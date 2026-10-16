import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runRead } from "../../../../../src/core/activity/query/read.js"
import type { SqlDatabase } from "../../../../../src/core/activity/query/sqlite.js"
import { openReadOnly } from "../../../../../src/core/activity/query/sqlite.js"
import {
	acceptTrailRows,
	DEFAULT_TRAILS_READ_LIMITS,
	parseTrailPosition,
	type TrailRow,
	type TrailsReadInput,
	type TrailsReadLimits,
} from "../../../../../src/core/activity/query/trails.js"
import type {
	ActivityCategory,
	ActivityTrails,
	ActivityTrailsTruncation,
} from "../../../../../src/core/activity/storage/contract.js"
import { ACTIVITY_SCHEMA_V1 } from "../../../../../src/core/activity/storage/contract.js"
import { FIXTURE_CLOCK_ANCHOR_MS } from "../storage/helpers.js"

const NOW = FIXTURE_CLOCK_ANCHOR_MS

// ---------- naive model (requirements 1.3-1.5) ----------

interface ModelResult {
	trails: { entityKey: string; points: number[][]; truncated: boolean }[]
	pointCount: number
	scannedRows: number
	skippedRows: number
	truncation: ActivityTrailsTruncation[]
}

function modelValid(position: unknown): [number, number, number | null] | null {
	let value = position
	if (typeof value === "string") {
		try {
			value = JSON.parse(value) as unknown
		} catch {
			return null
		}
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null
	const body = value as Record<string, unknown>
	const lat = body["lat"]
	const lon = body["lon"]
	if (typeof lat !== "number" || typeof lon !== "number") return null
	if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null
	if (lat === 0 && lon === 0) return null
	const alt = body["altM"]
	return [
		lat,
		lon,
		typeof alt === "number" && Number.isFinite(alt) ? alt : null,
	]
}

function model(
	rows: readonly TrailRow[],
	limits: TrailsReadLimits,
): ModelResult {
	const scanned = rows.slice(0, limits.scanRows)
	const points = new Map<string, number[][]>()
	const truncation = new Set<ActivityTrailsTruncation>()
	let total = 0
	let scannedRows = 0
	let skippedRows = 0
	let stopped = false
	for (const row of scanned) {
		scannedRows += 1
		const valid = modelValid(row.position)
		if (!valid) {
			skippedRows += 1
			continue
		}
		if (total === limits.maxPoints) {
			truncation.add("points")
			stopped = true
			break
		}
		const list = points.get(row.entityKey)
		if (!list && points.size === limits.maxEntities) {
			truncation.add("entities")
			continue
		}
		if (list && list.length === limits.maxPointsPerEntity) {
			truncation.add("per-entity")
			continue
		}
		const target = list ?? []
		target.push([row.producedAtMs, ...valid] as number[])
		points.set(row.entityKey, target)
		total += 1
	}
	if (!stopped && rows.length > limits.scanRows) truncation.add("scan-rows")
	// Independent of the caps: a trail is truncated exactly when the full,
	// uncapped input holds a valid in-window point of its entity it did not get.
	const validCount = new Map<string, number>()
	for (const row of rows) {
		if (modelValid(row.position) === null) continue
		validCount.set(row.entityKey, (validCount.get(row.entityKey) ?? 0) + 1)
	}
	const trails = [...points.entries()]
		.map(([entityKey, list]) => ({
			entityKey,
			points: [...list].reverse(),
			truncated: (validCount.get(entityKey) ?? 0) > list.length,
		}))
		.sort((a, b) => {
			const an = a.points[a.points.length - 1]?.[0] ?? 0
			const bn = b.points[b.points.length - 1]?.[0] ?? 0
			if (an !== bn) return bn - an
			return a.entityKey < b.entityKey ? -1 : a.entityKey > b.entityKey ? 1 : 0
		})
	const order: ActivityTrailsTruncation[] = [
		"scan-rows",
		"points",
		"entities",
		"per-entity",
	]
	return {
		trails,
		pointCount: total,
		scannedRows,
		skippedRows,
		truncation: order.filter(bound => truncation.has(bound)),
	}
}

// ---------- generators ----------

const positionArb: fc.Arbitrary<unknown> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc
			.record({
				lat: fc.double({ min: -90, max: 90, noNaN: true }),
				lon: fc.double({ min: -180, max: 180, noNaN: true }),
				altM: fc.option(fc.double(), { nil: undefined }),
			})
			.map(value => JSON.stringify(value)),
	},
	{ weight: 1, arbitrary: fc.constant(null) },
	{ weight: 1, arbitrary: fc.constant("{not json") },
	{ weight: 1, arbitrary: fc.constant("[1,2]") },
	{ weight: 1, arbitrary: fc.constant('{"lat":"48.1","lon":2}') },
	{ weight: 1, arbitrary: fc.constant('{"lat":0,"lon":0}') },
	{ weight: 1, arbitrary: fc.constant('{"lat":91,"lon":2}') },
	{ weight: 1, arbitrary: fc.constant('{"lat":10,"lon":-181}') },
	{ weight: 1, arbitrary: fc.constant('{"lat":1e999,"lon":2}') },
)

