/**
 * A hold names the transmission on its own frequency (heldVoiceOf): the recorder names the first
 * voiced session of the window (an older one first), so a neighbouring channel already talking
 * when a follow lands is named before the held track's transmission. The scheduler remembers
 * (Visit.heardVoiceId) only the voiced transmission whose session frequency (VoiceOnAir.targetHz)
 * lies within the held track's band, centre ± max(obw / 2, HELD_VOICE_FLOOR_HZ) plus
 * HELD_VOICE_TOLERANCE_HZ (the closest to the centre of several); none there, none is remembered,
 * and no voice hold is named after another (the keep of a hop for its recording and its re-checks
 * name it the same way). Pure matching, the scheduler's record hold, then the deterministic sweep
 * simulator: a 28 s ID with a neighbour 25 kHz up voiced from before the landing.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	simulateSweep,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import { WIDEBAND_JOIN_TOLERANCE_HZ } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	HELD_VOICE_FLOOR_HZ,
	HELD_VOICE_TOLERANCE_HZ,
	heldVoiceOf,
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
const NEIGHBOUR_HZ = TARGET_HZ + 25_000
const OBW_HZ = 11_000
const band = { centreHz: TARGET_HZ, obwHz: OBW_HZ }
/** max(obw / 2, floor) + tolerance: max(5500, 2000) + 3000 = 8500 Hz. */
const REACH_HZ = OBW_HZ / 2 + HELD_VOICE_TOLERANCE_HZ
/** The oracle's reach, stated apart from the code: max(obw / 2, 2000) + 3000. */
const reachOf = (obwHz: number): number => Math.max(obwHz / 2, 2_000) + 3_000

const voice = (name: string, hz?: number): VoiceOnAir => ({
	voice: name,
	quietMs: 0,
	...(hz === undefined ? {} : { targetHz: hz }),
})
const listing = (...entries: VoiceOnAir[]): VoiceOnAir => ({
	...entries[0]!,
	transmissions: Object.fromEntries(entries.map(e => [e.voice, e])),
})

