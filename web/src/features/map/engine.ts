// The Map's engine: one MapLibre map with our style, GeoJSON sources fed from the fleet stores, one animation loop
// that dead-reckons positions between reports and pushes them at a bounded rate (4 Hz idle, every frame while
// following), labels and ring distances drawn collision-free on a 2D overlay after each MapLibre frame, hit testing
// for hover, click, the cluster chooser and N / Shift-N. Nothing runs while the tab is hidden.
import "maplibre-gl/dist/maplibre-gl.css"

import { Map as MapLibreMap, Marker } from "maplibre-gl"
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl"

import type {
	CoverageStore,
	Fleets,
	StationStore,
	TrailHistoryStore,
} from "../../data/index.ts"
import { Store, type ReadableStore } from "../../data/store.ts"
import type { TrailHistoryState } from "../../data/trail-history-store.ts"
import {
	approxArea,
	collection,
	coverageShapes,
	graticule,
	links as linkFeatures,
	markers,
	rings,
	trailEnd,
	trailHead,
	trailSegments,
	type Feature,
	type FeatureCollection,
} from "./features.ts"
import { displayStore } from "../display.ts"
import {
	destination,
	distanceKm,
	kmPerPx,
	ringDistances,
	type LatLon,
} from "./geo.ts"
import { drawGlyphs } from "./glyphs.ts"
import {
	countsOf,
	itemsOf,
	labelPriority,
	labelText,
	meshLinks,
	predict,
	pushInterval,
	stationOf,
	wantsLabel,
	withinRange,
	type LayerId,
	type MapItem,
	type StationLocation,
} from "./items.ts"
import {
	altStep,
	mapPalette,
	readTokens,
	type MapPalette,
	type ThemeKey,
} from "./palette.ts"
import {
	clickResult,
	cycleNearest,
	hitsNear,
	placeLabels,
	placeRingLabels,
	type LabelRequest,
	type Rect,
	type ScreenPoint,
} from "./placement.ts"
import {
	BASEMAP,
	buildStyle,
	GRID_STEPS,
	LAYER,
	SRC,
	themedPaint,
} from "./style.ts"
import type { MapUi, MapUiState } from "./ui-store.ts"
import { latestReports, reportedFeatures } from "./reported.ts"
import { devicePrefsStore, type MapTiles } from "../../shell/device-prefs.ts"

/** "blank": Map › Blank asked for no tiles. */
export type BasemapState = "loading" | "online" | "unavailable" | "blank"

export interface EngineView {
	readonly basemap: BasemapState
	readonly zoom: number
	readonly lat: number
	readonly counts: Readonly<Record<LayerId, number>>
	readonly station: StationLocation
	/** The camera sits on the station (the recentre button shows it). */
	readonly centred: boolean
}

export interface EngineDeps {
	readonly container: HTMLElement
	readonly overlay: HTMLCanvasElement
	readonly fleets: Fleets
	readonly coverage: CoverageStore
	readonly trailHistory: TrailHistoryStore
	/** Trails of the aviation-data category only: positions reported over ACARS and VDL2, followed live. */
	readonly reported: ReadableStore<TrailHistoryState>
	readonly station: StationStore
	readonly ui: MapUi
	/** The element whose computed style holds the theme tokens. */
	readonly themeScope: Element
	readonly themeKey: () => ThemeKey
	/** Rects (container px) labels keep clear of: the shell's islands and the map's own controls. */
	readonly uiRects: () => Rect[]
	/** Map › Beyond the offline map; a change makes a new engine (the style's sources differ). */
	readonly tiles: MapTiles
}

const INITIAL_ZOOM = 7.6
/** The board centres the view a little north of the station, so the rings sit under the islands' gap. */
const NORTH_BIAS_DEG = 0.12
const BASEMAP_TIMEOUT_MS = 10_000
/** A camera move's duration, or none when motion is reduced (Display › Motion). */
const glide = (ms: number): number =>
	devicePrefsStore.reducesMotion() ? 0 : ms
/** Trail bodies are re-sent at most this often; their heads follow the markers on every push. */
const TRAIL_BODY_MS = 2000

