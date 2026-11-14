/**
 * Scanner truth scorecard: runs one labelled case (a synthetic scene or a CU8 capture) through
 * the real ScannerService on the virtual clock (harness.ts) with the analog recorder in the
 * loop, and records what it kept.
 *
 * - Tuning is proven (a tuning ledger, as the live receiver's commanded tuning), so the
 *   recorder records as it does live.
 * - Recorded always-on decodes (`ambient`: multimon-ng or dsd-fme placed on a channel) are
 *   injected when they reached the live scanner (their recorded offset, which holds the
 *   decoder's own latency) through the service's ambient evidence handler, which places them on
 *   an observation by frequency and time. Recorded identify decodes (`probe`, `replay`) are not:
 *   the revision under test identifies for itself.
 * - Identify replays run in the scanner's own replay queue on its own captures; only the
 *   decoders are doubles, answering from the labels one nominal second per trial
 *   (replayDoubles).
 * - Kept recordings: the recorder's finalized analog files still on disk once the run's idle
 *   tail let every provisional file's grace end. Each file's span is its first sample (the
 *   recorder's file start) plus its frame count at 8 kHz.
 *
 * Nothing touches the network or a device; the state directory is a temp dir, or the session's
 * (truth-cli.ts) when captures run as one session.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import type {
	DecodeEvidence,
	Identity,
} from "../../../src/core/scanner/types.js"
import { guardDsdFmeEvidence } from "../../../src/core/scanner/probes/confirm/dsd-fme.js"
import {
	classifyAnalogTrial,
	isVoice,
} from "../../../src/core/scanner/analog-trial.js"
import {
	ANALOG_TRIAL_FRAME_MS,
	ANALOG_TRIAL_MAX_FRAMES,
	type AnalogTrialFrame,
	type AnalogTrialMode,
	type AnalogTrialResult,
	type AnalogTrialStats,
	type AnalogTrialTones,
} from "../../../src/core/scanner/scanner-redesign-contract.js"
import { AMBIENT_PAIR_MS } from "../../../src/core/scanner/types.js"
import type { IqReplayProbeAnswer } from "../../../src/core/iq-capture/replay-queue.js"
import {
	LEAD_IN_MS,
	runScanner,
	type CaptureRecord,
	type DiscoveryRecord,
	type InspectContext,
	type IqChunkSource,
	type ReplayDoubles,
} from "./harness.js"
import { SceneGenerator, buildScene, type Scene } from "./scene.js"
import type { TruthDecode, TruthInterval } from "./truth-labels.js"

/** Noise fed after a case so its tracks close and the recorder asks every file's finish. */
export const TRUTH_TAIL_MS = 3_000
/**
 * Virtual time then run with no IQ: 30 s. By the noise tail's end the recorder has asked every
 * file's finish (a track closes one 500 ms hang after its signal, the recorder decides up to
 * 1 s later); a provisional file is then held for its late verdict at most 26 s (3 s + 8 s +
 * 15 s, the recorder's late-verdict grace where the scanner has one): 30 s covers it with 4 s to
 * spare. Past it the run goes on until the replay queue drained and every recording settled
 * (harness `idleUntil`); what is still queued or unsettled at its bound is counted
 * (`unsettled`), never silently dropped.
 */
export const TRUTH_IDLE_MS = 30_000
/** Analog file rate (frames per second, the recorder's 8 kHz WAV). */
const ANALOG_FRAMES_PER_S = 8_000
/**
 * Least virtual time between two runs of a session (after the previous run's lead-in, scene and
 * tails): 1 s, so a restarted core never sees its clock go back.
 */
export const SESSION_MIN_GAP_MS = 1_000
/** A replay decode needs a capture centred within this of its frequency (half a 6.25 kHz step). */
export const REPLAY_REACH_HZ = 3_125

