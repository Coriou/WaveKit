/**
 * Display-only mapping for SDR++ import. The tables label categories; they
 * are not frequency plans. Precedence is an exact operator override, then
 * the lowercase type table, then a whole-word keyword in the band name,
 * else "other". A bare "PMR" is not a keyword.
 */
import { createHash } from "node:crypto"
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type {
	BandPlanImportFormat,
	DisplayGroup,
	ImportGroupMappingRow,
	ImportReport,
	ImportSkipReason,
	StoredBand,
} from "@wavekit/api-types"
import type {
	GroupMapping,
	MapImportGroup,
	ParsedImportPreview,
	SdrppFailureReason,
	SdrppParseFailure,
	SdrppParseOptions,
	SdrppParseResult,
} from "../contract.js"

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

// Row rules shared by the import parsers (SDR++ JSON, SDR# XML, Gqrx CSV):
// strict decoding, field parsers, id allocation and preview assembly.
// Everything here is total and never echoes content.

export const NAME_CODE_POINTS = 80
export const SOURCE_TYPE_MAX = 64
const SLUG_MAX = 56
const ID_MAX = 64
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const DECIMAL_PATTERN = /^[0-9]{1,16}$/
const COLOUR_8 = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{6})$/
const COLOUR_6 = /^#?([0-9a-fA-F]{6})$/
const STEP_MAX = 10_000_000
export const TEXT_INVALID = /[\p{Cc}\p{Cs}]/u

type BandMode = NonNullable<StoredBand["mode"]>

const MODE_TABLE: ReadonlyMap<string, BandMode> = new Map<string, BandMode>([
	["am", "am"],
	["fm", "nfm"],
	["nfm", "nfm"],
	["narrow fm", "nfm"],
	["wfm", "wfm"],
	["wfm (mono)", "wfm"],
	["wfm (stereo)", "wfm"],
	["wfm (oirt)", "wfm"],
	["usb", "usb"],
	["lsb", "lsb"],
	["dsb", "dsb"],
	["cw", "cw"],
	["cw-l", "cw"],
	["cw-u", "cw"],
	["cwl", "cw"],
	["cwu", "cw"],
	["raw", "raw"],
])

const IMPORTED_PROVENANCE: StoredBand["provenance"] = Object.freeze({
	kind: "imported",
})

export interface RawImportRow {
	readonly name: string
	readonly minHz: string
	readonly maxHz: string
	readonly mode: string
	readonly step: string | null
	readonly color: string | null
}

export interface AssembleContext {
	readonly format: BandPlanImportFormat
	readonly bytes: Uint8Array
	readonly fileName: string
	readonly overrides: SdrppParseOptions["overrides"]
	readonly rowsExamined: number
}

export interface NormalizedRow {
	readonly name: string
	readonly sourceType: string
	readonly startHz: number
	readonly endHz: number
	readonly colourHint: string | null
	readonly mode?: StoredBand["mode"]
	readonly stepHz?: number | null
}

export function tooLarge(): SdrppParseFailure {
	return { ok: false, code: "BANDPLANS_IMPORT_TOO_LARGE", reason: "too-large" }
}

export function invalid(reason: SdrppFailureReason): SdrppParseFailure {
	return { ok: false, code: "BANDPLANS_IMPORT_INVALID", reason }
}

/** Fatal UTF-8; a leading BOM is stripped. Null when the bytes are not UTF-8. */
export function decodeStrictUtf8(bytes: Uint8Array): string | null {
	let view = bytes
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	)
		view = bytes.subarray(3)
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(view)
	} catch {
		return null
	}
}

/** Decimal integer digits only (no sign, point or exponent); a safe integer. */
export function parseDecimalHz(s: string): number | null {
	if (!DECIMAL_PATTERN.test(s)) return null
	const n = Number(s)
	return Number.isSafeInteger(n) ? n : null
}

export function mapImportMode(modeText: string): BandMode | null {
	return MODE_TABLE.get(modeText.trim().toLowerCase()) ?? null
}

export function parseImportStep(s: string | null): number | null {
	if (s === null) return null
	const n = parseDecimalHz(s.trim())
	if (n === null || n < 1 || n > STEP_MAX) return null
	return n
}

/** AARRGGBB, RRGGBB, #RRGGBB or #AARRGGBB to lowercase #rrggbb. */
export function parseImportColour(s: string | null): string | null {
	if (s === null) return null
	const t = s.trim()
	const m8 = COLOUR_8.exec(t)
	if (m8?.[2] !== undefined) return `#${m8[2].toLowerCase()}`
	const m6 = COLOUR_6.exec(t)
	if (m6?.[1] !== undefined) return `#${m6[1].toLowerCase()}`
	return null
}

/** Trimmed, capped at 64 so it fits an operator override key. */
export function sourceTypeOf(type: string): string {
	const trimmed = type.trim()
	return trimmed.length <= SOURCE_TYPE_MAX
		? trimmed
		: trimmed.slice(0, SOURCE_TYPE_MAX)
}

export function countSkip(
	counts: Map<ImportSkipReason, number>,
	reason: ImportSkipReason,
): void {
	counts.set(reason, (counts.get(reason) ?? 0) + 1)
}

export function exceedsCodePoints(value: string, max: number): boolean {
	let count = 0
	for (let i = 0; i < value.length; ) {
		const code = value.codePointAt(i)
		if (code === undefined) break
		count += 1
		if (count > max) return true
		i += code > 0xffff ? 2 : 1
	}
	return false
}