export class MapEngine {
	readonly view: Store<EngineView>
	private readonly deps: EngineDeps
	private readonly map: MapLibreMap
	private pal: MapPalette
	private loaded = false
	private items: MapItem[] = []
	private byId = new Map<string, MapItem>()
	private itemsDirty = true
	private staticDirty = true
	private dynamicDirty = true
	private lastPush = 0
	/** Trail bodies go out every TRAIL_BODY_MS (or on a layer change); heads with every push. */
	private trailsDirty = true
	private lastTrailPush = 0
	private trailEnds = new Map<string, LatLon>()
	private trailMin = devicePrefsStore.getState().mapTrail
	private labels = devicePrefsStore.getState().mapLabels
	private raf = 0
	private timer: ReturnType<typeof setTimeout> | null = null
	private drawn: { it: MapItem; at: LatLon }[] = []
	private points: ScreenPoint[] = []
	private readonly offs: (() => void)[] = []
	private dragging = false
	private stationMarker: Marker | null = null
	private stationEl: HTMLDivElement | null = null
	private placedCamera = false
	private uiCache: { at: number; rects: Rect[] } = { at: 0, rects: [] }
	private readonly textW = new Map<string, number>()
	private disposed = false
	private basemapTimer: ReturnType<typeof setTimeout> | null = null
	private mapCreated = false

	constructor(deps: EngineDeps) {
		this.deps = deps
		this.pal = mapPalette(deps.themeKey(), readTokens(deps.themeScope))
		this.view = new Store<EngineView>({
			basemap: deps.tiles === "blank" ? "blank" : "loading",
			zoom: INITIAL_ZOOM,
			lat: 48,
			counts: { aircraft: 0, vessels: 0, aprs: 0, mesh: 0 },
			station: { kind: "none" },
			centred: true,
		})
		this.rebuildItems()
		const st = this.view.get().station
		const start = st.kind === "none" ? null : st
		this.placedCamera = start !== null
		this.map = new MapLibreMap({
			container: deps.container,
			style: buildStyle(this.pal, deps.tiles === "blank" ? null : BASEMAP),
			center: start ? [start.lon, start.lat + NORTH_BIAS_DEG] : [2, 47],
			zoom: start ? INITIAL_ZOOM : 4.2,
			minZoom: 2.5,
			maxZoom: 14,
			attributionControl: false,
			dragRotate: false,
			pitchWithRotate: false,
			touchPitch: false,
			maxPitch: 0,
			keyboard: false,
			fadeDuration: 0,
			renderWorldCopies: false,
		})
		this.mapCreated = true
		this.placeStation(this.view.get().station)
		this.map.touchZoomRotate.disableRotation()
		this.map.on("load", () => this.onLoad())
		this.map.on("error", e => this.onError(e))
		this.map.on("sourcedata", e => {
			if (e.sourceId === SRC.base && e.tile !== undefined)
				this.setBasemap("online")
		})
		this.map.on("render", () => this.onRender())
		this.map.on("move", () => this.onMove())
		// a pan or zoom by hand (wheel, drag, pinch) leaves the station; ours (keys, buttons) have no originalEvent
		this.map.on("movestart", e => {
			if (e.originalEvent) this.setView({ centred: false })
		})
		// the scroll and double-click zooms start their move from a frame callback, without the event
		const leave = () => this.setView({ centred: false })
		this.map.on("wheel", leave)
		this.map.on("dblclick", leave)
		this.map.on("dragstart", () => {
			this.dragging = true
			deps.ui.setHover(null)
			deps.ui.setFollow(false)
		})
		this.map.on("dragend", () => {
			this.dragging = false
		})
		this.map.on("click", e => this.onClick(e))
		if (deps.tiles === "online")
			this.basemapTimer = setTimeout(() => {
				if (this.view.get().basemap === "loading")
					this.setBasemap("unavailable")
			}, BASEMAP_TIMEOUT_MS)

		const f = deps.fleets
		const dirtyItems = () => {
			this.itemsDirty = true
			this.kick()
		}
		for (const s of [f.aircraft, f.vessels, f.aprs, f.mesh])
			this.offs.push(s.subscribe(dirtyItems))
		this.offs.push(
			deps.coverage.subscribe(() => {
				this.staticDirty = true
				this.kick()
			}),
			deps.station.subscribe(dirtyItems),
			deps.trailHistory.subscribe(() => {
				this.trailsDirty = true
				dirtyItems()
			}),
			deps.reported.subscribe(() => {
				this.staticDirty = true
				this.kick()
			}),
			deps.ui.subscribe((next, prev) => this.onUi(next, prev)),
			// units: rings, labels and the hover line are drawn in them
			// Map › Trail length and Labels
			devicePrefsStore.subscribe(() => {
				const d = devicePrefsStore.getState()
				if (d.mapTrail === this.trailMin && d.mapLabels === this.labels) return
				if (d.mapTrail !== this.trailMin) this.trailsDirty = true
				this.trailMin = d.mapTrail
				this.labels = d.mapLabels
				this.dynamicDirty = true
				this.kick()
				this.map.triggerRepaint()
			}),
			displayStore.subscribe(() => {
				this.staticDirty = true
				this.itemsDirty = true
				this.dynamicDirty = true
				this.kick()
			}),
		)
		const onVisible = () => {
			if (!document.hidden) this.kick()
		}
		document.addEventListener("visibilitychange", onVisible)
		this.offs.push(() =>
			document.removeEventListener("visibilitychange", onVisible),
		)
	}

