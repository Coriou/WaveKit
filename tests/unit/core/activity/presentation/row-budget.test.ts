import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { presentAircraft } from "../../../../../src/core/activity/presentation/aircraft.js"
import { presentAprs } from "../../../../../src/core/activity/presentation/aprs.js"
import {
	ROW_GROWTH_COALESCED_BYTES,
	ROW_GROWTH_MAX_BYTES,
	fitRowBudget,
} from "../../../../../src/core/activity/presentation/budget.js"
import { presentMeshtastic } from "../../../../../src/core/activity/presentation/meshtastic.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import { presentShip } from "../../../../../src/core/activity/presentation/ship.js"
import { isCoalescibleShape } from "../../../../../src/core/activity/storage/coalesce.js"
import { buildActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type {
	DecodePresentation,
	DecodePosition,
} from "../../../../../src/core/activity/types.js"
import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import type * as RowModule from "../../../../../src/core/activity/storage/row.js"
import {
	encodePosition,
	meshPacket,
} from "../../../../mocks/fixtures/meshtastic/encode.js"
import { decoderOutput, presentationGrowth, rowBytes } from "./measure.js"

vi.mock(
	"../../../../../src/core/activity/storage/row.js",
	async importOriginal => {
		const actual = await importOriginal<typeof RowModule>()
		return { ...actual, buildActivityRow: vi.fn(actual.buildActivityRow) }
	},
)
const rows = vi.mocked(buildActivityRow)

type Presenter = (data: unknown) => DecodePresentation | undefined
const PRESENTERS: Record<string, Presenter> = {
	aircraft: presentAircraft,
	aprs: presentAprs,
	ship: presentShip,
	meshtastic: presentMeshtastic,
}

const CONTEXT = {
	eventId: "evt-measure",
	receivedAt: new Date("2026-10-13T00:00:00.000Z"),
	decoderId: "dec-1",
	decoderType: "measure",
	provenance: { sourceId: null, frequency: null },
}

/** Built-row growth of the presenter's view before `fitRowBudget`. */
function unfittedGrowth(output: DecoderOutput): number {
	const view = PRESENTERS[output.type]!(output.data)!
	const plain = createDecodeEnvelope(output, CONTEXT)
	return rowBytes(createDecodeEnvelope(output, CONTEXT, view)) - rowBytes(plain)
}

function limitOf(output: DecoderOutput): number {
	return isCoalescibleShape(output.type, output.data as Record<string, unknown>)
		? ROW_GROWTH_COALESCED_BYTES
		: ROW_GROWTH_MAX_BYTES
}

function decimals(value: number): number {
	const text = String(value)
	const dot = text.indexOf(".")
	return dot < 0 ? 0 : text.length - dot - 1
}

const WIDE_LAT = -89.12345678912345
const WIDE_LON = -179.12345678912345
const WIDEST = -1.2345678901234567e-6
const WIDE_LAT_I = -891_234_567
const WIDE_LON_I = -1_791_234_567

function meshOutput(altitudeM: number, extra: Record<string, unknown> = {}) {
	return decoderOutput("meshtastic", {
		...meshPacket({
			from: 0xabcdef12,
			to: 0xffffffff,
			portnum: 3,
			payload: encodePosition({
				latitudeI: WIDE_LAT_I,
				longitudeI: WIDE_LON_I,
				altitudeM,
				timeS: 0xffffffff,
			}),
			rxRssi: -120.123456789,
			rxSnr: -20.123456789,
		}),
		...extra,
	})
}

describe("coalesced bound (req 4.7)", () => {
	it("is 240 bytes; any other reception stays 1,100", () => {
		expect(ROW_GROWTH_COALESCED_BYTES).toBe(240)
		expect(ROW_GROWTH_MAX_BYTES).toBe(1_100)
	})

	it("keeps typical fixes unrounded with altM and the mesh title", () => {
		const cases: Array<[DecoderOutput, DecodePosition, string, number]> = [
			[
				decoderOutput("aircraft", {
					icao: "abc123",
					lat: 51.123456,
					lon: -0.123456,
					altitude: 35_000,
				}),
				{ lat: 51.123456, lon: -0.123456, altM: 10_668 },
				"ABC123",
				164,
			],
			[
				decoderOutput("aprs", {
					source: "N0CALL-9",
					dataType: "Position",
					lat: 51.123456,
					lon: 4.123456,
					altitude: 1_234,
				}),
				{ lat: 51.123456, lon: 4.123456, altM: 376 },
				"N0CALL-9 Position",
				195,
			],
			[
				decoderOutput(
					"meshtastic",
					meshPacket({
						from: 0xabcdef12,
						portnum: 3,
						payload: encodePosition({
							latitudeI: 511_234_567,
							longitudeI: -1_234_567,
							altitudeM: 12_345,
						}),
					}),
				),
				{ lat: 51.1234567, lon: -0.1234567, altM: 12_345 },
				"!abcdef12 Position",
				220,
			],
		]
		for (const [output, position, title, growth] of cases) {
			const view = presentDecoderOutput(output, "measure")
			expect(view?.position).toEqual(position)
			expect(view?.title).toBe(title)
			expect(presentationGrowth(output).growth).toBe(growth)
			expect(growth).toBeLessThanOrEqual(ROW_GROWTH_COALESCED_BYTES)
		}
	})
})

describe("golden maximum rows", () => {
	const coalesced: Array<
		[string, (altM: number, lat: number, lon: number) => DecoderOutput]
	> = [
		[
			"aircraft",
			(altM, lat, lon) =>
				decoderOutput("aircraft", {
					icao: "abc123",
					lat,
					lon,
					altitude: altM / 0.3048,
					gs: 1.7976931348623157e308,
				}),
		],
		[
			"aprs",
			(altM, lat, lon) =>
				decoderOutput("aprs", {
					source: "ABCDEF-15",
					dataType: "Position with timestamp and messaging",
					lat,
					lon,
					altitude: altM / 0.3048,
				}),
		],
		[
			"ship",
			(_altM, lat, lon) =>
				decoderOutput("ship", {
					mmsi: 999_999_999,
					messageType: 27,
					lat,
					lon,
				}),
		],
	]

	for (const [name, make] of coalesced) {
		for (const altM of [-500, 50_000]) {
			it(`${name} at altM ${altM}, widest decimals: fits 240 bytes`, () => {
				const output = make(altM, WIDE_LAT, WIDE_LON)
				expect(limitOf(output)).toBe(ROW_GROWTH_COALESCED_BYTES)
				const view = presentDecoderOutput(output, "measure")
				expect(presentationGrowth(output).growth).toBeLessThanOrEqual(
					ROW_GROWTH_COALESCED_BYTES,
				)
				if (name === "aprs") {
					// The 37-character data type pushes the title past the bound:
					// the longest title at six decimals wins, altM kept.
					expect(unfittedGrowth(output)).toBeGreaterThan(
						ROW_GROWTH_COALESCED_BYTES,
					)
					expect(view?.position).toEqual({
						lat: -89.123457,
						lon: -179.123457,
						altM,
					})
					expect(view?.title?.startsWith("ABCDEF-15 Position")).toBe(true)
					return
				}
				const position: DecodePosition = { lat: WIDE_LAT, lon: WIDE_LON }
				if (name !== "ship") position.altM = altM
				expect(view?.position).toEqual(position)
			})

			it(`${name} at altM ${altM}, widest JSON coordinates: fits 240 bytes`, () => {
				// 17 significant digits below 1e-5 print as 25 characters, the
				// widest JSON number in range.
				const output = make(altM, WIDEST, WIDEST)
				expect(limitOf(output)).toBe(ROW_GROWTH_COALESCED_BYTES)
				const unfitted = unfittedGrowth(output)
				const view = presentDecoderOutput(output, "measure")
				expect(presentationGrowth(output).growth).toBeLessThanOrEqual(
					ROW_GROWTH_COALESCED_BYTES,
				)
				expect(view?.position).toBeDefined()
				if (name !== "ship") expect(view?.position?.altM).toBe(altM)
				if (name === "aprs") {
					expect(unfitted).toBeGreaterThan(ROW_GROWTH_COALESCED_BYTES)
					expect(decimals(view!.position!.lat)).toBeGreaterThanOrEqual(4)
				} else {
					// Aircraft and AIS titles are fixed-width ids: never shrunk.
					expect(unfitted).toBeLessThanOrEqual(ROW_GROWTH_COALESCED_BYTES)
					expect(view?.position?.lat).toBe(WIDEST)
				}
			})
		}
	}

	it("meshtastic at the widest fix fits 240 bytes unrounded with the title", () => {
		// 1e-7 degree integers: -179.1234567 is the widest JSON a mesh fix has.
		for (const [altM, growth] of [
			[-500, 224],
			[50_000, 226],
		] as const) {
			const output = meshOutput(altM)
			expect(limitOf(output)).toBe(ROW_GROWTH_COALESCED_BYTES)
			expect(unfittedGrowth(output)).toBe(growth)
			expect(presentationGrowth(output).growth).toBe(growth)
			const view = presentDecoderOutput(output, "measure")
			expect(view?.title).toBe("!abcdef12 Position")
			expect(view?.position).toEqual({
				lat: WIDE_LAT_I / 1e7,
				lon: WIDE_LON_I / 1e7,
				altM,
			})
		}
	})

	const full: Array<[string, (altM: number) => DecoderOutput]> = [
		[
			"aircraft",
			altM =>
				decoderOutput("aircraft", {
					icao: "abc123",
					callsign: "界".repeat(80),
					squawk: "界".repeat(40),
					lat: WIDE_LAT,
					lon: WIDE_LON,
					altitude: altM / 0.3048,
					gs: -1.7976931348623157e308,
					track: -1.7976931348623157e308,
					baro_rate: -1.7976931348623157e308,
				}),
		],
		[
			"aprs",
			altM =>
				decoderOutput("aprs", {
					source: "ABCDEF-15",
					objectName: "界".repeat(80),
					objectKind: "object",
					dataType: "界".repeat(40),
					symbol: "界".repeat(40),
					comment: "界".repeat(80),
					lat: WIDE_LAT,
					lon: WIDE_LON,
					altitude: altM / 0.3048,
					course: -1.7976931348623157e308,
					speed: -1.7976931348623157e308,
				}),
		],
		[
			"ship",
			altM =>
				decoderOutput("ship", {
					mmsi: 999_999_999,
					messageType: 9,
					name: "界".repeat(80),
					callsign: "界".repeat(40),
					navStatus: -1.7976931348623157e308,
					sog: -1.7976931348623157e308,
					cog: -1.7976931348623157e308,
					shipType: -1.7976931348623157e308,
					lat: WIDE_LAT,
					lon: WIDE_LON,
					altitudeM: altM,
				}),
		],
		[
			"meshtastic",
			altM =>
				meshOutput(altM, {
					hopLimit: -1.7976931348623157e308,
					extra: "x",
				}),
		],
	]

	for (const [name, make] of full) {
		for (const altM of [-500, 50_000]) {
			it(`${name} at altM ${altM} fits 1,100 bytes`, () => {
				const output = make(altM)
				expect(limitOf(output)).toBe(ROW_GROWTH_MAX_BYTES)
				const growth = presentationGrowth(output).growth
				expect(growth).toBeLessThanOrEqual(ROW_GROWTH_MAX_BYTES)
				const view = presentDecoderOutput(output, "measure")
				expect(view?.title).toBeTruthy()
				expect(view?.position).toBeDefined()
			})
		}
	}
})

describe("altM through fitRowBudget (req 4.7)", () => {
	const output = decoderOutput("aircraft", {
		icao: "abc123",
		lat: WIDE_LAT,
		lon: WIDE_LON,
		altitude: 1,
	})
	const view = (keyChars: number): DecodePresentation => ({
		category: "aircraft",
		protocol: "adsb",
		entityKey: `icao:${"A".repeat(keyChars)}`,
		position: { lat: WIDE_LAT, lon: WIDE_LON, altM: -500 },
	})

	it("keeps altM on a rounded candidate when it fits", () => {
		expect(fitRowBudget(output, view(50)).position).toEqual({
			lat: -89.12346,
			lon: -179.12346,
			altM: -500,
		})
	})

	it("drops altM before rounding below four decimals", () => {
		// With altM nothing fits at four decimals; without it six decimals fit.
		expect(fitRowBudget(output, view(60)).position).toEqual({
			lat: -89.123457,
			lon: -179.123457,
		})
		expect(fitRowBudget(output, view(64)).position).toEqual({
			lat: -89.1235,
			lon: -179.1235,
		})
	})

	it("rounds further only after the no-altM candidates", () => {
		const position = fitRowBudget(output, view(66)).position
		expect(position).toBeDefined()
		expect(decimals(position!.lat)).toBeLessThan(4)
	})
})

function wide() {
	return fc.oneof(
		fc.double({ min: -90, max: 90, noNaN: true }),
		fc.integer({ min: -90_000_000, max: 90_000_000 }).map(v => v / 1e6),
		fc.constant(WIDE_LAT),
	)
}
function wideLon() {
	return fc.oneof(
		fc.double({ min: -180, max: 180, noNaN: true }),
		fc.constant(WIDE_LON),
	)
}
const feet = fc.oneof(
	fc.integer({ min: -1_700, max: 170_000 }),
	fc.double({ noNaN: false }),
	fc.constantFrom("ground", undefined),
)
const text = fc.oneof(
	fc.string({ maxLength: 90 }),
	fc.string({ unit: "grapheme", maxLength: 90 }),
)
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })

