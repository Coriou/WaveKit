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

/** The ranges plus LPD433 when the effective plans carry the EU `ism-433` plan (hidden: absent). */
export function withScannerOverlays(ranges: readonly ScanRange[]): ScanRange[] {
	const out = [...ranges]
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
