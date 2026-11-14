import { describe, expect, it } from "vitest"
import {
	BASIC_MAX_WIDTH,
	Canvas2dRenderer,
	paintWaterfall,
	tracePoints,
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

describe("paintWaterfall", () => {
	it("paints each row's bins through the ramp, newest first", () => {
		const rows = new Uint8Array(TEX * DEPTH)
		rows.set([10, 20, 30, 40], 1 * TEX) // ring row 1, the newest
		rows.set([50, 60, 70, 80], 0 * TEX) // ring row 0, one older
		const out = new Uint8ClampedArray(4 * 2 * 4)
		paintWaterfall(
			out,
			4,
			2,
			rows,
			TEX,
			DEPTH,
			new Float32Array(DEPTH),
			ramp,
			params({ newest: 1, filled: 2 }),
		)
		const reds = [...out].filter((_, i) => i % 4 === 0)
		expect(reds).toEqual([10, 20, 30, 40, 50, 60, 70, 80])
		expect([...out].filter((_, i) => i % 4 === 3)).toEqual(Array(8).fill(255))
	})

	it("draws a row measured before a retune at its own frequency, the rest transparent", () => {
		const rows = new Uint8Array(TEX * DEPTH)
		rows.set([1, 2, 3, 4], 0)
		const offsets = new Float32Array(DEPTH)
		// the row started 2 bins above the newest row's start
		offsets[0] = 2
		const out = new Uint8ClampedArray(4 * 4)
		paintWaterfall(out, 4, 1, rows, TEX, DEPTH, offsets, ramp, params())
		expect([out[3], out[7]]).toEqual([0, 0])
		expect([out[8], out[12]]).toEqual([1, 2])
	})

	it("applies the levels: below the scale is the ramp's first colour, above its last", () => {
		const rows = new Uint8Array(TEX * DEPTH)
		rows.set([0, 100, 200, 255], 0)
		const out = new Uint8ClampedArray(4 * 4)
		paintWaterfall(
			out,
			4,
			1,
			rows,
			TEX,
			DEPTH,
			new Float32Array(DEPTH),
			ramp,
			// 100 → 0, 200 → 1
			params({ level: { scale: 2.55, offset: -1 } }),
		)
		expect([out[0], out[4], out[8], out[12]]).toEqual([0, 0, 255, 255])
	})
})

describe("tracePoints", () => {
	it("puts a full-scale bin at the top of the trace band and an empty one at its bottom", () => {
		const row = Uint8Array.from([0, 255, 0, 255, 9, 9, 9, 9])
		expect(tracePoints(row, TEX, 4, params())).toEqual([
			[0.5, 100],
			[1.5, 0],
			[2.5, 100],
			[3.5, 0],
		])
	})

	it("has no point where the view runs past the row", () => {
		const row = new Uint8Array(TEX)
		const wide = params({ map: { offset: -0.25, scale: 1, limit: 4 / TEX } })
		expect(tracePoints(row, TEX, 4, wide).map(p => p[0])).toEqual([1.5, 2.5])
	})
})

describe("Canvas2dRenderer", () => {
	function fakes() {
		const calls: string[] = []
		const images: { width: number; height: number; data: Uint8ClampedArray }[] =
			[]
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
			stroke: () => calls.push("stroke"),
			putImageData: () => calls.push("put"),
			createImageData: (width: number, height: number) => {
				const image = {
					width,
					height,
					data: new Uint8ClampedArray(width * height * 4),
				}
				images.push(image)
				return image as unknown as ImageData
			},
			drawImage: (...args: unknown[]) =>
				calls.push(`image ${args.slice(1).join(",")}`),
		}
		const buffer = {
			canvas: { width: 0, height: 0 },
			ctx: { putImageData: () => calls.push("buffer") },
		}
		return {
			ctx: ctx as unknown as Basic2d & { canvas: { width: number } },
			buffer: buffer as unknown as BasicBuffer,
			calls,
			images,
		}
	}

	it("says what it is", () => {
		const f = fakes()
		expect(new Canvas2dRenderer(f.ctx, TEX, DEPTH, f.buffer).kind).toBe(
			"canvas2d",
		)
	})

	it("draws the waterfall stretched under the trace band, then the trace", () => {
		const f = fakes()
		const renderer = new Canvas2dRenderer(f.ctx, TEX, DEPTH, f.buffer)
		renderer.resize(4, 300)
		renderer.setRamp(ramp)
		renderer.uploadRow(0, Uint8Array.from([10, 20, 30, 40]), 4)
		renderer.uploadTrace(Uint8Array.from([10, 20, 30, 40]), 4)
		renderer.draw(params())
		expect(f.ctx.canvas.width).toBe(4)
		// one row of the two the band holds: 4 px wide, 100 px high, under the 100 px trace band
		expect(f.calls).toEqual([
			"clear",
			"buffer",
			"image 0,0,4,1,0,100,4,100",
			"begin",
			"move",
			"line",
			"line",
			"line",
			"stroke",
		])
		expect(
			[...(f.images[0]?.data ?? [])].filter((_, i) => i % 4 === 0),
		).toEqual([10, 20, 30, 40])
	})

	it("draws nothing but the clear before the first row", () => {
		const f = fakes()
		const renderer = new Canvas2dRenderer(f.ctx, TEX, DEPTH, f.buffer)
		renderer.resize(4, 300)
		renderer.draw(params({ filled: 0 }))
		expect(f.calls).toEqual(["clear"])
	})

	it("paints the waterfall no wider than its bound on a wide plot", () => {
		const f = fakes()
		const renderer = new Canvas2dRenderer(f.ctx, TEX, DEPTH, f.buffer)
		renderer.resize(BASIC_MAX_WIDTH * 3, 300)
		renderer.uploadRow(0, Uint8Array.from([10, 20, 30, 40]), 4)
		renderer.draw(params({ tracePx: 0 }))
		expect(f.images[0]?.width).toBe(BASIC_MAX_WIDTH)
		expect(f.calls).toContain(
			`image 0,0,${BASIC_MAX_WIDTH},1,0,0,${BASIC_MAX_WIDTH * 3},150`,
		)
	})
})
