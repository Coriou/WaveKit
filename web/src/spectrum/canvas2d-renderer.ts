/**
 * The spectrum drawn with a 2D canvas, for a browser without WebGL2 (graphics acceleration off or
 * blocked, a crashed GPU process). It takes the same calls as the WebGL2 renderer, so the scene is
 * the same, and it runs where that one does (the spectrum worker, on an OffscreenCanvas) or on the
 * page. It reads the bins as the WebGL2 renderer does: a pixel that covers several bins shows their
 * maximum, so a one-bin carrier never falls between two pixels.
 *
 * The waterfall lives on a second canvas, at most BASIC_MAX_WIDTH px wide and as many rows deep as
 * the history, allocated once. A new row scrolls that canvas down by one row (the browser's own
 * copy) and paints one row; only a change of view, levels, colours, size or row offsets repaints
 * all of it. The per-frame cost is one row, whatever the height of the plot.
 */

import type { DrawParams, SceneRenderer } from "./renderer.ts"
import { coveredBins, maxOverBins } from "./view.ts"

/** The waterfall is painted at most this wide (device px) and stretched to the plot. */
export const BASIC_MAX_WIDTH = 1024
/** Where on the ramp the trace takes its colour, as the WebGL2 renderer (its `ramp(0.82)`). */
const LINE_RAMP_INDEX = Math.round(0.82 * 255)
/** The peak line: the ramp's last colour at this opacity (WebGL2: `ramp(1.0)` mixed at 0.16). */
const PEAK_ALPHA = 0.16

/** The slice of a 2D context this renderer draws the plot with. */
export type Basic2d = Pick<
	CanvasRenderingContext2D,
	| "clearRect"
	| "beginPath"
	| "moveTo"
	| "lineTo"
	| "stroke"
	| "drawImage"
	| "strokeStyle"
	| "lineWidth"
	| "globalAlpha"
	| "imageSmoothingEnabled"
>

/** The second canvas, which holds the waterfall. */
export interface BasicBuffer {
	canvas: CanvasImageSource & { width: number; height: number }
	ctx: Pick<
		CanvasRenderingContext2D,
		"putImageData" | "drawImage" | "createImageData"
	>
}

/** For each pixel column, the bins it covers (the MAX is taken over them); first −1: no bin there. */
export interface ViewSpans {
	first: Int32Array
	last: Int32Array
	stride: Int32Array
}

/** The bins under each of `width` pixel columns for a view (`map`), as the WebGL2 renderer samples them. */
export function viewSpans(
	map: DrawParams["map"],
	texWidth: number,
	width: number,
): ViewSpans {
	const first = new Int32Array(width)
	const last = new Int32Array(width)
	const stride = new Int32Array(width).fill(1)
	const binCount = Math.round(map.limit * texWidth)
	for (let x = 0; x < width; x++) {
		const mid = Math.floor(
			(map.offset + ((x + 0.5) / width) * map.scale) * texWidth,
		)
		if (mid < 0 || mid >= binCount) {
			first[x] = -1
			last[x] = -1
			continue
		}
		const span = coveredBins(x, x + 1, map, texWidth, width)
		first[x] = span?.first ?? mid
		last[x] = span?.last ?? mid
		stride[x] = span?.stride ?? 1
	}
	return { first, last, stride }
}

/** The byte a pixel column shows for `row` (moved by `shift` bins): the max of the bins it covers; −1: none. */
export function columnValue(
	row: ArrayLike<number>,
	spans: ViewSpans,
	x: number,
	shift: number,
	binCount: number,
): number {
	const first = (spans.first[x] ?? -1) - shift
	const last = (spans.last[x] ?? -1) - shift
	if ((spans.first[x] ?? -1) < 0 || last < 0 || first >= binCount) return -1
	return maxOverBins(row, {
		first: Math.max(0, first),
		last: Math.min(binCount - 1, last),
		stride: spans.stride[x] ?? 1,
	})
}

