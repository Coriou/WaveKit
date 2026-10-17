/**
 * Grab handles on the plot (docs/web/canvas/Spectrum.dc.html; DESIGN.md "Spectrum interaction", "Squelch UX"):
 * the VFO passband (drag to tune), its two edges (drag to change the channel bandwidth, once zoomed in
 * enough to grab them) and the dashed squelch line (drag to set a manual threshold). Pure geometry: where
 * each handle sits in CSS px, what a pointer at (x, y) grabs, and the value a drag to there means.
 */

import type { SpectrumLevels, SpectrumViewSpan } from "../spectrum/index.ts"
import { clickPrecisionHz, dbToTraceY, spanWidth } from "./maths.ts"

export type HandleKind = "vfo" | "edge-left" | "edge-right" | "squelch"

/** The band must be at least this wide on screen before its edges can be grabbed (Spectrum board). */
export const EDGE_GRAB_MIN_PX = 24
/** Half-width of an edge's grab zone, CSS px (mouse; touch gets TOUCH_SLOP_PX). */
export const EDGE_HIT_PX = 5
/** Half-height of the squelch line's grab zone, CSS px (mouse). */
export const SQUELCH_HIT_PX = 5
export const TOUCH_SLOP_PX = 10
/** The passband is drawn (and grabbable) at least this wide. */
export const VFO_MIN_PX = 7
/** The squelch line spans the passband but never less than this (Spectrum board: max(180px, band)). */
export const SQUELCH_MIN_PX = 180
/** The manual threshold range, as the Listen island's squelch bar (LEVEL_MIN/MAX_DBFS). */
export const SQUELCH_MIN_DBFS = -120
export const SQUELCH_MAX_DBFS = -20

/** Mode bandwidth limits [min, max, step] in Hz (modes.ts `bw` without its default). */
export type BandwidthRange = readonly [number, number, number, ...number[]]

export interface HandleInput {
	view: SpectrumViewSpan
	widthPx: number
	/** Height of the trace band, CSS px (the squelch line lives in it). */
	traceCss: number
	levels: SpectrumLevels
	vfoHz: number | null
	bandwidthHz: number
	/** Edges can be dragged at all (live audio with a channel filter, not read-only). */
	edgesAllowed: boolean
	/** The VFO can be dragged (not read-only). */
	vfoAllowed: boolean
	/** The threshold to draw, dBFS; null hides the line (squelch off, noise squelch, unknown). */
	squelchDbfs: number | null
}

export interface HandleGeometry {
	/** The passband in CSS px from the plot's left edge; null when off screen. */
	vfo: { left: number; right: number; centre: number } | null
	/** Edges are grabbable (zoomed in enough, allowed). */
	edges: boolean
	/** The squelch line: y in the trace band and its horizontal extent; null when hidden. */
	squelch: { y: number; left: number; right: number } | null
}

function xOfHz(hz: number, view: SpectrumViewSpan, widthPx: number): number {
	return ((hz - view.startHz) / spanWidth(view)) * widthPx
}

/** Where every handle sits for the current view. */
export function handleGeometry(input: HandleInput): HandleGeometry {
	const { view, widthPx, vfoHz } = input
	if (!(widthPx > 0) || !(spanWidth(view) > 0) || vfoHz === null)
		return { vfo: null, edges: false, squelch: null }
	const centre = xOfHz(vfoHz, view, widthPx)
	const bandPx = (Math.max(0, input.bandwidthHz) / spanWidth(view)) * widthPx
	const half = Math.max(VFO_MIN_PX, bandPx) / 2
	const onScreen = centre + half >= 0 && centre - half <= widthPx
	const vfo = onScreen
		? { left: centre - half, right: centre + half, centre }
		: null
	const edges = vfo !== null && input.edgesAllowed && bandPx >= EDGE_GRAB_MIN_PX
	// The board draws the squelch line only while the tuned channel is on screen.
	const inView = vfoHz >= view.startHz && vfoHz <= view.endHz
	let squelch: HandleGeometry["squelch"] = null
	if (
		inView &&
		input.squelchDbfs !== null &&
		Number.isFinite(input.squelchDbfs)
	) {
		const lineHalf = Math.max(SQUELCH_MIN_PX, bandPx) / 2
		squelch = {
			y: dbToTraceY(input.squelchDbfs, input.levels, input.traceCss),
			left: centre - lineHalf,
			right: centre + lineHalf,
		}
	}
	return { vfo, edges, squelch }
}

/**
 * The handle under a pointer at (x, y) CSS px in the plot body, or null (pan, click, zoom as before).
 * The squelch line wins where it crosses the band, then the edges, then the passband itself.
 */
