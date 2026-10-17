// The windowing of Activity's list (virtual.ts) as a hook for the Scanner drawer's lists: entries keyed by
// id, heights measured once by one ResizeObserver (one state bump per frame), only visible rows mounted.
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import type { RefObject } from "react"

import type { VirtualWindow } from "../../activity/virtual.ts"
import { prefixOffsets, virtualWindow } from "../../activity/virtual.ts"

export interface VirtualList {
	scroller: RefObject<HTMLDivElement | null>
	/** Ref callback for every mounted entry (it needs `data-key`). */
	measure: (el: HTMLElement | null) => void
	win: VirtualWindow
	offsets: Float64Array
	onScroll: () => void
	/** Scrolls entry `index` into view. */
	reveal: (index: number) => void
}

export function useVirtual(
	keys: readonly string[],
	estimate: (index: number) => number,
	onNearEnd?: () => void,
): VirtualList {
	const scroller = useRef<HTMLDivElement | null>(null)
	const heights = useRef(new Map<string, number>())
	const [version, setVersion] = useState(0)
	const [scrollTop, setScrollTop] = useState(0)
	const [viewport, setViewport] = useState(600)
	const estimateRef = useRef(estimate)
	estimateRef.current = estimate

	const offsets = useMemo(() => {
		void version
		return prefixOffsets(
			keys.map((k, i) => heights.current.get(k) ?? estimateRef.current(i)),
		)
		// estimate is read through the ref; keys and measurements decide
	}, [keys, version])
	const win = virtualWindow(offsets, scrollTop, viewport)

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

	const nearEnd = useRef(onNearEnd)
	nearEnd.current = onNearEnd
	const onScroll = useCallback(() => {
		const el = scroller.current
		if (!el) return
		setScrollTop(el.scrollTop)
		if (el.scrollHeight - (el.scrollTop + el.clientHeight) < 600)
			nearEnd.current?.()
	}, [])

	const reveal = useCallback(
		(index: number) => {
			const el = scroller.current
			if (!el) return
			const top = offsets[index] ?? 0
			const bottom = offsets[index + 1] ?? top
			if (top < el.scrollTop) el.scrollTop = Math.max(0, top - 34)
			else if (bottom > el.scrollTop + el.clientHeight)
				el.scrollTop = Math.min(top - 34, bottom - el.clientHeight)
		},
		[offsets],
	)

	return { scroller, measure, win, offsets, onScroll, reveal }
}
