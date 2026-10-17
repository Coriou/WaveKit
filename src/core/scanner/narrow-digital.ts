/**
 * WG11 requirement 1.3 (docs/specs/web-gaps-11): is a frequency on a narrow (≤ 6.25 kHz)
 * channel raster? Identify adds the 6.25 kHz digital modes (nxdn48, dpmr, dstar) for such a
 * target even when the track's width does not suggest them. Pure; type-only imports so the
 * startup bundle does not grow.
 */
import type { ScanRange } from "./types.js"

/** Widest raster spacing (Hz) that counts as a narrow digital channel grid. */
export const NARROW_RASTER_MAX_SPACING_HZ = 6250

/**
 * True iff a range containing `hz` (inclusive edges, the same containment `priorsFor` uses)
 * lists a raster with a finite spacing in (0, 6 250] Hz. The ranges are the ones the scanner
 * passes for priors (already filtered by the active region). Malformed input (a non-finite
 * `hz`, a range with non-finite edges, a non-finite or non-positive spacing) never qualifies.
 */
export function narrowRasterAt(
	ranges: readonly ScanRange[],
	hz: number,
): boolean {
	if (!Number.isFinite(hz)) return false
	for (const r of ranges) {
		if (!Number.isFinite(r.startHz) || !Number.isFinite(r.endHz)) continue
		if (hz < r.startHz || hz > r.endHz) continue
		for (const raster of r.rasters ?? []) {
			const s = raster.spacingHz
			if (Number.isFinite(s) && s > 0 && s <= NARROW_RASTER_MAX_SPACING_HZ)
				return true
		}
	}
	return false
}
