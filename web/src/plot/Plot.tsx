// The plot (docs/web/canvas/Spectrum.dc.html, DESIGN.md "Spectrum interaction"): spectrum trace and waterfall drawn
// by the spectrum worker, with DOM overlays updated from frame meta (≤ 10/s) and the stores, never per bin.
// Click tunes (snapping to a signal), wheel steps, ctrl/⌘ + wheel and pinch zoom around the cursor, drag pans
// (and retunes past the capture edge), arrows/PageUp/PageDown/+/−/0 on the focused plot. Dragging the VFO
// tunes, its edges (once zoomed in) set the bandwidth, the dashed line sets the squelch (use-handles.ts). Shift-drag
// marks a range and offers "Scan this range"; scanner discoveries tag the row under the band lanes.
import "./plot.css"

import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react"
import type { ResolvedBandPlanView } from "@wavekit/api-types"

import type { DataLayer } from "../data/index.ts"
import { Store, tunedHz, useStore } from "../data/index.ts"
import {
	DEFAULT_LEVELS,
	SpectrumCanvas,
	type SpectrumEngineStatus,
	type SpectrumFrameMeta,
	type SpectrumLevels,
	type SpectrumViewSpan,
} from "../spectrum/index.ts"
import { IconButton } from "../ui/index.ts"
import {
	type PlacedLabel,
	type Track,
	autoLevels,
	dbTicks,
	describeTracks,
	formatMHz,
	freqTicks,
	holdTracks,
	keyAction,
	lanePieces,
	pinchFactor,
	placeLabels,
	readoutDecimals,
	resolveView,
	spanWidth,
	tuningStep,
	wheelPixels,
	wheelZoomFactor,
	zoomLabel,
} from "./maths.ts"
import { PlotController, type PlotContext } from "./plot-store.ts"
import { AXIS_CSS, DISCOVERY_ROW_CSS, LANES_CSS, plotLayout } from "./layout.ts"
import { isReadOnly } from "../app/context.ts"
import { modeSpec } from "../features/tuner/modes.ts"
import { scanHasReceiver as scanHasReceiverOf } from "../features/tuning.ts"
import { HandleController, squelchLineDbfs } from "./handle-controller.ts"
import { SquelchLine, VfoEdges } from "./HandleOverlays.tsx"
import { EDGE_GRAB_MIN_PX } from "./handles.ts"
import { useHandles, type HandleFrame } from "./use-handles.ts"
import type { SpectrumProbe } from "../spectrum/index.ts"
import { SavedTags } from "./SavedTags.tsx"
import {
	DiscoveryTags,
	useDiscoveryFetch,
	useDiscoveryRow,
} from "./DiscoveryTags.tsx"
import {
	dragRange,
	finishRange,
	hzAt,
	type RangeSelection,
} from "./range-select.ts"
import { RANGE_OFFER_CLASS, RangeSelect } from "./RangeSelect.tsx"

export interface PlotProps {
	data: DataLayer
	className?: string
	/** The user's chosen tuning step (wheel, keys, click snap); null or absent: the band plan's step. */
	stepHz?: number | null
}

/** Frames per second and bins asked of the core. */
const SPECTRUM_HZ = 25
/** Ask the core for its whole backfill window (it clamps to its own limits). */
const SPECTRUM_BACKFILL_MS = 10_000
const SPECTRUM_BINS = 2048
/** Bursty signals keep their label this long after the last burst. */
const TRACK_HOLD_MS = 1500
const DRAG_THRESHOLD_PX = 3

