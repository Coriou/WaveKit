import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { DISPLAY_GROUPS } from "@wavekit/api-types"
import type {
	DisplayGroup,
	ImportGroupMappingRow,
	ImportSkipReason,
} from "@wavekit/api-types"
import {
	aggregateImportReport,
	mapImportGroup,
	SDRPP_NAME_KEYWORDS,
	SDRPP_TYPE_TABLE,
} from "../../../../../src/core/bandplans/import/group-map.js"
import type { MappedImportRow } from "../../../../../src/core/bandplans/import/group-map.js"

const TYPE_VECTOR = {
	air: "air",
	airband: "air",
	ais: "marine",
	amateur: "amateur",
	aviation: "air",
	broadcast: "broadcast",
	cb: "personal-radio",
	dab: "broadcast",
	ham: "amateur",
	ism: "ism-srd",
	"land-mobile": "land-mobile",
	lpd: "personal-radio",
	marine: "marine",
	pager: "pagers",
	pagers: "pagers",
	pmr446: "personal-radio",
	pocsag: "pagers",
	srd: "ism-srd",
} as const satisfies Readonly<Record<string, DisplayGroup>>

const KEYWORD_VECTOR = [
	["broadcast", "broadcast"],
	["airband", "air"],
	["amateur", "amateur"],
	["marine", "marine"],
	["pagers", "pagers"],
	["PMR446", "personal-radio"],
	["POCSAG", "pagers"],
	["pager", "pagers"],
	["AIS", "marine"],
	["DAB", "broadcast"],
	["ham", "amateur"],
	["ISM", "ism-srd"],
	["LPD", "personal-radio"],
	["SRD", "ism-srd"],
	["CB", "personal-radio"],
] as const satisfies readonly (readonly [string, DisplayGroup])[]

const empty = (): Map<string, DisplayGroup> => new Map()

describe("SDR++ display group tables", () => {
	it("freezes the type table and maps each entry by table, ahead of a keyword", () => {
		expect(SDRPP_TYPE_TABLE).toEqual(TYPE_VECTOR)
		expect(Object.isFrozen(SDRPP_TYPE_TABLE)).toBe(true)
		for (const type of [
			"amateur",
			"broadcast",
			"aviation",
			"marine",
		] as const) {
			expect(TYPE_VECTOR[type]).toBeDefined()
		}
		for (const [type, group] of Object.entries(TYPE_VECTOR)) {
			expect(mapImportGroup(type, "marine broadcast pager", empty())).toEqual({
				group,
				rule: "table",
			})
			expect(mapImportGroup(type.toUpperCase(), "zzzz", empty())).toEqual({
				group,
				rule: "table",
			})
		}
	})

	it("freezes the keyword table and matches each keyword as a whole word", () => {
		expect(
			SDRPP_NAME_KEYWORDS.map(entry => [entry.keyword, entry.group]),
		).toEqual(KEYWORD_VECTOR.map(entry => [...entry]))
		expect(Object.isFrozen(SDRPP_NAME_KEYWORDS)).toBe(true)
		for (const entry of SDRPP_NAME_KEYWORDS)
			expect(Object.isFrozen(entry)).toBe(true)
		for (const [keyword, group] of KEYWORD_VECTOR) {
			for (const name of [keyword, keyword.toLowerCase(), `qq ${keyword} qq`]) {
				expect(mapImportGroup("unlisted", name, empty())).toEqual({
					group,
					rule: "name-keyword",
				})
			}
		}
	})

	it("does not treat a bare PMR as a keyword and keeps word boundaries", () => {
		expect(Object.keys(SDRPP_TYPE_TABLE)).not.toContain("pmr")
		expect(
			SDRPP_NAME_KEYWORDS.map(entry => entry.keyword.toLowerCase()),
		).not.toContain("pmr")
		for (const name of [
			"PMR",
			"pmr",
			"PMR band",
			"the PMR network",
			"PMR4460",
			"XPMR446",
			"ACB",
			"CBradio",
		]) {
			expect(mapImportGroup("unlisted", name, empty())).toEqual({
				group: "other",
				rule: "fallback-other",
			})
		}
		expect(mapImportGroup("unlisted", "CB radio", empty())).toEqual({
			group: "personal-radio",
			rule: "name-keyword",
		})
		expect(mapImportGroup("unlisted", "DAB+", empty())).toEqual({
			group: "broadcast",
			rule: "name-keyword",
		})
		expect(mapImportGroup("unlisted", "ISM-433", empty())).toEqual({
			group: "ism-srd",
			rule: "name-keyword",
		})
		expect(mapImportGroup("unlisted", "pager service", empty())).toEqual({
			group: "pagers",
			rule: "name-keyword",
		})
		expect(mapImportGroup("unlisted", "pagers", empty())).toEqual({
			group: "pagers",
			rule: "name-keyword",
		})
	})

	it("uses the leftmost keyword and lets a longer one win on the same index", () => {
		expect(mapImportGroup("unlisted", "marine broadcast", empty())).toEqual({
			group: "marine",
			rule: "name-keyword",
		})
		expect(mapImportGroup("unlisted", "broadcast marine", empty())).toEqual({
			group: "broadcast",
			rule: "name-keyword",
		})
		expect(mapImportGroup("unlisted", "", empty())).toEqual({
			group: "other",
			rule: "fallback-other",
		})
	})

	it("prefers an exact override, then the type table, then the name", () => {
		const overrides = new Map<string, DisplayGroup>([
			["amateur", "pagers"],
			["custom", "other"],
		])
		expect(mapImportGroup("amateur", "marine broadcast", overrides)).toEqual({
			group: "pagers",
			rule: "override",
		})
		expect(mapImportGroup("Amateur", "marine broadcast", overrides)).toEqual({
			group: "amateur",
			rule: "table",
		})
		expect(mapImportGroup("custom", "marine", overrides)).toEqual({
			group: "other",
			rule: "override",
		})
		expect(mapImportGroup("unlisted", "marine", empty())).toEqual({
			group: "marine",
			rule: "name-keyword",
		})
		expect(mapImportGroup("unlisted", "zzzz", empty())).toEqual({
			group: "other",
			rule: "fallback-other",
		})
		expect(mapImportGroup("", "marine", new Map([["", "air"]]))).toEqual({
			group: "air",
			rule: "override",
		})
	})
})

