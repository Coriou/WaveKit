/**
 * A first track that never voices must not cut a lone voice beside it. Two hops of 1150 ms, ticks
 * every 50 ms. Track "a" lies 25 kHz below the voice, 25 dB, in the window from the visit's start,
 * and never voices; the recorder answers the voice "id" at TARGET_HZ from the start to ID_END_MS;
 * the voice's own track "b" (analog voice) qualifies at `bAt`, open to ID_END_MS. The visit
 * commits its voice to "a" only when "a" can be analog voice, and that commitment passes to "b"
 * once "a" showed none of its own (a watch run to its cap, or a close past a turnaround with no
 * successor): either way "id" is named and held to its end, as before commitments existed.
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
/** COMMITTED_CLOSED_LAPSE_MS: 2 × TRAFFIC_GAP_MS. */
const LAPSE_MS = 2_000

interface Scene {
	/** When "b" qualifies, from the landing (1000 ms when absent). */
	bAt?: number
	/** "a" closes for good this long after the landing. */
	aClosesAt?: number
	/** "a"'s hints (none when absent: a steady line, never labelled). */
	aHints?: TrackHints
	/** "a" needs a decoder's confirm (a probe first), which never decodes. */
	aConfirm?: boolean
	/**
	 * "a" first appears on the hop's second visit (a full visit missed it: its onset was seen),
	 * the landing that visit's epoch.
	 */
	late?: boolean
	/** Called each tick from the landing on, before its block, with the clock from the landing. */
	during?: (s: SweepScheduler, rel: number) => void
}

function run(scene: Scene) {
	const id = { voice: "id", quietMs: 0, targetHz: TARGET_HZ }
	const listing = { ...id, transmissions: { id } }
	let clock = 0
	let landing: number | null = scene.late === true ? null : 0
	const rel = (): number => (landing === null ? -1 : clock - landing)
	const recording = (): RecordingActivity =>
		rel() >= 0 && rel() < ID_END_MS ? listing : false
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
		visit: { voiceId: string | null; heardVoiceId: string | null } | null
		hold: { trackId: string; mode: string } | null
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
	let hop = 0
	let settleAt: number | null = null
	let tunes = 0
	let leftAt: number | null = null
	const apply = (actions: SchedulerAction[]): void => {
		for (const a of actions) {
			if (a.type !== "tune") continue
			hop = a.hopIndex
			settleAt = clock + 1_000
			tunes++
			if (landing !== null && rel() > 0) leftAt ??= rel()
		}
	}
	const addA = (): SchedulerAction[] =>
		s.onTrack(
			sighting("a", OTHER_HZ, 25),
			scene.aConfirm === true,
			scene.aConfirm === true ? 1_000 : 0,
			scene.aHints ?? {},
		)
	s.start()
	s.onEpochStarted(0)
	if (landing === 0) apply(addA())
	const named = new Set<string>()
	const held = new Set<string>()
	for (clock = 50; clock <= 200_000 && leftAt === null; clock += 50) {
		if (settleAt !== null) {
			if (clock < settleAt) continue
			settleAt = null
			apply(s.onEpochStarted(clock))
			if (landing === null && hop === 0 && tunes >= 2) {
				landing = clock
				apply(addA())
			}
			continue
		}
		if (rel() === (scene.bAt ?? 1_000))
			apply(
				s.onTrack(sighting("b", TARGET_HZ, 15), false, 0, {
					followOnAir: true,
				}),
			)
		if (scene.aClosesAt !== undefined && rel() === scene.aClosesAt)
			apply(s.onTrackClosed("a"))
		if (rel() === ID_END_MS) apply(s.onTrackClosed("b"))
		if (landing !== null) scene.during?.(s, rel())
		apply(s.onBlock(clock))
		apply(s.tick(clock))
		if (landing === null) continue
		const v = internals.visit
		for (const name of [v?.voiceId, v?.heardVoiceId])
			if (name !== null && name !== undefined) named.add(name)
		if (internals.hold !== null)
			held.add(`${internals.hold.trackId}:${internals.hold.mode}`)
	}
	return { leftAt, named: [...named], held }
}

/** The voice is named and the hop held to its end, seen at the next re-check. */
function heldToItsEnd(h: ReturnType<typeof run>): void {
	expect(h.named).toEqual(["id"])
	expect(h.leftAt).not.toBeNull()
	expect(h.leftAt!).toBeGreaterThan(L2)
	expect(h.leftAt!).toBeGreaterThanOrEqual(ID_END_MS)
	expect(h.leftAt!).toBeLessThanOrEqual(ID_END_MS + RECHECK_MS)
}

