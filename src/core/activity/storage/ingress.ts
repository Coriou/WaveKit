import { randomUUID } from "node:crypto"
import { ACTIVITY_RECORD_VERSION } from "./contract.js"
import type {
	AdmitRejection,
	AdmitResult,
	AnalogTransmissionAdmission,
	IngestionGapPayload,
} from "./contract.js"
import type { ActivityLimits } from "./limits.js"
import { buildActivityRow } from "./row.js"
import type { BuiltActivityRow } from "./row.js"
import { isTelemetryOutput } from "./telemetry.js"
import { PositionCoalescer } from "./coalesce.js"
import type {
	CoalesceFlush,
	CoalesceMerge,
	CoalescePresenter,
	CoalesceUndo,
} from "./coalesce.js"
import { withEnvelopeMetadata, withMergedData } from "../envelope.js"
import { MAX_ENVELOPE_BYTES } from "../projection.js"
import { FloodDedupe, floodKeyOf } from "./flood-dedupe.js"
import type { FloodKey } from "./flood-dedupe.js"
import type { DecodeEnvelope } from "../types.js"
import type { Logger } from "../../../utils/logger.js"

const TOKEN = 1_000_000
const MAX_GAP_DECODERS = 32
/** Held rows passed over per flush for want of queue room before the flush waits. */
const MAX_FLUSH_SKIPS = 32

/** Why a held row was not queued: "queue-bytes" when only its own size kept it out. */
type HeldRejection =
	| "store-paused"
	| "queue-full"
	| "rate-limited"
	| "queue-bytes"

export interface IngressCounters {
	admitted: number
	excludedTelemetry: number
	dropped: Record<IngestionGapPayload["reason"] | "closed", number>
}

interface GapEpisode {
	reason: IngestionGapPayload["reason"]
	dropped: number
	decoderIds: string[]
	fromReceivedAt: string
	toReceivedAt: string
	eventId: string
	openedAt: number
	lastDropAt: number
}

/**
 * Main-thread admission. Token buckets are integer micro-tokens so refill does
 * not drift. One gap record is held outside the queue cap. An episode closes
 * after gapQuietMs with no drops, or at most once per gapMaxIntervalMs while
 * drops continue. The store also closes it from a gapQuietMs timer when
 * admits stop, and on shutdown before the queue is abandoned. The warn log
 * follows that same close.
 */
export class ActivityIngress {
	readonly dropped: IngressCounters["dropped"] = {
		"rate-limited": 0,
		"queue-full": 0,
		"store-paused": 0,
		"write-failed": 0,
		closed: 0,
	}
	admitted = 0
	excludedTelemetry = 0
	/** Held entity rows the queue or the global bucket turned away; still held, retried. */
	coalesceDeferrals = 0
	/** Rows of a tracked entity stored as their own data: the merged state did not fit. */
	coalesceMergeFailures = 0
	/** No held row is retried before this store-clock time (after a deferral). */
	private flushRetryAt = Number.NEGATIVE_INFINITY
	private readonly global: TokenBucket
	private readonly coalescer: PositionCoalescer
	/** Undo of each queued or in-flight row's coalescing state, by eventId. */
	private readonly coalesceUndo = new Map<string, CoalesceUndo>()
	private readonly decoders = new Map<string, TokenBucket>()
	private readonly flood = new FloodDedupe()
	/** Flood key of each queued or in-flight mesh row, by eventId. */
	private readonly floodPending = new Map<string, string>()
	private floodCopyCount = 0
	private readonly queue: BuiltActivityRow[] = []
	private queueBytes = 0
	private inFlight: BuiltActivityRow[] = []
	private inFlightBytes = 0
	private pendingGap: BuiltActivityRow | undefined
	private gapHeld = false
	private episode: GapEpisode | undefined
	private closed = false

	constructor(
		private readonly limits: ActivityLimits,
		private readonly now: () => number,
		private readonly logger: Logger,
	) {
		this.global = new TokenBucket(
			limits.globalRatePerSec,
			limits.globalBurst,
			now(),
		)
		this.coalescer = new PositionCoalescer(
			limits.positionCoalesceMs,
			limits.positionCoalesceMaxEntities,
			now,
			envelope => {
				this.noteDrop(
					"queue-full",
					envelope.receivedAt,
					envelope.decoderId,
					this.now(),
				)
			},
		)
	}

