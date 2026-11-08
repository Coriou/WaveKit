/**
 * A max-duration rollover is no end of the transmission: the tracker closes the track and opens
 * its successor at the same sample, reported in the same block before the block's summary, and the
 * recorder names the transmission again only once the successor opened (between the two it
 * answers false, as at a squelch close). The scheduler asks about a close at the next block, so the
 * rollover never spends the visit's voice hold. Through the scheduler alone; the driver feeds one
 * 50 ms block per step (the block's track events, then its summary) and the clock is the sample
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
const HZ = BASE_HZ + 100_437

/** The scene, ms from the landing of hop 0's second visit: one over voiced to OVER_END. */
const OVER_END = 26_000
/** The tracker's max-duration rollover of the over's track, 10 s after the landing. */
const ROLLOVER = 10_000

const sighting = (id: string, from: number, last: number): TrackSnapshot => ({
	...makeTrack({ id, centreHz: HZ, startedAt: 0, blocks: 8 }),
	trackId: id,
	startSample: from,
	lastSample: last,
})

/**
 * Drives the scene. `successorBlocks`: the block, counted from the close's, whose track events
 * open the successor (0: the close's own, before its summary, as the tracker reports a rollover;
 * 1: the next one, after the summary the scheduler asks at, which no rollover does). `summaries`:
 * false, no summary comes for the block after the close's (a stalled source): the tick asks one
 * block after the close.
 */
function rollover(successorBlocks: 0 | 1 | 2, summaries = true) {
	let clock = 0
	let hop = 0
	let settleAt: number | null = null
	let landing: number | null = null
	const plan = makeHopPlan(
		[0, 1, 2].map(i => BASE_HZ + i * STEP_HZ),
		HALF_SPAN_HZ,
	)
	const visits: { hop: number; tunedAt: number; leftAt: number | null }[] = []
	const visitOf = (h: number): number => visits.filter(v => v.hop === h).length
	const rel = (): number => (landing === null ? -Infinity : clock - landing)
	/** Between the close and the successor's open the recorder has no open track: false. */
	let between = false
	const answer = (): RecordingActivity => {
		if (hop !== 0 || landing === null || visitOf(0) !== 2) return false
		const ms = rel()
		if (between || ms >= OVER_END) return false
		return ms < 1_500 ? "judging" : { voice: "a", quietMs: 0 }
	}
	const s = new SweepScheduler(
		plan,
		makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS }),
		{
			blockSamples: BLOCK_MS,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 0,
			minSurfaceBlocks: 2,
			recordingActive: answer,
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
	let closedAt: number | null = null
	const report = (): void => {
		if (onAir !== null)
			s.onTrack(sighting(onAir[0], onAir[1], clock), false, 0, {
				followOnAir: true,
			})
	}
	const land = (): void => {
		onAir = null
		if (hop !== 0) return
		const visit = visitOf(0)
		if (visit === 1)
			s.onTrack(sighting("t1", clock, clock), true, 1_000, {
				followOnAir: true,
			})
		if (visit === 2) {
			landing = clock
			onAir = ["q", clock - 2_000]
		}
		report()
	}
	/** The block's track events, before its summary. */
	const events = (): void => {
		if (hop !== 0 || landing === null || visitOf(0) !== 2) return
		if (closedAt === null && rel() >= ROLLOVER) {
			// The over's track closes at this block's last sample; its successor opens there.
			closedAt = clock
			onAir = null
			between = true
			apply(s.onTrackClosed("q"))
		}
		if (
			between &&
			closedAt !== null &&
			clock >= closedAt + successorBlocks * BLOCK_MS
		) {
			between = false
			onAir = ["q2", closedAt]
		}
		if (onAir !== null && rel() >= OVER_END) {
			apply(s.onTrackClosed(onAir[0]))
			onAir = null
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
		events()
		// The stalled block: no summary for the block after the close.
		if (summaries || closedAt === null || clock !== closedAt + BLOCK_MS)
			apply(s.onBlock(clock))
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
	runUntil(() => landing !== null && rel() >= OVER_END + 2_000)
	const held = visits.filter(v => v.hop === 0)[1]!
	return { held, landing: landing! }
}

describe("a max-duration rollover of a voiced transmission's track", () => {
	// Asked at the close, the scheduler read the rollover's false answer as the over's end: the
	// voice hold was spent and the follow left at L (18.55 s after the landing on 3 hops).
	it("in the same block as its successor's open: the hold stays with the transmission to its end", () => {
		const { held, landing } = rollover(0)
		expect(held.leftAt).not.toBeNull()
		expect(held.leftAt! - landing).toBeGreaterThanOrEqual(OVER_END)
		expect(held.leftAt! - landing).toBeLessThanOrEqual(
			OVER_END + RECHECK_MS + 2 * BLOCK_MS,
		)
	})

	// L on 3 hops of 1150 ms (docs/SCANNER.md, Fair holds): 28 000 − 4600 − 5000; the holds
	// started at the 150 ms dwell's end. Past L at the close, a spent voice hold leaves at once.
	const L3 = 18_400

	it("past the bound, the successor opening only after the close's block summary: a squelch close, the voice hold is spent and the hop left by L", () => {
		const { held, landing } = rollover(1)
		expect(held.leftAt).not.toBeNull()
		expect(held.leftAt! - landing).toBeLessThan(OVER_END)
		expect(held.leftAt! - landing).toBeLessThanOrEqual(
			Math.max(ROLLOVER, 3 * BLOCK_MS + L3) + 2 * BLOCK_MS,
		)
	})

	it("with no block summary after the close's, the tick asks one block after the close: before a successor two blocks later, the close spends the voice hold", () => {
		const { held, landing } = rollover(2, false)
		expect(held.leftAt).not.toBeNull()
		expect(held.leftAt! - landing).toBeLessThan(OVER_END)
	})
})
