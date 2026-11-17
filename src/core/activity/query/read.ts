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
 * candidate set from the index range(s) inside the statement's seq window, which SQLite
 * materialises in full before LIMIT (a LIST SUBQUERY), so it costs the candidates of that window.
 * `walk`: plain per-row terms over the seq-ordered walk of the window, which stops at LIMIT, so
 * it costs the rows walked.
 */
export type ScopeRead = "union" | "walk"

export interface ScopePlan {
	channel: ScopeRead
	frequency: ScopeRead
}

const UNION_PLAN: ScopePlan = { channel: "union", frequency: "union" }
const WALK_PLAN: ScopePlan = { channel: "walk", frequency: "walk" }

/**
 * Rows (seq values) a scoped search walks before it reads the rest of its window as candidates.
 * Arithmetic: the walk form with its one refs probe measured 1.4 to 2.2 µs a row (load 8 to 9),
 * so a slice that finds nothing costs 23 to 37 ms, under a sixth of the 250 ms deadline (at the
 * 4 µs a row of the old two-probe walk, 1 s per 250 000 rows, it would be about 65 ms). A dense
 * scope fills its page inside the slice (51 rows at 60 % density: about 85 rows); a sparse or
 * clustered-old one pays the slice once, then the union over the rest of the window costs its
 * candidates only (about 5 µs each).
 */
export const WALK_SLICE = 16_384

/**
 * Slices of WALK_SLICE rows a scoped facets walk reads before it reads the rest of its window as
 * candidates. Arithmetic: the walk only takes a scope that holds at least scanCap candidates in
 * the window. 6 slices (98 304 rows) reach the default 50 000-match scan when the scope is at
 * least 51 % dense near the top of the window. That covers the 60 % 1090 MHz case: about 83 000
 * rows, measured at 180 to 200 ms with the count and channelMatch. A thinner scope walks all
 * 98 304 rows (about 190 ms at the 1.9 µs a row of the facets walk with its channel column
 * probe), then reads the remainder as candidates: that worst case can pass the deadline, which
 * then answers 429 as before. 4 slices missed the 60 % case and fell through to a 110 000-row
 * union (255 ms).
 */
export const FACETS_WALK_SLICES = 6

/** Internal read options (the plan and slice tests); production reads pass none. */
export interface ReadOptions {
	/** Rows of a walk slice; default WALK_SLICE. */
	walkSlice?: number
	/** Forces one statement over the whole window with this plan. */
	plan?: ScopePlan
}

/** A statement's seq window (low, high]: one bound per side, so SQLite seeks to the near end. */
export interface SeqWindow {
	low: bigint
	high: bigint
}

/**
 * The window of (low, high] and the cursor: low = max(low, after), high = min(high, before − 1)
 * (seq is an INTEGER rowid, compared as bigint). Two bounds on one side left SQLite seeking on
 * the first only, so an ASC replay with `after` near the end stepped over every older row.
 */
export function windowOf(request: {
	low: string
	high: string
	before: string | null
	after: string | null
}): SeqWindow {
	let low = parseSeq(request.low)
	let high = parseSeq(request.high)
	if (request.after !== null) {
		const after = parseSeq(request.after)
		if (after > low) low = after
	}
	if (request.before !== null) {
		const below = parseSeq(request.before) - 1n
		if (below < high) high = below
	}
	return { low, high }
}

/**
 * The first `size` rows of `window` in `order` (the walk slice) and the rest of the window, or
 * null when the slice covers it.
 */
export function splitWindow(
	window: SeqWindow,
	order: "asc" | "desc",
	size: number,
): { first: SeqWindow; rest: SeqWindow | null } {
	const span = BigInt(size)
	if (window.high - window.low <= span) return { first: window, rest: null }
	if (order === "desc") {
		const edge = window.high - span
		return {
			first: { low: edge, high: window.high },
			rest: { low: window.low, high: edge },
		}
	}
	const edge = window.low + span
	return {
		first: { low: window.low, high: edge },
		rest: { low: edge, high: window.high },
	}
}

function windowParams(window: SeqWindow): [SqlValue, SqlValue] {
	return [bindSeq(window.low), bindSeq(window.high)]
}

