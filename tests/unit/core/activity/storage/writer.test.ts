import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import { MAX_SUMMARY_BYTES } from "../../../../../src/core/activity/storage/contract.js"
import {
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityPrefix,
} from "../../../../../src/core/activity/storage/database.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import {
	buildActivityRow,
	parseStoredRecord,
	parseStoredSummary,
} from "../../../../../src/core/activity/storage/row.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type {
	SqliteDatabase,
	SqliteStatement,
	SqliteValue,
} from "../../../../../src/core/activity/storage/sqlite.js"
import { envelope, roots, tempDir } from "./helpers.js"

const databases: SqliteDatabase[] = []

afterEach(async () => {
	for (const db of databases.splice(0)) {
		try {
			db.close()
		} catch {
			// Already closed by the test.
		}
	}
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

async function database(): Promise<{ db: SqliteDatabase; path: string }> {
	const dir = await tempDir()
	const path = join(dir, "activity.db")
	const db = await openSqliteFile(path)
	databases.push(db)
	openActivityDatabase(db)
	return { db, path }
}

function reception(eventId: string, token = "alphaunique"): BuiltActivityRow {
	const stamp = "2026-10-12T00:00:00.000Z"
	return buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId,
		commitSeq: "999",
		producedAt: stamp,
		receivedAt: stamp,
		kind: "decoder-reception",
		payload: envelope({ eventId, title: token }),
	})
}

