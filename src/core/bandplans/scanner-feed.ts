/**
 * Effective scanner list for one stack view (design "Batch 2: scanner feed").
 * Pure and total: the scanner's own plan objects, never a copy and never an edit.
 * A malformed view yields `[]` by design (frozen contract: total, never throws);
 * `createScannerBandplanProvider` is the one place that degrades to the
 * built-in list, when the view is missing or reading it throws.
 */
import type { BandPlanStackView, BandRegion } from "@wavekit/api-types"
import { builtinBandplansFor } from "./builtin-supplement.js"
import type { Bandplan, BandRegionCode } from "../scanner/bandplan/index.js"
import type {
	ResolveScannerBandplans,
	ScannerBandplanProvider,
} from "./contract.js"

function collect(view: BandPlanStackView): readonly Bandplan[] {
	const regionByPack = new Map<string, BandRegion>()
	const seenPack = new Set<string>()
	for (const pack of view.packs) {
		if (seenPack.has(pack.id)) continue
		seenPack.add(pack.id)
		if (pack.kind === "builtin" && pack.region !== null)
			regionByPack.set(pack.id, pack.region)
	}
	const hidden = new Set<string>()
	for (const edit of view.edits) {
		if (edit.set.hidden === true) hidden.add(`${edit.packId}/${edit.bandId}`)
	}
	const emitted = new Set<string>()
	const plans: Bandplan[] = []
	for (const entry of view.stack.entries) {
		if (!entry.enabled) continue
		const region = regionByPack.get(entry.packId)
		if (region === undefined) continue
		for (const plan of builtinBandplansFor(region)) {
			if (hidden.has(`${entry.packId}/${plan.id}`)) continue
			if (emitted.has(plan.id)) continue
			emitted.add(plan.id)
			plans.push(plan)
		}
	}
	return plans
}

export const resolveScannerBandplans: ResolveScannerBandplans = view => {
	try {
		return collect(view)
	} catch {
		return []
	}
}

/**
 * The scanner's `bandplans` provider, read per call. `getView` returns undefined
 * until the band-plan service is open; then, and when `getView` throws, the
 * scanner gets `builtinBandplansFor(region)`. `onError` sees the throw; its own
 * failure is ignored so the scanner always gets a list.
 */
export function createScannerBandplanProvider(
	getView: () => BandPlanStackView | undefined,
	region: BandRegionCode,
	onError?: (err: unknown) => void,
): ScannerBandplanProvider {
	return () => {
		let view: BandPlanStackView | undefined
		try {
			view = getView()
		} catch (err) {
			try {
				onError?.(err)
			} catch {
				// Reporting is best-effort; the fallback below still applies.
			}
			return builtinBandplansFor(region)
		}
		if (view === undefined) return builtinBandplansFor(region)
		return resolveScannerBandplans(view)
	}
}
