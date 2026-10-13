/**
 * Scanner follow-ups (SF1) frozen contract: running-job range edits
 * (docs/specs/scanner-followups/design.md "Range edits"). Types and constants only.
 */
import type { PlanIssue, ScanJobSpec, ScanRange } from "../types.js"

/** Range fields a PATCH may change while the job exists (applied at the next hop). */
export const RANGE_LIVE_FIELDS = [
	"enabled",
	"protocols",
	"name",
	"dwellMs",
	"sensitivity",
] as const
/** Range fields fixed for the job's lifetime; a change is a `range-locked` error. */
export const RANGE_LOCKED_FIELDS = [
	"startHz",
	"endHz",
	"rasters",
	"obwHz",
	"bandplanId",
] as const
/** Upper bound of `ScanRange.name` (same as the job name). */
export const RANGE_NAME_MAX = 100

export type RangeLiveField = (typeof RANGE_LIVE_FIELDS)[number]
export type RangeLockedField = (typeof RANGE_LOCKED_FIELDS)[number]

/** The live part of one effective range; an absent key means "not set". */
export type ScanRangeLive = Pick<ScanRange, RangeLiveField>

/**
 * The stored operator spec (JobRecord.rawSpec, PersistedJob.rawSpec). `rangeLive` is never
 * accepted from a client: Main writes it from a validated PATCH `ranges`. It is aligned by
 * index with the job's effective range list (operator ranges, then bandplan ranges) and
 * replaces each range's live fields after normalisation.
 */
export interface StoredScanJobSpec extends ScanJobSpec {
	rangeLive?: ScanRangeLive[]
}

/**
 * Validates a PATCH `ranges` array against the job's current effective ranges
 * (`job.spec.ranges`). Pure and total. The patch must have the same length; each element's
 * locked fields must deep-equal the current ones (absent equals absent). Violations are
 * `range-locked` error issues (details: `{ index, fields }` or `{ expected, received }` for a
 * count mismatch). With no error, `rangeLive` is the full index-aligned live snapshot taken
 * from the patch (full-state: an absent live key clears it).
 */
export type ApplyRangePatch = (
	current: readonly ScanRange[],
	patch: readonly ScanRange[],
) => { rangeLive: ScanRangeLive[]; issues: PlanIssue[] }

/** The one enabled test every consumer uses: absent `enabled` means enabled. */
export function isRangeEnabled(range: Pick<ScanRange, "enabled">): boolean {
	return range.enabled !== false
}
