import { performance } from "node:perf_hooks"
import {
	ACTIVITY_AGGREGATES_SCAN_ROWS,
	ACTIVITY_BANDMAP_MAX_BUCKETS,
	ACTIVITY_BANDMAP_MAX_PROTOCOLS,
	ACTIVITY_BANDMAP_MAX_TOP_ENTITIES,
	ACTIVITY_TIMELINE_MAX_BUCKETS,
} from "@wavekit/api-types"
import type {
	ActivityAggregateTruncation,
	ActivityBandMap,
	ActivityBandMapBucket,
	ActivityBandMapEntity,
	ActivityBandMapProtocol,
	ActivityBandMapTruncation,
	ActivityCategory,
	ActivityKind,
	ActivityTimeline,
	ActivityTimelineBucket,
} from "../storage/contract.js"
import { activityRecordCorrupt, ActivityQueryInvalidError } from "./errors.js"
import type { SqlDatabase, SqlValue } from "./sqlite.js"
import {
	createStepWalk,
	numberOf,
	pieceParams,
	WALK_CHUNK_ROWS,
	WALK_RANGE_WHERE,
	WALK_TIE_WHERE,
	walkStart,
	type StepCursor,
	type StepPiece,
} from "./walk.js"

/**
 * WG5 Activity aggregates (requirements 1-3): the band map and the timeline, read in the
 * reader worker over the shared produced-index step walk (walk.ts). The caller owns the
 * read transaction.
 */

export interface AggregatesReadLimits {
	/** Index rows of the window examined per request (1.6). */
	scanRows: number
	/** Cooperative wall budget of the walk in ms (3.2). */
	wallBudgetMs: number
	/** Index rows per walk step (3.3). */
	chunkRows: number
	/** Band map buckets kept (1.4). */
	maxBuckets: number
	/** Protocol entries per bucket (1.3). */
	maxProtocols: number
	/** Top entities per bucket (1.3). */
	maxTopEntities: number
	/** Timeline buckets at most; more is invalid (2.2, 2.3). */
	maxTimelineBuckets: number
}

export const AGGREGATES_WALL_BUDGET_MS = 600

export const DEFAULT_AGGREGATES_READ_LIMITS: AggregatesReadLimits =
	Object.freeze({
		scanRows: ACTIVITY_AGGREGATES_SCAN_ROWS,
		wallBudgetMs: AGGREGATES_WALL_BUDGET_MS,
		chunkRows: WALK_CHUNK_ROWS,
		maxBuckets: ACTIVITY_BANDMAP_MAX_BUCKETS,
		maxProtocols: ACTIVITY_BANDMAP_MAX_PROTOCOLS,
		maxTopEntities: ACTIVITY_BANDMAP_MAX_TOP_ENTITIES,
		maxTimelineBuckets: ACTIVITY_TIMELINE_MAX_BUCKETS,
	})

interface AggregateReadCommon {
	/** Inclusive ms. */
	producedFromMs: number
	/** Inclusive ms. */
	producedToMs: number
	categories?: readonly string[]
	protocols?: readonly string[]
	/** Merged over DEFAULT_AGGREGATES_READ_LIMITS. */
	limits?: Partial<AggregatesReadLimits>
	/** generatedAt in ms; defaults to Date.now() (structured-clone safe, so data not a function). */
	nowMs?: number
	/** Monotonic ms clock of the wall budget; defaults to performance.now (inline tests inject one). */
	clock?: () => number
}

/** Already normalised and validated band map read (requirement 1.2). */
export interface BandMapReadInput extends AggregateReadCommon {
	/** Inclusive Hz. */
	minHz: number
	/** Inclusive Hz. */
	maxHz: number
	bucketHz: number
}

/** Already normalised and validated timeline read (requirement 2.2). */
export interface TimelineReadInput extends AggregateReadCommon {
	bucketMs: number
	/** Exact entity keys (never comma-split), at most ACTIVITY_TIMELINE_MAX_ENTITY_KEYS. */
	entityKeys?: readonly string[]
}

