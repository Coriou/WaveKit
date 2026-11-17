import "./messages.css"

import type { ActivitySummary } from "@wavekit/api-types"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import type { ActivityFeed } from "../../data/activity-feed.ts"
import { useStore } from "../../data/index.ts"
import { ActivityDisc } from "../activity/ActivityPlayback.tsx"
import { foldedOf } from "../activity/fold.ts"
import {
	activityListKey,
	activityQueue,
	recordingOf,
	recordingTitleOf,
} from "../activity/playback.ts"
import { estimateCardHeight } from "../activity/rows.ts"
import type { QueueRef } from "../playback/service.ts"
import { MessageCard } from "./MessageCard.tsx"
import { GALLERY_STEP, dealStable, galleryColumns } from "./gallery.ts"

// each live batch deals every card shown again: guess a card's height once
const heights = new WeakMap<ActivitySummary, number>()
const height = (item: ActivitySummary) => {
	let h = heights.get(item)
	if (h === undefined) {
		h = estimateCardHeight({ type: "row", key: item.eventId, item })
		heights.set(item, h)
	}
	return h
}
const keyOf = (item: ActivitySummary) => item.eventId

export interface CardsBoardProps {
	feed: ActivityFeed
	label: string
	onOpen: (item: ActivitySummary) => void
}

// The Activity drawer in Cards layout, expanded: the feed's decoded message cards in as many columns as fit
// (gallery.ts: 340 px columns, up to three), for wide reading of pages and packets. The drawer above it keeps the
// search, the categories, Live / Paused and the notices; Details opens the event in the drawer.
export function CardsBoard({ feed, label, onOpen }: CardsBoardProps) {
	const items = useStore(feed, s => s.items)
	const more = useStore(feed, s => s.nextPageToken !== null)
	const loadingMore = useStore(feed, s => s.loadingMore)
	const query = useStore(feed, s => s.query)
	const readOnly = useReadOnly()
	const { playback } = useServices()

	// the cards with audio, as the drawer's list folds them: the queue a disc here plays from (the drawer's
	// own list key, so a play started here or in the list keeps refreshing from the same feed)
	const queueList = activityListKey(feed)
	const queue = useMemo(
		() => activityQueue(foldedOf(items, feed), queueList),
		[items, feed, queueList],
	)
	const queueNow = useRef(queue)
	queueNow.current = queue
	const readQueue = useCallback(() => queueNow.current, [])
	useEffect(() => {
		playback.setQueue("activity", queue.ids, queue.titles, queueList)
	}, [playback, queue, queueList])

	const scroller = useRef<HTMLDivElement>(null)
	const end = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(1080)
	const [shown, setShown] = useState(GALLERY_STEP)

	// the cards' width: the end marker spans the content box
	useEffect(() => {
		const el = end.current
		if (!el) return
		const measure = () => setWidth(el.clientWidth)
		measure()
		if (typeof ResizeObserver === "undefined") return
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// a new search starts again from the top
	useEffect(() => {
		setShown(GALLERY_STEP)
		if (scroller.current) scroller.current.scrollTop = 0
	}, [query])

	// the end in view: draw more cards, then fetch an older page once every card is drawn
	const wantMore = useRef(() => {})
	wantMore.current = () => {
		if (shown < items.length) setShown(n => n + GALLERY_STEP)
		else if (more && !loadingMore) void feed.loadMore()
	}
	useEffect(() => {
		const el = end.current
		if (!el || typeof IntersectionObserver === "undefined") return
		const io = new IntersectionObserver(
			e => {
				if (e.some(x => x.isIntersecting)) wantMore.current()
			},
			{ root: scroller.current, rootMargin: "600px 0px" },
		)
		io.observe(el)
		return () => io.disconnect()
	}, [])

	// scrolled down, live cards wait above instead of pushing the board around
	const onScroll = () =>
		feed.setHolding((scroller.current?.scrollTop ?? 0) > 40)
	useEffect(() => () => feed.setHolding(false), [feed])

	const cols = galleryColumns(width)
	// cards keep their column while live ones arrive on top; a new search or column count deals again
	const placed = useRef<{
		cols: number
		query: unknown
		at: ReadonlyMap<string, number>
	} | null>(null)
	const columns = useMemo(() => {
		const p = placed.current
		const keep = p?.cols === cols && p.query === query
		const dealt = dealStable(
			items.slice(0, shown),
			cols,
			height,
			keyOf,
			keep ? p.at : null,
		)
		placed.current = { cols, query, at: dealt.placed }
		return dealt.columns
	}, [items, shown, cols, query])

	return (
		<div
			ref={scroller}
			className="wkg wk-scroll"
			data-cols={cols}
			onScroll={onScroll}
		>
			<div
				className="wkg-grid"
				role="list"
				aria-label={label}
				style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
			>
				{columns.map((col, i) => (
					<div key={i} className="wkg-col">
						{col.map(item => (
							<BoardCard
								key={item.eventId}
								item={item}
								readOnly={readOnly}
								onOpen={onOpen}
								queue={readQueue}
							/>
						))}
					</div>
				))}
			</div>
			<div ref={end} className="wkg-end" aria-hidden="true" />
			{loadingMore && <p className="wka-foot">Loading older events…</p>}
		</div>
	)
}

// Memoised: a live batch re-renders the board, not the cards already shown. A card with audio carries the
// play disc under it (as the drawer's cards do), marked while its recording is the one playing.
export const BoardCard = memo(function BoardCard({
	item,
	readOnly,
	onOpen,
	queue,
}: {
	item: ActivitySummary
	readOnly: boolean
	onOpen: (item: ActivitySummary) => void
	queue: () => QueueRef
}) {
	// a card folded into a stack in the list is not in the list's queue: it plays on its own
	const own = useCallback(() => boardQueue(queue(), item), [queue, item])
	return (
		<div role="listitem">
			<MessageCard
				item={item}
				readOnly={readOnly}
				onOpen={() => onOpen(item)}
			/>
			{item.recording !== undefined && (
				<div className="wka-cardstack">
					<ActivityDisc item={item} queue={own} inline />
				</div>
			)}
		</div>
	)
})

/** The queue a board card's disc plays from: the list's, or the card's recording alone when the list folds it away. */
export function boardQueue(q: QueueRef, item: ActivitySummary): QueueRef {
	const rec = recordingOf(item)
	if (rec === null || q.ids.includes(rec.id)) return q
	const own: QueueRef = {
		source: q.source,
		ids: [rec.id],
		titles: { [rec.id]: recordingTitleOf(item) },
	}
	if (q.list !== undefined) own.list = q.list
	return own
}
