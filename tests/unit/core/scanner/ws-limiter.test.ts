import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { WsLimiter } from "../../../../src/core/scanner/ws-limiter.js"

interface Msg {
	key: string
	version: number
}

/** `t` is monotonic (timers run on it, like setTimeout); `now()` is the wall clock, which can be stepped. */
class FakeClock {
	t = 0
	wallOffset = 0
	private seq = 0
	private tasks: {
		at: number
		seq: number
		fn: () => void
		cancelled: boolean
	}[] = []
	now = (): number => this.t + this.wallOffset
	schedule = (fn: () => void, ms: number): { cancel(): void } => {
		const task = { at: this.t + ms, seq: this.seq++, fn, cancelled: false }
		this.tasks.push(task)
		return {
			cancel: () => {
				task.cancelled = true
			},
		}
	}
	advanceTo(target: number): void {
		for (;;) {
			const due = this.tasks
				.filter(x => !x.cancelled && x.at <= target)
				.sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
			if (due === undefined) break
			this.tasks = this.tasks.filter(x => x !== due)
			this.t = Math.max(this.t, due.at)
			due.fn()
		}
		this.t = Math.max(this.t, target)
	}
}

type Priority = "state" | "progress" | "activity"

function setup(
	maxPerSecond: number,
	perKeyMinIntervalMs: number,
	perPriorityMinIntervalMs?: Partial<Record<Priority, number>>,
) {
	const clock = new FakeClock()
	const emitted: { at: number; msg: Msg }[] = []
	const limiter = new WsLimiter<Msg>({
		maxPerSecond,
		perKeyMinIntervalMs,
		...(perPriorityMinIntervalMs ? { perPriorityMinIntervalMs } : {}),
		now: clock.now,
		emit: msg => emitted.push({ at: clock.t, msg }),
		schedule: clock.schedule,
	})
	return { clock, emitted, limiter }
}

