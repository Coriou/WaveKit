import type {
	ActivityRecord,
	ActivitySummary,
	ActivityTrails,
} from "../storage/contract.js"
import {
	activityRecordCorrupt,
	ActivityQueryInvalidError,
	ActivityReaderFailedError,
} from "./errors.js"
import { bindSeq, formatSeq, MAX_SEQ, parseSeq, seqFromSqlite } from "./seq.js"
import type { SqlDatabase, SqlValue } from "./sqlite.js"
import { readTrails, type TrailsReadInput } from "./trails.js"
import type { FacetDimension, NormalisedQuery } from "./validate.js"

export interface SummaryRow {
	seq: string
	summary: ActivitySummary
}

interface SearchReadRequest {
	op: "search"
	query: NormalisedQuery
	order: "asc" | "desc"
	limit: number
	low: string
	high: string
	before: string | null
	after: string | null
}

interface FacetsReadRequest {
	op: "facets"
	query: NormalisedQuery
	dimensions: FacetDimension[]
	low: string
	high: string
	scanCap: number
	valueCap: number
}

export type ReadRequest =
	| SearchReadRequest
	| { op: "detail"; eventId: string }
	| FacetsReadRequest
	| { op: "trails"; input: TrailsReadInput }

/** Store identity read in the same transaction as the rows. */
export interface ObservedStore {
	storeUuid: string
	restoreGeneration: number
	pruneWatermark: string
	/** WG3: "0" when the key is absent. */
	holeWatermark: string
	/** WG3: 0 when the key is absent. */
	holeGeneration: number
}

interface SearchBody {
	op: "search"
	rows: SummaryRow[]
}

interface DetailBody {
	op: "detail"
	record: ActivityRecord | null
}

interface FacetsBody {
	op: "facets"
	facets: Record<string, { value: string | null; count: number }[]>
	scanned: number
	truncated: boolean
}

interface TrailsBody {
	op: "trails"
	trails: ActivityTrails
}

type ReadBody = SearchBody | DetailBody | FacetsBody | TrailsBody

export type ReadResult =
	| (SearchBody & { observed: ObservedStore })
	| (DetailBody & { observed: ObservedStore })
	| (FacetsBody & { observed: ObservedStore })
	| (TrailsBody & { observed: ObservedStore })

const FACET_COLUMN: Record<FacetDimension, string> = {
	category: "category",
	protocol: "protocol",
	decoderId: "decoder_id",
	sourceId: "source_id",
	kind: "kind",
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function appendIn(
	where: string[],
	params: SqlValue[],
	column: string,
	values: readonly string[],
): void {
	if (values.length === 0) return
	where.push(`${column} IN (${values.map(() => "?").join(", ")})`)
	for (const value of values) params.push(value)
}

function appendFilters(
	where: string[],
	params: SqlValue[],
	query: NormalisedQuery,
): void {
	appendIn(where, params, "kind", query.kinds)
	appendIn(where, params, "source_id", query.sourceIds)
	appendIn(where, params, "decoder_id", query.decoderIds)
	appendIn(where, params, "protocol", query.protocols)
	appendIn(where, params, "category", query.categories)
	if (query.frequencyMin !== null) {
		where.push("frequency_hz >= ?")
		params.push(query.frequencyMin)
	}
	if (query.frequencyMax !== null) {
		where.push("frequency_hz <= ?")
		params.push(query.frequencyMax)
	}
	if (query.producedFromMs !== null) {
		where.push("produced_at_ms >= ?")
		params.push(query.producedFromMs)
	}
	if (query.producedToMs !== null) {
		where.push("produced_at_ms <= ?")
		params.push(query.producedToMs)
	}
	if (query.entityKey !== null) {
		where.push("entity_key = ?")
		params.push(query.entityKey)
	}
	for (const ref of query.refs) {
		where.push(
			"EXISTS (SELECT 1 FROM activity_refs WHERE activity_refs.seq = activity.seq AND activity_refs.ref_type = ? AND activity_refs.ref_value = ?)",
		)
		params.push(ref.type, ref.value)
	}
	if (query.fts.kind === "impossible") where.push("1 = 0")
	else if (query.fts.kind === "match") {
		where.push(
			"seq IN (SELECT rowid FROM activity_fts WHERE activity_fts MATCH ?)",
		)
		params.push(query.fts.match)
	}
}

function bounds(request: {
	low: string
	high: string
	before: string | null
	after: string | null
}): { where: string[]; params: SqlValue[] } {
	const where = ["seq > ?", "seq <= ?"]
	const params: SqlValue[] = [
		bindSeq(parseSeq(request.low)),
		bindSeq(parseSeq(request.high)),
	]
	if (request.before !== null) {
		where.push("seq < ?")
		params.push(bindSeq(parseSeq(request.before)))
	}
	if (request.after !== null) {
		where.push("seq > ?")
		params.push(bindSeq(parseSeq(request.after)))
	}
	return { where, params }
}

function readSummary(
	seq: bigint,
	eventId: unknown,
	json: unknown,
): ActivitySummary {
	if (typeof eventId !== "string" || typeof json !== "string") {
		throw activityRecordCorrupt("Activity summary is missing")
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(json) as unknown
	} catch {
		throw activityRecordCorrupt("Activity summary JSON is corrupt")
	}
	if (!isRecord(parsed))
		throw activityRecordCorrupt("Activity summary is not an object")
	return {
		...(parsed as unknown as ActivitySummary),
		eventId,
		commitSeq: formatSeq(seq),
	}
}

function readRecord(seq: bigint, json: unknown): ActivityRecord {
	if (typeof json !== "string") {
		throw activityRecordCorrupt("Activity record is missing")
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(json) as unknown
	} catch {
		throw activityRecordCorrupt("Activity record JSON is corrupt")
	}
	if (!isRecord(parsed))
		throw activityRecordCorrupt("Activity record is not an object")
	const rest: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(parsed)) {
		if (key !== "commitSeq") rest[key] = value
	}
	return { ...rest, commitSeq: formatSeq(seq) } as ActivityRecord
}

