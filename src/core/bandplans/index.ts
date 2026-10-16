import type { BandPlanService, BandPlanServiceOptions } from "./contract.js"
import { builtinPackIdFor, projectBuiltinPacks } from "./builtin-packs.js"
import { transition } from "./domain.js"
import { parseSdrppBandPlan } from "./import/sdrpp.js"
import {
	builtinPresetsFor,
	presetIssuesFor,
	presetToJobSpec,
} from "./presets.js"
import { resolveBandPlans } from "./resolve.js"
import { resolveScannerBandplans } from "./scanner-feed.js"
import { createBandPlanService } from "./service.js"

export { BandPlansError } from "./contract.js"
export {
	createScannerBandplanProvider,
	resolveScannerBandplans,
} from "./scanner-feed.js"
export type {
	BandPlanService,
	BandPlanServiceOptions,
	OpenBandPlanService,
} from "./contract.js"

/** Resolves even when storage fails: reads then serve built-ins and writes reject. */
export function openBandPlanService(
	options: BandPlanServiceOptions,
): Promise<BandPlanService> {
	return createBandPlanService(options, {
		projectBuiltinPacks,
		builtinPackIdFor,
		resolveBandPlans,
		transition,
		parseSdrppBandPlan,
		builtinPresetsFor,
		presetIssuesFor,
		presetToJobSpec,
		scannerBandplans: resolveScannerBandplans,
	})
}
