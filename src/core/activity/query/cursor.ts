import { createHmac, timingSafeEqual } from "node:crypto"
import { canonicalJson } from "./canonical.js"
import {
	ActivityCursorGapError,
	ActivityCursorInvalidError,
	ActivitySnapshotResetError,
} from "./errors.js"
import {
	cursorBehindWatermark,
	formatSeq,
	holeStateOf,
	parseSeq,
	snapshotLowerBoundPassed,
} from "./seq.js"
import type { StoreIdentity } from "../storage/contract.js"

export const QUERY_VERSION = 1
export const CURSOR_VERSION = 1

export interface CursorPayload {
	v: typeof CURSOR_VERSION
	storeUUID: string
	restoreGeneration: number
	queryVersion: typeof QUERY_VERSION
	queryHash: string
	order: "asc" | "desc"
	L?: string
	H?: string
	lastSeq: string
	pruneGeneration: number
	/** WG3 hole generation. Tokens issued before WG3 omit it: read as 0. */
	hg: number
	expiresAt: string
}

export interface IssuedCursor {
	token: string
	expiresAt: string
	lastSeq: string
}

const KEYS = new Set([
	"v",
	"storeUUID",
	"restoreGeneration",
	"queryVersion",
	"queryHash",
	"order",
	"L",
	"H",
	"lastSeq",
	"pruneGeneration",
	"hg",
	"expiresAt",
])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireKey(key: Buffer): Buffer {
	if (key.length !== 32) {
		throw new ActivityCursorInvalidError("Activity cursor key is unavailable")
	}
	return key
}

export function signCursor(payload: CursorPayload, key: Buffer): string {
	const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url")
	const mac = createHmac("sha256", requireKey(key)).update(body).digest()
	return `${body}.${mac.toString("base64url")}`
}

function safeMacEqual(left: Buffer, right: Buffer): boolean {
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

function readPayload(body: string): Record<string, unknown> {
	let json: string
	try {
		json = Buffer.from(body, "base64url").toString("utf8")
	} catch {
		throw new ActivityCursorInvalidError()
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(json) as unknown
	} catch {
		throw new ActivityCursorInvalidError()
	}
	if (!isRecord(parsed)) throw new ActivityCursorInvalidError()
	for (const key of Object.keys(parsed)) {
		if (!KEYS.has(key)) throw new ActivityCursorInvalidError()
	}
	return parsed
}

function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key]
	if (typeof value !== "string" || value.length === 0) {
		throw new ActivityCursorInvalidError()
	}
	return value
}

function readOptionalSeq(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	if (!(key in record)) return undefined
	const value = readString(record, key)
	parseSeq(value)
	return value
}

function readGeneration(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ActivityCursorInvalidError()
	}
	return value
}

function decode(token: string, key: Buffer): CursorPayload {
	if (token.length === 0 || token.length > 8192) {
		throw new ActivityCursorInvalidError()
	}
	const dot = token.indexOf(".")
	if (dot <= 0 || dot !== token.lastIndexOf(".")) {
		throw new ActivityCursorInvalidError()
	}
	const body = token.slice(0, dot)
	const macText = token.slice(dot + 1)
	if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(macText)) {
		throw new ActivityCursorInvalidError()
	}
	const presented = Buffer.from(macText, "base64url")
	const expected = createHmac("sha256", requireKey(key)).update(body).digest()
	if (!safeMacEqual(presented, expected)) throw new ActivityCursorInvalidError()
	const record = readPayload(body)
	if (
		record["v"] !== CURSOR_VERSION ||
		record["queryVersion"] !== QUERY_VERSION
	) {
		throw new ActivityCursorInvalidError()
	}
	const order = record["order"]
	if (order !== "asc" && order !== "desc")
		throw new ActivityCursorInvalidError()
	const queryHash = readString(record, "queryHash")
	if (!/^[a-f0-9]{64}$/.test(queryHash)) throw new ActivityCursorInvalidError()
	const expiresAt = readString(record, "expiresAt")
	if (!Number.isFinite(Date.parse(expiresAt)))
		throw new ActivityCursorInvalidError()
	const lastSeq = readString(record, "lastSeq")
	parseSeq(lastSeq)
	const payload: CursorPayload = {
		v: CURSOR_VERSION,
		storeUUID: readString(record, "storeUUID"),
		restoreGeneration: readGeneration(record["restoreGeneration"]),
		queryVersion: QUERY_VERSION,
		queryHash,
		order,
		lastSeq,
		pruneGeneration: readGeneration(record["pruneGeneration"]),
		hg: "hg" in record ? readGeneration(record["hg"]) : 0,
		expiresAt,
	}
	const low = readOptionalSeq(record, "L")
	const high = readOptionalSeq(record, "H")
	if (low !== undefined) payload.L = low
	if (high !== undefined) payload.H = high
	if (payload.L !== undefined && payload.H !== undefined) {
		if (parseSeq(payload.H) < parseSeq(payload.L)) {
			throw new ActivityCursorInvalidError()
		}
	}
	if (
		payload.H !== undefined &&
		parseSeq(payload.lastSeq) > parseSeq(payload.H)
	) {
		throw new ActivityCursorInvalidError()
	}
	return payload
}