describe("heldVoiceOf names the held track's own transmission", () => {
	it("the tolerance is 8000 − 5000 Hz (channel cutoff less NFM deviation)", () => {
		expect(HELD_VOICE_TOLERANCE_HZ).toBe(8_000 - 5_000)
		expect(REACH_HZ).toBe(8_500)
	})

	it("the floor makes any track's reach the recorder's join tolerance: 2000 + 3000 = 5000 Hz", () => {
		expect(HELD_VOICE_FLOOR_HZ).toBe(2_000)
		expect(HELD_VOICE_FLOOR_HZ + HELD_VOICE_TOLERANCE_HZ).toBe(
			WIDEBAND_JOIN_TOLERANCE_HZ,
		)
	})

	it("a narrow track (3 kHz) recorded by a session joined 4 to 5 kHz off: matched at and inside 5000 Hz, not 1 Hz past; never the next 12.5 kHz channel", () => {
		const narrow = { centreHz: TARGET_HZ, obwHz: 3_000 }
		// Without the floor its reach would be 1500 + 3000 = 4500 Hz.
		for (const off of [4_000, 4_500, 4_501, 5_000, -5_000])
			expect(heldVoiceOf(voice("t", TARGET_HZ + off), narrow)?.voice).toBe("t")
		expect(heldVoiceOf(voice("t", TARGET_HZ + 5_001), narrow)).toBeNull()
		expect(heldVoiceOf(voice("t", TARGET_HZ - 5_001), narrow)).toBeNull()
		expect(heldVoiceOf(voice("n", TARGET_HZ + 12_500), narrow)).toBeNull()
		// A zero-width reading too.
		const point = { centreHz: TARGET_HZ, obwHz: 0 }
		expect(heldVoiceOf(voice("t", TARGET_HZ + 5_000), point)?.voice).toBe("t")
		expect(heldVoiceOf(voice("t", TARGET_HZ + 5_001), point)).toBeNull()
	})

	it("a wide merged track (20 kHz) reaching the next channel: the entry closest to its centre, whatever the order", () => {
		const wide = { centreHz: TARGET_HZ, obwHz: 20_000 }
		// Reach max(10 000, 2000) + 3000 = 13 000 Hz: the next 12.5 kHz channel lies inside it.
		expect(reachOf(wide.obwHz)).toBe(13_000)
		const n = voice("n", TARGET_HZ + 12_500)
		const t = voice("t", TARGET_HZ + 1_000)
		expect(heldVoiceOf(listing(n, t), wide)?.voice).toBe("t")
		expect(heldVoiceOf(listing(t, n), wide)?.voice).toBe("t")
		// Below the centre too, and the neighbour alone still matches a band that reaches it.
		const m = voice("m", TARGET_HZ - 12_000)
		expect(heldVoiceOf(listing(n, m, t), wide)?.voice).toBe("t")
		expect(heldVoiceOf(n, wide)?.voice).toBe("n")
		// A tie: the answer's own first, then the list's order.
		const a = voice("a", TARGET_HZ + 2_000)
		const b = voice("b", TARGET_HZ - 2_000)
		expect(heldVoiceOf(listing(a, b), wide)?.voice).toBe("a")
		expect(heldVoiceOf(listing(b, a), wide)?.voice).toBe("b")
		expect(heldVoiceOf({ ...n, transmissions: { b, a } }, wide)?.voice).toBe(
			"b",
		)
	})

	it("a neighbour named first and the target listed second: the target", () => {
		const a = listing(voice("n", NEIGHBOUR_HZ), voice("t", TARGET_HZ))
		expect(heldVoiceOf(a, band)?.voice).toBe("t")
	})

	it("the target named first: the target", () => {
		const a = listing(voice("t", TARGET_HZ), voice("n", NEIGHBOUR_HZ))
		expect(heldVoiceOf(a, band)?.voice).toBe("t")
	})

	it("the neighbour only, alone or listed: none", () => {
		expect(heldVoiceOf(voice("n", NEIGHBOUR_HZ), band)).toBeNull()
		expect(
			heldVoiceOf(
				{
					...voice("n", NEIGHBOUR_HZ),
					transmissions: { q: "quiet", u: "unrecorded" },
				},
				band,
			),
		).toBeNull()
	})

	it("at the band's edge plus the tolerance: matched; 1 Hz past it: not, on either side", () => {
		expect(heldVoiceOf(voice("t", TARGET_HZ + REACH_HZ), band)?.voice).toBe("t")
		expect(heldVoiceOf(voice("t", TARGET_HZ - REACH_HZ), band)?.voice).toBe("t")
		expect(heldVoiceOf(voice("t", TARGET_HZ + REACH_HZ + 1), band)).toBeNull()
		expect(heldVoiceOf(voice("t", TARGET_HZ - REACH_HZ - 1), band)).toBeNull()
		// The next 12.5 kHz channel never matches a voice track's band.
		expect(heldVoiceOf(voice("n", TARGET_HZ + 12_500), band)).toBeNull()
	})

	it("unknown or malformed: no frequency, a non-finite one, a malformed band, no match", () => {
		expect(heldVoiceOf(voice("t"), band)).toBeNull()
		expect(heldVoiceOf(voice("t", Number.NaN), band)).toBeNull()
		expect(heldVoiceOf(voice("t", Number.POSITIVE_INFINITY), band)).toBeNull()
		const t = voice("t", TARGET_HZ)
		expect(heldVoiceOf(t, { centreHz: Number.NaN, obwHz: OBW_HZ })).toBeNull()
		expect(
			heldVoiceOf(t, { centreHz: TARGET_HZ, obwHz: Number.NaN }),
		).toBeNull()
		expect(heldVoiceOf(t, { centreHz: TARGET_HZ, obwHz: -1 })).toBeNull()
		// A listed entry that is not voice names nothing, nor does a malformed one.
		const odd = {
			...voice("n", NEIGHBOUR_HZ),
			transmissions: {
				x: { voice: 7, targetHz: TARGET_HZ } as unknown as VoiceOnAir,
				q: "quiet" as const,
			},
		}
		expect(heldVoiceOf(odd, band)).toBeNull()
	})

	// Feature: scanner sweep holds, Property 1: a hold names only a transmission of its own band, the closest to its centre
	// Validates: docs/SCANNER.md § Sweep, Recording ("A hold follows the transmission on its own frequency")
	it("whatever the order of the list, the match lies within the band, and it is the one closest to the centre", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: -60_000, max: 60_000 }), {
					minLength: 1,
					maxLength: 6,
				}),
				fc.integer({ min: 0, max: 30_000 }),
				(offsets, obwHz) => {
					const entries = offsets.map((o, i) => voice(`v${i}`, TARGET_HZ + o))
					const a = listing(...entries)
					const b = { centreHz: TARGET_HZ, obwHz }
					const reach = reachOf(obwHz)
					const got = heldVoiceOf(a, b)
					const inside = offsets.filter(o => Math.abs(o) <= reach)
					expect(got !== null).toBe(inside.length > 0)
					if (got !== null) {
						const off = Math.abs(got.targetHz! - TARGET_HZ)
						expect(off).toBeLessThanOrEqual(reach)
						expect(off).toBe(Math.min(...inside.map(o => Math.abs(o))))
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

/**
 * A hop kept for its recording at the dwell's end (keepForRecording), its track at TARGET_HZ, while
 * the recorder answers `recording(clock)`: 2 hops of 1150 ms (L = 19 550 ms), one track "a"
 * neither probed nor followed, so the keep is the visit's first hold (from 150 ms).
 */
function recordHold(recording: (ms: number) => RecordingActivity) {
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
		visit: { voice: string; voiceId: string | null } | null
	}
	const named = new Set<string>()
	const note = (): void => {
		const id = internals.visit?.voiceId
		if (id !== null && id !== undefined) named.add(id)
	}
	const sighting: TrackSnapshot = {
		...makeTrack({ id: "a", centreHz: TARGET_HZ, startedAt: 0 }),
		trackId: "a",
		obwHz: OBW_HZ,
	}
	s.start()
	s.onEpochStarted(0)
	s.onTrack(sighting, false, 0)
	const tunes = (a: SchedulerAction[]): boolean =>
		a.some(x => x.type === "tune")
	for (let e = 50; e <= 150; e += 50) {
		clock = e
		if (tunes(s.onBlock(e))) throw new Error("left at the dwell")
		note()
	}
	return {
		named,
		/** Clock of the first tune, ticking every 50 ms up to `until`; null if none. */
		leftAt(until: number): number | null {
			for (clock = 200; clock <= until; clock += 50) {
				const left = tunes(s.tick(clock))
				note()
				if (left) return clock
			}
			return null
		},
	}
}

/** L on 2 hops (docs/SCANNER.md, Fair holds): 28 000 − 3450 − 5000. */
const L2 = 19_550
const KEPT_AT = 150

describe("a hop kept for its recording names no voice hold after a neighbour", () => {
	const n = voice("n", NEIGHBOUR_HZ)

	it("the ID refused a slot (only the neighbour voiced in the window): kept as a recording that is not voice, left at L, the neighbour never named", () => {
		// The neighbour talks from before the keep to 40 s: named after it, the hold would run
		// to 40 s (past L), and end with the neighbour's over.
		const h = recordHold(ms => (ms < 40_000 ? n : false))
		expect(h.leftAt(70_000)).toBe(KEPT_AT + L2)
		expect([...h.named]).toEqual([])
	})

	it("the ID not voiced yet at the keep: its voice hold starts once it voices, under its own name, and outlasts the neighbour's over", () => {
		// Neighbour 0 to 8 s; the ID voiced from 3 s to 30 s (listed after the neighbour while both
		// talk). Named after the neighbour at the keep, the hold was spent at 8 s and cut at L.
		const id = voice("id", TARGET_HZ)
		const h = recordHold(ms =>
			ms < 3_000 ? n : ms < 8_000 ? listing(n, id) : ms < 30_000 ? id : false,
		)
		const left = h.leftAt(70_000)
		expect(left).not.toBeNull()
		expect(left!).toBeGreaterThan(KEPT_AT + L2)
		expect(left!).toBeGreaterThanOrEqual(30_000)
		expect(left!).toBeLessThanOrEqual(30_000 + 250)
		expect([...h.named]).toEqual(["id"])
	})

	it("an answer with no frequency names no voice hold either: left at L", () => {
		const h = recordHold(ms => (ms < 40_000 ? voice("x") : false))
		expect(h.leftAt(70_000)).toBe(KEPT_AT + L2)
		expect([...h.named]).toEqual([])
	})

	it("the ID's own answer at the keep: its voice hold, to its end past L", () => {
		const h = recordHold(ms =>
			ms < 30_000 ? listing(n, voice("id", TARGET_HZ + 4_000)) : false,
		)
		const left = h.leftAt(70_000)!
		expect(left).toBeGreaterThanOrEqual(30_000)
		expect(left).toBeLessThanOrEqual(30_000 + 250)
		expect([...h.named]).toEqual(["id"])
	})
})

/**
 * A hop kept for its recording when its watch of track "a" (TARGET_HZ) ends, with a voiced
 * neighbour "b" (NEIGHBOUR_HZ, analog voice, already tried) open in the window. By the keep,
 * "a" is no longer one recordedTrack would report (`how`: it earned carrier evidence during the
 * watch, or was reclassed as no analog voice), so the recording is reported on "b"; the voice
 * hold is still named by "a"'s band (voiceBandOf), never after "b". The recorder answers the
 * neighbour's voice to 40 s.
 */
function keptBesideNeighbour(how: "carrier" | "unclassed") {
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
			recordingActive: () =>
				clock < 40_000 ? voice("n", NEIGHBOUR_HZ) : false,
		},
	)
	const internals = s as unknown as {
		visit: {
			voiceId: string | null
			tracks: Map<string, { tried: boolean }>
		} | null
		hold: { trackId: string; mode: string } | null
		memory: { centreHz: number; evidence: string }[]
	}
	const sighting = (
		trackId: string,
		centreHz: number,
		snrDb: number,
	): TrackSnapshot => ({
		...makeTrack({ id: trackId, centreHz, startedAt: 0, blocks: 8, snrDb }),
		trackId,
		obwHz: OBW_HZ,
	})
	const tunes = (a: SchedulerAction[]): boolean =>
		a.some(x => x.type === "tune")
	s.start()
	s.onEpochStarted(0)
	s.onTrack(sighting("a", TARGET_HZ, 25), false, 0, { followOnAir: true })
	s.onTrack(sighting("b", NEIGHBOUR_HZ, 15), false, 0, { followOnAir: true })
	// "b" was held already: no follow of its own in this visit, only the recording's report.
	internals.visit!.tracks.get("b")!.tried = true
	const named = new Set<string>()
	const reported = new Set<string>()
	let leftAt: number | null = null
	for (clock = 50; clock <= 70_000 && leftAt === null; clock += 50) {
		if (clock === 1_150) {
			expect(internals.hold?.trackId).toBe("a")
			if (how === "carrier")
				internals.memory.find(m => m.centreHz === TARGET_HZ)!.evidence =
					"carrier"
			else s.onTrack(sighting("a", TARGET_HZ, 25), false, 0)
		}
		if (tunes([...s.onBlock(clock), ...s.tick(clock)])) leftAt = clock
		const id = internals.visit?.voiceId
		if (id !== null && id !== undefined) named.add(id)
		if (internals.hold?.mode === "record") reported.add(internals.hold.trackId)
	}
	return { leftAt, named, reported }
}

