/**
 * Presentation budget (WG2 req 1.4-1.6, 1.8). Titles, entity keys and field
 * values are clipped here so a mapper cannot build an envelope the schema
 * rejects for ordinary text. Long texts (pager, APRS, ACARS) use a higher
 * cap than other strings; both caps count the trailing ellipsis.
 * `fitRowBudget` then measures summary + record + FTS and shortens whatever
 * still exceeds req 1.8 (wide titles, long coordinates, multibyte text).
 */
import { z } from "zod"
import type { DecoderOutput } from "../../../decoders/types.js"
import { createDecodeEnvelope } from "../envelope.js"
import { ACTIVITY_RECORD_VERSION } from "../storage/contract.js"
import { isCoalescibleShape } from "../storage/coalesce.js"
import { buildActivityRow } from "../storage/row.js"
import type {
	DecodeEnvelopeContext,
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
 * Pager message and ACARS/VDL2 text. Req 1.5 allows 256 bytes. 126 is the
 * largest cap whose worst ASCII pager (80-character title, function,
 * message type, saturated FTS) grows the built row by 1,100 bytes. Wider
 * text is shortened again by `fitRowBudget`. The ellipsis counts.
 */
export const LONG_TEXT_BYTES = 126
/**
 * APRS comment, status or message. Only one is shown. Beside an 80-character
 * object title the other APRS fields, 16 bytes grows the built row by 1,097.
 */
export const APRS_TEXT_BYTES = 16
/** Req 1.8. A 1.6 reception, and any other reception. */
export const ROW_GROWTH_COALESCED_BYTES = 160
export const ROW_GROWTH_MAX_BYTES = 1_100
export const ELLIPSIS = "…"

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/
const KEY_RE = /^[a-z][a-z0-9-]*:[^:]+$/
const payloadSchema = z.object({}).passthrough()

export function stripControls(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

/**
 * UTF-8 truncation that never splits a code point. A cut that lands on a
 * character boundary keeps that character; a cut inside one steps back to
 * the lead byte and drops it.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return ""
	const bytes = Buffer.from(value, "utf8")
	if (bytes.length <= maxBytes) return value
	let end = maxBytes
	while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--
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
	if (CONTROLS.test(raw)) return null
	const hex = raw.trim().toUpperCase()
	if (hex.includes("~") || !/^[0-9A-F]{6}$/.test(hex)) return null
	return hex
}

/** Upper case, SSID `-0` removed. Null when the callsign grammar rejects it. */
export function canonicalCallsign(raw: string): string | null {
	if (CONTROLS.test(raw)) return null
	const value = raw.trim().toUpperCase().replace(/-0$/, "")
	if (!/^[A-Z0-9]{1,6}(-[0-9]{1,2})?$/.test(value)) return null
	return value
}

export function canonicalMmsi(raw: unknown): string | null {
	let text: string
	if (typeof raw === "number") {
		if (!Number.isSafeInteger(raw) || raw < 0) return null
		text = String(raw)
	} else if (typeof raw === "string") {
		if (CONTROLS.test(raw)) return null
		text = raw.trim()
	} else return null
	if (!/^[0-9]{1,9}$/.test(text)) return null
	return text.padStart(9, "0")
}

/** Decimal digits with leading zeros removed (`0` stays `0`). */
export function canonicalCapcode(raw: unknown): string | null {
	let text: string
	if (typeof raw === "number") {
		if (!Number.isSafeInteger(raw) || raw < 0) return null
		text = String(raw)
	} else if (typeof raw === "string") {
		if (CONTROLS.test(raw)) return null
		text = raw.trim()
	} else return null
	if (!/^[0-9]+$/.test(text)) return null
	const stripped = text.replace(/^0+/, "")
	return stripped === "" ? "0" : stripped
}

/**
 * Registration: upper case, dots removed. A control character is invalid;
 * it is not stripped into a different registration.
 */
export function canonicalRegistration(raw: string): string | null {
	if (CONTROLS.test(raw)) return null
	const value = raw.trim().toUpperCase().replace(/\./g, "")
	return value === "" ? null : value
}

/**
 * Identifier text. Control characters reject the value. Display strings use
 * `stringField`, which strips those characters instead.
 */
export function identifierText(
	data: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = data[key]
	if (typeof value !== "string" || CONTROLS.test(value)) return undefined
	const clean = value.trim()
	return clean === "" ? undefined : clean
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

/** Consumed fields. Null and absence are allowed; a wrong type rejects the payload. */
export const asString = z.string().nullish()
export const asNumber = z.number().nullish()
export const asNumberOrString = z.union([z.number(), z.string()]).nullish()
export const asScalar = z.union([z.string(), z.number(), z.boolean()]).nullish()

/** Per-type object schema. Unknown keys are kept. */
export function objectSchema(shape: z.ZodRawShape) {
	return z.object(shape).passthrough()
}

export function parsePayload(
	schema: z.ZodType,
	data: unknown,
): Record<string, unknown> | undefined {
	const parsed = schema.safeParse(data)
	if (!parsed.success) return undefined
	if (
		typeof parsed.data !== "object" ||
		parsed.data === null ||
		Array.isArray(parsed.data)
	)
		return undefined
	return parsed.data as Record<string, unknown>
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

const BUDGET_AT = new Date("2026-10-13T00:00:00.000Z")

function rowLimit(output: DecoderOutput): number {
	const data = output.data
	if (
		typeof data === "object" &&
		data !== null &&
		!Array.isArray(data) &&
		isCoalescibleShape(output.type, data as { readonly [key: string]: unknown })
	)
		return ROW_GROWTH_COALESCED_BYTES
	return ROW_GROWTH_MAX_BYTES
}

function builtBytes(envelope: ReturnType<typeof createDecodeEnvelope>): number {
	const row = buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId: envelope.eventId,
		commitSeq: "0",
		producedAt: envelope.producedAt,
		receivedAt: envelope.receivedAt,
		kind: "decoder-reception",
		payload: envelope,
	})
	return (
		Buffer.byteLength(row.summaryJson, "utf8") +
		Buffer.byteLength(row.recordJson, "utf8") +
		Buffer.byteLength(row.ftsText, "utf8")
	)
}

/**
 * Smallest envelope that can still be stored. A fatter synthetic context
 * rejects near-cap payloads that a real short id would accept, which skipped
 * the row budget. Ingress passes its own context when it has one.
 */
function budgetContext(
	output: DecoderOutput,
	context: DecodeEnvelopeContext | undefined,
): DecodeEnvelopeContext {
	if (context) return context
	return {
		eventId: "e",
		receivedAt: BUDGET_AT,
		decoderId: output.decoder,
		provenance: { sourceId: null, frequency: null },
	}
}

/**
 * Bytes added by this presentation. Undefined when either envelope is
 * rejected: the ingress then rebuilds without the presentation (req 1.7).
 */
function measureGrowth(
	output: DecoderOutput,
	view: DecodePresentation,
	context: DecodeEnvelopeContext,
	plainBytes: { current: number | undefined },
): number | undefined {
	try {
		if (plainBytes.current === undefined)
			plainBytes.current = builtBytes(createDecodeEnvelope(output, context))
		return (
			builtBytes(createDecodeEnvelope(output, context, view)) -
			plainBytes.current
		)
	} catch {
		return undefined
	}
}

function roundCoord(value: number, digits: number): number {
	return Number(value.toFixed(digits))
}

function roundPosition(
	position: DecodePosition,
	digits: number,
): DecodePosition | undefined {
	const lat = roundCoord(position.lat, digits)
	const lon = roundCoord(position.lon, digits)
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined
	if (lat === 0 && lon === 0) return undefined
	return { lat, lon }
}

function reshape(
	view: DecodePresentation,
	patch: {
		title?: string | null
		position?: DecodePosition | null
		fields?: readonly DecodeField[] | null
	},
): DecodePresentation {
	const title = patch.title === undefined ? view.title : patch.title
	const position =
		patch.position === undefined
			? view.position
			: patch.position === null
				? undefined
				: patch.position
	const fields =
		patch.fields === undefined
			? view.fields
			: patch.fields === null || patch.fields.length === 0
				? undefined
				: patch.fields
	return presentation({
		category: view.category ?? "other",
		protocol: view.protocol ?? undefined,
		entityKey: view.entityKey,
		title,
		position,
		fields,
	})
}

function clipTitle(title: string, maxChars: number): string | null {
	if (maxChars <= 0) return null
	if (title.length <= maxChars) return title
	const clipped = clampChars(title, maxChars)
	if (
		clipped === "" ||
		clipped.length > MAX_TITLE_CHARS ||
		Buffer.byteLength(clipped, "utf8") > MAX_TITLE_BYTES ||
		CONTROLS.test(clipped)
	)
		return null
	return clipped
}

function shrinkStrings(
	fields: readonly DecodeField[],
	maxBytes: number,
): DecodeField[] {
	const next: DecodeField[] = []
	for (const field of fields) {
		if (typeof field.value !== "string") {
			next.push(field)
			continue
		}
		if (Buffer.byteLength(field.value, "utf8") <= maxBytes) {
			next.push(field)
			continue
		}
		const value = truncateText(field.value, maxBytes)
		if (value === "") continue
		next.push({ ...field, value })
	}
	return next
}

/**
 * Shorten a presentation until its built-row growth is within req 1.8.
 * An envelope the schema rejects is returned unchanged so ingress can
 * count the failure and store the reception without it.
 */
export function fitRowBudget(
	output: DecoderOutput,
	view: DecodePresentation,
	context?: DecodeEnvelopeContext,
): DecodePresentation {
	const limit = rowLimit(output)
	const measuredContext = budgetContext(output, context)
	const plainBytes: { current: number | undefined } = { current: undefined }
	const growth = (candidate: DecodePresentation) =>
		measureGrowth(output, candidate, measuredContext, plainBytes)
	const initial = growth(view)
	if (initial === undefined || initial <= limit) return view

	let current = view
	let bestGrowth = initial
	const adopt = (candidate: DecodePresentation, measured: number): boolean => {
		if (measured <= limit) return true
		if (measured < bestGrowth) {
			current = candidate
			bestGrowth = measured
		}
		return false
	}
	const originalPosition = view.position

	if (current.fields && current.fields.length > 0) {
		for (const cap of [96, 64, 48, 32, 24, 16, 8, 4]) {
			const fields = shrinkStrings(current.fields, cap)
			const candidate = reshape(current, { fields })
			const measured = growth(candidate)
			if (measured === undefined) continue
			if (adopt(candidate, measured)) return candidate
		}
	}

	// The longest title that fits at full precision or six decimal places
	// (~0.1 m) wins. Coarser fixes are used only when no title fits at that
	// precision. Each candidate is rounded from the original, so 51.5 cannot
	// become 52.
	const title = current.title
	const attempt = (
		nextTitle: string | null | undefined,
		digits: number | undefined,
	): DecodePresentation | undefined => {
		const patch: {
			title?: string | null
			position?: DecodePosition | null
		} = {}
		if (nextTitle !== undefined) patch.title = nextTitle
		if (digits !== undefined) {
			if (!originalPosition) return undefined
			const position = roundPosition(originalPosition, digits)
			if (!position) return undefined
			patch.position = position
		}
		const candidate = reshape(current, patch)
		const measured = growth(candidate)
		if (measured === undefined) return undefined
		if (adopt(candidate, measured)) return candidate
		return undefined
	}
	const clippedTitles = (value: string): Array<string | null> => {
		const clipped: Array<string | null> = [value]
		for (let chars = value.length - 1; chars >= 0; chars -= 1)
			clipped.push(clipTitle(value, chars))
		return clipped
	}
	if (title) {
		const clipped = clippedTitles(title)
		for (const nextTitle of clipped) {
			const fitted = attempt(nextTitle, undefined)
			if (fitted) return fitted
			if (originalPosition) {
				const rounded = attempt(nextTitle, 6)
				if (rounded) return rounded
			}
		}
		if (originalPosition) {
			for (const digits of [5, 4, 3, 2, 1, 0]) {
				for (const nextTitle of clipped) {
					const fitted = attempt(nextTitle, digits)
					if (fitted) return fitted
				}
			}
		}
	} else if (originalPosition) {
		for (const digits of [6, 5, 4, 3, 2, 1, 0]) {
			const fitted = attempt(undefined, digits)
			if (fitted) return fitted
		}
	}

	while (current.fields && current.fields.length > 0) {
		const fields = current.fields.slice(0, -1)
		const candidate = reshape(current, { fields })
		const measured = growth(candidate)
		if (measured === undefined) break
		if (adopt(candidate, measured)) return candidate
	}

	if (current.position) {
		const candidate = reshape(current, { position: null })
		const measured = growth(candidate)
		if (measured !== undefined && adopt(candidate, measured)) return candidate
	}

	if (current.title) {
		const candidate = reshape(current, { title: null })
		const measured = growth(candidate)
		if (measured !== undefined && adopt(candidate, measured)) return candidate
	}

	return current
}