export function Plot({ data, className, stepHz }: PlotProps) {
	const sourceId = useStore(data.sources, s => firstConnected(s.sources))
	const tuner = useStore(data.tuner, s =>
		sourceId === null ? undefined : s.bySource[sourceId],
	)
	const liveStatus = useStore(data.liveAudio, s => s.status)
	const plan = useStore(data.bandplan, s => s.view)

	const controller = useMemo(
		() =>
			new PlotController({
				retune: (hz, id) => data.tuner.tune(hz, id),
				setOffset: offsetHz => data.liveAudio.setConfig({ offsetHz }),
			}),
		[data],
	)
	const plotState = useStore(controller.store)
	const readOnly = useStore(data.access, isReadOnly)
	// VFO, band-edge and squelch-line drags (handles.ts), written through the islands' paths.
	const handles = useMemo(
		() =>
			new HandleController({
				tune: hz => controller.tuneTo(hz),
				setBandwidth: bandwidth => data.liveAudio.setConfig({ bandwidth }),
				setSquelch: squelch =>
					data.liveAudio.setConfig({ squelchMode: "manual", squelch }),
			}),
		[controller, data],
	)
	const handleState = useStore(handles.store)
	const probeRef = useRef<SpectrumProbe | null>(null)

	const [meta, setMeta] = useState<SpectrumFrameMeta | null>(null)
	// the scale follows the core's noise floor (frames carry floorDbfs)
	const [levels, setLevels] = useState<SpectrumLevels>(DEFAULT_LEVELS)
	const [engineError, setEngineError] = useState<string | null>(null)
	const heldRef = useRef<{ track: Track; seenAt: number }[]>([])
	const [tracks, setTracks] = useState<readonly Track[]>([])

	const bodyRef = useRef<HTMLDivElement>(null)
	const [size, setSize] = useState({ w: 0, h: 0 })
	useEffect(() => {
		const el = bodyRef.current
		if (!el) return
		const measure = () => {
			const r = el.getBoundingClientRect()
			setSize(s =>
				s.w === Math.round(r.width) && s.h === Math.round(r.height)
					? s
					: { w: Math.round(r.width), h: Math.round(r.height) },
			)
		}
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		measure()
		return () => ro.disconnect()
	}, [])

	// Meta of another source (or before a reset) is dropped.
	const shownMeta = meta && meta.sourceId === sourceId ? meta : null
	const capture: SpectrumViewSpan | null = shownMeta
		? {
				startHz: shownMeta.startHz,
				endHz: shownMeta.startHz + shownMeta.binCount * shownMeta.binHz,
			}
		: tuner
			? {
					startHz: tuner.frequency - tuner.sampleRate / 2,
					endHz: tuner.frequency + tuner.sampleRate / 2,
				}
			: null
	const capStart = capture?.startHz ?? null
	const capEnd = capture?.endHz ?? null
	const view = useMemo(
		() =>
			capStart === null || capEnd === null
				? null
				: resolveView(plotState.view, { startHz: capStart, endHz: capEnd }),
		[capStart, capEnd, plotState.view],
	)
	const hover = useMemo(() => new Store<Hover>(null), [])
	const range = useMemo(() => new Store<RangeSelection | null>(null), [])
	const viewRef = useRef(view)
	viewRef.current = view
	useDiscoveryFetch(data.scanner, view)
	const discRow = useDiscoveryRow(data.scanner)
	const scanHasReceiver = useStore(data.scanner, s =>
		scanHasReceiverOf(s.sweep),
	)
	const tuned = tunedHz(tuner, liveStatus)
	const vfoHz = handleState.vfoHz ?? plotState.pendingHz ?? tuned
	const bandwidthHz =
		handleState.bandwidthHz ?? liveStatus?.config.bandwidth ?? 12_500
	// The mode's limits; no edges without a live channel filter on this source (RAW, no live audio).
	const bandwidthRange =
		liveStatus &&
		liveStatus.sourceId === sourceId &&
		liveStatus.config.bandwidth > 0
			? modeSpec(liveStatus.config.modulation).bw
			: null
	const step =
		stepHz !== null && stepHz !== undefined && stepHz > 0
			? stepHz
			: tuningStep(plan, vfoHz)

	const context: PlotContext = {
		sourceId,
		capture,
		centreHz: tuner?.frequency ?? shownMeta?.centerHz ?? null,
		sampleRateHz: tuner?.sampleRate ?? shownMeta?.sampleRateHz ?? null,
		tunedHz: tuned,
		bandwidthHz,
		stepHz: step,
		tracks,
		scanHasReceiver,
	}
	controller.setContext(context)

	const layout = plotLayout(size.h, discRow ? DISCOVERY_ROW_CSS : 0)
	const unverified = shownMeta?.tuningTrust === "unverified"

	const onFrameMeta = (m: SpectrumFrameMeta) => {
		setMeta(m)
		setLevels(prev => autoLevels(m.floorDbfs, prev))
		heldRef.current = holdTracks(
			heldRef.current,
			m.tracks,
			performance.now(),
			TRACK_HOLD_MS,
		)
		setTracks(heldRef.current.map(h => h.track))
	}
	const onStatus = (status: SpectrumEngineStatus) => {
		if (status.type === "error") setEngineError(status.message)
		if (status.type === "reset" && status.reason !== "profile") {
			heldRef.current = []
			setTracks([])
		}
	}

	const frame: HandleFrame = {
		view,
		widthPx: size.w,
		traceCss: layout.traceCss,
		levels,
		vfoHz,
		bandwidthHz,
		bandwidthRange,
		stepHz: step,
		readOnly,
		squelchDbfs: () =>
			handles.store.get().squelchDbfs ?? squelchLineDbfs(data.liveAudio.get()),
	}
	const handleFrame = useRef(frame)
	handleFrame.current = frame
	const clearHover = useMemo(() => () => hover.set(null), [hover])
	useHandles(bodyRef, handleFrame, handles, controller, clearHover)
	useInteraction(bodyRef, controller, hover, size.w, range, viewRef)
	const edgesShown =
		bandwidthRange !== null &&
		!readOnly &&
		view !== null &&
		(bandwidthHz / spanWidth(view)) * size.w >= EDGE_GRAB_MIN_PX

	const decimals = view ? readoutDecimals(spanWidth(view)) : 3
	const ariaLabel =
		vfoHz !== null
			? `Spectrum, tuned to ${formatMHz(vfoHz, 4)} MHz. Arrows step, plus and minus zoom, 0 fits.`
			: "Spectrum"

	return (
		<div className={className ? `wk-plot ${className}` : "wk-plot"}>
			<div
				ref={bodyRef}
				className="wk-plot-body"
				tabIndex={0}
				role="application"
				aria-roledescription="spectrum"
				aria-label={ariaLabel}
			>
				<SpectrumCanvas
					sourceId={sourceId}
					hz={SPECTRUM_HZ}
					bins={SPECTRUM_BINS}
					backfillMs={SPECTRUM_BACKFILL_MS}
					view={plotState.view.spanHz === null ? null : view}
					levels={levels}
					layout={{ splitRatio: layout.splitRatio, gapCss: layout.gapCss }}
					onFrameMeta={onFrameMeta}
					onStatus={onStatus}
					probeRef={probeRef}
				/>
				{size.w > 0 && view && (
					<>
						<div
							className="wk-plot-band"
							style={{ top: 0, height: layout.traceCss }}
						>
							<DbScale levels={levels} traceCss={layout.traceCss} />
							<SignalLabels
								tracks={tracks}
								plan={plan}
								view={view}
								widthPx={size.w}
								traceCss={layout.traceCss}
								tunedHz={vfoHz}
								onPick={hz => void controller.tuneTo(hz)}
							/>
							{layout.traceCss >= 90 && capture && (
								<ZoomControl
									view={view}
									capture={capture}
									controller={controller}
								/>
							)}
						</div>
						<div
							className="wk-plot-band wk-plot-axis"
							style={{ top: layout.traceCss }}
							data-unverified={unverified ? "" : undefined}
						>
							<FreqAxis view={view} widthPx={size.w} />
							{unverified && (
								<span
									className="wk-plot-chip wk-plot-unverified"
									role="status"
									title="The receiver has not confirmed its tuning, so frequencies may be off"
								>
									Frequencies unverified
								</span>
							)}
							{vfoHz !== null &&
								vfoHz >= view.startHz &&
								vfoHz <= view.endHz && (
									<span
										className="wk-plot-chip wk-plot-vfo-chip"
										style={{ left: `${pct(vfoHz, view)}%` }}
									>
										{formatMHz(vfoHz, decimals)}
									</span>
								)}
							<HoverTag
								hover={hover}
								view={view}
								decimals={decimals}
								widthPx={size.w}
								probeRef={probeRef}
								tick={shownMeta?.at ?? null}
							/>
						</div>
						<div
							className="wk-plot-band wk-plot-lanes"
							style={{ top: layout.traceCss + AXIS_CSS, height: LANES_CSS }}
						>
							<Lanes plan={plan} view={view} widthPx={size.w} />
							<SavedTags
								data={data}
								controller={controller}
								view={view}
								widthPx={size.w}
								tunedHz={vfoHz}
							/>
						</div>
						{discRow && (
							<div
								className="wk-plot-band wk-plot-discs"
								data-unverified={unverified ? "" : undefined}
								style={{ top: layout.traceCss + AXIS_CSS + LANES_CSS }}
							>
								<DiscoveryTags
									data={data}
									controller={controller}
									view={view}
									widthPx={size.w}
								/>
							</div>
						)}
						{vfoHz !== null &&
							vfoHz >= view.startHz - bandwidthHz &&
							vfoHz <= view.endHz + bandwidthHz && (
								<div
									className="wk-plot-vfo"
									data-pending={plotState.pendingHz !== null ? "" : undefined}
									data-active={handleState.active !== null ? "" : undefined}
									style={{
										left: `${pct(vfoHz, view)}%`,
										width: `${(bandwidthHz / spanWidth(view)) * 100}%`,
									}}
								>
									{edgesShown && bandwidthRange && (
										<VfoEdges
											handles={handles}
											bandwidthHz={bandwidthHz}
											range={bandwidthRange}
											readOnly={readOnly}
										/>
									)}
								</div>
							)}
						<SquelchLine
							liveAudio={data.liveAudio}
							handles={handles}
							preview={handleState.squelchDbfs}
							view={view}
							widthPx={size.w}
							traceCss={layout.traceCss}
							levels={levels}
							vfoHz={vfoHz}
							bandwidthHz={bandwidthHz}
							readOnly={readOnly}
						/>
						<HoverLine hover={hover} />
						<RangeSelect range={range} view={view} />
					</>
				)}
				{sourceId === null && (
					<div className="wk-plot-note">No source connected</div>
				)}
				{engineError !== null && sourceId !== null && (
					<div className="wk-plot-note" role="status">
						{engineError}
					</div>
				)}
			</div>
		</div>
	)
}

