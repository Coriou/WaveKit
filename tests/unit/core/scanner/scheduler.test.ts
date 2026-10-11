// tests/unit/core/scanner/scheduler.test.ts
import fc from "fast-check"
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

function harness(plan: HopPlan, spec: NormalisedJobSpec, probeStartMs = 300) {
	const h = {
		clock: 0,
		sample: 0,
		s: null as unknown as SweepScheduler,
		/** Settles the current epoch (unless the caller already did) and runs blocks until an action list is returned. */
		dwell(blocks = 3, newEpoch = true): SchedulerAction[] {
			if (newEpoch) h.s.onEpochStarted(h.sample)
			let actions: SchedulerAction[] = []
			for (let i = 0; i < blocks && actions.length === 0; i++) {
				h.sample += B
				actions = h.s.onBlock(h.sample)
			}
			return actions
		},
	}
	h.s = new SweepScheduler(plan, spec, {
		blockSamples: B,
		sampleRateHz: FS,
		now: () => h.clock,
		probeStartMs,
	})
	return h
}

const track = (id: string, snrDb = 20, truncated = false): TrackSnapshot => ({
	...makeTrack({ id, centreHz: 400 * MHZ, startedAt: 0, snrDb, truncated }),
	trackId: id,
})
const tune = (
	hopIndex: number,
	centreHz: number,
	gainTenthsDb: number | null = 496,
): SchedulerAction => ({ type: "tune", hopIndex, centreHz, gainTenthsDb })
const noRevisit = { share: 0, maxIntervalMs: null }

describe("SweepScheduler dwell", () => {
	it("dwells (minSurfaceBlocks + 1) blocks in samples from the settled epoch start", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ, 403.2 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		expect(h.s.start()).toEqual([tune(0, 400 * MHZ)])
		expect(h.s.onBlock(5 * B)).toEqual([]) // before the epoch started: ignored
		h.s.onEpochStarted(10_000)
		expect(h.s.onBlock(10_000 + 2 * B)).toEqual([])
		expect(h.s.onBlock(10_000 + 3 * B)).toEqual([tune(1, 401.6 * MHZ)])
	})

	it("extends the dwell by every stale block and honours a longer operator dwell", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onStale(1)
		expect(h.s.onBlock(3 * B)).toEqual([])
		expect(h.s.onBlock(4 * B)).toEqual([tune(1, 401.6 * MHZ)])

		const long = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit, dwellMs: 335, settleMs: 35 }),
		)
		long.s.start()
		long.s.onEpochStarted(0)
		expect(long.s.onBlock(5 * B)).toEqual([])
		expect(long.s.onBlock(6 * B)).toEqual([tune(1, 401.6 * MHZ)])
	})

	it("restarts the dwell when a new epoch starts at sample 0 mid-dwell (source down and up)", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.s.onEpochStarted(1_000_000)
		h.s.onTrack(track("t1"), true, 1_800)
		expect(h.s.onBlock(1_000_000 + B)).toEqual([])
		// the new stream counts from 0; the old dwellEnd (1_000_000 + 3 B) would hold this hop for minutes
		expect(h.s.onEpochStarted(0)).toEqual([])
		expect(h.s.onBlock(B)).toEqual([])
		expect(h.s.onBlock(2 * B)).toEqual([])
		// t1 belonged to the old epoch: no probe, just the next hop
		expect(h.s.onBlock(3 * B)).toEqual([tune(1, 401.6 * MHZ)])
	})

	it("restarts the dwell on resume after the old dwellEnd has passed (restartVisit)", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onBlock(B)
		// paused: no blocks fed while the stream runs on to 50 B; resume re-sends the hop
		expect(h.s.restartVisit(50 * B)).toEqual([])
		expect(h.s.onBlock(51 * B)).toEqual([]) // the old dwellEnd (3 B) would decide here
		expect(h.s.onBlock(52 * B)).toEqual([])
		expect(h.s.onBlock(53 * B)).toEqual([tune(1, 401.6 * MHZ)])
		// idle schedulers ignore it
		const idle = harness(
			makeHopPlan([400 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		expect(idle.s.restartVisit(0)).toEqual([])
		expect(idle.s.progress().hopIndex).toBe(0)
	})

	it("reports sweep completion, coverage and the sweep period", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ, 403.2 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.dwell()
		expect(h.s.progress().coverage).toBeCloseTo(1 / 3)
		h.clock = 500
		h.dwell()
		h.clock = 900
		expect(h.dwell()).toEqual([
			{ type: "sweep-complete", sweepIndex: 0 },
			tune(0, 400 * MHZ),
		])
		expect(h.s.progress()).toEqual({
			sweepIndex: 1,
			hopIndex: 0,
			hopCount: 3,
			sweepPeriodMs: 900,
			holdingOn: null,
			coverage: 1,
		})
	})
})

