import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runRead } from "../../../../../src/core/activity/query/read.js"
import type { SqlDatabase } from "../../../../../src/core/activity/query/sqlite.js"
import { openReadOnly } from "../../../../../src/core/activity/query/sqlite.js"
import {
	DEFAULT_TRAILS_READ_LIMITS,
	parseTrailPosition,
	type TrailsReadInput,
} from "../../../../../src/core/activity/query/trails.js"
import type { ActivityTrails } from "../../../../../src/core/activity/storage/contract.js"
import { ACTIVITY_SCHEMA_V1 } from "../../../../../src/core/activity/storage/contract.js"
import { FIXTURE_CLOCK_ANCHOR_MS } from "../storage/helpers.js"

const NOW = FIXTURE_CLOCK_ANCHOR_MS

/** SQLite keeps the first of duplicate keys, JSON.parse the last. */
const INNER_DUP = '{"lat":10,"lon":20,"lat":50}'

/** The second key is spelled with an escape; SQLite decodes it, a text scan misses it. */
const ESCAPED_DUP = '{"lat":10,"lon":20,"l\\u0061t":50}'
/** A nested object named lat repeats the quoted key. */
const NESTED = '{"lat":10,"lon":20,"meta":{"lat":30}}'

describe("parseTrailPosition with duplicate keys", () => {
	it("refuses a position whose lat, lon or altM key repeats", () => {
		expect(parseTrailPosition(INNER_DUP)).toBeNull()
		expect(parseTrailPosition('{"lat":10,"lon":20,"lon":30}')).toBeNull()
		expect(
			parseTrailPosition('{"lat":10,"lon":20,"altM":1,"altM":2}'),
		).toBeNull()
		expect(parseTrailPosition('{"lat":10,"lon":20,"altM":5}')).toEqual({
			lat: 10,
			lon: 20,
			altM: 5,
		})
	})

	it("refuses escaped keys that hide a duplicate from the text check", () => {
		expect(parseTrailPosition(ESCAPED_DUP)).toBeNull()
		expect(parseTrailPosition('{"lat":10,"lon":20,"l\\u006fn":30}')).toBeNull()
	})

	it("refuses a nested object named lat (intended: fail-safe, both sides agree)", () => {
		expect(parseTrailPosition(NESTED)).toBeNull()
	})
})

describe("readTrails with duplicate JSON keys in a stored row", () => {
	let dir = ""
	let writer: DatabaseSync
	let reader: SqlDatabase
	let seq = 0

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "wavekit-trails-dup-"))
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

	function insert(offsetMs: number, entityKey: string, summary: string): void {
		seq += 1
		writer
			.prepare(
				`INSERT INTO activity (event_id, kind, produced_at_ms, received_at_ms, source_id,
				decoder_id, protocol, category, frequency_hz, entity_key, summary_json, record_json,
				record_bytes) VALUES (?, 'decoder-reception', ?, ?, NULL, NULL, 'adsb', 'aircraft',
				NULL, ?, ?, '{}', 2)`,
			)
			.run(`e${seq}`, NOW - offsetMs, NOW - offsetMs, entityKey, summary)
	}

	function read(input: Partial<TrailsReadInput> = {}): ActivityTrails {
		const result = runRead(reader, {
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
		return result.trails
	}

	it("the SQLite probe and the parser both refuse a row with a repeated position key", () => {
		writer.exec("DELETE FROM activity")
		insert(100, "A", '{"position":{"lat":11,"lon":21}}')
		insert(200, "A", `{"position":${INNER_DUP}}`)
		// SQLite sees an object with lat 10 (first); JSON.parse would see lat 50.
		const probe = writer
			.prepare(
				"SELECT json_type(summary_json, '$.position') AS t, json_extract(summary_json, '$.position.lat') AS lat FROM activity WHERE event_id = ?",
			)
			.get(`e${seq}`)
		expect(probe).toMatchObject({ t: "object", lat: 10 })

		// Walk: the row is skipped, not read as lat 50.
		const full = read()
		expect(full.skippedRows).toBe(1)
		expect(full.trails).toHaveLength(1)
		expect(full.trails[0]?.points).toEqual([[NOW - 100, 11, 21, null]])
		expect(full.trails[0]?.truncated).toBe(false)

		// Early-stop probe: the duplicate row past the stop is not an older valid point.
		const capped = read({
			limits: { ...DEFAULT_TRAILS_READ_LIMITS, maxPoints: 1, scanRows: 1 },
		})
		expect(capped.trails[0]?.points).toEqual([[NOW - 100, 11, 21, null]])
		expect(capped.trails[0]?.truncated).toBe(false)
	})

	it("a repeated top-level position key reads the same (first) value in walk and probe", () => {
		writer.exec("DELETE FROM activity")
		insert(
			100,
			"B",
			'{"position":{"lat":12,"lon":22},"position":{"lat":13,"lon":23}}',
		)
		const full = read()
		expect(full.trails[0]?.points).toEqual([[NOW - 100, 12, 22, null]])
	})

	it("the walk and the probe both refuse escaped-key and nested rows", () => {
		writer.exec("DELETE FROM activity")
		insert(100, "C", '{"position":{"lat":11,"lon":21}}')
		insert(200, "C", `{"position":${ESCAPED_DUP}}`)
		insert(300, "C", `{"position":${NESTED}}`)
		const full = read()
		expect(full.skippedRows).toBe(2)
		expect(full.trails[0]?.points).toEqual([[NOW - 100, 11, 21, null]])
		const capped = read({
			limits: { ...DEFAULT_TRAILS_READ_LIMITS, maxPoints: 1, scanRows: 1 },
		})
		expect(capped.trails[0]?.points).toEqual([[NOW - 100, 11, 21, null]])
		expect(capped.trails[0]?.truncated).toBe(false)
	})
})