export function toStoredBand(
	id: string,
	row: NormalizedRow,
	group: StoredBand["group"],
): StoredBand {
	return {
		id,
		name: row.name,
		startHz: row.startHz,
		endHz: row.endHz,
		group,
		mode: row.mode ?? null,
		bandwidthHz: null,
		stepHz: row.stepHz ?? null,
		skip: null,
		channels: [],
		parentId: null,
		colourHint: row.colourHint,
		registryRef: null,
		scan: null,
		provenance: IMPORTED_PROVENANCE,
	}
}

/**
 * Lowercase, collapse non-alphanumerics to "-", trim dashes, keep at most
 * 56 characters, then prefix "b-" unless it starts with a letter. An empty
 * slug becomes "band". Later repeats get "-2", "-3", skipping ids already
 * used in this file.
 */
export function slugFromName(name: string): string {
	let slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/-+$/g, "")
	if (slug.length === 0) return "band"
	if (!/^[a-z]/.test(slug)) return `b-${slug}`
	return slug
}

export function allocateId(base: string, used: Set<string>): string {
	const first = reserve(base, used)
	if (first !== null) return first
	for (let n = 2; n <= 10_000; n++) {
		const next = reserve(fitSuffix(base, n), used)
		if (next !== null) return next
	}
	for (let n = 0; n <= 10_000; n++) {
		const next = reserve(`b-${n.toString(16)}`, used)
		if (next !== null) return next
	}
	// Unreachable within the 512-band pack cap. The outer catch stays total.
	throw new Error("band-id")
}

function fitSuffix(base: string, n: number): string {
	const suffix = `-${n}`
	let stem = base
	if (stem.length + suffix.length > ID_MAX)
		stem = stem.slice(0, ID_MAX - suffix.length).replace(/-+$/g, "")
	if (stem.length === 0 || !/^[a-z]/.test(stem)) stem = "band"
	return stem + suffix
}

function reserve(id: string, used: Set<string>): string | null {
	if (!ID_PATTERN.test(id) || used.has(id)) return null
	used.add(id)
	return id
}

function inspectRaw(raw: RawImportRow): ImportSkipReason | NormalizedRow {
	const startHz = parseDecimalHz(raw.minHz.trim())
	const endHz = parseDecimalHz(raw.maxHz.trim())
	if (startHz === null || endHz === null) return "malformed-row"
	const name = raw.name.trim()
	if (name.length === 0) return "unnamed"
	if (TEXT_INVALID.test(name) || exceedsCodePoints(name, NAME_CODE_POINTS))
		return "text-invalid"
	if (startHz >= endHz) return "invalid-edges"
	if (
		startHz < 1 ||
		endHz < 1 ||
		startHz > BANDPLANS_LIMITS.frequencyHzMax ||
		endHz > BANDPLANS_LIMITS.frequencyHzMax
	)
		return "out-of-range"
	const sourceType = sourceTypeOf(raw.mode)
	if (TEXT_INVALID.test(sourceType)) return "text-invalid"
	return {
		name,
		sourceType,
		startHz,
		endHz,
		colourHint: parseImportColour(raw.color),
		mode: mapImportMode(raw.mode),
		stepHz: parseImportStep(raw.step),
	}
}

/**
 * Apply the SDR++ row rules to raw rows (or rows already rejected by the
 * tokenizer) and build the preview. `rowsExamined` is the report's total.
 */
export function assembleImport(
	entries: readonly (RawImportRow | ImportSkipReason)[],
	ctx: AssembleContext,
): SdrppParseResult {
	const seen = new Set<string>()
	const usedIds = new Set<string>()
	const skipCounts = new Map<ImportSkipReason, number>()
	const rows: MappedImportRow[] = []
	const bands: StoredBand[] = []
	for (const entry of entries) {
		const inspected = typeof entry === "string" ? entry : inspectRaw(entry)
		if (typeof inspected === "string") {
			countSkip(skipCounts, inspected)
			continue
		}
		const key = JSON.stringify([
			inspected.name,
			inspected.startHz,
			inspected.endHz,
		])
		if (seen.has(key)) {
			countSkip(skipCounts, "duplicate")
			continue
		}
		if (bands.length >= BANDPLANS_LIMITS.bandsPerPack) {
			countSkip(skipCounts, "pack-band-limit")
			continue
		}
		seen.add(key)
		const mapping = mapImportGroup(
			inspected.sourceType,
			inspected.name,
			ctx.overrides,
		)
		bands.push(
			toStoredBand(
				allocateId(slugFromName(inspected.name), usedIds),
				inspected,
				mapping.group,
			),
		)
		rows.push({
			sourceType: inspected.sourceType,
			mapping,
			colourHint: inspected.colourHint,
		})
	}
	if (bands.length === 0) return invalid("empty")
	const preview: ParsedImportPreview = {
		format: ctx.format,
		fileName: ctx.fileName,
		bytes: ctx.bytes.length,
		sha256: createHash("sha256").update(ctx.bytes).digest("hex"),
		meta: {
			name: null,
			countryName: null,
			countryCode: null,
			author: null,
			version: null,
		},
		trust: "community-unverified",
		bands,
		report: aggregateImportReport(ctx.rowsExamined, skipCounts, rows),
	}
	return { ok: true, value: { preview, bands } }
}