function firstConnected(
	sources: readonly { id: string; connected: boolean }[],
): string | null {
	return sources.find(s => s.connected)?.id ?? null
}

function pct(hz: number, view: SpectrumViewSpan): number {
	return ((hz - view.startHz) / spanWidth(view)) * 100
}

// ── Hover (its own tiny store, so pointer moves re-render two small nodes only) ─────────────────

type Hover = { x: number } | null

function HoverLine({ hover }: { hover: Store<Hover> }) {
	const h = useStore(hover)
	if (!h) return null
	return <div className="wk-plot-hover" style={{ left: `${h.x * 100}%` }} />
}

/** Frequency and level under the cursor; the level is the newest row's peak over the pixel (worker probe). */
function HoverTag({
	hover,
	view,
	decimals,
	widthPx,
	probeRef,
	tick,
}: {
	hover: Store<Hover>
	view: SpectrumViewSpan
	decimals: number
	widthPx: number
	probeRef: RefObject<SpectrumProbe | null>
	/** Changes with each frame meta (≤ 10/s): the level is read again. */
	tick: string | null
}) {
	const h = useStore(hover)
	const [db, setDb] = useState<number | null>(null)
	const asked = useRef(0)
	const hz = h ? view.startHz + h.x * spanWidth(view) : null
	const halfPx = spanWidth(view) / Math.max(1, widthPx) / 2
	useEffect(() => {
		const probe = probeRef.current
		if (hz === null || !probe) {
			setDb(null)
			return
		}
		// Replies arrive in order; a newer ask supersedes, but an older answer still shows meanwhile.
		const seq = ++asked.current
		void probe(hz - halfPx, hz + halfPx).then(v => {
			if (seq === asked.current) setDb(v)
		})
	}, [hz, halfPx, tick, probeRef])
	if (!h || hz === null) return null
	return (
		<span
			className="wk-plot-chip wk-plot-hover-tag"
			style={{ left: `${h.x * 100}%` }}
		>
			{formatMHz(hz, decimals + 1)} MHz
			{db !== null && ` · ${String(Math.round(db)).replace("-", "−")} dB`}
		</span>
	)
}