	/** Receptions merged into their entity's latest state instead of a row of their own. */
	get coalescedPositions(): number {
		return this.coalescer.coalesced
	}

	/** Evicted entity rows dropped because the entity's newer row was queued first. */
	get coalesceSuperseded(): number {
		return this.coalescer.superseded
	}

	/** Store-clock time the next held entity row is due (or retried), if any. */
	nextCoalesceDueAt(): number | undefined {
		const due = this.coalescer.nextDueAt()
		return due === undefined ? undefined : Math.max(due, this.flushRetryAt)
	}

	/** Evicted entities whose held row waits for queue room (at most maxEntities). */
	heldEvictedCount(): number {
		return this.coalescer.evictedCount()
	}

	/**
	 * Queues a row for each entity whose held receptions are due (or whose
	 * entity was evicted). O(rows queued): the held entities are in due order.
	 *
	 * These rows skip the per-decoder bucket: they are bounded by the entities,
	 * not by the decoder's rate. A held entity flushes at most once per window
	 * (its next hold starts a new window), so at most maxEntities per
	 * positionCoalesceMs in all (4,096 / 60 s ≈ 68/s at the extreme, a few per
	 * second at a busy site); an evicted entity's row follows a first sighting
	 * that took both buckets. They do take a global token, so the writer's
	 * bound holds. A row the global bucket, the queue caps or a paused store
	 * turn away is not lost: it stays held (counted in coalesceDeferrals, not
	 * as a drop) and every held row waits pauseRetryMs before the next try.
	 * A row only the queue's free bytes turn away is passed over, so smaller
	 * rows behind it still queue (up to MAX_FLUSH_SKIPS per flush, bounding the
	 * rows built). A row over queueMaxBytes itself never waits (enqueueHeld).
	 */
	flushCoalesced(now: number): void {
		if (this.closed || now < this.flushRetryAt) return
		// Every admit calls this: no generator unless a held row is due.
		const due = this.coalescer.nextDueAt()
		if (due === undefined || due > now) return
		let deferred = false
		let skips = 0
		for (const flush of this.coalescer.dueFlushes(now)) {
			const reason = this.enqueueHeld(flush, now, true)
			if (reason === undefined) continue
			deferred = true
			if (reason !== "queue-bytes" || ++skips >= MAX_FLUSH_SKIPS) break
		}
		if (!deferred) return
		this.coalesceDeferrals++
		this.flushRetryAt = now + this.limits.pauseRetryMs
	}

	/**
	 * Shutdown: every held entity row, due or not, before the queue drains,
	 * without token buckets (at most 2 × maxEntities rows). A row the queue
	 * caps or a paused store turn away now is a counted drop.
	 */
	flushAllCoalesced(): void {
		if (this.closed) return
		const now = this.now()
		for (const flush of this.coalescer.takeAll()) {
			const reason = this.enqueueHeld(flush, now, false)
			if (reason !== undefined)
				this.noteDrop(
					reason === "queue-bytes" ? "queue-full" : reason,
					flush.envelope.receivedAt,
					flush.envelope.decoderId,
					now,
				)
		}
	}

	/**
	 * Queues a held entity row; returns why it was turned away (nothing
	 * counted). A row over queueMaxBytes could never queue, whatever the
	 * queue holds: it falls back to the latest held reception's own data, and
	 * when even that is over the cap the held receptions are consumed as a
	 * counted queue-full drop. Either way nothing is left to block later rows.
	 */
	private enqueueHeld(
		flush: CoalesceFlush,
		now: number,
		globalToken: boolean,
	): HeldRejection | undefined {
		if (this.paused) return "store-paused"
		if (this.itemOverflow()) return "queue-full"
		if (globalToken) {
			this.global.refill(now)
			if (!this.global.available()) return "rate-limited"
		}
		let { envelope: stored, merged } = storedEnvelope(
			flush.envelope,
			flush.present,
			flush.merged,
		)
		if (merged) stored = stampedNow(stored, now)
		let row = buildReceptionRow(stored)
		if (merged && row.recordBytes > this.limits.queueMaxBytes) {
			stored = ownEnvelope(flush.envelope, flush.present)
			merged = false
			row = buildReceptionRow(stored)
		}
		if (row.recordBytes > this.limits.queueMaxBytes) {
			flush.commit().settle()
			this.noteDrop(
				"queue-full",
				flush.envelope.receivedAt,
				flush.envelope.decoderId,
				now,
			)
			return undefined
		}
		if (this.byteOverflow(row)) return "queue-bytes"
		if (globalToken) this.global.take()
		// The merged state cannot outgrow an envelope (coalesce.ts), but it can
		// outgrow queueMaxBytes or fail a presentation: the row then stands for
		// the latest reception.
		if (!merged) this.coalesceMergeFailures++
		this.pushReception(row, flush.commit(), undefined, now)
		this.coalescer.rememberAircraft(stored)
		return undefined
	}

