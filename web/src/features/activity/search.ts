// Activity search: typed tokens (talkgroup, capcode, MMSI, ICAO, callsign, frequency, CTCSS, DCS, an
// entity, plain text) and category chips, turned into one core ActivityQuery. The core searches text
// as AND-ed whole words (src/core/activity/query/fts.ts), so typed identifiers become text terms
// narrowed by the categories they belong to; a frequency becomes a range and an entity an exact key.
import type { ActivityCategory, ActivityQuery } from "@wavekit/api-types"

import { formatMHz } from "../format.ts"

export type TokenKind =
	| "talkgroup"
	| "capcode"
	| "mmsi"
	| "icao"
	| "callsign"
	| "frequency"
	| "ctcss"
	| "dcs"
	| "entity"
	| "text"

export interface SearchToken {
	kind: TokenKind
	/** The searched value: digits, a callsign, text; Hz for a frequency; the key for an entity. */
	value: string
	/** What the chip shows. */
	label: string
	/** Frequency tokens: half the matched width. */
	spanHz?: number
}

export const CATEGORY_CHIPS = [
	{ id: "voice", label: "Voice", categories: ["voice"] },
	{ id: "paging", label: "Pagers", categories: ["paging"] },
	{
		id: "aircraft",
		label: "Aircraft",
		categories: ["aircraft", "aviation-data"],
	},
	{ id: "marine", label: "Marine", categories: ["marine"] },
	{ id: "aprs", label: "APRS", categories: ["aprs"] },
	{ id: "sensors", label: "Sensors", categories: ["sensors"] },
	{ id: "mesh", label: "Mesh", categories: ["mesh"] },
] as const satisfies readonly {
	id: string
	label: string
	categories: readonly ActivityCategory[]
}[]

export type CategoryChipId = (typeof CATEGORY_CHIPS)[number]["id"]

const TOKEN_CATEGORIES: Partial<
	Record<TokenKind, readonly ActivityCategory[]>
> = {
	talkgroup: ["voice"],
	capcode: ["paging"],
	mmsi: ["marine"],
	icao: ["aircraft", "aviation-data"],
	callsign: ["aprs"],
	ctcss: ["voice"],
	dcs: ["voice"],
}

/** The 50 standard CTCSS tones (Hz). */
export const CTCSS_TONES: readonly number[] = [
	67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0,
	103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2,
	150.0, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9,
	183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7,
	229.1, 233.6, 241.8, 250.3, 254.1,
]

/** Default half width of a typed frequency: one 12.5 kHz channel. */
export const FREQUENCY_SPAN_HZ = 6250

const LABEL: Record<TokenKind, string> = {
	talkgroup: "TG",
	capcode: "Capcode",
	mmsi: "MMSI",
	icao: "ICAO",
	callsign: "Callsign",
	frequency: "",
	ctcss: "CTCSS",
	dcs: "DCS",
	entity: "",
	text: "",
}

export function token(
	kind: TokenKind,
	value: string,
	extra: Partial<SearchToken> = {},
): SearchToken {
	const label =
		kind === "frequency"
			? `${formatMHz(Number(value))} MHz`
			: kind === "ctcss"
				? `CTCSS ${value} Hz`
				: kind === "text"
					? `“${value}”`
					: kind === "entity"
						? value
						: `${LABEL[kind]} ${value}`
	return { kind, value, label, ...extra }
}

export function frequencyToken(
	hz: number,
	spanHz = FREQUENCY_SPAN_HZ,
): SearchToken {
	return token("frequency", String(Math.round(hz)), { spanHz })
}

const PREFIXES: readonly [RegExp, TokenKind][] = [
	[/^(?:tg|talkgroup)\s*:?\s*(\d{1,8})$/i, "talkgroup"],
	[/^(?:capcode|cap|ric)\s*:?\s*(\d{1,8})$/i, "capcode"],
	[/^mmsi\s*:?\s*(\d{9})$/i, "mmsi"],
	[/^(?:icao|hex)\s*:?\s*([0-9a-f]{6})$/i, "icao"],
	[/^(?:call|callsign)\s*:?\s*([a-z0-9]{3,7}(?:-\d{1,2})?)$/i, "callsign"],
	[/^ctcss\s*:?\s*(\d{2,3}(?:\.\d)?)$/i, "ctcss"],
	[/^dcs\s*:?\s*([0-7]{3}[ni]?)$/i, "dcs"],
]

function ctcssValue(raw: string): string | null {
	const n = Number(raw)
	return CTCSS_TONES.some(t => Math.abs(t - n) < 0.05) ? n.toFixed(1) : null
}

