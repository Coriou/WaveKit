/**
 * The plot's maths, free of the DOM: view state, axes, band lanes, signal labels and what a click,
 * a wheel notch or a key does. Hz arithmetic stays in doubles; the shader never sees it.
 */

import type {
	BandChannel,
	DisplayGroup,
	ResolvedBand,
	ResolvedBandPlanView,
} from "@wavekit/api-types"
import type {
	SpectrumFrameMeta,
	SpectrumLevels,
	SpectrumViewSpan,
} from "../spectrum/index.ts"
import { panView, zoomView } from "../spectrum/index.ts"

export type Track = SpectrumFrameMeta["tracks"][number]

// ── View state ────────────────────────────────────────────────────────────────────────────────

/**
 * Zoom and pan relative to the capture: the span on screen (null shows the whole capture) and the
 * offset of its middle from the capture's centre. Relative, so a retune keeps the same zoom.
 */
export interface PlotView {
	spanHz: number | null
	centreOffsetHz: number
}

export const FIT_VIEW: PlotView = { spanHz: null, centreOffsetHz: 0 }

/** Narrowest span the zoom allows (or the capture, when narrower). */
export const MIN_SPAN_HZ = 50_000

export function spanCentre(span: SpectrumViewSpan): number {
	return (span.startHz + span.endHz) / 2
}

export function spanWidth(span: SpectrumViewSpan): number {
	return span.endHz - span.startHz
}

/** The absolute span on screen for a view, kept inside the capture. */
export function resolveView(
	view: PlotView,
	capture: SpectrumViewSpan,
): SpectrumViewSpan {
	const width = spanWidth(capture)
	if (view.spanHz === null || view.spanHz >= width) return { ...capture }
	const span = Math.max(Math.min(MIN_SPAN_HZ, width), view.spanHz)
	const mid = spanCentre(capture) + view.centreOffsetHz
	return panView({ startHz: mid - span / 2, endHz: mid + span / 2 }, 0, capture)
}

/** The relative view that shows `span` (inverse of resolveView). */
export function viewOf(
	span: SpectrumViewSpan,
	capture: SpectrumViewSpan,
): PlotView {
	if (spanWidth(span) >= spanWidth(capture) - 1e-6) return FIT_VIEW
	return {
		spanHz: spanWidth(span),
		centreOffsetHz: spanCentre(span) - spanCentre(capture),
	}
}

/** Zooms by `factor` (> 1 zooms in) around screen x `anchorX` (0–1). */
export function zoomAt(
	view: PlotView,
	capture: SpectrumViewSpan,
	anchorX: number,
	factor: number,
): PlotView {
	const width = spanWidth(capture)
	const next = zoomView(
		resolveView(view, capture),
		Math.min(1, Math.max(0, anchorX)),
		factor,
		capture,
		Math.min(MIN_SPAN_HZ, width),
	)
	return viewOf(next, capture)
}

/**
 * Pans by `deltaHz`; what the capture edge stops is returned as `overflowHz` (signed), the amount the
 * hardware would have to move to show it.
 */
export function panBy(
	view: PlotView,
	capture: SpectrumViewSpan,
	deltaHz: number,
): { view: PlotView; overflowHz: number } {
	const current = resolveView(view, capture)
	const next = panView(current, deltaHz, capture)
	const overflowHz = current.startHz + deltaHz - next.startHz
	return { view: viewOf(next, capture), overflowHz }
}

/** Keeps `hz` on screen: a view that does not show it is panned to centre it. */
export function followHz(
	view: PlotView,
	capture: SpectrumViewSpan,
	hz: number,
): PlotView {
	const shown = resolveView(view, capture)
	if (hz >= shown.startHz && hz <= shown.endHz) return view
	return panBy(view, capture, hz - spanCentre(shown)).view
}

/** Zoom factor shown on the zoom control: "Fit", "2.4×", "12×". */
export function zoomLabel(
	view: SpectrumViewSpan,
	capture: SpectrumViewSpan,
): string {
	const zoom = spanWidth(capture) / Math.max(1, spanWidth(view))
	if (zoom < 1.05) return "Fit"
	return `${zoom < 10 ? zoom.toFixed(1) : String(Math.round(zoom))}×`
}

// ── Axes ──────────────────────────────────────────────────────────────────────────────────────