	/** Meshtastic flood copies not stored (req 6.6); not a loss. */
	get floodCopies(): number {
		return this.floodCopyCount
	}

	/**
	 * `present`, when given, is called only after coalescing and admission
	 * have kept the reception, and its envelope is the one stored. Coalescing
	 * reads decodedData, outputType, decoderId and receivedAt, which a
	 * presentation never changes. For a tracked entity it is called with the
	 * entity's merged latest state (coalesce.ts) and must present that data;
	 * a held reception keeps it until its entity's row is stored.
	 */
	admit(envelope: DecodeEnvelope, present?: CoalescePresenter): AdmitResult {
		if (this.closed) {
			this.dropped.closed++
			return { admitted: false, reason: "closed" }
		}
		if (isTelemetryOutput(envelope.outputType)) {
			this.excludedTelemetry++
			return { admitted: false, reason: "telemetry" }
		}
		let floodKey: FloodKey | undefined
		if (envelope.outputType === "meshtastic") {
			floodKey = floodKeyOf(envelope.decodedData, envelope.receivedAt)
			if (floodKey && this.flood.isCopy(floodKey)) {
				this.floodCopyCount++
				return { admitted: false, reason: "flood-copy" }
			}
		}
		const now = this.now()
		// O(1) when nothing is due: the next held entity row is at the front.
		this.flushCoalesced(now)
		const coalesce = this.coalescer.decide(envelope, present)
		if (!coalesce.store) {
			this.coalescer.noteCoalesced()
			return { admitted: false, reason: "coalesced" }
		}
		const result = this.enqueueReception(
			envelope,
			present,
			coalesce.merged,
			coalesce.commit,
			floodKey,
			now,
		)
		// An evicted entity's held receptions are flushed right away.
		if (result.admitted) this.flushCoalesced(now)
		return result
	}

	private enqueueReception(
		envelope: DecodeEnvelope,
		present: CoalescePresenter | undefined,
		merge: CoalesceMerge | undefined,
		commit: (keepHeld?: boolean) => CoalesceUndo,
		floodKey: FloodKey | undefined,
		now: number,
	): AdmitResult {
		if (this.paused) return this.rejectEnvelope(envelope, "store-paused")
		if (this.itemOverflow()) return this.rejectEnvelope(envelope, "queue-full")
		if (!this.takeTokens(envelope.decoderId, now))
			return this.rejectEnvelope(envelope, "rate-limited")
		const { envelope: stored, merged } = storedEnvelope(
			envelope,
			present,
			merge,
		)
		const row = buildReceptionRow(stored)
		if (this.byteOverflow(row)) {
			this.refundTokens(envelope.decoderId)
			this.noteDrop("queue-full", envelope.receivedAt, envelope.decoderId, now)
			return { admitted: false, reason: "queue-full" }
		}
		// Stored as its own data: the held receptions wait for a row that carries them.
		if (!merged) this.coalesceMergeFailures++
		this.pushReception(row, commit(!merged), floodKey, now)
		this.coalescer.rememberAircraft(stored)
		return { admitted: true }
	}

	private pushReception(
		row: BuiltActivityRow,
		undo: CoalesceUndo,
		floodKey: FloodKey | undefined,
		now: number,
	): void {
		this.stageDueEpisode(now)
		this.queue.push(row)
		this.queueBytes += row.recordBytes
		this.admitted++
		this.coalesceUndo.set(row.eventId, undo)
		if (floodKey) {
			this.flood.remember(floodKey, row.eventId)
			this.floodPending.set(row.eventId, floodKey.key)
		}
	}