/** One labelled case, times in scene ms (the harness's clock; 0 is the first scene sample). */
export interface TruthCase {
	name: string
	kind: "synthetic" | "capture"
	rateHz: number
	centreHz: number
	/** Every transmission is labelled: an unmatched kept file is false voice. */
	complete: boolean
	intervals: readonly TruthInterval[]
	decodes: readonly TruthDecode[]
	/** When the capture started (epoch ms), for a session's clock; null when unknown. */
	startedAtMs?: number | null
	/** The case's IQ: a fresh source per run. */
	open(): IqChunkSource & { close(): void }
}

/** One analog file the recorder began (a store operation). */
export interface RecordingRecord {
	operationId: string
	discoveryId: string
	/** The recorder channel's frequency (Hz). */
	targetHz: number
	/** Scene ms of the file's first sample; null when the recorder did not say. */
	startMs: number | null
	durationMs: number | null
	outcome: "finalized" | "aborted" | "failed" | "pending"
	/** The WAV is in the state directory at the end of the run. */
	onDisk: boolean
}

export interface InjectedDecodes {
	/** Recorded always-on decodes injected. */
	ambient: number
	/** Recorded probe and replay decodes, not injected (the revision identifies for itself). */
	skipped: number
	/** Recorded decodes before the scene started (the lead-in). */
	dropped: number
	/** Replay probe trials the decoder doubles answered, and how many decoded. */
	replayTrials: number
	replayDecoded: number
	/** Analog replay trials answered. */
	analogTrials: number
}

export interface TruthRun {
	recordings: RecordingRecord[]
	discoveries: DiscoveryRecord[]
	finalIds: string[]
	decodes: InjectedDecodes
	/** The recorder's decision counts (diagnostics). */
	decisions: Record<string, number>
	iqSeconds: number
	wallSeconds: number
	/** Steps that gave up waiting for the recorder's I/O (harness `busy`): 0 when deterministic. */
	busyOverruns: number
	/** Replays still queued or running, and recordings not settled, when the run stopped. */
	unsettled: number
	/**
	 * What happened, in scene ms order: each replay result applied and each recorder decision
	 * (diagnostics; not scored).
	 */
	trace: string[]
}

/** The service's private parts this harness drives (same names on every tree it is run on). */
interface ServiceInternals {
	storageDir: string
	replayQueue: ReplayQueueView | null
	ambient: { emit(event: "evidence", e: unknown): boolean }
	widebandAnalog: RecorderInternals
	spectrum: {
		engine(sourceId: string): { currentEpoch(): { epoch: number } } | undefined
	}
}
interface ReplayQueueView {
	size(): number
	active(): unknown
}
interface RecorderInternals {
	deps: { beginAnalog: (input: BeginInput) => AnalogHandleLike }
	beginOp?: (s: unknown, file: { startSample?: unknown }) => void
	diagnostics(): {
		counts: Record<string, number>
		recent: readonly DecisionEntry[]
		recentRefusals?: readonly DecisionEntry[] | undefined
	}
}
interface DecisionEntry {
	code: string
	at: string
	discoveryId: string | null
}
interface BeginInput {
	discoveryId: string
	observationId: string
	binding: { targetHz: number | null }
}
interface AnalogReceiptLike {
	outcome: "finalized" | "aborted" | "failed"
	output: { outputFrames: number | null }
}
/** The recorder's AnalogHandle (store/analog-operations.ts), as far as this harness uses it. */
interface AnalogHandleLike {
	readonly operationId: string
	readonly ready: Promise<void>
	readonly settled: Promise<AnalogReceiptLike>
	push(pcm: Int16Array): Promise<void>
	addGap(gap: unknown): void
	finish(cut?: unknown): Promise<AnalogReceiptLike>
	cancel(cut?: unknown): void
}

const IDENTITY_KIND: Record<TruthDecode["protocol"], Identity["kind"]> = {
	dmr: "dmr-cc",
	pocsag: "pocsag-capcode",
}
const DECODER: Record<TruthDecode["protocol"], "dsd-fme" | "multimon-ng"> = {
	dmr: "dsd-fme",
	pocsag: "multimon-ng",
}

