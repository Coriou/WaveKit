// The Settings drawer (docs/web/canvas/Settings.dc.html, SettingsPhone.dc.html; DESIGN.md "Settings"): search with
// typed filters, a rail that scroll-spies the eight groups, rows that apply at once or wait for Apply when they
// restart something or touch the hardware, decoder pages, and on a phone the groups as screens of their own.
import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type { SettingWriteResult } from "../../data/index.ts"
import { CardPlaceContext } from "../../shell/CardHandle.tsx"
import { useTheme } from "../../shell/hooks.ts"
import { cardAnchorName } from "../../shell/layout.ts"
import { shellStore } from "../../shell/store.ts"
import { themeStore } from "../../shell/theme.ts"
import { showAppToast } from "../../shell/toast.ts"
import { useTunerState } from "../hooks.ts"
import { openPalette } from "../palette/request.ts"
import { decoderLabel } from "../tuned/signal.ts"
import { BandPlansPage } from "./bandplans/BandPlansPage.tsx"
import { DecoderPageHead, DecoderStatus } from "./DecoderPage.tsx"
import { SetIcon, type SetIconName } from "./icons.tsx"
import { groupSummary, settingsItems, type SettingsItem } from "./items.ts"
import {
	FILTERS,
	SETTING_GROUPS,
	groupOf,
	isChanged,
	pendingSummary,
	same,
	yamlLine,
	type PendingChange,
	type SettingFilter,
	type SettingGroupId,
	type SettingRow,
	type SettingValue,
} from "./model.ts"
import { settingFocus, takeSettingFocus } from "./registry.ts"
import {
	buildRows,
	type SettingsActions,
	type SettingsSnapshot,
} from "./rows.ts"
import { SettingRowView } from "./SettingRowView.tsx"
import "./settings.css"
import "./bandplans/bandplans.css"

const GROUP_ICON: Record<SettingGroupId, SetIconName> = {
	station: "antenna",
	receiver: "radio",
	audio: "volume",
	decoders: "decoders",
	storage: "db",
	map: "map",
	display: "display",
	system: "server",
}

/** Below this drawer width the phone layout applies (groups as screens, no rail): the board's container rule. */
const PHONE_W = 460
const SPY_AT = 0.3
const BANDPLANS = "bandplans"

const OK: SettingWriteResult = { ok: true }
const toResult = (ok: boolean, message: string): SettingWriteResult =>
	ok ? OK : { ok: false, message }

function useSnapshot(): SettingsSnapshot {
	const services = useServices()
	const { data } = services
	const readOnly = useReadOnly()
	const theme = useTheme()
	const stepHz = useStore(services.prefs, s => s.stepHz)
	const cardAt = useStore(useContext(CardPlaceContext), s => s.at)
	const volume = useStore(services.listen, s => s.volume)
	const tuner = useTunerState()
	const sources = useStore(data.sources, s => s.sources)
	const receiver = useStore(data.receiver)
	const live = useStore(data.liveAudio, s => s.status)
	const station = useStore(data.station, s => s.station)
	const prefs = useStore(data.preferences)
	const savedCount = useStore(data.savedFrequencies, s => s.items.length)
	const bandplanEdits = useStore(data.bandplanStack, s =>
		s.view
			? new Set(s.view.edits.map(e => `${e.packId}/${e.bandId}`)).size +
				s.view.operatorBands.length
			: null,
	)
	const decoders = useStore(services.decoders, s => s.decoders)
	const decoderSettings = useStore(data.decoderSettings)
	const system = useStore(data.system)
	const access = useStore(data.access, s => s.access)
	return useMemo(() => {
		const sourceId = tuner?.sourceId
		const source = tuner
			? sources.find(x => x.id === tuner.sourceId)
			: sources[0]
		return {
			readOnly,
			theme,
			stepHz,
			cardAt,
			volume,
			tuner,
			source,
			caps:
				sourceId === undefined ? null : (receiver.caps[sourceId]?.caps ?? null),
			controls:
				sourceId === undefined ? {} : (receiver.controls[sourceId] ?? {}),
			relay: receiver.relay,
			live,
			station,
			preferences: prefs.available === true ? prefs.values : null,
			preferenceDefaults: prefs.defaults,
			savedCount,
			bandplanEdits,
			decoders,
			decoderTypes: decoderSettings.types,
			decoderViews: decoderSettings.views,
			decoderSettings: decoderSettings.available !== false,
			version: system.version,
			accessMode: access ? access.mode : null,
			storage: system.storage,
			exportUrl: data.system.configExportUrl(),
		}
	}, [
		readOnly,
		theme,
		stepHz,
		cardAt,
		volume,
		tuner,
		sources,
		receiver,
		live,
		station,
		prefs,
		savedCount,
		bandplanEdits,
		decoders,
		decoderSettings,
		system,
		access,
		data.system,
	])
}

