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
	it("identify starts when only external reservations are over; new reservations yield; held ones stay", async () => {
		const h = poolHarness()
		const budget = h.settings.cpuBudgetCores
		const held = budget - 0.08 - 0.45
		const release = h.pool.reserveExternal(held)
		expect(release).not.toBeNull()
		const req = probeRequest({ jobId: "identify", priority: 101 })
		expect(h.pool.request(req)).toHaveProperty("started")
		await flushAsync()
		// Engine + probe + held = budget + 0.05: over, so a new recording is refused.
		expect(h.pool.reserveExternal(0.01)).toBeNull()
		expect(h.pool.externalCoresInUse()).toBeCloseTo(held, 9)
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
