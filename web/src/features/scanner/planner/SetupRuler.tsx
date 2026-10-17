// Setup ruler: band-plan lanes (click a band to add or take it out), the "your ranges" lane with numbered tags,
// hatched skips, the axis. Drag on empty ruler draws a range (or a skip with the Skip tool, or Alt held).
// Ctrl + scroll zooms at the pointer, a sideways scroll pans. Plain DOM, recomputed only when the view, the plan or
// the width changes.
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
} from "react"

import { formatMHz } from "../../format.ts"
import type { PlanRange } from "./plan.ts"
import {
	bandAtX,
	hzAt,
	labelled,
	panView,
	placeTags,
	snapHz,
	ticks,
	xOf,
	zoomView,
	type Lane,
	type LaneBand,
	type View,
} from "./ruler.ts"

export type DrawKind = "add" | "skip"

export interface RulerSkip {
	readonly key: string
	readonly startHz: number
	readonly endHz: number
	readonly title: string
}

export interface SetupRulerProps {
	lanes: readonly Lane[]
	ranges: readonly PlanRange[]
	skips: readonly RulerSkip[]
	view: View
	onView: (v: View) => void
	tool: DrawKind
	onDraw: (kind: DrawKind, loHz: number, hiHz: number) => void
	onBand: (band: LaneBand) => void
	/** Band keys whose range is in the plan. */
	bandsOn: ReadonlySet<string>
	/** Lane names in a gutter on the left. */
	gutter: boolean
	compact: boolean
	/** Range keys whose row has a problem. */
	bad: ReadonlySet<string>
}

interface Drag {
	readonly x0: number
	readonly x1: number
	readonly kind: DrawKind
}

export function useWidth<T extends HTMLElement>(): [
	(el: T | null) => void,
	number,
] {
	const [el, setEl] = useState<T | null>(null)
	const [w, setW] = useState(0)
	useEffect(() => {
		if (!el) return
		setW(el.clientWidth)
		if (typeof ResizeObserver === "undefined") return
		const ro = new ResizeObserver(() => setW(el.clientWidth))
		ro.observe(el)
		return () => ro.disconnect()
	}, [el])
	return [setEl, w]
}