const KINDS: ReadonlySet<string> = new Set<ActivityKind>([
	"decoder-reception",
	"call-lifecycle",
	"analog-transmission",
	"scanner-result",
	"recording-change",
	"ingestion-gap",
])

/** Fixed order so `counts` serialises deterministically. */
export const AGGREGATE_CATEGORIES = [
	"aircraft",
	"marine",
	"aviation-data",
	"voice",
	"paging",
	"aprs",
	"sensors",
	"mesh",
	"other",
] as const satisfies readonly ActivityCategory[]

/** SQL list of the known kinds (fixed literals, no user input). */
const KIND_LIST = [...KINDS].map(kind => `'${kind}'`).join(", ")

const CATEGORY_SET: ReadonlySet<string> = new Set(AGGREGATE_CATEGORIES)

function categoryOf(value: unknown): ActivityCategory {
	if (typeof value !== "string" || !CATEGORY_SET.has(value))
		throw activityRecordCorrupt("Activity category is corrupt")
	return value as ActivityCategory
}

export function resolveAggregatesLimits(
	limits: Partial<AggregatesReadLimits> | undefined,
): AggregatesReadLimits {
	const merged = { ...DEFAULT_AGGREGATES_READ_LIMITS, ...limits }
	for (const [key, value] of Object.entries(merged)) {
		const min = key === "wallBudgetMs" ? 0 : 1
		if (!Number.isSafeInteger(value) || value < min)
			throw new ActivityQueryInvalidError("aggregate limits are invalid")
	}
	return merged
}

function checkWindow(input: AggregateReadCommon): void {
	if (
		!Number.isSafeInteger(input.producedFromMs) ||
		!Number.isSafeInteger(input.producedToMs) ||
		input.producedFromMs < 0 ||
		input.producedFromMs > input.producedToMs
	)
		throw new ActivityQueryInvalidError("aggregate window is invalid")
}

const iso = (ms: number): string => new Date(ms).toISOString()

function compareKeys(left: string, right: string): number {
	if (left === right) return 0
	return left < right ? -1 : 1
}

// ---------- band map aggregation (pure) ----------

/** One matched row of the band map walk. */
export interface BandMapRow {
	seq: number
	producedAtMs: number
	kind: string
	protocol: string | null
	category: ActivityCategory
	entityKey: string | null
	frequencyHz: number | null
}

export interface BandMapShape {
	minHz: number
	maxHz: number
	bucketHz: number
	maxBuckets: number
	maxProtocols: number
	maxTopEntities: number
}

export interface BandMapAggregate {
	/** startHz ascending, capped. */
	buckets: ActivityBandMapBucket[]
	countedRows: number
	noFrequencyRows: number
	droppedRows: number
	/** True when the bucket cap dropped buckets. */
	bucketsCut: boolean
}

interface GroupAcc {
	rows: number
	lastMs: number
	lastSeq: number
	category: ActivityCategory
	entities: Set<string>
}

interface BucketAcc {
	startHz: number
	rows: number
	lastMs: number
	groups: Map<string, GroupAcc>
	entities: Map<string, number>
}

export interface BandMapAggregator {
	/** Rows in any order; out-of-range frequencies are ignored, null ones counted apart. */
	add(row: BandMapRow): void
	finish(): BandMapAggregate
}

export function bucketStartHz(hz: number, bucketHz: number): number {
	return Math.floor(hz / bucketHz) * bucketHz
}