describe("SweepScheduler holds", () => {
	it("holds for confirmHoldMs + probe start latency, then moves on", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onTrack(track("t1"), true, 1_800)
		h.sample = 2 * B
		h.s.onBlock(h.sample)
		expect(h.s.onBlock(3 * B)).toEqual([
			{ type: "start-probe", trackId: "t1", holdMs: 2_100 },
		])
		expect(h.s.progress().holdingOn).toBe("t1")
		h.clock = 2_099
		expect(h.s.tick(h.clock)).toEqual([])
		h.clock = 2_100
		expect(h.s.tick(h.clock)).toEqual([
			{ type: "stop-probes" },
			tune(1, 401.6 * MHZ),
		])
	})

	it("never probes with policy never or for truncated tracks", () => {
		const never = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({
				revisit: noRevisit,
				hold: {
					policy: "never",
					confirmHoldMs: {},
					maxHoldMs: 60_000,
					hangMs: 2_000,
				},
			}),
		)
		never.s.start()
		never.s.onEpochStarted(0)
		never.s.onTrack(track("t1"), true, 1_800)
		never.s.onBlock(B)
		never.s.onBlock(2 * B)
		expect(never.s.onBlock(3 * B)).toEqual([tune(1, 401.6 * MHZ)])

		const cut = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		cut.s.start()
		cut.s.onEpochStarted(0)
		cut.s.onTrack(track("t1", 30, true), true, 1_800)
		cut.s.onBlock(B)
		cut.s.onBlock(2 * B)
		expect(cut.s.onBlock(3 * B)).toEqual([tune(1, 401.6 * MHZ)])
	})

	it("drops a track that becomes truncated, an IQ image or a spur after a clean first snapshot", () => {
		const imageOf = (t: TrackSnapshot): TrackSnapshot => ({
			...t,
			flags: { ...t.flags, iqImage: true },
		})
		const spurOf = (t: TrackSnapshot): TrackSnapshot => ({
			...t,
			flags: { ...t.flags, spur: true },
		})
		const queued = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		queued.s.start()
		queued.s.onEpochStarted(0)
		queued.s.onTrack(track("t1"), true, 1_800)
		queued.s.onTrack(track("t1", 20, true), true, 1_800) // later update: truncated (sticky from here on)
		queued.s.onBlock(B)
		queued.s.onBlock(2 * B)
		expect(queued.s.onBlock(3 * B)).toEqual([tune(1, 401.6 * MHZ)])

		const held = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		held.s.start()
		held.s.onEpochStarted(0)
		held.s.onTrack(track("t1"), true, 1_800)
		held.s.onTrack(track("t2", 10), true, 1_000)
		held.s.onBlock(B)
		held.s.onBlock(2 * B)
		expect(held.s.onBlock(3 * B)).toEqual([
			{ type: "start-probe", trackId: "t1", holdMs: 2_100 },
		])
		// the held track flips to an image: its probe stops and the next queued track gets one
		expect(held.s.onTrack(imageOf(track("t1")), true, 1_800)).toEqual([
			{ type: "stop-probes" },
			{ type: "start-probe", trackId: "t2", holdMs: 1_300 },
		])
		expect(held.s.onTrack(imageOf(track("t2", 10)), true, 1_000)).toEqual([
			{ type: "stop-probes" },
			tune(1, 401.6 * MHZ),
		])

		// a comb tooth promoted to a spur (Task 7a's late sticky flag): never probed when queued, cut when held
		const spurQueued = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		spurQueued.s.start()
		spurQueued.s.onEpochStarted(0)
		spurQueued.s.onTrack(track("t1"), true, 1_800)
		spurQueued.s.onTrack(spurOf(track("t1")), true, 1_800)
		spurQueued.s.onBlock(B)
		spurQueued.s.onBlock(2 * B)
		expect(spurQueued.s.onBlock(3 * B)).toEqual([tune(1, 401.6 * MHZ)])

		const spurHeld = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		spurHeld.s.start()
		spurHeld.s.onEpochStarted(0)
		spurHeld.s.onTrack(track("t1"), true, 1_800)
		spurHeld.s.onTrack(track("t2", 10), true, 1_000)
		spurHeld.s.onBlock(B)
		spurHeld.s.onBlock(2 * B)
		expect(spurHeld.s.onBlock(3 * B)).toEqual([
			{ type: "start-probe", trackId: "t1", holdMs: 2_100 },
		])
		expect(spurHeld.s.onTrack(spurOf(track("t1")), true, 1_800)).toEqual([
			{ type: "stop-probes" },
			{ type: "start-probe", trackId: "t2", holdMs: 1_300 },
		])
	})

	it("ends a hold with stop-probes when the hop is re-sent and dwells again", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onTrack(track("t1"), true, 1_800)
		h.s.onBlock(B)
		h.s.onBlock(2 * B)
		expect(h.s.onBlock(3 * B)).toEqual([
			{ type: "start-probe", trackId: "t1", holdMs: 2_100 },
		])
		expect(h.s.onEpochStarted(10 * B)).toEqual([{ type: "stop-probes" }])
		expect(h.s.progress().holdingOn).toBeNull()
		expect(h.s.onBlock(12 * B)).toEqual([])
		expect(h.s.onBlock(13 * B)).toEqual([tune(1, 401.6 * MHZ)])
	})

	it("follows a confirmed call until it closes plus hangMs (policy hold)", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onTrack(track("t1"), true, 1_800)
		h.s.onBlock(B)
		h.s.onBlock(2 * B)
		h.s.onBlock(3 * B)
		h.clock = 500
		expect(h.s.onConfirmed("t1", true)).toEqual([])
		h.clock = 5_000
		expect(h.s.tick(h.clock)).toEqual([])
		h.clock = 8_000
		expect(h.s.onTrackClosed("t1")).toEqual([])
		h.clock = 9_999
		expect(h.s.tick(h.clock)).toEqual([])
		h.clock = 10_000
		expect(h.s.tick(h.clock)).toEqual([
			{ type: "stop-probes" },
			tune(1, 401.6 * MHZ),
		])
	})

	it("moves on right after a confirm with policy confirm, and caps any hold at maxHoldMs", () => {
		const confirm = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({
				revisit: noRevisit,
				hold: {
					policy: "confirm",
					confirmHoldMs: {},
					maxHoldMs: 60_000,
					hangMs: 2_000,
				},
			}),
		)
		confirm.s.start()
		confirm.s.onEpochStarted(0)
		confirm.s.onTrack(track("t1"), true, 1_800)
		confirm.s.onBlock(B)
		confirm.s.onBlock(2 * B)
		confirm.s.onBlock(3 * B)
		expect(confirm.s.onConfirmed("t1", true)).toEqual([
			{ type: "stop-probes" },
			tune(1, 401.6 * MHZ),
		])

		const capped = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({
				revisit: noRevisit,
				hold: {
					policy: "hold",
					confirmHoldMs: {},
					maxHoldMs: 4_000,
					hangMs: 2_000,
				},
			}),
		)
		capped.s.start()
		capped.s.onEpochStarted(0)
		capped.s.onTrack(track("t1"), true, 1_800)
		capped.s.onBlock(B)
		capped.s.onBlock(2 * B)
		capped.s.onBlock(3 * B)
		capped.s.onConfirmed("t1", true)
		capped.clock = 3_999
		expect(capped.s.tick(capped.clock)).toEqual([])
		capped.clock = 4_000
		expect(capped.s.tick(capped.clock)).toEqual([
			{ type: "stop-probes" },
			tune(1, 401.6 * MHZ),
		])
	})

	it("probes the strongest track first, then the next queued one", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onTrack(track("weak", 12), true, 1_000)
		h.s.onTrack(track("strong", 30), true, 1_800)
		h.s.onBlock(B)
		h.s.onBlock(2 * B)
		expect(h.s.onBlock(3 * B)).toEqual([
			{ type: "start-probe", trackId: "strong", holdMs: 2_100 },
		])
		h.clock = 400
		expect(h.s.onConfirmed("strong", false)).toEqual([
			{ type: "stop-probes" },
			{ type: "start-probe", trackId: "weak", holdMs: 1_300 },
		])
		h.clock = 1_700
		expect(h.s.tick(h.clock)).toEqual([
			{ type: "stop-probes" },
			tune(1, 401.6 * MHZ),
		])
	})
})

