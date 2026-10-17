import { useEffect, useRef, type RefObject } from "react"
import { SpectrumEngine, type SpectrumEngineStatus } from "./engine.ts"
import type {
	SpectrumFrameMeta,
	SpectrumLayout,
	SpectrumLevels,
	SpectrumViewSpan,
} from "./protocol.ts"
import { DEFAULT_LAYOUT } from "./protocol.ts"
import { rampFromTheme } from "./ramp.ts"
import { historyDepth } from "./view.ts"

export interface SpectrumCanvasProps {
	/** Source to show; null unsubscribes. */
	sourceId: string | null
	/** Frames per second and bins asked of the core (defaults: the core's). */
	hz?: number
	bins?: number
	/**
	 * Recent waterfall rows the core replays on subscribe (WG1 backfill, ms, the core clamps to its
	 * limits), so the waterfall does not start empty.
	 */
	backfillMs?: number
	/** Visible span; null or absent shows the whole capture. */
	view?: SpectrumViewSpan | null
	levels?: SpectrumLevels
	layout?: Partial<SpectrumLayout>
	/** Colour ramp; default: the Match-accent ramp of the surrounding theme, followed live. */
	ramp?: Uint8Array
	onFrameMeta?: (meta: SpectrumFrameMeta) => void
	onStatus?: (status: SpectrumEngineStatus) => void
	/** Filled with the engine's level probe while mounted (hover readout); null otherwise. */
	probeRef?: RefObject<SpectrumProbe | null>
	className?: string
}

/** The newest row's peak dBFS over [startHz, endHz], null when no row covers it. */
export type SpectrumProbe = (
	startHz: number,
	endHz: number,
) => Promise<number | null>

const fill = { position: "relative", width: "100%", height: "100%" } as const
const THEME_ATTRIBUTES = [
	"data-wk-theme",
	"data-wk-accent",
	"data-wk-ground",
	"class",
	"style",
]

/**
 * Spectrum trace + waterfall filling its parent. The canvas is created in an effect (a canvas can be
 * transferred to a worker only once, which a remount would otherwise repeat).
 */
export function SpectrumCanvas(props: SpectrumCanvasProps) {
	const hostRef = useRef<HTMLDivElement>(null)
	const engineRef = useRef<SpectrumEngine | null>(null)
	const propsRef = useRef(props)
	propsRef.current = props

	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		const canvas = document.createElement("canvas")
		canvas.style.cssText =
			"position:absolute;inset:0;width:100%;height:100%;display:block"
		host.appendChild(canvas)
		const initial = propsRef.current
		// The texture depth is fixed for the engine's life: size it for the tallest this plot can get
		// (the screen), so the waterfall reaches the bottom edge after any resize.
		const dpr = window.devicePixelRatio || 1
		const tallest = Math.max(
			host.getBoundingClientRect().height,
			window.screen?.availHeight ?? 0,
			window.innerHeight,
		)
		const engine = new SpectrumEngine(canvas, {
			historyRows: historyDepth(
				tallest,
				dpr,
				initial.layout?.rowHeightCss ?? DEFAULT_LAYOUT.rowHeightCss,
			),
			...(initial.levels ? { levels: initial.levels } : {}),
			...(initial.layout ? { layout: initial.layout } : {}),
			ramp: initial.ramp ?? rampFromTheme(host),
		})
		engineRef.current = engine
		const probeRef = initial.probeRef
		if (probeRef)
			probeRef.current = (startHz, endHz) => engine.probe(startHz, endHz)
		const offMeta = engine.onFrameMeta(meta =>
			propsRef.current.onFrameMeta?.(meta),
		)
		const offStatus = engine.onStatus(status =>
			propsRef.current.onStatus?.(status),
		)

		const resize = () => {
			const rect = host.getBoundingClientRect()
			engine.resize(
				Math.max(1, rect.width),
				Math.max(1, rect.height),
				window.devicePixelRatio || 1,
			)
		}
		const observer = new ResizeObserver(resize)
		observer.observe(host)
		resize()

		// Follow theme and accent changes unless a ramp is given.
		const themeObserver = new MutationObserver(() => {
			if (!propsRef.current.ramp) engine.setRamp(rampFromTheme(host))
		})
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: THEME_ATTRIBUTES,
		})

		return () => {
			observer.disconnect()
			themeObserver.disconnect()
			if (probeRef) probeRef.current = null
			offMeta()
			offStatus()
			engine.dispose()
			engineRef.current = null
			canvas.remove()
		}
	}, [])

	const { sourceId, hz, bins, backfillMs } = props
	useEffect(() => {
		const engine = engineRef.current
		if (!engine) return
		if (sourceId === null) {
			engine.setSubscription(null)
			return
		}
		engine.setSubscription({
			sourceId,
			...(hz !== undefined ? { hz } : {}),
			...(bins !== undefined ? { bins } : {}),
			...(backfillMs !== undefined ? { backfillMs } : {}),
		})
	}, [sourceId, hz, bins, backfillMs])

	const viewStart = props.view?.startHz ?? null
	const viewEnd = props.view?.endHz ?? null
	useEffect(() => {
		engineRef.current?.setView(
			viewStart === null || viewEnd === null
				? null
				: { startHz: viewStart, endHz: viewEnd },
		)
	}, [viewStart, viewEnd])

	const minDb = props.levels?.minDb
	const maxDb = props.levels?.maxDb
	useEffect(() => {
		if (minDb !== undefined && maxDb !== undefined)
			engineRef.current?.setLevels({ minDb, maxDb })
	}, [minDb, maxDb])

	const splitRatio = props.layout?.splitRatio
	const gapCss = props.layout?.gapCss
	const rowHeightCss = props.layout?.rowHeightCss
	const peakHold = props.layout?.peakHold
	const peakDecayDbPerSec = props.layout?.peakDecayDbPerSec
	useEffect(() => {
		const layout: Partial<SpectrumLayout> = {}
		if (splitRatio !== undefined) layout.splitRatio = splitRatio
		if (gapCss !== undefined) layout.gapCss = gapCss
		if (rowHeightCss !== undefined) layout.rowHeightCss = rowHeightCss
		if (peakHold !== undefined) layout.peakHold = peakHold
		if (peakDecayDbPerSec !== undefined)
			layout.peakDecayDbPerSec = peakDecayDbPerSec
		engineRef.current?.setLayout(layout)
	}, [splitRatio, gapCss, rowHeightCss, peakHold, peakDecayDbPerSec])

	const { ramp } = props
	useEffect(() => {
		if (ramp) engineRef.current?.setRamp(ramp)
	}, [ramp])

	return <div ref={hostRef} className={props.className} style={fill} />
}
