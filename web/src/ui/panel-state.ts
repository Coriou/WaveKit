// The list panels' states (Activity, Recordings, later Scanner): one table, the same words and shapes in
// every panel. Pure, so the table tests in node; the panel maps a notice kind to its own words.
import type { FeedStatus } from "../data/paged-feed.ts"

/** What fills the panel's list area. */
export type PanelBody = "rows" | "skeleton" | "error" | "empty"

/**
 * The one notice under the filters, by priority: error (a refresh failed, the last good rows stay), busy
 * (a read past 3 s), truncated (the source left rows out), capped (the browser holds its most rows),
 * indexing (the list is still being built).
 */
export type PanelNoticeKind =
	| "error"
	| "busy"
	| "truncated"
	| "capped"
	| "indexing"

export interface PanelInput {
	status: FeedStatus
	busy: boolean
	/** Rows to show (after the panel's own hiding, e.g. deletes waiting for Undo). */
	rows: number
	/** The feed has rows from an earlier answer (an empty filter result is still an answer). */
	answered: boolean
	error: string | null
	truncated?: boolean
	capped?: boolean
	indexing?: boolean
}

export interface PanelView {
	body: PanelBody
	/** The skeleton says "Still loading. WaveKit is busy." instead of "Loading …". */
	busy: boolean
	/** The thin progress line under the header: rows are on screen and a read is running. */
	progress: boolean
	notice: PanelNoticeKind | null
}

/**
 * | State                     | Body     | Notice    |
 * |---------------------------|----------|-----------|
 * | first read, under 3 s     | skeleton | none (the skeleton fades in late, its caption at 1 s) |
 * | first read, 3 s and over  | skeleton, busy | none |
 * | first read failed or 10 s | error (what failed, Try again, retry on a backoff) | none |
 * | rows, refreshing          | rows + progress line | busy at 3 s |
 * | rows, refresh failed      | rows (as of the last answer) | error |
 * | answered, nothing listed  | empty (meaning and one action) | indexing / truncated |
 */
export function panelView(input: PanelInput): PanelView {
	const loading = input.status === "loading" || input.status === "idle"
	const failed = input.status === "error"
	if (input.rows === 0 && !input.answered) {
		if (failed)
			return { body: "error", busy: false, progress: false, notice: null }
		return { body: "skeleton", busy: input.busy, progress: false, notice: null }
	}
	const notice: PanelNoticeKind | null =
		failed && input.error !== null
			? "error"
			: loading && input.busy
				? "busy"
				: input.truncated
					? "truncated"
					: input.capped
						? "capped"
						: input.indexing
							? "indexing"
							: null
	return {
		body: input.rows === 0 ? "empty" : "rows",
		busy: false,
		progress: loading,
		notice,
	}
}

/** "Trying again in 8 s", or null when no retry is planned. */
export function retryText(retryAt: number | null, now: number): string | null {
	if (retryAt === null) return null
	const s = Math.max(1, Math.ceil((retryAt - now) / 1000))
	return `Trying again in ${s} s`
}
