/**
 * Polite HTTP for the aircraft-info sources: a descriptive User-Agent (Planespotters
 * refuses generic ones), a timeout, and a circuit breaker per source so an offline
 * core stops asking after a few failures and tries again later.
 *
 * @module src/services/aircraft-info/http
 */

import { WaveKitError } from "../../utils/errors.js"

export const USER_AGENT =
	"WaveKit/1.0 (+https://github.com/Coriou/WaveKit; self-hosted SDR receiver)"

/** Network failure, timeout or server error: counts against the source's breaker. */
export class SourceUnavailableError extends WaveKitError {
	constructor(source: string, reason: string) {
		super(`${source} unavailable: ${reason}`, "AIRCRAFT_SOURCE_UNAVAILABLE")
	}
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Opens after `threshold` consecutive failures, then stays open for a cool-down that
 * doubles on each reopen (capped). A success closes it and resets the cool-down.
 */
export class CircuitBreaker {
	private failures = 0
	private openUntil = 0
	private cooldownMs: number

	constructor(
		private readonly threshold = 3,
		private readonly baseCooldownMs = 5 * 60_000,
		private readonly maxCooldownMs = 60 * 60_000,
		private readonly now: () => number = Date.now,
	) {
		this.cooldownMs = baseCooldownMs
	}

	/** True while requests may be sent. */
	allows(): boolean {
		return this.now() >= this.openUntil
	}

	isOpen(): boolean {
		return !this.allows()
	}

	success(): void {
		this.failures = 0
		this.openUntil = 0
		this.cooldownMs = this.baseCooldownMs
	}

	failure(): void {
		this.failures++
		if (this.failures < this.threshold) return
		this.openUntil = this.now() + this.cooldownMs
		this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs)
		this.failures = 0
	}
}

export interface SourceClientOptions {
	fetch?: FetchLike
	timeoutMs?: number
	now?: () => number
}

/** HTTP client of one source. `get` returns null on 404 (not known), throws when unavailable. */
export class SourceClient {
	readonly breaker: CircuitBreaker
	private readonly fetchImpl: FetchLike
	private readonly timeoutMs: number

	constructor(
		readonly name: string,
		options: SourceClientOptions = {},
	) {
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
		this.timeoutMs = options.timeoutMs ?? 6000
		this.breaker = new CircuitBreaker(3, 5 * 60_000, 60 * 60_000, options.now)
	}

	available(): boolean {
		return this.breaker.allows()
	}

	/** GET a JSON document. null when the source answers 404. */
	async getJson(url: string): Promise<unknown> {
		if (!this.breaker.allows())
			throw new SourceUnavailableError(this.name, "paused after failures")
		let response: Response
		try {
			response = await this.fetchImpl(url, {
				method: "GET",
				headers: { Accept: "application/json", "User-Agent": USER_AGENT },
				signal: AbortSignal.timeout(this.timeoutMs),
			})
		} catch (err) {
			this.breaker.failure()
			const reason =
				err instanceof Error
					? err.name === "TimeoutError" || err.name === "AbortError"
						? "timeout"
						: err.message
					: String(err)
			throw new SourceUnavailableError(this.name, reason)
		}
		if (response.status === 404) {
			this.breaker.success()
			return null
		}
		if (!response.ok) {
			// 429 and 5xx mean "come back later"; other 4xx are our fault but the
			// source still answered, so they do not trip the breaker.
			if (response.status === 429 || response.status >= 500)
				this.breaker.failure()
			throw new SourceUnavailableError(this.name, `HTTP ${response.status}`)
		}
		try {
			const body: unknown = await response.json()
			this.breaker.success()
			return body
		} catch {
			this.breaker.failure()
			throw new SourceUnavailableError(this.name, "invalid JSON")
		}
	}
}