interface RawRow {
	producedAtMs: number
	entityKey: string
	category: ActivityCategory
	protocol: string | null
	position: unknown
}

const rawRowArb: fc.Arbitrary<RawRow> = fc.record({
	producedAtMs: fc.integer({ min: NOW - 20, max: NOW }),
	entityKey: fc.constantFrom("a", "b", "c", "d", "e", "f"),
	category: fc.constantFrom<ActivityCategory>("aircraft", "marine"),
	protocol: fc.constantFrom("adsb", "ais", null),
	position: positionArb,
})

/** Rows in scan order: produced_at_ms DESC, seq DESC. */
function toScanOrder(raw: readonly RawRow[]): TrailRow[] {
	return raw
		.map((row, index) => ({ ...row, seq: index + 1 }))
		.sort((a, b) => b.producedAtMs - a.producedAtMs || b.seq - a.seq)
}

const limitsArb: fc.Arbitrary<TrailsReadLimits> = fc.record({
	maxPoints: fc.integer({ min: 1, max: 30 }),
	maxEntities: fc.integer({ min: 1, max: 7 }),
	maxPointsPerEntity: fc.integer({ min: 1, max: 10 }),
	scanRows: fc.integer({ min: 1, max: 50 }),
})

function strip(
	result: ReturnType<typeof acceptTrailRows> | ActivityTrails,
): ModelResult {
	return {
		trails: result.trails.map(trail => ({
			entityKey: trail.entityKey,
			points: trail.points.map(point => [...point] as number[]),
			truncated: trail.truncated,
		})),
		pointCount: result.pointCount,
		scannedRows: result.scannedRows,
		skippedRows: result.skippedRows,
		truncation: [...result.truncation],
	}
}

// ---------- unit ----------

describe("parseTrailPosition", () => {
	it("accepts valid positions and normalises altM", () => {
		expect(parseTrailPosition('{"lat":48.1,"lon":2.3,"altM":100}')).toEqual({
			lat: 48.1,
			lon: 2.3,
			altM: 100,
		})
		expect(parseTrailPosition({ lat: -90, lon: 180 })).toEqual({
			lat: -90,
			lon: 180,
			altM: null,
		})
		expect(parseTrailPosition({ lat: 0, lon: 1, altM: "x" })).toEqual({
			lat: 0,
			lon: 1,
			altM: null,
		})
	})

	it("rejects missing, malformed, non-object, string, non-finite, out of range and (0, 0)", () => {
		for (const bad of [
			null,
			undefined,
			"{oops",
			"[1,2]",
			"42",
			{ lat: "48", lon: 2 },
			{ lat: 1 },
			{ lat: Number.NaN, lon: 2 },
			{ lat: Number.POSITIVE_INFINITY, lon: 2 },
			{ lat: 90.0001, lon: 2 },
			{ lat: 1, lon: -180.5 },
			{ lat: 0, lon: 0 },
			'{"lat":1e999,"lon":2}',
		]) {
			expect(parseTrailPosition(bad)).toBeNull()
		}
	})
})

