import { EventEmitter } from "node:events"
import { performance } from "node:perf_hooks"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../src/core/source-manager.js"

import type { EfficiencySample } from "../../../src/decoders/enablement/contract.js"
import { createEfficiencyMonitor } from "../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../src/decoders/enablement/efficiency-gate.js"

/** Counters are keyed `<branch id>#<instance>`; tests look a branch up by id. */
const branch = <T>(
	totals: ReadonlyMap<string, T> | null | undefined,
	id: string,
): T | undefined => {
	for (const [key, value] of totals ?? [])
		if (key.slice(0, key.lastIndexOf("#")) === id) return value
	return undefined
}

function setup() {
	const sources = Object.assign(new EventEmitter(), {
		getAllStatus: () => [
			{ id: "a", connected: false },
			{ id: "b", connected: false },
		],
		getStatus: () => undefined,
		getCaps: () => undefined,
	})
	const logger = pino({ level: "silent" })
	const primary = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		primary,
		logger,
	)
	return { router, primary }
}

function counters(
	fanout: FanoutManager,
	id: string,
	bytes: number,
	chunks: number,
) {
	fanout.addBranch({ id })
	const original = fanout.getBranchTelemetry.bind(fanout)
	vi.spyOn(fanout, "getBranchTelemetry").mockImplementation(branchId => {
		const branch = original(branchId)
		return branch && branchId === id
			? { ...branch, droppedBytesTotal: bytes, droppedChunksTotal: chunks }
			: branch
	})
}

describe("source branch drop telemetry", () => {
	it("two branches' drops are summed per source", () => {
		const { router, primary } = setup()
		try {
			counters(primary, "one", 12, 2)
			counters(primary, "two", 30, 3)
			counters(router.getFanout("b"), "other", 100, 10)
			expect(router.branchDropTotals("a")).toBeNull()
			expect(router.branchDropTotals("a")).toEqual({
				droppedBytesTotal: 42,
				droppedChunksTotal: 5,
			})
			expect(router.branchDropTotals("b")).toBeNull()
			expect(router.branchDropTotals("b")).toEqual({
				droppedBytesTotal: 100,
				droppedChunksTotal: 10,
			})
		} finally {
			router.destroy()
			primary.destroy()
		}
	})

	it("channelizer input branch is included", () => {
		const { router, primary } = setup()
		try {
			counters(primary, "decoder", 5, 1)
			counters(primary, "channelizer:a", 9, 2)
			expect(router.branchDropTotals("a")).toBeNull()
			expect(router.branchDropTotals("a")).toEqual({
				droppedBytesTotal: 14,
				droppedChunksTotal: 3,
			})
		} finally {
			router.destroy()
			primary.destroy()
		}
	})

	it("absent fanout returns null without creating it; an empty fanout returns zero", () => {
		const { router, primary } = setup()
		try {
			const getFanout = vi.spyOn(router, "getFanout")
			expect(router.branchDropTotals("b")).toBeNull()
			expect(router.branchDropTotals("missing")).toBeNull()
			expect(getFanout).not.toHaveBeenCalled()
			expect(router.branchDropTotals("a")).toEqual({
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			})
			router.getFanout("b")
			expect(router.branchDropTotals("b")).toEqual({
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			})
			router.releaseUnused("b")
			expect(router.branchDropTotals("b")).toBeNull()
		} finally {
			router.destroy()
			primary.destroy()
		}
	})

	it("missing branch telemetry yields unknown rather than a partial sum", () => {
		const { router, primary } = setup()
		try {
			counters(primary, "one", 12, 2)
			primary.addBranch({ id: "unreadable" })
			const original = primary.getBranchTelemetry.bind(primary)
			vi.spyOn(primary, "getBranchTelemetry").mockImplementation(id =>
				id === "unreadable" ? undefined : original(id),
			)
			expect(router.branchDropTotals("a")).toBeNull()
			expect(router.branchDropTotals("a")).toBeNull()
		} finally {
			router.destroy()
			primary.destroy()
		}
	})

	it("bench (report-only): 64 branches read", () => {
		const { router, primary } = setup()
		try {
			// Use real telemetry reads: mocks would dominate this small read budget.
			for (let i = 0; i < 64; i++) primary.addBranch({ id: `branch-${i}` })
			const expected = {
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
				active: true,
			}
			for (let i = 0; i < 1000; i++) router.branchDropCounters("a")
			const timings: number[] = []
			for (let i = 0; i < 1001; i++) {
				const start = performance.now()
				const totals = router.branchDropCounters("a")
				timings.push(performance.now() - start)
				expect(totals?.size).toBe(64)
				expect(branch(totals, "branch-0")).toEqual(expected)
			}
			timings.sort((a, b) => a - b)
			console.info(
				`64 branches median: ${timings[500]} ms; design budget: 0.05 ms (report-only)`,
			)
		} finally {
			router.destroy()
			primary.destroy()
		}
	})
})