/**
 * Wraps the recorder: every file it begins, with its first sample and its receipt. Returns
 * whether a store operation has real I/O in flight (its begin not ready yet, a write, or its
 * finish or cancel not settled yet); a file held for a late verdict has none.
 */
function watchRecorder(
	svc: ServiceInternals,
	ctx: InspectContext,
	out: RecordingRecord[],
): () => boolean {
	const rec = svc.widebandAnalog
	const origBeginOp = rec.beginOp
	if (typeof origBeginOp !== "function")
		throw new Error("truth scorecard: the recorder has no beginOp to watch")
	let pendingStart: number | null = null
	let inflight = 0
	const track = <T>(p: Promise<T>): Promise<T> => {
		inflight++
		const done = (): void => {
			inflight--
		}
		p.then(done, done)
		return p
	}
	rec.beginOp = (s, file) => {
		const start = file.startSample
		pendingStart = typeof start === "number" ? start : null
		try {
			origBeginOp.call(rec, s, file)
		} finally {
			pendingStart = null
		}
	}
	const begin = rec.deps.beginAnalog
	rec.deps.beginAnalog = input => {
		const handle = begin(input)
		const r: RecordingRecord = {
			operationId: handle.operationId,
			discoveryId: input.discoveryId,
			targetHz: input.binding.targetHz ?? Number.NaN,
			startMs: pendingStart === null ? null : ctx.sceneMsOfSample(pendingStart),
			durationMs: null,
			outcome: "pending",
			onDisk: false,
		}
		out.push(r)
		void track(handle.ready).catch(() => undefined)
		handle.settled.then(
			receipt => {
				r.outcome = receipt.outcome
				const frames = receipt.output.outputFrames
				r.durationMs =
					frames === null ? null : (frames * 1000) / ANALOG_FRAMES_PER_S
			},
			() => {
				r.outcome = "failed"
			},
		)
		let closing = false
		const close = (): void => {
			if (closing) return
			closing = true
			void track(handle.settled).catch(() => undefined)
		}
		return {
			operationId: handle.operationId,
			ready: handle.ready,
			settled: handle.settled,
			push: pcm => track(handle.push(pcm)),
			addGap: gap => handle.addGap(gap),
			finish: cut => {
				close()
				return handle.finish(cut)
			},
			cancel: cut => {
				close()
				handle.cancel(cut)
			},
		}
	}
	return () => inflight > 0
}

/** Operation ids of the analog WAVs under the state directory (any discovery folder). */
function analogFilesOnDisk(storageDir: string): Set<string> {
	const ids = new Set<string>()
	const root = join(storageDir, "recordings", "analog")
	let folders: string[]
	try {
		folders = readdirSync(root)
	} catch {
		return ids
	}
	for (const folder of folders) {
		let files: string[]
		try {
			files = readdirSync(join(root, folder))
		} catch {
			continue
		}
		for (const f of files) {
			const m = /^analog-([0-9a-f-]{36})\.wav$/.exec(f)
			if (m && statSync(join(root, folder, f)).size > 44) ids.add(m[1]!)
		}
	}
	return ids
}

/**
 * The identity a decode names: the recorded one, else one fixed per channel (a DMR colour code
 * 1 to 15, a 7-digit POCSAG capcode, from the channel's 3.125 kHz step), so two channels never
 * share one and a channel keeps its own across runs.
 */
function identityOf(
	protocol: TruthDecode["protocol"],
	hz: number,
	recorded?: string,
): Identity {
	const step = Math.round(hz / 3_125)
	return {
		kind: IDENTITY_KIND[protocol],
		value:
			recorded ??
			(protocol === "dmr"
				? String(1 + (step % 15))
				: String(1_000_000 + (step % 1_000_000))),
	}
}

/** The ambient decoder ids the run injects as, and their types (the harness's decoder double). */
export const TRUTH_DECODER_TYPES: Readonly<Record<string, string>> = {
	"truth-dsd-fme": "dsd-fme",
	"truth-multimon-ng": "multimon-ng",
}

