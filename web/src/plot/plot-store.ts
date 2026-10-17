/**
 * Plot state (zoom/pan relative to the capture, the frequency being tuned) and the controller that
 * turns clicks, wheel notches, drags and keys into view changes and tune requests. No DOM here: the
 * component feeds it the current context and pixel sizes.
 */

import { Store } from "../data/index.ts"
import type { SpectrumLevels, SpectrumViewSpan } from "../spectrum/index.ts"
import { DEFAULT_LEVELS } from "../spectrum/protocol.ts"
import {
	FIT_VIEW,
	type KeyAction,
	type PlotView,
	type Track,
	accumulateWheel,
	edgeMargin,
	followHz,
	offsetKeeping,
	panBy,
	resolveView,
	snapToStep,
	snapToTrackChannel,
	spanWidth,
	tuneAction,
	zoomAt,
} from "./maths.ts"

/** The scale Auto has found for the shown source; Settings › Spectrum range: Fixed holds it. */
export const autoLevelsNow = new Store<SpectrumLevels>(DEFAULT_LEVELS)

export interface PlotState {
	view: PlotView
	/** A tune request in flight: the VFO shows it until the core answers. */
	pendingHz: number | null
}

export class PlotStore extends Store<PlotState> {
	constructor(initial: Partial<PlotState> = {}) {
		super({ view: FIT_VIEW, pendingHz: null, ...initial })
	}

	setView(view: PlotView): void {
		const current = this.get().view
		if (
			current.spanHz === view.spanHz &&
			current.centreOffsetHz === view.centreOffsetHz
		)
			return
		this.update(s => ({ ...s, view }))
	}
}

/** What the controller needs to know about the receiver, refreshed by the component. */
export interface PlotContext {
	sourceId: string | null
	/**
	 * The capture on screen (from the latest frame, else the tuner). A real core's frames cover only the
	 * usable share of the band (USABLE_FRACTION), so this is narrower than the hardware capture.
	 */
	capture: SpectrumViewSpan | null
	/** Hardware centre the live-audio offset is relative to. */
	centreHz: number | null
	sampleRateHz: number | null
	/** Tuned frequency (centre + live-audio offset). */
	tunedHz: number | null
	bandwidthHz: number
	stepHz: number
	tracks: readonly Track[]
	/** The operator's sweep has the receiver: a tune recentres the hardware so the scan pauses. */
	scanHasReceiver?: boolean
}

export interface PlotActions {
	/** Retune the hardware centre. */
	retune(hz: number, sourceId: string): Promise<unknown>
	/** Move the live-audio channel to `offsetHz` from the hardware centre. */
	setOffset(offsetHz: number): Promise<unknown>
}

export const EMPTY_CONTEXT: PlotContext = {
	sourceId: null,
	capture: null,
	centreHz: null,
	sampleRateHz: null,
	tunedHz: null,
	bandwidthHz: 12_500,
	stepHz: 12_500,
	tracks: [],
}

export class PlotController {
	readonly store: PlotStore
	private readonly actions: PlotActions
	private ctx: PlotContext = EMPTY_CONTEXT
	private wheelAcc = 0
	private pan: { start: PlotView; overflowHz: number } | null = null
	private seq = 0

	constructor(actions: PlotActions, store: PlotStore = new PlotStore()) {
		this.actions = actions
		this.store = store
	}

	setContext(ctx: PlotContext): void {
		this.ctx = ctx
	}

	/** The span on screen, or null before the first frame. */
	visibleSpan(): SpectrumViewSpan | null {
		const capture = this.ctx.capture
		return capture ? resolveView(this.store.get().view, capture) : null
	}

	/** The VFO to draw: a pending request, else the core's tuned frequency. */
	vfoHz(): number | null {
		return this.store.get().pendingHz ?? this.ctx.tunedHz
	}

	/**
	 * The hardware capture (centre ± sample rate / 2) the tuning rule works on, as tuning.ts does; the
	 * on-screen capture when the tuner is unknown. The frame span must not be used: a real core sends only
	 * the usable 80 %, and edgeMargin() would then cut the unusable edge a second time.
	 */
	hardwareCapture(): SpectrumViewSpan | null {
		const { capture, centreHz, sampleRateHz } = this.ctx
		if (centreHz !== null && sampleRateHz !== null && sampleRateHz > 0)
			return {
				startHz: centreHz - sampleRateHz / 2,
				endHz: centreHz + sampleRateHz / 2,
			}
		return capture
	}

	/** Tunes to `hz`: inside the capture the live-audio channel moves, outside the hardware recentres. */
	tuneTo(hz: number): Promise<void> {
		const { capture, centreHz, sourceId } = this.ctx
		const hardware = this.hardwareCapture()
		if (!capture || !hardware || centreHz === null || !(hz > 0))
			return Promise.resolve()
		const action: ReturnType<typeof tuneAction> = this.ctx.scanHasReceiver
			? { kind: "retune", centreHz: Math.round(hz) }
			: tuneAction(
					hz,
					centreHz,
					hardware,
					edgeMargin(hardware, this.ctx.bandwidthHz),
				)
		const seq = ++this.seq
		this.store.update(s => ({ ...s, pendingHz: Math.round(hz) }))
		let run: Promise<unknown>
		if (action.kind === "offset") {
			this.store.setView(followHz(this.store.get().view, capture, hz))
			run = this.actions.setOffset(action.offsetHz)
		} else if (sourceId !== null) {
			// Recentre: the channel goes back to the middle, the view keeps its zoom around it.
			this.store.setView({ ...this.store.get().view, centreOffsetHz: 0 })
			run = this.actions
				.retune(action.centreHz, sourceId)
				.then(() => this.actions.setOffset(0))
		} else {
			run = Promise.resolve()
		}
		return run.then(
			() => this.settle(seq),
			() => this.settle(seq),
		)
	}

