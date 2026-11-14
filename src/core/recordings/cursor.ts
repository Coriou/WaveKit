import {
	RECORDING_INVENTORY_ID,
	RECORDING_INVENTORY_KINDS,
	RECORDINGS_CURSOR_MAX_LENGTH,
	RECORDINGS_PAGE_LIMIT_DEFAULT,
	RECORDINGS_PAGE_LIMIT_MAX,
	RECORDINGS_QUERY_TEXT_MAX,
} from "@wavekit/api-types"
import type {
	RecordingInventoryItem,
	RecordingInventoryKind,
} from "@wavekit/api-types"
import { z } from "zod"

export interface InventoryEntry {
	mtimeMs: number
	item: RecordingInventoryItem
}

export interface CursorValue {
	m: number
	i: string
}

export interface NormalisedQuery {
	limit: number
	cursor: CursorValue | null
	kind: RecordingInventoryKind | null
	decoderId: string | null
	kept: boolean | null
	discoveryId: string | null
	talkgroup: string | null
	source: string | null
	minHz: number | null
	maxHz: number | null
	sinceMs: number | null
	untilMs: number | null
	/** Lower-cased. */
	q: string | null
}

const CursorSchema = z
	.object({
		m: z.number().finite(),
		i: z.string().regex(RECORDING_INVENTORY_ID),
	})
	.strict()

/** Newest first, ties by id ascending (plain code-unit comparison). */
export function compareEntries(a: InventoryEntry, b: InventoryEntry): number {
	return cmp(a.mtimeMs, a.item.id, b.mtimeMs, b.item.id)
}

function cmp(am: number, ai: string, bm: number, bi: string): number {
	if (am !== bm) return am > bm ? -1 : 1
	if (ai === bi) return 0
	return ai < bi ? -1 : 1
}

export function encodeCursor(c: CursorValue): string {
	return Buffer.from(JSON.stringify({ m: c.m, i: c.i }), "utf8").toString(
		"base64url",
	)
}

export function decodeCursor(s: string): CursorValue | null {
	try {
		if (typeof s !== "string") return null
		if (s.length === 0 || s.length > RECORDINGS_CURSOR_MAX_LENGTH) return null
		if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
		const json: unknown = JSON.parse(
			Buffer.from(s, "base64url").toString("utf8"),
		)
		const r = CursorSchema.safeParse(json)
		return r.success ? { m: r.data.m, i: r.data.i } : null
	} catch {
		return null
	}
}

const QUERY_KEYS = new Set([
	"limit",
	"cursor",
	"kind",
	"decoderId",
	"kept",
	"discoveryId",
	"talkgroup",
	"source",
	"minHz",
	"maxHz",
	"since",
	"until",
	"q",
])

/** A scanner discovery id (as SCANNER_DISCOVERY_ID), at most 64 characters. */
const DISCOVERY_ID = /^d_[0-9A-Za-z]{1,62}$/
const DIGITS = /^\d{1,12}$/
/** ISO-8601 with a zone: `2026-11-14T10:00:00Z`, optional fraction, `Z` or `±hh:mm`. */
const ISO_ZONED =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
/** Hz up to 1e12 (well past any receiver), integer, one value. */
const HZ_MAX = 1_000_000_000_000

function parseHz(v: unknown): number | null | undefined {
	if (v === undefined) return undefined
	let n: number
	if (typeof v === "number") n = v
	else if (typeof v === "string" && /^\d{1,13}$/.test(v)) n = Number(v)
	else return null
	return Number.isSafeInteger(n) && n >= 0 && n <= HZ_MAX ? n : null
}

function parseTime(v: unknown): number | null | undefined {
	if (v === undefined) return undefined
	if (typeof v !== "string" || !ISO_ZONED.test(v)) return null
	const ms = Date.parse(v)
	return Number.isFinite(ms) ? ms : null
}

/** The query with no parameter: the default page size, no cursor, no filter. */
export function defaultInventoryQuery(): NormalisedQuery {
	return {
		limit: RECORDINGS_PAGE_LIMIT_DEFAULT,
		cursor: null,
		kind: null,
		decoderId: null,
		kept: null,
		discoveryId: null,
		talkgroup: null,
		source: null,
		minHz: null,
		maxHz: null,
		sinceMs: null,
		untilMs: null,
		q: null,
	}
}