/**
 * Arms one virtual timer per recorded always-on (`ambient`) decode, at its offset (the clock is
 * installed when `inspect` runs). It reaches the service's ambient evidence handler as the
 * decoder's interpreted evidence would: CRC-clean, its recorded identity, and for dsd-fme the
 * receiver guard applied (no content verification near the tuned centre). `probe` and `replay`
 * decodes in a label file are not injected (`skipped`): they are what the recorded scanner's own
 * identify did, which the revision under test does for itself (the replay doubles below).
 */
function armDecodes(
	svc: ServiceInternals,
	sceneNow: () => number,
	ctx: InspectContext,
	c: TruthCase,
	counts: InjectedDecodes,
): void {
	const epochNow = (): number =>
		svc.spectrum.engine(ctx.sourceId)?.currentEpoch().epoch ?? 0
	for (const d of c.decodes) {
		if (d.via !== "ambient") {
			counts.skipped++
			continue
		}
		if (d.atMs < 0) {
			counts.dropped++
			continue
		}
		setTimeout(() => {
			counts.ambient++
			const raw: DecodeEvidence = {
				protocol: d.protocol,
				identity: identityOf(d.protocol, d.frequencyHz, d.identity),
				metadata: {},
				crcClean: true,
				at: Date.now(),
				epoch: epochNow(),
				origin: "ambient",
				...(d.protocol === "dmr" ? { contentVerified: true } : {}),
			}
			const ev =
				d.protocol === "dmr"
					? guardDsdFmeEvidence(raw, d.frequencyHz, c.centreHz)
					: raw
			svc.ambient.emit("evidence", {
				decoderId: `truth-${DECODER[d.protocol]}`,
				sourceId: ctx.sourceId,
				hz: d.frequencyHz,
				ev,
			})
		}, d.atMs - sceneNow())
	}
}

/**
 * Identify's replay trials, answered from the labels by the decoders the scanner's own replay
 * queue runs (harness `replay`): the queue (FIFO, one capture at a time, the analog trial first
 * and the digital ones `not-needed` after a heard or toned voice) is production's; only the
 * decoders are doubles. Each trial takes REPLAY_TRIAL_MS of virtual time.
 *
 * A capture holds a label when its own IQ window (pre-roll to end) overlaps a confirmed label on
 * its channel (REPLAY_REACH_HZ) by at least REPLAY_MIN_HELD_MS, or the whole label when shorter:
 * a replay decoder needs a POCSAG batch (about 1 s at 1 200 Bd) or several DMR bursts, never a
 * capture's edge. The label it holds most decides:
 * - a probe trial decodes when it is the label's protocol (DMR, POCSAG), else no sync;
 * - the analog trial measures voice (`decoded` with the label's CTCSS tone, else `heard`) and a
 *   bare carrier (`carrier-only`); for DMR, POCSAG, noise, an unknown label or none it holds no
 *   frames (`no-sync`: proves nothing either way). The real trial measures the audio and can be
 *   fooled (noise read as voice, data read as FM); the double never claims what only that
 *   measurement could, so a revision leaning on an analog verdict for digital or noise gains
 *   nothing here. Its voice verdict is ideal (known limit: a weak voice is always heard). The
 *   outcome is the production classifier's own reading of those statistics, so the queue's judge
 *   accepts it.
 */
export const REPLAY_TRIAL_MS = 1_000
export const REPLAY_MIN_HELD_MS = 1_000

export interface Held {
	label: TruthInterval
	heldMs: number
}

/** The label a capture holds most on `rfHz`, or null. */
export function heldBy(
	c: TruthCase,
	capture: CaptureRecord | undefined,
	rfHz: number,
): Held | null {
	if (capture?.windowMs == null) return null
	const [a, b] = capture.windowMs
	let best: Held | null = null
	for (const iv of c.intervals) {
		if (Math.abs(iv.frequencyHz - rfHz) > REPLAY_REACH_HZ) continue
		const ms = Math.min(b, iv.endMs) - Math.max(a, iv.startMs)
		if (ms < Math.min(REPLAY_MIN_HELD_MS, iv.endMs - iv.startMs)) continue
		if (best === null || ms > best.heldMs) best = { label: iv, heldMs: ms }
	}
	return best
}

