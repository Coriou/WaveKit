/**
 * Presentation budget (WG2 req 1.4-1.6, 1.8). Titles, entity keys and field
 * values are clipped here so a mapper cannot build an envelope the schema
 * rejects for ordinary text. Long texts (pager, APRS, ACARS) use a higher
 * cap than other strings; both caps count the trailing ellipsis.
 */
import { z } from "zod"
import type {
	DecodeField,
	DecodePosition,
	DecodePresentation,
	JsonScalar,
} from "../types.js"

/** At most six display fields (req 1.5). */
export const MAX_FIELDS = 6
/** Title length in UTF-16 code units, matching the envelope's character budget. */
export const MAX_TITLE_CHARS = 80
/** Envelope `text(256)` byte cap, so an 80-character title of wide code points still parses. */
export const MAX_TITLE_BYTES = 256
/** Ordinary string fields (req 1.5). */
export const FIELD_TEXT_BYTES = 64
/**
 * Pager message and ACARS/VDL2 text. Req 1.5 allows 256 bytes. Measured
 * built-row growth for a pager with an 80-character title, function,
 * message type and this much message text is 1,100 bytes, so 126 is the
 * largest cap that satisfies req 1.8. The ellipsis counts toward the cap.
 */
export const LONG_TEXT_BYTES = 126
/**
 * APRS comment, status or message. Only one is shown. Beside an 80-character
 * object title the other APRS fields, 16 bytes grows the built row by 1,097.
 */
export const APRS_TEXT_BYTES = 16
export const ELLIPSIS = "…"

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/
const KEY_RE = /^[a-z][a-z0-9-]*:[^:]+$/
const payloadSchema = z.object({}).passthrough()

export function stripControls(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

/** UTF-8 truncation that never splits a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return ""
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
	const bytes = Buffer.from(value, "utf8").subarray(0, maxBytes)
	let end = bytes.length
	while (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1000_0000) end--
	if (end > 0 && bytes[end - 1]! >= 0b1100_0000) {
		const lead = bytes[end - 1]!
		const width =
			lead >= 0b1111_0000
				? 4
				: lead >= 0b1110_0000
					? 3
					: lead >= 0b1100_0000
						? 2
						: 1
		if (end - 1 + width > bytes.length) end--
	}
	return bytes.subarray(0, end).toString("utf8")
}

/** Strip controls, then clip to `maxBytes` including the ellipsis. */
export function truncateText(value: string, maxBytes: number): string {
	const clean = stripControls(value)
	if (clean === "") return ""
	if (Buffer.byteLength(clean, "utf8") <= maxBytes) return clean
	const mark = Buffer.byteLength(ELLIPSIS, "utf8")
	const kept = truncateUtf8(clean, maxBytes - mark)
	return kept === "" ? "" : kept + ELLIPSIS
}

function clampChars(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value
	let end = maxChars - 1
	const lead = value.charCodeAt(end - 1)
	if (end > 0 && lead >= 0xd800 && lead <= 0xdbff) end--
	return value.slice(0, end) + ELLIPSIS
}

/** Title within 80 characters and 256 bytes, or null when nothing remains. */
export function clampTitle(value: string): string | null {
	const clean = stripControls(value).trim()
	if (clean === "") return null
	let title = clampChars(clean, MAX_TITLE_CHARS)
	if (Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES) {
		const kept = truncateUtf8(
			title,
			MAX_TITLE_BYTES - Buffer.byteLength(ELLIPSIS, "utf8"),
		)
		title = kept === "" ? "" : clampChars(kept, MAX_TITLE_CHARS)
		if (!title.endsWith(ELLIPSIS) && kept !== "")
			title = clampChars(kept + ELLIPSIS, MAX_TITLE_CHARS)
	}
	if (title === "" || title.length > MAX_TITLE_CHARS) return null
	if (
		Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES ||
		CONTROLS.test(title)
	)
		return null
	return title
}

/** `kind:value` or null when the envelope key rule would reject it. */
export function entityKey(kind: string, value: string): string | null {
	if (value.length === 0 || value.includes(":") || CONTROLS.test(value))
		return null
	const key = `${kind}:${value}`
	if (!KEY_RE.test(key) || Buffer.byteLength(key, "utf8") > 128) return null
	return key
}

export function canonicalIcao(raw: string): string | null {
	const hex = raw.trim().toUpperCase()
	if (hex.includes("~") || !/^[0-9A-F]{6}$/.test(hex)) return null
	return hex
}

/** Upper case, SSID `-0` removed. Null when the callsign grammar rejects it. */
export function canonicalCallsign(raw: string): string | null {
	const value = raw.trim().toUpperCase().replace(/-0$/, "")
	if (!/^[A-Z0-9]{1,6}(-[0-9]{1,2})?$/.test(value)) return null
	return value
}

export function canonicalMmsi(raw: unknown): string | null {
	let text: string
	if (typeof raw === "number") {
		if (!Number.isSafeInteger(raw) || raw < 0) return null
		text = String(raw)
	} else if (typeof raw === "string") text = raw.trim()
	else return null
	if (!/^[0-9]{1,9}$/.test(text)) return null
	return text.padStart(9, "0")
}

/** Decimal digits with leading zeros removed (`0` stays `0`). */
export function canonicalCapcode(raw: unknown): string | null {
	let text: string
	if (typeof raw === "number") {
		if (!Number.isSafeInteger(raw) || raw < 0) return null
		text = String(raw)
	} else if (typeof raw === "string") text = raw.trim()
	else return null
	if (!/^[0-9]+$/.test(text)) return null
	const stripped = text.replace(/^0+/, "")
	return stripped === "" ? "0" : stripped
}

/** Registration: upper case, dots removed. */
export function canonicalRegistration(raw: string): string | null {
	const value = stripControls(raw).trim().toUpperCase().replace(/\./g, "")
	return value === "" ? null : value
}

const PROTOCOL_RE = /^[a-z0-9][a-z0-9.+_-]{0,62}$/

export function safeProtocol(value: string): string | undefined {
	const protocol = stripControls(value).trim().toLowerCase()
	if (!PROTOCOL_RE.test(protocol) || Buffer.byteLength(protocol, "utf8") > 64)
		return undefined
	return protocol
}

/** Zod boundary: a plain object, unknown keys kept. Anything else is no payload. */
export function readPayload(
	data: unknown,
): Record<string, unknown> | undefined {
	const parsed = payloadSchema.safeParse(data)
	if (!parsed.success) return undefined
	return parsed.data
}

export function stringField(
	data: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = data[key]
	if (typeof value !== "string") return undefined
	const clean = stripControls(value).trim()
	return clean === "" ? undefined : clean
}

export function numberField(
	data: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = data[key]
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined
	return value
}

export function integerField(
	data: Record<string, unknown>,
	key: string,
	min = 0,
): number | undefined {
	const value = numberField(data, key)
	if (
		value === undefined ||
		!Number.isSafeInteger(value) ||
		!Number.isInteger(value)
	)
		return undefined
	if (value < min) return undefined
	return value
}

export function firstNumber(
	data: Record<string, unknown>,
	keys: readonly string[],
): number | undefined {
	for (const key of keys) {
		const value = numberField(data, key)
		if (value !== undefined) return value
	}
	return undefined
}

export function firstString(
	data: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = stringField(data, key)
		if (value !== undefined) return value
	}
	return undefined
}