/** Index entries of `sql`, counted up to `cap` (one capped index range read). */
function countedTo(
	db: SqlDatabase,
	sql: string,
	params: SqlValue[],
	cap: number,
): number {
	if (cap <= 0) return 0
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM (${sql} LIMIT ?)`)
		.get(...params, cap)
	const n = row?.["n"]
	if (typeof n !== "number" && typeof n !== "bigint")
		throw new ActivityReaderFailedError("Activity scope count is unreadable")
	return Number(n)
}

/** The stored-channel half's candidates in `window`: a range of the refs key, seq as a filter. */
function channelRefCandidates(): string {
	return "SELECT activity_refs.seq FROM activity_refs WHERE activity_refs.ref_type = 'channelHz' AND activity_refs.ref_value BETWEEN ? AND ? AND +activity_refs.seq > ? AND +activity_refs.seq <= ?"
}

/** The fallback half's candidates in `window`: a range of activity_frequency, rows with no stored channel. */
function channelFallbackCandidates(): string {
	return `SELECT fallback.seq FROM activity AS fallback INDEXED BY activity_frequency WHERE fallback.frequency_hz >= ? AND fallback.frequency_hz < ? AND +fallback.seq > ? AND +fallback.seq <= ? AND ${noChannelRef("fallback")}`
}

function noChannelRef(table: string): string {
	return `NOT EXISTS (SELECT 1 FROM activity_refs WHERE activity_refs.seq = ${table}.seq AND activity_refs.ref_type = 'channelHz')`
}

function channelRefParams(channel: {
	minHz: number
	maxHz: number
}): [string, string] {
	return [channelRefValue(channel.minHz), channelRefValue(channel.maxHz)]
}

/**
 * The plan of a scoped facets scan of at most `cap` matches in `window`: each scope term counted
 * to `cap` (the channel scope: its refs range, plus its fallback range with no stored channel, so
 * no row counts twice; the frequency range: its activity_frequency range), all inside the window.
 * A term under the cap reads as the union (its candidates, fewer than the scan reads); at the cap,
 * as the walk. Arithmetic: counting to the default 50 000 steps at most 50 000 index entries per
 * term (about 10 ms), plus one refs probe per fallback entry. Measured on a busy channel (17 500
 * candidates, every one also in the fallback's frequency range), the count added 25 to 40 ms to
 * the facets read.
 */
export function facetsPlanOf(
	db: SqlDatabase,
	query: NormalisedQuery,
	window: SeqWindow,
	cap: number,
): ScopePlan {
	let channel: ScopeRead = "walk"
	if (query.channel !== null) {
		const refs = countedTo(
			db,
			channelRefCandidates(),
			[...channelRefParams(query.channel), ...windowParams(window)],
			cap,
		)
		const fallback = countedTo(
			db,
			channelFallbackCandidates(),
			[...channelFallbackParams(query.channel), ...windowParams(window)],
			cap - refs,
		)
		if (refs + fallback < cap) channel = "union"
	}
	let frequency: ScopeRead = "walk"
	const range = frequencyTerms(
		"ranged.frequency_hz",
		query.frequencyMin,
		query.frequencyMax,
	)
	if (
		range !== null &&
		countedTo(
			db,
			frequencyCandidates(range.sql),
			[...range.params, ...windowParams(window)],
			cap,
		) < cap
	)
		frequency = "union"
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
 * `union`: one `seq IN (… UNION ALL …)` of the two index ranges inside `window`, so a sparse
 * scope never walks the snapshot. `walk`: one refs probe per row: the row's stored channel, or
 * (none stored) the low end of the scope when its own frequency (`+`, so no index takes it) is in
 * the fallback range, compared with the scope; IFNULL evaluates its second argument only when
 * the probe found no channel.
 */
function appendChannel(
	where: string[],
	params: SqlValue[],
	channel: { minHz: number; maxHz: number },
	read: ScopeRead,
	window: SeqWindow,
): void {
	const [minRef, maxRef] = channelRefParams(channel)
	if (read === "union") {
		where.push(
			`seq IN (${channelRefCandidates()} UNION ALL ${channelFallbackCandidates()})`,
		)
		params.push(
			minRef,
			maxRef,
			...windowParams(window),
			...channelFallbackParams(channel),
			...windowParams(window),
		)
		return
	}
	where.push(
		`IFNULL(${CHANNEL_REF_OF_ROW}, CASE WHEN +frequency_hz >= ? AND +frequency_hz < ? THEN ? END) BETWEEN ? AND ?`,
	)
	params.push(...channelFallbackParams(channel), minRef, minRef, maxRef)
}

/** The fallback half of the channel scope on `activity`'s own row (the channelMatch probe). */
function channelFallbackOfRow(): string {
	return `frequency_hz >= ? AND frequency_hz < ? AND ${noChannelRef("activity")}`
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

/** The frequency range's candidates in a window: `range` over `ranged`, then the two seq bounds. */
function frequencyCandidates(range: string): string {
	return `SELECT ranged.seq FROM activity AS ranged INDEXED BY activity_frequency WHERE ${range} AND +ranged.seq > ? AND +ranged.seq <= ?`
}

/**
 * The frequency filter as SQL. `union`: a candidate set from the activity_frequency range inside
 * `window` (as bare `frequency_hz` terms SQLite drove a sparse range from the rowid range and
 * read every row of the window). `walk`: `+frequency_hz` terms no index takes, so a dense range
 * stops at LIMIT.
 */
function appendFrequency(
	where: string[],
	params: SqlValue[],
	min: number | null,
	max: number | null,
	read: ScopeRead,
	window: SeqWindow,
): void {
	const range = frequencyTerms(
		read === "union" ? "ranged.frequency_hz" : "+frequency_hz",
		min,
		max,
	)
	if (range === null) return
	if (read === "union") {
		where.push(`seq IN (${frequencyCandidates(range.sql)})`)
		params.push(...range.params, ...windowParams(window))
		return
	}
	where.push(range.sql)
	params.push(...range.params)
}

/** True when `query` has a channel scope or a frequency range (the terms a plan reads). */
function hasScope(query: NormalisedQuery): boolean {
	return (
		query.channel !== null ||
		query.frequencyMin !== null ||
		query.frequencyMax !== null
	)
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
	const window = windowOf({ low, high, before: null, after: null })
	const { where, params } = bounds(window)
	if (query.channel !== null) {
		where.push(channelFallbackOfRow())
		params.push(...channelFallbackParams(query.channel))
	}
	appendFilters(where, params, { ...query, channel: null }, WALK_PLAN, window, {
		perRowRecordings: true,
	})
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
	window: SeqWindow,
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
		appendChannel(where, params, query.channel, plan.channel, window)
	appendFrequency(
		where,
		params,
		query.frequencyMin,
		query.frequencyMax,
		plan.frequency,
		window,
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

/** The window as SQL: one bound per side. */
function bounds(window: SeqWindow): { where: string[]; params: SqlValue[] } {
	return { where: ["seq > ?", "seq <= ?"], params: [...windowParams(window)] }
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
	request: SearchReadRequest,
	plan: ScopePlan = UNION_PLAN,
	window: SeqWindow = windowOf(request),
	limit: number = request.limit,
): { sql: string; params: SqlValue[] } {
	const { where, params } = bounds(window)
	appendFilters(where, params, request.query, plan, window)
	const direction = request.order === "asc" ? "ASC" : "DESC"
	params.push(limit)
	// Keyset page inside the window. No COUNT(*): the extra row is the continuation signal.
	const sql = `SELECT seq, event_id, summary_json FROM activity WHERE ${where.join(" AND ")} ORDER BY seq ${direction} LIMIT ?`
	return { sql, params }
}

function summaryRows(
	db: SqlDatabase,
	statement: { sql: string; params: SqlValue[] },
): SummaryRow[] {
	const rows: SummaryRow[] = []
	for (const row of db.prepare(statement.sql).all(...statement.params)) {
		const seq = seqFromSqlite(row["seq"])
		rows.push({
			seq: formatSeq(seq),
			summary: readSummary(seq, row["event_id"], row["summary_json"]),
		})
	}
	return rows
}

/**
 * A search page. With a channel or frequency scope: the walk form over the first walk slice of
 * the window from the cursor (at most WALK_SLICE rows); a page not full there reads the rest of
 * the window as the union and appends it (the windows are disjoint and in order, so the page is
 * the same as one statement's).
 */
function search(
	db: SqlDatabase,
	request: SearchReadRequest,
	options: ReadOptions,
): SummaryRow[] {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
		throw new ActivityQueryInvalidError("limit is invalid")
	}
	const window = windowOf(request)
	if (window.high <= window.low) return []
	if (options.plan !== undefined || !hasScope(request.query))
		return summaryRows(
			db,
			searchStatement(request, options.plan ?? UNION_PLAN, window),
		)
	const { first, rest } = splitWindow(
		window,
		request.order,
		options.walkSlice ?? WALK_SLICE,
	)
	const rows = summaryRows(db, searchStatement(request, WALK_PLAN, first))
	if (rows.length >= request.limit || rest === null) return rows
	for (const row of summaryRows(
		db,
		searchStatement(request, UNION_PLAN, rest, request.limit - rows.length),
	))
		rows.push(row)
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
	request: FacetsReadRequest,
	plan: ScopePlan = UNION_PLAN,
	window: SeqWindow = windowOf({ ...request, before: null, after: null }),
	// One extra row distinguishes "exactly scanCap matches" from a truncated scan.
	limit: number = request.scanCap + 1,
): { sql: string; params: SqlValue[]; columns: string[] } {
	const { where, params } = bounds(window)
	appendFilters(where, params, request.query, plan, window)
	const columns = request.dimensions.map(
		dimension => `${FACET_COLUMN[dimension]} AS ${dimension}`,
	)
	const names = request.dimensions.join(", ")
	params.push(limit)
	// SQLite counts; only the distinct value combinations (tens, not 50 001 rows) cross
	// into JS. With the activity_facets covering index the scan reads index entries only;
	// without it the same statement walks rowids (correct, slower).
	const sql = `WITH scan AS (SELECT seq, ${columns.join(", ")} FROM activity WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?) SELECT ${names}, COUNT(*) AS n, MIN(seq) AS low FROM scan GROUP BY ${names}`
	return { sql, params, columns }
}

function groupCount(group: Record<string, unknown>): number {
	const n = group["n"]
	if (typeof n !== "number" && typeof n !== "bigint")
		throw new ActivityReaderFailedError("Activity facet count is unreadable")
	return Number(n)
}

/**
 * The facets scan's groups: newest first, at most scanCap + 1 matches. With a scope: a term with
 * fewer than scanCap candidates in the window drives one union statement; when every term holds
 * at least that many, the walk form reads at most FACETS_WALK_SLICES walk slices from the top of
 * the window and stops at scanCap + 1 matches; short of them, the union reads the rest of the
 * window for the matches still missing (the windows are disjoint, so the totals are one scan's).
 */
function facetGroups(
	db: SqlDatabase,
	request: FacetsReadRequest,
	window: SeqWindow,
	options: ReadOptions,
): Record<string, unknown>[] {
	const all = (statement: { sql: string; params: SqlValue[] }) =>
		db.prepare(statement.sql).all(...statement.params)
	if (options.plan !== undefined || !hasScope(request.query))
		return all(facetsStatement(request, options.plan ?? UNION_PLAN, window))
	const plan = facetsPlanOf(db, request.query, window, request.scanCap)
	if (plan.channel === "union" || plan.frequency === "union")
		return all(facetsStatement(request, plan, window))
	const { first, rest } = splitWindow(
		window,
		"desc",
		(options.walkSlice ?? WALK_SLICE) * FACETS_WALK_SLICES,
	)
	const groups = all(facetsStatement(request, WALK_PLAN, first))
	let matched = 0
	for (const group of groups) matched += groupCount(group)
	const wanted = request.scanCap + 1 - matched
	if (wanted <= 0 || rest === null) return groups
	for (const group of all(facetsStatement(request, UNION_PLAN, rest, wanted)))
		groups.push(group)
	return groups
}

function facets(
	db: SqlDatabase,
	request: FacetsReadRequest,
	options: ReadOptions,
): FacetsBody {
	const window = windowOf({ ...request, before: null, after: null })
	if (window.high <= window.low) {
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
	const columns = request.dimensions.map(
		dimension => `${FACET_COLUMN[dimension]} AS ${dimension}`,
	)
	const groups = facetGroups(db, request, window, options)
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
		const n = groupCount(group)
		matched += n
		const low = seqFromSqlite(group["low"])
		if (lowest === null || low < lowest) lowest = low
		add(group, n)
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

function readBody(
	db: SqlDatabase,
	request: ReadRequest,
	options: ReadOptions,
): ReadBody {
	switch (request.op) {
		case "search":
			return {
				op: "search",
				rows: search(db, request, options),
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
			return facets(db, request, options)
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
export function runRead(
	db: SqlDatabase,
	request: ReadRequest,
	options: ReadOptions = {},
): ReadResult {
	try {
		db.exec("BEGIN")
		const observed = readObserved(db)
		const body = readBody(db, request, options)
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
