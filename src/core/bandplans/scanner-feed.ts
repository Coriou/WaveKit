/**
 * Effective scanner list for one stack view (design "Batch 2: scanner feed").
 * Pure and total: the scanner's own plan objects, never a copy and never an edit.
 */
import type { BandPlanStackView, BandRegion } from "@wavekit/api-types"
import { bandplansFor } from "../scanner/bandplan/index.js"
import type { Bandplan } from "../scanner/bandplan/index.js"
import type { ResolveScannerBandplans } from "./contract.js"

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
		for (const plan of bandplansFor(region)) {
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
