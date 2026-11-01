/**
 * How often the scanner rewrites `discoveries.json`. Every mutation is already in the journal, so
 * the snapshot only bounds replay and lets old journal files be pruned: its cadence scales with its
 * size instead of a flat 10 s, which at a ~90 MB store rewrote 778 GB a day
 * (90e6 B x 8,640 snapshots) and, whenever the snapshot worker could not take it, cloned and
 * stringified the whole store on the main thread every 10 s (measured 2.7 s and +228 MiB heap per
 * snapshot at 88 MiB of text).
 */

/** Floor of every interval: a small store snapshots as often as it always did. */
export const SNAPSHOT_MIN_INTERVAL_MS = 10_000
/** Ceiling of the periodic interval: at most 2 h of journal replays after a crash or restart. */
export const SNAPSHOT_MAX_INTERVAL_MS = 2 * 3_600_000
/**
 * Periodic snapshot bytes per day: interval = bytes x 86,400,000 ms / 2e9 B. A 90 MB (90e6 B)
 * store gives 3,888 s (64.8 min, 22 snapshots a day); the 10 s floor holds up to
 * 2e9 / 8,640 = 231,481 B and the 2 h ceiling from 2e9 / 12 = 166.7 MB on.
 */
export const SNAPSHOT_BYTES_PER_DAY = 2_000_000_000
const DAY_MS = 86_400_000
/** Fastest snapshot after a journal hole while the snapshot worker can take it (~1 ms of main thread). */
export const SNAPSHOT_REQUEST_MIN_MS = 1_000
/**
 * Spacing of a snapshot the main thread must build (worker stale, failed or not started): 1 s per
 * MiB of snapshot text. The main path measured ~31 ms per MiB (2,715 ms at 87.6 MiB), so this keeps
 * it near 3 % of the main thread (31 ms / 1,000 ms). 88 MiB gives 88 s.
 */
export const MAIN_SNAPSHOT_MS_PER_MIB = 1_000
/** Ceiling of that spacing: a journal hole (appends refused) is covered within 10 min at any size. */
export const MAIN_SNAPSHOT_MAX_SPACING_MS = 10 * 60_000
/**
 * Journal since the last snapshot that makes one due early: at least 1 MiB (or the snapshot's own
 * size, so replay never reads more than about twice the snapshot), but never past half of
 * `storage.maxJournalMb`, so the uncovered journal pruning cannot delete stays inside the cap.
 */
export const JOURNAL_TRIGGER_MIN_BYTES = 1024 * 1024
const MIB = 1024 * 1024

/** The periodic interval for a snapshot of `snapshotBytes`, clamped to [10 s, 2 h]. */
export function periodicSnapshotIntervalMs(snapshotBytes: number): number {
	const bytes =
		Number.isFinite(snapshotBytes) && snapshotBytes > 0 ? snapshotBytes : 0
	const scaled = Math.ceil((bytes * DAY_MS) / SNAPSHOT_BYTES_PER_DAY)
	return Math.min(
		SNAPSHOT_MAX_INTERVAL_MS,
		Math.max(SNAPSHOT_MIN_INTERVAL_MS, scaled),
	)
}

/** Spacing of main-thread snapshots of `snapshotBytes`: 1 s per MiB, clamped to [1 s, 10 min]. */
export function mainSnapshotSpacingMs(snapshotBytes: number): number {
	const bytes =
		Number.isFinite(snapshotBytes) && snapshotBytes > 0 ? snapshotBytes : 0
	const scaled = Math.ceil((bytes / MIB) * MAIN_SNAPSHOT_MS_PER_MIB)
	return Math.min(
		MAIN_SNAPSHOT_MAX_SPACING_MS,
		Math.max(SNAPSHOT_REQUEST_MIN_MS, scaled),
	)
}

/** Journal bytes since the last snapshot that make the next one due: max(1 MiB, snapshot), at most half the cap. */
export function journalSnapshotTriggerBytes(
	snapshotBytes: number,
	maxJournalBytes: number,
): number {
	const bytes =
		Number.isFinite(snapshotBytes) && snapshotBytes > 0 ? snapshotBytes : 0
	const own = Math.max(JOURNAL_TRIGGER_MIN_BYTES, bytes)
	return Number.isFinite(maxJournalBytes) && maxJournalBytes > 0
		? Math.min(own, maxJournalBytes / 2)
		: own
}

export interface SnapshotCadenceInput {
	/** Size of the last snapshot written or loaded (0 before any). */
	snapshotBytes: number
	/** Journal bytes accepted since the last durable snapshot. */
	journalBytes: number
	/** `storage.maxJournalMb` in bytes. */
	maxJournalBytes: number
	/** The snapshot worker's mirror is live: the next snapshot costs the main thread ~1 ms. */
	onWorker: boolean
	/** A journal hole asked for a snapshot (appends refused until one covers it). */
	requested: boolean
	/** The last snapshot failed. */
	failed: boolean
}

/**
 * Minimum time between snapshot starts while the state is dirty. A journal hole is covered fast
 * (1 s on the worker, the main-thread spacing otherwise; never under 10 s after a failure, as on a
 * failing disk); a journal past its trigger makes one due after 10 s (or the main-thread spacing);
 * otherwise the size-scaled periodic interval.
 */
export function snapshotIntervalMs(s: SnapshotCadenceInput): number {
	const periodic = periodicSnapshotIntervalMs(s.snapshotBytes)
	const soon = s.onWorker
		? SNAPSHOT_REQUEST_MIN_MS
		: mainSnapshotSpacingMs(s.snapshotBytes)
	if (s.requested)
		return Math.min(
			periodic,
			s.failed ? Math.max(soon, SNAPSHOT_MIN_INTERVAL_MS) : soon,
		)
	if (
		s.journalBytes >=
		journalSnapshotTriggerBytes(s.snapshotBytes, s.maxJournalBytes)
	)
		return Math.min(periodic, Math.max(SNAPSHOT_MIN_INTERVAL_MS, soon))
	return periodic
}
