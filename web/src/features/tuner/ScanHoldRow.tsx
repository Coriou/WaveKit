// The scan hold row under the Tuner head (docs/web/canvas/Tuner.dc.html `hold`; DESIGN.md "Scanner UX review",
// "Scanner second pass"): the only status and control of a running sweep. Glyph, the scan's name, the frequency it is
// on, Pause / Resume / Stop, and Skip / Ignore / Save while it holds on a hit; a thin pass-progress line moved by
// transform only. Phosphor (accent) while live, amber when paused. A click opens the scan plan in the Scanner drawer.
// Solid surface (no backdrop blur): it adds no blurred layer over the waterfall.
import "./scan-hold.css"

import { useEffect, useState, type MouseEvent } from "react"
import type { Discovery, ScanJob } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import { bandAt, channelAt, errorMessage, useStore } from "../../data/index.ts"
import { heldFrequencyHz, isJobActive } from "../../data/scanner-format.ts"
import { takeoverImpact } from "../../data/scanner-store.ts"
import { shellStore } from "../../shell/store.ts"
import { openPlan } from "../scanner/ui-store.ts"
import { useLiveStatus, useNow, useSettledHz } from "../hooks.ts"
import { decoderLabel } from "../tuned/signal.ts"
import { modulationOf } from "./modes.ts"
import { defaultSaveName, saveInput } from "./saved.ts"
import {
	heldDiscoveryId,
	holdRowModel,
	holdSaveName,
	skipPatch,
	type HoldAction,
	type HoldGlyph,
} from "./scan-hold.ts"

// Tabler outline paths, as the Tuner board draws them (HI, SCAN_ICON).
const GLYPH: Readonly<Record<HoldGlyph, readonly string[]>> = {
	scan: [
		"M21 12h-8a1 1 0 1 0 -1 1v8a9 9 0 0 0 9 -9",
		"M16 9a5 5 0 1 0 -7 7",
		"M20.486 9a9 9 0 1 0 -11.482 11.495",
	],
	eye: [
		"M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0",
		"M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6",
	],
	pause: ["M6 5h4v14h-4zM14 5h4v14h-4z"],
	plug: [
		"M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054z",
		"M4 20l3.5 -3.5",
		"M15 4l-3.5 3.5",
		"M20 9l-3.5 3.5",
	],
	warn: [
		"M12 9v4",
		"M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z",
		"M12 16h.01",
	],
}
const BUTTON_ICON: Readonly<
	Record<NonNullable<HoldAction["icon"]>, readonly string[]>
> = {
	pause: GLYPH.pause,
	play: ["M7 4v16l13 -8z"],
	stop: ["M6 6h12v12h-12z"],
	skip: ["M4 5v14l12 -7z", "M20 5v14"],
	ignore: [
		"M3 3l18 18",
		"M10.585 10.587a2 2 0 0 0 2.829 2.828",
		"M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674",
	],
	star: [
		"M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z",
	],
}

function Paths({ d }: { d: readonly string[] }) {
	return (
		<>
			{d.map(p => (
				<path key={p} d={p} />
			))}
		</>
	)
}

/** The operator's live sweep job, or null. */
export function useSweep(): ScanJob | null {
	return useStore(useServices().data.scanner, s => s.sweep)
}

/**
 * Where a holding sweep sits: the frequency (probe on the held track, else the strongest active
 * observation) and the discovery, when known. Both null unless the sweep holds.
 */
export function useHeld(sweep: ScanJob | null): {
	heldHz: number | null
	held: Discovery | null
} {
	const { scanner } = useServices().data
	const holding = sweep?.state === "holding" ? sweep : null
	const holdingOn = useStore(scanner.progress, p =>
		holding && p?.jobId === holding.id ? (p.holdingOn ?? null) : null,
	)
	const heldHz = useStore(scanner, s =>
		holding ? heldFrequencyHz(holding, holdingOn, s.activity.values()) : null,
	)
	const heldId = useStore(scanner, s =>
		holding ? heldDiscoveryId(holding, s.activity.values(), heldHz) : null,
	)
	const held = useStore(scanner, s =>
		heldId === null ? null : (s.discoveries.byId.get(heldId) ?? null),
	)
	// an observation names a discovery this page has not seen yet: fetch it once
	useEffect(() => {
		if (heldId !== null && !scanner.discovery(heldId))
			scanner.fetchDiscovery(heldId).catch(() => undefined)
	}, [scanner, heldId])
	return { heldHz, held }
}

/** Opens the Scanner drawer with the plan pane (running mode while a sweep runs). */
export function openScanPlan(): void {
	openPlan()
	shellStore.openDrawer("scanner")
}

export function ScanHoldRow() {
	const sweep = useSweep()
	if (!sweep || !isJobActive(sweep.state)) return null
	return <HoldRow job={sweep} />
}

