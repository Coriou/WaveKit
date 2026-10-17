import { describe, expect, it } from "vitest"

import {
	checkBudgets,
	frameStats,
	percentile,
	slope,
	type Budgets,
	type ScenarioResult,
} from "../../perf/stats.ts"

describe("perf bench statistics", () => {
	it("counts frames, the p95 gap and missed vsyncs", () => {
		// 60 frames at 16.7 ms, then two frames 50 ms apart
		const stamps = Array.from({ length: 60 }, (_, i) => i * 16.7)
		stamps.push(59 * 16.7 + 50, 59 * 16.7 + 100)
		const s = frameStats(stamps, 1000)
		expect(s.fps).toBeCloseTo(62, 0)
		expect(s.jank).toBeCloseTo(2 / 61, 3)
		expect(s.p95FrameMs).toBeCloseTo(16.7, 1)
		expect(frameStats([], 1000)).toEqual({ fps: 0, p95FrameMs: 1000, jank: 1 })
	})

	it("takes nearest-rank percentiles and least-squares slopes", () => {
		expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
		expect(percentile([1, 2, 3, 4], 0.95)).toBe(4)
		expect(slope([10, 11, 12, 13])).toBeCloseTo(1)
		expect(slope([5, 5, 5])).toBe(0)
		expect(slope([5])).toBe(0)
	})

	it("lists every broken budget and nothing when all pass", () => {
		const budgets: Budgets = {
			scenarios: { a: { minFps: 50, maxBusy: 0.5, maxScript: 0.2 } },
			leak: {
				maxHeapSlopeMb: 0.5,
				maxHeapGrowthMb: 4,
				maxNodeGrowth: 100,
				maxListenerGrowth: 40,
			},
		}
		const ok: ScenarioResult = {
			name: "a",
			fps: 58,
			p95FrameMs: 17,
			jank: 0.02,
			busy: 0.3,
			script: 0.1,
			longTaskMsPerS: 0,
		}
		const leak = {
			cycles: 4,
			heapStartMb: 17,
			heapEndMb: 18,
			nodesStart: 1000,
			nodesEnd: 1010,
			listenersStart: 300,
			listenersEnd: 300,
			heapSlopeMb: 0.2,
		}
		expect(checkBudgets(budgets, [ok], leak)).toEqual([])
		const broken = checkBudgets(
			budgets,
			[
				{ ...ok, fps: 30, busy: 0.7 },
				{ ...ok, name: "unbudgeted", fps: 1 },
			],
			{ ...leak, nodesEnd: 1500, heapSlopeMb: 1 },
		)
		expect(broken).toHaveLength(4)
		expect(broken[0]).toContain("30.0 fps < 50")
	})
})
