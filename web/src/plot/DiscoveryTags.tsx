// Scanner discovery tags on the plot's discovery row (docs/web/canvas/Spectrum.dc.html `discTags`): a third, quieter
// tier under the saved-frequency tags; click tunes. The tags read `layer.scanner` discoveries (byId), which a debounced
// fetch fills for the visible span; they re-render when the discoveries, the active set, the view, the width or the
// saved list change, and once a minute for the last-hour tier (never per spectrum frame).
import "./discovery-tags.css"

import { memo, useEffect, useMemo, useRef } from "react"

import type { DataLayer } from "../data/index.ts"
import { useStore } from "../data/index.ts"
import type { ScannerStore } from "../data/scanner-store.ts"
import { useNow } from "../features/hooks.ts"
import type { DiscoveryTagMode } from "../shell/device-prefs.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import {
	discoveryFetchSpan,
	hasTaggable,
	placeDiscoveryTags,
	type FetchedSpan,
} from "./discovery-tags.ts"
import type { PlotController } from "./plot-store.ts"

/** Settle time after a pan or zoom before asking the core for the span's discoveries. */
const FETCH_DEBOUNCE_MS = 400
/** One page of the span's most recent discoveries (core max 500). */
const FETCH_LIMIT = 300

/** Whether the scanner answers on this core (no fetches, no row when it does not). */
function scannerUp(s: ReturnType<ScannerStore["get"]>): boolean {
	return s.statusErrorCode === null && s.status !== null
}

/** True while the discovery row has something to show under `mode` (Off: never): the plot keeps its gap for it. */
export function useDiscoveryRow(
	scanner: ScannerStore,
	mode: DiscoveryTagMode = "all",
): boolean {
	return useStore(
		scanner,
		s =>
			mode !== "off" && scannerUp(s) && hasTaggable(s.discoveries.byId, mode),
	)
}

/**
 * Keeps `byId` filled for the visible span: a debounced GET /api/scanner/discoveries limited to the
 * view (plus half a view each side), most recent first. A pan inside the fetched span within a minute
 * asks nothing; live `scanner:discovery` events keep what is loaded current.
 */
export function useDiscoveryFetch(
	scanner: ScannerStore,
	view: SpectrumViewSpan | null,
): void {
	const up = useStore(scanner, scannerUp)
	const last = useRef<FetchedSpan | null>(null)
	const startHz = view?.startHz ?? null
	const endHz = view?.endHz ?? null
	useEffect(() => {
		if (!up || startHz === null || endHz === null) return
		const abort = new AbortController()
		const timer = setTimeout(() => {
			const span = discoveryFetchSpan(
				{ startHz, endHz },
				last.current,
				Date.now(),
			)
			if (!span) return
			scanner
				.fetchDiscoveries(
					{
						freqMinHz: span.startHz,
						freqMaxHz: span.endHz,
						sort: "lastSeen",
						limit: FETCH_LIMIT,
					},
					{ signal: abort.signal },
				)
				.then(
					() => {
						last.current = { ...span, at: Date.now() }
					},
					() => undefined,
				)
		}, FETCH_DEBOUNCE_MS)
		return () => {
			clearTimeout(timer)
			abort.abort()
		}
	}, [scanner, up, startHz, endHz])
}

export interface DiscoveryTagsProps {
	data: DataLayer
	controller: PlotController
	view: SpectrumViewSpan
	widthPx: number
	/** Display › Discoveries on the spectrum; Off draws none. */
	mode?: DiscoveryTagMode
}

export const DiscoveryTags = memo(function DiscoveryTags({
	data,
	controller,
	view,
	widthPx,
	mode = "all",
}: DiscoveryTagsProps) {
	const byId = useStore(data.scanner, s => s.discoveries.byId)
	const activeNow = useStore(data.scanner, s => s.activeNow)
	const saved = useStore(data.savedFrequencies, s => s.items)
	// the last-hour tier moves on slowly: a minute is fine
	const now = useNow(true, 60_000)
	const savedHz = useMemo(() => saved.map(f => f.frequencyHz), [saved])
	const placed = useMemo(
		() =>
			mode === "off"
				? []
				: placeDiscoveryTags(byId.values(), view, {
						widthPx,
						activeNow,
						now,
						savedHz,
						only: mode,
					}),
		[byId, activeNow, now, savedHz, view.startHz, view.endHz, widthPx, mode],
	)
	return (
		<>
			{placed.map(t => (
				<button
					key={t.id}
					type="button"
					className="wk-plot-disc"
					data-tier={t.tier}
					data-heard={t.heard || undefined}
					style={{ left: t.x }}
					aria-label={`Discovery: ${t.title}`}
					title={t.title}
					onClick={() => void controller.tuneTo(t.hz)}
				>
					<i data-solid={t.solid || undefined} aria-hidden="true" />
					{t.labelled && <span>{t.label}</span>}
				</button>
			))}
		</>
	)
})