	dispose(): void {
		this.disposed = true
		for (const off of this.offs) off()
		if (this.raf) cancelAnimationFrame(this.raf)
		if (this.timer) clearTimeout(this.timer)
		if (this.basemapTimer) clearTimeout(this.basemapTimer)
		this.stationMarker?.remove()
		this.map.remove()
	}

	// ---- for the view

	/** The palette in use (the legend and the rail follow it). */
	get palette(): MapPalette {
		return this.pal
	}

	item(id: string): MapItem | undefined {
		return this.byId.get(id)
	}

	/** The station location in use (configured, else approximate). */
	stationPoint(): LatLon | null {
		const s = this.view.get().station
		return s.kind === "none" ? null : s
	}

	resize(): void {
		this.map.resize()
		this.sizeOverlay()
		this.uiCache.at = 0
		this.map.triggerRepaint()
	}

	/** The theme changed: new palette, paint values and glyph images. */
	retheme(): void {
		this.pal = mapPalette(
			this.deps.themeKey(),
			readTokens(this.deps.themeScope),
		)
		this.textW.clear()
		if (!this.loaded) return
		this.applyPaint()
		this.addGlyphs()
		this.map.triggerRepaint()
	}

	/** Zooms about the station while the view is on it (the rings stay put), else about the view's centre. */
	zoomBy(dz: number): void {
		const st = this.stationPoint()
		const around =
			this.view.get().centred && st
				? { around: [st.lon, st.lat] as [number, number] }
				: {}
		this.map.easeTo({
			zoom: this.map.getZoom() + dz,
			duration: glide(200),
			...around,
		})
	}

	panBy(dx: number, dy: number): void {
		this.deps.ui.setFollow(false)
		this.setView({ centred: false })
		this.map.panBy([dx, dy], { duration: glide(120) })
	}

	recentre(): void {
		const st = this.stationPoint()
		this.deps.ui.setFollow(false)
		if (!st) return
		this.map.easeTo({
			center: [
				st.lon,
				st.lat + NORTH_BIAS_DEG * 2 ** (INITIAL_ZOOM - this.map.getZoom()),
			],
			duration: glide(300),
		})
		this.setView({ centred: true })
	}

	/** N / Shift-N: select the next item by distance from the view's centre. */
	cycle(dir: 1 | -1): void {
		const c = this.deps.container
		const id = cycleNearest(
			this.points,
			c.clientWidth / 2,
			c.clientHeight / 2,
			this.deps.ui.get().selected,
			dir,
		)
		if (id) this.deps.ui.select(id)
	}

	/** Hover at container coordinates (a mouse; touch shows no hover). */
	hoverAt(x: number, y: number): void {
		if (this.dragging) return
		const near = hitsNear(this.points, x, y, 14)
		const first = near[0]
		this.deps.ui.setHover(
			first
				? { id: first.id, x: first.x, y: first.y, more: near.length - 1 }
				: null,
		)
	}

	/** The selected item's screen position, for anchoring nothing in particular but kept for the chooser. */
	screenOf(id: string): ScreenPoint | undefined {
		return this.points.find(p => p.id === id)
	}

	// ---- internals

	private setView(patch: Partial<EngineView>): void {
		const v = this.view.get()
		let changed = false
		for (const k of Object.keys(patch) as (keyof EngineView)[])
			if (!Object.is(v[k], patch[k])) changed = true
		if (changed) this.view.set({ ...v, ...patch })
	}

