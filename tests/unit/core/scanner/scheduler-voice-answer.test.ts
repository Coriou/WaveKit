/**
 * The edges of a voice hold against the recorder's answers, through the scheduler alone: a hold past
 * L must be continuous voice; a voiced landing is not left before the recorder can answer, whatever
 * the follow budget; a voice answer still to come ("judging") keeps the hop, bounded. The driver
 * feeds one 50 ms block per step; the clock is the sample count.
 */
import { describe, expect, it } from "vitest"
import {
	WIDEBAND_VOICE_ANSWER_MS,
	WIDEBAND_VOICE_JUDGE_MS,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	type RecordingActivity,
	type SchedulerAction,
	SweepScheduler,
} from "../../../../src/core/scanner/scheduler.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const MHZ = 1_000_000
const HALF_SPAN_HZ = 409_600
const STEP_HZ = 800_000
const BASE_HZ = 150 * MHZ
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
/** L on 3 hops of 1150 ms (docs/SCANNER.md, Fair holds): 28 000 − 4600 − 5000. */
const L3 = 18_400
const RECHECK_MS = 250

interface Visit {
	hop: number
	tunedAt: number
	leftAt: number | null
}

/** Hop `n` of the plan. */
const hopHz = (n: number): number => BASE_HZ + n * STEP_HZ + 100_437

/** A 3-hop sweep; `land` opens tracks on each epoch, `answer` is the recorder for the tuned hop. */
function drive(
	answer: (hop: number, ms: number) => RecordingActivity,
	land: (hop: number, s: SweepScheduler, visit: number) => void,
) {
	let clock = 0
	let hop = 0
	let settleAt: number | null = null
	const plan = makeHopPlan(
		[0, 1, 2].map(i => BASE_HZ + i * STEP_HZ),
		HALF_SPAN_HZ,
	)
	const visits: Visit[] = []
	const s = new SweepScheduler(
		plan,
		makeNormalisedSpec({
			dwellMs: DWELL_MS,
			settleMs: SETTLE_MS,
			revisit: { share: 0, maxIntervalMs: null },
		}),
		{
			blockSamples: BLOCK_MS,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 0,
			minSurfaceBlocks: 2,
			recordingActive: () => answer(hop, clock),
		},
	)
	const apply = (actions: SchedulerAction[]): void => {
		for (const a of actions) {
			if (a.type !== "tune") continue
			const last = visits.at(-1)
			if (last !== undefined) last.leftAt = clock
			visits.push({ hop: a.hopIndex, tunedAt: clock, leftAt: null })
			hop = a.hopIndex
			settleAt = clock + SETTLE_MS
		}
	}
	apply(s.start())
	const step = (): void => {
		if (settleAt !== null) {
			if (clock >= settleAt) {
				settleAt = null
				apply(s.onEpochStarted(clock))
				land(hop, s, visits.filter(v => v.hop === hop).length)
			} else clock = settleAt
			return
		}
		clock += BLOCK_MS
		apply(s.onBlock(clock))
		apply(s.tick(clock))
	}
	return {
		s,
		visits,
		now: () => clock,
		/** A decode of a held track: the frequency is traffic, the probe ends. */
		decoded: (id: string) => apply(s.onConfirmed(id, false)),
		runUntil(done: () => boolean, limitMs = 400_000): void {
			while (!done()) {
				if (clock > limitMs) throw new Error("the sweep never got there")
				step()
			}
		},
		/** The first listening of the `visit`th visit of `hop`: ms it stayed, tune to tune. */
		stayed(hopIndex: number, visit: number): number {
			this.runUntil(
				() =>
					visits.filter(v => v.hop === hopIndex && v.leftAt !== null).length >=
					visit,
			)
			const v = visits.filter(x => x.hop === hopIndex)[visit - 1]!
			return v.leftAt! - v.tunedAt
		},
	}
}

const sighting = (id: string, hz: number, blocks = 8): TrackSnapshot => ({
	...makeTrack({ id, centreHz: hz, startedAt: 0, blocks }),
	trackId: id,
})

