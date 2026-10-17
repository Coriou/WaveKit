import "./scanner-drawer.css"

// The Scanner drawer (Scanner board; DESIGN.md "Scanner second pass"): header "Scanner · count · Scan a
// band · ×", Watch here as one row (or Show plan / Hide plan while a sweep runs, with its live hit log),
// the discoveries list with typed-chip search and sort, the toast and a footer honest about coverage.
// The 2 Hz sweep progress is read only by the header count and the footer.
import { useEffect, useRef } from "react"

import { useReadOnly, useServices } from "../../../app/context.ts"
import { useStore } from "../../../data/index.ts"
import { Drawer } from "../../../ui/Drawer.tsx"
import { Seg } from "../../../ui/Seg.tsx"
import { Switch } from "../../../ui/Switch.tsx"
import { useNow, useTunerState } from "../../hooks.ts"
import { closePlan, openDiscovery, openPlan, scannerUi } from "../ui-store.ts"
import { dismissToast, drawerToast } from "./actions.ts"
import { DiscoveryList } from "./DiscoveryList.tsx"
import { HitLog } from "./HitLog.tsx"
import { ScanIcon } from "./icons.tsx"
import { closeMoreMenu, MoreMenu } from "./MoreMenu.tsx"
import { footerText, headerCount, isOneHop, spanText } from "./rows.ts"
import { buildDiscoveryQuery, sameQuery } from "./search.ts"
import { SearchBar } from "./SearchBar.tsx"
import type { DrawerTab } from "./state.ts"
import {
	clearSearch,
	drawerView,
	setTab,
	watchController,
	watchView,
} from "./state.ts"

export function ScannerDrawer({ onClose }: { onClose: () => void }) {
	const { data } = useServices()
	const scanner = data.scanner
	const root = useRef<HTMLElement>(null)
	const statusCode = useStore(scanner, s => s.statusErrorCode)
	const statusError = useStore(scanner, s =>
		s.status === null ? s.statusError : null,
	)
	const enabled = useStore(scanner, s => s.status?.enabled ?? null)
	const sweepId = useStore(scanner, s => s.sweep?.id ?? null)
	const tab = useStore(drawerView, s => s.tab)
	const readOnly = useReadOnly()

	useEffect(() => () => closeMoreMenu(), [])

	const close = () => {
		closePlan()
		onClose()
	}

	const missing = statusCode === "NOT_FOUND"
	const disabled = statusCode === "SCANNER_DISABLED" || enabled === false
	const usable = !missing && !disabled

	return (
		<Drawer
			ref={root}
			title="Scanner"
			className="wks-drawer"
			onClose={close}
			closeLabel="Close scanner"
			actions={<HeaderActions usable={usable && !readOnly} />}
		>
			{missing ? (
				<Unavailable
					title="No scanner on this WaveKit"
					text="This core has no scanner routes. Update WaveKit to find signals."
				/>
			) : disabled ? (
				<Unavailable
					title="Scanner is off"
					text="Turn it on with scanner.enabled in the WaveKit config."
				/>
			) : statusError !== null ? (
				<Unavailable
					title="Could not reach the scanner"
					text={statusError}
					retry={() => void scanner.load()}
				/>
			) : (
				<>
					<div className="wks-top">
						{readOnly && (
							<p className="wks-banner" role="status">
								<ScanIcon name="lock" size={15} />
								View only · your access can follow scans but not change them
							</p>
						)}
						{sweepId !== null ? <PlanRow /> : <WatchRow readOnly={readOnly} />}
					</div>
					{sweepId !== null && (
						<div className="wks-tabs">
							<Seg<DrawerTab>
								label="Show"
								wide
								value={tab}
								onChange={setTab}
								options={[
									{ value: "scan", label: "This scan" },
									{ value: "all", label: "All discoveries" },
								]}
							/>
						</div>
					)}
					{sweepId !== null && tab === "scan" ? (
						<SweepHits jobId={sweepId} />
					) : (
						<Discoveries />
					)}
				</>
			)}
			<Toast />
			<Footer />
			<MoreMenu root={root} />
		</Drawer>
	)
}

function HeaderActions({ usable }: { usable: boolean }) {
	const planOpen = useStore(scannerUi, s => s.planOpen)
	const running = useStore(useServices().data.scanner, s => s.sweep !== null)
	return (
		<>
			<HeaderCount />
			<span className="wks-head-gap" />
			{usable && !running && (
				<button
					type="button"
					className="wk-chip wks-plan-btn"
					aria-pressed={planOpen}
					title={
						planOpen ? "Hide the plan" : "Plan a scan of one or more bands"
					}
					onClick={() => (planOpen ? closePlan() : openPlan())}
				>
					<ScanIcon name="scanner" size={15} />
					Scan a band
				</button>
			)}
		</>
	)
}

