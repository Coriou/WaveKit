import "./recordings.css"

// The Recordings drawer (Recordings board), on the core's recordings catalogue (WG8 inventory, WG9 Keep and
// delete): header "Recordings · count · All / Kept" with the core's counts, typed-chip search run by the core,
// one notice slot, the virtual list of rows grouped by day (only what is on screen is mounted; older pages
// load at the end; open in place: waveform, Keep, Download, Tune, Show in Activity or Scanner, Delete with
// Undo), the player bar and the storage footer. The list follows the catalogue's `recordings` socket notices;
// arrivals hold while it is scrolled or playing ("N new"). Names, notes, trim, transcripts, IQ captures and
// Opus downloads wait for the core (CORE-GAPS "Recordings").
import { memo, useEffect, useMemo, useRef, useState } from "react"
import type {
	KeyboardEvent as ReactKeyboardEvent,
	PointerEvent as ReactPointerEvent,
} from "react"
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
import { openDiscovery } from "../scanner/ui-store.ts"
import { formatMHz } from "../format.ts"
import { PlayGlyph, RecIcon } from "./icons.tsx"
import { listKeyAction } from "./keys.ts"
import {
	countText,
	dayEntries,
	deleteBlocker,
	formatBytes,
	formatDuration,
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
import { RecordingPlayer, WAVE_BARS } from "./player.ts"
import type { RecFilter } from "./ui-store.ts"
import {
	addToken,
	clearSearch,
	openRow,
	recordingsUi,
	removeToken,
	setCursor,
	setFilter,
	requestReveal,
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

	// the list as shown, read by the player's auto-advance
	const order = useRef<readonly RecordingInventoryItem[]>([])
	const player = useMemo(
		() =>
			new RecordingPlayer({
				fetchFile: id => recordings.file(id),
				holdLive: held => services.listen.hold(held),
				nextOf: id => {
					const list = order.current
					const i = list.findIndex(r => r.id === id)
					return i >= 0 ? (list[i + 1]?.id ?? null) : null
				},
			}),
		[recordings, services.listen],
	)
	useEffect(() => () => player.dispose(), [player])

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
			actions={<HeaderActions usable={unavailable === null} />}
		>
			{unavailable === "protected-only" ? (
				<Empty
					icon="lock"
					title="Recordings need access protection"
					text="This WaveKit runs without access protection, and the core lists recordings only when it is on. Turn on access in the WaveKit config to list, play and keep them here."
				/>
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
					<List player={player} order={order} readOnly={readOnly} />
					<PlayerBar player={player} order={order} />
				</>
			)}
			<Footer />
		</Drawer>
	)
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

function List({
	player,
	order,
	readOnly,
}: {
	player: RecordingPlayer
	order: { current: readonly RecordingInventoryItem[] }
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
	const playing = useStore(player, s => s.id !== null)
	const [kb, setKb] = useState(false)
	const actions = useActions(player)
	const visible = useMemo(
		() => visibleRecordings(items, removing),
		[items, removing],
	)
	order.current = visible
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
											player={player}
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
											player={player}
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
	play(r: RecordingInventoryItem): void
	keep(r: RecordingInventoryItem): void
	remove(
		r: RecordingInventoryItem,
		list: readonly RecordingInventoryItem[],
	): void
	tune(hz: number): void
	inActivity(r: RecordingInventoryItem): void
	inScanner(discoveryId: string): void
}

function useActions(player: RecordingPlayer): Actions {
	const services = useServices()
	const recordings = services.data.recordings
	return useMemo<Actions>(
		() => ({
			play(r) {
				const p = player.get()
				if (p.id === r.id) player.toggle()
				else void player.play(r.id)
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
				player.forget(r.id)
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
			inActivity(r) {
				if (r.talkgroup)
					services.activity.setSearch(
						[activityToken("talkgroup", r.talkgroup)],
						null,
					)
				else if (r.frequencyHz !== null) {
					services.activity.showFrequency(r.frequencyHz)
					return
				} else return
				shellStore.openDrawer("activity")
			},
			inScanner(discoveryId) {
				openDiscovery(discoveryId)
				shellStore.openDrawer("scanner")
			},
		}),
		[player, recordings, services],
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
	player: RecordingPlayer
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
	player,
	readOnly,
	actions,
	list,
}: RowProps) {
	useDisplay() // the time follows Settings › Display
	const phase = useStore(player, s => (s.id === r.id ? s.phase : null))
	const recordings = useServices().data.recordings
	const keeping = useStore(recordings.marks, m => m.keeping.has(r.id))
	const title = recordingTitle(r)
	const icon = recordingIcon(r)
	const at = recordedAt(r)
	const playing = phase === "playing" || phase === "loading"
	const kept = r.kept === true
	const dur = r.durationMs !== null ? formatDuration(r.durationMs / 1000) : "–"
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
						{phase !== null && !open && <MiniBar player={player} />}
					</span>
				</button>
				<button
					type="button"
					className="wkr-play"
					data-state={
						phase === "playing"
							? "playing"
							: phase !== null
								? "current"
								: undefined
					}
					aria-label={`${phase === "playing" ? "Pause" : "Play"} ${title}`}
					title={phase === "playing" ? "Pause" : "Play"}
					onClick={() => actions.play(r)}
				>
					<span className="wkr-play-disc">
						{phase === "loading" ? (
							<span className="wk-spinner" aria-hidden="true" />
						) : (
							<PlayGlyph playing={playing} />
						)}
					</span>
					<span className="wkr-dur">{dur}</span>
				</button>
			</div>
			{open && (
				<div className="wkr-detail">
					<Strip item={r} player={player} />
					<div className="wkr-actions">
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
						<a
							className="wk-btn"
							data-variant="outline"
							href={recordings.fileUrl(r.id)}
							download
							title="The whole WAV file"
						>
							<RecIcon name="download" size={15} />
							WAV · {formatBytes(r.bytes)}
						</a>
						{r.frequencyHz !== null && (
							<button
								type="button"
								className="wk-btn"
								data-variant="outline"
								onClick={() => actions.tune(r.frequencyHz ?? 0)}
							>
								<RecIcon name="tune" size={15} />
								Tune to {formatMHz(r.frequencyHz)}
							</button>
						)}
						{(r.talkgroup !== null || r.frequencyHz !== null) && (
							<button
								type="button"
								className="wk-btn"
								data-variant="outline"
								title={
									r.talkgroup
										? `What was heard on talkgroup ${r.talkgroup}`
										: "What was heard on this frequency"
								}
								onClick={() => actions.inActivity(r)}
							>
								<RecIcon name="activity" size={15} />
								Show in Activity
							</button>
						)}
						{r.discoveryId !== null && (
							<button
								type="button"
								className="wk-btn"
								data-variant="outline"
								onClick={() => actions.inScanner(r.discoveryId ?? "")}
							>
								<RecIcon name="scan" size={15} />
								Show in Scanner
							</button>
						)}
						{!readOnly && (
							<DeleteButton item={r} actions={actions} list={list} />
						)}
					</div>
				</div>
			)}
		</article>
	)
})

function DeleteButton({
	item,
	actions,
	list,
}: {
	item: RecordingInventoryItem
	actions: Actions
	list: readonly RecordingInventoryItem[]
}) {
	const blocker = deleteBlocker(item)
	return (
		<button
			type="button"
			className="wk-btn wkr-delete"
			data-variant="outline"
			aria-disabled={blocker !== null || undefined}
			title={blocker ?? "Delete the file (Undo for a few seconds)"}
			onClick={() => {
				if (blocker !== null) showAppToast(blocker)
				else actions.remove(item, list)
			}}
		>
			<RecIcon name="trash" size={15} />
			Delete
		</button>
	)
}

function MiniBar({ player }: { player: RecordingPlayer }) {
	const pct = useStore(player, s =>
		s.duration ? Math.min(100, (s.pos / s.duration) * 100) : 0,
	)
	return (
		<span className="wkr-mini" aria-hidden="true">
			<span style={{ width: `${pct}%` }} />
		</span>
	)
}

/** The waveform: click (or drag) to play from there; the playhead follows playback. */
function Strip({
	item,
	player,
}: {
	item: RecordingInventoryItem
	player: RecordingPlayer
}) {
	const peaks = useStore(player.peaks, m => m.get(item.id))
	const current = useStore(player, s => s.id === item.id)
	const frac = useStore(player, s =>
		s.id === item.id && s.duration ? Math.min(1, s.pos / s.duration) : 0,
	)
	useEffect(() => {
		void player.loadPeaks(item.id)
	}, [player, item.id])
	const total = item.durationMs !== null ? item.durationMs / 1000 : null
	const seekAt = (e: ReactPointerEvent<HTMLDivElement>) => {
		const rect = e.currentTarget.getBoundingClientRect()
		const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
		const d =
			player.get().id === item.id ? (player.get().duration ?? total) : total
		if (d === null) return
		if (player.get().id === item.id) {
			player.seek(f * d)
			if (player.get().phase !== "playing") player.resume()
		} else void player.play(item.id, f * d)
	}
	const bars = Array.isArray(peaks) ? peaks : null
	const w = 600 / WAVE_BARS
	return (
		<div className="wkr-strip-wrap">
			<div
				className="wkr-strip"
				title="Click to play from here"
				onPointerDown={e => {
					e.currentTarget.setPointerCapture(e.pointerId)
					seekAt(e)
				}}
				onPointerMove={e => {
					if (e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId))
						seekAt(e)
				}}
			>
				<svg
					width="100%"
					height="100%"
					viewBox="0 0 600 100"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					{bars ? (
						bars.map((p, i) => {
							const h = Math.max(3, p * 84)
							const played = current && (i + 0.5) / WAVE_BARS <= frac
							return (
								<rect
									key={i}
									x={(i * w + w * 0.18).toFixed(1)}
									y={(50 - h / 2).toFixed(1)}
									width={(w * 0.64).toFixed(1)}
									height={h.toFixed(1)}
									className={played ? "wkr-bar is-played" : "wkr-bar"}
								/>
							)
						})
					) : (
						<rect x="0" y="49" width="600" height="2" className="wkr-bar" />
					)}
				</svg>
				{current && (
					<div className="wkr-head" style={{ left: `${frac * 100}%` }} />
				)}
				{peaks === undefined && (
					<span className="wkr-strip-note">Loading waveform…</span>
				)}
			</div>
			<div className="wkr-strip-times">
				<span>0:00</span>
				<span>{total !== null ? formatDuration(total) : ""}</span>
			</div>
		</div>
	)
}

