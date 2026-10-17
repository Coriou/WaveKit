import { activityRecordCorrupt } from "./errors.js"
import type { SqlDatabase, SqlValue } from "./sqlite.js"

/**
 * The produced-index step walk shared by trails and the aggregate reads (WG4, WG5 3.3).
 *
 * The walk goes newest first, (produced_at_ms, seq) descending, in steps of at most
 * `chunk` index rows of the window, whatever the filters match. activity_produced is
 * (produced_at_ms) with the rowid (seq) implicit, so every statement uses bounds the index
 * can seek on: a run of equal produced_at_ms (`produced_at_ms = ? AND seq < ? AND seq >= ?`)
 * or a range of whole milliseconds (`produced_at_ms BETWEEN ? AND ?`). A step first finds
 * its end on the index alone (covering), then the caller reads the rows of its pieces with
 * its filters applied in the statement.
 */

/** Index rows of the window examined per step of the newest-first walk. */
export const WALK_CHUNK_ROWS = 4_096

/** Greater than any stored seq: a cursor at (ms, WALK_MAX_SEQ) leaves the whole ms below it. */
export const WALK_MAX_SEQ = Number.MAX_SAFE_INTEGER

/** An exclusive walk position: rows strictly below (ms, seq) remain. */
export interface StepCursor {
	ms: number
	seq: number
}

/** A seekable index range: a run of one millisecond, or whole milliseconds lo..hi. */
export type StepPiece =
	| { kind: "tie"; ms: number; below: number; low: number }
	| { kind: "range"; lo: number; hi: number }

export interface StepPlan {
	/** Pieces in walk order (newest first). */
	pieces: StepPiece[]
	/** The cursor below the step; null when the window is exhausted. */
	next: StepCursor | null
	/**
	 * Index rows of the window in the step when known without another statement: the run
	 * count of a tie step, exactly `chunk` for a range step that found its end, 0 for an
	 * empty step. Null for the final partial range (fewer than `chunk` rows; count them
	 * with `countPiece`).
	 */
	examined: number | null
	/** `stop` answered true before a statement: nothing was planned. */
	stopped?: true
}

/** Piece predicates; bind `pieceParams(piece)` in this order. */
export const WALK_TIE_WHERE = "produced_at_ms = ? AND seq < ? AND seq >= ?"
export const WALK_RANGE_WHERE = "produced_at_ms BETWEEN ? AND ?"

export function numberOf(value: unknown, what: string): number {
	if (typeof value === "number") return value
	if (typeof value === "bigint") return Number(value)
	throw activityRecordCorrupt(`Activity ${what} is not a number`)
}

/** The walk start: everything at or below `producedToMs` remains. */
export function walkStart(producedToMs: number): StepCursor {
	return { ms: producedToMs, seq: WALK_MAX_SEQ }
}

/** The cursor just above a piece: everything newer is consumed. */
export function startOf(piece: StepPiece): StepCursor {
	return piece.kind === "tie"
		? { ms: piece.ms, seq: piece.below }
		: { ms: piece.hi, seq: WALK_MAX_SEQ }
}

export function pieceParams(piece: StepPiece): SqlValue[] {
	return piece.kind === "tie"
		? [piece.ms, piece.below, piece.low]
		: [piece.lo, piece.hi]
}

export interface StepWalk {
	/**
	 * The step below `cursor` (exclusive): at most `chunk` index rows (defaults to the walk's
	 * chunk). One or two statements, each examining at most `chunk` index rows. `stop` is
	 * consulted before each statement; true returns a `stopped` plan (cursor unchanged).
	 */
	planStep(cursor: StepCursor, chunk?: number, stop?: () => boolean): StepPlan
	/** Index rows of a piece on the covering index (bounded by the piece). */
	countPiece(piece: StepPiece): number
}

export interface StepWalkOptions {
	/** Inclusive window start. */
	fromMs: number
	/** Index rows per step; at least 1. */
	chunk: number
}

export function createStepWalk(
	db: SqlDatabase,
	options: StepWalkOptions,
): StepWalk {
	const { fromMs } = options
	const defaultChunk = Math.max(1, Math.floor(options.chunk))
	const tieEndStatement = db.prepare(
		`SELECT COUNT(*) AS n, MIN(seq) AS s FROM (SELECT seq FROM activity INDEXED BY activity_produced
		WHERE produced_at_ms = ? AND seq < ? ORDER BY seq DESC LIMIT ?)`,
	)
	const rangeEndStatement = db.prepare(
		`SELECT produced_at_ms, seq FROM activity INDEXED BY activity_produced
		WHERE produced_at_ms BETWEEN ? AND ?
		ORDER BY produced_at_ms DESC, seq DESC LIMIT 1 OFFSET ?`,
	)
	let countTie: ReturnType<SqlDatabase["prepare"]> | null = null
	let countRange: ReturnType<SqlDatabase["prepare"]> | null = null

	const planStep = (
		cursor: StepCursor,
		chunkRows?: number,
		stop?: () => boolean,
	): StepPlan => {
		const chunk =
			chunkRows === undefined
				? defaultChunk
				: Math.max(1, Math.floor(chunkRows))
		const stopped = (): StepPlan => ({
			pieces: [],
			next: cursor,
			examined: 0,
			stopped: true,
		})
		if (stop?.()) return stopped()
		const tie = tieEndStatement.get(cursor.ms, cursor.seq, chunk)
		const count = numberOf(tie?.["n"] ?? 0, "count")
		if (count > 0) {
			const low = numberOf(tie?.["s"], "seq")
			return {
				pieces: [{ kind: "tie", ms: cursor.ms, below: cursor.seq, low }],
				next: { ms: cursor.ms, seq: low },
				examined: count,
			}
		}
		const hi = cursor.ms - 1
		if (hi < fromMs) return { pieces: [], next: null, examined: 0 }
		if (stop?.()) return stopped()
		const end = rangeEndStatement.get(fromMs, hi, chunk - 1)
		if (end === undefined)
			return {
				pieces: [{ kind: "range", lo: fromMs, hi }],
				next: null,
				examined: null,
			}
		const endMs = numberOf(end["produced_at_ms"], "producedAt")
		const endSeq = numberOf(end["seq"], "seq")
		const pieces: StepPiece[] = []
		if (endMs + 1 <= hi) pieces.push({ kind: "range", lo: endMs + 1, hi })
		pieces.push({ kind: "tie", ms: endMs, below: WALK_MAX_SEQ, low: endSeq })
		return { pieces, next: { ms: endMs, seq: endSeq }, examined: chunk }
	}

	const countPiece = (piece: StepPiece): number => {
		let statement
		if (piece.kind === "tie") {
			countTie ??= db.prepare(
				`SELECT COUNT(*) AS n FROM activity INDEXED BY activity_produced WHERE ${WALK_TIE_WHERE}`,
			)
			statement = countTie
		} else {
			countRange ??= db.prepare(
				`SELECT COUNT(*) AS n FROM activity INDEXED BY activity_produced WHERE ${WALK_RANGE_WHERE}`,
			)
			statement = countRange
		}
		return numberOf(statement.get(...pieceParams(piece))?.["n"] ?? 0, "count")
	}

	return { planStep, countPiece }
}
