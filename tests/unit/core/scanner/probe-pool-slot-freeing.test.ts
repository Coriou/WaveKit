/**
 * ProbePool.slotFreeing: a queued request whose slot a stopping probe is about to free. Identify
 * keeps such a run queued past IDENTIFY_QUEUE_WAIT_MS instead of skipping it. Identify, job probes
 * and external reservations (recordings, analog trials) share one CPU budget.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	IDENTIFY_PROBE_PRIORITY,
	IDENTIFY_SLOT_FREEING_MAX_MS,
} from "../../../../src/core/scanner/identify.js"
import {
	IDENTIFY_PREEMPTION_HOLD_GAP_MS,
	IDENTIFY_PREEMPTION_HOLD_MS,
	offsetTransport,
	type TransportStrategy,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	flushAsync,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

function gate(h: ReturnType<typeof poolHarness>): () => void {
	let open = (): void => undefined
	h.decoders.removeGate = new Promise<void>(resolve => {
		open = resolve
	})
	return () => {
		h.decoders.removeGate = null
		open()
	}
}

describe("ProbePool.slotFreeing", () => {
	it("true while the probe preempted for the request stops; false once the request started", async () => {
		const h = poolHarness()
		const held = h.pool.request(probeRequest({ priority: 50 }))
		expect(held).toHaveProperty("started")
		await flushAsync()
		const open = gate(h)
		const req = probeRequest({
			jobId: "identify",
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: "t2",
		})
		expect(h.pool.request(req)).toEqual({ deferred: "max-probes" })
		await flushAsync()
		expect(h.pool.slotFreeing(req)).toBe(true)
		open()
		for (let i = 0; i < 5; i++) await flushAsync()
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify"])
		// Started, so no longer queued: nothing is being freed for it.
		expect(h.pool.slotFreeing(req)).toBe(false)
	})

	it("false while the slot is held by a probe nobody stops (another identify)", async () => {
		const h = poolHarness()
		expect(
			h.pool.request(
				probeRequest({ jobId: "first", priority: IDENTIFY_PROBE_PRIORITY }),
			),
		).toHaveProperty("started")
		await flushAsync()
		const req = probeRequest({
			jobId: "second",
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: "t2",
		})
		expect(h.pool.request(req)).toEqual({ deferred: "max-probes" })
		await flushAsync()
		expect(h.pool.slotFreeing(req)).toBe(false)
	})

	it("false for a request that is not queued, and after the pool is sealed", async () => {
		const h = poolHarness()
		const held = h.pool.request(probeRequest({ priority: 50 }))
		expect(held).toHaveProperty("started")
		await flushAsync()
		const open = gate(h)
		const req = probeRequest({
			jobId: "identify",
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: "t2",
		})
		expect(h.pool.slotFreeing(req)).toBe(false)
		h.pool.request(req)
		await flushAsync()
		expect(h.pool.slotFreeing(req)).toBe(true)
		h.pool.sealAdmission()
		expect(h.pool.slotFreeing(req)).toBe(false)
		open()
		for (let i = 0; i < 5; i++) await flushAsync()
	})
})

describe("ProbePool.queuedDeferral: the real reason a queued request waits", () => {
	it("max-probes while another identify holds the slot", async () => {
		const h = poolHarness()
		h.pool.request(
			probeRequest({ jobId: "first", priority: IDENTIFY_PROBE_PRIORITY }),
		)
		await flushAsync()
		const req = probeRequest({
			jobId: "second",
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: "t2",
		})
		h.pool.request(req)
		expect(h.pool.queuedDeferral(req)).toMatchObject({
			deferral: "max-probes",
		})
	})

	it("budget for a job probe when external reservations (recordings, analog trials) leave no room, with no probe running", () => {
		const h = poolHarness()
		const budget = h.settings.cpuBudgetCores
		// Room for the engine and recordings, none for a 0.5-core offset probe.
		const held = budget - 0.08 - 0.45
		expect(h.pool.reserveExternal(held)).not.toBeNull()
		const req = probeRequest({ jobId: "job", priority: 50 })
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		expect(h.pool.status()).toHaveLength(0)
		const d = h.pool.queuedDeferral(req)
		expect(d).toMatchObject({ deferral: "budget", budgetCores: budget })
		expect(d?.externalCores).toBeCloseTo(held, 9)
		expect(d?.estimatedCores).toBeCloseTo(0.08 + held, 9)
	})

	it("cpu while measured CPU is over the guard (a job probe)", () => {
		const h = poolHarness({ cpuPercent: 99 })
		const req = probeRequest({ priority: 50 })
		expect(h.pool.request(req)).toEqual({ deferred: "cpu" })
		expect(h.pool.queuedDeferral(req)).toMatchObject({ deferral: "cpu" })
	})

	it("null for a request that is not queued", () => {
		const h = poolHarness()
		expect(h.pool.queuedDeferral(probeRequest())).toBeNull()
	})
})

describe("ProbePool: one shared CPU budget for identify, job probes and reservations", () => {
	// Budget arithmetic: one engine 0.08 + one offset probe 0.5 = 0.58.
	const settings = (
		budget = 1,
		offsetSlots = 1,
	): ReturnType<typeof testSettings> =>
		testSettings(s => {
			s.cpuBudgetCores = budget
			s.maxProbes.offset = offsetSlots
		})

	it("identify waits on `budget` when reservations leave no room; the reservation is never cut", () => {
		const h = poolHarness()
		const budget = h.settings.cpuBudgetCores
		const held = budget - 0.08 - 0.45
		expect(h.pool.reserveExternal(held)).not.toBeNull()
		const req = probeRequest({
			jobId: "identify",
			priority: IDENTIFY_PROBE_PRIORITY,
		})
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		expect(h.pool.status()).toHaveLength(0)
		const d = h.pool.queuedDeferral(req)
		expect(d).toMatchObject({
			deferral: "budget",
			budgetCores: budget,
			probesCores: 0,
		})
		expect(d?.enginesCores).toBeCloseTo(0.08, 9)
		expect(d?.externalCores).toBeCloseTo(held, 9)
		expect(h.pool.externalCoresInUse()).toBeCloseTo(held, 9)
	})

	it("at the bound: engine + reservation + the identify probe exactly fill the budget, it starts", () => {
		const h = poolHarness({ settings: settings(0.88) })
		expect(h.pool.reserveExternal(0.3)).not.toBeNull()
		expect(
			h.pool.request(
				probeRequest({ jobId: "identify", priority: IDENTIFY_PROBE_PRIORITY }),
			),
		).toHaveProperty("started")
	})

	it("a reservation counts a running identify probe: E + I + new = 0.08 + 0.5 + 0.42 = 1 fits, 0.43 does not", async () => {
		const h = poolHarness({ settings: settings() })
		expect(
			h.pool.request(
				probeRequest({ jobId: "identify", priority: IDENTIFY_PROBE_PRIORITY }),
			),
		).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.reserveExternal(0.43)).toBeNull()
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
		expect(h.pool.reserveExternal(0.001)).toBeNull()
	})

	it("a reservation counts a job probe: E + J + new = 0.08 + 0.5 + 0.42 = 1 fits, 0.43 does not", async () => {
		const h = poolHarness({ settings: settings() })
		expect(
			h.pool.request(probeRequest({ jobId: "job", priority: 50 })),
		).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.reserveExternal(0.43)).toBeNull()
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
	})

	it("a job probe counts identify's cores and reservations", async () => {
		const h = poolHarness({ settings: settings(1, 2) })
		h.pool.request(
			probeRequest({ jobId: "identify", priority: IDENTIFY_PROBE_PRIORITY }),
		)
		await flushAsync()
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
		expect(
			h.pool.request(
				probeRequest({ jobId: "job", priority: 50, trackId: "t2" }),
			),
		).toEqual({ deferred: "budget" })
	})

	it("identify on `budget` does not preempt a job probe when reservations alone leave no room: the job probe keeps running", async () => {
		const h = poolHarness({ settings: settings(1, 2) })
		expect(
			h.pool.request(probeRequest({ jobId: "job", priority: 50 })),
		).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
		// The operator lowers the budget: the reservation now exceeds budget - engine - probe
		// (0.42 > 0.95 - 0.08 - 0.5), so stopping the job probe cannot make room for identify.
		h.settings.cpuBudgetCores = 0.95
		const req = probeRequest({
			jobId: "identify",
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: "t2",
		})
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		for (let i = 0; i < 5; i++) {
			await flushAsync()
			h.pool.pump()
		}
		expect(h.pool.status().map(p => [p.jobId, p.state])).toEqual([
			["job", expect.not.stringMatching(/^stopping$/)],
		])
		// Nothing is being freed, so identify stops waiting and skips the trial as cpu-budget.
		expect(h.pool.slotFreeing(req)).toBe(false)
		expect(h.pool.queuedDeferral(req)).toMatchObject({ deferral: "budget" })
		expect(h.pool.externalCoresInUse()).toBeCloseTo(0.42, 9)
		h.pool.sealAdmission()
	})

	it("identify on `budget` preempts a job probe when stopping it makes room", async () => {
		const h = poolHarness({ settings: settings(1, 2) })
		expect(
			h.pool.request(probeRequest({ jobId: "job", priority: 50 })),
		).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.reserveExternal(0.3)).not.toBeNull()
		// 0.08 + 0.5 + 0.3 + 0.5 > 1, but 0.08 + 0.3 + 0.5 <= 1 once the job probe stops.
		const req = probeRequest({
			jobId: "identify",
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: "t2",
		})
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		for (let i = 0; i < 5; i++) {
			await flushAsync()
			h.pool.pump()
		}
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify"])
		expect(h.pool.externalCoresInUse()).toBeCloseTo(0.3, 9)
	})

	it("property: across identify probes, job probes and reservations the estimate never exceeds the budget", async () => {
		type Op =
			| { kind: "identify" | "job"; priority: number }
			| { kind: "reserve"; cores: number }
			| { kind: "unreserve"; index: number }
			| { kind: "releaseProbe"; index: number }
		const op: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				kind: fc.constant("identify" as const),
				priority: fc.constant(IDENTIFY_PROBE_PRIORITY),
			}),
			fc.record({
				kind: fc.constant("job" as const),
				priority: fc.integer({ min: 0, max: 100 }),
			}),
			fc.record({
				kind: fc.constant("reserve" as const),
				cores: fc.double({ min: 0, max: 1.2, noNaN: true }),
			}),
			fc.record({
				kind: fc.constant("unreserve" as const),
				index: fc.nat(),
			}),
			fc.record({
				kind: fc.constant("releaseProbe" as const),
				index: fc.nat(),
			}),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.double({ min: 0.5, max: 3, noNaN: true }),
				fc.integer({ min: 1, max: 3 }),
				fc.array(op, { minLength: 1, maxLength: 25 }),
				async (budget, slots, ops) => {
					const h = poolHarness({ settings: settings(budget, slots) })
					const releases: (() => void)[] = []
					const estimate = (): number =>
						0.08 +
						h.pool.status().reduce((sum, p) => sum + p.cores, 0) +
						h.pool.externalCoresInUse()
					let n = 0
					for (const o of ops) {
						n++
						if (o.kind === "identify" || o.kind === "job")
							h.pool.request(
								probeRequest({
									jobId: `${o.kind}-${n}`,
									priority: o.priority,
									trackId: `t${n}`,
									observationId: `o${n}`,
								}),
							)
						else if (o.kind === "reserve") {
							const release = h.pool.reserveExternal(o.cores)
							if (release) releases.push(release)
						} else if (o.kind === "unreserve") {
							releases.splice(o.index % Math.max(1, releases.length), 1)[0]?.()
						} else if (o.kind === "releaseProbe") {
							const probes = h.pool.status()
							const p = probes[o.index % Math.max(1, probes.length)]
							if (p) await h.pool.release(p.probeId)
						}
						await flushAsync()
						h.pool.pump()
						expect(estimate()).toBeLessThanOrEqual(budget + 1e-9)
					}
					h.pool.sealAdmission()
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})

describe("ProbePool: identify preemption never stops a held recorded call, holds what it frees, re-checks room per victim", () => {
	// Arithmetic: engine 0.08, every offset probe 0.5.
	const settings = (
		budget: number,
		offsetSlots: number,
	): ReturnType<typeof testSettings> =>
		testSettings(s => {
			s.cpuBudgetCores = budget
			s.maxProbes.offset = offsetSlots
		})
	const identify = (): ReturnType<typeof probeRequest> =>
		probeRequest({
			jobId: "identify",
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: "t-id",
			observationId: "o-id",
		})
	async function settle(h: ReturnType<typeof poolHarness>): Promise<void> {
		for (let i = 0; i < 6; i++) {
			await flushAsync()
			h.pool.pump()
		}
	}
	async function job(
		h: ReturnType<typeof poolHarness>,
		n: number,
		record = false,
	): Promise<string> {
		const r = h.pool.request(
			probeRequest({
				jobId: `job${n}`,
				priority: 50,
				trackId: `t${n}`,
				observationId: `o${n}`,
				record,
			}),
		)
		if (!("started" in r)) throw new Error("job probe did not start")
		await flushAsync()
		// A recorded probe makes its record directory (real fs) before it is ready.
		for (
			let k = 0;
			k < 200 &&
			h.pool.status().find(p => p.probeId === r.started)?.state === "starting";
			k++
		)
			await new Promise(resolve => setTimeout(resolve, 5))
		return r.started
	}
	// Two job probes and 0.5 reserved fill 0.08 + 1.0 + 0.5 = 1.58 of a 1.6 budget; the operator then
	// lowers it to 1.5. Identify (0.5) needs both stopped: one stop leaves 0.08 + 0.5 + 0.5 + 0.5 = 1.58
	// > 1.5, two leave 1.08 <= 1.5. (With equal probe costs and an unchanged budget one stop always
	// makes room, since the reservation itself had to fit.)
	async function twoVictims(): Promise<ReturnType<typeof poolHarness>> {
		const h = poolHarness({ settings: settings(1.6, 3) })
		await job(h, 1)
		await job(h, 2)
		expect(h.pool.reserveExternal(0.5)).not.toBeNull()
		h.settings.cpuBudgetCores = 1.5
		return h
	}

	it("identify on `budget` never stops a following recorded job probe; nothing is freed, the wait ends cpu-budget", async () => {
		const h = poolHarness({ settings: settings(1, 2) })
		const id = await job(h, 1, true)
		h.pool.follow(id, true)
		expect(h.pool.reserveExternal(0.3)).not.toBeNull()
		// 0.08 + 0.5 + 0.3 + 0.5 = 1.38 > 1; stopping the call would make room (0.88 <= 1), but it is held.
		const req = identify()
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		await settle(h)
		expect(h.pool.status().map(p => [p.jobId, p.state])).toEqual([
			["job1", "following"],
		])
		expect(h.pool.slotFreeing(req)).toBe(false)
		expect(h.pool.queuedDeferral(req)).toMatchObject({ deferral: "budget" })
		h.pool.sealAdmission()
	})

	it("identify on `max-probes` never stops a following recorded job probe either", async () => {
		const h = poolHarness({ settings: settings(4, 1) })
		const id = await job(h, 1, true)
		h.pool.follow(id, true)
		const req = identify()
		expect(h.pool.request(req)).toEqual({ deferred: "max-probes" })
		await settle(h)
		expect(h.pool.status().map(p => [p.jobId, p.state])).toEqual([
			["job1", "following"],
		])
		expect(h.pool.slotFreeing(req)).toBe(false)
		h.pool.sealAdmission()
	})

	it("a following probe that is not recorded is still preempted, and a recorded one only while following", async () => {
		const h = poolHarness({ settings: settings(1, 2) })
		const id = await job(h, 1, true)
		// Recorded but confirming, not following: no call is held.
		h.pool.follow(id, false)
		expect(h.pool.reserveExternal(0.3)).not.toBeNull()
		expect(h.pool.request(identify())).toEqual({ deferred: "budget" })
		await settle(h)
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify"])
	})

	it("one victim suffices: 0.4 reserved, budget 1.6: 0.08 + 0.5 + 0.4 + 0.5 = 1.48 <= 1.6 after one stop; the other job keeps running", async () => {
		const h = poolHarness({ settings: settings(1.6, 3) })
		await job(h, 1)
		await job(h, 2)
		expect(h.pool.reserveExternal(0.4)).not.toBeNull()
		// 0.08 + 1.0 + 0.4 + 0.5 = 1.98 > 1.6
		expect(h.pool.request(identify())).toEqual({ deferred: "budget" })
		await settle(h)
		const jobs = h.pool.status().map(p => p.jobId)
		expect(jobs).toHaveLength(2)
		expect(jobs).toContain("identify")
	})

	it("two victims needed, both stopped one per round", async () => {
		const h = await twoVictims()
		expect(h.pool.request(identify())).toEqual({ deferred: "budget" })
		await settle(h)
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify"])
		expect(h.pool.externalCoresInUse()).toBeCloseTo(0.5, 9)
	})

	it("room shrank between rounds (budget lowered to 1.0 after the first stop): the second victim keeps running", async () => {
		const h = await twoVictims()
		let stopped = 0
		h.pool.on("probe-state", (_id: string, state: string) => {
			if (state !== "stopped" || stopped++ > 0) return
			// Left 0.08 + 0.5 + 0.5 = 1.08; stopping the other job leaves 0.58 + 0.5 = 1.08 > 1.0.
			h.settings.cpuBudgetCores = 1.0
		})
		const req = identify()
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		await settle(h)
		expect(stopped).toBe(1)
		expect(h.pool.status()).toHaveLength(1)
		expect(h.pool.status()[0]?.jobId).toMatch(/^job/)
		expect(h.pool.slotFreeing(req)).toBe(false)
		h.pool.sealAdmission()
	})

	it("at the room bound between rounds (budget 1.08 after the first stop): 0.58 + 0.5 = 1.08 <= 1.08, the second victim is stopped", async () => {
		const h = await twoVictims()
		let stopped = 0
		h.pool.on("probe-state", (_id: string, state: string) => {
			if (state !== "stopped" || stopped++ > 0) return
			h.settings.cpuBudgetCores = 1.08
		})
		expect(h.pool.request(identify())).toEqual({ deferred: "budget" })
		await settle(h)
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify"])
	})

	it("the room check counts only probes this requester may stop: a priority-60 job never stops a priority-50 probe when only a priority-80 one would complete the room", async () => {
		const h = poolHarness({ settings: settings(1.6, 3) })
		const start = (jobId: string, priority: number, n: number): void => {
			expect(
				h.pool.request(
					probeRequest({
						jobId,
						priority,
						trackId: `t${n}`,
						observationId: `o${n}`,
					}),
				),
			).toHaveProperty("started")
		}
		start("low", 50, 1)
		start("high", 80, 2)
		await flushAsync()
		expect(h.pool.reserveExternal(0.5)).not.toBeNull()
		h.settings.cpuBudgetCores = 1.5
		// Stopping "low" alone leaves 0.08 + 0.5 + 0.5 + 0.5 = 1.58 > 1.5; "high" outranks the requester.
		const req = probeRequest({
			jobId: "mid",
			priority: 60,
			trackId: "t3",
			observationId: "o3",
		})
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		await settle(h)
		expect(
			h.pool
				.status()
				.map(p => p.jobId)
				.sort(),
		).toEqual(["high", "low"])
		h.pool.sealAdmission()
	})

	it("the same requester stops the priority-50 probe when it alone makes room (budget left at 1.6: 1.58 - 0.5 + 0.5 = 1.58 <= 1.6)", async () => {
		const h = poolHarness({ settings: settings(1.6, 3) })
		for (const [jobId, priority, n] of [
			["low", 50, 1],
			["high", 80, 2],
		] as const)
			expect(
				h.pool.request(
					probeRequest({
						jobId,
						priority,
						trackId: `t${n}`,
						observationId: `o${n}`,
					}),
				),
			).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.reserveExternal(0.5)).not.toBeNull()
		const req = probeRequest({
			jobId: "mid",
			priority: 60,
			trackId: "t3",
			observationId: "o3",
		})
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		await settle(h)
		expect(
			h.pool
				.status()
				.map(p => p.jobId)
				.sort(),
		).toEqual(["high", "mid"])
	})

	it("between preemption rounds with equal costs a recording that leaves identify its room is admitted (0.08 + 0.5 + 0.5 + 0.05 + 0.5 = 1.63 before the second stop, 1.13 after)", async () => {
		const h = await twoVictims()
		const between: boolean[] = []
		h.pool.on("probe-state", (_id: string, state: string) => {
			if (state !== "stopped" || between.length > 0) return
			// After the first stop: estimate 0.08 + 0.5 + 0.5 = 1.08. Identify's room with 0.05 more:
			// 1.08 + 0.05 - 0.5 (the job probe it may still stop) + 0.5 = 1.13 <= 1.5.
			const release = h.pool.reserveExternal(0.05)
			between.push(release !== null)
			release?.()
		})
		expect(h.pool.request(identify())).toEqual({ deferred: "budget" })
		await settle(h)
		expect(between).toEqual([true])
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify"])
		// 0.08 + 0.5 + 0.5 + 0.42 = 1.5 fits.
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
	})

	// Unequal costs, so a reservation can fit the budget yet leave identify no room: job probes
	// (dsd-fme) cost `job`, an fsk2-wide identify (multimon-ng) costs `id`, the engine 0.08.
	function unequal(
		budget: number,
		costs: { job: number; id: number },
	): ReturnType<typeof poolHarness> {
		const transport: TransportStrategy = {
			...offsetTransport,
			cores: decoderType =>
				decoderType === "multimon-ng" ? costs.id : costs.job,
		}
		return poolHarness({
			settings: settings(budget, 3),
			transports: [transport],
		})
	}
	const costlyIdentify = (tag: string): ReturnType<typeof probeRequest> =>
		probeRequest({
			jobId: `identify-${tag}`,
			priority: IDENTIFY_PROBE_PRIORITY,
			trackId: `t-${tag}`,
			observationId: `o-${tag}`,
			cls: "fsk2-wide",
		})

	it("reviewer's case: a 0.5 recording during the stop is admitted (budget 3.08, engine 0.08, job probe 1, recording 1.5, identify 1)", async () => {
		const h = unequal(3.08, { job: 1, id: 1 })
		await job(h, 1)
		expect(h.pool.reserveExternal(1.5)).not.toBeNull()
		const open = gate(h)
		const req = costlyIdentify("a")
		// 0.08 + 1 + 1.5 + 1 = 3.58 > 3.08; without the job probe 2.58 <= 3.08.
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		await flushAsync()
		expect(h.pool.slotFreeing(req)).toBe(true)
		// Past the budget: 2.58 + 0.51 = 3.09 > 3.08.
		expect(h.pool.reserveExternal(0.51)).toBeNull()
		// At it: 2.58 + 0.5 = 3.08, and identify's room 3.08 - 1 (stopping victim) + 1 = 3.08 <= 3.08.
		// (Counting the held 1 on top of the stopping victim refused this: 3.08 + 1 > 3.08.)
		expect(h.pool.reserveExternal(0.5)).not.toBeNull()
		open()
		await settle(h)
		// 0.08 + 1.5 + 0.5 + 1 = 3.08: identify starts beside the recording.
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify-a"])
	})

	// Budget 2, job probe 0.5, identify 0.8, 0.7 reserved: estimate 1.28; identify 2.08 > 2, without the
	// job probe 1.58 <= 2. While the job probe stops, a recording x fits the budget up to 0.72 but leaves
	// identify its room only up to 1.28 + x - 0.5 + 0.8 <= 2, x <= 0.42.
	async function breaking(): Promise<{
		h: ReturnType<typeof poolHarness>
		req: ReturnType<typeof probeRequest>
		open: () => void
		t0: number
	}> {
		const h = unequal(2, { job: 0.5, id: 0.8 })
		await job(h, 1)
		expect(h.pool.reserveExternal(0.7)).not.toBeNull()
		const open = gate(h)
		const t0 = h.clock.now
		const req = costlyIdentify("a")
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		await flushAsync()
		expect(h.pool.slotFreeing(req)).toBe(true)
		return { h, req, open, t0 }
	}

	it("a recording that would leave identify no room is refused while the victim stops: 0.43 refused (2.01 > 2), 0.42 admitted (2.0)", async () => {
		const { h, open } = await breaking()
		expect(h.pool.reserveExternal(0.43)).toBeNull()
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
		open()
		await settle(h)
		// 0.08 + 0.7 + 0.42 + 0.8 = 2.0
		expect(h.pool.status().map(p => p.jobId)).toEqual(["identify-a"])
	})

	it("the hold expires IDENTIFY_PREEMPTION_HOLD_MS after the window opened: refused at 7 999 ms, admitted at 8 000 ms", async () => {
		const { h, req, open, t0 } = await breaking()
		h.clock.now = t0 + IDENTIFY_PREEMPTION_HOLD_MS - 1
		expect(h.pool.reserveExternal(0.43)).toBeNull()
		h.clock.now = t0 + IDENTIFY_PREEMPTION_HOLD_MS
		expect(h.pool.reserveExternal(0.43)).not.toBeNull()
		open()
		await settle(h)
		// 0.08 + 0.7 + 0.43 + 0.8 = 2.01 > 2: identify still waits.
		expect(h.pool.queuedDeferral(req)).toMatchObject({ deferral: "budget" })
		h.pool.sealAdmission()
	})

	// Identify A preempts at t0 and leaves at t0 + 4 s; a second job probe starts; identify B preempts it
	// at t0 + `bAt`. Then the estimate is 0.08 + 0.7 + 0.5 = 1.28 and a 0.5 recording (1.78 <= 2) leaves
	// B no room (1.28 + 0.5 - 0.5 + 0.8 = 2.08 > 2): refused exactly while a hold is in force.
	async function chained(bAt: number): Promise<{
		h: ReturnType<typeof poolHarness>
		t0: number
		open: () => void
	}> {
		const { h, open: openA, t0 } = await breaking()
		expect(h.pool.reserveExternal(0.5)).toBeNull()
		h.clock.now = t0 + 4000
		await h.pool.releaseJob("identify-a")
		openA()
		await settle(h)
		expect(h.pool.status()).toHaveLength(0)
		await job(h, 2)
		const open = gate(h)
		h.clock.now = t0 + bAt
		const b = costlyIdentify("b")
		expect(h.pool.request(b)).toEqual({ deferred: "budget" })
		await flushAsync()
		expect(h.pool.slotFreeing(b)).toBe(true)
		return { h, t0, open }
	}

	it("chained identifies share one window: B's hold (from t0 + 4 s) ends at t0 + 8 s, not t0 + 12 s", async () => {
		const { h, t0, open } = await chained(4000)
		h.clock.now = t0 + IDENTIFY_PREEMPTION_HOLD_MS - 1
		expect(h.pool.reserveExternal(0.5)).toBeNull()
		h.clock.now = t0 + IDENTIFY_PREEMPTION_HOLD_MS
		const release = h.pool.reserveExternal(0.5)
		expect(release).not.toBeNull()
		release?.()
		open()
		h.pool.sealAdmission()
	})

	it.each([
		[IDENTIFY_PREEMPTION_HOLD_MS + 1000, true],
		[IDENTIFY_PREEMPTION_HOLD_MS + IDENTIFY_PREEMPTION_HOLD_GAP_MS - 1, true],
		[IDENTIFY_PREEMPTION_HOLD_MS + IDENTIFY_PREEMPTION_HOLD_GAP_MS, false],
	])(
		"after the window a hold-free gap: B preempting at t0 + %i ms leaves the recording admitted: %s",
		async (bAt, admitted) => {
			const { h, open } = await chained(bAt)
			const release = h.pool.reserveExternal(0.5)
			expect(release !== null).toBe(admitted)
			release?.()
			open()
			h.pool.sealAdmission()
		},
	)

	it("the hold is released when identify leaves the queue and when the pool is sealed", async () => {
		const h = await twoVictims()
		const open = gate(h)
		const req = identify()
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		await flushAsync()
		expect(h.pool.slotFreeing(req)).toBe(true)
		// Identify's job ends while its victim stops: the hold goes with it.
		await h.pool.releaseJob("identify")
		open()
		await settle(h)
		// 0.08 + 0.5 + 0.5 + 0.42 = 1.5 fits now that nothing holds identify's 0.5.
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
		expect(h.pool.status().map(p => p.jobId)).toHaveLength(1)
		h.pool.sealAdmission()
		expect(h.pool.reserveExternal(0.001)).toBeNull()
	})

	it("the hold bound is identify's slot-freeing wait; the gap makes it at most 8 s in any 16 s", () => {
		expect(IDENTIFY_PREEMPTION_HOLD_MS).toBe(IDENTIFY_SLOT_FREEING_MAX_MS)
		expect(IDENTIFY_PREEMPTION_HOLD_MS + IDENTIFY_PREEMPTION_HOLD_GAP_MS).toBe(
			16_000,
		)
	})
})