describe("acceptTrailRows", () => {
	const row = (
		seq: number,
		ms: number,
		key: string,
		position: unknown = { lat: 1, lon: 1 },
	): TrailRow => ({
		seq,
		producedAtMs: ms,
		entityKey: key,
		category: "aircraft",
		protocol: "adsb",
		position,
	})

	it("defaults come from the frozen constants", () => {
		expect(DEFAULT_TRAILS_READ_LIMITS).toEqual({
			maxPoints: 20_000,
			maxEntities: 2_000,
			maxPointsPerEntity: 1_440,
			scanRows: 200_000,
		})
	})

	it("orders trails by newest point then key, points ascending, newest category", () => {
		const result = acceptTrailRows(
			[
				row(5, 50, "b"),
				{ ...row(4, 50, "a"), category: "marine", protocol: null },
				row(3, 40, "a"),
				row(2, 30, "c"),
				row(1, 20, "b", "{bad"),
			],
			DEFAULT_TRAILS_READ_LIMITS,
		)
		expect(result.trails.map(trail => trail.entityKey)).toEqual(["a", "b", "c"])
		expect(result.trails[0]?.points.map(point => point[0])).toEqual([40, 50])
		expect(result.trails[0]?.category).toBe("marine")
		expect(result.trails[0]?.protocol).toBeNull()
		expect(result.skippedRows).toBe(1)
		expect(result.scannedRows).toBe(5)
		expect(result.truncated).toBe(false)
	})

	it("each bound at the bound is not truncated, one past is", () => {
		const rows = [row(3, 3, "a"), row(2, 2, "a"), row(1, 1, "b")]
		const exact = {
			maxPoints: 3,
			maxEntities: 2,
			maxPointsPerEntity: 2,
			scanRows: 3,
		}
		expect(acceptTrailRows(rows, exact).truncation).toEqual([])
		expect(
			acceptTrailRows(rows, { ...exact, maxPoints: 2 }).truncation,
		).toEqual(["points"])
		expect(
			acceptTrailRows(rows, { ...exact, maxEntities: 1 }).truncation,
		).toEqual(["entities"])
		const perEntity = acceptTrailRows(rows, { ...exact, maxPointsPerEntity: 1 })
		expect(perEntity.truncation).toEqual(["per-entity"])
		expect(
			perEntity.trails.find(trail => trail.entityKey === "a")?.truncated,
		).toBe(true)
		const scan = acceptTrailRows(rows, { ...exact, scanRows: 2 })
		expect(scan.truncation).toEqual(["scan-rows"])
		expect(scan.scannedRows).toBe(2)
	})

	it("invalid rows count toward the scan cap", () => {
		const result = acceptTrailRows(
			[row(3, 3, "a", null), row(2, 2, "a"), row(1, 1, "a")],
			{ ...DEFAULT_TRAILS_READ_LIMITS, scanRows: 2 },
		)
		expect(result.scannedRows).toBe(2)
		expect(result.skippedRows).toBe(1)
		expect(result.pointCount).toBe(1)
		expect(result.truncation).toEqual(["scan-rows"])
	})

	// Feature: web-gaps-4, Property 1: Trails model
	// Validates: Requirements 1.1, 1.3, 1.4, 1.5
	it("matches the naive model", () => {
		fc.assert(
			fc.property(
				fc.array(rawRowArb, { maxLength: 60 }),
				limitsArb,
				(raw, limits) => {
					const rows = toScanOrder(raw)
					const result = acceptTrailRows(rows, limits)
					expect(strip(result)).toEqual(model(rows, limits))
					expect(result.pointCount).toBeLessThanOrEqual(limits.maxPoints)
					expect(result.trails.length).toBeLessThanOrEqual(limits.maxEntities)
					for (const trail of result.trails) {
						expect(trail.points.length).toBeLessThanOrEqual(
							limits.maxPointsPerEntity,
						)
						for (let index = 1; index < trail.points.length; index += 1) {
							expect(trail.points[index]?.[0]).toBeGreaterThanOrEqual(
								trail.points[index - 1]?.[0] ?? 0,
							)
						}
					}
					expect(result.truncated).toBe(result.truncation.length > 0)
				},
			),
			{ numRuns: 300 },
		)
	})

	it("scan-rows stop marks a trail that lost older points", () => {
		const result = acceptTrailRows(
			[row(3, 3, "A"), row(2, 2, "A"), row(1, 1, "A")],
			{ ...DEFAULT_TRAILS_READ_LIMITS, scanRows: 2 },
		)
		expect(result.truncation).toEqual(["scan-rows"])
		expect(result.trails[0]?.truncated).toBe(true)
	})

	it("points stop marks every trail that lost older points", () => {
		const result = acceptTrailRows(
			[row(4, 4, "A"), row(3, 3, "B"), row(2, 2, "B"), row(1, 1, "A")],
			{ ...DEFAULT_TRAILS_READ_LIMITS, maxPoints: 2 },
		)
		expect(result.truncation).toEqual(["points"])
		expect(
			result.trails.map(trail => [trail.entityKey, trail.truncated]),
		).toEqual([
			["A", true],
			["B", true],
		])
	})

	it("an early stop does not mark a trail with nothing older", () => {
		const result = acceptTrailRows(
			[row(3, 3, "A"), row(2, 2, "B"), row(1, 1, "B", null), row(0, 0, "B")],
			{ ...DEFAULT_TRAILS_READ_LIMITS, scanRows: 2 },
		)
		expect(result.truncation).toEqual(["scan-rows"])
		expect(
			result.trails.map(trail => [trail.entityKey, trail.truncated]),
		).toEqual([
			["A", false],
			["B", true],
		])
	})

	// Feature: web-gaps-4, Property 2: Trails truncation keeps the newest
	// Validates: Requirements 1.4
	// Greedy newest-first admission (design "Bulk trails"): rows are taken in
	// (produced_at_ms, seq) DESC order and a bound refuses the row that hits it.
	// Checked: for a returned entity, every refused point of it is older in scan
	// order than all of its accepted points; for a refused (unreturned) entity,
	// its newest refused point is not newer than any returned trail's newest
	// point; and points / scan-rows stops keep only rows before the stop.
	it("greedy admission: per entity newest first; a refused entity is not newer than any returned trail", () => {
		fc.assert(
			fc.property(
				fc.array(rawRowArb, { maxLength: 60 }),
				limitsArb,
				(raw, limits) => {
					// Tag each row: lat = index + 1 (unique, never 0), so a point names its row.
					const rows = toScanOrder(raw).map((row, index) => ({
						...row,
						position:
							parseTrailPosition(row.position) === null
								? row.position
								: { lat: (index + 1) / 100, lon: 1 },
					}))
					const result = acceptTrailRows(rows, limits)
					const accepted = new Set<number>()
					const newestOf = new Map<string, number>()
					for (const trail of result.trails) {
						for (const point of trail.points)
							accepted.add(Math.round(point[1] * 100) - 1)
						newestOf.set(
							trail.entityKey,
							Math.round(
								(trail.points[trail.points.length - 1]?.[1] ?? 0) * 100,
							) - 1,
						)
					}
					for (let index = 0; index < result.scannedRows; index += 1) {
						const row = rows[index]
						if (
							!row ||
							accepted.has(index) ||
							parseTrailPosition(row.position) === null
						)
							continue
						if (newestOf.has(row.entityKey)) {
							// per-entity or points: every accepted point of the entity is newer.
							for (const other of accepted) {
								if (rows[other]?.entityKey !== row.entityKey) continue
								expect(other).toBeLessThan(index)
							}
						} else {
							// entities or points: every returned trail started (newest point) before it.
							for (const newest of newestOf.values()) {
								expect(newest).toBeLessThan(index)
								expect(rows[newest]?.producedAtMs ?? 0).toBeGreaterThanOrEqual(
									row.producedAtMs,
								)
							}
						}
					}
					if (result.truncation.includes("points")) {
						for (const other of accepted)
							expect(other).toBeLessThan(result.scannedRows - 1)
					}
					if (result.truncation.includes("scan-rows")) {
						for (const other of accepted)
							expect(other).toBeLessThan(limits.scanRows)
					}
				},
			),
			{ numRuns: 300 },
		)
	})
})

