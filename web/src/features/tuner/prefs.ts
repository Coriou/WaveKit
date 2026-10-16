// Per-browser tuning preferences: the tuning step (the Tuner island's chips; the spectrum scrolls by it).
// One step for the app: the user's chosen step wins; until they choose one (or after "Auto"), the band
// plan's step at the tuned frequency is the default (tuningStep() in web/src/plot/maths.ts).
import type { ResolvedBandPlanView } from "@wavekit/api-types"

import { Store } from "../../data/index.ts"
import { tuningStep } from "../../plot/maths.ts"

export const STEPS: readonly number[] = [
	1000, 5000, 6250, 8330, 12_500, 25_000, 100_000,
]
export { DEFAULT_STEP_HZ } from "../../plot/maths.ts"
const STEP_KEY = "wavekit.web.step"

export interface TuningPrefsState {
	/** The step the user chose; null follows the band plan. */
	stepHz: number | null
}

function readStep(): number | null {
	try {
		const raw = globalThis.localStorage?.getItem(STEP_KEY)
		if (raw === null || raw === undefined) return null
		const v = Number(raw)
		return STEPS.includes(v) ? v : null
	} catch {
		return null
	}
}

/** The step the app tunes by: the user's choice, else the band plan's at `hz`, else the default. */
export function effectiveStep(
	chosenHz: number | null,
	view: ResolvedBandPlanView | null,
	hz: number | null,
): number {
	return chosenHz !== null && chosenHz > 0 ? chosenHz : tuningStep(view, hz)
}

export class TuningPrefs extends Store<TuningPrefsState> {
	constructor() {
		super({ stepHz: readStep() })
	}

	/** A step from the chips; null returns to the band plan's step. */
	setStep(stepHz: number | null): void {
		const next = stepHz !== null && stepHz > 0 ? stepHz : null
		if (next === this.get().stepHz) return
		try {
			if (next === null) globalThis.localStorage?.removeItem(STEP_KEY)
			else globalThis.localStorage?.setItem(STEP_KEY, String(next))
		} catch {
			// storage blocked: kept for this page only
		}
		this.set({ stepHz: next })
	}
}
