/**
 * ProbePool.slotFreeing: a queued request whose slot a stopping probe is about to free. Identify
 * keeps such a run queued past IDENTIFY_QUEUE_WAIT_MS instead of skipping it. Identify, job probes
 * and external reservations (recordings, analog trials) share one CPU budget.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { IDENTIFY_PROBE_PRIORITY } from "../../../../src/core/scanner/identify.js"
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
