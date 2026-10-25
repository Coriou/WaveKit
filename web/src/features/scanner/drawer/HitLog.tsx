// The live hit log of the running scan ("This scan"): what the sweep heard, live ones first, then the new
// ones, then the most recent; "New only" keeps the discoveries this scan found first. Windowed like the list.
// An open row can Skip its channel for the rest of this scan (the Tuner's scan row does it for the held one).
import type { ScanJob } from "@wavekit/api-types"
import { WaveKitIcon } from "@wavekit/brand/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useDisplay } from "../../display.ts"
import { useReadOnly, useServices } from "../../../app/context.ts"
import { isJobActive, useStore } from "../../../data/index.ts"
import { skipState } from "../../tuner/scan-hold.ts"
import { openDiscovery } from "../ui-store.ts"
import { listenTo, setIgnored, setSkipped, toggleSaved } from "./actions.ts"
import { ScanIcon } from "./icons.tsx"
import type { HitEntry } from "./rows.ts"
import { discoveryRow, frequencyParts, hitEntries, hitMeta } from "./rows.ts"
import { drawerView, setTab, toggleNewOnly } from "./state.ts"
import { useVirtual } from "./use-virtual.ts"

const EMPTY = new Map<never, never>()

export function HitLog({ jobId, oneHop }: { jobId: string; oneHop: boolean }) {
	const { data } = useServices()
	const scanner = data.scanner
	const hits = useStore(scanner, s => s.jobHits.get(jobId) ?? EMPTY)
	const job = useStore(scanner, s => s.jobs.get(jobId) ?? null)
	const byId = useStore(scanner, s => s.discoveries.byId)
	const activeNow = useStore(scanner, s => s.activeNow)
	const newOnly = useStore(drawerView, s => s.newOnly)
	const [openId, setOpenId] = useState<string | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)

	// hits from before the drawer opened
	useEffect(() => {
		scanner.getJobHits(jobId, 500).then(
			() => setLoadError(null),
			(error: unknown) =>
				setLoadError(error instanceof Error ? error.message : "failed"),
		)
	}, [jobId, scanner])

	// discoveries the store has not seen yet (hit before this page loaded), a few at a time
	const asked = useRef(new Set<string>())
	useEffect(() => {
		let n = 0
		for (const id of hits.keys()) {
			if (byId.has(id) || asked.current.has(id)) continue
			if (n++ >= 20) break
			asked.current.add(id)
			scanner.fetchDiscovery(id).catch(() => undefined)
		}
	}, [hits, byId, scanner])

	const entries = useMemo(
		() => hitEntries(hits, byId, activeNow, newOnly),
		[hits, byId, activeNow, newOnly],
	)
	const keys = useMemo(() => entries.map(e => e.hit.discoveryId), [entries])
	const toggle = useCallback(
		(id: string) => setOpenId(o => (o === id ? null : id)),
		[],
	)
	const v = useVirtual(keys, i => (keys[i] === openId ? 112 : 62))

	return (
		<>
			<div className="wks-hits-bar">
				<span className="wks-gap" />
				<button
					type="button"
					className="wk-chip"
					data-tick=""
					aria-pressed={newOnly}
					onClick={toggleNewOnly}
				>
					New only
				</button>
			</div>
			<div className="wks-listwrap">
				<div
					ref={v.scroller}
					className="wks-list wk-scroll"
					role="list"
					aria-label="Hits in this scan"
					tabIndex={0}
					onScroll={v.onScroll}
				>
					{entries.length === 0 && (
						<p className="wks-empty-line">
							{loadError
								? `Could not load the hits: ${loadError}`
								: newOnly
									? "Nothing new yet"
									: oneHop
										? "Nothing heard yet · watching the whole range"
										: "Nothing heard yet"}
						</p>
					)}
					<div style={{ height: v.win.total, position: "relative" }}>
						<div
							className="wks-window"
							style={{ transform: `translateY(${v.win.offset}px)` }}
						>
							{entries.slice(v.win.start, v.win.end).map(e => (
								<HitRow
									key={e.hit.discoveryId}
									hit={e.hit}
									discovery={e.discovery}
									live={e.live}
									fresh={e.fresh}
									job={job}
									open={openId === e.hit.discoveryId}
									measure={v.measure}
									onToggle={toggle}
								/>
							))}
						</div>
					</div>
				</div>
			</div>
		</>
	)
}

