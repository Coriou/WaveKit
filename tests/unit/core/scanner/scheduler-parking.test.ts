// tests/unit/core/scanner/scheduler-parking.test.ts
/**
 * Scanner redesign R 1.1, 1.3, 1.4: a one-hop plan tunes once and parks; parked dwells count
 * sweeps from received samples; a multi-hop sweep never re-tunes the window it is on.
 * Injected clock and sample counts only.
 */
import { describe, expect, it } from "vitest"
import { SweepScheduler } from "../../../../src/core/scanner/scheduler.js"
import type { SchedulerAction } from "../../../../src/core/scanner/scheduler.js"
import type {
	HopPlan,
	NormalisedJobSpec,
} from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const FS = 2_048_000
const B = 102_400 // 50 ms blocks
const MHZ = 1_000_000
const A = 446_100_000
const noRevisit = { share: 0, maxIntervalMs: null }

function harness(plan: HopPlan, spec: NormalisedJobSpec) {
	const h = {
		clock: 0,
		sample: 0,
		all: [] as SchedulerAction[],
		s: null as unknown as SweepScheduler,
		/** One 50 ms block: the clock follows the samples. */
		block(advanceClock = true): SchedulerAction[] {
			h.sample += B
			if (advanceClock) h.clock += 50
			const out = [...h.s.tick(h.clock), ...h.s.onBlock(h.sample)]
			h.all.push(...out)
			return out
		},
		/** Blocks until the scheduler returns actions (a dwell end) or `max` blocks pass. */
		untilActions(max = 200, advanceClock = true): SchedulerAction[] {
			for (let i = 0; i < max; i++) {
				const out = h.block(advanceClock)
				if (out.length > 0) return out
			}
			return []
		},
		settle(): SchedulerAction[] {
			const out = h.s.onEpochStarted(h.sample)
			h.all.push(...out)
			return out
		},
		tunes: () => h.all.filter(a => a.type === "tune"),
		sweeps: () => h.all.filter(a => a.type === "sweep-complete"),
	}
	h.s = new SweepScheduler(plan, spec, {
		blockSamples: B,
		sampleRateHz: FS,
		now: () => h.clock,
		probeStartMs: 300,
	})
	return h
}

const track = (id: string, centreHz = A, snrDb = 20): TrackSnapshot => ({
	...makeTrack({ id, centreHz, startedAt: 0, snrDb }),
	trackId: id,
})

function parked(spec: Partial<NormalisedJobSpec> = {}, centre = A) {
	const h = harness(
		makeHopPlan([centre]),
		makeNormalisedSpec({ revisit: noRevisit, dwellMs: 200, ...spec }),
	)
	h.all.push(...h.s.start())
	h.settle()
	return h
}