function useActions(openPage: (page: string) => void): SettingsActions {
	const services = useServices()
	const cards = useContext(CardPlaceContext)
	return useMemo(() => {
		const { data } = services
		const sourceId = () => {
			const s = data.tuner.get().bySource
			return Object.keys(s)[0] ?? null
		}
		const controlError = (key: Parameters<typeof data.receiver.control>[1]) => {
			const id = sourceId()
			return id === null ? null : data.receiver.control(id, key).error
		}
		return {
			setTheme: patch => themeStore.set(patch),
			setStep: hz => services.prefs.setStep(hz),
			setCardAt: id => cards.setAt(id, cardAnchorName(id)),
			setVolume: v => services.listen.setVolume(v),
			async receiver(setting) {
				const id = sourceId()
				if (id === null) return { ok: false, message: "No receiver" }
				const ok = await data.receiver.write(id, setting)
				return toResult(
					ok,
					controlError(setting.key)?.message ?? "The receiver refused it",
				)
			},
			async manualGain(tenths) {
				const id = sourceId()
				if (id === null) return { ok: false, message: "No receiver" }
				const ok = await data.receiver.setManualGain(id, tenths)
				return toResult(
					ok,
					controlError("gain")?.message ?? "The receiver refused it",
				)
			},
			async audio(patch) {
				try {
					await data.liveAudio.setConfig(patch)
					return OK
				} catch (error) {
					return {
						ok: false,
						message: error instanceof Error ? error.message : "Not saved",
					}
				}
			},
			station: patch => data.station.update(patch),
			preference: (key, value) => data.preferences.set(key, value),
			decoder: (id, patch) => data.decoderSettings.update(id, patch),
			openTuner: () => shellStore.openPanel("tuner"),
			openShortcuts: () => openPalette("keys"),
			openBandPlans: () => openPage(BANDPLANS),
		}
	}, [services, cards, openPage])
}

