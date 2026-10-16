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
	/** Keyset chunk size of the walk; defaults to TRAILS_CHUNK_ROWS (tests lower it). */
	chunkRows?: number
}

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
	/** Oldest accepted row, in scan order the last one. */
	oldestMs: number
	oldestSeq: number
	truncated: boolean
}

/**
 * Asks whether an in-window row with a valid position, older in scan order
 * than (oldestMs, oldestSeq), exists for the entity. Used only when the scan
 * stopped early, so trails that lost points past the stop are marked.
 */
export type TrailHasOlder = (
	entityKey: string,
	oldestMs: number,
	oldestSeq: number,
) => boolean

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
	return acceptor.finish(rows.length > limits.scanRows, entityKey =>
		rest.some(
			row =>
				row.entityKey === entityKey &&
				parseTrailPosition(row.position) !== null,
		),
	)
}

export interface TrailAcceptor {
	/** Feeds the next row in scan order. False: stop scanning (a cap was reached). */
	push(row: TrailRow): boolean
	/**
	 * `moreRows`: a row exists past the scanned ones (signals scan-rows when no other stop).
	 * `hasOlder`: consulted per untruncated trail when the scan stopped early
	 * (scan-rows or points), to mark trails that lost older in-window points.
	 */
	finish(moreRows: boolean, hasOlder?: TrailHasOlder): AcceptedTrails
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
				oldestMs: row.producedAtMs,
				oldestSeq: row.seq,
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
		trail.oldestMs = row.producedAtMs
		trail.oldestSeq = row.seq
		pointCount += 1
		return true
	}

	function finish(moreRows: boolean, hasOlder?: TrailHasOlder): AcceptedTrails {
		if (moreRows && !stopped && scannedRows >= limits.scanRows)
			hit.add("scan-rows")
		const built = [...byEntity.values()]
		if (hasOlder && (hit.has("scan-rows") || hit.has("points"))) {
			for (const entry of built) {
				if (entry.truncated) continue
				if (hasOlder(entry.entityKey, entry.oldestMs, entry.oldestSeq))
					entry.truncated = true
			}
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

function numberOf(value: unknown, what: string): number {
	if (typeof value === "number") return value
	if (typeof value === "bigint") return Number(value)
	throw activityRecordCorrupt(`Activity ${what} is not a number`)
}

/** Rows fetched per keyset chunk of the newest-first walk. */
export const TRAILS_CHUNK_ROWS = 4_096

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
	const where = [
		"produced_at_ms BETWEEN ? AND ?",
		"kind = 'decoder-reception'",
		"entity_key IS NOT NULL",
	]
	const params: SqlValue[] = [input.producedFromMs, input.producedToMs]
	appendIn(where, params, "category", input.categories)
	appendIn(where, params, "protocol", input.protocols)
	appendIn(where, params, "entity_key", input.entityKeys)
	// The walk is read in keyset chunks so a point cap stops it early instead
	// of materialising scanRows rows. One extra row past scanRows signals the
	// scan-rows bound.
	const acceptor = createTrailAcceptor(input.limits)
	const budget = input.limits.scanRows + 1
	const select = `SELECT seq, produced_at_ms, entity_key, category, protocol,
		CASE WHEN json_valid(summary_json) AND json_type(summary_json, '$.position') = 'object'
			THEN json_extract(summary_json, '$.position') END AS position
		FROM activity INDEXED BY activity_produced
		WHERE ${where.join(" AND ")}`
	const first = db.prepare(
		`${select} ORDER BY produced_at_ms DESC, seq DESC LIMIT ?`,
	)
	// (produced_at_ms, seq) < (lastMs, lastSeq), written so the index range still applies.
	const next = db.prepare(
		`${select} AND produced_at_ms <= ? AND (produced_at_ms < ? OR seq < ?) ORDER BY produced_at_ms DESC, seq DESC LIMIT ?`,
	)
	const chunk = Math.max(1, Math.floor(input.chunkRows ?? TRAILS_CHUNK_ROWS))
	let read = 0
	let moreRows = false
	let last: TrailRow | null = null
	walk: for (;;) {
		const size = Math.min(chunk, budget - read)
		const found =
			last === null
				? first.all(...params, size)
				: next.all(
						...params,
						last.producedAtMs,
						last.producedAtMs,
						last.seq,
						size,
					)
		for (const raw of found) {
			const row = toTrailRow(raw)
			read += 1
			last = row
			if (read > input.limits.scanRows) {
				moreRows = true
				break walk
			}
			if (!acceptor.push(row)) break walk
		}
		if (found.length < size || read >= budget) break
	}
	// Early stop: probe each returned trail for an older in-window valid row it
	// did not get (at most maxEntities probes on activity_entity, same snapshot).
	// The SQL predicate mirrors parseTrailPosition; JSON overflow (1e999) reads
	// as an infinite real and fails the range check.
	const probe = db.prepare(
		`SELECT 1 AS hit FROM activity INDEXED BY activity_entity
		WHERE entity_key = ? AND ${where.join(" AND ")}
		AND (produced_at_ms < ? OR (produced_at_ms = ? AND seq < ?))
		AND json_valid(summary_json)
		AND json_type(summary_json, '$.position.lat') IN ('integer', 'real')
		AND json_type(summary_json, '$.position.lon') IN ('integer', 'real')
		AND json_extract(summary_json, '$.position.lat') BETWEEN -90 AND 90
		AND json_extract(summary_json, '$.position.lon') BETWEEN -180 AND 180
		AND NOT (json_extract(summary_json, '$.position.lat') = 0
			AND json_extract(summary_json, '$.position.lon') = 0)
		LIMIT 1`,
	)
	const accepted = acceptor.finish(
		moreRows,
		(entityKey, oldestMs, oldestSeq) =>
			probe.get(entityKey, ...params, oldestMs, oldestMs, oldestSeq) !==
			undefined,
	)
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