describe("SweepScheduler revisits and gain memory", () => {
	const plan4 = makeHopPlan([400 * MHZ, 401.6 * MHZ, 403.2 * MHZ, 404.8 * MHZ])

	it("revisits the most active, longest-unvisited hop after round(1/share) coarse hops", () => {
		const h = harness(
			plan4,
			makeNormalisedSpec({ revisit: { share: 0.5, maxIntervalMs: null } }),
		)
		h.s.start()
		h.s.onEpochStarted(0)
		h.s.onTrack(track("t1"), false, 0)
		h.sample = 0
		h.s.onBlock(B)
		h.s.onBlock(2 * B)
		expect(h.s.onBlock(3 * B)).toEqual([tune(1, 401.6 * MHZ)])
		h.clock = 1_000
		h.sample = 10 * B
		expect(h.dwell()).toEqual([tune(0, 400 * MHZ)]) // revisit of the active hop 0
		h.clock = 1_200
		expect(h.dwell()).toEqual([tune(2, 403.2 * MHZ)]) // back to the coarse order
	})

	it("forces a revisit of a hop overdue by maxIntervalMs", () => {
		const h = harness(
			plan4,
			makeNormalisedSpec({ revisit: { share: 0, maxIntervalMs: 1_000 } }),
		)
		h.s.start()
		h.dwell()
		h.clock = 1_500
		expect(h.dwell()).toEqual([tune(0, 400 * MHZ)])
		h.clock = 1_600
		expect(h.dwell()).toEqual([tune(2, 403.2 * MHZ)])
	})

	it("doubles a candidate hop's revisit weight while boosted", () => {
		const run = (boost: boolean): SchedulerAction[] => {
			const h = harness(
				plan4,
				makeNormalisedSpec({ revisit: { share: 1 / 3, maxIntervalMs: null } }),
			)
			h.s.start()
			h.s.onEpochStarted(h.sample)
			h.s.onTrack(track("a"), false, 0)
			h.dwell(3, false) // a second epoch would restart the visit and drop track a
			h.clock = 600
			h.s.onEpochStarted(h.sample)
			h.s.onTrack(track("b"), false, 0)
			h.dwell(3, false)
			if (boost) h.s.setBoost(1, true)
			h.clock = 2_000
			return h.dwell()
		}
		expect(run(false)).toEqual([tune(0, 400 * MHZ)]) // 1 × 2000 > 1 × 1400
		expect(run(true)).toEqual([tune(1, 401.6 * MHZ)]) // 2 × 1400 > 1 × 2000
	})

	it("lowers an overloaded hop's gain 6 dB and restores it after three clean visits", () => {
		const spec = makeNormalisedSpec({
			revisit: noRevisit,
			tuner: {
				sampleRateHz: null,
				gainTenthsDb: 496,
				agc: false,
				overload: "reduce-gain",
			},
		})
		const h = harness(makeHopPlan([400 * MHZ, 401.6 * MHZ]), spec)
		const gains: (number | null)[] = []
		const record = (actions: SchedulerAction[]) => {
			for (const a of actions)
				if (a.type === "tune" && a.hopIndex === 0) gains.push(a.gainTenthsDb)
		}
		record(h.s.start())
		h.s.onOverload(0)
		for (let visit = 0; visit < 9; visit++) record(h.dwell())
		expect(gains).toEqual([496, 436, 436, 436, 496])
	})
})

