// The Map view (docs/web/canvas/Map.dc.html, embedded in the Immersive shell): MapLibre under the shell's islands,
// the layers rail under Receiver, the overlays menu with the legend, zoom and recentre, the hover tooltip, the
// cluster chooser, the selection panel, the station chip, the Live chip, the scale bar and the footer naming the
// basemap in use. Loaded only when the Map view opens (the Shell lazy-loads it), so MapLibre stays off the main chunk.
import "./map.css"

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type PointerEvent as ReactPointerEvent,
} from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/store.ts"
import { shellStore } from "../../shell/store.ts"
import { themeStore } from "../../shell/theme.ts"
import { isTypingTarget } from "../palette/keys.ts"
import { focusSetting } from "../settings/registry.ts"
import { mapFocus, takeMapFocus } from "./focus.ts"
import { MapEngine, type EngineView } from "./engine.ts"
import { fmtLat, fmtLon, kmPerPx, scaleBar, toLocator } from "./geo.ts"
import { legend } from "./glyphs.ts"
import {
	activityTokenOf,
	describe,
	selectionInfo,
	type LayerId,
	type MapItem,
} from "./items.ts"
import { altStep, type MapPalette } from "./palette.ts"
import type { Rect } from "./placement.ts"
import { BASEMAP } from "./style.ts"
import {
	MapUi,
	OVERLAY_IDS,
	type MapUiState,
	type OverlayId,
} from "./ui-store.ts"

export interface MapInsets {
	/** Bottom of the shell's top island row: the rail and panels start there. */
	readonly top: number
	/** Receiver's distance from the right edge (a full-height drawer pushes it in). */
	readonly right: number
	/** Phone layout: no dock, the find button sits bottom-right. */
	readonly phone: boolean
}

/** The rail collapses to icons under this width (DESIGN.md: the map's rail at 1100 px). */
const RAIL_WIDE_MIN = 1100
const RAIL_W = { wide: 156, narrow: 48 } as const
const PAN_PX = 80
const PAN_BIG_PX = 320

const LAYER_ICONS: Readonly<Record<LayerId | "acars", readonly string[]>> = {
	aircraft: [
		"M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2 -7h-4l-2 2h-3l2 -4l-2 -4h3l2 2h4l-2 -7h3l4 7",
	],
	vessels: [
		"M4 18l-1 -5h18l-2 4M5 13v-6h8l4 6M7 7v-4h-1",
		"M2 20a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1",
	],
	aprs: [
		"M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0",
		"M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
	],
	mesh: [
		"m10.82 7.2 -5.14 9.6M13.18 7.2l5.14 9.6M7 19h10",
		"M9.5 5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
		"M2 19a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
		"M17 19a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
	],
	acars: [
		"M4 9.5h12a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2H9l-4 3v-3H4a2 2 0 0 1 -2 -2v-6a2 2 0 0 1 2 -2Z",
		"M7 12.5h6M7 15.5h3",
		"M17 3a5 5 0 0 1 5 5M17 6a2 2 0 0 1 2 2",
	],
}

const LAYERS: readonly { id: LayerId; label: string; title: string }[] = [
	{ id: "aircraft", label: "Aircraft", title: "ADS-B · readsb" },
	{
		id: "vessels",
		label: "Vessels",
		title: "AIS, including aids to navigation",
	},
	{ id: "aprs", label: "APRS", title: "APRS, including weather and balloons" },
	{ id: "mesh", label: "Mesh", title: "Meshtastic nodes and links" },
]

const OVERLAY_TEXT: Readonly<Record<OverlayId, readonly [string, string]>> = {
	rings: ["Range rings", "Distance from your station"],
	coverage: ["Coverage", "Furthest reception per bearing, last 24 h"],
	trails: ["Trails", "Where things came from"],
	labels: ["Labels", "Callsigns, names and places"],
	links: ["Mesh links", "Who hears whom, by SNR"],
}

const ALT_LABELS = ["Ground", "10 000 ft", "FL200", "FL300", "FL400+"] as const