export function SettingsView({ onClose }: { onClose: () => void }) {
	const services = useServices()
	const { data } = services
	const snapshot = useSnapshot()
	const [page, setPage] = useState<string | null>(null)
	/** The band open in Band plans' editor (`packId/bandId`). */
	const [band, setBand] = useState<string | null>(null)
	const openPage = useCallback((p: string) => {
		setBand(null)
		setPage(p)
	}, [])
	const actions = useActions(openPage)
	const rows = useMemo(() => buildRows(snapshot, actions), [snapshot, actions])
	const byId = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows])

	const [query, setQuery] = useState("")
	const [filters, setFilters] = useState<SettingFilter[]>([])
	const [only, setOnly] = useState<SettingGroupId | null>(null)
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
	const [pending, setPending] = useState<PendingChange[]>([])
	const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
	const [flash, setFlash] = useState<string | null>(null)
	const [current, setCurrent] = useState<SettingGroupId>("station")
	const [phone, setPhone] = useState(false)
	const [applying, setApplying] = useState(false)

	const rootRef = useRef<HTMLElement>(null)
	const scrollRef = useRef<HTMLDivElement>(null)
	const searchRef = useRef<HTMLInputElement>(null)
	const spyLock = useRef(0)

	// load what only Settings reads, each time it opens
	useEffect(() => {
		void data.system.load()
		void data.station.load()
		void data.bandplanStack.load()
	}, [data])
	const decoderIds = useMemo(
		() => snapshot.decoders.map(d => d.id).join("\u0000"),
		[snapshot.decoders],
	)
	useEffect(() => {
		if (!decoderIds) return
		for (const id of decoderIds.split("\u0000"))
			void data.decoderSettings.loadView(id)
	}, [data, decoderIds])

	useLayoutEffect(() => {
		const el = rootRef.current
		if (!el || typeof ResizeObserver === "undefined") return
		const ro = new ResizeObserver(([entry]) => {
			if (entry) setPhone(entry.contentRect.width < PHONE_W)
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	const pageName = useCallback(
		(id: string) => {
			const d = snapshot.decoders.find(x => x.id === id)
			return d ? decoderLabel(d.type) : id
		},
		[snapshot.decoders],
	)

	const showGroups =
		phone &&
		only === null &&
		page === null &&
		query.trim() === "" &&
		filters.length === 0
	const bandplans = page === BANDPLANS
	const items = useMemo(
		() =>
			showGroups || bandplans
				? []
				: settingsItems({
						rows,
						query,
						filters,
						page,
						only: phone ? only : null,
						open,
						pageName,
					}),
		[
			showGroups,
			bandplans,
			rows,
			query,
			filters,
			page,
			phone,
			only,
			open,
			pageName,
		],
	)

	// ---- the palette's "Open in Settings ›": open the right group, page or fold, then flash the row
	const wanted = useStore(settingFocus, s => s.id)
	useEffect(() => {
		const id = takeSettingFocus(rows.map(r => r.id))
		if (id === null) return
		const row = byId.get(id)
		if (!row) return
		setQuery("")
		setFilters([])
		// ⌘K's "Band plans" opens the page itself
		if (id === "station.bandplans") {
			openPage(BANDPLANS)
			return
		}
		setPage(row.page ?? null)
		setOnly(row.group)
		if (row.more)
			setOpen(o => new Set([...o, row.page ? `page:${row.page}` : row.group]))
		setFlash(id)
		const t = setTimeout(() => setFlash(null), 1600)
		return () => clearTimeout(t)
	}, [wanted, rows, byId, openPage])
	useEffect(() => {
		if (flash === null) return
		const raf = requestAnimationFrame(() =>
			scrollRef.current
				?.querySelector(`[data-setting="${CSS.escape(flash)}"]`)
				?.scrollIntoView({ block: "center" }),
		)
		const t = setTimeout(() => setFlash(null), 1600)
		return () => {
			cancelAnimationFrame(raf)
			clearTimeout(t)
		}
	}, [flash])

	// ---- changes
	const stagedOf = (id: string) => pending.find(p => p.id === id)
	const setError = (id: string, message: string | null) =>
		setErrors(e => {
			if (message === null) {
				if (!(id in e)) return e
				const next = { ...e }
				delete next[id]
				return next
			}
			return { ...e, [id]: message }
		})

	const change = (row: SettingRow, value: SettingValue) => {
		if (!row.write) return
		if (row.effect) {
			setError(row.id, null)
			setPending(list => {
				const rest = list.filter(p => p.id !== row.id)
				return same(value, row.value) ? rest : [...rest, { id: row.id, value }]
			})
			return
		}
		void row
			.write(value)
			.then(result => setError(row.id, result.ok ? null : result.message))
	}

	const apply = async () => {
		if (applying) return
		setApplying(true)
		let done = 0
		const failed: PendingChange[] = []
		for (const p of pending) {
			const row = byId.get(p.id)
			if (!row?.write) continue
			const result = await row.write(p.value)
			if (result.ok) {
				done++
				setError(p.id, null)
			} else {
				failed.push(p)
				setError(p.id, result.message)
			}
		}
		setPending(failed)
		setApplying(false)
		if (failed.length === 0)
			showAppToast(`Applied ${done} change${done === 1 ? "" : "s"}`)
		else
			showAppToast(`Applied ${done} of ${done + failed.length} changes`, {
				tone: "warn",
			})
	}

	const copy = (row: SettingRow) => {
		const text = yamlLine(row)
		void navigator.clipboard
			?.writeText(text)
			.then(() => showAppToast("Copied as YAML"))
			.catch(() => showAppToast("Could not copy", { tone: "warn" }))
	}

	// ---- scroll-spy
	const onScroll = () => {
		const el = scrollRef.current
		if (!el || Date.now() < spyLock.current) return
		const line = el.scrollTop + el.clientHeight * SPY_AT
		let at: SettingGroupId = "station"
		for (const h of el.querySelectorAll<HTMLElement>("[data-group-head]")) {
			if (h.offsetTop <= line) at = h.dataset["groupHead"] as SettingGroupId
		}
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
			const heads = el.querySelectorAll<HTMLElement>("[data-group-head]")
			const last = heads[heads.length - 1]
			if (last) at = last.dataset["groupHead"] as SettingGroupId
		}
		setCurrent(at)
	}
	const jump = (g: SettingGroupId) => {
		setCurrent(g)
		const el = scrollRef.current
		const head = el?.querySelector<HTMLElement>(`[data-group-head="${g}"]`)
		if (!el || !head) return
		spyLock.current = Date.now() + 600
		const far = Math.abs(head.offsetTop - el.scrollTop) > el.clientHeight * 2
		el.scrollTo({ top: head.offsetTop - 4, behavior: far ? "auto" : "smooth" })
	}

	// ---- header and search
	const changedCount = rows.filter(
		r => r.widget.kind !== "page" && isChanged(r),
	).length
	const pageDecoder =
		page === null ? null : snapshot.decoders.find(d => d.id === page)
	const bandName = useStore(data.bandplanStack, s => {
		if (!band || !s.view) return null
		const [packId, bandId] = band.split("/")
		if (packId === "operator")
			return s.view.operatorBands.find(b => b.id === bandId)?.name ?? null
		const edit = s.view.edits.find(
			e => e.packId === packId && e.bandId === bandId,
		)
		return (
			edit?.set.name ??
			s.packs[packId ?? ""]?.bands.find(b => b.id === bandId)?.name ??
			null
		)
	})
	const title = bandplans
		? (bandName ?? "Band plans")
		: pageDecoder
			? decoderLabel(pageDecoder.type)
			: phone && only !== null && query === "" && filters.length === 0
				? groupOf(only).label
				: "Settings"
	const back = bandplans
		? band !== null
			? { label: "Band plans", go: () => setBand(null) }
			: {
					label: "Station",
					go: () => {
						setPage(null)
						setFlash("station.bandplans")
					},
				}
		: page !== null
			? {
					label: phone || only !== null ? "Decoders" : "Settings",
					go: () => setPage(null),
				}
			: phone && only !== null && query === "" && filters.length === 0
				? { label: "Settings", go: () => setOnly(null) }
				: null
	const toggleFilter = (f: SettingFilter) =>
		setFilters(list =>
			list.includes(f) ? list.filter(x => x !== f) : [...list, f],
		)
	const suggestion = items.find(i => i.kind === "suggest")
	const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Backspace" && query === "" && filters.length > 0)
			setFilters(list => list.slice(0, -1))
		else if (e.key === "Enter" && suggestion?.kind === "suggest") {
			setFilters(list => [...list, suggestion.filter])
			setQuery("")
		} else if (e.key === "Escape" && (query !== "" || filters.length > 0)) {
			e.stopPropagation()
			setQuery("")
			setFilters([])
		}
	}

	const railDots = useMemo(() => {
		const dots = new Map<SettingGroupId, "amber" | "accent">()
		for (const p of pending) {
			const r = byId.get(p.id)
			if (r) dots.set(r.group, "amber")
		}
		for (const r of rows)
			if (r.widget.kind !== "page" && isChanged(r) && !dots.has(r.group))
				dots.set(r.group, "accent")
		return dots
	}, [pending, rows, byId])

	const summary = pending.length > 0 ? pendingSummary(pending, rows) : null

	const renderItem = (item: SettingsItem, i: number) => {
		switch (item.kind) {
			case "head": {
				const g = groupOf(item.group)
				return (
					<div
						key={`h:${g.id}`}
						className="wkf-set-head"
						data-group-head={g.id}
						data-first={item.first || undefined}
					>
						<h3 className="wk-h3">{g.label}</h3>
						<div className="wkf-set-help">{g.desc}</div>
					</div>
				)
			}
			case "nothing":
				return (
					<div key={`n:${item.group}`} className="wkf-set-nothing">
						{item.text}
					</div>
				)
			case "fold":
				return (
					<button
						key={`f:${item.key}`}
						type="button"
						className="wk-row wkf-set-fold"
						aria-expanded={item.open}
						data-open={item.open || undefined}
						onClick={() =>
							setOpen(o => {
								const next = new Set(o)
								if (next.has(item.key)) next.delete(item.key)
								else next.add(item.key)
								return next
							})
						}
					>
						{item.open ? (
							<>
								<span className="wk-label wkf-grow">More</span>
								<span className="wkf-set-quiet">Hide</span>
								<SetIcon name="chevron-left" size={14} className="wkf-set-up" />
							</>
						) : (
							<>
								<b className="wkf-num">{item.count} more</b>
								<span className="wkf-grow wkf-ellipsis wkf-set-quiet">
									{item.names}
								</span>
								<SetIcon
									name="chevron-left"
									size={16}
									className="wkf-set-down"
								/>
							</>
						)}
					</button>
				)
			case "device":
				return (
					<div key={`d:${item.group}`} className="wkf-set-sub">
						<div className="wk-label">
							<SetIcon name="display" size={14} />
							On this device
						</div>
						<div className="wkf-set-help">
							Kept by this browser only. Your other devices keep their own.
						</div>
					</div>
				)
			case "count":
				return (
					<div key="count" role="status" className="wk-label wkf-set-count">
						{item.n} result{item.n === 1 ? "" : "s"}
					</div>
				)
			case "suggest": {
				const f = FILTERS.find(x => x.id === item.filter)
				return (
					<button
						key={`s:${item.filter}`}
						type="button"
						className="wk-row wkf-set-suggest"
						onClick={() => {
							toggleFilter(item.filter)
							setQuery("")
							searchRef.current?.focus()
						}}
					>
						<SetIcon name="filter" size={16} />
						<span className="wkf-grow">
							Show only <b>{f?.label}</b>
						</span>
						<span className="wkf-set-quiet wkf-num">{item.count}</span>
						<kbd className="wk-kbd" aria-hidden="true">
							↵
						</kbd>
					</button>
				)
			}
			case "none":
				return (
					<div key="none" className="wkf-set-empty">
						<b>Nothing matches “{item.q}”</b>
						<span>
							Search looks in names, descriptions and values. Commands such as
							Tune are in <kbd className="wk-kbd">⌘K</kbd>.
						</span>
						<button
							type="button"
							className="wk-btn"
							data-variant="outline"
							data-size="lg"
							onClick={() => {
								setQuery("")
								setFilters([])
							}}
						>
							Clear search
						</button>
					</div>
				)
			case "pagehead":
				return pageDecoder ? (
					<DecoderPageHead key="ph" decoder={pageDecoder} />
				) : null
			case "status":
				return pageDecoder ? (
					<DecoderStatus
						key="st"
						decoder={pageDecoder}
						readOnly={snapshot.readOnly}
					/>
				) : null
			case "row": {
				const row = item.row
				if (row.widget.kind === "page") {
					const w = row.widget
					const staged = stagedOf(row.id)
					const on = staged ? staged.value === true : row.value === true
					return (
						<div
							key={row.id}
							className="wk-row wkf-set-dec"
							data-setting={row.id}
							data-flash={flash === row.id || undefined}
							data-waiting={staged ? true : undefined}
						>
							<button
								type="button"
								className="wkf-set-dec-open"
								aria-label={`${row.label} settings · ${w.status}`}
								onClick={() => setPage(w.page)}
							>
								<span className="wk-tile" data-tone={w.tone}>
									<SetIcon name="decoders" size={16} />
								</span>
								<span className="wkf-grow wkf-set-dec-text">
									<span className="wkf-set-dec-name">
										<b>{row.label}</b>
										<span className="wkf-ellipsis">{w.tool}</span>
									</span>
									<span className="wkf-set-dec-stat" data-tone={w.tone}>
										<span aria-hidden="true" className="wkf-set-dot" />
										<span className="wkf-ellipsis">
											{staged
												? `Waiting for Apply · ${on ? "turns on" : "turns off"}`
												: w.status}
										</span>
									</span>
								</span>
								<SetIcon
									name="chevron-right"
									size={16}
									className="wkf-set-chev"
								/>
							</button>
							{row.write && (
								<>
									<span aria-hidden="true" className="wkf-set-dec-sep" />
									<button
										type="button"
										role="switch"
										className="wk-switch"
										data-size="row"
										aria-checked={on}
										aria-label={`${row.label} on`}
										disabled={row.disabled !== undefined}
										onClick={() => change(row, !on)}
									/>
								</>
							)}
						</div>
					)
				}
				const staged = stagedOf(row.id)
				return (
					<SettingRowView
						key={row.id}
						row={row}
						{...(staged ? { staged: staged.value } : {})}
						{...(item.crumb ? { crumb: item.crumb } : {})}
						{...(errors[row.id] ? { error: errors[row.id] as string } : {})}
						flash={flash === row.id}
						phone={phone}
						onChange={v => change(row, v)}
						onUndo={() => setPending(list => list.filter(p => p.id !== row.id))}
						onReset={() => row.def && change(row, row.def.value)}
						onCopy={() => copy(row)}
					/>
				)
			}
		}
		return <span key={i} />
	}

	return (
		<section
			ref={rootRef}
			aria-label="Settings"
			className="wk-drawer wkf-set"
			data-phone={phone || undefined}
		>
			<header className="wkf-set-top">
				{back && (
					<button
						type="button"
						className="wk-btn wkf-set-back"
						data-variant="ghost"
						data-size="lg"
						aria-label={`Back to ${back.label}`}
						onClick={back.go}
					>
						<SetIcon name="chevron-left" size={18} />
						{back.label}
					</button>
				)}
				<h2 className="wk-h2 wkf-ellipsis">{title}</h2>
				<span className="wkf-gap" />
				{changedCount > 0 && page === null && (
					<button
						type="button"
						className="wk-chip"
						data-size="sm"
						aria-pressed={filters.includes("changed")}
						title="Show only the settings you changed"
						onClick={() => toggleFilter("changed")}
					>
						<span aria-hidden="true" className="wkf-set-bar" />
						{changedCount} changed
					</button>
				)}
				<button
					type="button"
					className="wk-icon-btn"
					data-close=""
					aria-label="Close settings"
					onClick={onClose}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M6 6l12 12M18 6l-12 12" />
					</svg>
				</button>
			</header>

			{page === null && (
				<div className="wkf-set-search">
					<div className="wk-field">
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
							className="wkf-set-quiet"
						>
							<path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M21 21l-6 -6" />
						</svg>
						{filters.map(f => {
							const label = FILTERS.find(x => x.id === f)?.label ?? f
							return (
								<span key={f} className="wk-token">
									{label}
									<button
										type="button"
										aria-label={`Remove filter ${label}`}
										onClick={() => toggleFilter(f)}
									>
										<svg
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeLinecap="round"
											aria-hidden="true"
										>
											<path d="M6 6l12 12M18 6l-12 12" />
										</svg>
									</button>
								</span>
							)
						})}
						<input
							ref={searchRef}
							aria-label="Search settings"
							placeholder={filters.length ? "Narrow down" : "Search settings"}
							spellCheck={false}
							autoComplete="off"
							value={query}
							onChange={e => setQuery(e.target.value)}
							onKeyDown={onSearchKey}
						/>
					</div>
				</div>
			)}

			<div className="wkf-set-main">
				{!phone && page === null && query === "" && filters.length === 0 && (
					<nav className="wkf-set-rail" aria-label="Settings sections">
						{SETTING_GROUPS.map(g => {
							const dot = railDots.get(g.id)
							return (
								<button
									key={g.id}
									type="button"
									className="wkf-set-railbtn"
									aria-current={current === g.id || undefined}
									onClick={() => jump(g.id)}
								>
									<SetIcon
										name={GROUP_ICON[g.id]}
										size={16}
										strokeWidth={1.8}
									/>
									<span className="wkf-grow wkf-ellipsis">
										{g.short ?? g.label}
									</span>
									{dot && (
										<>
											<span
												aria-hidden="true"
												className="wkf-set-dot"
												data-tone={dot}
											/>
											<span className="wk-sr">
												{dot === "amber" ? "Changes waiting" : "Changed"}
											</span>
										</>
									)}
								</button>
							)
						})}
					</nav>
				)}
				<div
					ref={scrollRef}
					className="wk-scroll wkf-set-scroll"
					data-wk-region=""
					tabIndex={-1}
					onScroll={onScroll}
				>
					{bandplans ? (
						<BandPlansPage
							band={band}
							onBand={(key: string | null) => {
								setBand(key)
								scrollRef.current?.scrollTo({ top: 0 })
							}}
							host={rootRef.current}
							phone={phone}
						/>
					) : showGroups ? (
						SETTING_GROUPS.map(g => {
							const dot = railDots.get(g.id)
							return (
								<button
									key={g.id}
									type="button"
									className="wk-row wkf-set-glink"
									onClick={() => setOnly(g.id)}
								>
									<span className="wk-tile">
										<SetIcon name={GROUP_ICON[g.id]} size={16} />
									</span>
									<span className="wkf-grow wkf-set-dec-text">
										<b>{g.label}</b>
										<span className="wkf-ellipsis wkf-set-quiet">
											{groupSummary(rows, g.id)}
										</span>
									</span>
									{dot && (
										<span
											aria-hidden="true"
											className="wkf-set-dot"
											data-tone={dot}
										/>
									)}
									<SetIcon
										name="chevron-right"
										size={16}
										className="wkf-set-chev"
									/>
								</button>
							)
						})
					) : (
						items.map(renderItem)
					)}
				</div>
			</div>

			{summary && (
				<div
					role="region"
					aria-label="Changes waiting to be applied"
					className="wkf-set-apply"
				>
					<span className="wkf-set-apply-text">
						<span aria-hidden="true" className="wkf-set-apply-dot" />
						<span>
							<b>{summary.title}</b>
							{summary.sub && <span>{summary.sub}</span>}
						</span>
					</span>
					<span className="wkf-set-apply-btns">
						<button
							type="button"
							className="wk-btn wkf-set-discard"
							data-size="lg"
							disabled={applying}
							onClick={() => {
								setPending([])
								for (const p of pending) setError(p.id, null)
							}}
						>
							Discard
						</button>
						<button
							type="button"
							className="wk-btn"
							data-variant="amber"
							data-size="lg"
							disabled={applying}
							onClick={() => void apply()}
						>
							{applying
								? "Applying…"
								: pending.length === 1
									? "Apply"
									: `Apply ${pending.length}`}
						</button>
					</span>
				</div>
			)}
		</section>
	)
}
