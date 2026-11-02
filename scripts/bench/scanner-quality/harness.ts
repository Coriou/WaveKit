/**
 * Scanner quality benchmark: drives the real ScannerService (inline spectrum engine, passive job,
 * EU band plans, channel gate, discovery store) with CU8 chunks on a virtual clock, and records
 * what each stage did: pipeline tracks, channel-gate passes, discoveries, the IQ captures the
 * scanner asked for and the replay trials the real planner chose for each.
 *
 * Faked (no binaries offline): the IQ capture tool is a port that records the scanner's capture
 * requests and finishes them like the real one (track close, or 4 s); nothing is replayed through a
 * decoder. Decoder answers are applied afterwards by the oracle in metrics.ts. Sources, fanout,
 * tuner and decoder manager are in-process doubles; nothing touches the network.
 */
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import pino from "pino"
import { ScannerConfigSchema, type SourceCaps } from "../../../src/config.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import { planReplayTrialsDetailed } from "../../../src/core/scanner/replay-plan.js"
import type {
	IqCaptureRequest,
	IqCaptureView,
	IqCaptureRateHz,
} from "../../../src/core/scanner/iq-capture-contract.js"
import {
	IQ_CAPTURE_MAX_CONCURRENT,
	IQ_CAPTURE_MAX_MS,
	IQ_CAPTURE_PER_SOURCE_PER_MINUTE,
	IQ_CAPTURE_PREROLL_MAX_MS,
} from "../../../src/core/scanner/iq-capture-contract.js"
import type {
	Discovery,
	ScannerSettings,
} from "../../../src/core/scanner/types.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../src/core/spectrum/types.js"
import type { ScannerDiscoveryEventData } from "@wavekit/api-types"
import { ArbiterFakeTuner } from "../../../tests/mocks/scanner/arbiter-fakes.js"
import { VirtualClock } from "./virtual-clock.js"

const SOURCE = "rtl"
/** Virtual epoch of scene time 0. */
export const T0_MS = 1_700_000_000_000
/** 50 ms chunks: one integration block each at the default 50 ms. */
export const CHUNK_MS = 50
/** Noise fed before scene time 0 so the noise floor settles (20 chunks). */
export const LEAD_IN_MS = 1_000
/** Noise fed after the scene so open tracks close on their hang and captures finish. */
const TAIL_MS = 1_000
/** Real turns allowed for the scanner to start its passive job (state load is async I/O). */
const START_TURNS_MAX = 10_000
/** The capture tool keeps this much of its ring unused (RING_MARGIN_S in iq-capture/service.ts). */
const RING_MARGIN_MS = 250
/** The wall clock, read before the virtual clock replaces performance.now. */
const wallNow = performance.now.bind(performance)

export interface TrackRecord {
	trackId: string
	firstMs: number
	lastMs: number
	centreHz: number
	obwHz: number
	maxSnrDb: number
	maxChannelSnrDb: number | null
	blocks: number
	gate: TrackSnapshot["gate"] | "none"
	gatePassedMs: number | null
	closed: boolean
	burst: boolean
	edge: boolean
	spur: boolean
	iqImage: boolean
	truncated: boolean
}

export interface DiscoveryRecord {
	id: string
	createdMs: number
	lastEventMs: number
	/** Measured centre (frequencyHz + measuredOffsetHz) at the last event. */
	centreHz: number
	frequencyHz: number
	bandwidthHz: number
	class: string
	protocol: string
	hint: string | null
	observationCount: number
	/** Scene ms each class was first shown on this record (class-to-classification latency). */
	firstClassMs: Record<string, number>
	/** Deleted or merged away by the end of the run. */
	gone: boolean
	mergedInto: string | null
}