export function parseInventoryQuery(raw: unknown): NormalisedQuery | null {
	const q: NormalisedQuery = defaultInventoryQuery()
	if (raw === undefined || raw === null) return q
	if (typeof raw !== "object" || Array.isArray(raw)) return null
	const obj = raw as Record<string, unknown>
	for (const k of Object.keys(obj)) if (!QUERY_KEYS.has(k)) return null
	const get = (k: string): unknown => {
		if (!Object.hasOwn(obj, k)) return undefined
		return obj[k]
	}
	for (const k of QUERY_KEYS) {
		if (Array.isArray(get(k))) return null
	}
	const limit = get("limit")
	if (limit !== undefined) {
		let n: number
		if (typeof limit === "number") n = limit
		else if (typeof limit === "string" && /^[1-9]\d{0,2}$/.test(limit))
			n = Number(limit)
		else return null
		if (!Number.isInteger(n) || n < 1 || n > RECORDINGS_PAGE_LIMIT_MAX)
			return null
		q.limit = n
	}
	const cursor = get("cursor")
	if (cursor !== undefined) {
		if (typeof cursor !== "string") return null
		const c = decodeCursor(cursor)
		if (!c) return null
		q.cursor = c
	}
	const kind = get("kind")
	if (kind !== undefined) {
		if (
			typeof kind !== "string" ||
			!RECORDING_INVENTORY_KINDS.includes(kind as RecordingInventoryKind)
		)
			return null
		q.kind = kind as RecordingInventoryKind
	}
	const decoderId = get("decoderId")
	if (decoderId !== undefined) {
		if (
			typeof decoderId !== "string" ||
			decoderId.length < 1 ||
			decoderId.length > 128
		)
			return null
		q.decoderId = decoderId
	}
	const kept = get("kept")
	if (kept !== undefined) {
		if (kept === true || kept === "true") q.kept = true
		else if (kept === false || kept === "false") q.kept = false
		else return null
	}
	const discoveryId = get("discoveryId")
	if (discoveryId !== undefined) {
		if (typeof discoveryId !== "string" || !DISCOVERY_ID.test(discoveryId))
			return null
		q.discoveryId = discoveryId
	}
	for (const key of ["talkgroup", "source"] as const) {
		const v = get(key)
		if (v === undefined) continue
		if (typeof v !== "string" || !DIGITS.test(v)) return null
		q[key] = v
	}
	const minHz = parseHz(get("minHz"))
	const maxHz = parseHz(get("maxHz"))
	if (minHz === null || maxHz === null) return null
	if (minHz !== undefined) q.minHz = minHz
	if (maxHz !== undefined) q.maxHz = maxHz
	const since = parseTime(get("since"))
	const until = parseTime(get("until"))
	if (since === null || until === null) return null
	if (since !== undefined) q.sinceMs = since
	if (until !== undefined) q.untilMs = until
	const text = get("q")
	if (text !== undefined) {
		if (
			typeof text !== "string" ||
			text.trim().length < 1 ||
			text.length > RECORDINGS_QUERY_TEXT_MAX
		)
			return null
		q.q = text.trim().toLowerCase()
	}
	return q
}

/** True when `e` sorts strictly after the cursor (it belongs to a later page). */
export function afterCursor(e: InventoryEntry, c: CursorValue | null): boolean {
	return c === null || cmp(e.mtimeMs, e.item.id, c.m, c.i) > 0
}

/**
 * One page of `sorted` (newest first): entries after the cursor that pass `keep` (default: the
 * kind and decoderId filters), at most `q.limit`, and the cursor of the next page.
 */
export function paginate<E extends InventoryEntry>(
	sorted: readonly E[],
	q: NormalisedQuery,
	keep: (e: E) => boolean = e =>
		(q.kind === null || e.item.kind === q.kind) &&
		(q.decoderId === null || e.item.decoderId === q.decoderId),
): {
	entries: E[]
	items: RecordingInventoryItem[]
	nextCursor: string | null
} {
	const entries: E[] = []
	let more = false
	for (const e of sorted) {
		if (!afterCursor(e, q.cursor)) continue
		if (!keep(e)) continue
		if (entries.length >= q.limit) {
			more = true
			break
		}
		entries.push(e)
	}
	const last = entries[entries.length - 1]
	return {
		entries,
		items: entries.map(e => e.item),
		nextCursor:
			more && last ? encodeCursor({ m: last.mtimeMs, i: last.item.id }) : null,
	}
}
