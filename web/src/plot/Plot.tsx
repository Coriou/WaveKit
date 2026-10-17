// The plot (docs/web/canvas/Spectrum.dc.html, DESIGN.md "Spectrum interaction"): spectrum trace and waterfall drawn
// by the spectrum worker, with DOM overlays updated from frame meta (≤ 10/s) and the stores, never per bin.
// Click tunes (snapping to a signal), wheel steps, ctrl/⌘ + wheel and pinch zoom around the cursor, drag pans
// (past the capture the picture slides at once and the receiver follows, plot-store.ts `free`), arrows/PageUp/PageDown/+/−/0 on the focused plot. Dragging the VFO
// tunes, its edges (once zoomed in) set the bandwidth, the dashed line sets the squelch (use-handles.ts). Shift-drag
// marks a range and offers "Scan this range"; scanner discoveries tag the row under the band lanes. Right-click (long
// press, or the menu key) opens the signal menu: Identify, Decode as…, Listen, Save (SignalMenu.tsx).
import "./plot.css"

import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react"
import type { Discovery, ResolvedBandPlanView } from "@wavekit/api-types"

import type { DataLayer, SavedFrequencyRow } from "../data/index.ts"
import { Store, tunedHz, useStore } from "../data/index.ts"
import {
	DEFAULT_LEVELS,
	SpectrumCanvas,
	type SpectrumEngineStatus,
	type SpectrumFrameMeta,
	type SpectrumLevels,
	type SpectrumViewSpan,
} from "../spectrum/index.ts"
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
	namedChannelAt,
	lanePieces,
	pinchFactor,
	placeLabels,
	readoutDecimals,
	resolveView,
	spanWidth,
	tuningStep,
	wheelPixels,
	wheelZoomFactor,
} from "./maths.ts"
import {
	autoLevelsNow,
	PlotController,
	type PlotContext,
} from "./plot-store.ts"
import {
	AVERAGING_ALPHA,
	fftBins,
	spectrumLevels,
} from "../shell/device-prefs.ts"
import { useDevicePrefs } from "../shell/hooks.ts"
import {
	AXIS_CSS,
	DISCOVERY_ROW_CSS,
	LANES_CSS,
	RULER_CSS,
	plotLayout,
} from "./layout.ts"
import { BandRuler } from "./BandRuler.tsx"
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
	discoveryTagFilter,
	identifiedAt,
	identifiedLabel,
} from "./discovery-tags.ts"
import {
	dragRange,
	finishRange,
	hzAt,
	type RangeSelection,
} from "./range-select.ts"
import { RANGE_OFFER_CLASS, RangeSelect } from "./RangeSelect.tsx"
import {
	SIGNAL_MENU_CLASS,
	SignalMenu,
	type SignalMenuAt,
} from "./SignalMenu.tsx"
import {
	EMPTY_LABEL_GATE,
	gatedSignals,
	stepLabelGate,
	type GatedSignal,
	type LabelGateState,
} from "./label-gate.ts"

export interface PlotProps {
	data: DataLayer
	className?: string
	/** The user's chosen tuning step (wheel, keys, click snap); null or absent: the band plan's step. */
	stepHz?: number | null
	/** Covered by an opaque view (Map, Messages): the spectrum stops drawing, its history keeps filling. */
	paused?: boolean
}

/** Frames per second and bins asked of the core. */
const SPECTRUM_HZ = 25
/** Ask the core for its whole backfill window (it clamps to its own limits). */
const SPECTRUM_BACKFILL_MS = 10_000
/** Bursty signals keep their label this long after the last burst. */
const TRACK_HOLD_MS = 1500
const DRAG_THRESHOLD_PX = 3

