// The passive guard on realistic worker counters: host contention, a quiet host, and a passive job
// that really costs too much. Real PassiveGuard and real WorkerCostMeter, no fake decisions.
import { describe, expect, it } from "vitest"
import { PassiveGuard } from "../../../../src/core/scanner/passive-guard.js"
import type { PassiveGuardView } from "../../../../src/core/scanner/passive-guard.js"
import {
	COST_METER_MAX_MISSES,
	WorkerCostMeter,
} from "../../../../src/core/spectrum/pipeline-host.js"

const MINUTE = 60_000
const LIMIT = 0.25

interface Rates {
	/** Event-loop active share of wall time (includes time preempted inside a callback). */
	elu: number
	/** The thread's own CPU share of wall time. */
	cpu: number
}

/**
 * One source, ticked each second like the service does. `displays` empty means passive is the sole
 * consumer, so disabling closes the engine. The meter is awaited on every tick (a microtask), which
 * is the shape of the real `worker.cpuUsage()` answering between ticks.
 */
function sim(opts: {
	displays?: string[]
	rates: (passive: boolean, t: number) => Rates
	meter: boolean
}) {
	const displays = opts.displays ?? []
	let t = 0
	let passive = true
	// One running worker: closing the engine ends it, and the next open starts counters from zero.
	let engine = {}
	let generation = 1
	let openedAt = 0
	let eluActive = 0
	let cpu = 0
	const guard = new PassiveGuard()
	const newMeter = (): WorkerCostMeter =>
		new WorkerCostMeter({
			elu: () => ({ idle: t - openedAt - eluActive, active: eluActive }),
			cpuUsage: () => Promise.resolve({ user: cpu * 1000, system: 0 }),
		})
	let meter = newMeter()
	const actions: { at: number; what: string }[] = []
	let onMs = 0
	const engineOpen = (): boolean => passive || displays.length > 0
	const sample = (): PassiveGuardView["sample"] => {
		if (opts.meter) {
			const s = meter.sample()
			return s === null ? null : { idle: s.idle, active: s.active, generation }
		}
		return { idle: t - openedAt - eluActive, active: eluActive, generation }
	}
	const run = async (ms: number): Promise<void> => {
		for (let i = 0; i < ms / 1000; i++) {
			if (engineOpen()) {
				const r = opts.rates(passive, t)
				eluActive += r.elu * 1000
				cpu += r.cpu * 1000
			}
			t += 1000
			if (passive) onMs += 1000
			const a = guard.tick(
				"s",
				{
					engine: engineOpen() ? engine : null,
					openedAt,
					consumers: {
						jobs: passive ? ["job:passive-s"] : [],
						displays,
					},
					sample: engineOpen() ? sample() : null,
					tracked: passive,
				},
				t,
				LIMIT,
			)
			if (a.kind === "disable" || a.kind === "measure") {
				passive = false
				actions.push({ at: t, what: a.kind })
			} else if (a.kind === "restore") {
				if (!engineOpen()) {
					engine = {}
					generation++
					openedAt = t
					eluActive = 0
					cpu = 0
					meter = newMeter()
				}
				passive = true
				actions.push({ at: t, what: `restore:${a.why}` })
			}
			for (let m = 0; m < 5; m++) await Promise.resolve()
		}
	}
	return {
		run,
		actions,
		kinds: () => actions.map(a => a.what),
		count: (what: string) => actions.filter(a => a.what === what).length,
		onMs: () => onMs,
		passive: () => passive,
	}
}

const flat = (elu: number, cpu: number) => (): Rates => ({ elu, cpu })

