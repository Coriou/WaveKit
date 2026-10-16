import { performance } from "node:perf_hooks"
import {
	ACTIVITY_TRAILS_MAX_ENTITIES,
	ACTIVITY_TRAILS_MAX_POINTS,
	ACTIVITY_TRAILS_MAX_POINTS_PER_ENTITY,
	ACTIVITY_TRAILS_SCAN_ROWS,
} from "@wavekit/api-types"
import type {
	ActivityCategory,
	ActivityTrail,
	ActivityTrailPoint,
	ActivityTrails,
	ActivityTrailsTruncation,
} from "../storage/contract.js"
import { activityRecordCorrupt, ActivityQueryInvalidError } from "./errors.js"
import type { SqlDatabase, SqlValue } from "./sqlite.js"
import {
	createStepWalk,
	numberOf,
	pieceParams,
	startOf,
	WALK_CHUNK_ROWS,
	WALK_RANGE_WHERE,
	WALK_TIE_WHERE,
	walkStart,
	type StepCursor,
	type StepPiece,
} from "./walk.js"

export interface TrailsReadLimits {
	maxPoints: number
	maxEntities: number
	maxPointsPerEntity: number
	scanRows: number
}

export interface TrailsReadInput {
	/** Inclusive. */
	producedFromMs: number
	/** Inclusive. */
	producedToMs: number
	categories?: readonly string[]
	protocols?: readonly string[]
	entityKeys?: readonly string[]
	limits: TrailsReadLimits
	/** generatedAt; defaults to Date.now(). */
	nowMs?: number
	/** Index rows examined per walk step; defaults to TRAILS_CHUNK_ROWS (tests lower it). */
	chunkRows?: number
	/**
	 * Cooperative wall-time budget in ms of the whole read (walk and early-stop probe);
	 * defaults to TRAILS_WALL_BUDGET_MS. Past it the work stops and the result is marked
	 * `time-limit`, so the outer reader deadline (and its worker restart) stays a backstop.
	 */
	wallBudgetMs?: number
	/**
	 * Part of the wall budget kept for the early-stop probe: the walk stops at
	 * `wallBudgetMs - probeReserveMs`, the probe at `wallBudgetMs`. Defaults to
	 * TRAILS_PROBE_RESERVE_MS.
	 */
	probeReserveMs?: number
	/** Monotonic ms clock for the budget; defaults to performance.now (tests inject one). */
	clock?: () => number
}

/** Default scan wall budget, well inside the 1 000 ms trails reader deadline. */
export const TRAILS_WALL_BUDGET_MS = 600

/** Share of the wall budget reserved for the early-stop probe (the walk gets the rest). */
export const TRAILS_PROBE_RESERVE_MS = 150

export const DEFAULT_TRAILS_READ_LIMITS: TrailsReadLimits = Object.freeze({
	maxPoints: ACTIVITY_TRAILS_MAX_POINTS,
	maxEntities: ACTIVITY_TRAILS_MAX_ENTITIES,
	maxPointsPerEntity: ACTIVITY_TRAILS_MAX_POINTS_PER_ENTITY,
	scanRows: ACTIVITY_TRAILS_SCAN_ROWS,
})

/** One scanned row, newest first. `position` is the stored position JSON text, or null. */
export interface TrailRow {
	seq: number
	producedAtMs: number
	entityKey: string
	category: ActivityCategory
	protocol: string | null
	position: unknown
}

export interface TrailPosition {
	lat: number
	lon: number
	altM: number | null
}

export interface AcceptedTrails {
	trails: ActivityTrail[]
	pointCount: number
	scannedRows: number
	skippedRows: number
	truncated: boolean
	truncation: ActivityTrailsTruncation[]
}

