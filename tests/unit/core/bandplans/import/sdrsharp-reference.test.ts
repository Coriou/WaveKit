import { describe, expect, it } from "vitest"
import type { DisplayGroup } from "@wavekit/api-types"
import { parseSdrSharpBandPlan } from "../../../../../src/core/bandplans/import/sdrsharp.js"

// Requirement 10.5: a character reference is at most 12 characters including `&` and `;`.
const options = {
	fileName: "BandPlan.xml",
	overrides: new Map<string, DisplayGroup>(),
}
function parse(name: string) {
	const text = `<ArrayOfRangeEntry><RangeEntry minFrequency="1000" maxFrequency="2000" mode="NFM" step="12500" color="FF112233">${name}</RangeEntry></ArrayOfRangeEntry>`
	return parseSdrSharpBandPlan(new TextEncoder().encode(text), options)
}

describe("SDR# reference bound", () => {
	it("accepts a 12-character decimal reference (&, #, 9 digits, ;)", () => {
		const ref = "&#000000065;"
		expect(ref).toHaveLength(12)
		const result = parse(ref)
		expect(result.ok).toBe(true)
	})
	it("refuses a 13-character decimal reference", () => {
		const ref = "&#0000000065;"
		expect(ref).toHaveLength(13)
		expect(parse(ref).ok).toBe(false)
	})
	it("accepts 12 and refuses 13 characters for hex references", () => {
		expect("&#x00000042;").toHaveLength(12)
		expect(parse("&#x00000042;").ok).toBe(true)
		expect("&#x000000042;").toHaveLength(13)
		expect(parse("&#x000000042;").ok).toBe(false)
	})
})
