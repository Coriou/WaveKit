/**
 * ProbePool.slotFreeing: a queued request whose slot a stopping probe is about to free. Identify
 * keeps such a run queued past IDENTIFY_QUEUE_WAIT_MS instead of skipping it.
 */
import { describe, expect, it } from "vitest"
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
			priority: 101,
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
			h.pool.request(probeRequest({ jobId: "first", priority: 101 })),
		).toHaveProperty("started")
		await flushAsync()
		const req = probeRequest({ jobId: "second", priority: 101, trackId: "t2" })
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
			priority: 101,
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
		h.pool.request(probeRequest({ jobId: "first", priority: 101 }))
		await flushAsync()
		const req = probeRequest({ jobId: "second", priority: 101, trackId: "t2" })
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

describe("ProbePool: identify is not starved by external reservations", () => {
	// Budget arithmetic: one engine 0.08 + one offset probe 0.5 = 0.58.
	it("identify starts when only external reservations are over; new reservations still fit beside it; held ones stay", async () => {
		const h = poolHarness()
		const budget = h.settings.cpuBudgetCores
		const held = budget - 0.08 - 0.45
		const release = h.pool.reserveExternal(held)
		expect(release).not.toBeNull()
		const req = probeRequest({ jobId: "identify", priority: 101 })
		expect(h.pool.request(req)).toHaveProperty("started")
		await flushAsync()
		// Identify's 0.5 does not count for a reservation: engine 0.08 + held + 0.01 = budget - 0.44.
		const extra = h.pool.reserveExternal(0.01)
		expect(extra).not.toBeNull()
		expect(h.pool.externalCoresInUse()).toBeCloseTo(held + 0.01, 9)
		extra?.()
		release?.()
		expect(h.pool.externalCoresInUse()).toBe(0)
	})

	it("at the bound: engines + probes + the identify probe exactly fill the budget, it starts", () => {
		const settings = testSettings(s => {
			s.cpuBudgetCores = 0.58
		})
		const h = poolHarness({ settings })
		expect(h.pool.reserveExternal(0.3)).not.toBeNull()
		expect(
			h.pool.request(probeRequest({ jobId: "identify", priority: 101 })),
		).toHaveProperty("started")
	})

	it("past the bound: engines + probes leave no room for the identify probe, it waits on `budget`", () => {
		const settings = testSettings(s => {
			s.cpuBudgetCores = 0.57
		})
		const h = poolHarness({ settings })
		const req = probeRequest({ jobId: "identify", priority: 101 })
		expect(h.pool.request(req)).toEqual({ deferred: "budget" })
		expect(h.pool.queuedDeferral(req)).toMatchObject({ deferral: "budget" })
	})

	it("a job probe still counts external reservations", () => {
		const h = poolHarness()
		expect(
			h.pool.reserveExternal(h.settings.cpuBudgetCores - 0.08 - 0.45),
		).not.toBeNull()
		expect(h.pool.request(probeRequest({ priority: 100 }))).toEqual({
			deferred: "budget",
		})
	})
})

describe("ProbePool.reserveExternal: recordings do not wait on identify", () => {
	// Budget 1, one engine 0.08. E engines, J job probes, I identify probes, X reservations, B budget.
	const settings = (offsetSlots = 1): ReturnType<typeof testSettings> =>
		testSettings(s => {
			s.cpuBudgetCores = 1
			s.maxProbes.offset = offsetSlots
		})

	it("at the bound: with an identify probe running, E + X + new = 0.08 + 0.92 = 1 is admitted", async () => {
		const h = poolHarness({ settings: settings() })
		expect(
			h.pool.request(probeRequest({ jobId: "identify", priority: 101 })),
		).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.reserveExternal(0.92)).not.toBeNull()
		// Full estimate: 0.08 + 0.5 + 0.92 = 1.5 = B + I (the bounded overshoot).
		expect(h.pool.externalCoresInUse()).toBeCloseTo(0.92, 9)
	})

	it("past the bound: E + X + new = 0.08 + 0.93 > 1 is refused, identify running or not", async () => {
		const h = poolHarness({ settings: settings() })
		expect(h.pool.reserveExternal(0.93)).toBeNull()
		h.pool.request(probeRequest({ jobId: "identify", priority: 101 }))
		await flushAsync()
		expect(h.pool.reserveExternal(0.93)).toBeNull()
		expect(h.pool.reserveExternal(0.92)).not.toBeNull()
		// Now E + X = 1: one more core-thousandth is past it.
		expect(h.pool.reserveExternal(0.001)).toBeNull()
	})

	it("a job probe still counts for a reservation: E + J + new = 0.08 + 0.5 + 0.42 = 1 fits, 0.43 does not", async () => {
		const h = poolHarness({ settings: settings() })
		expect(
			h.pool.request(probeRequest({ jobId: "job", priority: 50 })),
		).toHaveProperty("started")
		await flushAsync()
		expect(h.pool.reserveExternal(0.43)).toBeNull()
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
	})

	it("a job probe still counts identify's cores and reservations: no room at E + I + X = 1.5", async () => {
		const h = poolHarness({ settings: settings(2) })
		h.pool.request(probeRequest({ jobId: "identify", priority: 101 }))
		await flushAsync()
		expect(h.pool.reserveExternal(0.42)).not.toBeNull()
		expect(
			h.pool.request(
				probeRequest({ jobId: "job", priority: 50, trackId: "t2" }),
			),
		).toEqual({ deferred: "budget" })
	})

	it("overshoot bound: two identify slots over full reservations stay at B + I = 1 + 2 x 0.5", async () => {
		// Identify admission: E + J + I + new <= B, so with E = 0.08 two 0.5-core probes do not fit B = 1;
		// at B = 1.08 they do (0.08 + 1 = 1.08), and reservations then fill E + X up to B again.
		const h = poolHarness({
			settings: testSettings(s => {
				s.cpuBudgetCores = 1.08
				s.maxProbes.offset = 2
			}),
		})
		h.pool.request(probeRequest({ jobId: "id1", priority: 101 }))
		h.pool.request(probeRequest({ jobId: "id2", priority: 101, trackId: "t2" }))
		await flushAsync()
		expect(h.pool.status()).toHaveLength(2)
		expect(h.pool.reserveExternal(1)).not.toBeNull()
		expect(h.pool.reserveExternal(0.001)).toBeNull()
		const total =
			0.08 +
			h.pool.status().reduce((sum, p) => sum + p.cores, 0) +
			h.pool.externalCoresInUse()
		// 0.08 + 1 + 1 = 2.08 = B + I, I = maxProbes.offset x 0.5.
		expect(total).toBeCloseTo(1.08 + 2 * 0.5, 9)
	})
})
