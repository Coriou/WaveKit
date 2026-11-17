import type {
	ActivityBandMap,
	ActivityRecord,
	ActivitySummary,
	ActivityTimeline,
	ActivityTrails,
} from "../storage/contract.js"
import {
	readBandMap,
	readTimeline,
	type BandMapReadInput,
	type TimelineReadInput,
} from "./aggregates.js"
import {
	activityRecordCorrupt,
	ActivityQueryInvalidError,
	ActivityReaderFailedError,
} from "./errors.js"
import { recordWithoutRecordingPath } from "../recording-path.js"
import { channelHzOfRef, channelRefValue } from "../storage/row.js"
import { ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ } from "@wavekit/api-types"
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
	/** With a channel scope: also answer channelMatch over (low, high]. */
	channelMatch?: boolean
	/** Forced by the plan tests; absent: chosen by {@link scopePlanOf} in the read's snapshot. */
	plan?: ScopePlan
}

interface FacetsReadRequest {
	op: "facets"
	query: NormalisedQuery
	dimensions: FacetDimension[]
	low: string
	high: string
	scanCap: number
	valueCap: number
	/** Forced by the plan tests; absent: chosen by {@link scopePlanOf} in the read's snapshot. */
	plan?: ScopePlan
}

export type ReadRequest =
	| SearchReadRequest
	| { op: "detail"; eventId: string }
	| FacetsReadRequest
	| { op: "trails"; input: TrailsReadInput }
	| { op: "bandmap"; input: BandMapReadInput }
	| { op: "timeline"; input: TimelineReadInput }

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
	/** Asked for (channelMatch) with a channel scope only. */
	channelMatch?: "exact" | "mixed"
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
	/** With a channel scope only. */
	channelMatch?: "exact" | "mixed"
}

interface TrailsBody {
	op: "trails"
	trails: ActivityTrails
}

interface BandMapBody {
	op: "bandmap"
	bandMap: ActivityBandMap
}

interface TimelineBody {
	op: "timeline"
	timeline: ActivityTimeline
}

type ReadBody =
	| SearchBody
	| DetailBody
	| FacetsBody
	| TrailsBody
	| BandMapBody
	| TimelineBody

export type ReadResult =
	| (SearchBody & { observed: ObservedStore })
	| (DetailBody & { observed: ObservedStore })
	| (FacetsBody & { observed: ObservedStore })
	| (TrailsBody & { observed: ObservedStore })
	| (BandMapBody & { observed: ObservedStore })
	| (TimelineBody & { observed: ObservedStore })

/** A row's stored channel (its `channelHz` ref, zero-padded), or NULL: one probe of the refs key. */
const CHANNEL_REF_OF_ROW =
	"(SELECT ref_value FROM activity_refs WHERE activity_refs.seq = activity.seq AND activity_refs.ref_type = 'channelHz')"

const FACET_COLUMN: Record<FacetDimension, string> = {
	category: "category",
	protocol: "protocol",
	decoderId: "decoder_id",
	sourceId: "source_id",
	kind: "kind",
	channel: CHANNEL_REF_OF_ROW,
}

/**
 * How a scope term (the channel scope, the frequency range) reads. `union`: a `seq IN (…)`
 * candidate set from the index range(s), which SQLite materialises in full before LIMIT (a LIST
 * SUBQUERY), so it is quick only while the range is short. `walk`: plain per-row terms over the
 * seq-ordered walk of (low, high], which stops at LIMIT, so it is quick when matches are dense.
 */
export type ScopeRead = "union" | "walk"

export interface ScopePlan {
	channel: ScopeRead
	frequency: ScopeRead
}

const UNION_PLAN: ScopePlan = { channel: "union", frequency: "union" }

/**
 * Index entries a search's scope term (both halves of the channel scope together) may hold and
 * still read as a candidate set. Arithmetic: counting to the cap steps at most 4 096 entries of
 * one or two indexes (about 1 ms); a union under the cap materialises at most 4 096 seqs for the
 * channel scope plus 4 096 for a frequency range and looks up at most those 8 192 rows (about
 * 5 µs each with the summary read: about 40 ms), a sixth of the 250 ms deadline. At the cap the
 * scope holds at least 4 096 of the snapshot's N rows, so the walk reaches a page of L rows after
 * about L × N / 4 096 rows (L = 1 001, N = 250 000: about 61 000 rows, about 75 ms at 1.2 µs a
 * row; a 51-row page about 3 100 rows), while the union of a dense scope materialises every
 * match first (150 000 rows at one frequency: about 170 ms for 51 rows).
 */
