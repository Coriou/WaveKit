import { describe, expect, it } from "vitest"

import { freeAreaStyle } from "../../src/shell/overlay-slot.ts"

describe("toasts and status notes centre on the free area", () => {
	it("names the centre of the plot beside a full-height drawer", () => {
		// a 1600 px window with a 560 px drawer and its gutter: 1032 px free
		expect(freeAreaStyle(1032)).toEqual({ "--wk-free-cx": "516px" })
		expect(freeAreaStyle(1031)).toEqual({ "--wk-free-cx": "516px" })
	})
	it("centres on the window without one", () => {
		expect(freeAreaStyle(null)).toBeUndefined()
		expect(freeAreaStyle(0)).toBeUndefined()
	})
})
