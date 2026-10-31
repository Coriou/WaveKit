/**
 * Comm-B in the aircraft presentation: what the crew selected and what the aircraft measured fill
 * the fields its position report leaves free, within the six-field budget. Fictional aircraft.
 */
import { describe, expect, it } from "vitest"
import { presentAircraft } from "../../../../../src/core/activity/presentation/aircraft.js"
import { MAX_FIELDS } from "../../../../../src/core/activity/presentation/budget.js"
import { loadCommBSample } from "../../../../mocks/fixtures/adsb/index.js"

describe("Comm-B in the aircraft presentation", () => {
	it("a full report keeps its basic fields and adds the selected altitude", () => {
		const [full] = loadCommBSample()
		const p = presentAircraft(full)
		expect(p?.fields?.map(f => f.key)).toEqual([
			"squawk",
			"altitude",
			"groundSpeed",
			"track",
			"verticalRate",
			"selectedAltitude",
		])
		expect(p?.fields?.at(-1)).toMatchObject({
			label: "Selected altitude",
			unit: "ft",
			value: 36000,
		})
	})

	it("a Comm-B-only reply shows what it carried", () => {
		const [, only] = loadCommBSample()
		const p = presentAircraft(only)
		const byKey = Object.fromEntries((p?.fields ?? []).map(f => [f.key, f]))
		expect(Object.keys(byKey)).toEqual([
			"altitude",
			"selectedAltitude",
			"ias",
			"mach",
			"magHeading",
			"qnh",
		])
		expect(byKey["ias"]).toMatchObject({ unit: "kt", value: 250 })
		expect(byKey["mach"]).toMatchObject({ value: 0.42 })
		expect(byKey["qnh"]).toMatchObject({ unit: "hPa", value: 1013.2 })
		expect(p?.fields?.length).toBeLessThanOrEqual(MAX_FIELDS)
	})
})