function Svg({
	paths,
	stroke = "currentColor",
	size = 16,
}: {
	paths: readonly string[]
	stroke?: string
	size?: number
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke={stroke}
			strokeWidth="1.9"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			style={{ flex: "none" }}
		>
			{paths.map(d => (
				<path key={d} d={d} />
			))}
		</svg>
	)
}

const CLOSE = ["M6 6l12 12M18 6l-12 12"]
const TARGET = [
	"M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
	"M12 2v3M12 19v3M2 12h3M19 12h3",
]

function layerColour(id: LayerId, pal: MapPalette): string {
	switch (id) {
		case "aircraft":
			return pal.alt[2] ?? pal.data.aprs
		case "vessels":
			return pal.data.vessel
		case "aprs":
			return pal.data.aprs
		case "mesh":
			return pal.data.mesh
	}
}

function itemColour(it: MapItem, pal: MapPalette): string {
	return it.kind === "aircraft"
		? (pal.alt[altStep(it.altFt)] ?? pal.data.aprs)
		: layerColour(it.layer, pal)
}

/** Re-renders every `ms` while `on` (freshness text in the panel). */
function useTick(on: boolean, ms: number): number {
	const [t, setT] = useState(() => Date.now())
	useEffect(() => {
		if (!on) return
		setT(Date.now())
		const id = setInterval(() => {
			if (!document.hidden) setT(Date.now())
		}, ms)
		return () => clearInterval(id)
	}, [on, ms])
	return t
}

function openStationSettings(): void {
	focusSetting("station.location")
	shellStore.openDrawer("settings")
}

/** Rects (relative to `box`) of what sits over the map: the shell's islands and the map's own controls. */
function uiRectsOf(box: HTMLElement): Rect[] {
	const b = box.getBoundingClientRect()
	const scope = box.closest(".wk-shell") ?? document.body
	const out: Rect[] = []
	const sel =
		".wk-shell-island, .wk-dock, .wk-shell-cardslot, .wk-shell-drawer, .wk-shell-find, .wk-shell-paneslot, [data-wkm-ui]"
	for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
		const r = el.getBoundingClientRect()
		if (r.width === 0 || r.height === 0) continue
		out.push([
			r.left - b.left - 4,
			r.top - b.top - 4,
			r.right - b.left + 4,
			r.bottom - b.top + 4,
		])
	}
	return out
}

