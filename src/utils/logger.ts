import type { Logger } from "@wavekit/shared"

export {
	createComponentLogger,
	createLogger,
	createRequestLogger,
	createScopedLogger,
	generateCorrelationId,
	getSensitiveEnvVarNames,
	isSensitiveEnvVar,
	MASK_VALUE,
	maskSensitiveValues,
} from "@wavekit/shared"

export type { LogLevel, Logger, LoggerConfig } from "@wavekit/shared"

/**
 * Hot-path log policy (docs/PERFORMANCE.md): no info or warn line per message, frame or chunk.
 * A per-message line is debug or trace; a repeated warning goes through LogRateLimiter; volume is
 * reported by one CountSummary line per minute.
 */

/** One minute: the summary period and the default rate-limit interval of the hot-path log policy. */
export const LOG_SUMMARY_INTERVAL_MS = 60_000
/** Keys a limiter or summary remembers; past it new keys are dropped, never the process's memory. */
export const LOG_MAX_KEYS = 1_000

/**
 * At most one line per key per interval. `take` returns how many lines of that key were
 * suppressed since the last one allowed, or null when this one must be suppressed.
 */
export class LogRateLimiter {
	private readonly intervalMs: number
	private readonly maxKeys: number
	private readonly now: () => number
	private readonly keys = new Map<string, { at: number; suppressed: number }>()

	constructor(
		options: {
			intervalMs?: number
			maxKeys?: number
			now?: () => number
		} = {},
	) {
		this.intervalMs = options.intervalMs ?? LOG_SUMMARY_INTERVAL_MS
		this.maxKeys = options.maxKeys ?? LOG_MAX_KEYS
		this.now = options.now ?? Date.now
	}

	take(key: string): number | null {
		const now = this.now()
		const slot = this.keys.get(key)
		if (slot && now - slot.at < this.intervalMs) {
			slot.suppressed += 1
			return null
		}
		if (slot) {
			const suppressed = slot.suppressed
			slot.at = now
			slot.suppressed = 0
			return suppressed
		}
		if (this.keys.size >= this.maxKeys) {
			// Forget windows that have ended; if every key is still in its window, suppress.
			for (const [k, s] of this.keys)
				if (now - s.at >= this.intervalMs) this.keys.delete(k)
			if (this.keys.size >= this.maxKeys) return null
		}
		this.keys.set(key, { at: now, suppressed: 0 })
		return 0
	}
}

/**
 * Counts events per key and logs one info line per interval with the counts (nothing when
 * nothing happened). Keys past `maxKeys` in one interval are counted under `other`.
 */
export class CountSummary {
	private readonly log: Logger
	private readonly message: string
	private readonly maxKeys: number
	private counts = new Map<string, number>()
	private other = 0
	private timer: ReturnType<typeof setInterval> | undefined

	constructor(
		log: Logger,
		message: string,
		options: { intervalMs?: number; maxKeys?: number } = {},
	) {
		this.log = log
		this.message = message
		this.maxKeys = options.maxKeys ?? LOG_MAX_KEYS
		this.timer = setInterval(
			() => this.flush(),
			options.intervalMs ?? LOG_SUMMARY_INTERVAL_MS,
		)
		this.timer.unref()
	}

	add(key: string): void {
		const count = this.counts.get(key)
		if (count !== undefined) this.counts.set(key, count + 1)
		else if (this.counts.size < this.maxKeys) this.counts.set(key, 1)
		else this.other += 1
	}

	/** Logs and resets the counts. */
	flush(): void {
		if (this.counts.size === 0 && this.other === 0) return
		const counts = Object.fromEntries(this.counts)
		const total = [...this.counts.values()].reduce((a, b) => a + b, this.other)
		this.log.info(
			{ counts, ...(this.other > 0 ? { other: this.other } : {}), total },
			this.message,
		)
		this.counts = new Map()
		this.other = 0
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}
}
