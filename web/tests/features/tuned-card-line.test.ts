import { describe, expect, it } from "vitest"

import {
	LINE_FORCED_REASON,
	lineExpandProps,
} from "../../src/features/tuned/TunedCard.tsx"

describe("the tuned card's line expand control", () => {
	it("expands on click when the reader minimised the card", () => {
		const p = lineExpandProps(false, "1.000 MHz · Signal")
		expect(p["aria-disabled"]).toBeUndefined()
		expect(p.title).toBe("1.000 MHz · Signal · click to expand")
	})

	it("is disabled with its reason while the layout forces the line form", () => {
		const p = lineExpandProps(true, "1.000 MHz · Signal")
		expect(p["aria-disabled"]).toBe(true)
		expect(p.title).toBe(`1.000 MHz · Signal · ${LINE_FORCED_REASON}`)
		expect(LINE_FORCED_REASON).toMatch(/no room/i)
	})
})
