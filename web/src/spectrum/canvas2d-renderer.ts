/**
 * The spectrum drawn with a 2D canvas, for a browser without WebGL2 (graphics acceleration off or
 * blocked, a crashed GPU process). It takes the same calls as the WebGL2 renderer, so the scene is
 * the same; it draws the trace, the peak line and the waterfall, the waterfall at most
 * BASIC_MAX_WIDTH pixels wide and stretched. Plain loops: no shaders, no textures.
 */

import type { DrawParams, SceneRenderer } from "./renderer.ts"

/** The waterfall is painted at most this wide (device px) and stretched to the plot: bounds the per-frame loop. */
export const BASIC_MAX_WIDTH = 1024

/** The slice of a 2D context this renderer uses (a canvas's or an OffscreenCanvas's). */
export type Basic2d = Pick<
	CanvasRenderingContext2D,
	| "clearRect"
	| "beginPath"
	| "moveTo"
	| "lineTo"
	| "stroke"
	| "putImageData"
	| "createImageData"
	| "drawImage"
	| "strokeStyle"
	| "lineWidth"
	| "globalAlpha"
	| "imageSmoothingEnabled"
>

/** A second, off-screen surface the waterfall is painted on before it is stretched onto the plot. */
export interface BasicBuffer {
	canvas: CanvasImageSource & { width: number; height: number }
	ctx: Pick<CanvasRenderingContext2D, "putImageData">
}

/** Colour position (0–1) of a byte under `level`, as the WebGL2 renderer computes it. */
function position(byte: number, level: DrawParams["level"]): number {
	const t = (byte / 255) * level.scale + level.offset
	return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Paints `shown` waterfall rows, newest first, into `out` (RGBA, `width` px per row). `rows` holds
 * the ring (`depth` rows of `texWidth` bytes), `offsets` each row's start in bins from the newest
 * row's. A pixel outside its row's bins stays transparent.
 */
export function paintWaterfall(
	out: Uint8ClampedArray,
	width: number,
	shown: number,
	rows: Uint8Array,
	texWidth: number,
	depth: number,
	offsets: Float32Array,
	ramp: Uint8Array,
	params: DrawParams,
): void {
	const binCount = Math.round(params.map.limit * texWidth)
	for (let r = 0; r < shown; r++) {
		const index = (params.newest - r + depth * 2) % depth
		const base = index * texWidth
		const shift = offsets[index] ?? 0
		for (let x = 0; x < width; x++) {
			const u = params.map.offset + ((x + 0.5) / width) * params.map.scale
			const bin = Math.floor(u * texWidth - shift)
			const o = (r * width + x) * 4
			if (bin < 0 || bin >= binCount) {
				out[o + 3] = 0
				continue
			}
			const c =
				Math.round(position(rows[base + bin] ?? 0, params.level) * 255) * 4
			out[o] = ramp[c] ?? 0
			out[o + 1] = ramp[c + 1] ?? 0
			out[o + 2] = ramp[c + 2] ?? 0
			out[o + 3] = 255
		}
	}
}

/**
 * The trace's points for a plot `widthPx` wide: [x, y] per device pixel column that has a bin
 * (y from the top of the trace band, `tracePx` high).
 */
export function tracePoints(
	row: Uint8Array,
	texWidth: number,
	widthPx: number,
	params: DrawParams,
): [number, number][] {
	const binCount = Math.round(params.map.limit * texWidth)
	const points: [number, number][] = []
	for (let x = 0; x < widthPx; x++) {
		const u = params.map.offset + ((x + 0.5) / widthPx) * params.map.scale
		const bin = Math.floor(u * texWidth)
		if (bin < 0 || bin >= binCount) continue
		points.push([
			x + 0.5,
			params.tracePx * (1 - position(row[bin] ?? 0, params.level)),
		])
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
	private image: ImageData | null = null

	/** `buffer`: a second canvas of any size (it is resized as needed). */
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
		this.widthPx = Math.max(1, widthPx)
		this.heightPx = Math.max(1, heightPx)
		const canvas = (this.ctx as { canvas?: { width: number; height: number } })
			.canvas
		if (canvas) {
			canvas.width = this.widthPx
			canvas.height = this.heightPx
		}
	}

	uploadRow(index: number, row: Uint8Array, count: number): void {
		const base = index * this.texWidth
		const n = Math.min(count, this.texWidth, row.length)
		this.rows.set(row.subarray(0, n), base)
		this.rows.fill(0, base + n, base + this.texWidth)
	}

	uploadPeak(row: Uint8Array, count: number): void {
		this.peak.set(row.subarray(0, Math.min(count, this.texWidth)))
	}

	uploadTrace(row: Uint8Array, count: number): void {
		this.trace.set(row.subarray(0, Math.min(count, this.texWidth)))
	}

	uploadRowOffsets(offsets: Float32Array): void {
		this.offsets = Float32Array.from(offsets)
	}

	setRamp(rgba: Uint8Array): void {
		this.ramp = rgba
	}

	draw(params: DrawParams): void {
		const ctx = this.ctx
		ctx.clearRect(0, 0, this.widthPx, this.heightPx)
		const top = params.tracePx + params.gapPx
		const band = this.heightPx - top
		const shown = Math.min(params.filled, params.rows, this.depth)
		if (shown > 0 && band > 0 && params.rows > 0) {
			const width = Math.min(this.widthPx, BASIC_MAX_WIDTH)
			let image = this.image
			if (!image || image.width !== width || image.height !== shown) {
				image = ctx.createImageData(width, shown)
				this.image = image
				this.buffer.canvas.width = width
				this.buffer.canvas.height = shown
			}
			paintWaterfall(
				image.data,
				width,
				shown,
				this.rows,
				this.texWidth,
				this.depth,
				this.offsets,
				this.ramp,
				params,
			)
			this.buffer.ctx.putImageData(image, 0, 0)
			ctx.imageSmoothingEnabled = false
			ctx.drawImage(
				this.buffer.canvas,
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
		if (params.tracePx <= 0 || params.filled === 0) return
		if (params.peakHold) this.line(this.peak, params, 0.35)
		this.line(this.trace, params, 1)
	}

	private line(row: Uint8Array, params: DrawParams, alpha: number): void {
		const points = tracePoints(row, this.texWidth, this.widthPx, params)
		if (points.length < 2) return
		const ctx = this.ctx
		ctx.globalAlpha = alpha
		ctx.strokeStyle = "#ffffff"
		ctx.lineWidth = Math.max(1, params.lineHalfWidth * 2)
		ctx.beginPath()
		points.forEach(([x, y], i) =>
			i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y),
		)
		ctx.stroke()
		ctx.globalAlpha = 1
	}

	dispose(): void {
		this.image = null
	}
}
