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
	MIN_SPAN_HZ,
	followHz,
	offsetKeeping,
	resolveView,
	snapToStep,
	snapToTrackChannel,
	spanCentre,
	spanWidth,
	tuneAction,
	viewOf,
	zoomAt,
} from "./maths.ts"
import { TUNER_RANGE } from "../features/tuner/frequency.ts"

/** The scale Auto has found for the shown source; Settings › Spectrum range: Fixed holds it. */
export const autoLevelsNow = new Store<SpectrumLevels>(DEFAULT_LEVELS)

export interface PlotState {
	view: PlotView
	/** A tune request in flight: the VFO shows it until the core answers. */
	pendingHz: number | null
	/**
	 * An absolute span shown instead of `view` while the spectrum is dragged (or swiped) past the
	 * capture: the picture slides at once, the receiver follows, and the part no frame covers yet is
	 * hatched. Cleared, back to a `view` relative to the capture, once the frames have caught up.
	 */
	free: SpectrumViewSpan | null
}

export class PlotStore extends Store<PlotState> {
	constructor(initial: Partial<PlotState> = {}) {
		super({ view: FIT_VIEW, pendingHz: null, free: null, ...initial })
	}

	setFree(free: SpectrumViewSpan | null): void {
		const current = this.get().free
		if (
			current === free ||
			(current &&
				free &&
				current.startHz === free.startHz &&
				current.endHz === free.endHz)
		)
			return
		this.update(s => ({ ...s, free }))
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

/** Timers the follow-the-drag retunes use (fake ones in tests). */
export interface PlotTimers {
	now(): number
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

const REAL_TIMERS: PlotTimers = {
	now: () => performance.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** At most one retune per this many ms while dragging past the capture (latest wins). */
export const FOLLOW_RETUNE_MS = 150
/** A retune smaller than this share of the capture is not worth sending. */
const FOLLOW_MIN_SHARE = 0.02
/** A slid view gives up waiting for frames at the new centre after this long. */
export const FREE_RELEASE_MS = 4000
/** How far (share of the capture) a slid view may sit off the capture and still count as caught up. */
const CAUGHT_UP_SHARE = 0.02

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
	private readonly timers: PlotTimers
	private wheelAcc = 0
	/** A drag: the absolute span at its start, and the frequency the live channel keeps. */
	private pan: { start: SpectrumViewSpan; keepHz: number | null } | null = null
	/** Follow-the-view retunes: one in flight, the latest target queued behind it. */
	private follow: {
		target: number | null
		sent: number | null
		inFlight: Promise<void> | null
		lastAt: number
		timer: unknown
		failed: boolean
		/** A retune during the drag left the live channel out of the capture (fixed at the end). */
		parked: boolean
	} = {
		target: null,
		sent: null,
		inFlight: null,
		lastAt: -Infinity,
		timer: null,
		failed: false,
		parked: false,
	}
	private releaseTimer: unknown = null
	private seq = 0

	constructor(
		actions: PlotActions,
		store: PlotStore = new PlotStore(),
		timers: PlotTimers = REAL_TIMERS,
	) {
		this.actions = actions
		this.store = store
		this.timers = timers
	}

	setContext(ctx: PlotContext): void {
		this.ctx = ctx
	}

	/** The span on screen, or null before the first frame. */
	visibleSpan(): SpectrumViewSpan | null {
		const capture = this.ctx.capture
		if (!capture) return null
		return this.store.get().free ?? resolveView(this.store.get().view, capture)
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
		this.dropFree()
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
		const free = this.store.get().free
		if (free) {
			// Zooming a slid view: around the cursor, never wider than the capture.
			const width = Math.min(
				spanWidth(capture),
				Math.max(
					Math.min(MIN_SPAN_HZ, spanWidth(capture)),
					spanWidth(free) / factor,
				),
			)
			const anchor =
				free.startHz + Math.min(1, Math.max(0, anchorX)) * spanWidth(free)
			const startHz = anchor - Math.min(1, Math.max(0, anchorX)) * width
			this.store.setFree({ startHz, endHz: startHz + width })
			this.captureChanged()
			return
		}
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
		this.dropFree()
		this.store.setView(FIT_VIEW)
	}

	/** Pans by a fraction of the visible span (keys, horizontal wheel); past the capture it retunes. */
	panFraction(fraction: number): void {
		const view = this.visibleSpan()
		if (!view) return
		this.slideTo(shiftSpan(view, fraction * spanWidth(view)), false)
	}

	beginPan(): void {
		const start = this.visibleSpan()
		this.pan = start ? { start, keepHz: this.ctx.tunedHz } : null
	}

	/** Drag by `dxPx` (since beginPan) on a plot `widthPx` wide: the picture follows the pointer. */
	dragPan(dxPx: number, widthPx: number): void {
		const pan = this.pan
		if (!pan) return
		const deltaHz = (-dxPx / Math.max(1, widthPx)) * spanWidth(pan.start)
		this.slideTo(shiftSpan(pan.start, deltaHz), true)
	}

	/** During a press or drag on the band ruler: the view's centre goes to `hz`, the receiver follows. */
	centreAt(hz: number): void {
		const pan = this.pan
		if (!pan) return
		this.slideTo(shiftSpan(pan.start, hz - spanCentre(pan.start)), true)
	}

	/**
	 * Ends a drag. Inside the capture the view simply stays where it was dragged; past it, the last
	 * retune goes out now and the slid picture holds until frames at the new centre arrive.
	 */
	endPan(): Promise<void> {
		const pan = this.pan
		this.pan = null
		if (!pan) return Promise.resolve()
		const done = this.flushFollow(pan.keepHz)
		this.captureChanged()
		return done
	}

	/**
	 * The capture or tuner moved (a frame at a new centre): a slid view that the capture now holds
	 * goes back to a view relative to the capture. Plot calls it whenever the capture changes.
	 */
	captureChanged(): void {
		const free = this.store.get().free
		const capture = this.ctx.capture
		if (!free || !capture || this.pan) return
		if (this.follow.inFlight || this.follow.timer !== null) return
		const width = spanWidth(capture)
		const slack = width * CAUGHT_UP_SHARE
		if (
			free.startHz < capture.startHz - slack ||
			free.endHz > capture.endHz + slack
		)
			// Still waiting on frames at the new centre (the release timer gives up).
			return
		this.settleFree(capture)
	}

	/** Shows `span` (absolute); outside the capture the receiver follows it. */
	private slideTo(span: SpectrumViewSpan, dragging: boolean): void {
		const capture = this.ctx.capture
		if (!capture) return
		const next = clampToTuner(span)
		const width = spanWidth(capture)
		const slack = width * CAUGHT_UP_SHARE
		const inside =
			next.startHz >= capture.startHz - slack &&
			next.endHz <= capture.endHz + slack
		if (inside && !dragging && !this.store.get().free) {
			this.store.setView(viewOf(clampInside(next, capture), capture))
			return
		}
		this.store.setFree(next)
		this.armRelease()
		if (inside || this.follow.failed || this.ctx.sourceId === null) return
		// A real core's frame middle sits a little off the hardware centre: recentre so that the next
		// frame's middle lands on the slid view's.
		const skew =
			this.ctx.centreHz !== null ? spanCentre(capture) - this.ctx.centreHz : 0
		this.requestCentre(
			spanCentre(next) - skew,
			dragging ? (this.pan?.keepHz ?? null) : this.ctx.tunedHz,
		)
	}

	/** Queues a retune to `centreHz` (latest wins; at most one in flight, one per FOLLOW_RETUNE_MS). */
	private requestCentre(centreHz: number, keepHz: number | null): void {
		const f = this.follow
		f.target = Math.round(centreHz)
		this.pumpFollow(keepHz)
	}

	private pumpFollow(keepHz: number | null): void {
		const f = this.follow
		if (f.inFlight || f.timer !== null || f.target === null) return
		const capture = this.ctx.capture
		const from = f.sent ?? this.ctx.centreHz
		if (
			capture &&
			from !== null &&
			Math.abs(f.target - from) < spanWidth(capture) * FOLLOW_MIN_SHARE
		) {
			f.target = null
			return
		}
		const wait = f.lastAt + FOLLOW_RETUNE_MS - this.timers.now()
		if (wait > 0) {
			f.timer = this.timers.setTimeout(() => {
				f.timer = null
				this.pumpFollow(keepHz)
			}, wait)
			return
		}
		// never rejects: a refusal is handled inside
		void this.sendFollow(keepHz)
	}

	private sendFollow(keepHz: number | null): Promise<void> {
		const f = this.follow
		const { sourceId, sampleRateHz } = this.ctx
		const centre = f.target
		if (centre === null || sourceId === null) return Promise.resolve()
		f.target = null
		f.sent = centre
		f.lastAt = this.timers.now()
		const dragging = this.pan !== null
		const hardware = this.hardwareCapture()
		const keep =
			keepHz !== null && sampleRateHz !== null && hardware
				? offsetKeeping(
						keepHz,
						centre,
						sampleRateHz,
						edgeMargin(hardware, this.ctx.bandwidthHz),
					)
				: null
		const run = this.actions
			.retune(centre, sourceId)
			// Out of the new capture, the channel goes to its middle once the drag is over (as tuneTo).
			.then(() => {
				f.parked = keep === null && dragging
				if (keep !== null) return this.actions.setOffset(keep)
				return dragging ? undefined : this.actions.setOffset(0)
			})
			.then(
				() => undefined,
				() => {
					// Refused (the scan holds the receiver, read-only…): stop following, snap back.
					f.failed = true
					f.target = null
				},
			)
			.then(() => {
				f.inFlight = null
				if (f.failed) {
					this.dropFree()
					return
				}
				if (f.target !== null) this.pumpFollow(keepHz)
				else this.captureChanged()
			})
		f.inFlight = run
		return run
	}

	/** Sends the queued target now (end of a drag) and resolves once every retune has answered. */
	private flushFollow(keepHz: number | null): Promise<void> {
		const f = this.follow
		if (f.timer !== null) {
			this.timers.clearTimeout(f.timer)
			f.timer = null
		}
		const waitAll = (): Promise<void> => {
			if (f.inFlight) return f.inFlight.then(waitAll)
			if (f.target !== null && !f.failed) {
				f.lastAt = -Infinity
				const run = this.sendFollow(keepHz)
				return run.then(waitAll)
			}
			return Promise.resolve()
		}
		return waitAll()
			.then(() => {
				const park = f.parked && !f.failed
				f.parked = false
				return park ? this.actions.setOffset(0) : undefined
			})
			.then(
				() => undefined,
				() => undefined,
			)
			.then(() => {
				f.failed = false
				f.sent = null
			})
	}

	private armRelease(): void {
		if (this.releaseTimer !== null) this.timers.clearTimeout(this.releaseTimer)
		this.releaseTimer = this.timers.setTimeout(() => {
			this.releaseTimer = null
			if (this.pan) return this.armRelease()
			const capture = this.ctx.capture
			if (this.store.get().free && capture) this.settleFree(capture)
		}, FREE_RELEASE_MS)
	}

	/** Back to a view relative to `capture`, showing as much of the slid span as it holds. */
	private settleFree(capture: SpectrumViewSpan): void {
		const free = this.store.get().free
		if (free) this.store.setView(viewOf(clampInside(free, capture), capture))
		this.dropFree()
	}

	private dropFree(): void {
		if (this.releaseTimer !== null) {
			this.timers.clearTimeout(this.releaseTimer)
			this.releaseTimer = null
		}
		this.store.setFree(null)
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

function shiftSpan(span: SpectrumViewSpan, deltaHz: number): SpectrumViewSpan {
	return { startHz: span.startHz + deltaHz, endHz: span.endHz + deltaHz }
}

/** Keeps a span's centre inside the tuner's range. */
function clampToTuner(span: SpectrumViewSpan): SpectrumViewSpan {
	const mid = spanCentre(span)
	const clamped = Math.min(TUNER_RANGE.maxHz, Math.max(TUNER_RANGE.minHz, mid))
	return shiftSpan(span, clamped - mid)
}

/** `span` moved (not resized, unless wider) to sit inside `bounds`. */
function clampInside(
	span: SpectrumViewSpan,
	bounds: SpectrumViewSpan,
): SpectrumViewSpan {
	const width = Math.min(spanWidth(span), spanWidth(bounds))
	let startHz = Math.max(bounds.startHz, span.startHz)
	if (startHz + width > bounds.endHz) startHz = bounds.endHz - width
	return { startHz, endHz: startHz + width }
}
