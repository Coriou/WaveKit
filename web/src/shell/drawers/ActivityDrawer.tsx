import "../../features/activity/activity.css"

import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type {
	ActivityFeed,
	ActivityFeedState,
} from "../../data/activity-feed.ts"
import { ActivityDetail } from "../../features/activity/ActivityDetail.tsx"
import { ActivityList } from "../../features/activity/ActivityList.tsx"
import { MAX_COLUMNS } from "../../features/activity/columns.ts"
import {
	activitySearchFocus,
	takeActivitySearchFocus,
} from "../../features/activity/focus.ts"
import {
	activityPane,
	setActivityPaneOpen,
} from "../../features/activity/pane.ts"
import type { CategoryChipId } from "../../features/activity/search.ts"
import { CATEGORY_CHIPS, suggest } from "../../features/activity/search.ts"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { Drawer } from "../../ui/Drawer.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { showAppToast } from "../toast.ts"
import type { DrawerContentProps } from "./types.ts"

const RESET_TEXT: Record<NonNullable<ActivityFeedState["reset"]>, string> = {
	"cursor-gap": "The live feed fell behind and was reloaded.",
	"cursor-expired": "The live feed expired and was reloaded.",
	"store-changed": "Activity storage changed; the list was reloaded.",
	"query-changed": "The search changed; the list was reloaded.",
	"invalid-cursor": "The live feed could not resume and was reloaded.",
	"reader-failed": "Reading Activity failed; the list was reloaded.",
}

// The Activity drawer (Activity board): search with typed chips and Pin as column, category chips with counts,
// the live list, and an event's detail pushed in with Back. With room, the header's Columns opens the pinned
// searches side by side in the attached pane (ActivityColumnsPane); without, they are a switcher row here.
export default function ActivityDrawer({
	onClose,
	paneRoom = false,
}: DrawerContentProps) {
	const { activity } = useServices()
	useEffect(() => activity.attach(), [activity])
	const openId = useStore(activity, s => s.openId)
	const openItem = useStore(activity, s => s.openItem)
	const view = useStore(activity, s => s.view)
	const hasColumns = useStore(activity, s => s.columns.length > 0)
	useStore(activity, s => s.columns)
	// no room for the pane: the switcher's pick is the list the drawer shows
	const feed =
		(!paneRoom && view !== "all" ? activity.columnFeed(view) : null) ??
		activity.feed
	const paused = useStore(activity.feed, s => s.paused)
	const paneOpen = useStore(activityPane, s => s.open)
	const list = useRef<HTMLDivElement>(null)

	const back = () => {
		activity.open(null)
		requestAnimationFrame(() => list.current?.focus())
	}

	return (
		<Drawer
			title="Activity"
			className="wka-drawer"
			onClose={onClose}
			actions={
				<button
					type="button"
					className="wka-live"
					aria-pressed={paused}
					title={
						paused
							? "Paused: new events wait. Click to go live."
							: "Live: new events appear at the top. Click to pause."
					}
					onClick={() => activity.setPaused(!paused)}
				>
					<span className="wka-live-dot" />
					{paused ? "Paused" : "Live"}
				</button>
			}
			end={
				paneRoom && (
					<Button
						variant="ghost"
						size="sm"
						className="wka-cols-btn"
						aria-pressed={paneOpen}
						title={
							paneOpen
								? "Hide the columns"
								: "Show your pinned searches as columns beside Activity"
						}
						onClick={() => setActivityPaneOpen(!paneOpen)}
					>
						<Icon name="columns" />
						Columns
					</Button>
				)
			}
		>
			<div className="wka-browse" hidden={openId !== null}>
				<SearchBox room={paneRoom} />
				<Categories />
				{!paneRoom && hasColumns && <Switcher />}
				<ListHeader feed={feed} room={paneRoom} />
				<Notices feed={feed} />
				<ActivityList
					ref={list}
					feed={feed}
					openId={openId}
					column="drawer"
					label={
						feed === activity.feed
							? activity.title()
							: (activity.get().columns.find(c => c.id === view)?.title ??
								activity.title())
					}
					onOpen={id => {
						const item = feed.get().items.find(i => i.eventId === id) ?? null
						if (item) activity.open(item)
					}}
				/>
			</div>
			{openId !== null && (
				<ActivityDetail eventId={openId} item={openItem} onBack={back} />
			)}
		</Drawer>
	)
}