const HitRow = memo(function HitRow({
	hit,
	discovery,
	live,
	fresh,
	job,
	open,
	measure,
	onToggle,
}: HitEntry & {
	job: ScanJob | null
	open: boolean
	measure: (el: HTMLElement | null) => void
	onToggle: (id: string) => void
}) {
	useDisplay() // times follow Settings › Display
	const services = useServices()
	const readOnly = useReadOnly()
	const e: HitEntry = { hit, discovery, live, fresh }
	const d = discovery
	const id = hit.discoveryId
	const row = d ? discoveryRow(d, Date.now()) : null
	const parts = d ? frequencyParts(d.frequencyHz) : null
	const saved = useStore(services.data.savedFrequencies, s =>
		d ? s.items.some(f => f.frequencyHz === Math.round(d.frequencyHz)) : false,
	)
	const ignored = d?.operator?.lockout === true
	// only while the scan runs: an ended job's skips change nothing
	const skip =
		d && job && isJobActive(job.state) ? skipState(job, d.frequencyHz) : null
	return (
		<article
			data-key={id}
			ref={measure}
			role="listitem"
			className="wks-item"
			data-open={open || undefined}
			data-ignored={ignored || undefined}
			data-skipped={skip !== null || undefined}
		>
			<button
				type="button"
				className="wk-row wks-row"
				aria-expanded={open}
				onClick={() => onToggle(id)}
			>
				<span
					className="wk-tile wks-tile"
					data-tone={row?.tone ?? "quiet"}
					aria-hidden="true"
				>
					{row?.icon ? (
						<WaveKitIcon name={row.icon} size={16} />
					) : (
						<ScanIcon name="wave" size={16} />
					)}
				</span>
				<span className="wks-main">
					<span className="wks-line1">
						<span className="wks-freq">
							{parts?.main ?? "…"}
							<span className="wks-freq-tail">{parts?.tail}</span>
						</span>
						<span className="wks-conf wks-ellipsis" data-tone={row?.tone}>
							{row
								? row.title
									? `${row.confidence} · ${row.title}`
									: row.confidence
								: ""}
						</span>
						<span className="wks-gap" />
						{skip !== null && <span className="wk-tag">Skipped</span>}
						{e.fresh && (
							<span className="wk-tag" data-variant="accent">
								New
							</span>
						)}
						{saved && (
							<ScanIcon
								name="bookmark"
								size={12}
								filled
								className="wks-kept"
								role="img"
								aria-label="Saved"
								aria-hidden={undefined}
							/>
						)}
						{e.live && (
							<span className="wks-now">
								<span className="wk-live" aria-hidden="true" />
								Now
							</span>
						)}
					</span>
					<span className="wks-reason">{hitMeta(e)}</span>
					{row && row.next !== null && (
						<span className="wks-reason wks-hint">
							{row.likely && <span className="wks-likely">{row.likely}</span>}
							{row.likely && " · "}
							<span className="wks-next">{row.next}</span>
						</span>
					)}
				</span>
			</button>
			{open && d && (
				<div className="wks-hit-acts">
					{!readOnly && (
						<button
							type="button"
							className="wk-btn"
							data-variant="primary"
							title="Tunes there and plays it · the scan pauses"
							onClick={() => void listenTo(services, d)}
						>
							<ScanIcon name="headphones" size={14} strokeWidth={2.2} />
							Listen
						</button>
					)}
					{!readOnly && (
						<button
							type="button"
							className="wk-btn"
							data-variant="ghost"
							aria-pressed={saved}
							aria-label={saved ? "Saved" : "Save"}
							onClick={() => void toggleSaved(services, d)}
						>
							<ScanIcon name="bookmark" size={14} filled={saved} />
							<span className="wks-hit-lbl">{saved ? "Saved" : "Save"}</span>
						</button>
					)}
					{!readOnly && (
						<button
							type="button"
							className="wk-btn"
							data-variant="ghost"
							aria-pressed={ignored}
							aria-label={ignored ? "Ignored" : "Ignore"}
							title="Always: never probed, recorded or scanned again"
							onClick={() => void setIgnored(services, d, !ignored)}
						>
							<ScanIcon name="eye-off" size={14} />
							<span className="wks-hit-lbl">
								{ignored ? "Ignored" : "Ignore"}
							</span>
						</button>
					)}
					{!readOnly && job && isJobActive(job.state) && (
						<button
							type="button"
							className="wk-btn"
							data-variant="ghost"
							aria-pressed={skip !== null}
							aria-label={skip !== null ? "Skipped" : "Skip"}
							disabled={skip === "plan"}
							title={
								skip === "plan"
									? "The plan already skips it"
									: skip === "you"
										? "Put it back in this scan"
										: "This scan only: the sweep stops visiting it"
							}
							onClick={() => void setSkipped(services, job, d, skip === null)}
						>
							<ScanIcon name="skip" size={14} />
							<span className="wks-hit-lbl">
								{skip !== null ? "Skipped" : "Skip"}
							</span>
						</button>
					)}
					<button
						type="button"
						className="wk-btn"
						data-variant="ghost"
						title="Open it in All discoveries"
						onClick={() => {
							setTab("all")
							openDiscovery(id)
						}}
					>
						Details
					</button>
				</div>
			)}
		</article>
	)
})
