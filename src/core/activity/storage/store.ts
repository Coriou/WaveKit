import { chmodSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import type {
	ActivityStoreHandle,
	ActivityStoreStats,
	AdmitResult,
	AnalogTransmissionAdmission,
	StoreIdentity,
} from "./contract.js"
import {
	ActivitySchemaMismatchError,
	ActivityStoreLockedError,
	ActivityUnavailableError,
	ActivityWriteTimeoutError,
	errnoCode,
} from "./errors.js"
import { ActivityIngress } from "./ingress.js"
import type { ActivityLimits } from "./limits.js"
import { resolveActivityLimits } from "./limits.js"
import type { ActivityLock } from "./lock.js"
import { acquireActivityLock, restrictPrivate } from "./lock.js"
import type { ActivityProbeResult } from "./probe.js"
import { openSqliteFile, probeActivityRuntime } from "./probe.js"
import type { BuiltActivityRow } from "./row.js"
import type { DecodeEnvelope } from "../types.js"
import type { Logger } from "../../../utils/logger.js"
import { isActivityWorkerResponse } from "./writer-protocol.js"
import type { ActivityWorkerResponse } from "./writer-protocol.js"
import type {
	ActivitySession,
	ActivityWorkerSnapshot,
	WriterWorkResult,
} from "./writer-session.js"
import { createActivitySession } from "./writer-session.js"

export interface OpenActivityStoreOptions {
	stateDir: string
	logger: Logger
	limits?: Partial<ActivityLimits>
	now?: () => number
	/** Production bundle resolves this next to dist/index.js. */
	workerUrl?: URL
	/** `inline` runs SQLite on the caller thread. Tests use it. */
	execution?: "thread" | "inline"
	/** Replaces the capability probe. A failure writes no state file. */
	probe?: () => Promise<ActivityProbeResult>
	/** Test seam: the next N write batches fail before SQLite is touched. */
	failNextWrites?: number
	/** Test seam: the next N write batches throw before SQLite is touched. */
	throwNextWrites?: number
	/** Test seam: the worker waits this long before applying a write. */
	writeDelayMs?: number
	openTimeoutMs?: number
	/** Acknowledgement budget for a write. Distinct from openTimeoutMs. */
	writeTimeoutMs?: number
}

interface OpenWorkerRequest {
	type: "open"
	dbPath: string
	lockPath: string
	limits: ActivityLimits
	failNextWrites: number
	throwNextWrites: number
	writeDelayMs: number
}

type WorkerRequestBody =
	| OpenWorkerRequest
	| { type: "write"; rows: BuiltActivityRow[]; nowMs: number }
	| { type: "checkpoint"; reason: "threshold" | "close" }
	| { type: "close" }

/**
 * Worker entry after esbuild flattens this module into dist/index.js.
 * Main adds activity-writer-worker.ts to scripts/build-file.mjs so the
 * file lands at dist/activity-writer-worker.js.
 */
export function defaultActivityWorkerUrl(): URL {
	return new URL("./activity-writer-worker.js", import.meta.url)
}

export async function openActivityStore(
	options: OpenActivityStoreOptions,
): Promise<ActivityStoreHandle> {
	const limits = resolveActivityLimits(options.limits)
	const failNextWrites = options.failNextWrites ?? 0
	const throwNextWrites = options.throwNextWrites ?? 0
	const writeDelayMs = options.writeDelayMs ?? 0
	const openTimeoutMs = options.openTimeoutMs ?? 5_000
	const writeTimeoutMs = options.writeTimeoutMs ?? 30_000
	const execution = options.execution ?? "thread"
	if (
		!Number.isSafeInteger(failNextWrites) ||
		failNextWrites < 0 ||
		!Number.isSafeInteger(throwNextWrites) ||
		throwNextWrites < 0 ||
		!Number.isSafeInteger(writeDelayMs) ||
		writeDelayMs < 0 ||
		!Number.isSafeInteger(openTimeoutMs) ||
		openTimeoutMs < 1 ||
		!Number.isSafeInteger(writeTimeoutMs) ||
		writeTimeoutMs < 1 ||
		(execution !== "thread" && execution !== "inline")
	)
		throw new ActivityUnavailableError("Invalid activity store options")
	const probe = options.probe ?? probeActivityRuntime
	const probed = await probe()
	if (!probed.ok) throw new ActivityUnavailableError(probed.reason)

	const activityDir = join(options.stateDir, "activity")
	await mkdir(activityDir, { recursive: true, mode: 0o700 })
	await restrictPrivate(activityDir, 0o700)
	const dbPath = join(activityDir, "activity.db")
	const lockPath = join(activityDir, "activity.lock.db")
	const now = options.now ?? (() => Date.now())
	if (execution === "inline") {
		const lock = await acquireActivityLock(lockPath)
		try {
			const db = await openSqliteFile(dbPath)
			let session: ActivitySession
			try {
				session = createActivitySession(
					db,
					dbPath,
					limits,
					failNextWrites,
					throwNextWrites,
					now,
				)
			} catch (error) {
				try {
					db.close()
				} catch {
					// The open error is reported below.
				}
				throw error
			}
			const store = new ActivityStore(
				dbPath,
				options.logger,
				limits,
				now,
				lock,
				session,
				undefined,
				session.snapshot(),
			)
			store.restrictFiles()
			return store
		} catch (error) {
			await lock.release()
			throw wrapOpenError(error)
		}
	}
	const client = await ActivityWriterClient.open(
		options.workerUrl ?? defaultActivityWorkerUrl(),
		dbPath,
		lockPath,
		limits,
		failNextWrites,
		throwNextWrites,
		writeDelayMs,
		openTimeoutMs,
		writeTimeoutMs,
		options.logger,
	)
	const store = new ActivityStore(
		dbPath,
		options.logger,
		limits,
		now,
		undefined,
		undefined,
		client,
		client.ready(),
	)
	store.restrictFiles()
	return store
}

class ActivityWriterClient {
	private readySnapshot: ActivityWorkerSnapshot | undefined
	private nextId = 1
	private exited = false
	private closing = false
	private gone: (() => void) | undefined
	private readonly pending = new Map<
		number,
		{
			resolve: (response: ActivityWorkerResponse) => void
			reject: (error: Error) => void
			timer: ReturnType<typeof setTimeout>
		}
	>()

	private constructor(
		private readonly worker: Worker,
		private readonly timeoutMs: number,
		private readonly writeTimeoutMs: number,
		private readonly logger: Logger,
	) {
		this.worker.on("message", (raw: unknown) => {
			this.onMessage(raw)
		})
		this.worker.on("error", error => {
			this.logger.error({ err: error }, "activity writer failed")
			this.failPending(
				error instanceof Error ? error.message : "activity writer failed",
			)
		})
		this.worker.on("exit", code => {
			if (this.closing) {
				this.failPending("activity writer exited")
				return
			}
			this.failPending(`activity writer exited (${code})`)
		})
	}

	static async open(
		workerUrl: URL,
		dbPath: string,
		lockPath: string,
		limits: ActivityLimits,
		failNextWrites: number,
		throwNextWrites: number,
		writeDelayMs: number,
		timeoutMs: number,
		writeTimeoutMs: number,
		logger: Logger,
	): Promise<ActivityWriterClient> {
		const worker = new Worker(workerUrl, { name: "activity-writer" })
		const client = new ActivityWriterClient(
			worker,
			timeoutMs,
			writeTimeoutMs,
			logger,
		)
		try {
			const response = await client.request(
				{
					type: "open",
					dbPath,
					lockPath,
					limits,
					failNextWrites,
					throwNextWrites,
					writeDelayMs,
				},
				timeoutMs,
			)
			if (response.type !== "ready")
				throw new ActivityUnavailableError(
					"activity writer did not become ready",
				)
			client.readySnapshot = response.snapshot
			return client
		} catch (error) {
			client.closing = true
			client.failPending("activity writer open failed")
			await worker.terminate()
			throw error
		}
	}

	ready(): ActivityWorkerSnapshot {
		if (!this.readySnapshot)
			throw new ActivityUnavailableError("activity writer is not ready")
		return this.readySnapshot
	}

	onGone(listener: () => void): void {
		this.gone = listener
	}

	write(
		rows: readonly BuiltActivityRow[],
		nowMs: number,
	): Promise<WriterWorkResult> {
		return this.request(
			{ type: "write", rows: [...rows], nowMs },
			this.writeTimeoutMs,
			() => new ActivityWriteTimeoutError(),
		).then(response => {
			if (response.type !== "wrote")
				throw new ActivityUnavailableError(
					"activity writer write was not acknowledged",
				)
			return response.result
		})
	}

	checkpoint(reason: "threshold" | "close"): Promise<ActivityWorkerSnapshot> {
		return this.request({ type: "checkpoint", reason }, this.timeoutMs).then(
			response => {
				if (response.type !== "checkpointed")
					throw new ActivityUnavailableError(
						"activity writer checkpoint was not acknowledged",
					)
				return response.snapshot
			},
		)
	}

	async close(): Promise<void> {
		this.closing = true
		try {
			if (!this.exited) {
				const response = await this.request({ type: "close" }, this.timeoutMs)
				if (response.type !== "closed")
					throw new ActivityUnavailableError("activity writer did not close")
			}
		} finally {
			await this.worker.terminate()
			this.exited = true
		}
	}

	private request(
		body: WorkerRequestBody,
		timeoutMs: number,
		timeoutError: () => Error = () =>
			new ActivityUnavailableError("activity writer timed out"),
	): Promise<ActivityWorkerResponse> {
		if (this.exited)
			return Promise.reject(
				new ActivityUnavailableError("activity writer is gone"),
			)
		const id = this.nextId
		this.nextId += 1
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(timeoutError())
			}, timeoutMs)
			this.pending.set(id, { resolve, reject, timer })
			this.worker.postMessage({ ...body, id })
		})
	}

	private onMessage(raw: unknown): void {
		if (!isActivityWorkerResponse(raw)) return
		const waiter = this.pending.get(raw.id)
		if (!waiter) return
		clearTimeout(waiter.timer)
		this.pending.delete(raw.id)
		if (raw.type === "error") waiter.reject(errorFromResponse(raw))
		else waiter.resolve(raw)
	}

	private failPending(message: string): void {
		if (!this.exited) {
			this.exited = true
			this.gone?.()
		}
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer)
			waiter.reject(new ActivityUnavailableError(message))
		}
		this.pending.clear()
	}
}