/** Statistics frames the analog trial reports for a held label (ANALOG_TRIAL_FRAME_MS each). */
export function analogStats(
	held: Held | null,
	mode: AnalogTrialMode,
): AnalogTrialStats {
	const n =
		held === null
			? 0
			: Math.min(
					ANALOG_TRIAL_MAX_FRAMES,
					Math.floor(held.heldMs / ANALOG_TRIAL_FRAME_MS),
				)
	const label = held?.label.label
	const frame: AnalogTrialFrame | null =
		label === "analog-voice"
			? {
					carrierDb: -10,
					hfNoiseDb: -20,
					audioDb: -12,
					syllabic: 0.5,
					cluster: 0.1,
				}
			: label === "carrier"
				? {
						carrierDb: -10,
						hfNoiseDb: -20,
						audioDb: -60,
						syllabic: 0,
						cluster: 0,
					}
				: null
	return {
		mode,
		frames:
			frame === null ? [] : Array.from({ length: n }, () => ({ ...frame })),
		gapSamples: 0,
		floorDb: -60,
	}
}

function replayDoubles(
	c: TruthCase,
	bind: () => { sceneNow: () => number; ctx: InspectContext },
	counts: InjectedDecodes,
	trace: string[],
): ReplayDoubles {
	const cancels = new Set<() => void>()
	/** Settles after REPLAY_TRIAL_MS of virtual time, or at once with `cancelled` on cancel. */
	const later = <T>(answer: () => T, cancelled: () => T) => {
		let settle: ((v: T) => void) | null = null
		const result = new Promise<T>(resolve => {
			settle = resolve
		})
		const timer = setTimeout(() => {
			cancels.delete(cancel)
			settle?.(answer())
		}, REPLAY_TRIAL_MS)
		const cancel = (): void => {
			clearTimeout(timer)
			cancels.delete(cancel)
			settle?.(cancelled())
		}
		cancels.add(cancel)
		return { result, cancel }
	}
	const probes: ReplayDoubles["probes"] = {
		request: req => ({
			run: later<IqReplayProbeAnswer>(
				() => {
					counts.replayTrials++
					const { sceneNow, ctx } = bind()
					const held = heldBy(c, ctx.captures.get(req.captureId), req.rfHz)
					const protocol = held?.label.label
					const decoded =
						(protocol === "dmr" || protocol === "pocsag") &&
						req.protocol === protocol
							? protocol
							: null
					if (decoded !== null) counts.replayDecoded++
					trace.push(
						`${sceneNow()} replay ${req.captureId} ${req.protocol} ${decoded ?? "no-sync"}`,
					)
					return {
						outcome: decoded === null ? "no-sync" : "decoded",
						decoded:
							decoded === null
								? null
								: {
										protocol: decoded,
										identity: identityOf(decoded, req.rfHz),
									},
					}
				},
				() => ({ outcome: "cancelled", decoded: null }),
			),
		}),
		onSlotRelease: () => () => undefined,
		dispose: () => {
			for (const cancel of [...cancels]) cancel()
		},
	}
	const analog: ReplayDoubles["analog"] = {
		run: (captureId, mode, signal) => {
			const run = later<AnalogTrialResult>(
				() => {
					counts.analogTrials++
					const { sceneNow, ctx } = bind()
					const capture = ctx.captures.get(captureId)
					const held = capture ? heldBy(c, capture, capture.rfHz) : null
					const stats = analogStats(held, mode)
					const tones: AnalogTrialTones = {
						ctcssHz:
							held?.label.label === "analog-voice"
								? (held.label.ctcssHz ?? null)
								: null,
						dcs: null,
						audioSeconds: (held?.heldMs ?? 0) / 1000,
					}
					const outcome = classifyAnalogTrial(stats, tones)
					trace.push(`${sceneNow()} analog ${captureId} ${outcome}`)
					return { outcome, mode, voice: isVoice(stats), tones, stats }
				},
				() => ({
					outcome: "no-sync",
					mode,
					voice: false,
					tones: { ctcssHz: null, dcs: null, audioSeconds: 0 },
					stats: null,
					error: "cancelled",
				}),
			)
			signal.addEventListener("abort", run.cancel, { once: true })
			return run.result
		},
	}
	return { probes, analog }
}

