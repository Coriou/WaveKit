/**
 * Map fleets for the mock (the Map board's Brittany traffic, docs/web/canvas/Map.dc.html): the core's
 * current-state routes with their shapes and error bodies, the `aircraft`, `vessels`, `aprs` and `mesh`
 * channels, and GET /api/coverage around the station (Roscoff by default, from the Settings mock).
 *
 * - Aircraft fly straight lines through the board's positions and wrap after ±260 km (a wrap is a
 *   `aircraft:lost` then `aircraft:new`, as when a real track times out and comes back). Updates every
 *   second, unthrottled like the core's aircraft channel; `trackHistory` (most recent first) like the
 *   core's tracker keeps.
 * - Vessels shuttle on the board's checked legs: ferries and the Batz shuttle leave a real berth, sit
 *   there before departing and turn round at the far end; the rest go back and forth on the leg they
 *   sailed in the board's last hour. tests/mock/map.test.ts checks every leg against the coastline.
 * - Vessel, APRS and mesh updates go through a 2 s per-entity limit, as the core's EntityUpdateThrottle.
 * - Mesh nodes carry NEIGHBORINFO links with SNR and device telemetry; APRS includes a weather station
 *   and a balloon. Aids to navigation are vessel class `aton` with their type 21 fields.
 */
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type {
	AircraftIdentification,
	AircraftIdentifier,
	AircraftIdentifierKind,
	AircraftIdentityLink,
	AircraftIdentityResponse,
	AircraftState,
	AircraftTrackerStats,
	AprsStation,
	ActivityTrail,
	ActivityTrailPoint,
	ActivityTrails,
	AprsTrackerStats,
	CoverageProtocolSummary,
	CoverageResponse,
	MeshNode,
	MeshTrackerStats,
	VesselClass,
	VesselState,
	VesselTrackerStats,
} from "@wavekit/api-types"

/** PUT /api/aircraft/info body, as strict as the core's. */
const infoUpdateBody = z.object({ online: z.boolean() }).strict()

// ---- aircraft identity (GET /api/aircraft-identity/:kind/:value, as the core's registry)

const HOUR_MS = 3_600_000
/** As the core's LINK_LIFETIME_MS: an address and its registration for weeks, a callsign for one flight. */
const MOCK_LINK_LIFETIME_MS: Readonly<Record<string, number>> = {
	"icao|reg": 30 * 24 * HOUR_MS,
	"callsign|icao": 2 * HOUR_MS,
	"flight|icao": 6 * HOUR_MS,
	"flight|reg": 6 * HOUR_MS,
}

interface MockLink {
	readonly a: AircraftIdentifier
	readonly b: AircraftIdentifier
	readonly evidence: AircraftIdentityLink["evidence"]
	readonly source: AircraftIdentityLink["source"]
	/** How long before the request it was last seen. */
	readonly agoMs: number
}

/** The query in the core's canonical form, or null when the value cannot be one of that kind. */
export function mockIdentifier(
	kind: string,
	value: string,
): AircraftIdentifier | null {
	if (value.length < 1 || value.length > 16) return null
	const v = value.trim().toUpperCase()
	if (kind === "icao")
		return /^[0-9A-F]{6}$/.test(v) ? { kind, value: v } : null
	if (kind === "reg") {
		const reg = v.replace(/\./g, "")
		return /^[A-Z0-9-]{2,10}$/.test(reg) ? { kind, value: reg } : null
	}
	if (kind === "callsign" || kind === "flight")
		return /^[A-Z0-9]{2,8}$/.test(v) ? { kind, value: v } : null
	return null
}

/**
 * The mock's links: each mock aircraft's registration from the database and its callsign heard on ADS-B,
 * plus a fictional registration heard with two addresses (a conflict).
 */
export function mockIdentityLinks(list: readonly MockAircraft[]): MockLink[] {
	const links: MockLink[] = []
	for (const a of list) {
		const icao = { kind: "icao", value: a.icao } as const
		if (a.registration)
			links.push({
				a: icao,
				b: { kind: "reg", value: a.registration },
				evidence: "database",
				source: "database",
				agoMs: 60_000,
			})
		links.push({
			a: { kind: "callsign", value: a.callsign },
			b: icao,
			evidence: "observed",
			source: "adsb",
			agoMs: 5_000,
		})
	}
	for (const value of ["0A0B01", "0A0B02"])
		links.push({
			a: { kind: "icao", value },
			b: { kind: "reg", value: "N0WK01" },
			evidence: "observed",
			source: "vdl2",
			agoMs: 120_000,
		})
	return links
}

const idKey = (id: AircraftIdentifier) => `${id.kind}:${id.value}`
const pairKey = (a: AircraftIdentifierKind, b: AircraftIdentifierKind) =>
	a <= b ? `${a}|${b}` : `${b}|${a}`

/** What the core's registry answers for `query` over `links` (observed beats database; conflicts resolve to nothing). */
export function mockIdentity(
	links: readonly MockLink[],
	query: AircraftIdentifier,
	at: number,
): AircraftIdentityResponse {
	const touching = (key: string) =>
		links.filter(l => idKey(l.a) === key || idKey(l.b) === key)
	const other = (l: MockLink, key: string) => (idKey(l.a) === key ? l.b : l.a)
	const owner = (reg: string) => {
		for (const level of ["observed", "database"] as const) {
			const found = new Set(
				touching(reg)
					.filter(l => l.evidence === level)
					.map(l => other(l, reg))
					.filter(id => id.kind === "icao")
					.map(id => id.value),
			)
			if (found.size > 1)
				return { icao: null, resolvedBy: null, conflict: true } as const
			const icao = [...found][0]
			if (icao !== undefined)
				return { icao, resolvedBy: level, conflict: false } as const
		}
		return { icao: null, resolvedBy: null, conflict: false } as const
	}
	const resolved =
		query.kind === "icao"
			? ({ icao: query.value, resolvedBy: "self", conflict: false } as const)
			: query.kind === "reg"
				? owner(idKey(query))
				: ({ icao: null, resolvedBy: null, conflict: false } as const)
	const around = new Set<MockLink>(touching(idKey(query)))
	if (resolved.icao !== null)
		for (const l of touching(`icao:${resolved.icao}`)) around.add(l)
	const entityKeys = new Set<string>()
	if (resolved.icao !== null) entityKeys.add(`icao:${resolved.icao}`)
	if (query.kind === "reg") entityKeys.add(idKey(query))
	if (resolved.icao !== null)
		for (const l of touching(`icao:${resolved.icao}`)) {
			const id = other(l, `icao:${resolved.icao}`)
			if (
				l.evidence !== "hint" &&
				id.kind === "reg" &&
				owner(idKey(id)).icao === resolved.icao
			)
				entityKeys.add(idKey(id))
		}
	const iso = (ms: number) => new Date(ms).toISOString()
	return {
		query,
		...resolved,
		links: [...around]
			.sort((x, y) => x.agoMs - y.agoMs)
			.map(l => {
				const last = at - l.agoMs
				return {
					a: l.a,
					b: l.b,
					evidence: l.evidence,
					source: l.source,
					firstSeen: iso(last - 600_000),
					lastSeen: iso(last),
					expiresAt: iso(
						last +
							(MOCK_LINK_LIFETIME_MS[pairKey(l.a.kind, l.b.kind)] ??
								2 * HOUR_MS),
					),
					count: 3,
				}
			}),
		entityKeys: [...entityKeys],
		timestamp: at,
	}
}