	/**
	 * Admits one closed analog transmission. The per-decoder bucket key is
	 * `analog:<sourceId>` so a source has its own token budget. Gap episodes
	 * record that key in decoderIds. Never telemetry.
	 */
	admitTransmission(input: AnalogTransmissionAdmission): AdmitResult {
		if (this.closed) {
			this.dropped.closed++
			return { admitted: false, reason: "closed" }
		}
		const now = this.now()
		const bucket = `analog:${input.payload.sourceId}`
		if (this.paused)
			return this.rejectTransmission(input, bucket, "store-paused")
		if (this.itemOverflow())
			return this.rejectTransmission(input, bucket, "queue-full")
		if (!this.takeTokens(bucket, now))
			return this.rejectTransmission(input, bucket, "rate-limited")
		let row: BuiltActivityRow
		try {
			row = buildActivityRow({
				version: ACTIVITY_RECORD_VERSION,
				eventId: input.payload.transmissionId,
				commitSeq: "0",
				producedAt: input.producedAt,
				receivedAt: input.receivedAt,
				kind: "analog-transmission",
				payload: input.payload,
			})
		} catch (error) {
			this.refundTokens(bucket)
			throw error
		}
		if (this.byteOverflow(row)) {
			this.refundTokens(bucket)
			this.noteDrop("queue-full", input.receivedAt, bucket, now)
			return { admitted: false, reason: "queue-full" }
		}
		this.stageDueEpisode(now)
		this.queue.push(row)
		this.queueBytes += row.recordBytes
		this.admitted++
		return { admitted: true }
	}

	/** Set by the store when the WAL cap is in force. */
	paused = false

	takeBatch(maxItems: number, maxBytes: number): BuiltActivityRow[] {
		if (this.inFlight.length > 0) return []
		const batch: BuiltActivityRow[] = []
		let bytes = 0
		if (this.pendingGap) {
			batch.push(this.pendingGap)
			bytes += this.pendingGap.recordBytes
			this.pendingGap = undefined
		}
		while (this.queue.length > 0 && batch.length < maxItems) {
			const next = this.queue[0]
			if (!next) break
			if (batch.length > 0 && bytes + next.recordBytes > maxBytes) break
			this.queue.shift()
			this.queueBytes -= next.recordBytes
			batch.push(next)
			bytes += next.recordBytes
		}
		this.inFlight = batch
		this.inFlightBytes = bytes
		return batch
	}

	ack(done: ReadonlySet<string>): void {
		// Rows written (or duplicates) keep their coalescing state; noteSkipped
		// has already rolled back the failed ones.
		for (const row of this.inFlight) {
			this.settleCoalescing(row.eventId)
			this.floodPending.delete(row.eventId)
		}
		const gap = this.inFlight.find(row => row.kind === "ingestion-gap")
		if (gap) {
			if (done.has(gap.eventId)) this.gapHeld = false
			else this.pendingGap = gap
		}
		this.inFlight = []
		this.inFlightBytes = 0
	}

	nack(): void {
		const gap = this.inFlight.find(row => row.kind === "ingestion-gap")
		const failed = this.inFlight.filter(row => row.kind !== "ingestion-gap")
		this.inFlight = []
		this.inFlightBytes = 0
		if (gap) this.pendingGap = gap
		// Newest first, so each undo sees the state its own commit left. A row
		// of held receptions only is held again: nothing lost, no drop counted.
		const kept = new Set<string>()
		for (const row of [...failed].reverse())
			if (this.rollBackCoalescing(row.eventId)) kept.add(row.eventId)
		if (kept.size > 0) this.deferHeldRetry()
		for (const row of failed) this.forgetFlood(row.eventId)
		for (const row of failed)
			if (!kept.has(row.eventId))
				this.noteDrop(
					"write-failed",
					new Date(row.receivedAtMs).toISOString(),
					row.decoderId,
					this.now(),
				)
	}

	noteSkipped(
		batch: readonly BuiltActivityRow[],
		eventIds: readonly string[],
	): void {
		const skipped = new Set(eventIds)
		const kept = new Set<string>()
		for (const row of [...batch].reverse())
			if (skipped.has(row.eventId)) {
				if (this.rollBackCoalescing(row.eventId)) kept.add(row.eventId)
				this.forgetFlood(row.eventId)
			}
		if (kept.size > 0) this.deferHeldRetry()
		for (const row of batch) {
			if (
				!skipped.has(row.eventId) ||
				kept.has(row.eventId) ||
				row.kind === "ingestion-gap"
			)
				continue
			this.noteDrop(
				"write-failed",
				new Date(row.receivedAtMs).toISOString(),
				row.decoderId,
				this.now(),
			)
		}
	}

