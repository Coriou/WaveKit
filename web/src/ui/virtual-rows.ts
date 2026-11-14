// The list panels' one virtual list (Activity, Recordings, the Scanner drawer's lists): entries keyed by
// id, heights measured once by one ResizeObserver (one state bump per frame, the estimate until then),
// only the entries in the viewport and `overscan` pixels around it mounted, and a call when the
// scroll comes near the end (load the next page).
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import type { RefObject } from "react"

import type { VirtualWindow } from "./virtual.ts"
import { prefixOffsets, virtualWindow } from "./virtual.ts"

/** Distance from the end (px) at which the next page is asked for. */
export const NEAR_END_PX = 600

export interface VirtualRows {
	scroller: RefObject<HTMLDivElement | null>
	/** Ref callback for every mounted entry (it needs `data-key`). */
	measure: (el: HTMLElement | null) => void
	win: VirtualWindow
	offsets: Float64Array
	scrollTop: number
	viewport: number
	onScroll: () => void
	/** Scrolls entry `index` into view, `margin` px clear of the top edge. */
	reveal: (index: number) => void
	/** Back to the top (a new search). */
	toTop: () => void
}

export interface VirtualRowsOptions {
	/** One key per entry, in order (a measured height belongs to its key). */
	keys: readonly string[]
	/** The height of entry `index` until it is measured. */
	estimate: (index: number) => number
	/** The scroll came within NEAR_END_PX of the end. */
	onNearEnd?: (() => void) | undefined
	/** Every scroll, with the scroller (hold arrivals away from the top). */
	onScroll?: ((el: HTMLDivElement) => void) | undefined
	/** A change forgets every measured height (a layout switch measures differently). */
	resetKey?: unknown
	/** Space kept above a revealed entry (a sticky label). Default 34 px. */
	revealMargin?: number
	/** Pixels mounted above and below the viewport. Default 400. */
	overscan?: number
}

export function useVirtualRows(options: VirtualRowsOptions): VirtualRows {
	const { keys, resetKey } = options
	const scroller = useRef<HTMLDivElement | null>(null)
	const heights = useRef(new Map<string, number>())
	const [version, setVersion] = useState(0)
	const [scrollTop, setScrollTop] = useState(0)
	const [viewport, setViewport] = useState(600)
	const latest = useRef(options)
	latest.current = options

	const lastReset = useRef(resetKey)
	if (!Object.is(lastReset.current, resetKey)) {
		lastReset.current = resetKey
		heights.current = new Map()
	}

	const offsets = useMemo(() => {
		void version
		void resetKey
		return prefixOffsets(
			keys.map((k, i) => heights.current.get(k) ?? latest.current.estimate(i)),
		)
		// the estimate is read through the ref; keys, measurements and a reset decide
	}, [keys, version, resetKey])
	const win = virtualWindow(offsets, scrollTop, viewport, options.overscan)

	const observer = useMemo(() => {
		if (typeof ResizeObserver === "undefined") return null
		let frame = 0
		return new ResizeObserver(records => {
			let changed = false
			for (const r of records) {
				const key = (r.target as HTMLElement).dataset["key"]
				if (!key) continue
				const h = Math.round(
					r.borderBoxSize[0]?.blockSize ?? r.contentRect.height,
				)
				if (h > 0 && heights.current.get(key) !== h) {
					heights.current.set(key, h)
					changed = true
				}
			}
			if (changed && frame === 0)
				frame = requestAnimationFrame(() => {
					frame = 0
					setVersion(v => v + 1)
				})
		})
	}, [])
	useEffect(() => () => observer?.disconnect(), [observer])

	const measure = useCallback(
		(el: HTMLElement | null) => {
			if (el && observer) observer.observe(el)
		},
		[observer],
	)

	useLayoutEffect(() => {
		const el = scroller.current
		if (!el) return
		setViewport(el.clientHeight || 600)
		if (typeof ResizeObserver === "undefined") return
		const ro = new ResizeObserver(() => setViewport(el.clientHeight || 600))
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	const onScroll = useCallback(() => {
		const el = scroller.current
		if (!el) return
		setScrollTop(el.scrollTop)
		latest.current.onScroll?.(el)
		if (el.scrollHeight - (el.scrollTop + el.clientHeight) < NEAR_END_PX)
			latest.current.onNearEnd?.()
	}, [])

	const reveal = useCallback(
		(index: number) => {
			const el = scroller.current
			if (!el) return
			const margin = latest.current.revealMargin ?? 34
			const top = offsets[index] ?? 0
			const bottom = offsets[index + 1] ?? top
			if (top < el.scrollTop) el.scrollTop = Math.max(0, top - margin)
			else if (bottom > el.scrollTop + el.clientHeight)
				el.scrollTop = Math.min(top - margin, bottom - el.clientHeight)
		},
		[offsets],
	)

	const toTop = useCallback(() => {
		if (scroller.current) scroller.current.scrollTop = 0
		setScrollTop(0)
	}, [])

	return {
		scroller,
		measure,
		win,
		offsets,
		scrollTop,
		viewport,
		onScroll,
		reveal,
		toTop,
	}
}
