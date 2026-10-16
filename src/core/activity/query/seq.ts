import {
	ActivityCursorGapError,
	ActivityCursorInvalidError,
	activityRecordCorrupt,
} from "./errors.js"

/** SQLite signed 64-bit integer ceiling. Sequences never go negative. */
export const MAX_SEQ = 9223372036854775807n

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
	// Watermark 0 means nothing has been pruned. A cursor whose lastSeq equals
	// the watermark already delivered that seq, so only an earlier seq is a gap.
	if (watermark === 0n) return false
	return lastSeq < watermark
}

/** The newer prune watermark. The cached copy can lag the read snapshot. */
export function higherWatermark(cached: bigint, observed: bigint): bigint {
	return cached > observed ? cached : observed
}

export function snapshotLowerBoundPassed(
	lowBarrier: bigint,
	watermark: bigint,
): boolean {
	return watermark > lowBarrier
}

/** Hole state as a reader sees it. Absent keys (stores older than WG3) read as 0. */
export interface HoleState {
	generation: number
	watermark: bigint
}

export function holeStateOf(source: {
	holeWatermark?: string | undefined
	holeGeneration?: number | undefined
}): HoleState {
	return {
		generation: source.holeGeneration ?? 0,
		watermark: parseSeq(source.holeWatermark ?? "0"),
	}
}

/** The newer of two hole states: both values only ever grow. */
export function newerHoles(left: HoleState, right: HoleState): HoleState {
	return {
		generation: Math.max(left.generation, right.generation),
		watermark:
			left.watermark > right.watermark ? left.watermark : right.watermark,
	}
}

/**
 * Replay hole rule (web-gaps-3 4.4). A new generation with its hole watermark
 * above the position may have removed a row the client has not received:
 * `cursor-gap`. Otherwise every hole ever opened is at or below the position,
 * so the replay adopts the generation. Returns the new base.
 */
export function checkReplayHoles(
	base: number,
	holes: HoleState,
	position: bigint,
): number {
	if (holes.generation <= base) return base
	if (holes.watermark > position) throw new ActivityCursorGapError()
	return holes.generation
}