	/**
	 * Receptions held again after a failed write are retried after
	 * pauseRetryMs, not at once, so a failing writer is not spun on.
	 */
	private deferHeldRetry(): void {
		this.flushRetryAt = Math.max(
			this.flushRetryAt,
			this.now() + this.limits.pauseRetryMs,
		)
	}

	/**
	 * The writer is gone (call after markClosed): every held entity row, due
	 * or not, is a counted write-failed loss, since no flush can carry it now.
	 */
	abandonHeld(): void {
		const now = this.now()
		for (const flush of this.coalescer.takeAll()) {
			flush.commit().settle()
			this.noteDrop(
				"write-failed",
				flush.envelope.receivedAt,
				flush.envelope.decoderId,
				now,
			)
		}
	}

	/** Clears an in-flight batch without counting it. A timed-out write may still commit. */
	forgetInFlight(): void {
		for (const row of this.inFlight) {
			this.settleCoalescing(row.eventId)
			this.floodPending.delete(row.eventId)
		}
		this.inFlight = []
		this.inFlightBytes = 0
	}

	/**
	 * A failed write must not suppress the entity's next reception (for example
	 * the retransmission of a name-bearing report): restore its prior state.
	 */
	private settleCoalescing(eventId: string): void {
		const undo = this.coalesceUndo.get(eventId)
		this.coalesceUndo.delete(eventId)
		undo?.settle()
	}

	/** A failed or skipped write forgets its flood entry if still its own. */
	private forgetFlood(eventId: string): void {
		const key = this.floodPending.get(eventId)
		if (key === undefined) return
		this.floodPending.delete(eventId)
		this.flood.forget(key, eventId)
	}

	/**
	 * True when the row's held receptions are held again (the row lost
	 * nothing). Never once closed: no flush can carry them any more, so the
	 * row is a counted write-failed loss rather than silently held.
	 */
	private rollBackCoalescing(eventId: string): boolean {
		const undo = this.coalesceUndo.get(eventId)
		this.coalesceUndo.delete(eventId)
		if (this.closed) return false
		return undo?.() ?? false
	}

	/** An episode is open and has not been staged yet. */
	hasOpenEpisode(): boolean {
		return this.episode !== undefined
	}

	/** When the open episode has been quiet for gapQuietMs, if one is open. */
	gapQuietDueAt(): number | undefined {
		const episode = this.episode
		if (!episode) return undefined
		return episode.lastDropAt + this.limits.gapQuietMs
	}

	/**
	 * Closes the open episode once it has been quiet for gapQuietMs, or once
	 * it has been open for gapMaxIntervalMs. Returns true when a gap row was
	 * staged.
	 */
	stageDueEpisode(now: number): boolean {
		const episode = this.episode
		if (!episode || this.gapHeld) return false
		const quiet = now - episode.lastDropAt >= this.limits.gapQuietMs
		const aged = now - episode.openedAt >= this.limits.gapMaxIntervalMs
		if (!quiet && !aged) return false
		this.commitEpisode(episode, now)
		return true
	}

	/**
	 * Closes the open episode immediately. Shutdown calls this before it
	 * abandons the queue, and the quiet timer calls it after gapQuietMs.
	 */
	stageOpenEpisode(now: number): boolean {
		const episode = this.episode
		if (!episode || this.gapHeld) return false
		this.commitEpisode(episode, now)
		return true
	}

	markClosed(): void {
		this.closed = true
	}

	/**
	 * Drops anything still queued at shutdown. Non-gap rows count as
	 * write-failed. A gap record is not a loss; its underlying drops were
	 * already counted. No new gap episode is started.
	 */
	abandonQueued(): void {
		const rows = [...this.inFlight, ...this.queue]
		this.coalesceUndo.clear()
		this.floodPending.clear()
		this.inFlight = []
		this.inFlightBytes = 0
		this.queue.length = 0
		this.queueBytes = 0
		this.pendingGap = undefined
		for (const row of rows) {
			if (row.kind === "ingestion-gap") continue
			this.dropped["write-failed"]++
		}
	}

	pendingCount(): number {
		return this.queue.length + (this.pendingGap ? 1 : 0)
	}