export function Plot({ data, className, stepHz, paused }: PlotProps) {
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
	// Auto follows the core's noise floor (frames carry floorDbfs); Fixed holds a scale the user set
	const [autoScale, setLevels] = useState<SpectrumLevels>(DEFAULT_LEVELS)
	const device = useDevicePrefs()
	const levels = spectrumLevels(device, autoScale)
	// Settings › FFT size, within what the core serves; a new size remounts the canvas (texture width).
	const binsMax = useStore(data.spectrumLimits, s => s.binsMax)
	const bins = fftBins(device.fftSize, binsMax)
	useEffect(() => autoLevelsNow.set(autoScale), [autoScale])
	const [engineError, setEngineError] = useState<string | null>(null)
	const heldRef = useRef<{ track: Track; seenAt: number }[]>([])
	const [tracks, setTracks] = useState<readonly Track[]>([])
	// Settings › Signal labels: which signals get a chip, followed across frames (label-gate.ts)
	const gateRef = useRef<LabelGateState>(EMPTY_LABEL_GATE)
	const [labelled, setLabelled] = useState<readonly GatedSignal[]>([])
	const savedItems = useStore(data.savedFrequencies, s => s.items)
	const discoveries = useStore(data.scanner, s => s.discoveries.byId)

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
	// A view slid past the capture (plot-store.ts `free`) shows as is until the frames catch up.
	const view = useMemo(
		() =>
			capStart === null || capEnd === null
				? null
				: (plotState.free ??
					resolveView(plotState.view, { startHz: capStart, endHz: capEnd })),
		[capStart, capEnd, plotState.view, plotState.free],
	)
	const hover = useMemo(() => new Store<Hover>(null), [])
	const range = useMemo(() => new Store<RangeSelection | null>(null), [])
	const sigMenu = useMemo(() => new Store<SignalMenuAt | null>(null), [])
	const viewRef = useRef(view)
	viewRef.current = view
	useDiscoveryFetch(data.scanner, view)
	const discOnly = discoveryTagFilter(device.signalLabels)
	const discRow = useDiscoveryRow(data.scanner, discOnly)
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
		centreTuning: device.clickTuning === "centre",
	}
	controller.setContext(context)
	const tunerCentre = context.centreHz
	useEffect(
		() => controller.captureChanged(),
		[controller, capStart, capEnd, tunerCentre],
	)

	const layout = plotLayout(
		size.h,
		(discRow ? DISCOVERY_ROW_CSS : 0) + RULER_CSS,
	)
	const unverified = shownMeta?.tuningTrust === "unverified"

	const gateCtx = useRef({
		mode: device.signalLabels,
		tunedHz: vfoHz,
		plan,
		saved: savedItems,
		discoveries,
	})
	gateCtx.current = {
		mode: device.signalLabels,
		tunedHz: vfoHz,
		plan,
		saved: savedItems,
		discoveries,
	}

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
		const g = gateCtx.current
		gateRef.current = stepLabelGate(gateRef.current, m, performance.now(), {
			mode: g.mode,
			tunedHz: g.tunedHz,
			isNamed: (hz, widthHz) =>
				namedChannelAt(g.plan, hz, widthHz) ||
				savedNear(g.saved, hz, widthHz) !== null ||
				identifiedAt(g.discoveries.values(), hz, widthHz) !== null,
		})
		setLabelled(gatedSignals(gateRef.current))
	}
	const onStatus = (status: SpectrumEngineStatus) => {
		if (status.type === "error") setEngineError(status.message)
		if (status.type === "reset" && status.reason !== "profile") {
			heldRef.current = []
			setTracks([])
			gateRef.current = EMPTY_LABEL_GATE
			setLabelled([])
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
		readOnly,
		squelchDbfs: () =>
			handles.store.get().squelchDbfs ?? squelchLineDbfs(data.liveAudio.get()),
	}
	const handleFrame = useRef(frame)
	handleFrame.current = frame
	const clearHover = useMemo(() => () => hover.set(null), [hover])
	useHandles(bodyRef, handleFrame, handles, controller, clearHover)
	const traceRef = useRef(layout.traceCss)
	traceRef.current = layout.traceCss
	useInteraction(bodyRef, controller, hover, size.w, range, viewRef, {
		menu: sigMenu,
		traceCss: traceRef,
	})
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
					key={bins}
					sourceId={sourceId}
					hz={SPECTRUM_HZ}
					bins={bins}
					backfillMs={SPECTRUM_BACKFILL_MS}
					view={
						plotState.free ?? (plotState.view.spanHz === null ? null : view)
					}
					levels={levels}
					layout={{
						splitRatio: layout.splitRatio,
						gapCss: layout.gapCss,
						traceAlpha: AVERAGING_ALPHA[device.averaging],
					}}
					onFrameMeta={onFrameMeta}
					onStatus={onStatus}
					paused={paused ?? false}
					probeRef={probeRef}
				/>
				{size.w > 0 && view && (
					<>
						<div
							className="wk-plot-band"
							style={{ top: 0, height: layout.traceCss }}
						>
							<Grid
								levels={levels}
								traceCss={layout.traceCss}
								view={view}
								widthPx={size.w}
							/>
							<DbScale levels={levels} traceCss={layout.traceCss} />
							<SignalLabels
								signals={labelled}
								plan={plan}
								saved={savedItems}
								discoveries={discoveries}
								view={view}
								widthPx={size.w}
								traceCss={layout.traceCss}
								levels={levels}
								tunedHz={vfoHz}
								onPick={hz => void controller.tuneTo(hz)}
							/>
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
									only={discOnly}
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
						<SignalMenu
							menu={sigMenu}
							tunedHz={tuned}
							widthPx={size.w}
							heightPx={size.h}
							onClose={refocus => {
								if (refocus) bodyRef.current?.focus({ preventScroll: true })
							}}
						/>
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
			{size.w > 0 && view && capture && (
				<BandRuler
					data={data}
					controller={controller}
					plan={plan}
					view={view}
					capture={capture}
					widthPx={size.w}
					top={
						layout.traceCss +
						AXIS_CSS +
						LANES_CSS +
						(discRow ? DISCOVERY_ROW_CSS : 0)
					}
					discoveries={discOnly}
					tunedHz={vfoHz}
				/>
			)}
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

/** The board's faint grid over the trace: a line per dB label and per frequency tick. */
const Grid = memo(function Grid({
	levels,
	traceCss,
	view,
	widthPx,
}: {
	levels: { minDb: number; maxDb: number }
	traceCss: number
	view: SpectrumViewSpan
	widthPx: number
}) {
	return (
		<div className="wk-plot-grid" aria-hidden="true">
			{dbTicks(levels, traceCss).map(t => (
				<i key={`d${t.db}`} data-h="" style={{ top: Math.round(t.y) }} />
			))}
			{freqTicks(view, widthPx).map(t => (
				<i key={`f${t.hz}`} style={{ left: `${t.x * 100}%` }} />
			))}
		</div>
	)
})

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

/** A saved frequency on the signal, by its name. */
function savedNear(
	saved: readonly SavedFrequencyRow[],
	hz: number,
	widthHz: number,
): SavedFrequencyRow | null {
	const tol = Math.max(3000, widthHz / 2)
	let best: SavedFrequencyRow | null = null
	for (const f of saved) {
		const d = Math.abs(f.frequencyHz - hz)
		if (d <= tol && (!best || d < Math.abs(best.frequencyHz - hz))) best = f
	}
	return best
}

function SignalLabels({
	signals: gated,
	plan,
	saved,
	discoveries,
	view,
	widthPx,
	traceCss,
	levels,
	tunedHz: tuned,
	onPick,
}: {
	signals: readonly GatedSignal[]
	plan: ResolvedBandPlanView | null
	saved: readonly SavedFrequencyRow[]
	discoveries: ReadonlyMap<string, Discovery>
	view: SpectrumViewSpan
	widthPx: number
	traceCss: number
	levels: SpectrumLevels
	tunedHz: number | null
	onPick: (hz: number) => void
}) {
	const shown = useMemo(() => gated.filter(g => !g.leaving), [gated])
	const signals = useMemo(
		() =>
			describeTracks(
				shown.map(g => ({
					startHz: g.hz - g.widthHz / 2,
					endHz: g.hz + g.widthHz / 2,
					flags: { burst: g.burst, iqImage: false, edge: false },
					peakDb: g.peakDb,
				})),
				plan,
			).map(s => {
				// what was identified there names the signal first, then a saved frequency, then the band plan
				const d = identifiedAt(discoveries.values(), s.hz, s.widthHz)
				if (d)
					return {
						...s,
						label: identifiedLabel(d),
						sub: formatMHz(s.hz, 3),
						known: true,
					}
				const f = savedNear(saved, s.hz, s.widthHz)
				return f
					? { ...s, label: f.name, sub: formatMHz(s.hz, 3), known: true }
					: s
			}),
		[shown, plan, saved, discoveries],
	)
	const placed: PlacedLabel[] = useMemo(
		() =>
			placeLabels(signals, view, {
				widthPx,
				traceCss,
				levels,
				tunedHz: tuned,
			}),
		[signals, view.startHz, view.endHz, widthPx, traceCss, levels, tuned],
	)
	// Each chip keyed by its followed signal; a leaving one fades where it last stood.
	const lastAt = useRef(new Map<number, PlacedLabel & { burst: boolean }>())
	const chips: (PlacedLabel & {
		id: number
		burst: boolean
		leaving: boolean
	})[] = []
	const byHz = new Map(shown.map(g => [g.hz, g]))
	for (const l of placed) {
		const g = byHz.get(l.hz)
		if (!g) continue
		lastAt.current.set(g.id, { ...l, burst: g.burst })
		chips.push({ ...l, id: g.id, burst: g.burst, leaving: false })
	}
	const live = new Set(gated.map(g => g.id))
	for (const g of gated) {
		if (!g.leaving) continue
		const last = lastAt.current.get(g.id)
		if (last) chips.push({ ...last, id: g.id, leaving: true })
	}
	for (const id of lastAt.current.keys())
		if (!live.has(id)) lastAt.current.delete(id)
	return (
		<>
			{chips.map(l => (
				<div
					key={l.id}
					className="wk-plot-sig"
					data-hz={l.hz}
					data-tuned={l.tuned ? "" : undefined}
					data-unknown={l.known ? undefined : ""}
					data-burst={l.burst ? "" : undefined}
					data-leaving={l.leaving ? "" : undefined}
					aria-hidden={l.leaving ? true : undefined}
					style={{ left: l.x, top: l.top }}
				>
					<button
						type="button"
						tabIndex={l.leaving ? -1 : undefined}
						aria-label={
							l.known
								? `Tune to ${l.label} ${formatMHz(l.hz, 4)} MHz`
								: `Tune to the signal at ${formatMHz(l.hz, 4)} MHz`
						}
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

// ── Pointer, wheel and keys ─────────────────────────────────────────────────────────────────────

function useInteraction(
	ref: RefObject<HTMLDivElement | null>,
	controller: PlotController,
	hover: Store<Hover>,
	widthPx: number,
	range: Store<RangeSelection | null>,
	viewRef: RefObject<SpectrumViewSpan | null>,
	sig: {
		menu: Store<SignalMenuAt | null>
		traceCss: RefObject<number>
	},
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
			if (e.button === 0 && sig.menu.get()) {
				// a press outside the open signal menu only closes it
				if (!(e.target as Element).closest(`.${SIGNAL_MENU_CLASS}`))
					sig.menu.set(null)
				return
			}
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
			if ((e.target as Element).closest(`.${SIGNAL_MENU_CLASS}`)) return
			e.preventDefault()
			sig.menu.set(null)
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
			if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
				e.preventDefault()
				openFromKey()
				return
			}
			const action = keyAction(e.key, {
				shift: e.shiftKey,
				ctrl: e.ctrlKey,
				meta: e.metaKey,
				alt: e.altKey,
			})
			if (action && controller.key(action)) e.preventDefault()
		}

		// Right-click, long press or the menu key: the signal menu at the signal under the pointer (a signal
		// label: its own frequency; from the keyboard: the tuned frequency, at the VFO).
		let keyedAt = 0
		const openFromKey = () => {
			const view = viewRef.current
			const hz = controller.vfoHz()
			if (!view || hz === null) return
			const r = el.getBoundingClientRect()
			const x = ((hz - view.startHz) / spanWidth(view)) * r.width
			keyedAt = performance.now()
			sig.menu.set({
				hz,
				x: Math.min(Math.max(0, x), r.width),
				y: Math.round((sig.traceCss.current ?? 0) / 2),
			})
		}
		const onMenu = (e: MouseEvent) => {
			const target = e.target as Element
			if (target.closest(`.${SIGNAL_MENU_CLASS}, .${RANGE_OFFER_CLASS}`)) return
			e.preventDefault()
			// the menu key already opened it (its keydown came first)
			if (performance.now() - keyedAt < 500) return
			if (drag) {
				drag = null
				delete el.dataset["dragging"]
				void controller.endPan()
			}
			pointers.clear()
			hover.set(null)
			if (e.button !== 2 && e.clientX === 0 && e.clientY === 0) {
				openFromKey()
				return
			}
			const view = viewRef.current
			if (!view) return
			const r = el.getBoundingClientRect()
			const x = e.clientX - r.left
			const label = target.closest<HTMLElement>("[data-hz]")
			const fromLabel = Number(label?.dataset["hz"])
			// a label snaps like a click at its own frequency (the track's centre is not the channel)
			const at =
				label && Number.isFinite(fromLabel)
					? (fromLabel - view.startHz) / spanWidth(view)
					: x / Math.max(1, r.width)
			const hz = controller.signalAt(Math.min(1, Math.max(0, at)), r.width)
			if (hz === null) return
			sig.menu.set({
				hz,
				x: Math.min(Math.max(0, x), r.width),
				y: Math.min(Math.max(0, e.clientY - r.top), r.height),
			})
		}

		el.addEventListener("pointerdown", onDown)
		el.addEventListener("pointermove", onMove)
		el.addEventListener("pointerup", onUp)
		el.addEventListener("pointercancel", onUp)
		el.addEventListener("pointerleave", onLeave)
		el.addEventListener("wheel", onWheel, { passive: false })
		el.addEventListener("keydown", onKey)
		el.addEventListener("contextmenu", onMenu)
		return () => {
			el.removeEventListener("contextmenu", onMenu)
			el.removeEventListener("pointerdown", onDown)
			el.removeEventListener("pointermove", onMove)
			el.removeEventListener("pointerup", onUp)
			el.removeEventListener("pointercancel", onUp)
			el.removeEventListener("pointerleave", onLeave)
			el.removeEventListener("wheel", onWheel)
			el.removeEventListener("keydown", onKey)
		}
	}, [ref, controller, hover, range, viewRef, sig.menu, sig.traceCss])
}
