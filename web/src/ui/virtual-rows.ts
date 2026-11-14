// The list panels' one virtual list (Activity, Recordings, the Scanner drawer's lists): entries keyed by
// id, heights measured once by one ResizeObserver (one state bump per frame, the estimate until then),
// only the entries in the viewport and `overscan` pixels around it mounted (plus any the caller keeps,
// such as the focused row), and a call when the scroll comes near the end (load the next page).
//
// Offsets live in a Fenwick tree: a measurement updates it in O(log n), never a rebuild of every offset,
// and a row unmounting stops being observed. A row above the viewport that changes height moves the
// scroll position by as much, so the rows in view never jump. The scroll position can be kept across an
// unmount (a panel closed and opened again) under a key.
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

/** Distance from the end (px) at which the next page is asked for. */
export const NEAR_END_PX = 600

/** Prefix sums of entry heights, updated one entry at a time (a Fenwick tree). */
export class OffsetTree {
	readonly size: number
	private readonly tree: Float64Array
	private readonly heights: Float64Array

	constructor(heights: ArrayLike<number>) {
		const n = heights.length
		this.size = n
		this.heights = Float64Array.from(heights)
		this.tree = new Float64Array(n + 1)
		for (let i = 1; i <= n; i++) {
			this.tree[i] = (this.tree[i] ?? 0) + (this.heights[i - 1] ?? 0)
			const parent = i + (i & -i)
			if (parent <= n)
				this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[i] ?? 0)
		}
	}

	height(i: number): number {
		return this.heights[i] ?? 0
	}

	/** Sets entry `i`'s height; returns the change. */
	set(i: number, h: number): number {
		if (i < 0 || i >= this.size) return 0
		const delta = h - (this.heights[i] ?? 0)
		if (delta === 0) return 0
		this.heights[i] = h
		for (let j = i + 1; j <= this.size; j += j & -j)
			this.tree[j] = (this.tree[j] ?? 0) + delta
		return delta
	}

	/** Top of entry `i` (the sum of the heights before it); `top(size)` is the total. */
	top(i: number): number {
		let sum = 0
		for (let j = Math.min(i, this.size); j > 0; j -= j & -j)
			sum += this.tree[j] ?? 0
		return sum
	}

	get total(): number {
		return this.top(this.size)
	}

	/** The last entry whose top is at or above `y` (0 for an empty list). */
	indexAt(y: number): number {
		if (this.size === 0) return 0
		let pos = 0
		let rem = y
		let step = 1
		while (step * 2 <= this.size) step *= 2
		for (; step > 0; step >>= 1) {
			const next = pos + step
			if (next <= this.size && (this.tree[next] ?? 0) <= rem) {
				pos = next
				rem -= this.tree[next] ?? 0
			}
		}
		return Math.min(pos, this.size - 1)
	}

	/** Entries to mount for a viewport, with `overscan` pixels above and below. */
	window(scrollTop: number, viewport: number, overscan = 400): VirtualWindow {
		const total = this.total
		if (this.size === 0) return { start: 0, end: 0, offset: 0, total }
		const start = this.indexAt(Math.max(0, scrollTop - overscan))
		const end = Math.min(
			this.size,
			this.indexAt(scrollTop + viewport + overscan) + 1,
		)
		return { start, end, offset: this.top(start), total }
	}
}

/** Saved scroll positions by key, across unmounts (a panel closed and opened again). */
const savedScroll = new Map<string, number>()

export interface VirtualRows {
	scroller: RefObject<HTMLDivElement | null>
	/** Ref callback for every mounted entry (it needs `data-key`); its cleanup stops observing it. */
	measure: (el: HTMLElement | null) => (() => void) | undefined
	win: VirtualWindow
	/** Kept entries outside the window (`keep`), with their top: render them absolutely there. */
	kept: readonly { index: number; top: number }[]
	/** Top of entry `index`. */
	topOf: (index: number) => number
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
	/** Entries mounted wherever the scroll is (the cursor row, the focused row): focus never drops. */
	keep?: readonly number[]
	/** Keeps the scroll position under this key across an unmount and puts it back on the next mount. */
	restoreKey?: string | undefined
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

	// rebuilt when the entries change (O(n)); a measurement updates it in place (O(log n))
	const tree = useMemo(() => {
		void resetKey
		const h = new Float64Array(keys.length)
		for (let i = 0; i < keys.length; i++)
			h[i] = heights.current.get(keys[i] ?? "") ?? latest.current.estimate(i)
		return new OffsetTree(h)
		// the estimate is read through the ref; keys and a reset decide
	}, [keys, resetKey])
	const keyIndex = useMemo(() => {
		const m = new Map<string, number>()
		keys.forEach((k, i) => m.set(k, i))
		return m
	}, [keys])
	const live = useRef({ tree, keyIndex })
	live.current = { tree, keyIndex }