export default function MapScreen({ insets }: { insets: MapInsets }) {
	const { data, activity } = useServices()
	const root = useRef<HTMLDivElement>(null)
	const box = useRef<HTMLDivElement>(null)
	const gl = useRef<HTMLDivElement>(null)
	const overlay = useRef<HTMLCanvasElement>(null)
	const [ui] = useState(() => new MapUi())
	const [engine, setEngine] = useState<MapEngine | null>(null)
	const [width, setWidth] = useState(() =>
		typeof window === "undefined" ? 1440 : window.innerWidth,
	)
	const theme = useSyncExternalStore(
		themeStore.subscribe,
		themeStore.getState,
		themeStore.getState,
	)
	const [themeRev, setThemeRev] = useState(0)

	// ---- data: attached while the Map is open
	useEffect(() => {
		const f = data.fleets
		const offs = [
			f.aircraft.attach(),
			f.vessels.attach(),
			f.aprs.attach(),
			f.mesh.attach(),
			data.coverage.attach(),
		]
		return () => {
			for (const off of offs) off()
		}
	}, [data])

	// ---- the engine
	useLayoutEffect(() => {
		const container = gl.current
		const cv = overlay.current
		const el = root.current
		const b = box.current
		if (!container || !cv || !el || !b) return
		const e = new MapEngine({
			container,
			overlay: cv,
			fleets: data.fleets,
			coverage: data.coverage,
			station: data.station,
			ui,
			themeScope: el,
			themeKey: () => themeStore.getState(),
			uiRects: () => uiRectsOf(b),
		})
		setEngine(e)
		return () => {
			e.dispose()
			setEngine(null)
		}
	}, [data, ui])

	// "Open on map" from a message card: select and follow, now or when the request arrives
	useEffect(() => {
		if (!engine) return
		const apply = () => {
			const f = takeMapFocus()
			if (!f) return
			ui.select(f.id)
			ui.setFollow(true)
		}
		apply()
		return mapFocus.subscribe(apply)
	}, [engine, ui])

	// a theme change: the attributes are on <html> before listeners run, so the computed tokens are current here
	const themeSeen = useRef(theme)
	useEffect(() => {
		if (!engine || themeSeen.current === theme) return
		themeSeen.current = theme
		engine.retheme()
		setThemeRev(r => r + 1)
	}, [engine, theme])

	useEffect(() => {
		const el = root.current
		if (!el || !engine) return
		const measure = () => {
			setWidth(el.clientWidth)
			engine.resize()
		}
		measure()
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure)
			return () => window.removeEventListener("resize", measure)
		}
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		return () => ro.disconnect()
	}, [engine])

	// ---- keyboard: arrows pan (Shift more), + / − zoom, 0 recentres, N / Shift-N next / previous, F follows,
	// Escape clears (the shell's open layers first unless the focus is on the map)
	useEffect(() => {
		if (!engine) return
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
			if (isTypingTarget(e.target)) return
			const shell = shellStore.getState()
			if (shell.palette) return
			const t = e.target as Node | null
			const onMap = t instanceof Node && root.current?.contains(t) === true
			const free =
				t === document.body || t === document.documentElement || t === null
			if (e.key === "Escape") {
				const shellOpen = shell.panel !== null || shell.drawer !== null
				if (!onMap && shellOpen) return
				if (ui.escape()) e.preventDefault()
				return
			}
			if (!onMap && !free) return
			if (shell.panel !== null) return
			const big = e.shiftKey ? PAN_BIG_PX : PAN_PX
			let handled = true
			switch (e.key) {
				case "ArrowLeft":
					engine.panBy(-big, 0)
					break
				case "ArrowRight":
					engine.panBy(big, 0)
					break
				case "ArrowUp":
					engine.panBy(0, -big)
					break
				case "ArrowDown":
					engine.panBy(0, big)
					break
				case "+":
				case "=":
					engine.zoomBy(1)
					break
				case "-":
				case "_":
				case "−":
					engine.zoomBy(-1)
					break
				case "0":
					engine.recentre()
					break
				case "n":
				case "N":
					if (e.repeat) return
					engine.cycle(e.shiftKey ? -1 : 1)
					break
				case "f":
				case "F": {
					if (e.repeat) return
					const s = ui.get()
					if (!s.selected) return
					ui.setFollow(!s.follow)
					break
				}
				default:
					handled = false
			}
			if (handled) e.preventDefault()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [engine, ui])

	// ---- hover (a mouse only), one hit test per frame
	const pending = useRef<{ x: number; y: number } | null>(null)
	const hoverRaf = useRef(0)
	const onPointerMove = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if (e.pointerType !== "mouse" || !engine || e.buttons !== 0) return
			const r = e.currentTarget.getBoundingClientRect()
			pending.current = { x: e.clientX - r.left, y: e.clientY - r.top }
			if (hoverRaf.current) return
			hoverRaf.current = requestAnimationFrame(() => {
				hoverRaf.current = 0
				const p = pending.current
				if (p) engine.hoverAt(p.x, p.y)
			})
		},
		[engine],
	)
	const onPointerLeave = useCallback(() => {
		pending.current = null
		ui.setHover(null)
	}, [ui])
	useEffect(() => () => cancelAnimationFrame(hoverRaf.current), [])

	const s = useStore(ui)
	const wide = width >= RAIL_WIDE_MIN
	const railW = wide ? RAIL_W.wide : RAIL_W.narrow
	const sideRight = insets.right + railW + 10
	const chipBottom = insets.phone ? 16 + 48 + 12 : 30

	return (
		<div
			ref={root}
			className="wkm"
			role="region"
			aria-label="Map"
			data-wide={wide || undefined}
			data-phone={insets.phone || undefined}
		>
			<div
				ref={box}
				className="wkm-box"
				data-wk-region=""
				tabIndex={0}
				role="application"
				aria-roledescription="map"
				aria-label="Map of decoded positions around the station. Arrow keys pan, plus and minus zoom, N selects the next item, F follows it, 0 recentres, Escape clears."
				onPointerMove={onPointerMove}
				onPointerLeave={onPointerLeave}
			>
				<div
					ref={gl}
					className="wkm-gl"
					// inline: maplibre-gl.css (unlayered) sets the container to position: relative
					style={{ position: "absolute", inset: 0 }}
				/>
				<canvas ref={overlay} className="wkm-labels" aria-hidden="true" />
			</div>
			{engine && (
				<MapChrome
					key={themeRev}
					engine={engine}
					ui={ui}
					s={s}
					insets={insets}
					wide={wide}
					railW={railW}
					sideRight={sideRight}
					chipBottom={chipBottom}
					onActivity={it => {
						activity.setSearch([activityTokenOf(it)], null)
						shellStore.openDrawer("activity")
					}}
				/>
			)}
		</div>
	)
}