const voiceAnswer = (quietMs = 0): RecordingActivity => ({
	voice: "a",
	quietMs,
})

/** Visit of `hop` with nothing but the settle and its dwell. */
const COARSE_MS = DWELL_MS

describe("a voice hold past L", () => {
	/** Hop 0 answers voice whose quiet reads `quiet(ms into the hold)`, ending at `endsAt`. */
	const held = (quiet: (intoMs: number) => number, endsAt = 60_000) => {
		const startedAt = SETTLE_MS + 3 * BLOCK_MS
		return drive(
			(hop, ms) => {
				if (hop !== 0 || ms >= startedAt + endsAt) return false
				return voiceAnswer(quiet(ms - startedAt))
			},
			(hop, s) => {
				if (hop === 0) s.onTrack(sighting("a", hopHz(0)), false, 0)
			},
		)
	}

	it("keeps a quiet of 1000 ms, the limit, to the voice's end", () => {
		const d = held(() => 1_000, 30_000)
		expect(d.stayed(0, 1)).toBeGreaterThanOrEqual(COARSE_MS + 30_000)
	})

	it("is left at the first re-check past L that reads 1001 ms", () => {
		const d = held(into => (into >= L3 + 2_000 ? 1_001 : 0))
		const stay = d.stayed(0, 1)
		expect(stay).toBeGreaterThanOrEqual(COARSE_MS + L3 + 2_000)
		expect(stay).toBeLessThanOrEqual(COARSE_MS + L3 + 2_000 + RECHECK_MS)
	})

	it("before L a quiet up to the recorder's 2 s does not end it", () => {
		const d = held(into => (into < L3 - RECHECK_MS ? 1_999 : 0), 25_000)
		expect(d.stayed(0, 1)).toBeGreaterThanOrEqual(COARSE_MS + 25_000)
	})

	it("reaching L in a quiet over the limit ends it at the re-check that sees L", () => {
		const d = held(() => 1_500)
		const stay = d.stayed(0, 1)
		expect(stay).toBeGreaterThanOrEqual(COARSE_MS + L3)
		expect(stay).toBeLessThanOrEqual(COARSE_MS + L3 + RECHECK_MS)
	})

	it("is followed by the forced sweep: both other hops visited before the hop is held again", () => {
		const d = held(() => 1_500)
		d.stayed(0, 2)
		expect(d.visits.slice(0, 3).map(v => v.hop)).toEqual([0, 1, 2])
		for (const v of d.visits.slice(1, 3))
			expect(v.leftAt! - v.tunedAt).toBeLessThanOrEqual(COARSE_MS + BLOCK_MS)
		// Its next visit is a voice hold again, per transmission.
		expect(d.visits[3]!.leftAt! - d.visits[3]!.tunedAt).toBeGreaterThan(
			COARSE_MS + 2 * RECHECK_MS,
		)
	})
})

/**
 * Hop 0: voice held to L with a long tail, so hop 2 has waited L when hop 1, already known as traffic
 * from a decode in the first sweep, gets its landing with a follow budget of 0.
 */
function budgetZeroLanding(
	answer: (intoMs: number) => RecordingActivity,
	needsConfirm = false,
) {
	let landedAt: number | null = null
	let held0 = false
	const d = drive(
		(hop, ms) => {
			if (hop === 0 && held0) return ms < 40_000 ? voiceAnswer() : false
			if (hop === 1 && landedAt !== null) return answer(ms - landedAt)
			return false
		},
		(hop, s, visit) => {
			if (hop === 0 && visit === 2) {
				held0 = true
				s.onTrack(sighting("b", hopHz(0)), false, 0)
			}
			if (hop === 1 && visit === 1) {
				s.onTrack(sighting("t1", hopHz(1)), true, 1_000, { followOnAir: true })
			}
			if (hop === 1 && visit === 2) {
				s.onTrack(sighting("t2", hopHz(1)), needsConfirm, 1_500, {
					followOnAir: true,
				})
			}
		},
	)
	// A decode in the first sweep proves hop 1's frequency traffic.
	d.runUntil(() => d.s.progress().holdingOn === "t1")
	d.decoded("t1")
	return {
		d,
		landing(): { heldMs: number } {
			d.runUntil(() => d.visits.filter(v => v.hop === 1).length === 2)
			const v = d.visits.filter(x => x.hop === 1)[1]!
			d.runUntil(() => d.now() >= v.tunedAt + SETTLE_MS)
			landedAt = v.tunedAt + SETTLE_MS
			d.runUntil(() => v.leftAt !== null)
			return { heldMs: v.leftAt! - v.tunedAt - SETTLE_MS }
		},
	}
}

