/**
 * Scanner truth scorecard: runs one labelled case (a synthetic scene or a CU8 capture) through
 * the real ScannerService on the virtual clock (harness.ts) with the analog recorder in the
 * loop, and records what it kept.
 *
 * - Tuning is proven (a tuning ledger, as the live receiver's commanded tuning), so the
 *   recorder records as it does live.
 * - Recorded decodes are injected when they reached the live scanner (their recorded offset,
 *   which holds the decoder's own latency), through the seam their path uses in production: an
 *   always-on decoder's evidence (`ambient`) or a live identify probe (`probe`) goes to the
 *   service's ambient evidence handler, which places it on an observation by frequency and time;
 *   an identify replay (`replay`) is applied to the scanner's own IQ capture of that transmission
 *   (`applyReplayResult`), and is lost when the scanner captured none, as it would be live.
 * - Identify replays of the scanner's own captures answer from the labels, late as they do live
 *   (armReplayOracle: the replay queue, then one nominal second per planned trial).
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
import type { IqReplayResult } from "../../../src/core/scanner/iq-capture-contract.js"
import {
	LEAD_IN_MS,
	runScanner,
	type CaptureRecord,
	type DiscoveryRecord,
	type InspectContext,
	type IqChunkSource,
} from "./harness.js"
import { SceneGenerator, buildScene, type Scene } from "./scene.js"
import type { TruthDecode, TruthInterval } from "./truth-labels.js"

/** Noise fed after a case so its tracks close and the recorder asks every file's finish. */
export const TRUTH_TAIL_MS = 3_000
/**
 * Virtual time then run with no IQ: 30 s. By the noise tail's end the recorder has asked every
 * file's finish (a track closes one 500 ms hang after its signal, the recorder decides up to
 * 1 s later); a provisional file is then held for its late verdict at most 26 s (3 s + 8 s +
 * 15 s, the recorder's late-verdict grace where the scanner has one), and a replay answers at
 * most REPLAY_QUEUE_MS + IQ_REPLAY_MAX_TRIALS (8) × REPLAY_TRIAL_MS = 10 s after its capture
 * ended: 30 s covers the longer with 4 s to spare.
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
	ambient: number
	probe: number
	replay: number
	/** Replay decodes with no capture of their transmission, or before the scene started. */
	dropped: number
	/** Identify replays the oracle answered (one per finished capture with probe trials). */
	replays: number
	/** Of those, replays that decoded (the capture held a labelled DMR or POCSAG transmission). */
	replayDecoded: number
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
	/**
	 * What happened, in scene ms order: each replay result applied and each recorder decision
	 * (diagnostics; not scored).
	 */
	trace: string[]
}