/** MHz with `decimals` places. */
export function formatMHz(hz: number, decimals: number): string {
	return (hz / 1e6).toFixed(decimals)
}

/** Decimals for a VFO or hover readout at this zoom. */
export function readoutDecimals(spanHz: number): number {
	return spanHz < 400_000 ? 4 : 3
}

const TICK_STEPS = [
	1e3, 2e3, 5e3, 10e3, 20e3, 25e3, 50e3, 100e3, 200e3, 250e3, 500e3, 1e6, 2e6,
	5e6, 10e6, 20e6, 50e6, 100e6,
]

export interface FreqTick {
	hz: number
	/** 0–1 across the view. */
	x: number
	text: string
}

/** Frequency ticks: a round step giving about one label per 120 px (at least 4). */
export function freqTicks(view: SpectrumViewSpan, widthPx: number): FreqTick[] {
	const span = spanWidth(view)
	if (!(span > 0) || !(widthPx > 0)) return []
	const want = Math.max(4, Math.floor(widthPx / 120))
	const step =
		TICK_STEPS.find(s => span / s <= want) ??
		TICK_STEPS[TICK_STEPS.length - 1] ??
		1e6
	const decimals = step >= 1e6 ? 0 : step >= 100e3 ? 1 : step >= 10e3 ? 2 : 3
	const out: FreqTick[] = []
	for (let i = Math.ceil(view.startHz / step); i * step <= view.endHz; i++) {
		const hz = i * step
		out.push({
			hz,
			x: (hz - view.startHz) / span,
			text: formatMHz(hz, decimals),
		})
	}
	return out
}

/** Line half-width of the trace in CSS px (the renderer's 0.625 · dpr device px). */
const LINE_HALF_CSS = 0.625

/** CSS px from the top of the trace band where `db` sits (the renderer's mapping). */
export function dbToTraceY(
	db: number,
	levels: SpectrumLevels,
	traceCss: number,
): number {
	const range = levels.maxDb - levels.minDb
	const t =
		range > 0 ? Math.min(1, Math.max(0, (db - levels.minDb) / range)) : 0
	const top = 2 * LINE_HALF_CSS
	return top + (1 - t) * (traceCss - top - 1)
}

export interface DbTick {
	db: number
	y: number
	text: string
}

/** dB shown below the noise floor, and the span of the scale (DEFAULT_LEVELS: −120 … −20). */
export const LEVELS_BELOW_FLOOR_DB = 15
export const LEVELS_RANGE_DB = 100
/** The floor must move this far before the scale follows (frame-to-frame jitter is a few dB). */
export const LEVELS_HYSTERESIS_DB = 10

/**
 * The trace and waterfall scale from the frame's noise floor (`floorDbfs`): the floor sits
 * LEVELS_BELOW_FLOOR_DB above the bottom (rounded to 5 dB) and the scale spans LEVELS_RANGE_DB, capped
 * at 0 dBFS. A real dongle's floor is far from the mock's −110 dBFS (about −62 dBFS at 1 kHz bins on an
 * RTL-SDR), which the fixed −120 … −20 scale drew as a washed-out grey waterfall. Returns `prev` itself
 * while the floor stays within LEVELS_HYSTERESIS_DB of the current scale's floor, or when it is unknown.
 */
export function autoLevels(
	floorDbfs: number | null | undefined,
	prev: SpectrumLevels,
): SpectrumLevels {
	if (
		floorDbfs === null ||
		floorDbfs === undefined ||
		!Number.isFinite(floorDbfs)
	)
		return prev
	const minDb = Math.floor((floorDbfs - LEVELS_BELOW_FLOOR_DB) / 5) * 5
	if (
		Math.abs(prev.minDb + LEVELS_BELOW_FLOOR_DB - floorDbfs) <
		LEVELS_HYSTERESIS_DB
	)
		return prev
	const maxDb = Math.min(0, minDb + LEVELS_RANGE_DB)
	return { minDb: Math.min(minDb, maxDb - 20), maxDb }
}