describe("activity writer rows", () => {
	it("commits a row, refs, and FTS text, and fills commitSeq on read", async () => {
		const { db } = await database()
		const row = reception("event-1")
		expect(row.recordJson.includes("commitSeq")).toBe(false)
		expect(row.summaryJson.includes("commitSeq")).toBe(false)
		expect(row.frequencyHz).toBe(1090)
		const result = commitActivityBatch(db, [row])
		expect(result.ok && result.committed).toBe(1)
		const stored = db
			.prepare(
				`SELECT CAST(seq AS TEXT) AS seq, event_id, kind, source_id, decoder_id,
				        protocol, category, frequency_hz, entity_key, summary_json, record_json
				 FROM activity`,
			)
			.get()
		const record = parseStoredRecord({
			seq: String(stored?.["seq"]),
			event_id: String(stored?.["event_id"]),
			kind: String(stored?.["kind"]),
			summary_json: String(stored?.["summary_json"]),
			record_json: String(stored?.["record_json"]),
		})
		expect(record.commitSeq).toBe("1")
		expect(record.kind).toBe("decoder-reception")
		const summary = parseStoredSummary({
			seq: String(stored?.["seq"]),
			event_id: String(stored?.["event_id"]),
			kind: String(stored?.["kind"]),
			summary_json: String(stored?.["summary_json"]),
			record_json: String(stored?.["record_json"]),
		})
		expect(summary.commitSeq).toBe("1")
		expect(summary.title).toBe("alphaunique")
		expect(stored?.["source_id"]).toBe("source-1")
		expect(stored?.["decoder_id"]).toBe("decoder-1")
		expect(stored?.["protocol"]).toBe("adsb")
		expect(stored?.["category"]).toBe("aircraft")
		expect(stored?.["frequency_hz"]).toBe(1090)
		expect(stored?.["entity_key"]).toBe("abc123")
		const refs = db
			.prepare("SELECT ref_type, ref_value FROM activity_refs")
			.all()
		expect(refs).toEqual([{ ref_type: "jobId", ref_value: "job-1" }])
		const hits = db
			.prepare(
				"SELECT rowid FROM activity_fts WHERE activity_fts MATCH '\"alphaunique\"'",
			)
			.all()
		expect(hits).toHaveLength(1)
		expect(hits[0]?.["rowid"]).toBe(1)
	})

	it("absorbs a duplicate event id inside the same transaction", async () => {
		const { db } = await database()
		const result = commitActivityBatch(db, [
			reception("event-1"),
			reception("event-1", "other"),
		])
		expect(result).toMatchObject({ ok: true, committed: 1, duplicates: 1 })
		const count = db.prepare("SELECT COUNT(*) AS n FROM activity").get()
		expect(count?.["n"]).toBe(1)
	})

	it("rolls the whole batch back when a write fails", async () => {
		const { db } = await database()
		const wrapped = explodeOn(db, "boom")
		const result = commitActivityBatch(wrapped, [
			reception("kept"),
			reception("boom"),
		])
		expect(result.ok).toBe(false)
		expect(db.prepare("SELECT COUNT(*) AS n FROM activity").get()?.["n"]).toBe(
			0,
		)
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM activity_fts").get()?.["n"],
		).toBe(0)
	})

	it("rolls back the activity delete when the FTS delete fails in the same transaction", async () => {
		const { db } = await database()
		expect(commitActivityBatch(db, [reception("event-1")]).ok).toBe(true)
		const limits = {
			maxRows: 0,
			maxDbBytes: 0,
			maxAgeMs: 0,
			pruneBatchRows: 10,
			incrementalVacuumPages: 0,
		}
		expect(() =>
			pruneActivityPrefix(failFtsDelete(db), limits, Date.now()),
		).toThrow(/fts delete failed/)
		expect(db.prepare("SELECT COUNT(*) AS n FROM activity").get()?.["n"]).toBe(
			1,
		)
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM activity_fts WHERE activity_fts MATCH '\"alphaunique\"'",
				)
				.get()?.["n"],
		).toBe(1)
		expect(
			db
				.prepare("SELECT value FROM store_meta WHERE key = 'pruneWatermark'")
				.get()?.["value"],
		).toBe("0")
		const pruned = pruneActivityPrefix(db, limits, Date.now())
		expect(pruned).toMatchObject({
			deleted: 1,
			watermark: "1",
			generation: 1,
			changed: true,
		})
		expect(db.prepare("SELECT COUNT(*) AS n FROM activity").get()?.["n"]).toBe(
			0,
		)
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM activity_refs").get()?.["n"],
		).toBe(0)
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM activity_fts WHERE activity_fts MATCH '\"alphaunique\"'",
				)
				.get()?.["n"],
		).toBe(0)
	})

	it("trims a summary to 4 KiB", () => {
		const fields = Array.from({ length: 200 }, (_, index) => ({
			key: `k${index}`,
			label: `Label ${index}`,
			value: "x".repeat(80),
		}))
		const row = buildActivityRow({
			version: ACTIVITY_RECORD_VERSION,
			eventId: "wide",
			commitSeq: "0",
			producedAt: "2026-10-12T00:00:00.000Z",
			receivedAt: "2026-10-12T00:00:00.000Z",
			kind: "decoder-reception",
			payload: envelope({
				eventId: "wide",
				title: "t".repeat(8_000),
				fields,
			}),
		})
		expect(Buffer.byteLength(row.summaryJson, "utf8")).toBeLessThanOrEqual(
			MAX_SUMMARY_BYTES,
		)
		expect(Buffer.byteLength(row.ftsText, "utf8")).toBeLessThanOrEqual(8 * 1024)
		const summary = parseStoredSummary({
			seq: "4",
			event_id: "wide",
			kind: "decoder-reception",
			summary_json: row.summaryJson,
			record_json: row.recordJson,
		})
		expect(summary.commitSeq).toBe("4")
		expect(summary.eventId).toBe("wide")
	})
})

function explodeOn(db: SqliteDatabase, eventId: string): SqliteDatabase {
	return {
		exec: sql => {
			db.exec(sql)
		},
		prepare(sql: string): SqliteStatement {
			const statement = db.prepare(sql)
			if (!sql.startsWith("INSERT INTO activity ")) return statement
			return {
				run(...params: SqliteValue[]) {
					if (params[0] === eventId) throw new Error("boom")
					return statement.run(...params)
				},
				get: (...params: SqliteValue[]) => statement.get(...params),
				all: (...params: SqliteValue[]) => statement.all(...params),
			}
		},
		close: () => {
			db.close()
		},
	}
}

function failFtsDelete(db: SqliteDatabase): SqliteDatabase {
	return {
		exec: sql => {
			db.exec(sql)
		},
		prepare(sql: string): SqliteStatement {
			const statement = db.prepare(sql)
			if (sql !== "DELETE FROM activity_fts WHERE rowid = ?") return statement
			return {
				run(...params: SqliteValue[]) {
					statement.run(...params)
					throw new Error("fts delete failed")
				},
				get: (...params: SqliteValue[]) => statement.get(...params),
				all: (...params: SqliteValue[]) => statement.all(...params),
			}
		},
		close: () => {
			db.close()
		},
	}
}