describe("a voiced landing on a traffic frequency with a follow budget of 0", () => {
	it("stays to the floor, 1500 ms from its hold, and leaves there with no recording", () => {
		expect(WIDEBAND_VOICE_ANSWER_MS).toBe(1_500)
		const { landing } = budgetZeroLanding(() => false)
		const { heldMs } = landing()
		// The dwell's 3 blocks, then the hold's floor.
		expect(heldMs).toBeGreaterThanOrEqual(3 * BLOCK_MS + 1_500)
		expect(heldMs).toBeLessThanOrEqual(3 * BLOCK_MS + 1_500 + BLOCK_MS)
	})

	it("a voice answer by the floor gets the voice hold, past L and to its end", () => {
		const { landing } = budgetZeroLanding(into =>
			into >= 1_400 && into < 25_000 ? voiceAnswer() : false,
		)
		const { heldMs } = landing()
		expect(heldMs).toBeGreaterThanOrEqual(25_000)
		expect(heldMs).toBeLessThanOrEqual(25_000 + RECHECK_MS + BLOCK_MS)
	})

	it("a voice answer past the floor with no session answering by then is too late: it leaves", () => {
		const { landing } = budgetZeroLanding(into =>
			into >= 1_800 ? voiceAnswer() : false,
		)
		expect(landing().heldMs).toBeLessThanOrEqual(
			3 * BLOCK_MS + 1_500 + BLOCK_MS,
		)
	})

	it("under the lock on the hop that set it, the probe only: no floor", () => {
		let visitOf0 = 0
		const d = drive(
			() => false,
			(hop, s, visit) => {
				if (hop === 0) {
					visitOf0 = visit
					// A watch of 8 s: longer than a coarse sweep, so it sets the long-hold lock on hop 0.
					if (visit === 2)
						s.onTrack(sighting("w", hopHz(0) + 200_000), false, 0, {
							followOnAir: true,
						})
					if (visit === 1)
						s.onTrack(sighting("t1", hopHz(0)), true, 1_000, {
							followOnAir: true,
						})
					if (visit === 3)
						s.onTrack(sighting("t2", hopHz(0)), false, 1_000, {
							followOnAir: true,
						})
				}
			},
		)
		d.runUntil(() => d.s.progress().holdingOn === "t1")
		d.decoded("t1")
		d.runUntil(() => visitOf0 === 3)
		const v = d.visits.filter(x => x.hop === 0)[2]!
		d.runUntil(() => v.leftAt !== null)
		expect(v.leftAt! - v.tunedAt).toBeLessThanOrEqual(COARSE_MS + 2 * BLOCK_MS)
	})
})

