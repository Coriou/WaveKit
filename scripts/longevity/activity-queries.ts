/**
 * Longevity: plans and timings of the hot Activity reads (measure only, not CI). Opens an Activity
 * database read-only and, for each read shape the query worker builds (src/core/activity/query/
 * read.ts and walk.ts) plus the writer's retention seed scan (storage/database.ts), prints the
 * EXPLAIN QUERY PLAN, the first run and the median of five. With `--state-dir`, also times
 * `openActivityStore` (lock, schema check, indexed reads; the seed scan is timed above) on that directory (it must hold a copy, never a live store: the open takes
 * the writer lock and may write).
 *
 *   pnpm exec esbuild scripts/longevity/activity-queries.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/longevity/activity-queries.mjs
 *   node output/longevity/activity-queries.mjs --db <copy>/activity/activity.db [--state-dir <copy>]
 */
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import pino from "pino"
import { openSqliteFile } from "../../src/core/activity/storage/probe.js"
import { openActivityStore } from "../../src/core/activity/storage/store.js"
import type { SqliteValue } from "../../src/core/activity/storage/sqlite.js"

const argText = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const dbPath = argText("db")
if (dbPath === null) throw new RangeError("--db is required")
const stateDir = argText("state-dir")

const db = await openSqliteFile(dbPath, true)
const one = (sql: string): Record<string, SqliteValue> | undefined =>
	db.prepare(sql).get()
const hi = String(one("SELECT max(seq) AS m FROM activity")?.["m"] ?? 0)
const newest = Number(
	one("SELECT max(produced_at_ms) AS m FROM activity")?.["m"] ?? 0,
)

interface Shape {
	name: string
	sql: string
	params: SqliteValue[]
}
const window = ["seq > ?", "seq <= ?"]
const bounds: SqliteValue[] = [0, BigInt(hi)]
const SHAPES: Shape[] = [
	{
		name: "search: newest page, no filter",
		sql: `SELECT seq, event_id, summary_json FROM activity WHERE ${window.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
		params: [...bounds, 101],
	},
	{
		name: "search: category=paging (rare)",
		sql: `SELECT seq, event_id, summary_json FROM activity WHERE ${window.join(" AND ")} AND category IN (?) ORDER BY seq DESC LIMIT ?`,
		params: [...bounds, "paging", 101],
	},
	{
		name: "search: protocol=adsb (common)",
		sql: `SELECT seq, event_id, summary_json FROM activity WHERE ${window.join(" AND ")} AND protocol IN (?) ORDER BY seq DESC LIMIT ?`,
		params: [...bounds, "adsb", 101],
	},
	{
		name: "search: last hour by produced time",
		sql: `SELECT seq, event_id, summary_json FROM activity WHERE ${window.join(" AND ")} AND produced_at_ms >= ? ORDER BY seq DESC LIMIT ?`,
		params: [...bounds, newest - 3_600_000, 101],
	},
	{
		name: "search: one entity",
		sql: `SELECT seq, event_id, summary_json FROM activity WHERE ${window.join(" AND ")} AND entity_key = ? ORDER BY seq DESC LIMIT ?`,
		params: [
			...bounds,
			String(
				one(
					"SELECT entity_key AS k FROM activity WHERE entity_key IS NOT NULL ORDER BY seq DESC LIMIT 1",
				)?.["k"] ?? "none",
			),
			101,
		],
	},
	{
		name: "search: full text",
		sql: `SELECT seq, event_id, summary_json FROM activity WHERE ${window.join(" AND ")} AND seq IN (SELECT rowid FROM activity_fts WHERE activity_fts MATCH ?) ORDER BY seq DESC LIMIT ?`,
		params: [...bounds, '"alpha"', 101],
	},
	{
		name: "facets: 5 dimensions, scan cap 50 000",
		sql: `SELECT category AS category, protocol AS protocol, decoder_id AS decoderId, source_id AS sourceId, kind AS kind FROM activity WHERE ${window.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
		params: [...bounds, 50_001],
	},
	{
		name: "walk: produced range count (timeline/bandmap)",
		sql: "SELECT COUNT(*) AS n FROM activity INDEXED BY activity_produced WHERE produced_at_ms BETWEEN ? AND ?",
		params: [newest - 6 * 3_600_000, newest],
	},
	{
		name: "writer seed: retention groups (NOT INDEXED)",
		sql: `SELECT decoder_id, CASE WHEN decoder_id IS NULL THEN kind END AS k, COUNT(*) AS n, COALESCE(SUM(record_bytes), 0) AS b FROM activity NOT INDEXED GROUP BY decoder_id, k`,
		params: [],
	},
]

const results = []
for (const shape of SHAPES) {
	const plan = db
		.prepare(`EXPLAIN QUERY PLAN ${shape.sql}`)
		.all(...shape.params)
		.map(r => String(r["detail"]))
	const times: number[] = []
	let rows = 0
	for (let i = 0; i < 6; i++) {
		const t0 = performance.now()
		rows = db.prepare(shape.sql).all(...shape.params).length
		times.push(performance.now() - t0)
	}
	const first = times[0] ?? 0
	const warm = times.slice(1).sort((a, b) => a - b)
	results.push({
		name: shape.name,
		plan,
		rows,
		firstMs: Number(first.toFixed(1)),
		medianMs: Number((warm[2] ?? 0).toFixed(1)),
	})
}
const total = Number(one("SELECT count(*) AS n FROM activity")?.["n"] ?? 0)
db.close()

let reopenMs: number | null = null
if (stateDir !== null) {
	const t0 = performance.now()
	const store = await openActivityStore({
		stateDir,
		logger: pino({ level: "silent" }),
		execution: "inline",
	})
	reopenMs = performance.now() - t0
	await store.close()
}

console.log(
	JSON.stringify(
		{
			rows: total,
			results,
			reopenMs: reopenMs === null ? null : Math.round(reopenMs),
			loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
		},
		null,
		1,
	),
)
