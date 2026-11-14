/**
 * A voice keyed beside a weak steady line joins the line's track, which reads wider and centred
 * between them, while the line may read on as its own track. A recording check during a hold of the
 * line hears the voice: it is the voice track's own (in its band), and that track's band overlaps the
 * line's (bandsOverlap), so the check commits the visit to nothing (commitVoiceTrack). Committed to the
 * line, every later hold named voice by the line's band, the voice track's own transmission was never
 * named, and the ID was cut at L into two files. A voice on another channel (bands apart, or
 * centres JOINED_TRACKS_BELOW_HZ or more apart) is a neighbour beside the held track's transmission,
 * and the check commits to the held track; the line's own hold is then a carrier watch (8 s on air
 * without a break, its onset unseen, no voice of its own), so that commitment is tentative and
 * passes to the voice's own track once that track is held and its own voice named: the voice is
 * held to its end (Visit.voiceTentative, settleCommitment).
 */
import { describe, expect, it } from "vitest"
import {
	type RecordingActivity,
	type SchedulerAction,
	SweepScheduler,
	type VoiceOnAir,
} from "../../../../src/core/scanner/scheduler.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"

const LINE_HZ = 150_100_000
const LINE_OBW_HZ = 7_000

/** The voice's end: past L of two hops (19 550 ms), so only its voice hold keeps it whole. */
const VOICE_END_MS = 25_000
/** A voice hold's end is seen at its next re-check (RECORD_RECHECK_MS). */
const RECHECK_MS = 250

interface Scene {
	/** The voice track's centre below the line. */
	offsetHz: number
	/** The voice track's occupied bandwidth. */
	voiceObwHz: number
	/** The held line's occupied bandwidth (LINE_OBW_HZ when absent). */
	lineObwHz?: number
}

/**
 * Two hops of 1150 ms. The line "line" (labelled analog at its first sighting, the stronger track)
 * is in the window from the start and is followed first, its 8 s watch from 150 ms; the voice
 * track "v" (analog voice) qualifies at 100 ms and is voiced (the recorder's only session, at its
 * centre) from the start to VOICE_END_MS, when its track closes. After the watch the hop is kept
 * for the recording and the re-check moves the hold to "v". Ticks every 50 ms for 40 s or until
 * the hop is left.
 */
function run(scene: Scene) {
	const voiceHz = LINE_HZ - scene.offsetHz
	const answer: VoiceOnAir = { voice: "v", quietMs: 0, targetHz: voiceHz }
	let clock = 0
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
			recordingActive: (): RecordingActivity =>
				clock < VOICE_END_MS ? answer : false,
		},
	)
	const internals = s as unknown as {
		visit: {
			voiceId: string | null
			heardVoiceId: string | null
			voiceTrackId: string | null
		} | null
	}
	const sighting = (
		trackId: string,
		centreHz: number,
		snrDb: number,
		obwHz: number,
	): TrackSnapshot => ({
		...makeTrack({ id: trackId, centreHz, startedAt: 0, blocks: 8, snrDb }),
		trackId,
		obwHz,
	})
	s.start()
	s.onEpochStarted(0)
	s.onTrack(
		sighting("line", LINE_HZ, 25, scene.lineObwHz ?? LINE_OBW_HZ),
		false,
		0,
		{
			followOnAir: true,
		},
	)
	const commitments: string[] = []
	const named = new Set<string>()
	let leftAt: number | null = null
	for (clock = 50; clock <= 40_000; clock += 50) {
		const actions: SchedulerAction[] = []
		if (clock === 100)
			actions.push(
				...s.onTrack(sighting("v", voiceHz, 15, scene.voiceObwHz), false, 0, {
					followOnAir: true,
				}),
			)
		if (clock === VOICE_END_MS) actions.push(...s.onTrackClosed("v"))
		actions.push(...s.onBlock(clock), ...s.tick(clock))
		const v = internals.visit
		const id = v?.voiceTrackId
		if (id !== null && id !== undefined && commitments.at(-1) !== id)
			commitments.push(id)
		for (const name of [v?.voiceId, v?.heardVoiceId])
			if (name !== null && name !== undefined) named.add(name)
		if (actions.some(a => a.type === "tune")) {
			leftAt = clock
			break
		}
	}
	return { commitments, named, leftAt }
}

describe("a voice heard during a hold of a line its track took in", () => {
	it("a 16 kHz voice track 9.8 kHz from the 7 kHz line (bands overlap, 11 500 Hz ≥ 9800 Hz): never committed to the line, and the voice is named", () => {
		const r = run({ offsetHz: 9_800, voiceObwHz: 16_000 })
		expect(r.commitments.includes("line")).toBe(false)
		expect([...r.named]).toEqual(["v"])
	})

	it("centres 9999 Hz apart (under JOINED_TRACKS_BELOW_HZ, bands overlapping) the line is still no commitment", () => {
		const r = run({ offsetHz: 9_999, voiceObwHz: 16_000 })
		expect(r.commitments.includes("line")).toBe(false)
	})

	it("centres 10 000 Hz apart (JOINED_TRACKS_BELOW_HZ) the voice is a neighbour: the check commits to the held line first", () => {
		const r = run({ offsetHz: 10_000, voiceObwHz: 16_000 })
		expect(r.commitments[0]).toBe("line")
	})

	it("past the overlap bound (11 501 Hz apart) the voice is a neighbour: the check commits to the held line first", () => {
		const r = run({ offsetHz: 11_501, voiceObwHz: 16_000 })
		expect(r.commitments[0]).toBe("line")
	})

	it("a 16 kHz held track and an 11 kHz voice one 12.5 kHz step away (bands overlapping by 1000 Hz) are not joined: the check commits to the held track first", () => {
		const r = run({ offsetHz: 12_500, voiceObwHz: 11_000, lineObwHz: 16_000 })
		expect(r.commitments[0]).toBe("line")
	})

	it("a voice on another channel (11 kHz, 25 kHz away: bands apart): committed to the line first, tentatively (the line's hold is a carrier watch), then to the voice's own track, which is named and held to its end", () => {
		const r = run({ offsetHz: 25_000, voiceObwHz: 11_000 })
		expect(r.commitments).toEqual(["line", "v"])
		expect([...r.named]).toEqual(["v"])
		expect(r.leftAt).not.toBeNull()
		expect(r.leftAt!).toBeGreaterThanOrEqual(VOICE_END_MS)
		expect(r.leftAt!).toBeLessThanOrEqual(VOICE_END_MS + RECHECK_MS)
	})
})
