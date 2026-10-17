import "../activity/activity.css"
import "./messages.css"

import type { ActivitySummary } from "@wavekit/api-types"
import { WaveKitIcon } from "@wavekit/brand/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { shellStore } from "../../shell/store.ts"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { estimateCardHeight } from "../activity/rows.ts"
import { CATEGORY_CHIPS } from "../activity/search.ts"
import { MessageCard } from "./MessageCard.tsx"
import { GALLERY_STEP, dealStable, galleryColumns } from "./gallery.ts"

export interface GalleryInsets {
	/** Bottom of the top row (Tuner, Receiver). */
	top: number
	/** Clearance on the right: the Receiver's gutter, plus a full-height drawer. */
	right: number
	/** Height of the bottom row (Listen, dock). */
	bottom: number
}

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

// The Messages view (Messages board, gallery variant): Activity's live feed as decoded message cards in up to three
// columns, under the islands. It shares Activity's search, category and Live / Paused; Details opens the event in the
// Activity drawer.
export default function MessagesGallery({ insets }: { insets: GalleryInsets }) {
	const { activity } = useServices()
	useEffect(() => activity.attach(), [activity])
	const feed = activity.feed
	const items = useStore(feed, s => s.items)
	const status = useStore(feed, s => s.status)
	const available = useStore(feed, s => s.available)
	const paused = useStore(feed, s => s.paused)
	const pending = useStore(feed, s => s.pending.length)
	const more = useStore(feed, s => s.nextPageToken !== null)
	const loadingMore = useStore(feed, s => s.loadingMore)
	const chip = useStore(activity, s => s.chip)
	const tokens = useStore(activity, s => s.tokens)
	const counts = useStore(activity, s => s.counts)
	const readOnly = useReadOnly()

	const scroller = useRef<HTMLDivElement>(null)
	const end = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(1080)
	const [shown, setShown] = useState(GALLERY_STEP)

	useEffect(() => {
		const el = scroller.current
		if (!el) return
		const measure = () => setWidth(el.clientWidth)
		measure()
		if (typeof ResizeObserver === "undefined") return
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// A new search starts again from the top.
	useEffect(() => {
		setShown(GALLERY_STEP)
		if (scroller.current) scroller.current.scrollTop = 0
	}, [chip, tokens])

	// The end of the gallery in view: draw more cards, then fetch an older page once every card is drawn.
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

	// Scrolled down, live cards wait above (the "N new" pill) instead of pushing the gallery around.
	const onScroll = () => {
		const top = scroller.current?.scrollTop ?? 0
		feed.setHolding(top > 40)
	}
	useEffect(() => () => feed.setHolding(false), [feed])
	const toTop = () => {
		feed.release()
		scroller.current?.scrollTo({ top: 0 })
		feed.setHolding(false)
	}

	const cols = galleryColumns(width)
	// cards keep their column while live ones arrive on top; a new search or column count deals again
	const placed = useRef<{
		cols: number
		chip: typeof chip
		tokens: typeof tokens
		at: ReadonlyMap<string, number>
	} | null>(null)
	const columns = useMemo(() => {
		const p = placed.current
		const keep = p?.cols === cols && p.chip === chip && p.tokens === tokens
		const dealt = dealStable(
			items.slice(0, shown),
			cols,
			height,
			keyOf,
			keep ? p.at : null,
		)
		placed.current = { cols, chip, tokens, at: dealt.placed }
		return dealt.columns
	}, [items, shown, cols, chip, tokens])
	const searching = tokens.length > 0 || chip !== null
	const open = useCallback(
		(item: ActivitySummary) => {
			activity.open(item)
			shellStore.openDrawer("activity")
		},
		[activity],
	)

	return (
		<section
			className="wkg"
			aria-label="Messages"
			style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
		>
			<div
				ref={scroller}
				className="wkg-scroll wk-scroll"
				style={{ paddingRight: insets.right + 8 }}
				onScroll={onScroll}
			>
				<header className="wkg-head">
					<h2 className="wk-h2">Messages</h2>
					<span className="wkg-live" data-paused={paused || undefined}>
						<span className="wka-live-dot" />
						{paused
							? pending > 0
								? `Paused · ${pending} waiting`
								: "Paused"
							: "Live"}
					</span>
					{searching && tokens.length > 0 && (
						<span className="wkg-search">{activity.title()}</span>
					)}
					<span className="wkd-grow" />
					{tokens.length > 0 && (
						<Button variant="ghost" size="sm" onClick={() => activity.clear()}>
							Clear search
						</Button>
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={() => activity.setPaused(!paused)}
					>
						{paused ? "Resume" : "Pause"}
					</Button>
				</header>
				<div className="wkg-chips" role="radiogroup" aria-label="Show">
					<Chip
						role="radio"
						aria-checked={chip === null}
						pressed={chip === null}
						onClick={() => activity.setChip(null)}
					>
						All
					</Chip>
					{CATEGORY_CHIPS.map(c => {
						const n = counts?.[c.id]
						return (
							<Chip
								key={c.id}
								role="radio"
								aria-checked={chip === c.id}
								pressed={chip === c.id}
								count={n !== undefined ? n : undefined}
								onClick={() => activity.setChip(c.id)}
							>
								<WaveKitIcon name={c.categories[0]} size={16} />
								<span>{c.label}</span>
							</Chip>
						)
					})}
				</div>
				{pending > 0 && !paused && (
					<button
						type="button"
						className="wka-newpill wkg-newpill"
						onClick={toTop}
					>
						↑ {pending} new
					</button>
				)}
				<GalleryNote
					available={available}
					status={status}
					empty={items.length === 0}
					searching={searching}
				/>
				<div
					className="wkg-grid"
					role="list"
					aria-label={searching ? activity.title() : "All messages"}
					style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
				>
					{columns.map((col, i) => (
						<div key={i} className="wkg-col">
							{col.map(item => (
								<GalleryCard
									key={item.eventId}
									item={item}
									readOnly={readOnly}
									onOpen={open}
								/>
							))}
						</div>
					))}
				</div>
				<div ref={end} className="wkg-end" aria-hidden="true" />
				{loadingMore && <p className="wka-foot">Loading older messages…</p>}
				{!more &&
					items.length > 0 &&
					shown >= items.length &&
					status === "live" && (
						<p className="wka-foot">That is everything kept for this search.</p>
					)}
			</div>
		</section>
	)
}

// Memoised: a live batch re-renders the gallery, not the cards already shown.
const GalleryCard = memo(function GalleryCard({
	item,
	readOnly,
	onOpen,
}: {
	item: ActivitySummary
	readOnly: boolean
	onOpen: (item: ActivitySummary) => void
}) {
	return (
		<div role="listitem">
			<MessageCard
				item={item}
				readOnly={readOnly}
				onOpen={() => onOpen(item)}
			/>
		</div>
	)
})

function GalleryNote({
	available,
	status,
	empty,
	searching,
}: {
	available: boolean
	status: string
	empty: boolean
	searching: boolean
}) {
	if (!available)
		return (
			<p className="wka-note">
				Activity is turned off on this receiver, so there are no messages to
				show. Decodes still show on the spectrum.
			</p>
		)
	if (status === "error")
		return (
			<p className="wka-note" data-tone="warn">
				Could not load messages.
			</p>
		)
	if (status === "loading" && empty) return <p className="wka-note">Loading…</p>
	if (status === "live" && empty)
		return (
			<p className="wka-note">
				{searching
					? "Nothing matches this search yet. New matches appear here as they are decoded."
					: "Nothing decoded yet. Messages appear here as they arrive."}
			</p>
		)
	return null
}
