/**
 * Rate limiter and coalescer for scanner WebSocket messages (spec § 9, § 12.2): at most
 * `maxPerSecond` emissions in any 1 s window, at most one per key per `perKeyMinIntervalMs`, latest
 * state per key wins, and the latest state of every key is always delivered eventually.
 */
type Priority = "state" | "progress" | "activity"

const WINDOW_MS = 1_000
const MAX_PENDING_ACTIVITY = 256
const LAST_EMIT_PRUNE_SIZE = 1_024
const RANK: Record<Priority, number> = { state: 0, progress: 1, activity: 2 }

interface Pending<T> {
	msg: T
	priority: Priority
	seq: number
}

export class WsLimiter<T> {
	private maxPerSecond: number
	private readonly perKeyMinIntervalMs: number
	private readonly now: () => number
	private readonly emitFn: (msg: T) => void
	private readonly scheduleFn: (
		fn: () => void,
		ms: number,
	) => { cancel(): void }
	private readonly pending = new Map<string, Pending<T>>()
	private readonly lastEmit = new Map<string, number>()
	private readonly window: number[] = []
	private timer: { cancel(): void } | null = null
	private timerAt = Number.POSITIVE_INFINITY
	private seq = 0
	private destroyed = false

	constructor(opts: {
		maxPerSecond: number
		perKeyMinIntervalMs: number
		now: () => number
		emit: (msg: T) => void
		schedule: (fn: () => void, ms: number) => { cancel(): void }
	}) {
		this.maxPerSecond = Math.max(1, Math.floor(opts.maxPerSecond))
		this.perKeyMinIntervalMs = Math.max(0, opts.perKeyMinIntervalMs)
		this.now = opts.now
		this.emitFn = opts.emit
		this.scheduleFn = opts.schedule
	}

	offer(key: string, msg: T, priority: Priority): void {
		if (this.destroyed) return
		const existing = this.pending.get(key)
		if (existing !== undefined) {
			existing.msg = msg
			if (RANK[priority] < RANK[existing.priority]) existing.priority = priority
		} else {
			this.pending.set(key, { msg, priority, seq: this.seq++ })
			if (priority === "activity") this.boundActivity()
		}
		this.pump()
	}

	/** Emits everything pending now, ignoring the limits (shutdown only). */
	flush(): void {
		if (this.destroyed) return
		this.cancelTimer()
		const now = this.now()
		const entries = [...this.pending].sort(
			([, a], [, b]) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq,
		)
		this.pending.clear()
		for (const [key, entry] of entries) this.emit(key, entry.msg, now)
	}

	/** Runtime update of `ws.maxMessagesPerSecond` (settings PATCH, Task 37). Lowering it holds back new emissions until the window drains; raising it releases pending keys now. */
	setMaxPerSecond(maxPerSecond: number): void {
		this.maxPerSecond = Math.max(1, Math.floor(maxPerSecond))
		this.pump()
	}

	destroy(): void {
		this.destroyed = true
		this.cancelTimer()
		this.pending.clear()
	}

	private pump(): void {
		if (this.destroyed) return
		const now = this.now()
		this.prune(now)
		while (this.window.length < this.maxPerSecond) {
			const next = this.nextEligible(now)
			if (next === null) break
			this.pending.delete(next[0])
			this.emit(next[0], next[1].msg, now)
		}
		this.arm(now)
	}

	private emit(key: string, msg: T, now: number): void {
		this.window.push(now)
		this.lastEmit.set(key, now)
		this.emitFn(msg)
	}

	private nextEligible(now: number): [string, Pending<T>] | null {
		let best: [string, Pending<T>] | null = null
		for (const [key, entry] of this.pending) {
			const last = this.lastEmit.get(key)
			if (last !== undefined && now - last < this.perKeyMinIntervalMs) continue
			if (
				best === null ||
				RANK[entry.priority] < RANK[best[1].priority] ||
				(RANK[entry.priority] === RANK[best[1].priority] &&
					entry.seq < best[1].seq)
			)
				best = [key, entry]
		}
		return best
	}

	private arm(now: number): void {
		if (this.pending.size === 0) {
			this.cancelTimer()
			return
		}
		// After a runtime lowering the window can hold more than `maxPerSecond` entries: the next slot frees
		// when the entry `maxPerSecond` from the newest leaves the window.
		const windowFree =
			this.window.length >= this.maxPerSecond
				? (this.window[this.window.length - this.maxPerSecond] ?? now) +
					WINDOW_MS
				: now
		let at = Number.POSITIVE_INFINITY
		for (const key of this.pending.keys()) {
			const last = this.lastEmit.get(key)
			const keyFree = last === undefined ? now : last + this.perKeyMinIntervalMs
			at = Math.min(at, Math.max(keyFree, windowFree))
		}
		if (this.timer !== null && this.timerAt === at) return
		this.cancelTimer()
		this.timerAt = at
		this.timer = this.scheduleFn(
			() => {
				this.timer = null
				this.timerAt = Number.POSITIVE_INFINITY
				this.pump()
			},
			Math.max(0, at - now),
		)
	}

	private prune(now: number): void {
		while (this.window.length > 0 && now - (this.window[0] ?? now) >= WINDOW_MS)
			this.window.shift()
		if (this.lastEmit.size > LAST_EMIT_PRUNE_SIZE)
			for (const [key, at] of this.lastEmit)
				if (now - at >= this.perKeyMinIntervalMs && !this.pending.has(key))
					this.lastEmit.delete(key)
	}

	private boundActivity(): void {
		let count = 0
		let oldest: [string, number] | null = null
		for (const [key, entry] of this.pending) {
			if (entry.priority !== "activity") continue
			count++
			if (oldest === null || entry.seq < oldest[1]) oldest = [key, entry.seq]
		}
		if (count > MAX_PENDING_ACTIVITY && oldest !== null)
			this.pending.delete(oldest[0])
	}

	private cancelTimer(): void {
		this.timer?.cancel()
		this.timer = null
		this.timerAt = Number.POSITIVE_INFINITY
	}
}
