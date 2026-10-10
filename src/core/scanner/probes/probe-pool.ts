/**
 * Scanner-owned ephemeral decoders that confirm tracks (spec § 6.5).
 * Admission (max probes per transport, CPU budget, host CPU guard), the
 * offset transport with IQ pre-roll, epoch binding (H5, P17), mode
 * stepping per the § 6.4 map, recordings and start latency. A probe reads
 * one engine stream: a `"stream"` event of its source ends it (sample indices
 * restart there).
 */
import { EventEmitter } from "node:events"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { z } from "zod"
import type { DsdFmeLinkLine } from "../../../decoders/builtin/dsd-fme-link.js"
import type { DecoderManager } from "../../../decoders/manager.js"
import type { DecoderConfig } from "../../../decoders/types.js"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import type {
	DigitalVoiceService,
	VoiceCallSource,
} from "../../digital-voice.js"
import { probeId as buildProbeId, shortId } from "../ids.js"
import { CPU_COST, probeCores } from "../plan/cost.js"
import {
	USABLE_FRACTION,
	type EngineEpoch,
	type EngineStreamReason,
	type SpectrumEngine,
	type SpectrumEngineEvents,
} from "../../spectrum/spectrum-engine.js"
import type {
	DecodeEvidence,
	ScannerClass,
	ScannerProtocol,
	ScannerSettings,
} from "../types.js"
import {
	createInterpreterState,
	type DecoderOutputLike,
	type InterpreterState,
} from "./confirm/double-match.js"
import { interpretDirewolf } from "./confirm/direwolf.js"
import {
	interpretDsdFme,
	toDsdFmeScannerEvent,
	type DsdFmeScannerEvent,
} from "./confirm/dsd-fme.js"
import { interpretMultimon } from "./confirm/multimon.js"
import { interpretRtl433 } from "./confirm/rtl433.js"

export type ProbeTransport = "offset" | "channel"
export type ProbeState = "starting" | "confirming" | "following" | "stopping"
export type ProbeDecoderType = "dsd-fme" | "multimon-ng" | "direwolf" | "rtl433"

export interface ProbeRequest {
	jobId: string
	priority: number
	sourceId: string
	trackId: string
	observationId: string
	discoveryId: string | null
	targetHz: number
	epoch: number
	cls: ScannerClass
	protocols: ScannerProtocol[]
	preRollFromSample: number | null
	holdMs: number
	record: boolean
	admission: {
		kind: "protocol-target" | "undecoded" | "reconfirm"
		snrDb: number
	}
	/** Identify (Task 35a): run exactly these modes instead of probeModesFor(cls, protocols). */
	modes?: ProbeMode[]
}

export interface ProbeMode {
	decoderType: ProbeDecoderType
	protocol: ScannerProtocol
	covers: ScannerProtocol[]
	options: Record<string, unknown>
	holdMs: number
}

/** `on`/`off` carry the engine's `"stream"` event: ring sample indices restart at each stream. */
export type ProbeEngineView = Pick<
	SpectrumEngine,
	"sourceId" | "format" | "currentEpoch" | "liveEdge" | "readRing" | "tap"
> & {
	on(event: "stream", listener: SpectrumEngineEvents["stream"]): unknown
	off(event: "stream", listener: SpectrumEngineEvents["stream"]): unknown
}

export interface TransportContext {
	req: ProbeRequest
	epoch: EngineEpoch
	format: string
	sampleRateHz: number
}

export interface TransportStrategy {
	readonly kind: ProbeTransport
	/** Feed the decoder a scanner input: IQ ring pre-roll, then the live tap. */
	readonly preRoll: boolean
	maxProbes(s: ScannerSettings): number
	cores(decoderType: ProbeDecoderType): number
	supports(mode: ProbeMode, ctx: TransportContext): boolean
	configure(base: DecoderConfig, ctx: TransportContext): DecoderConfig
}

export interface ProbePoolDeps {
	decoders: Pick<
		DecoderManager,
		| "createEphemeralDecoder"
		| "removeEphemeralDecoder"
		| "getDecoder"
		| "on"
		| "off"
	>
	digitalVoice: Pick<
		DigitalVoiceService,
		"addChannel" | "removeChannel" | "ensureStarted" | "attachDecoder"
	> | null
	engines: (sourceId: string) => ProbeEngineView | undefined
	settings: () => ScannerSettings
	transports: readonly TransportStrategy[]
	cpu: { readonly normalisedPercent: number | null }
	engineCount: () => number
	storageDir: string
	allocatePort: () => Promise<number>
	logger: Logger
	now?: () => number
}