const TRUNCATION_ORDER: readonly ActivityTrailsTruncation[] = [
	"scan-rows",
	"points",
	"entities",
	"per-entity",
	"time-limit",
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validates a stored position. Accepts JSON text or an already-parsed value.
 * Returns null for anything that is not a usable point: missing, malformed,
 * non-object, non-number or non-finite lat/lon, out of range, or exactly (0, 0).
 */
export function parseTrailPosition(json: unknown): TrailPosition | null {
	let value: unknown = json
	if (typeof json === "string") {
		try {
			value = JSON.parse(json) as unknown
		} catch {
			return null
		}
	}
	if (!isPlainObject(value)) return null
	const lat = value["lat"]
	const lon = value["lon"]
	if (typeof lat !== "number" || typeof lon !== "number") return null
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
	if (lat === 0 && lon === 0) return null
	const alt = value["altM"]
	const altM = typeof alt === "number" && Number.isFinite(alt) ? alt : null
	return { lat, lon, altM }
}

interface Building {
	entityKey: string
	category: ActivityCategory
	protocol: string | null
	newestMs: number
	/** Newest first while building. */
	points: ActivityTrailPoint[]
	truncated: boolean
}

/**
 * Resolves which returned trails lost an older in-window point. Given the keys of
 * the returned trails not yet marked truncated (only when the scan stopped early),
 * returns those that have a valid in-window row past the stop. `complete: false`
 * means the check ran out of time: every candidate not in `older` is then marked
 * truncated (conservative) and `time-limit` is reported.
 */
export type TrailOlderResolver = (candidates: readonly string[]) => {
	older: ReadonlySet<string>
	complete: boolean
}

/**
 * Greedy newest-first acceptance over rows already ordered by
 * (produced_at_ms DESC, seq DESC). `rows` may hold one row past
 * `limits.scanRows`; that row only signals the scan-rows bound.
 * Every scanned row (valid or not) counts toward the scan cap.
 */
export function acceptTrailRows(
	rows: readonly TrailRow[],
	limits: TrailsReadLimits,
): AcceptedTrails {
	const acceptor = createTrailAcceptor(limits)
	let index = 0
	for (const row of rows) {
		if (!acceptor.push(row)) break
		index += 1
	}
	// Rows from the stop on (the refused row included): any valid one of a
	// returned entity is a lost point.
	const rest = rows.slice(index)
	return acceptor.finish(rows.length > limits.scanRows, candidates => {
		const wanted = new Set(candidates)
		const older = new Set<string>()
		for (const row of rest) {
			if (
				wanted.has(row.entityKey) &&
				parseTrailPosition(row.position) !== null
			)
				older.add(row.entityKey)
		}
		return { older, complete: true }
	})
}

export interface TrailAcceptor {
	/** Feeds the next row in scan order. False: stop scanning (a cap was reached). */
	push(row: TrailRow): boolean
	/**
	 * `moreRows`: a row exists past the scanned ones (signals scan-rows when no other stop).
	 * `resolveOlder`: consulted once with the untruncated trails when the scan stopped
	 * early (scan-rows, points or time-limit), to mark trails that lost older in-window
	 * points. `timeLimited`: the wall budget stopped the scan before a remaining row.
	 */
	finish(
		moreRows: boolean,
		resolveOlder?: TrailOlderResolver,
		timeLimited?: boolean,
	): AcceptedTrails
}

/** Incremental form of acceptTrailRows, so the reader can stop the SQL walk early. */
export function createTrailAcceptor(limits: TrailsReadLimits): TrailAcceptor {
	const hit = new Set<ActivityTrailsTruncation>()
	const byEntity = new Map<string, Building>()
	let pointCount = 0
	let scannedRows = 0
	let skippedRows = 0
	let stopped = false

	function push(row: TrailRow): boolean {
		if (stopped || scannedRows >= limits.scanRows) return false
		scannedRows += 1
		const position = parseTrailPosition(row.position)
		if (position === null) {
			skippedRows += 1
			return true
		}
		const trail = byEntity.get(row.entityKey)
		if (pointCount >= limits.maxPoints) {
			// The scan stops at the point cap; this row is the refused one.
			hit.add("points")
			if (trail) trail.truncated = true
			stopped = true
			return false
		}
		const point: ActivityTrailPoint = [
			row.producedAtMs,
			position.lat,
			position.lon,
			position.altM,
		]
		if (trail === undefined) {
			if (byEntity.size >= limits.maxEntities) {
				hit.add("entities")
				return true
			}
			byEntity.set(row.entityKey, {
				entityKey: row.entityKey,
				category: row.category,
				protocol: row.protocol,
				newestMs: row.producedAtMs,
				points: [point],
				truncated: false,
			})
			pointCount += 1
			return true
		}
		if (trail.points.length >= limits.maxPointsPerEntity) {
			hit.add("per-entity")
			trail.truncated = true
			return true
		}
		trail.points.push(point)
		pointCount += 1
		return true
	}

	function finish(
		moreRows: boolean,
		resolveOlder?: TrailOlderResolver,
		timeLimited = false,
	): AcceptedTrails {
		if (moreRows && !stopped && scannedRows >= limits.scanRows)
			hit.add("scan-rows")
		if (timeLimited && !stopped) hit.add("time-limit")
		const built = [...byEntity.values()]
		if (
			resolveOlder &&
			(hit.has("scan-rows") || hit.has("points") || hit.has("time-limit"))
		) {
			const open = built.filter(entry => !entry.truncated)
			const { older, complete } = resolveOlder(
				open.map(entry => entry.entityKey),
			)
			for (const entry of open) {
				if (!complete || older.has(entry.entityKey)) entry.truncated = true
			}
			if (!complete) hit.add("time-limit")
		}
		built.sort((left, right) => {
			if (left.newestMs !== right.newestMs)
				return right.newestMs - left.newestMs
			if (left.entityKey === right.entityKey) return 0
			return left.entityKey < right.entityKey ? -1 : 1
		})
		const trails: ActivityTrail[] = built.map(entry => ({
			entityKey: entry.entityKey,
			category: entry.category,
			protocol: entry.protocol,
			points: entry.points.reverse(),
			truncated: entry.truncated,
		}))
		const truncation = TRUNCATION_ORDER.filter(bound => hit.has(bound))
		return {
			trails,
			pointCount,
			scannedRows,
			skippedRows,
			truncated: truncation.length > 0,
			truncation,
		}
	}

	return { push, finish }
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

function checkLimits(input: TrailsReadInput): void {
	const { limits } = input
	for (const value of [
		limits.maxPoints,
		limits.maxEntities,
		limits.maxPointsPerEntity,
		limits.scanRows,
	]) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new ActivityQueryInvalidError("trails limits are invalid")
		}
	}
	if (
		!Number.isSafeInteger(input.producedFromMs) ||
		!Number.isSafeInteger(input.producedToMs) ||
		input.producedFromMs > input.producedToMs
	) {
		throw new ActivityQueryInvalidError("trails window is invalid")
	}
}

