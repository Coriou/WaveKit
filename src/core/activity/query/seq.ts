import { ActivityCursorInvalidError, activityRecordCorrupt } from "./errors.js"

/** SQLite signed 64-bit integer ceiling. Sequences never go negative. */
const MAX_SEQ = 9223372036854775807n

const DECIMAL = /^(0|[1-9][0-9]*)$/

export function parseSeq(value: string): bigint {
	if (!DECIMAL.test(value)) {
		throw new ActivityCursorInvalidError("Sequence is not a decimal string")
	}
	const parsed = BigInt(value)
	if (parsed > MAX_SEQ) {
		throw new ActivityCursorInvalidError("Sequence is out of range")
	}
	return parsed
}

export function formatSeq(value: bigint): string {
	return value.toString(10)
}

/** Bind a sequence without losing bits past Number.MAX_SAFE_INTEGER. */
export function bindSeq(value: bigint): number | bigint {
	if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
	return value
}

export function seqFromSqlite(value: unknown): bigint {
	if (typeof value === "bigint") {
		if (value < 0n || value > MAX_SEQ) {
			throw activityRecordCorrupt("Activity row seq is out of range")
		}
		return value
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw activityRecordCorrupt("Activity row seq is not a safe integer")
		}
		return BigInt(value)
	}
	if (typeof value === "string") return parseSeq(value)
	throw activityRecordCorrupt("Activity row seq is missing")
}

export function cursorBehindWatermark(
	lastSeq: bigint,
	watermark: bigint,
): boolean {
	// Watermark 0 means nothing has been pruned. A cursor at 0 is the origin.
	if (watermark === 0n) return false
	return lastSeq <= watermark
}

export function snapshotLowerBoundPassed(
	lowBarrier: bigint,
	watermark: bigint,
): boolean {
	return watermark > lowBarrier
}
