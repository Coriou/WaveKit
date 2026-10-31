// The Map's pure helpers: geometry, the palette's altitude steps, items from the mock's fleets (glyphs, dead
// reckoning, labels, the selection panel, Activity tokens, the station estimate, mesh links), screen placement and
// hit testing, the GeoJSON it feeds MapLibre, and the view's UI store.
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { FleetEntry, FleetState } from "../../src/data/fleet-store.ts"
import {
	TRACK_CATEGORIES,
	trailsPath,
	trailsSchema,
} from "../../src/data/trail-history-store.ts"
import {
	aircraftSchema,
	aprsSchema,
	meshSchema,
	vesselSchema,
	type Aircraft,
	type Aprs,
	type Mesh,
	type Vessel,
} from "../../src/data/fleets.ts"
import {
	approxArea,
	coverageShapes,
	graticule,
	markers,
	rings,
	trailEnd,
	trailHead,
	trailSegments,
	trailSpanMs,
} from "../../src/features/map/features.ts"
import {
	bearing,
	cardinal,
	destination,
	distanceKm,
	flText,
	kmPerPx,
	relativeText,
	scaleBar,
	toLocator,
} from "../../src/features/map/geo.ts"
import {
	activityTokenOf,
	agoText,
	countsOf,
	describe as describeItem,
	entityKeyOf,
	glyphOf,
	itemsOf,
	labelPriority,
	labelText,
	meshLinks,
	predict,
	pushInterval,
	selectionInfo,
	routeFits,
	aircraftDetails,
	stationOf,
	wantsLabel,
	withinRange,
	type MapItem,
} from "../../src/features/map/items.ts"
import {
	altColours,
	altStep,
	FALLBACK_TOKENS,
	mapPalette,
} from "../../src/features/map/palette.ts"
import {
	candidates,
	clickResult,
	cycleNearest,
	hitsNear,
	LABEL_H,
	placeLabels,
	type LabelRequest,
} from "../../src/features/map/placement.ts"
import { buildStyle, LAYER, themedPaint } from "../../src/features/map/style.ts"
import { MapUi, parseStored } from "../../src/features/map/ui-store.ts"
import { ROSCOFF } from "../../mock/map.ts"
import { displayStore } from "../../src/features/display.ts"

// the board's Map reads in km: these tests run in metric (Settings › Display › Units)
displayStore.setLocal({ units: "metric" })
import { buildMockServer, type MockServer } from "../../mock/server.ts"

const STATION = { lat: ROSCOFF[0], lon: ROSCOFF[1] }
const NOW = 1_800_000_000_000

function fleet<T>(
	values: readonly T[],
	key: (v: T) => string,
	pos: (v: T) => boolean,
): FleetState<T> {
	const entries = new Map<string, FleetEntry<T>>()
	for (const v of values)
		entries.set(key(v), {
			value: v,
			heardAt: NOW - 1500,
			posAt: pos(v) ? NOW - 1500 : null,
			trail: [],
			trailFromCore: false,
		})
	return { status: "live", error: null, entries, revision: 1 }
}

describe("geo", () => {
	it("goes out and comes back: destination, distance and bearing agree", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -60, max: 60, noNaN: true }),
				fc.double({ min: -170, max: 170, noNaN: true }),
				fc.double({ min: 0, max: 359.9, noNaN: true }),
				fc.double({ min: 0.5, max: 400, noNaN: true }),
				(lat, lon, brg, km) => {
					const p = destination({ lat, lon }, brg, km)
					expect(distanceKm({ lat, lon }, p)).toBeCloseTo(km, 3)
					const back = bearing({ lat, lon }, p)
					const diff = Math.abs(((back - brg + 540) % 360) - 180)
					expect(diff).toBeLessThan(0.01)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("names directions, distances, locators and levels as the board does", () => {
		expect(cardinal(0)).toBe("N")
		expect(cardinal(44)).toBe("NE")
		expect(cardinal(359)).toBe("N")
		expect(cardinal(-90)).toBe("W")
		const p = destination(STATION, 45, 12.4)
		expect(relativeText(STATION, p)).toBe("12 km NE")
		expect(relativeText(STATION, destination(STATION, 180, 3.26))).toBe(
			"3.3 km S",
		)
		expect(toLocator(STATION.lat, STATION.lon)).toBe("IN88aq")
		expect(flText(36_000)).toBe("FL360")
		expect(flText(9_000)).toBe("2 750 m")
		expect(flText(9_000, { units: "nautical", timeFormat: "utc" })).toBe(
			"9 000 ft",
		)
		expect(flText(3_480)).toBe("1 050 m")
	})

	it("picks a round scale bar that fits", () => {
		const kpp = kmPerPx(48.7, 7.6)
		const sb = scaleBar(kpp)
		expect(sb.px).toBeLessThanOrEqual(110)
		expect(sb.text).toBe(`${sb.km} km`)
		expect(sb.km).toBe(20)
		expect(scaleBar(kmPerPx(48.7, 15)).text).toMatch(/ m$/)
	})
})

