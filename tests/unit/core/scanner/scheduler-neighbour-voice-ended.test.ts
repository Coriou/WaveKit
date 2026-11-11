/**
 * A follow of the held track's analog voice while a neighbouring channel's QSO runs in the same
 * window: the recorder's `voiceEnded` (RecordedSession.voiceEnded) names the session whose
 * transmission ended by its frequency (RecordedSession.targetHz). With no transmission remembered
 * by the visit, only a `voiceEnded` of the held track's band ends the follow; a neighbour's
 * turnaround, or one of no known frequency, is a recording that is not voice, and the follow runs
 * on to its own cap. Through the scheduler alone; one 50 ms block per step, the clock is the sample
 * count.
 */
import { describe, expect, it } from "vitest"
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
const RECHECK_MS = 250
/** L on 3 hops of 1150 ms (docs/SCANNER.md, Fair holds): 28 000 − 4600 − 5000. */
const L3 = 18_400
/** The held track stays on air this long from the landing: past L, so only the cap ends a follow. */
const ON_AIR_MS = 40_000
/** The next 12.5 kHz channel: outside the held track's band (the 9 kHz track reaches 9000 / 2 + 3000 = 7500 Hz). */
const NEIGHBOUR_OFFSET_HZ = 12_500

/** Hop `n`'s signal frequency. */
const hopHz = (n: number): number => BASE_HZ + n * STEP_HZ + 100_437

const sighting = (
	id: string,
	hz: number,
	from: number,
	last: number,
): TrackSnapshot => ({
	...makeTrack({ id, centreHz: hz, startedAt: 0, blocks: 8 }),
	trackId: id,
	startSample: from,
	lastSample: last,
})

interface Visit {
	hop: number
	tunedAt: number
	leftAt: number | null
}

/**
 * Hop 0's first visit proves its frequency traffic by a decode; its second lands on the held track
 * on air (followed) for ON_AIR_MS, and the recorder answers `answer(ms from that landing)` there.
 */
function scene(answer: (ms: number) => RecordingActivity) {
	let clock = 0
	let hop = 0
	let settleAt: number | null = null
	let landing: number | null = null
	const plan = makeHopPlan(
		[0, 1, 2].map(i => BASE_HZ + i * STEP_HZ),
		HALF_SPAN_HZ,
	)
	const visits: Visit[] = []
	const visitOf = (h: number): number => visits.filter(v => v.hop === h).length
	const rel = (): number => (landing === null ? -Infinity : clock - landing)
	const s = new SweepScheduler(
		plan,
		makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS }),
		{
			blockSamples: BLOCK_MS,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 0,
			minSurfaceBlocks: 2,
			recordingActive: () =>
				hop === 0 && landing !== null && visitOf(0) === 2
					? answer(rel())
					: false,
		},
	)
	const apply = (next: SchedulerAction[]): void => {
		for (const a of next) {
			if (a.type !== "tune") continue
			const last = visits.at(-1)
			if (last !== undefined) last.leftAt = clock
			visits.push({ hop: a.hopIndex, tunedAt: clock, leftAt: null })
			hop = a.hopIndex
			settleAt = clock + SETTLE_MS
		}
	}
	let onAir: [string, number] | null = null
	const report = (): void => {
		if (onAir !== null)
			s.onTrack(sighting(onAir[0], hopHz(0), onAir[1], clock), false, 0, {
				followOnAir: true,
			})
	}
	const land = (): void => {
		onAir = null
		if (hop !== 0) return
		const visit = visitOf(0)
		if (visit === 1)
			s.onTrack(sighting("t1", hopHz(0), clock, clock), true, 1_000, {
				followOnAir: true,
			})
		if (visit === 2) {
			landing = clock
			onAir = ["q", clock - 2_000]
		}
		report()
	}
	apply(s.start())
	const step = (): void => {
		if (settleAt !== null) {
			if (clock >= settleAt) {
				settleAt = null
				apply(s.onEpochStarted(clock))
				land()
			} else clock = settleAt
			return
		}
		clock += BLOCK_MS
		apply(s.onBlock(clock))
		if (hop === 0 && onAir !== null && rel() >= ON_AIR_MS) {
			apply(s.onTrackClosed(onAir[0]))
			onAir = null
		}
		report()
		apply(s.tick(clock))
	}
	const runUntil = (done: () => boolean, limitMs = 200_000): void => {
		while (!done()) {
			if (clock > limitMs) throw new Error("the sweep never got there")
			step()
		}
	}
	runUntil(() => s.progress().holdingOn === "t1")
	apply(s.onConfirmed("t1", false))
	runUntil(() => visitOf(0) >= 3)
	const held = visits.filter(v => v.hop === 0)[1]!
	const i = visits.indexOf(held)
	return {
		stay: held.leftAt! - held.tunedAt,
		/** The hops visited between the held visit and hop 0's next one. */
		between: visits
			.slice(
				i + 1,
				visits.findIndex((v, j) => j > i && v.hop === 0),
			)
			.map(v => v.hop),
	}
}

