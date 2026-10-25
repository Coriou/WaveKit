import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { bandplansFor } from "../../../../../src/core/scanner/bandplan/index.js"
import {
	CLASS_HYPOTHESES,
	familyOf,
} from "../../../../../src/core/scanner/classify/classifier.js"
import { hintOf } from "../../../../../src/core/scanner/classify/hint.js"
import type { HintInput } from "../../../../../src/core/scanner/classify/hint.js"
import type {
	ScannerClass,
	ScanRange,
} from "../../../../../src/core/scanner/types.js"

const EU_RANGES: ScanRange[] = bandplansFor("EU").flatMap(p => p.ranges)
const MHz = (x: number): number => Math.round(x * 1e6)
const CLASSES = Object.keys(CLASS_HYPOTHESES) as ScannerClass[]
const UNION = new Set<string>([
	...CLASSES.filter(c => c !== "unknown"),
	"ism-device",
	"analog-voice",
	"lora",
])

function input(over: Partial<HintInput>): HintInput {
	return {
		frequencyHz: MHz(433.92),
		bandwidthHz: 12_000,
		class: "ook-burst",
		short: true,
		region: "EU",
		ranges: EU_RANGES,
		...over,
	}
}

describe("hintOf: rule 1, invalid input", () => {
	it.each([
		["missing frequency", { frequencyHz: undefined }],
		["NaN frequency", { frequencyHz: Number.NaN }],
		["zero frequency", { frequencyHz: 0 }],
		["negative width", { bandwidthHz: -1 }],
		["infinite width", { bandwidthHz: Number.POSITIVE_INFINITY }],
		["missing width", { bandwidthHz: undefined }],
		["unknown class", { class: "unknown" }],
		["class outside the vocabulary", { class: "fsk9" }],
		["missing class", { class: undefined }],
		["missing short", { short: undefined }],
		["no region", { region: undefined }],
	] as [string, Partial<HintInput>][])("%s gives no hint", (_n, over) => {
		expect(hintOf(input(over))).toBeUndefined()
	})

	it("missing ranges or an unknown region give no hint", () => {
		expect(hintOf(input({ ranges: undefined }))).toBeUndefined()
		expect(
			hintOf(input({ region: "bogus" as unknown as HintInput["region"] })),
		).toBeUndefined()
	})
})

describe("hintOf: rule 2, lora", () => {
	const lora = (over: Partial<HintInput>): HintInput =>
		input({ frequencyHz: MHz(433.5), bandwidthHz: 125_000, ...over })

	it("a ~125 kHz short burst inside the EU 433 LoRa slot is lora", () => {
		expect(hintOf(lora({}))).toBe("lora")
		expect(hintOf(lora({ frequencyHz: MHz(869.525) }))).toBe("lora")
	})
	it("width bounds: 100 kHz and 150 kHz in, just outside out", () => {
		expect(hintOf(lora({ bandwidthHz: 100_000 }))).toBe("lora")
		expect(hintOf(lora({ bandwidthHz: 150_000 }))).toBe("lora")
		expect(hintOf(lora({ bandwidthHz: 99_999 }))).not.toBe("lora")
		expect(hintOf(lora({ bandwidthHz: 150_001 }))).not.toBe("lora")
	})
	it("the occupied span must lie inside the slot (edges inclusive)", () => {
		expect(hintOf(lora({ frequencyHz: MHz(433) + 62_500 }))).toBe("lora")
		expect(hintOf(lora({ frequencyHz: MHz(433) + 62_499 }))).not.toBe("lora")
		expect(hintOf(lora({ frequencyHz: MHz(434) - 62_500 }))).toBe("lora")
		expect(hintOf(lora({ frequencyHz: MHz(434) - 62_499 }))).not.toBe("lora")
	})
	it("needs short and region EU", () => {
		expect(hintOf(lora({ short: false }))).not.toBe("lora")
		expect(hintOf(lora({ region: "US" }))).not.toBe("lora")
	})
})

describe("hintOf: rule 3, ism-device", () => {
	it("an OOK burst at 433.92 MHz is ism-device", () => {
		expect(hintOf(input({}))).toBe("ism-device")
	})
	it("width bound 25 kHz", () => {
		expect(hintOf(input({ bandwidthHz: 25_000 }))).toBe("ism-device")
		expect(hintOf(input({ bandwidthHz: 25_001 }))).not.toBe("ism-device")
	})
	it("frequency bounds are closed intervals", () => {
		for (const f of [433.05, 434.79, 863, 870])
			expect(hintOf(input({ frequencyHz: MHz(f) }))).toBe("ism-device")
		for (const f of [
			MHz(433.05) - 1,
			MHz(434.79) + 1,
			MHz(863) - 1,
			MHz(870) + 1,
		])
			expect(hintOf(input({ frequencyHz: f }))).not.toBe("ism-device")
	})
	it("any short class qualifies; a long non-OOK track does not", () => {
		expect(hintOf(input({ class: "fsk4-12k5", short: true }))).toBe(
			"ism-device",
		)
		expect(hintOf(input({ class: "ook-burst", short: false }))).toBe(
			"ism-device",
		)
		expect(hintOf(input({ class: "fsk2-wide", short: false }))).toBe(
			"fsk2-wide",
		)
	})
	it("only in region EU", () => {
		expect(hintOf(input({ region: "US" }))).toBe("ook-burst")
	})
})

