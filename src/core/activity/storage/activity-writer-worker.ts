/**
 * worker_threads entry (built to dist/activity-writer-worker.js).
 * A thin loop: messages are serialized, and every write goes through
 * createActivitySession. This file must not import the store.
 */
import { parentPort } from "node:worker_threads"
import {
	ActivitySchemaMismatchError,
	ActivityUnavailableError,
} from "./errors.js"
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
		post({ id: raw.id, type: "closed" })
	} catch (error) {
		if (raw.type === "open") {
			session?.close()
			session = undefined
		}
		post(errorResponse(raw.id, error))
	}
}

async function openSession(
	request: Extract<ActivityWorkerRequest, { type: "open" }>,
): Promise<void> {
	if (session)
		throw new ActivityUnavailableError("activity writer is already open")
	const db = await openSqliteFile(request.dbPath)
	try {
		session = createActivitySession(
			db,
			request.dbPath,
			request.limits as ActivityLimits,
			request.failNextWrites,
		)
	} catch (error) {
		try {
			db.close()
		} catch {
			// The open error is the one the parent needs.
		}
		throw error
	}
	post({
		id: request.id,
		type: "ready",
		created: session.created,
		snapshot: session.snapshot(),
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
	return {
		id,
		type: "error",
		code: "ACTIVITY_UNAVAILABLE",
		message: error instanceof Error ? error.message : String(error),
	}
}

function post(message: ActivityWorkerResponse): void {
	port?.postMessage(message)
}