describe("SweepScheduler parking (R 1.1, 1.3)", () => {
	it("a one-hop plan emits exactly one tune action over 20 dwells", () => {
		const h = parked()
		for (let i = 0; i < 20; i++) h.untilActions()
		expect(h.tunes()).toEqual([
			{ type: "tune", hopIndex: 0, centreHz: A, gainTenthsDb: 496 },
		])
		expect(h.sweeps()).toHaveLength(20)
		expect(h.s.parked).toBe(true)
	})

	it("counts sample dwells during a hold even when the clock stands still", () => {
		const h = parked({ dwellMs: 1_000 })
		h.s.onTrack(track("t1"), true, 1_000)
		for (let i = 0; i < 20; i++) h.block(false)
		expect(h.sweeps()).toHaveLength(1)
		expect(h.s.progress().holdingOn).toBe("t1")
		expect(h.s.onConfirmed("t1", false)).toEqual([{ type: "stop-probes" }])
		for (let i = 0; i < 19; i++) h.block(false)
		expect(h.sweeps()).toHaveLength(1)
		h.block(false)
		expect(h.sweeps()).toHaveLength(2)
		expect(h.tunes()).toHaveLength(1)
	})

	it("a ten-minute pause and skipped resume count only new sample dwells", () => {
		const h = parked({
			dwellMs: 1_000,
			stop: { afterSweeps: 3, afterMs: null, onFirstDecoded: false },
		})
		for (let i = 0; i < 19; i++) h.block()
		h.clock += 600_000
		h.sample += 600 * FS
		expect(h.s.onTuneSkipped()).toEqual([])
		for (let dwell = 0; dwell < 3; dwell++) {
			for (let i = 0; i < 19; i++) {
				h.block()
				expect(h.sweeps()).toHaveLength(dwell)
			}
			expect(h.block().filter(a => a.type === "sweep-complete")).toHaveLength(1)
			expect(h.sweeps()).toHaveLength(dwell + 1)
		}
	})

	it.each([false, true])(
		"a ten-second data stall excludes missing samples (sample hole: %s)",
		hole => {
			const h = parked({ dwellMs: 1_000 })
			for (let i = 0; i < 10; i++) h.block()
			h.clock += 10_000
			if (hole) h.sample += 10 * FS
			for (let i = 0; i < 9; i++) {
				h.block()
				expect(h.sweeps()).toHaveLength(0)
			}
			expect(h.block().filter(a => a.type === "sweep-complete")).toHaveLength(1)
			for (let i = 0; i < 19; i++) h.block()
			expect(h.sweeps()).toHaveLength(1)
			h.block()
			expect(h.sweeps()).toHaveLength(2)
		},
	)

	it("a multi-hop skipped resume dwells on the current hop before leaving", () => {
		const h = harness(
			makeHopPlan([A, A + 3 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit, dwellMs: 1_000 }),
		)
		h.s.start()
		h.settle()
		h.block()
		h.clock += 600_000
		h.sample += 600 * FS
		expect(h.s.onTuneSkipped()).toEqual([])
		for (let i = 0; i < 19; i++) expect(h.block()).toEqual([])
		expect(h.s.progress().hopIndex).toBe(0)
		expect(h.block()).toContainEqual({
			type: "tune",
			hopIndex: 1,
			centreHz: A + 3 * MHZ,
			gainTenthsDb: 496,
		})
	})

	it("sweepPeriodMs null and parked true after the first settle", () => {
		const h = harness(
			makeHopPlan([A]),
			makeNormalisedSpec({ revisit: noRevisit, dwellMs: 200 }),
		)
		h.s.start()
		expect(h.s.parked).toBe(false)
		h.settle()
		expect(h.s.parked).toBe(true)
		for (let i = 0; i < 5; i++) h.untilActions()
		expect(h.s.progress()).toEqual({
			sweepIndex: 5,
			hopIndex: 0,
			hopCount: 1,
			sweepPeriodMs: null,
			holdingOn: null,
			coverage: 1,
		})
	})

	it("a hold while parked ends without a tune action", () => {
		const h = parked()
		h.s.onTrack(track("t1"), true, 1_000)
		expect(h.untilActions()).toContainEqual({
			type: "start-probe",
			trackId: "t1",
			holdMs: 1_300,
		})
		expect(h.s.progress().holdingOn).toBe("t1")
		let end: SchedulerAction[] = []
		for (let i = 0; i < 40 && !end.some(a => a.type === "stop-probes"); i++)
			end = h.block()
		expect(end).toContainEqual({ type: "stop-probes" })
		expect(end.some(a => a.type === "tune")).toBe(false)
		expect(h.s.progress().holdingOn).toBeNull()
		// the open, already tried track is not probed again on the next parked window
		expect(h.untilActions()).toEqual([
			{ type: "sweep-complete", sweepIndex: h.s.progress().sweepIndex - 1 },
		])
		expect(h.tunes()).toHaveLength(1)
	})

	it("afterSweeps 3 stops after 3 dwells", () => {
		const h = parked({
			stop: { afterSweeps: 3, afterMs: null, onFirstDecoded: false },
		})
		// the job runner's rule: stop when sweepIndex + 1 >= afterSweeps
		let stoppedAtDwell: number | null = null
		for (let dwell = 1; dwell <= 5 && stoppedAtDwell === null; dwell++)
			for (const a of h.untilActions())
				if (a.type === "sweep-complete" && a.sweepIndex + 1 >= 3)
					stoppedAtDwell = dwell
		expect(stoppedAtDwell).toBe(3)
		expect(h.tunes()).toHaveLength(1)
	})

	it("replan keeping the centre stays parked", () => {
		const h = parked()
		h.s.onTrack(track("t1"), true, 1_000)
		h.untilActions() // start-probe: a hold is open
		const edited = makeNormalisedSpec({
			revisit: noRevisit,
			dwellMs: 200,
			signalsOnly: false,
		})
		expect(h.s.replan(makeHopPlan([A], 900_000), edited)).toEqual([])
		expect(h.s.parked).toBe(true)
		expect(h.s.progress().holdingOn).toBe("t1")
		for (let i = 0; i < 4; i++) h.untilActions()
		expect(h.tunes()).toHaveLength(1)
	})

	it("replan to a new centre leaves the park with one tune", () => {
		const h = parked()
		h.s.onTrack(track("t1"), true, 1_000)
		h.untilActions() // start-probe: a hold is open
		const B2 = A + 3 * MHZ
		const out = h.s.replan(
			makeHopPlan([B2]),
			makeNormalisedSpec({ revisit: noRevisit, dwellMs: 200 }),
		)
		// the hold ends and exactly one tune follows
		expect(out).toEqual([
			{ type: "stop-probes" },
			{ type: "tune", hopIndex: 0, centreHz: B2, gainTenthsDb: 496 },
		])
		expect(h.s.parked).toBe(false)
		expect(h.s.progress().holdingOn).toBeNull()
		h.all.push(...out)
		// the new centre settles and parks again; no further tune
		h.settle()
		expect(h.s.parked).toBe(true)
		for (let i = 0; i < 5; i++) h.untilActions()
		expect(h.tunes().map(t => t.type === "tune" && t.centreHz)).toEqual([A, B2])
	})

	it("a gain or rate change in a one-hop replan re-tunes once", () => {
		const h = parked()
		const out = h.s.replan(
			makeHopPlan([A]),
			makeNormalisedSpec({
				revisit: noRevisit,
				dwellMs: 200,
				tuner: {
					sampleRateHz: null,
					gainTenthsDb: 300,
					agc: false,
					overload: "flag",
				},
			}),
		)
		expect(out).toEqual([
			{ type: "tune", hopIndex: 0, centreHz: A, gainTenthsDb: 300 },
		])
	})

	it("a plan becoming multi-hop leaves the park at the hop boundary", () => {
		const h = parked()
		const B2 = A + 3 * MHZ
		expect(
			h.s.replan(
				makeHopPlan([A, B2]),
				makeNormalisedSpec({ revisit: noRevisit, dwellMs: 200 }),
			),
		).toEqual([])
		expect(h.s.parked).toBe(false)
		const out = h.untilActions()
		expect(out.filter(a => a.type === "tune")).toEqual([
			{ type: "tune", hopIndex: 1, centreHz: B2, gainTenthsDb: 496 },
		])
		expect(h.s.progress().hopCount).toBe(2)
	})

	it("a re-sent window (reconnect) keeps the park and does not catch up missed sweeps", () => {
		const h = parked()
		h.untilActions()
		expect(h.sweeps()).toHaveLength(1)
		h.clock += 60_000 // down for a minute
		h.sample = 0
		expect(h.settle()).toEqual([])
		expect(h.s.parked).toBe(true)
		h.untilActions()
		expect(h.sweeps()).toHaveLength(2)
	})
})