class ActivityStore implements ActivityStoreHandle {
	readonly dbPath: string
	private readonly ingress: ActivityIngress
	private readonly listeners = new Set<(identity: StoreIdentity) => void>()
	private identityCache: StoreIdentity
	private cursorKeyHex: string
	private dbBytes: number
	private walBytes: number
	private rowCount: number
	private oldestReceivedAt: string | null
	private committed = 0
	private duplicates = 0
	private flushing = false
	private needsFlush = false
	private writerState: "running" | "stopped" = "running"
	private stopped = false
	private draining = false
	private batchTimer: ReturnType<typeof setTimeout> | undefined
	private pauseTimer: ReturnType<typeof setTimeout> | undefined
	private gapTimer: ReturnType<typeof setTimeout> | undefined
	private flight: Promise<void> | undefined
	private closing: Promise<void> | undefined

	constructor(
		dbPath: string,
		private readonly logger: Logger,
		private readonly limits: ActivityLimits,
		private readonly now: () => number,
		private readonly lock: ActivityLock | undefined,
		private readonly inline: ActivitySession | undefined,
		private readonly threaded: ActivityWriterClient | undefined,
		snapshot: ActivityWorkerSnapshot,
	) {
		this.dbPath = dbPath
		this.ingress = new ActivityIngress(limits, now, logger)
		this.identityCache = snapshot.identity
		this.cursorKeyHex = snapshot.cursorKeyHex
		this.dbBytes = snapshot.dbBytes
		this.walBytes = snapshot.walBytes
		this.rowCount = snapshot.rows
		this.oldestReceivedAt = snapshot.oldestReceivedAt
		this.ingress.paused = snapshot.paused
		this.threaded?.onGone(() => {
			this.onWriterGone()
		})
	}

