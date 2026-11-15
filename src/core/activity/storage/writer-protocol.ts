import type { ActivityLinkEvent, ActivityLinkOp } from "./contract.js"
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

/**
 * Unsolicited, after the facets covering index check (id 0): whether this open built it,
 * how long the build took, the failure that left the store without it, and the snapshot
 * after it (a build grows the file and the WAL, so the parent's byte figures refresh).
 */
interface IndexedActivityWorkerMessage {
	id: 0
	type: "indexed"
	built: boolean
	ms: number
	error?: string
	snapshot: ActivityWorkerSnapshot
}

/**
 * Unsolicited (id 0): recording links from the open-time work on the serial chain. A backfill
 * chunk's links (`reset` false), then, once the backfill is done, every link (`reset` true: the
 * parent's index is replaced). Write replies after it carry their own links.
 */
interface LinksActivityWorkerMessage {
	id: 0
	type: "links"
	reset: boolean
	events: ActivityLinkEvent[]
	/** Backfill progress: voice rows examined by this chunk; absent on the reset. */
	examined?: number
	/** Backfill progress: wall time of this chunk's transaction (ms). */
	ms?: number
	/** The backfill failed (it resumes from its cursor on the next open). */
	error?: string
}

interface ErrorActivityWorkerResponse {
	id: number
	type: "error"
	code: string
	message: string
	found?: string
	lockPath?: string
}

interface WriteActivityWorkerRequest {
	id: number
	type: "write"
	rows: BuiltActivityRow[]
	nowMs: number
	/** Link changes applied after the rows commit (links.ts applyActivityLinks). */
	links?: ActivityLinkOp[]
}

export type ActivityWorkerRequest =
	| OpenActivityWorkerRequest
	| WriteActivityWorkerRequest
	| { id: number; type: "checkpoint"; reason: "threshold" | "close" }
	| { id: number; type: "close" }

export type ActivityWorkerResponse =
	| ReadyActivityWorkerResponse
	| { id: number; type: "wrote"; result: WriterWorkResult }
	| { id: number; type: "checkpointed"; snapshot: ActivityWorkerSnapshot }
	| { id: number; type: "closed" }
	| SeededActivityWorkerMessage
	| IndexedActivityWorkerMessage
	| LinksActivityWorkerMessage
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
		return (
			Array.isArray(value["rows"]) &&
			typeof value["nowMs"] === "number" &&
			(value["links"] === undefined || Array.isArray(value["links"]))
		)
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
		type === "indexed" ||
		type === "links" ||
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
