import type {
	ActivityRetentionPolicy,
	ActivityRetentionShare,
	ActivityRetentionStats,
	StoreIdentity,
} from "./contract.js"
import {
	activityAgeActive,
	activityCapActive,
	activityLowWater,
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityFair,
	pruneActivityPrefix,
	readActivityLiveBytes,
	readActivityPressure,
	readActivityState,
	readPrefixCandidates,
	scanRetentionGroups,
	shareOldestReceivedMs,
	syncActivityWal,
} from "./database.js"
import { ActivityUnavailableError } from "./errors.js"
import type {
	CommitBatchSuccess,
	FairDeleteTarget,
	PruneResult,
	PrunedActivityRow,
} from "./database.js"
import {
	indivisibleShare,
	planFairStep,
	retentionShareKey,
} from "./fair-share.js"
import type { FairStepPlan } from "./fair-share.js"
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
	/** WG3 (req 2.1): mapped by the store into `stats().retention`. */
	retention: ActivityRetentionStats
}

/** Shares listed in the retention block (req 2.2). */
export const RETENTION_SHARES_LISTED = 64

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
	/** Wall time of the last retention seed scan, in ms. */
	readonly seedMs: number
	snapshot(): ActivityWorkerSnapshot
	write(rows: readonly BuiltActivityRow[], nowMs: number): WriterWorkResult
	checkpoint(reason: "threshold" | "close"): ActivityWorkerSnapshot
	close(): void
}

/**
 * Synchronous writer. The worker thread and the inline test execution share
 * this; the worker entry is only a message loop. `clock` times the prune
 * burst. The inline store passes its injected clock; the worker uses
 * Date.now so the budget is the same clock as the write timeout.
 */
