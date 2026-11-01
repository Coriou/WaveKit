import type { ActivityRetentionPolicy } from "./contract.js"
import { ActivityUnavailableError } from "./errors.js"

/**
 * Store limits. Overrides replace individual fields; omitted fields keep the
 * defaults below.
 */
export interface ActivityLimits {
	globalRatePerSec: number
	globalBurst: number
	decoderRatePerSec: number
	decoderBurst: number
	queueMaxItems: number
	queueMaxBytes: number
	batchMaxItems: number
	batchMaxBytes: number
	batchWindowMs: number
	maxRows: number
	maxDbBytes: number
	maxAgeMs: number
	walPassiveBytes: number
	walTruncateBytes: number
	walPauseBytes: number
	pruneBatchRows: number
	/** Consecutive prune transactions one write may run while a cap stays active. */
	pruneBurstBatches: number
	/** Time one write may spend in those transactions before the rest waits. */
	pruneBurstMs: number
	incrementalVacuumPages: number
	closeTimeoutMs: number
	/** How often a paused store retries a TRUNCATE checkpoint. */
	pauseRetryMs: number
	/** Quiet time with no drops before an ingestion-gap episode closes. */
	gapQuietMs: number
	/** Sustained overload emits at most one ingestion-gap row per this interval. */
	gapMaxIntervalMs: number
	/**
	 * Redundant receptions of one tracked entity (aircraft, ship, APRS and mesh
	 * position, sensor reading) are merged into one row per this window; 0
	 * stores every one (WG1 req 7.6, storage/coalesce.ts).
	 */
	positionCoalesceMs: number
	/**
	 * Entities tracked for coalescing; the least recently stored are evicted and
	 * their held receptions flushed as a row.
	 */
	positionCoalesceMaxEntities: number
	/**
	 * Which rows the row and byte caps remove (web-gaps-3 req 1.1). Age pruning is the
	 * same prefix prune under both policies.
	 */
	retentionPolicy: ActivityRetentionPolicy
}

const MiB = 1024 * 1024

/**
 * Default retention policy (web-gaps-3 req 1.1): fair-share, decided by the user on 2026-10-16;
 * "oldest-first" stays available as an opt-out. Caps, admission and `activity.enabled`
 * are unchanged by either value.
 */
export const ACTIVITY_RETENTION_POLICY_DEFAULT: ActivityRetentionPolicy =
	"fair-share"

export const ACTIVITY_RETENTION_POLICIES: readonly ActivityRetentionPolicy[] = [
	"fair-share",
	"oldest-first",
]

/** One stored position-only update per aircraft or vessel per minute (WG1 req 7.6). */
export const ACTIVITY_POSITION_COALESCE_MS = 60_000

/**
 * Tracked entities. Busy sites see at most about 600 aircraft, 2,000 vessels,
 * a few hundred APRS stations and sensors at once (about 3,000 together), so
 * 4,096 holds them all with headroom; past it the least recently stored entity
 * is evicted and its held receptions are stored, so nothing is lost, only
 * merged less. The admission bench measured about 1.3 KB per tracked aircraft
 * plus 1.0 KB while it holds a reception (SBS envelopes; the presenter closure
 * adds the decoder output, about 0.5 KB): 4,096 × (1.3 + 1.5) KB ≈ 11.5 MB at
 * most, where the old 20,000 would allow about 56 MB.
 */
export const ACTIVITY_POSITION_COALESCE_MAX_ENTITIES = 4_096

/** Identity members (callsign, registration, type code, type, operator). */
const AIRCRAFT_IDENTITY_MEMBERS = 5
/** Raw UTF-8 bytes of one identity value at most (the envelope cap). */
const AIRCRAFT_IDENTITY_VALUE_BYTES = 64

/**
 * Built-row bytes an aircraft row's stored identity (`aircraft`) may add on
 * top of the 1,100-byte row growth bound, and only the identity: the
 * presentation is fitted to 1,100 first, then the identity gets that slack
 * plus this. 5 × 64 = 320 bytes, the raw size of a whole identity at the
 * member cap. Counted like the 1,100 bound, in built-row bytes, not raw
 * value bytes: the record and the summary JSON each store `,"aircraft":`
 * (12 bytes) and the object (82 bytes of keys, quotes and punctuation for all
 * five, every value JSON-escaped, so `"` and `\` count twice), and the FTS
 * text stores each raw value plus a newline. An ordinary identity (`WKA52`,
 * `N0WK52`, `B77W`, `Boeing 777-300ER`, `WaveKit International Airways`, 61
 * value bytes) builds to 373 bytes: on a fully listed aircraft row (881
 * bytes of presentation growth) it stays whole at 1,254, where the 1,100
 * alone kept only the callsign and registration. A cap-length identity
 * builds to 1,153 bytes (1,793 when every character is escaped) and still
 * loses members, lowest priority first, past the slack and this allowance.
 */
export const ACTIVITY_AIRCRAFT_IDENTITY_ALLOWANCE_BYTES =
	AIRCRAFT_IDENTITY_MEMBERS * AIRCRAFT_IDENTITY_VALUE_BYTES

