/**
 * WG7 (web-gaps-7 requirement 6): band-plan skip ranges of a scan plan. `bandPlanSkipSources`
 * maps the resolved band-plan view to plain sources; `computeBandPlanSkips` clips them to the
 * job's enabled ranges, merges and bounds them. Both are total: malformed input yields nothing.
 * Edges are inclusive Hz, as everywhere in the scanner: [a, b] and [b + 1, c] touch and merge.
 */
import {
	BANDPLAN_SKIP_MAX_RANGES,
	BANDPLAN_SKIP_MAX_SOURCES,
} from "@wavekit/api-types"
import type { ResolvedBandPlanView } from "@wavekit/api-types"
import type {
	BandPlanSkipRange,
	BandPlanSkipSource,
	NormalisedJobSpec,
	PlanIssue,
} from "../types.js"
import { isRangeEnabled } from "./range-contract.js"

function isValidEdge(start: unknown, end: unknown): start is number {
	return (
		typeof start === "number" &&
		typeof end === "number" &&
		Number.isFinite(start) &&
		Number.isFinite(end) &&
		start <= end
	)
}

/** A `BandSkip` by meaning: a plain object whose `reason` is a string. Anything else is no skip. */
function isBandSkip(skip: unknown): boolean {
	if (skip === null || typeof skip !== "object" || Array.isArray(skip))
		return false
	return typeof (skip as { reason?: unknown }).reason === "string"
}

/**
 * Sources of every band whose effective `skip` is a valid `BandSkip`, one per resolved segment,
 * in view order. Never throws; a malformed band or segment is skipped and a malformed view
 * yields [].
 *
 * Bound: at most `BANDPLAN_SKIP_MAX_SOURCES + 1` segments of skip bands are EXAMINED in total,
 * valid or not, so iteration is bounded however large or malformed the segment arrays are.
 * The (MAX + 1)-th examined segment, if valid, is returned as the overflow entry that lets
 * `computeBandPlanSkips` detect and report truncation (the MAX + 1 contract). When that
 * segment, or earlier ones, are malformed, the overflow is cut silently: the result is still
 * bounded but carries no truncation signal.
 */
export function bandPlanSkipSources(
	view: ResolvedBandPlanView | null | undefined,
): BandPlanSkipSource[] {
	try {
		if (view === null || typeof view !== "object") return []
		const bands: unknown = view.bands
		if (!Array.isArray(bands)) return []
		const cap = BANDPLAN_SKIP_MAX_SOURCES + 1
		const out: BandPlanSkipSource[] = []
		let examined = 0
		for (const entry of bands as readonly unknown[]) {
			if (examined >= cap) break
			try {
				if (entry === null || typeof entry !== "object") continue
				const rb = entry as {
					key?: unknown
					band?: unknown
					segments?: unknown
				}
				const key = rb.key
				const band = rb.band
				const segments = rb.segments
				if (typeof key !== "string") continue
				if (band === null || typeof band !== "object") continue
				if (!isBandSkip((band as { skip?: unknown }).skip)) continue
				if (!Array.isArray(segments)) continue
				const arr = segments as readonly unknown[]
				const len = arr.length
				for (let i = 0; i < len && examined < cap; i++) {
					examined++
					try {
						const seg: unknown = arr[i]
						if (seg === null || typeof seg !== "object") continue
						const s = seg as { startHz?: unknown; endHz?: unknown }
						const startHz = s.startHz
						const endHz = s.endHz
						if (!isValidEdge(startHz, endHz)) continue
						out.push({ key, startHz, endHz: endHz as number })
					} catch {
						// a throwing segment is skipped (it still counts as examined)
					}
				}
			} catch {
				// a throwing band is skipped
			}
		}
		return out
	} catch {
		return []
	}
}

export interface BandPlanSkipLimits {
	maxSources?: number
	maxRanges?: number
}

export interface BandPlanSkipResult {
	ranges: BandPlanSkipRange[]
	issues: PlanIssue[]
}

interface Piece {
	startHz: number
	endHz: number
	key: string
}

/**
 * Clip the first `maxSources` sources to the spec's enabled ranges, sort by `startHz`, merge
 * overlapping or touching pieces (next.startHz <= current.endHz + 1, inclusive Hz), unite their
 * keys (sorted, unique) and keep the first `maxRanges`. Every entry has `applied: false`
 * (planJob decides). One `bandplan-skips-truncated` warning when a bound was passed and at least
 * one entry is reported. O(n log n) in the pieces.
 */
export function computeBandPlanSkips(
	sources: readonly BandPlanSkipSource[],
	spec: NormalisedJobSpec,
	limits?: BandPlanSkipLimits,
): BandPlanSkipResult {
	const maxSources = limits?.maxSources ?? BANDPLAN_SKIP_MAX_SOURCES
	const maxRanges = limits?.maxRanges ?? BANDPLAN_SKIP_MAX_RANGES
	let truncated = sources.length > maxSources

	const enabled = spec.ranges.filter(
		r => isRangeEnabled(r) && isValidEdge(r.startHz, r.endHz),
	)
	const pieces: Piece[] = []
	const n = Math.min(sources.length, maxSources)
	for (let i = 0; i < n; i++) {
		const s = sources[i]
		if (
			s === undefined ||
			typeof s.key !== "string" ||
			!isValidEdge(s.startHz, s.endHz)
		)
			continue
		for (const r of enabled) {
			const lo = Math.max(s.startHz, r.startHz)
			const hi = Math.min(s.endHz, r.endHz)
			if (lo <= hi) pieces.push({ startHz: lo, endHz: hi, key: s.key })
		}
	}
	pieces.sort((a, b) => a.startHz - b.startHz || a.endHz - b.endHz)

	const merged: { startHz: number; endHz: number; keys: Set<string> }[] = []
	for (const p of pieces) {
		const cur = merged[merged.length - 1]
		if (cur !== undefined && p.startHz <= cur.endHz + 1) {
			if (p.endHz > cur.endHz) cur.endHz = p.endHz
			cur.keys.add(p.key)
		} else {
			merged.push({
				startHz: p.startHz,
				endHz: p.endHz,
				keys: new Set([p.key]),
			})
		}
	}
	if (merged.length > maxRanges) {
		merged.length = maxRanges
		truncated = true
	}
	const ranges: BandPlanSkipRange[] = merged.map(m => ({
		startHz: m.startHz,
		endHz: m.endHz,
		bandKeys: [...m.keys].sort(),
		applied: false,
	}))
	const issues: PlanIssue[] = []
	if (truncated && ranges.length > 0) {
		issues.push({
			severity: "warning",
			code: "bandplan-skips-truncated",
			message: `Band-plan skips were truncated to ${maxSources} segments and ${maxRanges} ranges`,
			details: { maxSources, maxRanges },
		})
	}
	return { ranges, issues }
}