export function createBandMapAggregator(
	shape: BandMapShape,
): BandMapAggregator {
	const buckets = new Map<number, BucketAcc>()
	let countedRows = 0
	let noFrequencyRows = 0

	function add(row: BandMapRow): void {
		const hz = row.frequencyHz
		if (hz === null) {
			noFrequencyRows += 1
			return
		}
		if (hz < shape.minHz || hz > shape.maxHz) return
		countedRows += 1
		const startHz = bucketStartHz(hz, shape.bucketHz)
		let bucket = buckets.get(startHz)
		if (bucket === undefined) {
			bucket = {
				startHz,
				rows: 0,
				lastMs: row.producedAtMs,
				groups: new Map(),
				entities: new Map(),
			}
			buckets.set(startHz, bucket)
		}
		bucket.rows += 1
		if (row.producedAtMs > bucket.lastMs) bucket.lastMs = row.producedAtMs
		const key = row.protocol ?? row.kind
		const group = bucket.groups.get(key)
		if (group === undefined) {
			const entities = new Set<string>()
			if (row.entityKey !== null) entities.add(row.entityKey)
			bucket.groups.set(key, {
				rows: 1,
				lastMs: row.producedAtMs,
				lastSeq: row.seq,
				category: row.category,
				entities,
			})
		} else {
			group.rows += 1
			if (
				row.producedAtMs > group.lastMs ||
				(row.producedAtMs === group.lastMs && row.seq > group.lastSeq)
			) {
				group.lastMs = row.producedAtMs
				group.lastSeq = row.seq
				group.category = row.category
			}
			if (row.entityKey !== null) group.entities.add(row.entityKey)
		}
		if (row.entityKey !== null)
			bucket.entities.set(
				row.entityKey,
				(bucket.entities.get(row.entityKey) ?? 0) + 1,
			)
	}

	function finishBucket(bucket: BucketAcc): ActivityBandMapBucket {
		const groups = [...bucket.groups.entries()]
		groups.sort((left, right) =>
			left[1].rows !== right[1].rows
				? right[1].rows - left[1].rows
				: compareKeys(left[0], right[0]),
		)
		const listed = groups.slice(0, shape.maxProtocols)
		let otherRows = 0
		for (let index = shape.maxProtocols; index < groups.length; index += 1)
			otherRows += (groups[index] as [string, GroupAcc])[1].rows
		const protocols: ActivityBandMapProtocol[] = listed.map(
			([protocol, group]) => ({
				protocol,
				category: group.category,
				rows: group.rows,
				entities: group.entities.size,
				lastAt: iso(group.lastMs),
			}),
		)
		const entities = [...bucket.entities.entries()]
		entities.sort((left, right) =>
			left[1] !== right[1]
				? right[1] - left[1]
				: compareKeys(left[0], right[0]),
		)
		const topEntities: ActivityBandMapEntity[] = entities
			.slice(0, shape.maxTopEntities)
			.map(([entityKey, rows]) => ({ entityKey, rows }))
		return {
			startHz: bucket.startHz,
			rows: bucket.rows,
			lastAt: iso(bucket.lastMs),
			protocols,
			otherRows,
			topEntities,
		}
	}

	function finish(): BandMapAggregate {
		const all = [...buckets.values()]
		let droppedRows = 0
		let kept = all
		if (all.length > shape.maxBuckets) {
			// Newest lastAt kept, ties by startHz ascending (1.4).
			all.sort((left, right) =>
				left.lastMs !== right.lastMs
					? right.lastMs - left.lastMs
					: left.startHz - right.startHz,
			)
			kept = all.slice(0, shape.maxBuckets)
			for (let index = shape.maxBuckets; index < all.length; index += 1)
				droppedRows += (all[index] as BucketAcc).rows
		}
		kept.sort((left, right) => left.startHz - right.startHz)
		return {
			buckets: kept.map(finishBucket),
			countedRows,
			noFrequencyRows,
			droppedRows,
			bucketsCut: all.length > shape.maxBuckets,
		}
	}

	return { add, finish }
}

/** Pure band map of already matched rows (window and category/protocol filters applied). */
export function aggregateBandMap(
	rows: Iterable<BandMapRow>,
	shape: BandMapShape,
): BandMapAggregate {
	const aggregator = createBandMapAggregator(shape)
	for (const row of rows) aggregator.add(row)
	return aggregator.finish()
}

// ---------- timeline aggregation (pure) ----------

