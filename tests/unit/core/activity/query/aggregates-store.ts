import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type { SqlDatabase } from "../../../../../src/core/activity/query/sqlite.js"
import { ACTIVITY_SCHEMA_V1 } from "../../../../../src/core/activity/storage/contract.js"

/** One stored row for the aggregate tests. */
export interface AggRow {
	producedAtMs: number
	kind?: string
	protocol?: string | null
	category?: string
	entityKey?: string | null
	frequencyHz?: number | null
}

export interface AggStore {
	readonly sql: SqlDatabase
	insert(row: AggRow): number
	insertMany(rows: readonly AggRow[]): void
	close(): void
}

export interface StatementStats {
	/** Rows returned by each statement execution, in order. */
	returned: { sql: string; rows: number }[]
	prepared: Set<string>
}

/** In-memory store on one connection, wrapped as the reader's SqlDatabase. */
export function createAggStore(): AggStore {
	const db = new DatabaseSync(":memory:")
	db.exec(ACTIVITY_SCHEMA_V1)
	const meta = db.prepare("INSERT INTO store_meta(key, value) VALUES (?, ?)")
	meta.run("schemaVersion", "1")
	meta.run("storeUuid", randomUUID())
	meta.run("restoreGeneration", "1")
	meta.run("pruneWatermark", "0")
	const insertStatement =
		db.prepare(`INSERT INTO activity (event_id, kind, produced_at_ms,
		received_at_ms, source_id, decoder_id, protocol, category, frequency_hz, entity_key,
		summary_json, record_json, record_bytes)
		VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, '{}', '{}', 2)`)
	let next = 0
	const insert = (row: AggRow): number => {
		next += 1
		const result = insertStatement.run(
			`e${next}`,
			row.kind ?? "decoder-reception",
			row.producedAtMs,
			row.producedAtMs,
			row.protocol === undefined ? "adsb" : row.protocol,
			row.category ?? "aircraft",
			row.frequencyHz === undefined ? 1_090_000_000 : row.frequencyHz,
			row.entityKey === undefined ? null : row.entityKey,
		)
		return Number(result.lastInsertRowid)
	}
	const sql: SqlDatabase = {
		prepare(text) {
			const statement = db.prepare(text)
			return {
				all: (...params) =>
					statement.all(...params) as Record<string, unknown>[],
				get: (...params) =>
					statement.get(...params) as Record<string, unknown> | undefined,
			}
		},
		exec: text => db.exec(text),
		close: () => db.close(),
	}
	return {
		sql,
		insert,
		insertMany(rows) {
			db.exec("BEGIN")
			for (const row of rows) insert(row)
			db.exec("COMMIT")
		},
		close: () => db.close(),
	}
}

/** Wraps a SqlDatabase to record each statement's returned row count. */
export function counting(
	inner: SqlDatabase,
	stats: StatementStats,
	onStatement?: () => void,
): SqlDatabase {
	return {
		prepare(text) {
			stats.prepared.add(text)
			const statement = inner.prepare(text)
			return {
				all: (...params) => {
					onStatement?.()
					const rows = statement.all(...params)
					stats.returned.push({ sql: text, rows: rows.length })
					return rows
				},
				get: (...params) => {
					onStatement?.()
					const row = statement.get(...params)
					// A packed band map piece counts the rows inside its JSON array.
					const packed = row?.["j"]
					stats.returned.push({
						sql: text,
						rows:
							typeof packed === "string"
								? (JSON.parse(packed) as unknown[]).length
								: row === undefined
									? 0
									: 1,
					})
					return row
				},
			}
		},
		exec: text => inner.exec(text),
		close: () => inner.close(),
	}
}

export function newStats(): StatementStats {
	return { returned: [], prepared: new Set() }
}
