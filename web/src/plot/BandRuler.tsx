// The band ruler (band-ruler.ts): a strip under the band lanes showing a wide stretch of the band around the
// capture, with the band plan, saved frequencies and scanner discoveries, the capture outlined and the view
// filled. Press or drag on it and the view goes there at once while the receiver follows (plot-store.ts
// centreAt); the wheel widens or narrows it, up to the whole tuner range. It sits beside the plot body, not
// in it, so its presses never reach the plot's pan, handle and menu listeners.
import "./band-ruler.css"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import type { ResolvedBandPlanView } from "@wavekit/api-types"

import type { DataLayer } from "../data/index.ts"
import { useStore } from "../data/index.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import {
	DEFAULT_RULER_LEVEL,
	clampLevel,
	followCentre,
	hzToRulerX,
	rulerBands,
	rulerMarks,
	rulerSpan,
	rulerTicks,
	rulerXToHz,
} from "./band-ruler.ts"
import { useDiscoveryFetch } from "./DiscoveryTags.tsx"
import { formatMHz, spanCentre, spanWidth } from "./maths.ts"
import type { PlotController } from "./plot-store.ts"

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
}

/** Wheel travel (px) per ruler level. */
const WHEEL_LEVEL_PX = 120

export const BandRuler = memo(function BandRuler({
	data,
	controller,
	plan,
	view,
	capture,
	widthPx,
	top,
	tunedHz,
}: BandRulerProps) {
	const [level, setLevel] = useState(DEFAULT_RULER_LEVEL)
	const [centre, setCentre] = useState<number | null>(null)
	const [pressed, setPressed] = useState(false)
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

	const savedItems = useStore(data.savedFrequencies, s => s.items)
	const discoveries = useStore(data.scanner, s => s.discoveries.byId)
	const bands = useMemo(
		() => rulerBands(plan, span, widthPx),
		[plan, span, widthPx],
	)
	const saved = useMemo(
		() =>
			rulerMarks(
				savedItems.map(f => ({
					key: f.id,
					hz: f.frequencyHz,
					title: `${f.name} · ${formatMHz(f.frequencyHz, 4)} MHz`,
				})),
				span,
				widthPx,
			),
		[savedItems, span, widthPx],
	)
	const found = useMemo(
		() =>
			rulerMarks(
				[...discoveries.values()].map(d => ({
					key: d.id,
					hz: d.frequencyHz,
					title: `Scanner discovery · ${formatMHz(d.frequencyHz, 4)} MHz`,
				})),
				span,
				widthPx,
			),
		[discoveries, span, widthPx],
	)
	const ticks = useMemo(() => rulerTicks(span, widthPx), [span, widthPx])

	const ref = useRef<HTMLDivElement>(null)
	const live = useRef({ span, view })
	live.current = { span, view }
	useEffect(() => {
		const el = ref.current
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
			el.setPointerCapture(e.pointerId)
			const hz = hzAt(e.clientX)
			const v = live.current.view
			// Pressing the view's box drags it by where it was held; elsewhere the view jumps there.
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
			if (!grab || e.pointerId !== grab.id) return
			controller.centreAt(hzAt(e.clientX) - grab.offsetHz)
		}
		const onUp = (e: PointerEvent) => {
			if (!grab || e.pointerId !== grab.id) return
			grab = null
			if (el.hasPointerCapture(e.pointerId))
				el.releasePointerCapture(e.pointerId)
			setPressed(false)
			void controller.endPan()
		}
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			wheelAcc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
			const steps = Math.trunc(wheelAcc / WHEEL_LEVEL_PX)
			if (steps === 0) return
			wheelAcc -= steps * WHEEL_LEVEL_PX
			setLevel(l => clampLevel(l + steps))
		}
		el.addEventListener("pointerdown", onDown)
		el.addEventListener("pointermove", onMove)
		el.addEventListener("pointerup", onUp)
		el.addEventListener("pointercancel", onUp)
		el.addEventListener("wheel", onWheel, { passive: false })
		return () => {
			el.removeEventListener("pointerdown", onDown)
			el.removeEventListener("pointermove", onMove)
			el.removeEventListener("pointerup", onUp)
			el.removeEventListener("pointercancel", onUp)
			el.removeEventListener("wheel", onWheel)
			if (grab) void controller.endPan()
		}
	}, [controller])

	const pct = (x: number) => `${x * 100}%`
	const viewLeft = hzToRulerX(view.startHz, span)
	const viewRight = hzToRulerX(view.endHz, span)
	const capLeft = hzToRulerX(capture.startHz, span)
	const capRight = hzToRulerX(capture.endHz, span)
	const tuned =
		tunedHz !== null && tunedHz >= span.startHz && tunedHz <= span.endHz
			? hzToRulerX(tunedHz, span)
			: null
	const spanMHz = spanWidth(span) / 1e6

	return (
		<div
			ref={ref}
			className="wk-ruler"
			style={{ top }}
			data-pressed={pressed ? "" : undefined}
			role="group"
			aria-label={`Band ruler, ${formatMHz(span.startHz, 1)} to ${formatMHz(span.endHz, 1)} MHz. Press or drag to move the spectrum there; the wheel widens it.`}
		>
			{bands.map(b => (
				<i
					key={b.key}
					className="wk-ruler-band"
					data-depth={b.depth}
					title={b.title}
					style={{
						left: pct(b.left),
						width: pct(b.width),
						background: b.colour,
					}}
				/>
			))}
			{ticks.map(t => (
				<span key={t.hz} className="wk-ruler-tick" style={{ left: pct(t.x) }}>
					{t.text}
				</span>
			))}
			{found.map(m => (
				<i
					key={m.key}
					className="wk-ruler-found"
					title={m.title}
					style={{ left: pct(m.x) }}
				/>
			))}
			{saved.map(m => (
				<i
					key={m.key}
					className="wk-ruler-saved"
					title={m.title}
					style={{ left: pct(m.x) }}
				/>
			))}
			<i
				className="wk-ruler-capture"
				aria-hidden="true"
				style={{
					left: pct(capLeft),
					width: pct(Math.max(0, capRight - capLeft)),
				}}
			/>
			<i
				className="wk-ruler-view"
				aria-hidden="true"
				style={{
					left: pct(viewLeft),
					width: pct(Math.max(0, viewRight - viewLeft)),
				}}
			/>
			{tuned !== null && (
				<i
					className="wk-ruler-tuned"
					aria-hidden="true"
					style={{ left: pct(tuned) }}
				/>
			)}
			<span
				className="wk-ruler-span"
				title="Wheel over the ruler to widen or narrow it"
			>
				{spanMHz >= 100
					? Math.round(spanMHz)
					: spanMHz.toFixed(spanMHz >= 10 ? 0 : 1)}{" "}
				MHz
			</span>
		</div>
	)
})