/** dB labels on the trace: a 10/20/30 dB step leaving at least 36 px between labels. */
export function dbTicks(levels: SpectrumLevels, traceCss: number): DbTick[] {
	const range = levels.maxDb - levels.minDb
	if (!(range > 0) || traceCss < 40) return []
	const step = [10, 20, 30, 50].find(s => (s / range) * traceCss >= 36) ?? 50
	const out: DbTick[] = []
	for (
		let db = Math.floor(levels.maxDb / step) * step;
		db > levels.minDb;
		db -= step
	) {
		const y = dbToTraceY(db, levels, traceCss)
		// Keep labels clear of the band edges.
		if (y < 12 || y > traceCss - 10) continue
		out.push({ db, y, text: String(db).replace("-", "−") })
	}
	return out
}

// ── Tuning ────────────────────────────────────────────────────────────────────────────────────

/** Default tuning step when the band plan names none. */
export const DEFAULT_STEP_HZ = 12_500

/** Click snap radius around a signal's centre, CSS px. */
export const SNAP_PX = 8

/** The track a click at `hz` lands on (see snapToTrack); null when none. */
function trackAt(
	hz: number,
	tracks: readonly Track[],
	view: SpectrumViewSpan,
	widthPx: number,
	snapPx: number,
): Track | null {
	const hzPerPx = spanWidth(view) / Math.max(1, widthPx)
	const pad = snapPx * hzPerPx
	let best: Track | null = null
	let bestD = Infinity
	for (const t of tracks) {
		const centre = (t.startHz + t.endHz) / 2
		const reach = Math.max(pad, (t.endHz - t.startHz) / 2 + pad)
		const d = Math.abs(hz - centre)
		if (d <= reach && d < bestD) {
			best = t
			bestD = d
		}
	}
	return best
}

/**
 * The centre of the track a click at `hz` lands on: the click is inside the track (padded by
 * `snapPx` screen px) or within `snapPx` of its centre. The nearest centre wins; null when none.
 */
export function snapToTrack(
	hz: number,
	tracks: readonly Track[],
	view: SpectrumViewSpan,
	widthPx: number,
	snapPx = SNAP_PX,
): number | null {
	const t = trackAt(hz, tracks, view, widthPx, snapPx)
	return t ? (t.startHz + t.endHz) / 2 : null
}

/**
 * Like snapToTrack, but lands on the step raster's channel when the track covers one. A real core's
 * track edges sit on its FFT bin grid (offset from the centre frequency), so the measured centre of a
 * carrier on 446.600 MHz reads 446.59992 MHz; the channel it covers is what the click means.
 */
export function snapToTrackChannel(
	hz: number,
	tracks: readonly Track[],
	view: SpectrumViewSpan,
	widthPx: number,
	stepHz: number,
	snapPx = SNAP_PX,
): number | null {
	const t = trackAt(hz, tracks, view, widthPx, snapPx)
	if (!t) return null
	const centre = (t.startHz + t.endHz) / 2
	const channel = snapToStep(centre, stepHz)
	return channel >= t.startHz && channel <= t.endHz ? channel : centre
}

/** Rounds to the step raster. */
export function snapToStep(hz: number, stepHz: number): number {
	const step = stepHz > 0 ? stepHz : DEFAULT_STEP_HZ
	return Math.round(hz / step) * step
}

/** One step up (dir 1) or down (dir −1) on the step raster. */
export function stepHz(hz: number, step: number, dir: number): number {
	return snapToStep(hz + dir * step, step)
}

/** How a tune request is carried out. */
export type TuneAction =
	| { kind: "offset"; offsetHz: number }
	| { kind: "retune"; centreHz: number }

/**
 * The share of the capture the core treats as usable: identify refuses a target (OUT_OF_WINDOW) unless
 * |hz − centre| + bandwidth/2 ≤ sampleRate × USABLE_FRACTION / 2 (src/core/spectrum/spectrum-engine.ts
 * USABLE_FRACTION, src/core/scanner/identify.ts inWindow, checked in scanner-service.ts identify()).
 */
export const USABLE_FRACTION = 0.8

/**
 * Tuning to `hz`: inside the capture (clear of its edges by `marginHz`) the live-audio channel moves
 * (offset from the hardware centre); outside, the hardware recentres on it.
 */
export function tuneAction(
	hz: number,
	hardwareCentreHz: number,
	capture: SpectrumViewSpan,
	marginHz: number,
): TuneAction {
	const target = Math.round(hz)
	const margin = Math.min(marginHz, spanWidth(capture) / 4)
	if (target >= capture.startHz + margin && target <= capture.endHz - margin)
		return { kind: "offset", offsetHz: Math.round(target - hardwareCentreHz) }
	return { kind: "retune", centreHz: target }
}

