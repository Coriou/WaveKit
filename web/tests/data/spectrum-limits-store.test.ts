import { describe, expect, it } from "vitest"
import {
	parseSpectrumLimits,
	SpectrumLimitsStore,
} from "../../src/data/spectrum-limits-store.ts"
import { json, scripted } from "./fake-fetch.ts"

describe("spectrum limits", () => {
	it("reads bins.max and the WG8 cap from GET /api/spectrum", async () => {
		const { api, calls } = scripted(() =>
			json(200, {
				limits: {
					bins: { min: 128, max: 4096 },
					binsCap: { setting: "auto", cap: 8192, source: "measured" },
				},
			}),
		)
		const store = new SpectrumLimitsStore(api)
		expect(store.get().binsMax).toBeNull()
		await store.load()
		expect(calls.map(c => c.url)).toEqual(["/api/spectrum"])
		expect(store.get()).toEqual({
			binsMax: 4096,
			binsCap: { setting: "auto", cap: 8192, source: "measured" },
			error: null,
		})
	})

	it("drops a cap it does not understand and keeps the last limits on failure", async () => {
		expect(
			parseSpectrumLimits({
				limits: {
					bins: { max: 2048 },
					binsCap: { setting: 3000, cap: 3000, source: "config" },
				},
			}),
		).toEqual({ binsMax: 2048, binsCap: null })
		expect(parseSpectrumLimits({ limits: {} })).toBeNull()
		expect(parseSpectrumLimits(null)).toBeNull()
		let fail = false
		const { api } = scripted(() =>
			fail
				? json(503, { error: "down" })
				: json(200, { limits: { bins: { max: 2048 } } }),
		)
		const store = new SpectrumLimitsStore(api)
		await store.load()
		fail = true
		await store.load()
		expect(store.get().binsMax).toBe(2048)
		expect(store.get().error).not.toBeNull()
	})
})
