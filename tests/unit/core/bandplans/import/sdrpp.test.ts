import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	BANDPLANS_LIMITS,
	DISPLAY_GROUPS,
	storedBandSchema,
} from "@wavekit/api-types"
import type { DisplayGroup, StoredBand } from "@wavekit/api-types"
import { parseSdrppBandPlan } from "../../../../../src/core/bandplans/import/sdrpp.js"

const encoder = new TextEncoder()
const fixturePath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../mocks/fixtures/bandplans/synthetic-sdrpp.json",
)
const KNOWN_JSON = '{"bands":[{"name":"A","type":"amateur","start":1,"end":2}]}'
const KNOWN_SHA256 =
	"c50b7d71898a9cbcc74b52d0e6b3a98569a2768314f0c5e3a048ed2f69147512"

function options(
	overrides?: ReadonlyMap<string, DisplayGroup>,
	fileName = "synthetic.json",
) {
	return { fileName, overrides: overrides ?? new Map<string, DisplayGroup>() }
}

function parseBytes(
	bytes: Uint8Array,
	overrides?: ReadonlyMap<string, DisplayGroup>,
	fileName?: string,
) {
	return parseSdrppBandPlan(bytes, options(overrides, fileName))
}

function parseValue(
	value: unknown,
	overrides?: ReadonlyMap<string, DisplayGroup>,
) {
	return parseBytes(encoder.encode(JSON.stringify(value)), overrides)
}

function previewOf(
	value: unknown,
	overrides?: ReadonlyMap<string, DisplayGroup>,
) {
	const result = parseValue(value, overrides)
	if (!result.ok) throw new Error(`expected preview, got ${result.reason}`)
	return result.value
}

function band(
	name: string,
	type: string | undefined,
	start: number,
	end: number,
	extra?: Record<string, unknown>,
) {
	return {
		...(type === undefined ? {} : { type }),
		name,
		start,
		end,
		...extra,
	}
}