/**
 * Edge margin for the live-audio channel: the capture's unusable edge (1 − USABLE_FRACTION, half on each
 * side) plus half the channel bandwidth, so a channel placed by offset is always one the core identifies.
 */
export function edgeMargin(
	capture: SpectrumViewSpan,
	bandwidthHz: number,
): number {
	return (
		(spanWidth(capture) - spanWidth(capture) * USABLE_FRACTION) / 2 +
		Math.max(0, bandwidthHz) / 2
	)
}

/**
 * After the hardware moves to `centreHz`, the live-audio offset that keeps `tunedHz` where it is, or
 * null when it would fall outside the new capture (`sampleRateHz` wide).
 */
export function offsetKeeping(
	tunedHz: number,
	centreHz: number,
	sampleRateHz: number,
	marginHz: number,
): number | null {
	const offset = Math.round(tunedHz - centreHz)
	const half = sampleRateHz / 2 - Math.min(marginHz, sampleRateHz / 4)
	return Math.abs(offset) <= half ? offset : null
}

/** The band-plan step at `hz` (narrowest band naming one), else the default. */
export function tuningStep(
	view: ResolvedBandPlanView | null,
	hz: number | null,
): number {
	if (!view || hz === null) return DEFAULT_STEP_HZ
	let best: ResolvedBand | null = null
	for (const b of view.bands) {
		if (b.band.stepHz === null || b.band.stepHz <= 0) continue
		if (!b.segments.some(s => hz >= s.startHz && hz <= s.endHz)) continue
		if (!best || bandWidth(b) < bandWidth(best)) best = b
	}
	return best?.band.stepHz ?? DEFAULT_STEP_HZ
}

function bandWidth(b: ResolvedBand): number {
	return b.band.endHz - b.band.startHz
}

// ── Wheel, pinch and keys ─────────────────────────────────────────────────────────────────────

/** Pixels of wheel travel per tuning step (a mouse notch is about 100). */
export const WHEEL_STEP_PX = 40

/** Wheel delta in px whatever the deltaMode (0 px, 1 lines, 2 pages). */
export function wheelPixels(
	delta: number,
	deltaMode: number,
	pageHeight = 800,
): number {
	if (deltaMode === 1) return delta * 16
	if (deltaMode === 2) return delta * pageHeight
	return delta
}

/**
 * Adds wheel travel to the accumulator; once it reaches `stepPx` one step is taken (positive = up in
 * frequency, i.e. scrolling up) and the accumulator restarts, so a mouse notch (≈100 px) is one step
 * and a trackpad needs a deliberate swipe.
 */
export function accumulateWheel(
	acc: number,
	deltaPx: number,
	stepPx = WHEEL_STEP_PX,
): { steps: number; acc: number } {
	const total = acc + deltaPx
	if (Math.abs(total) < stepPx) return { steps: 0, acc: total }
	return { steps: total < 0 ? 1 : -1, acc: 0 }
}

/** Zoom factor for ctrl/⌘ + wheel (and trackpad pinch, which arrives as ctrl + wheel). */
export function wheelZoomFactor(deltaPx: number): number {
	return Math.exp(-deltaPx * 0.004)
}

/** Zoom factor of a two-finger pinch: finger distance now over distance at the last update. */
export function pinchFactor(
	previousDistance: number,
	distance: number,
): number {
	if (!(previousDistance > 0) || !(distance > 0)) return 1
	return distance / previousDistance
}

export type KeyAction =
	| { type: "step"; dir: 1 | -1; times: number }
	| { type: "pan"; fraction: number }
	| { type: "zoom"; factor: number }
	| { type: "fit" }

/**
 * Keyboard on the focused plot: ←/→ step the frequency (PageUp/PageDown ten steps), shift+←/→ pan
 * a tenth of the view, +/− zoom, 0 or Home fits the capture.
 */
