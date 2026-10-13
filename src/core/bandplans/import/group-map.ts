/**
 * Display-only mapping for SDR++ import. The tables label categories; they
 * are not frequency plans. Precedence is an exact operator override, then
 * the lowercase type table, then a whole-word keyword in the band name,
 * else "other". A bare "PMR" is not a keyword.
 */
import type {
	DisplayGroup,
	ImportGroupMappingRow,
	ImportReport,
	ImportSkipReason,
} from "@wavekit/api-types"
import type { GroupMapping, MapImportGroup } from "../contract.js"

export interface NameKeyword {
	readonly keyword: string
	readonly group: DisplayGroup
}

export interface MappedImportRow {
	readonly sourceType: string
	readonly mapping: GroupMapping
	readonly colourHint: string | null
}

/** Lowercase SDR++ `type` → display group. Unknown types fall through. */
export const SDRPP_TYPE_TABLE: Readonly<Record<string, DisplayGroup>> =
	Object.freeze({
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
	})

/**
 * Whole-word, case-insensitive. The leftmost match wins; a longer keyword
 * wins when two start at the same index. List order breaks remaining ties.
 */
export const SDRPP_NAME_KEYWORDS: readonly NameKeyword[] = Object.freeze([
	keywordEntry("broadcast", "broadcast"),
	keywordEntry("airband", "air"),
	keywordEntry("amateur", "amateur"),
	keywordEntry("marine", "marine"),
	keywordEntry("pagers", "pagers"),
	keywordEntry("PMR446", "personal-radio"),
	keywordEntry("POCSAG", "pagers"),
	keywordEntry("pager", "pagers"),
	keywordEntry("AIS", "marine"),
	keywordEntry("DAB", "broadcast"),
	keywordEntry("ham", "amateur"),
	keywordEntry("ISM", "ism-srd"),
	keywordEntry("LPD", "personal-radio"),
	keywordEntry("SRD", "ism-srd"),
	keywordEntry("CB", "personal-radio"),
])

/** Check order, used as the stable order of skip counts in a report. */
const SKIP_REASON_ORDER = [
	"malformed-row",
	"unnamed",
	"text-invalid",
	"invalid-edges",
	"out-of-range",
	"duplicate",
	"pack-band-limit",
] as const satisfies readonly ImportSkipReason[]

const TYPE_LOOKUP: ReadonlyMap<string, DisplayGroup> = new Map(
	Object.entries(SDRPP_TYPE_TABLE),
)

function keywordEntry(keyword: string, group: DisplayGroup): NameKeyword {
	return Object.freeze({ keyword, group })
}

function isAsciiWord(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122)
	)
}

function keywordGroup(name: string): DisplayGroup | undefined {
	const lower = name.toLowerCase()
	let bestIndex = Number.POSITIVE_INFINITY
	let bestLength = -1
	let bestGroup: DisplayGroup | undefined
	for (const entry of SDRPP_NAME_KEYWORDS) {
		const needle = entry.keyword.toLowerCase()
		let from = 0
		while (from <= lower.length) {
			const index = lower.indexOf(needle, from)
			if (index < 0) break
			const beforeOk = index === 0 || !isAsciiWord(lower.charCodeAt(index - 1))
			const afterAt = index + needle.length
			const afterOk =
				afterAt >= lower.length || !isAsciiWord(lower.charCodeAt(afterAt))
			if (beforeOk && afterOk) {
				if (
					index < bestIndex ||
					(index === bestIndex && needle.length > bestLength)
				) {
					bestIndex = index
					bestLength = needle.length
					bestGroup = entry.group
				}
				break
			}
			from = index + 1
		}
	}
	return bestGroup
}

export const mapImportGroup: MapImportGroup = (
	sourceType,
	bandName,
	overrides,
) => {
	if (overrides.has(sourceType)) {
		const group = overrides.get(sourceType)
		if (group !== undefined) return { group, rule: "override" }
	}
	const fromTable = TYPE_LOOKUP.get(sourceType.toLowerCase())
	if (fromTable !== undefined) return { group: fromTable, rule: "table" }
	const fromName = keywordGroup(bandName)
	if (fromName !== undefined) return { group: fromName, rule: "name-keyword" }
	return { group: "other", rule: "fallback-other" }
}

export function aggregateImportReport(
	rowsTotal: number,
	skipCounts: ReadonlyMap<ImportSkipReason, number>,
	rows: readonly MappedImportRow[],
): ImportReport {
	const skipped: { reason: ImportSkipReason; count: number }[] = []
	for (const reason of SKIP_REASON_ORDER) {
		const count = skipCounts.get(reason) ?? 0
		if (count > 0) skipped.push({ reason, count })
	}
	const buckets = new Map<string, ImportGroupMappingRow>()
	let mapped = 0
	let toOther = 0
	let colourHints = 0
	for (const row of rows) {
		if (row.mapping.group === "other") toOther += 1
		else mapped += 1
		if (row.colourHint !== null) colourHints += 1
		const key = JSON.stringify([
			row.sourceType,
			row.mapping.group,
			row.mapping.rule,
		])
		const existing = buckets.get(key)
		if (existing) {
			buckets.set(key, { ...existing, count: existing.count + 1 })
		} else {
			buckets.set(key, {
				sourceType: row.sourceType,
				group: row.mapping.group,
				rule: row.mapping.rule,
				count: 1,
			})
		}
	}
	const groupMapping = [...buckets.values()].sort(compareMappingRows)
	return {
		rowsTotal,
		accepted: rows.length,
		skipped,
		groupMapping,
		mapped,
		toOther,
		colourHints,
	}
}

function compareMappingRows(
	a: ImportGroupMappingRow,
	b: ImportGroupMappingRow,
): number {
	if (a.sourceType < b.sourceType) return -1
	if (a.sourceType > b.sourceType) return 1
	if (a.group < b.group) return -1
	if (a.group > b.group) return 1
	if (a.rule < b.rule) return -1
	if (a.rule > b.rule) return 1
	return 0
}
