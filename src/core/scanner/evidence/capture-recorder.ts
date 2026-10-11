/**
 * Burst IQ capture (Task 34a): [observation start − preMs, end + postMs] from
 * the IQ ring plus live bytes, written as cu8 (wideband or a ~48 kHz channel)
 * with a manifest v2 entry. Gap-free or nothing; one stream and one epoch: the
 * pre-roll never reaches before the capture's epoch, and a retune or new stream
 * cuts a closed capture back to its track end.
 *
 * Phases: `recording` (tapping the engine) → the window is complete → kept at once,
 * or, with `onlyDecoded` and no decode yet, `parked` until the ambient pairing
 * window after the close has passed (§ 6.3 ambient evidence arrives late). A
 * `capped` capture (MAX_CAPTURE_SECONDS reached before its track closed) has a
 * complete file and waits for the close.
 */
import { EventEmitter } from "node:events"
import { createWriteStream, type WriteStream } from "node:fs"
import type { ScannerCapture } from "@wavekit/api-types"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import { ulid } from "../ids.js"
import type { ProbeDecoderType } from "../probes/probe-pool.js"
import type {
	EngineStreamReason,
	SpectrumEngine,
} from "../../spectrum/spectrum-engine.js"
import type { TuningTrust } from "../../spectrum/types.js"
import {
	AMBIENT_PAIR_MS,
	type CaptureSpec,
	type DecodeEvidence,
	type Identity,
	type ScannerProtocol,
} from "../types.js"
import type { CaptureStore } from "./capture-store.js"
import { buildFixtureEntry, type CaptureFacts } from "./fixture-entry.js"
import { ChannelDecimator } from "./iq-decimate.js"

export const MAX_CAPTURE_SECONDS = 20
export const MAX_ACTIVE_PER_SOURCE = 2
/** Bytes queued in a capture's WriteStream beyond which the disk is not keeping up: discard. */
export const MAX_PENDING_WRITE_BYTES = 32 * 1024 * 1024
const HOUR_MS = 3_600_000
/** Ambient evidence stamped inside the pairing window can be delivered a little after it. */
const PARK_MARGIN_MS = 500
/** Accepted evidence kept per capture (the observation's own decodes, § 7.1). */
const EVIDENCE_KEEP = 16

/**
 * `accounting().stream` is the ring's stream (sample indices restart at each one); the
 * engine's `"stream"` event ends a capture of the old stream. `currentEpoch().stream`
 * may lag the ring on a thread host right after a reconnect.
 */
export type CaptureEngineView = Pick<
	SpectrumEngine,
	"sourceId" | "format" | "currentEpoch" | "liveEdge" | "readRing" | "tap"
> & {
	accounting(): { stream: number }
	on(
		event: "stream",
		listener: (stream: number, reason: EngineStreamReason) => void,
	): unknown
	off(
		event: "stream",
		listener: (stream: number, reason: EngineStreamReason) => void,
	): unknown
}

export interface CaptureRequest {
	observationId: string
	jobId: string
	sourceId: string
	stream: number
	epoch: number
	startSample: number
	targetHz: number
	spec: CaptureSpec
}

/**
 * What the sidecar needs from the observation; built when the capture is kept (a thunk at
 * close), so a decode that lands after the close is in it. `metadata`/`identity` are the
 * fallback: the capture's own accepted evidence (`evidence()`) wins.
 */
export interface CaptureCloseInfo {
	discoveryId: string | null
	protocol: ScannerProtocol
	identity?: Identity
	metadata: CaptureFacts["metadata"]
	encrypted: boolean
	tuningTrust: TuningTrust
	decoderType: ProbeDecoderType | null
	decoderOptions: Record<string, unknown>
}

export interface CaptureRecorderDeps {
	store: CaptureStore
	engines: (sourceId: string) => CaptureEngineView | undefined
	diskOk: () => boolean
	logger: Logger
	now: () => number
	/** How long after the close an undecoded `onlyDecoded` capture waits for a decode; default AMBIENT_PAIR_MS + 500 ms. */
	decodeWaitMs?: number
}

type DiscardReason =
	| "not-decoded"
	| "gap"
	| "epoch"
	| "stream"
	| "empty"
	| "aborted"
	| "invalid-entry"
	| "write-error"