describe("branch topology evidence", () => {
	it.each(["a", "b"])(
		"offsetting removal drops are unknown on source %s and block the gate",
		sourceId => {
			const { router, primary } = setup()
			try {
				const fanout = router.getFanout(sourceId)
				counters(fanout, "one", 100, 1)
				counters(fanout, "two", 0, 0)

				let now = 0
				let tick = () => {}
				let last: EfficiencySample | undefined
				const monitor = createEfficiencyMonitor({
					sources: () => [sourceId],
					branchCounters: id => router.branchDropCounters(id),
					topology: id => router.branchTopology(id),
					monoNow: () => now,
					cpu: { normalisedPercent: 20 },
					now: () => now,
					setInterval: fn => {
						tick = fn
						return { cancel() {} }
					},
					onSample: sample => {
						last = sample
						gate.record(sample)
					},
				})
				const gate = createEfficiencyGate(
					{ budgetCores: 1.5, cpuGuardPercent: 90 },
					{ drops: monitor },
				)
				monitor.start()
				for (now = 0; now <= 64000; now += 2000) tick()
				expect(monitor.dropState(sourceId).state).toBe("ok")
				fanout.removeBranch("one")
				const original = fanout.getBranchTelemetry.bind(fanout)
				vi.spyOn(fanout, "getBranchTelemetry").mockImplementation(id => {
					const branch = original(id)
					return branch
						? { ...branch, droppedBytesTotal: 100, droppedChunksTotal: 1 }
						: branch
				})
				now = 66000
				tick()
				expect(last?.sources.get(sourceId)?.droppedBytesDelta).toBeNull()
				expect(
					gate.admit(
						{
							key: "new",
							sourceId,
							reach: "centre",
							costCores: 0.1,
							sampleRateHz: 2048000,
							decoderId: "new",
							channelHz: null,
							origin: "configured",
							primary: true,
						},
						[],
						now,
					).admit,
				).toBe(false)
				now = 68000
				tick()
				expect(last?.sources.get(sourceId)?.droppedBytesDelta).toBe(0)
				now = 70000
				tick()
				expect(last?.sources.get(sourceId)?.droppedBytesDelta).toBe(0)
			} finally {
				router.destroy()
				primary.destroy()
			}
		},
	)

	it.each(["same-id", "new-id"])(
		"addition %s invalidates the next read",
		id => {
			const { router, primary } = setup()
			try {
				counters(primary, "same-id", 100, 1)
				router.branchDropTotals("a")
				router.branchDropTotals("a")
				if (id === "same-id") primary.removeBranch(id)
				counters(primary, id, 100, 1)
				expect(router.branchDropTotals("a")).toBeNull()
				expect(router.branchDropTotals("a")).not.toBeNull()
			} finally {
				router.destroy()
				primary.destroy()
			}
		},
	)

	it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid individual counter %s",
		value => {
			for (const field of [
				"droppedBytesTotal",
				"droppedChunksTotal",
			] as const) {
				const { router, primary } = setup()
				try {
					counters(
						primary,
						"bad",
						field === "droppedBytesTotal" ? value : 0,
						field === "droppedChunksTotal" ? value : 0,
					)
					counters(primary, "offset", 10, 10)
					router.branchDropTotals("a")
					expect(router.branchDropTotals("a")).toBeNull()
				} finally {
					router.destroy()
					primary.destroy()
				}
			}
		},
	)

	it("rejects unsafe sums and forgets released topology listeners", () => {
		const { router, primary } = setup()
		try {
			counters(primary, "one", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
			counters(primary, "two", 1, 1)
			router.branchDropTotals("a")
			expect(router.branchDropTotals("a")).toBeNull()
			const secondary = router.getFanout("b")
			expect(secondary.listenerCount("branch-added")).toBe(1)
			router.releaseUnused("b")
			expect(secondary.listenerCount("branch-added")).toBe(0)
			router.destroy()
			expect(primary.listenerCount("branch-added")).toBe(0)
		} finally {
			router.destroy()
			primary.destroy()
		}
	})
})

it("topology signatures are stable reads and additions, and change for removal, same-id replacement and fanout recreation", () => {
	const { router, primary } = setup()
	try {
		expect(router.branchTopology("b")).toBeNull()
		const fanout = router.getFanout("b")
		fanout.addBranch({ id: "one" })
		const first = router.branchTopology("b")
		expect(router.branchTopology("b")).toBe(first)
		// An addition is visible in the counters; only removals change the epoch.
		fanout.addBranch({ id: "channelizer-b" })
		expect(router.branchTopology("b")).toBe(first)
		fanout.removeBranch("channelizer-b")
		const removed = router.branchTopology("b")
		expect(removed).not.toBe(first)
		// Same-id replacement is a removal.
		fanout.removeBranch("one")
		fanout.addBranch({ id: "one" })
		expect(router.branchTopology("b")).not.toBe(removed)
		fanout.removeBranch("one")
		const empty = router.branchTopology("b")
		router.releaseUnused("b")
		expect(router.branchTopology("b")).toBeNull()
		router.getFanout("b")
		expect(router.branchTopology("b")).not.toBe(empty)
	} finally {
		router.destroy()
		primary.destroy()
	}
})

it("per-branch snapshots are copied and preserve invalid entries", () => {
	const { router, primary } = setup()
	try {
		expect(router.branchDropCounters("missing")).toBeNull()
		counters(primary, "one", 100, 100)
		primary.addBranch({ id: "bad" })
		const original = primary.getBranchTelemetry.bind(primary)
		vi.spyOn(primary, "getBranchTelemetry").mockImplementation(id =>
			id === "bad" ? undefined : original(id),
		)
		const first = router.branchDropCounters("a")
		expect(branch(first, "one")).toEqual({
			droppedBytesTotal: 100,
			droppedChunksTotal: 100,
			active: true,
		})
		expect(branch(first, "bad")?.droppedBytesTotal).toBeNaN()
		const value = branch(first, "one")
		if (value) value.droppedBytesTotal = 0
		expect(
			branch(router.branchDropCounters("a"), "one")?.droppedBytesTotal,
		).toBe(100)
		// A removed and re-added id is a new branch identity.
		const key = [...(first?.keys() ?? [])].find(k => k.startsWith("one#"))
		primary.removeBranch("one")
		primary.addBranch({ id: "one" })
		const again = [...(router.branchDropCounters("a")?.keys() ?? [])].find(k =>
			k.startsWith("one#"),
		)
		expect(again).toBeDefined()
		expect(again).not.toBe(key)
	} finally {
		router.destroy()
		primary.destroy()
	}
})