describe("SweepScheduler activity seed", () => {
	it("primes a hop's revisit weight from the seed (occupancy history), and leaves unseeded hops at 0", () => {
		const run = (seeded: boolean): SchedulerAction[] => {
			const plan = makeHopPlan([
				400 * MHZ,
				401.6 * MHZ,
				403.2 * MHZ,
				404.8 * MHZ,
			])
			const spec = makeNormalisedSpec({
				revisit: { share: 0.5, maxIntervalMs: null },
			})
			const h = { clock: 0, sample: 0 }
			const s = new SweepScheduler(plan, spec, {
				blockSamples: B,
				sampleRateHz: FS,
				now: () => h.clock,
				probeStartMs: 300,
				...(seeded
					? {
							activitySeed: (hop: { centreHz: number }) =>
								hop.centreHz === 400 * MHZ ? 0.8 : 0,
						}
					: {}),
			})
			const dwell = (): SchedulerAction[] => {
				s.onEpochStarted(h.sample)
				let actions: SchedulerAction[] = []
				for (let i = 0; i < 3 && actions.length === 0; i++) {
					h.sample += B
					actions = s.onBlock(h.sample)
				}
				return actions
			}
			s.start()
			dwell() // hop 0, quiet: the EWMA keeps the seed (no time has passed)
			h.clock = 1_000
			return dwell() // after hop 1: round(1/0.5) = 2 coarse hops → revisit check
		}
		expect(run(true)).toEqual([tune(0, 400 * MHZ)])
		expect(run(false)).toEqual([tune(2, 403.2 * MHZ)])
	})
})