	private setBasemap(state: BasemapState): void {
		if (this.view.get().basemap === state) return
		// a tile that arrives after a failure means the basemap works after all
		if (state === "unavailable" && this.view.get().basemap === "online") return
		this.setView({ basemap: state })
		if (this.loaded) this.applyPaint()
	}

	private onError(e: { error?: unknown; sourceId?: string }): void {
		if (this.deps.tiles === "blank") return
		const text =
			e.error instanceof Error ? e.error.message : String(e.error ?? "")
		if (
			e.sourceId === SRC.base ||
			text.includes(new URL(BASEMAP.tileJson).host)
		)
			this.setBasemap("unavailable")
	}

	private onLoad(): void {
		if (this.disposed) return
		this.loaded = true
		this.addGlyphs()
		this.applyPaint()
		this.sizeOverlay()
		this.staticDirty = true
		this.dynamicDirty = true
		this.kick()
	}

	private addGlyphs(): void {
		const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
		for (const [id, img] of drawGlyphs(this.pal, ratio)) {
			if (this.map.hasImage(id)) this.map.updateImage(id, img)
			else this.map.addImage(id, img, { pixelRatio: ratio })
		}
	}

	private applyPaint(): void {
		const up = this.view.get().basemap === "online"
		for (const [layer, prop, value] of themedPaint(this.pal, up)) {
			const ids =
				layer === LAYER.grid
					? GRID_STEPS.map((_, i) =>
							i === 0 ? LAYER.grid : `${LAYER.grid}-${i}`,
						)
					: [layer]
			for (const id of ids)
				if (this.map.getLayer(id)) this.map.setPaintProperty(id, prop, value)
		}
		this.applyVisibility(this.deps.ui.get())
	}

	private applyVisibility(s: MapUiState): void {
		const vis = (id: string, on: boolean) => {
			if (this.map.getLayer(id))
				this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none")
		}
		const o = s.overlays
		vis(LAYER.rings, o.rings)
		vis(LAYER.covFill, o.coverage)
		vis(LAYER.covLine, o.coverage)
		vis(LAYER.places, o.labels)
		vis(LAYER.links, o.links && s.layers.mesh)
		vis(LAYER.trails, o.trails)
		vis(LAYER.trailHeads, o.trails)
		vis(LAYER.reported, s.reported)
	}

	private onUi(next: MapUiState, prev: MapUiState): void {
		if (next.reported !== prev.reported && this.loaded)
			this.applyVisibility(next)
		if (next.layers !== prev.layers || next.overlays !== prev.overlays) {
			if (this.loaded) this.applyVisibility(next)
			this.itemsDirty = true
			this.trailsDirty = true
		}
		if (
			next.selected !== prev.selected ||
			next.follow !== prev.follow ||
			next.hover?.id !== prev.hover?.id
		) {
			this.dynamicDirty = true
			if (next.follow && next.selected) this.setView({ centred: false })
		}
		this.kick()
	}

	private rebuildItems(): void {
		this.itemsDirty = false
		const f = this.deps.fleets
		const all = itemsOf(
			{
				aircraft: f.aircraft.get(),
				vessels: f.vessels.get(),
				aprs: f.aprs.get(),
				mesh: f.mesh.get(),
			},
			this.deps.trailHistory.get().trails,
		)
		const identity = this.deps.station.get().station
		const station = stationOf(
			identity ? { lat: identity.lat.value, lon: identity.lon.value } : null,
			all,
		)
		const point = station.kind === "none" ? null : station
		this.items = withinRange(all, point)
		this.byId = new Map(this.items.map(i => [i.id, i]))
		// a trail whose item left goes at once, not with the next body push
		for (const id of this.trailEnds.keys())
			if (!this.byId.has(id)) {
				this.trailsDirty = true
				break
			}
		const prev = this.view.get().station
		const moved =
			prev.kind !== station.kind ||
			(prev.kind !== "none" &&
				station.kind !== "none" &&
				(prev.lat !== station.lat || prev.lon !== station.lon))
		this.setView({
			counts: countsOf(this.items),
			...(moved ? { station } : {}),
		})
		if (moved) {
			this.staticDirty = true
			this.placeStation(station)
		}
		const sel = this.deps.ui.get().selected
		if (sel && !this.byId.has(sel)) this.deps.ui.select(null)
		this.dynamicDirty = true
	}