export interface CaptureRecord {
	captureId: string
	observationId: string | null
	requestedMs: number
	/** Scene ms of the track start (`fromSample`). */
	trackStartMs: number
	/** Scene ms the captured IQ starts: pre-roll before the track start, clamped to the ring. */
	windowStartMs: number
	rfHz: number
	rateHz: IqCaptureRateHz | 48_000
	endedMs: number | null
	finishedMs: number | null
	/** [start, end] scene ms of the captured IQ (pre-roll included). */
	windowMs: [number, number] | null
	discoveryId: string | null
	trials: { protocol: string; decoder: string; kind: "probe" | "analog" }[]
	skipped: { protocol: string; reason: string }[]
	/** The captured track turned edge (no trial is planned for it). */
	edge: boolean
}

export interface RunRecord {
	rateHz: number
	centreHz: number
	iqSeconds: number
	/** CPU seconds (user + system) spent inside the scanner while it processed the IQ. */
	cpuSeconds: number
	wallSeconds: number
	tracks: TrackRecord[]
	discoveries: DiscoveryRecord[]
	captures: CaptureRecord[]
	/** Discoveries listed by the service at the end (after merges). */
	finalIds: string[]
	transients: number
	/** Capture requests the modelled port refused. */
	refusedCaptures: { busy: number; rateLimited: number }
}

export interface IqChunkSource {
	readonly rateHz: number
	readonly centreHz: number
	/** Next CU8 chunk of at most `samples` samples, null at the end. */
	next(samples: number): Buffer | null
	/** Noise for the lead-in before scene time 0 and the tail after it (not part of the scene). */
	leadIn(samples: number): Buffer
	/**
	 * Tuned centre at scene time `ms` (Hz); absent, `centreHz` throughout. When it changes the
	 * harness retunes the source like an external tuner write (caps change, a new epoch).
	 */
	centreAt?(ms: number): number
}

class Fanout extends EventEmitter {
	readonly branches = new Map<string, PassThrough>()
	addBranch(config: { id: string; highWaterMark?: number }): PassThrough {
		const stream = new PassThrough({
			highWaterMark: config.highWaterMark ?? 262_144,
		})
		stream.on("error", () => undefined)
		this.branches.set(config.id, stream)
		this.emit("bench:branch", config.id)
		return stream
	}
	removeBranch(id: string): void {
		this.branches.get(id)?.destroy()
		this.branches.delete(id)
	}
	getBranchTelemetry(id: string) {
		const s = this.branches.get(id)
		if (!s) return undefined
		return {
			id,
			backpressureActive: false,
			backpressureEnterCount: 0,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
			bufferBytes: s.readableLength + s.writableLength,
			highWaterMark: s.readableHighWaterMark,
			totalBytesWritten: 0,
		}
	}
	write(chunk: Buffer): void {
		for (const s of this.branches.values()) s.write(chunk)
	}
}

class Sources extends EventEmitter {
	readonly caps = new Map<string, SourceCaps>()
	readonly streams = new Map<string, PassThrough>()
	constructor(caps: SourceCaps) {
		super()
		this.caps.set(SOURCE, caps)
		this.streams.set(SOURCE, new PassThrough())
	}
	getCaps(id: string): SourceCaps | undefined {
		return this.caps.get(id)
	}
	getStream(id: string): PassThrough | undefined {
		return this.streams.get(id)
	}
	isRtlTcpSource(id: string): boolean {
		return id === SOURCE
	}
	setCaps(id: string, patch: Partial<SourceCaps>): void {
		const next = { ...this.caps.get(id)!, ...patch }
		this.caps.set(id, next)
		this.emit("caps-changed", id, next)
	}
}