// ── Overlays ─────────────────────────────────────────────────────────────────────────────────────

const DbScale = memo(function DbScale({
	levels,
	traceCss,
}: {
	levels: { minDb: number; maxDb: number }
	traceCss: number
}) {
	return (
		<>
			{dbTicks(levels, traceCss).map(t => (
				<span
					key={t.db}
					className="wk-plot-db"
					style={{ top: t.y }}
					aria-hidden="true"
				>
					{t.text}
				</span>
			))}
		</>
	)
})

const FreqAxis = memo(function FreqAxis({
	view,
	widthPx,
}: {
	view: SpectrumViewSpan
	widthPx: number
}) {
	return (
		<>
			{freqTicks(view, widthPx).map(t => (
				<span
					key={t.hz}
					className="wk-plot-tick"
					style={{ left: `${t.x * 100}%` }}
				>
					{t.text}
				</span>
			))}
		</>
	)
})

const Lanes = memo(function Lanes({
	plan,
	view,
	widthPx,
}: {
	plan: ResolvedBandPlanView | null
	view: SpectrumViewSpan
	widthPx: number
}) {
	const pieces = useMemo(
		() => lanePieces(plan, view, widthPx),
		[plan, view.startHz, view.endHz, widthPx],
	)
	return (
		<>
			{pieces.map(p => (
				<div
					key={p.key}
					className="wk-plot-lane"
					title={p.title}
					data-skip={p.skip ? "" : undefined}
					style={{
						left: `${p.left * 100}%`,
						width: `${p.width * 100}%`,
						zIndex: 1 + p.depth,
						boxShadow: `inset 1px 0 0 ${p.startsBand ? "rgba(var(--wk-line-rgb),.28)" : "transparent"}, inset -1px 0 0 ${p.endsBand ? "rgba(var(--wk-line-rgb),.28)" : "transparent"}`,
					}}
				>
					{p.showLabel && (
						<span
							className="wk-plot-lane-name"
							style={{ maxWidth: p.labelMax }}
						>
							<i aria-hidden="true" style={{ background: p.colour }} />
							<span>{p.label}</span>
						</span>
					)}
				</div>
			))}
		</>
	)
})