	pendingBytes(): number {
		return this.queueBytes + (this.pendingGap?.recordBytes ?? 0)
	}

	inFlightCount(): number {
		return this.inFlight.length
	}

	hasPending(): boolean {
		return this.pendingCount() > 0 || this.inFlight.length > 0
	}

	queueDepth(): number {
		return this.queue.length + this.inFlight.length + (this.pendingGap ? 1 : 0)
	}

	queueBytesTotal(): number {
		return (
			this.queueBytes + this.inFlightBytes + (this.pendingGap?.recordBytes ?? 0)
		)
	}

	private rejectEnvelope(
		envelope: DecodeEnvelope,
		reason: Exclude<
			AdmitRejection,
			"closed" | "telemetry" | "coalesced" | "flood-copy"
		>,
	): AdmitResult {
		this.noteDrop(reason, envelope.receivedAt, envelope.decoderId, this.now())
		return { admitted: false, reason }
	}

	private rejectTransmission(
		input: AnalogTransmissionAdmission,
		bucket: string,
		reason: Exclude<
			AdmitRejection,
			"closed" | "telemetry" | "coalesced" | "flood-copy"
		>,
	): AdmitResult {
		this.noteDrop(reason, input.receivedAt, bucket, this.now())
		return { admitted: false, reason }
	}

	private noteDrop(
		reason: IngestionGapPayload["reason"],
		receivedAt: string,
		decoderId: string | null,
		now: number,
	): void {
		this.dropped[reason]++
		if (!this.episode) {
			this.episode = {
				reason,
				dropped: 0,
				decoderIds: [],
				fromReceivedAt: receivedAt,
				toReceivedAt: receivedAt,
				eventId: randomUUID(),
				openedAt: now,
				lastDropAt: now,
			}
		}
		this.episode.dropped++
		this.episode.lastDropAt = now
		this.episode.toReceivedAt = receivedAt
		if (
			decoderId &&
			!this.episode.decoderIds.includes(decoderId) &&
			this.episode.decoderIds.length < MAX_GAP_DECODERS
		) {
			this.episode.decoderIds.push(decoderId)
			this.episode.decoderIds.sort()
		}
	}

	/**
	 * Stages the episode outside the token bucket and the queue item cap
	 * (one reserved slot).
	 */
	private commitEpisode(episode: GapEpisode, now: number): void {
		this.episode = undefined
		this.gapHeld = true
		const at = new Date(now).toISOString()
		this.pendingGap = buildActivityRow({
			version: ACTIVITY_RECORD_VERSION,
			eventId: episode.eventId,
			commitSeq: "0",
			producedAt: at,
			receivedAt: at,
			kind: "ingestion-gap",
			payload: {
				reason: episode.reason,
				dropped: episode.dropped,
				decoderIds: episode.decoderIds,
				fromReceivedAt: episode.fromReceivedAt,
				toReceivedAt: episode.toReceivedAt,
			},
		})
		this.logger.warn(
			{
				reason: episode.reason,
				dropped: episode.dropped,
				decoderIds: episode.decoderIds,
			},
			"activity ingestion gap queued",
		)
	}

	private itemOverflow(): boolean {
		return (
			this.queue.length + this.inFlight.length + 1 > this.limits.queueMaxItems
		)
	}

	private byteOverflow(row: BuiltActivityRow): boolean {
		return (
			this.queueBytes + this.inFlightBytes + row.recordBytes >
			this.limits.queueMaxBytes
		)
	}

	private takeTokens(decoderId: string, now: number): boolean {
		const decoder = this.bucketFor(decoderId, now)
		this.global.refill(now)
		decoder.refill(now)
		if (!this.global.available() || !decoder.available()) return false
		this.global.take()
		decoder.take()
		return true
	}

	private refundTokens(decoderId: string): void {
		this.global.refund()
		this.bucketFor(decoderId, this.now()).refund()
	}

	private bucketFor(decoderId: string, now: number): TokenBucket {
		const existing = this.decoders.get(decoderId)
		if (existing) return existing
		if (this.decoders.size >= 512) {
			for (const [id, bucket] of this.decoders) {
				if (id !== decoderId && bucket.full()) {
					this.decoders.delete(id)
					break
				}
			}
		}
		const created = new TokenBucket(
			this.limits.decoderRatePerSec,
			this.limits.decoderBurst,
			now,
		)
		this.decoders.set(decoderId, created)
		return created
	}
}

