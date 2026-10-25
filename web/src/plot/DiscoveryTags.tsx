// Scanner discovery tags on the plot's discovery row (docs/web/canvas/Spectrum.dc.html `discTags`): a third, quieter
// tier under the saved-frequency tags; click tunes. The tags read `layer.scanner` discoveries (byId), which a debounced
// fetch fills for the visible span; they re-render when the discoveries, the active set, the view, the width or the
// saved list change, and once a minute for the last-hour tier (never per spectrum frame).
import "./discovery-tags.css"

import type { Discovery } from "@wavekit/api-types"
import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react"

import type { DataLayer } from "../data/index.ts"
import { useStore } from "../data/index.ts"
import type { ScannerStore } from "../data/scanner-store.ts"
import { isVerified, whatIsThis } from "../data/scanner-format.ts"
import { useNow } from "../features/hooks.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import {
	discoveryFetchSpan,
	type DiscoveryTagFilter,
	hasTaggable,
	outsideView,
	placeDiscoveryTags,
	type FetchedSpan,
	type OutsideSide,
	type PlacedDiscoveryTag,
} from "./discovery-tags.ts"
import { formatMHz } from "./maths.ts"
import type { PlotController } from "./plot-store.ts"

/** Settle time after a pan or zoom before asking the core for the span's discoveries. */
const FETCH_DEBOUNCE_MS = 400
/** One page of the span's most recent discoveries (core max 500). */
const FETCH_LIMIT = 300

/** Whether the scanner answers on this core (no fetches, no row when it does not). */
function scannerUp(s: ReturnType<ScannerStore["get"]>): boolean {
	return s.statusErrorCode === null && s.status !== null
}

/** True while the discovery row has something to show (`only`: which discoveries count): the plot keeps its gap for it. */
export function useDiscoveryRow(
	scanner: ScannerStore,
	only: DiscoveryTagFilter = "all",
): boolean {
	return useStore(
		scanner,
		s => scannerUp(s) && hasTaggable(s.discoveries.byId, only),
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
	// the core said what is loaded may be stale (a truncated merge, a resync): ask again
	const epoch = useStore(scanner, s => s.discoveries.epoch)
	const last = useRef<FetchedSpan | null>(null)
	const lastEpoch = useRef(epoch)
	if (lastEpoch.current !== epoch) {
		lastEpoch.current = epoch
		last.current = null
	}
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
	}, [scanner, up, startHz, endHz, epoch])
}

/** Popovers and confirms of the discovery row: the plot's pointer, wheel and menu handlers leave them alone. */
export const DISCOVERY_POP_CLASS = "wk-plot-disc-pop"

export interface DiscoveryTagsProps {
	data: DataLayer
	controller: PlotController
	view: SpectrumViewSpan
	widthPx: number
	/** Which discoveries are tagged (Settings › Signal labels, through discoveryTagFilter). */
	only?: DiscoveryTagFilter
}

type Open =
	| { kind: "group"; id: string }
	| { kind: "edge"; side: "left" | "right" }
	| null

export const DiscoveryTags = memo(function DiscoveryTags({
	data,
	controller,
	view,
	widthPx,
	only = "all",
}: DiscoveryTagsProps) {
	const byId = useStore(data.scanner, s => s.discoveries.byId)
	const activeNow = useStore(data.scanner, s => s.activeNow)
	const saved = useStore(data.savedFrequencies, s => s.items)
	// the last-hour tier moves on slowly: a minute is fine
	const now = useNow(true, 60_000)
	const savedHz = useMemo(() => saved.map(f => f.frequencyHz), [saved])
	const placed = useMemo(
		() =>
			placeDiscoveryTags(byId.values(), view, {
				widthPx,
				activeNow,
				now,
				savedHz,
				only,
			}),
		[byId, activeNow, now, savedHz, view.startHz, view.endHz, widthPx, only],
	)
	const outside = useMemo(
		() => outsideView(byId.values(), view, { only, savedHz }),
		[byId, savedHz, view.startHz, view.endHz, only],
	)
	const [open, setOpen] = useState<Open>(null)
	// a retune or a pan moves everything: an open popover would point at nothing
	useEffect(() => setOpen(null), [view.startHz, view.endHz])
	const rootRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (open === null) return
		const onDown = (e: PointerEvent) => {
			const t = e.target as Element | null
			if (
				t &&
				rootRef.current?.contains(t) &&
				t.closest(`.${DISCOVERY_POP_CLASS}, .wk-plot-disc, .wk-plot-disc-edge`)
			)
				return
			setOpen(null)
		}
		document.addEventListener("pointerdown", onDown, true)
		return () => document.removeEventListener("pointerdown", onDown, true)
	}, [open])
	const onKey = (e: KeyboardEvent<HTMLElement>) => {
		if (e.key !== "Escape" || open === null) return
		e.stopPropagation()
		setOpen(null)
	}
	const group =
		open?.kind === "group" ? placed.find(t => t.id === open.id) : undefined
	const edge =
		open?.kind === "edge" ? { side: open.side, at: outside[open.side] } : null
	return (
		<div className="wk-plot-disc-root" ref={rootRef} onKeyDown={onKey}>
			{placed.map(t => {
				const n = t.members.length
				return (
					<button
						key={t.id}
						type="button"
						className="wk-plot-disc"
						data-tier={t.tier}
						data-heard={t.heard || undefined}
						data-group={n > 1 || undefined}
						style={{ left: t.x }}
						aria-label={
							n > 1 ? t.title : `Discovery: ${t.title}${likelySuffix(t.rep)}`
						}
						aria-haspopup={n > 1 ? "dialog" : undefined}
						aria-expanded={n > 1 ? group?.id === t.id : undefined}
						title={
							n > 1
								? `${t.title} · ${t.label}`
								: `${t.title}${likelySuffix(t.rep)}`
						}
						onClick={() => {
							if (n > 1)
								setOpen(o =>
									o?.kind === "group" && o.id === t.id
										? null
										: { kind: "group", id: t.id },
								)
							else void controller.tuneTo(t.hz)
						}}
					>
						<i data-solid={t.solid || undefined} aria-hidden="true" />
						{t.labelled && <span>{t.label}</span>}
					</button>
				)
			})}
			{(["left", "right"] as const).map(side => {
				const at = outside[side]
				if (!at) return null
				const text = `${at.count} ${at.count === 1 ? "signal" : "signals"} outside view ${side === "left" ? "←" : "→"}`
				return (
					<button
						key={side}
						type="button"
						className="wk-plot-disc-edge"
						data-side={side}
						aria-label={`${text}, nearby`}
						aria-haspopup="dialog"
						aria-expanded={edge?.side === side}
						title={`${text} (nearby)`}
						onClick={() =>
							setOpen(o =>
								o?.kind === "edge" && o.side === side
									? null
									: { kind: "edge", side },
							)
						}
					>
						{side === "left" && <span aria-hidden="true">←</span>}
						{at.count}
						{side === "right" && <span aria-hidden="true">→</span>}
					</button>
				)
			})}
			{group && (
				<GroupPopover
					tag={group}
					widthPx={widthPx}
					onPick={hz => {
						setOpen(null)
						void controller.tuneTo(hz)
					}}
				/>
			)}
			{edge?.at && (
				<EdgeConfirm
					side={edge.side}
					at={edge.at}
					onConfirm={hz => {
						setOpen(null)
						void controller.tuneTo(hz)
					}}
					onCancel={() => setOpen(null)}
				/>
			)}
		</div>
	)
})