describe("passive guard under host load", () => {
	it("sole, loaded host: preemption inflates ELU to 0.7, CPU stays 0.2, passive stays on", async () => {
		const s = sim({ rates: flat(0.7, 0.2), meter: true })
		await s.run(120 * MINUTE)
		expect(s.kinds()).toEqual([])
		expect(s.passive()).toBe(true)
	})

	it("the same sequence judged on ELU alone disabled it: the confound the meter removes", async () => {
		const s = sim({ rates: flat(0.7, 0.2), meter: false })
		await s.run(2 * MINUTE)
		expect(s.count("disable")).toBe(1)
	})

	it("sole, quiet host at 0.15: nothing happens on either measure", async () => {
		for (const meter of [true, false]) {
			const s = sim({ rates: flat(0.15, 0.15), meter })
			await s.run(120 * MINUTE)
			expect(s.kinds()).toEqual([])
		}
	})

	it("sole, a real overrun at CPU 0.6 disables at the first window, loaded or not", async () => {
		for (const elu of [0.6, 0.95]) {
			const s = sim({ rates: flat(elu, 0.6), meter: true })
			await s.run(MINUTE + 2000)
			expect(s.count("disable")).toBe(1)
			expect(s.passive()).toBe(false)
		}
	})

	it("sole, a real overrun comes back on probation at most once per 15 min", async () => {
		const s = sim({ rates: flat(0.6, 0.6), meter: true })
		await s.run(120 * MINUTE)
		// 2 h / (15 min off + 1 min judged) = 7.5 cycles, and passive runs 1 min in 16
		expect(s.count("disable")).toBeGreaterThanOrEqual(7)
		expect(s.count("disable")).toBeLessThanOrEqual(8)
		expect(s.onMs()).toBeLessThanOrEqual(8 * 62_000)
	})

	it("shared, load rises after the baseline: judged on ELU it reads as passive cost, on CPU it does not", async () => {
		// ELU 0.3 until the baseline is taken, then 0.6 from load alone; passive costs nothing, CPU 0.28.
		const rates = (_p: boolean, t: number): Rates => ({
			elu: t < 3 * MINUTE ? 0.3 : 0.6,
			cpu: 0.28,
		})
		const elu = sim({ displays: ["ws:a"], rates, meter: false })
		await elu.run(30 * MINUTE)
		expect(elu.count("disable")).toBeGreaterThan(0)
		const cpu = sim({ displays: ["ws:a"], rates, meter: true })
		await cpu.run(30 * MINUTE)
		expect(cpu.count("disable")).toBe(0)
	})

	it("shared and over the limit at no cost: one measuring minute per 30 min, nothing else", async () => {
		const s = sim({ displays: ["ws:a"], rates: flat(0.4, 0.4), meter: true })
		await s.run(120 * MINUTE)
		expect(s.count("disable")).toBe(0)
		// 120 / 30 = 4; the first runs at minute 1, then one each time the baseline ages out
		expect(s.count("measure")).toBeGreaterThanOrEqual(3)
		expect(s.count("measure")).toBeLessThanOrEqual(5)
	})

	it("shared, passive really costly and the engine cheap without it: no 2 min flip-flop", async () => {
		// Off 0.1 (under the 0.2 clear line), on 0.5: M = 0.4 over the limit.
		const s = sim({
			displays: ["ws:a"],
			rates: p => (p ? { elu: 0.5, cpu: 0.5 } : { elu: 0.1, cpu: 0.1 }),
			meter: true,
		})
		await s.run(120 * MINUTE)
		// The spec's bound (8.8): passive at most 61 s per 900 s while its cost stays over the limit.
		// 120 min / 15 min = 8 trials, plus the first judged minutes before the first disable.
		expect(s.count("restore:clear")).toBe(0)
		expect(s.count("disable")).toBeGreaterThanOrEqual(7)
		expect(s.count("disable")).toBeLessThanOrEqual(9)
		expect(s.onMs()).toBeLessThanOrEqual(9 * 61_000 + 2 * MINUTE)
	})

	it("shared, saturated by passive with a baseline: the same hold, no 2 min flip-flop", async () => {
		// Off 0.1, on 0.5 until the baseline is taken, then on 0.97: row 3 with U - B = 0.87.
		const s = sim({
			displays: ["ws:a"],
			rates: (p, t) => {
				const cpu = p ? (t < 3 * MINUTE ? 0.5 : 0.97) : 0.1
				return { elu: cpu, cpu }
			},
			meter: true,
		})
		await s.run(60 * MINUTE)
		expect(s.count("restore:clear")).toBe(0)
		expect(s.count("disable")).toBeLessThanOrEqual(5)
	})

	it("saturated with no baseline says nothing about passive: row 8 still clears it", async () => {
		const s = sim({
			displays: ["ws:a"],
			rates: (_p, t) => {
				const cpu = t < 2 * MINUTE ? 0.97 : 0.1
				return { elu: cpu, cpu }
			},
			meter: true,
		})
		await s.run(6 * MINUTE)
		expect(s.count("disable")).toBe(1)
		expect(s.count("restore:clear")).toBe(1)
	})

	it("the hold ends when the workload changes: another consumer means a fresh judgement", async () => {
		const engine = {}
		const guard = new PassiveGuard()
		let t = 0
		let active = 0
		let passive = true
		let displays = ["ws:a"]
		const tick = (rate: number) => {
			active += rate * 1000
			t += 1000
			return guard.tick(
				"s",
				{
					engine,
					openedAt: 0,
					consumers: { jobs: passive ? ["job:passive-s"] : [], displays },
					sample: { idle: t - active, active, generation: 1 },
					tracked: passive,
				},
				t,
				LIMIT,
			)
		}
		let disabled = false
		for (let i = 0; i < 5 * 60 && !disabled; i++) {
			const a = tick(passive ? 0.5 : 0.1)
			if (a.kind === "measure") passive = false
			if (a.kind === "restore") passive = true
			if (a.kind === "disable") {
				passive = false
				disabled = true
			}
		}
		expect(disabled).toBe(true)
		displays = ["ws:a", "ws:b"]
		const seen: string[] = []
		for (let i = 0; i < 130; i++) {
			const a = tick(0.1)
			if (a.kind === "restore") seen.push(a.why)
			if (a.kind === "restore") break
		}
		expect(seen).toEqual(["clear"])
	})
})

