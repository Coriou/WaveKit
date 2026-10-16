import { describe, expect, it } from "vitest"
import {
	DEFAULT_THEME,
	buildRamp,
	matchAccentRamp,
	parseCssColor,
} from "../../src/spectrum/ramp.ts"

describe("parseCssColor", () => {
	it("reads the token forms ui.css uses", () => {
		expect(parseCssColor(" #7becc7 ")).toEqual([0x7b, 0xec, 0xc7, 255])
		expect(parseCssColor("#fff")).toEqual([255, 255, 255, 255])
		expect(parseCssColor("#00000080")).toEqual([0, 0, 0, 128])
		expect(parseCssColor("rgba(17,28,25,.5)")).toEqual([17, 28, 25, 128])
		expect(parseCssColor("rgb(1 2 3 / 50%)")).toEqual([1, 2, 3, 128])
		expect(parseCssColor("")).toBeNull()
		expect(parseCssColor("var(--wk-x)")).toBeNull()
		expect(parseCssColor("#12345")).toBeNull()
	})
})

describe("ramps", () => {
	it("buildRamp interpolates 256 entries between stops", () => {
		const r = buildRamp([
			{ at: 0, color: [0, 0, 0, 255] },
			{ at: 1, color: [255, 255, 255, 255] },
		])
		expect(r.length).toBe(1024)
		expect(Array.from(r.subarray(0, 4))).toEqual([0, 0, 0, 255])
		expect(Array.from(r.subarray(1020, 1024))).toEqual([255, 255, 255, 255])
		expect(r[128 * 4]).toBe(128)
	})

	it("Match-accent starts at the plot background and passes the accent", () => {
		const r = matchAccentRamp(DEFAULT_THEME)
		expect(Array.from(r.subarray(0, 3))).toEqual(
			DEFAULT_THEME.plotBg.slice(0, 3),
		)
		const i = Math.round(0.75 * 255) * 4
		const near = Array.from(r.subarray(i, i + 3))
		DEFAULT_THEME.accent
			.slice(0, 3)
			.forEach((c, k) =>
				expect(Math.abs((near[k] ?? 0) - c)).toBeLessThanOrEqual(3),
			)
		for (let k = 3; k < 1024; k += 4) expect(r[k]).toBe(255)
	})
})