// ---- geodesy (as the board)

const R_KM = 6371
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export type LatLon = readonly [number, number]

export function dest(p: LatLon, brg: number, km: number): [number, number] {
	const d = km / R_KM
	const b = rad(brg)
	const p1 = rad(p[0])
	const l1 = rad(p[1])
	const p2 = Math.asin(
		Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
	)
	const l2 =
		l1 +
		Math.atan2(
			Math.sin(b) * Math.sin(d) * Math.cos(p1),
			Math.cos(d) - Math.sin(p1) * Math.sin(p2),
		)
	return [deg(p2), deg(l2)]
}

export function distKm(a: LatLon, b: LatLon): number {
	const dp = rad(b[0] - a[0])
	const dl = rad(b[1] - a[1])
	const h =
		Math.sin(dp / 2) ** 2 +
		Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dl / 2) ** 2
	return 2 * R_KM * Math.asin(Math.sqrt(h))
}

export function bearingDeg(a: LatLon, b: LatLon): number {
	const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]))
	const x =
		Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
		Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]))
	return (deg(Math.atan2(y, x)) + 360) % 360
}

function rng(seed: number): () => number {
	let s = seed
	return () => (s = (s * 16807) % 2147483647) / 2147483647
}

const KN_KMS = 1.852 / 3600

// ---- the board's places

export const ROSCOFF: LatLon = [48.7051, -3.975]
const BLOSCON: LatLon = [48.7262, -3.964]
const ROSCOFF_PIER: LatLon = [48.7292, -3.987]
const VIEUX_PORT: LatLon = [48.7275, -3.98]
const BATZ_SLIP: LatLon = [48.7395, -4.004]

// ---- aircraft

export interface MockAircraft {
	readonly icao: string
	readonly callsign: string
	readonly type: string
	readonly lat: number
	readonly lon: number
	readonly trk: number
	readonly kn: number
	readonly ft: number
	readonly vs: number
	readonly squawk: string
	readonly rssi: number
	readonly msgs: number
	readonly registration?: string
	readonly operator?: string
	/** The core's enrichment (docs/ADSB.md "Aircraft Enrichment") beyond registration and operator. */
	readonly details?: Omit<
		AircraftIdentification,
		"registration" | "operator" | "typeCode" | "source"
	>
}