function likelySuffix(d: Discovery): string {
	const what = whatIsThis(d)
	return what.likely ? ` · ${what.likely}` : ""
}

const POP_W = 280

/** Every member of a group tag, frequency order, each with its "what is this" (req 1.1, 1.3); a click tunes. */
function GroupPopover({
	tag,
	widthPx,
	onPick,
}: {
	tag: PlacedDiscoveryTag
	widthPx: number
	onPick: (hz: number) => void
}) {
	const left = Math.max(4, Math.min(widthPx - POP_W - 4, tag.x))
	const first = useRef<HTMLButtonElement>(null)
	useEffect(() => first.current?.focus({ preventScroll: true }), [tag.id])
	return (
		<div
			className={`${DISCOVERY_POP_CLASS} wk-menu`}
			role="dialog"
			aria-label={tag.title}
			style={{ left, width: POP_W }}
		>
			<div className="wk-plot-disc-pop-head">{tag.title}</div>
			<ul className="wk-plot-disc-pop-list">
				{tag.members.map((d, i) => {
					const what = whatIsThis(d)
					const label = d.operator?.label?.trim()
					return (
						<li key={d.id}>
							<button
								ref={i === 0 ? first : undefined}
								type="button"
								className="wk-option wk-plot-disc-member"
								onClick={() => onPick(d.frequencyHz)}
							>
								<span className="wk-plot-disc-member-freq">
									{formatMHz(d.frequencyHz, 4)}
								</span>
								<span className="wk-plot-disc-member-what">
									<b>{label || what.protocol}</b>
									{label && <span>{what.protocol}</span>}
									{what.likely && (
										<span className="wk-plot-disc-likely">{what.likely}</span>
									)}
									{!isVerified(d) && (
										<span className="wk-plot-disc-next">{what.next}</span>
									)}
								</span>
							</button>
						</li>
					)
				})}
			</ul>
		</div>
	)
}

/** "Tune to 432.9000 MHz?": a marker never retunes on its own (req 1.2). */
function EdgeConfirm({
	side,
	at,
	onConfirm,
	onCancel,
}: {
	side: "left" | "right"
	at: OutsideSide
	onConfirm: (hz: number) => void
	onCancel: () => void
}) {
	const yes = useRef<HTMLButtonElement>(null)
	useEffect(() => yes.current?.focus({ preventScroll: true }), [])
	return (
		<div
			className={`${DISCOVERY_POP_CLASS} wk-menu wk-plot-disc-confirm`}
			data-side={side}
			role="alertdialog"
			aria-label={`Tune to ${formatMHz(at.nearestHz, 4)} MHz?`}
		>
			<span>Tune to {formatMHz(at.nearestHz, 4)} MHz?</span>
			<span className="wk-plot-disc-confirm-row">
				<button
					ref={yes}
					type="button"
					className="wk-btn"
					data-size="sm"
					data-variant="primary"
					onClick={() => onConfirm(at.nearestHz)}
				>
					Tune
				</button>
				<button
					type="button"
					className="wk-btn"
					data-size="sm"
					onClick={onCancel}
				>
					Cancel
				</button>
			</span>
		</div>
	)
}
