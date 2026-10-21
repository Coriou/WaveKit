/**
 * In-memory capture index (WG11 req 6.4-6.6, 6.8, 6.9; Property 11). Pure state: no filesystem,
 * no process. The service performs the side effects the store asks for through `onRemove`.
 *
 * Bytes: a capture being written reserves the per-capture bound (maxCaptureMs × 48 × 8 B); a
 * finished one holds its actual size; a removed one keeps holding its bytes until the service
 * reports the unlink done (`released`). A request is refused "full" when the held total plus one
 * more reservation would exceed the cap; nothing is evicted to make room.
 *
 * Ownership: an entry is held by nobody (queued) or by exactly one holder (`claim`). A discard
 * while a replay of it runs is deferred to the end of the last replay.
 */
import {
	IQ_CAPTURE_BYTES_PER_SAMPLE,
	IQ_CAPTURE_MAX_BYTES,
	IQ_CAPTURE_MAX_CONCURRENT,
	IQ_CAPTURE_ORPHAN_TTL_MS,
	IQ_CAPTURE_PER_SOURCE_PER_MINUTE,
	IQ_CAPTURE_RATE_HZ,
	type IqCaptureDiscardReason,
	type IqCaptureRefusal,
	type IqCaptureRequest,
	type IqCaptureView,
} from "../scanner/iq-capture-contract.js"

const RATE_WINDOW_MS = 60_000
/** Shortest usable capture: 100 ms at 48 kHz. A shorter file is removed as invalid, never replayed. */
export const IQ_CAPTURE_MIN_SAMPLES = IQ_CAPTURE_RATE_HZ / 10

export type IqCaptureState = "capturing" | "verifying" | "ready"

export interface IqCaptureEntry {
	readonly captureId: string
	readonly privateTrial?: boolean
	readonly sourceId: string
	readonly observationId: string | null
	readonly epoch: number
	readonly rfHz: number
	readonly tuningTrust: IqCaptureView["tuningTrust"]
	readonly requestedAtMs: number
	state: IqCaptureState
	/** Bytes counted against the cap (reservation while writing, actual size after). */
	bytes: number
	samples: number
	gapSamples: number
	finishedAtMs: number | null
	holder: string | null
	replays: number
	replayStarted: boolean
	pendingDiscard: IqCaptureDiscardReason | null
}

export interface IqCaptureCounters {
	accepted: number
	refused: Record<IqCaptureRefusal, number>
	discarded: Record<IqCaptureDiscardReason, number>
	/** Captures that ended without a file (aborted, tool failure, timeout). */
	failed: number
	/** Tool events that named an unknown id or broke a bound (ignored). */
	hostileEvents: number
}

export interface IqCaptureStoreOptions {
	capBytes: number
	maxCaptureMs: number
	now: () => number
	/** The capture left the index; the service unlinks it and then calls `released(bytes)`. */
	onRemove: (
		entry: IqCaptureEntry,
		reason: IqCaptureDiscardReason | "failed",
	) => void
	/**
	 * Review m4: captures removed here that the tool still writes (no final event yet). They keep
	 * their concurrency slot, or the tool would answer the next request `busy`.
	 */
	openInTool?: (sourceId?: string) => number
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
	const out = {} as Record<K, number>
	for (const k of keys) out[k] = 0
	return out
}

const REFUSALS: readonly IqCaptureRefusal[] = [
	"disabled",
	"not-protected",
	"unavailable",
	"rate-limited",
	"busy",
	"full",
	"epoch-changed",
	"invalid",
]
const DISCARDS: readonly IqCaptureDiscardReason[] = [
	"result",
	"confirmed-live",
	"orphan-ttl",
	"invalid",
	"shutdown",
]

export class IqCaptureStore {
	readonly perCaptureBytes: number
	private readonly entries = new Map<string, IqCaptureEntry>()
	private readonly rate = new Map<string, number[]>()
	private releasing = 0
	private readonly c: IqCaptureCounters = {
		accepted: 0,
		refused: zeroRecord(REFUSALS),
		discarded: zeroRecord(DISCARDS),
		failed: 0,
		hostileEvents: 0,
	}

	constructor(private readonly o: IqCaptureStoreOptions) {
		this.perCaptureBytes = Math.min(
			IQ_CAPTURE_MAX_BYTES,
			Math.floor((o.maxCaptureMs * IQ_CAPTURE_RATE_HZ) / 1000) *
				IQ_CAPTURE_BYTES_PER_SAMPLE,
		)
	}

	/** Bytes held: live entries plus removals whose unlink has not finished. */
	heldBytes(): number {
		let total = this.releasing
		for (const e of this.entries.values()) total += e.bytes
		return total
	}

	capturing(): number {
		let n = 0
		for (const e of this.entries.values()) if (e.state === "capturing") n++
		return n
	}

	get(captureId: string): IqCaptureEntry | undefined {
		return this.entries.get(captureId)
	}

