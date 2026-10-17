// The Map's items: every fleet entry with a position, normalised (pure). Glyph choice, dead reckoning between
// reports, labels and their priority, the hover line, the selection panel's fields and the Activity token.
import type { MapLabels } from "../../shell/device-prefs.ts"
import type {
	Aircraft,
	Aprs,
	FleetEntry,
	FleetState,
	Mesh,
	TrailPoint,
	Vessel,
} from "../../data/index.ts"
import { token, type SearchToken } from "../activity/search.ts"
import {
	altitudeText,
	climbText,
	speedText,
	temperatureText,
} from "../display.ts"
import {
	destination,
	distanceKm,
	flText,
	fmtLat,
	fmtLon,
	relativeText,
	type LatLon,
} from "./geo.ts"
import { altStep } from "./palette.ts"

export type LayerId = "aircraft" | "vessels" | "aprs" | "mesh"
export type ItemKind = "aircraft" | "vessel" | "aton" | "aprs" | "mesh"
export type GlyphId =
	| "plane-0"
	| "plane-1"
	| "plane-2"
	| "plane-3"
	| "plane-4"
	| "hull"
	| "moored"
	| "aton"
	| "aprs"
	| "wx"
	| "mesh"

export type ItemSource =
	| { readonly kind: "aircraft"; readonly value: Aircraft }
	| { readonly kind: "vessel"; readonly value: Vessel }
	| { readonly kind: "aprs"; readonly value: Aprs }
	| { readonly kind: "mesh"; readonly value: Mesh }

export interface MapItem {
	/** Unique across fleets: `a:<icao>`, `v:<mmsi>`, `p:<aprs key>`, `m:<node id>`. */
	readonly id: string
	readonly kind: ItemKind
	readonly layer: LayerId
	/** Last reported position. */
	readonly lat: number
	readonly lon: number
	/** When that position was received, this browser's clock (ms). */
	readonly posAt: number
	readonly heardAt: number
	/** Degrees true, null when unknown. */
	readonly course: number | null
	readonly speedKn: number | null
	readonly altFt: number | null
	/** Moving (glyph rotated by course, dead reckoned) or still (moored, fixed). */
	readonly moving: boolean
	readonly name: string
	readonly trail: readonly TrailPoint[]
	readonly trailFromCore: boolean
	readonly source: ItemSource
}

export const LAYER_OF: Readonly<Record<ItemKind, LayerId>> = {
	aircraft: "aircraft",
	vessel: "vessels",
	aton: "vessels",
	aprs: "aprs",
	mesh: "mesh",
}

/** Dead reckoning stops after this long without a report (the item then waits where it was predicted). */
export const MAX_DEAD_RECKON_MS: Readonly<Record<ItemKind, number>> = {
	aircraft: 60_000,
	vessel: 5 * 60_000,
	aton: 0,
	aprs: 10 * 60_000,
	mesh: 15 * 60_000,
}

/**
 * The core sends vessel, APRS and mesh updates at most every 2 s per entity (WG2 §9): freshness under that is
 * shown as "just now", never as a number of seconds the data cannot support.
 */
export const FRESHNESS_FLOOR_MS: Readonly<Record<ItemKind, number>> = {
	aircraft: 1000,
	vessel: 2000,
	aton: 2000,
	aprs: 2000,
	mesh: 2000,
}

// ---- normalising the fleets

const MOORED_STATUS = new Set([1, 5, 6])

function aircraftItem(e: FleetEntry<Aircraft>): MapItem | null {
	const a = e.value
	if (!a.position || e.posAt === null) return null
	const ground = a.altitude?.onGround === true
	const alt = ground ? 0 : (a.altitude?.baro ?? a.altitude?.geom ?? null)
	const course = a.velocity?.track ?? a.velocity?.trueHeading ?? null
	const speed = a.velocity?.gs ?? null
	return {
		id: `a:${a.icao}`,
		kind: "aircraft",
		layer: "aircraft",
		lat: a.position.lat,
		lon: a.position.lon,
		posAt: e.posAt,
		heardAt: e.heardAt,
		course,
		speedKn: speed,
		altFt: alt,
		moving: course !== null && speed !== null && speed > 0,
		name: a.callsign?.trim() || a.icao,
		trail: e.trail,
		trailFromCore: e.trailFromCore,
		source: { kind: "aircraft", value: a },
	}
}