/**
 * The single source of default limits. Activity is on by default (WG1 req 7),
 * so retention and admission are bounded for a Pi-class SD card: 250 000 rows,
 * 256 MiB, 3 days; 50/s burst 500 globally, 20/s burst 200 per decoder. An
 * operator judgement, not a measurement. Config retention and admission blocks
 * override single fields; every omitted field keeps these values.
 *
 * maxDbBytes is a prune trigger on live pages (freelist pages excluded); the
 * WAL pauses writes past walPauseBytes. 256 MiB + 64 MiB is therefore a
 * nominal live-page plus WAL threshold, not a disk ceiling: freed pages return
 * through incremental vacuum and pruning is bounded per write. A store opened
 * near the previous 2 GiB default stays larger on disk until it shrinks.
 */
export const ACTIVITY_LIMIT_DEFAULTS: Readonly<ActivityLimits> = Object.freeze({
	globalRatePerSec: 50,
	globalBurst: 500,
	decoderRatePerSec: 20,
	decoderBurst: 200,
	queueMaxItems: 1024,
	queueMaxBytes: 8 * MiB,
	batchMaxItems: 64,
	batchMaxBytes: 512 * 1024,
	batchWindowMs: 25,
	maxRows: 250_000,
	maxDbBytes: 256 * MiB,
	maxAgeMs: 3 * 24 * 60 * 60 * 1000,
	walPassiveBytes: 16 * MiB,
	walTruncateBytes: 48 * MiB,
	walPauseBytes: 64 * MiB,
	pruneBatchRows: 500,
	pruneBurstBatches: 20,
	pruneBurstMs: 300,
	incrementalVacuumPages: 64,
	closeTimeoutMs: 2000,
	pauseRetryMs: 250,
	gapQuietMs: 5_000,
	gapMaxIntervalMs: 60_000,
	positionCoalesceMs: ACTIVITY_POSITION_COALESCE_MS,
	positionCoalesceMaxEntities: ACTIVITY_POSITION_COALESCE_MAX_ENTITIES,
	retentionPolicy: ACTIVITY_RETENTION_POLICY_DEFAULT,
})

type NumericLimitKey = Exclude<keyof ActivityLimits, "retentionPolicy">

const LIMIT_KEYS = (
	Object.keys(ACTIVITY_LIMIT_DEFAULTS) as (keyof ActivityLimits)[]
).filter((key): key is NumericLimitKey => key !== "retentionPolicy")

/** Token math stores micro-tokens. Bursts above this overflow Number.MAX_SAFE_INTEGER. */
const MAX_BURST = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000)

export function resolveActivityLimits(
	overrides?: Partial<ActivityLimits>,
): ActivityLimits {
	const limits: ActivityLimits = { ...ACTIVITY_LIMIT_DEFAULTS }
	if (overrides) {
		for (const key of LIMIT_KEYS) {
			const value = overrides[key]
			if (value !== undefined) limits[key] = value
		}
		if (overrides.retentionPolicy !== undefined)
			limits.retentionPolicy = overrides.retentionPolicy
	}
	if (!ACTIVITY_RETENTION_POLICIES.includes(limits.retentionPolicy))
		throw new ActivityUnavailableError("Invalid activity retention policy")
	for (const key of LIMIT_KEYS) {
		const value = limits[key]
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			throw new ActivityUnavailableError(`Invalid activity limit ${key}`)
	}
	if (limits.queueMaxItems < 1 || limits.batchMaxItems < 1)
		throw new ActivityUnavailableError(
			"Activity queue and batch item caps must be at least 1",
		)
	if (limits.queueMaxBytes < 1 || limits.batchMaxBytes < 1)
		throw new ActivityUnavailableError(
			"Activity queue and batch byte caps must be at least 1",
		)
	if (limits.maxRows < 1000)
		throw new ActivityUnavailableError("Activity maxRows must be at least 1000")
	if (limits.maxDbBytes < 16 * MiB)
		throw new ActivityUnavailableError(
			"Activity maxDbBytes must be at least 16 MiB",
		)
	if (limits.pruneBatchRows < 1)
		throw new ActivityUnavailableError(
			"Activity prune batch must be at least 1 row",
		)
	if (limits.pruneBurstBatches < 1)
		throw new ActivityUnavailableError(
			"Activity prune burst must be at least 1 batch",
		)
	if (limits.pruneBurstMs < 1)
		throw new ActivityUnavailableError(
			"Activity prune burst must be at least 1 ms",
		)
	if (limits.gapMaxIntervalMs < 1)
		throw new ActivityUnavailableError(
			"Activity gap interval must be at least 1 ms",
		)
	if (limits.positionCoalesceMs > 0 && limits.positionCoalesceMaxEntities < 1)
		throw new ActivityUnavailableError(
			"Activity position coalescing needs at least 1 tracked entity",
		)
	if (limits.pauseRetryMs < 1)
		throw new ActivityUnavailableError(
			"Activity pause retry must be at least 1 ms",
		)
	if (
		limits.globalBurst > MAX_BURST ||
		limits.decoderBurst > MAX_BURST ||
		limits.globalRatePerSec > 1_000_000_000 ||
		limits.decoderRatePerSec > 1_000_000_000
	)
		throw new ActivityUnavailableError("Activity rate limit is out of range")
	if (
		limits.walPassiveBytes > limits.walTruncateBytes ||
		limits.walTruncateBytes > limits.walPauseBytes
	)
		throw new ActivityUnavailableError(
			"Activity WAL thresholds must be passive <= truncate <= pause",
		)
	return limits
}
