import { describe, expect, it } from "vitest"
import { buildResolvedBandPlan } from "../../mock/data.ts"
import { bandAt, bandsAt, channelAt } from "../../src/data/bandplan-store.ts"

const view = buildResolvedBandPlan()
const at = (mhz: number) => bandAt(view, Math.round(mhz * 1e6))?.key ?? null

describe("bandAt", () => {
	it("picks the narrowest band whose uncovered segments contain the frequency", () => {
		expect(at(161.15)).toBe("builtin-fr/marine")
		expect(at(150)).toBe("builtin-fr/lmv")
		expect(at(446.00625)).toBe("builtin-fr/pmr446")
		expect(at(433.92)).toBe("builtin-fr/ism433")
		expect(at(144.8)).toBe("builtin-eu/amateur-2m")
		expect(at(1090)).toBe("builtin-eu/adsb")
	})

	it("lets a higher layer name its range: the operator band wins over the packs below", () => {
		expect(at(156.8)).toBe("operator/harbour")
		expect(bandsAt(view, 156_800_000).map(b => b.key)).toEqual([
			"operator/harbour",
		])
		// Marine VHF keeps the parts the operator band leaves.
		expect(at(156.3)).toBe("builtin-fr/marine")
	})

	it("skips hidden and shadowed bands", () => {
		expect(view.hidden).toContain("builtin-fr/dab")
		expect(view.shadowed).toContain("builtin-eu/amateur-70cm")
		expect(at(200)).toBeNull()
		expect(at(435)).toBe("builtin-fr/lmu")
	})

	it("includes inclusive band edges and returns null outside every band", () => {
		expect(at(118)).toBe("builtin-eu/air")
		expect(at(136.999)).toBe("builtin-eu/air")
		// 137 MHz is an edge of both: the narrower band names it.
		expect(at(137)).toBe("builtin-eu/wxsat")
		expect(at(50)).toBeNull()
		expect(bandAt(null, 161_150_000)).toBeNull()
	})

	it("finds the plan channel near a frequency", () => {
		const pmr = bandAt(view, 446_006_000)
		expect(channelAt(pmr, 446_006_000)?.name).toBe("PMR446 ch 1")
		expect(channelAt(pmr, 446_150_000, 1000)).toBeNull()
		expect(channelAt(bandAt(view, 156_800_000), 156_800_000)).toBeNull()
	})
})