	private placeStation(st: StationLocation): void {
		// the first rebuild runs before the map exists; the constructor places the station after creating it
		if (!this.mapCreated) return
		if (st.kind === "none") {
			this.stationMarker?.remove()
			this.stationMarker = null
			return
		}
		if (!this.stationEl) {
			this.stationEl = document.createElement("div")
			this.stationEl.className = "wkm-station"
			this.stationEl.setAttribute("aria-hidden", "true")
			this.stationEl.innerHTML =
				'<span class="wkm-station-pulse"></span><span class="wkm-station-dot"></span>'
		}
		this.stationEl.dataset["approx"] =
			st.kind === "approximate" ? "true" : "false"
		if (!this.stationMarker)
			this.stationMarker = new Marker({ element: this.stationEl })
				.setLngLat([st.lon, st.lat])
				.addTo(this.map)
		else this.stationMarker.setLngLat([st.lon, st.lat])
		if (!this.placedCamera) {
			this.placedCamera = true
			this.map.jumpTo({
				center: [st.lon, st.lat + NORTH_BIAS_DEG],
				zoom: INITIAL_ZOOM,
			})
		}
	}

	/** Schedules the loop now (data or UI changed, or the tab came back). */
	private kick(): void {
		if (this.disposed || this.raf) return
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
		this.raf = requestAnimationFrame(this.frame)
	}

	private readonly frame = (): void => {
		this.raf = 0
		if (this.disposed || !this.loaded || document.hidden) return
		const now = Date.now()
		if (this.itemsDirty) this.rebuildItems()
		if (this.staticDirty) this.pushStatic()
		const ui = this.deps.ui.get()
		const following = ui.follow && ui.selected !== null
		const every = this.pushEvery()
		if (this.dynamicDirty || following || now - this.lastPush >= every)
			this.pushDynamic(now)
		if (following && ui.selected) {
			const it = this.byId.get(ui.selected)
			if (it) {
				const p = predict(it, now)
				this.map.jumpTo({ center: [p.lon, p.lat] })
			}
		}
		const moving = this.drawn.some(d => d.it.moving)
		if (following) this.raf = requestAnimationFrame(this.frame)
		else if (moving)
			this.timer = setTimeout(
				() => {
					this.timer = null
					this.kick()
				},
				Math.max(16, this.lastPush + every - now),
			)
	}

	/** The push interval for the fastest moving item drawn, at the current zoom. */
	private pushEvery(): number {
		let kn = 0
		for (const d of this.drawn)
			if (d.it.moving && d.it.speedKn !== null && d.it.speedKn > kn)
				kn = d.it.speedKn
		return pushInterval(
			kn,
			kmPerPx(this.map.getCenter().lat, this.map.getZoom()),
		)
	}

	private source(id: string): GeoJSONSource | undefined {
		return this.map.getSource<GeoJSONSource>(id)
	}

	private setData(id: string, data: FeatureCollection): void {
		this.source(id)?.setData(
			data as unknown as Parameters<GeoJSONSource["setData"]>[0],
		)
	}

	private pushStatic(): void {
		this.staticDirty = false
		const st = this.view.get().station
		const point = st.kind === "none" ? null : st
		this.setData(SRC.grid, graticule(point ?? { lat: 48, lon: 2 }))
		this.setData(SRC.rings, rings(point))
		this.setData(SRC.approx, approxArea(st.kind === "approximate" ? st : null))
		const cov = this.deps.coverage.get().coverage
		this.setData(
			SRC.coverage,
			st.kind === "set" ? coverageShapes(cov) : collection([]),
		)
		const now = Date.now()
		this.setData(
			SRC.reported,
			reportedFeatures(
				latestReports(this.deps.reported.get().trails, now),
				now,
			),
		)
	}

	private colourOf(it: MapItem): string {
		const d = this.pal.data
		switch (it.kind) {
			case "aircraft":
				return this.pal.alt[altStep(it.altFt)] ?? d.aprs
			case "vessel":
			case "aton":
				return d.vessel
			case "aprs":
				return d.aprs
			case "mesh":
				return d.mesh
		}
	}

