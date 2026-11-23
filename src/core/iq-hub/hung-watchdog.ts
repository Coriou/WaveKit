/**
 * The hung-hub watchdog (S19). A configured hub emits `progress` every 100 ms, so a hub that sent
 * no event for `hungAfterMs` (5 s) is stopped, deadlocked or starved itself. A starved Node main
 * thread must not trip it: after a stall the timers phase runs before the poll phase reads the
 * waiting event lines, so a check only marks the hub suspect, and a `setImmediate` (the check
 * phase, after poll) looks again for a newer event before it acts.
 */

export const HUB_HUNG_AFTER_MS = 5000
export const HUB_HUNG_CHECK_MS = 1000

export interface HungWatchdogOptions {
	onHung: () => void
	hungAfterMs?: number
	checkEveryMs?: number
	now?: () => number
	/** Runs after the poll phase (default setImmediate); injected by tests. */
	defer?: (fn: () => void) => void
}

export class HungWatchdog {
	private readonly hungAfterMs: number
	private readonly checkEveryMs: number
	private readonly now: () => number
	private readonly onHung: () => void
	private readonly defer: (fn: () => void) => void
	private lastEventAt: number
	private timer: ReturnType<typeof setInterval> | null = null
	private suspect = false
	private fired = false

	constructor(options: HungWatchdogOptions) {
		this.hungAfterMs = options.hungAfterMs ?? HUB_HUNG_AFTER_MS
		this.checkEveryMs = options.checkEveryMs ?? HUB_HUNG_CHECK_MS
		this.now = options.now ?? (() => performance.now())
		this.onHung = options.onHung
		this.defer = options.defer ?? (fn => void setImmediate(fn))
		this.lastEventAt = this.now()
	}

	get running(): boolean {
		return this.timer !== null
	}

	start(): void {
		if (this.timer !== null || this.fired) return
		this.lastEventAt = this.now()
		this.timer = setInterval(() => this.check(), this.checkEveryMs)
		this.timer.unref()
	}

	/** Any line from the hub (parsed or not) proves it alive. */
	noteEvent(): void {
		this.lastEventAt = this.now()
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer)
		this.timer = null
	}

	private stale(): boolean {
		return this.now() - this.lastEventAt >= this.hungAfterMs
	}

	private check(): void {
		if (this.timer === null || this.suspect || !this.stale()) return
		this.suspect = true
		this.defer(() => {
			this.suspect = false
			if (this.timer === null || this.fired || !this.stale()) return
			this.fired = true
			this.stop()
			this.onHung()
		})
	}
}