function SearchBox({ room }: { room: boolean }) {
	const { activity } = useServices()
	const tokens = useStore(activity, s => s.tokens)
	const chip = useStore(activity, s => s.chip)
	const editing = useStore(activity, s =>
		s.editing === null
			? null
			: (s.columns.find(c => c.id === s.editing) ?? null),
	)
	const full = useStore(activity, s => s.columns.length >= MAX_COLUMNS)
	const pinned = useStore(activity, s => {
		void s.columns
		void s.tokens
		void s.chip
		return activity.currentColumn()
	})
	const searching = tokens.length > 0 || chip !== null
	const canPin = searching && (editing !== null || (!full && pinned === null))
	const [text, setText] = useState("")
	const input = useRef<HTMLInputElement>(null)
	const options = suggest(text)

	// ⌘K "Search Activity": focus the field, after the shell has moved focus into the opened drawer
	const focusWanted = useStore(activitySearchFocus, s => s.pending)
	useEffect(() => {
		if (!focusWanted) return
		const t = setTimeout(() => {
			if (takeActivitySearchFocus()) input.current?.focus()
		}, 0)
		return () => clearTimeout(t)
	}, [focusWanted])

	// "/" from anywhere outside a text field jumps to the search.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return
			const t = e.target as HTMLElement | null
			if (
				t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable)
			)
				return
			e.preventDefault()
			input.current?.focus()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [])

	const commit = (index: number) => {
		const t = options[index]
		if (!t) return
		activity.addToken(t)
		setText("")
	}

	const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault()
			commit(0)
		} else if (e.key === "Backspace" && text === "" && tokens.length > 0) {
			activity.removeToken(tokens.length - 1)
		} else if (e.key === "Escape" && text !== "") {
			e.preventDefault()
			setText("")
		} else if (e.key === "Escape" && editing !== null) {
			e.preventDefault()
			activity.cancelEdit()
		}
	}

	const pin = () => {
		const name = editing?.title
		const id = activity.pinSearch(room)
		if (id === null) return
		if (name !== undefined) showAppToast(`Column ${name} updated.`)
		else if (!room)
			showAppToast("Pinned. Switch to it in the row above the list.")
	}

	return (
		<div className="wka-search">
			<div className="wk-field wka-field">
				<Icon name="search" size={16} />
				{tokens.map((t, i) => (
					<span key={`${t.kind}:${t.value}`} className="wk-token">
						{t.label}
						<button
							type="button"
							aria-label={`Remove ${t.label}`}
							onClick={() => activity.removeToken(i)}
						>
							<Icon name="close" />
						</button>
					</span>
				))}
				<input
					ref={input}
					aria-label="Search activity"
					placeholder={
						tokens.length
							? "Add a filter…"
							: "Talkgroup, capcode, MMSI, frequency…"
					}
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
				/>
				{searching && (
					<Button
						variant="ghost"
						size="sm"
						className="wka-clear"
						onClick={() => activity.clear()}
					>
						{editing ? "Cancel" : "Clear all"}
					</Button>
				)}
				{canPin && (
					<Button
						variant="tonal"
						size="sm"
						className="wka-pin"
						title={
							editing
								? `Save this search to the column ${editing.title}`
								: room
									? "Keep this search as a column beside Activity"
									: "Keep this search as a column you can switch to"
						}
						onClick={pin}
					>
						<Icon name="pin" />
						{editing ? "Update column" : "Pin as column"}
					</Button>
				)}
			</div>
			{options.length > 0 && (
				<div className="wka-suggest" role="group" aria-label="Search as">
					{options.map((t, i) => (
						<Chip
							key={`${t.kind}:${t.value}`}
							size="sm"
							pressed={i === 0}
							onClick={() => commit(i)}
						>
							{t.kind === "text" ? `Anywhere: ${t.value}` : t.label}
						</Chip>
					))}
				</div>
			)}
		</div>
	)
}

function Categories() {
	const { activity } = useServices()
	const chip = useStore(activity, s => s.chip)
	const counts = useStore(activity, s => s.counts)
	const pick = (id: CategoryChipId) => activity.setChip(chip === id ? null : id)
	return (
		<div className="wka-chips" role="group" aria-label="Category">
			{CATEGORY_CHIPS.map(c => {
				const n = counts?.[c.id]
				return (
					<Chip
						key={c.id}
						size="sm"
						pressed={chip === c.id}
						count={n !== undefined && n > 0 ? n : undefined}
						onClick={() => pick(c.id)}
					>
						{c.label}
					</Chip>
				)
			})}
		</div>
	)
}

