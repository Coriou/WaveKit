import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { bandInputSchema, storedBandSchema } from "@wavekit/api-types"
import type { DisplayGroup, StoredBand } from "@wavekit/api-types"
import { parseSdrSharpBandPlan } from "../../../../../src/core/bandplans/import/sdrsharp.js"

const encoder = new TextEncoder()
const options = {
	fileName: "BandPlan.xml",
	overrides: new Map<string, DisplayGroup>(),
}

const MODES = [
	["AM", "am"],
	["NFM", "nfm"],
	["Narrow FM", "nfm"],
	["WFM (stereo)", "wfm"],
	["USB", "usb"],
	["LSB", "lsb"],
	["DSB", "dsb"],
	["CWU", "cw"],
	["RAW", "raw"],
	["Digital", null],
] as const

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
}

const rowArb = fc.record({
	name: fc
		.string({
			unit: fc.constantFrom(..."abcXYZ 09&<>\"'-é中"),
			minLength: 1,
			maxLength: 30,
		})
		.filter(name => name.trim().length > 0),
	start: fc.integer({ min: 1, max: 5_000_000_000 }),
	width: fc.integer({ min: 1, max: 10_000_000 }),
	mode: fc.integer({ min: 0, max: MODES.length - 1 }),
	step: fc.option(fc.integer({ min: 1, max: 10_000_000 }), { nil: null }),
	colour: fc.option(
		fc.tuple(
			fc.stringMatching(/^[0-9A-Fa-f]{6}$/),
			fc.constantFrom("", "#", "FF", "#80"),
		),
		{ nil: null },
	),
	quote: fc.constantFrom('"', "'"),
	order: fc.boolean(),
})

type Row = typeof rowArb extends fc.Arbitrary<infer T> ? T : never

function rowXml(row: Row): string {
	const q = row.quote
	const mode = MODES[row.mode]?.[0] ?? ""
	const attrs = [
		`minFrequency=${q}${row.start}${q}`,
		`maxFrequency=${q}${row.start + row.width}${q}`,
		`mode=${q}${escapeXml(mode)}${q}`,
	]
	if (row.step !== null) attrs.push(`step=${q}${row.step}${q}`)
	if (row.colour !== null)
		attrs.push(`color=${q}${row.colour[1]}${row.colour[0]}${q}`)
	if (row.order) attrs.reverse()
	return `<RangeEntry ${attrs.join(" ")}>${escapeXml(row.name)}</RangeEntry>`
}

/** Unique (name, edges) rows so duplicates never collapse the comparison. */
const docArb = fc
	.uniqueArray(rowArb, {
		minLength: 1,
		maxLength: 20,
		selector: row => `${row.name.trim()}|${row.start}|${row.width}`,
	})
	.map(rows => ({
		rows,
		text: `<?xml version="1.0" encoding="utf-8"?>\n<!-- generated -->\n<ArrayOfRangeEntry xmlns:xsi="urn:x">\n${rows.map(rowXml).join("\n")}\n</ArrayOfRangeEntry>\n`,
	}))

function expectBandValid(band: StoredBand): void {
	expect(storedBandSchema.safeParse(band).success).toBe(true)
	const { id: _id, scan: _scan, provenance: _provenance, ...input } = band
	expect(bandInputSchema.safeParse(input).success).toBe(true)
}

describe("parseSdrSharpBandPlan properties", () => {
	// Feature: web-gaps-5, Property 11: Import totality
	// Validates: Requirements 7.3, 7.4, 7.5
	it("random bytes and mutations of valid documents never throw; accepted bands are valid", () => {
		const mutated = fc
			.tuple(
				docArb,
				fc.array(
					fc.tuple(
						fc.nat(),
						fc.constantFrom("delete", "insert", "replace"),
						fc.constantFrom(
							..."<>&;/!?=\"' \u0000\u0001-x#",
							"<!DOCTYPE a>",
							"<![CDATA[",
							"&xxe;",
							"&#xD800;",
							"</RangeEntry>",
							"<RangeEntry>",
						),
					),
					{ minLength: 1, maxLength: 4 },
				),
			)
			.map(([{ text }, edits]) => {
				let out = text
				for (const [at, kind, piece] of edits) {
					const index = at % (out.length + 1)
					if (kind === "delete")
						out = out.slice(0, index) + out.slice(index + 1)
					else if (kind === "insert")
						out = out.slice(0, index) + piece + out.slice(index)
					else
						out = out.slice(0, index) + piece + out.slice(index + piece.length)
				}
				return encoder.encode(out)
			})
		fc.assert(
			fc.property(
				fc.oneof(fc.uint8Array({ maxLength: 300 }), mutated),
				bytes => {
					const first = parseSdrSharpBandPlan(bytes, options)
					expect(parseSdrSharpBandPlan(bytes, options)).toEqual(first)
					if (!first.ok) {
						expect(first.code).toMatch(/^BANDPLANS_IMPORT_(TOO_LARGE|INVALID)$/)
						expect(Object.keys(first).sort()).toEqual(["code", "ok", "reason"])
						return
					}
					expect(first.value.preview.format).toBe("sdrsharp-xml")
					expect(first.value.bands).toHaveLength(
						first.value.preview.report.accepted,
					)
					for (const band of first.value.bands) expectBandValid(band)
				},
			),
			{ numRuns: 120 },
		)
	})

	// Feature: web-gaps-5, Property 12: Import round trip
	// Validates: Requirements 7.2, 7.4
	it("generated valid rows round-trip names, edges, modes, steps and colours", () => {
		fc.assert(
			fc.property(docArb, ({ rows, text }) => {
				const result = parseSdrSharpBandPlan(encoder.encode(text), options)
				if (!result.ok) throw new Error(result.reason)
				const bands = result.value.bands
				expect(bands).toHaveLength(rows.length)
				rows.forEach((row, index) => {
					const band = bands[index]
					expect(band).toBeDefined()
					if (band === undefined) return
					expect(band.name).toBe(row.name.trim())
					expect(band.startHz).toBe(row.start)
					expect(band.endHz).toBe(row.start + row.width)
					expect(band.mode).toBe(MODES[row.mode]?.[1])
					expect(band.stepHz).toBe(row.step)
					expect(band.colourHint).toBe(
						row.colour === null ? null : `#${row.colour[0].toLowerCase()}`,
					)
					expectBandValid(band)
				})
			}),
			{ numRuns: 120 },
		)
	})
})