const ended = (targetHz?: number): RecordingActivity => ({
	recording: true,
	voiceEnded: true,
	...(targetHz === undefined ? {} : { targetHz }),
})

/** The follow's own cap: L from the start of the holds, after the 3-block dwell. */
const followCap = SETTLE_MS + 3 * BLOCK_MS + L3

describe("a recorder's voiceEnded during a follow that remembers no transmission", () => {
	it("a neighbour's voiceEnded (the next channel) is no end of it: the follow runs on to its cap", () => {
		const { stay } = scene(() => ended(hopHz(0) + NEIGHBOUR_OFFSET_HZ))
		expect(stay).toBeGreaterThanOrEqual(followCap - RECHECK_MS)
		expect(stay).toBeLessThanOrEqual(followCap + BLOCK_MS)
	})

	it("one with no frequency (targetHz absent) is no end of it either: ignoring keeps the hop within its cap", () => {
		const { stay } = scene(() => ended())
		expect(stay).toBeGreaterThanOrEqual(followCap - RECHECK_MS)
		expect(stay).toBeLessThanOrEqual(followCap + BLOCK_MS)
	})

	it("one just past the held band's reach (9000 / 2 + 3000 = 7500 Hz for the 9 kHz track) is a neighbour's", () => {
		const { stay } = scene(() => ended(hopHz(0) + 7_501))
		expect(stay).toBeGreaterThanOrEqual(followCap - RECHECK_MS)
	})

	it("the held track's own voiceEnded (on its centre, and at its reach, 7500 Hz) ends it at the first ask, and the sweep follows", () => {
		for (const off of [0, 7_500]) {
			const { stay, between } = scene(() => ended(hopHz(0) + off))
			expect(stay).toBeLessThanOrEqual(DWELL_MS + RECHECK_MS + BLOCK_MS)
			expect(new Set(between)).toEqual(new Set([1, 2]))
		}
	})
})

describe("a recorder's voiceEnded during a follow that remembers its transmission", () => {
	it("the remembered transmission ended: the follow ends at the first ask that reads it, whatever frequency it names", () => {
		const VOICE_MS = 3_000
		for (const targetHz of [undefined, hopHz(0) + NEIGHBOUR_OFFSET_HZ]) {
			const { stay, between } = scene(ms =>
				ms < VOICE_MS
					? { voice: "a", quietMs: 0, targetHz: hopHz(0) }
					: ended(targetHz),
			)
			expect(stay).toBeGreaterThanOrEqual(SETTLE_MS + VOICE_MS)
			expect(stay).toBeLessThanOrEqual(
				SETTLE_MS + VOICE_MS + RECHECK_MS + BLOCK_MS,
			)
			expect(new Set(between)).toEqual(new Set([1, 2]))
		}
	})
})
