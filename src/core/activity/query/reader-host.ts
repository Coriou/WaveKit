import { Worker } from "node:worker_threads"
import {
	activityRecordCorrupt,
	ActivityQueryClosedError,
	ActivityQueryInvalidError,
	ActivityQueryTimeoutError,
	ActivityReaderFailedError,
} from "./errors.js"
import type { ReadRequest, ReadResult } from "./read.js"
import { runRead } from "./read.js"
import { withReadOnly } from "./sqlite.js"

export interface ReaderHostEvent {
	type: "spawn" | "terminate"
	generation: number
}

interface Pending {
	generation: number
	settled: boolean
	resolve: (value: ReadResult) => void
	reject: (error: Error) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new ActivityReaderFailedError(String(error))
}

/** A reader that cannot start is a server fault, not a retryable timeout. */
function startupFailure(error: unknown): Error {
	if (
		error instanceof ActivityReaderFailedError ||
		error instanceof ActivityQueryClosedError
	) {
		return error
	}
	const message =
		error instanceof Error ? error.message : "Activity reader did not start"
	return new ActivityReaderFailedError(message)
}

function errorFromWorker(code: string, message: string): Error {
	if (code === "ACTIVITY_QUERY_INVALID") return new ActivityQueryInvalidError(message)
	if (code === "ACTIVITY_QUERY_TIMEOUT") return new ActivityQueryTimeoutError(message)
	if (code === "ACTIVITY_RECORD_CORRUPT") return activityRecordCorrupt(message)
	return new ActivityReaderFailedError(message)
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms)
	})
}

export class ReaderHost {
	private worker: Worker | null = null
	private generation = 0
	private readonly pending = new Map<number, Pending>()
	private nextId = 0
	private closed = false
	private readyReject: ((error: Error) => void) | null = null
	private activeTicket: object | null = null
	/** In-flight startup. Callers share it so a prewarm and a query spawn once. */
	private starting: Promise<Worker> | null = null

	constructor(
		private readonly dbPath: string,
		private readonly execution: "inline" | "worker",
		private readonly workerUrl: URL,
		private readonly onEvent: ((event: ReaderHostEvent) => void) | undefined,
		private readonly readyTimeoutMs = 5_000,
	) {}

	/**
	 * Resolves when a query can be posted. Inline mode is already ready.
	 * Worker startup uses `readyTimeoutMs` and is not the query deadline.
	 */
	ensureReady(): Promise<void> {
		if (this.closed) return Promise.reject(new ActivityQueryClosedError())
		if (this.execution === "inline") return Promise.resolve()
		try {
			return this.ensureWorker().then(() => undefined)
		} catch (error) {
			return Promise.reject(startupFailure(error))
		}
	}

	async execute(
		request: ReadRequest,
		delayMs: number,
		ticket: object,
	): Promise<ReadResult> {
		if (this.closed) throw new ActivityQueryClosedError()
		this.activeTicket = ticket
		if (this.execution === "inline") {
			if (delayMs > 0) await delay(delayMs)
			if (this.closed) throw new ActivityQueryClosedError()
			if (this.activeTicket !== ticket) throw new ActivityQueryTimeoutError()
			return withReadOnly(this.dbPath, db => runRead(db, request))
		}
		const worker = await this.ensureWorker()
		if (this.closed) throw new ActivityQueryClosedError()
		if (this.activeTicket !== ticket) throw new ActivityQueryTimeoutError()
		const id = ++this.nextId
		const generation = this.generation
		return new Promise((resolve, reject) => {
			const pending: Pending = {
				generation,
				settled: false,
				resolve: value => {
					if (pending.settled) return
					pending.settled = true
					resolve(value)
				},
				reject: error => {
					if (pending.settled) return
					pending.settled = true
					reject(error)
				},
			}
			this.pending.set(id, pending)
			try {
				worker.postMessage({
					type: "query",
					id,
					generation,
					delayMs,
					request,
				})
			} catch (error) {
				this.pending.delete(id)
				pending.reject(asError(error))
			}
		})
	}

