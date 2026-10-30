/**
 * worker_threads entry (built to dist/activity-writer-worker.js).
 * A thin loop: messages are serialized, and every write goes through
 * createActivitySession. This file must not import the store.
 */
import { parentPort } from "node:worker_threads"
import {
	ActivitySchemaMismatchError,
	ActivityStoreLockedError,
	ActivityUnavailableError,
} from "./errors.js"
import { acquireActivityLock } from "./lock.js"
import type { ActivityLock } from "./lock.js"
import { openSqliteFile } from "./probe.js"
import { isActivityWorkerRequest, requestId } from "./writer-protocol.js"
import type {
	ActivityWorkerRequest,
	ActivityWorkerResponse,
} from "./writer-protocol.js"
import { createActivitySession } from "./writer-session.js"
import type { ActivitySession } from "./writer-session.js"
import type { ActivityLimits } from "./limits.js"

const port = parentPort
if (!port) {
	throw new ActivityUnavailableError(
		"activity-writer must run inside a worker thread",
	)
}

let session: ActivitySession | undefined
let lock: ActivityLock | undefined
let writeDelayMs = 0
let chain: Promise<void> = Promise.resolve()

port.on("message", (raw: unknown) => {
	chain = chain
		.then(() => dispatch(raw))
		.catch(error => {
			post({
				id: requestId(raw),
				type: "error",
				code: "ACTIVITY_UNAVAILABLE",
				message: error instanceof Error ? error.message : String(error),
			})
		})
})

async function dispatch(raw: unknown): Promise<void> {
	if (!isActivityWorkerRequest(raw))
		throw new ActivityUnavailableError("invalid activity writer message")
	try {
		if (raw.type === "open") {
			await openSession(raw)
			return
		}
		if (!session)
			throw new ActivityUnavailableError("activity writer is not open")
		if (raw.type === "write") {
			if (writeDelayMs > 0) await delay(writeDelayMs)
			post({
				id: raw.id,
				type: "wrote",
				result: session.write(raw.rows, raw.nowMs),
			})
			return
		}
		if (raw.type === "checkpoint") {
			post({
				id: raw.id,
				type: "checkpointed",
				snapshot: session.checkpoint(raw.reason),
			})
			return
		}
		session.close()
		session = undefined
		await releaseLock()
		post({ id: raw.id, type: "closed" })
	} catch (error) {
		if (raw.type === "open") {
			try {
				session?.close()
			} catch {
				// The open error is the one the parent needs.
			}
			session = undefined
			await releaseLock()
		}
		post(errorResponse(raw.id, error))
	}
}

async function openSession(
	request: Extract<ActivityWorkerRequest, { type: "open" }>,
): Promise<void> {
	if (session)
		throw new ActivityUnavailableError("activity writer is already open")
	writeDelayMs = request.writeDelayMs
	lock = await acquireActivityLock(request.lockPath)
	if (request.openDelayMs !== undefined && request.openDelayMs > 0)
		await delay(request.openDelayMs)
	const db = await openSqliteFile(request.dbPath)
	try {
		session = createActivitySession(
			db,
			request.dbPath,
			request.limits as ActivityLimits,
			request.failNextWrites,
			request.throwNextWrites,
			Date.now,
			{ deferSeed: true },
		)
	} catch (error) {
		try {
			db.close()
		} catch {
			// The open error is the one the parent needs.
		}
		await releaseLock()
		throw error
	}
	post({
		id: request.id,
		type: "ready",
		created: session.created,
		snapshot: session.snapshot(),
	})
	// The deferred seed scan is the next task on the serial chain: a write queued behind
	// it finds the counters seeded. A seed failure is handled inside the session
	// (oldest-first until reopen); any other throw is caught below.
	// The parent cached the ready snapshot (no shares yet): the seeded one replaces its
	// retention block without waiting for a write.
	const opened = session
	const seedThrows = request.seedThrows === true
	chain = chain
		.then(() => {
			if (session !== opened) return
			if (seedThrows) throw new ActivityUnavailableError("injected seed throw")
			opened.seedCounters()
			post({ id: 0, type: "seeded", snapshot: opened.snapshot() })
		})
		.catch(() => {
			// Never reject the chain: the next message must still dispatch. The counters stay
			// unseeded and the next write seeds them (write() seeds first).
		})
}

function errorResponse(id: number, error: unknown): ActivityWorkerResponse {
	if (error instanceof ActivitySchemaMismatchError) {
		return {
			id,
			type: "error",
			code: "ACTIVITY_SCHEMA_MISMATCH",
			message: error.message,
			found: error.found,
		}
	}
	if (error instanceof ActivityStoreLockedError) {
		return {
			id,
			type: "error",
			code: "ACTIVITY_STORE_LOCKED",
			message: error.message,
			lockPath: error.lockPath,
		}
	}
	return {
		id,
		type: "error",
		code: "ACTIVITY_UNAVAILABLE",
		message: error instanceof Error ? error.message : String(error),
	}
}

async function releaseLock(): Promise<void> {
	const held = lock
	lock = undefined
	if (!held) return
	await held.release()
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms)
	})
}

function post(message: ActivityWorkerResponse): void {
	port?.postMessage(message)
}
