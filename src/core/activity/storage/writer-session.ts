import type { StoreIdentity } from "./contract.js"
import {
	activityLowWater,
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityPrefix,
	readActivityState,
	syncActivityWal,
} from "./database.js"
import { ActivityUnavailableError } from "./errors.js"
import type { CommitBatchSuccess, PruneResult } from "./database.js"
import type { ActivityLimits } from "./limits.js"
import type { BuiltActivityRow } from "./row.js"
import type { SqliteDatabase } from "./sqlite.js"

/** Plain snapshot safe to post to the parent thread. */
export interface ActivityWorkerSnapshot {
	identity: StoreIdentity
	cursorKeyHex: string
	dbBytes: number
	walBytes: number
	rows: number
	oldestReceivedAt: string | null
	paused: boolean
}

export interface WriterWorkSuccess {
	ok: true
	commit: CommitBatchSuccess
	prune: PruneResult
	snapshot: ActivityWorkerSnapshot
	note?: string
}

export type WriterWorkResult =
	| WriterWorkSuccess
	| { ok: false; message: string }

export interface ActivitySession {
	readonly created: boolean
	snapshot(): ActivityWorkerSnapshot
	write(rows: readonly BuiltActivityRow[], nowMs: number): WriterWorkResult
	checkpoint(reason: "threshold" | "close"): ActivityWorkerSnapshot
	close(): void
}

/**
 * Synchronous writer. The worker thread and the inline test execution share
 * this; the worker entry is only a message loop.
 */
export function createActivitySession(
	db: SqliteDatabase,
	dbPath: string,
	limits: ActivityLimits,
	failNextWrites = 0,
	throwNextWrites = 0,
): ActivitySession {
	const opened = openActivityDatabase(db)
	let failures = failNextWrites
	let throws = throwNextWrites
	let state = readActivityState(db, dbPath)
	let paused = state.walBytes >= limits.walPauseBytes
	let rowCapPruning = false
	let byteCapPruning = false
	if (state.walBytes >= limits.walPassiveBytes || paused) {
		const wal = syncActivityWal(db, dbPath, limits)
		paused = wal.paused
		state = readActivityState(db, dbPath)
		paused = state.walBytes >= limits.walPauseBytes
	}

	const snapshot = (): ActivityWorkerSnapshot => ({
		identity: { ...state.identity },
		cursorKeyHex: state.cursorKey.toString("hex"),
		dbBytes: state.dbBytes,
		walBytes: state.walBytes,
		rows: state.rows,
		oldestReceivedAt: state.oldestReceivedAt,
		paused,
	})

	const refresh = (reason: "threshold" | "close"): void => {
		const wal = syncActivityWal(db, dbPath, limits, reason)
		paused = wal.paused
		state = readActivityState(db, dbPath)
		paused = state.walBytes >= limits.walPauseBytes
	}

	const refreshCaps = (): void => {
		const observed = readActivityState(db, dbPath)
		const rowLow = activityLowWater(limits.maxRows)
		const byteLow = activityLowWater(limits.maxDbBytes)
		rowCapPruning = rowCapPruning
			? observed.rows > rowLow
			: observed.rows > limits.maxRows
		byteCapPruning = byteCapPruning
			? observed.dbBytes > byteLow
			: observed.dbBytes > limits.maxDbBytes
	}

	return {
		created: opened.created,
		snapshot,
		write(rows, nowMs) {
			if (throws > 0) {
				throws -= 1
				throw new ActivityUnavailableError("injected write throw")
			}
			if (failures > 0) {
				failures -= 1
				return { ok: false, message: "injected write failure" }
			}
			const commit = commitActivityBatch(db, rows)
			if (!commit.ok) return { ok: false, message: commit.message }
			const previous = state.identity
			let prune: PruneResult = {
				deleted: 0,
				watermark: previous.pruneWatermark,
				generation: previous.pruneGeneration,
				changed: false,
			}
			let note: string | undefined
			try {
				const burst = limits.pruneBurstBatches
				for (let batch = 0; batch < burst; batch++) {
					refreshCaps()
					const step = pruneActivityPrefix(db, limits, nowMs, {
						rowCap: rowCapPruning,
						byteCap: byteCapPruning,
					})
					if (!step.changed) break
					prune = {
						deleted: prune.deleted + step.deleted,
						watermark: step.watermark,
						generation: step.generation,
						changed: true,
					}
				}
			} catch (error) {
				note = messageOf(error)
			}
			try {
				refresh("threshold")
			} catch (error) {
				note = messageOf(error)
			}
			const shot = snapshot()
			if (note !== undefined)
				return { ok: true, commit, prune, snapshot: shot, note }
			return { ok: true, commit, prune, snapshot: shot }
		},
		checkpoint(reason) {
			refresh(reason)
			return snapshot()
		},
		close() {
			try {
				refresh("close")
			} catch {
				// The caller still closes the handle and releases the lock.
			}
			db.close()
		},
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