interface ChromeProps {
	readonly engine: MapEngine
	readonly ui: MapUi
	readonly s: MapUiState
	readonly insets: MapInsets
	readonly wide: boolean
	readonly railW: number
	readonly sideRight: number
	readonly chipBottom: number
	readonly onActivity: (it: MapItem) => void
}

function MapChrome(props: ChromeProps) {
	const { engine, ui, s, insets, wide, railW, sideRight, chipBottom } = props
	const v = useStore(engine.view)
	const pal = engine.palette
	return (
		<>
			{s.hover && !s.chooser && <HoverTip engine={engine} hover={s.hover} />}
			{s.chooser && (
				<Chooser engine={engine} ui={ui} chooser={s.chooser} pal={pal} />
			)}
			<StationChip v={v} top={insets.top} right={sideRight} />
			<Rail
				engine={engine}
				ui={ui}
				s={s}
				v={v}
				pal={pal}
				top={insets.top}
				right={insets.right}
				wide={wide}
				width={railW}
			/>
			{s.overlaysOpen && (
				<OverlaysMenu
					ui={ui}
					s={s}
					v={v}
					pal={pal}
					top={insets.top}
					right={sideRight}
				/>
			)}
			{s.selected && !s.overlaysOpen && (
				<Selection
					engine={engine}
					ui={ui}
					id={s.selected}
					follow={s.follow}
					pal={pal}
					top={insets.top}
					right={sideRight}
					bottomGap={chipBottom + 54}
					onActivity={props.onActivity}
				/>
			)}
			<div
				data-wkm-ui=""
				className="wk-island wkm-live"
				style={{ right: insets.right, bottom: chipBottom }}
				title="Live positions. Replay needs history the core does not keep yet."
			>
				<span className="wkm-live-dot" aria-hidden="true" />
				Live
			</div>
			<ScaleBar v={v} right={insets.right + 2} bottom={chipBottom + 52} />
			<Footer v={v} right={insets.right} phone={insets.phone} />
		</>
	)
}

function HoverTip({
	engine,
	hover,
}: {
	engine: MapEngine
	hover: NonNullable<MapUiState["hover"]>
}) {
	const it = engine.item(hover.id)
	if (!it) return null
	return (
		<div
			className="wkm-tip"
			style={{ left: hover.x, top: hover.y }}
			role="tooltip"
		>
			<b>{it.name}</b> <span className="wkm-dim">{describe(it)}</span>
			{hover.more > 0 && (
				<span className="wkm-accent"> · +{hover.more} nearby</span>
			)}
		</div>
	)
}

