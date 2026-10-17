// The open drawer's resize grip (Immersive board): a separator on the drawer's left edge (on the seam when a pane is
// attached). Drag to resize between 360 and 640 px, arrows step 16 px (Shift 64), Home and End go to the ends,
// double-click resets; the width is remembered per drawer (src/shell/drawer-width.ts). While dragging, a full-window
// layer keeps the col-resize cursor and stops the plot from reading the pointer.
import { useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent } from "react"

import { DR_MIN } from "./layout.ts"
import type { DrawerWidthStore } from "./drawer-width.ts"
import type { DrawerId } from "./store.ts"

export interface DrawerGripProps {
	id: DrawerId
	/** The drawer's name, for "Resize Activity". */
	name: string
	store: DrawerWidthStore
	/** The width the drawer got this render, and the most the grip may give it. */
	width: number
	maxW: number
	/** The drawer's left edge from the shell's left, and its top and bottom insets. */
	x: number
	top: number
	bottom: number
	onResizing: (on: boolean) => void
}

const KEY_STEP: Readonly<Record<string, (w: number, step: number) => number>> =
	{
		ArrowLeft: (w, step) => w + step,
		ArrowRight: (w, step) => w - step,
		Home: () => Number.POSITIVE_INFINITY,
		End: () => DR_MIN,
	}

export function DrawerGrip({
	id,
	name,
	store,
	width,
	maxW,
	x,
	top,
	bottom,
	onResizing,
}: DrawerGripProps) {
	const from = useRef<{ px: number; w: number; pointer: number } | null>(null)
	const [on, setOn] = useState(false)

	const stop = (el: HTMLElement) => {
		const f = from.current
		if (!f) return
		from.current = null
		if (el.hasPointerCapture(f.pointer)) el.releasePointerCapture(f.pointer)
		setOn(false)
		onResizing(false)
	}

	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return
		e.preventDefault()
		e.currentTarget.focus({ preventScroll: true })
		e.currentTarget.setPointerCapture(e.pointerId)
		from.current = { px: e.clientX, w: width, pointer: e.pointerId }
		setOn(true)
		onResizing(true)
	}
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		const f = from.current
		if (!f) return
		store.setWidth(id, f.w - (e.clientX - f.px), maxW)
	}
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = KEY_STEP[e.key]
		if (!step) return
		e.preventDefault()
		e.stopPropagation()
		store.setWidth(id, step(width, e.shiftKey ? 64 : 16), maxW)
	}

	return (
		<>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label={`Resize ${name}`}
				aria-valuemin={DR_MIN}
				aria-valuemax={maxW}
				aria-valuenow={width}
				aria-valuetext={`${width} pixels wide`}
				tabIndex={0}
				title="Drag to resize · double-click resets"
				className="wk-shell-grip"
				data-on={on || undefined}
				style={{ left: x - 10, top: top + 16, bottom: bottom + 16 }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={e => stop(e.currentTarget)}
				onPointerCancel={e => stop(e.currentTarget)}
				onLostPointerCapture={e => stop(e.currentTarget)}
				onDoubleClick={() => store.reset(id)}
				onKeyDown={onKeyDown}
			>
				<span className="wk-shell-grip-bar" aria-hidden="true" />
			</div>
			{on && <div className="wk-shell-grip-layer" aria-hidden="true" />}
		</>
	)
}
