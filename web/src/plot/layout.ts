/** Vertical layout of the plot body: trace, frequency axis, band lanes, waterfall (CSS px). */

export const AXIS_CSS = 30
export const LANES_CSS = 24
/** The discovery tag row under the lanes (Spectrum board), only while the scanner has something to tag. */
export const DISCOVERY_ROW_CSS = 20
/** The band ruler under the lanes and the discovery row (BandRuler.tsx). */
export const RULER_CSS = 26
/** The gap the renderer leaves between trace and waterfall for the axis and the lanes. */
export const GAP_CSS = AXIS_CSS + LANES_CSS
/** Trace height on a tall plot (Immersive board: 300 px). */
export const TRACE_MAX_CSS = 300
export const TRACE_MIN_CSS = 72
/** Waterfall kept at least this tall when the plot is short. */
export const WATERFALL_MIN_CSS = 40

export interface PlotLayout {
	traceCss: number
	gapCss: number
	/** Trace share of the body height, for SpectrumCanvas. */
	splitRatio: number
}

/**
 * About 40 % of the height for the trace, 72–300 px, leaving the gap and some waterfall. `extraGapCss`
 * grows the gap under the lanes (the discovery row).
 */
export function plotLayout(heightCss: number, extraGapCss = 0): PlotLayout {
	const h = Math.max(1, heightCss)
	const gapCss = GAP_CSS + Math.max(0, extraGapCss)
	const room = Math.max(0, h - gapCss - WATERFALL_MIN_CSS)
	const traceCss = Math.round(
		Math.min(TRACE_MAX_CSS, room, Math.max(TRACE_MIN_CSS, h * 0.4)),
	)
	return { traceCss, gapCss, splitRatio: Math.min(1, traceCss / h) }
}