/** Dense epoch-aligned buckets from the step holding `fromMs` to the step holding `toMs`. */
export function timelineBucketCount(
	fromMs: number,
	toMs: number,
	bucketMs: number,
): number {
	return Math.floor(toMs / bucketMs) - Math.floor(fromMs / bucketMs) + 1
}

export interface TimelineCounter {
	/** Adds `n` rows of `category` to the bucket of index `floor(ms / bucketMs)`. */
	add(bucketIndex: number, category: ActivityCategory, n: number): void
	finish(): { buckets: ActivityTimelineBucket[]; totalRows: number }
}

export function createTimelineCounter(
	fromMs: number,
	toMs: number,
	bucketMs: number,
): TimelineCounter {
	const first = Math.floor(fromMs / bucketMs)
	const size = timelineBucketCount(fromMs, toMs, bucketMs)
	const width = AGGREGATE_CATEGORIES.length
	const cells = new Float64Array(size * width)
	const index = new Map<string, number>(
		AGGREGATE_CATEGORIES.map((category, at) => [category, at]),
	)
	return {
		add(bucketIndex, category, n) {
			const slot = bucketIndex - first
			const column = index.get(category)
			if (slot < 0 || slot >= size || column === undefined) return
			const cell = slot * width + column
			cells[cell] = (cells[cell] ?? 0) + n
		},
		finish() {
			const buckets: ActivityTimelineBucket[] = []
			let totalRows = 0
			for (let slot = 0; slot < size; slot += 1) {
				const counts: Partial<Record<ActivityCategory, number>> = {}
				let total = 0
				for (let column = 0; column < width; column += 1) {
					const n = cells[slot * width + column] ?? 0
					if (n > 0) {
						counts[AGGREGATE_CATEGORIES[column] as ActivityCategory] = n
						total += n
					}
				}
				totalRows += total
				buckets.push({ startMs: (first + slot) * bucketMs, total, counts })
			}
			return { buckets, totalRows }
		},
	}
}

/** Pure timeline of already matched rows (filters applied); rows outside the window are ignored. */
export function aggregateTimeline(
	rows: Iterable<{ producedAtMs: number; category: ActivityCategory }>,
	fromMs: number,
	toMs: number,
	bucketMs: number,
): { buckets: ActivityTimelineBucket[]; totalRows: number } {
	const counter = createTimelineCounter(fromMs, toMs, bucketMs)
	for (const row of rows) {
		if (row.producedAtMs < fromMs || row.producedAtMs > toMs) continue
		counter.add(Math.floor(row.producedAtMs / bucketMs), row.category, 1)
	}
	return counter.finish()
}

// ---------- the bounded walk ----------

export interface AggregateWalkOutcome {
	/** Index rows of the window examined (matched or not). */
	scannedRows: number
	truncation: ActivityAggregateTruncation[]
	/** Rows at or after it were all examined; the window start when complete. */
	coveredFromMs: number
}

/**
 * Walks the window newest first in steps of at most `chunkRows` index rows (walk.ts) and
 * hands every piece to `visit`, which runs one statement bounded by the piece and returns
 * the piece's index rows (matched or not). The wall budget is checked before every
 * statement after the first (`guard`, shared with the caller's other statements); a spent
 * budget stops with `time-limit`. Reaching `scanRows` examined rows stops with `scan-rows`
 * (requirement 1.6) only when a one-row probe finds a row left below the cursor (exactly
 * `scanRows` rows in the window is complete): steps are sized so the cap is never passed.
 * `coveredFromMs` is the oldest boundary known exact: `lo` after a range piece, `ms + 1`
 * after a run piece (rows below it in the same ms may remain), the probed row's `ms + 1` at
 * the cap, the window start when the walk ended, and the window end + 1 ms when a budget
 * spent before any piece examined nothing.
 */