export function keyAction(
	key: string,
	mods: { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean },
): KeyAction | null {
	if (mods.ctrl || mods.meta || mods.alt) return null
	switch (key) {
		case "ArrowRight":
		case "ArrowUp":
			return mods.shift && key === "ArrowRight"
				? { type: "pan", fraction: 0.1 }
				: { type: "step", dir: 1, times: 1 }
		case "ArrowLeft":
		case "ArrowDown":
			return mods.shift && key === "ArrowLeft"
				? { type: "pan", fraction: -0.1 }
				: { type: "step", dir: -1, times: 1 }
		case "PageUp":
			return { type: "step", dir: 1, times: 10 }
		case "PageDown":
			return { type: "step", dir: -1, times: 10 }
		case "+":
		case "=":
			return { type: "zoom", factor: 2 }
		case "-":
		case "_":
			return { type: "zoom", factor: 0.5 }
		case "0":
		case "Home":
			return { type: "fit" }
		default:
			return null
	}
}

// ── Band lanes ────────────────────────────────────────────────────────────────────────────────

const GROUP_TOKEN: Readonly<Record<DisplayGroup, string>> = {
	marine: "marine",
	air: "air",
	"ism-srd": "srd",
	pagers: "pagers",
	"personal-radio": "personal",
	amateur: "amateur",
	"land-mobile": "landmobile",
	broadcast: "broadcast",
	other: "other",
}

/** The colour token of a display group: var(--wk-grp-…). */
export function groupColour(group: DisplayGroup): string {
	return `var(--wk-grp-${GROUP_TOKEN[group]})`
}

export interface LanePiece {
	key: string
	/** 0–1 across the view. */
	left: number
	width: number
	label: string
	showLabel: boolean
	/** Max label width, px. */
	labelMax: number
	title: string
	colour: string
	skip: boolean
	startsBand: boolean
	endsBand: boolean
	depth: number
}

/** Nesting depth of a band (its parent chain inside the same pack). */
function nestingDepth(
	b: ResolvedBand,
	byKey: ReadonlyMap<string, ResolvedBand>,
): number {
	let depth = 0
	let parentId = b.band.parentId
	const seen = new Set<string>()
	while (parentId !== null && depth < 16) {
		const key = `${b.packId}/${parentId}`
		if (seen.has(key)) break
		seen.add(key)
		const parent = byKey.get(key)
		if (!parent) break
		depth++
		parentId = parent.band.parentId
	}
	return depth
}

/**
 * Band lanes for the view, cut into pieces: a band shows where no narrower (or deeper) band covers
 * it, so a nested band reads as drawn over its parent and the parent's name moves to a stretch it
 * still owns. The name goes in the widest piece when it fits; colour never comes without the name.
 */
export function lanePieces(
	view: ResolvedBandPlanView | null,
	span: SpectrumViewSpan,
	widthPx: number,
	charPx = 7.8,
): LanePiece[] {
	if (!view || !(spanWidth(span) > 0)) return []
	const L = span.startHz
	const R = span.endHz
	const width = R - L
	const byKey = new Map(view.bands.map(b => [b.key, b]))
	const visible = view.bands
		.filter(b => b.segments.some(s => s.endHz > L && s.startHz < R))
		.map(b => ({ b, depth: nestingDepth(b, byKey) }))
		.sort(
			(x, y) =>
				y.depth - x.depth ||
				bandWidth(x.b) - bandWidth(y.b) ||
				(x.b.key < y.b.key ? -1 : 1),
		)
	const out: LanePiece[] = []
	const covered: [number, number][] = []
	for (const { b, depth } of visible) {
		let pieces: [number, number][] = b.segments
			.filter(s => s.endHz > L && s.startHz < R)
			.map(s => [Math.max(s.startHz, L), Math.min(s.endHz, R)])
		for (const [c0, c1] of covered)
			pieces = pieces.flatMap(([g0, g1]): [number, number][] =>
				c1 <= g0 || c0 >= g1
					? [[g0, g1]]
					: (
							[
								[g0, c0],
								[c1, g1],
							] as [number, number][]
						).filter(([a, z]) => z - a > 0),
			)
		for (const s of b.segments) covered.push([s.startHz, s.endHz])
		let widest: [number, number] | null = null
		for (const p of pieces)
			if (!widest || p[1] - p[0] > widest[1] - widest[0]) widest = p
		const labelPx = b.band.name.length * charPx + 24
		const mhz = (hz: number) => String(+(hz / 1e6).toFixed(4))
		const title =
			`${b.band.name} · ${mhz(b.band.startHz)}–${mhz(b.band.endHz)} MHz` +
			(b.band.skip ? ` · scans skip it: ${b.band.skip.reason}` : "")
		pieces.forEach((p, i) => {
			const px = ((p[1] - p[0]) / width) * widthPx
			out.push({
				key: `${b.key}#${i}`,
				left: (p[0] - L) / width,
				width: (p[1] - p[0]) / width,
				label: b.band.name,
				showLabel: p === widest && px >= labelPx,
				labelMax: Math.max(0, px - 12),
				title,
				colour: groupColour(b.band.group),
				skip: b.band.skip !== null,
				startsBand: b.segments.some(s => s.startHz === p[0]),
				endsBand: b.segments.some(s => s.endHz === p[1]),
				depth,
			})
		})
	}
	return out
}

