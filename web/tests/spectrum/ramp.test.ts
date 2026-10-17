import { describe, expect, it } from "vitest"
import {
	DEFAULT_THEME,
	WATERFALL_NAMES,
	buildRamp,
	matchAccentRamp,
	parseCssColor,
	rampGradient,
	waterfallRamp,
	waterfallStops,
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
		const i = Math.round(0.86 * 255) * 4
		const near = Array.from(r.subarray(i, i + 3))
		DEFAULT_THEME.accent
			.slice(0, 3)
			.forEach((c, k) =>
				expect(Math.abs((near[k] ?? 0) - c)).toBeLessThanOrEqual(3),
			)
		for (let k = 3; k < 1024; k += 4) expect(r[k]).toBe(255)
	})
})

describe("waterfall colours (the Spectrum board's rampStops)", () => {
	const paper = {
		plotBg: [0xf4, 0xf0, 0xe6, 255] as [number, number, number, number],
		accent: [0x1d, 0x6b, 0x52, 255] as [number, number, number, number],
		text: [0x2a, 0x24, 0x1c, 255] as [number, number, number, number],
		light: true,
	}

	it("every ramp starts on the plot background, opaque", () => {
		for (const name of WATERFALL_NAMES)
			for (const theme of [DEFAULT_THEME, paper]) {
				const r = waterfallRamp(name, theme)
				expect(Array.from(r.subarray(0, 3))).toEqual(theme.plotBg.slice(0, 3))
				for (let k = 3; k < 1024; k += 4) expect(r[k]).toBe(255)
			}
	})

	it("Classic is SDR++-style heat on dark and its paper variant on light", () => {
		const dark = waterfallStops("classic", DEFAULT_THEME)
		expect(dark.at(-1)?.color).toEqual([200, 30, 30, 255])
		expect(dark.map(s => s.at)).toEqual([0, 0.25, 0.45, 0.62, 0.78, 0.9, 1])
		const light = waterfallStops("classic", paper)
		expect(light.at(-1)?.color).toEqual([96, 16, 20, 255])
	})

	it("Match accent on dark passes the accent at 0.86 and ends on the ink", () => {
		const s = waterfallStops("match", DEFAULT_THEME)
		expect(s.find(x => x.at === 0.86)?.color).toEqual(DEFAULT_THEME.accent)
		expect(s.at(-1)?.color).toEqual(DEFAULT_THEME.text)
		// the HSL stops stay in the accent's hue: green dominates
		const mid = s.find(x => x.at === 0.5)?.color ?? [0, 0, 0, 0]
		expect(mid[1]).toBeGreaterThan(mid[0])
	})

	it("Paper's strong signals are the darkest marks (ramp a)", () => {
		const s = waterfallStops("match", paper)
		expect(s.map(x => x.at)).toEqual([0, 0.38, 0.72, 1])
		expect(s.at(-1)?.color).toEqual(paper.text)
	})

	it("previews are CSS gradients of the same stops", () => {
		expect(rampGradient("mono", DEFAULT_THEME)).toMatch(
			/^linear-gradient\(90deg, rgb\(11 21 18\) 0%, .* 100%\)$/,
		)
	})
})