export function SetupRuler({
	lanes,
	ranges,
	skips,
	view,
	onView,
	tool,
	onDraw,
	onBand,
	bandsOn,
	gutter,
	compact,
	bad,
}: SetupRulerProps) {
	const [trackRef, w] = useWidth<HTMLDivElement>()
	const track = useRef<HTMLDivElement | null>(null)
	const [drag, setDrag] = useState<Drag | null>(null)
	const press = useRef<{
		x: number
		y: number
		id: number
		alt: boolean
	} | null>(null)

	const LH = compact ? 11 : 13
	const LG = 2
	const laneTop = 6
	const lanesEnd = laneTop + lanes.length * (LH + LG) - LG
	const rangeTop = lanesEnd + 6
	const rangeH = 24
	const axisTop = lanesEnd + 34
	const height = axisTop + 22

	const viewRef = useRef(view)
	viewRef.current = view
	const onViewRef = useRef(onView)
	onViewRef.current = onView
	// wheel: Ctrl / ⌘ + scroll zooms at the pointer, a sideways scroll pans (non-passive, so it does not scroll the page)
	useEffect(() => {
		const el = track.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			const v = viewRef.current
			const width = el.clientWidth
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault()
				const at = hzAt(e.clientX - el.getBoundingClientRect().left, v, width)
				onViewRef.current(zoomView(v, Math.exp(e.deltaY * 0.004), at))
			} else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
				e.preventDefault()
				const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
				onViewRef.current(panView(v, (d / Math.max(1, width)) * (v.hi - v.lo)))
			}
		}
		el.addEventListener("wheel", onWheel, { passive: false })
		return () => el.removeEventListener("wheel", onWheel)
	}, [])

	const X = (hz: number) => xOf(hz, view, w)
	const visible = (a: number, b: number) => b > view.lo && a < view.hi
	const clip = (a: number, b: number) => {
		const x0 = Math.max(-2, X(a))
		const x1 = Math.min(w + 2, X(b))
		return { left: x0, width: Math.max(2, x1 - x0) }
	}

	const tags = useMemo(
		() =>
			w > 0
				? placeTags(
						ranges
							.map((r, i) => ({ r, num: i + 1 }))
							.filter(({ r }) => visible(r.startHz, r.endHz))
							.map(({ r, num }) => ({
								num,
								name: r.name,
								x0: Math.max(0, xOf(r.startHz, view, w)),
								x1: Math.min(w, xOf(r.endHz, view, w)),
							})),
						w,
					)
				: [],
		[ranges, view, w],
	)

	// faint channel ticks once the zoom spreads a range's channels at least 6 px apart (cap 400 per range)
	const chans = useMemo(() => {
		if (w <= 0) return []
		const out: { key: string; x: number }[] = []
		for (const r of ranges) {
			const st = Math.max(0, ...r.spacingHz)
			if (!(st > 0) || !visible(r.startHz, r.endHz)) continue
			const px = (st / (view.hi - view.lo)) * w
			if (px < 6) continue
			const first =
				r.planRasters.find(x => Math.round(x.spacingHz) === st)
					?.firstChannelHz ?? r.startHz
			let hz =
				first + Math.ceil((Math.max(r.startHz, view.lo) - first) / st) * st
			for (
				let n = 0;
				hz <= Math.min(r.endHz, view.hi) && n < 400;
				n++, hz += st
			)
				out.push({ key: `${r.key}:${hz}`, x: xOf(hz, view, w) })
		}
		return out
	}, [ranges, view, w])

	const axis = useMemo(
		() => (w > 0 ? labelled(ticks(view, w, compact ? 70 : 90), w) : []),
		[view, w, compact],
	)

	const localX = (e: PointerEvent) =>
		e.clientX - (track.current?.getBoundingClientRect().left ?? 0)
	const localY = (e: PointerEvent) =>
		e.clientY - (track.current?.getBoundingClientRect().top ?? 0)

	const onDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return
		press.current = {
			x: localX(e),
			y: localY(e),
			id: e.pointerId,
			alt: e.altKey,
		}
		e.currentTarget.setPointerCapture(e.pointerId)
	}
	const onMove = (e: PointerEvent<HTMLDivElement>) => {
		const p = press.current
		if (!p || p.id !== e.pointerId) return
		const x = Math.max(0, Math.min(w, localX(e)))
		if (!drag && Math.abs(x - p.x) < 4) return
		setDrag({ x0: p.x, x1: x, kind: tool === "skip" || p.alt ? "skip" : "add" })
	}
	const onUp = (e: PointerEvent<HTMLDivElement>) => {
		const p = press.current
		press.current = null
		if (!p || p.id !== e.pointerId) return
		if (drag) {
			setDrag(null)
			const a = snapHz(hzAt(Math.min(drag.x0, drag.x1), view, w))
			const b = snapHz(hzAt(Math.max(drag.x0, drag.x1), view, w))
			if (b - a >= 5000) onDraw(drag.kind, a, b)
			return
		}
		if (p.y < lanesEnd + 2) {
			const lane = lanes[Math.floor((p.y - laneTop) / (LH + LG))]
			const band = lane ? bandAtX(lane, p.x, view, w) : null
			if (band && !band.skip) onBand(band)
		}
	}
	const onCancel = () => {
		press.current = null
		setDrag(null)
	}
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const span = view.hi - view.lo
		if (e.key === "ArrowLeft") onView(panView(view, -span * 0.1))
		else if (e.key === "ArrowRight") onView(panView(view, span * 0.1))
		else if (e.key === "+" || e.key === "=") onView(zoomView(view, 0.7))
		else if (e.key === "-" || e.key === "_") onView(zoomView(view, 1 / 0.7))
		else return
		e.preventDefault()
	}

	const dragLo = drag ? hzAt(Math.min(drag.x0, drag.x1), view, w) : 0
	const dragHi = drag ? hzAt(Math.max(drag.x0, drag.x1), view, w) : 0

	return (
		<div
			className="wk-pl-ruler"
			style={{ height }}
			tabIndex={0}
			role="group"
			aria-label={`Ruler, ${formatMHz(view.lo)} to ${formatMHz(view.hi)} MHz. Drag to add a range, Ctrl + scroll to zoom`}
			onKeyDown={onKey}
		>
			{gutter && (
				<div className="wk-pl-gutter" aria-hidden="true">
					{lanes.map((l, i) => (
						<span
							key={l.group}
							className="wk-pl-gutlabel"
							style={{ top: laneTop + i * (LH + LG) - 1, height: LH + 2 }}
						>
							<span className="wk-pl-swatch" style={{ background: l.colour }} />
							<span className="wk-pl-ellipsis">{l.name}</span>
						</span>
					))}
					<span
						className="wk-pl-gutlabel"
						data-strong=""
						style={{ top: rangeTop, height: rangeH }}
					>
						Your ranges
					</span>
				</div>
			)}
			<div
				ref={el => {
					track.current = el
					trackRef(el)
				}}
				className="wk-pl-track"
				data-tool={tool}
				onPointerDown={onDown}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerCancel={onCancel}
			>
				{w > 0 &&
					lanes.map((l, i) =>
						l.bands
							.filter(b => visible(b.startHz, b.endHz))
							.map(b => (
								<div
									key={b.key}
									className="wk-pl-band"
									data-on={bandsOn.has(b.key) || undefined}
									data-skip={b.skip !== null || undefined}
									title={
										b.skip
											? `${b.name} · ${edges(b)} · skipped by default: ${b.skip}`
											: `${b.name} · ${edges(b)} · click to ${bandsOn.has(b.key) ? "take it out" : "add it"}`
									}
									style={{
										top: laneTop + i * (LH + LG),
										height: LH,
										...clip(b.startHz, b.endHz),
										["--wk-pl-grp" as string]: l.colour,
									}}
								>
									{X(b.endHz) - X(b.startHz) > 40 && (
										<span className="wk-pl-bandname">{b.name}</span>
									)}
								</div>
							)),
					)}
				<div
					className="wk-pl-laneline"
					style={{ top: lanesEnd + 2 }}
					aria-hidden="true"
				/>
				{w > 0 &&
					ranges
						.filter(r => visible(r.startHz, r.endHz))
						.map(r => (
							<div
								key={r.key}
								className="wk-pl-range"
								data-bad={bad.has(r.key) || undefined}
								title={`${r.name} · ${edges(r)} MHz`}
								style={{
									top: rangeTop,
									height: rangeH,
									...clip(r.startHz, r.endHz),
								}}
							/>
						))}
				{chans.map(c => (
					<span
						key={c.key}
						className="wk-pl-chan"
						style={{ left: c.x, top: rangeTop + rangeH - 6 }}
						aria-hidden="true"
					/>
				))}
				{w > 0 &&
					skips
						.filter(x => visible(x.startHz, x.endHz))
						.map(x => (
							<div
								key={x.key}
								className="wk-pl-skip"
								title={x.title}
								style={{
									top: rangeTop + 3,
									height: rangeH - 6,
									...clip(x.startHz, x.endHz),
								}}
							/>
						))}
				{ranges.length === 0 && !drag && (
					<span
						className="wk-pl-rulerempty"
						style={{ top: rangeTop, height: rangeH }}
						aria-hidden="true"
					>
						Click a band or drag here
					</span>
				)}
				{tags.map(t => (
					<span key={t.num} aria-hidden="true">
						<span
							className="wk-pl-tag"
							style={{ top: rangeTop + 3, left: t.left, minWidth: t.w }}
						>
							{t.num}
						</span>
						{t.nameW > 0 && (
							<span
								className="wk-pl-tagname"
								style={{
									top: rangeTop + 3,
									left: t.nameLeft,
									maxWidth: t.nameW,
								}}
							>
								{t.name}
							</span>
						)}
					</span>
				))}
				{drag && (
					<div
						className="wk-pl-drag"
						data-kind={drag.kind}
						aria-hidden="true"
						style={{
							left: Math.min(drag.x0, drag.x1),
							width: Math.abs(drag.x1 - drag.x0),
							top: 2,
							height: axisTop - 2,
						}}
					>
						<span className="wk-pl-dragtext">
							{drag.kind === "skip" ? "Skip " : ""}
							{formatMHz(snapHz(dragLo))}–{formatMHz(snapHz(dragHi))}
						</span>
					</div>
				)}
				<div className="wk-pl-axis" style={{ top: axisTop }} aria-hidden="true">
					{axis.map(t => (
						<span key={t.hz} className="wk-pl-tick" style={{ left: t.x }}>
							<span className="wk-pl-ticktext">{t.text}</span>
						</span>
					))}
				</div>
			</div>
		</div>
	)
}

function edges(b: { startHz: number; endHz: number }): string {
	return `${formatMHz(b.startHz)}–${formatMHz(b.endHz)}`
}
