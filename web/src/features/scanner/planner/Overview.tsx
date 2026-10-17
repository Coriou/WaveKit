// The ruler's overview strip, 100–900 MHz: your ranges as marks and the visible stretch as a window; press or drag
// to move the ruler there. Arrow keys move it by a tenth of the strip.
import { useRef, type KeyboardEvent, type PointerEvent } from "react"

import type { PlanRange } from "./plan.ts"
import { clampView, type View } from "./ruler.ts"

const OV = { lo: 100e6, hi: 900e6 } as const

const pct = (hz: number) =>
	((Math.min(OV.hi, Math.max(OV.lo, hz)) - OV.lo) / (OV.hi - OV.lo)) * 100

export function Overview({
	view,
	ranges,
	onView,
}: {
	view: View
	ranges: readonly PlanRange[]
	onView: (v: View) => void
}) {
	const el = useRef<HTMLDivElement>(null)
	const moving = useRef<number | null>(null)
	const centreAt = (clientX: number) => {
		const r = el.current?.getBoundingClientRect()
		if (!r) return
		const hz =
			OV.lo + ((clientX - r.left) / Math.max(1, r.width)) * (OV.hi - OV.lo)
		const span = view.hi - view.lo
		onView(clampView({ lo: hz - span / 2, hi: hz + span / 2 }))
	}
	const onDown = (e: PointerEvent<HTMLDivElement>) => {
		moving.current = e.pointerId
		e.currentTarget.setPointerCapture(e.pointerId)
		centreAt(e.clientX)
	}
	const onMove = (e: PointerEvent<HTMLDivElement>) => {
		if (moving.current === e.pointerId) centreAt(e.clientX)
	}
	const onUp = () => {
		moving.current = null
	}
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
		if (!d) return
		e.preventDefault()
		const step = (OV.hi - OV.lo) / 10
		onView(clampView({ lo: view.lo + d * step, hi: view.hi + d * step }))
	}
	const centreMHz = Math.round((view.lo + view.hi) / 2e6)
	const left = pct(view.lo)
	const width = Math.max(0, pct(view.hi) - left)
	return (
		<div
			ref={el}
			className="wk-pl-ov"
			role="slider"
			tabIndex={0}
			aria-label="Overview, 100 to 900 MHz"
			title="Overview, 100 to 900 MHz · drag to move the ruler"
			aria-valuemin={100}
			aria-valuemax={900}
			aria-valuenow={centreMHz}
			aria-valuetext={`${centreMHz} MHz`}
			onPointerDown={onDown}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onUp}
			onKeyDown={onKey}
		>
			{ranges.map(r => (
				<span
					key={r.key}
					className="wk-pl-ovmark"
					aria-hidden="true"
					style={{
						left: `${pct(r.startHz)}%`,
						width: `max(2px, ${pct(r.endHz) - pct(r.startHz)}%)`,
					}}
				/>
			))}
			<span
				className="wk-pl-ovwin"
				aria-hidden="true"
				style={{ left: `${left}%`, width: `max(6px, ${width}%)` }}
			/>
		</div>
	)
}