function SignalLabels({
	tracks,
	plan,
	view,
	widthPx,
	traceCss,
	tunedHz: tuned,
	onPick,
}: {
	tracks: readonly Track[]
	plan: ResolvedBandPlanView | null
	view: SpectrumViewSpan
	widthPx: number
	traceCss: number
	tunedHz: number | null
	onPick: (hz: number) => void
}) {
	const signals = useMemo(() => describeTracks(tracks, plan), [tracks, plan])
	const burstAt = useMemo(
		() => new Map(signals.map(s => [s.hz, s.burst])),
		[signals],
	)
	const placed: PlacedLabel[] = useMemo(
		() =>
			placeLabels(signals, view, {
				widthPx,
				traceCss,
				tunedHz: tuned,
				// Keep clear of the zoom control.
				taken: [[widthPx - 230, traceCss - 46, widthPx, traceCss]],
			}),
		[signals, view.startHz, view.endHz, widthPx, traceCss, tuned],
	)
	return (
		<>
			{placed.map(l => (
				<div
					key={l.hz}
					className="wk-plot-sig"
					data-tuned={l.tuned ? "" : undefined}
					data-burst={burstAt.get(l.hz) ? "" : undefined}
					style={{ left: l.x, top: l.top }}
				>
					<button
						type="button"
						aria-label={`Tune to ${l.label} ${formatMHz(l.hz, 4)} MHz`}
						onClick={() => onPick(l.hz)}
					>
						<span className="wk-plot-sig-dot" aria-hidden="true" />
						<b>{l.label}</b>
						{l.sub !== null && <span className="wk-plot-sig-sub">{l.sub}</span>}
					</button>
					<span className="wk-plot-sig-lead" style={{ height: l.lead }} />
				</div>
			))}
		</>
	)
}