function vesselItem(e: FleetEntry<Vessel>): MapItem | null {
	const v = e.value
	if (!v.position || e.posAt === null) return null
	const aton = v.vesselClass === "aton"
	const moving =
		!aton &&
		v.vesselClass !== "base-station" &&
		v.sog !== null &&
		v.sog >= 0.5 &&
		(v.cog !== null || v.heading !== null) &&
		!(v.navStatus !== null && MOORED_STATUS.has(v.navStatus))
	return {
		id: `v:${v.mmsi}`,
		kind: aton ? "aton" : "vessel",
		layer: "vessels",
		lat: v.position.lat,
		lon: v.position.lon,
		posAt: e.posAt,
		heardAt: e.heardAt,
		course: v.cog ?? v.heading,
		speedKn: v.sog,
		altFt: null,
		moving,
		name: v.name ?? `MMSI ${v.mmsi}`,
		trail: e.trail,
		trailFromCore: e.trailFromCore,
		source: { kind: "vessel", value: v },
	}
}

function aprsItem(e: FleetEntry<Aprs>): MapItem | null {
	const s = e.value
	if (!s.position || e.posAt === null || s.killed) return null
	return {
		id: `p:${s.key}`,
		kind: "aprs",
		layer: "aprs",
		lat: s.position.lat,
		lon: s.position.lon,
		posAt: e.posAt,
		heardAt: e.heardAt,
		course: s.courseDeg,
		speedKn: s.speedKn,
		altFt: s.altitudeFt,
		moving: s.speedKn !== null && s.speedKn >= 1 && s.courseDeg !== null,
		name: s.name ?? s.callsign,
		trail: e.trail,
		trailFromCore: e.trailFromCore,
		source: { kind: "aprs", value: s },
	}
}

function meshItem(e: FleetEntry<Mesh>): MapItem | null {
	const m = e.value
	if (!m.position || e.posAt === null) return null
	return {
		id: `m:${m.nodeId}`,
		kind: "mesh",
		layer: "mesh",
		lat: m.position.lat,
		lon: m.position.lon,
		posAt: e.posAt,
		heardAt: e.heardAt,
		course: null,
		speedKn: null,
		altFt: null,
		moving: false,
		name: m.longName ?? m.shortName ?? m.nodeId,
		trail: e.trail,
		trailFromCore: e.trailFromCore,
		source: { kind: "mesh", value: m },
	}
}

export interface FleetSnapshots {
	readonly aircraft: FleetState<Aircraft>
	readonly vessels: FleetState<Vessel>
	readonly aprs: FleetState<Aprs>
	readonly mesh: FleetState<Mesh>
}

/** Every entry with a position, in drawing order (mesh, APRS, AtoN, vessels, aircraft on top). */
export function itemsOf(f: FleetSnapshots): MapItem[] {
	const out: MapItem[] = []
	const add = <T>(
		s: FleetState<T>,
		fn: (e: FleetEntry<T>) => MapItem | null,
	) => {
		for (const e of s.entries.values()) {
			const it = fn(e)
			if (it) out.push(it)
		}
	}
	add(f.mesh, meshItem)
	add(f.aprs, aprsItem)
	add(f.vessels, vesselItem)
	add(f.aircraft, aircraftItem)
	return out
}

/** Items per layer (the rail's counts). */
export function countsOf(items: readonly MapItem[]): Record<LayerId, number> {
	const n: Record<LayerId, number> = {
		aircraft: 0,
		vessels: 0,
		aprs: 0,
		mesh: 0,
	}
	for (const it of items) n[it.layer] += 1
	return n
}

// ---- dead reckoning

/** Where the item is now: its last position moved along course at speed, for at most MAX_DEAD_RECKON_MS. */
export function predict(it: MapItem, now: number): LatLon {
	if (!it.moving || it.course === null || it.speedKn === null)
		return { lat: it.lat, lon: it.lon }
	const dt = Math.min(Math.max(0, now - it.posAt), MAX_DEAD_RECKON_MS[it.kind])
	if (dt === 0) return { lat: it.lat, lon: it.lon }
	return destination(it, it.course, (it.speedKn * 1.852 * dt) / 3_600_000)
}

const PUSH_MIN_MS = 250
const PUSH_MAX_MS = 2000