export interface ProbeStatus {
	probeId: string
	decoderId: string
	jobId: string
	sourceId: string
	trackId: string
	observationId: string
	discoveryId: string | null
	targetHz: number
	epoch: number
	protocol: ScannerProtocol
	decoderType: ProbeDecoderType
	transport: ProbeTransport
	state: ProbeState
	startedAt: number
	cores: number
}

export interface ProbeCall {
	callId: string
	startedAt: number
	endedAt: number
	talkgroup?: string
	source?: string
	encrypted: boolean
}

export interface ProbeRecordings {
	probeId: string
	jobId: string
	req: ProbeRequest
	probeDir: string
	calls: ProbeCall[]
	epochEndedAt: number | null
}

type Deferral =
	| "budget"
	| "max-probes"
	| "cpu"
	| "no-transport"
	| "format"
	| "stale-epoch"
type StopReason =
	| "released"
	| "epoch"
	| "stream"
	| "preempted"
	| "job-ended"
	| "shutdown"
	| "error"

interface ProbeRecord {
	probeId: string
	decoderId: string
	req: ProbeRequest
	mode: ProbeMode
	modeIndex: number
	modes: ProbeMode[]
	transport: TransportStrategy
	epoch: number
	centreHz: number
	state: ProbeState
	startedAt: number
	firstOutputAt: number | null
	epochEndedAt: number | null
	cores: number
	confirmed: boolean
	interp: InterpreterState
	input: PassThrough | null
	untap: (() => void) | null
	recordDir: string | null
	dvChannel: boolean
	calls: ProbeCall[]
	detach: (() => void)[]
	modeTimer: NodeJS.Timeout | null
	droppedBytes: number
	/** Set by teardown; a stop that arrives during it awaits this. */
	teardownDone: Promise<void> | null
	/** A mode step is tearing this record down; a stop clears it to cancel the step. */
	stepping: boolean
	/** Last multimon output (pairing window, § 6.4 "within the hold"). */
	lastPairAt: number | null
}

/** Stream events of one engine, watched once a request names its source. */
interface StreamWatch {
	engine: ProbeEngineView
	/** Newest stream the engine announced; null until the first event. */
	latest: number | null
	stopped: boolean
	off: () => void
}

const PROBE_INPUT_HWM = 1024 * 1024
const PROBE_INPUT_MAX_QUEUED = 8 * 1024 * 1024
const DEFAULT_START_LATENCY_MS = 400
/** multimon capcodes pair only within this gap (§ 6.4 "two decodes … within the hold", ± 2 s). */
export const PAIRING_GAP_MS = 2000
const LATENCY_ALPHA = 0.3
const ADMISSION_RANK = {
	"protocol-target": 0,
	undecoded: 1,
	reconfirm: 2,
} as const
const DSD_AUTO_COVERS: ScannerProtocol[] = [
	"dmr",
	"p25p1",
	"p25p2",
	"ysf",
	"dstar",
]

function dsd(
	mode: string,
	protocol: ScannerProtocol,
	covers: ScannerProtocol[],
	holdMs: number,
): ProbeMode {
	return { decoderType: "dsd-fme", protocol, covers, options: { mode }, holdMs }
}

function keepRequested(
	modes: ProbeMode[],
	protocols: ScannerProtocol[],
): ProbeMode[] {
	if (protocols.length === 0) return modes
	return modes.filter(mode => mode.covers.some(p => protocols.includes(p)))
}

/** Identify (Task 35a) runs several explicit-mode probes on one track: each mode list is its own request. */
function explicitModesKey(req: ProbeRequest): string {
	return (
		req.modes
			?.map(m => `${m.decoderType}:${JSON.stringify(m.options)}`)
			.join("|") ?? ""
	)
}

