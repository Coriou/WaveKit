// The discoveries list (Scanner board): windowed rows grouped by the sort, the ignored ones behind a toggle at
// the end, and one row opened in place (why that confidence, identity chips, label and note, actions). Live
// updates touch only rows whose discovery changed: rows are memoised on the discovery object.
import { WaveKitIcon } from "@wavekit/brand/react"
import type { Discovery } from "@wavekit/api-types"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react"

import { useDisplay } from "../../display.ts"
import { useReadOnly, useServices } from "../../../app/context.ts"
import { isIdentifyFinal, useStore } from "../../../data/index.ts"
import { useNow, useTunerState } from "../../hooks.ts"
import { openDiscovery, scannerUi } from "../ui-store.ts"
import {
	identifyAgain,
	inCapture,
	listenTo,
	saveOperatorText,
	toggleSaved,
} from "./actions.ts"
import { DiscoveryHistory } from "./History.tsx"
import { DotsIcon, ScanIcon } from "./icons.tsx"
import { moreMenu } from "./MoreMenu.tsx"
import type { DiscoveryRowView, ListEntry } from "./rows.ts"
import {
	discoveryRow,
	estimateHeight,
	identityChips,
	listEntries,
	measuredText,
	whyText,
} from "./rows.ts"
import { drawerView, toggleIgnored, toggleWeak } from "./state.ts"
import { useVirtual } from "./use-virtual.ts"

