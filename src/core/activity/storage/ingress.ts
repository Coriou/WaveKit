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
import type { DecodeEnvelope } from "../types.js"
import type { Logger } from "../../../utils/logger.js"

const TOKEN = 1_000_000
const MAX_GAP_DECODERS = 32

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
	private readonly global: TokenBucket
	private readonly coalescer: PositionCoalescer
	/** Undo of each queued or in-flight row's coalescing state, by eventId. */
	private readonly coalesceUndo = new Map<string, () => void>()
	private readonly decoders = new Map<string, TokenBucket>()
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
		)
	}

	/** Position-only receptions not stored inside their entity's window. */
	get coalescedPositions(): number {
		return this.coalescer.coalesced
	}

	admit(envelope: DecodeEnvelope): AdmitResult {
		if (this.closed) {
			this.dropped.closed++
			return { admitted: false, reason: "closed" }
		}
		if (isTelemetryOutput(envelope.outputType)) {
			this.excludedTelemetry++
			return { admitted: false, reason: "telemetry" }
		}
		const coalesce = this.coalescer.decide(envelope)
		if (!coalesce.store) {
			this.coalescer.noteCoalesced()
			return { admitted: false, reason: "coalesced" }
		}
		const now = this.now()
		if (this.paused) return this.rejectEnvelope(envelope, "store-paused")
		if (this.itemOverflow()) return this.rejectEnvelope(envelope, "queue-full")
		if (!this.takeTokens(envelope.decoderId, now))
			return this.rejectEnvelope(envelope, "rate-limited")
		const row = buildActivityRow({
			version: ACTIVITY_RECORD_VERSION,
			eventId: envelope.eventId,
			commitSeq: "0",
			producedAt: envelope.producedAt,
			receivedAt: envelope.receivedAt,
			kind: "decoder-reception",
			payload: envelope,
		})
		if (this.byteOverflow(row)) {
			this.refundTokens(envelope.decoderId)
			this.noteDrop("queue-full", envelope.receivedAt, envelope.decoderId, now)
			return { admitted: false, reason: "queue-full" }
		}
		this.stageDueEpisode(now)
		this.queue.push(row)
		this.queueBytes += row.recordBytes
		this.admitted++
		this.coalesceUndo.set(row.eventId, coalesce.commit())
		return { admitted: true }
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
		for (const row of this.inFlight) this.coalesceUndo.delete(row.eventId)
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
		// Newest first, so each undo sees the state its own commit left.
		for (const row of [...failed].reverse())
			this.rollBackCoalescing(row.eventId)
		for (const row of failed)
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
		for (const row of [...batch].reverse())
			if (skipped.has(row.eventId)) this.rollBackCoalescing(row.eventId)
		for (const row of batch) {
			if (!skipped.has(row.eventId) || row.kind === "ingestion-gap") continue
			this.noteDrop(
				"write-failed",
				new Date(row.receivedAtMs).toISOString(),
				row.decoderId,
				this.now(),
			)
		}
	}

	/** Clears an in-flight batch without counting it. A timed-out write may still commit. */
	forgetInFlight(): void {
		for (const row of this.inFlight) this.coalesceUndo.delete(row.eventId)
		this.inFlight = []
		this.inFlightBytes = 0
	}

	/**
	 * A failed write must not suppress the entity's next reception (for example
	 * the retransmission of a name-bearing report): restore its prior state.
	 */
	private rollBackCoalescing(eventId: string): void {
		const undo = this.coalesceUndo.get(eventId)
		this.coalesceUndo.delete(eventId)
		undo?.()
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
		reason: Exclude<AdmitRejection, "closed" | "telemetry" | "coalesced">,
	): AdmitResult {
		this.noteDrop(reason, envelope.receivedAt, envelope.decoderId, this.now())
		return { admitted: false, reason }
	}

	private rejectTransmission(
		input: AnalogTransmissionAdmission,
		bucket: string,
		reason: Exclude<AdmitRejection, "closed" | "telemetry" | "coalesced">,
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