/**
 * Dead-reckoned positions are pushed when the fastest drawn item has moved about half a pixel, bounded to 4 Hz and
 * 0.5 Hz (at the default zoom an airliner moves about half a pixel a second, so most pushes would change nothing).
 */
export function pushInterval(maxKnots: number, kmPerPixel: number): number {
	if (maxKnots <= 0) return PUSH_MAX_MS
	const kmPerS = (maxKnots * 1.852) / 3600
	return Math.min(
		PUSH_MAX_MS,
		Math.max(PUSH_MIN_MS, ((0.5 * kmPerPixel) / kmPerS) * 1000),
	)
}

// ---- glyphs

export function isWeather(s: Aprs): boolean {
	return s.weather !== null || s.symbol === "/_" || s.symbol === "\\_"
}

/** The glyph and its rotation (degrees, clockwise from north; 0 for unrotated glyphs). */
export function glyphOf(it: MapItem): { glyph: GlyphId; rotate: number } {
	switch (it.kind) {
		case "aircraft":
			return {
				glyph: `plane-${altStep(it.altFt)}` as GlyphId,
				rotate: it.course ?? 0,
			}
		case "vessel":
			return it.moving
				? { glyph: "hull", rotate: it.course ?? 0 }
				: { glyph: "moored", rotate: 0 }
		case "aton":
			return { glyph: "aton", rotate: 0 }
		case "aprs":
			return {
				glyph:
					it.source.kind === "aprs" && isWeather(it.source.value)
						? "wx"
						: "aprs",
				rotate: 0,
			}
		case "mesh":
			return { glyph: "mesh", rotate: 0 }
	}
}

// ---- labels

/** The map label: aircraft show their level, everything else its name. */
export function labelText(it: MapItem): string {
	if (it.kind === "aircraft" && it.altFt !== null)
		return `${it.name}  ${flText(it.altFt)}`
	return it.name
}

/** Map › Labels: zoom levels added to the view's before the thresholds below (Many names items sooner). */
export const LABEL_ZOOM_BIAS: Readonly<Record<MapLabels, number>> = {
	few: -1.5,
	normal: 0,
	many: 1.5,
}

/** Which kinds get a label at a zoom (MapLibre zoom: one less than the board's 256 px zoom). */
export function wantsLabel(
	kind: ItemKind,
	zoom: number,
	labels: MapLabels = "normal",
): boolean {
	const z = zoom + 1 + LABEL_ZOOM_BIAS[labels]
	switch (kind) {
		case "aircraft":
			return z >= 7.5
		case "vessel":
			return z >= 9.4
		case "aton":
			return z >= 11
		default:
			return z >= 9
	}
}

const KIND_PRIORITY: Readonly<Record<ItemKind, number>> = {
	aircraft: 2,
	vessel: 3,
	aprs: 4,
	mesh: 5,
	aton: 6,
}

/** Lower places first: selected, hovered, then aircraft nearest the station, vessels, APRS, mesh, aids. */
export function labelPriority(
	it: MapItem,
	opts: { selected: boolean; hovered: boolean; kmFromStation: number },
): number {
	if (opts.selected) return -2
	if (opts.hovered) return -1
	return (
		KIND_PRIORITY[it.kind] +
		(it.kind === "aircraft" ? Math.min(0.99, opts.kmFromStation / 1000) : 0)
	)
}

// ---- texts

const SHIP_TYPES: readonly [number, number, string][] = [
	[20, 29, "Wing in ground"],
	[30, 30, "Fishing"],
	[31, 32, "Towing"],
	[33, 33, "Dredging"],
	[34, 34, "Diving"],
	[35, 35, "Military"],
	[36, 36, "Sailing"],
	[37, 37, "Pleasure craft"],
	[40, 49, "High-speed craft"],
	[50, 50, "Pilot vessel"],
	[51, 51, "Search and rescue"],
	[52, 52, "Tug"],
	[53, 53, "Port tender"],
	[54, 54, "Anti-pollution"],
	[55, 55, "Law enforcement"],
	[58, 58, "Medical transport"],
	[60, 69, "Passenger"],
	[70, 79, "Cargo"],
	[80, 89, "Tanker"],
	[90, 99, "Other"],
]