export function DiscoveryList() {
	const { data } = useServices()
	const scanner = data.scanner
	const items = useStore(scanner, s => s.discoveries.items)
	const activeNow = useStore(scanner, s => s.activeNow)
	const loadingMore = useStore(scanner, s => s.discoveries.loadingMore)
	const more = useStore(scanner, s => s.discoveries.nextCursor !== null)
	const sort = useStore(drawerView, s => s.sort)
	const showIgnored = useStore(drawerView, s => s.showIgnored)
	const showWeak = useStore(drawerView, s => s.showWeak)
	const weakFilter = useStore(scanner, s => s.discoveries.evidenceSupported)
	const openId = useStore(scannerUi, s => s.openDiscoveryId)
	// a discovery opened from elsewhere (the tuned card, the spectrum) that this search does not list
	const extra = useStore(scanner, s =>
		openId !== null && !s.discoveries.items.some(d => d.id === openId)
			? s.discoveries.byId.get(openId)
			: undefined,
	)
	const now = useNow(true, 30_000)
	const [cursor, setCursor] = useState<string | null>(null)

	useEffect(() => {
		if (openId !== null && !scanner.discovery(openId))
			scanner.fetchDiscovery(openId).catch(() => openDiscovery(null))
	}, [openId, scanner])

	const entries = useMemo(() => {
		const list = listEntries(
			items,
			sort,
			activeNow,
			now,
			showIgnored,
			!weakFilter ? "none" : showWeak ? "shown" : "hidden",
		)
		if (!extra) return list
		const pinned: ListEntry[] = [
			{ type: "group", key: "g:opened", label: "Opened" },
			{ type: "row", key: extra.id, discovery: extra },
		]
		return [...pinned, ...list]
	}, [items, sort, activeNow, now, showIgnored, showWeak, weakFilter, extra])
	const keys = useMemo(() => entries.map(e => e.key), [entries])
	const v = useVirtual(
		keys,
		i => {
			const e = entries[i]
			return e ? estimateHeight(e, e.key === openId) : 60
		},
		() => void scanner.loadMore(),
	)

	// bring an opened row into view (opened here, by keyboard or from elsewhere)
	const revealed = useRef<string | null>(null)
	useEffect(() => {
		if (openId === null || revealed.current === openId) return
		const index = keys.indexOf(openId)
		if (index < 0) return
		revealed.current = openId
		v.reveal(index)
	}, [openId, keys, v])
	useEffect(() => {
		if (openId === null) revealed.current = null
	}, [openId])

	// a new search starts at the top
	const query = useStore(scanner, s => s.discoveries.query)
	useEffect(() => {
		const el = v.scroller.current
		if (el) el.scrollTop = 0
	}, [query, v.scroller])

	const rows = useMemo(
		() =>
			entries.filter(
				(e): e is Extract<ListEntry, { type: "row" }> => e.type === "row",
			),
		[entries],
	)
	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const t = e.target as HTMLElement
		if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return
		if (e.key === "Escape" && openId !== null) {
			e.preventDefault()
			e.stopPropagation()
			openDiscovery(null)
			return
		}
		if (!["ArrowDown", "ArrowUp", "Enter", "Home", "End"].includes(e.key))
			return
		if (rows.length === 0) return
		if (e.key === "Enter" && t !== e.currentTarget) return
		e.preventDefault()
		const current = cursor ?? openId
		const at = current === null ? -1 : rows.findIndex(r => r.key === current)
		if (e.key === "Enter") {
			const key = rows[at]?.key
			if (key) openDiscovery(openId === key ? null : key)
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
		if (openId !== null) openDiscovery(key)
		const index = keys.indexOf(key)
		if (index >= 0) v.reveal(index)
	}

	return (
		<div className="wks-listwrap">
			<div
				ref={v.scroller}
				className="wks-list wk-scroll"
				role="list"
				aria-label="Discoveries. Arrows move, Enter opens."
				tabIndex={0}
				onScroll={() => {
					v.onScroll()
					followMenu(v.scroller.current)
				}}
				onKeyDown={onKeyDown}
			>
				<div style={{ height: v.win.total, position: "relative" }}>
					<div
						className="wks-window"
						style={{ transform: `translateY(${v.win.offset}px)` }}
					>
						{entries.slice(v.win.start, v.win.end).map(e =>
							e.type === "group" ? (
								<h3
									key={e.key}
									data-key={e.key}
									ref={v.measure}
									className="wk-label wks-group"
									data-strong=""
								>
									{e.label}
								</h3>
							) : e.type === "ignored" ? (
								<div
									key={e.key}
									data-key={e.key}
									ref={v.measure}
									className="wks-ign-wrap"
								>
									<button
										type="button"
										className="wk-row wks-ign"
										aria-expanded={showIgnored}
										onClick={toggleIgnored}
									>
										<ScanIcon name="eye-off" size={15} />
										<span className="wks-ign-count">{e.count} ignored</span>
										<span className="wks-ign-names">
											{showIgnored
												? "Never probed, recorded or scanned"
												: e.names}
										</span>
										<ScanIcon
											name={showIgnored ? "chevron-up" : "chevron-down"}
											size={16}
										/>
									</button>
								</div>
							) : e.type === "weak" ? (
								<div
									key={e.key}
									data-key={e.key}
									ref={v.measure}
									className="wks-ign-wrap"
								>
									<button
										type="button"
										className="wk-row wks-ign"
										aria-pressed={e.shown}
										onClick={toggleWeak}
									>
										<ScanIcon name={e.shown ? "eye-off" : "eye"} size={15} />
										<span className="wks-ign-count">
											{e.shown ? "Hide weak activity" : "Show weak activity"}
										</span>
										<span className="wks-ign-names">
											Heard, but nothing proved what it is
										</span>
									</button>
								</div>
							) : (
								<DiscoveryItem
									key={e.key}
									discovery={e.discovery}
									live={activeNow.has(e.key)}
									open={openId === e.key}
									cursor={cursor === e.key}
									now={now}
									measure={v.measure}
								/>
							),
						)}
					</div>
				</div>
				{loadingMore && <p className="wks-foot-note">Loading more…</p>}
				{!more && items.length > 20 && (
					<p className="wks-foot-note">
						That is every discovery for this search.
					</p>
				)}
			</div>
		</div>
	)
}