function HeaderCount() {
	const scanner = useServices().data.scanner
	const sweep = useStore(scanner, s => s.sweep)
	const found = useStore(scanner, s =>
		s.sweep ? (s.jobHits.get(s.sweep.id)?.size ?? 0) : 0,
	)
	const freshLocal = useStore(scanner, s => {
		const hits = s.sweep ? s.jobHits.get(s.sweep.id) : undefined
		let n = 0
		if (hits) for (const h of hits.values()) if (h.firstSeenInJob) n++
		return n
	})
	const freshCore = useStore(scanner.progress, p => p?.newDiscoveries ?? null)
	const listed = useStore(
		scanner,
		s => s.discoveries.items.filter(d => d.operator?.lockout !== true).length,
	)
	const more = useStore(scanner, s => s.discoveries.nextCursor !== null)
	const loaded = useStore(scanner, s => s.discoveries.loaded)
	const text = headerCount({
		sweep,
		found,
		fresh: Math.max(freshLocal, freshCore ?? 0),
		listed,
		more,
		loaded,
	})
	if (!text) return null
	return (
		<span
			className="wks-count"
			title={
				sweep
					? isOneHop(sweep)
						? "Fits in one hop: the receiver stays put and watches the whole range at once"
						: `Steps through ${sweep.plan.hops.length} hops`
					: undefined
			}
		>
			{text}
		</span>
	)
}

function WatchRow({ readOnly }: { readOnly: boolean }) {
	const { data } = useServices()
	const tuner = useTunerState()
	const sourceId = tuner?.sourceId ?? null
	const watch = watchController(data.api, data.scanner)
	const state = useStore(watch)
	const engine = useStore(data.scanner, s =>
		s.status?.engines.find(e => e.sourceId === sourceId),
	)
	useEffect(() => {
		void watch.load()
	}, [watch])
	const v = watchView(sourceId, state, engine, readOnly)
	const span = tuner ? spanText(tuner.frequency, tuner.sampleRate) : null
	const tip = "Finds signals where you are tuned. Never moves the receiver."
	return (
		<>
			<section
				className="wks-watch"
				data-on={v.on || undefined}
				aria-label="Watch here"
			>
				<ScanIcon
					name={v.on ? "eye" : "eye-off"}
					size={16}
					className="wks-watch-eye"
				/>
				<span id="wks-watch-head" className="wks-watch-head" title={tip}>
					<b>Watch here</b>
					<span className="wks-quiet"> · {v.on && span ? span : "Off"}</span>
				</span>
				<span className="wks-gap" />
				{v.on && (
					<span
						className="wks-watch-looks"
						title="Watch here tries every protocol. Choosing them needs core support (passive protocols)."
					>
						Any signal
					</span>
				)}
				{v.canToggle || state.pending !== null ? (
					<Switch
						size="row"
						checked={v.on}
						disabled={!v.canToggle}
						aria-labelledby="wks-watch-head"
						title={tip}
						onChange={on => {
							if (sourceId) void watch.setWatching(sourceId, on)
						}}
					/>
				) : (
					<span className="wks-watch-ro" title={v.why ?? undefined}>
						{v.on ? "On" : "Off"}
					</span>
				)}
			</section>
			{state.error && (
				<p className="wks-watch-error" role="alert">
					Could not change Watch here: {state.error}
				</p>
			)}
		</>
	)
}

function PlanRow() {
	const planOpen = useStore(scannerUi, s => s.planOpen)
	return (
		<button
			type="button"
			className="wk-btn wks-planrow"
			data-variant="outline"
			data-size="lg"
			aria-expanded={planOpen}
			onClick={() => (planOpen ? closePlan() : openPlan())}
		>
			<ScanIcon name={planOpen ? "chevron-right" : "chevron-left"} size={15} />
			{planOpen ? "Hide plan" : "Show plan"}
		</button>
	)
}

function SweepHits({ jobId }: { jobId: string }) {
	const oneHop = useStore(useServices().data.scanner, s =>
		s.sweep ? isOneHop(s.sweep) : false,
	)
	return <HitLog jobId={jobId} oneHop={oneHop} />
}