// ---- player bar

function PlayerBar({
	player,
	order,
}: {
	player: RecordingPlayer
	order: { current: readonly RecordingInventoryItem[] }
}) {
	useDisplay()
	const id = useStore(player, s => s.id)
	const phase = useStore(player, s => s.phase)
	const pos = useStore(player, s => Math.floor(s.pos * 4) / 4)
	const duration = useStore(player, s => s.duration)
	const speed = useStore(player, s => s.speed)
	const error = useStore(player, s => s.error)
	const services = useServices()
	const items = useStore(services.data.recordings, s => s.items)
	const liveWanted = useStore(services.listen, s => s.wanted)
	if (id === null) return null
	const item = items.find(r => r.id === id)
	const list = order.current
	const i = list.findIndex(r => r.id === id)
	const prev = i > 0 ? list[i - 1] : undefined
	const next = i >= 0 ? list[i + 1] : undefined
	const d = duration ?? (item?.durationMs != null ? item.durationMs / 1000 : 0)
	const title = item ? recordingTitle(item) : "Recording"
	const playing = phase === "playing"
	return (
		<div className="wkr-player" role="region" aria-label="Player">
			<div className="wkr-player-row">
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Previous"
					disabled={!prev && pos < 0.5}
					onClick={() => {
						if (player.get().pos > 2 || !prev) player.seek(0)
						else void player.play(prev.id)
					}}
				>
					<RecIcon name="prev" size={14} />
				</button>
				<button
					type="button"
					className="wkr-player-play"
					aria-label={playing ? "Pause" : "Play"}
					onClick={() => player.toggle()}
				>
					{phase === "loading" ? (
						<span className="wk-spinner" aria-hidden="true" />
					) : (
						<PlayGlyph playing={playing} size={13} />
					)}
				</button>
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Next"
					disabled={!next}
					onClick={() => next && void player.play(next.id)}
				>
					<RecIcon name="next" size={14} />
				</button>
				<button
					type="button"
					className="wkr-player-title"
					title="Show it in the list"
					onClick={() => {
						openRow(id)
						requestReveal(id)
					}}
				>
					<span className="wkr-player-name">{title}</span>
					<span
						className="wkr-player-sub"
						data-tone={error ? "warn" : undefined}
					>
						{error ??
							[
								item ? timeLabel(recordedAt(item)) : null,
								liveWanted ? "live audio muted" : null,
							]
								.filter(Boolean)
								.join(" · ")}
					</span>
				</button>
				<span className="wkr-player-time">
					{formatDuration(pos)} / {formatDuration(d)}
				</span>
				<button
					type="button"
					className="wk-chip"
					data-size="sm"
					title="Playback speed"
					onClick={() => player.cycleSpeed()}
				>
					{speed}×
				</button>
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Close player and unmute live audio"
					title="Close player and unmute live audio"
					onClick={() => player.stop()}
				>
					<RecIcon name="close" size={15} />
				</button>
			</div>
			<input
				type="range"
				className="wkr-seek"
				aria-label="Position"
				min={0}
				max={Math.max(1, Math.round(d * 10))}
				value={Math.round(pos * 10)}
				onChange={e => player.seek(Number(e.target.value) / 10)}
			/>
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
