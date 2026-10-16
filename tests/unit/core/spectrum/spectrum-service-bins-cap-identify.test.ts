import { describe, expect, it } from "vitest"
import { measureTarget } from "../../../../src/core/scanner/identify.js"
import { TARGET_HZ, summaryOf } from "../../../mocks/scanner/identify-fakes.js"

describe("identify peak with 8192-bin summaries", () => {
	it("finds the strongest bin inside the window and ignores stronger bins outside", () => {
		const base = summaryOf()
		const binHz = base.sampleRateHz / 8192
		const startHz = base.centreHz - base.sampleRateHz / 2
		const bins = Array.from({ length: 8192 }, () => -80)
		const at = (hz: number) => Math.floor((hz - startHz) / binHz)
		bins[at(TARGET_HZ)] = -50
		bins[at(TARGET_HZ + 400)] = -45
		bins[at(TARGET_HZ + 20_000)] = -10 // outside the 1 kHz window
		bins[0] = -5
		bins[8191] = -5
		const summary = { ...base, binHz, startHz, bins }
		expect(measureTarget(null, summary, TARGET_HZ, 1000)).toMatchObject({
			source: "spectrum",
			peakDbfs: -45,
			snrDb: 35,
			floorDbfs: -80,
		})
		// a window narrower than one bin still reads the bin containing the target
		expect(measureTarget(null, summary, TARGET_HZ, 1)).toMatchObject({
			peakDbfs: -50,
		})
	})

	it("a window at the band edges clamps to the array", () => {
		const base = summaryOf()
		const binHz = base.sampleRateHz / 8192
		const startHz = base.centreHz - base.sampleRateHz / 2
		const bins = Array.from({ length: 8192 }, (_, i) => -90 + (i % 7))
		const summary = { ...base, binHz, startHz, bins }
		expect(measureTarget(null, summary, startHz + 100, 5_000).peakDbfs).toBe(
			Math.max(...bins.slice(0, 21)),
		)
		expect(
			measureTarget(null, summary, startHz + 8192 * binHz - 100, 5_000)
				.peakDbfs,
		).toBe(Math.max(...bins.slice(8192 - 21)))
	})
})
