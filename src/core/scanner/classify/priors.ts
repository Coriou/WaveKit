import { priorsFor } from "../bandplan/index.js"
import type { ScannerProtocol, ScanRange } from "../types.js"

/**
 * Scanner-redesign 3.12, scanner side. The legacy band-plan blobs are frozen, so the LPD433
 * range and the narrowest-range prior rule live here and are applied at the scanner's prior and
 * hint call sites.
 */

/** LPD433 (ERC/REC 70-03 Annex 1): 69 channels of 25 kHz, 433.075–434.775 MHz, analog FM voice. */
export const LPD433_RANGE: Readonly<ScanRange> = {
	startHz: 433_075_000,
	endHz: 434_775_000,
	rasters: [{ spacingHz: 25_000, firstChannelHz: 433_075_000 }],
	obwHz: [],
	protocols: ["analog-fm", "ism"],
	bandplanId: "ism-433",
}

/**
 * EU UHF paging, 465.975–466.550 MHz (wide-area POCSAG/FLEX inside the 450–470 MHz
 * land-mobile allocation; general public band-plan knowledge). 575 kHz / 12.5 kHz = 46 steps, so
 * 47 channels on the 12.5 kHz raster from 465.975 MHz, plus the 6.25 kHz split raster of the same
 * origin for off-raster carriers. DMR is listed because land-mobile digital carriers share the
 * sub-band; the classifier still ranks the pager trials first (PAGER_RANGE_HYPOTHESES). It is
 * narrower than `uhf-land-mobile` (70 MHz), so `narrowestPriors` picks it inside its span. The
 * range is a scanner overlay like LPD433. The built-in catalogue
 * (`src/core/bandplans/builtin-supplement.ts`) carries the French paging plan `pager-fr`
 * (466.025–466.230 MHz, POCSAG); when the effective plans hold it, only the parts of this span it
 * does not cover are added (465.975–466.025 MHz and 466.230–466.550 MHz, each exclusive of the
 * shared edge), so no frequency is covered by both ranges.
 */
export const PAGER_UHF_RANGE: Readonly<ScanRange> = {
	startHz: 465_975_000,
	endHz: 466_550_000,
	rasters: [
		{ spacingHz: 12_500, firstChannelHz: 465_975_000 },
		{ spacingHz: 6250, firstChannelHz: 465_975_000 },
	],
	obwHz: [12_000],
	protocols: ["pocsag", "flex", "dmr"],
	bandplanId: "pager-uhf",
}

/** The parts of PAGER_UHF_RANGE outside the given ranges' span ([start, end] inclusive Hz). */
export function pagerOverlayParts(covered: readonly ScanRange[]): ScanRange[] {
	let parts: ScanRange[] = [copyRange(PAGER_UHF_RANGE)]
	for (const c of covered)
		parts = parts.flatMap(p => {
			if (c.endHz < p.startHz || c.startHz > p.endHz) return [p]
			const out: ScanRange[] = []
			if (c.startHz > p.startHz)
				out.push({ ...copyRange(p), endHz: c.startHz - 1 })
			if (c.endHz < p.endHz) out.push({ ...copyRange(p), startHz: c.endHz + 1 })
			return out
		})
	return parts
}

/** EU-only plan ids: their presence says the effective plans are the EU variant. */
const EU_MARKERS: ReadonlySet<string> = new Set(["ism-433", "pmr446"])

function copyRange(r: Readonly<ScanRange>): ScanRange {
	return {
		...r,
		rasters: [...(r.rasters ?? [])],
		protocols: [...(r.protocols ?? [])],
		...(r.obwHz !== undefined ? { obwHz: [...r.obwHz] } : {}),
	}
}

/**
 * The ranges plus LPD433 when the effective plans carry the EU `ism-433` plan (hidden: absent),
 * and the EU UHF paging range when they carry an EU-only plan (`ism-433` or `pmr446`).
 */
export function withScannerOverlays(ranges: readonly ScanRange[]): ScanRange[] {
	const out = [...ranges]
	if (
		ranges.some(r => r.bandplanId !== undefined && EU_MARKERS.has(r.bandplanId))
	)
		out.push(
			...pagerOverlayParts(ranges.filter(r => r.bandplanId === "pager-fr")),
		)
	if (ranges.some(r => r.bandplanId === "ism-433"))
		out.push({
			...LPD433_RANGE,
			rasters: [...(LPD433_RANGE.rasters ?? [])],
			protocols: [...(LPD433_RANGE.protocols ?? [])],
		})
	return out
}

/**
 * Priors from the narrowest range covering `hz` that lists protocols (ties: stack order); its
 * protocols get 1 and every other specific protocol the legacy soft prior. `{}` when none lists.
 */
export function narrowestPriors(
	ranges: readonly ScanRange[],
	hz: number,
): Partial<Record<ScannerProtocol, number>> {
	let chosen: ScanRange | undefined
	let width = Infinity
	for (const r of ranges) {
		if (hz < r.startHz || hz > r.endHz) continue
		if (r.protocols === undefined || r.protocols.length === 0) continue
		const w = r.endHz - r.startHz
		if (w < width) {
			width = w
			chosen = r
		}
	}
	return chosen === undefined ? {} : priorsFor([chosen], hz)
}