	identity(): StoreIdentity {
		return { ...this.identityCache }
	}

	cursorKey(): Buffer {
		return Buffer.from(this.cursorKeyHex, "hex")
	}

	onCommit(listener: (identity: StoreIdentity) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	admit(envelope: DecodeEnvelope): AdmitResult {
		const result = this.ingress.admit(envelope)
		if (result.admitted) {
			this.onQueued()
			if (!this.ingress.hasOpenEpisode()) this.clearGapTimer()
		} else if (
			result.reason !== "telemetry" &&
			result.reason !== "closed" &&
			result.reason !== "coalesced"
		) {
			this.armGapTimer()
		}
		return result
	}

	admitTransmission(input: AnalogTransmissionAdmission): AdmitResult {
		const result = this.ingress.admitTransmission(input)
		if (result.admitted) {
			this.onQueued()
			if (!this.ingress.hasOpenEpisode()) this.clearGapTimer()
		} else if (
			result.reason !== "telemetry" &&
			result.reason !== "closed" &&
			result.reason !== "coalesced"
		) {
			this.armGapTimer()
		}
		return result
	}

	stats(): ActivityStoreStats {
		return {
			admitted: this.ingress.admitted,
			committed: this.committed,
			duplicates: this.duplicates,
			dropped: {
				"rate-limited": this.ingress.dropped["rate-limited"],
				"queue-full": this.ingress.dropped["queue-full"],
				"store-paused": this.ingress.dropped["store-paused"],
				"write-failed": this.ingress.dropped["write-failed"],
				closed: this.ingress.dropped.closed,
			},
			excludedTelemetry: this.ingress.excludedTelemetry,
			coalescedPositions: this.ingress.coalescedPositions,
			queueDepth: this.ingress.queueDepth(),
			queueBytes: this.ingress.queueBytesTotal(),
			dbBytes: this.dbBytes,
			walBytes: this.walBytes,
			rows: this.rowCount,
			oldestReceivedAt: this.oldestReceivedAt,
			pruneWatermark: this.identityCache.pruneWatermark,
			paused: this.ingress.paused,
			writer: this.writerState,
		}
	}

	close(): Promise<void> {
		if (!this.closing) this.closing = this.shutdown()
		return this.closing
	}

	restrictFiles(): void {
		for (const suffix of ["", "-wal", "-shm"]) {
			const path = `${this.dbPath}${suffix}`
			try {
				chmodSync(path, 0o600)
			} catch (error) {
				if (errnoCode(error) !== "ENOENT")
					this.logger.warn(
						{ err: error, path },
						"activity file mode was not restricted",
					)
			}
		}
	}

	private onWriterGone(): void {
		if (this.stopped) return
		this.writerState = "stopped"
		this.stopped = true
		this.nackInFlight()
		this.ingress.markClosed()
		this.clearBatchTimer()
		this.clearPause()
		this.clearGapTimer()
		this.logger.error("activity writer stopped")
	}

	private stopForWriteTimeout(): void {
		if (this.writerState === "stopped") return
		this.writerState = "stopped"
		this.stopped = true
		this.ingress.forgetInFlight()
		this.ingress.markClosed()
		this.clearBatchTimer()
		this.clearPause()
		this.clearGapTimer()
		this.logger.error("activity write timed out")
	}

	private onQueued(): void {
		if (this.stopped) return
		if (this.shouldFlushSoon() || this.limits.batchWindowMs === 0)
			this.flushNow()
		else this.armTimer()
	}

	private shouldFlushSoon(): boolean {
		return (
			this.ingress.pendingCount() >= this.limits.batchMaxItems ||
			this.ingress.pendingBytes() >= this.limits.batchMaxBytes
		)
	}

	private flushNow(): void {
		this.clearBatchTimer()
		if (this.inline) this.flushInline(false)
		else this.kick(false)
	}

	private flushInline(force: boolean): boolean {
		const session = this.inline
		if (!session) return false
		if (this.flushing) {
			this.needsFlush = true
			return true
		}
		this.flushing = true
		let ok = true
		try {
			for (;;) {
				this.needsFlush = false
				const batch = this.ingress.takeBatch(
					this.limits.batchMaxItems,
					this.limits.batchMaxBytes,
				)
				if (batch.length === 0) break
				let result: WriterWorkResult
				try {
					result = session.write(batch, this.now())
				} catch (error) {
					if (!this.stopped) {
						this.nackInFlight()
						this.logger.error({ err: error }, "activity write failed")
						if (!this.draining) this.armTimer()
					}
					ok = false
					break
				}
				if (!result.ok) {
					this.nackInFlight()
					this.logger.error({ err: result.message }, "activity write failed")
					if (!this.draining && !this.stopped) this.armTimer()
					ok = false
					break
				}
				this.apply(batch, result)
				this.restrictFiles()
				if (force || this.needsFlush || this.shouldFlushSoon()) continue
				if (!this.stopped && this.ingress.pendingCount() > 0) this.armTimer()
				break
			}
		} finally {
			this.flushing = false
		}
		return ok
	}

	private kick(force: boolean): void {
		if (this.flushing) {
			this.needsFlush = true
			return
		}
		this.flushing = true
		this.flight = this.pump(force)
		void this.flight.catch(error => {
			this.logger.error({ err: error }, "activity writer pump failed")
		})
	}

	private async pump(force: boolean): Promise<void> {
		let ok = true
		try {
			for (;;) {
				this.needsFlush = false
				const step = await this.flushOne()
				if (step === "failed") {
					ok = false
					break
				}
				if (step === "empty") break
				if (force || this.needsFlush || this.shouldFlushSoon()) continue
				if (!this.stopped && this.ingress.pendingCount() > 0) this.armTimer()
				break
			}
		} finally {
			this.flushing = false
			this.flight = undefined
			if (ok && !this.stopped && (this.needsFlush || this.shouldFlushSoon()))
				this.kick(false)
		}
	}

	private async flushOne(): Promise<"wrote" | "empty" | "failed"> {
		const client = this.threaded
		if (!client) return "empty"
		const batch = this.ingress.takeBatch(
			this.limits.batchMaxItems,
			this.limits.batchMaxBytes,
		)
		if (batch.length === 0) return "empty"
		try {
			const result = await client.write(batch, this.now())
			if (!result.ok) {
				this.nackInFlight()
				this.logger.error({ err: result.message }, "activity write failed")
				if (!this.draining && !this.stopped) this.armTimer()
				return "failed"
			}
			this.apply(batch, result)
			this.restrictFiles()
			return "wrote"
		} catch (error) {
			if (error instanceof ActivityWriteTimeoutError) {
				this.stopForWriteTimeout()
				return "failed"
			}
			if (this.stopped) return "failed"
			this.nackInFlight()
			this.logger.error({ err: error }, "activity write failed")
			if (!this.draining) this.armTimer()
			return "failed"
		}
	}

	private apply(
		batch: readonly BuiltActivityRow[],
		result: Extract<WriterWorkResult, { ok: true }>,
	): void {
		if (result.note !== undefined)
			this.logger.warn({ err: result.note }, "activity retention step failed")
		this.ingress.noteSkipped(batch, result.commit.writeFailedEventIds)
		const done = new Set<string>([
			...result.commit.committedEventIds,
			...result.commit.duplicateEventIds,
		])
		this.ingress.ack(done)
		this.committed += result.commit.committed
		this.duplicates += result.commit.duplicates
		this.adopt(result.snapshot)
		this.publish()
		if (this.ingress.paused) this.armPause()
		else this.clearPause()
	}

	private adopt(snapshot: ActivityWorkerSnapshot): void {
		const wasPaused = this.ingress.paused
		this.identityCache = snapshot.identity
		this.dbBytes = snapshot.dbBytes
		this.walBytes = snapshot.walBytes
		this.rowCount = snapshot.rows
		this.oldestReceivedAt = snapshot.oldestReceivedAt
		this.ingress.paused = snapshot.paused
		if (snapshot.paused && !wasPaused)
			this.logger.warn({ walBytes: snapshot.walBytes }, "activity store paused")
	}

	private publish(): void {
		const identity = this.identity()
		for (const listener of [...this.listeners]) {
			try {
				listener(identity)
			} catch (error) {
				this.logger.error({ err: error }, "activity commit listener failed")
			}
		}
	}

	private nackInFlight(): void {
		this.ingress.nack()
		this.armGapTimer()
	}

	private armGapTimer(): void {
		if (this.gapTimer || this.stopped || this.draining) return
		const due = this.ingress.gapQuietDueAt()
		if (due === undefined) return
		this.scheduleGapTimer(Math.max(0, due - this.now()))
	}

	private onGapTimer(): void {
		this.gapTimer = undefined
		if (this.stopped || this.draining) return
		const due = this.ingress.gapQuietDueAt()
		if (due === undefined) return
		const remaining = due - this.now()
		if (remaining > 0) {
			this.scheduleGapTimer(remaining)
			return
		}
		if (this.ingress.stageOpenEpisode(this.now())) {
			this.onQueued()
			return
		}
		if (this.ingress.hasOpenEpisode())
			this.scheduleGapTimer(this.limits.gapQuietMs)
	}

	private scheduleGapTimer(waitMs: number): void {
		this.gapTimer = setTimeout(() => {
			this.onGapTimer()
		}, waitMs)
		this.gapTimer.unref()
	}

	private armTimer(): void {
		if (this.batchTimer || this.stopped) return
		this.batchTimer = setTimeout(() => {
			this.batchTimer = undefined
			this.flushNow()
		}, this.limits.batchWindowMs)
		this.batchTimer.unref()
	}

	private armPause(): void {
		if (this.pauseTimer || this.stopped) return
		this.pauseTimer = setTimeout(() => {
			this.pauseTimer = undefined
			void this.retryPause()
		}, this.limits.pauseRetryMs)
		this.pauseTimer.unref()
	}

	private async retryPause(): Promise<void> {
		if (this.stopped) return
		try {
			const snapshot = this.inline
				? this.inline.checkpoint("threshold")
				: await this.threaded?.checkpoint("threshold")
			if (!snapshot) return
			this.adopt(snapshot)
			if (!this.ingress.paused) {
				this.clearPause()
				if (this.ingress.pendingCount() > 0) this.onQueued()
				return
			}
		} catch (error) {
			this.logger.warn({ err: error }, "activity pause checkpoint failed")
		}
		this.armPause()
	}

	private clearBatchTimer(): void {
		if (!this.batchTimer) return
		clearTimeout(this.batchTimer)
		this.batchTimer = undefined
	}

	private clearPause(): void {
		if (!this.pauseTimer) return
		clearTimeout(this.pauseTimer)
		this.pauseTimer = undefined
	}

	private clearGapTimer(): void {
		if (!this.gapTimer) return
		clearTimeout(this.gapTimer)
		this.gapTimer = undefined
	}

	private async shutdown(): Promise<void> {
		this.writerState = "stopped"
		this.stopped = true
		this.draining = true
		this.ingress.markClosed()
		this.clearBatchTimer()
		this.clearPause()
		this.clearGapTimer()
		try {
			if (this.flight) await this.flight
			const deadline = Date.now() + this.limits.closeTimeoutMs
			const drain = async (): Promise<void> => {
				while (this.ingress.hasPending() && Date.now() < deadline) {
					if (this.inline) {
						if (!this.flushInline(true)) break
					} else {
						const step = await this.flushOne()
						if (step !== "wrote") break
					}
				}
			}
			this.ingress.stageOpenEpisode(this.now())
			await drain()
			this.ingress.stageOpenEpisode(this.now())
			await drain()
			this.ingress.abandonQueued()
			try {
				const snapshot = this.inline
					? this.inline.checkpoint("close")
					: await this.threaded?.checkpoint("close")
				if (snapshot) this.adopt(snapshot)
			} catch (error) {
				this.logger.warn({ err: error }, "activity close checkpoint failed")
			}
			try {
				if (this.inline) this.inline.close()
				else await this.threaded?.close()
			} catch (error) {
				this.logger.warn({ err: error }, "activity writer close failed")
			}
		} finally {
			this.draining = false
			await this.lock?.release()
		}
	}
}

function errorFromResponse(
	response: Extract<ActivityWorkerResponse, { type: "error" }>,
): Error {
	if (response.code === "ACTIVITY_SCHEMA_MISMATCH")
		return new ActivitySchemaMismatchError(response.found ?? "missing")
	if (response.code === "ACTIVITY_STORE_LOCKED")
		return new ActivityStoreLockedError(response.lockPath ?? "")
	return new ActivityUnavailableError(response.message)
}

function wrapOpenError(error: unknown): Error {
	if (
		error instanceof ActivityUnavailableError ||
		error instanceof ActivitySchemaMismatchError ||
		error instanceof ActivityStoreLockedError
	)
		return error
	const message = error instanceof Error ? error.message : String(error)
	return new ActivityUnavailableError(
		message,
		error instanceof Error ? error : undefined,
	)
}
