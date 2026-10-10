/**
 * Burst IQ capture (Task 34a): [observation start − preMs, end + postMs] from
 * the IQ ring plus live bytes, written as cu8 (wideband or a ~48 kHz channel)
 * with a manifest v2 entry. Gap-free or nothing; one stream and one epoch.
 */
import { createHash, type Hash } from "node:crypto"
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
import type { CaptureSpec, Identity, ScannerProtocol } from "../types.js"
import type { CaptureStore } from "./capture-store.js"
import { buildFixtureEntry, type CaptureFacts } from "./fixture-entry.js"
import { ChannelDecimator } from "./iq-decimate.js"

export const MAX_CAPTURE_SECONDS = 20
export const MAX_ACTIVE_PER_SOURCE = 2
const HOUR_MS = 3_600_000

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

export interface CaptureCloseInfo {
	endSample: number
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

interface Recording {
	id: string
	req: CaptureRequest
	fs: number
	centreHz: number
	requestedFrom: number
	startSample: number
	expectNext: number
	/** End of the input samples actually written; the sidecar range is [startSample, writtenEnd). */
	writtenEnd: number
	endTarget: number | null
	maxEnd: number
	file: WriteStream
	hash: Hash
	outBytes: number
	decimator: ChannelDecimator | null
	untap: () => void
	unwatch: () => void
	decoded: boolean
	info: CaptureCloseInfo | null
	/** MAX_CAPTURE_SECONDS written before the close: the window is complete, the capture waits for its close. */
	capped: boolean
	finishing: boolean
	failed: boolean
}

export class CaptureRecorder extends EventEmitter {
	private readonly log: Logger
	private readonly active = new Map<string, Recording>()

	constructor(private readonly deps: CaptureRecorderDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "CaptureRecorder")
	}

	activeCount(): number {
		return this.active.size
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
		const inflight = recordings.filter(r => r.req.jobId === req.jobId).length
		if (
			this.deps.store.countSince(req.jobId, now - HOUR_MS) + inflight >=
			req.spec.maxPerHour
		)
			return false
		// A capped capture no longer reads the source; it only waits for its track to close.
		if (
			recordings.filter(r => r.req.sourceId === req.sourceId && !r.capped)
				.length >= MAX_ACTIVE_PER_SOURCE
		)
			return false
		const view = this.deps.engines(req.sourceId)
		if (!view || view.format !== "U8_IQ") return false
		const epoch = view.currentEpoch()
		if (epoch.epoch !== req.epoch || epoch.stream !== req.stream) return false
		// The ring may already hold a newer stream than the epoch reports: its indices are not the track's.
		if (view.accounting().stream !== req.stream) return false
		const fs = epoch.sampleRateHz
		const id = `cap_${ulid(now).toLowerCase()}`
		const file = createWriteStream(this.deps.store.tempPath(id))
		const rec: Recording = {
			id,
			req,
			fs,
			centreHz: epoch.centreHz,
			requestedFrom: Math.max(
				0,
				req.startSample - Math.round((req.spec.preMs * fs) / 1000),
			),
			startSample: 0,
			expectNext: 0,
			writtenEnd: 0,
			endTarget: null,
			maxEnd: 0,
			file,
			hash: createHash("sha256"),
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
			info: null,
			capped: false,
			finishing: false,
			failed: false,
		}
		file.on("error", (err: Error) => {
			this.log.warn({ err, id }, "Capture write failed")
			rec.failed = true
		})
		// Ring read and tap in one synchronous block: nothing lost or repeated. The read runs to the
		// ring's end, not liveEdge(): an inline pipeline delivers the track-open while the engine is
		// still ingesting a chunk that is in the ring and tapped, before liveEdge() moves past it.
		const pre = view.readRing(rec.requestedFrom, Number.MAX_SAFE_INTEGER)
		rec.startSample = pre?.startSample ?? view.liveEdge()
		rec.expectNext = rec.startSample
		rec.writtenEnd = rec.startSample
		rec.maxEnd = rec.startSample + MAX_CAPTURE_SECONDS * fs
		this.active.set(req.observationId, rec)
		const onStream = (): void => this.streamEnded(rec)
		view.on("stream", onStream)
		rec.unwatch = () => view.off("stream", onStream)
		rec.untap = view.tap((start, bytes) => this.accept(rec, start, bytes))
		if (pre) this.accept(rec, pre.startSample, pre.bytes)
		return true
	}

	decoded(observationId: string): void {
		const rec = this.active.get(observationId)
		if (rec) rec.decoded = true
	}

	close(observationId: string, info: CaptureCloseInfo): void {
		const rec = this.active.get(observationId)
		if (!rec || rec.finishing) return
		rec.info = info
		rec.endTarget =
			info.endSample + Math.round((rec.req.spec.postMs * rec.fs) / 1000)
		if (rec.capped || rec.expectNext >= Math.min(rec.endTarget, rec.maxEnd))
			void this.finish(rec)
	}

