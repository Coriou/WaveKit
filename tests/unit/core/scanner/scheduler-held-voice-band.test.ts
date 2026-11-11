/**
 * A hold names the transmission on its own frequency (heldVoiceOf): the recorder names the first
 * voiced session of the window (an older one first), so a neighbouring channel already talking
 * when a follow lands is named before the held track's transmission. The scheduler remembers
 * (Visit.heardVoiceId) only the voiced transmission whose session frequency (VoiceOnAir.targetHz)
 * lies within the held track's band, centre ± obw / 2 plus HELD_VOICE_TOLERANCE_HZ; none there,
 * none is remembered. Pure matching, then the deterministic sweep simulator: a 28 s ID with a
 * neighbour 25 kHz up voiced from before the landing.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	simulateSweep,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import {
	HELD_VOICE_TOLERANCE_HZ,
	heldVoiceOf,
	type RecordingActivity,
	type VoiceOnAir,
} from "../../../../src/core/scanner/scheduler.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

const TARGET_HZ = 150_100_000
const NEIGHBOUR_HZ = TARGET_HZ + 25_000
const OBW_HZ = 11_000
const band = { centreHz: TARGET_HZ, obwHz: OBW_HZ }
/** obw / 2 + tolerance: 5500 + 3000 = 8500 Hz. */
const REACH_HZ = OBW_HZ / 2 + HELD_VOICE_TOLERANCE_HZ

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

	// Feature: scanner sweep holds, Property 1: a hold names only a transmission of its own band
	// Validates: a follow landing while a neighbour talks records the held transmission
	it("whatever the order of the list, the match lies within the band, and one within it is found", () => {
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
					const reach = obwHz / 2 + HELD_VOICE_TOLERANCE_HZ
					const got = heldVoiceOf(a, b)
					const inside = offsets.some(o => Math.abs(o) <= reach)
					expect(got !== null).toBe(inside)
					if (got !== null)
						expect(Math.abs(got.targetHz! - TARGET_HZ)).toBeLessThanOrEqual(
							reach,
						)
				},
			),
			{ numRuns: 200 },
		)
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
})
