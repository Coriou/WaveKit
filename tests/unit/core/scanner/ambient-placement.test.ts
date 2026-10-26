import fc from "fast-check"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
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
	protocol: ScannerProtocol | null,
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
	it("uses occupied spans with a bounded placement tolerance", () => {
		expect(ambientReachHz("acars", 300_000)).toBe(152_500)
		for (const protocol of ["ais", "vdl2", "lora", "pocsag"] as const)
			expect(ambientReachHz(protocol, 0)).toBe(4_000)
		expect(AMBIENT_CHANNEL_WIDTH_HZ["acars"]).toBe(25_000)
		expect(ambientReachHz(null, 0)).toBe(AMBIENT_VFO_MIN_REACH_HZ)
		expect(ambientReachHz(null, 12_500)).toBe(6_250)
		for (const width of [-5, Infinity, Number.NaN])
			expect(ambientReachHz("pocsag", width)).toBe(4_000)
	})

	it("excludes the reach boundary and everything past it", () => {
		for (const protocol of ["acars", "lora", "pocsag", "adsb", null] as const) {
			const reach = ambientReachHz(protocol, 2_000)
			expect(place([obs("a", HZ + reach - 1)], protocol)).toEqual(["a"])
			// ADS-B keeps its inclusive centre tolerance (see the ADS-B block below).
			expect(place([obs("a", HZ + reach)], protocol)).toEqual(
				protocol === "adsb" ? ["a"] : [],
			)
			expect(place([obs("a", HZ + reach + 1)], protocol)).toEqual([])
		}
	})

	it.each(["pocsag", "flex", "aprs"] as const)(
		"%s never names a keyed neighbour and places both tracked channels",
		protocol => {
			const neighbour = obs("voice", HZ + 12_500, {
				obwHz: 8_000,
				discoveryId: "voice",
			})
			expect(place([neighbour], protocol)).toEqual([])
			const offsetPager = obs("pager", HZ + 2_500, {
				obwHz: 8_000,
				discoveryId: "pager",
			})
			expect(place([offsetPager], protocol)).toEqual(["pager"])
			const pager = obs("pager", HZ, { obwHz: 8_000, discoveryId: "pager" })
			expect(place([pager, neighbour], protocol)).toEqual(["pager"])
			expect(place([pager, neighbour], protocol, HZ + 12_500)).toEqual([
				"voice",
			])
		},
	)

	it("uses each ACARS channel fragment inside a merged wide track, else the wide track", () => {
		const wide = obs("wide", HZ + 12_500, {
			obwHz: 60_000,
			discoveryId: "wide",
		})
		const a = obs("a", HZ, { obwHz: 8_000, discoveryId: "a" })
		const b = obs("b", HZ + 25_000, { obwHz: 8_000, discoveryId: "b" })
		for (const [hz, own, other] of [
			[HZ, a, b],
			[HZ + 25_000, b, a],
		] as const) {
			expect(place([wide, own, other], "acars", hz)).toEqual([
				own.observationId,
			])
			expect(place([wide, other], "acars", hz)).toEqual(["wide"])
		}
	})

	it("refuses overlapping non-nested discoveries even at unequal distances", () => {
		expect(place([obs("a", HZ - 500), obs("b", HZ + 1_000)], "acars")).toEqual(
			[],
		)
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
		// Feature: ambient-identify-all, Property 2: placement resolves single and nested candidates
		// Validates: Requirements R2
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
						expect(Math.abs(t.centreHz - HZ)).toBeLessThan(
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
							Math.abs(o.lastTrack!.centreHz - HZ) <
							ambientReachHz(protocol, o.lastTrack!.obwHz),
					)
					if (reaching.length === 1) expect(named).toEqual(reaching)
					for (const o of named) {
						if (reaching.some(other => other.discoveryId !== o.discoveryId)) {
							const own = named.find(n =>
								reaching.every(
									other =>
										n.lastTrack!.centreHz - n.lastTrack!.obwHz / 2 >=
											other.lastTrack!.centreHz - other.lastTrack!.obwHz / 2 &&
										n.lastTrack!.centreHz + n.lastTrack!.obwHz / 2 <=
											other.lastTrack!.centreHz + other.lastTrack!.obwHz / 2,
								),
							)
							expect(own).toBeDefined()
						}
					}
					const wide = obs("wide", HZ, { obwHz: 25_000, discoveryId: "wide" })
					const fragment = obs("fragment", HZ + 3_000, {
						obwHz: 2_000,
						discoveryId: "fragment",
					})
					expect(place([wide, fragment], "acars")).toEqual(["fragment"])
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("ADS-B placement keeps the nearest-wins rule", () => {
	const ADSB = 1_090_000_000
	it("names the nearer of two discoveries inside the reach", () => {
		const near = obs("near", ADSB + 100_000, {
			obwHz: 50_000,
			discoveryId: "d1",
		})
		const far = obs("far", ADSB + 200_000, { obwHz: 50_000, discoveryId: "d2" })
		expect(place([far, near], "adsb", ADSB)).toEqual(["near"])
	})
	it("reaches exactly 500 kHz inclusive and not past it", () => {
		const at = obs("at", ADSB + 500_000, { discoveryId: "d1" })
		const past = obs("past", ADSB + 500_001, { discoveryId: "d2" })
		expect(place([at], "adsb", ADSB)).toEqual(["at"])
		expect(place([past], "adsb", ADSB)).toEqual([])
	})
	it("leaves a 1 Hz tie between discoveries ambiguous", () => {
		const a = obs("a", ADSB + 100_000, { discoveryId: "d1" })
		const b = obs("b", ADSB - 100_000, { discoveryId: "d2" })
		expect(place([a, b], "adsb", ADSB)).toEqual([])
	})
})
