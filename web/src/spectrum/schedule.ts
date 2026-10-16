/** Timing helpers: render coalescing, meta throttling and reconnect backoff. Clock and timers are injected. */

export type FrameRequest = (cb: () => void) => number
export type FrameCancel = (handle: number) => void

/** Runs `render` at most once per animation frame, and only after `invalidate()`. */
export class RenderScheduler {
	private handle: number | null = null
	private readonly request: FrameRequest
	private readonly cancel: FrameCancel
	private readonly render: () => void

	constructor(render: () => void, request: FrameRequest, cancel: FrameCancel) {
		this.render = render
		this.request = request
		this.cancel = cancel
	}

	get pending(): boolean {
		return this.handle !== null
	}

	invalidate(): void {
		if (this.handle !== null) return
		this.handle = this.request(() => {
			this.handle = null
			this.render()
		})
	}

	dispose(): void {
		if (this.handle !== null) this.cancel(this.handle)
		this.handle = null
	}
}

/** requestAnimationFrame where the global scope has it (window, most workers), else a 16 ms timer. */
export function animationFrame(): {
	request: FrameRequest
	cancel: FrameCancel
} {
	const scope = globalThis as {
		requestAnimationFrame?: (cb: () => void) => number
		cancelAnimationFrame?: (handle: number) => void
	}
	const raf = scope.requestAnimationFrame
	const caf = scope.cancelAnimationFrame
	if (typeof raf === "function" && typeof caf === "function")
		return {
			request: cb => raf.call(scope, cb),
			cancel: h => caf.call(scope, h),
		}
	return {
		request: cb => setTimeout(cb, 16) as unknown as number,
		cancel: h => clearTimeout(h),
	}
}

export interface TimerApi {
	now(): number
	setTimeout(cb: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export const realTimers: TimerApi = {
	now: () => performance.now(),
	setTimeout: (cb, ms) => setTimeout(cb, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Passes values on at most once per `intervalMs`; the latest value of a burst is delivered at the end
 * of the interval (trailing edge), so the last frame's meta is never lost. `flush` sends immediately.
 */
export class Throttle<T> {
	private last = Number.NEGATIVE_INFINITY
	private pendingValue: { value: T } | null = null
	private timer: unknown = null
	private readonly intervalMs: number
	private readonly emit: (value: T) => void
	private readonly timers: TimerApi

	constructor(intervalMs: number, emit: (value: T) => void, timers: TimerApi) {
		this.intervalMs = intervalMs
		this.emit = emit
		this.timers = timers
	}

	push(value: T): void {
		const now = this.timers.now()
		if (now - this.last >= this.intervalMs && this.timer === null) {
			this.send(value, now)
			return
		}
		this.pendingValue = { value }
		if (this.timer === null) {
			const wait = Math.max(0, this.last + this.intervalMs - now)
			this.timer = this.timers.setTimeout(() => {
				this.timer = null
				const pending = this.pendingValue
				if (pending) this.send(pending.value, this.timers.now())
			}, wait)
		}
	}

	/** Sends `value` now and drops anything pending (used for axis changes). */
	flush(value: T): void {
		this.cancelTimer()
		this.send(value, this.timers.now())
	}

	dispose(): void {
		this.cancelTimer()
		this.pendingValue = null
	}

	private send(value: T, now: number): void {
		this.pendingValue = null
		this.last = now
		this.emit(value)
	}

	private cancelTimer(): void {
		if (this.timer !== null) this.timers.clearTimeout(this.timer)
		this.timer = null
	}
}

/** Reconnect delay for attempt n (0-based): 500 ms doubling to 10 s, with ±20 % jitter from `random`. */
export function backoffDelay(
	attempt: number,
	random: () => number = Math.random,
): number {
	const base = Math.min(10_000, 500 * 2 ** Math.min(attempt, 10))
	return Math.round(base * (0.8 + 0.4 * random()))
}