// No room for the pane: the columns become a chip row that switches the drawer's list, with new-item counts.
function Switcher() {
	const { activity } = useServices()
	const columns = useStore(activity, s => s.columns)
	const view = useStore(activity, s => s.view)
	return (
		<div className="wka-pins" role="tablist" aria-label="Pinned columns">
			<Chip
				size="sm"
				role="tab"
				aria-selected={view === "all"}
				pressed={view === "all"}
				onClick={() => activity.pickView("all")}
			>
				All
			</Chip>
			{columns.map(c => (
				<SwitcherChip key={c.id} id={c.id} title={c.title} on={view === c.id} />
			))}
		</div>
	)
}

function SwitcherChip({
	id,
	title,
	on,
}: {
	id: string
	title: string
	on: boolean
}) {
	const { activity } = useServices()
	const feed = activity.columnFeed(id)
	// re-read the count when the column's list or what was seen moves
	useStore(activity, s => s.seen[id])
	const fresh = useStore(feed ?? activity.feed, () =>
		on ? 0 : activity.newInColumn(id),
	)
	return (
		<Chip
			size="sm"
			role="tab"
			aria-selected={on}
			pressed={on}
			count={fresh > 0 ? fresh : undefined}
			aria-label={fresh > 0 ? `${title}, ${fresh} new` : title}
			onClick={() => activity.pickView(id)}
		>
			{title}
		</Chip>
	)
}

function ListHeader({ feed, room }: { feed: ActivityFeed; room: boolean }) {
	const { activity } = useServices()
	const count = useStore(feed, s => s.items.length)
	const more = useStore(feed, s => s.nextPageToken !== null)
	const searching = useStore(
		activity,
		s => s.tokens.length > 0 || s.chip !== null,
	)
	const view = useStore(activity, s =>
		room || s.view === "all"
			? null
			: (s.columns.find(c => c.id === s.view) ?? null),
	)
	useStore(activity, s => s.tokens)
	useStore(activity, s => s.chip)
	const title = view
		? searching
			? `${view.title} · ${activity.title()}`
			: view.title
		: searching
			? activity.title()
			: "All activity"
	return (
		<div className="wka-listhead">
			<span className="wka-listtitle">{title}</span>
			<span className="wka-listcount">
				{count}
				{more ? "+" : ""}
			</span>
		</div>
	)
}

function Notices({ feed }: { feed: ActivityFeed }) {
	const { activity } = useServices()
	const status = useStore(feed, s => s.status)
	const reset = useStore(feed, s => s.reset)
	const error = useStore(feed, s => s.error)
	const available = useStore(feed, s => s.available)
	const empty = useStore(feed, s => s.items.length === 0)
	const query = useStore(feed, s => s.query)
	const tokens = useStore(activity, s => s.tokens)
	if (!available)
		return (
			<p className="wka-note">
				Activity is turned off on this receiver. Decodes still show on the
				spectrum.
			</p>
		)
	if (status === "error")
		return (
			<p className="wka-note" data-tone="warn">
				Could not load Activity: {error}{" "}
				<button
					type="button"
					className="wka-link"
					onClick={() => void feed.reload()}
				>
					Try again
				</button>
			</p>
		)
	return (
		<>
			{reset && status === "live" && (
				<p className="wka-note">{RESET_TEXT[reset]}</p>
			)}
			{error && status === "live" && (
				<p className="wka-note" data-tone="warn">
					Live updates stopped: {error}{" "}
					<button
						type="button"
						className="wka-link"
						onClick={() => void feed.reload()}
					>
						Retry
					</button>
				</p>
			)}
			{status === "loading" && empty && <p className="wka-note">Loading…</p>}
			{status === "live" && empty && (
				<p className="wka-note">
					{query === null || tokens.length > 0
						? "Nothing matches this search yet. New matches appear here as they are heard."
						: "Nothing heard yet. Decoded messages and calls appear here as they arrive."}
				</p>
			)}
			{status === "idle" && query === null && tokens.length > 0 && (
				<p className="wka-note">
					These filters cannot match together. Remove one.
				</p>
			)}
		</>
	)
}