describe("a first track that never voices does not cut a lone voice beside it", () => {
	it("a steady line, never labelled and never held but for the recording's keep: no commitment, the voice named and held to its end", () => {
		const h = run({})
		expect(h.held.has("a:record")).toBe(true)
		expect(h.held.has("b:follow")).toBe(true)
		heldToItsEnd(h)
	})

	it("the same line closing for good at 2 s: the voice named and held to its end", () => {
		heldToItsEnd(run({ aClosesAt: 2_000 }))
	})

	it("a line that needs a confirm, never decoded (probed, then followed): the voice named and held to its end", () => {
		const h = run({ aConfirm: true })
		expect(h.held.has("a:confirm")).toBe(true)
		expect(h.held.has("a:follow")).toBe(true)
		heldToItsEnd(h)
	})

	it("an analog-labelled track, followed, closing for good at 5 s: the commitment lapses past the turnaround bound and passes to the voice's own track", () => {
		const h = run({ aHints: { followOnAir: true }, aClosesAt: 5_000 })
		expect(h.held.has("a:follow")).toBe(true)
		heldToItsEnd(h)
	})

	it("an analog-labelled track, steady (its full 8 s watch): the voice named and held to its end", () => {
		heldToItsEnd(run({ aHints: { followOnAir: true } }))
	})

	it("a probed line closing at 3 s: the voice named and held to its end", () => {
		const h = run({ aConfirm: true, aClosesAt: 3_000 })
		expect(h.held.has("a:hang")).toBe(true)
		heldToItsEnd(h)
	})

	it("the voice's own track qualifies before any hold moves (100 ms in), beside an analog-labelled track: the voice named and held to its end", () => {
		heldToItsEnd(run({ aHints: { followOnAir: true }, bAt: 100 }))
	})

	it("the voice's own track qualifies before any hold moves (100 ms in), beside a steady line: the voice named and held to its end", () => {
		heldToItsEnd(run({ bAt: 100 }))
	})

	it("an analog-labelled track whose onset a visit saw (a watch to its cap, not read as a carrier): the watch run to its cap makes the commitment tentative, and the voice's own track takes it", () => {
		const h = run({ aHints: { followOnAir: true }, late: true })
		expect(h.held.has("a:follow")).toBe(true)
		heldToItsEnd(h)
	})

	it("COMMITTED_CLOSED_LAPSE_MS (2000 ms): a never-voiced commitment to a track closed one block short (1950 ms) is firm, at 2000 ms it lapses", () => {
		const closeAt = 5_000
		const seen: Record<number, boolean> = {}
		run({
			aHints: { followOnAir: true },
			aClosesAt: closeAt,
			during: (s, rel) => {
				const x = s as unknown as {
					visit: {
						voiceTrackId: string | null
						tracks: Map<string, unknown>
					} | null
					committedLapsed(v: unknown, t: unknown, now: number): boolean
				}
				const v = x.visit
				if (v === null || v.voiceTrackId !== "a") return
				const t = v.tracks.get("a")
				// The landing is at clock 0, so `rel` is the clock.
				if (rel === closeAt + LAPSE_MS - 50)
					seen[LAPSE_MS - 50] = x.committedLapsed(v, t, rel)
				if (rel === closeAt + LAPSE_MS)
					seen[LAPSE_MS] = x.committedLapsed(v, t, rel)
			},
		})
		expect(seen).toEqual({ [LAPSE_MS - 50]: false, [LAPSE_MS]: true })
	})

	it("a check is judged at its own clock: asked 1950 ms after the close but run once the clock passed 2000 ms, the commitment is firm", () => {
		const closeAt = 5_000
		const seen: boolean[] = []
		run({
			aHints: { followOnAir: true },
			aClosesAt: closeAt,
			during: (s, rel) => {
				const x = s as unknown as {
					now: () => number
					visit: {
						voiceTrackId: string | null
						tracks: Map<string, unknown>
					} | null
					committedLapsed(v: unknown, t: unknown, now: number): boolean
				}
				const v = x.visit
				if (v === null || v.voiceTrackId !== "a") return
				if (rel !== closeAt + LAPSE_MS - 50) return
				// The scheduler's clock already 500 ms past the bound while the check asked at 1950 ms.
				const own = x.now
				x.now = () => closeAt + LAPSE_MS + 500
				try {
					const t = v.tracks.get("a")
					seen.push(
						x.committedLapsed(v, t, rel),
						x.committedLapsed(v, t, closeAt + LAPSE_MS + 500),
					)
				} finally {
					x.now = own
				}
			},
		})
		expect(seen).toEqual([false, true])
	})
})
