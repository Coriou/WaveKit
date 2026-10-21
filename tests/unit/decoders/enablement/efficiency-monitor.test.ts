import { describe, expect, it, vi } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { EFFICIENCY_SAMPLE_MS } from "../../../../src/decoders/enablement/contract.js"
import type {
	EfficiencySample,
	SourceDropSample,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"

const unknown: SourceDropSample = {
	droppedBytesDelta: null,
	droppedChunksDelta: null,
}
const zero: SourceDropSample = { droppedBytesDelta: 0, droppedChunksDelta: 0 }

function setup() {
	let ids = ["a", "b"]
	let cpu: number | null = 25
	let cpuThrows = false
	let tick: (() => void) | undefined
	let now = 1234
	const totals = new Map([
		["a", { droppedBytesTotal: 10, droppedChunksTotal: 2 }],
		["b", { droppedBytesTotal: 20, droppedChunksTotal: 4 }],
	])
	const sources = vi.fn(() => ids)
	const dropTotals = vi.fn((id: string) => totals.get(id) ?? null)
	const cancel = vi.fn()
	const setInterval = vi.fn((fn: () => void, _ms: number) => {
		tick = fn
		return { cancel }
	})
	const onSample = vi.fn<(sample: EfficiencySample) => void>()
	const monitor = createEfficiencyMonitor({
		sources,
		dropTotals,
		cpu: {
			get normalisedPercent() {
				if (cpuThrows) throw new TypeError("unreadable")
				return cpu
			},
		},
		now: () => {
			if (now === -999) throw new TypeError("clock")
			return now
		},
		setInterval,
		onSample,
	})
	return {
		monitor,
		totals,
		sources,
		dropTotals,
		cancel,
		setInterval,
		onSample,
		tick: () => tick?.(),
		setIds: (value: string[]) => {
			ids = value
		},
		setCpu: (value: number | null) => {
			cpu = value
		},
		throwCpu: (value: boolean) => {
			cpuThrows = value
		},
		setNow: (value: number) => {
			now = value
		},
	}
}

describe("efficiency monitor", () => {
	it("peeks stay unknown until a timer sample establishes a baseline", () => {
		const h = setup()
		expect(h.monitor.sampleNow()).toEqual({
			atMs: 1234,
			cpuPercent: 25,
			sources: new Map([
				["a", unknown],
				["b", unknown],
			]),
		})
		h.monitor.start()
		h.tick()
		h.totals.set("a", { droppedBytesTotal: 15, droppedChunksTotal: 3 })
		h.setNow(3234)
		const sample = h.monitor.sampleNow()
		expect(sample.atMs).toBe(3234)
		expect(sample.sources.get("a")).toEqual({
			droppedBytesDelta: 5,
			droppedChunksDelta: 1,
		})
		expect(sample.sources.get("b")).toEqual(zero)
	})

	it("throwing read yields unknown for that source only", () => {
		const h = setup()
		h.monitor.start()
		h.tick()
		h.dropTotals.mockImplementation(id => {
			if (id === "a") throw new TypeError("unreadable")
			return h.totals.get(id) ?? null
		})
		expect(h.monitor.sampleNow().sources).toEqual(
			new Map([
				["a", unknown],
				["b", zero],
			]),
		)
		h.dropTotals.mockImplementation(id => h.totals.get(id) ?? null)
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
		h.tick()
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(zero)
	})

	it.each(["droppedBytesTotal", "droppedChunksTotal"] as const)(
		"counter going backwards yields unknown",
		field => {
			const h = setup()
			h.monitor.start()
			h.tick()
			h.totals.set("a", {
				droppedBytesTotal: 10,
				droppedChunksTotal: 2,
				[field]: 1,
			})
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
			h.tick()
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(zero)
		},
	)

	it.each([
		null,
		NaN,
		Infinity,
		-1,
		"10",
		undefined,
		Number.MAX_SAFE_INTEGER + 1,
		0.5,
	])("invalid total %s invalidates and then re-baselines", value => {
		for (const field of ["droppedBytesTotal", "droppedChunksTotal"] as const) {
			const h = setup()
			h.monitor.start()
			h.tick()
			h.dropTotals.mockReturnValueOnce(
				value === null
					? null
					: ({
							droppedBytesTotal: 10,
							droppedChunksTotal: 2,
							[field]: value,
						} as unknown as {
							droppedBytesTotal: number
							droppedChunksTotal: number
						}),
			)
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
			h.tick()
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(zero)
		}
	})

	it("copies reused counter objects and accepts safe integer totals", () => {
		const h = setup()
		h.monitor.start()
		h.tick()
		const totals = h.totals.get("a")!
		totals.droppedBytesTotal = Number.MAX_SAFE_INTEGER
		totals.droppedChunksTotal = 3
		expect(h.monitor.sampleNow().sources.get("a")).toEqual({
			droppedBytesDelta: Number.MAX_SAFE_INTEGER - 10,
			droppedChunksDelta: 1,
		})
	})

	it("NaN cpu is null", () => {
		const h = setup()
		h.setCpu(NaN)
		expect(h.monitor.sampleNow().cpuPercent).toBeNull()
	})

	it.each([null, Infinity, -Infinity, -1, 101, "25"])(
		"invalid CPU %s is null",
		value => {
			const h = setup()
			h.setCpu(value as number | null)
			expect(h.monitor.sampleNow().cpuPercent).toBeNull()
		},
	)

	it.each([0, 100])("accepts CPU boundary %s", value => {
		const h = setup()
		h.setCpu(value)
		expect(h.monitor.sampleNow().cpuPercent).toBe(value)
	})

	it.each(["sources", "cpu"])(
		"throwing %s emits unknown known sources without crashing the timer",
		port => {
			const h = setup()
			h.monitor.start()
			h.tick()
			h.tick()
			if (port === "sources")
				h.sources.mockImplementation(() => {
					throw new TypeError("unreadable")
				})
			else h.throwCpu(true)
			expect(() => h.tick()).not.toThrow()
			const sample = h.onSample.mock.calls.at(-1)![0]
			expect(sample.sources).toEqual(
				new Map([
					["a", unknown],
					["b", unknown],
				]),
			)
			expect(sample.cpuPercent).toBeNull()
			const gate = createEfficiencyGate({
				budgetCores: 1.5,
				cpuGuardPercent: 90,
			})
			gate.record(sample)
			expect(
				gate
					.view([], [], sample.atMs)
					.sources.every(source => source.drops === "unknown"),
			).toBe(true)
			h.sources.mockImplementation(() => ["a", "b"])
			h.throwCpu(false)
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
			h.tick()
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(zero)
		},
	)

	it("removed sources lose their baselines and re-added sources start unknown", () => {
		const h = setup()
		h.monitor.start()
		h.tick()
		h.setIds(["b"])
		h.tick()
		expect(h.onSample.mock.calls.at(-1)![0].sources.has("a")).toBe(false)
		h.setIds(["a", "b"])
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
	})

	it("stop cancels the interval", () => {
		const h = setup()
		h.monitor.start()
		expect(h.setInterval).toHaveBeenCalledWith(
			expect.any(Function),
			EFFICIENCY_SAMPLE_MS,
		)
		h.monitor.stop()
		h.monitor.stop()
		expect(h.cancel).toHaveBeenCalledTimes(1)
	})

	it("start twice does not double the interval and can restart after stop", () => {
		const h = setup()
		h.monitor.start()
		h.monitor.start()
		expect(h.setInterval).toHaveBeenCalledTimes(1)
		h.monitor.stop()
		h.monitor.start()
		expect(h.setInterval).toHaveBeenCalledTimes(2)
	})

	it("onSample throwing does not stop the interval", () => {
		const h = setup()
		h.onSample.mockImplementation(() => {
			throw new TypeError("consumer failed")
		})
		h.monitor.start()
		expect(() => {
			h.tick()
			h.tick()
		}).not.toThrow()
		expect(h.onSample).toHaveBeenCalledTimes(2)
		expect(h.onSample.mock.calls[1]![0].sources.get("a")).toEqual(unknown)
	})
})

describe("efficiency evidence retention", () => {
	it.each([NaN, Infinity, -1, -999, 1000])(
		"retains drops across bad clock %s",
		clock => {
			const h = setup()
			h.monitor.start()
			h.tick()
			h.totals.set("a", { droppedBytesTotal: 110, droppedChunksTotal: 3 })
			h.dropTotals.mockClear()
			h.setNow(clock)
			expect(() => h.tick()).not.toThrow()
			expect(h.onSample).toHaveBeenCalledTimes(1)
			expect(h.dropTotals).not.toHaveBeenCalled()
			const bad = h.monitor.sampleNow()
			expect(bad.atMs).toBeNaN()
			expect(bad.sources.get("a")).toEqual(unknown)
			h.setNow(4000)
			h.tick()
			expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual({
				droppedBytesDelta: 100,
				droppedChunksDelta: 1,
			})
		},
	)

	it("retries undelivered drops and the gate sees them", () => {
		const h = setup()
		const gate = createEfficiencyGate({ budgetCores: 1.5, cpuGuardPercent: 90 })
		h.onSample.mockImplementation(sample => gate.record(sample))
		h.monitor.start()
		h.tick()
		h.totals.set("a", { droppedBytesTotal: 110, droppedChunksTotal: 3 })
		h.onSample.mockImplementationOnce(() => {
			throw new TypeError("delivery")
		})
		h.setNow(3000)
		h.tick()
		h.setNow(5000)
		h.tick()
		expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual({
			droppedBytesDelta: 100,
			droppedChunksDelta: 1,
		})
		expect(
			gate.view([], [], 5000).sources.find(s => s.sourceId === "a")?.drops,
		).toBe("dropping")
	})

	it.each([
		{},
		"a",
		["a", 2],
		[""],
		{
			[Symbol.iterator]: function* () {
				yield "a"
				throw new TypeError("iterator")
			},
		},
	])("invalid source enumeration clears baselines", value => {
		const h = setup()
		h.monitor.start()
		h.tick()
		h.sources.mockReturnValueOnce(value as unknown as string[])
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
		h.tick()
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(zero)
	})

	it("deduplicates source ids", () => {
		const h = setup()
		h.setIds(["a", "a"])
		h.monitor.start()
		h.tick()
		expect(h.dropTotals).toHaveBeenCalledTimes(1)
	})
})

describe("undelivered uncertainty", () => {
	it("keeps a consumed unknown read unknown until delivery succeeds", () => {
		const h = setup()
		h.monitor.start()
		h.tick()
		h.tick()
		h.dropTotals.mockReturnValueOnce(null)
		h.onSample.mockImplementationOnce(() => {
			throw new TypeError("delivery")
		})
		h.tick()
		h.tick()
		expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual(unknown)
		h.tick()
		expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual(zero)
	})
})

describe("peek evidence retention", () => {
	const placement = {
		key: "decoder#raw@a",
		decoderId: "decoder",
		sourceId: "a",
		channelHz: null,
		reach: "raw" as const,
		origin: "band" as const,
		primary: true,
		costCores: 0.1,
		sampleRateHz: 2400000,
	}

	it("delivers drops observed by a peek to the gate", () => {
		const h = setup()
		const gate = createEfficiencyGate({ budgetCores: 1.5, cpuGuardPercent: 90 })
		h.onSample.mockImplementation(sample => gate.record(sample))
		h.monitor.start()
		h.tick()
		h.totals.set("a", { droppedBytesTotal: 110, droppedChunksTotal: 3 })
		const drops = { droppedBytesDelta: 100, droppedChunksDelta: 1 }
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(drops)
		expect(h.monitor.sampleNow().sources.get("a")).toEqual(drops)
		expect(h.onSample).toHaveBeenCalledTimes(1)
		expect(
			gate.view([], [], 1234).sources.find(s => s.sourceId === "a")?.drops,
		).toBe("unknown")
		expect(gate.admit(placement, [], 1234).admit).toBe(false)
		h.setNow(3234)
		h.tick()
		expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual(drops)
		expect(
			gate.view([], [], 3234).sources.find(s => s.sourceId === "a")?.drops,
		).toBe("dropping")
		gate.forget(placement.key)
		expect(gate.admit(placement, [], 3234)).toMatchObject({
			admit: false,
			detail: "drops",
		})
	})

	it.each(["failed delivery", "peek"] as const)(
		"retains a consumed topology flag across %s until unknown delivery",
		interleaving => {
			const h = setup()
			const gate = createEfficiencyGate({
				budgetCores: 1.5,
				cpuGuardPercent: 90,
			})
			h.onSample.mockImplementation(sample => gate.record(sample))
			h.monitor.start()
			h.tick()
			// Like the router, this provider consumes its topology flag on any read.
			h.dropTotals.mockReturnValueOnce(null)
			if (interleaving === "failed delivery") {
				h.onSample.mockImplementationOnce(() => {
					throw new TypeError("delivery")
				})
				h.tick()
			}
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(unknown)
			expect(
				gate.view([], [], 1234).sources.find(s => s.sourceId === "a")?.drops,
			).toBe("unknown")
			expect(gate.admit(placement, [], 1234).admit).toBe(false)
			h.setNow(3234)
			h.tick()
			expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual(unknown)
			expect(
				gate.view([], [], 3234).sources.find(s => s.sourceId === "a")?.drops,
			).toBe("unknown")
			gate.forget(placement.key)
			expect(gate.admit(placement, [], 3234)).toMatchObject({
				admit: false,
				detail: "unknown",
			})
			expect(h.monitor.sampleNow().sources.get("a")).toEqual(zero)
			h.tick()
			expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual(zero)
		},
	)

	it.each(["counter reset", "topology change"] as const)(
		"a drop seen by a peek still reaches the gate after a %s",
		change => {
			const h = setup()
			const gate = createEfficiencyGate({
				budgetCores: 1.5,
				cpuGuardPercent: 90,
			})
			h.onSample.mockImplementation(sample => gate.record(sample))
			h.monitor.start()
			h.tick()
			h.totals.set("a", { droppedBytesTotal: 110, droppedChunksTotal: 3 })
			expect(h.monitor.sampleNow().sources.get("a")).toEqual({
				droppedBytesDelta: 100,
				droppedChunksDelta: 1,
			})
			if (change === "counter reset")
				h.totals.set("a", { droppedBytesTotal: 10, droppedChunksTotal: 2 })
			else h.dropTotals.mockReturnValueOnce(null)
			h.setNow(3234)
			h.tick()
			// A reset back to the committed totals reads as a clean delta, so the held
			// drop is merged in; an unreadable read keeps one counter null (unknown).
			expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual({
				droppedBytesDelta: 100,
				droppedChunksDelta: change === "counter reset" ? 1 : null,
			})
			expect(
				gate.view([], [], 3234).sources.find(s => s.sourceId === "a")?.drops,
			).toBe(change === "counter reset" ? "dropping" : "unknown")
			// Fresh clean ticks: the held drop still enforces the clear window.
			for (let t = 5234; t <= 13234; t += 2000) {
				h.setNow(t)
				h.tick()
			}
			expect(
				gate.view([], [], 13234).sources.find(s => s.sourceId === "a")?.drops,
			).toBe("dropping")
			expect(gate.admit(placement, [], 13234).admit).toBe(false)
		},
	)

	it("prunes held evidence of removed sources", () => {
		const h = setup()
		h.monitor.start()
		h.tick()
		h.dropTotals.mockReturnValueOnce(null)
		h.totals.set("b", { droppedBytesTotal: 30, droppedChunksTotal: 5 })
		h.monitor.sampleNow()
		h.setIds(["b"])
		h.setNow(3234)
		h.tick()
		h.setIds(["a", "b"])
		h.setNow(5234)
		h.tick()
		h.setNow(7234)
		h.tick()
		// "a" re-added: one re-baseline tick, then clean; no stale held state.
		expect(h.onSample.mock.calls.at(-1)![0].sources.get("a")).toEqual(zero)
		expect(h.onSample.mock.calls.at(-1)![0].sources.get("b")).toEqual(zero)
	})
})
