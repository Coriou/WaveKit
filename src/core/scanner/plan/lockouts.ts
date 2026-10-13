import type {
	HopPlan,
	LockoutExclusion,
	ScanExclusion,
	ScanRange,
} from "../types.js"

/**
 * WG2 requirement 12 (D2): a locked-out discovery skips sweeps. Pure: the caller supplies the
 * locked discoveries of the job's source and the job's enabled ranges; nothing here touches the
 * stored job spec (12.2).
 */

/** A locked-out discovery heard on the job's source. */
export interface LockoutTarget {
	discoveryId: string
	centreHz: number
	/** The discovery's occupied bandwidth (0 or non-finite: unknown). */
	bandwidthHz: number
}

/** 12.3: at most this many lockout exclusions apply per job. */
export const LOCKOUT_EXCLUSIONS_MAX = 256
/** 12.1: the exclusion is at least this wide. */
export const LOCKOUT_MIN_WIDTH_HZ = 1000

/** Narrowest raster step of the ranges holding `hz` (0 when only free ranges hold it). */
function rasterStepAt(hz: number, holding: readonly ScanRange[]): number {
	let step = Infinity
	for (const r of holding)
		for (const raster of r.rasters ?? [])
			if (raster.spacingHz > 0) step = Math.min(step, raster.spacingHz)
	return Number.isFinite(step) ? step : 0
}

/**
 * 12.1, 12.3: one exclusion `[centre − w/2, centre + w/2]` per locked discovery whose centre lies in
 * an enabled range, w = max(occupied bandwidth, raster step, 1 kHz), clipped to the enabled ranges
 * it overlaps; sorted by start (lowest frequency first), the first 256 `applied`, the rest not.
 */
export function lockoutExclusionsFor(
	targets: readonly LockoutTarget[],
	enabledRanges: readonly ScanRange[],
): LockoutExclusion[] {
	const out: LockoutExclusion[] = []
	for (const t of targets) {
		const c = t.centreHz
		if (!Number.isFinite(c)) continue
		const holding = enabledRanges.filter(r => c >= r.startHz && c <= r.endHz)
		if (holding.length === 0) continue
		const bw = Number.isFinite(t.bandwidthHz) ? Math.max(0, t.bandwidthHz) : 0
		const w = Math.max(bw, rasterStepAt(c, holding), LOCKOUT_MIN_WIDTH_HZ)
		const lo = c - w / 2
		const hi = c + w / 2
		let minStart = Infinity
		let maxEnd = -Infinity
		for (const r of enabledRanges) {
			if (r.endHz < lo || r.startHz > hi) continue
			minStart = Math.min(minStart, r.startHz)
			maxEnd = Math.max(maxEnd, r.endHz)
		}
		out.push({
			discoveryId: t.discoveryId,
			startHz: Math.max(lo, minStart),
			endHz: Math.min(hi, maxEnd),
			applied: true,
		})
	}
	out.sort(
		(a, b) =>
			a.startHz - b.startHz ||
			a.endHz - b.endHz ||
			(a.discoveryId < b.discoveryId
				? -1
				: a.discoveryId > b.discoveryId
					? 1
					: 0),
	)
	for (let i = LOCKOUT_EXCLUSIONS_MAX; i < out.length; i++) {
		const x = out[i]
		if (x) x.applied = false
	}
	return out
}

/**
 * 12.4: plans with the applied lockouts unless that would leave no hop where the plan without them
 * has one; then none applies (all listed with `applied: false`). `plan(extra)` is the job's one
 * plan function with `extra` added to the spec's own exclusions.
 */
export function planWithLockouts(
	plan: (extra: readonly ScanExclusion[]) => HopPlan,
	candidates: readonly LockoutExclusion[],
): { plan: HopPlan; lockoutExclusions: LockoutExclusion[] } {
	const applied: ScanExclusion[] = candidates
		.filter(x => x.applied)
		.map(x => ({ startHz: x.startHz, endHz: x.endHz }))
	if (applied.length === 0)
		return {
			plan: plan([]),
			lockoutExclusions: candidates.map(x => ({ ...x })),
		}
	const locked = plan(applied)
	if (locked.hops.length > 0)
		return { plan: locked, lockoutExclusions: candidates.map(x => ({ ...x })) }
	const base = plan([])
	if (base.hops.length === 0)
		return { plan: locked, lockoutExclusions: candidates.map(x => ({ ...x })) }
	return {
		plan: base,
		lockoutExclusions: candidates.map(x => ({ ...x, applied: false })),
	}
}
