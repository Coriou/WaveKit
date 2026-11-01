/**
 * When the scanner rewrites `discoveries.json` (a compaction). Every mutation is already in the
 * journal, so the snapshot only bounds replay and lets old journal files be pruned. A compaction is
 * due when the journal since the last one passes its trigger (`journalSnapshotTriggerBytes`), when
 * the store has changed and 24 h have passed (`SNAPSHOT_AGE_CEILING_MS`), or at once for a journal
 * hole; never sooner than the write-budget floor (`writeBudgetFloorMs`) except for a hole (and for
 * the start-up, consolidation and shutdown snapshots, which do not use this cadence).
 *
 * The size-scaled periodic interval this replaces rewrote a 90 MB store every 64.8 min:
 * 22.2 x 90e6 = 2.0 GB a day for a journal of only 655 B/s x 86,400 s = 56.6 MB a day. Now the same
 * store compacts each time 32 MiB of journal accrues: 56.6e6 / 33,554,432 = 1.69 compactions,
 * 152 MB a day.
 */

/** Floor of every interval but a hole's: a small store snapshots at most every 10 s. */
export const SNAPSHOT_MIN_INTERVAL_MS = 10_000
/** A changed store compacts at least this long after the last compaction started: 24 h. */
export const SNAPSHOT_AGE_CEILING_MS = 24 * 3_600_000
/**
 * Compaction bytes per day the write-budget floor allows: floor = bytes x 86,400,000 ms / 1.5e9 B.
 * A 90 MB store waits at least 5,184 s (86.4 min) between compactions, so even a journal burst
 * or a tiny `maxJournalMb` rewrites it at most 86,400,000 / 5,184,000 = 16.7 times (1.5 GB) a day.
 */
export const COMPACTION_BYTES_PER_DAY = 1_500_000_000
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
 * Journal since the last snapshot that makes one due: at least 1 MiB (or the snapshot's own
 * size, so replay never reads more than about twice the snapshot), but never past half of
 * `storage.maxJournalMb`, so the uncovered journal pruning cannot delete stays inside the cap.
 */
export const JOURNAL_TRIGGER_MIN_BYTES = 1024 * 1024
const MIB = 1024 * 1024

/**
 * The write-budget floor for a snapshot of `snapshotBytes`: bytes x 86,400,000 / 1.5e9 ms, rounded
 * up (0 for no snapshot). 90 MB gives 5,184,000 ms; 1 MiB 60,398 ms; up to 173,611 B it is at
 * most the 10 s floor every interval keeps anyway (173,611 x 0.0576 = 9,999.99 ms).
 */
export function writeBudgetFloorMs(snapshotBytes: number): number {
	const bytes =
		Number.isFinite(snapshotBytes) && snapshotBytes > 0 ? snapshotBytes : 0
	return Math.ceil((bytes * DAY_MS) / COMPACTION_BYTES_PER_DAY)
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
 * Ceiling of the failure retry of a snapshot that is not a hole's: 2 h, reached at the 11th
 * consecutive failure (10 s x 2^10 = 10,240 s capped to 7,200 s), so a disk that keeps failing
 * sees one attempt every 2 h (or every write-budget floor, when that is longer).
 */
export const SNAPSHOT_RETRY_MAX_MS = 2 * 3_600_000

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
 * 20, 40, ... s, capped by the caller (2 h, or 5 min while a hole waits).
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
 * Minimum time between snapshot starts while the state is dirty.
 *
 * - A journal hole is covered after 1 s, backing off once holes keep recurring
 *   (`holeSnapshotSpacingMs`) and after failures (retry capped at 5 min); never later than
 *   max(10 s, write-budget floor), so a lasting hole episode stays inside the write budget too
 *   (a 90 MB store's floor, 86.4 min, is far above the 5 min caps; a small store's is 10 s).
 * - A journal past its trigger makes one due after max(10 s, floor, failure retry capped at 2 h),
 *   and when the main thread must build it, at least the main-thread spacing.
 * - Otherwise the 24 h age ceiling, or after a failure max(10 s, floor, retry capped at 2 h).
 *
 * Bytes a day, steady state, for a journal of J bytes a day, a snapshot of S bytes and the trigger
 * T: J + S x max(1, J / T) (the age ceiling compacts a changed store at least once a day), at most
 * 1.5 GB + J whatever J. A 90 MB store at 56.6 MB a day: 56.6 MB + 1.69 x 90 MB = 0.21 GB.
 *
 * A snapshot the main thread will build also waits out the rest after the last main-thread build,
 * hole or not.
 */
export function snapshotIntervalMs(s: SnapshotCadenceInput): number {
	const interval = cadenceIntervalMs(s)
	if (s.onWorker || !(s.mainBuildMs > 0)) return interval
	const rest = s.mainBuildEndOffsetMs + mainSnapshotRestMs(s.mainBuildMs)
	return Number.isFinite(rest) ? Math.max(interval, rest) : interval
}

function cadenceIntervalMs(s: SnapshotCadenceInput): number {
	const floor = Math.max(
		SNAPSHOT_MIN_INTERVAL_MS,
		writeBudgetFloorMs(s.snapshotBytes),
	)
	const retry = snapshotRetryMs(s.failures)
	if (s.requested)
		return Math.min(
			floor,
			Math.max(
				holeSnapshotSpacingMs(s.holeStreak),
				Math.min(HOLE_SNAPSHOT_MAX_SPACING_MS, retry),
			),
		)
	const cappedRetry = Math.min(SNAPSHOT_RETRY_MAX_MS, retry)
	if (
		s.journalBytes >=
		journalSnapshotTriggerBytes(s.snapshotBytes, s.maxJournalBytes)
	) {
		const spacing = s.onWorker ? 0 : mainSnapshotSpacingMs(s.snapshotBytes)
		return Math.max(floor, spacing, cappedRetry)
	}
	if (retry > 0) return Math.max(floor, cappedRetry)
	return Math.max(SNAPSHOT_AGE_CEILING_MS, floor)
}