describe("palette", () => {
	it("steps altitudes into five bands, null counting as ground", () => {
		expect(
			[null, 0, 9_999, 10_000, 25_000, 30_000, 45_000].map(altStep),
		).toEqual([0, 0, 0, 1, 2, 3, 4])
		expect(altColours(false)).toHaveLength(5)
		expect(altColours(true)).toHaveLength(5)
	})

	it("Paper is a chart: light sea, a shallow band, fixed data colours", () => {
		const dark = mapPalette(
			{ theme: "dark", ground: "black", accent: "mono" },
			FALLBACK_TOKENS,
		)
		const paper = mapPalette(
			{ theme: "light", ground: "ink", accent: "mono" },
			FALLBACK_TOKENS,
		)
		expect(paper.light).toBe(true)
		expect(paper.shallow).not.toBeNull()
		expect(dark.shallow).toBeNull()
		expect(dark.sea).toBe("#000000")
		expect(paper.data.vessel).not.toBe(dark.data.vessel)
		// accent changes never move the data colours
		const ice = mapPalette(
			{ theme: "dark", ground: "black", accent: "ice" },
			FALLBACK_TOKENS,
		)
		expect(ice.data).toEqual(dark.data)
	})
})

describe("style", () => {
	it("is our own minimal style: one basemap source, our GeoJSON sources, markers drawn last", () => {
		const pal = mapPalette(
			{ theme: "dark", ground: "black", accent: "mono" },
			FALLBACK_TOKENS,
		)
		const style = buildStyle(pal)
		expect(Object.keys(style.sources)).toContain("base")
		expect(style.layers.at(-1)?.id).toBe(LAYER.items)
		const vector = Object.values(style.sources).filter(s => s.type === "vector")
		expect(vector).toHaveLength(1)
		// without tiles the ground is sea; with them the background is land under the water layer
		const bg = (up: boolean) =>
			themedPaint(pal, up).find(([l]) => l === LAYER.bg)?.[2]
		expect(bg(false)).toBe(pal.sea)
		expect(bg(true)).toBe(pal.land)
	})

	it("asks nothing of the tile server when Map › Blank is picked", () => {
		const pal = mapPalette(
			{ theme: "dark", ground: "black", accent: "mono" },
			FALLBACK_TOKENS,
		)
		const style = buildStyle(pal, null)
		expect(style.glyphs).toBeUndefined()
		expect(Object.keys(style.sources)).not.toContain("base")
		expect(Object.values(style.sources).every(s => s.type === "geojson")).toBe(
			true,
		)
		expect(style.layers.some(l => "source" in l && l.source === "base")).toBe(
			false,
		)
		expect(style.layers.map(l => l.id)).toContain(LAYER.trails)
		expect(style.layers.at(-1)?.id).toBe(LAYER.items)
	})
})

