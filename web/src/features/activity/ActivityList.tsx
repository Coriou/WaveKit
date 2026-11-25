// The Activity list: windowed rows (only what is on screen is mounted, heights measured once), grouped
// by minute, arrows to move, Enter to open, → / ← to expand and collapse the stack under the cursor.
// Repeats fold into stacks (fold.ts): one row per thing going on, its newest decode (only who it is filled
// in from older rows), a count and a span, expanded in place to the folded earlier rows. A stack's React key
// is its fold key and the first row it was seen with, kept while it shares a row with the stack before
// (fold.ts foldedOf), so a live decode, an evicted old row or a loaded older page leaves it mounted. Stacks
// are ordered by their latest decode: at the top of the list a stack that hears again moves to the top;
// while the list is scrolled away from the top (or paused) arrivals are held and announced by the "N new"
// pill (counted in stacks), so nothing moves under the pointer. In the Cards layout each stack is its
// decoded message card (Messages board, feed variant), windowed the same way.
import type { ActivitySummary } from "@wavekit/api-types"
import { WaveKitIcon } from "@wavekit/brand/react"
import {
	memo,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react"
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react"

import type { ActivityFeed } from "../../data/activity-feed.ts"
import { compareSeq } from "../../data/activity-feed.ts"
import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { useSavedNames } from "../naming.ts"
import { clockText, useDisplay } from "../display.ts"
import { useNow } from "../hooks.ts"
import { MessageCard } from "../messages/MessageCard.tsx"
import type { ActivityStack } from "./fold.ts"
import { foldedOf, heldStacks, spanText } from "./fold.ts"
import { activityLayout } from "./layout.ts"
import {
	entryEventId,
	estimateCardHeight,
	estimateHeight,
	memberLine,
	rowView,
	stackEntries,
	timeText,
} from "./rows.ts"
import type { ListEntry } from "./rows.ts"
import { NEAR_END_PX, useVirtualRows } from "../../ui/virtual-rows.ts"
import {
	aircraftKey,
	useAircraftFleet,
	useRowAircraft,
} from "./row-aircraft.ts"
import { formatMHz } from "../format.ts"
import { Icon } from "../../ui/Icon.tsx"
import type { QueueRef } from "../playback/service.ts"
import { ActivityDisc, DiscSlot } from "./ActivityPlayback.tsx"
import { activityListKey, activityQueue } from "./playback.ts"
import { recordingStarts, recordStarts, rowTimeOf } from "./row-time.ts"

const HOLD_PX = 8
const MORE_PX = NEAR_END_PX
/**
 * Older pages loaded by themselves while the folded list is shorter than the viewport: folding can turn a
 * 100-row page into a handful of stacks (one aircraft at 2 rows/s is 120 rows a minute), so the list asks for
 * more until it fills, at most 10 pages (1 000 rows, a fifth of MAX_ITEMS) per search. Past that, scrolling
 * loads more as before.
 */
export const AUTO_FILL_PAGES = 10

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
	const { activity, playback } = useServices()
	const items = useStore(feed, s => s.items)
	const pendingItems = useStore(feed, s => s.pending)
	const status = useStore(feed, s => s.status)
	const more = useStore(feed, s => s.nextPageToken !== null)
	const loadingMore = useStore(feed, s => s.loadingMore)
	const full = useStore(feed, s => s.items.length >= feed.capacity)
	const now = useNow(true, 30_000)
	const [cursor, setCursor] = useState<string | null>(null)
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
	const seen = useRef<string | null>(null)
	const autoPages = useRef(0)
	const cards = useStore(activityLayout, s => s.layout === "cards")
	const listId = useId()
	const readOnly = useReadOnly()
	// aircraft rows name the airline and type from the live fleet while the list shows any
	useAircraftFleet(
		useStore(feed, s => s.items.some(i => aircraftKey(i.entityKey))),
	)
	const estimate = cards ? estimateCardHeight : estimateHeight

	const display = useDisplay()
	const stacks = useMemo(() => foldedOf(items, feed), [items, feed])
	// held arrivals, counted as the stacks they fold into (a beacon heard five times is 1 new)
	const pending = useMemo(
		() => heldStacks(pendingItems, feed),
		[pendingItems, feed],
	)
	// the rows with audio as shown: the queue a disc here plays from, refreshed while it is the one played
	// each list (the drawer's, every pinned column) is its own queue: only the one played from refreshes it
	const queueList = activityListKey(feed)
	const queue = useMemo(
		() => activityQueue(stacks, queueList),
		[stacks, queueList],
	)
	const queueNow = useRef(queue)
	queueNow.current = queue
	const readQueue = useCallback(() => queueNow.current, [])
	useEffect(() => {
		playback.setQueue("activity", queue.ids, queue.titles, queueList)
	}, [playback, queue, queueList])
	const entries = useMemo(
		() => stackEntries(stacks, now, expanded),
		[stacks, now, display, expanded], // group labels follow the time setting
	)
	const keys = useMemo(() => entries.map(e => e.key), [entries])
	// the cursor row stays mounted wherever the scroll is: aria-activedescendant always points at a row
	const keep = useMemo(() => {
		if (cursor === null) return []
		const i = keys.indexOf(cursor)
		return i < 0 ? [] : [i]
	}, [cursor, keys])
	const searchKeyNow = useStore(feed, s => s.searchKey)
	// Rows and cards measure differently: a layout switch starts from fresh guesses (resetKey), at the top.
	const virtual = useVirtualRows({
		keys,
		estimate: i => {
			const e = entries[i]
			return e ? estimate(e) : 0
		},
		resetKey: cards,
		revealMargin: 28,
		keep,
		// the same search opened again is where it was left
		restoreKey: `activity:${column ?? "drawer"}:${searchKeyNow ?? ""}`,
		onScroll: el => feed.setHolding(el.scrollTop > HOLD_PX),
		onNearEnd: () => void feed.loadMore(),
	})
	const { scroller, measure, win, viewport, reveal } = virtual
	const toTopOf = virtual.toTop
	const shownLayout = useRef(cards)
	useEffect(() => {
		if (shownLayout.current === cards) return
		shownLayout.current = cards
		toTopOf()
	}, [cards, toTopOf])

	// Stacks that heard live (a decode newer than the newest so far) flash once; older pages do not.
	const fresh = useMemo(() => {
		const out = new Set<string>()
		const newest = items[0]?.commitSeq ?? null
		const before = status === "live" ? seen.current : null
		if (before === null || newest === null) return out
		for (const st of stacks) {
			if (compareSeq(st.latest.commitSeq, before) <= 0) break
			out.add(st.key)
		}
		return out
	}, [items, stacks, status])
	useEffect(() => {
		seen.current = status === "live" ? (items[0]?.commitSeq ?? null) : null
	}, [items, status])

	// A new search starts at the top, folded (a rolling range moving on is the same search).
	const search = searchKeyNow
	const shownSearch = useRef(search)
	useEffect(() => {
		// the first run is the mount: a reopened search keeps its place (restoreKey)
		if (shownSearch.current !== search) toTopOf()
		shownSearch.current = search
		setExpanded(new Set())
		autoPages.current = 0
		feed.setHolding(false)
	}, [search, feed, toTopOf])

	// Folded stacks shorter than the viewport: ask for older pages until it fills (bounded above).
	useEffect(() => {
		if (
			!shouldAutoFill({
				live: status === "live",
				more,
				loadingMore,
				full,
				pages: autoPages.current,
				contentPx: win.total,
				viewportPx: viewport,
			})
		)
			return
		autoPages.current += 1
		void feed.loadMore()
	}, [status, more, loadingMore, full, win.total, viewport, feed])

	const onScroll = virtual.onScroll

	const toTop = useCallback(() => {
		feed.release()
		toTopOf()
		feed.setHolding(false)
	}, [feed, toTopOf])

	// The detail folds the same list: tell the controller which one this row came from.
	const open = useCallback(
		(eventId: string) => {
			activity.noteOpenFeed(feed)
			onOpen(eventId)
		},
		[activity, feed, onOpen],
	)

	const setOpen = useCallback((key: string, open: boolean | null) => {
		setExpanded(prev => {
			const want = open ?? !prev.has(key)
			if (want === prev.has(key)) return prev
			const next = new Set(prev)
			if (want) next.add(key)
			else next.delete(key)
			return next
		})
	}, [])
	const toggle = useCallback((key: string) => setOpen(key, null), [setOpen])
	const foldsId = useCallback(
		(stackKey: string) => `${listId}-folded-${encodeURIComponent(stackKey)}`,
		[listId],
	)
	const entryDomId = useCallback(
		(key: string) => `${listId}-entry-${encodeURIComponent(key)}`,
		[listId],
	)

	const rowIndex = useMemo(() => {
		const m = new Map<string, number>()
		entries.forEach((e, i) => {
			if (e.type !== "group") m.set(e.key, i)
		})
		return m
	}, [entries])

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (
			(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
			e.target === e.currentTarget
		) {
			// → expands the stack under the cursor, ← collapses it (from a folded row too, back onto its
			// stack); with nothing to expand or collapse they move between the columns
			const at = cursor === null ? undefined : rowIndex.get(cursor)
			const entry = at === undefined ? undefined : entries[at]
			const act = stackAction(entry, e.key === "ArrowRight" ? 1 : -1)
			if (act !== null) {
				e.preventDefault()
				setOpen(act.stackKey, act.open)
				if (act.cursor !== null) setCursor(act.cursor)
				return
			}
			if (column === undefined) return
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
		// A card or a stack holds its own buttons: Enter on one of them is that button's, not "open".
		if (e.key === "Enter" && e.target !== e.currentTarget) return
		const rows = entries.filter(x => x.type !== "group")
		if (rows.length === 0) return
		e.preventDefault()
		const at = cursor === null ? -1 : rows.findIndex(r => r.key === cursor)
		if (e.key === "Enter") {
			const row = rows[at]
			const id = row ? entryEventId(row) : null
			if (id !== null) open(id)
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

	const refreshing = status === "loading" && items.length > 0

	// the cursor's element (a stack's first folded row carries its toggle's aria-controls id)
	const cursorAt = cursor === null ? undefined : rowIndex.get(cursor)
	const cursorEntry = cursorAt === undefined ? undefined : entries[cursorAt]
	const activeDescendant =
		cursorEntry === undefined
			? undefined
			: cursorEntry.type === "member" && cursorEntry.first
				? foldsId(cursorEntry.stackKey)
				: entryDomId(cursorEntry.key)

	const renderEntry = (e: ListEntry) =>
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
		) : e.type === "member" ? (
			<FoldedRow
				key={e.key}
				entryKey={e.key}
				id={e.first ? foldsId(e.stackKey) : entryDomId(e.key)}
				item={e.item}
				measure={measure}
				cursor={cursor === e.key}
				current={openId === e.item.eventId}
				onOpen={open}
			/>
		) : e.type === "row" ? (
			<ActivityRow
				key={e.key}
				domId={entryDomId(e.key)}
				item={e.item}
				measure={measure}
				cursor={cursor === e.key}
				current={openId === e.key}
				fresh={false}
				onOpen={open}
				queue={readQueue}
			/>
		) : cards ? (
			<ActivityCard
				key={e.key}
				domId={entryDomId(e.key)}
				entryKey={e.key}
				item={e.stack.view}
				stack={e.stack}
				expanded={e.expanded}
				onToggle={toggle}
				foldsId={foldsId(e.key)}
				measure={measure}
				cursor={cursor === e.key}
				current={openId === e.stack.latest.eventId}
				fresh={fresh.has(e.key)}
				readOnly={readOnly}
				onOpen={open}
				queue={readQueue}
			/>
		) : (
			<ActivityRow
				key={e.key}
				domId={entryDomId(e.key)}
				entryKey={e.key}
				item={e.stack.view}
				stack={e.stack}
				expanded={e.expanded}
				onToggle={toggle}
				foldsId={foldsId(e.key)}
				measure={measure}
				cursor={cursor === e.key}
				current={openId === e.stack.latest.eventId}
				fresh={fresh.has(e.key)}
				onOpen={open}
				queue={readQueue}
			/>
		)

	return (
		<div className={className ? `wka-listwrap ${className}` : "wka-listwrap"}>
			{pending > 0 && (
				<button
					type="button"
					className="wka-newpill"
					title={`${heldText(pending, pendingItems.length)} Show them at the top.`}
					onClick={toTop}
				>
					↑ {pending} new
				</button>
			)}
			{refreshing && (
				<span className="wka-refresh" role="status">
					Updating…
				</span>
			)}
			<div
				ref={setRefs}
				className="wka-list wk-scroll"
				data-layout={cards ? "cards" : undefined}
				role="list"
				aria-label={label}
				aria-busy={refreshing || undefined}
				aria-activedescendant={activeDescendant}
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
						{entries.slice(win.start, win.end).map(renderEntry)}
					</div>
					{virtual.kept.map(k => {
						const e = entries[k.index]
						return e === undefined ? null : (
							<div
								key={`kept:${e.key}`}
								className="wka-kept"
								style={{ top: k.top }}
							>
								{renderEntry(e)}
							</div>
						)
					})}
				</div>
				{loadingMore && <p className="wka-foot">Loading older activity…</p>}
				{items.length > 0 && status !== "error" && (
					<p className="wka-foot">
						{foldedText(items.length, stacks.length)}
						{!more && status === "live"
							? " That is everything kept for this search."
							: ""}
					</p>
				)}
			</div>
		</div>
	)
}

export interface AutoFillState {
	live: boolean
	more: boolean
	loadingMore: boolean
	/** The list holds its most items (MAX_ITEMS): a page more would only push old rows out. */
	full: boolean
	/** Older pages already loaded by themselves for this search. */
	pages: number
	contentPx: number
	viewportPx: number
}

/** Whether to load an older page by itself: the folded list ends within MORE_PX of the viewport's end. */
export function shouldAutoFill(s: AutoFillState): boolean {
	if (!s.live || !s.more || s.loadingMore || s.full) return false
	if (s.pages >= AUTO_FILL_PAGES) return false
	return s.contentPx < s.viewportPx + MORE_PX
}

/** The list's honest count: what is loaded, and how it folded ("312 events in 41 rows, loaded so far."). */
export function foldedText(events: number, rows: number): string {
	const ev = `${events} event${events === 1 ? "" : "s"}`
	return events === rows
		? `${ev} loaded so far.`
		: `${ev} in ${rows} row${rows === 1 ? "" : "s"}, loaded so far.`
}

/** The "N new" pill's title: held stacks and the decodes in them ("2 rows from 7 new decodes."). */
export function heldText(stacks: number, decodes: number): string {
	const rows = `${stacks} row${stacks === 1 ? "" : "s"}`
	return `${rows} from ${decodes} new decode${decodes === 1 ? "" : "s"}.`
}

/**
 * What → (by 1) or ← (by -1) does on a list entry: expand a collapsed stack, collapse an expanded one,
 * or, on a folded row, collapse its stack and put the cursor back on it. Null when neither applies.
 */
export function stackAction(
	entry: ListEntry | undefined,
	by: -1 | 1,
): { stackKey: string; open: boolean; cursor: string | null } | null {
	if (entry?.type === "member")
		return by < 0
			? { stackKey: entry.stackKey, open: false, cursor: entry.stackKey }
			: null
	if (entry?.type !== "stack" || entry.stack.members.length < 2) return null
	if (by > 0 && !entry.expanded)
		return { stackKey: entry.key, open: true, cursor: null }
	if (by < 0 && entry.expanded)
		return { stackKey: entry.key, open: false, cursor: null }
	return null
}

/** A stack toggle's aria-controls: the folded rows' id only while they are shown (the element exists). */
export function toggleControls(
	expanded: boolean,
	foldsId: string | undefined,
): string | undefined {
	return expanded ? foldsId : undefined
}

/** "160.450 · 431.075 MHz": the channels a simulcast stack was heard on; null for one channel. */
export function channelsText(stack: ActivityStack | undefined): string | null {
	if (!stack || stack.channelsHz.length < 2) return null
	return `On ${stack.channelsHz.map(hz => formatMHz(hz)).join(" · ")} MHz`
}

/** "25 · 3 min": a stack's count and span in the loaded list. */
export function stackBadge(stack: ActivityStack): string {
	const span = stack.lastMs - stack.firstMs
	return span >= 1000
		? `${stack.members.length} · ${spanText(span)}`
		: String(stack.members.length)
}

function stackLabel(stack: ActivityStack, expanded: boolean): string {
	const n = stack.members.length
	return `${n} in the loaded list over ${spanText(stack.lastMs - stack.firstMs)}. ${
		expanded ? "Hide" : "Show"
	} the ${n - 1} earlier`
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
	/** The list entry's key (a stack's fold key and start); the event id for a lone row. */
	entryKey?: string
	/** The stack this row stands for; with more than one member it shows the count and expands. */
	stack?: ActivityStack
	expanded?: boolean
	onToggle?: (key: string) => void
	/** The id of the stack's first folded row (aria-controls of its toggle). */
	foldsId?: string
	/** The entry's element id (the list's aria-activedescendant names it). */
	domId?: string
	/** The list a row with audio plays from (its disc). */
	queue?: () => QueueRef
}

const NO_QUEUE = (): QueueRef => ({ source: "activity", ids: [] })

/** The time a row shows (row-time.ts): a kept recording's audio start, as the Recordings list shows it. */
function useRowTime(item: ActivitySummary): string {
	const { data } = useServices()
	const id = item.recording?.id ?? null
	const recording = useStore(data.recordings, s =>
		id === null ? null : (recordingStarts(s.items).get(id) ?? null),
	)
	const record = useStore(recordStarts, m => m.get(item.eventId) ?? null)
	return rowTimeOf(item, { recording, record })
}

function StackToggle({
	stack,
	expanded,
	onToggle,
	foldsId,
}: {
	stack: ActivityStack
	expanded: boolean
	onToggle: ((key: string) => void) | undefined
	foldsId: string | undefined
}) {
	return (
		<button
			type="button"
			className="wka-stack"
			aria-expanded={expanded}
			aria-controls={toggleControls(expanded, foldsId)}
			aria-label={stackLabel(stack, expanded)}
			title={stackLabel(stack, expanded)}
			onClick={() => onToggle?.(stack.key)}
		>
			<span className="wka-stack-n">{stackBadge(stack)}</span>
			<Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} />
		</button>
	)
}

export const ActivityRow = memo(function ActivityRow({
	item,
	measure,
	cursor,
	current,
	fresh,
	onOpen,
	entryKey,
	stack,
	expanded = false,
	onToggle,
	foldsId,
	domId,
	queue = NO_QUEUE,
}: RowProps) {
	useDisplay() // the time follows Settings › Display
	useSavedNames() // a saved name renames the row's channel
	const v = rowView(item, useRowAircraft(item.entityKey))
	const stacked = stack !== undefined && stack.members.length > 1
	const channels = channelsText(stack)
	const audio = item.recording !== undefined
	const shown = useRowTime(item)
	return (
		<div
			role="listitem"
			id={domId}
			data-key={entryKey ?? item.eventId}
			ref={measure}
			className="wka-item"
			data-stacked={stacked || undefined}
			data-col=""
			data-disc={audio || undefined}
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
						<time className="wka-time" dateTime={shown}>
							{timeText(shown)}
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
					{channels !== null && <span className="wka-read">{channels}</span>}
				</span>
			</button>
			{stacked && (
				<StackToggle
					stack={stack}
					expanded={expanded}
					onToggle={onToggle}
					foldsId={foldsId}
				/>
			)}
			{/* the disc's column is always last: discs line up at the item's right edge, and a row without
			    audio keeps the column empty so every row's time and stack count sit in the same place */}
			{audio ? <ActivityDisc item={item} queue={queue} /> : <DiscSlot />}
		</div>
	)
})

/** A folded earlier row under an expanded stack: its time and what it said, one line; opens its detail. */
export const FoldedRow = memo(function FoldedRow({
	entryKey,
	id,
	item,
	measure,
	cursor,
	current,
	onOpen,
}: {
	entryKey: string
	/** Set on a stack's first folded row: its toggle's aria-controls points here. */
	id?: string | undefined
	item: ActivitySummary
	measure: (el: HTMLElement | null) => void
	cursor: boolean
	current: boolean
	onOpen: (eventId: string) => void
}) {
	useDisplay()
	const shown = useRowTime(item)
	return (
		<div
			role="listitem"
			id={id}
			data-key={entryKey}
			ref={measure}
			className="wka-item wka-folded"
		>
			<button
				type="button"
				className="wk-row wka-row wka-folded-row"
				data-kb-cursor={cursor || undefined}
				aria-current={current || undefined}
				onClick={() => onOpen(item.eventId)}
			>
				<time className="wka-time" dateTime={shown}>
					{clockText(shown, { seconds: true })}
				</time>
				<span className="wka-folded-text">{memberLine(item)}</span>
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
	entryKey,
	stack,
	expanded = false,
	onToggle,
	foldsId,
	domId,
	queue = NO_QUEUE,
}: RowProps & { readOnly: boolean }) {
	const stacked = stack !== undefined && stack.members.length > 1
	const channels = channelsText(stack)
	const audio = item.recording !== undefined
	return (
		<div
			role="listitem"
			id={domId}
			data-key={entryKey ?? item.eventId}
			ref={measure}
			className="wka-item wka-carditem"
			data-kb-cursor={cursor || undefined}
			data-fresh={fresh || undefined}
			aria-current={current || undefined}
		>
			<MessageCard
				item={item}
				readOnly={readOnly}
				onOpen={() => onOpen(stack?.latest.eventId ?? item.eventId)}
			/>
			{(stacked || channels !== null || audio) && (
				<div className="wka-cardstack">
					{channels !== null && <span className="wka-read">{channels}</span>}
					{stacked && (
						<StackToggle
							stack={stack}
							expanded={expanded}
							onToggle={onToggle}
							foldsId={foldsId}
						/>
					)}
					{/* the disc's column, last and of one width (empty on a stacked card without audio) */}
					{audio ? (
						<ActivityDisc item={item} queue={queue} inline />
					) : (
						stacked && <DiscSlot inline />
					)}
				</div>
			)}
		</div>
	)
})
