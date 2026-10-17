// Shift-drag on the spectrum marks a range to scan (docs/web/canvas/Spectrum.dc.html `rsel`; DESIGN.md "Shell grid,
// Scanner composer": "Shift-drag on the spectrum offers Scan this range"). Pure: the drag in Hz, its snapped result
// and where the offer sits.
import type { FreqRange } from "@wavekit/api-types"

import type { SpectrumViewSpan } from "../spectrum/index.ts"

/** Edges snap outwards to this grid (the board's 12.5 kHz). */
export const RANGE_SNAP_HZ = 12_500
/** A selection narrower than this (after snapping) is dropped: a Shift-click is not a range. */
export const RANGE_MIN_HZ = 25_000

export interface RangeSelection {
	startHz: number
	endHz: number
	/** The drag ended: the selection is snapped and "Scan this range" is offered. */
	done: boolean
}

/** The frequency under a fraction (0..1) of the view's width. */
export function hzAt(view: SpectrumViewSpan, frac: number): number {
	return (
		view.startHz + Math.min(1, Math.max(0, frac)) * (view.endHz - view.startHz)
	)
}

/** The live selection while dragging from `fromHz` to `toHz` (either direction). */
export function dragRange(fromHz: number, toHz: number): RangeSelection {
	return {
		startHz: Math.min(fromHz, toHz),
		endHz: Math.max(fromHz, toHz),
		done: false,
	}
}

/**
 * The selection a finished drag leaves: edges snapped outwards to `snapHz`, or null when it is
 * narrower than `minHz` (a Shift-click, or a twitch).
 */
export function finishRange(
	from: FreqRange,
	snapHz = RANGE_SNAP_HZ,
	minHz = RANGE_MIN_HZ,
): RangeSelection | null {
	const a = Math.min(from.startHz, from.endHz)
	const b = Math.max(from.startHz, from.endHz)
	const startHz = Math.floor(a / snapHz) * snapHz
	const endHz = Math.ceil(b / snapHz) * snapHz
	if (!(endHz - startHz >= minHz)) return null
	return { startHz, endHz, done: true }
}

/** "146.000–146.500": the range in MHz, three decimals. */
export function rangeText(r: FreqRange): string {
	return `${(r.startHz / 1e6).toFixed(3)}–${(r.endHz / 1e6).toFixed(3)}`
}

export interface RangeBox {
	/** Left edge and width, % of the view (clipped to it). */
	left: number
	width: number
	/** Where the offer's centre sits, % of the view (kept 14–86 % so it stays on screen). */
	mid: number
}

/** Where a selection draws in the view, or null when it is out of view. */
export function rangeBox(
	r: FreqRange,
	view: SpectrumViewSpan,
): RangeBox | null {
	const span = view.endHz - view.startHz
	if (!(span > 0) || r.endHz <= view.startHz || r.startHz >= view.endHz)
		return null
	const a = Math.max(view.startHz, r.startHz)
	const b = Math.min(view.endHz, r.endHz)
	const pct = (hz: number) => ((hz - view.startHz) / span) * 100
	return {
		left: pct(a),
		width: pct(b) - pct(a),
		mid: Math.max(14, Math.min(86, pct((a + b) / 2))),
	}
}
