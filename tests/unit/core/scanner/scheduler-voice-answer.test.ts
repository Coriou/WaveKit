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
	VOICE_QUIET_PAST_L_MS,
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

/**
 * A 3-hop sweep; `land` opens tracks on each epoch, `answer` is the recorder for the tuned hop,
 * `during` runs after each block (ms since the epoch started).
 */
function drive(
	answer: (hop: number, ms: number) => RecordingActivity,
	land: (hop: number, s: SweepScheduler, visit: number) => void,
	share = 0,
	during?: (
		hop: number,
		s: SweepScheduler,
		visit: number,
		intoMs: number,
	) => void,
) {
	let clock = 0
	let hop = 0
	let settleAt: number | null = null
	let epochAt = 0
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
			revisit: { share, maxIntervalMs: null },
		}),
		{
			blockSamples: BLOCK_MS,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 0,
			minSurfaceBlocks: 2,
			recordingActive: () => answer(hop, clock),
			activitySeed: h => (h.centreHz === BASE_HZ + STEP_HZ ? 1 : 0),
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
				epochAt = clock
				land(hop, s, visits.filter(v => v.hop === hop).length)
			} else clock = settleAt
			return
		}
		clock += BLOCK_MS
		apply(s.onBlock(clock))
		during?.(hop, s, visits.filter(v => v.hop === hop).length, clock - epochAt)
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

/** A voice answer of a session on `hz` (VoiceOnAir.targetHz: the held track's own, hop 0's). */
const voiceAnswer = (quietMs = 0, hz = hopHz(0)): RecordingActivity => ({
	voice: "a",
	quietMs,
	targetHz: hz,
})