/** The ⋯ menu follows its button while the list scrolls; it closes once the button leaves the list. */
function followMenu(list: HTMLElement | null): void {
	const m = moreMenu.get()
	if (!m || !list) return
	const box = list.getBoundingClientRect()
	const a = m.anchor.getBoundingClientRect()
	if (!m.anchor.isConnected || a.bottom < box.top || a.top > box.bottom)
		moreMenu.set(null)
	else moreMenu.set({ ...m })
}

interface ItemProps {
	discovery: Discovery
	live: boolean
	open: boolean
	cursor: boolean
	now: number
	measure: (el: HTMLElement | null) => void
}

const DiscoveryItem = memo(function DiscoveryItem({
	discovery,
	live,
	open,
	cursor,
	now,
	measure,
}: ItemProps) {
	useDisplay() // times follow Settings › Display
	const v = discoveryRow(discovery, now)
	return (
		<article
			data-key={discovery.id}
			ref={measure}
			role="listitem"
			aria-label={v.aria}
			className="wks-item"
			data-open={open || undefined}
			data-ignored={v.ignored || undefined}
		>
			{open ? (
				<DiscoveryDetail d={discovery} v={v} live={live} />
			) : (
				<button
					type="button"
					className="wk-row wks-row"
					aria-expanded="false"
					data-kb-cursor={cursor || undefined}
					onClick={() => openDiscovery(discovery.id)}
				>
					<Tile v={v} />
					<span className="wks-main">
						<Line1 v={v} live={live} />
						{v.title && (
							<span className="wks-title" data-label={v.labelled || undefined}>
								{v.title}
							</span>
						)}
						{v.reason && <span className="wks-reason">{v.reason}</span>}
						<HintLine v={v} />
					</span>
				</button>
			)}
		</article>
	)
})

/** "likely ISM device · Run identify": the hint (muted, never the protocol) and the next step; unverified rows only. */
function HintLine({ v }: { v: DiscoveryRowView }) {
	if (v.next === null) return null
	return (
		<span className="wks-reason wks-hint">
			{v.likely && <span className="wks-likely">{v.likely}</span>}
			{v.likely && " · "}
			<span className="wks-next">{v.next}</span>
		</span>
	)
}

function Tile({ v }: { v: DiscoveryRowView }) {
	return (
		<span className="wk-tile wks-tile" data-tone={v.tone} aria-hidden="true">
			{v.icon ? (
				<WaveKitIcon name={v.icon} size={16} />
			) : (
				<ScanIcon name="wave" size={16} />
			)}
		</span>
	)
}

function Line1({
	v,
	live,
	children,
}: {
	v: DiscoveryRowView
	live: boolean
	children?: ReactNode
}) {
	return (
		<span className="wks-line1">
			<span className="wks-freq">
				{v.freqMain}
				<span className="wks-freq-tail">{v.freqTail}</span>
			</span>
			<span className="wks-conf" data-tone={v.tone}>
				{v.decoded && <ScanIcon name="check" size={12} strokeWidth={2.6} />}
				<span className="wks-ellipsis">{v.confidence}</span>
			</span>
			<span className="wks-gap" />
			{v.kept && (
				<ScanIcon
					name="star"
					size={12}
					filled
					className="wks-kept"
					role="img"
					aria-label="Kept"
					aria-hidden={undefined}
				/>
			)}
			{v.encrypted && (
				<ScanIcon
					name="lock"
					size={12}
					className="wks-lock"
					role="img"
					aria-label="Encrypted"
					aria-hidden={undefined}
				/>
			)}
			{live ? (
				<span className="wks-now">
					<span className="wk-live" aria-hidden="true" />
					Now
				</span>
			) : (
				<span className="wks-heard">{v.heard}</span>
			)}
			{children}
		</span>
	)
}

