import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { runRead } from "../../../../../src/core/activity/query/read.js"
import { openReadOnly } from "../../../../../src/core/activity/query/sqlite.js"
import { DEFAULT_TRAILS_READ_LIMITS } from "../../../../../src/core/activity/query/trails.js"
import type {
	ActivityTrail,
	ActivityTrails,
} from "../../../../../src/core/activity/storage/contract.js"
import { ACTIVITY_SCHEMA_V1 } from "../../../../../src/core/activity/storage/contract.js"
import { FIXTURE_CLOCK_ANCHOR_MS } from "../storage/helpers.js"

const enabled = process.env["WAVEKIT_TRAILS_BENCH"] === "1"
const NOW = FIXTURE_CLOCK_ANCHOR_MS
const ROWS = 250_000
const ROWS_PER_HOUR = 21_700
const HOUR = 3_600_000

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe.skipIf(!enabled)("trails benchmark (WAVEKIT_TRAILS_BENCH=1)", () => {
	it("1 h, 24 h scan cap and max-size serialisation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-trails-bench-"))
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
				VALUES (?, ?, ?, ?, 'rtl', 'dec', ?, ?, 1090000000, ?, ?, '{}', 2)`)
			const step = HOUR / ROWS_PER_HOUR
			db.exec("BEGIN")
			for (let index = 0; index < ROWS; index += 1) {
				const ms = Math.round(NOW - (ROWS - index) * step)
				const mix = index % 10
				// ~60% positioned aircraft/vessels, the rest receptions without position or other kinds.
				const kind = mix === 9 ? "ingestion-gap" : "decoder-reception"
				const positioned = mix < 6
				const entity = mix < 4 ? `icao:${index % 300}` : `mmsi:${index % 400}`
				const summary = JSON.stringify({
					eventId: `e${index}`,
					kind,
					producedAt: new Date(ms).toISOString(),
					protocol: mix < 4 ? "adsb" : "ais",
					category: mix < 4 ? "aircraft" : "marine",
					entityKey: entity,
					title: `Entity ${entity}`,
					fields: [{ label: "Speed", value: "123 kt" }],
					...(positioned
						? {
								position: {
									lat: 48 + (index % 1000) / 1000,
									lon: 2 + (index % 777) / 1000,
									altM: 10_000,
								},
							}
						: {}),
				})
				insert.run(
					`e${index}`,
					kind,
					ms,
					ms,
					mix < 4 ? "adsb" : "ais",
					mix < 4 ? "aircraft" : "marine",
					entity,
					summary,
				)
			}
			db.exec("COMMIT")
			db.close()
			const reader = await openReadOnly(path)
			const time = (
				fromMs: number,
				limits = DEFAULT_TRAILS_READ_LIMITS,
			): { ms: number; result: ActivityTrails } => {
				const times: number[] = []
				let last: ActivityTrails | undefined
				for (let run = 0; run < 3; run += 1) {
					const started = performance.now()
					const result = runRead(reader, {
						op: "trails",
						input: {
							producedFromMs: fromMs,
							producedToMs: NOW,
							limits,
						},
					})
					times.push(performance.now() - started)
					if (result.op === "trails") last = result.trails
				}
				if (!last) throw new TypeError("no result")
				return { ms: median(times), result: last }
			}
			const hour = time(NOW - HOUR)
			const day = time(NOW - 24 * HOUR)
			// Worst case: only the scan cap stops the walk.
			const cap = time(NOW - 24 * HOUR, {
				...DEFAULT_TRAILS_READ_LIMITS,
				maxPoints: 1_000_000,
				maxPointsPerEntity: 1_000_000,
			})
			reader.close()
			const trails: ActivityTrail[] = []
			for (let entity = 0; entity < 2_000; entity += 1) {
				const points: [number, number, number, number | null][] = []
				for (let point = 0; point < 10; point += 1) {
					points.push([
						NOW - point * 60_000,
						48.12345 + point / 1e5,
						2.12345,
						10668,
					])
				}
				trails.push({
					entityKey: `icao:${entity.toString(16).padStart(6, "0")}`,
					category: "aircraft",
					protocol: "adsb",
					points,
					truncated: false,
				})
			}
			const big: ActivityTrails = { ...hour.result, trails, pointCount: 20_000 }
			const serial: number[] = []
			let bytes = 0
			for (let run = 0; run < 3; run += 1) {
				const started = performance.now()
				bytes = JSON.stringify(big).length
				serial.push(performance.now() - started)
			}
			const report = {
				hourMs: hour.ms,
				hour: {
					scanned: hour.result.scannedRows,
					points: hour.result.pointCount,
					trails: hour.result.trails.length,
					truncation: hour.result.truncation,
				},
				dayMs: day.ms,
				day: {
					scanned: day.result.scannedRows,
					points: day.result.pointCount,
					trails: day.result.trails.length,
					truncation: day.result.truncation,
				},
				capMs: cap.ms,
				cap: {
					scanned: cap.result.scannedRows,
					truncation: cap.result.truncation,
				},
				stringifyMs: median(serial),
				bytes,
			}
			process.stderr.write(`TRAILS_BENCH ${JSON.stringify(report)}\n`)
			expect(hour.result.scannedRows).toBeGreaterThan(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}, 300_000)
})