describe("items from the mock's fleets", () => {
	let server: MockServer
	let items: MapItem[]
	let aircraft: Aircraft[]
	let vessels: Vessel[]
	let aprs: Aprs[]
	let mesh: Mesh[]
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
		const get = async (url: string) =>
			(await server.app.inject({ method: "GET", url })).json<
				Record<string, unknown[]>
			>()
		aircraft = ((await get("/api/aircraft"))["aircraft"] ?? []).map(a =>
			aircraftSchema.parse(a),
		)
		vessels = ((await get("/api/vessels"))["vessels"] ?? []).map(v =>
			vesselSchema.parse(v),
		)
		aprs = ((await get("/api/aprs/stations"))["stations"] ?? []).map(s =>
			aprsSchema.parse(s),
		)
		mesh = ((await get("/api/mesh/nodes"))["nodes"] ?? []).map(n =>
			meshSchema.parse(n),
		)
		items = itemsOf({
			aircraft: fleet(
				aircraft,
				a => a.icao,
				a => a.position !== null && a.position !== undefined,
			),
			vessels: fleet(
				vessels,
				v => v.mmsi,
				v => v.position !== null,
			),
			aprs: fleet(
				aprs,
				s => s.key,
				s => s.position !== null,
			),
			mesh: fleet(
				mesh,
				m => m.nodeId,
				m => m.position !== null,
			),
		})
	})
	afterAll(async () => {
		await server.close()
	})

	it("normalises every fleet, aircraft drawn last, counted per layer", () => {
		expect(countsOf(items)).toEqual({
			aircraft: 34,
			vessels: 15,
			aprs: 6,
			mesh: 4,
		})
		expect(items.at(-1)?.kind).toBe("aircraft")
		expect(items[0]?.kind).toBe("mesh")
		expect(new Set(items.map(i => i.id)).size).toBe(items.length)
	})

	it("finds every moving item's stored trail by its Activity entity key and puts it in front", async () => {
		const res = await server.app.inject({
			method: "GET",
			url: trailsPath(TRACK_CATEGORIES),
		})
		const raw = res.json() as { trails: { category: string }[] }
		expect(raw.trails.some(t => t.category === "aviation-data")).toBe(false)
		const body = trailsSchema.parse(raw)
		const history = new Map(
			body.trails.map(t => [
				t.entityKey,
				t.points.map(([at, lat, lon]) => ({ lat, lon, at })),
			]),
		)
		const moving = items.filter(i => i.kind !== "aton" && i.moving)
		expect(moving.length).toBeGreaterThan(30)
		for (const it of moving) expect(history.has(entityKeyOf(it))).toBe(true)
		const fleets = {
			aircraft: fleet(
				aircraft,
				a => a.icao,
				a => a.position !== undefined,
			),
			vessels: fleet(
				vessels,
				v => v.mmsi,
				v => v.position !== null,
			),
			aprs: fleet(
				aprs,
				s => s.key,
				s => s.position !== null,
			),
			mesh: fleet(
				mesh,
				m => m.nodeId,
				m => m.position !== null,
			),
		}
		const withPast = itemsOf(fleets, history)
		const afr = withPast.find(i => i.name === "AFR1234")
		expect(afr?.trail.length).toBeGreaterThan(1)
		const times = afr?.trail.map(p => p.at) ?? []
		expect([...times].sort((x, y) => x - y)).toEqual(times)
	})

	it("serves positions reported over datalink only to the ACARS layer, to 0.1°", async () => {
		const res = await server.app.inject({
			method: "GET",
			url: trailsPath(["aviation-data"]),
		})
		const body = trailsSchema.parse(res.json())
		expect(body.trails.length).toBeGreaterThan(0)
		for (const t of body.trails)
			for (const [, lat, lon] of t.points) {
				expect(Math.round(lat * 10) / 10).toBe(lat)
				expect(Math.round(lon * 10) / 10).toBe(lon)
			}
	})

	it("chooses the board's glyphs", () => {
		const glyphs = new Set(items.map(i => glyphOf(i).glyph))
		for (const g of ["hull", "aton", "aprs", "wx", "mesh"])
			expect(glyphs).toContain(g)
		const afr = items.find(i => i.name === "AFR1234")
		expect(afr && glyphOf(afr)).toEqual({
			glyph: "plane-3",
			rotate: afr?.course,
		})
		const moored = items.find(i => i.kind === "vessel" && !i.moving)
		if (moored) expect(glyphOf(moored)).toEqual({ glyph: "moored", rotate: 0 })
		const batz = items.find(i => i.kind === "aton")
		expect(batz && labelText(batz)).toBe(batz?.name)
	})

	it("fills the selection panel with distance, bearing, decoder and freshness", () => {
		for (const it of items) {
			const info = selectionInfo(it, STATION, NOW)
			expect(info.title).toBe(it.name)
			expect(info.fields.length).toBeGreaterThanOrEqual(4)
			expect(info.fields.find(([k]) => k === "From station")?.[1]).toMatch(
				/^\d+(\.\d)? km (N|NE|E|SE|S|SW|W|NW)$/,
			)
			// 1.5 s after a report: aircraft say seconds, the throttled fleets say "just now"
			expect(info.seen).toMatch(it.kind === "aircraft" ? /2 s ago/ : /just now/)
			expect(describeItem(it).length).toBeGreaterThan(0)
		}
		const wx = items.find(i => glyphOf(i).glyph === "wx")
		expect(
			wx && selectionInfo(wx, STATION, NOW).fields.map(f => f[0]),
		).toContain("Temperature")
		const node = items.find(i => i.kind === "mesh")
		expect(
			node &&
				selectionInfo(node, null, NOW).fields.find(
					f => f[0] === "From station",
				)?.[1],
		).toBe("—")
	})

	it("shows an aircraft's photo, planned route and identity from the core's enrichment", () => {
		const afr = items.find(i => i.name === "AFR1234")
		expect(afr).toBeDefined()
		const info = selectionInfo(afr!, STATION, NOW)
		expect(info.sub).toBe("Air France · A320 214")
		expect(info.aircraft?.photo).toMatchObject({
			credit: "© Mock photographer · Planespotters",
			link: "https://www.planespotters.net/",
		})
		expect(info.aircraft?.photo?.src).toMatch(/^data:image\/svg\+xml/)
		expect(info.aircraft?.route).toEqual({
			from: "CDG",
			fromName: "Paris",
			to: "JFK",
			toName: "New York",
		})
		expect(info.aircraft?.ident).toContainEqual(["Registration", "F-HBNA"])
		expect(info.aircraft?.ident).toContainEqual(["Type", "A320 214"])
		expect(info.aircraft?.ident).toContainEqual(["ICAO address", "3944EF"])
		const navy = items.find(i => i.name === "FNY03")
		expect(navy && selectionInfo(navy, STATION, NOW).aircraft?.military).toBe(
			true,
		)
		expect(navy && selectionInfo(navy, STATION, NOW).aircraft?.photo).toBeNull()
	})

	it("hides a planned route the track disagrees with, or that belongs to another callsign", () => {
		const route = {
			origin: { lat: 49.0128, lon: 2.55 }, // CDG
			destination: { lat: 40.6398, lon: -73.7789 }, // JFK
		}
		const brittany = { lat: 48.81, lon: -3.87 }
		expect(routeFits(route, brittany, 284)).toBe(true)
		expect(routeFits(route, brittany, 100)).toBe(false)
		expect(routeFits(route, brittany, null)).toBe(true)
		// just after take-off any heading is fine
		expect(routeFits(route, { lat: 49.1, lon: 2.4 }, 100)).toBe(true)
		const afr = aircraft.find(a => a.callsign === "AFR1234")!
		const renamed = { ...afr, callsign: "ZZ0999" }
		expect(aircraftDetails(renamed, brittany, 284).route).toBeNull()
	})

	it("names an aircraft by callsign, else registration, else ICAO address", () => {
		const a = aircraft.find(x => x.callsign === "AFR1234")!
		const named = (v: Aircraft) =>
			itemsOf({
				aircraft: fleet(
					[v],
					x => x.icao,
					() => true,
				),
				vessels: fleet(
					[],
					(v: Vessel) => v.mmsi,
					() => true,
				),
				aprs: fleet(
					[],
					(s: Aprs) => s.key,
					() => true,
				),
				mesh: fleet(
					[],
					(m: Mesh) => m.nodeId,
					() => true,
				),
			})[0]?.name
		expect(named(a)).toBe("AFR1234")
		expect(named({ ...a, callsign: undefined })).toBe("F-HBNA")
		const { identification: _, ...bare } = a
		expect(named({ ...bare, callsign: undefined })).toBe("3944EF")
	})

	it("opens Activity with the existing search tokens", () => {
		const a = items.find(i => i.kind === "aircraft")
		const v = items.find(i => i.kind === "vessel")
		const p = items.find(i => i.kind === "aprs")
		const m = items.find(i => i.kind === "mesh")
		expect(a && activityTokenOf(a)).toMatchObject({ kind: "icao" })
		expect(v && activityTokenOf(v)).toMatchObject({
			kind: "mmsi",
			value: v?.source.kind === "vessel" ? v.source.value.mmsi : "",
		})
		expect(p && activityTokenOf(p)).toMatchObject({
			kind: "entity",
			value: expect.stringMatching(/^callsign:/),
		})
		expect(m && activityTokenOf(m)).toMatchObject({
			kind: "entity",
			value: expect.stringMatching(/^node:!/),
		})
	})

	it("estimates the station from what is heard when none is set", () => {
		expect(stationOf({ lat: 48, lon: -4 }, items)).toEqual({
			kind: "set",
			lat: 48,
			lon: -4,
		})
		const est = stationOf({ lat: null, lon: null }, items)
		expect(est.kind).toBe("approximate")
		if (est.kind === "approximate")
			expect(distanceKm(STATION, est)).toBeLessThan(25)
		expect(stationOf(null, [])).toEqual({ kind: "none" })
	})

	it("links mesh nodes once each, with their SNR", () => {
		const links = meshLinks(items)
		expect(links.length).toBeGreaterThan(0)
		const keys = links.map(l => [l.a.id, l.b.id].sort().join("|"))
		expect(new Set(keys).size).toBe(keys.length)
		expect(links.every(l => l.a.kind === "mesh" && l.b.kind === "mesh")).toBe(
			true,
		)
	})

	it("drops items beyond the receiver's plausible range", () => {
		expect(withinRange(items, STATION).length).toBe(items.length)
		expect(withinRange(items, { lat: 10, lon: 10 })).toEqual([])
		expect(withinRange(items, null).length).toBe(items.length)
	})

	it("draws markers with glyph, rotation and order, the selected one on top", () => {
		const list = items.slice(0, 5).map(it => ({ it, at: predict(it, NOW) }))
		const fc0 = markers(list, items[2]?.id ?? null)
		expect(fc0.features).toHaveLength(5)
		expect(fc0.features[2]?.properties["z"]).toBe(9)
		expect(fc0.features[0]?.properties["g"]).toBe(
			glyphOf(items[0] as MapItem).glyph,
		)
	})
})