/** A drawn stand-in for an airframe photo (the mock never reaches Planespotters). */
function mockPhoto(sky: string, ground: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="300" height="116" fill="${sky}"/><rect y="116" width="300" height="84" fill="${ground}"/><path d="M40 112 L210 104 Q236 103 252 110 Q258 114 250 118 L214 124 L60 126 Z M118 108 L160 70 L176 70 L156 108 Z M120 124 L150 150 L166 150 L152 124 Z M46 112 L36 92 L48 92 L66 110 Z" fill="#eef2f6"/></svg>`
	return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const airport = (
	icao: string,
	iata: string,
	name: string,
	city: string,
	lat: number,
	lon: number,
) => ({ icao, iata, name, city, country: "France", countryIso: "FR", lat, lon })

/** The board's 34 aircraft (seeded): three named ones and 31 on the airways around the station. */
export function makeAircraft(): MockAircraft[] {
	const r = rng(20261010)
	const out: MockAircraft[] = [
		{
			icao: "3944EF",
			callsign: "AFR1234",
			type: "A320",
			lat: 48.81,
			lon: -3.87,
			trk: 284,
			kn: 452,
			ft: 36000,
			vs: 0,
			squawk: "4721",
			rssi: -12.4,
			msgs: 1834,
			registration: "F-HBNA",
			operator: "Air France",
			details: {
				typeDescription: "A320 214",
				manufacturer: "Airbus",
				country: "France",
				countryIso: "FR",
				year: 2010,
				airline: {
					name: "Air France",
					icao: "AFR",
					iata: "AF",
					callsign: "AIRFRANS",
					source: "adsbdb",
				},
				route: {
					callsign: "AFR1234",
					origin: airport(
						"LFPG",
						"CDG",
						"Paris Charles de Gaulle",
						"Paris",
						49.0128,
						2.55,
					),
					destination: {
						icao: "KJFK",
						iata: "JFK",
						name: "John F Kennedy International Airport",
						city: "New York",
						country: "United States",
						countryIso: "US",
						lat: 40.6398,
						lon: -73.7789,
					},
					source: "adsbdb",
					plausible: true,
				},
				photo: {
					thumbnailUrl: mockPhoto("#5d7ea6", "#6f7a68"),
					photographer: "Mock photographer",
					link: "https://www.planespotters.net/",
					source: "planespotters",
				},
			},
		},
		{
			icao: "3949F2",
			callsign: "HOP47MJ",
			type: "E145",
			lat: 48.52,
			lon: -3.81,
			trk: 52,
			kn: 286,
			ft: 11250,
			vs: 1800,
			squawk: "6215",
			rssi: -9.8,
			msgs: 612,
			registration: "F-GRGJ",
			operator: "HOP!",
			details: {
				typeDescription: "ERJ-145EU",
				manufacturer: "Embraer",
				country: "France",
				countryIso: "FR",
				year: 2000,
				airline: { name: "HOP!", icao: "HOP", iata: "A5", source: "local" },
				route: {
					callsign: "HOP47MJ",
					origin: airport(
						"LFRB",
						"BES",
						"Brest Bretagne Airport",
						"Brest",
						48.4479,
						-4.4185,
					),
					destination: airport(
						"LFPO",
						"ORY",
						"Paris-Orly Airport",
						"Paris",
						48.7233,
						2.3794,
					),
					source: "adsbdb",
					plausible: true,
				},
			},
		},
		{
			icao: "3B7FA2",
			callsign: "FNY03",
			type: "RFAL",
			lat: 48.56,
			lon: -4.15,
			trk: 75,
			kn: 330,
			ft: 3500,
			vs: 0,
			squawk: "7000",
			rssi: -7.1,
			msgs: 220,
			operator: "French Navy",
			details: {
				typeDescription: "Dassault Rafale M",
				country: "France",
				countryIso: "FR",
				flags: { military: true },
			},
		},
	]
	const PFX = [
		"AFR",
		"EZY",
		"BAW",
		"RYR",
		"KLM",
		"DLH",
		"TOM",
		"IBE",
		"VLG",
		"EXS",
		"TAP",
		"SWR",
		"AEA",
		"HOP",
	]
	const TYPES = [
		"A320",
		"A319",
		"A321",
		"B738",
		"B38M",
		"A20N",
		"E190",
		"A333",
		"B789",
		"AT76",
		"CRJ9",
		"A359",
	]
	const AIRWAYS = [32, 212, 8, 188, 62, 242, 300, 120, 350, 170]
	for (let i = 0; i < 31; i++) {
		const b = r() * 360
		const d = 25 + Math.pow(r(), 0.8) * 255
		const [lat, lon] = dest(ROSCOFF, b, d)
		const trk =
			((AIRWAYS[Math.floor(r() * AIRWAYS.length)] ?? 0) +
				(r() - 0.5) * 16 +
				360) %
			360
		const low = r() < 0.18
		const ft = low
			? Math.round((3000 + r() * 12000) / 250) * 250
			: Math.round((22000 + r() * 18000) / 1000) * 1000
		const pfx = PFX[Math.floor(r() * PFX.length)] ?? "AFR"
		const callsign = pfx + Math.floor(100 + r() * 8900)
		const type = TYPES[Math.floor(r() * TYPES.length)] ?? "A320"
		const icao = Math.floor(r() * 0xffffff)
			.toString(16)
			.toUpperCase()
			.padStart(6, "0")
		const kn = Math.round(low ? 230 + r() * 90 : 410 + r() * 80)
		const vs = low ? (r() < 0.5 ? 1400 : -1100) : 0
		const squawk = String(Math.floor(r() * 7777))
			.padStart(4, "0")
			.replace(/[89]/g, "7")
		const rssi = -(6 + r() * 22)
		const msgs = Math.floor(80 + r() * 1800)
		out.push({
			icao,
			callsign,
			type,
			lat,
			lon,
			trk,
			kn,
			ft,
			vs,
			squawk,
			rssi,
			msgs,
		})
	}
	return out
}

/** Half the length of an aircraft's line: past it the aircraft wraps to the other end. */
const AIR_HALF_KM = 260

/** Where an aircraft is `t` seconds after the mock started, and which lap of its line it is on. */
export function aircraftAt(
	a: MockAircraft,
	t: number,
): { lat: number; lon: number; lap: number } {
	const along = a.kn * KN_KMS * t + AIR_HALF_KM * 0.15
	const lap = Math.floor((along + AIR_HALF_KM) / (2 * AIR_HALF_KM))
	const s = along - lap * 2 * AIR_HALF_KM
	const [lat, lon] = dest([a.lat, a.lon], a.trk, s)
	return { lat, lon, lap }
}

// ---- vessels

export interface MockVessel {
	readonly mmsi: string
	readonly name: string
	readonly callsign: string
	readonly vesselClass: VesselClass
	/** ITU-R M.1371 ship type. */
	readonly shipType: number | null
	readonly destination: string | null
	/** Navigation status while under way (moored is 5). */
	readonly underWay: number
	readonly kn: number
	/** The leg: from A to B. A is a berth when `dwellS` > 0. */
	readonly a: LatLon
	readonly b: LatLon
	/** Seconds at each berth before leaving (0: turn round at once). */
	readonly dwellS: number
	/** Seconds into the cycle at mock start. */
	readonly phaseS: number
	readonly aton?: { aidType: number; virtual: boolean }
	readonly channel: "A" | "B"
}

const behind = (p: LatLon, course: number, kn: number, s: number): LatLon =>
	dest(p, (course + 180) % 360, kn * KN_KMS * s)

/** The board's vessels: [name, MMSI, ship type, lat, lon, course, kn, nav status, destination, from, to]. */
export function makeVessels(): MockVessel[] {
	type Row = readonly [
		string,
		number,
		number | null,
		number,
		number,
		number,
		number,
		number,
		string | null,
		LatLon?,
		LatLon?,
	]
	const V: readonly Row[] = [
		[
			"Kerlouan",
			227006760,
			30,
			48.742,
			-4.075,
			0,
			9.4,
			0,
			"Fishing grounds",
			VIEUX_PORT,
		],
		["Belle Étoile", 228237700, 60, 48.7183, -3.9661, 0, 0, 5, "Roscoff"],
		["Ker Avel", 227419000, 69, 48.95, -4.0, 0, 21.0, 0, "Plymouth", BLOSCON],
		["Morgane II", 227592820, 30, 48.8, -3.75, 60, 6.8, 7, null],
		["Ar Vro", 227141500, 70, 48.9, -3.6, 102, 14.0, 0, "Saint-Malo"],
		["Pilot 29", 227000290, 50, 48.8, -3.985, 0, 18.2, 0, "Ker Avel", BLOSCON],
		[
			"Enez Vaz",
			227300410,
			60,
			48.735,
			-3.9965,
			0,
			8.0,
			0,
			"Île de Batz",
			ROSCOFF_PIER,
			BATZ_SLIP,
		],
		["Penn ar Bed", 227877100, 36, 48.82, -4.15, 250, 5.5, 8, "Aber Wrac’h"],
		["Sant Erwan", 227663300, 30, 48.85, -3.9, 180, 3.1, 7, null],
		["SNS 061", 227004610, 51, 48.722, -3.945, 0, 0, 5, null],
		["Nordic Star", 255806200, 70, 49.05, -3.7, 75, 13.0, 0, "Antwerp"],
		["Atlantic Breeze", 538009100, 80, 49.1, -4.3, 250, 12.0, 0, "Lisbon"],
		["Ty Gwenn", 227551900, 30, 48.78, -4.25, 200, 2.2, 7, null],
	]
	const out: MockVessel[] = V.map(
		(
			[
				name,
				mmsi,
				shipType,
				lat,
				lon,
				course,
				kn,
				status,
				destination,
				from,
				to,
			],
			i,
		) => {
			const here: LatLon = [lat, lon]
			const common = {
				mmsi: String(mmsi).padStart(9, "0"),
				name,
				callsign: `FA${(4000 + i * 37).toString(36).toUpperCase()}`,
				vesselClass: (shipType === 36 || shipType === 30
					? "B"
					: "A") as VesselClass,
				shipType,
				destination,
				underWay: status,
				kn,
				channel: (mmsi % 2 ? "A" : "B") as "A" | "B",
			}
			if (kn === 0) return { ...common, a: here, b: here, dwellS: 0, phaseS: 0 }
			if (from) {
				// leaves the berth, sails to `to` (or to where the board saw it) and back; at the board's position at start
				const b = to ?? here
				const legS = distKm(from, b) / (kn * KN_KMS)
				const dwellS = 300
				const alongS = Math.min(legS, distKm(from, here) / (kn * KN_KMS))
				return { ...common, a: from, b, dwellS, phaseS: dwellS + alongS }
			}
			// back and forth on the leg it sailed in the board's last hour, heading `course` at start
			const legS = 3600
			return {
				...common,
				a: behind(here, course, kn, legS),
				b: here,
				dwellS: 0,
				phaseS: legS * 0.98,
			}
		},
	)
	out.push(
		{
			mmsi: "992271001",
			name: "Phare de l’île de Batz",
			callsign: "",
			vesselClass: "aton",
			shipType: null,
			destination: null,
			underWay: 15,
			kn: 0,
			a: [48.7469, -4.0283],
			b: [48.7469, -4.0283],
			dwellS: 0,
			phaseS: 0,
			aton: { aidType: 5, virtual: false },
			channel: "A",
		},
		{
			mmsi: "992271014",
			name: "Men Guen Bras",
			callsign: "",
			vesselClass: "aton",
			shipType: null,
			destination: null,
			underWay: 15,
			kn: 0,
			a: [48.765, -3.958],
			b: [48.765, -3.958],
			dwellS: 0,
			phaseS: 0,
			aton: { aidType: 9, virtual: true },
			channel: "B",
		},
	)
	return out
}

export interface VesselFix {
	lat: number
	lon: number
	/** Course over ground, null when not moving. */
	cog: number | null
	sog: number
	moored: boolean
}

/** A vessel `t` seconds after the mock started: dwell at A, sail to B, dwell (if a berth), sail back. */
export function vesselAt(v: MockVessel, t: number): VesselFix {
	if (v.kn === 0)
		return { lat: v.a[0], lon: v.a[1], cog: null, sog: 0, moored: true }
	const legKm = distKm(v.a, v.b)
	const legS = legKm / (v.kn * KN_KMS)
	const cycle = 2 * (v.dwellS + legS)
	const c = (((v.phaseS + t) % cycle) + cycle) % cycle
	const at = (from: LatLon, to: LatLon, s: number): VesselFix => {
		const course = bearingDeg(from, to)
		const [lat, lon] = dest(from, course, v.kn * KN_KMS * s)
		return {
			lat,
			lon,
			cog: Math.round(course * 10) / 10,
			sog: v.kn,
			moored: false,
		}
	}
	const still = (p: LatLon): VesselFix => ({
		lat: p[0],
		lon: p[1],
		cog: null,
		sog: 0,
		moored: v.dwellS > 0,
	})
	if (c < v.dwellS) return still(v.a)
	if (c < v.dwellS + legS) return at(v.a, v.b, c - v.dwellS)
	if (c < 2 * v.dwellS + legS) return still(v.b)
	return at(v.b, v.a, c - 2 * v.dwellS - legS)
}

// ---- APRS

export interface MockAprs {
	readonly callsign: string
	readonly symbol: string
	readonly comment: string
	readonly path: readonly string[]
	readonly a: LatLon
	readonly course: number
	readonly kn: number
	readonly altitudeFt: number | null
	readonly weather: boolean
	readonly everyS: number
}

export function makeAprs(): MockAprs[] {
	const row = (
		callsign: string,
		symbol: string,
		lat: number,
		lon: number,
		course: number,
		kn: number,
		comment: string,
		path: string,
		everyS: number,
		altitudeFt: number | null = null,
		weather = false,
	): MockAprs => ({
		callsign,
		symbol,
		comment,
		path: path === "direct" ? [] : path.split(", "),
		a: [lat, lon],
		course,
		kn,
		altitudeFt,
		weather,
		everyS,
	})
	return [
		row(
			"F4ABC-9",
			"/>",
			48.3904,
			-4.4861,
			112,
			52 / 1.852,
			"On the way home. QRV 145.500",
			"WIDE1-1, WIDE2-1",
			30,
		),
		row(
			"F6XYZ-13",
			"/_",
			48.58,
			-3.83,
			0,
			0,
			"Davis Vantage Pro2",
			"direct",
			120,
			null,
			true,
		),
		row(
			"F1ZZZ-1",
			"/#",
			48.41,
			-3.93,
			0,
			0,
			"Monts d’Arrée digi · 145.6375 rptr",
			"direct",
			600,
		),
		row(
			"F4KLM",
			"/-",
			48.62,
			-4.35,
			0,
			0,
			"Shack online, 2 m and 70 cm",
			"F1ZZZ-1*",
			600,
		),
		row(
			"F5XYZ-7",
			"/[",
			48.73,
			-3.46,
			210,
			1.6,
			"Walking the coast path",
			"WIDE1-1",
			60,
		),
		row(
			"F4BLN-11",
			"/O",
			48.95,
			-3.2,
			70,
			24,
			"Alt 18 240 m · climbing 4.8 m/s",
			"WIDE2-1",
			30,
			59_843,
		),
	]
}

/** Moving stations go back and forth over the hour before the board's position. */
export function aprsAt(s: MockAprs, t: number): { lat: number; lon: number } {
	if (s.kn === 0) return { lat: s.a[0], lon: s.a[1] }
	const legKm = s.kn * 1.852
	const start = behind(s.a, s.course, s.kn, 3600)
	const c = (((t + 3500) % 7200) + 7200) % 7200
	const along = c < 3600 ? (c / 3600) * legKm : (1 - (c - 3600) / 3600) * legKm
	const [lat, lon] = dest(start, s.course, along)
	return { lat, lon }
}

// ---- mesh

export interface MockMesh {
	readonly nodeId: string
	readonly longName: string
	readonly shortName: string
	readonly role: number
	readonly a: LatLon
	readonly course: number
	readonly kn: number
	readonly batteryPct: number | null
	readonly comment: string
}

export function makeMesh(): MockMesh[] {
	return [
		{
			nodeId: "!a3f2c1d4",
			longName: "Harbour relay",
			shortName: "HRBR",
			role: 2,
			a: [48.727, -3.987],
			course: 0,
			kn: 0,
			batteryPct: null,
			comment:
				"Anyone on the coast tonight? Signal is great from the lighthouse.",
		},
		{
			nodeId: "!9be011a7",
			longName: "Lighthouse",
			shortName: "LGHT",
			role: 0,
			a: [48.7469, -4.0283],
			course: 0,
			kn: 0,
			batteryPct: 81,
			comment: "Position beacon",
		},
		{
			nodeId: "!77c0de02",
			longName: "Morlaix node",
			shortName: "MRLX",
			role: 2,
			a: [48.585, -3.84],
			course: 0,
			kn: 0,
			batteryPct: null,
			comment: "Router · 12 neighbours",
		},
		{
			nodeId: "!0fe12a6b",
			longName: "Kayak",
			shortName: "KYK",
			role: 0,
			a: [48.79, -3.95],
			course: 300,
			kn: 2.5,
			batteryPct: 64,
			comment: "Paddling to Batz, back by 18:00",
		},
	]
}

/** NEIGHBORINFO links: [reporting node, neighbour, SNR dB] (the board's). */
export const MESH_LINKS: readonly (readonly [string, string, number])[] = [
	["!a3f2c1d4", "!9be011a7", 9.0],
	["!a3f2c1d4", "!77c0de02", 3.5],
	["!a3f2c1d4", "!0fe12a6b", 6.5],
	["!77c0de02", "!9be011a7", -2.0],
]

export function meshAt(m: MockMesh, t: number): { lat: number; lon: number } {
	if (m.kn === 0) return { lat: m.a[0], lon: m.a[1] }
	const legKm = m.kn * 1.852
	const start = behind(m.a, m.course, m.kn, 3600)
	const c = (((t + 3400) % 7200) + 7200) % 7200
	const along = c < 3600 ? (c / 3600) * legKm : (1 - (c - 3600) / 3600) * legKm
	const [lat, lon] = dest(start, m.course, along)
	return { lat, lon }
}

// ---- coverage (the board's furthest reception per bearing)

export function coverageKm(protocol: "adsb" | "ais", b: number): number {
	if (protocol === "adsb")
		return (
			215 +
			70 * Math.cos(rad(b - 25)) +
			18 * Math.sin(rad(b * 3)) -
			(b > 150 && b < 230 ? 45 : 0)
		)
	const sea = b > 270 || b < 85
	return sea ? 48 + 10 * Math.sin(rad(b * 4)) : 6 + 3 * Math.sin(rad(b * 2))
}

// ---- the routes

export interface MapMockContext {
	broadcast: (channel: string, type: string, data: unknown) => void
	/** The station location (the Settings mock's), null when unset. */
	station: () => { lat: number; lon: number } | null
	now?: () => number
	/** Simulation step, ms. Default 1000. */
	tickMs?: number
	/** Fleet multiplier for load tests (WAVEKIT_MOCK_LOAD): each entity gets `load - 1` seeded copies. Default 1. */
	load?: number
	/** Aircraft updates per aircraft per step, spread over the step (the core sends one per SBS message). Default 1. */
	adsbRate?: number
}

/** `items` plus `load - 1` copies of each, made distinct by `copy(item, k)` (k from 1). */
export function multiplyFleet<T>(
	items: readonly T[],
	load: number,
	copy: (item: T, k: number) => T,
): T[] {
	const n = Math.max(1, Math.floor(load))
	const out = [...items]
	for (let k = 1; k < n; k++) for (const item of items) out.push(copy(item, k))
	return out
}

const hexSuffix = (id: string, k: number): string =>
	(id.slice(0, -2) + (k & 0xff).toString(16).padStart(2, "0")).toUpperCase()

export interface MapMock {
	/** Runs one simulation step now (tests). */
	tick(): void
}

/** Core's per-entity WS limit for vessels, APRS and mesh (EntityUpdateThrottle, WG2 req 9.4). */
const ENTITY_WINDOW_MS = 2000

const HHMM = (ms: number) => new Date(ms).toISOString()

export function registerMapMock(
	app: FastifyInstance,
	ctx: MapMockContext,
): MapMock {
	const now = ctx.now ?? Date.now
	const startedAt = now()
	const t = () => (now() - startedAt) / 1000

	const load = ctx.load ?? 1
	const adsbRate = Math.max(1, Math.floor(ctx.adsbRate ?? 1))
	const aircraft = multiplyFleet(makeAircraft(), load, (a, k) => ({
		...a,
		icao: hexSuffix(a.icao, k),
		callsign: `${a.callsign.slice(0, 5)}${k}`,
		trk: (a.trk + k * 37) % 360,
		lat: a.lat + ((k * 0.13) % 0.9) - 0.45,
		lon: a.lon + ((k * 0.29) % 1.4) - 0.7,
	}))
	const vessels = multiplyFleet(makeVessels(), load, (v, k) => ({
		...v,
		mmsi: `${v.mmsi.slice(0, -2)}${String(k).padStart(2, "0")}`,
		name: `${v.name} ${k}`,
		phaseS: v.phaseS + k * 97,
	}))
	const aprs = multiplyFleet(makeAprs(), load, (s, k) => ({
		...s,
		callsign: `${s.callsign}-${k}`,
		a: [
			s.a[0] + ((k * 0.07) % 0.3) - 0.15,
			s.a[1] + ((k * 0.11) % 0.4) - 0.2,
		] as const,
	}))
	const mesh = multiplyFleet(makeMesh(), load, (m, k) => ({
		...m,
		nodeId: `${m.nodeId.slice(0, -2)}${(k & 0xff).toString(16).padStart(2, "0")}`,
		a: [
			m.a[0] + ((k * 0.05) % 0.2) - 0.1,
			m.a[1] + ((k * 0.09) % 0.3) - 0.15,
		] as const,
	}))

	// per-entity bookkeeping: message counts, first seen, last report, last broadcast
	const firstSeen = new Map<string, number>()
	const counts = new Map<string, number>()
	const lastReport = new Map<string, number>()
	const lastSent = new Map<string, number>()
	const laps = new Map<string, number>()
	const seen = (key: string, at: number) => {
		if (!firstSeen.has(key))
			firstSeen.set(key, at - 20 * 60_000 + (key.length % 7) * 61_000)
		return firstSeen.get(key) ?? at
	}
	const bump = (key: string, at: number) => {
		counts.set(key, (counts.get(key) ?? 0) + 1)
		lastReport.set(key, at)
	}

	// ---- aircraft state
	const aircraftState = (a: MockAircraft, at: number): AircraftState => {
		const ts = (at - startedAt) / 1000
		const here = aircraftAt(a, ts)
		const history: AircraftState["trackHistory"] = []
		for (let k = 0; k < 24; k++) {
			const back = ts - k * 15
			const p = aircraftAt(a, back)
			if (p.lap !== here.lap) break
			history.push({
				lat: p.lat,
				lon: p.lon,
				altitude: a.ft,
				timestamp: Math.round(at - k * 15_000),
			})
		}
		const key = `a:${a.icao}`
		return {
			icao: a.icao,
			callsign: a.callsign,
			squawk: a.squawk,
			messageType: "adsb_icao",
			position: { lat: here.lat, lon: here.lon, nic: 8, rc: 186, seenPos: 0.4 },
			velocity: { gs: a.kn, track: Math.round(a.trk * 10) / 10 },
			altitude: { baro: a.ft, geom: a.ft + 175, baroRate: a.vs },
			identification: {
				typeCode: a.type,
				...(a.registration !== undefined
					? { registration: a.registration }
					: {}),
				...(a.operator !== undefined ? { operator: a.operator } : {}),
				...a.details,
				...(a.details?.photo ? { imageUrl: a.details.photo.thumbnailUrl } : {}),
				source: a.details ? "local" : "readsb",
			},
			signalQuality: { rssi: Math.round(a.rssi * 10) / 10 },
			category: a.type === "AT76" || a.type === "E145" ? "A2" : "A3",
			emergency: "none",
			trackHistory: history,
			seen: 0.2,
			seenPos: 0.4,
			messages: a.msgs + (counts.get(key) ?? 0) * 6,
			firstSeen: seen(key, at),
			lastUpdated: at,
		}
	}

	// ---- vessel state
	const vesselState = (v: MockVessel, at: number): VesselState => {
		const key = `v:${v.mmsi}`
		const reported = lastReport.get(key) ?? at
		const fix = vesselAt(v, (reported - startedAt) / 1000)
		const aton = v.vesselClass === "aton"
		return {
			mmsi: v.mmsi,
			vesselClass: v.vesselClass,
			name: v.name,
			callsign: aton ? null : v.callsign,
			imo:
				aton || v.vesselClass === "B"
					? null
					: 9_100_000 + Number(v.mmsi.slice(-5)),
			shipType: v.shipType,
			destination: v.destination,
			eta: null,
			draught: aton ? null : v.shipType === 70 || v.shipType === 80 ? 7.4 : 2.1,
			position: {
				lat: Math.round(fix.lat * 1e6) / 1e6,
				lon: Math.round(fix.lon * 1e6) / 1e6,
				at: HHMM(reported),
			},
			cog: fix.cog,
			sog: aton ? null : Math.round(fix.sog * 10) / 10,
			heading: fix.cog === null ? null : Math.round(fix.cog),
			navStatus: aton ? null : fix.moored ? 5 : v.underWay,
			messageTypes: aton ? [21] : v.vesselClass === "B" ? [18, 24] : [1, 3, 5],
			messageCount: 40 + (counts.get(key) ?? 0),
			decoderId: "ais-catcher",
			firstSeen: HHMM(seen(key, at)),
			lastSeen: HHMM(reported),
			lastStaticAt: HHMM(seen(key, at) + 60_000),
			channel: v.channel,
			aton: v.aton
				? {
						aidType: v.aton.aidType,
						virtual: v.aton.virtual,
						offPosition: false,
					}
				: null,
			altitudeM: null,
		}
	}

	// ---- APRS state
	const aprsState = (s: MockAprs, at: number): AprsStation => {
		const key = `callsign:${s.callsign}`
		const reported = lastReport.get(key) ?? at
		const p = aprsAt(s, (reported - startedAt) / 1000)
		const minute = (at - startedAt) / 60_000
		return {
			key,
			kind: "station",
			callsign: s.callsign,
			name: null,
			position: {
				lat: Math.round(p.lat * 1e5) / 1e5,
				lon: Math.round(p.lon * 1e5) / 1e5,
				at: HHMM(reported),
			},
			altitudeFt: s.altitudeFt,
			courseDeg: s.kn ? Math.round(s.course) : null,
			speedKn: s.kn ? Math.round(s.kn * 10) / 10 : null,
			symbol: s.symbol,
			comment: s.comment,
			status: null,
			weather: s.weather
				? {
						temperatureF: Math.round((57.6 + Math.sin(minute / 30)) * 10) / 10,
						humidityPct: 78,
						pressureMbar: 1012.4,
						windSpeedMph: 11.2,
						windDirectionDeg: 270,
						rainLastHourIn: 0,
						at: HHMM(reported),
					}
				: null,
			path: [...s.path],
			lastDataType: s.weather ? "weather" : "position",
			killed: false,
			packetCount: 12 + (counts.get(key) ?? 0),
			digipeatedCopies: s.path.length > 0 ? 3 : 0,
			decoderId: "direwolf",
			firstSeen: HHMM(seen(key, at)),
			lastSeen: HHMM(reported),
		}
	}

	// ---- mesh state
	const meshState = (m: MockMesh, at: number): MeshNode => {
		const key = `node:${m.nodeId}`
		const reported = lastReport.get(key) ?? at
		const p = meshAt(m, (reported - startedAt) / 1000)
		const neighbours = MESH_LINKS.filter(l => l[0] === m.nodeId).map(
			([, n, snr]) => ({ nodeId: n, snrDb: snr, at: HHMM(reported) }),
		)
		return {
			nodeId: m.nodeId,
			key,
			nodeNum: parseInt(m.nodeId.slice(1), 16),
			longName: m.longName,
			shortName: m.shortName,
			hwModel: 9,
			role: m.role,
			isLicensed: false,
			position: {
				lat: Math.round(p.lat * 1e5) / 1e5,
				lon: Math.round(p.lon * 1e5) / 1e5,
				altitudeM: m.kn ? 0 : 12,
				at: HHMM(reported),
				fixAt: HHMM(reported - 4000),
			},
			snrDb: 6.25,
			rssiDbm: -97,
			hopsAway: m.role === 2 ? 0 : 1,
			viaMqtt: false,
			packetCount: 30 + (counts.get(key) ?? 0),
			duplicateCopies: 4,
			portnums: {
				"1": 5,
				"3": 12,
				"4": 2,
				"67": 6,
				"71": neighbours.length > 0 ? 3 : 0,
			},
			lastPortnum: 3,
			decoderId: "lora-meshtastic",
			firstSeen: HHMM(seen(key, at)),
			lastSeen: HHMM(reported),
			lastNodeInfoAt: HHMM(seen(key, at) + 30_000),
			telemetry: {
				batteryPct: m.batteryPct,
				powered: m.batteryPct === null,
				voltageV: m.batteryPct === null ? 5.1 : 3.9,
				channelUtilizationPct: 7.5,
				airUtilTxPct: 1.2,
				uptimeS: Math.round(86_400 + (at - startedAt) / 1000),
				at: HHMM(reported),
			},
			neighbours,
		}
	}

	const aircraftStats = (list: AircraftState[]): AircraftTrackerStats => ({
		aircraftCount: list.length,
		withPosition: list.filter(a => a.position).length,
		withCallsign: list.filter(a => a.callsign).length,
		enrichedCount: list.filter(a => a.identification?.registration).length,
		messagesProcessed: list.reduce((n, a) => n + a.messages, 0),
		messagesPerSecond: list.length * 6,
		enrichmentCache: { hits: 12, misses: 3, size: 15 },
	})
	const vesselStats = (list: VesselState[], at: number): VesselTrackerStats => {
		const byClass: Record<VesselClass, number> = {
			A: 0,
			B: 0,
			"base-station": 0,
			aton: 0,
			sar: 0,
			unknown: 0,
		}
		for (const v of list) byClass[v.vesselClass] += 1
		return {
			vesselCount: list.length,
			withPosition: list.filter(v => v.position).length,
			withName: list.filter(v => v.name).length,
			byClass,
			messagesProcessed: list.reduce((n, v) => n + v.messageCount, 0),
			messagesPerSecond: 0.8,
			lastMessageAt: HHMM(at),
			latestMmsi: list[0]?.mmsi ?? null,
			expiredTotal: 0,
			timestamp: HHMM(at),
		}
	}
	const aprsStats = (list: AprsStation[], at: number): AprsTrackerStats => ({
		stationCount: list.length,
		withPosition: list.filter(s => s.position).length,
		byKind: { station: list.length, object: 0, item: 0 },
		packetsProcessed: list.reduce((n, s) => n + s.packetCount, 0),
		duplicatesDropped: 9,
		invalidPackets: 0,
		packetsPerSecond: 0.1,
		lastPacketAt: HHMM(at),
		latestKey: list[0]?.key ?? null,
		expiredTotal: 0,
		timestamp: HHMM(at),
	})
	const meshStats = (list: MeshNode[], at: number): MeshTrackerStats => ({
		nodeCount: list.length,
		withPosition: list.filter(m => m.position).length,
		withName: list.filter(m => m.longName).length,
		packetsProcessed: list.reduce((n, m) => n + m.packetCount, 0),
		duplicatesDropped: 16,
		invalidPackets: 0,
		decodeErrors: 0,
		packetsPerSecond: 0.05,
		lastPacketAt: HHMM(at),
		latestNodeId: list[0]?.nodeId ?? null,
		expiredTotal: 0,
		telemetryPackets: 8,
		neighbourReports: 3,
		timestamp: HHMM(at),
	})

	// most recently heard first, as the core lists them
	const byRecent = <T>(list: T[], key: (x: T) => string): T[] =>
		list.sort(
			(x, y) => (lastReport.get(key(y)) ?? 0) - (lastReport.get(key(x)) ?? 0),
		)
	const allAircraft = () =>
		byRecent(
			aircraft.map(a => aircraftState(a, now())),
			a => `a:${a.icao}`,
		)
	const allVessels = () =>
		byRecent(
			vessels.map(v => vesselState(v, now())),
			v => `v:${v.mmsi}`,
		)
	const allAprs = () =>
		byRecent(
			aprs.map(s => aprsState(s, now())),
			s => s.key,
		)
	const allMesh = () =>
		byRecent(
			mesh.map(m => meshState(m, now())),
			m => m.key,
		)

	// first reports at start, so every list is full from the first request
	{
		const at = now()
		for (const a of aircraft) bump(`a:${a.icao}`, at)
		vessels.forEach((v, i) => bump(`v:${v.mmsi}`, at - (i % 5) * 4000))
		aprs.forEach((s, i) => bump(`callsign:${s.callsign}`, at - i * 20_000))
		mesh.forEach((m, i) => bump(`node:${m.nodeId}`, at - i * 45_000))
		for (const a of aircraft) laps.set(a.icao, aircraftAt(a, 0).lap)
	}

	// ---- REST
	app.get("/api/aircraft", async () => {
		const list = allAircraft()
		return { aircraft: list, stats: aircraftStats(list), timestamp: now() }
	})
	app.get("/api/aircraft/stats", async () => aircraftStats(allAircraft()))
	// Settings › Map › Online aircraft lookups (the switch only; the mock never goes online).
	// Off by default like the core.
	let infoOnline: boolean | null = null
	const aircraftInfo = () => ({
		enabled: true,
		online: infoOnline ?? false,
		onlineFrom: infoOnline === null ? "config" : "ui",
		persistent: true,
		localDb: {
			enabled: true,
			aircraft: 612_480,
			updatedAt: new Date(now() - 86_400_000).toISOString(),
		},
	})
	app.get("/api/aircraft/info", async () => aircraftInfo())
	app.put("/api/aircraft/info", async (request, reply) => {
		// strict like the core: { online: boolean } and nothing else
		const body = infoUpdateBody.safeParse(request.body)
		if (!body.success)
			return reply.code(400).send({
				error: "Bad Request",
				message: "Expected { online: boolean }",
			})
		infoOnline = body.data.online
		reply.header("Cache-Control", "no-store")
		return aircraftInfo()
	})
	const identityLinks = mockIdentityLinks(aircraft)
	app.get<{ Params: { kind: string; value: string } }>(
		"/api/aircraft-identity/:kind/:value",
		async (request, reply) => {
			const query = mockIdentifier(request.params.kind, request.params.value)
			if (query === null)
				return reply
					.code(400)
					.send({ error: "Not a valid identifier of that kind" })
			return mockIdentity(identityLinks, query, now())
		},
	)
	app.get<{ Params: { icao: string } }>(
		"/api/aircraft/:icao",
		async (request, reply) => {
			const icao = request.params.icao.toUpperCase()
			const a = aircraft.find(x => x.icao === icao)
			if (!a) return reply.code(404).send({ error: "Aircraft not found", icao })
			return aircraftState(a, now())
		},
	)

	app.get("/api/vessels", async () => {
		const list = allVessels()
		return {
			vessels: list,
			stats: vesselStats(list, now()),
			timestamp: HHMM(now()),
		}
	})
	app.get("/api/vessels/stats", async () => vesselStats(allVessels(), now()))
	app.get<{ Params: { mmsi: string } }>(
		"/api/vessels/:mmsi",
		async (request, reply) => {
			const raw = request.params.mmsi
			if (!/^\d{1,9}$/.test(raw))
				return reply
					.code(400)
					.send({ error: "MMSI must be 1-9 digits", code: "VALIDATION_ERROR" })
			const mmsi = raw.padStart(9, "0")
			const v = vessels.find(x => x.mmsi === mmsi)
			if (!v)
				return reply
					.code(404)
					.send({ error: "Vessel not found", code: "VESSEL_NOT_FOUND", mmsi })
			return vesselState(v, now())
		},
	)

	const APRS_KEY =
		/^(callsign:[A-Z0-9]{1,6}(-[0-9]{1,2})?|aprs-(object|item):[^:\u0000-\u001f]{1,9})$/
	app.get("/api/aprs/stations", async () => {
		const list = allAprs()
		return {
			stations: list,
			stats: aprsStats(list, now()),
			timestamp: HHMM(now()),
		}
	})
	app.get("/api/aprs/stats", async () => aprsStats(allAprs(), now()))
	app.get<{ Params: { key: string } }>(
		"/api/aprs/stations/:key",
		async (request, reply) => {
			const key = request.params.key
			if (!APRS_KEY.test(key))
				return reply.code(400).send({
					error: "APRS station key is outside the allowed grammar",
					code: "VALIDATION_ERROR",
				})
			const s = aprs.find(x => `callsign:${x.callsign}` === key)
			if (!s)
				return reply.code(404).send({
					error: "APRS station not found",
					code: "APRS_STATION_NOT_FOUND",
					key,
				})
			return aprsState(s, now())
		},
	)

	app.get("/api/mesh/nodes", async () => {
		const list = allMesh()
		return {
			nodes: list,
			stats: meshStats(list, now()),
			timestamp: HHMM(now()),
		}
	})
	app.get("/api/mesh/stats", async () => meshStats(allMesh(), now()))
	app.get<{ Params: { nodeId: string } }>(
		"/api/mesh/nodes/:nodeId",
		async (request, reply) => {
			const raw = request.params.nodeId
			if (!/^![0-9a-fA-F]{8}$/.test(raw))
				return reply.code(400).send({
					error: "Node id must be ! and 8 hex digits",
					code: "VALIDATION_ERROR",
				})
			const nodeId = raw.toLowerCase()
			const m = mesh.find(x => x.nodeId === nodeId)
			if (!m)
				return reply.code(404).send({
					error: "Mesh node not found",
					code: "MESH_NODE_NOT_FOUND",
					nodeId,
				})
			return meshState(m, now())
		},
	)

	// GET /api/activity/trails (WG4): the stored positions of the last hour, one per entity per 60 s
	// (the core's position coalescing), oldest first; an aircraft's trail starts on its current lap.
	app.get<{ Querystring: { categories?: string } }>(
		"/api/activity/trails",
		async request => {
			const wanted = request.query.categories
				?.split(",")
				.map(c => c.trim())
				.filter(c => c.length > 0)
			const at = now()
			const from = at - 3_600_000
			const trails: ActivityTrail[] = []
			const add = (
				entityKey: string,
				category: ActivityTrail["category"],
				protocol: string,
				pos: (ms: number) => { lat: number; lon: number } | null,
			) => {
				const points: ActivityTrailPoint[] = []
				for (let ms = at - ((at - from) % 60_000); ms >= from; ms -= 60_000) {
					const p = pos(ms)
					if (!p) break
					points.push([
						ms,
						Math.round(p.lat * 1e5) / 1e5,
						Math.round(p.lon * 1e5) / 1e5,
						null,
					])
				}
				if (points.length > 0)
					trails.push({
						entityKey,
						category,
						protocol,
						points: points.reverse(),
						truncated: false,
					})
			}
			const ts = (ms: number) => (ms - startedAt) / 1000
			for (const a of aircraft) {
				const lap = aircraftAt(a, ts(at)).lap
				add(`icao:${a.icao}`, "aircraft", "adsb", ms => {
					const p = aircraftAt(a, ts(ms))
					return p.lap === lap ? p : null
				})
			}
			for (const v of vessels)
				if (v.vesselClass !== "aton")
					add(`mmsi:${v.mmsi}`, "marine", "ais", ms => vesselAt(v, ts(ms)))
			for (const s of aprs)
				add(`callsign:${s.callsign}`, "aprs", "aprs", ms => aprsAt(s, ts(ms)))
			for (const m of mesh)
				add(`node:${m.nodeId}`, "mesh", "meshtastic", ms => meshAt(m, ts(ms)))
			// positions the first aircraft reported over VDL2 (link frames, to 0.1°): one every 10 min of its lap
			const first = aircraft[0]
			if (first) {
				const lap = aircraftAt(first, ts(at)).lap
				const points: ActivityTrailPoint[] = []
				for (let ms = at - ((at - from) % 600_000); ms >= from; ms -= 600_000) {
					const p = aircraftAt(first, ts(ms))
					if (p.lap !== lap) break
					points.push([
						ms,
						Math.round(p.lat * 10) / 10,
						Math.round(p.lon * 10) / 10,
						null,
					])
				}
				if (points.length > 0)
					trails.push({
						entityKey: `icao:${first.icao}`,
						category: "aviation-data",
						protocol: "vdl2",
						points: points.reverse(),
						truncated: false,
					})
			}
			const kept =
				wanted && wanted.length > 0
					? trails.filter(t => wanted.includes(t.category))
					: [...trails]
			trails.length = 0
			trails.push(...kept)
			const pointCount = trails.reduce((n, t) => n + t.points.length, 0)
			const answer: ActivityTrails = {
				producedFrom: HHMM(from),
				producedTo: HHMM(at),
				trails,
				pointCount,
				scannedRows: pointCount,
				skippedRows: 0,
				truncated: false,
				truncation: [],
				retentionFloor: HHMM(startedAt - 3 * 86_400_000),
				generatedAt: HHMM(at),
			}
			return answer
		},
	)

	app.get<{ Querystring: { protocol?: string } }>(
		"/api/coverage",
		async (request, reply) => {
			const protocol = request.query.protocol
			if (protocol !== undefined && protocol !== "adsb" && protocol !== "ais")
				return reply.code(400).send({
					error: "protocol must be one of: adsb, ais",
					code: "VALIDATION_ERROR",
				})
			void reply.header("Cache-Control", "no-store")
			const st = ctx.station()
			const at = now()
			const rejected = {
				"invalid-position": 0,
				"too-far": 2,
				stale: 5,
				"no-station": st ? 0 : 41,
			}
			const base = {
				windowHours: 24,
				bearingStepDeg: 1,
				rejected,
				timestamp: HHMM(at),
			}
			if (!st) {
				const answer: CoverageResponse = {
					available: false,
					reason: "no-station-location",
					station: null,
					protocols: [],
					...base,
				}
				return answer
			}
			const summary = (p: "adsb" | "ais"): CoverageProtocolSummary => {
				const sectors = Array.from({ length: 360 }, (_, b) => {
					const km = coverageKm(p, b + 0.5)
					const [lat, lon] = dest([st.lat, st.lon], b + 0.5, km)
					return {
						bearingDeg: b,
						maxRangeM: Math.round(km * 1000),
						lat: Math.round(lat * 1e5) / 1e5,
						lon: Math.round(lon * 1e5) / 1e5,
						at: HHMM(at - ((b * 7919) % 86_000) * 1000),
					}
				})
				return {
					protocol: p,
					sectors,
					maxRangeM: Math.max(...sectors.map(s => s.maxRangeM)),
					accepted: p === "adsb" ? 48_210 : 3_904,
				}
			}
			const answer: CoverageResponse = {
				available: true,
				station: { lat: st.lat, lon: st.lon },
				protocols:
					protocol === "adsb" || protocol === "ais"
						? [summary(protocol)]
						: [summary("adsb"), summary("ais")],
				...base,
			}
			return answer
		},
	)

	// ---- live updates
	let step = 0
	const tick = () => {
		step += 1
		const at = now()
		const ts = t()
		for (const a of aircraft) {
			const key = `a:${a.icao}`
			const lap = aircraftAt(a, ts).lap
			if (lap !== laps.get(a.icao)) {
				// out of range and back at the other end: lost, then a new track
				laps.set(a.icao, lap)
				const last = aircraftState(a, at - 1000)
				ctx.broadcast("aircraft", "aircraft:lost", {
					icao: a.icao,
					aircraft: last,
				})
				firstSeen.set(key, at)
				counts.set(key, 0)
				bump(key, at)
				ctx.broadcast("aircraft", "aircraft:new", aircraftState(a, at))
				continue
			}
			bump(key, at)
			ctx.broadcast("aircraft", "aircraft:update", aircraftState(a, at))
			for (let j = 1; j < adsbRate; j++)
				setTimeout(
					() => {
						const later = now()
						bump(key, later)
						ctx.broadcast(
							"aircraft",
							"aircraft:update",
							aircraftState(a, later),
						)
					},
					(j * (ctx.tickMs ?? 1000)) / adsbRate,
				).unref()
		}
		if (step % 10 === 0)
			ctx.broadcast("aircraft", "aircraft:stats", aircraftStats(allAircraft()))
		// the others report on their own cadence, then through the 2 s per-entity limit
		const offer = (
			channel: string,
			type: string,
			key: string,
			everyS: number,
			state: () => unknown,
		) => {
			const last = lastReport.get(key) ?? 0
			if (at - last < everyS * 1000) return
			bump(key, at)
			if (at - (lastSent.get(key) ?? 0) < ENTITY_WINDOW_MS) return
			lastSent.set(key, at)
			ctx.broadcast(channel, type, state())
		}
		for (const v of vessels) {
			const every =
				v.vesselClass === "aton"
					? 180
					: v.kn === 0
						? 120
						: v.vesselClass === "B"
							? 15
							: 6
			offer("vessels", "vessel:update", `v:${v.mmsi}`, every, () =>
				vesselState(v, at),
			)
		}
		for (const s of aprs)
			offer("aprs", "aprs:update", `callsign:${s.callsign}`, s.everyS, () =>
				aprsState(s, at),
			)
		for (const m of mesh)
			offer("mesh", "mesh:update", `node:${m.nodeId}`, m.kn ? 30 : 90, () =>
				meshState(m, at),
			)
		if (step % 15 === 0) {
			ctx.broadcast("vessels", "vessel:stats", vesselStats(allVessels(), at))
			ctx.broadcast("aprs", "aprs:stats", aprsStats(allAprs(), at))
			ctx.broadcast("mesh", "mesh:stats", meshStats(allMesh(), at))
		}
	}
	const timer = setInterval(tick, ctx.tickMs ?? 1000)
	timer.unref()
	app.addHook("onClose", async () => {
		clearInterval(timer)
	})
	return { tick }
}
