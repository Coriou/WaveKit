/**
 * A visit names its transmission after the track it committed to (Visit.voiceTrackId), not after
 * the track a later hold sits on. A hop kept for its recording of track "a" (the ID, TARGET_HZ) is
 * re-checked; a neighbour "b" 25 kHz below qualifies meanwhile, so the re-check follows it
 * (recheckRecording, nextCandidate) and the hold moves to "b". The recorder answers the neighbour's
 * voice first (its session opened earlier) and the ID's own only once the ID voices, after the
 * move. Named after the track held at the first voice answer, the visit adopted the neighbour's
 * over and ended at its end, the ID cut; named after the committed track, the neighbour is never
 * the visit's transmission, its end (the recorder's `voiceEnded` of its frequency, or its listing
 * gone) never ends the hold, and the ID gets its voice hold once it voices, to its end.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	HELD_VOICE_TOLERANCE_HZ,
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

const TARGET_HZ = 150_100_000
const NEIGHBOUR_HZ = TARGET_HZ - 25_000
const OBW_HZ = 11_000
/** The ID's reach: obw / 2 + tolerance = 5500 + 3000 = 8500 Hz; a neighbour must lie past it. */
const REACH_HZ = OBW_HZ / 2 + HELD_VOICE_TOLERANCE_HZ
/** The ID keys before the visit and is voiced (answered) from ID_VOICED_MS to ID_END_MS. */
const ID_VOICED_MS = 3_000
const ID_END_MS = 30_000
/** The neighbour's over, voiced from before the landing. */
const NEIGHBOUR_END_MS = 8_000
/** When the neighbour's track qualifies in the visit: after the keep, before the ID voices. */
const NEIGHBOUR_SEEN_MS = 1_000
/** L on 2 hops (docs/SCANNER.md, Fair holds): 28 000 − 3450 − 5000. */
const L2 = 19_550
const KEPT_AT = 150
/** A voice hold's end is seen at its next re-check (RECORD_RECHECK_MS) or sampled ask. */
const RECHECK_MS = 250

const voice = (name: string, hz: number): VoiceOnAir => ({
	voice: name,
	quietMs: 0,
	targetHz: hz,
})
const listing = (...entries: VoiceOnAir[]): VoiceOnAir => ({
	...entries[0]!,
	transmissions: Object.fromEntries(entries.map(e => [e.voice, e])),
})

interface Scene {
	/** The neighbour's frequency. */
	neighbourHz?: number
	/** When the neighbour's track qualifies. */
	seenMs?: number
	/** When the ID voices. */
	voicedMs?: number
	/** The neighbour's over ends as a `voiceEnded` of its frequency (its reply joined), not by a gone listing. */
	endedAnswer?: boolean
	/**
	 * The ID's track is followed (analog voice) from the dwell's end, and the hold is moved to the
	 * neighbour's track while that follow runs, as a re-check's move does (endHold, then startHold
	 * of the neighbour), right after the neighbour qualifies. A follow chains no other track itself,
	 * so the move is forced: what is under test is the commit by the follow's first recording check.
	 */
	followedFirst?: boolean
}

/**
 * Two hops of 1150 ms. Track "a" (the ID) is in the window from the start; the neighbour "b"
 * qualifies at `seenMs`, analog voice, untried; it closes at its over's end. Ticks every 50 ms.
 */