function item(over: Partial<MapItem> = {}): MapItem {
	return {
		id: "a:3944EF",
		kind: "aircraft",
		layer: "aircraft",
		lat: STATION.lat,
		lon: STATION.lon,
		posAt: NOW,
		heardAt: NOW,
		course: 90,
		speedKn: 450,
		altFt: 36_000,
		moving: true,
		name: "AFR1234",
		trail: [],
		trailFromCore: false,
		source: { kind: "aircraft", value: {} as Aircraft },
		...over,
	}
}

describe("dead reckoning and freshness", () => {
	it("moves along course at speed, and stops after the kind's limit", () => {
		const it0 = item()
		const p = predict(it0, NOW + 10_000)
		expect(distanceKm(it0, p)).toBeCloseTo((450 * 1.852 * 10) / 3600, 3)
		expect(bearing(it0, p)).toBeCloseTo(90, 0)
		expect(distanceKm(it0, predict(it0, NOW + 600_000))).toBeCloseTo(
			distanceKm(it0, predict(it0, NOW + 60_000)),
			6,
		)
		expect(predict(item({ moving: false }), NOW + 60_000)).toEqual({
			lat: it0.lat,
			lon: it0.lon,
		})
		expect(predict(it0, NOW - 5_000)).toEqual({ lat: it0.lat, lon: it0.lon })
	})

	it("pushes positions when the fastest item moves half a pixel, between 4 Hz and 0.5 Hz", () => {
		const kpp = kmPerPx(48.7, 7.6)
		const ms = pushInterval(450, kpp)
		expect(ms).toBeGreaterThan(250)
		expect(ms).toBeLessThanOrEqual(2000)
		expect(pushInterval(450, kmPerPx(48.7, 13))).toBe(250)
		expect(pushInterval(0, kpp)).toBe(2000)
		expect(pushInterval(5, kpp)).toBe(2000)
	})

	it("says ago in steps, never under the freshness floor", () => {
		expect(agoText(400)).toBe("just now")
		expect(agoText(1_900, 2_000)).toBe("just now")
		expect(agoText(2_400, 2_000)).toBe("2 s ago")
		expect(agoText(90_000)).toBe("2 min ago")
		expect(agoText(3 * 3_600_000)).toBe("3 h ago")
	})

	it("labels by zoom and priority", () => {
		expect(wantsLabel("aircraft", 6)).toBe(false)
		expect(wantsLabel("aircraft", 7)).toBe(true)
		expect(wantsLabel("vessel", 7.6)).toBe(false)
		expect(wantsLabel("vessel", 9)).toBe(true)
		expect(wantsLabel("aton", 9)).toBe(false)
		// Map › Labels: Few waits for a closer zoom, Many names them sooner
		expect(wantsLabel("aircraft", 7, "few")).toBe(false)
		expect(wantsLabel("aircraft", 8, "few")).toBe(true)
		expect(wantsLabel("vessel", 7.6, "many")).toBe(true)
		expect(wantsLabel("vessel", 6, "many")).toBe(false)
		const it0 = item()
		expect(labelText(it0)).toBe("AFR1234  FL360")
		const sel = labelPriority(it0, {
			selected: true,
			hovered: false,
			kmFromStation: 0,
		})
		const hov = labelPriority(it0, {
			selected: false,
			hovered: true,
			kmFromStation: 0,
		})
		const near = labelPriority(it0, {
			selected: false,
			hovered: false,
			kmFromStation: 20,
		})
		const far = labelPriority(it0, {
			selected: false,
			hovered: false,
			kmFromStation: 200,
		})
		const ship = labelPriority(item({ kind: "vessel", layer: "vessels" }), {
			selected: false,
			hovered: false,
			kmFromStation: 5,
		})
		expect(sel < hov && hov < near && near < far && far < ship).toBe(true)
	})
})

