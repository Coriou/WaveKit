import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
	aggregateBandMap,
	DEFAULT_AGGREGATES_READ_LIMITS,
	type BandMapRow,
} from "../../../../../src/core/activity/query/aggregates.js"
import { runRead } from "../../../../../src/core/activity/query/read.js"
import { openReadOnly } from "../../../../../src/core/activity/query/sqlite.js"
import type {
	ActivityBandMap,
	ActivityTimeline,
} from "../../../../../src/core/activity/storage/contract.js"
import { ACTIVITY_SCHEMA_V1 } from "../../../../../src/core/activity/storage/contract.js"
import { FIXTURE_CLOCK_ANCHOR_MS } from "../storage/helpers.js"

const enabled = process.env["WAVEKIT_AGGREGATES_BENCH"] === "1"
const NOW = FIXTURE_CLOCK_ANCHOR_MS
const ROWS = 250_000
const ROWS_PER_HOUR = 21_700
const HOUR = 3_600_000

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe.skipIf(!enabled)(
	"aggregates benchmark (WAVEKIT_AGGREGATES_BENCH=1)",
	() => {
		it("band map, timeline and max band map serialisation at the scan cap", async () => {
			const dir = await mkdtemp(join(tmpdir(), "wavekit-aggregates-bench-"))
			try {
				const path = join(dir, "activity.db")
				const db = new DatabaseSync(path)
				db.exec("PRAGMA journal_mode = WAL")
				db.exec(ACTIVITY_SCHEMA_V1)
				const meta = db.prepare(
					"INSERT INTO store_meta(key, value) VALUES (?, ?)",
				)
				meta.run("storeUuid", randomUUID())
				meta.run("restoreGeneration", "1")
				meta.run("pruneWatermark", "0")
				const insert =
					db.prepare(`INSERT INTO activity (event_id, kind, produced_at_ms, received_at_ms,
					source_id, decoder_id, protocol, category, frequency_hz, entity_key, summary_json, record_json, record_bytes)
					VALUES (?, ?, ?, ?, 'rtl', 'dec', ?, ?, ?, ?, '{}', '{}', 2)`)
				const step = HOUR / ROWS_PER_HOUR
				const mixes = [
					["decoder-reception", "adsb", "aircraft", 1_090_000_000],
					["decoder-reception", "ais", "marine", 162_025_000],
					["decoder-reception", "acars", "aviation-data", 131_550_000],
					["decoder-reception", "p25", "voice", 851_000_000],
					["decoder-reception", "pocsag", "paging", 153_350_000],
					["decoder-reception", "aprs", "aprs", 144_800_000],
					["decoder-reception", "rtl433", "sensors", 433_920_000],
					["decoder-reception", "meshtastic", "mesh", 869_525_000],
					["analog-transmission", null, "voice", 446_000_000],
					["ingestion-gap", null, "other", null],
				] as const
				db.exec("BEGIN")
				for (let index = 0; index < ROWS; index += 1) {
					const ms = Math.round(NOW - (ROWS - index) * step)
					const [kind, protocol, category, base] = mixes[
						index % mixes.length
					] as (typeof mixes)[number]
					// Spread voice and analog over a few hundred 12.5 kHz channels.
					const hz = base === null ? null : base + (index % 300) * 12_500
					insert.run(
						`e${index}`,
						kind,
						ms,
						ms,
						protocol,
						category,
						hz,
						kind === "decoder-reception" ? `k:${index % 2_000}` : null,
					)
				}
				db.exec("COMMIT")
				db.close()
				const reader = await openReadOnly(path)
				const limits = {
					...DEFAULT_AGGREGATES_READ_LIMITS,
					// Measure the whole scan, not the cooperative stop.
					wallBudgetMs: 60_000,
				}
				const fromMs = NOW - 72 * HOUR
				const bandTimes: number[] = []
				let band: ActivityBandMap | undefined
				for (let run = 0; run < 3; run += 1) {
					const started = performance.now()
					const result = runRead(reader, {
						op: "bandmap",
						input: {
							producedFromMs: fromMs,
							producedToMs: NOW,
							minHz: 0,
							maxHz: 2_000_000_000,
							bucketHz: 12_500,
							limits,
						},
					})
					bandTimes.push(performance.now() - started)
					if (result.op === "bandmap") band = result.bandMap
				}
				const lineTimes: number[] = []
				let line: ActivityTimeline | undefined
				for (let run = 0; run < 3; run += 1) {
					const started = performance.now()
					const result = runRead(reader, {
						op: "timeline",
						input: {
							producedFromMs: fromMs,
							producedToMs: NOW - 1,
							bucketMs: 180_000,
							limits,
						},
					})
					lineTimes.push(performance.now() - started)
					if (result.op === "timeline") line = result.timeline
				}
				reader.close()
				if (!band || !line) throw new TypeError("no result")
				// Max-shaped band map: 1 000 buckets x 8 protocols x 3 entities, long keys.
				const rows: BandMapRow[] = []
				let seq = 0
				for (let b = 0; b < 1_000; b += 1)
					for (let p = 0; p < 9; p += 1)
						for (let e = 0; e < 3; e += 1)
							rows.push({
								seq: ++seq,
								producedAtMs: NOW - seq,
								kind: "decoder-reception",
								protocol: String(p).padStart(64, "p"),
								category: "aviation-data",
								entityKey: `${b}:${e + p}:`.padEnd(128, "k"),
								frequencyHz: b * 1_000_000,
							})
				const aggregate = aggregateBandMap(rows, {
					minHz: 0,
					maxHz: 2_000_000_000,
					bucketHz: 1_000_000,
					maxBuckets: 1_000,
					maxProtocols: 8,
					maxTopEntities: 3,
				})
				const big: ActivityBandMap = { ...band, buckets: aggregate.buckets }
				const serial: number[] = []
				let bytes = 0
				for (let run = 0; run < 3; run += 1) {
					const started = performance.now()
					bytes = JSON.stringify(big).length
					serial.push(performance.now() - started)
				}
				const lineSerial: number[] = []
				let lineBytes = 0
				for (let run = 0; run < 3; run += 1) {
					const started = performance.now()
					lineBytes = JSON.stringify(line).length
					lineSerial.push(performance.now() - started)
				}
				const report = {
					bandMapMs: median(bandTimes),
					bandMap: {
						scanned: band.scannedRows,
						counted: band.countedRows,
						noFrequency: band.noFrequencyRows,
						buckets: band.buckets.length,
						truncation: band.truncation,
						bytes: JSON.stringify(band).length,
					},
					timelineMs: median(lineTimes),
					timeline: {
						scanned: line.scannedRows,
						total: line.totalRows,
						buckets: line.buckets.length,
						truncation: line.truncation,
					},
					maxBandMapStringifyMs: median(serial),
					maxBandMapBytes: bytes,
					timelineStringifyMs: median(lineSerial),
					timelineBytes: lineBytes,
				}
				process.stderr.write(`AGGREGATES_BENCH ${JSON.stringify(report)}\n`)
				expect(band.scannedRows).toBe(ROWS)
			} finally {
				await rm(dir, { recursive: true, force: true })
			}
		}, 300_000)
	},
)