export function createActivitySession(
	db: SqliteDatabase,
	dbPath: string,
	limits: ActivityLimits,
	failNextWrites = 0,
	throwNextWrites = 0,
	clock: () => number = Date.now,
): ActivitySession {
	const opened = openActivityDatabase(db)
	let failures = failNextWrites
	let throws = throwNextWrites
	let state = readActivityState(db, dbPath)
	let paused = state.walBytes >= limits.walPauseBytes
	let rowCapPruning = false
	let byteCapPruning = false
	const policy: ActivityRetentionPolicy = limits.retentionPolicy
	const counters = new RetentionCounters(db)
	let effective: ActivityRetentionPolicy = policy
	let pendingNote: string | undefined
	let prefixFallbackSteps = 0
	/** A maintenance note from a step that still committed (vacuum failure). */
	let stepNote: string | undefined
	/** Wall time of the last seed scan (design F seed budget). */
	let seedMs = 0
	const seed = (): boolean => {
		const started = performance.now()
		try {
			counters.seed()
			return true
		} catch (error) {
			counters.drop()
			if (effective === "fair-share") {
				effective = "oldest-first"
				pendingNote = `activity retention seed failed; oldest-first until reopen: ${messageOf(error)}`
			}
			return false
		} finally {
			seedMs = performance.now() - started
		}
	}
	seed()
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
		retention: {
			policy,
			effective,
			...counters.listed(),
			prefixFallbackSteps,
		},
	})

	/** A prefix step (age, oldest-first or fallback) with the counters kept in step. */
	const prefixStep = (
		prefixLimits: Parameters<typeof pruneActivityPrefix>[1],
		nowMs: number,
		pressure: { rowCap: boolean; byteCap: boolean } | undefined,
		preRead = true,
	): PruneResult => {
		const read = counters.live && preRead
		const before = read ? readPrefixCandidates(db, limits.pruneBatchRows) : []
		let step: PruneResult
		try {
			step = pruneActivityPrefix(db, prefixLimits, nowMs, pressure)
		} catch (error) {
			// The prefix may have committed before incremental_vacuum threw: rebuild counters.
			if (counters.live && !seed()) counters.drop()
			throw error
		}
		if (step.changed && counters.live) {
			// Every seq the prefix deleted is one of its candidates, all <= the new watermark.
			const to = BigInt(step.watermark)
			if (read) counters.subtract(before.filter(row => row.seq <= to))
			else if (!seed()) counters.drop()
		}
		if (step.changed) adoptStep(step)
		return step
	}

	const adoptStep = (step: PruneResult): void => {
		state = {
			...state,
			identity: {
				...state.identity,
				pruneWatermark: step.watermark,
				pruneGeneration: step.generation,
			},
		}
	}

	/**
	 * `pruneActivityPrefix` exactly as before WG3. The counters' candidate read only runs when
	 * a delete is plausible; an unexpected delete reseeds instead.
	 */
	const oldestFirstStep = (nowMs: number): PruneResult => {
		let plausible = false
		if (counters.live) {
			const live = readActivityLiveBytes(db)
			plausible =
				activityAgeActive(live.oldestReceivedMs, limits.maxAgeMs, nowMs) ||
				activityCapActive(
					rowCapPruning,
					counters.totalRows(),
					limits.maxRows,
				) ||
				activityCapActive(byteCapPruning, live.dbBytes, limits.maxDbBytes)
		}
		return prefixStep(
			limits,
			nowMs,
			{ rowCap: rowCapPruning, byteCap: byteCapPruning },
			plausible,
		)
	}

	/** Fair-share step order: age prefix, else fair step, else stop (design "Step order"). */
	const fairShareStep = (nowMs: number, burst: BurstState): PruneResult => {
		const reading = readActivityPressure(db)
		// Drift first (1.10): the one-share shortcut below must not trust stale counters.
		if (counters.totalRows() !== reading.rowCount && !burst.reseeded) {
			burst.reseeded = true
			if (!seed()) return oldestFirstStep(nowMs)
		}
		// One share: its fair level is the low-water mark, so the step is today's (1.13).
		if (counters.size() <= 1) return oldestFirstStep(nowMs)
		if (activityAgeActive(reading.oldestReceivedMs, limits.maxAgeMs, nowMs)) {
			const aged = prefixStep(
				{
					...limits,
					maxRows: Number.MAX_SAFE_INTEGER,
					maxDbBytes: Number.MAX_SAFE_INTEGER,
				},
				nowMs,
				undefined,
			)
			if (aged.changed) return aged
		}
		const overRows = activityCapActive(
			rowCapPruning,
			reading.rowCount,
			limits.maxRows,
		)
		const overBytes = activityCapActive(
			byteCapPruning,
			reading.dbBytes,
			limits.maxDbBytes,
		)
		const unchanged: PruneResult = {
			deleted: 0,
			watermark: state.identity.pruneWatermark,
			generation: state.identity.pruneGeneration,
			changed: false,
			rowCount: reading.rowCount,
			dbBytes: reading.dbBytes,
		}
		if (!overRows && !overBytes) return unchanged
		const capOnly = { ...limits, maxAgeMs: Number.POSITIVE_INFINITY }
		const capPressure = { rowCap: rowCapPruning, byteCap: byteCapPruning }
		const plan = (): FairStepPlan =>
			planFairStep({
				shares: counters.usages(),
				rowTarget: overRows ? activityLowWater(limits.maxRows) : null,
				byteExcess: overBytes
					? reading.dbBytes - activityLowWater(limits.maxDbBytes)
					: null,
				budget: limits.pruneBatchRows,
			})
		let planned = plan()
		if (planned.allocations.length === 0 && !burst.reseeded) {
			burst.reseeded = true
			if (!seed()) return prefixStep(capOnly, nowMs, capPressure)
			if (counters.size() <= 1) return oldestFirstStep(nowMs)
			planned = plan()
		}
		if (planned.allocations.length === 0) {
			if (!planned.residual) return unchanged
			const fallback = prefixStep(capOnly, nowMs, capPressure)
			if (fallback.changed) prefixFallbackSteps += 1
			return fallback
		}
		const targets: FairDeleteTarget[] = []
		for (const allocation of planned.allocations) {
			const share = counters.get(allocation.key)
			if (share)
				targets.push({
					decoderId: share.decoderId,
					kind: share.kind,
					rows: allocation.rows,
					minRows: allocation.minRows,
					byteFloor: allocation.byteFloor,
					shareBytes: share.bytes,
				})
		}
		const runFair = (chosen: readonly FairDeleteTarget[]): PruneResult => {
			const done = pruneActivityFair(db, limits, chosen, reading)
			counters.subtract(done.deletedRows)
			if (done.vacuumError !== undefined)
				stepNote = `activity incremental vacuum failed: ${done.vacuumError}`
			if (done.changed) {
				adoptStep(done)
				state = {
					...state,
					identity: {
						...state.identity,
						holeWatermark: done.holeWatermark,
						holeGeneration: done.holeGeneration,
					},
				}
			}
			return done
		}
		const step = runFair(targets)
		if (step.changed) return step
		if (!burst.reseeded) {
			// Counters named rows the share index does not hold: drift. Reseed and re-plan in
			// this same step; the burst flag keeps it to once per burst.
			burst.reseeded = true
			if (!seed()) return oldestFirstStep(nowMs)
			return fairShareStep(nowMs, burst)
		}
		// Indivisible step: every candidate would cross its share's byte floor. Delete the
		// oldest row of the over-level share with the largest excess (ties key ascending),
		// so the cap still binds and no share at or under the level loses a row. Counted in
		// prefixFallbackSteps.
		const key = indivisibleShare(planned, counters.usages())
		const share = key === null ? undefined : counters.get(key)
		if (!share) return step
		const single = runFair([
			{ decoderId: share.decoderId, kind: share.kind, rows: 1 },
		])
		if (single.changed) prefixFallbackSteps += 1
		return single
	}

	const refresh = (reason: "threshold" | "close"): void => {
		const wal = syncActivityWal(db, dbPath, limits, reason)
		paused = wal.paused
		state = readActivityState(db, dbPath)
		paused = state.walBytes >= limits.walPauseBytes
	}

	return {
		created: opened.created,
		get seedMs() {
			return seedMs
		},
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
			if (counters.live) counters.addCommitted(rows, commit.committedIndexes)
			const previous = state.identity
			let prune: PruneResult = {
				deleted: 0,
				watermark: previous.pruneWatermark,
				generation: previous.pruneGeneration,
				changed: false,
				rowCount: state.rows,
				dbBytes: state.dbBytes,
			}
			let note: string | undefined = pendingNote
			pendingNote = undefined
			stepNote = undefined
			try {
				const started = clock()
				const burst = limits.pruneBurstBatches
				const burstState: BurstState = { reseeded: false }
				for (let batch = 0; batch < burst; batch++) {
					if (batch > 0 && clock() - started >= limits.pruneBurstMs) break
					const step =
						effective === "fair-share"
							? fairShareStep(nowMs, burstState)
							: oldestFirstStep(nowMs)
					rowCapPruning = activityCapActive(
						rowCapPruning,
						step.rowCount,
						limits.maxRows,
					)
					byteCapPruning = activityCapActive(
						byteCapPruning,
						step.dbBytes,
						limits.maxDbBytes,
					)
					if (!step.changed) break
					prune = {
						deleted: prune.deleted + step.deleted,
						watermark: step.watermark,
						generation: step.generation,
						changed: true,
						rowCount: step.rowCount,
						dbBytes: step.dbBytes,
					}
				}
			} catch (error) {
				note = messageOf(error)
			}
			if (stepNote !== undefined) note ??= stepNote
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

interface BurstState {
	reseeded: boolean
}

interface ShareCounter {
	key: string
	decoderId: string | null
	kind: string
	rows: number
	bytes: number
	oldestReceivedMs: number | null
}

/**
 * Per-share rows and record bytes (WG3 req 1.7). Changed only after a COMMIT: by committed
 * event ids, and by the rows a prune transaction deleted. `live` is false after a seed
 * failure; the session then runs oldest-first with no shares.
 */
class RetentionCounters {
	private readonly shares = new Map<string, ShareCounter>()
	private rowsTotal = 0
	live = false

	constructor(private readonly db: SqliteDatabase) {}

	seed(): void {
		const groups = scanRetentionGroups(this.db)
		this.shares.clear()
		this.rowsTotal = 0
		for (const group of groups) {
			const key = retentionShareKey(group.decoderId, group.kind)
			const existing = this.shares.get(key)
			if (existing) {
				existing.rows += group.rows
				existing.bytes += group.bytes
			} else
				this.shares.set(key, {
					key,
					decoderId: group.decoderId,
					kind: group.kind,
					rows: group.rows,
					bytes: group.bytes,
					oldestReceivedMs: null,
				})
			this.rowsTotal += group.rows
		}
		for (const share of this.shares.values())
			share.oldestReceivedMs = shareOldestReceivedMs(
				this.db,
				share.decoderId,
				share.kind,
			)
		this.live = true
	}

	drop(): void {
		this.shares.clear()
		this.rowsTotal = 0
		this.live = false
	}

	size(): number {
		return this.shares.size
	}

	totalRows(): number {
		return this.rowsTotal
	}

	get(key: string): ShareCounter | undefined {
		return this.shares.get(key)
	}

	usages(): { key: string; rows: number; bytes: number }[] {
		return [...this.shares.values()].map(share => ({
			key: share.key,
			rows: share.rows,
			bytes: share.bytes,
		}))
	}

	/** O(1) per committed row, no SQL; a new share's oldest row is its first commit. */
	addCommitted(
		rows: readonly BuiltActivityRow[],
		committedIndexes: readonly number[],
	): void {
		// The row that committed, by batch index: a skipped row may share its event id.
		for (const index of committedIndexes) {
			const row = rows[index]
			if (!row) continue
			const key = retentionShareKey(row.decoderId, row.kind)
			const share = this.shares.get(key)
			if (share) {
				share.rows += 1
				share.bytes += row.recordBytes
			} else
				this.shares.set(key, {
					key,
					decoderId: row.decoderId,
					kind: row.kind,
					rows: 1,
					bytes: row.recordBytes,
					oldestReceivedMs: row.receivedAtMs,
				})
			this.rowsTotal += 1
		}
	}

	/** After a prune COMMIT; refreshes oldest once per changed share. */
	subtract(deleted: readonly PrunedActivityRow[]): void {
		if (deleted.length === 0) return
		const changed = new Set<ShareCounter>()
		for (const row of deleted) {
			const share = this.shares.get(retentionShareKey(row.decoderId, row.kind))
			if (!share) continue
			share.rows = Math.max(0, share.rows - 1)
			share.bytes = Math.max(0, share.bytes - row.recordBytes)
			this.rowsTotal = Math.max(0, this.rowsTotal - 1)
			changed.add(share)
		}
		for (const share of changed) {
			if (share.rows === 0) {
				this.shares.delete(share.key)
				continue
			}
			try {
				share.oldestReceivedMs = shareOldestReceivedMs(
					this.db,
					share.decoderId,
					share.kind,
				)
			} catch {
				share.oldestReceivedMs = null
			}
		}
	}

	listed(): Pick<ActivityRetentionStats, "shares" | "sharesTruncated"> {
		const all = [...this.shares.values()].sort(
			(a, b) => b.rows - a.rows || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
		)
		const shares: ActivityRetentionShare[] = all
			.slice(0, RETENTION_SHARES_LISTED)
			.map(share => ({
				key: share.key,
				rows: share.rows,
				bytes: share.bytes,
				oldestReceivedAt:
					share.oldestReceivedMs === null
						? null
						: new Date(share.oldestReceivedMs).toISOString(),
			}))
		return { shares, sharesTruncated: all.length > RETENTION_SHARES_LISTED }
	}
}
