/**
 * Per-key leading-edge throttle (WG2 req 9).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EntityUpdateThrottle } from "../../../src/core/entity-update-throttle.js"
import { WaveKitError } from "../../../src/utils/errors.js"

interface Sample {
	identity: string
	seq: number
}

interface Emission {
	key: string
	seq: number
	at: number
}

function harness(options?: {
	windowMs?: number
	maxKeys?: number
	now?: () => number
}) {
	const emitted: Emission[] = []
	const throttle = new EntityUpdateThrottle<Sample>({
		windowMs: options?.windowMs ?? 2_000,
		identity: state => state.identity,
		emit: (key, state) => {
			emitted.push({ key, seq: state.seq, at: Date.now() })
		},
		...(options?.maxKeys !== undefined ? { maxKeys: options.maxKeys } : {}),
		...(options?.now !== undefined ? { now: options.now } : {}),
	})
	return { throttle, emitted }
}

describe("EntityUpdateThrottle", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("emits the leading edge and the latest state once at the window end", () => {
		const { throttle, emitted } = harness()
		throttle.offer("m", { identity: "a", seq: 1 })
		throttle.offer("m", { identity: "a", seq: 2 })
		throttle.offer("m", { identity: "a", seq: 3 })
		expect(emitted.map(item => item.seq)).toEqual([1])
		expect(throttle.pending()).toBe(1)
		expect(throttle.pending()).toBeLessThanOrEqual(throttle.size())
		vi.advanceTimersByTime(2_000)
		expect(emitted.map(item => item.seq)).toEqual([1, 3])
		expect(emitted[1]?.at).toBe(2_000)
		expect(throttle.pending()).toBe(0)
		throttle.stop()
	})

	it("emits an identity change at once and drops the pending state", () => {
		const { throttle, emitted } = harness()
		throttle.offer("m", { identity: "a", seq: 1 })
		throttle.offer("m", { identity: "a", seq: 2 })
		vi.advanceTimersByTime(100)
		throttle.offer("m", { identity: "b", seq: 3 })
		expect(emitted.map(item => item.seq)).toEqual([1, 3])
		expect(emitted[1]?.at).toBe(100)
		expect(throttle.pending()).toBe(0)
		vi.advanceTimersByTime(2_000)
		expect(emitted.map(item => item.seq)).toEqual([1, 3])
		throttle.stop()
	})

	it("emits immediately once the window has elapsed and does not flush a stale pending state", () => {
		// `now` runs ahead of the timer clock: the pending flush is still armed,
		// and the offer that finds the window already over drops it.
		let clock = 0
		const { throttle, emitted } = harness({ now: () => clock })
		throttle.offer("m", { identity: "a", seq: 1 })
		clock = 500
		throttle.offer("m", { identity: "a", seq: 2 })
		clock = 2_000
		throttle.offer("m", { identity: "a", seq: 3 })
		expect(emitted.map(item => item.seq)).toEqual([1, 3])
		vi.advanceTimersByTime(2_000)
		expect(emitted.map(item => item.seq)).toEqual([1, 3])
		throttle.stop()
	})

	it("forgets a key on clear and emits the next offer at once", () => {
		const { throttle, emitted } = harness()
		throttle.offer("m", { identity: "a", seq: 1 })
		throttle.offer("m", { identity: "a", seq: 2 })
		throttle.clear("m")
		expect(throttle.size()).toBe(0)
		vi.advanceTimersByTime(2_000)
		expect(emitted.map(item => item.seq)).toEqual([1])
		throttle.offer("m", { identity: "a", seq: 3 })
		expect(emitted.map(item => item.seq)).toEqual([1, 3])
		throttle.clear("missing")
		throttle.stop()
	})

	it("emits nothing after stop", () => {
		const { throttle, emitted } = harness()
		throttle.offer("m", { identity: "a", seq: 1 })
		throttle.offer("m", { identity: "a", seq: 2 })
		throttle.stop()
		expect(throttle.size()).toBe(0)
		expect(throttle.pending()).toBe(0)
		vi.advanceTimersByTime(5_000)
		throttle.offer("m", { identity: "a", seq: 3 })
		expect(emitted.map(item => item.seq)).toEqual([1])
	})

	it("counts an emit exception and still consumes the window", () => {
		const emitted: number[] = []
		const throttle = new EntityUpdateThrottle<number>({
			windowMs: 1_000,
			identity: () => "a",
			emit: (_key, value) => {
				if (value === 1) throw new Error("boom")
				emitted.push(value)
			},
		})
		expect(() => throttle.offer("k", 1)).not.toThrow()
		expect(throttle.errors()).toBe(1)
		throttle.offer("k", 2)
		expect(emitted).toEqual([])
		vi.advanceTimersByTime(1_000)
		expect(emitted).toEqual([2])
		expect(throttle.errors()).toBe(1)
		throttle.stop()
	})

	it("keeps a re-entrant offer made from emit", () => {
		const seen: number[] = []
		const throttle = new EntityUpdateThrottle<number>({
			windowMs: 1_000,
			identity: () => "a",
			emit: (_key, value) => {
				seen.push(value)
				if (value === 1) throttle.offer("k", 2)
			},
		})
		throttle.offer("k", 1)
		expect(seen).toEqual([1])
		expect(throttle.pending()).toBe(1)
		vi.advanceTimersByTime(1_000)
		expect(seen).toEqual([1, 2])
		throttle.stop()
	})

	it("drops the key when emit clears it, and ignores offers after emit stops it", () => {
		const cleared = new EntityUpdateThrottle<number>({
			windowMs: 1_000,
			identity: () => "a",
			emit: key => cleared.clear(key),
		})
		cleared.offer("k", 1)
		expect(cleared.size()).toBe(0)
		vi.advanceTimersByTime(1_000)
		cleared.offer("k", 2)
		expect(cleared.size()).toBe(0)
		cleared.stop()

		const seen: number[] = []
		const stopped = new EntityUpdateThrottle<number>({
			windowMs: 1_000,
			identity: () => "a",
			emit: (_key, value) => {
				seen.push(value)
				stopped.stop()
			},
		})
		stopped.offer("k", 1)
		stopped.offer("k", 2)
		expect(seen).toEqual([1])
		expect(stopped.size()).toBe(0)
	})

	it("lets an identity exception propagate and leaves the slot unchanged", () => {
		let calls = 0
		const throttle = new EntityUpdateThrottle<number>({
			windowMs: 1_000,
			identity: () => {
				calls++
				if (calls === 2) throw new Error("identity")
				return "a"
			},
			emit: () => {},
		})
		throttle.offer("k", 1)
		expect(() => throttle.offer("k", 2)).toThrow("identity")
		expect(throttle.errors()).toBe(0)
		expect(throttle.size()).toBe(1)
		expect(throttle.pending()).toBe(0)
		throttle.stop()
	})

	it("reads the injected clock at flush time", () => {
		let clock = 0
		const { throttle, emitted } = harness({ windowMs: 1_000, now: () => clock })
		throttle.offer("k", { identity: "a", seq: 1 })
		clock = 400
		throttle.offer("k", { identity: "a", seq: 2 })
		// The timer delay was fixed at offer time. The clock must already show
		// the due time when that timer runs, or the next window starts late.
		clock = 1_000
		vi.advanceTimersByTime(600)
		expect(emitted.map(item => item.seq)).toEqual([1, 2])
		throttle.offer("k", { identity: "a", seq: 3 })
		expect(emitted).toHaveLength(2)
		expect(throttle.pending()).toBe(1)
		throttle.stop()
	})

	it("emits every offer when the window is zero", () => {
		const { throttle, emitted } = harness({ windowMs: 0 })
		throttle.offer("k", { identity: "a", seq: 1 })
		throttle.offer("k", { identity: "a", seq: 2 })
		expect(emitted.map(item => item.seq)).toEqual([1, 2])
		expect(throttle.pending()).toBe(0)
		throttle.stop()
	})

	it("passes a new key through once 10000 keys are tracked", () => {
		let identityCalls = 0
		const emitted: string[] = []
		const throttle = new EntityUpdateThrottle<string>({
			windowMs: 2_000,
			identity: value => {
				identityCalls++
				return value
			},
			emit: key => emitted.push(key),
		})
		for (let i = 0; i < 10_000; i++) throttle.offer(String(i), "a")
		expect(throttle.size()).toBe(10_000)
		expect(throttle.overflows()).toBe(0)
		expect(identityCalls).toBe(10_000)

		throttle.offer("overflow", "a")
		throttle.offer("overflow", "b")
		expect(throttle.overflows()).toBe(2)
		expect(throttle.size()).toBe(10_000)
		expect(identityCalls).toBe(10_000)
		expect(emitted.at(-1)).toBe("overflow")

		throttle.clear("0")
		throttle.offer("fresh", "c")
		expect(throttle.size()).toBe(10_000)
		expect(throttle.overflows()).toBe(2)
		expect(identityCalls).toBe(10_001)

		for (let i = 1; i < 10_000; i++) throttle.offer(String(i), "a")
		throttle.offer("fresh", "c")
		expect(throttle.pending()).toBe(10_000)
		expect(throttle.pending()).toBe(throttle.size())
		const emittedBeforeStop = emitted.length
		throttle.stop()
		expect(throttle.pending()).toBe(0)
		expect(throttle.size()).toBe(0)
		vi.advanceTimersByTime(2_000)
		throttle.offer("later", "d")
		expect(emitted).toHaveLength(emittedBeforeStop)
	})

	it("cuts the busy-port burst cohort and emits the rest", () => {
		// 10 min, 2 s window, 220 vessels (under maxKeys). Steady reports whose
		// interval is already >= 2 s are not reduced. A 3-report burst every
		// 10 s keeps the leading edge and the latest (+800 ms) and drops the middle.
		//   10 @ 2 s:   301 * 10 = 3010 offered = emitted
		//   40 @ 6 s:   101 * 40 = 4040
		//   50 @ 10 s:   61 * 50 = 3050
		//  100 @ 180 s:   4 * 100 = 400
		//   20 burst: 61 * 3 * 20 = 3660 offered, 61 * 2 * 20 = 2440 emitted
		// offered 14160, emitted 12940 (1220 dropped, 8.6%).
		const { throttle, emitted } = harness()
		const events: Array<{ t: number; id: string; seq: number }> = []
		const addSteady = (from: number, to: number, interval: number) => {
			for (let id = from; id < to; id++) {
				for (let t = 0; t <= 600_000; t += interval) {
					events.push({ t, id: String(id), seq: t })
				}
			}
		}
		addSteady(0, 10, 2_000)
		addSteady(10, 50, 6_000)
		addSteady(50, 100, 10_000)
		addSteady(100, 200, 180_000)
		for (let t = 0; t <= 600_000; t += 10_000) {
			for (let id = 200; id < 220; id++) {
				events.push({ t, id: String(id), seq: t })
				events.push({ t: t + 400, id: String(id), seq: t + 400 })
				events.push({ t: t + 800, id: String(id), seq: t + 800 })
			}
		}
		events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
		let cursor = 0
		let offered = 0
		for (const event of events) {
			if (event.t > cursor) {
				vi.advanceTimersByTime(event.t - cursor)
				cursor = event.t
			}
			offered++
			throttle.offer(event.id, { identity: event.id, seq: event.seq })
			expect(throttle.pending()).toBeLessThanOrEqual(throttle.size())
		}
		vi.advanceTimersByTime(2_000)
		expect(offered).toBe(14_160)
		expect(emitted).toHaveLength(12_940)
		expect(throttle.pending()).toBe(0)
		expect(throttle.size()).toBe(220)
		const burst = emitted.filter(item => item.key === "200")
		expect(burst).toHaveLength(122)
		expect(burst.every(item => item.seq % 10_000 !== 400)).toBe(true)
		throttle.stop()
	})
})

describe("EntityUpdateThrottle construction", () => {
	it("rejects a bad window or maxKeys", () => {
		const identity = () => "a"
		const emit = () => {}
		for (const windowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(
				() => new EntityUpdateThrottle({ windowMs, identity, emit }),
			).toThrow(WaveKitError)
		}
		try {
			new EntityUpdateThrottle({ windowMs: -1, identity, emit })
			expect.unreachable()
		} catch (err) {
			expect(err).toBeInstanceOf(WaveKitError)
			expect((err as WaveKitError).code).toBe("ENTITY_THROTTLE_WINDOW")
		}
		for (const maxKeys of [0, -1, 1.5]) {
			try {
				new EntityUpdateThrottle({ windowMs: 1, maxKeys, identity, emit })
				expect.unreachable()
			} catch (err) {
				expect(err).toBeInstanceOf(WaveKitError)
				expect((err as WaveKitError).code).toBe("ENTITY_THROTTLE_MAX_KEYS")
			}
		}
	})

	it("unrefs the one pending timer", () => {
		const probe = setTimeout(() => {}, 1)
		const proto = Object.getPrototypeOf(probe) as { unref: () => unknown }
		clearTimeout(probe)
		const unref = vi.spyOn(proto, "unref")
		const throttle = new EntityUpdateThrottle<number>({
			windowMs: 60_000,
			identity: () => "a",
			emit: () => {},
			now: () => 0,
		})
		try {
			throttle.offer("k", 1)
			throttle.offer("k", 2)
			expect(unref).toHaveBeenCalledTimes(1)
			expect(throttle.pending()).toBe(1)
		} finally {
			throttle.stop()
			unref.mockRestore()
		}
	})
})
