import "./recordings.css"

// The Recordings drawer (Recordings board), on what the core has today: the WG8 inventory of the WAV files
// WaveKit writes (dsd-fme calls, scanner recordings), WG9 Keep and delete. Header "Recordings · count ·
// All / Kept", typed-chip search, rows grouped by day (open in place: waveform, Keep, Download, Tune, Show in
// Activity or Scanner, Delete with Undo), the player bar and the storage footer. Names, notes, trim,
// transcripts, IQ captures and Opus downloads wait for the core (CORE-GAPS "Recordings").
import { memo, useEffect, useMemo, useRef, useState } from "react"
import type {
	KeyboardEvent as ReactKeyboardEvent,
	PointerEvent as ReactPointerEvent,
} from "react"
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import { errorMessage, useStore } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { useDisplay } from "../display.ts"
import { shellStore } from "../../shell/store.ts"
import { Drawer } from "../../ui/Drawer.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Seg } from "../../ui/Seg.tsx"
import { Skeleton } from "../../ui/Skeleton.tsx"
import { token as activityToken } from "../activity/search.ts"
import { openDiscovery } from "../scanner/ui-store.ts"
import { formatMHz } from "../format.ts"
import { PlayGlyph, RecIcon } from "./icons.tsx"
import {
	deleteBlocker,
	formatBytes,
	formatDuration,
	groupByDay,
	recordedAt,
	recordingIcon,
	recordingMeta,
	recordingTitle,
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
	setText,
	visibleRecordings,
} from "./ui-store.ts"

/** The list refreshes this often while the drawer is open (the core sends no event for new files). */
const REFRESH_MS = 20_000
const SCRUB_S = 5