type Phase = "recording" | "capped" | "parked" | "done"

interface Recording {
	id: string
	req: CaptureRequest
	fs: number
	centreHz: number
	/** Where the pre-roll was asked to start (before the epoch and ring clamps). */
	requestedFrom: number
	startSample: number
	expectNext: number
	/** End of the input samples written to the file. */
	writtenEnd: number
	/** End of the input samples the capture keeps (≤ writtenEnd; a retune cuts it to the track end). */
	keepEnd: number
	/** Input bytes of the pre-roll write, exempt from MAX_PENDING_WRITE_BYTES. */
	preBytes: number
	closeEnd: number | null
	endTarget: number | null
	closedAt: number | null
	maxEnd: number
	file: WriteStream
	fileDone: Promise<void> | null
	outBytes: number
	decimator: ChannelDecimator | null
	untap: () => void
	unwatch: () => void
	decoded: boolean
	evidence: DecodeEvidence[]
	infoOf: (() => CaptureCloseInfo) | null
	phase: Phase
	parkTimer: NodeJS.Timeout | null
	failed: boolean
}

/** Metadata of the capture's own accepted evidence, most recent value first per field. */
function metadataOf(evidence: DecodeEvidence[]): CaptureFacts["metadata"] {
	const out: CaptureFacts["metadata"] = {
		talkgroups: [],
		sources: [],
		capcodes: [],
		callsigns: [],
		ismModels: [],
	}
	for (const ev of [...evidence].sort((a, b) => b.at - a.at)) {
		for (const key of Object.keys(out) as (keyof typeof out)[]) {
			for (const v of ev.metadata[key] ?? [])
				if (!out[key].includes(v)) out[key].push(v)
		}
	}
	return out
}

export class CaptureRecorder extends EventEmitter {
	private readonly log: Logger
	private readonly active = new Map<string, Recording>()
	/** Kept captures between their keep decision and the seal of their file. */
	private readonly sealing = new Set<Recording>()
	/** Commits in flight (seal, manifest entry); stop() awaits them (S1-B final review, finding 5). */
	private readonly committing = new Set<Promise<void>>()
	private readonly decodeWaitMs: number

