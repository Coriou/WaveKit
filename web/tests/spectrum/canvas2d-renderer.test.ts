import { describe, expect, it } from "vitest"
import {
	BASIC_MAX_WIDTH,
	Canvas2dRenderer,
	columnValue,
	levelLut,
	paintRow,
	tracePoints,
	viewSpans,
	type Basic2d,
	type BasicBuffer,
} from "../../src/spectrum/canvas2d-renderer.ts"
import type { DrawParams } from "../../src/spectrum/renderer.ts"

const TEX = 8
const DEPTH = 4

/** A grey ramp: colour index i is (i, i, i). */
const ramp = new Uint8Array(1024)
for (let i = 0; i < 256; i++) ramp.set([i, i, i, 255], i * 4)

const params = (over: Partial<DrawParams> = {}): DrawParams => ({
	// the view is the whole row of 4 bins
	map: { offset: 0, scale: 4 / TEX, limit: 4 / TEX },
	// byte b lands on colour position b / 255
	level: { scale: 1, offset: 0 },
	newest: 0,
	filled: 1,
	rows: 2,
	tracePx: 100,
	gapPx: 0,
	lineHalfWidth: 0.5,
	peakHold: false,
	...over,
})

const reds = (out: Uint8ClampedArray) => [...out].filter((_, i) => i % 4 === 0)

describe("the bins a pixel shows", () => {
	it("is one bin per pixel when the view has as many pixels as bins", () => {
		const spans = viewSpans(params().map, TEX, 4)
		expect([...spans.first]).toEqual([0, 1, 2, 3])
		expect([...spans.last]).toEqual([0, 1, 2, 3])
	})

	it("keeps a one-bin carrier at full span: a pixel shows the max of the bins it covers", () => {
		// 2048 bins on 512 pixels: four bins per pixel, the carrier in none of their middles
		const bins = 2048
		const row = new Uint8Array(bins).fill(40)
		row[1001] = 250
		const map = { offset: 0, scale: 1, limit: 1 }
		const spans = viewSpans(map, bins, 512)
		const values = Array.from({ length: 512 }, (_, x) =>
			columnValue(row, spans, x, 0, bins),
		)
		expect(Math.max(...values)).toBe(250)
		expect(values.indexOf(250)).toBe(Math.floor(1001 / 4))
		expect(values.filter(v => v === 250)).toHaveLength(1)
		// and on the trace
		const points = tracePoints(row, spans, params({ map, tracePx: 100 }), bins)
		expect(Math.min(...points.map(p => p[1]))).toBeCloseTo(
			100 * (1 - 250 / 255),
		)
	})

	it("has no bin where the view runs past the row", () => {
		const wide = viewSpans({ offset: -0.25, scale: 1, limit: 4 / TEX }, TEX, 4)
		// two bins per pixel: the middle pixels cover bins 0-1 and 2-3, the outer ones none
		expect([...wide.first]).toEqual([-1, 0, 2, -1])
		expect([...wide.last]).toEqual([-1, 1, 3, -1])
	})
})

describe("paintRow", () => {
	it("paints the bins through the levels and the ramp", () => {
		const out = new Uint8ClampedArray(16)
		const spans = viewSpans(params().map, TEX, 4)
		paintRow(
			out,
			Uint8Array.from([0, 100, 200, 255]),
			0,
			spans,
			// 100 → 0, 200 → 1
			levelLut({ scale: 2.55, offset: -1 }),
			ramp,
			4,
		)
		expect(reds(out)).toEqual([0, 0, 255, 255])
	})

	it("draws a row measured before a retune at its own frequency, the rest transparent", () => {
		const out = new Uint8ClampedArray(16)
		const spans = viewSpans(params().map, TEX, 4)
		// the row started 2 bins above the newest row's start
		paintRow(
			out,
			Uint8Array.from([1, 2, 3, 4]),
			2,
			spans,
			levelLut(params().level),
			ramp,
			4,
		)
		expect([out[3], out[7]]).toEqual([0, 0])
		expect([out[8], out[12]]).toEqual([1, 2])
	})

	// The gate's bound: a frame costs one row. Median of many runs, so a busy host does not decide.
	it("paints a 1024 px row of 2048 bins in well under 4 ms", () => {
		const bins = 2048
		const row = Uint8Array.from({ length: bins }, (_, i) => i % 251)
		const spans = viewSpans(
			{ offset: 0, scale: 1, limit: 1 },
			bins,
			BASIC_MAX_WIDTH,
		)
		const lut = levelLut({ scale: 1, offset: 0 })
		const out = new Uint8ClampedArray(BASIC_MAX_WIDTH * 4)
		const times: number[] = []
		for (let i = 0; i < 400; i++) {
			const t0 = performance.now()
			paintRow(out, row, 0, spans, lut, ramp, bins)
			times.push(performance.now() - t0)
		}
		times.sort((a, b) => a - b)
		expect(times[200]).toBeLessThan(4)
	})
})

