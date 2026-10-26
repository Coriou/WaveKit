import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	AMBIENT_CHANNEL_WIDTH_HZ,
	AMBIENT_VFO_MIN_REACH_HZ,
	ambientReachHz,
	placeAmbientDecode,
	type PlacementCandidate,
} from "../../../../src/core/scanner/probes/ambient-placement.js"

const HZ = 131_725_000
const PAIR_MS = 2_000
const NOW = 100_000

function obs(
	id: string,
	centreHz: number,
	opts: { obwHz?: number; discoveryId?: string; sourceId?: string } = {},
): PlacementCandidate {
	return {
		observationId: id,
		sourceId: opts.sourceId ?? "rtl",
		startedAt: 90_000,
		lastTrack: { centreHz, obwHz: opts.obwHz ?? 2_000 },
		...(opts.discoveryId !== undefined
			? { discoveryId: opts.discoveryId }
			: {}),
	}
}

const place = (
	cands: PlacementCandidate[],
	protocol: "acars" | "ais" | "lora" | "adsb" | "pocsag" | null,
	hz = HZ,
	at = 95_000,
) =>
	placeAmbientDecode(
		cands,
		{ sourceId: "rtl", hz, at, protocol },
		NOW,
		PAIR_MS,
	).map(o => o.observationId)

describe("ambient placement", () => {
	it("reaches half the decoder's channel width for ambient-only protocols", () => {
		expect(ambientReachHz("acars", 300_000)).toBe(12_500)
		expect(ambientReachHz("ais", 0)).toBe(12_500)
		expect(ambientReachHz("vdl2", Number.NaN)).toBe(12_500)
		expect(ambientReachHz("lora", 0)).toBe(62_500)
		expect(AMBIENT_CHANNEL_WIDTH_HZ["acars"]).toBe(25_000)
	})

	it("uses protocol channel widths and retains the unknown-protocol OBW fallback", () => {
		expect(ambientReachHz("pocsag", 0)).toBe(12_500)
		expect(ambientReachHz(null, 0)).toBe(AMBIENT_VFO_MIN_REACH_HZ)
		expect(ambientReachHz(null, 2_000)).toBe(1_500)
		expect(ambientReachHz(null, 12_500)).toBe(6_250)
		expect(ambientReachHz(null, -5)).toBe(1_500)
		expect(ambientReachHz(null, Infinity)).toBe(1_500)
	})

	it("names a track at the reach bound and not 1 Hz past it", () => {
		expect(place([obs("a", HZ + 12_500)], "acars")).toEqual(["a"])
		expect(place([obs("a", HZ + 12_501)], "acars")).toEqual([])
		expect(place([obs("a", HZ - 62_500)], "lora")).toEqual(["a"])
		expect(place([obs("a", HZ - 62_501)], "lora")).toEqual([])
		// ADS-B: a track-centre tolerance of 500 kHz around the nominal 1090 MHz
		expect(ambientReachHz("adsb", 0)).toBe(500_000)
		expect(place([obs("a", HZ + 500_000)], "adsb")).toEqual(["a"])
		expect(place([obs("a", HZ + 500_001)], "adsb")).toEqual([])
		// a merged wide track centred 8 kHz off (formerly missed by the 1 kHz rule)
		expect(place([obs("a", HZ + 8_000, { obwHz: 200_000 })], "acars")).toEqual([
			"a",
		])
	})

	it("refuses two reaching candidates even at unequal distances", () => {
		expect(
			place([obs("far", HZ + 9_000), obs("near", HZ - 3_000)], "acars"),
		).toEqual([])
	})

	it("refuses two signals at and past the former nearest tie width", () => {
		expect(
			place(
				[
					obs("a", HZ + 5_000, { discoveryId: "d1" }),
					obs("b", HZ - 5_000, { discoveryId: "d2" }),
				],
				"acars",
			),
		).toEqual([])
		expect(
			place([obs("a", HZ + 5_000), obs("b", HZ - 5_000 - 1)], "acars"),
		).toEqual([])
		expect(
			place([obs("a", HZ + 5_000), obs("b", HZ - 5_000 - 1 - 1)], "acars"),
		).toEqual([])
	})

	it("names every tied observation of one discovery", () => {
		expect(
			place(
				[
					obs("a", HZ + 1_000, { discoveryId: "d1" }),
					obs("b", HZ + 1_000, { discoveryId: "d1" }),
				],
				"acars",
			),
		).toEqual(["a", "b"])
	})

	it("ignores other sources, tracks outside the time pairing, and non-finite input", () => {
		expect(place([obs("a", HZ, { sourceId: "other" })], "acars")).toEqual([])
		expect(place([obs("a", HZ)], "acars", HZ, 90_000 - PAIR_MS - 1)).toEqual([])
		expect(place([obs("a", HZ)], "acars", HZ, 90_000 - PAIR_MS)).toEqual(["a"])
		expect(place([obs("a", HZ)], "acars", HZ, NOW + PAIR_MS + 1)).toEqual([])
		expect(place([obs("a", HZ)], "acars", Number.NaN)).toEqual([])
		expect(place([obs("a", Number.NaN)], "acars")).toEqual([])
	})

	it("never names a track beyond its reach, nor two discoveries (property)", () => {
		// Feature: decode-attachment, Property 2: ambient placement is within reach and unambiguous
		// Validates: Requirements 3c
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						offset: fc.integer({ min: -200_000, max: 200_000 }),
						obwHz: fc.integer({ min: 0, max: 400_000 }),
						discovery: fc.constantFrom("d1", "d2", "d3", undefined),
					}),
					{ maxLength: 8 },
				),
				fc.constantFrom("acars", "ais", "lora", "pocsag", null),
				(tracks, protocol) => {
					const cands = tracks.map((t, i) =>
						obs(`o${i}`, HZ + t.offset, {
							obwHz: t.obwHz,
							...(t.discovery !== undefined
								? { discoveryId: t.discovery }
								: {}),
						}),
					)
					const named = placeAmbientDecode(
						cands,
						{ sourceId: "rtl", hz: HZ, at: 95_000, protocol },
						NOW,
						PAIR_MS,
					)
					for (const o of named) {
						const t = o.lastTrack!
						expect(Math.abs(t.centreHz - HZ)).toBeLessThanOrEqual(
							ambientReachHz(protocol, t.obwHz),
						)
					}
					if (named.length > 1) {
						const ids = new Set(named.map(o => o.discoveryId))
						expect(ids.size).toBe(1)
						expect([...ids][0]).toBeTypeOf("string")
					}
					const reaching = cands.filter(
						o =>
							Math.abs(o.lastTrack!.centreHz - HZ) <=
							ambientReachHz(protocol, o.lastTrack!.obwHz),
					)
					if (new Set(reaching.map(o => o.discoveryId)).size > 1)
						expect(named).toEqual([])
				},
			),
			{ numRuns: 200 },
		)
	})
})