/** The service's private parts this harness drives (same names on every tree it is run on). */
interface ServiceInternals {
	storageDir: string
	ambient: { emit(event: "evidence", e: unknown): boolean }
	widebandAnalog: RecorderInternals
	spectrum: {
		engine(sourceId: string): { currentEpoch(): { epoch: number } } | undefined
	}
	applyReplayResult(result: IqReplayResult): void
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
/** Identity of a decode that names none (a synthetic one): a fixed value per protocol. */
const DEFAULT_IDENTITY: Record<TruthDecode["protocol"], string> = {
	dmr: "1",
	pocsag: "1234567",
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

/** The labelled transmission a decode belongs to: the latest one on its channel begun by then. */
function transmissionOf(
	d: TruthDecode,
	intervals: readonly TruthInterval[],
): TruthInterval | null {
	let best: TruthInterval | null = null
	for (const iv of intervals) {
		if (iv.label !== d.protocol) continue
		if (Math.abs(iv.frequencyHz - d.frequencyHz) > REPLAY_REACH_HZ) continue
		if (iv.startMs > d.atMs) continue
		if (best === null || iv.startMs > best.startMs) best = iv
	}
	return best
}

/** The scanner's finished capture of `iv` on the decode's channel, newest first. */
function captureOf(
	d: TruthDecode,
	iv: TruthInterval | null,
	captures: ReadonlyMap<string, CaptureRecord>,
	now: number,
): CaptureRecord | null {
	let best: CaptureRecord | null = null
	for (const c of captures.values()) {
		if (c.finishedMs === null || c.finishedMs > now || c.windowMs === null)
			continue
		if (Math.abs(c.rfHz - d.frequencyHz) > REPLAY_REACH_HZ) continue
		const [a, b] = c.windowMs
		if (iv !== null && (b <= iv.startMs || a >= iv.endMs)) continue
		if (best === null || c.finishedMs > (best.finishedMs ?? 0)) best = c
	}
	return best
}

/** Arms one virtual timer per decode (the clock is installed when `inspect` runs). */
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
		if (d.atMs < 0) {
			counts.dropped++
			continue
		}
		const identity: Identity = {
			kind: IDENTITY_KIND[d.protocol],
			value: d.identity ?? DEFAULT_IDENTITY[d.protocol],
		}
		setTimeout(() => {
			if (d.via === "replay") {
				const capture = captureOf(
					d,
					transmissionOf(d, c.intervals),
					ctx.captures,
					sceneNow(),
				)
				if (capture === null) {
					counts.dropped++
					return
				}
				counts.replay++
				svc.applyReplayResult({
					captureId: capture.captureId,
					sourceId: ctx.sourceId,
					observationId: capture.observationId,
					epoch: epochNow(),
					rfHz: capture.rfHz,
					trials: [
						{
							protocol: d.protocol,
							decoderType: DECODER[d.protocol],
							known: false,
							outcome: "decoded",
						},
					],
					decoded: { protocol: d.protocol, identity },
				})
				return
			}
			counts[d.via]++
			const ev: DecodeEvidence = {
				protocol: d.protocol,
				identity,
				metadata: {},
				crcClean: true,
				at: Date.now(),
				epoch: epochNow(),
				origin: d.via === "probe" ? "probe" : "ambient",
				...(d.protocol === "dmr" ? { contentVerified: true } : {}),
				...(d.via === "probe" ? { transport: "live" as const } : {}),
			}
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
 * Identify replays answer from the labels, late as they do live: a finished capture's probe
 * trials (the real replay plan) run one after another, REPLAY_TRIAL_MS each, after
 * REPLAY_QUEUE_MS in the replay queue. A trial decodes when the capture's own IQ window holds a
 * confirmed DMR or POCSAG label on its channel (REPLAY_REACH_HZ) and the trial is that
 * protocol's; the replay result then names the decode and stops there, as the replay does. Every
 * other trial reports no sync. A capture whose plan holds no probe trial gets no result.
 */
export const REPLAY_QUEUE_MS = 2_000
export const REPLAY_TRIAL_MS = 1_000
/** How often the oracle looks for newly finished captures (virtual ms). */
const REPLAY_POLL_MS = 100

type ReplayTrial = IqReplayResult["trials"][number]

function armReplayOracle(
	svc: ServiceInternals,
	sceneNow: () => number,
	ctx: InspectContext,
	c: TruthCase,
	counts: InjectedDecodes,
	trace: string[],
): void {
	const seen = new Set<string>()
	const epochNow = (): number =>
		svc.spectrum.engine(ctx.sourceId)?.currentEpoch().epoch ?? 0
	setInterval(() => {
		for (const cap of ctx.captures.values()) {
			if (cap.finishedMs === null || seen.has(cap.captureId)) continue
			seen.add(cap.captureId)
			const probes = cap.trials.filter(t => t.kind === "probe")
			if (cap.edge || cap.windowMs === null || probes.length === 0) continue
			const [a, b] = cap.windowMs
			let label: TruthInterval["label"] | null = null
			let best = 0
			for (const iv of c.intervals) {
				if (iv.label !== "dmr" && iv.label !== "pocsag") continue
				if (Math.abs(iv.frequencyHz - cap.rfHz) > REPLAY_REACH_HZ) continue
				const ms = Math.min(b, iv.endMs) - Math.max(a, iv.startMs)
				if (ms > best) {
					best = ms
					label = iv.label
				}
			}
			const hit =
				label === null ? -1 : probes.findIndex(t => t.protocol === label)
			const ran = hit >= 0 ? probes.slice(0, hit + 1) : probes
			const decoded =
				label === "dmr" || label === "pocsag" ? (hit >= 0 ? label : null) : null
			const finished = cap.finishedMs
			setTimeout(
				() => {
					counts.replays++
					if (decoded !== null) counts.replayDecoded++
					trace.push(
						`${sceneNow()} replay ${cap.captureId} ${Math.round(cap.rfHz)} window ${a}..${b} ${decoded ?? "no decode"}`,
					)
					svc.applyReplayResult({
						captureId: cap.captureId,
						sourceId: ctx.sourceId,
						observationId: cap.observationId,
						epoch: epochNow(),
						rfHz: cap.rfHz,
						trials: ran.map(
							(t): ReplayTrial => ({
								protocol: t.protocol as ReplayTrial["protocol"],
								decoderType: t.decoder as ReplayTrial["decoderType"],
								known: false,
								outcome: t.protocol === decoded ? "decoded" : "no-sync",
							}),
						),
						decoded:
							decoded === null
								? null
								: {
										protocol: decoded,
										identity: {
											kind: IDENTITY_KIND[decoded],
											value: DEFAULT_IDENTITY[decoded],
										},
									},
					})
				},
				Math.max(
					1,
					finished +
						REPLAY_QUEUE_MS +
						ran.length * REPLAY_TRIAL_MS -
						sceneNow(),
				),
			)
		}
	}, REPLAY_POLL_MS)
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
		probe: 0,
		replay: 0,
		dropped: 0,
		replays: 0,
		replayDecoded: 0,
	}
	let decisions: Record<string, number> = {}
	const trace: string[] = []
	let t0 = 0
	let busy: () => boolean = () => false
	const src = c.open()
	try {
		const run = await runScanner(src, {
			...(session ? { stateDir: session.stateDir, t0Ms: session.t0Ms } : {}),
			provenTuning: true,
			tailMs: TRUTH_TAIL_MS,
			idleTailMs: TRUTH_IDLE_MS,
			busy: () => busy(),
			inspect: (service, sceneNow, ctx) => {
				const svc = service as unknown as ServiceInternals
				busy = watchRecorder(svc, ctx, recordings)
				armDecodes(svc, sceneNow, ctx, c, decodes)
				armReplayOracle(svc, sceneNow, ctx, c, decodes, trace)
				t0 = Date.now() - sceneNow()
			},
			beforeStop: (service: ScannerService) => {
				const svc = service as unknown as ServiceInternals
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
 * within the capture (0 to its length): one the live system recorded after the capture ended
 * belongs to a transmission the capture does not hold.
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
			.filter(d => d.atMs >= 0 && d.atMs <= o.durationMs)
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