const payloads: fc.Arbitrary<DecoderOutput> = fc.oneof(
	fc
		.record({
			icao: fc.constantFrom("abc123", "ABCDEF"),
			lat: wide(),
			lon: wideLon(),
			altitude: feet,
			alt_baro: maybe(feet),
			callsign: maybe(text),
			squawk: maybe(text),
			gs: maybe(fc.double()),
		})
		.map(data => decoderOutput("aircraft", data)),
	fc
		.record({
			source: fc.constantFrom("N0CALL", "ABCDEF-15"),
			dataType: fc.constantFrom(
				"Position",
				"Position with timestamp and messaging",
				"Mic-E (old)",
				"Status",
			),
			lat: wide(),
			lon: wideLon(),
			altitude: maybe(feet),
			objectName: maybe(text),
			objectKind: maybe(fc.constantFrom("object", "item")),
			comment: maybe(text),
			course: maybe(fc.double()),
		})
		.map(data => decoderOutput("aprs", data)),
	fc
		.record({
			mmsi: fc.integer({ min: 0, max: 999_999_999 }),
			messageType: fc.constantFrom(1, 9, 18, 27),
			lat: wide(),
			lon: wideLon(),
			altitudeM: maybe(
				fc.oneof(fc.integer({ min: -600, max: 60_000 }), fc.double()),
			),
			name: maybe(text),
			sog: maybe(fc.double()),
		})
		.map(data => decoderOutput("ship", data)),
	fc
		.record({
			from: fc.integer({ min: 0, max: 0xffffffff }),
			latitudeI: fc.integer({ min: -0x80000000, max: 0x7fffffff }),
			longitudeI: fc.integer({ min: -0x80000000, max: 0x7fffffff }),
			altitudeM: fc.integer({ min: -0x80000000, max: 0x7fffffff }),
			portnum: fc.constantFrom(3, 3, 3, 4),
			rxSnr: fc.double(),
			extra: maybe(fc.constant("x")),
		})
		.map(({ latitudeI, longitudeI, altitudeM, extra, ...rest }) =>
			decoderOutput("meshtastic", {
				...meshPacket({
					...rest,
					payload: encodePosition({ latitudeI, longitudeI, altitudeM }),
				}),
				...(extra === undefined ? {} : { extra }),
			}),
		),
)