export function shipTypeText(v: Vessel): string {
	if (v.vesselClass === "aton") return "Aid to navigation"
	if (v.vesselClass === "base-station") return "Base station"
	if (v.vesselClass === "sar") return "SAR aircraft"
	const t = v.shipType
	if (t === null) return v.vesselClass === "B" ? "Class B vessel" : "Vessel"
	return SHIP_TYPES.find(([a, b]) => t >= a && t <= b)?.[2] ?? "Vessel"
}

const NAV_STATUS = [
	"Under way",
	"At anchor",
	"Not under command",
	"Restricted manoeuvrability",
	"Constrained by draught",
	"Moored",
	"Aground",
	"Engaged in fishing",
	"Under way, sailing",
] as const

export function navStatusText(v: Vessel, moving: boolean): string {
	const n = v.navStatus
	if (n !== null && n >= 0 && n < NAV_STATUS.length) return NAV_STATUS[n] ?? "—"
	if (n === 14) return "AIS-SART active"
	return moving ? "Under way" : "Not moving"
}

const AID_TYPES: Readonly<Record<number, string>> = {
	1: "Reference point",
	2: "RACON",
	3: "Fixed structure",
	5: "Light",
	6: "Light with sectors",
	7: "Leading light front",
	8: "Leading light rear",
	9: "North cardinal",
	10: "East cardinal",
	11: "South cardinal",
	12: "West cardinal",
	13: "Port hand",
	14: "Starboard hand",
	19: "Isolated danger",
	20: "Safe water",
	21: "Special mark",
	22: "North cardinal buoy",
	23: "East cardinal buoy",
	24: "South cardinal buoy",
	25: "West cardinal buoy",
	26: "Port hand buoy",
	27: "Starboard hand buoy",
	30: "Safe water buoy",
	31: "Special mark buoy",
}

export function aidTypeText(v: Vessel): string {
	const t = v.aton?.aidType
	const name =
		t !== null && t !== undefined
			? (AID_TYPES[t] ?? "Aid to navigation")
			: "Aid to navigation"
	return v.aton?.virtual ? `${name} (virtual)` : name
}

const APRS_SYMBOLS: Readonly<Record<string, string>> = {
	"/>": "Mobile",
	"/k": "Truck",
	"/v": "Van",
	"/_": "Weather station",
	"\\_": "Weather station",
	"/#": "Digipeater",
	"\\#": "Digipeater",
	"/-": "Home station",
	"/[": "Handheld",
	"/O": "Balloon",
	"/'": "Aircraft",
	"/s": "Boat",
	"/Y": "Yacht",
	"/r": "Repeater",
	"/&": "Gateway",
}

export function aprsTypeText(s: Aprs): string {
	if (isWeather(s)) return "Weather station"
	if (s.kind === "object") return "Object"
	if (s.kind === "item") return "Item"
	return (s.symbol ? APRS_SYMBOLS[s.symbol] : undefined) ?? "Station"
}

/** Hover line: what it is and how it moves. */
export function describe(it: MapItem): string {
	const s = it.source
	switch (s.kind) {
		case "aircraft":
			return [
				it.altFt !== null ? flText(it.altFt) : null,
				it.speedKn !== null ? speedText(it.speedKn) : null,
			]
				.filter(Boolean)
				.join(" · ")
		case "vessel":
			return it.kind === "aton"
				? aidTypeText(s.value)
				: `${shipTypeText(s.value)} · ${speedText(it.moving && it.speedKn !== null ? it.speedKn : 0, { digits: 1 })}`
		case "aprs":
			return aprsTypeText(s.value)
		case "mesh":
			return `Mesh node ${s.value.nodeId}`
	}
}

/** "just now" under the item's floor, then seconds, minutes, hours. */
export function agoText(ageMs: number, floorMs = 1000): string {
	if (ageMs < floorMs) return "just now"
	const s = Math.round(ageMs / 1000)
	if (s < 60) return `${s} s ago`
	const m = Math.round(s / 60)
	if (m < 60) return `${m} min ago`
	return `${Math.round(m / 60)} h ago`
}

// ---- the selection panel

export interface SelectionInfo {
	readonly title: string
	readonly sub: string
	/** A message or comment shown above the fields. */
	readonly note: string | null
	readonly fields: readonly (readonly [string, string])[]
	/** Source decoder, freshness and the position. */
	readonly seen: string
}

const feet = (ft: number) => altitudeText(ft)
const MPH_KN = 1.609344 / 1.852
const c1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

