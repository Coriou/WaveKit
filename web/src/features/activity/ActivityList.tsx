// The Activity list: windowed rows (only what is on screen is mounted, heights measured once), grouped
// by minute, arrows to move, Enter to open. Arrivals are held while the list is scrolled away from the
// top and announced by the "N new" pill, so rows never jump under the pointer. In the Cards layout each event is
// its decoded message card (Messages board, feed variant), windowed the same way.
import type { ActivitySummary } from "@wavekit/api-types"
import { WaveKitIcon } from "@wavekit/brand/react"
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react"

import type { ActivityFeed } from "../../data/activity-feed.ts"
import { compareSeq } from "../../data/activity-feed.ts"
import { useReadOnly } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { useNow } from "../hooks.ts"
import { MessageCard } from "../messages/MessageCard.tsx"
import { activityLayout } from "./layout.ts"
import type { ListEntry } from "./rows.ts"
import {
	estimateCardHeight,
	estimateHeight,
	listEntries,
	rowView,
	timeText,
} from "./rows.ts"
import { prefixOffsets, virtualWindow } from "./virtual.ts"

const HOLD_PX = 8
const MORE_PX = 600

export interface ActivityListProps {
	feed: ActivityFeed
	onOpen: (eventId: string) => void
	/** The row the detail shows (kept highlighted when coming back). */
	openId: string | null
	label: string
	/** Extra class on the wrapper (a pane column drops the drawer's well margins). */
	className?: string
	/** `data-act-col` on the scroller: ← / → move focus across the pane's columns and the drawer's list. */
	column?: string
	ref?: Ref<HTMLDivElement>
}

export function ActivityList({
	feed,
	onOpen,
	openId,
	label,
	className,
	column,
	ref,
}: ActivityListProps) {
	const items = useStore(feed, s => s.items)
	const pending = useStore(feed, s => s.pending.length)
	const status = useStore(feed, s => s.status)
	const more = useStore(feed, s => s.nextPageToken !== null)
	const loadingMore = useStore(feed, s => s.loadingMore)
	const now = useNow(true, 30_000)
	const scroller = useRef<HTMLDivElement | null>(null)
	const heights = useRef(new Map<string, number>())
	const [version, setVersion] = useState(0)
	const [scrollTop, setScrollTop] = useState(0)
	const [viewport, setViewport] = useState(600)
	const [cursor, setCursor] = useState<string | null>(null)
	const seen = useRef<string | null>(null)
	const cards = useStore(activityLayout, s => s.layout === "cards")
	const readOnly = useReadOnly()
	const estimate = cards ? estimateCardHeight : estimateHeight

	// Rows and cards measure differently: a layout switch starts from fresh guesses, at the top.
	const lastLayout = useRef(cards)
	if (lastLayout.current !== cards) {
		lastLayout.current = cards
		heights.current = new Map()
	}
	useEffect(() => {
		if (scroller.current) scroller.current.scrollTop = 0
		setScrollTop(0)
	}, [cards])

	const entries = useMemo(() => listEntries(items, now), [items, now])
	const offsets = useMemo(() => {
		void version
		return prefixOffsets(
			entries.map(e => heights.current.get(e.key) ?? estimate(e)),
		)
	}, [entries, version, estimate])
	const win = virtualWindow(offsets, scrollTop, viewport)

	// Rows that arrive live (newer than the newest row so far) flash once; older pages do not.
	const fresh = useMemo(() => {
		const out = new Set<string>()
		const newest = items[0]?.commitSeq ?? null
		const before = status === "live" ? seen.current : null
		if (before === null || newest === null) return out
		for (const i of items) {
			if (compareSeq(i.commitSeq, before) <= 0) break
			out.add(i.eventId)
		}
		return out
	}, [items, status])
	useEffect(() => {
		seen.current = status === "live" ? (items[0]?.commitSeq ?? null) : null
	}, [items, status])

	// One ResizeObserver for every mounted row; measurements land in one state bump per frame.
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

	// A new search starts at the top.
	const query = useStore(feed, s => s.query)
	useEffect(() => {
		if (scroller.current) scroller.current.scrollTop = 0
		setScrollTop(0)
		feed.setHolding(false)
	}, [query, feed])

	const onScroll = useCallback(() => {
		const el = scroller.current
		if (!el) return
		setScrollTop(el.scrollTop)
		feed.setHolding(el.scrollTop > HOLD_PX)
		if (el.scrollHeight - (el.scrollTop + el.clientHeight) < MORE_PX)
			void feed.loadMore()
	}, [feed])

	const toTop = useCallback(() => {
		feed.release()
		if (scroller.current) scroller.current.scrollTop = 0
		setScrollTop(0)
		feed.setHolding(false)
	}, [feed])

	const rowIndex = useMemo(() => {
		const m = new Map<string, number>()
		entries.forEach((e, i) => {
			if (e.type === "row") m.set(e.key, i)
		})
		return m
	}, [entries])

	const reveal = useCallback(
		(index: number) => {
			const el = scroller.current
			if (!el) return
			const top = offsets[index] ?? 0
			const bottom = offsets[index + 1] ?? top
			if (top < el.scrollTop) el.scrollTop = Math.max(0, top - 28)
			else if (bottom > el.scrollTop + el.clientHeight)
				el.scrollTop = bottom - el.clientHeight
		},
		[offsets],
	)

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (
			(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
			column !== undefined &&
			e.target === e.currentTarget
		) {
			e.preventDefault()
			focusSideways(e.currentTarget, e.key === "ArrowRight" ? 1 : -1)
			return
		}
		if (
			e.key !== "ArrowDown" &&
			e.key !== "ArrowUp" &&
			e.key !== "Enter" &&
			e.key !== "Home" &&
			e.key !== "End"
		)
			return
		// A card holds its own buttons: Enter on one of them is that button's, not "open".
		if (e.key === "Enter" && cards && e.target !== e.currentTarget) return
		const rows = entries.filter(
			(x): x is Extract<ListEntry, { type: "row" }> => x.type === "row",
		)
		if (rows.length === 0) return
		e.preventDefault()
		const at = cursor === null ? -1 : rows.findIndex(r => r.key === cursor)
		if (e.key === "Enter") {
			if (at >= 0) onOpen(rows[at]?.key ?? "")
			return
		}
		const next =
			e.key === "Home"
				? 0
				: e.key === "End"
					? rows.length - 1
					: e.key === "ArrowDown"
						? Math.min(rows.length - 1, at + 1)
						: Math.max(0, at - 1)
		const key = rows[next]?.key
		if (key === undefined) return
		setCursor(key)
		const index = rowIndex.get(key)
		if (index !== undefined) reveal(index)
	}

	const setRefs = (el: HTMLDivElement | null) => {
		scroller.current = el
		if (typeof ref === "function") ref(el)
		else if (ref) ref.current = el
	}

	return (
		<div className={className ? `wka-listwrap ${className}` : "wka-listwrap"}>
			{pending > 0 && (
				<button type="button" className="wka-newpill" onClick={toTop}>
					↑ {pending} new
				</button>
			)}
			<div
				ref={setRefs}
				className="wka-list wk-scroll"
				data-layout={cards ? "cards" : undefined}
				role="list"
				aria-label={label}
				tabIndex={0}
				data-act-col={column}
				onScroll={onScroll}
				onKeyDown={onKeyDown}
			>
				<div style={{ height: win.total, position: "relative" }}>
					<div
						className="wka-window"
						style={{ transform: `translateY(${win.offset}px)` }}
					>
						{entries.slice(win.start, win.end).map(e =>
							e.type === "group" ? (
								<div
									key={e.key}
									data-key={e.key}
									ref={measure}
									className="wka-group"
									role="presentation"
								>
									{e.label}
								</div>
							) : cards ? (
								<ActivityCard
									key={e.key}
									item={e.item}
									measure={measure}
									cursor={cursor === e.key}
									current={openId === e.key}
									fresh={fresh.has(e.key)}
									readOnly={readOnly}
									onOpen={onOpen}
								/>
							) : (
								<ActivityRow
									key={e.key}
									item={e.item}
									measure={measure}
									cursor={cursor === e.key}
									current={openId === e.key}
									fresh={fresh.has(e.key)}
									onOpen={onOpen}
								/>
							),
						)}
					</div>
				</div>
				{loadingMore && <p className="wka-foot">Loading older activity…</p>}
				{!more && items.length > 0 && status === "live" && (
					<p className="wka-foot">That is everything kept for this search.</p>
				)}
			</div>
		</div>
	)
}

