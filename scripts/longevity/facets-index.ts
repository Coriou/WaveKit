/**
 * Longevity: the facets covering index on a cap-size synthetic store (measure only, not CI).
 * Builds a v1 store of --rows rows (default 250 000, the row cap) in a temporary directory with
 * row sizes like live (record JSON about 1 KB, summary about 300 B; no FTS or refs rows, which the
 * facets read never touches), then reports:
 *   - the facets read (the web's category-only request and all five dimensions, scan cap 50 000)
 *     through runRead on a fresh read-only connection per read, as the query worker does: first
 *     run and median of five, before and after the index;
 *   - the migration (ensureFacetsIndex, the writer worker's post-open step): wall time, file and
 *     WAL bytes added;
 *   - EXPLAIN QUERY PLAN of the writer and reader statements that could pick the new index, after.
 * Every number comes with the load average around it. The directory is deleted at the end
 * unless --keep is given.
 *
 *   pnpm exec esbuild scripts/longevity/facets-index.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=output/longevity/facets-index.mjs
 *   node output/longevity/facets-index.mjs [--rows 250000] [--keep]
 */
import { randomBytes, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"
import {
	runRead,
	type ReadRequest,
} from "../../src/core/activity/query/read.js"
import { withReadOnly } from "../../src/core/activity/query/sqlite.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../src/core/activity/query/service.js"
import {
	normaliseQuery,
	type FacetDimension,
} from "../../src/core/activity/query/validate.js"
import {
	ACTIVITY_SCHEMA_V1,
	ACTIVITY_SCHEMA_VERSION,
} from "../../src/core/activity/storage/contract.js"
import {
	applyRuntimePragmas,
	ensureFacetsIndex,
} from "../../src/core/activity/storage/database.js"
import { openSqliteFile } from "../../src/core/activity/storage/probe.js"

const argText = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const rowCount = Number(argText("rows") ?? "250000")
const keep = process.argv.includes("--keep")
const load = (): number[] => os.loadavg().map(x => Number(x.toFixed(2)))

const CATEGORIES = [
	["aircraft", 70],
	["marine", 10],
	["paging", 8],
	["sensors", 6],
	["aprs", 4],
	["voice", 2],
] as const
const PROTOCOLS: Record<string, string[]> = {
	aircraft: ["adsb", "acars", "vdl2"],
	marine: ["ais"],
	paging: ["pocsag", "flex"],
	sensors: ["ism"],
	aprs: ["aprs", "meshtastic"],
	voice: ["dmr", "p25", "ysf"],
}
const pick = <T>(items: readonly T[], i: number): T =>
	items[i % items.length] as T
const categoryOf = (i: number): string => {
	let slot = (i * 7919) % 100
	for (const [name, weight] of CATEGORIES) {
		if (slot < weight) return name
		slot -= weight
	}
	return "aircraft"
}

const dir = await mkdtemp(join(os.tmpdir(), "wavekit-facets-index-"))
const dbPath = join(dir, "activity.db")
const bytes = (path: string): number => {
	try {
		return statSync(path).size
	} catch {
		return 0
	}
}

try {
	const db = await openSqliteFile(dbPath)
	db.exec("PRAGMA auto_vacuum=INCREMENTAL")
	applyRuntimePragmas(db)
	db.exec(ACTIVITY_SCHEMA_V1)
	const meta = db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)")
	for (const [key, value] of [
		["schemaVersion", String(ACTIVITY_SCHEMA_VERSION)],
		["storeUuid", randomUUID()],
		["restoreGeneration", "1"],
		["pruneWatermark", "0"],
		["pruneGeneration", "0"],
		["cursorKey", randomBytes(32).toString("hex")],
		["holeWatermark", "0"],
		["holeGeneration", "0"],
	])
		meta.run(key as string, value as string)
	const insert = db.prepare(
		`INSERT INTO activity (event_id, kind, produced_at_ms, received_at_ms, source_id, decoder_id,
			protocol, category, frequency_hz, entity_key, summary_json, record_json, record_bytes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	const pad = "x".repeat(900)
	const start = Date.parse("2026-10-30T00:00:00.000Z")
	const fill0 = performance.now()
	for (let i = 0; i < rowCount; i += 1) {
		if (i % 10_000 === 0) db.exec("BEGIN")
		const category = categoryOf(i)
		const protocol = pick(PROTOCOLS[category] ?? ["adsb"], i)
		const produced = start + i * 150
		const summary = JSON.stringify({
			title: `${protocol} ${i}`,
			category,
			protocol,
			pad: pad.slice(0, 200),
		})
		const record = JSON.stringify({
			eventId: `e${i}`,
			category,
			protocol,
			payload: pad,
		})
		insert.run(
			`e${i}`,
			i % 50 === 0 ? "ingestion-gap" : "decoder-reception",
			produced,
			produced,
			pick(["rtl-a", "rtl-b"], i),
			`${protocol}-${i % 2}`,
			protocol,
			category,
			100_000_000 + (i % 400) * 25_000,
			`${protocol}:${i % 3_000}`,
			summary,
			record,
			Buffer.byteLength(record),
		)
		if (i % 10_000 === 9_999 || i === rowCount - 1) db.exec("COMMIT")
	}
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	const fillMs = performance.now() - fill0

	const empty = normaliseQuery({}, DEFAULT_ACTIVITY_QUERY_LIMITS)
	const facets = (dimensions: FacetDimension[]): ReadRequest => ({
		op: "facets",
		query: empty,
		dimensions,
		low: "0",
		high: String(rowCount),
		scanCap: 50_000,
		valueCap: 32,
	})
	/** Wall and process CPU time (CPU is the steadier figure on a loaded host). */
	const timeIt = async (run: () => Promise<unknown>) => {
		const wall: number[] = []
		const cpu: number[] = []
		for (let i = 0; i < 6; i += 1) {
			const t0 = performance.now()
			const c0 = process.cpuUsage()
			await run()
			const c1 = process.cpuUsage(c0)
			wall.push(performance.now() - t0)
			cpu.push((c1.user + c1.system) / 1000)
		}
		const median = (xs: number[]) =>
			Number((xs.slice(1).sort((a, b) => a - b)[2] ?? 0).toFixed(1))
		return {
			firstMs: Number((wall[0] ?? 0).toFixed(1)),
			medianMs: median(wall),
			medianCpuMs: median(cpu),
		}
	}
	const timeRead = (request: ReadRequest) =>
		timeIt(() => withReadOnly(dbPath, reader => runRead(reader, request)))
	/** The previous facets read: every scanned row materialised in JS, then counted. */
	const legacyRead = (dimensions: string[]) =>
		timeIt(() =>
			withReadOnly(dbPath, reader => {
				const rows = reader
					.prepare(
						`SELECT ${dimensions.join(", ")} FROM activity WHERE seq > ? AND seq <= ? ORDER BY seq DESC LIMIT ?`,
					)
					.all(0, rowCount, 50_001)
				const counts = dimensions.map(() => new Map<unknown, number>())
				for (const row of rows.slice(0, 50_000))
					dimensions.forEach((d, i) => {
						const bucket = counts[i]
						bucket?.set(row[d], (bucket.get(row[d]) ?? 0) + 1)
					})
				return counts
			}),
		)
	const FIVE: FacetDimension[] = [
		"category",
		"protocol",
		"decoderId",
		"sourceId",
		"kind",
	]
	const FIVE_COLUMNS = [
		"category",
		"protocol",
		"decoder_id",
		"source_id",
		"kind",
	]
	const reads = async () => ({
		category: await timeRead(facets(["category"])),
		categoryLegacy: await legacyRead(["category"]),
		fiveDimensions: await timeRead(facets(FIVE)),
		fiveDimensionsLegacy: await legacyRead(FIVE_COLUMNS),
	})

	const loadBefore = load()
	const before = await reads()
	const fileBefore = bytes(dbPath)
	const loadMigration = load()
	const build = ensureFacetsIndex(db)
	const walAfterBuild = bytes(`${dbPath}-wal`)
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	const fileAfter = bytes(dbPath)
	const after = await reads()

	const PLANS: Record<string, string> = {
		"facets (category)":
			"WITH scan AS (SELECT seq, category AS category FROM activity WHERE seq > 0 AND seq <= 1e9 ORDER BY seq DESC LIMIT 50001) SELECT category, COUNT(*) AS n, MIN(seq) AS low FROM scan GROUP BY category",
		"facets (time-scoped)":
			"WITH scan AS (SELECT seq, category AS category FROM activity WHERE seq > 0 AND seq <= 1e9 AND produced_at_ms >= 0 ORDER BY seq DESC LIMIT 50001) SELECT category, COUNT(*) AS n, MIN(seq) AS low FROM scan GROUP BY category",
		"search newest page":
			"SELECT seq, event_id, summary_json FROM activity WHERE seq > 0 AND seq <= 1e9 ORDER BY seq DESC LIMIT 101",
		"search category":
			"SELECT seq, event_id, summary_json FROM activity WHERE seq > 0 AND seq <= 1e9 AND category IN ('paging') ORDER BY seq DESC LIMIT 101",
		"search decoder":
			"SELECT seq, event_id, summary_json FROM activity WHERE seq > 0 AND seq <= 1e9 AND decoder_id IN ('ais-0') ORDER BY seq DESC LIMIT 101",
		"writer row count": "SELECT COUNT(*) AS n FROM activity",
		"writer share candidates":
			"SELECT seq, decoder_id, kind, record_bytes FROM activity WHERE decoder_id = 'ais-0' ORDER BY seq ASC LIMIT 500",
		"writer kind share":
			"SELECT received_at_ms FROM activity WHERE kind = 'ingestion-gap' AND decoder_id IS NULL ORDER BY seq ASC LIMIT 1",
		"writer oldest received":
			"SELECT MIN(received_at_ms) AS oldest FROM activity",
		"walk produced count":
			"SELECT COUNT(*) AS n FROM activity WHERE produced_at_ms BETWEEN 0 AND 1e15",
	}
	const plans: Record<string, string> = {}
	for (const [name, sql] of Object.entries(PLANS))
		plans[name] = db
			.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.all()
			.map(row => String(row["detail"]))
			.join(" | ")
	db.close()

	console.log(
		JSON.stringify(
			{
				rows: rowCount,
				fillMs: Math.round(fillMs),
				fileMiB: Number((fileBefore / 2 ** 20).toFixed(1)),
				facetsBefore: { load: loadBefore, ...before },
				migration: {
					load: loadMigration,
					built: build.built,
					ms: Math.round(build.ms),
					indexMiB: Number(((fileAfter - fileBefore) / 2 ** 20).toFixed(2)),
					walMiBAfterBuild: Number((walAfterBuild / 2 ** 20).toFixed(2)),
				},
				facetsAfter: { load: load(), ...after },
				plans,
			},
			null,
			2,
		),
	)
} finally {
	if (!keep) await rm(dir, { recursive: true, force: true })
	else console.log(`kept ${dir}`)
}