/**
 * Runs one case and returns what the recorder kept and what identify concluded. `session`: the
 * state directory earlier cases of the session left (kept) and this case's virtual time 0.
 */
export async function runTruthCase(
	c: TruthCase,
	session?: { stateDir: string; t0Ms: number },
): Promise<TruthRun> {
	const recordings: RecordingRecord[] = []
	const decodes: InjectedDecodes = {
		ambient: 0,
		skipped: 0,
		dropped: 0,
		replayTrials: 0,
		replayDecoded: 0,
		analogTrials: 0,
	}
	let decisions: Record<string, number> = {}
	const trace: string[] = []
	let t0 = 0
	let busy: () => boolean = () => false
	let unsettled = 0
	let queueOf: () => ReplayQueueView | null = () => null
	/** Replays still to answer and recordings still to settle (the run is not done while > 0). */
	const pending = (): number => {
		const q = queueOf()
		return (
			(q ? q.size() + (q.active() === null ? 0 : 1) : 0) +
			recordings.filter(r => r.outcome === "pending").length
		)
	}
	// The replay doubles answer only after the run started (inspect binds the clock and captures).
	let bound: { sceneNow: () => number; ctx: InspectContext } | null = null
	const replay = replayDoubles(
		c,
		() => {
			if (bound === null)
				throw new Error(
					"truth scorecard: a replay trial before the run started",
				)
			return bound
		},
		decodes,
		trace,
	)
	const src = c.open()
	try {
		const run = await runScanner(src, {
			...(session ? { stateDir: session.stateDir, t0Ms: session.t0Ms } : {}),
			provenTuning: true,
			tailMs: TRUTH_TAIL_MS,
			idleTailMs: TRUTH_IDLE_MS,
			busy: () => busy(),
			idleUntil: () => pending() === 0,
			replay,
			decoderTypes: TRUTH_DECODER_TYPES,
			inspect: (service, sceneNow, ctx) => {
				const svc = service as unknown as ServiceInternals
				bound = { sceneNow, ctx }
				queueOf = () => svc.replayQueue
				busy = watchRecorder(svc, ctx, recordings)
				armDecodes(svc, sceneNow, ctx, c, decodes)
				t0 = Date.now() - sceneNow()
			},
			beforeStop: (service: ScannerService) => {
				const svc = service as unknown as ServiceInternals
				unsettled = pending()
				const onDisk = analogFilesOnDisk(svc.storageDir)
				for (const r of recordings) r.onDisk = onDisk.has(r.operationId)
				const diag = svc.widebandAnalog.diagnostics()
				decisions = { ...diag.counts }
				for (const d of [...diag.recent, ...(diag.recentRefusals ?? [])])
					trace.push(
						`${Date.parse(d.at) - t0} recorder ${d.code} ${d.discoveryId ?? "-"}`,
					)
				trace.sort((x, y) => parseFloat(x) - parseFloat(y))
			},
		})
		return {
			recordings,
			discoveries: run.discoveries,
			finalIds: run.finalIds,
			decodes,
			decisions,
			iqSeconds: run.iqSeconds,
			wallSeconds: run.wallSeconds,
			busyOverruns: run.busyOverruns ?? 0,
			unsettled,
			trace,
		}
	} finally {
		src.close()
	}
}