/** A voice answer of a session the recorder recorded at `hz` (verified voice history there). */
const recordedVoice = (hz: number): RecordingActivity => ({
	voice: "a",
	quietMs: 0,
	recordedHz: hz,
	targetHz: hz,
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
		expect(VOICE_QUIET_PAST_L_MS).toBe(1_000)
		const d = held(() => VOICE_QUIET_PAST_L_MS, 30_000)
		expect(d.stayed(0, 1)).toBeGreaterThanOrEqual(COARSE_MS + 30_000)
	})

	it("is left at the first re-check past L that reads 1001 ms", () => {
		const d = held(into => (into >= L3 + 2_000 ? VOICE_QUIET_PAST_L_MS + 1 : 0))
		const stay = d.stayed(0, 1)
		expect(stay).toBeGreaterThanOrEqual(COARSE_MS + L3 + 2_000)
		expect(stay).toBeLessThanOrEqual(COARSE_MS + L3 + 2_000 + RECHECK_MS)
	})

	/**
	 * The recorder's reading of a pause after the last word: judged audio runs 1000 ms behind the air
	 * and the last voiced window ends 500 ms after the word, then the quiet grows in 100 ms steps.
	 */
	const quantized = (lastWord: number) => (into: number) =>
		Math.max(0, Math.floor((into - lastWord - 1_500) / 100) * 100)

	it("past L with readings in 100 ms steps: 1000 still holds, 1100 (2600 ms after the word) leaves, by 2850", () => {
		const lastWord = L3 + 901
		const d = held(quantized(lastWord))
		const after = d.stayed(0, 1) - COARSE_MS - lastWord
		expect(after).toBeGreaterThanOrEqual(1_500 + 1_100)
		expect(after).toBeLessThanOrEqual(1_000 + 500 + 1_100 + RECHECK_MS)
	})

	it("past L, quiet reading the limit and no more is not left", () => {
		const lastWord = L3 + 901
		const d = held(
			into => Math.min(VOICE_QUIET_PAST_L_MS, quantized(lastWord)(into)),
			40_000,
		)
		expect(d.stayed(0, 1)).toBeGreaterThanOrEqual(COARSE_MS + 40_000)
	})

	it("before L a quiet up to the recorder's 2 s does not end it", () => {
		const d = held(into => (into < L3 - RECHECK_MS ? 1_999 : 0), 25_000)
		expect(d.stayed(0, 1)).toBeGreaterThanOrEqual(COARSE_MS + 25_000)
	})

	it("reaching L in a quiet over the limit ends it at the re-check that sees L", () => {
		const d = held(() => 1_600)
		const stay = d.stayed(0, 1)
		expect(stay).toBeGreaterThanOrEqual(COARSE_MS + L3)
		expect(stay).toBeLessThanOrEqual(COARSE_MS + L3 + RECHECK_MS)
	})

	it("is followed by the forced sweep: both other hops visited before the hop is held again", () => {
		const d = held(() => 1_600)
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
			into >= 1_400 && into < 25_000 ? voiceAnswer(0, hopHz(1)) : false,
		)
		const { heldMs } = landing()
		expect(heldMs).toBeGreaterThanOrEqual(25_000)
		expect(heldMs).toBeLessThanOrEqual(25_000 + RECHECK_MS + BLOCK_MS)
	})

	it("a voice answer past the floor with no session answering by then is too late: it leaves", () => {
		const { landing } = budgetZeroLanding(into =>
			into >= 1_800 ? voiceAnswer(0, hopHz(1)) : false,
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

describe("a watch's long-hold lock and a voice on its hop", () => {
	/**
	 * Hop 1 watches a track 8 s (longer than a coarse sweep: the long-hold lock, set by hop 1), then
	 * answers voice from then on. With activity revisits on, hop 1 is the active hop a revisit would
	 * pick right after hop 2, and hold for that voice while hop 0 still waits for its coarse visit.
	 */
	const afterWatch = () => {
		let watched = false
		const d = drive(
			(hop, ms) =>
				hop === 1 && watched && ms < 120_000 ? voiceAnswer(0, hopHz(1)) : false,
			(hop, s, visit) => {
				if (hop !== 1) return
				if (visit === 1) {
					s.onTrack(sighting("w", hopHz(1)), false, 0, { followOnAir: true })
					// Something else on air in the window: the hop's activity, for a revisit to pick.
					s.onTrack(sighting("a", hopHz(1) + 50_000), false, 0)
				} else watched = true
			},
			// A revisit after every coarse visit.
			1,
		)
		d.runUntil(() => d.visits.filter(v => v.hop === 1).length >= 2)
		d.runUntil(() => d.visits.at(-1)!.leftAt !== null || d.visits.length > 8)
		return d
	}

	it("the hop that set it holds no voice on a revisit before every other hop had its coarse visit", () => {
		const d = afterWatch()
		d.runUntil(
			() =>
				d.visits.filter(v => v.hop === 1 && v.leftAt !== null).length >= 3 ||
				d.now() > 200_000,
		)
		const first = d.visits.findIndex(v => v.hop === 1)
		expect(d.visits[first]!.leftAt! - d.visits[first]!.tunedAt).toBeGreaterThan(
			COARSE_MS + 7_000,
		)
		// The first later visit of hop 1 that holds (its voice): hops 2 and 0 both came before it.
		const held = d.visits.findIndex(
			(v, i) =>
				i > first &&
				v.hop === 1 &&
				v.leftAt !== null &&
				v.leftAt - v.tunedAt > COARSE_MS + 2_000,
		)
		expect(held).toBeGreaterThan(first)
		const between = new Set(d.visits.slice(first + 1, held).map(v => v.hop))
		expect(between).toEqual(new Set([0, 1, 2]))
	})
})

describe("a voice beside a line with carrier evidence", () => {
	/**
	 * Visit 1 of hop 0 watches a 4 kHz line 8 s with its onset unseen: carrier evidence. Visit 2 hears
	 * track `id` on the same frequency read the widths `widths` in turn (the line taken into a voice's
	 * track, or the carrier itself reading wider) and the recorder answers voice for 20 s from that
	 * landing, whether or not anyone talks.
	 */
	const secondVisit = (
		widths: readonly number[],
		opts: {
			lineWidensTo?: number
			id?: string
			offsetHz?: number
			answer?: RecordingActivity
			voiceMs?: number
		} = {},
	) => {
		let voiceFrom: number | null = null
		const d = drive(
			(hop, ms) =>
				hop === 0 &&
				voiceFrom !== null &&
				ms < voiceFrom + (opts.voiceMs ?? 20_000)
					? (opts.answer ?? voiceAnswer())
					: false,
			(hop, s, visit) => {
				if (hop !== 0) return
				if (visit === 1) {
					s.onTrack({ ...sighting("c", hopHz(0)), obwHz: 4_000 }, false, 0, {
						followOnAir: true,
					})
					// The line's track reads wider during its watch.
					if (opts.lineWidensTo !== undefined)
						s.onTrack(
							{ ...sighting("c", hopHz(0)), obwHz: opts.lineWidensTo },
							false,
							0,
							{ followOnAir: true },
						)
				}
				if (visit === 2) {
					voiceFrom = d.now()
					const id = opts.id ?? "v"
					const hz = hopHz(0) + (opts.offsetHz ?? 1_000)
					for (const obwHz of widths)
						s.onTrack({ ...sighting(id, hz), obwHz }, false, 0, {
							followOnAir: true,
						})
				}
			},
		)
		expect(d.stayed(0, 1)).toBeGreaterThan(COARSE_MS + 7_000)
		return d.stayed(0, 2)
	}

	it("a track seen at the line's width that widens to twice it (8 kHz) is the line: no voice hold", () => {
		expect(secondVisit([4_000, 8_000])).toBeLessThan(COARSE_MS + 9_000)
	})

	it("one that widens past it (8001 Hz) while the hop listens on a later visit is still the line: width is no evidence", () => {
		expect(secondVisit([4_000, 8_001])).toBeLessThan(COARSE_MS + 9_000)
		expect(secondVisit([4_000, 14_000])).toBeLessThan(COARSE_MS + 9_000)
	})

	it("the carrier's own track widening within a later visit keeps its cap", () => {
		expect(secondVisit([4_000, 14_000], { id: "c", offsetHz: 0 })).toBeLessThan(
			COARSE_MS + 9_000,
		)
	})

	it("a landing that already reads past it is width alone: the carrier rules still apply", () => {
		expect(secondVisit([8_001])).toBeLessThan(COARSE_MS + 9_000)
		expect(secondVisit([14_000])).toBeLessThan(COARSE_MS + 9_000)
	})

	it("a carrier whose watch read 4 then 14 kHz, landed on at 14 kHz with a voice answer, is still the carrier", () => {
		expect(
			secondVisit([14_000], { lineWidensTo: 14_000, id: "c", offsetHz: 0 }),
		).toBeLessThan(COARSE_MS + 9_000)
	})

	it("a watch that heard the step spares its own visit only: the next visit's widening track is the carrier", () => {
		expect(secondVisit([4_000, 14_000], { lineWidensTo: 14_000 })).toBeLessThan(
			COARSE_MS + 9_000,
		)
	})
	/** A 29 s ID from the landing, recorded by the recorder (verified voice history). */
	const VOICED_ID_MS = 29_000

	it("the first catch after the evidence: a voice the recorder recorded there is held to its end", () => {
		const verified = recordedVoice(hopHz(0) + 1_000)
		const stay = secondVisit([4_000, 14_000], {
			answer: verified,
			voiceMs: VOICED_ID_MS,
		})
		expect(stay).toBeGreaterThanOrEqual(SETTLE_MS + VOICED_ID_MS)
		expect(stay).toBeLessThanOrEqual(
			SETTLE_MS + VOICED_ID_MS + RECHECK_MS + BLOCK_MS,
		)
	})

	it("the carrier's own track, verified: held to its end too (a repeater's ID on its idle carrier)", () => {
		const stay = secondVisit([4_000], {
			id: "c",
			offsetHz: 0,
			answer: recordedVoice(hopHz(0)),
			voiceMs: VOICED_ID_MS,
		})
		expect(stay).toBeGreaterThanOrEqual(SETTLE_MS + VOICED_ID_MS)
	})

	// The voice's session sits 9 kHz from the line (outside the line's 6.25 kHz), inside the track
	// that took the line in (centred 4 kHz from the line, 12 kHz wide): its recording is of that track.
	it("a session within the band of the track that took the line in is that frequency's history", () => {
		const stay = secondVisit([4_000, 12_000], {
			offsetHz: 4_000,
			answer: recordedVoice(hopHz(0) + 9_000),
			voiceMs: VOICED_ID_MS,
		})
		expect(stay).toBeGreaterThanOrEqual(SETTLE_MS + VOICED_ID_MS)
	})

	it("a session recorded 50 kHz away is no history of this frequency: capped", () => {
		const stay = secondVisit([4_000, 14_000], {
			answer: recordedVoice(hopHz(0) + 50_000),
			voiceMs: VOICED_ID_MS,
		})
		expect(stay).toBeLessThan(COARSE_MS + 9_000)
	})
})

describe("the watch that gives a line its first carrier evidence after its track widened", () => {
	/**
	 * Visit 1 of hop 0 watches track "c" (onset unseen) read 4 kHz, then `widthHz` (a voice keying
	 * up beside the line joins its track), while the recorder answers `answer(ms into the visit)`.
	 * Width is no exception: the visit that earns the evidence is under the carrier rules as any.
	 */
	const firstVisit = (
		widthHz: number,
		answer: (intoMs: number) => RecordingActivity,
	) => {
		const d = drive(
			(hop, ms) => (hop === 0 && ms < 60_000 ? answer(ms - SETTLE_MS) : false),
			(hop, s, visit) => {
				if (hop !== 0 || visit !== 1) return
				for (const obwHz of [4_000, widthHz])
					s.onTrack({ ...sighting("c", hopHz(0)), obwHz }, false, 0, {
						followOnAir: true,
					})
			},
		)
		return d
	}

	for (const widthHz of [8_000, 8_001, 14_000])
		it(`read ${widthHz} Hz at the evidence, a recording that is not voice: left at its watch`, () => {
			const stay = firstVisit(widthHz, () => true).stayed(0, 1)
			expect(stay).toBeGreaterThan(COARSE_MS + 7_000)
			expect(stay).toBeLessThan(COARSE_MS + 9_000)
		})

	// Review repro: a false voice answer from 11 to 50 s on the visit that earned the evidence held
	// the hop 50 150 ms (the L bound is 19 800).
	it("a bare voice answer from 11 to 50 s after the evidence stays under the L bound: left at its watch", () => {
		const stay = firstVisit(14_000, into =>
			into < 11_000 ? true : into < 50_000 ? voiceAnswer() : false,
		).stayed(0, 1)
		expect(stay).toBeLessThan(COARSE_MS + L3)
		expect(stay).toBeLessThan(COARSE_MS + 9_000)
	})

	// The recorder voiced the session before the watch's end, with no voice on air at that moment:
	// verified voice history all the same, so the evidence does not cap it.
	it("a recorded session with no voice on air at the evidence is history: kept to what L has left", () => {
		const recorded: RecordingActivity = {
			recording: true,
			recordedHz: hopHz(0) + 3_000,
		}
		const stay = firstVisit(14_000, () => recorded).stayed(0, 1)
		expect(stay).toBeGreaterThanOrEqual(COARSE_MS + L3)
		expect(stay).toBeLessThanOrEqual(COARSE_MS + L3 + RECHECK_MS)
	})

	it("and its voice answering after the evidence gets the voice hold, to the voice's end", () => {
		const hz = hopHz(0) + 3_000
		const stay = firstVisit(14_000, into =>
			into < 10_000
				? { recording: true, recordedHz: hz }
				: into < 30_000
					? recordedVoice(hz)
					: false,
		).stayed(0, 1)
		expect(stay).toBeGreaterThanOrEqual(COARSE_MS + 30_000 - BLOCK_MS * 3)
		expect(stay).toBeLessThanOrEqual(COARSE_MS + 30_000 + RECHECK_MS)
	})

	it("the next visit of that frequency is under the carrier rules too, the same widening and answer again", () => {
		const d = drive(
			(hop, ms) => hop === 0 && ms < 120_000,
			(hop, s, visit) => {
				if (hop !== 0) return
				for (const obwHz of [4_000, 8_001])
					s.onTrack({ ...sighting(`c${visit}`, hopHz(0)), obwHz }, false, 0, {
						followOnAir: true,
					})
			},
		)
		expect(d.stayed(0, 1)).toBeLessThan(COARSE_MS + 9_000)
		expect(d.stayed(0, 2)).toBeLessThan(COARSE_MS + 9_000)
	})
})

describe("verified voice history: carrier evidence never caps it", () => {
	/**
	 * Visit 1 of hop 0 watches line "c" (carrier evidence); visit 2 the recorder records a voiced
	 * session on it for 3 s; then hop 0 hears nothing for `silentVisits` visits; on the next it
	 * hears the frequency flap (a close and a reopen one block apart: carrier evidence again) and the
	 * recorder answers bare voice for 25 s from the landing.
	 */
	const afterHistory = (silentVisits: number) => {
		const back = 3 + silentVisits
		let voiceFrom: number | null = null
		let verifiedTo: number | null = null
		const d = drive(
			(hop, ms) => {
				if (hop !== 0) return false
				if (verifiedTo !== null && ms < verifiedTo)
					return recordedVoice(hopHz(0))
				return voiceFrom !== null && ms >= voiceFrom && ms < voiceFrom + 25_000
					? voiceAnswer()
					: false
			},
			(hop, s, visit) => {
				if (hop !== 0) return
				if (visit === 1)
					s.onTrack({ ...sighting("c", hopHz(0)), obwHz: 4_000 }, false, 0, {
						followOnAir: true,
					})
				if (visit === 2) {
					verifiedTo = d.now() + 3_000
					s.onTrack({ ...sighting("c2", hopHz(0)), obwHz: 4_000 }, false, 0, {
						followOnAir: true,
					})
				}
				if (visit === back) {
					voiceFrom = d.now()
					s.onTrack({ ...sighting("f1", hopHz(0)), obwHz: 4_000 }, false, 0, {
						followOnAir: true,
					})
				}
			},
			0,
			(hop, s, visit, intoMs) => {
				if (hop !== 0 || visit !== back) return
				if (intoMs === BLOCK_MS) s.onTrackClosed("f1")
				if (intoMs === BLOCK_MS * 2)
					s.onTrack({ ...sighting("f2", hopHz(0)), obwHz: 4_000 }, false, 0, {
						followOnAir: true,
					})
			},
		)
		expect(d.stayed(0, 1)).toBeGreaterThan(COARSE_MS + 7_000)
		expect(d.stayed(0, 2)).toBeGreaterThanOrEqual(SETTLE_MS + 3_000)
		return d.stayed(0, back)
	}

	it("is kept across visits: 9 silent visits later, a flap and a bare voice answer still get the voice hold", () => {
		expect(afterHistory(9)).toBeGreaterThan(COARSE_MS + L3 + 2_000)
	})

	it("forgetting (10 silent visits) clears it with the evidence: the returning carrier is capped again", () => {
		expect(afterHistory(10)).toBeLessThan(COARSE_MS + 9_000)
	})
})

describe("a voiced transmission whose squelch closed under the recorder's hang (voiceEnded)", () => {
	/**
	 * Hop 0: a recorded voice for `voiceMs` from the landing, then the recorder's recording with no
	 * voice (`after`) for 2 s (the reply joined in its hang, not voiced yet), then the reply's voice,
	 * another name, also recorded, for 25 s.
	 */
	const reply = (
		after: RecordingActivity,
		voiceMs = 5_000,
		landWith: "voice" | "after" = "voice",
	) => {
		let landedAt: number | null = null
		const d = drive(
			(hop, ms) => {
				if (hop !== 0 || landedAt === null) return false
				const into = ms - landedAt
				const first = landWith === "voice" ? voiceMs : 0
				if (into < first) return recordedVoice(hopHz(0))
				if (into < first + 2_000) return after
				if (into < first + 27_000)
					return {
						voice: "b",
						quietMs: 0,
						recordedHz: hopHz(0),
						targetHz: hopHz(0),
					}
				return false
			},
			(hop, s, visit) => {
				if (hop !== 0 || visit !== 1) return
				landedAt = d.now()
				s.onTrack(sighting("a", hopHz(0)), false, 0)
			},
		)
		return d
	}
	const ended: RecordingActivity = {
		recording: true,
		recordedHz: hopHz(0),
		voiceEnded: true,
	}

	it("ends the voice hold at the first re-check that reads it, history or not: the forced sweep follows", () => {
		const d = reply(ended)
		const stay = d.stayed(0, 1)
		expect(stay).toBeGreaterThanOrEqual(SETTLE_MS + 5_000)
		expect(stay).toBeLessThanOrEqual(SETTLE_MS + 5_000 + RECHECK_MS)
		d.stayed(0, 2)
		expect(d.visits.slice(0, 4).map(v => v.hop)).toEqual([0, 1, 2, 0])
	})

	it("a recording still of the voiced transmission (no voiceEnded) is kept, to what L has left", () => {
		const d = reply({ recording: true, recordedHz: hopHz(0) })
		// Kept past the 2 s without voice, and the reply's voice then rides the spent hold to L.
		expect(d.stayed(0, 1)).toBeGreaterThanOrEqual(SETTLE_MS + L3 - RECHECK_MS)
	})

	it("read at the keep, with no voice hold before it, it is not kept and still owes the coarse sweep", () => {
		const d = reply(ended, 0, "after")
		expect(d.stayed(0, 1)).toBeLessThanOrEqual(COARSE_MS + RECHECK_MS)
		d.stayed(0, 2)
		expect(d.visits.slice(0, 4).map(v => v.hop)).toEqual([0, 1, 2, 0])
		// The reply on air at the next visit is a transmission of its own: it gets its voice hold.
		expect(d.stayed(0, 2)).toBeGreaterThan(COARSE_MS + L3)
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

	it("renews on each visit: a session that never answers costs its 3000 ms every time", () => {
		const d = drive(
			hop => (hop === 0 ? "judging" : false),
			(hop, s, visit) => {
				if (hop === 0) s.onTrack(sighting(`v${visit}`, hopHz(0)), false, 0)
			},
		)
		for (const visit of [1, 2, 3]) {
			const stay = d.stayed(0, visit) - COARSE_MS
			expect(stay).toBeGreaterThanOrEqual(3_000)
			expect(stay).toBeLessThanOrEqual(3_000 + BLOCK_MS)
		}
	})

	it("adds to the voice floor with no L left: up to 1500 + 3000 ms past the dwell", () => {
		const { landing } = budgetZeroLanding(() => "judging")
		const { heldMs } = landing()
		expect(heldMs).toBeGreaterThanOrEqual(3 * BLOCK_MS + 1_500)
		expect(heldMs).toBeLessThanOrEqual(3 * BLOCK_MS + 1_500 + 3_000 + BLOCK_MS)
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
			hop => (hop === 1 ? (label ? voiceAnswer(0, hopHz(1)) : false) : false),
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
