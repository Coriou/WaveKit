import type { ActivityLimits } from "./limits.js"
import type { BuiltActivityRow } from "./row.js"
import type {
	ActivityWorkerSnapshot,
	WriterWorkResult,
} from "./writer-session.js"

interface OpenActivityWorkerRequest {
	id: number
	type: "open"
	dbPath: string
	lockPath: string
	limits: ActivityLimits
	failNextWrites: number
	throwNextWrites: number
	writeDelayMs: number
	/** Test seam: the worker waits this long after taking the lock, before opening. */
	openDelayMs?: number
	/** Test seam: the deferred seed task throws before it scans. */
	seedThrows?: boolean
}

interface ReadyActivityWorkerResponse {
	id: number
	type: "ready"
	created: boolean
	snapshot: ActivityWorkerSnapshot
}

/**
 * Unsolicited, after the deferred retention seed (id 0, never a request id): the snapshot with
 * the seeded shares, or with `effective: "oldest-first"` when the seed failed.
 */
interface SeededActivityWorkerMessage {
	id: 0
	type: "seeded"
	snapshot: ActivityWorkerSnapshot
}

interface ErrorActivityWorkerResponse {
	id: number
	type: "error"
	code: string
	message: string
	found?: string
	lockPath?: string
}

export type ActivityWorkerRequest =
	| OpenActivityWorkerRequest
	| { id: number; type: "write"; rows: BuiltActivityRow[]; nowMs: number }
	| { id: number; type: "checkpoint"; reason: "threshold" | "close" }
	| { id: number; type: "close" }

export type ActivityWorkerResponse =
	| ReadyActivityWorkerResponse
	| { id: number; type: "wrote"; result: WriterWorkResult }
	| { id: number; type: "checkpointed"; snapshot: ActivityWorkerSnapshot }
	| { id: number; type: "closed" }
	| SeededActivityWorkerMessage
	| ErrorActivityWorkerResponse

const REQUEST_TYPES = new Set(["open", "write", "checkpoint", "close"])

export function isActivityWorkerRequest(
	value: unknown,
): value is ActivityWorkerRequest {
	if (!isRecord(value)) return false
	if (typeof value["id"] !== "number" || !Number.isSafeInteger(value["id"]))
		return false
	const type = value["type"]
	if (typeof type !== "string" || !REQUEST_TYPES.has(type)) return false
	if (type === "open") {
		return (
			typeof value["dbPath"] === "string" &&
			typeof value["lockPath"] === "string" &&
			isRecord(value["limits"]) &&
			typeof value["failNextWrites"] === "number" &&
			typeof value["throwNextWrites"] === "number" &&
			typeof value["writeDelayMs"] === "number" &&
			(value["openDelayMs"] === undefined ||
				typeof value["openDelayMs"] === "number") &&
			(value["seedThrows"] === undefined ||
				typeof value["seedThrows"] === "boolean")
		)
	}
	if (type === "write")
		return Array.isArray(value["rows"]) && typeof value["nowMs"] === "number"
	if (type === "checkpoint")
		return value["reason"] === "threshold" || value["reason"] === "close"
	return true
}

export function isActivityWorkerResponse(
	value: unknown,
): value is ActivityWorkerResponse {
	if (!isRecord(value)) return false
	if (typeof value["id"] !== "number") return false
	const type = value["type"]
	return (
		type === "ready" ||
		type === "wrote" ||
		type === "checkpointed" ||
		type === "closed" ||
		type === "seeded" ||
		type === "error"
	)
}

export function requestId(value: unknown): number {
	if (!isRecord(value) || typeof value["id"] !== "number") return -1
	return value["id"]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
