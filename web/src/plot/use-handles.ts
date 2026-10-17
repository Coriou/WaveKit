/**
 * Pointer input for the plot's grab handles. Listens in the capture phase on the plot body, ahead of the
 * pan/zoom/click listeners: a press on a handle (handles.ts hitTest) is taken here, with pointer capture,
 * and never reaches them; any other press goes on to pan, pinch or click as before. A press on a handle
 * released without moving is a plain click (tune there). Hovering a handle sets `data-handle` on the
 * body for its cursor; a drag sets `data-handle-drag`.
 */

import { useEffect, type RefObject } from "react"

import type { SpectrumLevels, SpectrumViewSpan } from "../spectrum/index.ts"
import type { HandleController } from "./handle-controller.ts"
import {
	type BandwidthRange,
	type HandleKind,
	bandwidthAtHz,
	handleGeometry,
	hitTest,
	squelchAtY,
	vfoDragHz,
} from "./handles.ts"
import { spanWidth } from "./maths.ts"
import type { PlotController } from "./plot-store.ts"

/** What the handles need from the latest render, read at event time. */
export interface HandleFrame {
	view: SpectrumViewSpan | null
	widthPx: number
	traceCss: number
	levels: SpectrumLevels
	vfoHz: number | null
	bandwidthHz: number
	/** The mode's bandwidth limits; null: no channel filter to resize (RAW, no live audio). */
	bandwidthRange: BandwidthRange | null
	stepHz: number
	readOnly: boolean
	/** The squelch threshold drawn now (live, read from the store), null when hidden. */
	squelchDbfs: () => number | null
}

const DRAG_THRESHOLD_PX = 3

export function useHandles(
	ref: RefObject<HTMLDivElement | null>,
	frameRef: RefObject<HandleFrame>,
	handles: HandleController,
	plot: PlotController,
	clearHover: () => void,
): void {
	useEffect(() => {
		const el = ref.current
		if (!el) return
		let drag: {
			kind: HandleKind
			id: number
			x: number
			y: number
			moved: boolean
			startHz: number
			spanHz: number
		} | null = null

		const local = (e: PointerEvent) => {
			const r = el.getBoundingClientRect()
			return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width }
		}
		const hit = (e: PointerEvent): HandleKind | null => {
			const f = frameRef.current
			if (!f.view || f.widthPx <= 0) return null
			const geom = handleGeometry({
				view: f.view,
				widthPx: f.widthPx,
				traceCss: f.traceCss,
				levels: f.levels,
				vfoHz: f.vfoHz,
				bandwidthHz: f.bandwidthHz,
				edgesAllowed: !f.readOnly && f.bandwidthRange !== null,
				vfoAllowed: !f.readOnly,
				squelchDbfs: f.readOnly ? null : f.squelchDbfs(),
			})
			const { x, y } = local(e)
			return hitTest(geom, x, y, {
				traceCss: f.traceCss,
				vfoAllowed: !f.readOnly,
				touch: e.pointerType !== "mouse",
			})
		}
		const finish = () => {
			delete el.dataset["handleDrag"]
			drag = null
			handles.end()
		}

		const onDown = (e: PointerEvent) => {
			if (drag) {
				// A second finger while a handle is held: ignore it (no pinch mid-drag).
				e.stopImmediatePropagation()
				return
			}
			if (e.button !== 0 || (e.target as Element).closest("button")) return
			const kind = hit(e)
			if (!kind) return
			e.stopImmediatePropagation()
			const f = frameRef.current
			el.setPointerCapture(e.pointerId)
			drag = {
				kind,
				id: e.pointerId,
				x: e.clientX,
				y: e.clientY,
				moved: false,
				startHz: f.vfoHz ?? 0,
				spanHz: f.view ? spanWidth(f.view) : 0,
			}
			handles.begin(kind)
		}
		const onMove = (e: PointerEvent) => {
			if (!drag) {
				if (e.pointerType !== "mouse" || el.dataset["dragging"] !== undefined)
					return
				const kind = hit(e)
				if (kind) el.dataset["handle"] = kind
				else delete el.dataset["handle"]
				return
			}
			if (e.pointerId !== drag.id) return
			e.stopImmediatePropagation()
			const d = drag
			if (
				!d.moved &&
				Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_THRESHOLD_PX
			) {
				d.moved = true
				el.dataset["handleDrag"] = d.kind
				clearHover()
			}
			if (!d.moved) return
			const f = frameRef.current
			const { x, y, w } = local(e)
			if (d.kind === "vfo") {
				handles.dragVfo(
					vfoDragHz(d.startHz, e.clientX - d.x, w, d.spanHz, f.stepHz),
				)
			} else if (d.kind === "squelch") {
				handles.setSquelch(squelchAtY(y, f.levels, f.traceCss))
			} else if (f.view && f.vfoHz !== null && f.bandwidthRange) {
				const hz = f.view.startHz + (x / Math.max(1, w)) * spanWidth(f.view)
				handles.setBandwidth(bandwidthAtHz(hz, f.vfoHz, f.bandwidthRange))
			}
		}
		const onUp = (e: PointerEvent) => {
			if (!drag || e.pointerId !== drag.id) return
			e.stopImmediatePropagation()
			if (el.hasPointerCapture(e.pointerId))
				el.releasePointerCapture(e.pointerId)
			const d = drag
			finish()
			if (!d.moved && e.type === "pointerup") {
				const { x, w } = local(e)
				const frac = Math.min(1, Math.max(0, x / Math.max(1, w)))
				void plot.clickAt(frac, w)
			}
		}
		const onLost = (e: PointerEvent) => {
			if (drag && e.pointerId === drag.id) finish()
		}
		const onLeave = () => {
			delete el.dataset["handle"]
		}

		const capture = { capture: true }
		el.addEventListener("pointerdown", onDown, capture)
		el.addEventListener("pointermove", onMove, capture)
		el.addEventListener("pointerup", onUp, capture)
		el.addEventListener("pointercancel", onUp, capture)
		el.addEventListener("lostpointercapture", onLost)
		el.addEventListener("pointerleave", onLeave)
		return () => {
			el.removeEventListener("pointerdown", onDown, capture)
			el.removeEventListener("pointermove", onMove, capture)
			el.removeEventListener("pointerup", onUp, capture)
			el.removeEventListener("pointercancel", onUp, capture)
			el.removeEventListener("lostpointercapture", onLost)
			el.removeEventListener("pointerleave", onLeave)
			if (drag) finish()
			delete el.dataset["handle"]
		}
	}, [ref, frameRef, handles, plot, clearHover])
}
