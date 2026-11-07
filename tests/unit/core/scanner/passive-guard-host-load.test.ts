// The passive guard on realistic worker counters: host contention, a quiet host, and a passive job
// that really costs too much. Real PassiveGuard and real WorkerCostMeter, no fake decisions.
import fc from "fast-check"
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
	/** Replaces the worker's CPU answer; `cpuMs` is what a healthy worker would report. */
	cpuAnswer?: (cpuMs: number) => Promise<{ user: number; system: number }>
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
			cpuUsage: () =>
				opts.cpuAnswer
					? opts.cpuAnswer(cpu)
					: Promise.resolve({ user: cpu * 1000, system: 0 }),
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

	it("a real overrun is disabled when every CPU request after the first fails or hangs", async () => {
		const failures: (() => Promise<never>)[] = [
			() => Promise.reject(new Error("worker stopped")),
			() => new Promise<never>(() => undefined),
		]
		for (const failure of failures) {
			let calls = 0
			const s = sim({
				rates: flat(0.9, 0.9),
				meter: true,
				cpuAnswer: cpuMs =>
					calls++ === 0
						? Promise.resolve({ user: cpuMs * 1000, system: 0 })
						: failure(),
			})
			// The 10 stale ticks read as idle, so the first window reads about 0.75 and the limit is 0.25.
			await s.run(MINUTE + 12_000)
			expect(s.count("disable")).toBe(1)
			expect(s.passive()).toBe(false)
		}
	})

	it("a real overrun is disabled when one CPU request in 12 is answered", async () => {
		let calls = 0
		const s = sim({
			rates: flat(0.9, 0.9),
			meter: true,
			cpuAnswer: cpuMs =>
				calls++ % 12 === 0
					? Promise.resolve({ user: cpuMs * 1000, system: 0 })
					: Promise.reject(new Error("no answer")),
		})
		await s.run(3600 * 1000)
		expect(s.count("disable")).toBeGreaterThan(0)
		// Judged at the first window, not eventually.
		expect(s.actions[0]).toEqual({ at: MINUTE, what: "disable" })
	})

	it("a preempted worker under the limit stays on when one CPU request in 12 is answered", async () => {
		let calls = 0
		const s = sim({
			rates: flat(0.7, 0.2),
			meter: true,
			cpuAnswer: cpuMs =>
				calls++ % 12 === 0
					? Promise.resolve({ user: cpuMs * 1000, system: 0 })
					: Promise.reject(new Error("no answer")),
		})
		await s.run(120 * MINUTE)
		expect(s.kinds()).toEqual([])
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
	describe("tells when it falls back on ELU", () => {
		it("once, when the Node has no worker.cpuUsage", () => {
			const told: string[] = []
			const m = new WorkerCostMeter({
				elu: () => ({ idle: 300, active: 700 }),
				onEluFallback: reason => told.push(reason),
			})
			for (let tick = 0; tick < 5; tick++) m.sample()
			expect(told).toEqual(["no-cpu-usage"])
		})

		it("once, at the tick the misses reach the bound and not one before", () => {
			const told: string[] = []
			const m = new WorkerCostMeter({
				elu: () => ({ idle: 300, active: 700 }),
				cpuUsage: () => new Promise(() => {}),
				onEluFallback: reason => told.push(reason),
			})
			// The first tick sends the only request; each later one finds it pending and counts a miss.
			for (let tick = 0; tick < COST_METER_MAX_MISSES; tick++) m.sample()
			expect(told).toEqual([])
			m.sample()
			expect(told).toEqual(["no-answer"])
			for (let tick = 0; tick < 5; tick++) m.sample()
			expect(told).toEqual(["no-answer"])
		})

		it("not at all while the worker answers", async () => {
			const told: string[] = []
			const m = new WorkerCostMeter({
				elu: () => ({ idle: 300, active: 700 }),
				cpuUsage: () => Promise.resolve({ user: 1000, system: 0 }),
				onEluFallback: reason => told.push(reason),
			})
			for (let tick = 0; tick < 20; tick++) {
				m.sample()
				await new Promise<void>(resolve => {
					setImmediate(resolve)
				})
			}
			expect(told).toEqual([])
		})
	})

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

	describe("a worker that stops answering", () => {
		const TICK_MS = 1000
		const ELU_ACTIVE_SHARE = 0.9
		type Answer = "cpu" | "reject" | "hang"

		/**
		 * A worker whose ELU runs at 90 % active and whose CPU time runs at `cpuShare`. `answer` decides
		 * each request; `release` settles the requests left hanging with the current CPU figure.
		 */
		function worker(answer: (call: number) => Answer, cpuShare = 0.1) {
			let tick = 0
			let calls = 0
			let hanging: ((usage: { user: number; system: number }) => void)[] = []
			const usage = () => ({
				user: tick * TICK_MS * cpuShare * 1000,
				system: 0,
			})
			const meter = new WorkerCostMeter({
				elu: () => ({
					idle: tick * TICK_MS * (1 - ELU_ACTIVE_SHARE),
					active: tick * TICK_MS * ELU_ACTIVE_SHARE,
				}),
				cpuUsage: () => {
					const kind = answer(calls++)
					if (kind === "cpu") return Promise.resolve(usage())
					if (kind === "reject")
						return Promise.reject(new Error("worker stopped"))
					return new Promise(resolve => hanging.push(resolve))
				},
			})
			return {
				meter,
				/** One 1 s tick: time passes, the guard samples, the worker answers. */
				tick: async () => {
					tick++
					const s = meter.sample()
					await flush()
					await flush()
					return s
				},
				release: () => {
					for (const resolve of hanging) resolve(usage())
					hanging = []
				},
				wall: () => tick * TICK_MS,
			}
		}

		const FAILURES: Answer[] = ["reject", "hang"]
		const onceThen = (kind: Answer) => (call: number) =>
			call === 0 ? "cpu" : kind

		for (const kind of FAILURES) {
			it(`${kind}: stale CPU at 9 misses, ELU from 10, counters consistent`, async () => {
				const w = worker(onceThen(kind))
				expect(await w.tick()).toBeNull()
				// The answer to the first request: 1 s × 0.1, and from here no answer arrives.
				const first = (await w.tick())!
				expect(first.active).toBe(100)
				for (let misses = 1; misses < COST_METER_MAX_MISSES; misses++) {
					const stale = (await w.tick())!
					expect(stale.active).toBe(100)
					expect(stale.idle).toBe(w.wall() - 100)
				}
				// Miss 10: one tick of ELU, no jump to ELU's own cumulative figure.
				const at10 = (await w.tick())!
				expect(at10.active).toBeCloseTo(100 + 900, 6)
				expect(at10.active + at10.idle).toBeCloseTo(w.wall(), 6)
				let last = at10
				for (let i = 0; i < 120; i++) {
					const s = (await w.tick())!
					expect(s.active - last.active).toBeCloseTo(900, 6)
					expect(s.idle - last.idle).toBeCloseTo(100, 6)
					expect(s.active + s.idle).toBeCloseTo(w.wall(), 6)
					expect(s.utilization).toBeCloseTo(s.active / w.wall(), 10)
					last = s
				}
			})

			it(`${kind} from the first request: no sample until 10 misses, then plain ELU`, async () => {
				const w = worker(() => kind)
				for (let tick = 1; tick <= COST_METER_MAX_MISSES; tick++)
					expect(await w.tick()).toBeNull()
				const s = (await w.tick())!
				expect(s.active).toBeCloseTo(w.wall() * ELU_ACTIVE_SHARE, 6)
				expect(s.idle).toBeCloseTo(w.wall() * (1 - ELU_ACTIVE_SHARE), 6)
				expect(s.utilization).toBeCloseTo(ELU_ACTIVE_SHARE, 10)
			})
		}

		it("a reject answered before the bound never falls back", async () => {
			// Nine misses in a row, then an answer: the count starts over each time.
			const w = worker(call => (call % 10 === 0 ? "cpu" : "reject"))
			await w.tick()
			for (let i = 0; i < 100; i++) {
				const s = (await w.tick())!
				expect(s.active).toBeLessThanOrEqual(w.wall() * 0.1 + 1e-6)
			}
		})

		for (const kind of FAILURES) {
			it(`${kind}: on recovery active follows CPU again from where ELU left it`, async () => {
				let failing = false
				const w = worker(call => {
					if (call === 0) return "cpu"
					return failing ? kind : "cpu"
				})
				await w.tick()
				await w.tick()
				failing = true
				const samples = []
				for (let i = 0; i < 30; i++) samples.push((await w.tick())!)
				failing = false
				w.release()
				await flush()
				await flush()
				// A rejecting worker has nothing to release: the next request carries its first answer.
				if (kind === "reject") samples.push((await w.tick())!)
				// The next sample is the one the recovery answer rebases on: no jump either way.
				const rebased = (await w.tick())!
				samples.push(rebased)
				expect(rebased.active).toBeCloseTo(samples.at(-2)!.active, 6)
				expect(rebased.idle - samples.at(-2)!.idle).toBeCloseTo(TICK_MS, 6)
				// Then each tick costs what CPU says, not a flat stretch while CPU catches ELU up.
				let last = rebased
				for (let i = 0; i < 30; i++) {
					const s = (await w.tick())!
					samples.push(s)
					expect(s.active - last.active).toBeCloseTo(100, 6)
					expect(s.idle - last.idle).toBeCloseTo(900, 6)
					expect(s.active + s.idle).toBeCloseTo(w.wall(), 6)
					last = s
				}
				for (let i = 1; i < samples.length; i++) {
					expect(samples[i]!.active).toBeGreaterThanOrEqual(
						samples[i - 1]!.active,
					)
					expect(samples[i]!.idle).toBeGreaterThanOrEqual(samples[i - 1]!.idle)
				}
			})
		}

		const everyTwelfth = (call: number): Answer =>
			call % 12 === 0 ? "cpu" : "reject"

		it("one answer in 12: 3 600 s at CPU 0.9 reads 0.9, not the 0.15 that discards the stale ticks", async () => {
			const w = worker(everyTwelfth, ELU_ACTIVE_SHARE)
			let s = null
			for (let i = 0; i < 3600; i++) s = await w.tick()
			const cpu = w.wall() * ELU_ACTIVE_SHARE
			expect(s!.active).toBeGreaterThanOrEqual(
				cpu - COST_METER_MAX_MISSES * TICK_MS * ELU_ACTIVE_SHARE,
			)
			expect(s!.active).toBeLessThanOrEqual(cpu + 1e-6)
			expect(s!.utilization).toBeGreaterThan(0.85)
		})

		it("one answer in 12: ELU's credit is not counted again by the CPU delta that covers it", async () => {
			const w = worker(everyTwelfth, ELU_ACTIVE_SHARE)
			await w.tick()
			let s = (await w.tick())!
			let answered = s.active
			// Ticks 2 to 13 are one round: the answer to the request of tick 13 is read at tick 14.
			for (let round = 1; round <= 20; round++) {
				for (let i = 0; i < 12; i++) s = (await w.tick())!
				expect(s.active - answered).toBeCloseTo(
					12 * TICK_MS * ELU_ACTIVE_SHARE,
					6,
				)
				answered = s.active
			}
		})

		// The last (every - 10) ticks of each round follow ELU: 2 × 0.9 / 12 and 20 × 0.9 / 30, against
		// CPU time's 0.1. An answer sooner than the bound credits no ELU: one in 10 reads 0.1.
		for (const [every, reads] of [
			[10, 0.1],
			[12, 0.15],
			[30, 0.6],
		] as const) {
			it(`one answer in ${every} on a preempted worker reads ${reads}: what ELU credited, and no more`, async () => {
				const w = worker(call => (call % every === 0 ? "cpu" : "reject"), 0.1)
				let s = null
				for (let i = 0; i < 40 * every; i++) s = await w.tick()
				expect(s!.utilization).toBeGreaterThan(reads - 0.01)
				expect(s!.utilization).toBeLessThan(reads + 0.01)
			})
		}

		for (const kind of FAILURES) {
			it(`${kind}: CPU time runs ahead of active by exactly the bound, no further`, async () => {
				const w = worker(onceThen(kind), ELU_ACTIVE_SHARE)
				await w.tick()
				let peak = 0
				for (let i = 0; i < 100; i++) {
					const s = (await w.tick())!
					peak = Math.max(peak, w.wall() * ELU_ACTIVE_SHARE - s.active)
				}
				expect(peak).toBeCloseTo(
					COST_METER_MAX_MISSES * TICK_MS * ELU_ACTIVE_SHARE,
					6,
				)
			})
		}

		it("a late answer's credit stays below ELU's total", async () => {
			const w = worker(call => (call === 1 ? "hang" : "cpu"), ELU_ACTIVE_SHARE)
			await w.tick()
			const before = (await w.tick())!
			for (let i = 0; i < 4; i++) await w.tick()
			w.release()
			await flush()
			await flush()
			const after = (await w.tick())!
			expect(after.active).toBeGreaterThan(before.active)
			expect(after.active).toBeLessThanOrEqual(w.wall() * ELU_ACTIVE_SHARE)
			expect(after.active).toBeCloseTo(
				(w.wall() - TICK_MS) * ELU_ACTIVE_SHARE,
				6,
			)
		})

		// Feature: spectrum-main-thread, Property 4: active follows CPU time within the stale bound, under ELU
		// Validates: docs/PERFORMANCE.md, the passive guard judges CPU time
		it("over any answer pattern, active is within the stale bound of CPU time and under ELU", async () => {
			const EPS = 1e-6
			const WINDOW_TICKS = 60
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.constantFrom<Answer>("cpu", "reject", "hang"), {
						minLength: 1,
						maxLength: 60,
					}),
					fc.nat({ max: 40 }),
					fc.array(
						fc.record({
							elu: fc.double({ min: 0, max: 1, noNaN: true }),
							cpuOfElu: fc.double({ min: 0, max: 1, noNaN: true }),
						}),
						{ minLength: 1, maxLength: 30 },
					),
					async (answers, releaseEvery, rates) => {
						let tick = 0
						let calls = 0
						let cpu = 0
						let elu = 0
						let hanging: (() => void)[] = []
						const meter = new WorkerCostMeter({
							elu: () => ({ idle: tick * TICK_MS - elu, active: elu }),
							cpuUsage: () => {
								const kind = answers[calls++ % answers.length]!
								if (kind === "reject")
									return Promise.reject(new Error("no answer"))
								if (kind === "cpu")
									return Promise.resolve({ user: cpu * 1000, system: 0 })
								return new Promise(resolve => {
									hanging.push(() => resolve({ user: cpu * 1000, system: 0 }))
								})
							},
						})
						const cpuAt: number[] = [0]
						const eluAt: number[] = [0]
						const activeAt: (number | null)[] = [null]
						/** The CPU time of the costliest `COST_METER_MAX_MISSES` ticks in a row so far. */
						let stale = 0
						let last = { idle: 0, active: 0 }
						for (let t = 1; t <= 400; t++) {
							const rate = rates[t % rates.length]!
							tick = t
							elu += rate.elu * TICK_MS
							cpu += rate.elu * rate.cpuOfElu * TICK_MS
							cpuAt.push(cpu)
							eluAt.push(elu)
							stale = Math.max(
								stale,
								cpu - cpuAt[Math.max(0, t - COST_METER_MAX_MISSES)]!,
							)
							const s = meter.sample()
							activeAt.push(s === null ? null : s.active)
							await flush()
							await flush()
							if (releaseEvery > 0 && t % releaseEvery === 0) {
								for (const release of hanging) release()
								hanging = []
								await flush()
								await flush()
							}
							if (s === null) continue
							// Plain comparisons: 400 ticks x 100 runs of expect() calls cost seconds on a busy host.
							const fail = (what: string): never => {
								throw new Error(
									`tick ${t}: ${what} (active ${s.active}, idle ${s.idle}, cpu ${cpu}, elu ${elu}, stale ${stale})`,
								)
							}
							if (s.active < last.active) fail("active went back")
							if (s.idle < last.idle) fail("idle went back")
							last = s
							if (s.active > elu + EPS) fail("active above ELU")
							if (cpu - s.active > stale + EPS)
								fail("active below CPU by more than the stale bound")
							const start = activeAt[t - WINDOW_TICKS]
							if (start === undefined || start === null) continue
							const from = t - WINDOW_TICKS
							const advance = s.active - start
							if (advance < cpuAt[t]! - cpuAt[from]! - stale - EPS)
								fail("window advance below CPU less the stale bound")
							if (advance > eluAt[t]! - eluAt[from]! + stale + EPS)
								fail("window advance above ELU plus the stale bound")
						}
					},
				),
				{ numRuns: 100 },
			)
		})

		// Feature: spectrum-main-thread, Property 3: the meter's counters never go back
		// Validates: docs/PERFORMANCE.md, the passive guard judges CPU time
		it("counters never go back and active stays within ELU over any answer pattern", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.constantFrom<Answer>("cpu", "reject", "hang"), {
						minLength: 1,
						maxLength: 40,
					}),
					fc.array(fc.nat({ max: 25 }), { minLength: 1, maxLength: 6 }),
					fc.double({ min: 0, max: 1, noNaN: true }),
					async (answers, releases, cpuShare) => {
						const w = worker(call => answers[call % answers.length]!, cpuShare)
						let last = { idle: 0, active: 0 }
						for (const stretch of releases) {
							for (let i = 0; i <= stretch; i++) {
								const s = await w.tick()
								if (s === null) continue
								// Plain comparisons, as above: expect() per tick is the cost on a busy host.
								if (
									s.active < last.active ||
									s.idle < last.idle ||
									s.active > w.wall() * ELU_ACTIVE_SHARE + 1e-6
								)
									throw new Error(
										`counters went back or active passed ELU: ${JSON.stringify({ s, last, wall: w.wall() })}`,
									)
								last = s
							}
							w.release()
							await flush()
							await flush()
						}
					},
				),
				{ numRuns: 200 },
			)
		})
	})
})