export function walkAggregate(
	db: SqlDatabase,
	input: {
		producedFromMs: number
		producedToMs: number
		limits: AggregatesReadLimits
	},
	guard: AggregateGuard,
	visit: (piece: StepPiece) => number,
): AggregateWalkOutcome {
	const { limits } = input
	const fromMs = input.producedFromMs
	const walk = createStepWalk(db, { fromMs, chunk: limits.chunkRows })
	let scannedRows = 0
	let scanCut = false
	let coveredFromMs = input.producedToMs + 1
	let cursor: StepCursor | null = walkStart(input.producedToMs)
	walk: while (cursor !== null) {
		const remaining = limits.scanRows - scannedRows
		if (remaining <= 0) {
			// At the cap: a one-row probe tells an exhausted window (complete) from rows
			// left below the cursor (cut; exact down to just above the next row's ms).
			const probe = walk.planStep(cursor, 1, guard.stop)
			if (probe.stopped) break
			if (probe.next !== null) {
				scanCut = true
				coveredFromMs = Math.min(coveredFromMs, probe.next.ms + 1)
			}
			cursor = probe.next
			break
		}
		const plan = walk.planStep(
			cursor,
			Math.min(limits.chunkRows, remaining),
			guard.stop,
		)
		if (plan.stopped) break
		for (const piece of plan.pieces) {
			if (guard.stop()) break walk
			scannedRows += visit(piece)
			coveredFromMs = Math.min(
				coveredFromMs,
				piece.kind === "tie" ? piece.ms + 1 : piece.lo,
			)
		}
		cursor = plan.next
	}
	if (cursor === null) coveredFromMs = fromMs
	const truncation: ActivityAggregateTruncation[] = []
	if (scanCut) truncation.push("scan-rows")
	if (guard.timedOut()) truncation.push("time-limit")
	return {
		scannedRows,
		truncation,
		// A budget spent before any piece examined nothing: producedTo + 1 ms, deliberately
		// not clamped (a clamp would claim rows at producedTo were examined).
		coveredFromMs: Math.max(fromMs, coveredFromMs),
	}
}

/** The cooperative wall budget, checked before every statement after the first. */
export interface AggregateGuard {
	/** Call before a statement: true when the budget is spent (the statement must not run). */
	stop(): boolean
	timedOut(): boolean
}

export function createAggregateGuard(
	wallBudgetMs: number,
	clock: () => number = () => performance.now(),
): AggregateGuard {
	const startedMs = clock()
	let statements = 0
	let timedOut = false
	return {
		stop() {
			if (timedOut) return true
			if (statements > 0 && clock() - startedMs >= wallBudgetMs) timedOut = true
			else statements += 1
			return timedOut
		},
		timedOut: () => timedOut,
	}
}

function appendIn(
	where: string[],
	params: SqlValue[],
	column: string,
	values: readonly string[] | undefined,
): void {
	if (values === undefined || values.length === 0) return
	where.push(`${column} IN (${values.map(() => "?").join(", ")})`)
	for (const value of values) params.push(value)
}

function readRetentionFloor(
	db: SqlDatabase,
	guard: AggregateGuard,
): string | null {
	// The first statement of a read, so it always runs (MIN on activity_produced is one seek).
	guard.stop()
	const floorRow = db
		.prepare("SELECT MIN(produced_at_ms) AS floor FROM activity")
		.get()
	const floor = floorRow?.["floor"]
	return floor === null || floor === undefined
		? null
		: iso(numberOf(floor, "retention floor"))
}

/** One packed row: [seq, produced_at_ms, kind, protocol, category, entity_key, frequency_hz]. */
export function toBandMapRow(packed: unknown): BandMapRow {
	if (!Array.isArray(packed) || packed.length !== 7)
		throw activityRecordCorrupt("Activity band map row is corrupt")
	const [seq, producedAtMs, kind, protocol, category, entityKey, frequency] =
		packed as unknown[]
	if (typeof kind !== "string" || !KINDS.has(kind))
		throw activityRecordCorrupt("Activity kind is corrupt")
	if (
		(protocol !== null && typeof protocol !== "string") ||
		(entityKey !== null && typeof entityKey !== "string") ||
		typeof seq !== "number" ||
		typeof producedAtMs !== "number" ||
		(frequency !== null && typeof frequency !== "number")
	)
		throw activityRecordCorrupt("Activity band map row is corrupt")
	return {
		seq,
		producedAtMs,
		kind,
		protocol,
		category: categoryOf(category),
		entityKey,
		frequencyHz: frequency,
	}
}

