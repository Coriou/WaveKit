import { randomUUID } from "node:crypto"
import { ACTIVITY_RECORD_VERSION } from "./contract.js"
import type {
	AdmitRejection,
	AdmitResult,
	IngestionGapPayload,
} from "./contract.js"
import type { ActivityLimits } from "./limits.js"
import { buildActivityRow } from "./row.js"
import type { BuiltActivityRow } from "./row.js"
import { isTelemetryOutput } from "./telemetry.js"
import type { DecodeEnvelope } from "../types.js"
import type { Logger } from "../../../utils/logger.js"

const TOKEN = 1_000_000
const MAX_GAP_DECODERS = 32

export interface IngressCounters {
	admitted: number
	excludedTelemetry: number
	dropped: Record<IngestionGapPayload["reason"], number>
}

interface GapEpisode {
	reason: IngestionGapPayload["reason"]
	dropped: number
	decoderIds: string[]
	fromReceivedAt: string
	toReceivedAt: string
	eventId: string
}

/**
 * Main-thread admission. Token buckets are integer micro-tokens so refill does
 * not drift. One gap record is held outside the queue cap and is never refused
 * for rate; it is emitted on the next successful admit.
 */
export class ActivityIngress {
	readonly dropped: IngressCounters["dropped"] = {
		"rate-limited": 0,
		"queue-full": 0,
		"store-paused": 0,
		"write-failed": 0,
	}
	admitted = 0
	excludedTelemetry = 0
	private readonly global: TokenBucket
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
	}

	admit(envelope: DecodeEnvelope): AdmitResult {
		if (this.closed) return { admitted: false, reason: "closed" }
		if (isTelemetryOutput(envelope.outputType)) {
			this.excludedTelemetry++
			return { admitted: false, reason: "telemetry" }
		}
		const row = buildActivityRow({
			version: ACTIVITY_RECORD_VERSION,
			eventId: envelope.eventId,
			commitSeq: "0",
			producedAt: envelope.producedAt,
			receivedAt: envelope.receivedAt,
			kind: "decoder-reception",
			payload: envelope,
		})
		if (this.paused) return this.reject(row, "store-paused")
		if (this.wouldOverflow(row)) return this.reject(row, "queue-full")
		if (!this.takeTokens(envelope.decoderId, this.now()))
			return this.reject(row, "rate-limited")
		this.stageGap()
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
		for (const row of failed)
			this.noteDrop(
				"write-failed",
				new Date(row.receivedAtMs).toISOString(),
				row.decoderId,
			)
	}

	noteSkipped(
		batch: readonly BuiltActivityRow[],
		eventIds: readonly string[],
	): void {
		const skipped = new Set(eventIds)
		for (const row of batch) {
			if (!skipped.has(row.eventId) || row.kind === "ingestion-gap") continue
			this.noteDrop(
				"write-failed",
				new Date(row.receivedAtMs).toISOString(),
				row.decoderId,
			)
		}
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

	private reject(
		row: BuiltActivityRow,
		reason: Exclude<AdmitRejection, "closed" | "telemetry">,
	): AdmitResult {
		this.noteDrop(
			reason,
			new Date(row.receivedAtMs).toISOString(),
			row.decoderId,
		)
		return { admitted: false, reason }
	}

	private noteDrop(
		reason: IngestionGapPayload["reason"],
		receivedAt: string,
		decoderId: string | null,
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
			}
		}
		this.episode.dropped++
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

	/** A gap bypasses the token bucket and the queue item cap (one reserved slot). */
	private stageGap(): void {
		if (!this.episode || this.gapHeld) return
		const episode = this.episode
		this.episode = undefined
		this.gapHeld = true
		const at = new Date(this.now()).toISOString()
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

	private wouldOverflow(row: BuiltActivityRow): boolean {
		const depth = this.queue.length + this.inFlight.length
		if (depth + 1 > this.limits.queueMaxItems) return true
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

	full(): boolean {
		return this.tokens >= this.capacity
	}
}