/** § 6.4 confirmation map (pre-channelizer slice). */
export function probeModesFor(
	cls: ScannerClass,
	protocols: ScannerProtocol[],
): ProbeMode[] {
	let modes: ProbeMode[]
	switch (cls) {
		case "tdma-ms":
		case "fsk4-12k5":
			modes = [
				dsd("auto", "dmr", DSD_AUTO_COVERS, 600),
				dsd("nxdn", "nxdn96", ["nxdn96"], 2000),
			]
			break
		case "fsk4-6k25":
			modes = [
				dsd("nxdn48", "nxdn48", ["nxdn48"], 2000),
				dsd("dpmr", "dpmr", ["dpmr"], 2000),
			]
			break
		case "gmsk-narrow":
			modes = [dsd("auto", "dstar", ["dstar"], 2000)]
			break
		case "fsk2-wide":
			modes = [
				{
					decoderType: "multimon-ng",
					protocol: "pocsag",
					covers: ["pocsag", "flex"],
					options: { modes: ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"] },
					holdMs: 4000,
				},
			]
			break
		case "afsk-fm":
			modes = [
				{
					decoderType: "direwolf",
					protocol: "aprs",
					covers: ["aprs"],
					options: {},
					holdMs: 3000,
				},
			]
			break
		case "analog-fm":
			// No analog decoder: a short dsd-fme probe that finds no sync keeps it analog (§ 6.4).
			modes = [dsd("auto", "digital-unknown", DSD_AUTO_COVERS, 1500)]
			break
		case "ook-burst":
			// ISM confirmation is ambient-only before the channelizer (§ 6.4, § 14.1).
			return []
		case "carrier":
		case "wideband":
		case "unknown":
			return []
	}
	return keepRequested(modes, protocols)
}

/** Pre-channelizer transport: csdr front-end shift by `offsetHz` (§ 6.5). */
export const offsetTransport: TransportStrategy = {
	kind: "offset",
	preRoll: true,
	maxProbes: s => s.maxProbes.offset,
	cores: decoderType => probeCores("offset", decoderType),
	supports: (mode, ctx) =>
		ctx.format === "U8_IQ" &&
		mode.decoderType !== "rtl433" &&
		Math.abs(ctx.req.targetHz - ctx.epoch.centreHz) <=
			(ctx.sampleRateHz * USABLE_FRACTION) / 2,
	configure: (base, ctx) => ({
		...base,
		options: {
			...base.options,
			offsetHz: ctx.req.targetHz - ctx.epoch.centreHz,
		},
	}),
}

export function buildProbeConfig(input: {
	probeId: string
	req: ProbeRequest
	mode: ProbeMode
	transport: TransportStrategy
	ctx: TransportContext
	recordDir: string | null
	ports: { kiss: number; agw: number } | null
}): DecoderConfig {
	const options: Record<string, unknown> = { ...input.mode.options }
	if (input.mode.decoderType === "dsd-fme") {
		// `output` stays unset: DigitalVoiceService.addChannel only rewrites unset/udp outputs.
		if (input.recordDir) {
			options["enablePerCallRecording"] = true
			options["perCallRecordingDir"] = input.recordDir
			options["perCallRecordingPrune"] = false
		}
	}
	if (input.mode.decoderType === "direwolf" && input.ports) {
		options["kissPort"] = input.ports.kiss
		options["agwPort"] = input.ports.agw
	}
	const base: DecoderConfig = {
		id: input.probeId,
		type: input.mode.decoderType,
		enabled: true,
		sourceId: input.req.sourceId,
		options,
	}
	return input.transport.configure(base, input.ctx)
}

const CallEndSchema = z
	.object({
		callId: z.string(),
		startedAt: z.string(),
		endedAt: z.string().optional(),
		talkgroup: z.number().nullable().optional(),
		source: z.number().nullable().optional(),
		encrypted: z.boolean().optional(),
		flags: z
			.object({
				encrypted: z.boolean().optional(),
				wavFileUpdate: z.boolean().optional(),
			})
			.partial()
			.optional(),
	})
	.passthrough()

function protocolShort(p: ScannerProtocol): string {
	return p.replace(/[^a-z0-9]/g, "").slice(0, 8)
}

export class ProbePool extends EventEmitter {
	private readonly log: Logger
	private readonly now: () => number
	private readonly records = new Map<string, ProbeRecord>()
	private readonly byDecoder = new Map<string, ProbeRecord>()
	private readonly queue: ProbeRequest[] = []
	private readonly latency = new Map<string, number>()
	private readonly watches = new Map<string, StreamWatch>()
	private seq = 0
	private destroyed = false

	constructor(private readonly deps: ProbePoolDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "ProbePool")
		this.now = deps.now ?? Date.now
		deps.decoders.on("decoder:output", this.onOutput)
	}

	request(req: ProbeRequest): { started: string } | { deferred: Deferral } {
		if (this.destroyed) return { deferred: "no-transport" }
		const existing = [...this.records.values()].find(
			r =>
				r.req.trackId === req.trackId &&
				r.req.jobId === req.jobId &&
				explicitModesKey(r.req) === explicitModesKey(req),
		)
		if (existing) return { started: existing.probeId }
		const engine = this.deps.engines(req.sourceId)
		if (!engine) return { deferred: "no-transport" }
		const epoch = engine.currentEpoch()
		if (
			epoch.epoch !== req.epoch ||
			!this.streamCurrent(req.sourceId, engine, epoch)
		) {
			return { deferred: "stale-epoch" }
		}
		if (
			engine.format !== "U8_IQ" &&
			!this.deps.transports.some(t => t.kind !== "offset")
		) {
			return { deferred: "format" }
		}
		const modes = req.modes ?? probeModesFor(req.cls, req.protocols)
		const first = modes[0]
		if (!first) return { deferred: "no-transport" }
		const ctx: TransportContext = {
			req,
			epoch,
			format: engine.format,
			sampleRateHz: epoch.sampleRateHz,
		}
		const pick = this.pickTransport(first, ctx)
		if ("deferred" in pick) {
			if (
				pick.deferred === "max-probes" ||
				pick.deferred === "budget" ||
				pick.deferred === "cpu"
			) {
				this.enqueue(req)
				// Under the CPU guard only identify (priority above every job's 0–100, Task 35a) preempts: a stopped
				// decoder is the CPU the guard is waiting for. pump() retries the queue every service tick.
				if (pick.deferred !== "cpu" || req.priority > 100) this.preemptFor(req)
			}
			return pick
		}
		return { started: this.start(req, modes, 0, pick.transport, ctx, null) }
	}

	follow(probeId: string, follow: boolean): void {
		const rec = this.records.get(probeId)
		if (!rec || rec.state === "stopping" || rec.state === "starting") return
		rec.state = follow ? "following" : "confirming"
		this.emit("probe-state", probeId, rec.state, rec.req)
	}

	async release(probeId: string): Promise<void> {
		const rec = this.records.get(probeId)
		if (rec) await this.stopProbe(rec, "released")
	}

	async releaseJob(jobId: string): Promise<void> {
		this.dropQueued(r => r.jobId === jobId)
		await Promise.all(
			[...this.records.values()]
				.filter(r => r.req.jobId === jobId)
				.map(r => this.stopProbe(r, "job-ended")),
		)
	}

	trackClosed(trackId: string): void {
		this.dropQueued(r => r.trackId === trackId)
	}

	/** Drops one queued request (identify gives up on a run that never got a slot, Task 35a). */
	dequeue(req: ProbeRequest): boolean {
		const before = this.queue.length
		this.dropQueued(r => r === req)
		return this.queue.length < before
	}

	async onEpoch(
		sourceId: string,
		epoch: number,
		centreHz: number,
	): Promise<void> {
		const at = this.now()
		this.dropQueued(r => r.sourceId === sourceId && r.epoch !== epoch)
		const stale = [...this.records.values()].filter(
			r => r.req.sourceId === sourceId && r.epoch !== epoch,
		)
		for (const rec of stale) rec.epochEndedAt = at
		await Promise.all(stale.map(rec => this.stopProbe(rec, "epoch")))
		for (const rec of stale) {
			const engine = this.deps.engines(sourceId)
			if (!engine) continue
			const halfSpan =
				(engine.currentEpoch().sampleRateHz * USABLE_FRACTION) / 2
			if (Math.abs(rec.req.targetHz - centreHz) > halfSpan) continue
			this.request({ ...rec.req, epoch, preRollFromSample: null })
		}
	}

	status(): ProbeStatus[] {
		return [...this.records.values()].map(r => ({
			probeId: r.probeId,
			decoderId: r.decoderId,
			jobId: r.req.jobId,
			sourceId: r.req.sourceId,
			trackId: r.req.trackId,
			observationId: r.req.observationId,
			discoveryId: r.req.discoveryId,
			targetHz: r.req.targetHz,
			epoch: r.epoch,
			protocol: r.mode.protocol,
			decoderType: r.mode.decoderType,
			transport: r.transport.kind,
			state: r.state,
			startedAt: r.startedAt,
			cores: r.cores,
		}))
	}

	startLatencyMs(
		decoderType: ProbeDecoderType,
		transport: ProbeTransport,
	): number {
		return Math.round(
			this.latency.get(`${decoderType}:${transport}`) ??
				DEFAULT_START_LATENCY_MS,
		)
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.queue.length = 0
		this.deps.decoders.off("decoder:output", this.onOutput)
		for (const watch of this.watches.values()) watch.off()
		this.watches.clear()
		await Promise.all(
			[...this.records.values()].map(r => this.stopProbe(r, "shutdown")),
		)
	}

	// === streams ===

	/**
	 * Watches the engine's `"stream"` events. On a thread host `currentEpoch().stream`
	 * lags the ring right after a reconnect boundary: a stream newer than the epoch's
	 * means the epoch's sample indices no longer address the ring.
	 */
	private streamCurrent(
		sourceId: string,
		engine: ProbeEngineView,
		epoch: EngineEpoch,
	): boolean {
		let watch = this.watches.get(sourceId)
		if (watch?.engine !== engine) {
			watch?.off()
			const onStream = (stream: number, reason: EngineStreamReason): void =>
				this.onStream(sourceId, stream, reason)
			engine.on("stream", onStream)
			watch = {
				engine,
				latest: null,
				stopped: false,
				off: () => engine.off("stream", onStream),
			}
			this.watches.set(sourceId, watch)
		}
		return (
			!watch.stopped && (watch.latest === null || watch.latest <= epoch.stream)
		)
	}

	/** A new stream (or the engine's stop): every probe of the source read the old ring. */
	private onStream(
		sourceId: string,
		stream: number,
		reason: EngineStreamReason,
	): void {
		const watch = this.watches.get(sourceId)
		if (watch) {
			watch.latest = stream
			watch.stopped = reason === "stop"
		}
		const at = this.now()
		this.dropQueued(r => r.sourceId === sourceId)
		for (const rec of this.records.values()) {
			if (rec.req.sourceId !== sourceId) continue
			rec.epochEndedAt ??= at
			// Synchronously, before the engine delivers the new stream's first bytes.
			rec.untap?.()
			rec.untap = null
			void this.stopProbe(rec, "stream")
		}
	}

	// === admission ===

	private estimatedCores(): number {
		let cores = this.deps.engineCount() * CPU_COST.engine
		for (const r of this.records.values()) cores += r.cores
		return cores
	}

	private pickTransport(
		mode: ProbeMode,
		ctx: TransportContext,
	): { transport: TransportStrategy } | { deferred: Deferral } {
		const s = this.deps.settings()
		let reason: Deferral | null = null
		for (const transport of this.deps.transports) {
			if (!transport.supports(mode, ctx)) continue
			const running = [...this.records.values()].filter(
				r => r.transport.kind === transport.kind,
			).length
			if (running >= transport.maxProbes(s)) {
				reason ??= "max-probes"
				continue
			}
			if (
				this.estimatedCores() + transport.cores(mode.decoderType) >
				s.cpuBudgetCores + 1e-9
			) {
				reason ??= "budget"
				continue
			}
			const cpu = this.deps.cpu.normalisedPercent
			if (cpu !== null && cpu > s.cpuGuardPercent) {
				reason ??= "cpu"
				continue
			}
			return { transport }
		}
		if (reason) return { deferred: reason }
		return { deferred: ctx.format === "U8_IQ" ? "no-transport" : "format" }
	}

	private enqueue(req: ProbeRequest): void {
		this.dropQueued(
			r =>
				r.trackId === req.trackId &&
				r.jobId === req.jobId &&
				explicitModesKey(r) === explicitModesKey(req),
		)
		this.queue.push(req)
		this.queue.sort(
			(a, b) =>
				b.priority - a.priority ||
				ADMISSION_RANK[a.admission.kind] - ADMISSION_RANK[b.admission.kind] ||
				b.admission.snrDb - a.admission.snrDb,
		)
	}

	private dropQueued(match: (r: ProbeRequest) => boolean): void {
		for (let i = this.queue.length - 1; i >= 0; i--)
			if (match(this.queue[i]!)) this.queue.splice(i, 1)
	}

	private preemptFor(req: ProbeRequest): void {
		let victim: ProbeRecord | null = null
		for (const r of this.records.values()) {
			if (r.state === "stopping" || r.req.priority >= req.priority) continue
			if (!victim || r.req.priority < victim.req.priority) victim = r
		}
		if (victim) void this.stopProbe(victim, "preempted")
	}

	/**
	 * Starts queued requests that now fit. Runs after every probe stop and from `ScannerService.tick` (Task 35), so a
	 * cpu- or budget-deferred request starts once the meter drops even when no probe stops.
	 */
	pump(): void {
		if (this.destroyed) return
		for (const req of [...this.queue]) {
			const engine = this.deps.engines(req.sourceId)
			if (
				!engine ||
				engine.currentEpoch().epoch !== req.epoch ||
				!this.streamCurrent(req.sourceId, engine, engine.currentEpoch())
			) {
				this.dropQueued(r => r === req)
				continue
			}
			const modes = req.modes ?? probeModesFor(req.cls, req.protocols)
			const first = modes[0]
			if (!first) {
				this.dropQueued(r => r === req)
				continue
			}
			const epoch = engine.currentEpoch()
			const ctx: TransportContext = {
				req,
				epoch,
				format: engine.format,
				sampleRateHz: epoch.sampleRateHz,
			}
			const pick = this.pickTransport(first, ctx)
			if ("deferred" in pick) continue
			this.dropQueued(r => r === req)
			this.start(req, modes, 0, pick.transport, ctx, null)
		}
	}

	// === lifecycle ===

	private start(
		req: ProbeRequest,
		modes: ProbeMode[],
		modeIndex: number,
		transport: TransportStrategy,
		ctx: TransportContext,
		probeIdOverride: string | null,
	): string {
		const mode = modes[modeIndex]!
		this.seq += 1
		const decoderId = buildProbeId(
			shortId(req.jobId),
			protocolShort(mode.protocol),
			this.seq,
		)
		const probeId = probeIdOverride ?? decoderId
		const rec: ProbeRecord = {
			probeId,
			decoderId,
			req,
			mode,
			modeIndex,
			modes,
			transport,
			epoch: req.epoch,
			centreHz: ctx.epoch.centreHz,
			state: "starting",
			startedAt: this.now(),
			firstOutputAt: null,
			epochEndedAt: null,
			cores: transport.cores(mode.decoderType),
			confirmed: false,
			interp: createInterpreterState({
				epoch: req.epoch,
				origin: "probe",
				probeId,
				decoderId,
				nxdn: mode.options["mode"] === "nxdn48" ? "nxdn48" : "nxdn96",
			}),
			input: null,
			untap: null,
			recordDir: null,
			dvChannel: false,
			calls: [],
			detach: [],
			modeTimer: null,
			droppedBytes: 0,
			teardownDone: null,
			stepping: false,
			lastPairAt: null,
		}
		this.records.set(probeId, rec)
		this.byDecoder.set(decoderId, rec)
		this.emit("probe-state", probeId, "starting", req)
		void this.launch(rec, ctx, modeIndex === 0).catch((err: unknown) => {
			// The pool stopped it while it started (createEphemeralDecoder rejects with PROBE_REMOVED): not a failure.
			if (this.isStopping(rec)) {
				this.log.debug(
					{ probeId, decoderType: mode.decoderType },
					"Probe stopped during its start",
				)
				return
			}
			const removed =
				err instanceof WaveKitError && err.code === "PROBE_REMOVED"
			this.log[removed ? "debug" : "warn"](
				{ err, probeId, decoderType: mode.decoderType },
				removed ? "Probe removed during its start" : "Probe failed to start",
			)
			void this.stopProbe(rec, "error")
		})
		return probeId
	}

	/**
	 * stopProbe can run while launch awaits. A method call, not an inline `rec.state === "stopping"`: TypeScript keeps
	 * the first inline check's narrowing across the awaits and rejects the second one (TS2367).
	 */
	private isStopping(rec: ProbeRecord): boolean {
		return rec.state === "stopping"
	}

	private async launch(
		rec: ProbeRecord,
		ctx: TransportContext,
		withPreRoll: boolean,
	): Promise<void> {
		const { req, mode, transport } = rec
		const ports =
			mode.decoderType === "direwolf"
				? {
						kiss: await this.deps.allocatePort(),
						agw: await this.deps.allocatePort(),
					}
				: null
		if (mode.decoderType === "dsd-fme" && req.record) {
			rec.recordDir = join(
				this.deps.storageDir,
				"recordings",
				"dv",
				`probe-${rec.probeId}`,
			)
			await mkdir(rec.recordDir, { recursive: true })
		}
		let config = buildProbeConfig({
			probeId: rec.decoderId,
			req,
			mode,
			transport,
			ctx,
			recordDir: rec.recordDir,
			ports,
		})
		const dv = this.deps.digitalVoice
		if (mode.decoderType === "dsd-fme" && dv) {
			config = await dv.addChannel(config)
			rec.dvChannel = config.options["output"] === "udp"
			// A stop during addChannel tore down before the channel existed; removeChannel is idempotent.
			if (rec.dvChannel && this.isStopping(rec))
				await dv.removeChannel(rec.decoderId)
			if (rec.dvChannel && !this.isStopping(rec)) await dv.ensureStarted()
		}
		if (this.isStopping(rec)) return
		if (transport.preRoll) {
			const engine = this.deps.engines(req.sourceId)
			// A "stream" event since the request stopped this probe (isStopping above). A replaced engine has
			// its own ring and stream counter.
			if (!engine || engine !== this.watches.get(req.sourceId)?.engine) {
				throw new WaveKitError(
					`Spectrum engine for ${req.sourceId} is gone`,
					"SCANNER_ENGINE_GONE",
				)
			}
			const input = new PassThrough({ highWaterMark: PROBE_INPUT_HWM })
			input.on("error", (err: Error) =>
				this.log.debug({ err, probeId: rec.probeId }, "Probe input error"),
			)
			// Pre-roll and tap in one synchronous block: no sample lost or repeated.
			const edge = engine.liveEdge()
			const from =
				withPreRoll && req.preRollFromSample !== null
					? req.preRollFromSample
					: edge
			const pre = engine.readRing(from, edge)
			if (pre && pre.bytes.length > 0) input.write(Buffer.from(pre.bytes))
			rec.untap = engine.tap((_start, bytes) => {
				if (input.writableLength > PROBE_INPUT_MAX_QUEUED) {
					rec.droppedBytes += bytes.length
					return
				}
				input.write(Buffer.from(bytes))
			})
			rec.input = input
		}
		const decoder = await this.deps.decoders.createEphemeralDecoder(config, {
			owner: "scanner",
			jobId: req.jobId,
			...(rec.input ? { input: rec.input } : {}),
		})
		if (this.isStopping(rec)) {
			await this.deps.decoders.removeEphemeralDecoder(rec.decoderId)
			return
		}
		const emitter = decoder as unknown as EventEmitter
		if (rec.dvChannel && dv)
			dv.attachDecoder(rec.decoderId, emitter as unknown as VoiceCallSource)
		if (mode.decoderType === "dsd-fme") {
			const onLink = (line: DsdFmeLinkLine): void => {
				this.markOutput(rec)
				this.deliver(rec, interpretDsdFme({ kind: "link", line }, rec.interp))
			}
			emitter.on("link", onLink)
			rec.detach.push(() => emitter.off("link", onLink))
		}
		rec.state = "confirming"
		this.emit("probe-state", rec.probeId, "confirming", req)
		// req.holdMs is the class total: leave the later modes their own holds inside it (§ 6.4).
		const laterHoldMs = rec.modes.slice(1).reduce((sum, m) => sum + m.holdMs, 0)
		const holdMs =
			rec.modeIndex === 0
				? Math.max(mode.holdMs, req.holdMs - laterHoldMs)
				: mode.holdMs
		rec.modeTimer = setTimeout(() => {
			rec.modeTimer = null
			void this.onModeTimeout(rec)
		}, holdMs)
		rec.modeTimer.unref()
	}

	private async onModeTimeout(rec: ProbeRecord): Promise<void> {
		if (rec.confirmed || rec.state !== "confirming") return
		const next = rec.modeIndex + 1
		if (next >= rec.modes.length) return
		const engine = this.deps.engines(rec.req.sourceId)
		if (!engine) return
		const epoch = engine.currentEpoch()
		if (epoch.epoch !== rec.epoch) return
		const nextMode = rec.modes[next]!
		const ctx: TransportContext = {
			req: rec.req,
			epoch,
			format: engine.format,
			sampleRateHz: epoch.sampleRateHz,
		}
		if (!rec.transport.supports(nextMode, ctx)) return
		rec.stepping = true
		await this.teardown(rec)
		// A stop during the teardown cancelled the step and finishes the probe itself.
		if (!rec.stepping) return
		rec.stepping = false
		this.records.delete(rec.probeId)
		this.start(rec.req, rec.modes, next, rec.transport, ctx, rec.probeId)
	}

	private teardown(rec: ProbeRecord): Promise<void> {
		rec.teardownDone ??= this.runTeardown(rec)
		return rec.teardownDone
	}

	private async runTeardown(rec: ProbeRecord): Promise<void> {
		rec.state = "stopping"
		if (rec.modeTimer) clearTimeout(rec.modeTimer)
		rec.modeTimer = null
		rec.untap?.()
		rec.untap = null
		for (const off of rec.detach) off()
		rec.detach = []
		this.byDecoder.delete(rec.decoderId)
		rec.input?.end()
		try {
			await this.deps.decoders.removeEphemeralDecoder(rec.decoderId)
		} catch (err) {
			this.log.warn(
				{ err, probeId: rec.probeId },
				"Removing a probe decoder failed",
			)
		}
		if (rec.dvChannel && this.deps.digitalVoice) {
			await this.deps.digitalVoice
				.removeChannel(rec.decoderId)
				.catch((err: unknown) => {
					this.log.warn(
						{ err, probeId: rec.probeId },
						"Removing a probe voice channel failed",
					)
				})
		}
		rec.input?.destroy()
		rec.input = null
	}

	private async stopProbe(rec: ProbeRecord, reason: StopReason): Promise<void> {
		if (rec.state === "stopping") {
			if (!rec.stepping) return
			rec.stepping = false
		}
		await this.teardown(rec)
		// A mode step reuses the probe id: never drop its successor.
		if (this.records.get(rec.probeId) !== rec) return
		this.records.delete(rec.probeId)
		this.log.debug({ probeId: rec.probeId, reason }, "Probe stopped")
		this.emit("probe-state", rec.probeId, "stopped", rec.req)
		if (rec.recordDir) {
			const result: ProbeRecordings = {
				probeId: rec.probeId,
				jobId: rec.req.jobId,
				req: rec.req,
				probeDir: rec.recordDir,
				calls: rec.calls,
				epochEndedAt: rec.epochEndedAt,
			}
			this.emit("recordings", result)
		}
		this.pump()
	}

	// === output ===

	private readonly onOutput = (
		decoderId: string,
		out: DecoderOutputLike,
	): void => {
		const rec = this.byDecoder.get(decoderId)
		if (!rec || rec.state === "stopping") return
		this.markOutput(rec)
		switch (rec.mode.decoderType) {
			case "dsd-fme": {
				const ev = toDsdFmeScannerEvent(out)
				if (!ev) return
				this.trackCall(rec, ev, out)
				this.deliver(rec, interpretDsdFme(ev, rec.interp))
				return
			}
			case "multimon-ng": {
				const at = this.now()
				if (rec.lastPairAt !== null && at - rec.lastPairAt > PAIRING_GAP_MS) {
					rec.interp = createInterpreterState({
						epoch: rec.epoch,
						origin: "probe",
						probeId: rec.probeId,
						decoderId: rec.decoderId,
					})
				}
				rec.lastPairAt = at
				this.deliver(rec, interpretMultimon(out, rec.interp))
				return
			}
			case "direwolf":
				this.deliver(rec, interpretDirewolf(out, rec.interp))
				return
			case "rtl433":
				this.deliver(rec, interpretRtl433(out, rec.interp))
				return
		}
	}

	private markOutput(rec: ProbeRecord): void {
		if (rec.firstOutputAt !== null) return
		rec.firstOutputAt = this.now()
		const key = `${rec.mode.decoderType}:${rec.transport.kind}`
		const sample = rec.firstOutputAt - rec.startedAt
		const prev = this.latency.get(key)
		this.latency.set(
			key,
			prev === undefined ? sample : prev + LATENCY_ALPHA * (sample - prev),
		)
	}

	private trackCall(
		rec: ProbeRecord,
		ev: DsdFmeScannerEvent,
		out: DecoderOutputLike,
	): void {
		if (ev.kind !== "call_end") return
		const parsed = CallEndSchema.safeParse(out.data)
		if (!parsed.success || parsed.data.flags?.wavFileUpdate) return
		const d = parsed.data
		rec.calls.push({
			callId: d.callId,
			startedAt: Date.parse(d.startedAt),
			endedAt: d.endedAt ? Date.parse(d.endedAt) : out.timestamp.getTime(),
			...(d.talkgroup != null ? { talkgroup: String(d.talkgroup) } : {}),
			...(d.source != null ? { source: String(d.source) } : {}),
			encrypted: d.encrypted === true || d.flags?.encrypted === true,
		})
	}

	/** P17: only evidence of the probe's epoch, stamped before that epoch ended. */
	private deliver(rec: ProbeRecord, evs: DecodeEvidence[]): void {
		for (const ev of evs) {
			if (ev.epoch !== rec.epoch) continue
			if (rec.epochEndedAt !== null && ev.at >= rec.epochEndedAt) continue
			if (ev.identity || ev.encrypted !== undefined) rec.confirmed = true
			this.emit("evidence", rec.probeId, rec.req, ev)
		}
	}
}
