import { describe, expect, it } from "vitest"

import {
	dragRange,
	finishRange,
	hzAt,
	rangeBox,
	rangeText,
} from "../../src/plot/range-select.ts"

const view = { startHz: 146_000_000, endHz: 148_000_000 }

describe("Shift-drag range", () => {
	it("maps the pointer to Hz, clamped to the view", () => {
		expect(hzAt(view, 0.25)).toBe(146_500_000)
		expect(hzAt(view, -1)).toBe(146_000_000)
		expect(hzAt(view, 2)).toBe(148_000_000)
	})

	it("drags in either direction", () => {
		expect(dragRange(147e6, 146.5e6)).toEqual({
			startHz: 146.5e6,
			endHz: 147e6,
			done: false,
		})
	})

	it("snaps the edges outwards to 12.5 kHz and drops a range under 25 kHz", () => {
		expect(finishRange({ startHz: 146_006_000, endHz: 146_493_000 })).toEqual({
			startHz: 146_000_000,
			endHz: 146_500_000,
			done: true,
		})
		expect(finishRange({ startHz: 146_001_000, endHz: 146_011_000 })).toBeNull()
		expect(
			finishRange({ startHz: 146_000_000, endHz: 146_025_000 }),
		).not.toBeNull()
	})

	it("reads as MHz with three decimals", () => {
		expect(rangeText({ startHz: 146e6, endHz: 146.5e6 })).toBe(
			"146.000–146.500",
		)
	})

	it("draws clipped to the view and keeps the offer on screen", () => {
		expect(rangeBox({ startHz: 146.5e6, endHz: 147e6 }, view)).toEqual({
			left: 25,
			width: 25,
			mid: 37.5,
		})
		const edge = rangeBox({ startHz: 145e6, endHz: 146.1e6 }, view)
		expect(edge?.left).toBe(0)
		expect(edge?.width).toBeCloseTo(5, 6)
		expect(edge?.mid).toBe(14)
		expect(rangeBox({ startHz: 150e6, endHz: 151e6 }, view)).toBeNull()
	})
})