export const SCOPE_DENSITY_CAP = 4_096

/**
 * The density cap of a facets scan of at most `scanCap` rows: the scan reads every match up to
 * the cap, so the walk stops early only once the scope holds more matches than that, and reads
 * every row of the snapshot below it (about 300 ms on 250 000 rows), where the union reads the
 * matches only (17 500 matches: about 130 ms). Past the scan cap the union materialises more
 * candidates than the scan uses and the walk reads scanCap × N / matches rows, fewer as the scope
 * grows denser (150 000 matches of 250 000 rows: walk about 175 ms, union about 310 ms). Counting
 * to the default 50 000 steps at most 50 000 index entries (about 10 ms). Never below the search
 * cap, so a small scan cap keeps the union for scopes a search would read as a union too.
 */
export function facetsDensityCap(scanCap: number): number {
	return Math.max(SCOPE_DENSITY_CAP, scanCap)
}

/** Index entries in `sql`'s range, counted up to `cap` (one capped index range read). */
function countedTo(
	db: SqlDatabase,
	sql: string,
	params: SqlValue[],
	cap: number,
): number {
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM (${sql} LIMIT ?)`)
		.get(...params, cap)
	const n = row?.["n"]
	if (typeof n !== "number" && typeof n !== "bigint")
		throw new ActivityReaderFailedError("Activity scope count is unreadable")
	return Number(n)
}

/**
 * The plan for `query`'s scope terms, read by density in the read's snapshot: the channel scope
 * (its refs key range plus the activity_frequency range of its fallback) and the frequency range
 * each counted to `cap`; a term reads as a candidate set while its count is under the cap, else
 * as the walk. The counts span the whole store, not (low, high]: an upper
 * bound, so a dense store never takes the union. activity_frequency is part of the only schema
 * a reader opens (ACTIVITY_SCHEMA_V1), so INDEXED BY never fails to prepare.
 */
export function scopePlanOf(
	db: SqlDatabase,
	query: NormalisedQuery,
	cap: number = SCOPE_DENSITY_CAP,
): ScopePlan {
	let channel: ScopeRead = "union"
	if (query.channel !== null) {
		const refs = countedTo(
			db,
			"SELECT 1 FROM activity_refs WHERE ref_type = 'channelHz' AND ref_value BETWEEN ? AND ?",
			[
				channelRefValue(query.channel.minHz),
				channelRefValue(query.channel.maxHz),
			],
			cap,
		)
		const fallback =
			refs < cap
				? countedTo(
						db,
						"SELECT 1 FROM activity INDEXED BY activity_frequency WHERE frequency_hz >= ? AND frequency_hz < ?",
						channelFallbackParams(query.channel),
						cap - refs,
					)
				: 0
		if (refs + fallback >= cap) channel = "walk"
	}
	let frequency: ScopeRead = "union"
	const range = frequencyTerms(
		"frequency_hz",
		query.frequencyMin,
		query.frequencyMax,
	)
	if (
		range !== null &&
		countedTo(
			db,
			`SELECT 1 FROM activity INDEXED BY activity_frequency WHERE ${range.sql}`,
			range.params,
			cap,
		) >= cap
	)
		frequency = "walk"
	return { channel, frequency }
}

/**
 * The channel scope as SQL: rows whose stored channel is within [minHz, maxHz] (a range of the
 * refs key (ref_type, ref_value, seq), the values zero-padded so text order is frequency order),
 * and rows with no stored channel whose own frequency is within half the fallback step of the
 * scope, [minHz − ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ, maxHz + ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ)
 * (a range of activity_frequency): the upper bound open, so a row on the edge of two channels
 * belongs to one. A row with neither never matches; the two halves are disjoint (one has a
 * channel ref, the other none).
 *
 * `union`: one `seq IN (… UNION ALL …)` of the two index ranges, so a sparse scope never walks
 * the snapshot (an OR of the halves walked every row: about 1 s on 250 000 rows, past the
 * 250 ms deadline). `walk`: the same halves as per-row probes (the refs key by seq, the row's own
 * frequency with `+` so no index takes it), so a dense scope stops at LIMIT.
 */
function appendChannel(
	where: string[],
	params: SqlValue[],
	channel: { minHz: number; maxHz: number },
	read: ScopeRead,
): void {
	where.push(
		read === "union"
			? `seq IN (SELECT seq FROM activity_refs WHERE ref_type = 'channelHz' AND ref_value BETWEEN ? AND ? UNION ALL SELECT fallback.seq FROM activity AS fallback WHERE ${channelFallbackOf("fallback.frequency_hz", "fallback")})`
			: `(EXISTS (SELECT 1 FROM activity_refs WHERE activity_refs.seq = activity.seq AND activity_refs.ref_type = 'channelHz' AND activity_refs.ref_value BETWEEN ? AND ?) OR (${channelFallbackOf("+frequency_hz", "activity")}))`,
	)
	params.push(
		channelRefValue(channel.minHz),
		channelRefValue(channel.maxHz),
		...channelFallbackParams(channel),
	)
}

/** The fallback half of the channel scope: no stored channel on `table`, `column` in range. */
function channelFallbackOf(column: string, table: string): string {
	return `${column} >= ? AND ${column} < ? AND NOT EXISTS (SELECT 1 FROM activity_refs WHERE activity_refs.seq = ${table}.seq AND activity_refs.ref_type = 'channelHz')`
}

function channelFallbackParams(channel: {
	minHz: number
	maxHz: number
}): [number, number] {
	return [
		channel.minHz - ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ,
		channel.maxHz + ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ,
	]
}

/** The frequency range over `column`, or null when neither bound is set. */
function frequencyTerms(
	column: string,
	min: number | null,
	max: number | null,
): { sql: string; params: SqlValue[] } | null {
	const terms: string[] = []
	const params: SqlValue[] = []
	if (min !== null) {
		terms.push(`${column} >= ?`)
		params.push(min)
	}
	if (max !== null) {
		terms.push(`${column} <= ?`)
		params.push(max)
	}
	return terms.length === 0 ? null : { sql: terms.join(" AND "), params }
}

/**
 * The frequency filter as SQL. `union`: a candidate set from the activity_frequency range (as
 * bare `frequency_hz` terms SQLite drove a sparse range from the (low, high] rowid range and read
 * every row of the snapshot). `walk`: `+frequency_hz` terms no index takes, so a dense range
 * stops at LIMIT.
 */
function appendFrequency(
	where: string[],
	params: SqlValue[],
	min: number | null,
	max: number | null,
	read: ScopeRead,
): void {
	const range = frequencyTerms(
		read === "union" ? "ranged.frequency_hz" : "+frequency_hz",
		min,
		max,
	)
	if (range === null) return
	where.push(
		read === "union"
			? `seq IN (SELECT ranged.seq FROM activity AS ranged WHERE ${range.sql})`
			: range.sql,
	)
	params.push(...range.params)
}

/**
 * `mixed` when a row of the scope in (low, high] matched by its own frequency (no stored
 * channel), else `exact`: one probe per request of the other filters and only the fallback half
 * of the scope (a row matching the stored-channel half has a channel ref, so it never counts),
 * stopped at the first such row.
 */
function channelMatchOf(
	db: SqlDatabase,
	query: NormalisedQuery,
	low: string,
	high: string,
): "exact" | "mixed" {
	const { sql, params } = channelMatchStatement(query, low, high)
	const found = db.prepare(sql).get(...params)
	return found === undefined ? "exact" : "mixed"
}

/**
 * The channelMatch probe and its parameters (exported for the query-plan tests): plain terms
 * driven from the fallback's activity_frequency range (INDEXED BY: the index is in the only
 * schema a reader opens), the other filters as per-row terms, LIMIT 1 with no ORDER BY, so it
 * stops at the first fallback row and never materialises a candidate set of the scope.
 */
export function channelMatchStatement(
	query: NormalisedQuery,
	low: string,
	high: string,
): { sql: string; params: SqlValue[] } {
	const { where, params } = bounds({ low, high, before: null, after: null })
	if (query.channel !== null) {
		where.push(channelFallbackOf("frequency_hz", "activity"))
		params.push(...channelFallbackParams(query.channel))
	}
	appendFilters(
		where,
		params,
		{ ...query, channel: null },
		{ channel: "walk", frequency: "walk" },
		{ perRowRecordings: true },
	)
	const from =
		query.channel === null
			? "activity"
			: "activity INDEXED BY activity_frequency"
	return {
		sql: `SELECT 1 AS one FROM ${from} WHERE ${where.join(" AND ")} LIMIT 1`,
		params,
	}
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
	plan: ScopePlan,
	options: { perRowRecordings?: boolean } = {},
): void {
	appendIn(where, params, "kind", query.kinds)
	appendIn(where, params, "source_id", query.sourceIds)
	appendIn(where, params, "decoder_id", query.decoderIds)
	appendIn(where, params, "protocol", query.protocols)
	appendIn(where, params, "category", query.categories)
	for (const ref of query.refs) {
		// A recording key names one or two rows: read them from the refs key (ref_type, ref_value,
		// seq) instead of probing every newer row (280 ms for no match on 250 000 rows). Other
		// refs (a job's id) can match most rows, where the per-row probe stops sooner.
		where.push(
			ref.type === "recordingId"
				? "seq IN (SELECT seq FROM activity_refs WHERE ref_type = ? AND ref_value = ?)"
				: "EXISTS (SELECT 1 FROM activity_refs WHERE activity_refs.seq = activity.seq AND activity_refs.ref_type = ? AND activity_refs.ref_value = ?)",
		)
		params.push(ref.type, ref.value)
	}
	// Which candidate set drives the read is the SQLite planner's choice, not a documented rule:
	// the terms go narrowest first (a recording key's one or two rows, then a channel, then a
	// frequency range, then the recordings set, which can hold most rows), and
	// tests/unit/core/activity/query/channel-plan.test.ts holds the plans the bundled SQLite picks.
	if (query.channel !== null)
		appendChannel(where, params, query.channel, plan.channel)
	appendFrequency(
		where,
		params,
		query.frequencyMin,
		query.frequencyMax,
		plan.frequency,
	)
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
	// The (ref_type, ref_value, seq) key lists every linked row: one ref per link. Per row (the
	// refs_seq key) where another range drives the read and must stop at its first match.
	if (query.hasRecording !== null)
		where.push(
			options.perRowRecordings === true
				? `${query.hasRecording ? "" : "NOT "}EXISTS (SELECT 1 FROM activity_refs WHERE activity_refs.seq = activity.seq AND activity_refs.ref_type = 'recordingId')`
				: query.hasRecording
					? "seq IN (SELECT seq FROM activity_refs WHERE ref_type = 'recordingId')"
					: "seq NOT IN (SELECT seq FROM activity_refs WHERE ref_type = 'recordingId')",
		)
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
	return recordWithoutRecordingPath({
		...rest,
		commitSeq: formatSeq(seq),
	}) as unknown as ActivityRecord
}

/** The search statement and its parameters (exported for the query-plan tests). */
export function searchStatement(
	request: Extract<ReadRequest, { op: "search" }>,
	plan: ScopePlan = request.plan ?? UNION_PLAN,
): { sql: string; params: SqlValue[] } {
	const { where, params } = bounds(request)
	appendFilters(where, params, request.query, plan)
	const direction = request.order === "asc" ? "ASC" : "DESC"
	params.push(request.limit)
	// Keyset page inside (low, high]. No COUNT(*): the extra row is the continuation signal.
	const sql = `SELECT seq, event_id, summary_json FROM activity WHERE ${where.join(" AND ")} ORDER BY seq ${direction} LIMIT ?`
	return { sql, params }
}

function search(
	db: SqlDatabase,
	request: Extract<ReadRequest, { op: "search" }>,
): SummaryRow[] {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
		throw new ActivityQueryInvalidError("limit is invalid")
	}
	const { sql, params } = searchStatement(
		request,
		request.plan ?? scopePlanOf(db, request.query),
	)
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

/** A `channel` facet value: the stored ref as decimal Hz; NULL (no stored channel) stays null. */
function channelFacetValue(value: unknown): string | null {
	if (value === null) return null
	const hz = channelHzOfRef(value)
	if (hz === null)
		throw activityRecordCorrupt("Activity channel ref is corrupt")
	return String(hz)
}

/** The facets statement and its parameters (exported for the query-plan tests). */
export function facetsStatement(
	request: Extract<ReadRequest, { op: "facets" }>,
	plan: ScopePlan = request.plan ?? UNION_PLAN,
): { sql: string; params: SqlValue[]; columns: string[] } {
	const { where, params } = bounds({
		low: request.low,
		high: request.high,
		before: null,
		after: null,
	})
	appendFilters(where, params, request.query, plan)
	const columns = request.dimensions.map(
		dimension => `${FACET_COLUMN[dimension]} AS ${dimension}`,
	)
	const names = request.dimensions.join(", ")
	// One extra row distinguishes "exactly scanCap matches" from a truncated scan.
	params.push(request.scanCap + 1)
	// SQLite counts; only the distinct value combinations (tens, not 50 001 rows) cross
	// into JS. With the activity_facets covering index the scan reads index entries only;
	// without it the same statement walks rowids (correct, slower).
	const sql = `WITH scan AS (SELECT seq, ${columns.join(", ")} FROM activity WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?) SELECT ${names}, COUNT(*) AS n, MIN(seq) AS low FROM scan GROUP BY ${names}`
	return { sql, params, columns }
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
			...(request.query.channel === null
				? {}
				: { channelMatch: "exact" as const }),
		}
	}
	const { sql, params, columns } = facetsStatement(
		request,
		request.plan ??
			scopePlanOf(db, request.query, facetsDensityCap(request.scanCap)),
	)
	const groups = db.prepare(sql).all(...params)
	const counts = new Map<FacetDimension, Map<string | null, number>>()
	for (const dimension of request.dimensions) counts.set(dimension, new Map())
	const add = (row: Record<string, unknown>, by: number): void => {
		for (const dimension of request.dimensions) {
			const bucket = counts.get(dimension)
			if (!bucket) continue
			const value =
				dimension === "channel"
					? channelFacetValue(row[dimension] ?? null)
					: facetValue(row[dimension] ?? null)
			const next = (bucket.get(value) ?? 0) + by
			if (next > 0) bucket.set(value, next)
			else bucket.delete(value)
		}
	}
	let matched = 0
	let lowest: bigint | null = null
	for (const group of groups) {
		const n = group["n"]
		if (typeof n !== "number" && typeof n !== "bigint")
			throw new ActivityReaderFailedError("Activity facet count is unreadable")
		matched += Number(n)
		const low = seqFromSqlite(group["low"])
		if (lowest === null || low < lowest) lowest = low
		add(group, Number(n))
	}
	const truncated = matched > request.scanCap
	if (truncated && lowest !== null) {
		// The extra row is the oldest one scanned: take it back out of the counts.
		const extra = db
			.prepare(`SELECT ${columns.join(", ")} FROM activity WHERE seq = ?`)
			.get(bindSeq(lowest))
		if (!extra)
			throw new ActivityReaderFailedError("Activity facet row vanished")
		add(extra, -1)
	}
	const facetsOut = emptyFacets(request.dimensions)
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
		scanned: truncated ? request.scanCap : matched,
		truncated,
		...(request.query.channel === null
			? {}
			: {
					channelMatch: channelMatchOf(
						db,
						request.query,
						request.low,
						request.high,
					),
				}),
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
			return {
				op: "search",
				rows: search(db, request),
				...(request.channelMatch === true && request.query.channel !== null
					? {
							channelMatch: channelMatchOf(
								db,
								request.query,
								request.low,
								request.high,
							),
						}
					: {}),
			}
		case "detail":
			return { op: "detail", record: detail(db, request) }
		case "facets":
			return facets(db, request)
		case "trails":
			return { op: "trails", trails: readTrails(db, request.input) }
		case "bandmap":
			return { op: "bandmap", bandMap: readBandMap(db, request.input) }
		case "timeline":
			return { op: "timeline", timeline: readTimeline(db, request.input) }
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
			case "bandmap":
				return { ...body, observed }
			case "timeline":
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
