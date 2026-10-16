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
import type { SqliteDatabase, SqliteValue } from "./sqlite.js"

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
	/**
	 * Batch index of each committed row, parallel to committedEventIds. A skipped or
	 * duplicate row can share an event id with the row that committed.
	 */
	committedIndexes: number[]
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
	/** Rows read before this call deleted anything. */
	rowCount: number
	/** Live bytes read before this call deleted anything. */
	dbBytes: number
}

/**
 * Previous cap decision from the writer session. A true flag keeps that cap
 * on until the count just read is back at or under its low-water mark.
 */
export interface ActivityPrunePressure {
	rowCap: boolean
	byteCap: boolean
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
	ensureHoleMeta(db)
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
			committedIndexes: [],
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
	const committedIndexes: number[] = []
	const duplicateEventIds: string[] = []
	const writeFailedEventIds: string[] = []
	db.exec("BEGIN IMMEDIATE")
	try {
		for (const [index, row] of rows.entries()) {
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
				committedIndexes.push(index)
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
		committedIndexes,
		duplicateEventIds,
		writeFailedEventIds,
	}
}

const AGE_SLACK_MIN_MS = 60_000

/** max(60s, 1% of maxAge). Age pruning waits until the oldest row is past this cushion. */
export function activityAgeSlackMs(maxAgeMs: number): number {
	const percent = Number.isFinite(maxAgeMs) ? Math.floor(maxAgeMs / 100) : 0
	return Math.max(AGE_SLACK_MIN_MS, percent)
}

/** 95% of a row or byte cap. Zero or negative caps have no retained floor. */
export function activityLowWater(cap: number): number {
	if (!Number.isSafeInteger(cap) || cap <= 0) return 0
	return Math.floor((cap * 95) / 100)
}

/** Once a cap is on, it stays on until the value is back at its low-water mark. */
export function activityCapActive(
	active: boolean,
	value: number,
	cap: number,
): boolean {
	return active ? value > activityLowWater(cap) : value > cap
}

/**
 * Deletes an ascending seq prefix in one transaction, then incremental_vacuum.
 * The watermark moves to the greatest deleted seq and the generation increments
 * in that same transaction. Age runs only when the oldest row is older than
 * maxAge plus slack, and then only deletes rows older than maxAge. Row and byte
 * pressure delete down to 95% of the cap and never remove more than
 * count - lowWater rows for the row cap. Pass the session's previous
 * hysteresis flags; this call recomputes them from the row count and live
 * bytes it already reads, so a cap that has started keeps deleting until
 * the low-water mark. Omit them for a one-shot check against the cap
 * itself. A row that qualifies for none of these stops the prefix, so a
 * prune never opens a hole.
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
	pressure?: ActivityPrunePressure,
): PruneResult {
	const meta = readRequiredMeta(db)
	const rowCount = countRows(db)
	const dbBytes = databaseBytes(db)
	const unchanged: PruneResult = {
		deleted: 0,
		watermark: meta.pruneWatermark,
		generation: meta.pruneGeneration,
		changed: false,
		rowCount,
		dbBytes,
	}
	const overRows = pressure
		? activityCapActive(pressure.rowCap, rowCount, limits.maxRows)
		: rowCount > limits.maxRows
	const overBytes = pressure
		? activityCapActive(pressure.byteCap, dbBytes, limits.maxDbBytes)
		: dbBytes > limits.maxDbBytes
	const oldest = oldestReceivedMs(db)
	const slack = activityAgeSlackMs(limits.maxAgeMs)
	const ageActive = oldest !== null && oldest < nowMs - limits.maxAgeMs - slack
	const cutoff = nowMs - limits.maxAgeMs
	if (!overRows && !overBytes && !ageActive) return unchanged
	const rowBudget = overRows
		? Math.max(0, rowCount - activityLowWater(limits.maxRows))
		: 0
	const byteExcess = overBytes
		? Math.max(0, dbBytes - activityLowWater(limits.maxDbBytes))
		: 0
	const candidates = db
		.prepare(
			`SELECT CAST(activity.seq AS TEXT) AS seq_text,
			        activity.received_at_ms AS received_at_ms,
			        activity.record_bytes AS record_bytes
			 FROM activity ORDER BY activity.seq ASC LIMIT ?`,
		)
		.all(limits.pruneBatchRows)
	const seqs: bigint[] = []
	let capDeletes = 0
	let bytesFreed = 0
	for (const candidate of candidates) {
		const seqText = cell(candidate, "seq_text")
		if (typeof seqText !== "string" || !/^\d+$/.test(seqText))
			throw new ActivityUnavailableError("Activity seq is invalid")
		const received = sqlNumber(
			cell(candidate, "received_at_ms"),
			"received_at_ms",
		)
		const recordBytes = sqlNumber(
			cell(candidate, "record_bytes") ?? 0,
			"record_bytes",
		)
		const forAge = ageActive && received < cutoff
		const forRows = capDeletes < rowBudget
		const forBytes = byteExcess > 0 && bytesFreed < byteExcess
		if (!forAge && !forRows && !forBytes) break
		seqs.push(BigInt(seqText))
		capDeletes += 1
		bytesFreed += Math.max(0, recordBytes)
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
	return {
		deleted: seqs.length,
		watermark,
		generation,
		changed: true,
		rowCount,
		dbBytes,
	}
}

/** One retention share's usage from the grouped scan (WG3 req 1.7). */
export interface RetentionGroup {
	decoderId: string | null
	kind: string
	rows: number
	bytes: number
}

/** A row a prune transaction removed, with what the retention counters need. */
export interface PrunedActivityRow {
	seq: bigint
	decoderId: string | null
	kind: string
	recordBytes: number
}

/** Rows and live bytes as the prefix prune reads them, plus the oldest received time. */
export interface ActivityPressureReading {
	rowCount: number
	dbBytes: number
	oldestReceivedMs: number | null
}

/** One share's slice of a fair prune step. */
export interface FairDeleteTarget {
	decoderId: string | null
	kind: string
	/** At most this many oldest rows. */
	rows: number
	/** Rows deleted regardless of the byte floor (the row cap's share). Defaults to `rows`. */
	minRows?: number
	/** Beyond minRows, delete only while retained bytes stay >= this. */
	byteFloor?: number | null
	/** The share's record bytes before the step (the counters' value). */
	shareBytes?: number
}

export interface FairPruneResult extends PruneResult {
	deletedRows: PrunedActivityRow[]
	holeWatermark: string
	holeGeneration: number
	holeOpened: boolean
	/** Set when incremental_vacuum failed after COMMIT; the deletes stand. */
	vacuumError?: string
}

/**
 * The seed scan of the per-share counters (design "Counters"). NOT INDEXED keeps it one
 * sequential table pass: left to itself SQLite walks activity_decoder and fetches every row
 * by rowid, which measured 1.5-14x slower on a 250 000-row store.
 */
export function scanRetentionGroups(db: SqliteDatabase): RetentionGroup[] {
	const rows = db
		.prepare(
			`SELECT decoder_id, CASE WHEN decoder_id IS NULL THEN kind END AS k,
			        COUNT(*) AS n, COALESCE(SUM(record_bytes), 0) AS b
			 FROM activity NOT INDEXED GROUP BY decoder_id, k`,
		)
		.all()
	return rows.map(row => {
		const decoderId = cell(row, "decoder_id")
		const kind = cell(row, "k")
		if (decoderId !== null && typeof decoderId !== "string")
			throw new ActivityUnavailableError("Activity decoder id is invalid")
		if (decoderId === null && typeof kind !== "string")
			throw new ActivityUnavailableError("Activity kind is invalid")
		return {
			decoderId,
			kind: typeof kind === "string" ? kind : "",
			rows: sqlNumber(cell(row, "n"), "count"),
			bytes: sqlNumber(cell(row, "b"), "record_bytes"),
		}
	})
}

/** received_at of a share's lowest-seq row: one indexed point lookup. */
export function shareOldestReceivedMs(
	db: SqliteDatabase,
	decoderId: string | null,
	kind: string,
): number | null {
	const row =
		decoderId === null
			? db
					.prepare(
						`SELECT received_at_ms FROM activity
						 WHERE kind = ? AND decoder_id IS NULL ORDER BY seq ASC LIMIT 1`,
					)
					.get(kind)
			: db
					.prepare(
						`SELECT received_at_ms FROM activity
						 WHERE decoder_id = ? ORDER BY seq ASC LIMIT 1`,
					)
					.get(decoderId)
	const value = cell(row, "received_at_ms")
	if (value === undefined || value === null) return null
	return sqlNumber(value, "received_at_ms")
}

export function readActivityPressure(
	db: SqliteDatabase,
): ActivityPressureReading {
	return {
		rowCount: countRows(db),
		dbBytes: databaseBytes(db),
		oldestReceivedMs: oldestReceivedMs(db),
	}
}

/** Live bytes and the oldest received time, without the row count. */
export function readActivityLiveBytes(db: SqliteDatabase): {
	dbBytes: number
	oldestReceivedMs: number | null
} {
	return { dbBytes: databaseBytes(db), oldestReceivedMs: oldestReceivedMs(db) }
}

/** True when `pruneActivityPrefix` would start an age delete (rule unchanged). */
export function activityAgeActive(
	oldestMs: number | null,
	maxAgeMs: number,
	nowMs: number,
): boolean {
	return (
		oldestMs !== null &&
		oldestMs < nowMs - maxAgeMs - activityAgeSlackMs(maxAgeMs)
	)
}

/**
 * The rows `pruneActivityPrefix` reads as its candidates (the lowest `limit` seqs), with the
 * share columns. The writer reads them before a prefix step so it can subtract what the step
 * deleted (every deleted seq is one of these) without touching the prefix prune itself.
 */
export function readPrefixCandidates(
	db: SqliteDatabase,
	limit: number,
): PrunedActivityRow[] {
	const rows = db
		.prepare(
			`SELECT CAST(seq AS TEXT) AS seq_text, decoder_id, kind, record_bytes
			 FROM activity ORDER BY seq ASC LIMIT ?`,
		)
		.all(limit)
	return rows.map(prunedRow)
}

/**
 * WG3 fair prune transaction (design "Transaction"). Deletes each target's lowest-seq rows
 * through its share index, then moves the prune watermark to MIN(seq) - 1 of what remains
 * (the greatest deleted seq when the table is empty) when that is greater, and records any
 * deleted seq above it as a hole. Every meta update is in the same transaction; a
 * generation at Number.MAX_SAFE_INTEGER fails the step and rolls back.
 */
export function pruneActivityFair(
	db: SqliteDatabase,
	limits: Pick<ActivityLimits, "incrementalVacuumPages">,
	targets: readonly FairDeleteTarget[],
	before: Pick<ActivityPressureReading, "rowCount" | "dbBytes">,
): FairPruneResult {
	const vacuumPages = limits.incrementalVacuumPages
	if (!Number.isSafeInteger(vacuumPages) || vacuumPages < 0)
		throw new ActivityUnavailableError("Activity vacuum page cap is invalid")
	const deletedRows: PrunedActivityRow[] = []
	let result: FairPruneResult
	db.exec("BEGIN IMMEDIATE")
	try {
		const meta = readRequiredMeta(db)
		const byDecoder = db.prepare(
			`SELECT CAST(seq AS TEXT) AS seq_text, decoder_id, kind, record_bytes
			 FROM activity WHERE decoder_id = ? ORDER BY seq ASC LIMIT ?`,
		)
		const byKind = db.prepare(
			`SELECT CAST(seq AS TEXT) AS seq_text, decoder_id, kind, record_bytes
			 FROM activity WHERE kind = ? AND decoder_id IS NULL ORDER BY seq ASC LIMIT ?`,
		)
		const dropFts = db.prepare("DELETE FROM activity_fts WHERE rowid = ?")
		const dropRow = db.prepare("DELETE FROM activity WHERE seq = ?")
		for (const target of targets) {
			if (!Number.isSafeInteger(target.rows) || target.rows < 1) continue
			const rows =
				target.decoderId === null
					? byKind.all(target.kind, target.rows)
					: byDecoder.all(target.decoderId, target.rows)
			const minRows = Math.min(target.rows, target.minRows ?? target.rows)
			const floor = target.byteFloor ?? null
			let retained = target.shareBytes ?? 0
			let taken = 0
			for (const raw of rows) {
				const row = prunedRow(raw)
				if (taken >= minRows) {
					// Never below the share's byte floor (req 1.5), not even for one row.
					if (floor === null || retained - row.recordBytes < floor) break
				}
				taken += 1
				retained -= row.recordBytes
				const bound = bindInteger(row.seq)
				dropFts.run(bound)
				dropRow.run(bound)
				deletedRows.push(row)
			}
		}
		const watermark = BigInt(meta.pruneWatermark)
		const holeWatermark = BigInt(meta.holeWatermark)
		let nextWatermark = watermark
		let nextHole = holeWatermark
		let pruneGeneration = meta.pruneGeneration
		let holeGeneration = meta.holeGeneration
		let holeOpened = false
		if (deletedRows.length > 0) {
			let greatest = 0n
			for (const row of deletedRows) if (row.seq > greatest) greatest = row.seq
			const min = cell(
				db.prepare("SELECT CAST(MIN(seq) AS TEXT) AS seq FROM activity").get(),
				"seq",
			)
			const floor =
				typeof min === "string" && /^\d+$/.test(min)
					? BigInt(min) - 1n
					: greatest
			if (floor > nextWatermark) nextWatermark = floor
			for (const row of deletedRows) {
				if (row.seq <= nextWatermark) continue
				holeOpened = true
				if (row.seq > nextHole) nextHole = row.seq
			}
			const update = db.prepare("UPDATE store_meta SET value = ? WHERE key = ?")
			if (holeOpened) {
				if (holeGeneration >= Number.MAX_SAFE_INTEGER)
					throw new ActivityUnavailableError(
						"Activity hole generation is exhausted",
					)
				holeGeneration += 1
				update.run(nextHole.toString(10), "holeWatermark")
				update.run(String(holeGeneration), "holeGeneration")
			}
			if (nextWatermark > watermark) {
				if (pruneGeneration >= Number.MAX_SAFE_INTEGER)
					throw new ActivityUnavailableError(
						"Activity prune generation is exhausted",
					)
				pruneGeneration += 1
				update.run(nextWatermark.toString(10), "pruneWatermark")
				update.run(String(pruneGeneration), "pruneGeneration")
			}
		}
		db.exec("COMMIT")
		result = {
			deleted: deletedRows.length,
			watermark: nextWatermark.toString(10),
			generation: pruneGeneration,
			changed: deletedRows.length > 0,
			rowCount: before.rowCount,
			dbBytes: before.dbBytes,
			deletedRows,
			holeWatermark: nextHole.toString(10),
			holeGeneration,
			holeOpened,
		}
	} catch (error) {
		rollback(db)
		throw error
	}
	if (result.changed && vacuumPages > 0) {
		try {
			db.exec(`PRAGMA incremental_vacuum(${vacuumPages})`)
		} catch (error) {
			result.vacuumError =
				error instanceof Error ? error.message : String(error)
		}
	}
	return result
}

function prunedRow(row: Record<string, SqliteValue>): PrunedActivityRow {
	const seqText = cell(row, "seq_text")
	if (typeof seqText !== "string" || !/^\d+$/.test(seqText))
		throw new ActivityUnavailableError("Activity seq is invalid")
	const decoderId = cell(row, "decoder_id")
	const kind = cell(row, "kind")
	if (
		(decoderId !== null && typeof decoderId !== "string") ||
		typeof kind !== "string"
	)
		throw new ActivityUnavailableError("Activity share columns are invalid")
	return {
		seq: BigInt(seqText),
		decoderId,
		kind,
		recordBytes: Math.max(
			0,
			sqlNumber(cell(row, "record_bytes") ?? 0, "record_bytes"),
		),
	}
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
			committedMax: readCommittedMax(
				db,
				meta.pruneWatermark,
				meta.holeWatermark,
			),
			holeWatermark: meta.holeWatermark,
			holeGeneration: meta.holeGeneration,
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
			["holeWatermark", "0"],
			["holeGeneration", "0"],
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
	holeWatermark: string
	holeGeneration: number
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
		holeWatermark: parseSeq(map.get("holeWatermark") ?? "0", "holeWatermark"),
		holeGeneration: parseCount(
			map.get("holeGeneration") ?? "0",
			"holeGeneration",
		),
	}
}