export function RecordingsDrawer({ onClose }: { onClose: () => void }) {
	const services = useServices()
	const recordings = services.data.recordings
	const unavailable = useStore(recordings, s => s.unavailable)
	const loaded = useStore(recordings, s => s.loaded)
	const error = useStore(recordings, s => s.error)
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

	useEffect(() => {
		void recordings.refresh()
		void services.data.system.load()
		const t = setInterval(() => {
			if (document.visibilityState === "visible") void recordings.refresh()
		}, REFRESH_MS)
		const flush = () => recordings.flushRemovals()
		window.addEventListener("pagehide", flush)
		return () => {
			clearInterval(t)
			window.removeEventListener("pagehide", flush)
		}
	}, [recordings, services.data.system])

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
			) : !loaded && error !== null ? (
				<Empty
					icon="refresh"
					title="Could not read recordings"
					text={error}
					action={{ label: "Try again", run: () => void recordings.refresh() }}
				/>
			) : (
				<>
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

function HeaderActions({ usable }: { usable: boolean }) {
	const recordings = useServices().data.recordings
	const total = useStore(recordings, s => s.items.length - s.removing.size)
	const kept = useStore(
		recordings,
		s => s.items.filter(r => r.kept === true && !s.removing.has(r.id)).length,
	)
	const loading = useStore(recordings, s => s.loading)
	const filter = useStore(recordingsUi, s => s.filter)
	if (!usable) return null
	return (
		<>
			<span className="wkr-count">
				{loading && total === 0 ? "" : String(filter === "kept" ? kept : total)}
			</span>
			<span className="wkr-head-gap" />
			<Seg<RecFilter>
				label="Show"
				value={filter}
				onChange={setFilter}
				options={[
					{ value: "all", label: "All" },
					{ value: "kept", label: `Kept${kept > 0 ? ` ${kept}` : ""}` },
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
	const items = useStore(useServices().data.recordings, s => s.items)
	const tokens = useStore(recordingsUi, s => s.tokens)
	const text = useStore(recordingsUi, s => s.text)
	const [focus, setFocus] = useState(false)
	const [active, setActive] = useState(0)
	const options = useMemo(
		() => suggest(text, items, tokens),
		[text, items, tokens],
	)
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
							<span className="wkr-sugg-count">{o.count}</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

// ---- list

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
	const removing = useStore(recordings, s => s.removing)
	const loaded = useStore(recordings, s => s.loaded)
	const truncated = useStore(recordings, s => s.truncated)
	const error = useStore(recordings, s => s.error)
	const tokens = useStore(recordingsUi, s => s.tokens)
	const text = useStore(recordingsUi, s => s.text)
	const filter = useStore(recordingsUi, s => s.filter)
	const openId = useStore(recordingsUi, s => s.openId)
	const cursorId = useStore(recordingsUi, s => s.cursorId)
	const [kb, setKb] = useState(false)
	const actions = useActions(player)
	const visible = useMemo(
		() => visibleRecordings(items, removing, { tokens, text, filter }),
		[items, removing, tokens, text, filter],
	)
	order.current = visible
	// the day labels follow the clock; a minute is fine for "Today"
	const [now, setNow] = useState(() => new Date())
	useEffect(() => {
		const t = setInterval(() => setNow(new Date()), 60_000)
		return () => clearInterval(t)
	}, [])
	const display = useDisplay()
	const groups = useMemo(
		() => groupByDay(visible, now),
		[visible, now, display], // day groups follow the time setting
	)

	const reveal = (id: string) =>
		requestAnimationFrame(() =>
			document
				.getElementById(rowDomId(id))
				?.scrollIntoView({ block: "nearest" }),
		)

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const target = e.target as HTMLElement
		if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return
		if (e.metaKey || e.ctrlKey || e.altKey) return
		const i = visible.findIndex(r => r.id === cursorId)
		const cur = visible[i]
		const move = (d: number) => {
			const n =
				visible[Math.max(0, Math.min(visible.length - 1, i < 0 ? 0 : i + d))]
			if (!n) return
			e.preventDefault()
			setKb(true)
			if (openId !== null) openRow(n.id)
			else setCursor(n.id)
			reveal(n.id)
		}
		const p = player.get()
		const k = e.key.toLowerCase()
		if (e.key === "ArrowDown") move(1)
		else if (e.key === "ArrowUp") move(-1)
		else if (e.key === " " && cur) {
			e.preventDefault()
			actions.play(cur)
		} else if (e.key === "Enter" && cur) {
			e.preventDefault()
			openRow(openId === cur.id ? null : cur.id)
		} else if (e.key === "Escape" && openId !== null) {
			e.preventDefault()
			e.stopPropagation()
			openRow(null)
		} else if ((k === "j" || k === "l" || k === "k") && p.id !== null) {
			// the list's own keys win over the app's single-key shortcuts (L listen, S save)
			e.preventDefault()
			if (k === "k") player.toggle()
			else player.seek(p.pos + (k === "l" ? SCRUB_S : -SCRUB_S))
		} else if (k === "s" && cur && !readOnly) {
			e.preventDefault()
			actions.keep(cur)
		} else if (
			(e.key === "Delete" || e.key === "Backspace") &&
			cur &&
			!readOnly &&
			deleteBlocker(cur) === null
		) {
			e.preventDefault()
			actions.remove(cur, visible)
		}
	}

	if (!loaded) return <Skeleton round label="recordings" />
	const searching = tokens.length > 0 || text.trim() !== ""
	return (
		<>
			{error && (
				<p className="wkr-note" data-tone="warn">
					Could not refresh: {error}
				</p>
			)}
			{truncated && (
				<p className="wkr-note">
					Only the newest files are listed: the core reads at most 2 000 per
					scan.
				</p>
			)}
			{visible.length === 0 ? (
				searching ? (
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
				<div
					className="wkr-list wk-scroll"
					role="list"
					aria-label="Recordings"
					tabIndex={0}
					onKeyDown={onKeyDown}
					onPointerDown={() => setKb(false)}
				>
					{groups.map(g => (
						<section key={g.key} className="wkr-day" aria-label={g.label}>
							<h3 className="wk-label wkr-day-label" data-strong="">
								{g.label}
							</h3>
							{g.items.map(r => (
								<Row
									key={r.id}
									item={r}
									open={openId === r.id}
									cursor={kb && cursorId === r.id}
									player={player}
									readOnly={readOnly}
									actions={actions}
									list={visible}
								/>
							))}
						</section>
					))}
				</div>
			)}
		</>
	)
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
	item: RecordingInventoryItem
	open: boolean
	cursor: boolean
	player: RecordingPlayer
	readOnly: boolean
	actions: Actions
	list: readonly RecordingInventoryItem[]
}

const Row = memo(function Row({
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
	const keeping = useStore(recordings, s => s.keeping.has(r.id))
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
			className="wkr-item"
			role="listitem"
			aria-label={title}
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
						requestAnimationFrame(() =>
							document
								.getElementById(rowDomId(id))
								?.scrollIntoView({ block: "nearest" }),
						)
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
	const keptBytes = useStore(services.data.recordings, s =>
		s.items.reduce((a, r) => (r.kept === true ? a + r.bytes : a), 0),
	)
	const unavailable = useStore(services.data.recordings, s => s.unavailable)
	if (unavailable !== null) return null
	const calls = storage?.areas.find(a => a.id === "digital-voice-wav")
	const evidence = storage?.areas.find(a => a.id === "scanner-evidence")
	const low = storage?.lowSpace.state === "low"
	const parts = [`Kept ${formatBytes(keptBytes)}`]
	if (calls?.exists)
		parts.push(
			`calls ${formatBytes(calls.bytes)}${calls.cap ? ` of ${formatBytes(calls.cap.bytes)}` : ""}`,
		)
	if (evidence?.exists)
		parts.push(
			`scanner ${formatBytes(evidence.bytes)}${evidence.cap ? ` of ${formatBytes(evidence.cap.bytes)}` : ""}`,
		)
	if (storage?.filesystem)
		parts.push(`${formatBytes(storage.filesystem.availableBytes)} free`)
	return (
		<footer className="wkr-footer" data-tone={low ? "warn" : undefined}>
			<span className="wkr-footer-text">
				{low
					? "Low on space: scanner recordings stop until some is freed · "
					: ""}
				{parts.join(" · ")}
			</span>
			<button
				type="button"
				className="wkr-link"
				onClick={() => {
					void services.data.recordings.refresh()
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