describe("hintOf: rule 4, analog-voice", () => {
	const voice = (over: Partial<HintInput>): HintInput =>
		input({
			frequencyHz: MHz(434.45),
			bandwidthHz: 11_000,
			class: "analog-fm",
			short: false,
			...over,
		})

	it("NFM on the 434.450 MHz raster point is analog-voice, within ±3 kHz", () => {
		expect(hintOf(voice({}))).toBe("analog-voice")
		expect(hintOf(voice({ frequencyHz: MHz(434.45) + 3000 }))).toBe(
			"analog-voice",
		)
		expect(hintOf(voice({ frequencyHz: MHz(434.45) - 3000 }))).toBe(
			"analog-voice",
		)
		expect(hintOf(voice({ frequencyHz: MHz(434.45) + 3001 }))).toBe("analog-fm")
		expect(hintOf(voice({ frequencyHz: MHz(434.45) - 3001 }))).toBe("analog-fm")
	})
	it("fsk4-12k5 on the raster is analog-voice", () => {
		expect(hintOf(voice({ class: "fsk4-12k5", frequencyHz: MHz(434.4) }))).toBe(
			"analog-voice",
		)
	})
	it("raster ends: channel 0 and 68 in, one step beyond out", () => {
		expect(hintOf(voice({ frequencyHz: MHz(433.075) }))).toBe("analog-voice")
		expect(hintOf(voice({ frequencyHz: MHz(434.775) }))).toBe("analog-voice")
		expect(hintOf(voice({ frequencyHz: MHz(433.05) }))).not.toBe("analog-voice")
		expect(hintOf(voice({ frequencyHz: MHz(434.8) }))).not.toBe("analog-voice")
	})
	it("width bound 25 kHz and not short", () => {
		expect(hintOf(voice({ bandwidthHz: 25_000 }))).toBe("analog-voice")
		expect(hintOf(voice({ bandwidthHz: 25_001 }))).not.toBe("analog-voice")
		expect(hintOf(voice({ short: true }))).toBe("ism-device")
	})
	it("a class outside the voice set falls through", () => {
		expect(hintOf(voice({ class: "fsk2-wide" }))).toBe("fsk2-wide")
	})
})

describe("hintOf: rule 5, spectral class", () => {
	it("a digital-voice first hypothesis gives no hint unless a covering range lists it", () => {
		const f = MHz(151.5)
		const none: ScanRange[] = []
		const lists: ScanRange[] = [
			{ startHz: MHz(151), endHz: MHz(152), protocols: ["dmr"] },
		]
		expect(
			hintOf(
				input({ frequencyHz: f, class: "tdma-ms", short: false, ranges: none }),
			),
		).toBeUndefined()
		expect(
			hintOf(
				input({
					frequencyHz: f,
					class: "tdma-ms",
					short: false,
					ranges: lists,
				}),
			),
		).toBe("tdma-ms")
	})
	it("a fsk4-12k5 track in the 70 cm amateur band off the LPD raster keeps its class", () => {
		expect(
			hintOf(
				input({ frequencyHz: MHz(438.0125), class: "fsk4-12k5", short: false }),
			),
		).toBe("fsk4-12k5")
	})
})

describe("hintOf properties", () => {
	const arbInput: fc.Arbitrary<HintInput> = fc.record({
		frequencyHz: fc.oneof(
			fc.integer({ min: MHz(430), max: MHz(440) }),
			fc.integer({ min: MHz(860), max: MHz(872) }),
			fc.integer({ min: MHz(140), max: MHz(170) }),
			fc.constantFrom(0, -1, Number.NaN, Number.POSITIVE_INFINITY),
			fc.constant(undefined),
		),
		bandwidthHz: fc.oneof(
			fc.integer({ min: 1, max: 200_000 }),
			fc.constantFrom(0, -5, Number.NaN),
			fc.constant(undefined),
		),
		class: fc.oneof(
			fc.constantFrom<string>(...CLASSES),
			fc.string(),
			fc.constant(undefined),
		),
		short: fc.option(fc.boolean(), { nil: undefined }),
		region: fc.option(
			fc.constantFrom("EU" as const, "US" as const, "JP" as const),
			{
				nil: undefined,
			},
		),
		ranges: fc.option(fc.constant(EU_RANGES), { nil: undefined }),
	})

	// Feature: scanner-redesign, Property 17: Weak records publish no guess
	// Validates: Requirements 3.10, 3.11
	it("returns at most one value in the hint union, none for malformed input, and no unlisted digital voice", () => {
		fc.assert(
			fc.property(arbInput, x => {
				const h = hintOf(x)
				const f = x.frequencyHz
				const w = x.bandwidthHz
				const malformed =
					!(typeof f === "number" && Number.isFinite(f) && f > 0) ||
					!(typeof w === "number" && Number.isFinite(w) && w > 0) ||
					typeof x.class !== "string" ||
					!CLASSES.includes(x.class as ScannerClass) ||
					x.class === "unknown" ||
					x.short === undefined ||
					x.region === undefined ||
					x.ranges === undefined
				if (malformed) {
					expect(h).toBeUndefined()
					return
				}
				expect(h === undefined || UNION.has(h)).toBe(true)
				expect(hintOf(x)).toBe(h)
				if (h !== undefined && CLASSES.includes(h as ScannerClass)) {
					const first = CLASS_HYPOTHESES[h as ScannerClass][0]
					if (first && familyOf(first.protocol) === "digital-voice") {
						const listed = (x.ranges ?? []).some(
							r =>
								f >= r.startHz &&
								f <= r.endHz &&
								(r.protocols ?? []).includes(first.protocol),
						)
						expect(listed).toBe(true)
					}
				}
			}),
			{ numRuns: 300 },
		)
	})

	it("never throws on hostile input", () => {
		fc.assert(
			fc.property(fc.anything(), junk => {
				expect(() => hintOf(junk as HintInput)).not.toThrow()
			}),
			{ numRuns: 100 },
		)
	})
})