describe("row budget property", () => {
	// Feature: web-gaps-5, Property 6: Row budget with altitude
	// Validates: Requirements 4.7
	it("built-row growth stays within 240 B coalesced and 1,100 B otherwise", () => {
		fc.assert(
			fc.property(payloads, output => {
				// A payload the plain envelope rejects (non-finite numbers) is
				// stored without presentation by ingress: no growth to bound.
				let storable = true
				try {
					createDecodeEnvelope(output, CONTEXT)
				} catch {
					storable = false
				}
				fc.pre(storable)
				const growth = presentationGrowth(output).growth
				expect(growth).toBeLessThanOrEqual(limitOf(output))
			}),
			{ numRuns: 200 },
		)
	})
})

describe("arithmetic fast path on typical coalesced receptions", () => {
	it("builds no row for a seeded corpus of typical fixes", () => {
		// Deterministic LCG: readsb (6 decimals) and SBS (float32) aircraft,
		// APRS DDMM.hh minutes, AIS 1/600 000 degree, mesh 1e-7 degree.
		let seed = 0x2545f491
		const next = () => {
			seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
			return seed / 0x1_0000_0000
		}
		const between = (lo: number, hi: number) => lo + next() * (hi - lo)
		const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1))
		const makers: Array<() => DecoderOutput> = [
			() =>
				decoderOutput("aircraft", {
					hex: "4ca1d3",
					lat: Number(between(-60, 70).toFixed(6)),
					lon: Number(between(-180, 180).toFixed(6)),
					alt_baro: int(0, 1_800) * 25,
					gs: int(0, 5_000) / 10,
				}),
			() =>
				decoderOutput("aircraft", {
					icao: "4CA1D3",
					lat: Math.fround(between(-60, 70)),
					lon: Math.fround(between(-180, 180)),
					altitude: int(0, 1_800) * 25,
				}),
			() =>
				decoderOutput("aprs", {
					source: "N0CALL-9",
					dataType: "Position with messaging",
					lat: int(0, 89) + int(0, 5_999) / 6_000,
					lon: -(int(0, 179) + int(0, 5_999) / 6_000),
					altitude: int(0, 5_000),
					course: int(0, 359),
					speed: int(0, 80),
				}),
			() =>
				decoderOutput("ship", {
					mmsi: int(200_000_000, 799_999_999),
					messageType: 1,
					lat: int(-54_000_000, 54_000_000) / 600_000,
					lon: int(-108_000_000, 108_000_000) / 600_000,
					sog: int(0, 300) / 10,
					cog: int(0, 3_599) / 10,
				}),
			() =>
				decoderOutput(
					"meshtastic",
					meshPacket({
						from: int(1, 0xffffffff),
						portnum: 3,
						payload: encodePosition({
							latitudeI: int(-900_000_000, 900_000_000),
							longitudeI: int(-1_800_000_000, 1_800_000_000),
							altitudeM: int(0, 3_000),
						}),
					}),
				),
		]
		let total = 0
		let built = 0
		for (let i = 0; i < 1_000; i++) {
			const output = makers[i % makers.length]!()
			expect(limitOf(output)).toBe(ROW_GROWTH_COALESCED_BYTES)
			const view = PRESENTERS[output.type]!(output.data)!
			rows.mockClear()
			const fitted = fitRowBudget(output, view)
			if (rows.mock.calls.length > 0) built += 1
			total += 1
			// Altitude is never traded for precision on a typical fix.
			if (view.position?.altM !== undefined)
				expect(fitted.position?.altM).toBe(view.position.altM)
		}
		expect(built / total).toBeLessThanOrEqual(0.01)
	})
})