	/** Deadline path: drop the ticket and, in worker mode, kill the reader. */
	invalidate(ticket: object): void {
		if (this.activeTicket !== ticket) return
		this.activeTicket = null
		if (this.execution === "inline") {
			this.onEvent?.({ type: "terminate", generation: this.generation })
			return
		}
		this.terminateWorker(new ActivityQueryTimeoutError())
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		this.activeTicket = null
		const worker = this.worker
		this.worker = null
		this.readyReject?.(new ActivityQueryClosedError())
		this.readyReject = null
		this.failPending(new ActivityQueryClosedError())
		if (worker) await worker.terminate()
	}

	private terminateWorker(error: Error): void {
		const worker = this.worker
		this.worker = null
		this.readyReject?.(error)
		this.readyReject = null
		this.failPending(error)
		this.onEvent?.({ type: "terminate", generation: this.generation })
		if (worker) void worker.terminate()
	}

	private failPending(error: Error): void {
		const pending = [...this.pending.values()]
		this.pending.clear()
		for (const item of pending) item.reject(error)
	}

	private ensureWorker(): Promise<Worker> {
		if (this.closed) return Promise.reject(new ActivityQueryClosedError())
		if (this.starting) return this.starting
		if (this.worker) return Promise.resolve(this.worker)
		const worker = new Worker(this.workerUrl, {
			workerData: { dbPath: this.dbPath },
		})
		this.worker = worker
		this.generation += 1
		const generation = this.generation
		this.onEvent?.({ type: "spawn", generation })
		worker.on("message", (raw: unknown) => {
			this.onMessage(raw)
		})
		worker.on("error", (error: unknown) => {
			if (this.worker !== worker) return
			this.worker = null
			const failure = startupFailure(error)
			this.readyReject?.(failure)
			this.readyReject = null
			this.failPending(failure)
		})
		worker.on("exit", () => {
			if (this.worker !== worker) return
			this.worker = null
			const error = new ActivityReaderFailedError("Activity reader exited")
			this.readyReject?.(error)
			this.readyReject = null
			this.failPending(error)
		})
		let starting: Promise<Worker>
		starting = this.waitReady(worker, generation).then(
			ready => {
				if (this.starting === starting) this.starting = null
				return ready
			},
			(error: Error) => {
				if (this.starting === starting) this.starting = null
				throw error
			},
		)
		this.starting = starting
		return starting
	}

	private waitReady(worker: Worker, generation: number): Promise<Worker> {
		return new Promise((resolve, reject) => {
			let settled = false
			const finish = (error?: Error): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				this.readyReject = null
				worker.off("message", onMessage)
				if (error) reject(error)
			}
			const timer = setTimeout(() => {
				if (settled || this.worker !== worker) return
				// Drop the handle before terminate so a late exit cannot reuse it.
				this.terminateWorker(
					new ActivityReaderFailedError("Activity reader did not start"),
				)
			}, this.readyTimeoutMs)
			timer.unref()
			this.readyReject = error => {
				finish(error)
			}
			const onMessage = (raw: unknown) => {
				if (!isRecord(raw) || raw["type"] !== "ready") return
				if (this.generation !== generation || this.worker !== worker) return
				finish()
				resolve(worker)
			}
			worker.on("message", onMessage)
		})
	}

	private onMessage(raw: unknown): void {
		if (!isRecord(raw) || raw["type"] !== "result") return
		const id = raw["id"]
		const generation = raw["generation"]
		if (typeof id !== "number" || typeof generation !== "number") return
		const pending = this.pending.get(id)
		if (!pending || pending.generation !== generation) return
		this.pending.delete(id)
		if (raw["ok"] === true) {
			pending.resolve(raw["value"] as ReadResult)
			return
		}
		const code = typeof raw["code"] === "string" ? raw["code"] : "ACTIVITY_QUERY_FAILED"
		const message =
			typeof raw["message"] === "string" ? raw["message"] : "Activity reader failed"
		pending.reject(errorFromWorker(code, message))
	}
}