/** Ramp offset (colour index × 4) for each byte under `level`, as the WebGL2 renderer maps it. */
export function levelLut(level: DrawParams["level"]): Uint16Array {
	const lut = new Uint16Array(256)
	for (let byte = 0; byte < 256; byte++) {
		const t = (byte / 255) * level.scale + level.offset
		lut[byte] = Math.round((t < 0 ? 0 : t > 1 ? 1 : t) * 255) * 4
	}
	return lut
}

/** Paints one waterfall row into `out` (RGBA, one pixel per column); a column without a bin stays transparent. */
export function paintRow(
	out: Uint8ClampedArray,
	row: ArrayLike<number>,
	shift: number,
	spans: ViewSpans,
	lut: Uint16Array,
	ramp: Uint8Array,
	binCount: number,
): void {
	const width = spans.first.length
	for (let x = 0; x < width; x++) {
		const o = x * 4
		const value = columnValue(row, spans, x, shift, binCount)
		if (value < 0) {
			out[o + 3] = 0
			continue
		}
		const c = lut[value] ?? 0
		out[o] = ramp[c] ?? 0
		out[o + 1] = ramp[c + 1] ?? 0
		out[o + 2] = ramp[c + 2] ?? 0
		out[o + 3] = 255
	}
}

/** The trace's points: [x, y] per pixel column that has a bin (y from the top of a band `tracePx` high). */
export function tracePoints(
	row: ArrayLike<number>,
	spans: ViewSpans,
	params: DrawParams,
	binCount: number,
): [number, number][] {
	const points: [number, number][] = []
	const width = spans.first.length
	for (let x = 0; x < width; x++) {
		const value = columnValue(row, spans, x, 0, binCount)
		if (value < 0) continue
		const t = (value / 255) * params.level.scale + params.level.offset
		points.push([x + 0.5, params.tracePx * (1 - (t < 0 ? 0 : t > 1 ? 1 : t))])
	}
	return points
}

export class Canvas2dRenderer implements SceneRenderer {
	readonly kind = "canvas2d"
	private readonly ctx: Basic2d
	private readonly texWidth: number
	private readonly depth: number
	private readonly buffer: BasicBuffer
	private readonly rows: Uint8Array
	private readonly trace: Uint8Array
	private readonly peak: Uint8Array
	private offsets: Float32Array
	private ramp: Uint8Array = new Uint8Array(1024)
	private widthPx = 1
	private heightPx = 1
	/** One row of the waterfall canvas, reused for every row painted. */
	private rowImage: ImageData | null = null
	private waterfallSpans: ViewSpans | null = null
	private traceSpans: ViewSpans | null = null
	private lut: Uint16Array = new Uint16Array(256)
	/** The view and levels the waterfall canvas was painted for. */
	private painted = ""
	/** Rows on the waterfall canvas, newest at the top. */
	private held = 0
	/** Rows uploaded since the last draw. */
	private fresh = 0
	/** Everything on the waterfall canvas must be painted again. */
	private stale = true

	/** `buffer`: a second canvas; it is sized here, once per plot width. */
	constructor(
		ctx: Basic2d,
		texWidth: number,
		depth: number,
		buffer: BasicBuffer,
	) {
		this.ctx = ctx
		this.texWidth = texWidth
		this.depth = depth
		this.buffer = buffer
		this.rows = new Uint8Array(texWidth * depth)
		this.trace = new Uint8Array(texWidth)
		this.peak = new Uint8Array(texWidth)
		this.offsets = new Float32Array(depth)
	}

	resize(widthPx: number, heightPx: number): void {
		const width = Math.max(1, widthPx)
		const height = Math.max(1, heightPx)
		if (width === this.widthPx && height === this.heightPx && this.rowImage)
			return
		this.widthPx = width
		this.heightPx = height
		const canvas = (this.ctx as { canvas?: { width: number; height: number } })
			.canvas
		if (canvas) {
			canvas.width = width
			canvas.height = height
		}
		const buffered = Math.min(width, BASIC_MAX_WIDTH)
		if (this.rowImage?.width !== buffered) {
			this.buffer.canvas.width = buffered
			this.buffer.canvas.height = this.depth
			this.rowImage = this.buffer.ctx.createImageData(buffered, 1)
		}
		this.painted = ""
		this.stale = true
	}

