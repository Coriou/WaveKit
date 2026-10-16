/**
 * Per-key leading-edge throttle for entity updates (WG2 req 9).
 *
 * The first offer of a key emits at once. Further offers of the same identity
 * inside `windowMs` keep only the latest state and flush it once, from one
 * unref'd timer, at the end of the window. A different identity emits at once
 * and drops anything pending. `clear` forgets the key. `stop` cancels every
 * timer and ignores later offers.
 *
 * `now` must read the same clock that drives timers (the default `Date.now()`
 * does, including under fake timers). The throttle holds the offered state by
 * reference and never copies it.
 */

import { WaveKitError } from "../utils/errors.js"

export interface EntityUpdateThrottleOptions<T> {
	windowMs: number
	identity: (state: T) => string
	emit: (key: string, state: T) => void
	/** Clock for the window. Default `Date.now`. */
	now?: () => number
	/** Distinct keys remembered. Beyond this, new keys emit immediately. Default 10_000. */
	maxKeys?: number
}

interface Pending<T> {
	state: T
	identity: string
}

interface Slot<T> {
	identity: string
	lastEmitAt: number
	pending: Pending<T> | null
	timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_MAX_KEYS = 10_000

export class EntityUpdateThrottle<T> {
	private readonly windowMs: number
	private readonly maxKeys: number
	private readonly identityOf: (state: T) => string
	private readonly emitFn: (key: string, state: T) => void
	private readonly now: () => number
	private readonly entries = new Map<string, Slot<T>>()
	private stopped = false
	private errorCount = 0
	private overflowCount = 0

	constructor(options: EntityUpdateThrottleOptions<T>) {
		if (!Number.isFinite(options.windowMs) || options.windowMs < 0) {
			throw new WaveKitError(
				"EntityUpdateThrottle windowMs must be a finite number >= 0",
				"ENTITY_THROTTLE_WINDOW",
			)
		}
		const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
		if (!Number.isInteger(maxKeys) || maxKeys < 1) {
			throw new WaveKitError(
				"EntityUpdateThrottle maxKeys must be an integer >= 1",
				"ENTITY_THROTTLE_MAX_KEYS",
			)
		}
		this.windowMs = options.windowMs
		this.maxKeys = maxKeys
		this.identityOf = options.identity
		this.emitFn = options.emit
		this.now = options.now ?? (() => Date.now())
	}

	/** Keys currently remembered (emitted and not cleared). Pass-through keys are not counted. */
	size(): number {
		return this.entries.size
	}

	/** Keys with a pending trailing flush. One timer each. */
	pending(): number {
		let count = 0
		for (const slot of this.entries.values()) {
			if (slot.timer !== null) count++
		}
		return count
	}

	/** Emit callbacks that threw. */
	errors(): number {
		return this.errorCount
	}

	/** Offers emitted immediately because `maxKeys` was already full. */
	overflows(): number {
		return this.overflowCount
	}

	offer(key: string, state: T): void {
		if (this.stopped) return
		const known = this.entries.get(key)
		if (!known && this.entries.size >= this.maxKeys) {
			this.overflowCount++
			this.safeEmit(key, state)
			return
		}
		const identity = this.identityOf(state)
		if (!known) {
			this.entries.set(key, {
				identity,
				lastEmitAt: this.now(),
				pending: null,
				timer: null,
			})
			this.safeEmit(key, state)
			return
		}
		if (identity !== known.identity) {
			this.disarm(known)
			known.identity = identity
			known.lastEmitAt = this.now()
			this.safeEmit(key, state)
			return
		}
		const elapsed = Math.max(0, this.now() - known.lastEmitAt)
		if (elapsed >= this.windowMs) {
			this.disarm(known)
			known.identity = identity
			known.lastEmitAt = this.now()
			this.safeEmit(key, state)
			return
		}
		known.pending = { state, identity }
		if (known.timer === null) this.arm(known, key, this.windowMs - elapsed)
	}

	/** Drop a pending flush and forget the key. The next offer emits at once. */
	clear(key: string): void {
		const slot = this.entries.get(key)
		if (!slot) return
		this.disarm(slot)
		this.entries.delete(key)
	}

	/** Cancel every timer. Later offers do nothing. */
	stop(): void {
		this.stopped = true
		for (const slot of this.entries.values()) this.disarm(slot)
		this.entries.clear()
	}

	private arm(slot: Slot<T>, key: string, delay: number): void {
		const timer = setTimeout(() => {
			if (this.stopped) return
			const current = this.entries.get(key)
			if (!current || current.timer !== timer) return
			current.timer = null
			this.flush(key)
		}, delay)
		if (typeof timer.unref === "function") timer.unref()
		slot.timer = timer
	}

	private flush(key: string): void {
		if (this.stopped) return
		const slot = this.entries.get(key)
		if (!slot?.pending) return
		const pending = slot.pending
		slot.pending = null
		slot.timer = null
		slot.lastEmitAt = this.now()
		slot.identity = pending.identity
		this.safeEmit(key, pending.state)
	}

	private disarm(slot: Slot<T>): void {
		if (slot.timer !== null) {
			clearTimeout(slot.timer)
			slot.timer = null
		}
		slot.pending = null
	}

	private safeEmit(key: string, state: T): void {
		try {
			this.emitFn(key, state)
		} catch {
			this.errorCount++
		}
	}
}