/** The open row: header with label and note editable in place, why, chips, actions. */
function DiscoveryDetail({
	d,
	v,
	live,
}: {
	d: Discovery
	v: DiscoveryRowView
	live: boolean
}) {
	const services = useServices()
	const readOnly = useReadOnly()
	const close = () => openDiscovery(null)
	const chips = identityChips(d)
	return (
		<div className="wks-detail">
			<div className="wks-detail-head">
				<button
					type="button"
					className="wk-tile wks-tile wks-tile-btn"
					data-tone={v.tone}
					aria-expanded="true"
					aria-label={`Close ${v.aria}`}
					title="Close"
					onClick={close}
				>
					{v.icon ? (
						<WaveKitIcon name={v.icon} size={16} />
					) : (
						<ScanIcon name="wave" size={16} />
					)}
				</button>
				<span className="wks-main">
					<Line1 v={v} live={live}>
						<button
							type="button"
							className="wk-icon-btn wks-collapse"
							data-size="sm"
							aria-label={`Close ${v.aria}`}
							onClick={close}
						>
							<ScanIcon name="chevron-up" size={14} />
						</button>
					</Line1>
					<OperatorFields d={d} readOnly={readOnly} />
				</span>
			</div>
			<div className="wks-detail-body">
				<div className="wks-why">
					<ScanIcon
						name={d.confidence === "decoded" ? "check" : "wave"}
						size={16}
						className="wks-why-icon"
						data-tone={v.tone}
					/>
					<span className="wks-why-text">
						<span role="status">{whyText(d)}</span>
						<span className="wks-measured">{measuredText(d)}</span>
						{v.reason && <span className="wks-measured">{v.reason}</span>}
						<HintLine v={v} />
					</span>
				</div>
				{chips.length > 0 && (
					<ul className="wks-chips" aria-label="Identity">
						{chips.map(c => (
							<li key={c} className="wks-idchip">
								{c}
							</li>
						))}
					</ul>
				)}
				<DiscoveryHistory d={d} />
				<Actions d={d} readOnly={readOnly} services={services} />
			</div>
		</div>
	)
}

function OperatorFields({ d, readOnly }: { d: Discovery; readOnly: boolean }) {
	const services = useServices()
	const [label, setLabel] = useState(d.operator?.label ?? "")
	const [note, setNote] = useState(d.operator?.notes ?? "")
	// another client (or Undo) changed it: follow unless this field is being edited
	const editing = useRef<"label" | "notes" | null>(null)
	const cancelled = useRef(false)
	useEffect(() => {
		if (editing.current !== "label") setLabel(d.operator?.label ?? "")
		if (editing.current !== "notes") setNote(d.operator?.notes ?? "")
	}, [d.operator?.label, d.operator?.notes])
	if (readOnly)
		return (
			<>
				{label && (
					<span className="wks-title" data-label="">
						{label}
					</span>
				)}
				{note && <span className="wks-note-ro">{note}</span>}
			</>
		)
	const placeholder = discoveryRow(d, Date.now()).title || "Add a label"
	const onKey = (
		e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
		field: "label" | "notes",
	) => {
		// leaving the field gives focus back to the list, so Escape there closes the row, not the drawer
		const leave = () => {
			const el = e.currentTarget as HTMLElement
			const list = el.closest<HTMLElement>("[role=list]")
			if (list) list.focus()
			else el.blur()
		}
		if (e.key === "Escape") {
			e.preventDefault()
			e.stopPropagation()
			cancelled.current = true
			if (field === "label") setLabel(d.operator?.label ?? "")
			else setNote(d.operator?.notes ?? "")
			leave()
		} else if (e.key === "Enter" && (field === "label" || !e.shiftKey)) {
			e.preventDefault()
			leave()
		}
	}
	const commit = (field: "label" | "notes", value: string) => {
		editing.current = null
		if (cancelled.current) {
			cancelled.current = false
			return
		}
		void saveOperatorText(services, d, field, value)
	}
	return (
		<>
			<input
				className="wk-input wks-label-input"
				value={label}
				placeholder={placeholder}
				aria-label="Label"
				title="Add a label"
				maxLength={128}
				spellCheck={false}
				autoComplete="off"
				onFocus={() => (editing.current = "label")}
				onChange={e => setLabel(e.target.value)}
				onKeyDown={e => onKey(e, "label")}
				onBlur={() => commit("label", label)}
			/>
			<textarea
				className="wk-input wks-note-input"
				value={note}
				placeholder="Add a note"
				aria-label="Note"
				rows={1}
				maxLength={2000}
				onFocus={() => (editing.current = "notes")}
				onChange={e => setNote(e.target.value)}
				onKeyDown={e => onKey(e, "notes")}
				onBlur={() => commit("notes", note)}
			/>
		</>
	)
}