export function selectionInfo(
	it: MapItem,
	station: LatLon | null,
	now: number,
): SelectionInfo {
	const p = predict(it, now)
	const rel = station ? relativeText(station, p) : "—"
	const ll = `${fmtLat(p.lat)} ${fmtLon(p.lon)}`
	const ago = agoText(now - it.heardAt, FRESHNESS_FLOOR_MS[it.kind])
	const s = it.source
	switch (s.kind) {
		case "aircraft": {
			const a = s.value
			const vs = a.altitude?.baroRate ?? a.altitude?.geomRate
			const id = a.identification
			return {
				title: it.name,
				sub: [
					id?.typeDescription ?? id?.typeCode,
					`ICAO ${a.icao}`,
					id?.registration,
					id?.operator,
				]
					.filter(Boolean)
					.join(" · "),
				note:
					a.emergency && a.emergency !== "none"
						? `Emergency: ${a.emergency}`
						: null,
				fields: [
					[
						"Altitude",
						a.altitude?.onGround
							? "On ground"
							: it.altFt !== null
								? feet(it.altFt)
								: "—",
					],
					[
						"Vertical",
						vs === undefined
							? "—"
							: vs > 64
								? `↑ ${climbText(vs)}`
								: vs < -64
									? `↓ ${climbText(-vs)}`
									: "Level",
					],
					["Speed", it.speedKn !== null ? speedText(it.speedKn) : "—"],
					["Track", it.course !== null ? `${Math.round(it.course)}°` : "—"],
					["Squawk", a.squawk ?? "—"],
					["From station", rel],
					[
						"Signal",
						a.signalQuality?.rssi !== undefined
							? `${c1(a.signalQuality.rssi)} dBFS`
							: "—",
					],
					["Messages", String(a.messages)],
				],
				seen: `ADS-B · readsb · last message ${ago} · ${ll}`,
			}
		}
		case "vessel": {
			const v = s.value
			const via = `AIS · ${v.decoderId} · last report ${ago} · ${ll}`
			if (it.kind === "aton")
				return {
					title: it.name,
					sub: `${aidTypeText(v)} · MMSI ${v.mmsi}`,
					note: null,
					fields: [
						["Type", aidTypeText(v)],
						["From station", rel],
						[
							"Status",
							v.aton?.offPosition
								? "Off position"
								: v.aton?.offPosition === false
									? "On station"
									: "—",
						],
						["Report", "AIS type 21"],
					],
					seen: via,
				}
			return {
				title: it.name,
				sub: [shipTypeText(v), `MMSI ${v.mmsi}`, v.callsign]
					.filter(Boolean)
					.join(" · "),
				note: null,
				fields: [
					[
						"Speed",
						speedText(it.moving && it.speedKn !== null ? it.speedKn : 0, {
							digits: 1,
						}),
					],
					[
						"Course",
						it.moving && it.course !== null ? `${Math.round(it.course)}°` : "—",
					],
					["Status", navStatusText(v, it.moving)],
					["Destination", v.destination ?? "—"],
					["From station", rel],
					["Channel", v.channel ? `AIS ${v.channel}` : "—"],
				],
				seen: via,
			}
		}
		case "aprs": {
			const a = s.value
			const w = a.weather
			const fields: [string, string][] = w
				? [
						[
							"Temperature",
							w.temperatureF !== null
								? temperatureText(((w.temperatureF - 32) * 5) / 9)
								: "—",
						],
						[
							"Humidity",
							w.humidityPct !== null ? `${Math.round(w.humidityPct)} %` : "—",
						],
						[
							"Wind",
							w.windSpeedMph !== null
								? `${speedText(w.windSpeedMph * MPH_KN)}${w.windDirectionDeg !== null ? ` from ${Math.round(w.windDirectionDeg)}°` : ""}`
								: "—",
						],
						[
							"Pressure",
							w.pressureMbar !== null ? `${c1(w.pressureMbar)} hPa` : "—",
						],
						["From station", rel],
						["Packets", String(a.packetCount)],
					]
				: [
						[
							"Speed",
							it.moving && it.speedKn !== null
								? speedText(it.speedKn)
								: "Fixed",
						],
						[
							"Course",
							it.moving && it.course !== null
								? `${Math.round(it.course)}°`
								: "—",
						],
						["From station", rel],
						[
							"Altitude",
							a.altitudeFt !== null ? altitudeText(a.altitudeFt) : "—",
						],
					]
			return {
				title: it.name,
				sub: `${aprsTypeText(a)} · ${a.path.length > 0 ? `via ${a.path.join(", ")}` : "heard direct"}`,
				note: a.comment ?? a.status,
				fields,
				seen: `APRS · ${a.decoderId} · last packet ${ago} · ${ll}`,
			}
		}
		case "mesh": {
			const m = s.value
			const links = m.neighbours ?? []
			const snrs = links
				.map(l => l.snrDb)
				.filter((x): x is number => x !== null)
			const t = m.telemetry
			return {
				title: it.name,
				sub: [`Meshtastic node ${m.nodeId}`, m.shortName]
					.filter(Boolean)
					.join(" · "),
				note: null,
				fields: [
					["From station", rel],
					["Links", String(links.length)],
					["Best SNR", snrs.length > 0 ? `${c1(Math.max(...snrs))} dB` : "—"],
					[
						"Battery",
						t?.powered
							? "Powered"
							: t?.batteryPct !== null && t?.batteryPct !== undefined
								? `${Math.round(t.batteryPct)} %`
								: "—",
					],
					["Hops", m.hopsAway !== null ? String(m.hopsAway) : "—"],
					["Signal", m.snrDb !== null ? `${c1(m.snrDb)} dB SNR` : "—"],
				],
				seen: `Meshtastic · ${m.decoderId} · last heard ${ago} · ${ll}`,
			}
		}
	}
}

