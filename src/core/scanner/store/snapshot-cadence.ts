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
/**
 * Fastest snapshot after a journal hole: until one covers the hole every append is refused,
 * recording operations included. Spaced further only by the hole backoff
 * (`holeSnapshotSpacingMs`), the failure retry (`snapshotRetryMs`) and, for one the main thread
 * builds, the main-thread duty budget (`MAIN_SNAPSHOT_REST_FACTOR`).
 */
export const SNAPSHOT_REQUEST_MIN_MS = 1_000
/**
 * Spacing of a non-urgent (journal trigger) snapshot the main thread must build (worker stale,
 * failed or not started): 1 s per MiB of snapshot text. The main path measured ~31 ms per MiB
 * (2,715 ms at 87.6 MiB), so this keeps it near 3 % of the main thread (31 ms / 1,000 ms).
 * 88 MiB gives 88 s.
 */
export const MAIN_SNAPSHOT_MS_PER_MIB = 1_000
/** Ceiling of that spacing, and of the rest below: 10 min at any size. */
export const MAIN_SNAPSHOT_MAX_SPACING_MS = 10 * 60_000
/**
 * Main-thread snapshot duty budget, hole snapshots included: the next snapshot the main thread
 * builds starts no earlier than the end of the last main-thread build plus 9 x its synchronous
 * build time, so builds take at most 1 / (1 + 9) = 10 % of the main thread however often holes
 * recur. A 2.7 s build rests 24.3 s; a 30 ms build (about 1 MiB) rests 270 ms, inside the 1 s
 * hole spacing. Snapshots the worker builds are not limited by it.
 */
export const MAIN_SNAPSHOT_REST_FACTOR = 9
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

/** Rest after a main-thread build of `buildMs`: 9 x the build, clamped to [0, 10 min]. */
export function mainSnapshotRestMs(buildMs: number): number {
	const ms = Number.isFinite(buildMs) && buildMs > 0 ? buildMs : 0
	return Math.min(
		MAIN_SNAPSHOT_MAX_SPACING_MS,
		Math.ceil(ms * MAIN_SNAPSHOT_REST_FACTOR),
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

/**
 * Consecutive hole snapshots after which hole snapshots back off: a journal that keeps refusing
 * (failing appends, a backlog that refills) while snapshot writes succeed would otherwise rewrite
 * the whole store every second (a 90 MB store on the worker: 90e6 x 86,400 = 7.8 TB a day).
 * The first 5 holes of an episode are covered after 1 s each.
 */
export const HOLE_SNAPSHOT_BACKOFF_AFTER = 5
/**
 * Ceiling of the hole backoff (and of the failure retry while a hole waits): 5 min, so a lasting
 * episode rewrites a 90 MB store at most 288 times a day (25.9 GB) and loses at most 5 min of
 * changes to a crash.
 */
export const HOLE_SNAPSHOT_MAX_SPACING_MS = 5 * 60_000
/** A hole requested this long after the last hole snapshot ended starts a new episode (streak 0). */
export const HOLE_STREAK_RESET_MS = 10 * 60_000
/** First retry after a failed snapshot; each further consecutive failure doubles it. */
export const SNAPSHOT_RETRY_MIN_MS = SNAPSHOT_MIN_INTERVAL_MS

/**
 * Spacing of a hole snapshot after `streak` consecutive successful ones in the same episode:
 * 1 s below `HOLE_SNAPSHOT_BACKOFF_AFTER`, then 1 s x 2^(streak - 4) (2, 4, 8, ... 256 s at
 * streak 5..12), capped at 5 min from streak 13 on.
 */
export function holeSnapshotSpacingMs(streak: number): number {
	const s = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0
	if (s < HOLE_SNAPSHOT_BACKOFF_AFTER) return SNAPSHOT_REQUEST_MIN_MS
	const exponent = Math.min(30, s - HOLE_SNAPSHOT_BACKOFF_AFTER + 1)
	return Math.min(
		HOLE_SNAPSHOT_MAX_SPACING_MS,
		SNAPSHOT_REQUEST_MIN_MS * 2 ** exponent,
	)
}

/**
 * Retry after `failures` consecutive failed snapshots (0: none): 10 s x 2^(failures - 1), so 10,
 * 20, 40, ... s, capped by the caller (the periodic interval, or 5 min while a hole waits). A
 * 90 MB store (periodic 3,888 s) reaches its cap at the 10th failure (10 s x 2^9 = 5,120 s),
 * about 1.4 h of failures in; a disk that keeps failing then sees one 90 MB attempt an hour.
 */
export function snapshotRetryMs(failures: number): number {
	const f = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0
	if (f === 0) return 0
	return SNAPSHOT_RETRY_MIN_MS * 2 ** Math.min(30, f - 1)
}

export interface SnapshotCadenceInput {
	/** Size of the last snapshot written or loaded (0 before any). */
	snapshotBytes: number
	/** Journal bytes written since the last durable snapshot. */
	journalBytes: number
	/** `storage.maxJournalMb` in bytes. */
	maxJournalBytes: number
	/** The snapshot worker's mirror is live: the next snapshot costs the main thread ~1 ms. */
	onWorker: boolean
	/** A journal hole asked for a snapshot (appends refused until one covers it). */
	requested: boolean
	/** Consecutive failed snapshots (0 after a success; a main-thread deferral is no failure). */
	failures: number
	/** Consecutive successful hole snapshots in this episode (`holeSnapshotSpacingMs`). */
	holeStreak: number
	/** Synchronous build time of the last main-thread snapshot (0 before any). */
	mainBuildMs: number
	/**
	 * When that build ended, in ms after the start of the last snapshot (negative when it ended
	 * before; ignored while `mainBuildMs` is 0).
	 */
	mainBuildEndOffsetMs: number
}

/**
 * Minimum time between snapshot starts while the state is dirty. A journal hole is covered after
 * 1 s, backing off once holes keep recurring (`holeSnapshotSpacingMs`). A journal past its
 * trigger makes one due after 10 s, or after the main-thread spacing when the worker cannot take
 * it; otherwise the size-scaled periodic interval. After failed snapshots the next waits at least
 * the failure retry (`snapshotRetryMs`), capped at the periodic interval (5 min for a hole). A
 * snapshot the main thread will build also waits out the rest after the last main-thread build,
 * hole or not.
 */
export function snapshotIntervalMs(s: SnapshotCadenceInput): number {
	const interval = cadenceIntervalMs(s)
	if (s.onWorker || !(s.mainBuildMs > 0)) return interval
	const rest = s.mainBuildEndOffsetMs + mainSnapshotRestMs(s.mainBuildMs)
	return Number.isFinite(rest) ? Math.max(interval, rest) : interval
}

function cadenceIntervalMs(s: SnapshotCadenceInput): number {
	const periodic = periodicSnapshotIntervalMs(s.snapshotBytes)
	const retry = snapshotRetryMs(s.failures)
	if (s.requested)
		return Math.min(
			periodic,
			Math.max(
				holeSnapshotSpacingMs(s.holeStreak),
				Math.min(HOLE_SNAPSHOT_MAX_SPACING_MS, retry),
			),
		)
	if (
		s.journalBytes >=
		journalSnapshotTriggerBytes(s.snapshotBytes, s.maxJournalBytes)
	) {
		const spacing = s.onWorker ? 0 : mainSnapshotSpacingMs(s.snapshotBytes)
		return Math.min(
			periodic,
			Math.max(SNAPSHOT_MIN_INTERVAL_MS, spacing, retry),
		)
	}
	return retry > 0 ? Math.min(periodic, retry) : periodic
}