	/** The frequency at screen x (0–1), snapped to the signal under it, else to the step raster. */
	signalAt(x: number, widthPx: number): number | null {
		const view = this.visibleSpan()
		if (!view) return null
		const hz = view.startHz + x * spanWidth(view)
		return (
			snapToTrackChannel(hz, this.ctx.tracks, view, widthPx, this.ctx.stepHz) ??
			snapToStep(hz, this.ctx.stepHz)
		)
	}

	/** A click at screen x (0–1): tunes to `signalAt`. */
	clickAt(x: number, widthPx: number): Promise<void> {
		const hz = this.signalAt(x, widthPx)
		return hz === null ? Promise.resolve() : this.tuneTo(hz)
	}

	/** `times` tuning steps up (dir 1) or down (dir −1). */
	step(dir: 1 | -1, times = 1): Promise<void> {
		const base = this.vfoHz()
		if (base === null) return Promise.resolve()
		const step = this.ctx.stepHz
		return this.tuneTo(snapToStep(base + dir * times * step, step))
	}

	/** Plain wheel: accumulates travel, steps the frequency per WHEEL_STEP_PX. */
	wheelStep(deltaPx: number): Promise<void> {
		const { steps, acc } = accumulateWheel(this.wheelAcc, deltaPx)
		this.wheelAcc = acc
		if (steps === 0) return Promise.resolve()
		return this.step(steps > 0 ? 1 : -1, Math.abs(steps))
	}

	zoom(anchorX: number, factor: number): void {
		const capture = this.ctx.capture
		if (!capture || !(factor > 0)) return
		this.store.setView(zoomAt(this.store.get().view, capture, anchorX, factor))
	}

	/** Zoom buttons: around the VFO when it is on screen, else the middle. */
	zoomCentred(factor: number): void {
		const view = this.visibleSpan()
		if (!view) return
		const vfo = this.vfoHz()
		const anchor =
			vfo !== null && vfo >= view.startHz && vfo <= view.endHz
				? (vfo - view.startHz) / spanWidth(view)
				: 0.5
		this.zoom(anchor, factor)
	}

	fit(): void {
		this.store.setView(FIT_VIEW)
	}

	/** Pans by a fraction of the visible span (keys). */
	panFraction(fraction: number): void {
		const capture = this.ctx.capture
		const view = this.visibleSpan()
		if (!capture || !view) return
		this.store.setView(
			panBy(this.store.get().view, capture, fraction * spanWidth(view)).view,
		)
	}

	beginPan(): void {
		this.pan = { start: this.store.get().view, overflowHz: 0 }
	}

	/** Drag by `dxPx` (since beginPan) on a plot `widthPx` wide. */
	dragPan(dxPx: number, widthPx: number): void {
		const capture = this.ctx.capture
		const pan = this.pan
		if (!capture || !pan) return
		const span = spanWidth(resolveView(pan.start, capture))
		const result = panBy(
			pan.start,
			capture,
			(-dxPx / Math.max(1, widthPx)) * span,
		)
		pan.overflowHz = result.overflowHz
		this.store.setView(result.view)
	}

	/**
	 * Ends a drag. Dragged past the capture edge while zoomed in, the hardware moves by the overflow
	 * and the live-audio channel stays on its frequency when the new capture still holds it.
	 */
	endPan(): Promise<void> {
		const pan = this.pan
		this.pan = null
		const { capture, centreHz, sourceId, sampleRateHz, tunedHz } = this.ctx
		if (!pan || !capture || centreHz === null || sourceId === null)
			return Promise.resolve()
		if (Math.abs(pan.overflowHz) < spanWidth(capture) * 0.01)
			return Promise.resolve()
		const hardware = this.hardwareCapture() ?? capture
		const centre = Math.round(centreHz + pan.overflowHz)
		const keep =
			tunedHz !== null && sampleRateHz !== null
				? offsetKeeping(
						tunedHz,
						centre,
						sampleRateHz,
						edgeMargin(hardware, this.ctx.bandwidthHz),
					)
				: null
		// The view stays relative to the capture: once the hardware has moved it shows what was dragged to.
		return this.actions
			.retune(centre, sourceId)
			.then(() => (keep !== null ? this.actions.setOffset(keep) : undefined))
			.then(
				() => undefined,
				() => undefined,
			)
	}

	/** Runs a keyboard action; true when the key was used. */
	key(action: KeyAction): boolean {
		switch (action.type) {
			case "step":
				void this.step(action.dir, action.times)
				return true
			case "pan":
				this.panFraction(action.fraction)
				return true
			case "zoom":
				this.zoomCentred(action.factor)
				return true
			case "fit":
				this.fit()
				return true
		}
	}

	private settle(seq: number): void {
		if (seq === this.seq) this.store.update(s => ({ ...s, pendingHz: null }))
	}
}
