import "../../features/activity/activity.css"

import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type { ActivityFeedState } from "../../data/activity-feed.ts"
import { ActivityDetail } from "../../features/activity/ActivityDetail.tsx"
import { ActivityList } from "../../features/activity/ActivityList.tsx"
import type { CategoryChipId } from "../../features/activity/search.ts"
import { CATEGORY_CHIPS, suggest } from "../../features/activity/search.ts"
import { Chip } from "../../ui/Chip.tsx"
import { Drawer } from "../../ui/Drawer.tsx"
import { Icon } from "../../ui/Icon.tsx"
import type { DrawerContentProps } from "./types.ts"

const RESET_TEXT: Record<NonNullable<ActivityFeedState["reset"]>, string> = {
	"cursor-gap": "The live feed fell behind and was reloaded.",
	"cursor-expired": "The live feed expired and was reloaded.",
	"store-changed": "Activity storage changed; the list was reloaded.",
	"query-changed": "The search changed; the list was reloaded.",
	"invalid-cursor": "The live feed could not resume and was reloaded.",
	"reader-failed": "Reading Activity failed; the list was reloaded.",
}

// The Activity drawer (Activity board): search with typed chips, category chips with counts, pinned
// searches as a switcher row, the live list, and an event's detail pushed in with Back.
export default function ActivityDrawer({ onClose }: DrawerContentProps) {
	const { activity } = useServices()
	const feed = activity.feed
	useEffect(() => activity.attach(), [activity])
	const openId = useStore(activity, s => s.openId)
	const openItem = useStore(activity, s => s.openItem)
	const paused = useStore(feed, s => s.paused)
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
					onClick={() => feed.setPaused(!paused)}
				>
					<span className="wka-live-dot" />
					{paused ? "Paused" : "Live"}
				</button>
			}
		>
			<div className="wka-browse" hidden={openId !== null}>
				<SearchBox />
				<Categories />
				<Pins />
				<ListHeader />
				<Notices />
				<ActivityList
					ref={list}
					feed={feed}
					openId={openId}
					label={activity.title()}
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

function SearchBox() {
	const { activity } = useServices()
	const tokens = useStore(activity, s => s.tokens)
	const [text, setText] = useState("")
	const input = useRef<HTMLInputElement>(null)
	const options = suggest(text)

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
		}
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

function Pins() {
	const { activity } = useServices()
	const pins = useStore(activity, s => s.pins)
	// Re-read the current pin when the search changes.
	useStore(activity, s => s.tokens)
	useStore(activity, s => s.chip)
	const all = useStore(activity, s => s.tokens.length === 0 && s.chip === null)
	const current = activity.currentPin()
	if (pins.length === 0) return null
	return (
		<div className="wka-pins" role="group" aria-label="Pinned searches">
			<Chip size="sm" pressed={all} onClick={() => activity.clear()}>
				All activity
			</Chip>
			{pins.map(p => (
				<Chip
					key={p.id}
					size="sm"
					pressed={current?.id === p.id}
					onClick={() => activity.setSearch(p.tokens, p.chip)}
				>
					{p.title}
				</Chip>
			))}
		</div>
	)
}

function ListHeader() {
	const { activity } = useServices()
	const feed = activity.feed
	const count = useStore(feed, s => s.items.length)
	const more = useStore(feed, s => s.nextPageToken !== null)
	const tokens = useStore(activity, s => s.tokens)
	const chip = useStore(activity, s => s.chip)
	useStore(activity, s => s.pins)
	const pinned = activity.currentPin()
	const searching = tokens.length > 0 || chip !== null
	return (
		<div className="wka-listhead">
			<span className="wka-listtitle">
				{searching ? activity.title() : "All activity"}
			</span>
			<span className="wka-listcount">
				{count}
				{more ? "+" : ""}
			</span>
			<span className="wkf-gap" />
			{searching &&
				(pinned ? (
					<button
						type="button"
						className="wka-link"
						onClick={() => activity.unpin(pinned.id)}
					>
						Unpin
					</button>
				) : (
					<button
						type="button"
						className="wka-link"
						onClick={() => activity.pinCurrent()}
					>
						Pin search
					</button>
				))}
			{searching && (
				<button
					type="button"
					className="wka-link"
					onClick={() => activity.clear()}
				>
					Clear
				</button>
			)}
		</div>
	)
}

function Notices() {
	const { activity } = useServices()
	const feed = activity.feed
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