describe("a hop kept while its held track reads as no voice of its own names no voice hold after the neighbour the recording is reported on", () => {
	for (const how of ["carrier", "unclassed"] as const)
		it(`the held track ${how === "carrier" ? "earned carrier evidence" : "was reclassed"}: kept within L on the neighbour's report, never named after it`, () => {
			const r = keptBesideNeighbour(how)
			expect([...r.reported]).toEqual(["b"])
			expect([...r.named]).toEqual([])
			// Named after the neighbour, the hold would run to its over's end at 40 s.
			expect(r.leftAt).not.toBeNull()
			expect(r.leftAt!).toBeLessThanOrEqual(KEPT_AT + L2)
		})
})

const MHZ = 1_000_000
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const HOPS = 3
const plan = makeHopPlan(
	Array.from({ length: HOPS }, (_, i) => 150 * MHZ + i * 800_000),
	409_600,
)
const spec = makeNormalisedSpec({
	dwellMs: SETTLE_MS + 3 * BLOCK_MS,
	settleMs: SETTLE_MS,
})
const LAST = HOPS - 1
const ID_FROM = 30_000
const ID_MS = 28_000
const id: SimSignal = {
	centreHz: plan.hops[LAST]!.centreHz + 100_000,
	startMs: ID_FROM,
	endMs: ID_FROM + ID_MS,
	snrDb: 21,
	needsConfirm: true,
	confirmHoldMs: 1_800,
	followOnAir: true,
}
/** The neighbour's overs: 3 s on, 3 s off, from 6 s before the ID to its end. */
const NEIGHBOUR = Array.from({ length: 6 }, (_, k) => ({
	from: ID_FROM - 6_000 + 6_000 * k,
	to: ID_FROM - 3_000 + 6_000 * k,
}))
const VOICED_AFTER_MS = 1_500