function buildReceptionRow(stored: DecodeEnvelope): BuiltActivityRow {
	return buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId: stored.eventId,
		commitSeq: "0",
		producedAt: stored.producedAt,
		receivedAt: stored.receivedAt,
		kind: "decoder-reception",
		payload: stored,
	})
}

/**
 * The envelope a kept reception is stored as: presented with the entity's
 * merged state when there is one, else as received. A presenter that throws
 * falls back to the unpresented merge, which keeps the envelope's own
 * presentation. `merged` is false when a merged state was given but no
 * envelope could carry it (over MAX_ENVELOPE_BYTES): the reception is stored
 * as its own data instead and the caller keeps the held receptions.
 */
function storedEnvelope(
	envelope: DecodeEnvelope,
	present: CoalescePresenter | undefined,
	merge: CoalesceMerge | undefined,
): { envelope: DecodeEnvelope; merged: boolean } {
	if (present) {
		try {
			return {
				envelope: merge === undefined ? present() : present(merge),
				merged: true,
			}
		} catch {
			// Fall back below.
		}
	}
	if (merge === undefined) return { envelope, merged: true }
	try {
		return {
			envelope: withMergedData(envelope, merge.decodedData, merge.coalesced),
			merged: true,
		}
	} catch {
		// An envelope that never passed validation (a test or a direct caller)
		// is merged as it is, if the result still fits; the writer refuses a
		// record over MAX_RECORD_BYTES.
		const { decodedData: _own, coalesced: _span, ...metadata } = envelope
		const raw: DecodeEnvelope = {
			...metadata,
			...(merge.coalesced === undefined ? {} : { coalesced: merge.coalesced }),
			decodedData: merge.decodedData,
		}
		if (jsonBytes(raw) <= MAX_ENVELOPE_BYTES)
			return { envelope: raw, merged: true }
	}
	return { envelope: ownEnvelope(envelope, present), merged: false }
}

/**
 * A flushed row is a snapshot of the entity's state taken when it is queued:
 * producedAt and receivedAt are the store clock then (never earlier than its
 * latest held reception), so rows in seq order also read in time order. Its
 * `coalesced` span keeps when the receptions it stands for were heard.
 */
function stampedNow(stored: DecodeEnvelope, now: number): DecodeEnvelope {
	const latest = Date.parse(stored.coalesced?.lastSeenAt ?? stored.receivedAt)
	const at = Number.isFinite(latest) && latest > now ? latest : now
	if (!Number.isFinite(at)) return stored
	const time = new Date(at).toISOString()
	if (time === stored.receivedAt && time === stored.producedAt) return stored
	try {
		return withEnvelopeMetadata(stored, { producedAt: time, receivedAt: time })
	} catch {
		// An envelope that never passed validation (a test or a direct caller).
		return { ...stored, producedAt: time, receivedAt: time }
	}
}

function ownEnvelope(
	envelope: DecodeEnvelope,
	present: CoalescePresenter | undefined,
): DecodeEnvelope {
	if (present)
		try {
			return present()
		} catch {
			// The plain envelope below.
		}
	return envelope
}

function jsonBytes(value: DecodeEnvelope): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8")
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

class TokenBucket {
	private tokens: number
	private updatedAt: number
	private readonly capacity: number
	private readonly perMs: number

	constructor(ratePerSec: number, burst: number, now: number) {
		this.capacity = burst * TOKEN
		this.tokens = this.capacity
		this.perMs = ratePerSec * 1000
		this.updatedAt = now
	}

	refill(now: number): void {
		if (now <= this.updatedAt) return
		const elapsed = now - this.updatedAt
		this.updatedAt = now
		if (this.perMs <= 0 || this.capacity === 0) return
		const room = this.capacity - this.tokens
		const add = elapsed * this.perMs
		this.tokens = add >= room ? this.capacity : this.tokens + add
	}

	available(): boolean {
		return this.tokens >= TOKEN
	}

	take(): void {
		this.tokens -= TOKEN
	}

	refund(): void {
		const next = this.tokens + TOKEN
		this.tokens = next > this.capacity ? this.capacity : next
	}

	full(): boolean {
		return this.tokens >= this.capacity
	}
}
