// Per-browser tuning preferences: the tuning step (the Tuner island's chips; the spectrum scrolls by it).
import { Store } from "../../data/index.ts"

export const STEPS: readonly number[] = [
	1000, 5000, 6250, 8330, 12_500, 25_000, 100_000,
]
export const DEFAULT_STEP_HZ = 12_500
const STEP_KEY = "wavekit.web.step"

export interface TuningPrefsState {
	stepHz: number
}

function readStep(): number {
	try {
		const v = Number(globalThis.localStorage?.getItem(STEP_KEY))
		return STEPS.includes(v) ? v : DEFAULT_STEP_HZ
	} catch {
		return DEFAULT_STEP_HZ
	}
}

export class TuningPrefs extends Store<TuningPrefsState> {
	constructor() {
		super({ stepHz: readStep() })
	}

	setStep(stepHz: number): void {
		if (stepHz <= 0 || stepHz === this.get().stepHz) return
		try {
			globalThis.localStorage?.setItem(STEP_KEY, String(stepHz))
		} catch {
			// storage blocked: kept for this page only
		}
		this.set({ stepHz })
	}
}