function HoldRow({ job }: { job: ScanJob }) {
	const { data, decoders } = useServices()
	const { scanner } = data
	const readOnly = useReadOnly()
	const progress = useStore(scanner.progress, p =>
		p?.jobId === job.id ? p : null,
	)
	const { heldHz, held } = useHeld(job)
	const status = useLiveStatus()
	const view = useStore(data.bandplan, s => s.view)
	// the row says what the Tuner digits say: the tuned frequency moves at once, progress is throttled
	// to 2 Hz and can lag a hop
	const tunedHz = useSettledHz()
	const shown =
		progress && job.state === "running" && tunedHz !== null
			? { ...progress, centerHz: tunedHz }
			: progress
	// while holding, live audio sits on the hit: the tuned frequency until the core names it
	const heldAt =
		heldHz ?? held?.frequencyHz ?? (job.state === "holding" ? tunedHz : null)
	const saved = useStore(
		data.savedFrequencies,
		s =>
			heldAt !== null &&
			s.items.some(f => f.frequencyHz === Math.round(heldAt)),
	)
	const [consent, setConsent] = useState<string[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	// "resumes in 42 s" counts down
	const ticking = job.state === "paused" && job.resumeAt !== null
	const now = useNow(ticking, 1000)

	// a consent question or an error belongs to the state it was asked in
	useEffect(() => {
		setConsent(null)
		setError(null)
	}, [job.state, job.reason])
	useEffect(() => {
		if (error === null) return
		const t = setTimeout(() => setError(null), 5000)
		return () => clearTimeout(t)
	}, [error])

	const model = holdRowModel({
		job,
		progress: shown,
		now,
		heldHz: heldAt,
		held,
		saved,
		consent,
		readOnly,
	})

	const run = (work: () => Promise<unknown>) => {
		setBusy(true)
		setError(null)
		work()
			.catch((err: unknown) => {
				const impact = takeoverImpact(err)
				if (impact) {
					const all = decoders.get().decoders
					setConsent(
						impact.runningDecoders.map(id =>
							decoderLabel(all.find(d => d.id === id)?.type ?? id),
						),
					)
				} else setError(errorMessage(err))
			})
			.finally(() => setBusy(false))
	}

	const act = (a: HoldAction, e: MouseEvent) => {
		e.stopPropagation()
		switch (a.id) {
			case "pause":
			case "stay":
				return run(() => scanner.pauseJob(job.id))
			case "resume":
				return run(() => scanner.resumeJob(job.id))
			case "takeover":
				return run(() => scanner.resumeJob(job.id, { takeover: true }))
			case "stop":
				return run(() => scanner.cancelJob(job.id))
			case "skip":
				if (heldAt === null) return
				return run(() =>
					scanner.patchJob(
						job.id,
						skipPatch(job, heldAt, held?.bandwidthHz ?? null),
					),
				)
			case "ignore":
				if (!held) return
				return run(() => scanner.patchDiscovery(held.id, { lockout: true }))
			case "save": {
				if (heldAt === null || saved) return
				const band = bandAt(view, heldAt)
				const input = saveInput(
					{
						hz: heldAt,
						config: status?.config ?? null,
						bandMode: modulationOf(band?.band.mode),
					},
					holdSaveName(
						held,
						defaultSaveName(
							heldAt,
							channelAt(band, heldAt)?.name,
							band?.band.name,
						),
					),
					null,
				)
				return run(() => data.savedFrequencies.create(input))
			}
		}
	}

	const tone = model.tone === "paused" ? "paused" : "live"
	return (
		<div
			className="wkf-hold"
			data-tone={tone}
			role="status"
			title={model.tooltip}
			onClick={openScanPlan}
		>
			{model.pulse ? (
				<span className="wk-live wkf-hold-pulse" aria-hidden="true" />
			) : (
				<svg
					className="wkf-hold-glyph"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.9"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
					focusable="false"
				>
					<Paths d={GLYPH[model.glyph]} />
				</svg>
			)}
			<button
				type="button"
				className="wkf-hold-open"
				aria-label={model.aria}
				onClick={e => {
					e.stopPropagation()
					openScanPlan()
				}}
			>
				<span className="wkf-hold-words">
					<b>{model.title}</b>
					{error !== null ? (
						<span className="wkf-hold-err"> · {error}</span>
					) : (
						model.detail
					)}
				</span>
				{model.freq !== null && (
					<span className="wkf-hold-freq">{model.freq}</span>
				)}
			</button>
			{model.actions.map(a => (
				<button
					key={a.id}
					type="button"
					className="wkf-hold-btn"
					data-kind={a.kind}
					data-pressed={a.pressed || undefined}
					data-icon-only={a.label === "" || undefined}
					aria-label={a.aria}
					aria-pressed={a.id === "save" ? (a.pressed ?? false) : undefined}
					title={a.title}
					disabled={
						busy ||
						(a.id === "ignore" && !held) ||
						((a.id === "skip" || a.id === "save") && heldAt === null)
					}
					onClick={e => act(a, e)}
				>
					{a.icon && (
						<svg
							width="13"
							height="13"
							viewBox="0 0 24 24"
							fill={a.pressed ? "currentColor" : "none"}
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
							focusable="false"
						>
							<Paths d={BUTTON_ICON[a.icon]} />
						</svg>
					)}
					{a.label && <span className="wkf-hold-label">{a.label}</span>}
				</button>
			))}
			{model.bar !== null && (
				<span className="wkf-hold-bar" aria-hidden="true">
					<span style={{ transform: `scaleX(${model.bar})` }} />
				</span>
			)}
		</div>
	)
}