export function childRecord(
	data: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = data[key]
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined
	return value as Record<string, unknown>
}

/** Finite in-range lat/lon, never exactly (0, 0), never altitude. */
export function readPosition(
	data: Record<string, unknown>,
): DecodePosition | undefined {
	const lat = data["lat"]
	const lon = data["lon"]
	if (typeof lat !== "number" || typeof lon !== "number") return undefined
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined
	if (lat === 0 && lon === 0) return undefined
	return { lat, lon }
}

export interface FieldDraft {
	key: string
	label: string
	value: unknown
	unit?: string
	maxBytes?: number
}

function scalarValue(value: unknown, maxBytes: number): JsonScalar | undefined {
	if (typeof value === "boolean") return value
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined
	if (typeof value !== "string") return undefined
	const text = truncateText(value, maxBytes)
	return text === "" ? undefined : text
}

/** Present values only, at most six, skipping keys that already are the title. */
export function takeFields(
	drafts: readonly FieldDraft[],
	options?: { title?: string | null; omitKeys?: readonly string[] },
): DecodeField[] {
	const title = options?.title ?? null
	const omit = new Set(options?.omitKeys ?? [])
	const fields: DecodeField[] = []
	const seen = new Set<string>()
	for (const draft of drafts) {
		if (fields.length >= MAX_FIELDS) break
		if (omit.has(draft.key) || seen.has(draft.key)) continue
		if (draft.label.length === 0 || draft.label.length > 24) continue
		const value = scalarValue(draft.value, draft.maxBytes ?? FIELD_TEXT_BYTES)
		if (value === undefined) continue
		if (typeof value === "string" && title !== null && value === title) continue
		seen.add(draft.key)
		const field: DecodeField = { key: draft.key, label: draft.label, value }
		if (draft.unit !== undefined) field.unit = draft.unit
		fields.push(field)
	}
	return fields
}

export function presentation(parts: {
	category: NonNullable<DecodePresentation["category"]>
	protocol?: string | undefined
	entityKey?: string | null | undefined
	title?: string | null | undefined
	position?: DecodePosition | undefined
	fields?: readonly DecodeField[] | undefined
}): DecodePresentation {
	const result: DecodePresentation = { category: parts.category }
	if (parts.protocol !== undefined) result.protocol = parts.protocol
	if (parts.entityKey) result.entityKey = parts.entityKey
	if (parts.title) result.title = parts.title
	if (parts.position) result.position = parts.position
	if (parts.fields !== undefined && parts.fields.length > 0)
		result.fields = parts.fields
	return result
}