	private pushDynamic(now: number): void {
		this.dynamicDirty = false
		this.lastPush = now
		const ui = this.deps.ui.get()
		const drawn = this.items
			.filter(it => ui.layers[it.layer])
			.map(it => ({ it, at: predict(it, now) }))
		this.drawn = drawn
		this.setData(SRC.items, markers(drawn, ui.selected))
		this.pushTrails(drawn, now, ui.overlays.trails)
		if (ui.overlays.links && ui.layers.mesh) {
			const at = new Map(drawn.map(d => [d.it.id, d.at]))
			this.setData(
				SRC.links,
				linkFeatures(
					meshLinks(this.items).map(l => ({
						a: at.get(l.a.id) ?? l.a,
						b: at.get(l.b.id) ?? l.b,
						snr: l.snr,
					})),
				),
			)
		}
	}

	/**
	 * Trails in two parts: the bodies (most of the coordinates) at most every TRAIL_BODY_MS, and with every push
	 * a short head from each body's end to the marker, so the line follows the marker without a gap.
	 */
	private pushTrails(
		drawn: readonly { it: MapItem; at: LatLon }[],
		now: number,
		on: boolean,
	): void {
		if (this.trailsDirty || now - this.lastTrailPush >= TRAIL_BODY_MS) {
			this.trailsDirty = false
			this.lastTrailPush = now
			this.trailEnds = new Map()
			const bodies: Feature[] = []
			if (on)
				for (const d of drawn) {
					const end = trailEnd(d.it, now, this.trailMin)
					if (!end) continue
					bodies.push(
						...trailSegments(
							d.it,
							null,
							now,
							this.colourOf(d.it),
							this.trailMin,
						),
					)
					this.trailEnds.set(d.it.id, end)
				}
			this.setData(SRC.trails, collection(bodies))
		}
		const heads: Feature[] = []
		if (on)
			for (const d of drawn) {
				const from = this.trailEnds.get(d.it.id)
				if (from) heads.push(trailHead(from, d.at, this.colourOf(d.it)))
			}
		this.setData(SRC.trailHeads, collection(heads))
	}

	private onMove(): void {
		const c = this.map.getCenter()
		const z = this.map.getZoom()
		const v = this.view.get()
		// the scale bar follows in steps; a store write per move frame only when the rounded value changes
		const zr = Math.round(z * 20) / 20
		const lr = Math.round(c.lat * 10) / 10
		const patch: { zoom?: number; lat?: number } = {}
		if (zr !== v.zoom) patch.zoom = zr
		if (lr !== v.lat) patch.lat = lr
		if (Object.keys(patch).length > 0) this.setView(patch)
	}

	private onClick(e: MapMouseEvent): void {
		const coarse =
			typeof matchMedia === "function" &&
			matchMedia("(pointer: coarse)").matches
		const near = hitsNear(this.points, e.point.x, e.point.y, coarse ? 22 : 12)
		const r = clickResult(near)
		const ui = this.deps.ui
		if (r.kind === "none") ui.clearAll()
		else if (r.kind === "select") ui.select(r.id)
		else
			ui.openChooser({ x: e.point.x, y: e.point.y, ids: r.ids, count: r.count })
	}

	private sizeOverlay(): void {
		const cv = this.deps.overlay
		const ratio = Math.min(2, window.devicePixelRatio || 1)
		const w = this.deps.container.clientWidth
		const h = this.deps.container.clientHeight
		if (
			cv.width !== Math.round(w * ratio) ||
			cv.height !== Math.round(h * ratio)
		) {
			cv.width = Math.round(w * ratio)
			cv.height = Math.round(h * ratio)
		}
	}

	private measure(
		g: CanvasRenderingContext2D,
		font: string,
		text: string,
	): number {
		const k = `${font}|${text}`
		let w = this.textW.get(k)
		if (w === undefined) {
			g.font = font
			w = g.measureText(text).width
			this.textW.set(k, w)
		}
		return w
	}

	private uiRects(): Rect[] {
		const now = performance.now()
		if (now - this.uiCache.at > 250)
			this.uiCache = { at: now, rects: this.deps.uiRects() }
		return this.uiCache.rects
	}

