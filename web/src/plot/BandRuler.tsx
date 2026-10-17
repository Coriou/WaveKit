// The band ruler (band-ruler.ts): a strip under the band lanes showing a wide stretch of the band around the
// view, drawn like the Scan planner's overview strip (a well, the view as an ink window): the band plan as
// quiet colour, where the scanner has heard things as a density strip, saved frequencies as accent dots, the
// tuned frequency as a tick. Its two ends read in MHz. The row ends with the plot's one zoom: − and + zoom the
// spectrum (animated, around the VFO), and past Fit − keeps going by widening the ruler up to the whole tuner
// range, since the spectrum cannot show more than the capture; the label reads the zoom and goes back to Fit.
// The wheel over the ruler widens or narrows it. Press or drag and the view goes there at once while the receiver follows (plot-store.ts centreAt);
// hovering reads the frequency and band under the pointer; arrows move by a view width (Shift: a tenth of the
// ruler). It sits beside the plot body, not in it, so its presses never reach the plot's own listeners.
import "./band-ruler.css"

import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react"
import type { ResolvedBandPlanView } from "@wavekit/api-types"

import type { DataLayer } from "../data/index.ts"
import { useStore } from "../data/index.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import {
	activityBins,
	bandNameAt,
	followCentre,
	hzToRulerX,
	rulerBands,
	rulerMarks,
	rulerSpan,
	rulerXToHz,
} from "./band-ruler.ts"
import { useDiscoveryFetch } from "./DiscoveryTags.tsx"
import type { DiscoveryTagFilter } from "./discovery-tags.ts"
import { formatMHz, spanCentre, spanWidth, zoomLabel } from "./maths.ts"
import { RULER_MAX_LEVEL, type PlotController } from "./plot-store.ts"

export interface BandRulerProps {
	data: DataLayer
	controller: PlotController
	plan: ResolvedBandPlanView | null
	/** The span on screen. */
	view: SpectrumViewSpan
	/** What the frames cover now. */
	capture: SpectrumViewSpan
	widthPx: number
	/** Top, CSS px from the top of the plot body. */
	top: number
	tunedHz: number | null
	/** Which discoveries the heard strip counts (Settings › Signal labels, through discoveryTagFilter). */
	discoveries?: DiscoveryTagFilter
}

/** Wheel travel (px) per ruler level. */
const WHEEL_LEVEL_PX = 120
/** Room the ends take beside the track: start label; end label and the zoom (band-ruler.css). */
const START_PX = 58
const END_PX = 160
/** A − or + press animates over this long (none under Motion: reduce). */
const ZOOM_ANIM_MS = 160

/** Zooms by `factor` around the VFO, eased over ZOOM_ANIM_MS. */
function animateZoom(controller: PlotController, factor: number): void {
	const reduce =
		typeof document !== "undefined" &&
		document.documentElement.dataset["wkMotion"] === "reduce"
	if (reduce || typeof requestAnimationFrame === "undefined") {
		controller.zoomCentred(factor)
		return
	}
	const total = Math.log(factor)
	const start = performance.now()
	let applied = 0
	const step = (now: number) => {
		const t = Math.min(1, (now - start) / ZOOM_ANIM_MS)
		const target = total * (1 - (1 - t) ** 3)
		controller.zoomCentred(Math.exp(target - applied))
		applied = target
		if (t < 1) requestAnimationFrame(step)
	}
	requestAnimationFrame(step)
}

/** "446.0" under 1 GHz with one decimal while the ruler is narrow, whole MHz once it is wide. */
function edgeText(hz: number, spanHz: number): string {
	return formatMHz(hz, spanHz >= 50e6 ? 0 : 1)
}