// ---------- real store ----------

describe("readTrails against a store", () => {
	let dir = ""
	let writer: DatabaseSync
	let reader: SqlDatabase
	let seq = 0

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "wavekit-trails-"))
		const path = join(dir, "activity.db")
		writer = new DatabaseSync(path)
		writer.exec("PRAGMA journal_mode = WAL")
		writer.exec(ACTIVITY_SCHEMA_V1)
		const meta = writer.prepare(
			"INSERT INTO store_meta(key, value) VALUES (?, ?)",
		)
		meta.run("schemaVersion", "1")
		meta.run("storeUuid", randomUUID())
		meta.run("restoreGeneration", "1")
		meta.run("pruneWatermark", "0")
		reader = await openReadOnly(path)
	})

	afterAll(async () => {
		reader.close()
		writer.close()
		await rm(dir, { recursive: true, force: true })
	})

	function reset(): void {
		writer.exec("DELETE FROM activity")
	}

	const insertSql = `INSERT INTO activity (event_id, kind, produced_at_ms, received_at_ms, source_id, decoder_id,
		protocol, category, frequency_hz, entity_key, summary_json, record_json, record_bytes)
		VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, '{}', 2)`

	function insert(row: RawRow & { kind?: string; rawSummary?: string }): void {
		seq += 1
		const summary =
			row.rawSummary ??
			(row.position === null
				? JSON.stringify({ eventId: `e${seq}` })
				: `{"eventId":"e${seq}","position":${typeof row.position === "string" ? row.position : JSON.stringify(row.position)}}`)
		writer
			.prepare(insertSql)
			.run(
				`e${seq}`,
				row.kind ?? "decoder-reception",
				row.producedAtMs,
				row.producedAtMs,
				row.protocol,
				row.category,
				row.entityKey,
				summary,
			)
	}

	function read(input: Partial<TrailsReadInput> = {}): ActivityTrails {
		const result = runRead(reader, {
			op: "trails",
			input: {
				producedFromMs: NOW - 1_000,
				producedToMs: NOW,
				limits: DEFAULT_TRAILS_READ_LIMITS,
				nowMs: NOW,
				...input,
			},
		})
		if (result.op !== "trails") throw new TypeError("wrong op")
		return result.trails
	}

	it("stops at the wall budget with the newest rows and an exact per-trail flag", () => {
		reset()
		const at = (offset: number, entityKey: string) =>
			insert({
				producedAtMs: NOW - offset,
				entityKey,
				category: "aircraft",
				protocol: "adsb",
				position: { lat: 10, lon: 20 },
			})
		at(100, "A")
		at(200, "B")
		at(300, "A")
		at(400, "C")
		at(500, "A")
		// One tick per clock call. Start 0; step 1 is two pieces (rows 1, 2): the second
		// piece reads 1, row 2 reads 2. Step 2 reads 3, its pieces (rows 3, 4) read 4 and 6,
		// rows 3 and 4 read 5 and 7. The walk budget is 100 - 93 = 7, so it stops before
		// row 4; the probe then runs well inside the 100 total and keeps the flags exact.
		let ticks = 0
		const result = read({
			chunkRows: 2,
			wallBudgetMs: 100,
			probeReserveMs: 93,
			clock: () => ticks++,
		})
		expect(result.truncated).toBe(true)
		expect(result.truncation).toEqual(["time-limit"])
		expect(result.scannedRows).toBe(3)
		expect(
			result.trails.map(t => [
				t.entityKey,
				t.points.map(p => p[0]),
				t.truncated,
			]),
		).toEqual([
			["A", [NOW - 300, NOW - 100], true],
			["B", [NOW - 200], false],
		])
		// A budget that is never reached reads the whole window untruncated.
		const full = read({ chunkRows: 2, wallBudgetMs: 1e9 })
		expect(full.truncation).toEqual([])
		expect(full.scannedRows).toBe(5)
	})

	it("a probe that runs out of the shared budget marks the open trails truncated", () => {
		reset()
		const at = (offset: number, entityKey: string) =>
			insert({
				producedAtMs: NOW - offset,
				entityKey,
				category: "aircraft",
				protocol: "adsb",
				position: { lat: 10, lon: 20 },
			})
		at(100, "A")
		at(200, "B")
		at(300, "A")
		at(400, "C")
		at(500, "A")
		// Walk budget 8 - 1 = 7 stops before row 4 (tick 7, as above); the probe checks the
		// held row 4 (C, not returned) then reads tick 8 >= 8 before its first step, so A
		// and B are never probed and both trails are conservative.
		let ticks = 0
		const result = read({
			chunkRows: 2,
			wallBudgetMs: 8,
			probeReserveMs: 1,
			clock: () => ticks++,
		})
		expect(result.truncation).toEqual(["time-limit"])
		expect(result.scannedRows).toBe(3)
		expect(result.trails.map(t => [t.entityKey, t.truncated])).toEqual([
			["A", true],
			["B", true],
		])
	})

	it("the probe after a points stop is bounded per chunk by the same budget", () => {
		reset()
		const at = (offset: number, entityKey: string) =>
			insert({
				producedAtMs: NOW - offset,
				entityKey,
				category: "aircraft",
				protocol: "adsb",
				position: { lat: 10, lon: 20 },
			})
		at(100, "A")
		at(200, "B")
		at(300, "C")
		for (let i = 0; i < 6; i += 1) at(400 + i, "X")
		at(900, "B")
		const limits = { ...DEFAULT_TRAILS_READ_LIMITS, maxPoints: 2 }
		const flags = (result: ActivityTrails) =>
			result.trails.map(t => [t.entityKey, t.truncated])
		// Ample budget: the probe walks past the six X rows and finds B's older point.
		const exact = read({ limits, chunkRows: 2 })
		expect(exact.truncation).toEqual(["points"])
		expect(flags(exact)).toEqual([
			["A", false],
			["B", true],
		])
		// Clock calls: walk start (1), the second piece and row B of step 1 (2, 3), step 2
		// and its first piece (4, 5), row C (6, refused: points). The probe's step (7)
		// and its first piece (8, the X run) are in budget, its next step (9) is past it.
		let calls = 0
		const clock = () => (++calls >= 9 ? 1e6 : 0)
		const cut = read({ limits, chunkRows: 2, clock })
		expect(calls).toBe(9)
		expect(cut.truncation).toEqual(["points", "time-limit"])
		expect(flags(cut)).toEqual([
			["A", true],
			["B", true],
		])
	})

	/** Wraps the reader so chosen statement calls block for `delay(sql, call)` ms. */
	function delayed(delay: (sql: string, call: number) => number): SqlDatabase {
		const cell = new Int32Array(new SharedArrayBuffer(4))
		return {
			prepare(sql) {
				const statement = reader.prepare(sql)
				let call = 0
				const wait = () => {
					call += 1
					const ms = delay(sql, call)
					if (ms > 0) Atomics.wait(cell, 0, 0, ms)
				}
				return {
					all: (...params) => (wait(), statement.all(...params)),
					get: (...params) => (wait(), statement.get(...params)),
				}
			},
			exec: sql => reader.exec(sql),
			close: () => undefined,
		}
	}

	function timedRead(
		db: SqlDatabase,
		input: Partial<TrailsReadInput>,
	): { ms: number; result: ActivityTrails } {
		const started = performance.now()
		const result = runRead(db, {
			op: "trails",
			input: {
				producedFromMs: NOW - 10_000,
				producedToMs: NOW,
				limits: DEFAULT_TRAILS_READ_LIMITS,
				nowMs: NOW,
				...input,
			},
		})
		if (result.op !== "trails") throw new TypeError("wrong op")
		return { ms: performance.now() - started, result: result.trails }
	}

	function fill(rows: number, keyOf: (index: number) => string): void {
		writer.exec("BEGIN")
		for (let index = 0; index < rows; index += 1) {
			insert({
				producedAtMs: NOW - 1 - index,
				entityKey: keyOf(index),
				category: "marine",
				protocol: "ais",
				position: { lat: 10, lon: 20 },
			})
		}
		writer.exec("COMMIT")
	}

	it("real clock: a slow walk fetch stops at the default budget with no probe overrun", () => {
		reset()
		fill(101, index => `mmsi:${index}`)
		// The second walk chunk (first keyset continuation) takes 610 ms; every probe
		// chunk would take 5 ms.
		const db = delayed((sql, call) => {
			if (sql.includes("json_each")) return 5
			const scan = sql.includes("json_extract") && !sql.includes("OFFSET")
			return scan && call === 2 ? 610 : 0
		})
		const { ms, result } = timedRead(db, { chunkRows: 100 })
		expect(result.truncation).toEqual(["time-limit"])
		expect(result.scannedRows).toBe(100)
		// The held row 101 was the window's last: the probe has nothing left to read, so
		// the flags stay exact without another statement.
		expect(result.trails.some(trail => trail.truncated)).toBe(false)
		expect(ms).toBeLessThan(650)
	})

	it("real clock: a slow probe stops at the shared budget", () => {
		reset()
		// A and B are returned (maxPoints 2), C is refused, then 400 rows of X follow:
		// the probe never resolves A or B and needs many chunks of 4 rows, 20 ms each.
		insert({
			producedAtMs: NOW - 1,
			entityKey: "A",
			category: "aircraft",
			protocol: "adsb",
			position: { lat: 1, lon: 1 },
		})
		insert({
			producedAtMs: NOW - 2,
			entityKey: "B",
			category: "aircraft",
			protocol: "adsb",
			position: { lat: 1, lon: 1 },
		})
		writer.exec("BEGIN")
		for (let index = 0; index < 400; index += 1) {
			insert({
				producedAtMs: NOW - 3 - index,
				entityKey: index === 0 ? "C" : "X",
				category: "aircraft",
				protocol: "adsb",
				position: { lat: 1, lon: 1 },
			})
		}
		writer.exec("COMMIT")
		const db = delayed(sql => (sql.includes("json_each") ? 20 : 0))
		const { ms, result } = timedRead(db, {
			chunkRows: 4,
			limits: { ...DEFAULT_TRAILS_READ_LIMITS, maxPoints: 2 },
			wallBudgetMs: 200,
			probeReserveMs: 50,
		})
		expect(result.truncation).toEqual(["points", "time-limit"])
		expect(result.trails.map(t => [t.entityKey, t.truncated])).toEqual([
			["A", true],
			["B", true],
		])
		// One probe chunk past the budget at most.
		expect(ms).toBeGreaterThanOrEqual(200)
		expect(ms).toBeLessThan(260)
	})

	it("a selective filter is walked in bounded steps over the non-matching rows", () => {
		reset()
		writer.exec("BEGIN")
		for (let index = 0; index < 2_000; index += 1) {
			insert({
				producedAtMs: NOW - 1 - index,
				entityKey: `icao:${index % 50}`,
				category: "aircraft",
				protocol: "adsb",
				position: { lat: 1, lon: 1 },
			})
		}
		for (let index = 0; index < 5; index += 1) {
			insert({
				producedAtMs: NOW - 3_000 - index,
				entityKey: "mmsi:1",
				category: "marine",
				protocol: "ais",
				position: { lat: 1, lon: 1 },
			})
		}
		writer.exec("COMMIT")
		let statements = 0
		const counting: SqlDatabase = {
			prepare(sql) {
				const statement = reader.prepare(sql)
				return {
					all: (...values) => (statements++, statement.all(...values)),
					get: (...values) => (statements++, statement.get(...values)),
				}
			},
			exec: sql => reader.exec(sql),
			close: () => undefined,
		}
		const run = (input: Partial<TrailsReadInput>): ActivityTrails => {
			const result = runRead(counting, {
				op: "trails",
				input: {
					producedFromMs: NOW - 10_000,
					producedToMs: NOW,
					protocols: ["ais"],
					limits: DEFAULT_TRAILS_READ_LIMITS,
					nowMs: NOW,
					chunkRows: 100,
					...input,
				},
			})
			if (result.op !== "trails") throw new TypeError("wrong op")
			return result.trails
		}
		const full = run({})
		expect(full.truncation).toEqual([])
		expect(full.scannedRows).toBe(5)
		expect(full.trails[0]?.points).toHaveLength(5)
		// 2 005 index rows in steps of 100: 20 steps of four statements (tie end, range
		// end, a range piece, the end's run), the last step three, the snapshot meta
		// read and the floor.
		expect(statements).toBe(85)
		// One clock tick per statement: the walk (budget 10) stops between statements
		// although none of the examined rows matched, instead of one unbounded statement.
		statements = 0
		const cut = run({
			clock: () => statements,
			wallBudgetMs: 12,
			probeReserveMs: 2,
		})
		expect(cut.truncation).toEqual(["time-limit"])
		expect(cut.scannedRows).toBe(0)
		expect(cut.trails).toEqual([])
		// Meta, five steps (10 statements, 500 index rows) and the floor.
		expect(statements).toBe(12)
	})

	it("every trails statement seeks activity_produced on both bounds (EXPLAIN QUERY PLAN)", () => {
		reset()
		insert({
			producedAtMs: NOW - 1,
			entityKey: "A",
			category: "aircraft",
			protocol: "adsb",
			position: { lat: 1, lon: 1 },
		})
		insert({
			producedAtMs: NOW - 2,
			entityKey: "B",
			category: "aircraft",
			protocol: "adsb",
			position: { lat: 1, lon: 1 },
		})
		insert({
			producedAtMs: NOW - 3,
			entityKey: "A",
			category: "aircraft",
			protocol: "adsb",
			position: { lat: 1, lon: 1 },
		})
		const seen = new Set<string>()
		const recording: SqlDatabase = {
			prepare(sql) {
				seen.add(sql)
				return reader.prepare(sql)
			},
			exec: sql => reader.exec(sql),
			close: () => undefined,
		}
		// A points stop so the probe statements are prepared too.
		runRead(recording, {
			op: "trails",
			input: {
				producedFromMs: NOW - 1_000,
				producedToMs: NOW,
				protocols: ["adsb"],
				limits: { ...DEFAULT_TRAILS_READ_LIMITS, maxPoints: 1 },
				chunkRows: 1,
			},
		})
		const plans = [...seen]
			.filter(sql => sql.includes("activity_produced"))
			.map(sql => {
				const count = (sql.match(/\?/g) ?? []).length
				const rows = reader
					.prepare(`EXPLAIN QUERY PLAN ${sql}`)
					.all(...Array<number>(count).fill(1))
				return rows
					.map(row => String(row["detail"]))
					.filter(detail => detail.includes("activity_produced"))
			})
		expect(plans).toHaveLength(6)
		for (const details of plans) {
			expect(details).toHaveLength(1)
			expect(details[0]).toMatch(
				/^SEARCH activity USING (COVERING )?INDEX activity_produced \((produced_at_ms=\? AND rowid>\? AND rowid<\?|produced_at_ms>\? AND produced_at_ms<\?|produced_at_ms=\? AND rowid<\?)\)$/,
			)
		}
		if (process.env["WAVEKIT_TRAILS_EQP"] === "1")
			process.stderr.write(`TRAILS_EQP ${JSON.stringify(plans)}\n`)
	})

	it("a deadline crossed while finding a step end stops before its rows, cursor unchanged", () => {
		reset()
		const at = (offset: number, entityKey: string) =>
			insert({
				producedAtMs: NOW - offset,
				entityKey,
				category: "aircraft",
				protocol: "adsb",
				position: { lat: 10, lon: 20 },
			})
		at(100, "A")
		at(200, "B")
		at(300, "A")
		at(400, "C")
		let ends = 0
		let late = false
		const boundary: SqlDatabase = {
			prepare(sql) {
				const statement = reader.prepare(sql)
				const mark = () => {
					if (sql.includes("OFFSET") && ++ends === 2) late = true
				}
				return {
					all: (...values) => (mark(), statement.all(...values)),
					get: (...values) => (mark(), statement.get(...values)),
				}
			},
			exec: sql => reader.exec(sql),
			close: () => undefined,
		}
		const out = runRead(boundary, {
			op: "trails",
			input: {
				producedFromMs: NOW - 1_000,
				producedToMs: NOW,
				limits: DEFAULT_TRAILS_READ_LIMITS,
				nowMs: NOW,
				chunkRows: 2,
				wallBudgetMs: 100,
				probeReserveMs: 95,
				// Past the walk budget (5) from step 2's end on, inside the probe's (100).
				clock: () => (late ? 5 : 0),
			},
		})
		if (out.op !== "trails") throw new TypeError("wrong op")
		expect(out.trails.truncation).toEqual(["time-limit"])
		expect(out.trails.scannedRows).toBe(2)
		// The probe resumes at the unread step and finds A's older point: exact flags.
		expect(out.trails.trails.map(t => [t.entityKey, t.truncated])).toEqual([
			["A", true],
			["B", false],
		])
	})

	it("a run of 100 000 equal timestamps is walked in bounded statements", () => {
		reset()
		writer.exec("BEGIN")
		for (let index = 0; index < 100_000; index += 1) {
			insert({
				producedAtMs: NOW - 5,
				entityKey: `icao:${index % 10}`,
				category: "aircraft",
				protocol: "adsb",
				position: { lat: 1, lon: 1 },
			})
		}
		writer.exec("COMMIT")
		let statements = 0
		let slowest = 0
		const timing: SqlDatabase = {
			prepare(sql) {
				const statement = reader.prepare(sql)
				const timed = <T>(run: () => T): T => {
					statements += 1
					const started = performance.now()
					try {
						return run()
					} finally {
						slowest = Math.max(slowest, performance.now() - started)
					}
				}
				return {
					all: (...values) => timed(() => statement.all(...values)),
					get: (...values) => timed(() => statement.get(...values)),
				}
			},
			exec: sql => reader.exec(sql),
			close: () => undefined,
		}
		const { result } = (() => {
			const out = runRead(timing, {
				op: "trails",
				input: {
					producedFromMs: NOW - 1_000,
					producedToMs: NOW,
					limits: DEFAULT_TRAILS_READ_LIMITS,
					chunkRows: 4,
					wallBudgetMs: 200,
					probeReserveMs: 50,
				},
			})
			if (out.op !== "trails") throw new TypeError("wrong op")
			return { result: out.trails }
		})()
		expect(result.truncation).toContain("time-limit")
		// A statement re-examining the whole run would take milliseconds each (100 000
		// index rows) and reach only a few dozen statements in the budget.
		expect(statements).toBeGreaterThan(2_000)
		if (process.env["WAVEKIT_TRAILS_EQP"] === "1")
			process.stderr.write(`TRAILS_TIES ${statements} ${slowest}\n`)
	}, 60_000)

	it("empty store returns no trails and a null floor; from == to allowed", () => {
		reset()
		const result = read({ producedFromMs: NOW, producedToMs: NOW })
		expect(result).toEqual({
			producedFrom: new Date(NOW).toISOString(),
			producedTo: new Date(NOW).toISOString(),
			trails: [],
			pointCount: 0,
			scannedRows: 0,
			skippedRows: 0,
			truncated: false,
			truncation: [],
			retentionFloor: null,
			generatedAt: new Date(NOW).toISOString(),
		})
	})

	it("filters window, kind, null entity, category, protocol and entity keys; skips bad positions", () => {
		reset()
		const base = { category: "aircraft" as ActivityCategory, protocol: "adsb" }
		insert({
			...base,
			producedAtMs: NOW - 5_000,
			entityKey: "old",
			position: { lat: 1, lon: 1 },
		})
		insert({
			...base,
			producedAtMs: NOW - 10,
			entityKey: "a",
			position: { lat: 1, lon: 2, altM: 300 },
		})
		insert({
			...base,
			producedAtMs: NOW - 5,
			entityKey: "a",
			position: { lat: 1.5, lon: 2.5 },
		})
		insert({
			...base,
			producedAtMs: NOW - 4,
			entityKey: "a",
			position: null,
			kind: "ingestion-gap",
		})
		insert({
			...base,
			producedAtMs: NOW - 3,
			entityKey: "b",
			position: "{not json",
		})
		insert({
			...base,
			producedAtMs: NOW - 2,
			entityKey: "b",
			position: '"text"',
		})
		insert({
			...base,
			producedAtMs: NOW - 2,
			entityKey: "b",
			position: '{"lat":"1","lon":2}',
		})
		insert({
			...base,
			producedAtMs: NOW - 1,
			entityKey: "b",
			position: null,
			rawSummary: "{corrupt",
		})
		insert({
			category: "marine",
			protocol: "ais",
			producedAtMs: NOW,
			entityKey: "v",
			position: { lat: 3, lon: 4 },
		})
		const all = read()
		expect(all.trails.map(trail => trail.entityKey)).toEqual(["v", "a"])
		expect(all.trails[1]?.points).toEqual([
			[NOW - 10, 1, 2, 300],
			[NOW - 5, 1.5, 2.5, null],
		])
		expect(all.skippedRows).toBe(4)
		expect(all.scannedRows).toBe(7)
		expect(all.retentionFloor).toBe(new Date(NOW - 5_000).toISOString())
		expect(
			read({ categories: ["marine"] }).trails.map(trail => trail.entityKey),
		).toEqual(["v"])
		expect(
			read({ protocols: ["adsb"] }).trails.map(trail => trail.entityKey),
		).toEqual(["a"])
		expect(
			read({ entityKeys: ["a", "zz"] }).trails.map(trail => trail.entityKey),
		).toEqual(["a"])
		expect(
			read({ producedFromMs: NOW - 6, producedToMs: NOW - 5 }).pointCount,
		).toBe(1)
	})

	it("early stops mark trails with an older in-window valid row (probe)", () => {
		const at = (
			ms: number,
			key: string,
			position: unknown = { lat: 1, lon: 1 },
		) =>
			insert({
				producedAtMs: NOW - 10 + ms,
				entityKey: key,
				category: "aircraft",
				protocol: "adsb",
				position,
			})
		const flags = (result: ActivityTrails) =>
			result.trails.map(trail => [trail.entityKey, trail.truncated])
		reset()
		at(3, "A")
		at(2, "A")
		at(1, "A")
		const limits = DEFAULT_TRAILS_READ_LIMITS
		const scan = read({ limits: { ...limits, scanRows: 2 } })
		expect(scan.truncation).toEqual(["scan-rows"])
		expect(flags(scan)).toEqual([["A", true]])
		// The older row outside the window is not a lost point.
		expect(
			flags(
				read({ producedFromMs: NOW - 8, limits: { ...limits, scanRows: 2 } }),
			),
		).toEqual([["A", false]])
		reset()
		at(4, "A")
		at(3, "B")
		at(2, "B")
		at(1, "A")
		at(0, "B", { lat: 0, lon: 0 })
		const points = read({ limits: { ...limits, maxPoints: 2 }, chunkRows: 1 })
		expect(points.truncation).toEqual(["points"])
		expect(flags(points)).toEqual([
			["A", true],
			["B", true],
		])
		// Only an invalid position is older: not a lost point.
		reset()
		at(4, "A")
		at(3, "B")
		at(2, "B", '{"lat":1e999,"lon":2}')
		at(1, "B", { lat: 91, lon: 2 })
		at(0, "A", null)
		const invalid = read({ limits: { ...limits, scanRows: 2 } })
		expect(invalid.truncation).toEqual(["scan-rows"])
		expect(flags(invalid)).toEqual([
			["A", false],
			["B", false],
		])
	})

	// Feature: web-gaps-4, Property 1: Trails model
	// Validates: Requirements 1.1, 1.3, 1.4, 1.5
	it("matches the naive model on a real store", () => {
		fc.assert(
			fc.property(
				fc.array(rawRowArb, { maxLength: 25 }),
				limitsArb,
				fc.integer({ min: NOW - 20, max: NOW }),
				fc.integer({ min: 0, max: 20 }),
				fc.integer({ min: 1, max: 8 }),
				(raw, limits, from, span, chunk) => {
					reset()
					const start = seq
					for (const row of raw) insert(row)
					const to = Math.min(NOW, from + span)
					const inWindow = raw
						.map((row, index) => ({ ...row, seq: start + index + 1 }))
						.filter(row => row.producedAtMs >= from && row.producedAtMs <= to)
						.sort((a, b) => b.producedAtMs - a.producedAtMs || b.seq - a.seq)
					const result = read({
						producedFromMs: from,
						producedToMs: to,
						limits,
						chunkRows: chunk,
					})
					expect(strip(result)).toEqual(model(inWindow, limits))
				},
			),
			{ numRuns: 100 },
		)
		// About 1 s idle; headroom for a loaded shared machine.
	}, 20_000)
})