describe("placement", () => {
	const measure = (t: string) => t.length * 6
	const req = (
		id: string,
		x: number,
		y: number,
		priority: number,
		force = false,
	): LabelRequest => ({
		id,
		text: id,
		x,
		y,
		priority,
		force,
		bold: false,
	})

	it("never overlaps two labels, nor a label and the UI (property)", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.integer({ min: 0, max: 400 }),
						fc.integer({ min: 0, max: 300 }),
					),
					{ maxLength: 40 },
				),
				pts => {
					const u = [300, 0, 400, 80] as const
					const ui = [u]
					const placed = placeLabels(
						pts.map(([x, y], i) => req(`L${i}`, x, y, i)),
						{ width: 400, height: 300, measure, ui, markers: [] },
					)
					for (let i = 0; i < placed.length; i++) {
						const a = placed[i]?.rect
						if (!a) continue
						expect(a[0] >= 2 && a[1] >= 2 && a[2] <= 398 && a[3] <= 298).toBe(
							true,
						)
						expect(
							a[0] < u[2] && a[2] > u[0] && a[1] < u[3] && a[3] > u[1],
						).toBe(false)
						for (let j = i + 1; j < placed.length; j++) {
							const b = placed[j]?.rect
							if (!b) continue
							expect(
								a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
							).toBe(false)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("tries six positions, right of the marker first, and keeps a forced label", () => {
		const c = candidates(100, 100, 40)
		expect(c).toHaveLength(6)
		expect(c[0]).toEqual([111, 100 - LABEL_H / 2, 151, 100 + LABEL_H / 2])
		const placed = placeLabels(
			[req("A", 100, 100, 0), req("SEL", 100, 100, -2, true)],
			{
				width: 400,
				height: 300,
				measure,
				ui: [],
				markers: [],
			},
		)
		expect(placed.map(p => p.request.id)).toContain("SEL")
	})

	it("hit tests nearest first, chooses in clusters and walks with N", () => {
		const pts = [
			{ id: "a", x: 100, y: 100 },
			{ id: "b", x: 104, y: 100 },
			{ id: "c", x: 300, y: 300 },
		]
		const near = hitsNear(pts, 101, 100, 12)
		expect(near.map(h => h.id)).toEqual(["a", "b"])
		expect(clickResult(near)).toEqual({
			kind: "choose",
			ids: ["a", "b"],
			count: 2,
		})
		expect(clickResult(hitsNear(pts, 300, 301, 12))).toEqual({
			kind: "select",
			id: "c",
		})
		expect(clickResult([])).toEqual({ kind: "none" })
		const many = Array.from({ length: 9 }, (_, i) => ({
			id: `m${i}`,
			x: 50 + i,
			y: 50,
		}))
		const r = clickResult(hitsNear(many, 54, 50, 12))
		expect(r.kind === "choose" && r.ids.length === 6 && r.count === 9).toBe(
			true,
		)
		expect(cycleNearest(pts, 100, 100, null, 1)).toBe("a")
		expect(cycleNearest(pts, 100, 100, "a", 1)).toBe("b")
		expect(cycleNearest(pts, 100, 100, "c", 1)).toBe("a")
		expect(cycleNearest(pts, 100, 100, null, -1)).toBe("c")
		expect(cycleNearest(pts, 100, 100, "a", -1)).toBe("c")
		expect(cycleNearest([], 0, 0, null, 1)).toBeNull()
	})
})

describe("features", () => {
	it("draws rings, the approximate area and a graticule around the station", () => {
		expect(rings(null).features).toEqual([])
		const r = rings(STATION)
		expect(r.features).toHaveLength(7)
		const ring = r.features[0]?.geometry
		if (ring?.type === "LineString") {
			const p = ring.coordinates[10]
			expect(p && distanceKm(STATION, { lon: p[0], lat: p[1] })).toBeCloseTo(
				5,
				2,
			)
		}
		expect(approxArea(STATION).features).toHaveLength(1)
		expect(graticule(STATION).features.length).toBeGreaterThan(0)
	})

	it("closes a coverage polygon per protocol in bearing order, nothing without a station", () => {
		const sectors = [90, 0, 270, 180].map(b => {
			const p = destination(STATION, b, 50)
			return {
				bearingDeg: b,
				distanceKm: 50,
				lat: p.lat,
				lon: p.lon,
				at: "2026-10-17T10:00:00.000Z",
			}
		})
		const shapes = coverageShapes({
			available: true,
			station: { lat: STATION.lat, lon: STATION.lon },
			protocols: [{ protocol: "ais", sectors, positions: 4 }],
		} as unknown as Parameters<typeof coverageShapes>[0])
		const g = shapes.features[0]?.geometry
		expect(g?.type).toBe("Polygon")
		if (g?.type === "Polygon") {
			const ring = g.coordinates[0] ?? []
			expect(ring).toHaveLength(5)
			expect(ring[0]).toEqual(ring[4])
			expect(ring[0]?.[1]).toBeGreaterThan(STATION.lat)
		}
		expect(
			coverageShapes({
				available: false,
				reason: "no-station-location",
			} as unknown as Parameters<typeof coverageShapes>[0]).features,
		).toEqual([])
		expect(coverageShapes(null).features).toEqual([])
	})

	it("fades a trail in three segments, newest the most opaque, within the kind's span", () => {
		const trail = Array.from({ length: 13 }, (_, k) => {
			const at = NOW - (12 - k) * 15_000
			const p = destination(STATION, 270, (12 - k) * 2)
			return { lat: p.lat, lon: p.lon, at }
		})
		const segs = trailSegments(item({ trail }), STATION, NOW, "#fff")
		expect(segs).toHaveLength(3)
		expect(segs.map(s => s.properties["a"])).toEqual([0.5, 0.28, 0.1])
		expect(
			trailSegments(item({ kind: "aton", trail }), STATION, NOW, "#fff"),
		).toEqual([])
		expect(trailSegments(item({ trail: [] }), STATION, NOW, "#fff")).toEqual([])
		// nothing older than three minutes for aircraft
		const old = trail.map(p => ({ ...p, at: p.at - 3_600_000 }))
		expect(trailSegments(item({ trail: old }), STATION, NOW, "#fff")).toEqual(
			[],
		)
	})

	it("follows Map › Trail length: the whole length for vessels, a fifth of it for aircraft", () => {
		expect(trailSpanMs("vessel")).toBe(15 * 60_000)
		expect(trailSpanMs("aircraft")).toBe(3 * 60_000)
		expect(trailSpanMs("aprs", 60)).toBe(3_600_000)
		expect(trailSpanMs("aircraft", 5)).toBe(60_000)
		expect(trailSpanMs("aton", 60)).toBe(0)
		// points 2 to 8 minutes old: past a 1 min aircraft trail, inside a 12 min one
		const trail = Array.from({ length: 7 }, (_, k) => {
			const at = NOW - (8 - k) * 60_000
			const p = destination(STATION, 270, (8 - k) * 10)
			return { lat: p.lat, lon: p.lon, at }
		})
		const it = item({ trail })
		expect(trailSegments(it, null, NOW, "#fff", 5)).toEqual([])
		expect(trailEnd(it, NOW, 5)).toBeNull()
		expect(trailSegments(it, null, NOW, "#fff", 60).length).toBeGreaterThan(0)
		expect(trailEnd(it, NOW, 60)).not.toBeNull()
	})

	it("draws a body without its head, and the head from the body's end to the marker", () => {
		const trail = Array.from({ length: 13 }, (_, k) => {
			const at = NOW - (12 - k) * 15_000
			const p = destination(STATION, 270, (12 - k) * 2)
			return { lat: p.lat, lon: p.lon, at }
		})
		const it = item({ trail })
		const body = trailSegments(it, null, NOW, "#fff")
		const last = trail[trail.length - 1]
		const newest = body[0]?.geometry
		expect(newest?.type).toBe("LineString")
		const coords = newest?.type === "LineString" ? newest.coordinates : []
		expect(coords[coords.length - 1]).toEqual([last?.lon, last?.lat])
		const end = trailEnd(it, NOW)
		expect(end).toEqual({ lat: last?.lat, lon: last?.lon })
		const head = trailHead(end ?? STATION, STATION, "#fff")
		expect(head.properties?.["a"]).toBe(0.5)
		expect(head.geometry).toEqual({
			type: "LineString",
			coordinates: [
				[last?.lon, last?.lat],
				[STATION.lon, STATION.lat],
			],
		})
		expect(trailEnd(item({ trail: [] }), NOW)).toBeNull()
		expect(trailEnd(item({ kind: "aton", trail }), NOW)).toBeNull()
		const old = trail.map(p => ({ ...p, at: p.at - 3_600_000 }))
		expect(trailEnd(item({ trail: old }), NOW)).toBeNull()
	})
})

describe("map UI store", () => {
	it("reads stored layers and overlays field by field, everything on by default", () => {
		expect(parseStored(null).layers).toEqual({
			aircraft: true,
			vessels: true,
			aprs: true,
			mesh: true,
		})
		expect(parseStored("not json").overlays.rings).toBe(true)
		const s = parseStored(
			JSON.stringify({
				layers: { aircraft: false, bogus: 1 },
				overlays: { trails: false, rings: "x" },
			}),
		)
		expect(s.layers).toEqual({
			aircraft: false,
			vessels: true,
			aprs: true,
			mesh: true,
		})
		expect(s.overlays.trails).toBe(false)
		expect(s.overlays.rings).toBe(true)
	})

	it("Escape closes the chooser, then the overlays menu, then the selection", () => {
		const ui = new MapUi(null, false)
		expect(ui.escape()).toBe(false)
		ui.select("a:1")
		ui.setFollow(true)
		expect(ui.get().follow).toBe(true)
		ui.setOverlaysOpen(true)
		ui.openChooser({ x: 1, y: 2, ids: ["a:1", "a:2"], count: 2 })
		expect(ui.escape()).toBe(true)
		expect(ui.get().chooser).toBeNull()
		expect(ui.escape()).toBe(true)
		expect(ui.get().overlaysOpen).toBe(false)
		expect(ui.get().selected).toBe("a:1")
		expect(ui.escape()).toBe(true)
		expect(ui.get()).toMatchObject({ selected: null, follow: false })
		expect(ui.escape()).toBe(false)
	})

	it("follows only a selection, and a new selection stops following", () => {
		const ui = new MapUi(null, false)
		ui.setFollow(true)
		expect(ui.get().follow).toBe(false)
		ui.select("v:1")
		ui.setFollow(true)
		ui.select("v:2")
		expect(ui.get().follow).toBe(false)
		ui.toggleLayer("mesh")
		ui.toggleOverlay("labels")
		expect(ui.get().layers.mesh).toBe(false)
		expect(ui.get().overlays.labels).toBe(false)
		ui.clearAll()
		expect(ui.get().selected).toBeNull()
	})
})