/** Moves focus to the next list left or right: the pane's columns in order, then the drawer's list. */
export function focusSideways(from: HTMLElement, by: -1 | 1): void {
	const lists = [...document.querySelectorAll<HTMLElement>("[data-act-col]")]
	const order = [
		...lists.filter(l => l.dataset["actCol"] !== "drawer"),
		...lists.filter(l => l.dataset["actCol"] === "drawer"),
	]
	const next = order[order.indexOf(from) + by]
	if (!next) return
	next.focus({ preventScroll: true })
	next.scrollIntoView?.({ block: "nearest", inline: "nearest" })
}

interface RowProps {
	item: ActivitySummary
	measure: (el: HTMLElement | null) => void
	cursor: boolean
	current: boolean
	fresh: boolean
	onOpen: (eventId: string) => void
}

export const ActivityRow = memo(function ActivityRow({
	item,
	measure,
	cursor,
	current,
	fresh,
	onOpen,
}: RowProps) {
	const v = rowView(item)
	return (
		<div
			role="listitem"
			data-key={item.eventId}
			ref={measure}
			className="wka-item"
		>
			<button
				type="button"
				className="wk-row wka-row"
				data-notice={v.notice || undefined}
				data-kb-cursor={cursor || undefined}
				data-fresh={fresh || undefined}
				aria-current={current || undefined}
				onClick={() => onOpen(item.eventId)}
			>
				<span className="wk-tile" aria-hidden="true">
					{v.icon ? (
						<WaveKitIcon name={v.icon} size={16} />
					) : (
						<span className="wka-tile-dot" />
					)}
				</span>
				<span className="wka-main">
					<span className="wka-line1">
						<span className="wka-title">{v.title}</span>
						<time className="wka-time" dateTime={item.producedAt}>
							{timeText(item.producedAt)}
						</time>
					</span>
					{v.subtitle && <span className="wka-sub">{v.subtitle}</span>}
					{v.message !== null && (
						<span className="wka-msg">
							{item.category === "voice" ? `“${v.message}”` : v.message}
						</span>
					)}
					{v.readings !== null && (
						<span className="wka-read">{v.readings}</span>
					)}
				</span>
			</button>
		</div>
	)
})

export const ActivityCard = memo(function ActivityCard({
	item,
	measure,
	cursor,
	current,
	fresh,
	readOnly,
	onOpen,
}: RowProps & { readOnly: boolean }) {
	return (
		<div
			role="listitem"
			data-key={item.eventId}
			ref={measure}
			className="wka-item wka-carditem"
			data-kb-cursor={cursor || undefined}
			data-fresh={fresh || undefined}
			aria-current={current || undefined}
		>
			<MessageCard
				item={item}
				readOnly={readOnly}
				onOpen={() => onOpen(item.eventId)}
			/>
		</div>
	)
})