describe("import report aggregation", () => {
	it("orders skips by check sequence and groups by source type", () => {
		const skips = new Map<ImportSkipReason, number>([
			["duplicate", 2],
			["unnamed", 0],
			["malformed-row", 4],
			["pack-band-limit", 1],
		])
		const rows: MappedImportRow[] = [
			row("zeta", "other", "fallback-other", null),
			row("alpha", "air", "table", "#aabbcc"),
			row("alpha", "marine", "name-keyword", null),
			row("alpha", "air", "table", null),
			row("", "other", "fallback-other", null),
		]
		const report = aggregateImportReport(12, skips, rows)
		expect(report.rowsTotal).toBe(12)
		expect(report.accepted).toBe(5)
		expect(report.skipped).toEqual([
			{ reason: "malformed-row", count: 4 },
			{ reason: "duplicate", count: 2 },
			{ reason: "pack-band-limit", count: 1 },
		])
		expect(report.groupMapping).toEqual([
			{ sourceType: "", group: "other", rule: "fallback-other", count: 1 },
			{ sourceType: "alpha", group: "air", rule: "table", count: 2 },
			{
				sourceType: "alpha",
				group: "marine",
				rule: "name-keyword",
				count: 1,
			},
			{
				sourceType: "zeta",
				group: "other",
				rule: "fallback-other",
				count: 1,
			},
		])
		expect(report.mapped).toBe(3)
		expect(report.toOther).toBe(2)
		expect(report.colourHints).toBe(1)
		expect(sumCounts(report.groupMapping)).toBe(report.accepted)
		expect(sumCounts(report.skipped) + report.accepted).toBe(report.rowsTotal)
	})
})