describe('a voice answer still to come ("judging")', () => {
	const keptFor = (answer: (intoMs: number) => RecordingActivity) => {
		const startedAt = SETTLE_MS + 3 * BLOCK_MS
		const d = drive(
			(hop, ms) => (hop === 0 ? answer(ms - startedAt) : false),
			(hop, s, visit) => {
				if (hop === 0 && visit === 1)
					s.onTrack(sighting("a", hopHz(0)), false, 0)
			},
		)
		return d.stayed(0, 1) - COARSE_MS
	}

	it("keeps the hop for the bound, 3000 ms, and no longer", () => {
		expect(WIDEBAND_VOICE_JUDGE_MS).toBe(3_000)
		const stay = keptFor(() => "judging")
		expect(stay).toBeGreaterThanOrEqual(3_000)
		expect(stay).toBeLessThanOrEqual(3_000 + BLOCK_MS)
	})

	it("becomes a voice hold when voice answers, at the bound's last re-check", () => {
		const stay = keptFor(into =>
			into < 2_900 ? "judging" : into < 20_000 ? voiceAnswer() : false,
		)
		expect(stay).toBeGreaterThanOrEqual(20_000)
		expect(stay).toBeLessThanOrEqual(20_000 + RECHECK_MS)
	})

	it("a verdict of no voice leaves at the next re-check", () => {
		const stay = keptFor(into => (into < 1_000 ? "judging" : false))
		expect(stay).toBeGreaterThanOrEqual(1_000)
		expect(stay).toBeLessThanOrEqual(1_000 + RECHECK_MS)
	})

	it("is used once per visit: judging again after a recording's end does not keep it", () => {
		const stay = keptFor(into =>
			into < 1_000 ? "judging" : into < 1_500 ? true : "judging",
		)
		expect(stay).toBeLessThanOrEqual(3_000 + BLOCK_MS)
	})

	it("a frequency with carrier evidence is not kept: a shadow of a carrier taxes no visit", () => {
		// 8 s of watch on air with its onset unseen is carrier evidence; later visits are coarse.
		const d = drive(
			(hop, ms) => (hop === 0 && ms > 12_000 ? "judging" : false),
			(hop, s) => {
				if (hop === 0)
					s.onTrack(sighting("c", hopHz(0)), false, 0, { followOnAir: true })
			},
		)
		d.runUntil(() => d.visits.filter(v => v.hop === 0).length >= 4)
		const later = d.visits
			.filter(v => v.hop === 0 && v.leftAt !== null)
			.slice(1)
		expect(later.length).toBeGreaterThan(1)
		for (const v of later)
			expect(v.leftAt! - v.tunedAt).toBeLessThanOrEqual(
				COARSE_MS + 2 * BLOCK_MS,
			)
	})

	it("after the visit's voice hold ended, it keeps only what L has left", () => {
		const stay = keptFor(into => (into < 5_000 ? voiceAnswer() : "judging"))
		expect(stay).toBeGreaterThanOrEqual(L3)
		expect(stay).toBeLessThanOrEqual(L3 + RECHECK_MS)
	})
})

describe("a probe of a track just passed, its label still to come", () => {
	it("waits for the label once, then follows it instead of leaving at the dwell", () => {
		let label = false
		const d = drive(
			hop => (hop === 1 ? (label ? voiceAnswer() : false) : false),
			(hop, s, visit) => {
				if (hop === 1 && visit === 1) {
					s.onTrack(sighting("t1", hopHz(1)), true, 1_000, {
						followOnAir: true,
					})
				}
				if (hop === 1 && visit === 2) {
					s.onCandidate(sighting("t2", hopHz(1), 2), 100)
					s.onTrack(sighting("t2", hopHz(1), 2), true, 0, {})
				}
			},
		)
		d.runUntil(() => d.s.progress().holdingOn === "t1")
		d.decoded("t1")
		d.runUntil(() => d.visits.filter(v => v.hop === 1).length === 2)
		const v = d.visits.filter(x => x.hop === 1)[1]!
		d.runUntil(() => d.now() >= v.tunedAt + SETTLE_MS + 5 * BLOCK_MS)
		// Still on the hop past its 3-block dwell: the class it waited for arrives now.
		expect(v.leftAt).toBeNull()
		d.s.onTrack(sighting("t2", hopHz(1), 5), true, 0, { followOnAir: true })
		label = true
		d.runUntil(() => d.now() >= v.tunedAt + SETTLE_MS + 20 * BLOCK_MS)
		expect(v.leftAt).toBeNull()
		expect(d.s.progress().holdingOn).toBe("t2")
	})
})
