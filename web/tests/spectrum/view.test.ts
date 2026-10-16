import { describe, expect, it } from "vitest"
import {
	captureSpan,
	hzToTexU,
	hzToX,
	panView,
	splitHeight,
	texMapping,
	visibleRows,
	xToHz,
	zoomView,
} from "../../src/spectrum/view.ts"

const axis = { startHz: 445_180_800, binHz: 4000, binCount: 410 }
const W = 2048

describe("view mapping", () => {
	it("captureSpan covers binCount bins", () => {
		expect(captureSpan(axis)).toEqual({
			startHz: 445_180_800,
			endHz: 445_180_800 + 410 * 4000,
		})
	})

	it("bin centres land on texel centres", () => {
		for (const i of [0, 1, 200, 409]) {
			const hz = axis.startHz + (i + 0.5) * axis.binHz
			expect(hzToTexU(hz, axis, W)).toBeCloseTo((i + 0.5) / W, 12)
		}
	})

	it("the whole capture maps x 0–1 onto u 0–limit", () => {
		const m = texMapping(null, axis, W)
		expect(m.offset).toBeCloseTo(0, 12)
		expect(m.offset + m.scale).toBeCloseTo(410 / W, 12)
		expect(m.limit).toBeCloseTo(410 / W, 12)
	})

	it("a zoomed view maps its edges to the right bins (sub-Hz exact at RF)", () => {
		const view = { startHz: 446_000_000, endHz: 446_100_000 }
		const m = texMapping(view, axis, W)
		const u = (x: number) => m.offset + x * m.scale
		expect(u(0) * W).toBeCloseTo((446_000_000 - axis.startHz) / 4000, 9)
		expect(u(1) * W).toBeCloseTo((446_100_000 - axis.startHz) / 4000, 9)
		expect(u(0.5)).toBeCloseTo(hzToTexU(446_050_000, axis, W), 12)
	})

	it("a view wider than the capture maps outside 0–limit (drawn empty)", () => {
		const view = {
			startHz: axis.startHz - 100_000,
			endHz: axis.startHz + 2_000_000,
		}
		const m = texMapping(view, axis, W)
		expect(m.offset).toBeLessThan(0)
		expect(m.offset + m.scale).toBeGreaterThan(m.limit)
	})

	it("hzToX and xToHz are inverses", () => {
		const view = { startHz: 100e6, endHz: 102e6 }
		expect(hzToX(101e6, view)).toBe(0.5)
		expect(xToHz(0.25, view)).toBe(100.5e6)
	})
})

describe("zoom and pan", () => {
	const bounds = { startHz: 100e6, endHz: 102e6 }

	it("keeps the anchored frequency under the cursor", () => {
		const v = zoomView(bounds, 0.25, 2, bounds, 1000)
		expect(v.endHz - v.startHz).toBe(1e6)
		expect(xToHz(0.25, v)).toBeCloseTo(xToHz(0.25, bounds), 3)
	})

	it("clamps to bounds and to the minimum span", () => {
		const v = zoomView(bounds, 0, 1e9, bounds, 5000)
		expect(v.endHz - v.startHz).toBe(5000)
		expect(v.startHz).toBe(100e6)
		expect(zoomView(bounds, 0.5, 0.1, bounds, 1000)).toEqual(bounds)
		const half = { startHz: 101e6, endHz: 102e6 }
		expect(panView(half, 5e5, bounds)).toEqual(half)
		expect(panView(half, -5e5, bounds)).toEqual({
			startHz: 100.5e6,
			endHz: 101.5e6,
		})
	})
})

describe("layout", () => {
	it("splits the height and counts waterfall rows", () => {
		expect(splitHeight(1000, 0.3)).toEqual({ tracePx: 300, waterfallPx: 700 })
		expect(splitHeight(1000, 2)).toEqual({ tracePx: 1000, waterfallPx: 0 })
		expect(visibleRows(700, 2, 1024)).toBe(350)
		expect(visibleRows(4000, 1, 1024)).toBe(1024)
		expect(visibleRows(0, 1, 1024)).toBe(1)
	})
})
