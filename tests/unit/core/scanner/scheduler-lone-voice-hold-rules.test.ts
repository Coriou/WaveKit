/**
 * A lone voice beside a line is held whole, as the scheduler held it before holds were named by
 * band. Two hops of 1150 ms, ticks every 50 ms. Track "a" lies 25 kHz below the voice, 25 dB, in
 * the window from the visit's start, and never voices; the voice "id" at TARGET_HZ is answered by
 * the recorder from `voiceAt` to ID_END_MS (a recording that is not voice before it), its own
 * track "b" (analog voice) qualifying at `bAt`, open to ID_END_MS.
 *
 * - The voice on air but unnamed when "a"'s watch caps (the held band is "a"'s): the keep names it
 *   for "b", whose band holds it, even while another hop's long hold left the long-hold lock.
 * - A keep of the hop for a recording that was not voice bounds the visit's holds by what L had
 *   left; once a follow of "b" names "b"'s own voice that bound is lifted, so "b" is held whole.
 * - A line only hinted as voice to come (voiceLater) and never held takes no commitment from a
 *   voice that lies in another open track's band (the voice's own track qualified by its first
 *   answer). A voice answered before any track holds it still commits to the line, as to a
 *   labelled one (scheduler-committed-voice-track: the line may be the ID, voicing later).
 */
import { describe, expect, it } from "vitest"
import {
	type RecordingActivity,
	type SchedulerAction,
	SweepScheduler,
	type TrackHints,
} from "../../../../src/core/scanner/scheduler.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const TARGET_HZ = 150_100_000
const OTHER_HZ = TARGET_HZ - 25_000
/** The voice is answered, and its track open, this long from the visit's landing. */
const ID_END_MS = 30_000
/** A voice hold's end is seen at its next re-check (RECORD_RECHECK_MS) or sampled ask. */
const RECHECK_MS = 250
/** L on 2 hops (docs/SCANNER.md, Fair holds): 28 000 − 3450 − 5000; a cut hop leaves by then. */
const L2 = 19_550

interface Scene {
	/** When "b" qualifies, from the landing. */
	bAt: number
	/** When the recorder first answers the voice (a recording that is not voice before it). */
	voiceAt?: number
	/** "a"'s hints (none when absent: a steady line, never labelled). */
	aHints?: TrackHints
	/** "a" needs a decoder's confirm (a probe first), which never decodes. */
	aConfirm?: boolean
	/** The long-hold lock another hop's long hold left (SweepScheduler.longHoldLock) at the landing. */
	longHoldLock?: number
}

function run(scene: Scene) {
	const id = { voice: "id", quietMs: 0, targetHz: TARGET_HZ }
	const listing = { ...id, transmissions: { id } }
	let clock = 0
	const recording = (): RecordingActivity => {
		if (clock >= ID_END_MS) return false
		return clock >= (scene.voiceAt ?? 0) ? listing : true
	}
	const s = new SweepScheduler(
		makeHopPlan([150_000_000, 150_800_000], 409_600),
		makeNormalisedSpec({
			dwellMs: 1_150,
			settleMs: 1_000,
			revisit: { share: 0, maxIntervalMs: null },
		}),
		{
			blockSamples: 50,
			sampleRateHz: 1000,
			now: () => clock,
			probeStartMs: 300,
			recordingActive: recording,
		},
	)
	const internals = s as unknown as {
		visit: {
			voiceId: string | null
			heardVoiceId: string | null
			voiceTrackId: string | null
		} | null
		hold: { trackId: string; mode: string } | null
		longHoldLock: number
	}
	const sighting = (
		trackId: string,
		centreHz: number,
		snrDb: number,
	): TrackSnapshot => ({
		...makeTrack({ id: trackId, centreHz, startedAt: clock, blocks: 8, snrDb }),
		trackId,
		obwHz: 11_000,
	})
	let settleAt: number | null = null
	let leftAt: number | null = null
	const apply = (actions: SchedulerAction[]): void => {
		for (const a of actions) {
			if (a.type !== "tune") continue
			settleAt = clock + 1_000
			if (clock > 0) leftAt ??= clock
		}
	}
	s.start()
	s.onEpochStarted(0)
	if (scene.longHoldLock !== undefined)
		internals.longHoldLock = scene.longHoldLock
	apply(
		s.onTrack(
			sighting("a", OTHER_HZ, 25),
			scene.aConfirm === true,
			scene.aConfirm === true ? 1_000 : 0,
			scene.aHints ?? {},
		),
	)
	const named = new Set<string>()
	const held = new Set<string>()
	const committed = new Set<string>()
	for (clock = 50; clock <= 200_000 && leftAt === null; clock += 50) {
		if (settleAt !== null) {
			if (clock < settleAt) continue
			settleAt = null
			apply(s.onEpochStarted(clock))
			continue
		}
		if (clock === scene.bAt)
			apply(
				s.onTrack(sighting("b", TARGET_HZ, 15), false, 0, {
					followOnAir: true,
				}),
			)
		if (clock === ID_END_MS) apply(s.onTrackClosed("b"))
		apply(s.onBlock(clock))
		apply(s.tick(clock))
		const v = internals.visit
		for (const name of [v?.voiceId, v?.heardVoiceId])
			if (name !== null && name !== undefined) named.add(name)
		if (v?.voiceTrackId !== null && v?.voiceTrackId !== undefined)
			committed.add(v.voiceTrackId)
		if (internals.hold !== null)
			held.add(`${internals.hold.trackId}:${internals.hold.mode}`)
	}
	return { leftAt, named: [...named], held, committed: [...committed] }
}

