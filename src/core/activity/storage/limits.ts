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
	 * Position-only receptions (aircraft, ship) of one entity are stored at most
	 * once per this window; 0 stores every one (WG1 req 7.6).
	 */
	positionCoalesceMs: number
	/** Entities tracked for coalescing; the least recently stored are evicted. */
	positionCoalesceMaxEntities: number
}

const MiB = 1024 * 1024

/** One stored position-only update per aircraft or vessel per minute (WG1 req 7.6). */
export const ACTIVITY_POSITION_COALESCE_MS = 60_000

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
	positionCoalesceMaxEntities: 20_000,
})

const LIMIT_KEYS = Object.keys(
	ACTIVITY_LIMIT_DEFAULTS,
) as (keyof ActivityLimits)[]

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
	}
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