export interface VerifyCursorInput {
	token: string
	key: Buffer
	identity: StoreIdentity
	queryHash: string
	order: "asc" | "desc"
	now: number
	mode: "page" | "replay"
}

/**
 * Page tokens reset with 409 when the captured lower bound is stale, and with
 * 410 when the continuation seq itself is below the prune watermark. A cursor
 * sitting exactly on the watermark has already delivered that seq.
 * Replay cursors use the gap rule only (live follow must survive earlier prunes).
 */
export function verifyCursor(input: VerifyCursorInput): CursorPayload {
	const payload = decode(input.token, input.key)
	if (
		payload.storeUUID !== input.identity.storeUuid ||
		payload.restoreGeneration !== input.identity.restoreGeneration
	) {
		throw new ActivitySnapshotResetError(
			"store-changed",
			"Activity store changed",
		)
	}
	if (payload.queryHash !== input.queryHash || payload.order !== input.order) {
		throw new ActivitySnapshotResetError(
			"query-changed",
			"Activity query changed",
		)
	}
	if (Date.parse(payload.expiresAt) <= input.now) {
		throw new ActivitySnapshotResetError(
			"cursor-expired",
			"Activity cursor expired",
		)
	}
	const watermark = parseSeq(input.identity.pruneWatermark)
	const lastSeq = parseSeq(payload.lastSeq)
	if (input.mode === "page") {
		if (payload.L === undefined || payload.H === undefined) {
			throw new ActivityCursorInvalidError()
		}
		const low = parseSeq(payload.L)
		const high = parseSeq(payload.H)
		if (lastSeq <= low || lastSeq > high) throw new ActivityCursorInvalidError()
		if (cursorBehindWatermark(lastSeq, watermark)) {
			throw new ActivityCursorGapError()
		}
		if (snapshotLowerBoundPassed(low, watermark)) {
			throw new ActivitySnapshotResetError(
				"snapshot-reset",
				"Activity snapshot lower bound moved",
			)
		}
		if (holeStateOf(input.identity).generation > payload.hg) {
			throw new ActivitySnapshotResetError(
				"snapshot-reset",
				"Activity snapshot lost rows to a hole",
			)
		}
		return payload
	}
	if (cursorBehindWatermark(lastSeq, watermark))
		throw new ActivityCursorGapError()
	return payload
}

export interface CursorIssueInput {
	key: Buffer
	identity: StoreIdentity
	queryHash: string
	order: "asc" | "desc"
	lastSeq: bigint
	low?: bigint
	high?: bigint
	/** Hole generation read with the rows this cursor follows. Defaults to 0. */
	holeGeneration?: number
	expiresAtMs: number
}

export function issueCursor(input: CursorIssueInput): IssuedCursor {
	const expiresAt = new Date(input.expiresAtMs).toISOString()
	const payload: CursorPayload = {
		v: CURSOR_VERSION,
		storeUUID: input.identity.storeUuid,
		restoreGeneration: input.identity.restoreGeneration,
		queryVersion: QUERY_VERSION,
		queryHash: input.queryHash,
		order: input.order,
		lastSeq: formatSeq(input.lastSeq),
		pruneGeneration: input.identity.pruneGeneration,
		hg: input.holeGeneration ?? 0,
		expiresAt,
	}
	if (input.low !== undefined) payload.L = formatSeq(input.low)
	if (input.high !== undefined) payload.H = formatSeq(input.high)
	return {
		token: signCursor(payload, input.key),
		expiresAt,
		lastSeq: payload.lastSeq,
	}
}