function search(
	db: SqlDatabase,
	request: Extract<ReadRequest, { op: "search" }>,
): SummaryRow[] {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
		throw new ActivityQueryInvalidError("limit is invalid")
	}
	const { where, params } = bounds(request)
	appendFilters(where, params, request.query)
	const direction = request.order === "asc" ? "ASC" : "DESC"
	params.push(request.limit)
	// Keyset page inside (low, high]. No COUNT(*): the extra row is the continuation signal.
	const sql = `SELECT seq, event_id, summary_json FROM activity WHERE ${where.join(" AND ")} ORDER BY seq ${direction} LIMIT ?`
	const found = db.prepare(sql).all(...params)
	const rows: SummaryRow[] = []
	for (const row of found) {
		const seq = seqFromSqlite(row["seq"])
		rows.push({
			seq: formatSeq(seq),
			summary: readSummary(seq, row["event_id"], row["summary_json"]),
		})
	}
	return rows
}

function detail(
	db: SqlDatabase,
	request: Extract<ReadRequest, { op: "detail" }>,
): ActivityRecord | null {
	const row = db
		.prepare("SELECT seq, record_json FROM activity WHERE event_id = ?")
		.get(request.eventId)
	if (!row) return null
	return readRecord(seqFromSqlite(row["seq"]), row["record_json"])
}

function emptyFacets(
	dimensions: readonly FacetDimension[],
): Record<string, { value: string | null; count: number }[]> {
	const facets: Record<string, { value: string | null; count: number }[]> = {}
	for (const dimension of dimensions) facets[dimension] = []
	return facets
}

function facetValue(value: unknown): string | null {
	if (value === null) return null
	if (typeof value === "string") return value
	throw activityRecordCorrupt("Activity facet value is not text")
}

function facets(
	db: SqlDatabase,
	request: Extract<ReadRequest, { op: "facets" }>,
): FacetsBody {
	if (parseSeq(request.high) <= parseSeq(request.low)) {
		return {
			op: "facets",
			facets: emptyFacets(request.dimensions),
			scanned: 0,
			truncated: false,
		}
	}
	const { where, params } = bounds({
		low: request.low,
		high: request.high,
		before: null,
		after: null,
	})
	appendFilters(where, params, request.query)
	const selected = request.dimensions
		.map(dimension => `${FACET_COLUMN[dimension]} AS ${dimension}`)
		.join(", ")
	// One extra row distinguishes "exactly scanCap matches" from a truncated scan.
	params.push(request.scanCap + 1)
	const sql = `SELECT ${selected} FROM activity WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`
	const found = db.prepare(sql).all(...params)
	const truncated = found.length > request.scanCap
	const scannedRows = truncated ? found.slice(0, request.scanCap) : found
	const facetsOut = emptyFacets(request.dimensions)
	const counts = new Map<FacetDimension, Map<string | null, number>>()
	for (const dimension of request.dimensions) counts.set(dimension, new Map())
	for (const row of scannedRows) {
		for (const dimension of request.dimensions) {
			const bucket = counts.get(dimension)
			if (!bucket) continue
			const value = facetValue(row[dimension] ?? null)
			bucket.set(value, (bucket.get(value) ?? 0) + 1)
		}
	}
	for (const dimension of request.dimensions) {
		const bucket = counts.get(dimension) ?? new Map<string | null, number>()
		const ranked = [...bucket.entries()].map(([value, count]) => ({
			value,
			count,
		}))
		ranked.sort((left, right) => {
			if (left.count !== right.count) return right.count - left.count
			if (left.value === right.value) return 0
			if (left.value === null) return -1
			if (right.value === null) return 1
			return left.value < right.value ? -1 : 1
		})
		facetsOut[dimension] = ranked.slice(0, request.valueCap)
	}
	return {
		op: "facets",
		facets: facetsOut,
		scanned: scannedRows.length,
		truncated,
	}
}