/** The voice is named and the hop held to its end, seen at the next re-check. */
function heldToItsEnd(h: ReturnType<typeof run>): void {
	expect(h.named).toEqual(["id"])
	expect(h.leftAt).not.toBeNull()
	expect(h.leftAt!).toBeGreaterThan(L2)
	expect(h.leftAt!).toBeGreaterThanOrEqual(ID_END_MS)
	expect(h.leftAt!).toBeLessThanOrEqual(ID_END_MS + RECHECK_MS)
}

describe("a lone voice beside a line is held whole", () => {
	describe("the voice unnamed when the line's watch caps (voiceOwnTrack)", () => {
		for (const lock of [0, 1])
			it(`a probed steady line watched to its cap, the voice's track qualifying 3 s in, long-hold lock ${lock}: the voice named for its own track and held to its end`, () => {
				const h = run({ bAt: 3_000, aConfirm: true, longHoldLock: lock })
				expect(h.held.has("a:follow")).toBe(true)
				heldToItsEnd(h)
			})

		it("an analog-labelled line watched to its cap under the long-hold lock: its never-voiced commitment passes to the voice's own track", () => {
			const h = run({
				bAt: 3_000,
				aHints: { followOnAir: true },
				longHoldLock: 1,
			})
			expect(h.held.has("a:follow")).toBe(true)
			expect(h.committed).toContain("b")
			heldToItsEnd(h)
		})

		it("a probed line hinted as voice to come, watched to its cap under the long-hold lock: the voice named for its own track and held to its end", () => {
			const h = run({
				bAt: 3_000,
				aConfirm: true,
				aHints: { voiceLater: true },
				longHoldLock: 1,
			})
			heldToItsEnd(h)
		})
	})

	describe("a keep for a recording that was not voice (Visit.recordEndMs)", () => {
		for (const at of [3_000, 6_000, 9_000])
			it(`a steady line kept for a recording that is not voice, the voice and its track ${at / 1000} s in: the follow naming its own voice lifts the keep's bound and the voice is held to its end`, () => {
				const h = run({ bAt: at, voiceAt: at })
				expect(h.held.has("a:record")).toBe(true)
				heldToItsEnd(h)
			})
	})

	describe("a voiceLater line never held (commitVoiceTrack)", () => {
		it("a steady line hinted as voice to come, kept only for the recording, the voice and its track 1 s in: no commitment to it, the voice named and held to its end", () => {
			const h = run({
				bAt: 1_000,
				voiceAt: 1_000,
				aHints: { followOnAir: false, voiceLater: true },
			})
			expect(h.held.has("a:record")).toBe(true)
			expect(h.committed).not.toContain("a")
			heldToItsEnd(h)
		})

		it("the same line, the voice and its track 3 s in: no commitment to it, the voice held to its end", () => {
			const h = run({
				bAt: 3_000,
				voiceAt: 3_000,
				aHints: { followOnAir: false, voiceLater: true },
			})
			expect(h.committed).not.toContain("a")
			heldToItsEnd(h)
		})
	})
})