// ── Signal labels ─────────────────────────────────────────────────────────────────────────────

export interface SignalInfo {
	hz: number
	widthHz: number
	label: string
	sub: string | null
	burst: boolean
	/** Named by the band plan (a channel or the band's mode); else the label is the frequency. */
	known: boolean
	/** Peak dBFS over the track (anchors the chip above it); null when unknown. */
	peakDb: number | null
}

function channelNear(
	view: ResolvedBandPlanView,
	hz: number,
	toleranceHz: number,
): { band: ResolvedBand; channel: BandChannel } | null {
	let best: { band: ResolvedBand; channel: BandChannel } | null = null
	for (const band of view.bands)
		for (const channel of band.band.channels) {
			const d = Math.abs(channel.frequencyHz - hz)
			if (d > toleranceHz) continue
			if (!best || d < Math.abs(best.channel.frequencyHz - hz))
				best = { band, channel }
		}
	return best
}

function narrowestBand(
	view: ResolvedBandPlanView,
	hz: number,
): ResolvedBand | null {
	let best: ResolvedBand | null = null
	for (const b of view.bands)
		if (b.segments.some(s => hz >= s.startHz && hz <= s.endHz))
			if (!best || bandWidth(b) < bandWidth(best)) best = b
	return best
}

/**
 * What to call each track: the plan channel at its centre ("Marine ch 16"), else the band's mode
 * ("NFM") with the frequency as detail, else just the frequency (core does not identify signals on
 * the spectrum yet: CORE-GAPS "Auto band map for spectrum labels").
 */
export function describeTracks(
	tracks: readonly Track[],
	plan: ResolvedBandPlanView | null,
): SignalInfo[] {
	return tracks.map(t => {
		const hz = (t.startHz + t.endHz) / 2
		const widthHz = t.endHz - t.startHz
		const freq = formatMHz(hz, 3)
		const base = {
			hz,
			widthHz,
			burst: t.flags.burst,
			peakDb: t.peakDb ?? null,
		}
		if (plan) {
			const hit = channelNear(plan, hz, Math.max(3000, widthHz / 2))
			if (hit)
				return { ...base, label: hit.channel.name, sub: freq, known: true }
			const band = narrowestBand(plan, hz)
			if (band?.band.mode)
				return {
					...base,
					label: band.band.mode.toUpperCase(),
					sub: freq,
					known: true,
				}
		}
		return { ...base, label: freq, sub: null, known: false }
	})
}

/**
 * Tracks seen in the last `holdMs` (bursty signals keep their label between bursts). A new track
 * replaces a held one it overlaps.
 */
export function holdTracks(
	held: readonly { track: Track; seenAt: number }[],
	tracks: readonly Track[],
	now: number,
	holdMs: number,
): { track: Track; seenAt: number }[] {
	const fresh = tracks.map(track => ({ track, seenAt: now }))
	const kept = held.filter(
		h =>
			now - h.seenAt <= holdMs &&
			!tracks.some(t => t.startHz < h.track.endHz && t.endHz > h.track.startHz),
	)
	return [...fresh, ...kept].sort((a, b) => a.track.startHz - b.track.startHz)
}

export interface PlacedLabel {
	hz: number
	/** CSS px from the left of the plot. */
	x: number
	/** CSS px from the top of the trace band. */
	top: number
	/** Lead line length below the chip, px. */
	lead: number
	label: string
	sub: string | null
	tuned: boolean
	known: boolean
}