function movedHold(scene: Scene = {}) {
	const neighbourHz = scene.neighbourHz ?? NEIGHBOUR_HZ
	const seenMs = scene.seenMs ?? NEIGHBOUR_SEEN_MS
	const voicedMs = scene.voicedMs ?? ID_VOICED_MS
	const n = voice("n", neighbourHz)
	const id = voice("id", TARGET_HZ)
	const recording = (ms: number): RecordingActivity => {
		if (ms < NEIGHBOUR_END_MS)
			return ms < voicedMs ? listing(n) : listing(n, id)
		if (ms < NEIGHBOUR_END_MS + 500 && scene.endedAnswer === true)
			return {
				recording: true,
				voiceEnded: true,
				targetHz: neighbourHz,
				transmissions: ms < voicedMs ? {} : { id },
			}
		return ms < voicedMs ? true : ms < ID_END_MS ? id : false
	}
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
			recordingActive: () => recording(clock),
		},
	)
	const internals = s as unknown as {
		visit: {
			voiceId: string | null
			heardVoiceId: string | null
			voiceTrackId: string | null
		} | null
		hold: { trackId: string; mode: string } | null
		endHold(evidence: boolean): void
		startHold(c: {
			id: string
			t: unknown
			kind: "confirm" | "follow"
		}): SchedulerAction[]
	}
	const tracksOf = (): Map<string, unknown> =>
		(s as unknown as { visit: { tracks: Map<string, unknown> } }).visit.tracks
	const sighting = (trackId: string, centreHz: number, snrDb: number) =>
		({
			...makeTrack({ id: trackId, centreHz, startedAt: 0, blocks: 8, snrDb }),
			trackId,
			obwHz: OBW_HZ,
		}) satisfies TrackSnapshot
	const tunes = (a: SchedulerAction[]): boolean =>
		a.some(x => x.type === "tune")
	s.start()
	s.onEpochStarted(0)
	s.onTrack(
		sighting("a", TARGET_HZ, 25),
		false,
		0,
		scene.followedFirst === true ? { followOnAir: true } : {},
	)
	const named = new Set<string>()
	const heldOn = new Set<string>()
	let leftAt: number | null = null
	for (clock = 50; clock <= 70_000 && leftAt === null; clock += 50) {
		const actions: SchedulerAction[] = []
		if (clock === seenMs)
			actions.push(
				...s.onTrack(sighting("b", neighbourHz, 15), false, 0, {
					followOnAir: true,
				}),
			)
		if (
			scene.followedFirst === true &&
			clock === seenMs + 50 &&
			internals.hold?.trackId === "a" &&
			internals.hold.mode === "follow"
		) {
			internals.endHold(false)
			actions.push(
				...internals.startHold({
					id: "b",
					t: tracksOf().get("b"),
					kind: "follow",
				}),
			)
		}
		if (clock === NEIGHBOUR_END_MS) actions.push(...s.onTrackClosed("b"))
		actions.push(...s.onBlock(clock), ...s.tick(clock))
		if (tunes(actions)) leftAt = clock
		const v = internals.visit
		for (const name of [v?.voiceId, v?.heardVoiceId])
			if (name !== null && name !== undefined) named.add(name)
		if (internals.hold !== null) heldOn.add(internals.hold.trackId)
	}
	return { leftAt, named, heldOn }
}

describe("a hold moved to a neighbour's track names the visit's transmission after the committed track", () => {
	it("the neighbour first in every answer, the ID voiced after the move: never named after the neighbour, held to the ID's end", () => {
		const h = movedHold()
		// The re-check moved the hold to the neighbour's track.
		expect([...h.heldOn].sort()).toEqual(["a", "b"])
		expect([...h.named]).toEqual(["id"])
		// Past the neighbour's end and past L: the ID's own end, seen at its next re-check.
		expect(h.leftAt).not.toBeNull()
		expect(h.leftAt!).toBeGreaterThan(KEPT_AT + L2)
		expect(h.leftAt!).toBeGreaterThanOrEqual(ID_END_MS)
		expect(h.leftAt!).toBeLessThanOrEqual(ID_END_MS + RECHECK_MS)
	})

	it("the neighbour's end read as the recorder's `voiceEnded` of its frequency: no end of the committed track's hold", () => {
		const h = movedHold({ endedAnswer: true })
		expect(h.heldOn.has("b")).toBe(true)
		expect([...h.named]).toEqual(["id"])
		expect(h.leftAt!).toBeGreaterThanOrEqual(ID_END_MS)
		expect(h.leftAt!).toBeLessThanOrEqual(ID_END_MS + RECHECK_MS)
	})

	it("the ID followed as analog voice, the hold moved during that follow: the follow's first recording check committed the visit to the ID", () => {
		const h = movedHold({ followedFirst: true })
		expect(h.heldOn.has("b")).toBe(true)
		expect([...h.named]).toEqual(["id"])
		expect(h.leftAt!).toBeGreaterThanOrEqual(ID_END_MS)
		expect(h.leftAt!).toBeLessThanOrEqual(ID_END_MS + RECHECK_MS)
	})

	it("the ID never voices: the neighbour is still never named, and the hop is left within L", () => {
		const h = movedHold({ voicedMs: 70_000 })
		expect(h.heldOn.has("b")).toBe(true)
		expect([...h.named]).toEqual([])
		expect(h.leftAt).not.toBeNull()
		expect(h.leftAt!).toBeLessThanOrEqual(KEPT_AT + L2)
	})

	it("whatever the neighbour's offset past the ID's reach and when it qualifies before the ID voices, only the ID is named and it is held to its end", () => {
		// Feature: scanner sweep, Property: a moved hold names the committed track's transmission
		// Validates: a neighbour's end never ends the committed track's hold
		fc.assert(
			fc.property(
				fc.integer({ min: REACH_HZ + 1, max: 60_000 }),
				fc.boolean(),
				fc.integer({ min: 4, max: Math.floor(ID_VOICED_MS / 50) - 1 }),
				fc.boolean(),
				(off, below, step, ended) => {
					const h = movedHold({
						neighbourHz: TARGET_HZ + (below ? -off : off),
						seenMs: step * 50,
						endedAnswer: ended,
					})
					expect([...h.named]).toEqual(["id"])
					expect(h.leftAt!).toBeGreaterThanOrEqual(ID_END_MS)
					expect(h.leftAt!).toBeLessThanOrEqual(ID_END_MS + RECHECK_MS)
				},
			),
			{ numRuns: 100 },
		)
	})
})
