import "./recordings.css"

// The Recordings drawer (Recordings board), on the core's recordings catalogue (WG8 inventory, WG9 Keep and
// delete): header "Recordings · count · All / Kept" with the core's counts, typed-chip search run by the core,
// one notice slot, the virtual list of rows grouped by day (only what is on screen is mounted; older pages
// load at the end; open in place: waveform, then Play, Keep, Details, ⋯ (Download, Tune, Open in Scanner, Delete
// with Undo) and one channel link) and the storage footer. Details pushes the Transmission view in place of the
// list; Back returns to the same search, scroll and open row. Playback is the app's one player (services.playback, its dock
// the only transport): the row disc toggles it, the open row's waveform seeks it, the playing row is marked.
// The list follows the catalogue's `recordings` socket notices; arrivals hold while it is scrolled or playing
// from it ("N new"). Names, notes, trim, transcripts, IQ captures and Opus downloads wait for the core
// (CORE-GAPS "Recordings").
import { memo, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from "react"
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import {
	RECORDINGS_WINDOW_MAX,
	errorMessage,
	recordingsUnavailable,
	useStore,
} from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { clockText, useDisplay } from "../display.ts"
import { shellStore } from "../../shell/store.ts"
import { Drawer } from "../../ui/Drawer.tsx"
import { Icon } from "../../ui/Icon.tsx"
import {
	PanelFailed,
	PanelLoading,
	PanelNotice,
	PanelProgress,
} from "../../ui/Panel.tsx"
import { panelView } from "../../ui/panel-state.ts"
import type { PanelNoticeKind } from "../../ui/panel-state.ts"
import { Seg } from "../../ui/Seg.tsx"
import { useVirtualRows } from "../../ui/virtual-rows.ts"
import { token as activityToken } from "../activity/search.ts"
import {
	backFromTransmission,
	focusAfterBack,
	openInScanner,
	openTransmission,
	transmissionNav,
} from "../transmission/nav.ts"
import { TransmissionView } from "../transmission/TransmissionView.tsx"
import {
	channelMHz,
	historyLabel,
	rasterHz,
	showChannel,
	useSavedNames,
} from "../naming.ts"
import { tuningStep } from "../../plot/maths.ts"
import { playbackIdOf } from "../playback/keep.ts"
import { PlayDisc, usePlaybackMark, WaveView } from "../playback/PlaybackUi.tsx"
import type { PlaybackService, QueueRef } from "../playback/service.ts"
import { PlayGlyph, RecIcon } from "./icons.tsx"
import { listKeyAction } from "./keys.ts"
import {
	countText,
	dayEntries,
	deleteBlocker,
	formatBytes,
	headerCount,
	recordedAt,
	recordingIcon,
	recordingMeta,
	recordingTitle,
	recordingsQuery,
	storageLine,
	suggest,
	timeLabel,
} from "./model.ts"
import type { RecFilter } from "./ui-store.ts"
import {
	addToken,
	clearSearch,
	openRow,
	recordingsUi,
	removeToken,
	setCursor,
	setFilter,
	revealRequest,
	setText,
	visibleRecordings,
} from "./ui-store.ts"

const SCRUB_S = 5
/** Typed text waits this long before it becomes a core query (one read per pause, not per key). */
const TYPE_DEBOUNCE_MS = 250
/** Scrolled further than this from the top, arrivals hold ("N new"). */
const HOLD_PX = 8
/** Height guesses until measured: a day label, a closed row, an open row (waveform and actions). */
const DAY_PX = 34
const ROW_PX = 62
const OPEN_PX = 236

export function RecordingsDrawer({ onClose }: { onClose: () => void }) {
	const services = useServices()
	const recordings = services.data.recordings
	const unavailable = useStore(recordings, recordingsUnavailable)
	const readOnly = useReadOnly()
	const player = services.playback
	// the Transmission view pushed in place of the list (Details)
	const tx = useStore(transmissionNav, s =>
		s?.origin.host === "recordings" ? s : null,
	)

	// open: the list for the current search, following the catalogue's notices (no polling)
	useEffect(() => {
		const detach = recordings.attach(recordingsQuery(recordingsUi.get()))
		void services.data.system.load()
		const flush = () => recordings.flushRemovals()
		window.addEventListener("pagehide", flush)
		return () => {
			detach()
			window.removeEventListener("pagehide", flush)
		}
	}, [recordings, services.data.system])
	useSearchQuery()

	return (
		<Drawer
			title="Recordings"
			className="wkr-drawer"
			onClose={onClose}
			closeLabel="Close recordings"
			actions={
				// the count and the All / Kept switch belong to the list: hidden while the view stands in its place,
				// so the list Back returns to is the one the user left
				tx === null ? <HeaderActions usable={unavailable === null} /> : null
			}
		>
			{unavailable === "protected-only" ? (
				<Empty
					icon="lock"
					title="Recordings need access protection"
					text="This WaveKit runs without access protection, and the core lists recordings only when it is on. Turn on access in the WaveKit config to list, play and keep them here."
				/>
			) : tx !== null ? (
				<TransmissionView open={tx} onBack={backToList} />
			) : (
				<>
					<Progress />
					{readOnly && (
						<p className="wkr-banner" role="status">
							<RecIcon name="lock" size={15} />
							View only · your access can play recordings but not keep or delete
							them
						</p>
					)}
					<SearchBar />
					<List player={player} readOnly={readOnly} />
				</>
			)}
			{tx === null && <Footer />}
		</Drawer>
	)
}

/**
 * Back from the Transmission view: the list comes back as it was (search, scroll, open row), focus on that row,
 * or on the list itself when that row is not mounted (scrolled out of the window, or gone). A view that opened
 * this drawer gives focus back to what opened it instead (backFromTransmission).
 */
function backToList(): void {
	const origin = backFromTransmission()
	if (focusAfterBack(origin, false) !== "list") return
	requestAnimationFrame(() => focusListAfterBack(recordingsUi.get(), document))
}

/**
 * Focuses the open (else the cursor) row when it is mounted, else the list: its tab stop row when one is
 * mounted, else the list element itself (made focusable by script only, so it never becomes a tab stop).
 */
export function focusListAfterBack(
	ui: { openId: string | null; cursorId: string | null },
	doc: Pick<Document, "getElementById" | "querySelector">,
): void {
	const id = ui.openId ?? ui.cursorId
	const row = id !== null ? doc.getElementById(rowDomId(id)) : null
	if (row !== null) {
		row.focus({ preventScroll: true })
		return
	}
	const stop = doc.querySelector<HTMLElement>(
		'.wkr-drawer .wkr-list [data-row-id][tabindex="0"]',
	)
	if (stop !== null) {
		stop.focus({ preventScroll: true })
		return
	}
	const list = doc.querySelector<HTMLElement>(".wkr-drawer .wkr-list")
	if (list === null) return
	if (!list.hasAttribute("tabindex")) list.tabIndex = -1
	list.focus({ preventScroll: true })
}

/** The search and the Kept filter as a core query: chips and Kept at once, typed text after a pause. */
function useSearchQuery() {
	const recordings = useServices().data.recordings
	const tokens = useStore(recordingsUi, s => s.tokens)
	const text = useStore(recordingsUi, s => s.text)
	const filter = useStore(recordingsUi, s => s.filter)
	const first = useRef(true)
	useEffect(() => {
		// the attach above already asked for the opening query
		if (first.current) {
			first.current = false
			return
		}
		const q = recordingsQuery({ tokens, text, filter })
		const t = setTimeout(
			() => void recordings.show(q),
			text.trim() === "" ? 0 : TYPE_DEBOUNCE_MS,
		)
		return () => clearTimeout(t)
	}, [recordings, tokens, text, filter])
}

function Progress() {
	const recordings = useServices().data.recordings
	const on = useStore(
		recordings,
		s => s.status === "loading" && s.items.length > 0,
	)
	return <PanelProgress on={on} />
}

function HeaderActions({ usable }: { usable: boolean }) {
	const recordings = useServices().data.recordings
	const meta = useStore(recordings, s => s.meta)
	// a count still loading keeps its last value, dimmed
	const dim = useStore(recordings, s => !s.answered || s.status === "loading")
	const filter = useStore(recordingsUi, s => s.filter)
	const searching = useStore(
		recordingsUi,
		s => s.tokens.length > 0 || s.text.trim() !== "",
	)
	if (!usable) return null
	const count = headerCount(meta, filter, searching)
	const kept = meta?.counts?.kept ?? null
	return (
		<>
			<span className="wkr-count" data-dim={dim || undefined}>
				{count ?? ""}
			</span>
			<span className="wkr-head-gap" />
			<Seg<RecFilter>
				label="Show"
				value={filter}
				onChange={setFilter}
				options={[
					{ value: "all", label: "All" },
					{
						value: "kept",
						label: `Kept${kept !== null && kept > 0 ? ` ${countText(kept)}` : ""}`,
					},
				]}
			/>
		</>
	)
}

function Empty({
	icon,
	title,
	text,
	action,
}: {
	icon: "lock" | "refresh" | "star" | "voice"
	title: string
	text: string
	action?: { label: string; run: () => void }
}) {
	return (
		<div className="wkr-empty">
			<span className="wkr-empty-icon">
				<RecIcon name={icon} size={22} />
			</span>
			<span className="wkr-empty-title">{title}</span>
			<span className="wkr-empty-text">{text}</span>
			{action && (
				<button
					type="button"
					className="wk-btn"
					data-variant="outline"
					data-size="lg"
					onClick={action.run}
				>
					{action.label}
				</button>
			)}
		</div>
	)
}

// ---- search

function SearchBar() {
	const tokens = useStore(recordingsUi, s => s.tokens)
	const text = useStore(recordingsUi, s => s.text)
	const [focus, setFocus] = useState(false)
	const [active, setActive] = useState(0)
	const options = useMemo(() => suggest(text, tokens), [text, tokens])
	const show = focus && options.length > 0

	const commit = (i: number) => {
		const o = options[i]
		if (!o) return
		addToken(o.token)
		setActive(0)
	}
	const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && show) {
			e.preventDefault()
			commit(active)
		} else if (e.key === "ArrowDown" && show) {
			e.preventDefault()
			setActive(a => (a + 1) % options.length)
		} else if (e.key === "ArrowUp" && show) {
			e.preventDefault()
			setActive(a => (a - 1 + options.length) % options.length)
		} else if (e.key === "Backspace" && text === "" && tokens.length > 0) {
			removeToken(tokens.length - 1)
		} else if (e.key === "Escape" && text !== "") {
			e.preventDefault()
			e.stopPropagation()
			setText("")
		}
	}

	return (
		<div className="wkr-search">
			<div className="wk-field wkr-field">
				<Icon name="search" size={16} />
				{tokens.map((t, i) => (
					<span key={`${t.kind}:${t.value}`} className="wk-token">
						<span className="wkr-token-kind">{t.kindLabel}</span>
						{t.label}
						<button
							type="button"
							aria-label={`Remove filter ${t.kindLabel} ${t.label}`}
							onClick={() => removeToken(i)}
						>
							<Icon name="close" />
						</button>
					</span>
				))}
				<input
					aria-label="Search recordings"
					role="combobox"
					aria-expanded={show}
					aria-controls="wkr-suggest"
					aria-autocomplete="list"
					placeholder={
						tokens.length ? "Narrow further…" : "Talkgroup, radio, frequency…"
					}
					spellCheck={false}
					autoComplete="off"
					value={text}
					onChange={e => {
						setText(e.target.value)
						setActive(0)
					}}
					onFocus={() => setFocus(true)}
					onBlur={() => setFocus(false)}
					onKeyDown={onKeyDown}
				/>
			</div>
			{show && (
				<div
					id="wkr-suggest"
					role="listbox"
					aria-label="Search as"
					className="wk-menu wkr-suggest"
				>
					{options.map((o, i) => (
						<button
							key={`${o.token.kind}:${o.token.value}`}
							type="button"
							role="option"
							aria-selected={i === active}
							className="wk-option"
							data-size="touch"
							onMouseDown={e => {
								e.preventDefault()
								commit(i)
							}}
							onMouseEnter={() => setActive(i)}
						>
							<span className="wkr-sugg-kind">{o.token.kindLabel}</span>
							<span className="wkr-sugg-value">{o.token.label}</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

// ---- list

/** The notice slot's words for each kind (panel-state.ts picks one). */
function noticeText(
	kind: PanelNoticeKind,
	s: {
		error: string | null
		asOf: number | null
		scanned: number
		indexed: number
	},
): string {
	switch (kind) {
		case "error":
			return `Could not refresh: ${s.error ?? "no answer"}.${
				s.asOf !== null
					? ` Showing the list as of ${clockText(new Date(s.asOf))}.`
					: ""
			}`
		case "busy":
			return "Still loading. WaveKit is busy."
		case "truncated":
			return `Only the newest ${countText(s.scanned)} recordings are listed; older ones are left out.`
		case "capped":
			return `The newest ${countText(RECORDINGS_WINDOW_MAX)} are loaded here. Search to narrow the list.`
		case "indexing":
			return `Indexing recordings, ${countText(s.indexed)} so far.`
	}
}

/** The Recordings queue: the playable rows as shown, by playback id, with their titles. */
export function recordingsQueue(
	visible: readonly RecordingInventoryItem[],
): QueueRef {
	const titles: Record<string, string> = {}
	for (const r of visible) titles[playbackIdOf(r)] = recordingTitle(r)
	return {
		source: "recordings",
		ids: visible.map(playbackIdOf),
		titles,
	}
}

function List({
	player,
	readOnly,
}: {
	player: PlaybackService
	readOnly: boolean
}) {
	const recordings = useServices().data.recordings
	const items = useStore(recordings, s => s.items)
	const status = useStore(recordings, s => s.status)
	const busy = useStore(recordings, s => s.busy)
	const error = useStore(recordings, s => s.error)
	const asOf = useStore(recordings, s => s.asOf)
	const retryAt = useStore(recordings, s => s.retryAt)
	const meta = useStore(recordings, s => s.meta)
	const capped = useStore(recordings, s => s.capped)
	const more = useStore(recordings, s => s.nextCursor !== null)
	const loadingMore = useStore(recordings, s => s.loadingMore)
	const heldNew = useStore(recordings, s => s.heldNew)
	const answered = useStore(recordings, s => s.answered)
	const retrying = useStore(recordings, s => s.retrying)
	const removing = useStore(recordings.marks, m => m.removing)
	const tokens = useStore(recordingsUi, s => s.tokens)
	const text = useStore(recordingsUi, s => s.text)
	const filter = useStore(recordingsUi, s => s.filter)
	const openId = useStore(recordingsUi, s => s.openId)
	const cursorId = useStore(recordingsUi, s => s.cursorId)
	// playing from this list holds its arrivals: its row does not move under the ear
	const playing = useStore(
		player,
		s => s.id !== null && s.queue?.source === "recordings",
	)
	const [kb, setKb] = useState(false)
	const visible = useMemo(
		() => visibleRecordings(items, removing),
		[items, removing],
	)
	// the list as shown is the queue Next and Auto-next follow while it is the one played from
	const queue = useMemo(() => recordingsQueue(visible), [visible])
	const queueRef = useRef(queue)
	queueRef.current = queue
	useEffect(() => {
		player.setQueue("recordings", queue.ids, queue.titles)
	}, [player, queue])
	const actions = useActions(player, queueRef)
	// the day labels follow the clock; a minute is fine for "Today"
	const [now, setNow] = useState(() => new Date())
	useEffect(() => {
		const t = setInterval(() => setNow(new Date()), 60_000)
		return () => clearInterval(t)
	}, [])
	const display = useDisplay()
	const entries = useMemo(
		() => dayEntries(visible, now),
		[visible, now, display], // day groups follow the time setting
	)
	const keys = useMemo(() => entries.map(e => e.key), [entries])
	const rowIndex = useMemo(() => {
		const m = new Map<string, number>()
		entries.forEach((e, i) => {
			if (e.type === "row") m.set(e.item.id, i)
		})
		return m
	}, [entries])
	// roving focus: the cursor row (else the first) is the list's one tab stop; it and the focused row stay
	// mounted wherever the scroll is, so focus never falls to the page
	const tabId =
		cursorId !== null && rowIndex.has(cursorId)
			? cursorId
			: (visible[0]?.id ?? null)
	const [focusedId, setFocusedId] = useState<string | null>(null)
	const keep = useMemo(() => {
		const out: number[] = []
		for (const id of [tabId, focusedId]) {
			const i = id === null ? undefined : rowIndex.get(id)
			if (i !== undefined) out.push(i)
		}
		return out
	}, [tabId, focusedId, rowIndex])
	const searchKey = useStore(recordings, s => s.key)
	const virtual = useVirtualRows({
		keys,
		keep,
		restoreKey: `recordings:${searchKey ?? ""}`,
		estimate: i => {
			const e = entries[i]
			if (!e) return 0
			if (e.type === "day") return DAY_PX
			return e.item.id === openId ? OPEN_PX : ROW_PX
		},
		onScroll: el => recordings.setHolding(el.scrollTop > HOLD_PX || playing),
		onNearEnd: () => void recordings.loadMore(),
	})
	const { scroller, measure, win, viewport } = virtual
	// something playing holds arrivals too: its row does not move under the ear
	useEffect(() => {
		const top = scroller.current?.scrollTop ?? 0
		recordings.setHolding(top > HOLD_PX || playing)
	}, [playing, recordings, scroller])
	// a new search starts at the top; the same search opened again is where it was left
	const toTopOf = virtual.toTop
	const shownKey = useRef(searchKey)
	useEffect(() => {
		if (shownKey.current === searchKey) return
		shownKey.current = searchKey
		toTopOf()
	}, [searchKey, toTopOf])
	// a keyboard move focuses the row it lands on (mounted: it is the tab stop, kept)
	const focusNext = useRef<string | null>(null)
	useEffect(() => {
		const id = focusNext.current
		if (id === null || id !== cursorId) return
		focusNext.current = null
		document.getElementById(rowDomId(id))?.focus({ preventScroll: true })
	})
	// a list shorter than the viewport asks for the next page by itself
	useEffect(() => {
		if (
			status === "ready" &&
			more &&
			!loadingMore &&
			!capped &&
			win.total < viewport + 600
		)
			void recordings.loadMore()
	}, [status, more, loadingMore, capped, win.total, viewport, recordings])

	const reveal = (id: string) => {
		const i = rowIndex.get(id)
		if (i !== undefined) virtual.reveal(i)
	}
	// the player's title asks for its row
	// each request is served once (the row may load later: it is served when it does)
	const asked = useStore(revealRequest)
	const served = useRef(revealRequest.get()?.n ?? 0)
	const revealRow = virtual.reveal
	useEffect(() => {
		if (asked === null || asked.n === served.current) return
		const i = rowIndex.get(asked.id)
		if (i === undefined) return
		served.current = asked.n
		revealRow(i)
	}, [asked, rowIndex, revealRow])

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const target = e.target as HTMLElement
		// a row's ⋯ menu owns its keys: arrows, Delete, Backspace or S there never act on the list
		if (target.closest("[role=menu]") !== null) return
		const i = visible.findIndex(r => r.id === cursorId)
		const cur = visible[i]
		const p = player.get()
		const action = listKeyAction(
			{
				key: e.key,
				metaKey: e.metaKey,
				ctrlKey: e.ctrlKey,
				altKey: e.altKey,
				inField: target.tagName === "INPUT" || target.tagName === "TEXTAREA",
				inControl: target.closest("button, a, input") !== null,
			},
			{
				cursor: cur !== undefined,
				open: openId !== null,
				loaded: p.id !== null,
				readOnly,
				deletable: cur !== undefined && deleteBlocker(cur) === null,
			},
		)
		if (action === null) return
		switch (action.type) {
			case "move": {
				const n =
					visible[
						Math.max(0, Math.min(visible.length - 1, i < 0 ? 0 : i + action.by))
					]
				if (!n) return
				e.preventDefault()
				setKb(true)
				focusNext.current = n.id
				if (openId !== null) openRow(n.id)
				else setCursor(n.id)
				reveal(n.id)
				return
			}
			case "play":
				e.preventDefault()
				if (cur) actions.play(cur)
				return
			case "toggle-open":
				e.preventDefault()
				if (cur) openRow(openId === cur.id ? null : cur.id)
				return
			case "close":
				e.preventDefault()
				e.stopPropagation()
				openRow(null)
				return
			case "player-toggle":
				e.preventDefault()
				player.toggle()
				return
			case "seek":
				e.preventDefault()
				player.seek(p.pos + action.by * SCRUB_S)
				return
			case "keep":
				e.preventDefault()
				if (cur) actions.keep(cur)
				return
			case "delete":
				e.preventDefault()
				if (cur) actions.remove(cur, visible)
				return
		}
	}

	const view = panelView({
		status,
		busy,
		rows: visible.length,
		answered,
		error,
		truncated: meta?.truncated === true,
		capped,
		indexing: meta?.indexing === true,
	})
	const noticeKind = view.notice
	const notice =
		noticeKind === null ? null : (
			<PanelNotice
				tone={
					noticeKind === "error" || noticeKind === "busy" ? "warn" : undefined
				}
				action={
					noticeKind === "error"
						? {
								label: "Try again",
								run: () => void recordings.retry(),
								busy: retrying,
							}
						: undefined
				}
			>
				{noticeText(noticeKind, {
					error,
					asOf,
					scanned: meta?.scannedFiles ?? 0,
					indexed: meta?.counts?.total ?? meta?.scannedFiles ?? 0,
				})}
			</PanelNotice>
		)

	if (view.body === "skeleton")
		return (
			<>
				<PanelNotice />
				<PanelLoading label="recordings" busy={view.busy} round />
			</>
		)
	if (view.body === "error")
		return (
			<>
				<PanelNotice />
				<PanelFailed
					icon={<RecIcon name="refresh" size={22} />}
					title="Could not read recordings"
					text={error ?? "WaveKit did not answer."}
					retryAt={retryAt}
					retrying={retrying}
					onRetry={() => void recordings.retry()}
				/>
			</>
		)
	const searching = tokens.length > 0 || text.trim() !== ""
	// what the search matches, less what waits for Undo here
	const total =
		meta?.matched === null || meta?.matched === undefined
			? null
			: Math.max(visible.length, meta.matched - removing.size)
	return (
		<>
			{notice ?? <PanelNotice />}
			{view.body === "empty" ? (
				meta?.indexing === true ? (
					<Empty
						icon="voice"
						title="Indexing recordings"
						text="WaveKit is reading the recordings on disk. They show up here as it finds them, newest first."
					/>
				) : searching ? (
					<Empty
						icon="voice"
						title="Nothing matches"
						text={
							filter === "kept"
								? "Only kept recordings are searched. Show All to search everything."
								: "Try a talkgroup, a radio id or a frequency."
						}
						action={{ label: "Clear search", run: clearSearch }}
					/>
				) : filter === "kept" ? (
					<Empty
						icon="star"
						title="Nothing kept yet"
						text="Keep a recording with the star or S and no retention rule ever deletes it."
						action={{ label: "Show all", run: () => setFilter("all") }}
					/>
				) : (
					<Empty
						icon="voice"
						title="No recordings yet"
						text="WaveKit records digital voice calls and scanner evidence on its own. They show up here, newest first."
					/>
				)
			) : (
				<div className="wkr-listwrap">
					{heldNew > 0 && (
						<button
							type="button"
							className="wkr-newpill"
							title="Show the new recordings at the top"
							onClick={() => {
								recordings.release()
								virtual.toTop()
								recordings.setHolding(playing)
							}}
						>
							↑ {countText(heldNew)} new
						</button>
					)}
					<div
						ref={scroller}
						className="wkr-list wk-scroll"
						role="list"
						aria-label="Recordings"
						aria-busy={view.progress || undefined}
						onScroll={virtual.onScroll}
						onKeyDown={onKeyDown}
						onPointerDown={() => setKb(false)}
						onFocus={e => {
							const row = (e.target as HTMLElement).closest<HTMLElement>(
								"[data-row-id]",
							)
							setFocusedId(row?.dataset["rowId"] ?? null)
						}}
						onBlur={e => {
							if (!e.currentTarget.contains(e.relatedTarget as Node | null))
								setFocusedId(null)
						}}
					>
						<div style={{ height: win.total, position: "relative" }}>
							<div
								className="wkr-window"
								style={{ transform: `translateY(${win.offset}px)` }}
							>
								{entries.slice(win.start, win.end).map(e =>
									e.type === "day" ? (
										<div
											key={e.key}
											data-key={e.key}
											ref={measure}
											role="presentation"
											className="wk-label wkr-day-label"
											data-strong=""
										>
											{e.label}
										</div>
									) : (
										<Row
											key={e.key}
											entryKey={e.key}
											measure={measure}
											item={e.item}
											setSize={total ?? visible.length}
											position={e.position}
											open={openId === e.item.id}
											tabStop={tabId === e.item.id}
											cursor={kb && cursorId === e.item.id}
											readOnly={readOnly}
											actions={actions}
											list={visible}
										/>
									),
								)}
							</div>
							{virtual.kept.map(k => {
								const e = entries[k.index]
								if (e?.type !== "row") return null
								return (
									<div
										key={`kept:${e.key}`}
										className="wkr-kept-row"
										style={{ top: k.top }}
									>
										<Row
											entryKey={e.key}
											measure={measure}
											item={e.item}
											setSize={total ?? visible.length}
											position={e.position}
											open={openId === e.item.id}
											tabStop={tabId === e.item.id}
											cursor={kb && cursorId === e.item.id}
											readOnly={readOnly}
											actions={actions}
											list={visible}
										/>
									</div>
								)
							})}
						</div>
						<ListFoot />
					</div>
				</div>
			)}
		</>
	)
}

/** The end of the list: loading the next page, or a failed one with Try again. */
function ListFoot() {
	const recordings = useServices().data.recordings
	const loadingMore = useStore(recordings, s => s.loadingMore)
	const failed = useStore(
		recordings,
		s => s.status === "ready" && s.error !== null && s.nextCursor !== null,
	)
	if (loadingMore) return <p className="wkr-foot">Loading older recordings…</p>
	if (failed)
		return (
			<p className="wkr-foot">
				Could not load older recordings.{" "}
				<button
					type="button"
					className="wkr-link"
					onClick={() => void recordings.loadMore()}
				>
					Try again
				</button>
			</p>
		)
	return null
}

const rowDomId = (id: string) => `wkr-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`

interface Actions {
	/** The list it plays from, as shown now. */
	queue(): QueueRef
	play(r: RecordingInventoryItem): void
	keep(r: RecordingInventoryItem): void
	remove(
		r: RecordingInventoryItem,
		list: readonly RecordingInventoryItem[],
	): void
	tune(hz: number): void
	/** The row's one channel link: Activity on its channel (or talkgroup), nothing opened over it. */
	channel(r: RecordingInventoryItem): void
	/** Scanner on the discovery that owns it; a toast when the core cannot give it. */
	scanner(discoveryId: string): void
	/** The Transmission view of this recording, in this drawer. */
	details(r: RecordingInventoryItem): void
}

function useActions(
	player: PlaybackService,
	queue: { current: QueueRef },
): Actions {
	const services = useServices()
	const recordings = services.data.recordings
	return useMemo<Actions>(
		() => ({
			queue: () => queue.current,
			play(r) {
				const id = playbackIdOf(r)
				if (player.get().id === id) player.toggle()
				else player.play(id, queue.current, 0, recordingTitle(r))
			},
			keep(r) {
				const kept = r.kept !== true
				recordings
					.setKept(r.id, kept)
					.catch((error: unknown) =>
						showAppToast(
							`Could not ${kept ? "keep" : "unkeep"} “${recordingTitle(r)}”: ${errorMessage(error)}`,
							{ tone: "warn" },
						),
					)
			},
			remove(r, list) {
				const i = list.findIndex(x => x.id === r.id)
				const neighbour = list[i + 1] ?? list[i - 1] ?? null
				const ui = recordingsUi.get()
				if (ui.openId === r.id) openRow(neighbour?.id ?? null)
				else if (ui.cursorId === r.id) setCursor(neighbour?.id ?? null)
				player.forget(playbackIdOf(r))
				const title = recordingTitle(r)
				const undo = recordings.scheduleRemove(r.id, error =>
					showAppToast(`Could not delete “${title}”: ${errorMessage(error)}`, {
						tone: "warn",
					}),
				)
				showAppToast(`Deleted “${title}”`, {
					undo: () => {
						undo()
						openRow(r.id)
					},
				})
			},
			tune(hz) {
				void services.tuning.tune(hz)
			},
			channel(r) {
				// the channel's list only: this transmission is Details, never opened over the list
				if (r.frequencyHz !== null)
					showChannel(
						services.activity,
						r.frequencyHz,
						tuningStep(services.data.bandplan.get().view, r.frequencyHz),
					)
				else if (r.talkgroup) {
					services.activity.setSearch(
						[activityToken("talkgroup", r.talkgroup)],
						null,
					)
					shellStore.openDrawer("activity")
				}
			},
			scanner(discoveryId) {
				void openInScanner(discoveryId, services.data.scanner)
			},
			details(r) {
				openTransmission(
					{ recording: r.key ?? r.id },
					{ host: "recordings", label: "Recordings" },
				)
			},
		}),
		[player, queue, recordings, services],
	)
}

interface RowProps {
	/** The virtual list's entry key (`data-key`, measured once). */
	entryKey: string
	measure: (el: HTMLElement | null) => void
	/** aria-setsize: every recording the search matches (the core's count), not only those loaded. */
	setSize: number
	/** aria-posinset, from 1. */
	position: number
	/** The list's one tab stop (roving focus). */
	tabStop: boolean
	item: RecordingInventoryItem
	open: boolean
	cursor: boolean
	readOnly: boolean
	actions: Actions
	list: readonly RecordingInventoryItem[]
}

const Row = memo(function Row({
	entryKey,
	measure,
	setSize,
	position,
	tabStop,
	item: r,
	open,
	cursor,
	readOnly,
	actions,
	list,
}: RowProps) {
	useDisplay() // the time follows Settings › Display
	useSavedNames() // a saved name renames the row's title and its channel link
	const pid = playbackIdOf(r)
	const phase = usePlaybackMark(pid)
	const recordings = useServices().data.recordings
	const keeping = useStore(recordings.marks, m => m.keeping.has(r.id))
	const title = recordingTitle(r)
	const icon = recordingIcon(r)
	const at = recordedAt(r)
	const kept = r.kept === true
	const toggleOpen = () => openRow(open ? null : r.id)
	return (
		<article
			id={rowDomId(r.id)}
			ref={measure}
			data-key={entryKey}
			className="wkr-item"
			role="listitem"
			aria-label={title}
			aria-setsize={setSize}
			aria-posinset={position}
			tabIndex={tabStop ? 0 : -1}
			data-row-id={r.id}
			data-open={open || undefined}
			data-current={phase !== null || undefined}
			data-kb-cursor={cursor || undefined}
		>
			<div className="wkr-item-top">
				<button
					type="button"
					className="wk-row wkr-row"
					aria-expanded={open}
					onClick={toggleOpen}
				>
					<span className="wk-tile" data-tone="accent">
						<RecIcon name={icon} />
					</span>
					<span className="wkr-row-main">
						<span className="wkr-row-line">
							<span className="wkr-title">{title}</span>
							{kept && (
								<span
									className="wkr-kept"
									title="Kept: no retention rule deletes it"
								>
									<RecIcon name="star" size={12} filled />
								</span>
							)}
							<span className="wkr-gap" />
							<span className="wkr-time">{timeLabel(at)}</span>
							{open && (
								<RecIcon name="chevron-up" size={15} className="wkr-chev" />
							)}
						</span>
						<span className="wkr-meta">{recordingMeta(r)}</span>
					</span>
				</button>
				<PlayDisc
					id={pid}
					title={title}
					durationMs={r.durationMs}
					queue={actions.queue}
				/>
			</div>
			{open && (
				<div className="wkr-detail">
					<WaveView
						id={pid}
						title={title}
						durationMs={r.durationMs}
						queue={actions.queue}
					/>
					<RowActions
						item={r}
						title={title}
						playing={phase === "playing" || phase === "loading"}
						kept={kept}
						keeping={keeping}
						readOnly={readOnly}
						fileUrl={recordings.fileUrl(r.id)}
						actions={actions}
						list={list}
					/>
				</div>
			)}
		</article>
	)
})

/** The channel link's words: "History of Club net", "History of 145.6125", "History of TG 2081". */
export function channelLinkLabel(r: RecordingInventoryItem): string | null {
	if (r.frequencyHz !== null) return historyLabel(r.frequencyHz)
	if (r.talkgroup) return `History of TG ${r.talkgroup}`
	return null
}

/**
 * An open row's actions (Recordings board, design "same order everywhere"): Play, Keep, Details, ⋯ (Download,
 * Tune, Open in Scanner, Delete) and one channel link.
 */
function RowActions({
	item: r,
	title,
	playing,
	kept,
	keeping,
	readOnly,
	fileUrl,
	actions,
	list,
}: {
	item: RecordingInventoryItem
	title: string
	playing: boolean
	kept: boolean
	keeping: boolean
	readOnly: boolean
	fileUrl: string
	actions: Actions
	list: readonly RecordingInventoryItem[]
}) {
	const [menu, setMenu] = useState(false)
	const moreRef = useRef<HTMLButtonElement>(null)
	const link = channelLinkLabel(r)
	const owner = r.ownerDiscoveryId ?? r.discoveryId
	const blocker = deleteBlocker(r)
	return (
		<div className="wkr-actions">
			<button
				type="button"
				className="wk-btn"
				data-variant="outline"
				aria-label={`${playing ? "Pause" : "Play"} ${title}`}
				onClick={() => actions.play(r)}
			>
				<PlayGlyph playing={playing} />
				{playing ? "Pause" : "Play"}
			</button>
			<button
				type="button"
				className="wk-btn"
				data-variant="outline"
				aria-pressed={kept}
				disabled={readOnly || keeping}
				title={
					kept
						? "Kept: retention never deletes it. Click to unkeep (S)"
						: "Keep: protect it from every retention rule (S)"
				}
				onClick={() => actions.keep(r)}
			>
				<RecIcon name="star" size={15} filled={kept} />
				{kept ? "Kept" : "Keep"}
			</button>
			<button
				type="button"
				className="wk-btn"
				data-variant="outline"
				title="Everything known about this transmission"
				onClick={() => actions.details(r)}
			>
				Details
			</button>
			<span className="wkr-more">
				<button
					ref={moreRef}
					type="button"
					className="wk-btn"
					data-variant="outline"
					aria-label="More actions"
					aria-haspopup="menu"
					aria-expanded={menu}
					title="Download, tune, open in Scanner, delete"
					onClick={() => setMenu(m => !m)}
				>
					<Icon name="dots" size={15} />
				</button>
				{menu && (
					<RowMenu
						onClose={refocus => {
							setMenu(false)
							if (refocus) moreRef.current?.focus()
						}}
					>
						<a
							role="menuitem"
							className="wk-option"
							href={fileUrl}
							download
							title="The whole WAV file"
						>
							<RecIcon name="download" size={16} />
							<span className="wkf-grow">Download WAV</span>
							<span className="wkf-menu-hint">{formatBytes(r.bytes)}</span>
						</a>
						{r.frequencyHz !== null && (
							<button
								type="button"
								role="menuitem"
								className="wk-option"
								onClick={() => actions.tune(rasterHz(r.frequencyHz ?? 0))}
							>
								<RecIcon name="tune" size={16} />
								<span className="wkf-grow">
									Tune to {channelMHz(r.frequencyHz)}
								</span>
							</button>
						)}
						{owner !== null && (
							<button
								type="button"
								role="menuitem"
								className="wk-option"
								title="This channel's discovery in the Scanner"
								onClick={() => actions.scanner(owner)}
							>
								<RecIcon name="scan" size={16} />
								<span className="wkf-grow">Open in Scanner</span>
							</button>
						)}
						{!readOnly && (
							<button
								type="button"
								role="menuitem"
								className="wk-option wkr-delete"
								aria-disabled={blocker !== null || undefined}
								title={blocker ?? "Delete the file (Undo for a few seconds)"}
								onClick={() => {
									if (blocker !== null) showAppToast(blocker)
									else actions.remove(r, list)
								}}
							>
								<RecIcon name="trash" size={16} />
								<span className="wkf-grow">Delete</span>
							</button>
						)}
					</RowMenu>
				)}
			</span>
			{link !== null && (
				<button
					type="button"
					className="wk-btn wkr-channel"
					data-variant="ghost"
					title="What was heard on this channel, in Activity"
					onClick={() => actions.channel(r)}
				>
					<RecIcon name="activity" size={15} />
					{link}
				</button>
			)}
		</div>
	)
}

/** What a key does inside the ⋯ menu: move focus to a row, close it, or nothing the menu owns. */
export type RowMenuKey =
	| { type: "focus"; index: number }
	| { type: "close"; refocus: boolean }
	| null

/** The ⋯ menu's keys: arrows wrap, Home and End jump, Esc closes onto ⋯, Tab closes as focus moves on. */
export function rowMenuKey(key: string, at: number, count: number): RowMenuKey {
	if (key === "Escape") return { type: "close", refocus: true }
	if (key === "Tab") return { type: "close", refocus: false }
	if (count === 0) return null
	if (key === "ArrowDown" || key === "ArrowUp") {
		const by = key === "ArrowDown" ? 1 : -1
		const from = at < 0 ? (by > 0 ? -1 : 0) : at
		return { type: "focus", index: (from + by + count) % count }
	}
	if (key === "Home") return { type: "focus", index: 0 }
	if (key === "End") return { type: "focus", index: count - 1 }
	return null
}

/**
 * When a chosen row closes the menu: a link (Download WAV) only after its click has run, since unmounting it
 * mid-click cancels the download; any other row at once.
 */
export function rowMenuCloseTiming(
	el: Pick<Element, "tagName">,
): "now" | "after" {
	return el.tagName === "A" ? "after" : "now"
}

/**
 * The ⋯ menu (ui.css `wk-menu`): focus starts on its first row, arrows, Home and End move, Esc, Tab, focus leaving
 * or a press outside closes. Every key pressed inside stays inside: the list's shortcuts never see it.
 */
function RowMenu({
	onClose,
	children,
}: {
	onClose: (refocus: boolean) => void
	children: ReactNode
}) {
	const ref = useRef<HTMLDivElement>(null)
	// a press inside (Safari does not focus a pressed button) is not focus leaving
	const pressing = useRef(false)
	useEffect(() => {
		ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus()
	}, [])
	useEffect(() => {
		const away = (e: PointerEvent) => {
			if (!ref.current?.parentElement?.contains(e.target as Node))
				onClose(false)
		}
		const up = () => {
			pressing.current = false
		}
		document.addEventListener("pointerdown", away)
		document.addEventListener("pointerup", up)
		return () => {
			document.removeEventListener("pointerdown", away)
			document.removeEventListener("pointerup", up)
		}
	}, [onClose])
	return (
		<div
			ref={ref}
			role="menu"
			aria-label="More actions"
			className="wk-menu wkf-card-menu wkr-more-menu"
			onPointerDown={() => {
				pressing.current = true
			}}
			onClick={e => {
				const item = (e.target as Element).closest("[role=menuitem]")
				if (!item) return
				if (rowMenuCloseTiming(item) === "after")
					window.setTimeout(() => onClose(true), 0)
				else onClose(true)
			}}
			onBlur={e => {
				const next = e.relatedTarget as Node | null
				if (pressing.current) return
				if (next !== null && ref.current?.parentElement?.contains(next)) return
				onClose(false)
			}}
			onKeyDown={e => {
				e.stopPropagation()
				const items = [
					...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ??
						[]),
				]
				const at = items.indexOf(document.activeElement as HTMLElement)
				const action = rowMenuKey(e.key, at, items.length)
				if (action === null) return
				if (action.type === "focus") {
					e.preventDefault()
					items[action.index]?.focus()
				} else if (action.refocus) {
					e.preventDefault()
					onClose(true)
				}
				// Tab: focus moves on by default and the menu closes as it leaves (onBlur)
			}}
		>
			{children}
		</div>
	)
}

// ---- footer

function Footer() {
	const services = useServices()
	const storage = useStore(services.data.system, s => s.storage)
	const kept = useStore(
		services.data.recordings,
		s => s.meta?.counts?.kept ?? null,
	)
	const unavailable = useStore(services.data.recordings, recordingsUnavailable)
	if (unavailable !== null) return null
	const low = storage?.lowSpace.state === "low"
	return (
		<footer className="wkr-footer" data-tone={low ? "warn" : undefined}>
			<span className="wkr-footer-text">
				{low
					? "Low on space: scanner recordings stop until some is freed · "
					: ""}
				{storageLine(storage, kept)}
			</span>
			<button
				type="button"
				className="wkr-link"
				onClick={() => {
					void services.data.recordings.retry()
					void services.data.system.load()
				}}
				title="Read the list again"
				aria-label="Refresh recordings"
			>
				<RecIcon name="refresh" size={14} />
			</button>
		</footer>
	)
}