export const BandRuler = memo(function BandRuler({
	data,
	controller,
	plan,
	view,
	capture,
	widthPx,
	top,
	tunedHz,
	discoveries: mode = "all",
}: BandRulerProps) {
	const level = useStore(controller.store, s => s.ruler)
	const zoomedIn = useStore(
		controller.store,
		s => s.free !== null || s.view.spanHz !== null,
	)
	const [centre, setCentre] = useState<number | null>(null)
	const [pressed, setPressed] = useState(false)
	const [hoverHz, setHoverHz] = useState<number | null>(null)
	const captureWidth = spanWidth(capture)
	// Recentre when the view nears the ruler's edge, never mid-press (the strip must hold still under the pointer).
	const nextCentre = followCentre(centre, view, captureWidth, level)
	useEffect(() => {
		if (!pressed && nextCentre !== centre) setCentre(nextCentre)
	}, [pressed, nextCentre, centre])
	const span = useMemo(
		() => rulerSpan(centre ?? spanCentre(view), captureWidth, level),
		// the view only seeds the first centre (followCentre keeps it after)
		[centre, captureWidth, level],
	)
	useDiscoveryFetch(data.scanner, span)
	const trackPx = Math.max(40, widthPx - START_PX - END_PX)

	const savedItems = useStore(data.savedFrequencies, s => s.items)
	const discoveries = useStore(data.scanner, s => s.discoveries.byId)
	const bands = useMemo(
		() => rulerBands(plan, span, trackPx),
		[plan, span, trackPx],
	)
	const saved = useMemo(
		() =>
			rulerMarks(
				savedItems.map(f => ({
					key: f.id,
					hz: f.frequencyHz,
					title: f.name,
				})),
				span,
				// one dot per 6 px at most: a channel list must not read as a fence
				Math.max(1, Math.floor(trackPx / 6)),
			),
		[savedItems, span, trackPx],
	)
	const heard = useMemo(
		() =>
			activityBins(
				[...discoveries.values()]
					.filter(d => mode === "all" || d.confidence === "decoded")
					.map(d => d.frequencyHz),
				span,
				trackPx,
			),
		[discoveries, span, trackPx, mode],
	)

	const trackRef = useRef<HTMLDivElement>(null)
	const live = useRef({ span, view })
	live.current = { span, view }
	useEffect(() => {
		const el = trackRef.current
		if (!el) return
		let grab: { id: number; offsetHz: number } | null = null
		let wheelAcc = 0
		const hzAt = (clientX: number) => {
			const r = el.getBoundingClientRect()
			return rulerXToHz(
				(clientX - r.left) / Math.max(1, r.width),
				live.current.span,
			)
		}
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || grab) return
			e.preventDefault()
			el.focus({ preventScroll: true })
			el.setPointerCapture(e.pointerId)
			const hz = hzAt(e.clientX)
			const v = live.current.view
			// Pressing the window drags it by where it was held; elsewhere the view jumps there.
			const inBox = hz >= v.startHz && hz <= v.endHz
			grab = {
				id: e.pointerId,
				offsetHz: inBox ? hz - spanCentre(v) : 0,
			}
			setPressed(true)
			controller.beginPan()
			controller.centreAt(hz - grab.offsetHz)
		}
		const onMove = (e: PointerEvent) => {
			if (grab && e.pointerId === grab.id) {
				controller.centreAt(hzAt(e.clientX) - grab.offsetHz)
				return
			}
			if (e.pointerType === "mouse") setHoverHz(hzAt(e.clientX))
		}
		const onUp = (e: PointerEvent) => {
			if (!grab || e.pointerId !== grab.id) return
			grab = null
			if (el.hasPointerCapture(e.pointerId))
				el.releasePointerCapture(e.pointerId)
			setPressed(false)
			void controller.endPan()
		}
		const onLeave = () => setHoverHz(null)
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			wheelAcc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
			const steps = Math.trunc(wheelAcc / WHEEL_LEVEL_PX)
			if (steps === 0) return
			wheelAcc -= steps * WHEEL_LEVEL_PX
			controller.store.setRuler(controller.store.get().ruler + steps)
		}
		el.addEventListener("pointerdown", onDown)
		el.addEventListener("pointermove", onMove)
		el.addEventListener("pointerup", onUp)
		el.addEventListener("pointercancel", onUp)
		el.addEventListener("pointerleave", onLeave)
		el.addEventListener("wheel", onWheel, { passive: false })
		return () => {
			el.removeEventListener("pointerdown", onDown)
			el.removeEventListener("pointermove", onMove)
			el.removeEventListener("pointerup", onUp)
			el.removeEventListener("pointercancel", onUp)
			el.removeEventListener("pointerleave", onLeave)
			el.removeEventListener("wheel", onWheel)
			if (grab) void controller.endPan()
		}
	}, [controller])

	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
		if (!dir) return
		e.preventDefault()
		const step = e.shiftKey ? spanWidth(span) / 10 : spanWidth(view)
		controller.beginPan()
		controller.centreAt(spanCentre(view) + dir * step)
		void controller.endPan()
	}

	const pct = (x: number) => `${x * 100}%`
	const viewLeft = Math.max(0, hzToRulerX(view.startHz, span))
	const viewRight = Math.min(1, hzToRulerX(view.endHz, span))
	const tuned =
		tunedHz !== null && tunedHz >= span.startHz && tunedHz <= span.endHz
			? hzToRulerX(tunedHz, span)
			: null
	const spanHz = spanWidth(span)
	const centreMHz = spanCentre(view) / 1e6
	const readHz = hoverHz
	const readBand = readHz !== null ? bandNameAt(plan, readHz) : null
	const readX = readHz !== null ? hzToRulerX(readHz, span) : 0

	return (
		<div
			className="wk-ruler"
			style={{ top }}
			data-pressed={pressed ? "" : undefined}
		>
			<span className="wk-ruler-edge" aria-hidden="true">
				{edgeText(span.startHz, spanHz)}
			</span>
			<div
				ref={trackRef}
				className="wk-ruler-track"
				role="slider"
				tabIndex={0}
				aria-label="Band ruler: press or drag to move the spectrum there"
				aria-valuemin={Math.round(span.startHz / 1e6)}
				aria-valuemax={Math.round(span.endHz / 1e6)}
				aria-valuenow={Math.round(centreMHz)}
				aria-valuetext={`${formatMHz(spanCentre(view), 3)} MHz`}
				onKeyDown={onKey}
			>
				{bands.map(b => (
					<i
						key={b.key}
						className="wk-ruler-band"
						data-depth={b.depth}
						style={{
							left: pct(b.left),
							width: pct(b.width),
							background: b.colour,
						}}
					/>
				))}
				{heard.map(b => (
					<i
						key={b.x}
						className="wk-ruler-heard"
						style={{
							left: pct(b.x),
							width: pct(b.width),
							height: `${2 + Math.round(b.level * 6)}px`,
						}}
					/>
				))}
				{saved.map(m => (
					<i
						key={m.key}
						className="wk-ruler-saved"
						style={{ left: pct(m.x) }}
					/>
				))}
				<i
					className="wk-ruler-window"
					style={{
						left: pct(viewLeft),
						width: pct(Math.max(0, viewRight - viewLeft)),
					}}
				/>
				{tuned !== null && (
					<i className="wk-ruler-tuned" style={{ left: pct(tuned) }} />
				)}
				{readHz !== null && !pressed && (
					<span
						className="wk-ruler-read"
						style={{
							left: `clamp(0px, calc(${pct(readX)} - 60px), calc(100% - 120px))`,
						}}
					>
						{formatMHz(readHz, spanHz >= 50e6 ? 1 : 3)}
						{readBand && <em>{readBand}</em>}
					</span>
				)}
			</div>
			<span className="wk-ruler-edge wk-ruler-edge-end" aria-hidden="true">
				{edgeText(span.endHz, spanHz)} MHz
			</span>
			<span className="wk-ruler-zoom">
				<button
					type="button"
					aria-label="Zoom out"
					title={zoomedIn ? "Zoom out" : "Zoom out: widen the band ruler"}
					disabled={!zoomedIn && level >= RULER_MAX_LEVEL}
					onClick={() => animateZoom(controller, 0.5)}
				>
					−
				</button>
				<button
					type="button"
					className="wk-ruler-fit"
					aria-label={zoomedIn ? "Show the whole capture" : "Zoom"}
					title={zoomedIn ? "Show the whole capture (0)" : undefined}
					disabled={!zoomedIn && level === 0}
					onClick={() =>
						zoomedIn ? controller.fit() : controller.store.setRuler(0)
					}
				>
					{zoomedIn ? zoomLabel(view, capture) : "Fit"}
				</button>
				<button
					type="button"
					aria-label="Zoom in"
					title="Zoom in"
					onClick={() => animateZoom(controller, 2)}
				>
					+
				</button>
			</span>
		</div>
	)
})