function readObserved(db: SqlDatabase): ObservedStore {
	const rows = db
		.prepare(
			"SELECT key, value FROM store_meta WHERE key IN ('storeUuid', 'restoreGeneration', 'pruneWatermark', 'holeWatermark', 'holeGeneration')",
		)
		.all()
	const map = new Map<string, string>()
	for (const row of rows) {
		const key = row["key"]
		const value = row["value"]
		if (typeof key === "string" && typeof value === "string")
			map.set(key, value)
	}
	const storeUuid = map.get("storeUuid")
	const generation = map.get("restoreGeneration")
	const pruneWatermark = map.get("pruneWatermark")
	const holeWatermark = map.get("holeWatermark") ?? "0"
	const holeGenerationText = map.get("holeGeneration") ?? "0"
	if (
		storeUuid === undefined ||
		storeUuid.length === 0 ||
		generation === undefined ||
		!/^\d+$/.test(generation) ||
		pruneWatermark === undefined ||
		!/^\d+$/.test(pruneWatermark) ||
		!/^(0|[1-9]\d*)$/.test(holeWatermark) ||
		!/^\d+$/.test(holeGenerationText)
	) {
		throw new ActivityReaderFailedError("Activity store meta is unreadable")
	}
	const restoreGeneration = Number(generation)
	const holeGeneration = Number(holeGenerationText)
	if (
		!Number.isSafeInteger(restoreGeneration) ||
		!Number.isSafeInteger(holeGeneration) ||
		BigInt(holeWatermark) > MAX_SEQ
	) {
		throw new ActivityReaderFailedError("Activity store meta is unreadable")
	}
	return {
		storeUuid,
		restoreGeneration,
		pruneWatermark,
		holeWatermark,
		holeGeneration,
	}
}

function readBody(db: SqlDatabase, request: ReadRequest): ReadBody {
	switch (request.op) {
		case "search":
			return { op: "search", rows: search(db, request) }
		case "detail":
			return { op: "detail", record: detail(db, request) }
		case "facets":
			return facets(db, request)
		case "trails":
			return { op: "trails", trails: readTrails(db, request.input) }
		default:
			throw new ActivityQueryInvalidError("Unknown activity read")
	}
}

/**
 * Synchronous read against an open database. Meta and rows share one deferred
 * transaction so a prune cannot hide rows that this snapshot still returns.
 * Safe to call on the main thread in tests.
 */
export function runRead(db: SqlDatabase, request: ReadRequest): ReadResult {
	try {
		db.exec("BEGIN")
		const observed = readObserved(db)
		const body = readBody(db, request)
		db.exec("COMMIT")
		switch (body.op) {
			case "search":
				return { ...body, observed }
			case "detail":
				return { ...body, observed }
			case "facets":
				return { ...body, observed }
			case "trails":
				return { ...body, observed }
			default:
				throw new ActivityQueryInvalidError("Unknown activity read")
		}
	} catch (error) {
		try {
			db.exec("ROLLBACK")
		} catch {
			// BEGIN may have failed, or the connection already rolled back.
		}
		throw error
	}
}

export function assembleSummaries(
	rows: readonly SummaryRow[],
	limit: number,
	maxBytes: number,
): { items: ActivitySummary[]; lastSeq: string | null; hasMore: boolean } {
	const items: ActivitySummary[] = []
	let bytes = 0
	let lastSeq: string | null = null
	for (const row of rows) {
		if (items.length >= limit) return { items, lastSeq, hasMore: true }
		const size = Buffer.byteLength(JSON.stringify(row.summary))
		if (items.length > 0 && bytes + size > maxBytes) {
			return { items, lastSeq, hasMore: true }
		}
		items.push(row.summary)
		bytes += size
		lastSeq = row.seq
	}
	return { items, lastSeq, hasMore: false }
}
