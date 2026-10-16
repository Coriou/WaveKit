/** Vertical layout of the plot body: trace, frequency axis, band lanes, waterfall (CSS px). */

export const AXIS_CSS = 30
export const LANES_CSS = 24
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

/** About 40 % of the height for the trace, 72–300 px, leaving the gap and some waterfall. */
export function plotLayout(heightCss: number): PlotLayout {
	const h = Math.max(1, heightCss)
	const room = Math.max(0, h - GAP_CSS - WATERFALL_MIN_CSS)
	const traceCss = Math.round(
		Math.min(TRACE_MAX_CSS, room, Math.max(TRACE_MIN_CSS, h * 0.4)),
	)
	return { traceCss, gapCss: GAP_CSS, splitRatio: Math.min(1, traceCss / h) }
}