/** Parses "145.6375", "145.6375 MHz", "433920 kHz", "161150000 Hz" into Hz, or null. */
export function parseFrequency(raw: string): number | null {
	const m = /^(\d+(?:[.,]\d+)?)\s*(mhz|khz|hz|m|k)?$/i.exec(raw.trim())
	if (!m?.[1]) return null
	const n = Number(m[1].replace(",", "."))
	const unit = (m[2] ?? "").toLowerCase()
	const decimal = m[1].includes(".") || m[1].includes(",")
	let hz: number | null = null
	if (unit === "hz") hz = n
	else if (unit === "khz" || unit === "k") hz = n * 1e3
	else if (unit === "mhz" || unit === "m" || decimal) hz = n * 1e6
	if (hz === null || !Number.isFinite(hz)) return null
	return hz >= 1e5 && hz <= 7e9 ? Math.round(hz) : null
}

/**
 * What the typed text could mean, best guess first. Enter takes the first; the rest show as
 * suggestion chips. Empty input suggests nothing.
 */
export function suggest(input: string): SearchToken[] {
	const raw = input.trim()
	if (raw.length === 0) return []
	for (const [re, kind] of PREFIXES) {
		const m = re.exec(raw)
		if (!m?.[1]) continue
		if (kind === "ctcss") {
			const v = ctcssValue(m[1])
			if (v !== null) return [token("ctcss", v)]
			continue
		}
		const v =
			kind === "icao" || kind === "callsign" || kind === "dcs"
				? m[1].toUpperCase()
				: m[1]
		return [token(kind, v)]
	}
	const out: SearchToken[] = []
	const tone = /^\d{2,3}\.\d$/.test(raw) ? ctcssValue(raw) : null
	const hz = parseFrequency(raw)
	if (tone !== null) out.push(token("ctcss", tone))
	if (hz !== null) out.push(frequencyToken(hz))
	if (/^\d+$/.test(raw)) {
		if (raw.length === 9) out.push(token("mmsi", raw))
		if (raw.length === 7) out.push(token("capcode", raw))
		if (raw.length <= 8) out.push(token("talkgroup", raw))
		if (raw.length !== 7 && raw.length <= 8) out.push(token("capcode", raw))
	} else if (/^[0-9a-f]{6}$/i.test(raw) && /[a-f]/i.test(raw)) {
		out.push(token("icao", raw.toUpperCase()))
	} else if (/^[a-z]{1,2}\d[a-z]{1,4}(?:-\d{1,2})?$/i.test(raw)) {
		out.push(token("callsign", raw.toUpperCase()))
	}
	out.push(token("text", raw))
	return out
}

/** The tokens' search words (identifier values and plain text) for the core's text filter. */
function textOf(t: SearchToken): string | null {
	switch (t.kind) {
		case "frequency":
		case "entity":
			return null
		case "dcs":
			return t.value.replace(/[NI]$/i, "")
		default:
			return t.value
	}
}

function intersect(
	a: readonly ActivityCategory[] | null,
	b: readonly ActivityCategory[],
): ActivityCategory[] {
	return a === null ? [...b] : a.filter(c => b.includes(c))
}

/**
 * One core query for the tokens and the category chip, or null when they cannot match anything
 * (two frequencies, or categories that exclude each other).
 */
export function buildQuery(
	tokens: readonly SearchToken[],
	chip: CategoryChipId | null,
): ActivityQuery | null {
	const q: ActivityQuery = {}
	let categories: ActivityCategory[] | null = null
	if (chip !== null) {
		const def = CATEGORY_CHIPS.find(c => c.id === chip)
		if (def) categories = [...def.categories]
	}
	const words: string[] = []
	for (const t of tokens) {
		const cats = TOKEN_CATEGORIES[t.kind]
		if (cats) categories = intersect(categories, cats)
		if (t.kind === "frequency") {
			if (q.frequencyHz) return null
			const hz = Number(t.value)
			const span = t.spanHz ?? FREQUENCY_SPAN_HZ
			q.frequencyHz = { min: hz - span, max: hz + span }
		} else if (t.kind === "entity") {
			if (q.entityKey !== undefined && q.entityKey !== t.value) return null
			q.entityKey = t.value
		}
		const w = textOf(t)
		if (w !== null) words.push(w)
	}
	if (categories !== null) {
		if (categories.length === 0) return null
		q.categories = categories
	}
	if (words.length > 0) q.text = words.join(" ")
	return q
}

/** The search as one short title (pinned searches, the list header). */
export function searchTitle(
	tokens: readonly SearchToken[],
	chip: CategoryChipId | null,
): string {
	const chipLabel = CATEGORY_CHIPS.find(c => c.id === chip)?.label
	const parts = tokens.map(t => t.label)
	if (chipLabel) parts.unshift(chipLabel)
	return parts.length > 0 ? parts.join(" · ") : "All activity"
}