/** Index rows of the window examined per step of the newest-first walk. */
export const TRAILS_CHUNK_ROWS = WALK_CHUNK_ROWS

function toTrailRow(row: Record<string, unknown>): TrailRow {
	const entityKey = row["entity_key"]
	const category = row["category"]
	const protocol = row["protocol"]
	if (typeof entityKey !== "string" || typeof category !== "string") {
		throw activityRecordCorrupt("Activity trail row is corrupt")
	}
	return {
		seq: numberOf(row["seq"], "seq"),
		producedAtMs: numberOf(row["produced_at_ms"], "producedAt"),
		entityKey,
		category: category as ActivityCategory,
		protocol: typeof protocol === "string" ? protocol : null,
		position: row["position"] ?? null,
	}
}

/** SQL scan plus acceptance. The caller owns the read transaction. */
export function readTrails(
	db: SqlDatabase,
	input: TrailsReadInput,
): ActivityTrails {
	checkLimits(input)
	// Filters only; the window is applied per step as an index range.
	const where = ["kind = 'decoder-reception'", "entity_key IS NOT NULL"]
	const params: SqlValue[] = []
	appendIn(where, params, "category", input.categories)
	appendIn(where, params, "protocol", input.protocols)
	appendIn(where, params, "entity_key", input.entityKeys)
	const filters = where.join(" AND ")
	const fromMs = input.producedFromMs
	const acceptor = createTrailAcceptor(input.limits)
	const chunk = Math.max(1, Math.floor(input.chunkRows ?? TRAILS_CHUNK_ROWS))
	const clock = input.clock ?? (() => performance.now())
	const wallBudgetMs = input.wallBudgetMs ?? TRAILS_WALL_BUDGET_MS
	// The walk stops early enough to leave the probe its reserve inside the one budget.
	const walkBudgetMs = Math.max(
		0,
		wallBudgetMs - (input.probeReserveMs ?? TRAILS_PROBE_RESERVE_MS),
	)
	const startedMs = clock()
	const elapsed = (): number => clock() - startedMs

	// The walk goes newest first, (produced_at_ms, seq) descending, in steps of at most
	// `chunk` index rows of the window, whatever the filters match. activity_produced is
	// (produced_at_ms) with the rowid (seq) implicit, so every statement uses bounds the
	// index can seek on: a run of equal produced_at_ms (`produced_at_ms = ? AND seq < ?
	// AND seq >= ?`) or a range of whole milliseconds (`produced_at_ms BETWEEN ? AND ?`).
	// A step first finds its end on the index alone (covering), then reads the filtered
	// rows of its pieces; the clock is checked before every statement after the first.
	const START: StepCursor = walkStart(input.producedToMs)
	const walk = createStepWalk(db, { fromMs, chunk })
	const planStep = (
		cursor: StepCursor,
	): { pieces: StepPiece[]; next: StepCursor | null } => walk.planStep(cursor)
	const TIE_WHERE = WALK_TIE_WHERE
	const RANGE_WHERE = WALK_RANGE_WHERE
	const scanSelect = `SELECT seq, produced_at_ms, entity_key, category, protocol,
		CASE WHEN json_valid(summary_json) AND json_type(summary_json, '$.position') = 'object'
			THEN json_extract(summary_json, '$.position') END AS position
		FROM activity INDEXED BY activity_produced`
	const scanTie = db.prepare(
		`${scanSelect} WHERE ${TIE_WHERE} AND ${filters} ORDER BY seq DESC`,
	)
	const scanRange = db.prepare(
		`${scanSelect} WHERE ${RANGE_WHERE} AND ${filters}
		ORDER BY produced_at_ms DESC, seq DESC`,
	)
	const scanPiece = (piece: StepPiece): TrailRow[] =>
		(piece.kind === "tie" ? scanTie : scanRange)
			.all(...pieceParams(piece), ...params)
			.map(toTrailRow)

	let read = 0
	let moreRows = false
	let timeLimited = false
	/** Rows read by the walk but not consumed; the probe checks them first. */
	let pending: TrailRow[] = []
	/** Where the probe continues: above the first unread piece; null when the window is done. */
	let resume: StepCursor | null = null
	let cursor: StepCursor | null = START
	walk: for (let steps = 0; cursor !== null; steps += 1) {
		if (steps > 0 && elapsed() >= walkBudgetMs) {
			timeLimited = true
			resume = cursor
			break
		}
		const { pieces, next } = planStep(cursor)
		for (let at = 0; at < pieces.length; at += 1) {
			const piece = pieces[at] as StepPiece
			const after = (): StepCursor | null => {
				const following = pieces[at + 1]
				return following === undefined ? next : startOf(following)
			}
			// After the step end and between pieces: a stop leaves the cursor unchanged.
			if ((steps > 0 || at > 0) && elapsed() >= walkBudgetMs) {
				timeLimited = true
				resume = startOf(piece)
				break walk
			}
			const rows = scanPiece(piece)
			for (let index = 0; index < rows.length; index += 1) {
				const row = rows[index] as TrailRow
				// Checked before every row after the first, so a stop leaves a real
				// unscanned row behind.
				if (read > 0 && elapsed() >= walkBudgetMs) {
					timeLimited = true
					pending = rows.slice(index)
					resume = after()
					break walk
				}
				read += 1
				if (read > input.limits.scanRows) {
					// One row past scanRows only signals the bound.
					moreRows = true
					pending = rows.slice(index)
					resume = after()
					break walk
				}
				if (!acceptor.push(row)) {
					pending = rows.slice(index + 1)
					resume = after()
					break walk
				}
			}
		}
		cursor = next
	}
	// Early stop: the walk continues past the stop with the same steps, reading the
	// position only for the returned trails not yet known to be cut, to find those that
	// lost an older in-window valid row. Rows the walk already read are not read again.
	// It ends when no open trail remains or the window is exhausted (exact), or when the
	// shared wall budget runs out (the rest are marked truncated, time-limit reported).
	const probeSelect = `SELECT entity_key,
			CASE WHEN entity_key IN (SELECT value FROM json_each(?))
				THEN CASE WHEN json_valid(summary_json) AND json_type(summary_json, '$.position') = 'object'
					THEN json_extract(summary_json, '$.position') END END AS position
			FROM activity INDEXED BY activity_produced`
	const probeTie = db.prepare(
		`${probeSelect} WHERE ${TIE_WHERE} AND ${filters}`,
	)
	const probeRange = db.prepare(
		`${probeSelect} WHERE ${RANGE_WHERE} AND ${filters}`,
	)
	const resolveOlder: TrailOlderResolver = candidates => {
		const open = new Set(candidates)
		const older = new Set<string>()
		const check = (entityKey: string, position: unknown): void => {
			if (open.has(entityKey) && parseTrailPosition(position) !== null) {
				open.delete(entityKey)
				older.add(entityKey)
			}
		}
		for (const row of pending) check(row.entityKey, row.position)
		let at = resume
		while (open.size > 0 && at !== null) {
			if (elapsed() >= wallBudgetMs) return { older, complete: false }
			const { pieces, next } = planStep(at)
			for (const piece of pieces) {
				if (open.size === 0) break
				if (elapsed() >= wallBudgetMs) return { older, complete: false }
				const found = (piece.kind === "tie" ? probeTie : probeRange).all(
					JSON.stringify([...open]),
					...pieceParams(piece),
					...params,
				)
				for (const raw of found) {
					const entityKey = raw["entity_key"]
					if (typeof entityKey !== "string")
						throw activityRecordCorrupt("Activity trail row is corrupt")
					const position = raw["position"]
					if (position !== null && position !== undefined)
						check(entityKey, position)
				}
			}
			at = next
		}
		return { older, complete: true }
	}
	const accepted = acceptor.finish(moreRows, resolveOlder, timeLimited)
	const floorRow = db
		.prepare("SELECT MIN(produced_at_ms) AS floor FROM activity")
		.get()
	const floor = floorRow?.["floor"]
	const retentionFloor =
		floor === null || floor === undefined
			? null
			: new Date(numberOf(floor, "retention floor")).toISOString()
	return {
		producedFrom: new Date(input.producedFromMs).toISOString(),
		producedTo: new Date(input.producedToMs).toISOString(),
		trails: accepted.trails,
		pointCount: accepted.pointCount,
		scannedRows: accepted.scannedRows,
		skippedRows: accepted.skippedRows,
		truncated: accepted.truncated,
		truncation: accepted.truncation,
		retentionFloor,
		generatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
	}
}