function Chooser({
	engine,
	ui,
	chooser,
	pal,
}: {
	engine: MapEngine
	ui: MapUi
	chooser: NonNullable<MapUiState["chooser"]>
	pal: MapPalette
}) {
	const menu = useRef<HTMLDivElement>(null)
	useEffect(() => {
		menu.current
			?.querySelector<HTMLButtonElement>("button")
			?.focus({ preventScroll: true })
	}, [chooser])
	const items = chooser.ids
		.map(id => engine.item(id))
		.filter((x): x is MapItem => x !== undefined)
	const box = menu.current?.parentElement
	const W = box?.clientWidth ?? 1000
	const H = box?.clientHeight ?? 800
	const left = Math.max(8, Math.min(chooser.x + 12, W - 258))
	const top = Math.max(8, Math.min(chooser.y + 12, H - 60 - items.length * 48))
	const title =
		chooser.count > items.length
			? `${chooser.count} here · ${items.length} nearest`
			: `${chooser.count} here`
	return (
		<div
			ref={menu}
			data-wkm-ui=""
			className="wk-menu wkm-chooser"
			role="menu"
			aria-label="Several items here"
			style={{ left, top }}
			onKeyDown={e => {
				if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
				e.preventDefault()
				e.stopPropagation()
				const list = [
					...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ??
						[]),
				]
				const i = list.indexOf(document.activeElement as HTMLButtonElement)
				list[
					(i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length
				]?.focus()
			}}
		>
			<span className="wkm-menu-title">{title}</span>
			{items.map(it => (
				<button
					key={it.id}
					type="button"
					className="wk-option"
					data-size="touch"
					role="menuitem"
					onClick={() => ui.select(it.id)}
				>
					<span
						className="wkm-swatch"
						style={{
							background: itemColour(it, pal),
							borderRadius:
								it.layer === "aprs" || it.layer === "mesh" ? "50%" : 2,
						}}
					/>
					<span className="wkm-two">
						<b>{it.name}</b>
						<span className="wkm-dim">{describe(it)}</span>
					</span>
				</button>
			))}
		</div>
	)
}

function StationChip({
	v,
	top,
	right,
}: {
	v: EngineView
	top: number
	right: number
}) {
	if (v.station.kind === "set") return null
	// nothing heard yet and no location: the chip asks for one
	const text =
		v.station.kind === "approximate"
			? "Station location is approximate · Set it"
			: "Station location not set · Set it"
	return (
		// centred in the room left of the rail (a full-height drawer pushes the rail in)
		<div className="wkm-top" style={{ top, right }}>
			<button
				data-wkm-ui=""
				type="button"
				className="wk-btn wkm-approx"
				onClick={openStationSettings}
			>
				<Svg paths={TARGET} />
				{text}
			</button>
		</div>
	)
}

