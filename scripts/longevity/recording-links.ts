/**
 * Longevity: the recording link backfill on a cap-size synthetic store (measure only, not CI).
 * Builds a v1 store of --rows rows (default 250 000, the row cap) written before recording links
 * (`recordingLinkBackfill` "0"): row sizes like live (record JSON about 1 KB), a share of voice
 * rows (--voice-share, default 0.06) of which a third are dsd-fme `call_end` rows with an absolute
 * `wavFile` (some found late: a call row without it and a `wavFileUpdate` row after), and one
 * `jobId` ref on most rows. Then it opens the store through the real writer worker, bundled next
 * to this harness, while a decoder admits receptions at --rate per second, and reports:
 *   - the migration: open time, then the time until the backfill is done and the links are
 *     loaded (the worker's reset message), links found;
 *   - the main thread meanwhile: event-loop delay (max, p99) and admit-to-commit latency (max,
 *     p99) of the receptions admitted during the backfill;
 *   - the reads after it (first and median of five, a fresh read-only connection each, as the
 *     query worker): the newest page, the newest page with hasRecording true and false, one
 *     recording's rows (refs recordingId), with EXPLAIN QUERY PLAN.
 * Every number comes with the load average around it. The directory is deleted at the end
 * unless --keep is given.
 *
 *   pnpm exec esbuild scripts/longevity/recording-links.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=output/longevity/recording-links.mjs
 *   node output/longevity/recording-links.mjs [--rows 250000] [--rate 50] [--keep]
 */
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { dirname, join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import process from "node:process"
import { Writable } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import pino from "pino"
import {
	runRead,
	type ReadRequest,
} from "../../src/core/activity/query/read.js"
import { withReadOnly } from "../../src/core/activity/query/sqlite.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../src/core/activity/query/service.js"
import { normaliseQuery } from "../../src/core/activity/query/validate.js"
import {
	ACTIVITY_FACETS_INDEX_SQL,
	ACTIVITY_SCHEMA_V1,
	ACTIVITY_SCHEMA_VERSION,
} from "../../src/core/activity/storage/contract.js"
import type { ActivityQuery } from "../../src/core/activity/storage/contract.js"
import { applyRuntimePragmas } from "../../src/core/activity/storage/database.js"
import { openSqliteFile } from "../../src/core/activity/storage/probe.js"
import { buildActivityRow } from "../../src/core/activity/storage/row.js"
import { openActivityStore } from "../../src/core/activity/storage/store.js"
import type { DecodeEnvelope } from "../../src/core/activity/types.js"

const argText = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const rowCount = Number(argText("rows") ?? "250000")
const voiceShare = Number(argText("voice-share") ?? "0.06")
const ratePerSec = Number(argText("rate") ?? "50")
const keep = process.argv.includes("--keep")
/** Baseline: the store is already linked ("done"), so the open runs everything but the backfill. */
const baseline = process.argv.includes("--baseline")
const load = (): number[] => os.loadavg().map(x => Number(x.toFixed(2)))
const round = (x: number): number => Number(x.toFixed(1))
const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const start = Date.parse("2026-10-30T00:00:00.000Z")
const pad = "x".repeat(900)
let expectedLinks = 0
/** The newest call row seeded with its file (its key survives the cap prune of the run). */
let newestLinkedName = ""

function callName(i: number): string {
	const d = new Date(start + i * 150)
	const p = (n: number) => String(n).padStart(2, "0")
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}_${String(i % 100_000).padStart(5, "0")}_DMR_CC_1_GROUP_TGT_9_SRC_${i}.wav`
}

/** A dsd-fme `call_end` envelope as an older core stored it (absolute path, no refs). */
function callEnd(i: number, wav: string | null, late: boolean): DecodeEnvelope {
	const at = new Date(start + i * 150).toISOString()
	return {
		version: 1,
		eventId: `e${i}`,
		producedAt: at,
		receivedAt: at,
		decoderId: "dsd-fme-0",
		decoderType: "dsd-fme",
		outputType: "call_end",
		protocol: "dmr",
		category: "voice",
		entityKey: "talkgroup:9",
		title: `DMR TG 9 from ${i}`,
		fields: [
			{ key: "talkgroup", label: "Talkgroup", value: 9 },
			{ key: "source", label: "Radio", value: i },
			{ key: "duration", label: "Duration", unit: "ms", value: 4200 },
		],
		provenance: { sourceId: "rtl-a", frequency: null },
		decodedData: {
			callId: `call-${late ? i - 1 : i}`,
			protocol: "DMR",
			talkgroup: 9,
			source: i,
			duration: 4200,
			flags: { encrypted: false, ...(late ? { wavFileUpdate: true } : {}) },
			...(wav === null ? {} : { wavFile: `/data/dsd-fme/calls/${wav}` }),
			pad: pad.slice(0, 600),
		},
	}
}

async function seed(dbPath: string): Promise<number> {
	const db = await openSqliteFile(dbPath)
	db.exec("PRAGMA auto_vacuum=INCREMENTAL")
	applyRuntimePragmas(db)
	db.exec(ACTIVITY_SCHEMA_V1)
	db.exec(ACTIVITY_FACETS_INDEX_SQL)
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
		// A store of a core before recording links (open would insert "0" too).
		["recordingLinkBackfill", baseline ? "done" : "0"],
	])
		meta.run(key as string, value as string)
	const insert = db.prepare(
		`INSERT INTO activity (event_id, kind, produced_at_ms, received_at_ms, source_id, decoder_id,
			protocol, category, frequency_hz, entity_key, summary_json, record_json, record_bytes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	const ref = db.prepare(
		"INSERT INTO activity_refs(seq, ref_type, ref_value) VALUES (?, ?, ?)",
	)
	const voiceEvery = Math.max(1, Math.round(1 / voiceShare))
	const started = performance.now()
	for (let i = 0; i < rowCount; i += 1) {
		if (i % 10_000 === 0) db.exec("BEGIN")
		const produced = start + i * 150
		if (i % voiceEvery === 0) {
			// Voice: call_start-like rows, calls with their file, calls whose file came late.
			const kind = (i / voiceEvery) % 6
			const late = kind === 5
			const wav =
				kind === 1 || kind === 3
					? callName(i)
					: late
						? callName(i - voiceEvery)
						: null
			if (wav !== null) expectedLinks += 1
			if (wav !== null && !late) newestLinkedName = wav
			const env = callEnd(i, wav, late)
			if (late)
				env.decodedData = {
					...(env.decodedData as object),
					callId: `call-${i - voiceEvery}`,
				}
			const row = buildActivityRow({
				version: 1,
				eventId: env.eventId,
				commitSeq: "0",
				producedAt: env.producedAt,
				receivedAt: env.receivedAt,
				kind: "decoder-reception",
				payload: env,
			})
			insert.run(
				row.eventId,
				row.kind,
				row.producedAtMs,
				row.receivedAtMs,
				row.sourceId,
				row.decoderId,
				row.protocol,
				row.category,
				row.frequencyHz,
				row.entityKey,
				row.summaryJson,
				row.recordJson,
				row.recordBytes,
			)
		} else {
			const summary = JSON.stringify({
				eventId: `e${i}`,
				kind: "decoder-reception",
				producedAt: new Date(produced).toISOString(),
				receivedAt: new Date(produced).toISOString(),
				decoderId: `adsb-${i % 2}`,
				sourceId: "rtl-a",
				protocol: "adsb",
				category: "aircraft",
				frequencyHz: 1_090_000_000,
				entityKey: `icao:${(i % 3_000).toString(16).padStart(6, "0").toUpperCase()}`,
				title: `adsb ${i}`,
				fields: [],
			})
			const record = JSON.stringify({ eventId: `e${i}`, payload: pad })
			const result = insert.run(
				`e${i}`,
				i % 50 === 0 ? "ingestion-gap" : "decoder-reception",
				produced,
				produced,
				"rtl-a",
				`adsb-${i % 2}`,
				"adsb",
				"aircraft",
				1_090_000_000,
				`adsb:${i % 3_000}`,
				summary,
				record,
				Buffer.byteLength(record),
			)
			if (i % 10 < 7) ref.run(result.lastInsertRowid, "jobId", "job-1")
		}
		if (i % 10_000 === 9_999 || i === rowCount - 1) db.exec("COMMIT")
	}
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	db.close()
	return performance.now() - started
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return (
		sorted[
			Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
		] ?? 0
	)
}

const dir = await mkdtemp(join(os.tmpdir(), "wavekit-recording-links-"))
const stateDir = join(dir, "state")
const activityDir = join(stateDir, "activity")
const bundleDir = await mkdtemp(
	join(repository, "output", ".recording-links-worker-"),
)
try {
	await mkdir(activityDir, { recursive: true })
	const dbPath = join(activityDir, "activity.db")
	const loadFill = load()
	const fillMs = await seed(dbPath)

	const workerFile = join(bundleDir, "activity-writer-worker.mjs")
	await build({
		absWorkingDir: repository,
		entryPoints: ["src/core/activity/storage/activity-writer-worker.ts"],
		outfile: workerFile,
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
	})
	await writeFile(join(bundleDir, "package.json"), '{"type":"module"}\n')

	const loadMigration = load()
	const delay = monitorEventLoopDelay({ resolution: 5 })
	delay.enable()
	const openStarted = performance.now()
	// Done when the store logs the backfill (it follows the worker's full link load).
	let backfilled: (() => void) | null = null
	const done = new Promise<void>(resolve => {
		backfilled = resolve
	})
	let backfillLog: Record<string, unknown> = {}
	const sink = new Writable({
		write(chunk, _encoding, callback) {
			for (const line of String(chunk).split("\n")) {
				if (!line.includes("recording links backfilled")) continue
				backfillLog = JSON.parse(line) as Record<string, unknown>
				backfilled?.()
			}
			callback()
		},
	})
	const store = await openActivityStore({
		stateDir,
		logger: pino({ level: "info" }, sink),
		execution: "thread",
		workerUrl: pathToFileURL(workerFile),
		// The fixture rows sit on 2026-10-30: a store clock there keeps the age prune off them.
		now: () => start + rowCount * 150 + (performance.now() - openStarted),
	})
	const openMs = performance.now() - openStarted
	// Ingest while the backfill runs: one reception every 1000 / rate ms.
	const admittedAt: number[] = []
	let committed = 0
	const latencies: number[] = []
	store.onCommit(() => {
		const total = store.stats().committed
		const at = performance.now()
		while (committed < total && committed < admittedAt.length) {
			latencies.push(at - (admittedAt[committed] ?? at))
			committed += 1
		}
	})
	let n = 0
	const ingest = setInterval(() => {
		const at = new Date(start + rowCount * 150 + n * 20).toISOString()
		const env: DecodeEnvelope = {
			version: 1,
			eventId: randomUUID(),
			producedAt: at,
			receivedAt: at,
			decoderId: "pager-0",
			outputType: "message",
			protocol: "pocsag",
			category: "paging",
			entityKey: `capcode:${n % 500}`,
			title: `POCSAG ${n}`,
			fields: [],
			provenance: { sourceId: "rtl-a", frequency: null },
			decodedData: { capcode: n % 500, message: pad.slice(0, 200) },
		}
		n += 1
		if (store.admit(env).admitted) admittedAt.push(performance.now())
	}, 1000 / ratePerSec)
	// The baseline has no backfill to log: it ingests for --window-ms (default 15 s, about as
	// long as a backfill with ingest at the row cap took).
	const timeout = setTimeout(
		() => backfilled?.(),
		baseline ? Number(argText("window-ms") ?? "15000") : 300_000,
	)
	await done
	clearTimeout(timeout)
	const linked = store.linkedRecordings?.().length ?? 0
	const migrationMs = performance.now() - openStarted
	delay.disable()
	clearInterval(ingest)
	const loadAfterMigration = load()
	// Let the last receptions commit before reading.
	await new Promise(resolve => setTimeout(resolve, 500))
	await store.close()

	const time = async (query: ActivityQuery) => {
		const request: ReadRequest = {
			op: "search",
			query: normaliseQuery(query, DEFAULT_ACTIVITY_QUERY_LIMITS),
			order: "desc",
			limit: 101,
			low: "0",
			high: String(rowCount + 1_000_000),
			before: null,
			after: null,
		}
		const wall: number[] = []
		let items = 0
		for (let i = 0; i < 6; i += 1) {
			const t0 = performance.now()
			const result = await withReadOnly(dbPath, reader =>
				runRead(reader, request),
			)
			wall.push(performance.now() - t0)
			if (result.op === "search") items = result.rows.length
		}
		return {
			firstMs: round(wall[0] ?? 0),
			medianMs: round(percentile(wall.slice(1), 50)),
			rows: items,
		}
	}
	const someKey = `dsd~${newestLinkedName}`
	const loadReads = load()
	const reads = {
		newestPage: await time({}),
		hasRecordingTrue: await time({ hasRecording: true }),
		hasRecordingFalse: await time({ hasRecording: false }),
		voiceWithRecording: await time({
			categories: ["voice"],
			hasRecording: true,
		}),
		oneRecording: await time({
			refs: [{ type: "recordingId", value: someKey }],
		}),
	}
	const plans: Record<string, string> = {}
	const db = await openSqliteFile(dbPath, true)
	for (const [name, sql] of Object.entries({
		hasRecording:
			"SELECT seq, event_id, summary_json FROM activity WHERE seq > 0 AND seq <= 1e9 AND seq IN (SELECT seq FROM activity_refs WHERE ref_type = 'recordingId') ORDER BY seq DESC LIMIT 101",
		oneRecording:
			"SELECT seq, event_id, summary_json FROM activity WHERE seq > 0 AND seq <= 1e9 AND seq IN (SELECT seq FROM activity_refs WHERE ref_type = 'recordingId' AND ref_value = 'x') ORDER BY seq DESC LIMIT 101",
		noRecording:
			"SELECT seq, event_id, summary_json FROM activity WHERE seq > 0 AND seq <= 1e9 AND seq NOT IN (SELECT seq FROM activity_refs WHERE ref_type = 'recordingId') ORDER BY seq DESC LIMIT 101",
		linkCall:
			"SELECT a.seq FROM activity_refs r JOIN activity a ON a.seq = r.seq WHERE r.ref_type = 'callId' AND r.ref_value = 'x' AND a.decoder_id = 'd' AND a.kind = 'decoder-reception'",
		backfillChunk:
			"SELECT seq FROM activity WHERE category = 'voice' AND kind = 'decoder-reception' AND seq > 0 ORDER BY seq LIMIT 2000",
	}))
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
				voiceShare,
				baseline,
				fill: { load: loadFill, ms: Math.round(fillMs) },
				migration: {
					load: loadMigration,
					loadAfter: loadAfterMigration,
					openMs: Math.round(openMs),
					// Baseline: the ingest window instead.
					backfillAndLoadMs: Math.round(migrationMs),
					linksExpected: expectedLinks,
					linksLoaded: linked,
					backfillLog: {
						examined: backfillLog["examined"],
						linked: backfillLog["linked"],
						chunks: backfillLog["chunks"],
						maxChunkMs: backfillLog["maxChunkMs"],
					},
					ingestRatePerSec: ratePerSec,
					admittedDuring: admittedAt.length,
					eventLoopDelayMs: {
						max: round(delay.max / 1e6),
						p99: round(delay.percentile(99) / 1e6),
						mean: round(delay.mean / 1e6),
					},
					admitToCommitMs: {
						max: round(Math.max(0, ...latencies)),
						p99: round(percentile(latencies, 99)),
						median: round(percentile(latencies, 50)),
						samples: latencies.length,
					},
				},
				reads: { load: loadReads, ...reads },
				plans,
			},
			null,
			2,
		),
	)
} finally {
	await rm(bundleDir, { recursive: true, force: true })
	if (!keep) await rm(dir, { recursive: true, force: true })
	else console.log(`kept ${dir}`)
}