	void version
	const win = tree.window(scrollTop, viewport, options.overscan)
	const keepList = options.keep ?? []
	const kept: { index: number; top: number }[] = []
	for (const index of keepList)
		if (
			index >= 0 &&
			index < tree.size &&
			(index < win.start || index >= win.end) &&
			!kept.some(k => k.index === index)
		)
			kept.push({ index, top: tree.top(index) })

	const observer = useMemo(() => {
		if (typeof ResizeObserver === "undefined") return null
		let frame = 0
		let shift = 0
		return new ResizeObserver(records => {
			const { tree: t, keyIndex: ix } = live.current
			const el = scroller.current
			const top = el?.scrollTop ?? 0
			let changed = false
			for (const r of records) {
				const key = (r.target as HTMLElement).dataset["key"]
				if (!key) continue
				const h = Math.round(
					r.borderBoxSize[0]?.blockSize ?? r.contentRect.height,
				)
				if (!(h > 0) || heights.current.get(key) === h) continue
				heights.current.set(key, h)
				changed = true
				const i = ix.get(key)
				if (i === undefined) continue
				const above = t.top(i) < top
				const delta = t.set(i, h)
				// an entry above the viewport grew or shrank: the rows in view stay where they are
				if (above && top > 0) shift += delta
			}
			if (changed && frame === 0)
				frame = requestAnimationFrame(() => {
					frame = 0
					const s = scroller.current
					if (s && shift !== 0) s.scrollTop = Math.max(0, s.scrollTop + shift)
					shift = 0
					setVersion(v => v + 1)
				})
		})
	}, [])
	useEffect(() => () => observer?.disconnect(), [observer])

	const measure = useCallback(
		(el: HTMLElement | null) => {
			if (!el || !observer) return undefined
			observer.observe(el)
			return () => observer.unobserve(el)
		},
		[observer],
	)

	// The scroller can mount later than the hook (a panel shows its skeleton first) or be replaced (an
	// empty state in between): follow whichever element the ref holds after each commit, and put a saved
	// scroll position back on the first one.
	const watched = useRef<{
		el: HTMLDivElement
		ro: ResizeObserver | null
	} | null>(null)
	useLayoutEffect(() => {
		const el = scroller.current
		if (watched.current?.el === el) return
		watched.current?.ro?.disconnect()
		watched.current = null
		if (!el) return
		setViewport(el.clientHeight || 600)
		const key = latest.current.restoreKey
		const saved = key === undefined ? undefined : savedScroll.get(key)
		if (saved !== undefined && saved > 0) {
			el.scrollTop = saved
			setScrollTop(el.scrollTop)
		}
		const ro =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => setViewport(el.clientHeight || 600))
		ro?.observe(el)
		watched.current = { el, ro }
	})
	// the position under the key it was scrolled with, kept for the next mount
	const lastTop = useRef<{ key: string | undefined; top: number }>({
		key: undefined,
		top: 0,
	})
	useEffect(
		() => () => {
			watched.current?.ro?.disconnect()
			watched.current = null
			const { key, top } = lastTop.current
			if (key !== undefined) savedScroll.set(key, top)
		},
		[],
	)

	const onScroll = useCallback(() => {
		const el = scroller.current
		if (!el) return
		setScrollTop(el.scrollTop)
		lastTop.current = { key: latest.current.restoreKey, top: el.scrollTop }
		latest.current.onScroll?.(el)
		if (el.scrollHeight - (el.scrollTop + el.clientHeight) < NEAR_END_PX)
			latest.current.onNearEnd?.()
	}, [])

	const topOf = useCallback((index: number) => tree.top(index), [tree])

	const reveal = useCallback((index: number) => {
		const el = scroller.current
		if (!el) return
		const t = live.current.tree
		const margin = latest.current.revealMargin ?? 34
		const top = t.top(index)
		const bottom = top + t.height(index)
		if (top < el.scrollTop) el.scrollTop = Math.max(0, top - margin)
		else if (bottom > el.scrollTop + el.clientHeight)
			el.scrollTop = Math.min(top - margin, bottom - el.clientHeight)
	}, [])

	const toTop = useCallback(() => {
		if (scroller.current) scroller.current.scrollTop = 0
		setScrollTop(0)
		lastTop.current = { key: latest.current.restoreKey, top: 0 }
	}, [])

	return {
		scroller,
		measure,
		win,
		kept,
		topOf,
		scrollTop,
		viewport,
		onScroll,
		reveal,
		toTop,
	}
}
