/**
 * View maths: the visible span (zoom/pan) is mapped to texture coordinates in the shader, so changing
 * the view never re-uploads rows. All Hz arithmetic happens here in doubles (float32 in GLSL cannot
 * hold RF frequencies to the Hz).
 */

import type { SpectrumViewSpan } from "./protocol.ts"

export interface BinAxis {
	startHz: number
	binHz: number
	binCount: number
}

/** u(x) = offset + x · scale for screen x in 0–1; a texel is a bin; u outside 0–limit is empty. */
export interface TexMapping {
	offset: number
	scale: number
	limit: number
}

/** The capture's frequency range: bin i covers startHz + [i, i + 1) · binHz. */
export function captureSpan(axis: BinAxis): SpectrumViewSpan {
	return {
		startHz: axis.startHz,
		endHz: axis.startHz + axis.binCount * axis.binHz,
	}
}

/** Normalized texture coordinate of `hz` in a row texture `texWidth` texels wide. */
export function hzToTexU(hz: number, axis: BinAxis, texWidth: number): number {
	return (hz - axis.startHz) / axis.binHz / texWidth
}

export function texMapping(
	view: SpectrumViewSpan | null,
	axis: BinAxis,
	texWidth: number,
): TexMapping {
	const span = view ?? captureSpan(axis)
	const offset = hzToTexU(span.startHz, axis, texWidth)
	const scale = (span.endHz - span.startHz) / axis.binHz / texWidth
	return { offset, scale, limit: axis.binCount / texWidth }
}

/** Screen x (0–1) of `hz` in the view. */
export function hzToX(hz: number, view: SpectrumViewSpan): number {
	return (hz - view.startHz) / (view.endHz - view.startHz)
}

export function xToHz(x: number, view: SpectrumViewSpan): number {
	return view.startHz + x * (view.endHz - view.startHz)
}

/**
 * Zooms by `factor` (> 1 zooms in) keeping the frequency under screen x `anchorX` in place, then keeps
 * the span inside `bounds` and at least `minSpanHz` wide.
 */
export function zoomView(
	view: SpectrumViewSpan,
	anchorX: number,
	factor: number,
	bounds: SpectrumViewSpan,
	minSpanHz: number,
): SpectrumViewSpan {
	const anchor = xToHz(anchorX, view)
	const maxSpan = bounds.endHz - bounds.startHz
	const span = Math.min(
		maxSpan,
		Math.max(minSpanHz, (view.endHz - view.startHz) / factor),
	)
	const startHz = anchor - anchorX * span
	return clampSpan({ startHz, endHz: startHz + span }, bounds)
}

/** Moves the view by `deltaHz`, kept inside `bounds`. */
export function panView(
	view: SpectrumViewSpan,
	deltaHz: number,
	bounds: SpectrumViewSpan,
): SpectrumViewSpan {
	return clampSpan(
		{ startHz: view.startHz + deltaHz, endHz: view.endHz + deltaHz },
		bounds,
	)
}

function clampSpan(
	view: SpectrumViewSpan,
	bounds: SpectrumViewSpan,
): SpectrumViewSpan {
	const span = Math.min(
		view.endHz - view.startHz,
		bounds.endHz - bounds.startHz,
	)
	let startHz = view.startHz
	if (startHz < bounds.startHz) startHz = bounds.startHz
	if (startHz + span > bounds.endHz) startHz = bounds.endHz - span
	return { startHz, endHz: startHz + span }
}

/** Waterfall rows on screen: one row per `rowHeightPx` device px, at most the history depth. */
export function visibleRows(
	waterfallHeightPx: number,
	rowHeightPx: number,
	depth: number,
): number {
	const rows = Math.round(waterfallHeightPx / Math.max(rowHeightPx, 0.25))
	return Math.max(1, Math.min(depth, rows))
}

/** Splits a canvas height in device px into the trace (top) and waterfall (bottom) bands. */
export function splitHeight(
	heightPx: number,
	splitRatio: number,
): { tracePx: number; waterfallPx: number } {
	const ratio = Math.min(1, Math.max(0, splitRatio))
	const tracePx = Math.round(heightPx * ratio)
	return { tracePx, waterfallPx: heightPx - tracePx }
}

/** Most bins the shader reads for one pixel; wider spans are strided. */
export const MAX_TAPS = 32

/**
 * Bins the renderer reads for the screen px interval [a, b] of a canvas `widthPx` wide (the fragment
 * shader's sampleSpan, mirrored for tests): null when the interval covers at most one bin (the shader
 * then takes the linear sample at its middle), else the first and last bin and the stride of the MAX.
 */
export function coveredBins(
	a: number,
	b: number,
	map: TexMapping,
	texWidth: number,
	widthPx: number,
): { first: number; last: number; stride: number } | null {
	const t0 = (map.offset + (a / widthPx) * map.scale) * texWidth
	const t1 = (map.offset + (b / widthPx) * map.scale) * texWidth
	if (t1 - t0 <= 1) return null
	const lastBin = map.limit * texWidth - 1
	const clampBin = (x: number) => Math.min(lastBin, Math.max(0, x))
	const first = Math.trunc(clampBin(Math.floor(t0)))
	const last = Math.trunc(clampBin(Math.ceil(t1) - 1))
	const stride = Math.trunc((last - first + MAX_TAPS) / MAX_TAPS)
	return { first, last, stride }
}

/** The value the shader takes for a pixel: the max of the bins coveredBins names. */
export function maxOverBins(
	row: ArrayLike<number>,
	span: { first: number; last: number; stride: number },
): number {
	let m = 0
	for (let k = 0; k < MAX_TAPS; k++) {
		const i = span.first + k * span.stride
		if (i > span.last) break
		m = Math.max(m, row[i] ?? 0)
	}
	return m
}

/** History depth bounds (texture rows): at least a small window's worth, at most WebGL2's minimum max size. */
export const HISTORY_MIN_ROWS = 256
export const HISTORY_MAX_ROWS = 2048

/**
 * Waterfall history depth for a canvas up to `heightCss` tall: enough rows that the waterfall reaches
 * the bottom edge once history fills (one row per `rowHeightCss`), capped to bound GPU memory
 * (depth × MAX_BINS bytes). Rows not received yet draw as the plot background.
 */
export function historyDepth(
	heightCss: number,
	dpr: number,
	rowHeightCss = 1,
): number {
	const px = Math.max(0, heightCss) * Math.max(dpr, 0.25)
	const rows = Math.ceil(px / Math.max(rowHeightCss * Math.max(dpr, 0.25), 0.25))
	return Math.min(HISTORY_MAX_ROWS, Math.max(HISTORY_MIN_ROWS, rows))
}