	all(): IqCaptureEntry[] {
		return [...this.entries.values()]
	}

	refuse(reason: IqCaptureRefusal): { refused: IqCaptureRefusal } {
		this.c.refused[reason]++
		return { refused: reason }
	}

	countHostile(): void {
		this.c.hostileEvents++
	}

	counters(): IqCaptureCounters {
		return {
			...this.c,
			refused: { ...this.c.refused },
			discarded: { ...this.c.discarded },
		}
	}

	/**
	 * Admission after the service's availability checks: epoch, concurrency, rate (detection only),
	 * cap. On success the entry is indexed as `capturing` with its reservation.
	 */
	admit(
		req: IqCaptureRequest,
		captureId: string,
		currentEpoch: number,
		privateTrial = false,
	): { captureId: string } | { refused: IqCaptureRefusal } {
		if (req.epoch !== currentEpoch) return this.refuse("epoch-changed")
		if (
			(privateTrial
				? this.all().filter(
						e =>
							e.sourceId === req.sourceId &&
							(e.privateTrial || e.state === "capturing"),
					).length
				: this.capturing()) +
				(this.o.openInTool?.(privateTrial ? req.sourceId : undefined) ?? 0) >=
			IQ_CAPTURE_MAX_CONCURRENT
		)
			return this.refuse("busy")
		const now = this.o.now()
		const stamps = (this.rate.get(req.sourceId) ?? []).filter(
			t => now - t < RATE_WINDOW_MS && t <= now,
		)
		this.rate.set(req.sourceId, stamps)
		if (
			req.reason === "detection" &&
			stamps.length >= IQ_CAPTURE_PER_SOURCE_PER_MINUTE
		)
			return this.refuse("rate-limited")
		if (this.heldBytes() + this.perCaptureBytes > this.o.capBytes)
			return this.refuse("full")
		if (this.entries.has(captureId)) return this.refuse("invalid")
		if (req.reason === "detection") stamps.push(now)
		this.entries.set(captureId, {
			captureId,
			privateTrial,
			sourceId: req.sourceId,
			observationId: req.observationId,
			epoch: req.epoch,
			rfHz: req.rfHz,
			tuningTrust: req.tuningTrust,
			requestedAtMs: now,
			state: "capturing",
			bytes: this.perCaptureBytes,
			samples: 0,
			gapSamples: 0,
			finishedAtMs: null,
			holder: null,
			replays: 0,
			replayStarted: false,
			pendingDiscard: null,
		})
		this.c.accepted++
		return { captureId }
	}

	/**
	 * The tool reported the file finished. False (entry removed as invalid) when the sample count
	 * breaks the per-capture bound; an unknown or non-capturing id is hostile and ignored.
	 */
	captured(captureId: string, samples: number, gapSamples: number): boolean {
		const e = this.entries.get(captureId)
		if (!e || e.state !== "capturing") {
			this.countHostile()
			return false
		}
		// Confirmed live while being written: the finished file is moot.
		if (e.pendingDiscard !== null) {
			this.remove(e, e.pendingDiscard)
			return false
		}
		const bytes = samples * IQ_CAPTURE_BYTES_PER_SAMPLE
		if (
			!Number.isSafeInteger(samples) ||
			!Number.isSafeInteger(gapSamples) ||
			samples < 0 ||
			gapSamples < 0 ||
			bytes > this.perCaptureBytes
		) {
			this.countHostile()
			this.remove(e, "invalid")
			return false
		}
		if (samples < IQ_CAPTURE_MIN_SAMPLES) {
			this.remove(e, "invalid")
			return false
		}
		e.state = "verifying"
		e.bytes = bytes
		e.samples = samples
		e.gapSamples = gapSamples
		e.finishedAtMs = this.o.now()
		return true
	}

	/** The file proof passed: the capture is ready (queued, TTL running from its finish). */
	ready(captureId: string): IqCaptureView | null {
		const e = this.entries.get(captureId)
		if (!e || e.state !== "verifying") return null
		e.state = "ready"
		return viewOf(e)
	}

	/**
	 * The capture ended without a usable file (aborted, tool exit, timeout, failed proof). One
	 * confirmed live while being written counts as that discard instead.
	 */
	fail(captureId: string): void {
		const e = this.entries.get(captureId)
		if (!e || e.state === "ready") return
		this.remove(e, e.pendingDiscard ?? "failed")
	}

	/** Discard by reason; deferred while a replay of it runs. */
	discard(captureId: string, reason: IqCaptureDiscardReason): boolean {
		const e = this.entries.get(captureId)
		if (!e) return false
		if (e.replays > 0) {
			e.pendingDiscard ??= reason
			return true
		}
		this.remove(e, reason)
		return true
	}