/**
 * WG3 (req 3.1): stores written before the hole keys gain them as "0". schemaVersion stays 1.
 */
function ensureHoleMeta(db: SqliteDatabase): void {
	const insert = db.prepare(
		"INSERT OR IGNORE INTO store_meta(key, value) VALUES (?, '0')",
	)
	insert.run("holeWatermark")
	insert.run("holeGeneration")
}

function parseSeq(value: string, name: string): string {
	if (!/^\d+$/.test(value))
		throw new ActivityUnavailableError(`Activity store meta ${name} is invalid`)
	return BigInt(value).toString(10)
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

/**
 * max(MAX(seq), pruneWatermark, holeWatermark): a fair prune that deletes the newest rows
 * must not move committedMax backwards.
 */
function readCommittedMax(
	db: SqliteDatabase,
	watermark: string,
	holeWatermark: string,
): string {
	const row = db
		.prepare("SELECT CAST(MAX(seq) AS TEXT) AS seq FROM activity")
		.get()
	const max = cell(row, "seq")
	let best = BigInt(typeof max === "string" && /^\d+$/.test(max) ? max : "0")
	for (const floor of [watermark, holeWatermark]) {
		const value = BigInt(floor)
		if (value > best) best = value
	}
	return best.toString(10)
}

function countRows(db: SqliteDatabase): number {
	return sqlNumber(
		cell(db.prepare("SELECT COUNT(*) AS n FROM activity").get(), "n"),
		"count",
	)
}

function oldestReceivedMs(db: SqliteDatabase): number | null {
	const oldest = cell(
		db.prepare("SELECT MIN(received_at_ms) AS oldest FROM activity").get(),
		"oldest",
	)
	if (oldest === undefined || oldest === null) return null
	return sqlNumber(oldest, "oldest")
}

function oldestReceivedAt(db: SqliteDatabase): string | null {
	const oldest = oldestReceivedMs(db)
	if (oldest === null) return null
	return new Date(oldest).toISOString()
}

/**
 * Pages that still hold data. Freelist pages stay in `page_count` until
 * incremental_vacuum returns them, and must not keep the byte cap on.
 */
function databaseBytes(db: SqliteDatabase): number {
	const pageSize = pragmaNumber(db, "PRAGMA page_size", "page_size")
	const pageCount = pragmaNumber(db, "PRAGMA page_count", "page_count")
	const freelist = pragmaNumber(db, "PRAGMA freelist_count", "freelist_count")
	const live = pageCount > freelist ? pageCount - freelist : 0
	return live * pageSize
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