/** A synthetic case: a seeded scene, its truth from the generator, its decodes given. */
export function syntheticCase(
	scene: Scene,
	intervals: readonly TruthInterval[],
	decodes: readonly TruthDecode[],
): TruthCase {
	return {
		name: scene.name,
		kind: "synthetic",
		rateHz: scene.rateHz,
		centreHz: scene.centreHz,
		complete: true,
		intervals,
		decodes,
		open: () => {
			const gen = new SceneGenerator(scene)
			return {
				rateHz: scene.rateHz,
				centreHz: scene.centreHz,
				next: n => gen.next(n),
				leadIn: n => gen.noiseOnly(n),
				close: () => undefined,
			}
		},
	}
}

/**
 * A CU8 capture case. The harness feeds its first LEAD_IN_MS as the lead-in (the noise floor
 * settles on the capture's own floor), so capture time t is scene time t − LEAD_IN_MS: the
 * labels and decodes are shifted by that. A label is clipped to the scene; a decode is kept only
 * from the capture's start to AMBIENT_PAIR_MS (2 s) past its end, the reach the scanner places an
 * ambient decode in after a transmission ends: a later one belongs to a transmission the capture
 * does not hold.
 */
export function captureCase(o: {
	name: string
	path: string
	rateHz: number
	centreHz: number
	durationMs: number
	startedAtMs: number | null
	complete: boolean
	intervals: readonly TruthInterval[]
	decodes: readonly TruthDecode[]
}): TruthCase {
	const sceneEnd = o.durationMs - LEAD_IN_MS
	const intervals = o.intervals
		.map(iv => ({
			...iv,
			startMs: Math.max(0, iv.startMs - LEAD_IN_MS),
			endMs: Math.min(sceneEnd, iv.endMs - LEAD_IN_MS),
		}))
		.filter(iv => iv.endMs > iv.startMs)
	return {
		name: o.name,
		kind: "capture",
		rateHz: o.rateHz,
		centreHz: o.centreHz,
		complete: o.complete,
		startedAtMs: o.startedAtMs,
		intervals,
		decodes: o.decodes
			.filter(d => d.atMs >= 0 && d.atMs <= o.durationMs + AMBIENT_PAIR_MS)
			.map(d => ({ ...d, atMs: d.atMs - LEAD_IN_MS })),
		open: () => fileSource(o.path, o.rateHz, o.centreHz),
	}
}

/**
 * The capture's bytes in order: the lead-in reads its first second, the scene the rest. The
 * tail after it is noise at the capture's own level (the standard deviation of its first second
 * of I and Q), so the noise floor does not step when the capture ends.
 */
function fileSource(
	path: string,
	rateHz: number,
	centreHz: number,
): IqChunkSource & { close(): void } {
	const fd = openSync(path, "r")
	let position = 0
	let ended = false
	const read = (samples: number): Buffer | null => {
		if (ended || samples <= 0) return null
		const buf = Buffer.allocUnsafe(2 * samples)
		const got = readSync(fd, buf, 0, buf.length, position)
		if (got < 2) {
			ended = true
			return null
		}
		position += got & ~1
		return buf.subarray(0, got & ~1)
	}
	const head = Buffer.allocUnsafe(2 * rateHz)
	const headBytes = readSync(fd, head, 0, head.length, 0)
	let sum = 0
	let sq = 0
	for (let i = 0; i < headBytes; i++) {
		const v = (head[i]! - 127.5) / 127.5
		sum += v
		sq += v * v
	}
	const mean = headBytes > 0 ? sum / headBytes : 0
	const sigma =
		headBytes > 0 ? Math.sqrt(Math.max(0, sq / headBytes - mean * mean)) : 0
	const filler = new SceneGenerator(
		buildScene({
			name: "filler",
			rateHz,
			centreHz,
			durationMs: 0,
			seed: 1,
			noiseSigma: sigma > 0 ? sigma : 0.03,
			signals: [],
		}),
	)
	let leadIn = true
	return {
		rateHz,
		centreHz,
		next: n => {
			leadIn = false
			return read(n)
		},
		leadIn: n =>
			leadIn ? (read(n) ?? filler.noiseOnly(n)) : filler.noiseOnly(n),
		close: () => closeSync(fd),
	}
}