describe("WsLimiter", () => {
	it("coalesces bursts per key to the latest state, at most once per interval", () => {
		const { clock, emitted, limiter } = setup(10, 1_000)
		for (let v = 1; v <= 5; v++) {
			clock.advanceTo(v * 100)
			limiter.offer("d1", { key: "d1", version: v }, "state")
		}
		clock.advanceTo(5_000)
		expect(emitted).toEqual([
			{ at: 100, msg: { key: "d1", version: 1 } },
			{ at: 1_100, msg: { key: "d1", version: 5 } },
		])
	})

	it("caps the total rate and prefers state over activity when slots are scarce", () => {
		const { clock, emitted, limiter } = setup(2, 0)
		limiter.offer("a1", { key: "a1", version: 1 }, "activity")
		limiter.offer("a2", { key: "a2", version: 1 }, "activity")
		limiter.offer("a3", { key: "a3", version: 1 }, "activity")
		limiter.offer("s1", { key: "s1", version: 1 }, "state")
		expect(emitted.map(e => e.msg.key)).toEqual(["a1", "a2"])
		clock.advanceTo(1_000)
		expect(emitted.map(e => e.msg.key)).toEqual(["a1", "a2", "s1", "a3"])
		expect(emitted.map(e => e.at)).toEqual([0, 0, 1_000, 1_000])
	})

	it("flushes pending messages and goes silent after destroy", () => {
		const { clock, emitted, limiter } = setup(1, 1_000)
		limiter.offer("d1", { key: "d1", version: 1 }, "state")
		limiter.offer("d2", { key: "d2", version: 1 }, "state")
		limiter.flush()
		expect(emitted.map(e => e.msg.key)).toEqual(["d1", "d2"])
		limiter.offer("d3", { key: "d3", version: 1 }, "state")
		limiter.offer("d4", { key: "d4", version: 1 }, "state")
		limiter.destroy()
		limiter.offer("d5", { key: "d5", version: 1 }, "state")
		clock.advanceTo(10_000)
		expect(emitted.map(e => e.msg.key)).toEqual(["d1", "d2"])
	})

	it("keeps emitting after the wall clock steps back 60 s", () => {
		const { clock, emitted, limiter } = setup(2, 1_000)
		clock.advanceTo(100_000)
		limiter.offer("d1", { key: "d1", version: 1 }, "state")
		limiter.offer("d2", { key: "d2", version: 1 }, "state")
		clock.wallOffset = -60_000 // NTP correction after a boot on a fake hwclock
		clock.advanceTo(100_100)
		limiter.offer("d1", { key: "d1", version: 2 }, "state")
		limiter.offer("d3", { key: "d3", version: 1 }, "state")
		// and the per-key limit applies again from the stepped clock on
		clock.advanceTo(100_500)
		limiter.offer("d1", { key: "d1", version: 3 }, "state")
		clock.advanceTo(110_000)
		expect(emitted).toEqual([
			{ at: 100_000, msg: { key: "d1", version: 1 } },
			{ at: 100_000, msg: { key: "d2", version: 1 } },
			{ at: 100_100, msg: { key: "d1", version: 2 } },
			{ at: 100_100, msg: { key: "d3", version: 1 } },
			{ at: 101_100, msg: { key: "d1", version: 3 } },
		])
	})

	it("applies a runtime maxPerSecond change", () => {
		const { clock, emitted, limiter } = setup(2, 0)
		for (const key of ["s1", "s2", "s3", "s4"])
			limiter.offer(key, { key, version: 1 }, "state")
		expect(emitted.map(e => e.msg.key)).toEqual(["s1", "s2"])
		limiter.setMaxPerSecond(4)
		expect(emitted.map(e => e.msg.key)).toEqual(["s1", "s2", "s3", "s4"])
		expect(emitted.map(e => e.at)).toEqual([0, 0, 0, 0])
		limiter.setMaxPerSecond(1)
		limiter.offer("s5", { key: "s5", version: 1 }, "state")
		clock.advanceTo(999)
		expect(emitted).toHaveLength(4)
		clock.advanceTo(1_000)
		expect(emitted.map(e => e.msg.key)).toEqual(["s1", "s2", "s3", "s4", "s5"])
		expect(emitted.at(-1)?.at).toBe(1_000)
	})

	// Feature: signal-discovery-scanner, Property 12: WS rate limits
	// Validates: spec § 9, § 12.2
	it("respects the window and per-key limits and eventually delivers every key's latest state", () => {
		const offerArb = fc.record({
			dt: fc.integer({ min: 0, max: 300 }),
			key: fc.integer({ min: 0, max: 5 }),
			priority: fc.constantFrom(
				"state" as const,
				"progress" as const,
				"activity" as const,
			),
		})
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 10 }),
				fc.integer({ min: 0, max: 1_500 }),
				fc.array(offerArb, { maxLength: 120 }),
				(max, interval, offers) => {
					const { clock, emitted, limiter } = setup(max, interval)
					const latest = new Map<string, number>()
					let t = 0
					offers.forEach((o, i) => {
						t += o.dt
						clock.advanceTo(t)
						const key = `${o.priority}:${o.key}` // one priority per key
						latest.set(key, i)
						limiter.offer(key, { key, version: i }, o.priority)
					})
					clock.advanceTo(t + 120_000)
					for (let i = 0; i + max < emitted.length; i++)
						expect(
							(emitted[i + max]?.at ?? 0) - (emitted[i]?.at ?? 0),
						).toBeGreaterThanOrEqual(1_000)
					const lastByKey = new Map<string, { at: number; version: number }>()
					for (const e of emitted) {
						const prev = lastByKey.get(e.msg.key)
						if (prev !== undefined) {
							expect(e.at - prev.at).toBeGreaterThanOrEqual(interval)
							expect(e.msg.version).toBeGreaterThan(prev.version)
						}
						lastByKey.set(e.msg.key, { at: e.at, version: e.msg.version })
					}
					for (const [key, version] of latest)
						expect(lastByKey.get(key)?.version).toBe(version)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("lets one priority override the per-key interval", () => {
		const { clock, emitted, limiter } = setup(10, 1_000, { progress: 500 })
		for (let v = 1; v <= 20; v++) {
			clock.advanceTo(v * 100)
			limiter.offer("p", { key: "p", version: v }, "progress")
			limiter.offer("s", { key: "s", version: v }, "state")
		}
		clock.advanceTo(5_000)
		expect(
			emitted.filter(e => e.msg.key === "p").map(e => [e.at, e.msg.version]),
		).toEqual([
			[100, 1],
			[600, 5],
			[1_100, 10],
			[1_600, 15],
			[2_100, 20],
		])
		expect(
			emitted.filter(e => e.msg.key === "s").map(e => [e.at, e.msg.version]),
		).toEqual([
			[100, 1],
			[1_100, 10],
			[2_100, 20],
		])
	})

	// Feature: web-gaps-1, Property 10: Scanner progress rate
	// Validates: Requirements 8.1
	it("keeps progress keys 500 ms apart, other keys 1 s apart, within the global budget", () => {
		const offerArb = fc.record({
			dt: fc.integer({ min: 0, max: 300 }),
			key: fc.integer({ min: 0, max: 5 }),
			priority: fc.constantFrom(
				"state" as const,
				"progress" as const,
				"activity" as const,
			),
		})
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 20 }),
				fc.array(offerArb, { maxLength: 150 }),
				(max, offers) => {
					const { clock, emitted, limiter } = setup(max, 1_000, {
						progress: 500,
					})
					const latest = new Map<string, number>()
					let t = 0
					offers.forEach((o, i) => {
						t += o.dt
						clock.advanceTo(t)
						const key = `${o.priority}:${o.key}` // one priority per key
						latest.set(key, i)
						limiter.offer(key, { key, version: i }, o.priority)
					})
					clock.advanceTo(t + 120_000)
					for (let i = 0; i + max < emitted.length; i++)
						expect(
							(emitted[i + max]?.at ?? 0) - (emitted[i]?.at ?? 0),
						).toBeGreaterThanOrEqual(1_000)
					const lastByKey = new Map<string, { at: number; version: number }>()
					for (const e of emitted) {
						const prev = lastByKey.get(e.msg.key)
						if (prev !== undefined) {
							const interval = e.msg.key.startsWith("progress:") ? 500 : 1_000
							expect(e.at - prev.at).toBeGreaterThanOrEqual(interval)
							expect(e.msg.version).toBeGreaterThan(prev.version)
						}
						lastByKey.set(e.msg.key, { at: e.at, version: e.msg.version })
					}
					for (const [key, version] of latest)
						expect(lastByKey.get(key)?.version).toBe(version)
				},
			),
			{ numRuns: 100 },
		)
	})
})