/**
 * The real recorder's answer for the last hop's window: the neighbour's session (opened earlier)
 * first, then the ID's, each with its own `targetHz` (or none, `withHz` false), and the list when
 * two are voiced.
 */
function recorder(withHz: boolean) {
	const hzOf = (hz: number): number | undefined => (withHz ? hz : undefined)
	return (c: number, hop: number | null): RecordingActivity => {
		if (hop !== LAST) return false
		const voiced: VoiceOnAir[] = []
		NEIGHBOUR.forEach((o, k) => {
			if (c >= o.from && c < o.to)
				voiced.push(voice(`n${k}`, hzOf(id.centreHz + 25_000)))
		})
		if (c >= id.startMs + VOICED_AFTER_MS && c < id.endMs)
			voiced.push(voice("id", hzOf(id.centreHz)))
		const first = voiced[0]
		if (first === undefined) return false
		if (voiced.length < 2) return first
		return listing(...voiced)
	}
}

function run(withHz: boolean) {
	const r = simulateSweep(plan, spec, {
		settleMs: SETTLE_MS,
		blockMs: BLOCK_MS,
		minSurfaceBlocks: 2,
		probeStartMs: 300,
		durationMs: ID_FROM + 60_000,
		signals: [id],
		recordingActive: recorder(withHz),
	})
	const held = r.visits.filter(
		v =>
			v.hopIndex === LAST && v.leftAtMs > id.startMs && v.tunedAtMs < id.endMs,
	)
	return { heardMs: r.heardMs[0] ?? 0, held }
}