describe("Canvas2dRenderer", () => {
	function fakes() {
		const calls: string[] = []
		let images = 0
		const ctx = {
			canvas: { width: 0, height: 0 },
			strokeStyle: "",
			lineWidth: 0,
			globalAlpha: 1,
			imageSmoothingEnabled: true,
			clearRect: () => calls.push("clear"),
			beginPath: () => calls.push("begin"),
			moveTo: () => calls.push("move"),
			lineTo: () => calls.push("line"),
			stroke: () => calls.push(`stroke ${ctx.strokeStyle}`),
			drawImage: (...args: unknown[]) =>
				calls.push(`plot ${args.slice(1).join(",")}`),
		}
		const buffer = {
			canvas: { width: 0, height: 0 },
			ctx: {
				createImageData: (width: number, height: number) => {
					images++
					return {
						width,
						height,
						data: new Uint8ClampedArray(width * height * 4),
					} as unknown as ImageData
				},
				putImageData: (image: ImageData, _x: number, y: number) =>
					calls.push(`row ${y}: ${reds(image.data).join(",")}`),
				drawImage: (...args: unknown[]) =>
					calls.push(`scroll ${args.slice(1).join(",")}`),
			},
		}
		return {
			ctx: ctx as unknown as Basic2d & { canvas: { width: number } },
			buffer: buffer as unknown as BasicBuffer & {
				canvas: { width: number; height: number }
			},
			calls,
			images: () => images,
		}
	}
	const ready = () => {
		const f = fakes()
		const renderer = new Canvas2dRenderer(f.ctx, TEX, DEPTH, f.buffer)
		renderer.resize(4, 300)
		renderer.setRamp(ramp)
		return { ...f, renderer }
	}

	it("says what it is, and sizes its waterfall canvas once, as deep as the history", () => {
		const t = ready()
		expect(t.renderer.kind).toBe("canvas2d")
		expect(t.buffer.canvas).toMatchObject({ width: 4, height: DEPTH })
		expect(t.images()).toBe(1)
	})

	it("draws the waterfall stretched under the trace band, then the trace in the ramp's line colour", () => {
		const t = ready()
		t.renderer.uploadRow(0, Uint8Array.from([10, 20, 30, 40]), 4)
		t.renderer.uploadTrace(Uint8Array.from([10, 20, 30, 40]), 4)
		t.renderer.draw(params())
		// one row of the two the band holds: 4 px wide, 100 px high, under the 100 px trace band
		expect(t.calls).toEqual([
			"clear",
			"row 0: 10,20,30,40",
			"plot 0,0,4,1,0,100,4,100",
			"begin",
			"move",
			"line",
			"line",
			"line",
			"stroke rgb(209, 209, 209)",
		])
	})

	it("paints one row per new frame: it scrolls what it holds and adds the row", () => {
		const t = ready()
		t.renderer.uploadRow(0, Uint8Array.from([10, 20, 30, 40]), 4)
		t.renderer.draw(params({ tracePx: 0 }))
		t.calls.length = 0
		t.renderer.uploadRow(1, Uint8Array.from([50, 60, 70, 80]), 4)
		t.renderer.draw(params({ tracePx: 0, newest: 1, filled: 2 }))
		expect(t.calls).toEqual([
			"clear",
			// the row held moves down by one, the new one lands on top
			"scroll 0,0,4,1,0,1,4,1",
			"row 0: 50,60,70,80",
			"plot 0,0,4,2,0,0,4,300",
		])
		// a draw with nothing new paints nothing
		t.calls.length = 0
		t.renderer.draw(params({ tracePx: 0, newest: 1, filled: 2 }))
		expect(t.calls).toEqual(["clear", "plot 0,0,4,2,0,0,4,300"])
		// and no image was allocated on the way
		expect(t.images()).toBe(1)
	})

	it("repaints every row held when the levels, the view, the colours or the offsets change", () => {
		const t = ready()
		t.renderer.uploadRow(0, Uint8Array.from([10, 20, 30, 40]), 4)
		t.renderer.uploadRow(1, Uint8Array.from([50, 60, 70, 80]), 4)
		const held = params({ tracePx: 0, newest: 1, filled: 2 })
		t.renderer.draw(held)
		const repaints = (change: () => void, with_: DrawParams) => {
			t.calls.length = 0
			change()
			t.renderer.draw(with_)
			return t.calls.filter(c => c.startsWith("row")).length
		}
		expect(repaints(() => {}, held)).toBe(0)
		expect(
			repaints(() => {}, { ...held, level: { scale: 0.5, offset: 0 } }),
		).toBe(2)
		expect(
			repaints(() => {}, {
				...held,
				level: { scale: 0.5, offset: 0 },
				map: { offset: 0, scale: 2 / TEX, limit: 4 / TEX },
			}),
		).toBe(2)
		const zoomed: DrawParams = {
			...held,
			level: { scale: 0.5, offset: 0 },
			map: { offset: 0, scale: 2 / TEX, limit: 4 / TEX },
		}
		expect(repaints(() => t.renderer.setRamp(ramp), zoomed)).toBe(2)
		expect(
			repaints(
				() => t.renderer.uploadRowOffsets(new Float32Array(DEPTH)),
				zoomed,
			),
		).toBe(2)
		expect(repaints(() => t.renderer.resize(4, 200), zoomed)).toBe(2)
		expect(t.images()).toBe(1)
	})

	it("draws nothing but the clear before the first row", () => {
		const t = ready()
		t.renderer.draw(params({ filled: 0 }))
		expect(t.calls).toEqual(["clear"])
	})

	it("paints the waterfall no wider than its bound on a wide plot", () => {
		const f = fakes()
		const renderer = new Canvas2dRenderer(f.ctx, TEX, DEPTH, f.buffer)
		renderer.resize(BASIC_MAX_WIDTH * 3, 300)
		expect(f.buffer.canvas.width).toBe(BASIC_MAX_WIDTH)
		renderer.uploadRow(0, Uint8Array.from([10, 20, 30, 40]), 4)
		renderer.draw(params({ tracePx: 0 }))
		expect(f.calls).toContain(
			`plot 0,0,${BASIC_MAX_WIDTH},1,0,0,${BASIC_MAX_WIDTH * 3},150`,
		)
	})
})