	uploadRow(index: number, row: Uint8Array, count: number): void {
		const base = index * this.texWidth
		const n = Math.min(count, this.texWidth, row.length)
		this.rows.set(row.subarray(0, n), base)
		this.rows.fill(0, base + n, base + this.texWidth)
		this.fresh++
	}

	uploadPeak(row: Uint8Array, count: number): void {
		this.peak.set(row.subarray(0, Math.min(count, this.texWidth)))
	}

	uploadTrace(row: Uint8Array, count: number): void {
		this.trace.set(row.subarray(0, Math.min(count, this.texWidth)))
	}

	uploadRowOffsets(offsets: Float32Array): void {
		this.offsets = Float32Array.from(offsets)
		this.stale = true
	}

	setRamp(rgba: Uint8Array): void {
		this.ramp = rgba
		this.stale = true
	}

	draw(params: DrawParams): void {
		const ctx = this.ctx
		ctx.clearRect(0, 0, this.widthPx, this.heightPx)
		const image = this.rowImage
		if (!image) return
		const key = `${params.map.offset}:${params.map.scale}:${params.map.limit}:${params.level.scale}:${params.level.offset}`
		if (key !== this.painted || !this.waterfallSpans || !this.traceSpans) {
			this.painted = key
			this.waterfallSpans = viewSpans(params.map, this.texWidth, image.width)
			this.traceSpans = viewSpans(params.map, this.texWidth, this.widthPx)
			this.lut = levelLut(params.level)
			this.stale = true
		}
		const binCount = Math.round(params.map.limit * this.texWidth)
		const top = params.tracePx + params.gapPx
		const band = this.heightPx - top
		const shown = Math.min(params.filled, params.rows, this.depth)
		if (shown > 0 && band > 0 && params.rows > 0) {
			const buffer = this.buffer
			const width = image.width
			// rows to paint at the top: all of them after a change, else the ones that just arrived
			let paint = shown
			if (!this.stale && this.fresh < shown) {
				paint = this.fresh
				const keep = Math.min(this.held, this.depth - paint)
				if (paint > 0 && keep > 0)
					buffer.ctx.drawImage(
						buffer.canvas,
						0,
						0,
						width,
						keep,
						0,
						paint,
						width,
						keep,
					)
				this.held = Math.min(this.depth, this.held + paint)
			} else this.held = shown
			for (let r = 0; r < paint; r++) {
				const index = (params.newest - r + this.depth * 2) % this.depth
				paintRow(
					image.data,
					this.rows.subarray(
						index * this.texWidth,
						(index + 1) * this.texWidth,
					),
					Math.round(this.offsets[index] ?? 0),
					this.waterfallSpans,
					this.lut,
					this.ramp,
					binCount,
				)
				buffer.ctx.putImageData(image, 0, r)
			}
			ctx.imageSmoothingEnabled = false
			ctx.drawImage(
				buffer.canvas,
				0,
				0,
				width,
				shown,
				0,
				top,
				this.widthPx,
				(band / params.rows) * shown,
			)
		}
		this.fresh = 0
		this.stale = false
		if (params.tracePx <= 0 || params.filled === 0) return
		if (params.peakHold) this.line(this.peak, params, binCount, 255, PEAK_ALPHA)
		this.line(this.trace, params, binCount, LINE_RAMP_INDEX, 1)
	}

	private line(
		row: Uint8Array,
		params: DrawParams,
		binCount: number,
		rampIndex: number,
		alpha: number,
	): void {
		const spans = this.traceSpans
		if (!spans) return
		const points = tracePoints(row, spans, params, binCount)
		if (points.length < 2) return
		const ctx = this.ctx
		const c = rampIndex * 4
		ctx.globalAlpha = alpha
		ctx.strokeStyle = `rgb(${this.ramp[c] ?? 0}, ${this.ramp[c + 1] ?? 0}, ${this.ramp[c + 2] ?? 0})`
		ctx.lineWidth = Math.max(1, params.lineHalfWidth * 2)
		ctx.beginPath()
		points.forEach(([x, y], i) =>
			i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y),
		)
		ctx.stroke()
		ctx.globalAlpha = 1
	}

	dispose(): void {
		this.rowImage = null
	}
}