describe("SweepScheduler re-plan", () => {
	it("applies a new plan at the next hop boundary, re-indexed by centre", () => {
		const h = harness(
			makeHopPlan([400 * MHZ, 401.6 * MHZ, 403.2 * MHZ, 404.8 * MHZ]),
			makeNormalisedSpec({ revisit: noRevisit }),
		)
		h.s.start()
		h.dwell()
		const fine = makeHopPlan(
			[0, 1, 2, 3, 4, 5, 6, 7].map(i => 400 * MHZ + i * 0.8 * MHZ),
			409_600,
		)
		h.s.replan(fine, makeNormalisedSpec({ revisit: noRevisit }))
		expect(h.s.progress().hopCount).toBe(4)
		expect(h.dwell()).toEqual([tune(3, 402.4 * MHZ)]) // hop 1 (401.6) is index 2 in the new plan
		expect(h.s.progress()).toMatchObject({ hopIndex: 3, hopCount: 8 })
	})

	// Feature: signal-discovery-scanner, Property 9: Job transitions (scheduler index bounds)
	// Validates: spec § 10.1, § 10.2, § 12.1
	it("keeps hopIndex in [0, hopCount) and sweepIndex non-decreasing for any event sequence, including re-plans", () => {
		type Ev =
			| { k: "epoch" }
			| { k: "block"; n: number }
			| { k: "stale" }
			| { k: "track"; id: number; confirm: boolean }
			| { k: "confirmed"; id: number; follow: boolean }
			| { k: "closed"; id: number }
			| { k: "tick"; ms: number }
			| { k: "replan"; hops: number }
			| { k: "overload" }
			| { k: "boost"; hop: number; on: boolean }
		const evArb: fc.Arbitrary<Ev> = fc.oneof(
			fc.record({ k: fc.constant("epoch" as const) }),
			fc.record({
				k: fc.constant("block" as const),
				n: fc.integer({ min: 1, max: 4 }),
			}),
			fc.record({ k: fc.constant("stale" as const) }),
			fc.record({
				k: fc.constant("track" as const),
				id: fc.integer({ min: 0, max: 3 }),
				confirm: fc.boolean(),
			}),
			fc.record({
				k: fc.constant("confirmed" as const),
				id: fc.integer({ min: 0, max: 3 }),
				follow: fc.boolean(),
			}),
			fc.record({
				k: fc.constant("closed" as const),
				id: fc.integer({ min: 0, max: 3 }),
			}),
			fc.record({
				k: fc.constant("tick" as const),
				ms: fc.integer({ min: 0, max: 70_000 }),
			}),
			fc.record({
				k: fc.constant("replan" as const),
				hops: fc.integer({ min: 1, max: 8 }),
			}),
			fc.record({ k: fc.constant("overload" as const) }),
			fc.record({
				k: fc.constant("boost" as const),
				hop: fc.integer({ min: 0, max: 9 }),
				on: fc.boolean(),
			}),
		)
		const planOf = (n: number) =>
			makeHopPlan(
				Array.from({ length: n }, (_, i) => 400 * MHZ + i * 1.6 * MHZ),
			)
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.array(evArb, { maxLength: 80 }),
				fc.boolean(),
				(initialHops, events, reduceGain) => {
					const spec = makeNormalisedSpec({
						revisit: { share: 0.3, maxIntervalMs: 20_000 },
						hold: {
							policy: "hold",
							confirmHoldMs: {},
							maxHoldMs: 30_000,
							hangMs: 2_000,
						},
						tuner: {
							sampleRateHz: null,
							gainTenthsDb: 300,
							agc: false,
							overload: reduceGain ? "reduce-gain" : "flag",
						},
					})
					let latest = planOf(initialHops)
					const h = harness(latest, spec)
					let lastSweep = 0
					const check = (actions: SchedulerAction[]) => {
						for (const a of actions) {
							if (a.type === "tune") {
								expect(a.hopIndex).toBeGreaterThanOrEqual(0)
								expect(a.hopIndex).toBeLessThan(latest.hops.length)
								expect(a.centreHz).toBe(latest.hops[a.hopIndex]?.centreHz)
								if (a.gainTenthsDb !== null)
									expect(a.gainTenthsDb).toBeGreaterThanOrEqual(0)
							}
							if (a.type === "sweep-complete")
								expect(a.sweepIndex).toBeGreaterThanOrEqual(lastSweep)
						}
						const p = h.s.progress()
						expect(p.hopIndex).toBeGreaterThanOrEqual(0)
						expect(p.hopIndex).toBeLessThan(p.hopCount)
						expect(p.sweepIndex).toBeGreaterThanOrEqual(lastSweep)
						expect(p.coverage).toBeGreaterThanOrEqual(0)
						expect(p.coverage).toBeLessThanOrEqual(1)
						lastSweep = p.sweepIndex
					}
					check(h.s.start())
					for (const e of events) {
						switch (e.k) {
							case "epoch":
								check(h.s.onEpochStarted(h.sample))
								break
							case "block":
								for (let i = 0; i < e.n; i++) {
									h.sample += B
									check(h.s.onBlock(h.sample))
								}
								break
							case "stale":
								h.s.onStale(1)
								break
							case "track":
								check(h.s.onTrack(track(`t${e.id}`), e.confirm, 1_000))
								break
							case "confirmed":
								check(h.s.onConfirmed(`t${e.id}`, e.follow))
								break
							case "closed":
								check(h.s.onTrackClosed(`t${e.id}`))
								break
							case "tick":
								h.clock += e.ms
								check(h.s.tick(h.clock))
								break
							case "replan":
								latest = planOf(e.hops)
								h.s.replan(latest, spec)
								check([])
								break
							case "overload":
								h.s.onOverload(h.s.progress().hopIndex)
								break
							case "boost":
								h.s.setBoost(e.hop, e.on)
								break
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
