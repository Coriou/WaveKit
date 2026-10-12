import { randomBytes, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { ACTIVITY_SCHEMA_VERSION, ACTIVITY_SCHEMA_V1 } from "./contract.js"
import type { StoreIdentity } from "./contract.js"
import {
	MAX_INDEXED_TEXT_BYTES,
	MAX_RECORD_BYTES,
	MAX_SUMMARY_BYTES,
} from "./contract.js"
import {
	ActivitySchemaMismatchError,
	ActivityUnavailableError,
	errnoCode,
} from "./errors.js"
import type { ActivityLimits } from "./limits.js"
import { truncateUtf8 } from "./row.js"
import type { BuiltActivityRow } from "./row.js"
import { bindInteger, cell, sqlNumber } from "./sqlite.js"
import type { SqliteDatabase } from "./sqlite.js"

export interface OpenedActivityDatabase {
	created: boolean
	cursorKey: Buffer
}

export interface CommitBatchSuccess {
	ok: true
	committed: number
	duplicates: number
	writeFailed: number
	committedEventIds: string[]
	duplicateEventIds: string[]
	writeFailedEventIds: string[]
}

export interface CommitBatchFailure {
	ok: false
	message: string
}

export type CommitBatchResult = CommitBatchSuccess | CommitBatchFailure

export interface PruneResult {
	deleted: number
	watermark: string
	generation: number
	changed: boolean
}

export interface ActivityDatabaseState {
	identity: StoreIdentity
	cursorKey: Buffer
	dbBytes: number
	walBytes: number
	rows: number
	oldestReceivedAt: string | null
}

export interface ActivityPragmas {
	autoVacuum: number
	journalMode: string
	synchronous: number
	busyTimeout: number
	foreignKeys: number
	walAutocheckpoint: number
}

const REQUIRED_TABLES = [
	"store_meta",
	"activity",
	"activity_refs",
	"activity_fts",
]

/**
 * Opens or creates schema v1. auto_vacuum=INCREMENTAL is set before any table
 * exists; runtime pragmas are applied on every open. A different schemaVersion
 * is refused before journal_mode is changed.
 */
export function openActivityDatabase(
	db: SqliteDatabase,
): OpenedActivityDatabase {
	const names = userTableNames(db)
	if (names.length === 0) {
		db.exec("PRAGMA auto_vacuum=INCREMENTAL")
		applyRuntimePragmas(db)
		const cursorKey = randomBytes(32)
		writeSchema(db, randomUUID(), cursorKey)
		return { created: true, cursorKey }
	}
	assertSchema(db, names)
	applyRuntimePragmas(db)
	return { created: false, cursorKey: readRequiredMeta(db).cursorKey }
}

export function applyRuntimePragmas(db: SqliteDatabase): void {
	db.exec("PRAGMA journal_mode=WAL")
	db.exec("PRAGMA synchronous=FULL")
	db.exec("PRAGMA busy_timeout=100")
	db.exec("PRAGMA foreign_keys=ON")
	db.exec("PRAGMA wal_autocheckpoint=0")
}

export function readActivityPragmas(db: SqliteDatabase): ActivityPragmas {
	return {
		autoVacuum: pragmaNumber(db, "PRAGMA auto_vacuum", "auto_vacuum"),
		journalMode: pragmaString(db, "PRAGMA journal_mode", "journal_mode"),
		synchronous: pragmaNumber(db, "PRAGMA synchronous", "synchronous"),
		busyTimeout: pragmaNumber(db, "PRAGMA busy_timeout", "timeout"),
		foreignKeys: pragmaNumber(db, "PRAGMA foreign_keys", "foreign_keys"),
		walAutocheckpoint: pragmaNumber(
			db,
			"PRAGMA wal_autocheckpoint",
			"wal_autocheckpoint",
		),
	}
}

export function commitActivityBatch(
	db: SqliteDatabase,
	rows: readonly BuiltActivityRow[],
): CommitBatchResult {
	if (rows.length === 0) {
		return {
			ok: true,
			committed: 0,
			duplicates: 0,
			writeFailed: 0,
			committedEventIds: [],
			duplicateEventIds: [],
			writeFailedEventIds: [],
		}
	}
	const insert = db.prepare(
		`INSERT INTO activity (
			event_id, kind, produced_at_ms, received_at_ms, source_id, decoder_id,
			protocol, category, frequency_hz, entity_key, summary_json, record_json, record_bytes
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	const fts = db.prepare("INSERT INTO activity_fts(rowid, text) VALUES (?, ?)")
	const ref = db.prepare(
		"INSERT INTO activity_refs(seq, ref_type, ref_value) VALUES (?, ?, ?)",
	)
	const committedEventIds: string[] = []
	const duplicateEventIds: string[] = []
	const writeFailedEventIds: string[] = []
	db.exec("BEGIN IMMEDIATE")
	try {
		for (const row of rows) {
			const recordBytes = Buffer.byteLength(row.recordJson, "utf8")
			if (
				recordBytes > MAX_RECORD_BYTES ||
				Buffer.byteLength(row.summaryJson, "utf8") > MAX_SUMMARY_BYTES
			) {
				writeFailedEventIds.push(row.eventId)
				continue
			}
			const text =
				Buffer.byteLength(row.ftsText, "utf8") > MAX_INDEXED_TEXT_BYTES
					? truncateUtf8(row.ftsText, MAX_INDEXED_TEXT_BYTES)
					: row.ftsText
			try {
				const inserted = insert.run(
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
					recordBytes,
				)
				const seq = inserted.lastInsertRowid
				fts.run(seq, text)
				for (const item of row.refs) ref.run(seq, item.type, item.value)
				committedEventIds.push(row.eventId)
			} catch (error) {
				if (isUniqueConstraint(error)) {
					duplicateEventIds.push(row.eventId)
					continue
				}
				throw error
			}
		}
		db.exec("COMMIT")
	} catch (error) {
		rollback(db)
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
		}
	}
	return {
		ok: true,
		committed: committedEventIds.length,
		duplicates: duplicateEventIds.length,
		writeFailed: writeFailedEventIds.length,
		committedEventIds,
		duplicateEventIds,
		writeFailedEventIds,
	}
}

/**
 * Deletes an ascending seq prefix in one transaction, then incremental_vacuum.
 * The watermark moves to the greatest deleted seq and the generation increments
 * in that same transaction. Age uses received_at_ms and never opens a hole:
 * a fresh row stops an age-only prune.
 */
export function pruneActivityPrefix(
	db: SqliteDatabase,
	limits: Pick<
		ActivityLimits,
		| "maxRows"
		| "maxDbBytes"
		| "maxAgeMs"
		| "pruneBatchRows"
		| "incrementalVacuumPages"
	>,
	nowMs: number,
): PruneResult {
	const meta = readRequiredMeta(db)
	const unchanged: PruneResult = {
		deleted: 0,
		watermark: meta.pruneWatermark,
		generation: meta.pruneGeneration,
		changed: false,
	}
	const overRows = countRows(db) > limits.maxRows
	const overBytes = databaseBytes(db) > limits.maxDbBytes
	const cutoff = nowMs - limits.maxAgeMs
	const candidates = db
		.prepare(
			`SELECT CAST(activity.seq AS TEXT) AS seq_text, activity.received_at_ms AS received_at_ms
			 FROM activity ORDER BY activity.seq ASC LIMIT ?`,
		)
		.all(limits.pruneBatchRows)
	const seqs: bigint[] = []
	for (const candidate of candidates) {
		const seqText = cell(candidate, "seq_text")
		if (typeof seqText !== "string" || !/^\d+$/.test(seqText))
			throw new ActivityUnavailableError("Activity seq is invalid")
		const expired =
			sqlNumber(cell(candidate, "received_at_ms"), "received_at_ms") < cutoff
		if (!(overRows || overBytes || expired)) break
		seqs.push(BigInt(seqText))
	}
	const greatest = seqs[seqs.length - 1]
	if (greatest === undefined || greatest <= BigInt(meta.pruneWatermark))
		return unchanged
	if (meta.pruneGeneration >= Number.MAX_SAFE_INTEGER)
		throw new ActivityUnavailableError("Activity prune generation is exhausted")
	const generation = meta.pruneGeneration + 1
	const watermark = greatest.toString(10)
	const vacuumPages = limits.incrementalVacuumPages
	if (!Number.isSafeInteger(vacuumPages) || vacuumPages < 0)
		throw new ActivityUnavailableError("Activity vacuum page cap is invalid")
	db.exec("BEGIN IMMEDIATE")
	try {
		const dropFts = db.prepare("DELETE FROM activity_fts WHERE rowid = ?")
		for (const seq of seqs) dropFts.run(bindInteger(seq))
		db.prepare("DELETE FROM activity WHERE seq <= ?").run(bindInteger(greatest))
		db.prepare(
			"UPDATE store_meta SET value = ? WHERE key = 'pruneWatermark'",
		).run(watermark)
		db.prepare(
			"UPDATE store_meta SET value = ? WHERE key = 'pruneGeneration'",
		).run(String(generation))
		db.exec("COMMIT")
	} catch (error) {
		rollback(db)
		throw error
	}
	if (vacuumPages > 0) db.exec(`PRAGMA incremental_vacuum(${vacuumPages})`)
	return { deleted: seqs.length, watermark, generation, changed: true }
}

export function syncActivityWal(
	db: SqliteDatabase,
	dbPath: string,
	limits: Pick<
		ActivityLimits,
		"walPassiveBytes" | "walTruncateBytes" | "walPauseBytes"
	>,
	reason: "threshold" | "close" = "threshold",
): { walBytes: number; paused: boolean } {
	const before = activityWalBytes(dbPath)
	if (reason === "close") {
		if (before > 0) db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	} else if (
		before >= limits.walTruncateBytes ||
		before >= limits.walPauseBytes
	) {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	} else if (before >= limits.walPassiveBytes) {
		db.exec("PRAGMA wal_checkpoint(PASSIVE)")
	}
	const walBytes = activityWalBytes(dbPath)
	return { walBytes, paused: walBytes >= limits.walPauseBytes }
}

export function readActivityState(
	db: SqliteDatabase,
	dbPath: string,
): ActivityDatabaseState {
	const meta = readRequiredMeta(db)
	return {
		identity: {
			storeUuid: meta.storeUuid,
			restoreGeneration: meta.restoreGeneration,
			pruneWatermark: meta.pruneWatermark,
			pruneGeneration: meta.pruneGeneration,
			committedMax: readCommittedMax(db, meta.pruneWatermark),
		},
		cursorKey: meta.cursorKey,
		dbBytes: databaseBytes(db),
		walBytes: activityWalBytes(dbPath),
		rows: countRows(db),
		oldestReceivedAt: oldestReceivedAt(db),
	}
}

export function activityWalBytes(dbPath: string): number {
	if (dbPath === ":memory:") return 0
	try {
		const info = statSync(`${dbPath}-wal`)
		return info.isFile() ? info.size : 0
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return 0
		throw error
	}
}

function writeSchema(
	db: SqliteDatabase,
	storeUuid: string,
	cursorKey: Buffer,
): void {
	db.exec("BEGIN IMMEDIATE")
	try {
		db.exec(ACTIVITY_SCHEMA_V1)
		const insert = db.prepare(
			"INSERT INTO store_meta(key, value) VALUES (?, ?)",
		)
		const rows: Array<[string, string]> = [
			["schemaVersion", String(ACTIVITY_SCHEMA_VERSION)],
			["storeUuid", storeUuid],
			["restoreGeneration", "1"],
			["pruneWatermark", "0"],
			["pruneGeneration", "0"],
			["cursorKey", cursorKey.toString("hex")],
		]
		for (const [key, value] of rows) insert.run(key, value)
		db.exec("COMMIT")
	} catch (error) {
		rollback(db)
		throw error
	}
}

function assertSchema(db: SqliteDatabase, names: readonly string[]): void {
	for (const required of REQUIRED_TABLES) {
		if (!names.includes(required))
			throw new ActivitySchemaMismatchError("missing")
	}
	const version = readMetaMap(db).get("schemaVersion")
	if (version !== String(ACTIVITY_SCHEMA_VERSION))
		throw new ActivitySchemaMismatchError(version ?? "missing")
}

interface StoreMeta {
	storeUuid: string
	restoreGeneration: number
	pruneWatermark: string
	pruneGeneration: number
	cursorKey: Buffer
}

function readRequiredMeta(db: SqliteDatabase): StoreMeta {
	const map = readMetaMap(db)
	const version = map.get("schemaVersion")
	if (version !== String(ACTIVITY_SCHEMA_VERSION))
		throw new ActivitySchemaMismatchError(version ?? "missing")
	const storeUuid = map.get("storeUuid")
	if (!storeUuid)
		throw new ActivityUnavailableError("Activity store uuid is missing")
	const watermark = map.get("pruneWatermark")
	if (!watermark || !/^\d+$/.test(watermark))
		throw new ActivityUnavailableError("Activity prune watermark is invalid")
	const cursor = map.get("cursorKey")
	if (!cursor || !/^[0-9a-f]{64}$/.test(cursor))
		throw new ActivityUnavailableError("Activity cursor key is invalid")
	return {
		storeUuid,
		restoreGeneration: parseCount(
			map.get("restoreGeneration"),
			"restoreGeneration",
		),
		pruneWatermark: watermark,
		pruneGeneration: parseCount(map.get("pruneGeneration"), "pruneGeneration"),
		cursorKey: Buffer.from(cursor, "hex"),
	}
}

function readMetaMap(db: SqliteDatabase): Map<string, string> {
	const rows = db.prepare("SELECT key, value FROM store_meta").all()
	const map = new Map<string, string>()
	for (const row of rows) {
		const key = cell(row, "key")
		const value = cell(row, "value")
		if (typeof key === "string" && typeof value === "string")
			map.set(key, value)
	}
	return map
}

function readCommittedMax(db: SqliteDatabase, watermark: string): string {
	const row = db
		.prepare("SELECT CAST(MAX(seq) AS TEXT) AS seq FROM activity")
		.get()
	const max = cell(row, "seq")
	const text = typeof max === "string" && /^\d+$/.test(max) ? max : "0"
	return BigInt(text) >= BigInt(watermark) ? text : watermark
}

function countRows(db: SqliteDatabase): number {
	return sqlNumber(
		cell(db.prepare("SELECT COUNT(*) AS n FROM activity").get(), "n"),
		"count",
	)
}

function oldestReceivedAt(db: SqliteDatabase): string | null {
	const oldest = cell(
		db.prepare("SELECT MIN(received_at_ms) AS oldest FROM activity").get(),
		"oldest",
	)
	if (oldest === undefined || oldest === null) return null
	return new Date(sqlNumber(oldest, "oldest")).toISOString()
}

function databaseBytes(db: SqliteDatabase): number {
	return (
		pragmaNumber(db, "PRAGMA page_size", "page_size") *
		pragmaNumber(db, "PRAGMA page_count", "page_count")
	)
}

function userTableNames(db: SqliteDatabase): string[] {
	const rows = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
		)
		.all()
	const names: string[] = []
	for (const row of rows) {
		const name = cell(row, "name")
		if (typeof name === "string") names.push(name)
	}
	return names
}

function pragmaNumber(db: SqliteDatabase, sql: string, column: string): number {
	return sqlNumber(cell(db.prepare(sql).get(), column), column)
}

function pragmaString(db: SqliteDatabase, sql: string, column: string): string {
	const value = cell(db.prepare(sql).get(), column)
	if (typeof value !== "string")
		throw new ActivityUnavailableError(`Unexpected SQLite value for ${column}`)
	return value
}

function parseCount(value: string | undefined, name: string): number {
	if (value === undefined || !/^\d+$/.test(value))
		throw new ActivityUnavailableError(`Activity store meta ${name} is invalid`)
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed))
		throw new ActivityUnavailableError(
			`Activity store meta ${name} is out of range`,
		)
	return parsed
}

function rollback(db: SqliteDatabase): void {
	try {
		db.exec("ROLLBACK")
	} catch {
		// The transaction is already closed.
	}
}

function isUniqueConstraint(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("message" in error))
		return false
	return (
		typeof error.message === "string" &&
		error.message.includes("UNIQUE constraint failed")
	)
}