function ZoomControl({
	view,
	capture,
	controller,
}: {
	view: SpectrumViewSpan
	capture: SpectrumViewSpan
	controller: PlotController
}) {
	const width = spanWidth(capture)
	return (
		<div className="wk-plot-zoom">
			<IconButton
				label="Zoom out"
				size="sm"
				onClick={() => controller.zoomCentred(0.5)}
			>
				−
			</IconButton>
			<div className="wk-plot-zoom-ov" aria-hidden="true">
				<span
					style={{
						left: `${((view.startHz - capture.startHz) / width) * 100}%`,
						width: `${(spanWidth(view) / width) * 100}%`,
					}}
				/>
			</div>
			<IconButton
				label="Zoom in"
				size="sm"
				onClick={() => controller.zoomCentred(2)}
			>
				+
			</IconButton>
			<button
				type="button"
				className="wk-btn wk-plot-zoom-fit"
				data-variant="ghost"
				data-size="sm"
				aria-label="Show the whole capture"
				onClick={() => controller.fit()}
			>
				{zoomLabel(view, capture)}
			</button>
		</div>
	)
}

// ── Pointer, wheel and keys ─────────────────────────────────────────────────────────────────────

function useInteraction(
	ref: RefObject<HTMLDivElement | null>,
	controller: PlotController,
	hover: Store<Hover>,
	widthPx: number,
	range: Store<RangeSelection | null>,
	viewRef: RefObject<SpectrumViewSpan | null>,
): void {
	const widthRef = useRef(widthPx)
	widthRef.current = widthPx
	useEffect(() => {
		const el = ref.current
		if (!el) return
		const pointers = new Map<number, number>()
		let drag: { x: number; moved: boolean } | null = null
		// Shift-drag: a range to scan, in Hz so it stays put while the view moves
		let rangeDrag: { x: number; fromHz: number; moved: boolean } | null = null
		let pinchDistance = 0

		const xOf = (clientX: number) => {
			const r = el.getBoundingClientRect()
			return {
				px: clientX - r.left,
				frac: Math.min(
					1,
					Math.max(0, (clientX - r.left) / Math.max(1, r.width)),
				),
				w: r.width,
			}
		}
		const spread = () => {
			const xs = [...pointers.values()]
			return xs.length >= 2 ? Math.abs((xs[0] ?? 0) - (xs[1] ?? 0)) : 0
		}

		const onDown = (e: PointerEvent) => {
			// Chips, the zoom control and the range offer handle their own presses.
			if (
				e.button !== 0 ||
				(e.target as Element).closest(`button, .${RANGE_OFFER_CLASS}`)
			)
				return
			const view = viewRef.current
			if (e.shiftKey && view && pointers.size === 0) {
				pointers.set(e.pointerId, e.clientX)
				el.setPointerCapture(e.pointerId)
				rangeDrag = {
					x: e.clientX,
					fromHz: hzAt(view, xOf(e.clientX).frac),
					moved: false,
				}
				hover.set(null)
				return
			}
			// any other press clears a marked range
			if (range.get()) range.set(null)
			pointers.set(e.pointerId, e.clientX)
			el.setPointerCapture(e.pointerId)
			if (pointers.size === 2) {
				// Second finger: pinch instead of pan.
				drag = null
				pinchDistance = spread()
				void controller.endPan()
				return
			}
			drag = { x: e.clientX, moved: false }
			controller.beginPan()
		}
		const onMove = (e: PointerEvent) => {
			if (rangeDrag) {
				const view = viewRef.current
				if (
					!rangeDrag.moved &&
					Math.abs(e.clientX - rangeDrag.x) > DRAG_THRESHOLD_PX
				)
					rangeDrag.moved = true
				if (rangeDrag.moved && view)
					range.set(
						dragRange(rangeDrag.fromHz, hzAt(view, xOf(e.clientX).frac)),
					)
				return
			}
			if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e.clientX)
			if (pointers.size >= 2) {
				const d = spread()
				const xs = [...pointers.values()]
				const mid = ((xs[0] ?? 0) + (xs[1] ?? 0)) / 2
				controller.zoom(xOf(mid).frac, pinchFactor(pinchDistance, d))
				pinchDistance = d
				return
			}
			if (drag) {
				const dx = e.clientX - drag.x
				if (!drag.moved && Math.abs(dx) > DRAG_THRESHOLD_PX) {
					drag.moved = true
					el.dataset["dragging"] = ""
					hover.set(null)
				}
				if (drag.moved) controller.dragPan(dx, xOf(e.clientX).w)
				return
			}
			if (e.pointerType === "mouse") hover.set({ x: xOf(e.clientX).frac })
		}
		const onUp = (e: PointerEvent) => {
			if (rangeDrag) {
				const r = range.get()
				const finished =
					rangeDrag.moved && r && e.type === "pointerup" ? finishRange(r) : null
				rangeDrag = null
				pointers.delete(e.pointerId)
				if (el.hasPointerCapture(e.pointerId))
					el.releasePointerCapture(e.pointerId)
				range.set(finished)
				return
			}
			const wasPinch = pointers.size >= 2
			pointers.delete(e.pointerId)
			if (el.hasPointerCapture(e.pointerId))
				el.releasePointerCapture(e.pointerId)
			delete el.dataset["dragging"]
			const d = drag
			drag = null
			if (wasPinch || !d) return
			if (d.moved) void controller.endPan()
			else if (e.type === "pointerup") {
				void controller.endPan()
				const { frac, w } = xOf(e.clientX)
				void controller.clickAt(frac, w)
			}
		}
		const onLeave = () => {
			if (!drag && !rangeDrag) hover.set(null)
		}
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			const dy = wheelPixels(e.deltaY, e.deltaMode)
			const dx = wheelPixels(e.deltaX, e.deltaMode)
			if (e.ctrlKey || e.metaKey) {
				controller.zoom(xOf(e.clientX).frac, wheelZoomFactor(dy))
			} else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
				const w = Math.max(1, widthRef.current)
				const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy
				controller.panFraction(delta / w)
			} else {
				void controller.wheelStep(dy)
			}
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && range.get()) {
				e.preventDefault()
				range.set(null)
				return
			}
			if (e.target !== el) return
			const action = keyAction(e.key, {
				shift: e.shiftKey,
				ctrl: e.ctrlKey,
				meta: e.metaKey,
				alt: e.altKey,
			})
			if (action && controller.key(action)) e.preventDefault()
		}

		el.addEventListener("pointerdown", onDown)
		el.addEventListener("pointermove", onMove)
		el.addEventListener("pointerup", onUp)
		el.addEventListener("pointercancel", onUp)
		el.addEventListener("pointerleave", onLeave)
		el.addEventListener("wheel", onWheel, { passive: false })
		el.addEventListener("keydown", onKey)
		return () => {
			el.removeEventListener("pointerdown", onDown)
			el.removeEventListener("pointermove", onMove)
			el.removeEventListener("pointerup", onUp)
			el.removeEventListener("pointercancel", onUp)
			el.removeEventListener("pointerleave", onLeave)
			el.removeEventListener("wheel", onWheel)
			el.removeEventListener("keydown", onKey)
		}
	}, [ref, controller, hover, range, viewRef])
}