/** The Activity search for an item (the existing search tokens: ICAO, MMSI, or the entity key). */
export function activityTokenOf(it: MapItem): SearchToken {
	const s = it.source
	switch (s.kind) {
		case "aircraft":
			return token("icao", s.value.icao)
		case "vessel":
			return token("mmsi", s.value.mmsi)
		case "aprs":
			return token("entity", s.value.key, {
				label: s.value.name ?? s.value.callsign,
			})
		case "mesh":
			return token("entity", s.value.key, { label: it.name })
	}
}

// ---- the station

export type StationLocation =
	| { readonly kind: "set"; readonly lat: number; readonly lon: number }
	| { readonly kind: "approximate"; readonly lat: number; readonly lon: number }
	| { readonly kind: "none" }

const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b)
	const m = Math.floor(s.length / 2)
	return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

/**
 * The configured location, else an estimate from what is received (the median of the positions heard; vessels,
 * APRS and mesh first since they are closer than aircraft), shown as approximate.
 */
export function stationOf(
	configured: { lat: number | null; lon: number | null } | null,
	items: readonly MapItem[],
): StationLocation {
	if (configured && configured.lat !== null && configured.lon !== null)
		return { kind: "set", lat: configured.lat, lon: configured.lon }
	const near = items.filter(i => i.kind !== "aircraft")
	const pool = near.length >= 3 ? near : items
	if (pool.length === 0) return { kind: "none" }
	return {
		kind: "approximate",
		lat: median(pool.map(i => i.lat)),
		lon: median(pool.map(i => i.lon)),
	}
}

/** Mesh links between nodes that both have a position, each once, by SNR. */
export function meshLinks(
	items: readonly MapItem[],
): { a: MapItem; b: MapItem; snr: number | null }[] {
	const nodes = new Map<string, MapItem>()
	for (const it of items)
		if (it.source.kind === "mesh") nodes.set(it.source.value.nodeId, it)
	const seen = new Set<string>()
	const out: { a: MapItem; b: MapItem; snr: number | null }[] = []
	for (const it of nodes.values()) {
		if (it.source.kind !== "mesh") continue
		for (const n of it.source.value.neighbours ?? []) {
			const other = nodes.get(n.nodeId)
			if (!other || other === it) continue
			const k = [it.id, other.id].sort().join("|")
			if (seen.has(k)) continue
			seen.add(k)
			out.push({ a: it, b: other, snr: n.snrDb })
		}
	}
	return out
}

/** Items within `km` of the station (aircraft beyond the receiver's plausible range are dropped). */
export function withinRange(
	items: readonly MapItem[],
	station: LatLon | null,
	km = 500,
): MapItem[] {
	if (!station) return [...items]
	return items.filter(i => distanceKm(station, i) <= km)
}