export function hitTest(
	geom: HandleGeometry,
	x: number,
	y: number,
	opts: { traceCss: number; vfoAllowed: boolean; touch?: boolean },
): HandleKind | null {
	const slopX = opts.touch ? TOUCH_SLOP_PX : EDGE_HIT_PX
	const slopY = opts.touch ? TOUCH_SLOP_PX : SQUELCH_HIT_PX
	const sq = geom.squelch
	if (
		sq &&
		y <= opts.traceCss &&
		Math.abs(y - sq.y) <= slopY &&
		x >= sq.left &&
		x <= sq.right
	)
		return "squelch"
	const vfo = geom.vfo
	if (!vfo) return null
	if (geom.edges) {
		const dl = Math.abs(x - vfo.left)
		const dr = Math.abs(x - vfo.right)
		if (Math.min(dl, dr) <= slopX) return dl <= dr ? "edge-left" : "edge-right"
	}
	if (opts.vfoAllowed && x >= vfo.left && x <= vfo.right) return "vfo"
	return null
}

/** CSS px from the top of the trace band → dB on the plot's scale (inverse of dbToTraceY). */
export function traceYToDb(
	y: number,
	levels: SpectrumLevels,
	traceCss: number,
): number {
	// dbToTraceY: y = top + (1 − t) · (traceCss − top − 1), top = 1.25 (twice the line half-width)
	const top = 1.25
	const room = traceCss - top - 1
	const range = levels.maxDb - levels.minDb
	if (!(room > 0) || !(range > 0)) return levels.minDb
	const t = Math.min(1, Math.max(0, 1 - (y - top) / room))
	return levels.minDb + t * range
}

/** A manual squelch threshold: whole dB inside the Listen island's range. */
export function clampSquelch(dbfs: number): number {
	return Math.min(
		SQUELCH_MAX_DBFS,
		Math.max(SQUELCH_MIN_DBFS, Math.round(dbfs)),
	)
}

/** The squelch threshold a drag of the line to `y` sets. */
export function squelchAtY(
	y: number,
	levels: SpectrumLevels,
	traceCss: number,
): number {
	return clampSquelch(traceYToDb(y, levels, traceCss))
}

/** A bandwidth inside the mode's limits, on its step. */
export function clampBandwidth(hz: number, range: BandwidthRange): number {
	const [min, max, step] = range
	const snapped = step > 0 ? Math.round(hz / step) * step : Math.round(hz)
	return Math.min(max, Math.max(min, snapped))
}

/** The bandwidth an edge dragged to `pointerHz` sets: symmetric about the VFO. */
export function bandwidthAtHz(
	pointerHz: number,
	vfoHz: number,
	range: BandwidthRange,
): number {
	return clampBandwidth(Math.abs(pointerHz - vfoHz) * 2, range)
}

/** One keyboard notch of the bandwidth (dir 1 wider, −1 narrower; `big` is ten steps). */
export function nudgeBandwidth(
	hz: number,
	dir: 1 | -1,
	range: BandwidthRange,
	big = false,
): number {
	return clampBandwidth(hz + dir * range[2] * (big ? 10 : 1), range)
}

/** One keyboard notch of the squelch threshold: 1 dB, or 5 dB when `big`. */
export function nudgeSquelch(dbfs: number, dir: 1 | -1, big = false): number {
	return clampSquelch(dbfs + dir * (big ? 5 : 1))
}

/**
 * The frequency a VFO drag of `dxPx` means: relative to where the drag started, so a recentre in the
 * middle of the drag (the view jumps with the capture) does not run away with the pointer.
 */
export function vfoDragHz(
	startHz: number,
	dxPx: number,
	widthPx: number,
	spanHz: number,
): number {
	// Like a click, a drag lands where the pointer is, at the zoom's precision (not the step raster).
	const precision = clickPrecisionHz({ startHz: 0, endHz: spanHz }, widthPx)
	const hz = startHz + (dxPx / Math.max(1, widthPx)) * spanHz
	return Math.round(hz / precision) * precision
}

/** A slider key on a handle: dir and size, or null for keys the handle leaves alone. */
export function handleKey(key: string): { dir: 1 | -1; big: boolean } | null {
	switch (key) {
		case "ArrowUp":
		case "ArrowRight":
			return { dir: 1, big: false }
		case "ArrowDown":
		case "ArrowLeft":
			return { dir: -1, big: false }
		case "PageUp":
			return { dir: 1, big: true }
		case "PageDown":
			return { dir: -1, big: true }
		default:
			return null
	}
}