	/** A ready, unreplayed capture held by nobody (taken now) or already by `holder` (reserved). */
	claim(captureId: string, holder: string): boolean {
		const e = this.entries.get(captureId)
		if (!e || e.state !== "ready" || e.pendingDiscard !== null) return false
		if (e.replayStarted || e.replays > 0) return false
		if (e.holder !== null) return e.holder === holder
		e.holder = holder
		return true
	}

	/**
	 * Review M2: a capture being written is held for its requester from the start, so the replay
	 * queue never takes it over when it finishes. False when gone, finished or held.
	 */
	reserve(captureId: string, holder: string): boolean {
		const e = this.entries.get(captureId)
		if (!e || e.state !== "capturing" || e.holder !== null) return false
		e.holder = holder
		return true
	}

	settle(captureId: string, holder: string): void {
		const e = this.entries.get(captureId)
		if (!e || e.holder !== holder) return
		this.discard(captureId, "result")
	}

	confirmLive(sourceId: string, observationId: string): number {
		let n = 0
		for (const e of [...this.entries.values()]) {
			if (
				e.sourceId !== sourceId ||
				e.observationId !== observationId ||
				e.replayStarted ||
				e.replays > 0 ||
				e.pendingDiscard !== null
			)
				continue
			// Still being written: discarded when the tool finishes or aborts it (the caller ends it).
			if (e.state === "capturing") e.pendingDiscard = "confirmed-live"
			else this.remove(e, "confirmed-live")
			n++
		}
		return n
	}

	/** Finished captures near `hz` (newest first). */
	near(
		sourceId: string,
		hz: number,
		toleranceHz: number,
		opts: { observationId: string | null; limit: number },
	): IqCaptureView[] {
		if (!Number.isFinite(hz) || !Number.isFinite(toleranceHz)) return []
		const limit = Math.max(0, Math.floor(opts.limit))
		const out: IqCaptureEntry[] = []
		for (const e of this.entries.values()) {
			if (
				e.state !== "ready" ||
				e.sourceId !== sourceId ||
				e.pendingDiscard !== null ||
				e.replayStarted ||
				e.holder !== null
			)
				continue
			const sameObs =
				opts.observationId !== null && e.observationId === opts.observationId
			const trusted =
				(e.tuningTrust === "commanded" || e.tuningTrust === "relay") &&
				Math.abs(e.rfHz - hz) <= Math.abs(toleranceHz)
			if (sameObs || trusted) out.push(e)
		}
		out.sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0))
		return out.slice(0, limit).map(viewOf)
	}

	beginReplay(captureId: string): boolean {
		const e = this.entries.get(captureId)
		if (!e || e.state !== "ready" || e.pendingDiscard !== null) return false
		e.replays++
		e.replayStarted = true
		return true
	}

	endReplay(captureId: string): void {
		const e = this.entries.get(captureId)
		if (!e || e.replays === 0) return
		e.replays--
		if (e.replays === 0 && e.pendingDiscard !== null)
			this.remove(e, e.pendingDiscard)
	}

	/** Orphan TTL: every finished capture is discarded (or deferred) 10 min after its finish. */
	expire(): number {
		const now = this.o.now()
		let n = 0
		for (const e of [...this.entries.values()]) {
			if (e.finishedAtMs === null) continue
			if (now - e.finishedAtMs < IQ_CAPTURE_ORPHAN_TTL_MS) continue
			if (e.pendingDiscard !== null) continue
			this.discard(e.captureId, "orphan-ttl")
			n++
		}
		return n
	}

	/**
	 * The earliest instant (clock ms) a finished capture reaches the orphan TTL, null when none
	 * is due; captures with a deferred discard are skipped (they go when their replay ends).
	 */
	nextExpiryAt(): number | null {
		let at: number | null = null
		for (const e of this.entries.values()) {
			if (e.finishedAtMs === null || e.pendingDiscard !== null) continue
			const due = e.finishedAtMs + IQ_CAPTURE_ORPHAN_TTL_MS
			if (at === null || due < at) at = due
		}
		return at
	}

	/** The unlink of a removed entry finished (or failed for good): its bytes are free. */
	released(bytes: number): void {
		this.releasing = Math.max(0, this.releasing - bytes)
	}

	private remove(
		e: IqCaptureEntry,
		reason: IqCaptureDiscardReason | "failed",
	): void {
		this.entries.delete(e.captureId)
		if (reason === "failed") this.c.failed++
		else this.c.discarded[reason]++
		this.releasing += e.bytes
		this.o.onRemove(e, reason)
	}
}

export function viewOf(e: IqCaptureEntry): IqCaptureView {
	return {
		captureId: e.captureId,
		sourceId: e.sourceId,
		observationId: e.observationId,
		epoch: e.epoch,
		rfHz: e.rfHz,
		tuningTrust: e.tuningTrust,
		capturedAtMs: e.finishedAtMs ?? e.requestedAtMs,
		durationMs: Math.round((e.samples * 1000) / IQ_CAPTURE_RATE_HZ),
		gapSamples: e.gapSamples,
	}
}