function Rail(props: {
	engine: MapEngine
	ui: MapUi
	s: MapUiState
	v: EngineView
	pal: MapPalette
	top: number
	right: number
	wide: boolean
	width: number
}) {
	const { engine, ui, s, v, pal, wide } = props
	const ovCount = OVERLAY_IDS.filter(o => s.overlays[o]).length
	const just = wide ? "flex-start" : "center"
	return (
		<div
			data-wkm-ui=""
			className="wkm-rail"
			style={{ top: props.top, right: props.right, width: props.width }}
		>
			<div
				className="wk-island wkm-rail-box"
				role="group"
				aria-label="Map layers"
			>
				{LAYERS.map(l => {
					const on = s.layers[l.id]
					const n = v.counts[l.id]
					return (
						<button
							key={l.id}
							type="button"
							className="wk-row"
							data-size="dense"
							aria-pressed={on}
							onClick={() => ui.toggleLayer(l.id)}
							title={l.title}
							aria-label={`${l.label}, ${n}${on ? ", shown" : ", hidden"}`}
							style={{ justifyContent: just }}
						>
							<Svg
								paths={LAYER_ICONS[l.id]}
								stroke={on ? layerColour(l.id, pal) : "var(--wk-text-5)"}
							/>
							{wide && (
								<>
									<span className="wkm-grow">{l.label}</span>
									<span className="wkm-cnt">{n}</span>
								</>
							)}
						</button>
					)
				})}
				<button
					type="button"
					className="wk-row"
					data-size="dense"
					aria-disabled="true"
					disabled
					title="ACARS and VDL2 position reports are not on the map yet: this WaveKit does not serve them"
					aria-label="ACARS, not available"
					style={{ justifyContent: just }}
				>
					<Svg paths={LAYER_ICONS.acars} stroke="var(--wk-text-5)" />
					{wide && (
						<>
							<span className="wkm-grow">ACARS</span>
							<span className="wkm-cnt">—</span>
						</>
					)}
				</button>
				{wide && s.layers.aircraft && (
					<div className="wkm-ramp" aria-hidden="true">
						<div className="wkm-ramp-bar">
							{pal.alt.map(c => (
								<span key={c} style={{ background: c }} />
							))}
						</div>
						<div className="wkm-ramp-text">
							<span>0</span>
							<span>FL200</span>
							<span>FL400</span>
						</div>
					</div>
				)}
				<div className="wkm-sep" />
				<button
					type="button"
					className="wk-row wkm-ovbtn"
					data-size="dense"
					onClick={() => ui.setOverlaysOpen(!s.overlaysOpen)}
					aria-expanded={s.overlaysOpen}
					aria-label="Overlays and legend"
					title="Overlays and legend"
					style={{ justifyContent: just }}
				>
					<Svg
						paths={[
							"M12 4l-8 4l8 4l8 -4l-8 -4",
							"M4 12l8 4l8 -4",
							"M4 16l8 4l8 -4",
						]}
					/>
					{wide && (
						<>
							<span className="wkm-grow">Overlays</span>
							<span className="wkm-cnt">{ovCount}</span>
						</>
					)}
				</button>
			</div>
			<div className="wk-island wkm-zoom" role="group" aria-label="Zoom">
				<button
					type="button"
					className="wk-icon-btn"
					data-size="lg"
					onClick={() => engine.zoomBy(1)}
					aria-label="Zoom in"
					title="Zoom in (+)"
				>
					<Svg paths={["M12 5v14M5 12h14"]} />
				</button>
				<button
					type="button"
					className="wk-icon-btn"
					data-size="lg"
					onClick={() => engine.zoomBy(-1)}
					aria-label="Zoom out"
					title="Zoom out (−)"
				>
					<Svg paths={["M5 12h14"]} />
				</button>
				<div className="wkm-sep" />
				<button
					type="button"
					className="wk-icon-btn"
					data-size="lg"
					onClick={() => engine.recentre()}
					aria-label="Centre on the station"
					title="Centre on the station (0)"
					disabled={v.station.kind === "none"}
					style={{ color: v.centred ? "var(--wk-accent)" : undefined }}
				>
					<Svg
						paths={[
							"M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
							"M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
							"M12 2v2M12 20v2M20 12h2M2 12h2",
						]}
					/>
				</button>
			</div>
		</div>
	)
}

function OverlaysMenu(props: {
	ui: MapUi
	s: MapUiState
	v: EngineView
	pal: MapPalette
	top: number
	right: number
}) {
	const { ui, s, v, pal } = props
	const coverageNote =
		v.station.kind !== "set" ? "Needs the station location" : null
	return (
		<div
			data-wkm-ui=""
			className="wkm-overlays"
			style={{ top: props.top, right: props.right }}
			role="group"
			aria-label="Overlays and legend"
		>
			{OVERLAY_IDS.map(o => {
				const [label, sub0] = OVERLAY_TEXT[o]
				const sub =
					o === "coverage" && coverageNote
						? coverageNote
						: o === "rings" && v.station.kind === "approximate"
							? "Around the approximate location"
							: sub0
				return (
					<button
						key={o}
						type="button"
						className="wkm-row"
						aria-pressed={s.overlays[o]}
						onClick={() => ui.toggleOverlay(o)}
					>
						<span className="wkm-two wkm-grow">
							<b>{label}</b>
							<span className="wkm-dim">{sub}</span>
						</span>
						<span
							className="wk-switch"
							aria-hidden="true"
							aria-checked={s.overlays[o]}
						/>
					</button>
				)
			})}
			<div className="wkm-sep" />
			<span className="wkm-menu-title">Legend</span>
			<div className="wkm-legend">
				{legend(pal).map(g => (
					<span key={g.label}>
						<svg
							width="16"
							height="16"
							viewBox="-10 -10 20 20"
							aria-hidden="true"
						>
							<path d={g.d} fill={g.fill} stroke={g.stroke} strokeWidth="1.4" />
						</svg>
						<span className="wkm-ellipsis">{g.label}</span>
					</span>
				))}
			</div>
			<div className="wkm-ramp wkm-ramp-big">
				<div className="wkm-ramp-bar">
					{pal.alt.map(c => (
						<span key={c} style={{ background: c }} />
					))}
				</div>
				<div className="wkm-ramp-text">
					{ALT_LABELS.map(t => (
						<span key={t}>{t}</span>
					))}
				</div>
			</div>
		</div>
	)
}

