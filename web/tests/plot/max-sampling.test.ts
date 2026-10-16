// The waterfall and trace take the MAX over the bins under a pixel when zoomed out (C3 gap fixed in C5a):
// coveredBins mirrors the fragment shader's sampleSpan.
import { describe, expect, it } from "vitest"
import { DEFAULT_LAYOUT } from "../../src/spectrum/protocol.ts"
import { SpectrumScene } from "../../src/spectrum/scene.ts"
import {
	MAX_TAPS,
	coveredBins,
	maxOverBins,
	texMapping,
} from "../../src/spectrum/view.ts"
import { FakeRenderer } from "../spectrum/fakes.ts"

const TEX = 2048
const axis = { startHz: 160_300_000, binHz: 2_400_000 / 2048, binCount: 2048 }

describe("coveredBins", () => {
	it("is null (linear sample) when a pixel covers at most one bin", () => {
		const map = texMapping(
			{ startHz: 161_000_000, endHz: 161_200_000 },
			axis,
			TEX,
		)
		expect(coveredBins(499.5, 500.5, map, TEX, 1000)).toBeNull()
	})

	it("covers every bin under a pixel when zoomed out", () => {
		const map = texMapping(null, axis, TEX)
		// 2048 bins over 500 px: about 4.1 bins per pixel.
		const span = coveredBins(99.5, 100.5, map, TEX, 500)
		expect(span).not.toBeNull()
		if (!span) return
		expect(span.stride).toBe(1)
		expect(span.last - span.first + 1).toBeGreaterThanOrEqual(4)
		expect(span.last - span.first + 1).toBeLessThanOrEqual(6)
		// Adjacent pixels leave no bin uncovered.
		const next = coveredBins(100.5, 101.5, map, TEX, 500)
		expect(next && next.first <= span.last + 1).toBe(true)
	})

	it("a one-bin signal shows on every pixel width (no gaps from linear interpolation)", () => {
		const row = new Uint8Array(2048).fill(20)
		const map = texMapping(null, axis, TEX)
		for (const width of [200, 333, 640, 1024, 1500]) {
			for (const bin of [0, 7, 1023, 1500, 2047]) {
				row.fill(20)
				row[bin] = 250
				let seen = 0
				for (let px = 0; px < width; px++) {
					const span = coveredBins(px, px + 1, map, TEX, width)
					if (span && maxOverBins(row, span) === 250) seen++
				}
				expect(seen, `bin ${bin} at ${width} px`).toBeGreaterThanOrEqual(1)
			}
		}
	})

	it("bounds the fetches per pixel and stays inside the row", () => {
		const map = texMapping(null, { ...axis, binCount: 1000 }, TEX)
		const span = coveredBins(0, 30, map, TEX, 30)
		expect(span).not.toBeNull()
		if (!span) return
		expect(
			Math.ceil((span.last - span.first + 1) / span.stride),
		).toBeLessThanOrEqual(MAX_TAPS)
		expect(span.first).toBeGreaterThanOrEqual(0)
		expect(span.last).toBeLessThanOrEqual(999)
	})
})

describe("trace/waterfall gap", () => {
	it("leaves gapCss between the bands and fits the waterfall rows below it", () => {
		const renderer = new FakeRenderer()
		const scene = new SpectrumScene(renderer, {
			depth: 1024,
			texWidth: TEX,
			layout: {
				...DEFAULT_LAYOUT,
				splitRatio: 0.25,
				gapCss: 54,
				rowHeightCss: 1,
			},
			levels: { minDb: -120, maxDb: -20 },
			size: { widthCss: 100, heightCss: 400, dpr: 2 },
			invalidate: () => undefined,
		})
		const p = scene.drawParams()
		expect(p.tracePx).toBe(200)
		expect(p.gapPx).toBe(108)
		expect(p.rows).toBe((800 - 200 - 108) / 2)
		expect(DEFAULT_LAYOUT.gapCss).toBe(0)
	})
})