export interface LabelOptions {
	widthPx: number
	traceCss: number
	/** Trace levels, to anchor each chip above its signal's peak. */
	levels?: SpectrumLevels
	tunedHz: number | null
	/** Rectangles already taken, [x0, y0, x1, y1] px. */
	taken?: [number, number, number, number][]
	charPx?: number
	subCharPx?: number
}

const LABEL_H = 28
const LABEL_ROW = 30
const LABEL_TOP = 8
/** Chip top sits this far above its signal's peak; the lead line runs down to just above it. */
const LABEL_ABOVE_PEAK = 46
const LEAD_GAP = 8

/**
 * Places signal chips without overlap, as on the design board: the tuned signal first, then named
 * signals, then the strongest. Each chip sits just above its signal's peak and tries one and two rows
 * higher, then a compact form without its detail, and is dropped when it still clashes (the signal
 * stays clickable). Without a level the chip starts from the top rows.
 */
export function placeLabels(
	signals: readonly SignalInfo[],
	view: SpectrumViewSpan,
	opts: LabelOptions,
): PlacedLabel[] {
	const span = spanWidth(view)
	if (!(span > 0)) return []
	const charPx = opts.charPx ?? 7.4
	const subCharPx = opts.subCharPx ?? 6.6
	const taken = [...(opts.taken ?? [])]
	const tunedTol = (span / Math.max(1, opts.widthPx)) * 4
	const isTuned = (s: SignalInfo) =>
		opts.tunedHz !== null &&
		Math.abs(s.hz - opts.tunedHz) <= Math.max(tunedTol, s.widthHz / 2)
	const rows = Math.max(
		1,
		Math.min(3, Math.floor((opts.traceCss - LABEL_TOP - 24) / LABEL_ROW)),
	)
	const levels = opts.levels
	const order = signals
		.filter(s => s.hz >= view.startHz && s.hz <= view.endHz)
		.map(s => ({ s, tuned: isTuned(s) }))
		.sort(
			(a, b) =>
				Number(b.tuned) - Number(a.tuned) ||
				Number(b.s.known) - Number(a.s.known) ||
				(b.s.peakDb ?? -Infinity) - (a.s.peakDb ?? -Infinity) ||
				b.s.widthHz - a.s.widthHz ||
				a.s.hz - b.s.hz,
		)
	const out: PlacedLabel[] = []
	for (const { s, tuned } of order) {
		const x = ((s.hz - view.startHz) / span) * opts.widthPx
		const full =
			40 + s.label.length * charPx + (s.sub ? 6 + s.sub.length * subCharPx : 0)
		const compact = 40 + s.label.length * charPx
		const forms: [number, boolean][] = s.sub
			? [
					[full, true],
					[compact, false],
				]
			: [[compact, false]]
		const peakY =
			levels && s.peakDb !== null
				? dbToTraceY(s.peakDb, levels, opts.traceCss)
				: null
		// Lowest allowed spot: above the peak, never into the bottom of the band.
		const lowest = Math.min(
			opts.traceCss - LABEL_H - 16,
			peakY === null
				? LABEL_TOP + (rows - 1) * LABEL_ROW
				: peakY - LABEL_ABOVE_PEAK,
		)
		const tops: number[] = []
		for (let row = 0; row < rows; row++) {
			const top =
				peakY === null
					? LABEL_TOP + row * LABEL_ROW
					: Math.max(LABEL_TOP, lowest) - row * LABEL_ROW
			if (top >= LABEL_TOP && !tops.includes(top)) tops.push(top)
		}
		let placed = false
		for (const [w, withSub] of forms) {
			for (const top of tops) {
				if (placed) break
				const r: [number, number, number, number] = [
					x - w / 2 - 3,
					top - 2,
					x + w / 2 + 3,
					top + LABEL_H,
				]
				if (r[0] < 34 || r[2] > opts.widthPx - 2) continue
				if (
					taken.some(
						o => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1],
					)
				)
					continue
				taken.push(r)
				out.push({
					hz: s.hz,
					x,
					top,
					lead:
						peakY === null
							? 10
							: Math.max(6, peakY - LEAD_GAP - (top + LABEL_H)),
					label: s.label,
					sub: withSub ? s.sub : null,
					tuned,
					known: s.known,
				})
				placed = true
			}
			if (placed) break
		}
	}
	return out
}