function Discoveries() {
	const scanner = useServices().data.scanner
	const tokens = useStore(drawerView, s => s.tokens)
	const sort = useStore(drawerView, s => s.sort)
	const loaded = useStore(scanner, s => s.discoveries.loaded)
	const loading = useStore(scanner, s => s.discoveries.loading)
	const error = useStore(scanner, s => s.discoveries.error)
	const count = useStore(scanner, s => s.discoveries.items.length)
	const more = useStore(scanner, s => s.discoveries.nextCursor !== null)

	// a new search closes the open row (the first run keeps one opened from elsewhere)
	const first = useRef(true)
	useEffect(() => {
		if (first.current) first.current = false
		else openDiscovery(null)
		const q = buildDiscoveryQuery(tokens, sort)
		const d = scanner.get().discoveries
		if (!d.loaded || !sameQuery(d.query, q)) void scanner.refreshDiscoveries(q)
	}, [tokens, sort, scanner])

	const searching = tokens.length > 0
	return (
		<>
			<SearchBar
				count={searching && loaded ? `${count}${more ? "+" : ""}` : null}
			/>
			{error && (
				<p className="wks-note" data-tone="warn">
					Could not load discoveries: {error}{" "}
					<button
						type="button"
						className="wks-link"
						onClick={() => void scanner.refreshDiscoveries()}
					>
						Try again
					</button>
				</p>
			)}
			{!loaded && loading && (
				<p className="wks-note">
					<span className="wk-spinner" aria-hidden="true" /> Loading
					discoveries…
				</p>
			)}
			{loaded &&
				count === 0 &&
				!loading &&
				!error &&
				(searching ? (
					<div className="wks-empty">
						<span className="wks-empty-title">Nothing matches</span>
						<span className="wks-empty-text">
							Ignored signals are searched too.
						</span>
						<button
							type="button"
							className="wk-btn"
							data-variant="outline"
							data-size="lg"
							onClick={clearSearch}
						>
							Clear search
						</button>
					</div>
				) : (
					<div className="wks-empty">
						<span className="wks-empty-icon">
							<ScanIcon name="scanner" size={22} />
						</span>
						<span className="wks-empty-title">Nothing found yet</span>
						<span className="wks-empty-text">
							Signals the scanner finds land here.
						</span>
					</div>
				))}
			{(count > 0 || !loaded) && <DiscoveryList />}
		</>
	)
}

function Toast() {
	const toast = useStore(drawerToast)
	if (!toast) return null
	return (
		<div
			role="status"
			className="wk-toast wks-toast"
			data-inline=""
			data-tone={toast.tone}
		>
			<span className="wks-toast-text">{toast.text}</span>
			{toast.undo ? (
				<button
					type="button"
					className="wk-btn"
					data-variant="tonal"
					data-size="sm"
					onClick={toast.undo}
				>
					Undo
				</button>
			) : (
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Dismiss"
					onClick={dismissToast}
				>
					<ScanIcon name="close" size={14} />
				</button>
			)}
		</div>
	)
}

function Footer() {
	const { data } = useServices()
	const scanner = data.scanner
	const readOnly = useReadOnly()
	const sweep = useStore(scanner, s => s.sweep)
	const lastSweep = useStore(scanner, s =>
		s.sweep === null && s.lastSweepId !== null
			? (s.jobs.get(s.lastSweepId) ?? null)
			: null,
	)
	const found = useStore(scanner, s => {
		const id = s.sweep?.id ?? s.lastSweepId
		return id
			? (s.jobHits.get(id)?.size ?? s.jobHitStats.get(id)?.discoveries ?? 0)
			: 0
	})
	const passive = useStore(scanner, s => s.passive)
	const progress = useStore(scanner.progress)
	const tuner = useTunerState()
	const watch = useStore(watchController(data.api, scanner))
	const engine = useStore(scanner, s =>
		s.status?.engines.find(e => e.sourceId === tuner?.sourceId),
	)
	const watching = watchView(
		tuner?.sourceId ?? null,
		watch,
		engine,
		readOnly,
	).on
	// ticks while idle; while a sweep runs, progress re-renders this anyway
	useNow(true, 15_000)
	const now = Date.now()
	const text = footerText({
		sweep,
		lastSweep,
		progress,
		passive,
		watching,
		found,
		readOnly,
		now,
	})
	const amber = sweep?.state === "paused"
	return (
		<footer className="wks-footer" data-tone={amber ? "amber" : undefined}>
			<span className="wks-ellipsis" title={text}>
				{text}
			</span>
		</footer>
	)
}

function Unavailable({
	title,
	text,
	retry,
}: {
	title: string
	text: string
	retry?: () => void
}) {
	return (
		<div className="wks-empty">
			<span className="wks-empty-icon">
				<ScanIcon name="scanner" size={22} />
			</span>
			<span className="wks-empty-title">{title}</span>
			<span className="wks-empty-text">{text}</span>
			{retry && (
				<button
					type="button"
					className="wk-btn"
					data-variant="outline"
					data-size="lg"
					onClick={retry}
				>
					Try again
				</button>
			)}
		</div>
	)
}
