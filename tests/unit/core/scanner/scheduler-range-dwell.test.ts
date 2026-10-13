import { describe, expect, it } from "vitest"
import { SweepScheduler } from "../../../../src/core/scanner/scheduler.js"
import type { SchedulerAction } from "../../../../src/core/scanner/scheduler.js"
import type { HopPlan } from "../../../../src/core/scanner/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

const FS = 2_048_000
const B = 102_400
const MHZ = 1_000_000
const noRevisit = { share: 0, maxIntervalMs: null }

function tune(
	hopIndex: number,
	centreHz: number,
	gainTenthsDb: number | null = 496,
): SchedulerAction {
	return { type: "tune", hopIndex, centreHz, gainTenthsDb }
}

function withDwell(plan: HopPlan, dwell: Array<number | undefined>): HopPlan {
	return {
		...plan,
		hops: plan.hops.map((hop, i) => {
			const dwellMs = dwell[i]
			return dwellMs === undefined ? hop : { ...hop, dwellMs }
		}),
	}
}

describe("SweepScheduler per-hop dwell", () => {
	it("dwells for the current hop's dwellMs, else the job dwell, and keeps the surface floor", () => {
		const centres = [400 * MHZ, 401.6 * MHZ, 403.2 * MHZ]
		const plan = withDwell(makeHopPlan(centres), [335, 40, undefined])
		const spec = makeNormalisedSpec({
			revisit: noRevisit,
			dwellMs: 185,
			settleMs: 35,
		})
		const s = new SweepScheduler(plan, spec, {
			blockSamples: B,
			sampleRateHz: FS,
			now: () => 0,
			probeStartMs: 300,
		})
		expect(s.start()).toEqual([tune(0, centres[0]!)])
		s.onEpochStarted(0)
		// 335 ms dwell is 6 blocks; the job dwell would have left at 3.
		expect(s.onBlock(5 * B)).toEqual([])
		expect(s.onBlock(6 * B)).toEqual([tune(1, centres[1]!)])
		// 40 ms is under the (minSurfaceBlocks + 1) floor, so this hop still takes 3 blocks.
		s.onEpochStarted(6 * B)
		expect(s.onBlock(6 * B + 2 * B)).toEqual([])
		expect(s.onBlock(6 * B + 3 * B)).toEqual([tune(2, centres[2]!)])
		// No hop dwell: the job's 185 ms, which is exactly 3 blocks.
		s.onEpochStarted(9 * B)
		expect(s.onBlock(9 * B + 2 * B)).toEqual([])
		expect(s.onBlock(9 * B + 3 * B)).toEqual([
			{ type: "sweep-complete", sweepIndex: 0 },
			tune(0, centres[0]!),
		])
	})

	it("keeps a re-plan at the hop boundary and uses the new hop dwell on the next visit", () => {
		const centres = [400 * MHZ, 401.6 * MHZ]
		const plan = withDwell(makeHopPlan(centres), [335, undefined])
		const spec = makeNormalisedSpec({
			revisit: noRevisit,
			dwellMs: 185,
			settleMs: 35,
		})
		const s = new SweepScheduler(plan, spec, {
			blockSamples: B,
			sampleRateHz: FS,
			now: () => 0,
			probeStartMs: 300,
		})
		s.start()
		s.onEpochStarted(0)
		const next = withDwell(makeHopPlan(centres), [40, 335])
		s.replan(next, spec)
		expect(s.progress().hopCount).toBe(2)
		expect(s.onBlock(5 * B)).toEqual([])
		expect(s.onBlock(6 * B)).toEqual([tune(1, centres[1]!)])
		s.onEpochStarted(6 * B)
		expect(s.onBlock(6 * B + 5 * B)).toEqual([])
		expect(s.onBlock(6 * B + 6 * B)).toEqual([
			{ type: "sweep-complete", sweepIndex: 0 },
			tune(0, centres[0]!),
		])
	})
})