function Actions({
	d,
	readOnly,
	services,
}: {
	d: Discovery
	readOnly: boolean
	services: ReturnType<typeof useServices>
}) {
	const hz = Math.round(d.frequencyHz)
	const saved = useStore(services.data.savedFrequencies, s =>
		s.items.some(f => f.frequencyHz === hz),
	)
	const savedAvailable = useStore(
		services.data.savedFrequencies,
		s => s.status !== "unavailable",
	)
	const identifying = useStore(
		services.data.identify,
		s =>
			s.targetHz === d.frequencyHz &&
			(s.starting || (s.job !== null && !isIdentifyFinal(s.event?.state))),
	)
	const sweeping = useStore(services.data.scanner, s => s.sweep !== null)
	const tuner = useTunerState()
	const here = inCapture(d.frequencyHz, tuner, Math.max(0, d.bandwidthHz) / 2)
	const menuOpen = useStore(moreMenu, m => m?.discoveryId === d.id)
	const f = (d.frequencyHz / 1e6).toFixed(3)
	if (readOnly)
		return (
			<div className="wks-acts">
				<span className="wks-gap" />
				<MoreButton d={d} open={menuOpen} />
			</div>
		)
	const idTitle = !here
		? "Outside the tuned span · Listen first, then identify"
		: sweeping
			? "Pause the scan to identify"
			: "Identify again · every decoder tries it on the tuned card. Never moves the receiver."
	return (
		<div className="wks-acts">
			<button
				type="button"
				className="wk-btn wks-listen"
				data-variant="primary"
				data-size="lg"
				title={
					here
						? `Plays ${f}`
						: sweeping
							? `Tunes to ${f} and plays it · the scan pauses`
							: `Tunes to ${f} and plays it`
				}
				onClick={() => void listenTo(services, d)}
			>
				<ScanIcon name="headphones" size={15} strokeWidth={2.2} />
				Listen
			</button>
			<button
				type="button"
				className="wk-btn wks-act2"
				data-variant="ghost"
				data-size="lg"
				aria-pressed={saved}
				aria-label={saved ? "Saved frequency" : "Save frequency"}
				disabled={!savedAvailable}
				title={
					!savedAvailable
						? "Saved frequencies need operator data on this core"
						: saved
							? "In your saved frequencies · click to remove"
							: "Add to saved frequencies · name, mode and width filled in"
				}
				onClick={() => void toggleSaved(services, d)}
			>
				<ScanIcon name="bookmark" size={15} filled={saved} />
				<span className="wks-lbl-save">
					{saved ? "Saved" : "Save frequency"}
				</span>
			</button>
			<button
				type="button"
				className="wk-btn wks-act2"
				data-variant="ghost"
				data-size="lg"
				aria-label={identifying ? "Identifying" : "Identify again"}
				disabled={!here || sweeping || identifying}
				title={idTitle}
				onClick={() => void identifyAgain(services, d)}
			>
				<ScanIcon name="identify" size={15} />
				<span className="wks-lbl-id">
					{identifying ? "Identifying…" : "Identify again"}
				</span>
			</button>
			<span className="wks-gap" />
			<MoreButton d={d} open={menuOpen} />
		</div>
	)
}

function MoreButton({ d, open }: { d: Discovery; open: boolean }) {
	return (
		<button
			type="button"
			className="wk-icon-btn wks-more"
			data-size="lg"
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label="More actions"
			title="More"
			onClick={e => {
				const anchor = e.currentTarget
				moreMenu.set(open ? null : { discoveryId: d.id, anchor })
			}}
		>
			<DotsIcon />
		</button>
	)
}
