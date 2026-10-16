import {
	RECORDING_INVENTORY_ID,
	RECORDING_INVENTORY_KINDS,
	RECORDINGS_CURSOR_MAX_LENGTH,
	RECORDINGS_PAGE_LIMIT_DEFAULT,
	RECORDINGS_PAGE_LIMIT_MAX,
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

const QUERY_KEYS = new Set(["limit", "cursor", "kind", "decoderId"])

export function parseInventoryQuery(raw: unknown): NormalisedQuery | null {
	const q: NormalisedQuery = {
		limit: RECORDINGS_PAGE_LIMIT_DEFAULT,
		cursor: null,
		kind: null,
		decoderId: null,
	}
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
	return q
}

export function paginate(
	sorted: readonly InventoryEntry[],
	q: NormalisedQuery,
): { items: RecordingInventoryItem[]; nextCursor: string | null } {
	const items: RecordingInventoryItem[] = []
	let last: InventoryEntry | null = null
	let more = false
	for (const e of sorted) {
		if (q.kind !== null && e.item.kind !== q.kind) continue
		if (q.decoderId !== null && e.item.decoderId !== q.decoderId) continue
		if (q.cursor && cmp(e.mtimeMs, e.item.id, q.cursor.m, q.cursor.i) <= 0)
			continue
		if (items.length >= q.limit) {
			more = true
			break
		}
		items.push(e.item)
		last = e
	}
	return {
		items,
		nextCursor:
			more && last ? encodeCursor({ m: last.mtimeMs, i: last.item.id }) : null,
	}
}