describe("group mapping properties", () => {
	// Feature: band-plans, Property 11: Group mapping totality
	// Validates: Requirements 3.1, 6.5
	it("maps every type and name to one group and sums report counts", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						name: fc.string({ maxLength: 24 }),
						override: fc.constantFrom(...DISPLAY_GROUPS),
					}),
					{ maxLength: 8 },
				),
				fc.string({ maxLength: 24 }),
				fc.string({ maxLength: 40 }),
				fc.array(
					fc.tuple(
						fc.string({ maxLength: 16 }),
						fc.constantFrom(...DISPLAY_GROUPS),
					),
					{ maxLength: 5 },
				),
				(acceptedRows, sourceType, name, pairs) => {
					const overrides = new Map<string, DisplayGroup>()
					const rows: MappedImportRow[] = acceptedRows.map(
						(accepted, index) => {
							const key = `t${index}`
							overrides.set(key, accepted.override)
							const mapping = mapImportGroup(key, accepted.name, overrides)
							expect(mapping).toEqual({
								group: accepted.override,
								rule: "override",
							})
							expect(DISPLAY_GROUPS).toContain(mapping.group)
							return {
								sourceType: key,
								mapping,
								colourHint: index % 2 === 0 ? "#aabbcc" : null,
							}
						},
					)
					const report = aggregateImportReport(rows.length, new Map(), rows)
					expect(report.accepted).toBe(rows.length)
					expect(sumCounts(report.groupMapping)).toBe(report.accepted)
					expect(report.mapped + report.toOther).toBe(report.accepted)
					expect(report.colourHints).toBe(
						rows.filter(row => row.colourHint !== null).length,
					)
					expect(report.mapped).toBe(
						rows.filter(row => row.mapping.group !== "other").length,
					)
					assertMappingOrder(report.groupMapping)
					expectGroupCounts(report.groupMapping, rows)

					const others = new Map<string, DisplayGroup>()
					for (const [key, group] of pairs) {
						if (key !== sourceType) others.set(key, group)
					}
					const mapping = mapImportGroup(sourceType, name, others)
					expect(DISPLAY_GROUPS).toContain(mapping.group)
					expect([
						"table",
						"name-keyword",
						"override",
						"fallback-other",
					]).toContain(mapping.rule)
					expect(mapping.rule).not.toBe("override")
					const fromTable = SDRPP_TYPE_TABLE[sourceType.toLowerCase()]
					if (fromTable !== undefined) {
						expect(mapping).toEqual({ group: fromTable, rule: "table" })
					}
					if (mapping.rule === "fallback-other")
						expect(mapping.group).toBe("other")
				},
			),
			{ numRuns: 100 },
		)
	})
})

function row(
	sourceType: string,
	group: DisplayGroup,
	rule: MappedImportRow["mapping"]["rule"],
	colourHint: string | null,
): MappedImportRow {
	return { sourceType, mapping: { group, rule }, colourHint }
}

function sumCounts(rows: readonly { readonly count: number }[]): number {
	return rows.reduce((sum, entry) => sum + entry.count, 0)
}

function assertMappingOrder(rows: readonly ImportGroupMappingRow[]): void {
	for (let i = 1; i < rows.length; i++) {
		const prev = rows[i - 1]
		const cur = rows[i]
		if (prev === undefined || cur === undefined) throw new Error("row")
		const typeCmp =
			prev.sourceType < cur.sourceType
				? -1
				: prev.sourceType > cur.sourceType
					? 1
					: 0
		expect(typeCmp).toBeLessThanOrEqual(0)
		if (typeCmp !== 0) continue
		const groupCmp =
			prev.group < cur.group ? -1 : prev.group > cur.group ? 1 : 0
		expect(groupCmp).toBeLessThanOrEqual(0)
		if (groupCmp !== 0) continue
		const ruleCmp = prev.rule < cur.rule ? -1 : prev.rule > cur.rule ? 1 : 0
		expect(ruleCmp).toBeLessThanOrEqual(0)
	}
}

function expectGroupCounts(
	mapping: readonly ImportGroupMappingRow[],
	rows: readonly MappedImportRow[],
): void {
	const expected = new Map<string, number>()
	for (const entry of rows) {
		const key = JSON.stringify([
			entry.sourceType,
			entry.mapping.group,
			entry.mapping.rule,
		])
		expected.set(key, (expected.get(key) ?? 0) + 1)
	}
	expect(mapping).toHaveLength(expected.size)
	for (const entry of mapping) {
		expect(entry.count).toBe(
			expected.get(JSON.stringify([entry.sourceType, entry.group, entry.rule])),
		)
	}
}
