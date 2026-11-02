/**
 * Scanner quality benchmark: a virtual clock for the scanner under test. While installed it
 * replaces the global setTimeout / setInterval (and their clears), Date.now and performance.now,
 * so every timer the scanner arms (service ticks, the spectrum engine's batch flush, gate
 * deadlines, snapshot debounces) fires at a virtual time the harness chooses instead of on the
 * wall clock. setImmediate, process.nextTick and promise jobs stay real: the harness yields with
 * them between timers so async continuations run in a fixed order.
 *
 * Node clamps a delay below 1 ms to 1 ms; so does this clock, which also bounds `advanceTo`: a
 * timer that re-arms itself from its own callback moves at least 1 virtual ms per firing.
 */

interface Entry {
	id: number
	due: number
	/** Arm order: equal due times fire first-armed first. */
	seq: number
	/** The armed delay (refresh restarts it). */
	delayMs: number
	intervalMs: number | null
	fn: (...args: unknown[]) => void
	args: unknown[]
}

/** The handle setTimeout / setInterval return (the Node Timeout surface the scanner uses). */
class VirtualTimer {
	constructor(
		readonly id: number,
		private readonly clock: VirtualClock,
	) {}
	unref(): this {
		return this
	}
	ref(): this {
		return this
	}
	hasRef(): boolean {
		return false
	}
	refresh(): this {
		this.clock.refresh(this.id)
		return this
	}
	close(): this {
		this.clock.clear(this)
		return this
	}
	[Symbol.toPrimitive](): number {
		return this.id
	}
}

/** The globals the clock replaces, typed loosely enough to assign its own versions. */
interface TimerGlobals {
	setTimeout: unknown
	clearTimeout: unknown
	setInterval: unknown
	clearInterval: unknown
}

const delayOf = (ms: unknown): number => {
	const n = Number(ms)
	return Number.isFinite(n) && n >= 1 ? n : 1
}

export class VirtualClock {
	private nowMs: number
	private nextId = 1
	private seq = 0
	private readonly timers = new Map<number, Entry>()
	private restore: (() => void) | null = null

	constructor(startMs: number) {
		this.nowMs = startMs
	}

	now(): number {
		return this.nowMs
	}

	/** Number of armed timers (tests). */
	get pending(): number {
		return this.timers.size
	}

	install(): void {
		if (this.restore) return
		const g = globalThis as unknown as TimerGlobals
		const saved = {
			setTimeout: g.setTimeout,
			clearTimeout: g.clearTimeout,
			setInterval: g.setInterval,
			clearInterval: g.clearInterval,
			dateNow: Date.now,
			perfNow: Object.getOwnPropertyDescriptor(performance, "now"),
		}
		const origin = this.nowMs
		const arm =
			(interval: boolean) =>
			(fn: unknown, ms?: unknown, ...args: unknown[]): VirtualTimer => {
				if (typeof fn !== "function")
					throw new TypeError("virtual clock: callback is not a function")
				const d = delayOf(ms)
				return this.arm(
					fn as (...a: unknown[]) => void,
					d,
					interval ? d : null,
					args,
				)
			}
		g.setTimeout = arm(false)
		g.setInterval = arm(true)
		g.clearTimeout = (h: unknown) => this.clear(h)
		g.clearInterval = (h: unknown) => this.clear(h)
		Date.now = () => this.nowMs
		Object.defineProperty(performance, "now", {
			configurable: true,
			writable: true,
			value: () => this.nowMs - origin,
		})
		this.restore = () => {
			g.setTimeout = saved.setTimeout
			g.clearTimeout = saved.clearTimeout
			g.setInterval = saved.setInterval
			g.clearInterval = saved.clearInterval
			Date.now = saved.dateNow
			if (saved.perfNow)
				Object.defineProperty(performance, "now", saved.perfNow)
			else delete (performance as unknown as { now?: unknown }).now
		}
	}

	uninstall(): void {
		this.restore?.()
		this.restore = null
		this.timers.clear()
	}

	private arm(
		fn: (...a: unknown[]) => void,
		delayMs: number,
		intervalMs: number | null,
		args: unknown[],
	): VirtualTimer {
		const id = this.nextId++
		this.timers.set(id, {
			id,
			due: this.nowMs + delayMs,
			seq: this.seq++,
			delayMs,
			intervalMs,
			fn,
			args,
		})
		return new VirtualTimer(id, this)
	}

	clear(handle: unknown): void {
		if (handle === null || handle === undefined) return
		const id =
			handle instanceof VirtualTimer
				? handle.id
				: typeof handle === "number"
					? handle
					: NaN
		this.timers.delete(id)
	}

	refresh(id: number): void {
		const e = this.timers.get(id)
		if (!e) return
		e.due = this.nowMs + e.delayMs
		e.seq = this.seq++
	}

	private earliest(): Entry | null {
		let best: Entry | null = null
		for (const e of this.timers.values())
			if (!best || e.due < best.due || (e.due === best.due && e.seq < best.seq))
				best = e
		return best
	}

	/**
	 * Fires every timer due at or before `targetMs` in (due, arm order), moving the clock to each
	 * one's due time first and awaiting `settle` after each callback; then sets the clock to
	 * `targetMs`. A callback that throws is rethrown after the clock reached its due time.
	 */
	async advanceTo(
		targetMs: number,
		settle: () => Promise<void>,
	): Promise<void> {
		for (;;) {
			const e = this.earliest()
			if (!e || e.due > targetMs) break
			this.nowMs = Math.max(this.nowMs, e.due)
			if (e.intervalMs === null) this.timers.delete(e.id)
			else {
				e.due += e.intervalMs
				e.seq = this.seq++
			}
			e.fn(...e.args)
			await settle()
		}
		this.nowMs = Math.max(this.nowMs, targetMs)
	}
}
