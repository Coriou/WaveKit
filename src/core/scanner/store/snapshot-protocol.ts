/**
 * Messages between ScannerPersistence (main thread) and the snapshot worker (WG11 req 3.5).
 * Both sides validate what they receive; an invalid message is a worker failure (main) or a
 * broken mirror (worker), never a crash of the core.
 */
import type { MirrorCounts, SnapshotHead } from "./snapshot-mirror.js"

/**
 * Journal lines in seq order. Every request but `commit` is acknowledged by one `applied`
 * carrying its `charged`, in order: the main thread's bound on queued messages.
 */
export interface LinesRequest {
	type: "lines"
	lines: string[]
	charged: number
}
export interface RemoveRequest {
	type: "remove"
	discoveries: string[]
	observations: string[]
	charged: number
}
/** Replace the mirror with a snapshot file text the main thread wrote, at `seq`. */
export interface ResetRequest {
	type: "reset"
	text: string
	seq: number
	charged: number
}
/** Build the text for the mirror's state now; hold it (one at a time) until `commit`. */
export interface SnapshotRequest {
	type: "snapshot"
	id: number
	head: SnapshotHead
	counts: MirrorCounts
	charged: number
}
/** Write the held text of `id` to `file` (tmp + fsync + rename). */
export interface CommitRequest {
	type: "commit"
	id: number
	file: string
}
export type SnapshotWorkerRequest =
	| LinesRequest
	| RemoveRequest
	| ResetRequest
	| SnapshotRequest
	| CommitRequest

export type SnapshotFailReason =
	| "diverged"
	| "broken"
	| "unknown-id"
	| "io"
	| "invalid-request"

export interface AppliedResponse {
	type: "applied"
	charged: number
}
export interface WrittenResponse {
	type: "written"
	id: number
	bytes: number
	buildMs: number
	writeMs: number
	heapUsedBytes: number
}
export interface FailedResponse {
	type: "failed"
	id: number
	reason: SnapshotFailReason
	heapUsedBytes: number
}
export type SnapshotWorkerResponse =
	| AppliedResponse
	| WrittenResponse
	| FailedResponse

/** The fields read from untrusted objects (all unknown until checked). */
interface Loose {
	type?: unknown
	id?: unknown
	lines?: unknown
	charged?: unknown
	discoveries?: unknown
	observations?: unknown
	text?: unknown
	seq?: unknown
	head?: unknown
	counts?: unknown
	file?: unknown
	lastSeq?: unknown
	savedAt?: unknown
	corrections?: unknown
	recordingOperations?: unknown
	aliases?: unknown
	bytes?: unknown
	buildMs?: unknown
	writeMs?: unknown
	heapUsedBytes?: unknown
	reason?: unknown
}

function isRecord(value: unknown): value is Loose {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
const nonNegInt = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const nonNeg = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0
const strings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every(x => typeof x === "string")
const FAIL_REASONS: ReadonlySet<string> = new Set([
	"diverged",
	"broken",
	"unknown-id",
	"io",
	"invalid-request",
])

function isHead(v: unknown): v is SnapshotHead {
	return (
		isRecord(v) &&
		nonNegInt(v.lastSeq) &&
		typeof v.savedAt === "string" &&
		(v.corrections === undefined || typeof v.corrections === "string") &&
		typeof v.recordingOperations === "string" &&
		(v.aliases === null || typeof v.aliases === "string")
	)
}

export function isSnapshotWorkerRequest(
	v: unknown,
): v is SnapshotWorkerRequest {
	if (!isRecord(v)) return false
	switch (v.type) {
		case "lines":
			return strings(v.lines) && nonNegInt(v.charged)
		case "remove":
			return (
				strings(v.discoveries) &&
				strings(v.observations) &&
				nonNegInt(v.charged)
			)
		case "reset":
			return (
				typeof v.text === "string" && nonNegInt(v.seq) && nonNegInt(v.charged)
			)
		case "snapshot":
			return (
				nonNegInt(v.id) &&
				isHead(v.head) &&
				isRecord(v.counts) &&
				nonNegInt(v.counts.discoveries) &&
				nonNegInt(v.counts.observations) &&
				nonNegInt(v.charged)
			)
		case "commit":
			return nonNegInt(v.id) && typeof v.file === "string"
		default:
			return false
	}
}

export function isSnapshotWorkerResponse(
	v: unknown,
): v is SnapshotWorkerResponse {
	if (!isRecord(v)) return false
	switch (v.type) {
		case "applied":
			return nonNegInt(v.charged)
		case "written":
			return (
				nonNegInt(v.id) &&
				nonNegInt(v.bytes) &&
				nonNeg(v.buildMs) &&
				nonNeg(v.writeMs) &&
				nonNegInt(v.heapUsedBytes)
			)
		case "failed":
			return (
				nonNegInt(v.id) &&
				typeof v.reason === "string" &&
				FAIL_REASONS.has(v.reason) &&
				nonNegInt(v.heapUsedBytes)
			)
		default:
			return false
	}
}