describe("SweepScheduler multi-hop same-hop rule (R 1.4)", () => {
	it("multi-hop: a revisit picking the current hop extends dwellEnd and emits no tune", () => {
		// hops 0 and 2 share a centre: moving between them is staying on the window being visited
		const h = harness(
			makeHopPlan([A, A + 2 * MHZ, A]),
			makeNormalisedSpec({
				revisit: { share: 1, maxIntervalMs: null },
				dwellMs: 200,
			}),
		)
		const visitOf = () =>
			(h.s as unknown as { visit: { hopIndex: number; revisit: boolean } })
				.visit
		let visiting = A
		let pending = h.s.start()
		const continued: { from: number; to: number; revisit: boolean }[] = []
		for (let i = 0; i < 400; i++) {
			if (pending.some(a => a.type === "tune")) h.settle()
			const before = visitOf().hopIndex
			if (h.s.progress().holdingOn === null)
				h.s.onTrack(track(`t${i}`, visiting), false, 0)
			pending = h.block()
			for (const a of pending)
				if (a.type === "tune") {
					// R 1.4: never a tune to the window being visited
					expect(a.centreHz).not.toBe(visiting)
					visiting = a.centreHz
				}
			const after = visitOf()
			if (after.hopIndex !== before && !pending.some(a => a.type === "tune"))
				continued.push({
					from: before,
					to: after.hopIndex,
					revisit: after.revisit,
				})
		}
		// every continuation is between the twins, and both a revisit and the coarse order did it
		expect(continued.length).toBeGreaterThan(0)
		for (const c of continued) {
			expect([0, 2]).toContain(c.from)
			expect([0, 2]).toContain(c.to)
		}
		expect(continued.some(c => c.revisit)).toBe(true)
		expect(continued.some(c => !c.revisit)).toBe(true)
	})

	it("an extended visit keeps its open tracks and dwells a full dwellMs more", () => {
		const h = harness(
			makeHopPlan([A, A]),
			makeNormalisedSpec({ revisit: noRevisit, dwellMs: 200 }),
		)
		h.all.push(...h.s.start())
		h.settle()
		h.s.onTrack(track("t1"), true, 1_000)
		h.s.onConfirmed("t1", false) // not holding: ignored
		const first = h.untilActions()
		expect(first).toEqual([
			{ type: "start-probe", trackId: "t1", holdMs: 1_300 },
		])
		// confirmed without follow: leave to hop 1, which is the same centre: no tune
		const leave = h.s.onConfirmed("t1", false)
		expect(leave).toEqual([{ type: "stop-probes" }])
		expect(h.s.progress().hopIndex).toBe(1)
		// 200 ms at 2.048 Msps = 4 blocks of 50 ms; t1 stays known (tried): no second probe
		const before = h.sample
		const next = h.untilActions()
		expect(h.sample - before).toBe(4 * B)
		expect(next.filter(a => a.type === "start-probe")).toEqual([])
		expect(h.tunes()).toHaveLength(1)
	})
})