describe("parseSdrppBandPlan", () => {
	it("parses the synthetic fixture into stable ids, groups and a byte hash", () => {
		const bytes = new Uint8Array(readFileSync(fixturePath))
		const first = parseBytes(bytes, undefined, "synthetic-demo.json")
		const second = parseBytes(bytes, undefined, "synthetic-demo.json")
		expect(second).toEqual(first)
		if (!first.ok) throw new Error(first.reason)
		const { preview, bands } = first.value
		expect(preview).toMatchObject({
			format: "sdrpp-json",
			fileName: "synthetic-demo.json",
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			trust: "community-unverified",
			meta: {
				name: "Synthetic demo",
				countryName: "Exampleland",
				countryCode: "EX",
				author: "Lane Fixture",
				version: "2",
			},
		})
		expect(bands.map(item => [item.id, item.group, item.colourHint])).toEqual([
			["alpha-beacon", "amateur", null],
			["beta-broadcast", "broadcast", null],
			["gamma-aviation", "air", null],
			["delta-marine", "marine", null],
			["epsilon-pmr446", "personal-radio", null],
			["zeta", "other", "#aabbcc"],
		])
		expect(preview.bands).toEqual(bands)
		expect(preview.report).toEqual({
			rowsTotal: 6,
			accepted: 6,
			skipped: [],
			groupMapping: [
				{
					sourceType: "#AaBbCc",
					group: "other",
					rule: "fallback-other",
					count: 1,
				},
				{ sourceType: "amateur", group: "amateur", rule: "table", count: 1 },
				{ sourceType: "aviation", group: "air", rule: "table", count: 1 },
				{
					sourceType: "broadcast",
					group: "broadcast",
					rule: "table",
					count: 1,
				},
				{
					sourceType: "custom",
					group: "personal-radio",
					rule: "name-keyword",
					count: 1,
				},
				{ sourceType: "marine", group: "marine", rule: "table", count: 1 },
			],
			mapped: 5,
			toOther: 1,
			colourHints: 1,
		})
		expectBandsValid(bands)
		for (const item of bands) {
			expect(item.scan).toBeNull()
			expect(item.provenance).toEqual({ kind: "imported" })
			expect(item.channels).toEqual([])
			expect(item.mode).toBeNull()
		}
	})

	it("hashes the original bytes, including a single leading BOM", () => {
		const body = encoder.encode(KNOWN_JSON)
		const withBom = new Uint8Array(body.length + 3)
		withBom.set([0xef, 0xbb, 0xbf])
		withBom.set(body, 3)
		const plain = parseBytes(body)
		const bom = parseBytes(withBom)
		if (!plain.ok || !bom.ok) throw new Error("expected previews")
		expect(plain.value.preview.sha256).toBe(KNOWN_SHA256)
		expect(plain.value.preview.sha256).toBe(
			createHash("sha256").update(body).digest("hex"),
		)
		expect(bom.value.preview.sha256).toBe(
			createHash("sha256").update(withBom).digest("hex"),
		)
		expect(bom.value.preview.sha256).not.toBe(plain.value.preview.sha256)
		expect(bom.value.bands).toEqual(plain.value.bands)
		expect(bom.value.preview.bytes).toBe(withBom.length)
		// A second BOM decodes to U+FEFF, which JSON.parse treats as whitespace.
		// The hash still covers every original byte.
		const doubleBom = new Uint8Array(withBom.length + 3)
		doubleBom.set([0xef, 0xbb, 0xbf])
		doubleBom.set(withBom, 3)
		const twice = parseBytes(doubleBom)
		if (!twice.ok) throw new Error(twice.reason)
		expect(twice.value.bands).toEqual(plain.value.bands)
		expect(twice.value.preview.bytes).toBe(doubleBom.length)
		expect(twice.value.preview.sha256).toBe(
			createHash("sha256").update(doubleBom).digest("hex"),
		)
		expect(twice.value.preview.sha256).not.toBe(bom.value.preview.sha256)
	})

	it("rejects oversized input before decoding", () => {
		const limit = BANDPLANS_LIMITS.importFileBytes
		const tooBig = new Uint8Array(limit + 1)
		tooBig.fill(0xff)
		expect(parseBytes(tooBig)).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_TOO_LARGE",
			reason: "too-large",
		})
		const atLimit = new Uint8Array(limit)
		atLimit.fill(0xff)
		expect(parseBytes(atLimit)).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "encoding",
		})
	})

	it("returns a fixed reason and does not echo file content", () => {
		const sentinel = "UNIQUE_SENTINEL_9f3a"
		expect(parseBytes(encoder.encode(""))).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "json",
		})
		expect(parseBytes(encoder.encode(`{${sentinel}`))).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "json",
		})
		expect(parseBytes(encoder.encode(`{"bands":"${sentinel}"}`))).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "shape",
		})
		expect(
			parseBytes(Uint8Array.from([0xff, 0xfe, ...encoder.encode(sentinel)])),
		).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "encoding",
		})
		for (const value of [null, 1, "x", true, [], { bands: null }, {}]) {
			const result = parseValue(value)
			expect(result).toEqual({
				ok: false,
				code: "BANDPLANS_IMPORT_INVALID",
				reason: "shape",
			})
			expect(Object.keys(result).sort()).toEqual(["code", "ok", "reason"])
		}
		const thrown = parseBytes(encoder.encode(KNOWN_JSON), hostileOverrides())
		expect(thrown).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "shape",
		})
		expect(JSON.stringify(thrown)).not.toContain("SENTINEL_THROW_secret")
		expect(
			JSON.stringify(parseBytes(encoder.encode(`{${sentinel}`))),
		).not.toContain(sentinel)
	})

	it("rejects an over-long bands array and an empty usable set", () => {
		const over = Array.from(
			{ length: BANDPLANS_LIMITS.importRows + 1 },
			() => ({}),
		)
		over[0] = band("Alpha", "amateur", 1, 2)
		expect(parseValue({ bands: over })).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "row-limit",
		})
		const atCap = Array.from(
			{ length: BANDPLANS_LIMITS.importRows },
			() => ({}),
		)
		expect(parseValue({ bands: atCap })).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "empty",
		})
		expect(parseValue({ bands: [] })).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "empty",
		})
		expect(parseValue({ bands: [band("Alpha", "amateur", 0, 10)] })).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "empty",
		})
	})

	it("counts skipped rows in check order when one band is usable", () => {
		const value = previewOf({
			bands: [
				band("Alpha", "amateur", 10, 20),
				{},
				band("   ", "amateur", 30, 40),
				band("bad\u0001", "amateur", 30, 40),
				band("Edges", "amateur", 30, 30),
				band("Range", "amateur", 0, 10),
				band("Alpha", "broadcast", 10, 20),
				band("Low", "amateur", 5, 0),
			],
		})
		expect(value.bands.map(item => item.id)).toEqual(["alpha"])
		expect(value.preview.report.rowsTotal).toBe(8)
		expect(value.preview.report.accepted).toBe(1)
		expect(value.preview.report.skipped).toEqual([
			{ reason: "malformed-row", count: 1 },
			{ reason: "unnamed", count: 1 },
			{ reason: "text-invalid", count: 1 },
			{ reason: "invalid-edges", count: 2 },
			{ reason: "out-of-range", count: 1 },
			{ reason: "duplicate", count: 1 },
		])
	})

	it("rounds edges before range, duplicate and id checks", () => {
		const rounded = previewOf({
			bands: [band("Alpha", "amateur", 0.6, 2.4)],
		})
		expect(rounded.bands[0]).toMatchObject({ startHz: 1, endHz: 2 })
		const duplicate = previewOf({
			bands: [
				band("Alpha", "amateur", 10.1, 20.4),
				band(" Alpha ", "marine", 9.6, 20.1),
				band("Alpha", "amateur", 10, 21),
			],
		})
		expect(
			duplicate.bands.map(item => [item.id, item.startHz, item.endHz]),
		).toEqual([
			["alpha", 10, 20],
			["alpha-2", 10, 21],
		])
		expect(duplicate.preview.report.skipped).toEqual([
			{ reason: "duplicate", count: 1 },
		])
		const max = BANDPLANS_LIMITS.frequencyHzMax
		const edges = previewOf({
			bands: [
				band("Top", "amateur", max - 1, max),
				band("Past", "amateur", 1, max + 1),
				band("Same", "amateur", 4, 4),
			],
		})
		expect(edges.bands.map(item => item.id)).toEqual(["top"])
		expect(edges.preview.report.skipped.map(item => item.reason)).toEqual([
			"invalid-edges",
			"out-of-range",
		])
	})

	it("derives ids from trimmed names in file order", () => {
		expect(idsOf(["Marine VHF"])).toEqual(["marine-vhf"])
		expect(idsOf(["123 Emergency"])).toEqual(["b-123-emergency"])
		expect(idsOf(["!!!"])).toEqual(["band"])
		expect(idsOf(["  Air  Band  "])).toEqual(["air-band"])
		expect(idsOf(["Émission"])).toEqual(["mission"])
		expect(idsOf(["2 m"])).toEqual(["b-2-m"])
		expect(idsOf(["Äther"])).toEqual(["ther"])
		expect(idsOf(["Hello", "Hello", "Hello"])).toEqual([
			"hello",
			"hello-2",
			"hello-3",
		])
		expect(idsOf(["hello-2", "hello", "hello"])).toEqual([
			"hello-2",
			"hello",
			"hello-3",
		])
		expect(idsOf(["Alpha", "alpha"])).toEqual(["alpha", "alpha-2"])
		expect(idsOf(["a".repeat(80)])).toEqual(["a".repeat(56)])
		expect(idsOf(["a".repeat(55) + " " + "b".repeat(10)])).toEqual([
			"a".repeat(55),
		])
		expect(idsOf(["9".repeat(60)])).toEqual([`b-${"9".repeat(56)}`])
		expect(idsOf(["😀".repeat(80), "😀".repeat(80)])).toEqual([
			"band",
			"band-2",
		])
		expectBandsValid(
			previewOf({
				bands: [
					band("a".repeat(80), "amateur", 1, 2),
					band("9".repeat(60), "amateur", 3, 4),
				],
			}).bands,
		)
		expect(
			parseValue({ bands: [band("😀".repeat(81), "amateur", 1, 2)] }),
		).toEqual({
			ok: false,
			code: "BANDPLANS_IMPORT_INVALID",
			reason: "empty",
		})
	})

	it("keeps a colour hint only for a #rrggbb type and ignores other fields", () => {
		const parsed = previewOf({
			bands: [
				band("Beacon", "amateur", 1, 2, { color: "#ff0000" }),
				band("Tint", "  #AaBbCc  ", 3, 4),
				band("Short", "#abc", 5, 6),
				band("Named", "red", 7, 8),
				band("marine watch", "#ff00aa", 9, 10),
			],
		})
		expect(parsed.bands.map(item => item.colourHint)).toEqual([
			null,
			"#aabbcc",
			null,
			null,
			"#ff00aa",
		])
		expect(parsed.bands[4]).toMatchObject({
			group: "marine",
			id: "marine-watch",
		})
		expect(parsed.preview.report.colourHints).toBe(2)
		const exact = new Map<string, DisplayGroup>([["#FF00AA", "pagers"]])
		const overridden = previewOf(
			{ bands: [band("marine watch", "#FF00AA", 1, 2)] },
			exact,
		)
		expect(overridden.bands[0]).toMatchObject({
			group: "pagers",
			colourHint: "#ff00aa",
		})
		expect(overridden.preview.report.groupMapping[0]).toMatchObject({
			sourceType: "#FF00AA",
			rule: "override",
		})
	})

	it("drops invalid meta, keeps bounded meta, and ignores unknown keys", () => {
		const good = previewOf({
			name: "  Good Name  ",
			country_name: "Exampleland",
			country_code: "  EX  ",
			author_name: "Ada",
			author_url: "https://example.invalid",
			version: 3,
			bands: [band("Alpha", "amateur", 1, 2)],
		})
		expect(good.preview.meta).toEqual({
			name: "Good Name",
			countryName: "Exampleland",
			countryCode: "EX",
			author: "Ada",
			version: "3",
		})
		const bad = previewOf({
			name: "bad\u0001name",
			country_name: 12,
			country_code: "   ",
			author_name: "a".repeat(81),
			version: true,
			bands: [band("Alpha", "amateur", 1, 2)],
		})
		expect(bad.preview.meta).toEqual({
			name: null,
			countryName: null,
			countryCode: null,
			author: null,
			version: null,
		})
		const versioned = parseBytes(
			encoder.encode(
				'{"version":"  1.2.3  ","bands":[{"name":"A","type":"amateur","start":1,"end":2}]}',
			),
		)
		if (!versioned.ok) throw new Error(versioned.reason)
		expect(versioned.value.preview.meta.version).toBe("1.2.3")
		const infinite = parseBytes(
			encoder.encode(
				'{"version":1e309,"bands":[{"name":"A","type":"amateur","start":1,"end":2}]}',
			),
		)
		if (!infinite.ok) throw new Error(infinite.reason)
		expect(infinite.value.preview.meta.version).toBeNull()
	})

	it("accepts a missing type, caps a long type, and lets overrides win", () => {
		const missing = previewOf({
			bands: [{ name: "marine watch", start: 1, end: 2 }],
		})
		expect(missing.bands[0]).toMatchObject({ group: "marine" })
		expect(missing.preview.report.groupMapping[0]).toMatchObject({
			sourceType: "",
			rule: "name-keyword",
		})
		const longType = `amateur${"x".repeat(80)}`
		const capped = previewOf({
			bands: [band("Alpha", longType, 1, 2)],
		})
		expect(capped.preview.report.groupMapping[0]?.sourceType).toBe(
			longType.slice(0, 64),
		)
		expect(capped.bands[0]?.group).toBe("other")
		const overrides = new Map<string, DisplayGroup>([["amateur", "marine"]])
		const first = previewOf(
			{ bands: [band("Alpha", "amateur", 1, 2)] },
			overrides,
		)
		const second = previewOf({ bands: [band("Alpha", "amateur", 1, 2)] })
		expect(first.bands[0]?.id).toBe(second.bands[0]?.id)
		expect(first.bands[0]?.group).toBe("marine")
		expect(first.preview.sha256).toBe(second.preview.sha256)
		const renamed = parseValue(
			{ bands: [band("Alpha", "amateur", 1, 2)] },
			undefined,
		)
		const otherName = parseBytes(
			encoder.encode(
				JSON.stringify({ bands: [band("Alpha", "amateur", 1, 2)] }),
			),
			undefined,
			"other.json",
		)
		if (!renamed.ok || !otherName.ok) throw new Error("expected previews")
		expect(otherName.value.bands).toEqual(renamed.value.bands)
		expect(otherName.value.preview.sha256).toBe(renamed.value.preview.sha256)
		expect(otherName.value.preview.fileName).toBe("other.json")
	})

	it("stops accepting at 512 bands and still counts later duplicates first", () => {
		const bands = Array.from({ length: 511 }, (_, index) =>
			band(`n${index}`, "amateur", index + 1, index + 2),
		)
		bands.push(band("n0", "broadcast", 1, 2))
		bands.push(band("extra", "amateur", 900_000, 900_001))
		bands.push(band("overflow", "amateur", 900_002, 900_003))
		const parsed = previewOf({ bands })
		expect(parsed.preview.report.rowsTotal).toBe(514)
		expect(parsed.preview.report.accepted).toBe(512)
		expect(parsed.preview.report.skipped).toEqual([
			{ reason: "duplicate", count: 1 },
			{ reason: "pack-band-limit", count: 1 },
		])
		expect(parsed.bands.map(item => item.id)).not.toContain("overflow")
		expect(parsed.bands).toHaveLength(512)
		expectBandsValid(parsed.bands)
	})

	it("does not mutate the input bytes", () => {
		const bytes = encoder.encode(KNOWN_JSON)
		const before = bytes.slice()
		parseBytes(bytes)
		expect(bytes).toEqual(before)
	})

	// Feature: band-plans, Property 10: Importer totality and bounds
	// Validates: Requirements 6.2, 6.3, 6.4, 6.7, 6.8
	it("returns a bounded result for arbitrary bytes and a stable preview", () => {
		const validBytes = fc
			.array(
				fc.record({
					name: fc.string({
						unit: fc.constantFrom(..."abcdefghij"),
						minLength: 1,
						maxLength: 12,
					}),
					type: fc.constantFrom(
						"amateur",
						"broadcast",
						"aviation",
						"marine",
						"custom",
					),
					start: fc.integer({ min: 1, max: 50_000_000 }),
				}),
				{ minLength: 1, maxLength: 5 },
			)
			.map(rows =>
				encoder.encode(
					JSON.stringify({
						name: "Valid",
						bands: rows.map((row, index) => ({
							name: `${row.name}${index}`,
							type: row.type,
							start: row.start + index * 1000,
							end: row.start + index * 1000 + 500,
						})),
					}),
				),
			)
		fc.assert(
			fc.property(
				fc.oneof(
					fc
						.uint8Array({ minLength: 0, maxLength: 200 })
						.map(bytes => ({ bytes, mustAccept: false })),
					validBytes.map(bytes => ({ bytes, mustAccept: true })),
				),
				({ bytes, mustAccept }) => {
					const before = bytes.slice()
					const opts = options()
					const first = parseSdrppBandPlan(bytes, opts)
					const second = parseSdrppBandPlan(bytes, opts)
					expect(bytes).toEqual(before)
					expect(second).toEqual(first)
					if (!first.ok) {
						expect(mustAccept).toBe(false)
						expect([
							"BANDPLANS_IMPORT_TOO_LARGE",
							"BANDPLANS_IMPORT_INVALID",
						]).toContain(first.code)
						expect(JSON.stringify(first).length).toBeLessThan(160)
						expect(Object.keys(first).sort()).toEqual(["code", "ok", "reason"])
						return
					}
					expect(first.value.preview.bytes).toBe(bytes.length)
					expect(first.value.preview.sha256).toBe(
						createHash("sha256").update(bytes).digest("hex"),
					)
					expect(first.value.preview.bands).toEqual(first.value.bands)
					expectBandsValid(first.value.bands)
					const report = first.value.preview.report
					const skipped = report.skipped.reduce(
						(sum, entry) => sum + entry.count,
						0,
					)
					const grouped = report.groupMapping.reduce(
						(sum, entry) => sum + entry.count,
						0,
					)
					expect(skipped + report.accepted).toBe(report.rowsTotal)
					expect(grouped).toBe(report.accepted)
					expect(report.mapped + report.toOther).toBe(report.accepted)
					expect(first.value.bands).toHaveLength(report.accepted)
					expect(new Set(first.value.bands.map(item => item.id)).size).toBe(
						report.accepted,
					)
					for (const item of report.groupMapping) {
						expect(DISPLAY_GROUPS).toContain(item.group)
						expect(item.sourceType.length).toBeLessThanOrEqual(64)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

function idsOf(names: readonly string[]): string[] {
	const parsed = previewOf({
		bands: names.map((name, index) =>
			band(name, "amateur", index * 10 + 1, index * 10 + 2),
		),
	})
	return parsed.bands.map(item => item.id)
}

function expectBandsValid(bands: readonly StoredBand[]): void {
	for (const item of bands) {
		expect(storedBandSchema.safeParse(item).success).toBe(true)
		expect(item.channels).toEqual([])
		expect(Object.isFrozen(item.provenance)).toBe(true)
	}
}

function hostileOverrides(): Map<string, DisplayGroup> {
	return new Proxy(new Map<string, DisplayGroup>(), {
		get(target, prop, receiver) {
			if (prop === "has" || prop === "get")
				throw new Error("SENTINEL_THROW_secret")
			return Reflect.get(target, prop, receiver) as unknown
		},
	})
}