describe("a follow landing while a neighbour talks holds the ID, not the neighbour", () => {
	it("named by frequency: the ID is held to its end in one visit, through the neighbour's overs", () => {
		const { heardMs, held } = run(true)
		const last = held.at(-1)!
		expect(last.leftAtMs).toBeGreaterThanOrEqual(id.endMs)
		for (const o of NEIGHBOUR)
			expect(
				held.some(v => v.leftAtMs > o.from && v.leftAtMs < o.to + 300),
			).toBe(false)
		expect(heardMs).toBeGreaterThanOrEqual(26_000)
	})

	it("no frequency in the answers (targetHz missing): nothing is named, so no voice hold: every visit of the ID's hop is cut at L, never held to the ID's end", () => {
		// L on 3 hops (docs/SCANNER.md, Fair holds): 28 000 − 4600 − 5000 = 18 400 ms, after the dwell.
		const L3 = 18_400
		const named = run(true)
		const { heardMs, held } = run(false)
		expect(held.length).toBeGreaterThan(0)
		for (const v of held)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(spec.dwellMs + L3)
		expect(
			held.some(
				v => v.leftAtMs >= id.endMs && v.tunedAtMs <= id.startMs + 2_000,
			),
		).toBe(false)
		expect(heardMs).toBeLessThan(named.heardMs)
	})
})