/** Parses one piece's packed rows (a JSON array built by json_group_array). */
export function parsePackedRows(text: unknown): unknown[] {
	if (typeof text !== "string")
		throw activityRecordCorrupt("Activity band map rows are corrupt")
	let parsed: unknown
	try {
		parsed = JSON.parse(text) as unknown
	} catch {
		throw activityRecordCorrupt("Activity band map rows are corrupt")
	}
	if (!Array.isArray(parsed))
		throw activityRecordCorrupt("Activity band map rows are corrupt")
	return parsed
}

/** Band map (requirements 1.1-1.6, 3.2, 3.3, 3.5). */
export function readBandMap(
	db: SqlDatabase,
	input: BandMapReadInput,
): ActivityBandMap {
	checkWindow(input)
	const limits = resolveAggregatesLimits(input.limits)
	if (
		!Number.isSafeInteger(input.minHz) ||
		!Number.isSafeInteger(input.maxHz) ||
		!Number.isSafeInteger(input.bucketHz) ||
		input.minHz < 0 ||
		input.minHz > input.maxHz ||
		input.bucketHz < 1
	)
		throw new ActivityQueryInvalidError("band map range is invalid")
	const where = ["(frequency_hz IS NULL OR frequency_hz BETWEEN ? AND ?)"]
	const params: SqlValue[] = [input.minHz, input.maxHz]
	appendIn(where, params, "category", input.categories)
	appendIn(where, params, "protocol", input.protocols)
	const filters = where.join(" AND ")
	// One packed row per piece (at most the piece's chunk of rows inside): materialising
	// a JSON text and parsing it costs about a third of returning each row as an object.
	// COUNT(*) is the piece's index rows (scannedRows); the filters select what is packed.
	const select = `SELECT COUNT(*) AS n, json_group_array(json_array(seq, produced_at_ms, kind,
		protocol, category, entity_key, frequency_hz)) FILTER (WHERE ${filters}) AS j
		FROM activity INDEXED BY activity_produced`
	const scanTie = db.prepare(`${select} WHERE ${WALK_TIE_WHERE}`)
	const scanRange = db.prepare(`${select} WHERE ${WALK_RANGE_WHERE}`)
	const guard = createAggregateGuard(limits.wallBudgetMs, input.clock)
	const retentionFloor = readRetentionFloor(db, guard)
	const aggregator = createBandMapAggregator({
		minHz: input.minHz,
		maxHz: input.maxHz,
		bucketHz: input.bucketHz,
		maxBuckets: limits.maxBuckets,
		maxProtocols: limits.maxProtocols,
		maxTopEntities: limits.maxTopEntities,
	})
	const outcome = walkAggregate(
		db,
		{
			producedFromMs: input.producedFromMs,
			producedToMs: input.producedToMs,
			limits,
		},
		guard,
		piece => {
			const packed = (piece.kind === "tie" ? scanTie : scanRange).get(
				...params,
				...pieceParams(piece),
			)
			for (const row of parsePackedRows(packed?.["j"] ?? "[]"))
				aggregator.add(toBandMapRow(row))
			return numberOf(packed?.["n"] ?? 0, "count")
		},
	)
	const aggregate = aggregator.finish()
	const truncation: ActivityBandMapTruncation[] = [...outcome.truncation]
	if (aggregate.bucketsCut) truncation.push("buckets")
	return {
		producedFrom: iso(input.producedFromMs),
		producedTo: iso(input.producedToMs),
		minHz: input.minHz,
		maxHz: input.maxHz,
		bucketHz: input.bucketHz,
		buckets: aggregate.buckets,
		scannedRows: outcome.scannedRows,
		countedRows: aggregate.countedRows,
		noFrequencyRows: aggregate.noFrequencyRows,
		droppedRows: aggregate.droppedRows,
		truncated: truncation.length > 0,
		truncation,
		coveredFrom: iso(outcome.coveredFromMs),
		retentionFloor,
		generatedAt: iso(input.nowMs ?? Date.now()),
	}
}