	/** After each MapLibre frame: project what is drawn (hit testing) and draw labels on the overlay. */
	private onRender(): void {
		if (!this.loaded) return
		const map = this.map
		const W = this.deps.container.clientWidth
		const H = this.deps.container.clientHeight
		const pts: ScreenPoint[] = []
		const markerRects: Rect[] = []
		for (const d of this.drawn) {
			const p = map.project([d.at.lon, d.at.lat])
			if (p.x < -30 || p.y < -30 || p.x > W + 30 || p.y > H + 30) continue
			pts.push({ id: d.it.id, x: p.x, y: p.y })
			markerRects.push([p.x - 8, p.y - 8, p.x + 8, p.y + 8])
		}
		this.points = pts
		const cv = this.deps.overlay
		const g = cv.getContext("2d")
		if (!g) return
		this.sizeOverlay()
		const ratio = cv.width / Math.max(1, W)
		g.setTransform(1, 0, 0, 1, 0, 0)
		g.clearRect(0, 0, cv.width, cv.height)
		g.setTransform(ratio, 0, 0, ratio, 0, 0)
		const ui = this.deps.ui.get()
		const zoom = map.getZoom()
		const st = this.stationPoint()
		const font = `11.5px ${this.pal.font}`
		const bold = `700 11.5px ${this.pal.font}`
		const byId = new Map(pts.map(p => [p.id, p]))
		const requests: LabelRequest[] = []
		for (const d of this.drawn) {
			const p = byId.get(d.it.id)
			if (!p) continue
			const selected = ui.selected === d.it.id
			const hovered = ui.hover?.id === d.it.id
			if (
				!selected &&
				!hovered &&
				!(ui.overlays.labels && wantsLabel(d.it.kind, zoom, this.labels))
			)
				continue
			requests.push({
				id: d.it.id,
				text: labelText(d.it),
				x: p.x,
				y: p.y,
				priority: labelPriority(d.it, {
					selected,
					hovered,
					kmFromStation: st ? distanceKm(st, d.at) : 0,
				}),
				force: selected || hovered,
				bold: selected,
			})
		}
		let stationXY: { x: number; y: number } | null = null
		if (st) {
			const s = map.project([st.lon, st.lat])
			stationXY = { x: s.x, y: s.y }
			markerRects.push([s.x - 10, s.y - 10, s.x + 10, s.y + 10])
		}
		const ui0 = this.uiRects()
		const placed = placeLabels(requests, {
			width: W,
			height: H,
			measure: (t, b) => this.measure(g, b ? bold : font, t),
			ui: ui0,
			markers: markerRects,
		})
		// ring distances along their rings, after the traffic
		const ringFont = `11px ${this.pal.font}`
		let ringDraws: { text: string; x: number; y: number }[] = []
		if (ui.overlays.rings && st && stationXY) {
			const sxy = stationXY
			const list = ringDistances()
				.map(({ km, text }) => {
					const q = map.project([destination(st, 90, km).lon, st.lat])
					return { text, r: Math.abs(q.x - sxy.x) }
				})
				.filter(r => r.r >= 48 && r.r <= Math.max(W, H) * 1.6)
			ringDraws = placeRingLabels(list, {
				cx: sxy.x,
				cy: sxy.y,
				width: W,
				height: H,
				measure: t => this.measure(g, ringFont, t),
				taken: [...ui0, ...markerRects, ...placed.map(p => p.rect)],
			})
		}
		// the selection ring (drawn here, not as a GL circle layer: one shader less to compile on first select)
		const selP = ui.selected ? byId.get(ui.selected) : undefined
		if (selP) {
			g.beginPath()
			g.arc(selP.x, selP.y, 15, 0, Math.PI * 2)
			g.strokeStyle = this.pal.selRing
			g.lineWidth = 1
			g.stroke()
		}
		g.textBaseline = "middle"
		g.font = ringFont
		g.textAlign = "center"
		for (const r of ringDraws) {
			const w = this.measure(g, ringFont, r.text) + 4
			g.fillStyle = this.pal.labelBox
			g.fillRect(r.x - w / 2, r.y - 7, w, 14)
			g.fillStyle = this.pal.ringText
			g.fillText(r.text, r.x, r.y)
		}
		g.textAlign = "left"
		for (const { request: l, rect } of placed) {
			const it = this.byId.get(l.id)
			g.font = l.bold ? bold : font
			g.fillStyle = this.pal.labelBox
			g.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1])
			g.fillStyle =
				it && it.kind !== "aircraft" ? this.colourOf(it) : this.pal.airText
			g.fillText(l.text, rect[0] + 3, rect[1] + 8.5)
		}
	}
}
