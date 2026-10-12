/**
 * Thin reader-worker entry. Built flat to dist/query-worker.js.
 * All query logic lives in read.ts so tests can run it in-process.
 */
import { parentPort, workerData } from "node:worker_threads"
import { WaveKitError } from "../../../utils/errors.js"
import type { ReadRequest } from "./read.js"
import { runRead } from "./read.js"
import { withReadOnly } from "./sqlite.js"

interface WorkerPort {
	on(event: "message", listener: (message: unknown) => void): void
	postMessage(message: unknown): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms)
	})
}

export function startQueryWorker(
	port: WorkerPort,
	dbPath: string,
): void {
	port.on("message", message => {
		void handle(port, dbPath, message)
	})
	port.postMessage({ type: "ready" })
}

async function handle(
	port: WorkerPort,
	dbPath: string,
	message: unknown,
): Promise<void> {
	if (!isRecord(message) || message["type"] !== "query") return
	const id = message["id"]
	const generation = message["generation"]
	if (typeof id !== "number" || typeof generation !== "number") return
	const delayMs = message["delayMs"]
	try {
		if (typeof delayMs === "number" && delayMs > 0) await delay(delayMs)
		const request = message["request"] as ReadRequest
		const value = await withReadOnly(dbPath, db => runRead(db, request))
		port.postMessage({ type: "result", id, generation, ok: true, value })
	} catch (error) {
		const code = error instanceof WaveKitError ? error.code : "ACTIVITY_QUERY_FAILED"
		const text = error instanceof Error ? error.message : "Activity reader failed"
		port.postMessage({
			type: "result",
			id,
			generation,
			ok: false,
			code,
			message: text,
		})
	}
}

if (parentPort) {
	const data = workerData as { dbPath?: unknown } | undefined
	if (data && typeof data.dbPath === "string") {
		startQueryWorker(parentPort, data.dbPath)
	} else {
		parentPort.postMessage({
			type: "result",
			id: 0,
			generation: 0,
			ok: false,
			code: "ACTIVITY_QUERY_FAILED",
			message: "Activity reader is missing dbPath",
		})
	}
}