function Selection(props: {
	engine: MapEngine
	ui: MapUi
	id: string
	follow: boolean
	pal: MapPalette
	top: number
	right: number
	bottomGap: number
	onActivity: (it: MapItem) => void
}) {
	const { engine, ui } = props
	const now = useTick(true, 1000)
	const it = engine.item(props.id)
	if (!it) return null
	const info = selectionInfo(it, engine.stationPoint(), now)
	const icon = LAYER_ICONS[it.layer]
	return (
		<aside
			data-wkm-ui=""
			className="wk-island wkm-sel"
			data-expanded=""
			aria-label={`Selected: ${info.title}`}
			style={{
				top: props.top,
				right: props.right,
				maxHeight: `calc(100% - ${props.top + props.bottomGap}px)`,
			}}
		>
			<div className="wkm-sel-head">
				<span className="wk-tile" style={{ color: itemColour(it, props.pal) }}>
					<Svg paths={icon} size={18} />
				</span>
				<div className="wkm-two wkm-grow">
					<span className="wk-h3 wkm-ellipsis">{info.title}</span>
					<span className="wkm-dim wkm-ellipsis">{info.sub}</span>
				</div>
				<button
					type="button"
					className="wk-icon-btn"
					data-close=""
					onClick={() => ui.select(null)}
					aria-label="Close"
				>
					<Svg paths={CLOSE} />
				</button>
			</div>
			{info.note && <p className="wkm-note">{info.note}</p>}
			<div className="wkm-fields">
				{info.fields.map(([k, val]) => (
					<div key={k}>
						<span className="wkm-dim">{k}</span>
						<b className="wkm-ellipsis">{val}</b>
					</div>
				))}
			</div>
			<span className="wkm-seen">{info.seen}</span>
			<div className="wkm-actions">
				<button
					type="button"
					className="wk-chip"
					aria-pressed={props.follow}
					onClick={() => ui.setFollow(!props.follow)}
				>
					{props.follow ? "Following" : "Follow"}
				</button>
				<button
					type="button"
					className="wk-btn"
					data-variant="outline"
					data-size="lg"
					onClick={() => props.onActivity(it)}
				>
					Activity
				</button>
			</div>
		</aside>
	)
}

function ScaleBar({
	v,
	right,
	bottom,
}: {
	v: EngineView
	right: number
	bottom: number
}) {
	const sb = scaleBar(kmPerPx(v.lat, v.zoom))
	return (
		<div className="wkm-scale" aria-hidden="true" style={{ right, bottom }}>
			<span>{sb.text}</span>
			<span className="wkm-scale-bar" style={{ width: sb.px }} />
		</div>
	)
}

function Footer({
	v,
	right,
	phone,
}: {
	v: EngineView
	right: number
	phone: boolean
}) {
	const st = v.station
	const stationText =
		st.kind === "set"
			? `Station ${toLocator(st.lat, st.lon)}`
			: st.kind === "approximate"
				? "Station approximate"
				: "No station location"
	const stationTitle =
		st.kind === "none"
			? "Set the station location"
			: `${fmtLat(st.lat)} · ${fmtLon(st.lon)}`
	return (
		<div className="wkm-footer" style={{ right, bottom: phone ? 2 : 6 }}>
			<button
				type="button"
				className="wkm-link"
				onClick={openStationSettings}
				title={stationTitle}
			>
				<span className="wkm-dot" data-kind={st.kind} />
				{stationText}
			</button>
			<span>·</span>
			{v.basemap === "unavailable" ? (
				<span>Basemap unavailable · data only</span>
			) : v.basemap === "loading" ? (
				<span>Loading the map…</span>
			) : (
				<>
					<span>{BASEMAP.label}</span>
					<span>·</span>
					{BASEMAP.attribution.map(a => (
						<a key={a.href} href={a.href} target="_blank" rel="noreferrer">
							{a.text}
						</a>
					))}
				</>
			)}
		</div>
	)
}