describe("WorkerCostMeter", () => {
	const flush = async (): Promise<void> => {
		await Promise.resolve()
		await Promise.resolve()
	}

	it("no sample until the first CPU answer, then active is the CPU time", async () => {
		const m = new WorkerCostMeter({
			elu: () => ({ idle: 500, active: 500 }),
			cpuUsage: () => Promise.resolve({ user: 100_000, system: 50_000 }),
		})
		expect(m.sample()).toBeNull()
		await flush()
		const s = m.sample()!
		expect(s.active).toBe(150)
		expect(s.idle).toBe(850)
		expect(s.utilization).toBeCloseTo(0.15, 10)
	})

	it("active never exceeds ELU's active time", async () => {
		const m = new WorkerCostMeter({
			elu: () => ({ idle: 900, active: 100 }),
			cpuUsage: () => Promise.resolve({ user: 400_000, system: 0 }),
		})
		m.sample()
		await flush()
		expect(m.sample()!.active).toBe(100)
	})

	it("counters never go back, whatever order the readings arrive in", async () => {
		const readings = [
			{ wall: 1000, elu: 500, cpu: 300 },
			{ wall: 1001, elu: 500, cpu: 450 },
			{ wall: 1002, elu: 400, cpu: 100 },
			{ wall: 3000, elu: 600, cpu: 500 },
		]
		let i = 0
		const m = new WorkerCostMeter({
			elu: () => {
				const r = readings[Math.min(i, readings.length - 1)]!
				return { idle: r.wall - r.elu, active: r.elu }
			},
			cpuUsage: () =>
				Promise.resolve({
					user: readings[Math.min(i, readings.length - 1)]!.cpu * 1000,
					system: 0,
				}),
		})
		m.sample()
		await flush()
		let last = { idle: 0, active: 0 }
		for (i = 0; i < readings.length; i++) {
			const s = m.sample()!
			expect(s.idle).toBeGreaterThanOrEqual(last.idle)
			expect(s.active).toBeGreaterThanOrEqual(last.active)
			last = s
			await flush()
		}
	})

	it("reports plain ELU on a Node without cpuUsage", () => {
		const m = new WorkerCostMeter({ elu: () => ({ idle: 300, active: 700 }) })
		const s = m.sample()!
		expect(s.active).toBe(700)
		expect(s.utilization).toBeCloseTo(0.7, 10)
	})

	it("falls back to ELU at the miss bound, and not one tick before it", async () => {
		const m = new WorkerCostMeter({
			elu: () => ({ idle: 300, active: 700 }),
			cpuUsage: () => new Promise(() => undefined),
		})
		// the first call only asks; each later call with the answer outstanding is one miss
		for (let i = 0; i < COST_METER_MAX_MISSES; i++)
			expect(m.sample()).toBeNull()
		expect(m.sample()!.active).toBe(700)
		await flush()
	})

	it("a rejected answer keeps the last figure and does not throw", async () => {
		let reject = false
		const m = new WorkerCostMeter({
			elu: () => ({ idle: 500, active: 500 }),
			cpuUsage: () =>
				reject
					? Promise.reject(new Error("worker stopped"))
					: Promise.resolve({ user: 100_000, system: 0 }),
		})
		m.sample()
		await flush()
		await flush()
		reject = true
		expect(m.sample()!.active).toBe(100)
		await flush()
		await flush()
		await flush()
		expect(m.sample()!.active).toBe(100)
	})
})
