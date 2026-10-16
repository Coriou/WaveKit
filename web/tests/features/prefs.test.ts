import { afterEach, describe, expect, it, vi } from "vitest"
import { buildResolvedBandPlan } from "../../mock/data.ts"
import { effectiveStep, TuningPrefs } from "../../src/features/tuner/prefs.ts"

const plan = buildResolvedBandPlan()

function memoryStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial))
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		map,
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("one tuning step for the app", () => {
	it("the user's chosen step wins over the band plan", () => {
		expect(effectiveStep(25_000, plan, 120_000_000)).toBe(25_000)
	})

	it("the band plan's step is the default until the user chooses", () => {
		expect(effectiveStep(null, plan, 120_000_000)).toBe(8_330) // Airband
		expect(effectiveStep(null, plan, 95_000_000)).toBe(100_000) // FM broadcast
		expect(effectiveStep(null, null, 95_000_000)).toBe(12_500)
	})

	it("starts unchosen, remembers a choice, and Auto (null) forgets it", () => {
		const storage = memoryStorage()
		vi.stubGlobal("localStorage", storage)
		const prefs = new TuningPrefs()
		expect(prefs.get().stepHz).toBeNull()
		prefs.setStep(6_250)
		expect(prefs.get().stepHz).toBe(6_250)
		expect(storage.map.get("wavekit.web.step")).toBe("6250")
		expect(new TuningPrefs().get().stepHz).toBe(6_250)
		prefs.setStep(null)
		expect(prefs.get().stepHz).toBeNull()
		expect(storage.map.has("wavekit.web.step")).toBe(false)
	})

	it("ignores a stored value that is not one of the steps", () => {
		vi.stubGlobal("localStorage", memoryStorage({ "wavekit.web.step": "7" }))
		expect(new TuningPrefs().get().stepHz).toBeNull()
	})
})