	constructor(private readonly deps: CaptureRecorderDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "CaptureRecorder")
		this.decodeWaitMs = deps.decodeWaitMs ?? AMBIENT_PAIR_MS + PARK_MARGIN_MS
	}

	activeCount(): number {
		return this.active.size
	}

	has(observationId: string): boolean {
		return this.active.has(observationId)
	}

	open(req: CaptureRequest): boolean {
		if (
			!req.spec.enabled ||
			this.active.has(req.observationId) ||
			!this.deps.diskOk()
		)
			return false
		const now = this.deps.now()
		const recordings = [...this.active.values()]
		// Every uncommitted capture of the job is in flight (recording, capped or parked).
		const inflight = recordings.filter(r => r.req.jobId === req.jobId).length
		if (
			this.deps.store.countSince(req.jobId, now - HOUR_MS) + inflight >=
			req.spec.maxPerHour
		)
			return false
		// Only recording captures read the source: capped and parked ones free their slot.
		if (
			recordings.filter(
				r => r.req.sourceId === req.sourceId && r.phase === "recording",
			).length >= MAX_ACTIVE_PER_SOURCE
		)
			return false
		const view = this.deps.engines(req.sourceId)
		if (!view || view.format !== "U8_IQ") return false
		const epoch = view.currentEpoch()
		if (epoch.epoch !== req.epoch || epoch.stream !== req.stream) return false
		// The ring may already hold a newer stream than the epoch reports: its indices are not the track's.
		if (view.accounting().stream !== req.stream) return false
		const fs = epoch.sampleRateHz
		const requestedFrom = Math.max(
			0,
			req.startSample - Math.round((req.spec.preMs * fs) / 1000),
		)
		// Never before the capture's epoch: older samples are another centre frequency.
		const from = Math.max(requestedFrom, epoch.startSample ?? 0)
		const id = `cap_${ulid(now).toLowerCase()}`
		const file = createWriteStream(this.deps.store.tempPath(id))
		const rec: Recording = {
			id,
			req,
			fs,
			centreHz: epoch.centreHz,
			requestedFrom,
			startSample: 0,
			expectNext: 0,
			writtenEnd: 0,
			keepEnd: 0,
			preBytes: 0,
			closeEnd: null,
			endTarget: null,
			closedAt: null,
			maxEnd: 0,
			file,
			fileDone: null,
			outBytes: 0,
			decimator:
				req.spec.mode === "channel"
					? new ChannelDecimator({
							inputRateHz: fs,
							offsetHz: req.targetHz - epoch.centreHz,
						})
					: null,
			untap: () => undefined,
			unwatch: () => undefined,
			decoded: false,
			evidence: [],
			infoOf: null,
			phase: "recording",
			parkTimer: null,
			failed: false,
		}
		file.on("error", (err: Error) => {
			this.log.warn({ err, id }, "Capture write failed")
			rec.failed = true
		})
		// Ring read and tap in one synchronous block: nothing lost or repeated. The read runs to the
		// ring's end, not liveEdge(): an inline pipeline delivers the track-open while the engine is
		// still ingesting a chunk that is in the ring and tapped, before liveEdge() moves past it.
		const pre = view.readRing(from, Number.MAX_SAFE_INTEGER)
		rec.startSample = pre?.startSample ?? Math.max(from, view.liveEdge())
		rec.expectNext = rec.startSample
		rec.writtenEnd = rec.startSample
		rec.maxEnd = rec.startSample + MAX_CAPTURE_SECONDS * fs
		this.active.set(req.observationId, rec)
		const onStream = (): void => this.ended(rec, "stream")
		view.on("stream", onStream)
		rec.unwatch = () => view.off("stream", onStream)
		rec.untap = view.tap((start, bytes) => this.accept(rec, start, bytes))
		if (pre) {
			// The pre-roll is one write of up to preMs + 1 s of ring: allowed on top of the backlog cap.
			rec.preBytes = pre.bytes.length
			this.accept(rec, pre.startSample, pre.bytes)
		}
		return true
	}

	/** The observation's own accepted evidence (CRC-clean, its epoch): the expected payload's source. */
	evidence(observationId: string, ev: DecodeEvidence): void {
		const rec = this.active.get(observationId)
		if (!rec) return
		rec.evidence.push(ev)
		if (rec.evidence.length > EVIDENCE_KEEP) rec.evidence.shift()
	}

	/** An accepted decode of the observation: keeps a parked capture. */
	decoded(observationId: string): void {
		const rec = this.active.get(observationId)
		if (!rec) return
		rec.decoded = true
		if (rec.phase === "parked") this.startCommit(rec)
	}

	/** The track closed at `endSample`; `infoOf` is evaluated only if the capture is kept. */
	close(
		observationId: string,
		endSample: number,
		infoOf: () => CaptureCloseInfo,
	): void {
		const rec = this.active.get(observationId)
		if (!rec || rec.infoOf || rec.phase === "done") return
		rec.infoOf = infoOf
		rec.closeEnd = endSample
		rec.closedAt = this.deps.now()
		rec.endTarget =
			endSample + Math.round((rec.req.spec.postMs * rec.fs) / 1000)
		if (
			rec.phase === "capped" ||
			rec.expectNext >= Math.min(rec.endTarget, rec.maxEnd)
		) {
			// A capped window may already have been cut by a late retune.
			const end = rec.phase === "capped" ? rec.keepEnd : rec.writtenEnd
			rec.keepEnd = Math.min(end, rec.endTarget)
			this.complete(rec)
		}
	}

	/**
	 * A retune: cut recording captures that closed back to their track end, abort the rest.
	 * `startSample` (the new epoch's settled start) also trims a complete window that the late
	 * `epoch-started` reached after the fact (parked, capped, or committing before its seal).
	 */
	epochChanged(
		sourceId: string,
		epoch: number,
		startSample: number | null = null,
	): void {
		const affected = (rec: Recording) =>
			rec.req.sourceId === sourceId && rec.req.epoch !== epoch
		for (const rec of [...this.active.values()]) {
			if (!affected(rec)) continue
			if (rec.phase === "recording") this.ended(rec, "epoch")
			else this.trimLate(rec, startSample)
		}
		for (const rec of this.sealing)
			if (affected(rec)) this.trimLate(rec, startSample)
	}

	async stop(): Promise<void> {
		await Promise.all(
			[...this.active.values()].map(rec => this.discard(rec, "aborted")),
		)
		await Promise.all(this.committing)
	}

	// === internals ===

	/**
	 * The engine started a new stream or stopped, or the epoch changed. A complete window
	 * (capped or parked) is unaffected. A closed capture keeps [start, track end): its
	 * post-roll may already hold the transient and the new centre.
	 */
	private ended(rec: Recording, reason: "epoch" | "stream"): void {
		if (rec.phase !== "recording") return
		if (rec.closeEnd === null) {
			void this.discard(rec, reason)
			return
		}
		rec.keepEnd = Math.min(rec.writtenEnd, rec.closeEnd)
		this.complete(rec)
	}

	/**
	 * A retune at `at` inside a complete window's kept range: keep [start, track end), or up to
	 * `at` for a capped capture whose track has not closed. The file is cut at the seal.
	 */
	private trimLate(rec: Recording, at: number | null): void {
		if (at === null || at <= rec.startSample || at > rec.keepEnd) return
		const cut = rec.closeEnd !== null && rec.closeEnd < at ? rec.closeEnd : at
		rec.keepEnd = Math.max(rec.startSample, Math.min(rec.keepEnd, cut))
	}

	private accept(rec: Recording, start: number, bytes: Uint8Array): void {
		if (rec.phase !== "recording") return
		if (start !== rec.expectNext) {
			void this.discard(rec, "gap")
			return
		}
		const limit = Math.min(rec.endTarget ?? Infinity, rec.maxEnd)
		const samples = Math.min(bytes.length / 2, Math.max(0, limit - start))
		if (samples > 0) {
			rec.writtenEnd = start + samples
			const piece = bytes.subarray(0, samples * 2)
			const out = rec.decimator ? rec.decimator.push(piece) : piece
			if (out.length > 0) {
				rec.outBytes += out.length
				// A copy: the engine reuses its chunk buffers after the tap returns.
				rec.file.write(Buffer.from(out))
				if (rec.file.writableLength > MAX_PENDING_WRITE_BYTES + rec.preBytes) {
					this.log.warn(
						{ id: rec.id, pendingBytes: rec.file.writableLength },
						"Capture writes are not keeping up",
					)
					void this.discard(rec, "write-error")
					return
				}
			}
		}
		rec.expectNext = start + bytes.length / 2
		if (rec.expectNext < limit) return
		rec.keepEnd = rec.writtenEnd
		if (rec.infoOf) {
			this.complete(rec)
			return
		}
		// MAX_CAPTURE_SECONDS reached before the track closed: the file is complete; wait for the close.
		rec.phase = "capped"
		this.stopReading(rec)
		void this.endFile(rec)
	}

	/** The window is final ([startSample, keepEnd)): keep it now, or park it for a late decode. */
	private complete(rec: Recording): void {
		this.stopReading(rec)
		void this.endFile(rec)
		if (!rec.req.spec.onlyDecoded || rec.decoded) {
			this.startCommit(rec)
			return
		}
		rec.phase = "parked"
		const waited = this.deps.now() - (rec.closedAt ?? this.deps.now())
		rec.parkTimer = setTimeout(
			() => void this.discard(rec, "not-decoded"),
			Math.max(0, this.decodeWaitMs - waited),
		)
		rec.parkTimer.unref()
	}

	private stopReading(rec: Recording): void {
		rec.untap()
		rec.unwatch()
	}

	private endFile(rec: Recording): Promise<void> {
		rec.fileDone ??= new Promise<void>(resolve => rec.file.end(() => resolve()))
		return rec.fileDone
	}

	private async discard(rec: Recording, reason: DiscardReason): Promise<void> {
		if (rec.phase === "done") return
		rec.phase = "done"
		if (rec.parkTimer) clearTimeout(rec.parkTimer)
		this.active.delete(rec.req.observationId)
		this.stopReading(rec)
		await this.endFile(rec)
		await this.deps.store.discard(rec.id).catch(() => undefined)
		this.emit("discarded", rec.req.observationId, reason)
	}

	/** Output bytes of the input range [startSample, keepEnd): the decimator emits one sample per D inputs. */
	private keptBytes(rec: Recording): number {
		const inputs = rec.keepEnd - rec.startSample
		const samples = rec.decimator
			? Math.floor(inputs / rec.decimator.plan.decimation)
			: inputs
		return Math.min(rec.outBytes, 2 * Math.max(0, samples))
	}

	private startCommit(rec: Recording): void {
		const run: Promise<void> = this.commit(rec)
			.catch((err: unknown) =>
				this.log.warn({ err, id: rec.id }, "Committing a capture failed"),
			)
			.finally(() => this.committing.delete(run))
		this.committing.add(run)
	}

	private async commit(rec: Recording): Promise<void> {
		if (rec.phase === "done") return
		const infoOf = rec.infoOf
		if (!infoOf) return this.discard(rec, "aborted")
		if (this.keptBytes(rec) === 0) return this.discard(rec, "empty")
		rec.phase = "done"
		if (rec.parkTimer) clearTimeout(rec.parkTimer)
		this.active.delete(rec.req.observationId)
		// Until the seal, a late epoch-started can still trim the window (epochChanged).
		this.sealing.add(rec)
		await this.endFile(rec)
		this.sealing.delete(rec)
		const fail = async (reason: DiscardReason, err?: unknown) => {
			if (err !== undefined)
				this.log.warn({ err, id: rec.id }, `Capture ${reason}`)
			await this.deps.store.discard(rec.id).catch(() => undefined)
			this.emit("discarded", rec.req.observationId, reason)
		}
		if (rec.failed) return fail("write-error")
		const bytes = this.keptBytes(rec)
		if (bytes === 0) return fail("empty")
		let sha256: string
		try {
			// Cut to the kept window, hash what is on disk, fsync before the rename.
			sha256 = await this.deps.store.seal(rec.id, bytes)
		} catch (err) {
			return fail("write-error", err)
		}
		const info = infoOf()
		const metadata =
			rec.evidence.length > 0 ? metadataOf(rec.evidence) : info.metadata
		const identity =
			[...rec.evidence].reverse().find(ev => ev.identity)?.identity ??
			info.identity
		const sampleRateHz = rec.decimator
			? rec.decimator.plan.outputRateHz
			: rec.fs
		const endSample = rec.keepEnd
		const createdAt = new Date(this.deps.now()).toISOString()
		let entry
		try {
			entry = buildFixtureEntry({
				id: rec.id,
				mode: rec.req.spec.mode,
				sampleRateHz,
				sourceCentreHz: rec.centreHz,
				targetHz: rec.req.targetHz,
				durationS: bytes / 2 / sampleRateHz,
				sha256,
				bytes,
				decoderType: info.decoderType,
				decoderOptions: info.decoderOptions,
				protocol: info.protocol,
				decoded: rec.decoded,
				metadata,
				...(identity ? { identity } : {}),
				jobId: rec.req.jobId,
				sourceId: rec.req.sourceId,
				createdAt,
			})
		} catch (err) {
			return fail("invalid-entry", err)
		}
		const capture: ScannerCapture = {
			id: rec.id,
			createdAt,
			jobId: rec.req.jobId,
			sourceId: rec.req.sourceId,
			observationId: rec.req.observationId,
			discoveryId: info.discoveryId,
			mode: rec.req.spec.mode,
			role:
				entry.role === "channelizer-golden"
					? "channelizer-golden"
					: "tail-golden",
			protocol: info.protocol,
			...(identity ? { identity } : {}),
			decoded: rec.decoded,
			encrypted: info.encrypted,
			tuningTrust: info.tuningTrust,
			sampleRateHz,
			centreHz: rec.centreHz,
			targetHz: rec.req.targetHz,
			stream: rec.req.stream,
			epoch: rec.req.epoch,
			startSample: rec.startSample,
			endSample,
			preRollClippedMs: ((rec.startSample - rec.requestedFrom) / rec.fs) * 1000,
			postTruncated: rec.endTarget !== null && endSample < rec.endTarget,
			durationS: entry.duration_s,
			bytes,
			files: { iq: `${rec.id}.cu8`, manifest: `${rec.id}.json` },
		}
		try {
			await this.deps.store.commit(entry, capture)
		} catch (err) {
			return fail("write-error", err)
		}
		this.log.info(
			{
				id: rec.id,
				protocol: info.protocol,
				durationS: capture.durationS,
				role: capture.role,
			},
			"Burst IQ captured",
		)
		this.emit("captured", capture)
	}
}