/** Timeline (requirements 2.1-2.5, 3.2, 3.3, 3.5). */
export function readTimeline(
	db: SqlDatabase,
	input: TimelineReadInput,
): ActivityTimeline {
	checkWindow(input)
	const limits = resolveAggregatesLimits(input.limits)
	if (!Number.isSafeInteger(input.bucketMs) || input.bucketMs < 1)
		throw new ActivityQueryInvalidError("timeline bucket is invalid")
	if (
		timelineBucketCount(
			input.producedFromMs,
			input.producedToMs,
			input.bucketMs,
		) > limits.maxTimelineBuckets
	)
		throw new ActivityQueryInvalidError("timeline has too many buckets")
	const where: string[] = []
	const params: SqlValue[] = []
	appendIn(where, params, "category", input.categories)
	appendIn(where, params, "protocol", input.protocols)
	appendIn(where, params, "entity_key", input.entityKeys)
	const filters = where.length === 0 ? "1" : where.join(" AND ")
	// Integer division: produced_at_ms and the bound bigint are both INTEGER, and the
	// window is non-negative, so this is floor(ms / bucketMs). `seen` counts every index
	// row of the piece (scannedRows), `n` the matched ones, `bad` matched rows of an unknown
	// kind. Like the band map, only matched rows are checked (kind and category).
	const select = `SELECT produced_at_ms / ? AS b, category, COUNT(*) AS seen,
		COUNT(*) FILTER (WHERE ${filters}) AS n,
		COUNT(*) FILTER (WHERE (${filters}) AND kind NOT IN (${KIND_LIST})) AS bad
		FROM activity INDEXED BY activity_produced`
	const scanTie = db.prepare(
		`${select} WHERE ${WALK_TIE_WHERE} GROUP BY b, category`,
	)
	const scanRange = db.prepare(
		`${select} WHERE ${WALK_RANGE_WHERE} GROUP BY b, category`,
	)
	const guard = createAggregateGuard(limits.wallBudgetMs, input.clock)
	const retentionFloor = readRetentionFloor(db, guard)
	const counter = createTimelineCounter(
		input.producedFromMs,
		input.producedToMs,
		input.bucketMs,
	)
	const bucketParam = BigInt(input.bucketMs)
	const outcome = walkAggregate(
		db,
		{
			producedFromMs: input.producedFromMs,
			producedToMs: input.producedToMs,
			limits,
		},
		guard,
		piece => {
			const rows = (piece.kind === "tie" ? scanTie : scanRange).all(
				bucketParam,
				...params, // n
				...params, // bad
				...pieceParams(piece),
			)
			let seen = 0
			for (const row of rows) {
				if (numberOf(row["bad"], "count") > 0)
					throw activityRecordCorrupt("Activity kind is corrupt")
				const n = numberOf(row["n"], "count")
				if (n > 0)
					counter.add(
						numberOf(row["b"], "bucket"),
						categoryOf(row["category"]),
						n,
					)
				seen += numberOf(row["seen"], "count")
			}
			return seen
		},
	)
	const { buckets, totalRows } = counter.finish()
	return {
		producedFrom: iso(input.producedFromMs),
		producedTo: iso(input.producedToMs),
		bucketMs: input.bucketMs,
		buckets,
		totalRows,
		scannedRows: outcome.scannedRows,
		truncated: outcome.truncation.length > 0,
		truncation: outcome.truncation,
		coveredFrom: iso(outcome.coveredFromMs),
		retentionFloor,
		generatedAt: iso(input.nowMs ?? Date.now()),
	}
}
