import { Worker } from "node:worker_threads"
import { WaveKitError } from "../../../utils/errors.js"
import {
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

function errorFromWorker(code: string, message: string): Error {
	if (code === "ACTIVITY_QUERY_INVALID") return new ActivityQueryInvalidError(message)
	if (code === "ACTIVITY_QUERY_TIMEOUT") return new ActivityQueryTimeoutError(message)
	if (code === "ACTIVITY_RECORD_CORRUPT" || code === "ACTIVITY_QUERY_FAILED") {
		return new WaveKitError(message, code)
	}
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

	constructor(
		private readonly dbPath: string,
		private readonly execution: "inline" | "worker",
		private readonly workerUrl: URL,
		private readonly onEvent: ((event: ReaderHostEvent) => void) | undefined,
	) {}

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
			this.readyReject?.(asError(error))
			this.readyReject = null
			this.failPending(new ActivityReaderFailedError("Activity reader stopped"))
		})
		worker.on("exit", () => {
			if (this.worker !== worker) return
			this.worker = null
			const error = new ActivityReaderFailedError("Activity reader exited")
			this.readyReject?.(error)
			this.readyReject = null
			this.failPending(error)
		})
		return this.waitReady(worker, generation)
	}

	private waitReady(worker: Worker, generation: number): Promise<Worker> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.readyReject = null
				reject(new ActivityQueryTimeoutError("Activity reader did not start"))
			}, 5_000)
			timer.unref()
			this.readyReject = error => {
				clearTimeout(timer)
				reject(error)
			}
			const onMessage = (raw: unknown) => {
				if (!isRecord(raw) || raw["type"] !== "ready") return
				if (this.generation !== generation || this.worker !== worker) return
				clearTimeout(timer)
				this.readyReject = null
				worker.off("message", onMessage)
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