	/** A retune inside a capture: finish closed captures early, abort the rest. */
	epochChanged(sourceId: string, epoch: number): void {
		for (const rec of [...this.active.values()]) {
			if (rec.req.sourceId !== sourceId || rec.req.epoch === epoch) continue
			this.ended(rec, "epoch")
		}
	}

	async stop(): Promise<void> {
		await Promise.all(
			[...this.active.values()].map(rec => this.discard(rec, "aborted")),
		)
	}

	// === internals ===

	/** The engine started a new stream or stopped: the ring no longer continues this capture. */
	private streamEnded(rec: Recording): void {
		this.ended(rec, "stream")
	}

	/** A complete (capped) window is unaffected; a closed capture keeps its truncated post-roll. */
	private ended(rec: Recording, reason: "epoch" | "stream"): void {
		if (rec.finishing || rec.capped) return
		if (rec.info) void this.finish(rec)
		else void this.discard(rec, reason)
	}

	private accept(rec: Recording, start: number, bytes: Uint8Array): void {
		if (rec.finishing || rec.capped) return
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
				rec.hash.update(out)
				rec.outBytes += out.length
				// A copy: the engine reuses its chunk buffers after the tap returns.
				rec.file.write(Buffer.from(out))
			}
		}
		rec.expectNext = start + bytes.length / 2
		if (rec.expectNext < limit) return
		if (rec.info) {
			void this.finish(rec)
			return
		}
		// MAX_CAPTURE_SECONDS reached before the track closed: stop reading and wait for the close.
		rec.capped = true
		rec.untap()
		rec.unwatch()
	}

	private async closeFile(rec: Recording): Promise<void> {
		rec.untap()
		rec.unwatch()
		await new Promise<void>(resolve => rec.file.end(() => resolve()))
	}

	private async discard(rec: Recording, reason: DiscardReason): Promise<void> {
		if (rec.finishing) return
		rec.finishing = true
		this.active.delete(rec.req.observationId)
		await this.closeFile(rec)
		await this.deps.store.discard(rec.id).catch(() => undefined)
		this.emit("discarded", rec.req.observationId, reason)
	}

	private async finish(rec: Recording): Promise<void> {
		if (rec.finishing) return
		const info = rec.info
		if (!info) return this.discard(rec, "aborted")
		if (rec.req.spec.onlyDecoded && !rec.decoded)
			return this.discard(rec, "not-decoded")
		if (rec.outBytes === 0) return this.discard(rec, "empty")
		if (rec.failed) return this.discard(rec, "write-error")
		rec.finishing = true
		this.active.delete(rec.req.observationId)
		await this.closeFile(rec)
		if (rec.failed) {
			await this.deps.store.discard(rec.id).catch(() => undefined)
			this.emit("discarded", rec.req.observationId, "write-error")
			return
		}
		const sampleRateHz = rec.decimator
			? rec.decimator.plan.outputRateHz
			: rec.fs
		// What the file holds: the pre-roll already reaches the live edge when a track closed
		// behind it, so the range can extend past endTarget; short of it = truncated post-roll.
		const endSample = rec.writtenEnd
		const postTruncated = rec.endTarget !== null && endSample < rec.endTarget
		const createdAt = new Date(this.deps.now()).toISOString()
		let entry
		try {
			entry = buildFixtureEntry({
				id: rec.id,
				mode: rec.req.spec.mode,
				sampleRateHz,
				sourceCentreHz: rec.centreHz,
				targetHz: rec.req.targetHz,
				durationS: rec.outBytes / 2 / sampleRateHz,
				sha256: rec.hash.digest("hex"),
				bytes: rec.outBytes,
				decoderType: info.decoderType,
				decoderOptions: info.decoderOptions,
				protocol: info.protocol,
				decoded: rec.decoded,
				metadata: info.metadata,
				...(info.identity ? { identity: info.identity } : {}),
				jobId: rec.req.jobId,
				sourceId: rec.req.sourceId,
				createdAt,
			})
		} catch (err) {
			this.log.warn(
				{ err, id: rec.id },
				"Capture manifest entry failed validation",
			)
			await this.deps.store.discard(rec.id).catch(() => undefined)
			this.emit("discarded", rec.req.observationId, "invalid-entry")
			return
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
			...(info.identity ? { identity: info.identity } : {}),
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
			postTruncated,
			durationS: entry.duration_s,
			bytes: rec.outBytes,
			files: { iq: `${rec.id}.cu8`, manifest: `${rec.id}.json` },
		}
		try {
			await this.deps.store.commit(entry, capture)
		} catch (err) {
			this.log.warn({ err, id: rec.id }, "Capture commit failed")
			await this.deps.store.discard(rec.id).catch(() => undefined)
			this.emit("discarded", rec.req.observationId, "write-error")
			return
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