/** No decoder binaries: every ephemeral decoder start fails like a missing program. */
class Decoders extends EventEmitter {
	private readonly held = new Map<string, Set<string>>()
	createEphemeralDecoder(): Promise<never> {
		return Promise.reject(new Error("no decoder binaries in the benchmark"))
	}
	removeEphemeralDecoder(): Promise<void> {
		return Promise.resolve()
	}
	getDecoder(): undefined {
		return undefined
	}
	holdSource(sourceId: string, _r: string, holderId: string): Promise<void> {
		const h = this.held.get(sourceId) ?? new Set<string>()
		h.add(holderId)
		this.held.set(sourceId, h)
		return Promise.resolve()
	}
	releaseSource(sourceId: string, holderId: string): Promise<void> {
		this.held.get(sourceId)?.delete(holderId)
		return Promise.resolve()
	}
	isSourceHeld(sourceId: string): boolean {
		return (this.held.get(sourceId)?.size ?? 0) > 0
	}
	getAllStatus(): [] {
		return []
	}
	getStatus(): undefined {
		return undefined
	}
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

interface Internals {
	store: { discoveryIdOf(observationId: string): string | undefined }
	replayPlanInput(
		capture: IqCaptureView,
	): Parameters<typeof planReplayTrialsDetailed>[0]
}

/**
 * Runs one IQ source through the scanner. `onProgress` is called once per simulated second.
 * The state directory is a fresh temp dir, removed at the end.
 */
export async function runScanner(
	source: IqChunkSource,
	opts: {
		onProgress?: (sceneMs: number) => void
		/**
		 * Enforce the real capture port's limits (concurrency, per-minute rate, 2 s ring); default
		 * on. Off: every request is granted with its full pre-roll (the first published baseline).
		 */
		captureLimits?: boolean
		/** Diagnostics: called once with the service before it starts (wrap internals to trace). */
		inspect?: (service: ScannerService, sceneNow: () => number) => void
	} = {},
): Promise<RunRecord> {
	const fs = source.rateHz
	const dir = mkdtempSync(join(tmpdir(), "wk-scanner-quality-"))
	const clock = new VirtualClock(T0_MS - LEAD_IN_MS)
	const now = (): number => clock.now()
	const sceneNow = (): number => clock.now() - T0_MS
	const caps: SourceCaps = {
		kind: "iq",
		format: "U8_IQ",
		sampleRate: fs,
		centerFreq: source.centreHz,
		exclusive: false,
	}
	const sources = new Sources(caps)
	const fanout = new Fanout()
	const tuner = new ArbiterFakeTuner()
	tuner.addSource(SOURCE)
	tuner.states.get(SOURCE)!.sampleRate = fs
	tuner.states.get(SOURCE)!.frequency = source.centreHz
	const settings = structuredClone(
		ScannerConfigSchema.parse({ storage: { dir } }),
	) as ScannerSettings
	settings.sweep.markers = false
	/** The capture pre-roll the real tool uses (config default 500 ms when the section is absent). */
	const preRollMs = settings.iqCapture?.preRollMs ?? 500

	const tracks = new Map<string, TrackRecord>()
	const discoveries = new Map<string, DiscoveryRecord>()
	const captures = new Map<string, CaptureRecord>()
	let transients = 0
	/** Engine sample index of scene time 0 (the engine counts from its branch's first byte). */
	let engineSampleAtZero = 0
	let fedSamples = 0
	let branchAtSample: number | null = null
	fanout.on("bench:branch", () => {
		branchAtSample ??= fedSamples
	})
	const sceneMsOfSample = (sample: number): number =>
		((sample - engineSampleAtZero) * 1000) / fs

	let service: ScannerService | null = null
	const finish = (c: CaptureRecord): void => {
		if (c.finishedMs !== null || !service) return
		c.finishedMs = sceneNow()
		const start = c.windowStartMs
		const end = Math.min(start + IQ_CAPTURE_MAX_MS, c.endedMs ?? sceneNow())
		c.windowMs = [start, end]
		const view: IqCaptureView = {
			captureId: c.captureId,
			sourceId: SOURCE,
			observationId: c.observationId,
			epoch: 1,
			rfHz: c.rfHz,
			tuningTrust: "commanded",
			capturedAtMs: T0_MS + start,
			durationMs: end - start,
			gapSamples: 0,
			...(c.rateHz !== 48_000 ? { rateHz: c.rateHz } : {}),
		}
		const internals = service as unknown as Internals
		const input = internals.replayPlanInput(view)
		c.edge = input.track?.flags.edge === true
		const plan = planReplayTrialsDetailed(input)
		c.trials = plan.trials.map(t => ({
			protocol: t.protocol,
			decoder: t.kind === "analog" ? "analog-demod" : t.mode.decoderType,
			kind: t.kind ?? "probe",
		}))
		c.skipped = plan.skipped.map(s => ({
			protocol: String(s.protocol),
			reason: s.reason,
		}))
		if (c.observationId)
			c.discoveryId =
				internals.store.discoveryIdOf(c.observationId) ?? c.discoveryId
	}
	let nextCapture = 1
	const limits = opts.captureLimits !== false
	const stamps: number[] = []
	const refused = { busy: 0, rateLimited: 0 }
	const port = {
		near: () => [],
		capture: (req: IqCaptureRequest) => {
			const at = sceneNow()
			const trackStartMs = sceneMsOfSample(req.fromSample)
			if (limits) {
				// The real port: IQ_CAPTURE_MAX_CONCURRENT captures being written, then
				// IQ_CAPTURE_PER_SOURCE_PER_MINUTE detection captures per rolling minute.
				let open = 0
				for (const c of captures.values()) if (c.finishedMs === null) open++
				if (open >= IQ_CAPTURE_MAX_CONCURRENT) {
					refused.busy++
					return { refused: "busy" as const }
				}
				while (stamps.length > 0 && at - stamps[0]! >= 60_000) stamps.shift()
				if (
					req.reason === "detection" &&
					stamps.length >= IQ_CAPTURE_PER_SOURCE_PER_MINUTE
				) {
					refused.rateLimited++
					return { refused: "rate-limited" as const }
				}
				if (req.reason === "detection") stamps.push(at)
			}
			// The port's ring holds the last IQ_CAPTURE_PREROLL_MAX_MS less its 250 ms margin: a
			// later request loses the start of the track.
			const windowStartMs = Math.max(
				trackStartMs - preRollMs,
				limits ? at - IQ_CAPTURE_PREROLL_MAX_MS + RING_MARGIN_MS : -Infinity,
			)
			const captureId = `cap-${nextCapture++}`
			captures.set(captureId, {
				captureId,
				observationId: req.observationId,
				requestedMs: at,
				trackStartMs,
				windowStartMs,
				rfHz: req.rfHz,
				rateHz: req.rateHz ?? 48_000,
				endedMs: null,
				finishedMs: null,
				windowMs: null,
				discoveryId: req.observationId
					? ((service as unknown as Internals | null)?.store.discoveryIdOf(
							req.observationId,
						) ?? null)
					: null,
				trials: [],
				skipped: [],
				edge: false,
			})
			return { captureId }
		},
		captureFor: () => ({ refused: "busy" as const }),
		view: () => null,
		onFinished: () => () => undefined,
		onRemoved: () => () => undefined,
		holderOf: () => undefined,
		discard: (captureId: string) => {
			const c = captures.get(captureId)
			if (c && c.finishedMs === null) {
				c.edge = true
				c.endedMs = sceneNow()
				c.finishedMs = sceneNow()
			}
			return true
		},
		end: (captureId: string) => {
			const c = captures.get(captureId)
			if (!c || c.endedMs !== null) return
			c.endedMs = sceneNow()
			finish(c)
		},
		claim: () => false,
		settle: () => undefined,
		confirmLive: () => 0,
		openReplay: () => null,
		flush: () => undefined,
		attachSource: () => undefined,
		detachSource: () => undefined,
		setShapes: () => undefined,
		state: () => "on" as const,
	}

	// Every timer the scanner arms from here on runs on the virtual clock.
	clock.install()
	try {
		service = new ScannerService({
			settings,
			sourceConfigs: [
				{
					id: SOURCE,
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: 1234,
					loop: false,
					playbackSpeed: 1,
					caps,
				},
			],
			decoderConfigs: [],
			region: "EU",
			stateDir: dir,
			sources: sources as never,
			routing: {
				getFanout: () => fanout,
				releaseUnused: () => undefined,
			} as never,
			tuner: tuner as never,
			decoders: new Decoders() as never,
			digitalVoice: null,
			liveDemod: null,
			logger: pino({ level: "silent" }),
			now,
			engineHost: "inline",
			tickMs: 20,
			iqCapture: port as never,
		})
	} catch (err: unknown) {
		clock.uninstall()
		rmSync(dir, { recursive: true, force: true })
		throw err
	}
	const svc = service
	// Everything after install runs inside this try: a throwing `inspect`, a failing run or a
	// rejecting stop() still restores the real timers and clocks (the nested finally).
	try {
		opts.inspect?.(svc, sceneNow)
		svc.spectrum.on("pipeline", (sourceId: string, ev: PipelineEvent) => {
			if (sourceId !== SOURCE) return
			if (ev.kind === "transient") transients++
			if (
				ev.kind !== "track-open" &&
				ev.kind !== "track-update" &&
				ev.kind !== "track-close"
			)
				return
			const t = ev.track
			let r = tracks.get(t.trackId)
			if (!r) {
				r = {
					trackId: t.trackId,
					firstMs: sceneMsOfSample(t.startSample),
					lastMs: sceneNow(),
					centreHz: t.centreHz,
					obwHz: t.obwHz,
					maxSnrDb: t.snrDb,
					maxChannelSnrDb: null,
					blocks: t.blocks,
					gate: t.gate ?? "none",
					gatePassedMs: null,
					closed: false,
					burst: false,
					edge: false,
					spur: false,
					iqImage: false,
					truncated: false,
				}
				tracks.set(t.trackId, r)
			}
			r.lastMs = sceneMsOfSample(t.lastSample)
			r.centreHz = t.centreHz
			r.obwHz = t.obwHz
			r.maxSnrDb = Math.max(r.maxSnrDb, t.snrDb)
			const ch = Math.max(
				t.channelSnrDb ?? -Infinity,
				t.peakChannelSnrDb ?? -Infinity,
			)
			if (Number.isFinite(ch))
				r.maxChannelSnrDb = Math.max(r.maxChannelSnrDb ?? -Infinity, ch)
			r.blocks = t.blocks
			if (r.gate !== "passed") r.gate = t.gate ?? "none"
			if (t.gate === "passed" && r.gatePassedMs === null)
				r.gatePassedMs =
					t.gatePassedSample !== undefined
						? sceneMsOfSample(t.gatePassedSample)
						: sceneNow()
			r.burst ||= t.flags.burst
			r.edge ||= t.flags.edge
			r.spur ||= t.flags.spur
			r.iqImage ||= t.flags.iqImage
			r.truncated ||= t.flags.truncated
			if (ev.kind === "track-close") r.closed = true
		})
		const record = (d: Discovery, gone: boolean, mergedInto: string | null) => {
			const prev = discoveries.get(d.id)
			const firstClassMs = { ...(prev?.firstClassMs ?? {}) }
			firstClassMs[d.class] ??= sceneNow()
			discoveries.set(d.id, {
				firstClassMs,
				id: d.id,
				createdMs: prev?.createdMs ?? sceneNow(),
				lastEventMs: sceneNow(),
				centreHz: d.frequencyHz + (d.measuredOffsetHz || 0),
				frequencyHz: d.frequencyHz,
				bandwidthHz: d.bandwidthHz,
				class: d.class,
				protocol: d.protocol,
				hint: d.hint ?? prev?.hint ?? null,
				observationCount: d.observationCount,
				gone: gone || (prev?.gone ?? false),
				mergedInto: mergedInto ?? prev?.mergedInto ?? null,
			})
		}
		svc.on("discovery", (data: ScannerDiscoveryEventData) => {
			const d = data.discovery as unknown as Discovery
			record(d, data.change === "deleted", null)
			for (const id of data.mergedIds ?? []) {
				const m = discoveries.get(id)
				if (m) {
					m.gone = true
					m.mergedInto = d.id
				}
			}
		})

		const started = wallNow()
		let cpuMicros = 0
		const chunk = Math.round((fs * CHUNK_MS) / 1000)
		/** Two real turns: stream data events and promise continuations run before the next step. */
		const settle = async (): Promise<void> => {
			await turn()
			await turn()
		}
		/** Fires the scanner timers due up to scene time `ms`, then holds the clock there. */
		const advanceTo = (ms: number): Promise<void> =>
			clock.advanceTo(T0_MS + ms, settle)
		await svc.start()
		// Start-up: the passive job and its engine branch come up on real turns (state load and
		// job start are async I/O). No IQ is fed and the virtual clock does not move, so how many
		// turns this takes changes nothing the scene sees.
		for (
			let i = 0;
			i < START_TURNS_MAX &&
			(svc.getJob(`passive-${SOURCE}`)?.state !== "running" ||
				branchAtSample === null);
			i++
		)
			await turn()
		if (branchAtSample === null)
			throw new Error("benchmark: the passive job never opened its branch")
		// Lead-in: LEAD_IN_MS of noise so the noise floor settles before the scene starts.
		for (let ms = -LEAD_IN_MS + CHUNK_MS; ms <= 0; ms += CHUNK_MS) {
			await advanceTo(ms)
			fanout.write(source.leadIn(chunk))
			fedSamples += chunk
			await settle()
		}
		engineSampleAtZero = fedSamples - branchAtSample
		let fedSceneSamples = 0
		let lastProgress = 0
		let tunedHz = source.centreHz
		for (;;) {
			const centre = source.centreAt?.((fedSceneSamples * 1000) / fs)
			if (centre !== undefined && centre !== tunedHz) {
				tunedHz = centre
				tuner.states.get(SOURCE)!.frequency = centre
				sources.setCaps(SOURCE, { centerFreq: centre })
				await settle()
			}
			const bytes = source.next(chunk)
			if (!bytes) break
			fedSceneSamples += bytes.length / 2
			// The engine processes on its batch-flush timer too: count the timers' CPU as well.
			const cpu0 = process.cpuUsage()
			await advanceTo((fedSceneSamples * 1000) / fs)
			fanout.write(bytes)
			fedSamples += bytes.length / 2
			await settle()
			const d = process.cpuUsage(cpu0)
			cpuMicros += d.user + d.system
			const at = sceneNow()
			for (const c of captures.values())
				if (c.finishedMs === null && at >= c.windowStartMs + IQ_CAPTURE_MAX_MS)
					finish(c)
			if (at - lastProgress >= 1000) {
				lastProgress = at
				opts.onProgress?.(at)
			}
		}
		// Let the open tracks close on quiet (hang) and finish what is pending.
		const sceneEnd = sceneNow()
		for (let ms = CHUNK_MS; ms <= TAIL_MS; ms += CHUNK_MS) {
			const cpu0 = process.cpuUsage()
			await advanceTo(sceneEnd + ms)
			fanout.write(source.leadIn(chunk))
			await settle()
			const d = process.cpuUsage(cpu0)
			cpuMicros += d.user + d.system
		}
		for (const c of captures.values()) finish(c)
		const finalIds = svc
			.listDiscoveries({ limit: 10_000 })
			.items.map((d: Discovery) => d.id)
		for (const d of svc.listDiscoveries({ limit: 10_000 }).items)
			record(d, false, null)
		return {
			rateHz: fs,
			centreHz: source.centreHz,
			iqSeconds: Math.max(0, sceneNow()) / 1000,
			cpuSeconds: cpuMicros / 1e6,
			wallSeconds: (wallNow() - started) / 1000,
			tracks: [...tracks.values()],
			discoveries: [...discoveries.values()],
			captures: [...captures.values()],
			finalIds,
			transients,
			refusedCaptures: { ...refused },
		}
	} finally {
		try {
			await svc.stop()
		} finally {
			clock.uninstall()
			rmSync(dir, { recursive: true, force: true })
		}
	}
}
