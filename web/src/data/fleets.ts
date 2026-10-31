/**
 * The four fleets the Map shows, as FleetSpecs over the core's routes and channels:
 * - aircraft: GET /api/aircraft, channel `aircraft` (`aircraft:new | update | lost`, lost data
 *   `{ icao, aircraft }`); times in Unix ms; the tracker keeps a track history (most recent first).
 * - vessels (AIS, aids to navigation included): GET /api/vessels, channel `vessels`, ISO times.
 * - APRS stations, objects and items: GET /api/aprs/stations, channel `aprs`.
 * - Meshtastic nodes (with neighbour links): GET /api/mesh/nodes, channel `mesh`.
 * The schemas read only what the web app uses (unknown fields are dropped); the type checks at the
 * bottom keep each schema accepting the DTO in packages/api-types.
 */
import { z } from "zod/v4"
import type {
	AircraftState,
	AprsStation,
	MeshNode,
	VesselState,
} from "@wavekit/api-types"

import type { ApiClient } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import type { FleetSpec, FleetStoreOptions } from "./fleet-store.ts"
import { FleetStore } from "./fleet-store.ts"

const num = z.number()
const optNum = num.optional()
const iso = z.string()

function ms(text: string): number {
	const t = Date.parse(text)
	return Number.isFinite(t) ? t : 0
}

const record = (body: unknown): Record<string, unknown> | null =>
	typeof body === "object" && body !== null
		? (body as Record<string, unknown>)
		: null

function listOf(
	key: string,
	time: (raw: unknown) => number | null,
): (body: unknown) => { items: unknown[]; now: number } | null {
	return body => {
		const r = record(body)
		const items = r?.[key]
		const now = r ? time(r["timestamp"]) : null
		return Array.isArray(items) && now !== null ? { items, now } : null
	}
}

const unixMs = (raw: unknown) => (typeof raw === "number" ? raw : null)
const isoMs = (raw: unknown) => (typeof raw === "string" ? ms(raw) : null)

function lostKeyOf(field: string): (data: unknown) => string | null {
	return data => {
		const v = record(data)?.[field]
		return typeof v === "string" ? v : null
	}
}

// ---- aircraft

const airportSchema = z.object({
	icao: z.string(),
	iata: z.string().optional(),
	name: z.string(),
	city: z.string().optional(),
	lat: num,
	lon: num,
})

export const aircraftSchema = z.object({
	icao: z.string(),
	callsign: z.string().optional(),
	squawk: z.string().optional(),
	position: z.object({ lat: num, lon: num, seenPos: optNum }).optional(),
	velocity: z
		.object({
			gs: optNum,
			track: optNum,
			trueHeading: optNum,
			magHeading: optNum,
		})
		.optional(),
	altitude: z
		.object({
			baro: num.nullable().optional(),
			geom: optNum,
			baroRate: optNum,
			geomRate: optNum,
			onGround: z.boolean().optional(),
		})
		.optional(),
	identification: z
		.object({
			registration: z.string().optional(),
			typeCode: z.string().optional(),
			typeDescription: z.string().optional(),
			manufacturer: z.string().optional(),
			operator: z.string().optional(),
			country: z.string().optional(),
			countryIso: z.string().optional(),
			year: optNum,
			// Enrichment from the core (docs/ADSB.md "Aircraft Enrichment"); a malformed part is dropped,
			// never the aircraft.
			flags: z
				.object({
					military: z.boolean().optional(),
					interesting: z.boolean().optional(),
					pia: z.boolean().optional(),
					ladd: z.boolean().optional(),
				})
				.optional()
				.catch(undefined),
			airline: z
				.object({
					name: z.string(),
					icao: z.string(),
					iata: z.string().optional(),
					callsign: z.string().optional(),
				})
				.optional()
				.catch(undefined),
			route: z
				.object({
					callsign: z.string(),
					origin: airportSchema,
					destination: airportSchema,
				})
				.optional()
				.catch(undefined),
			photo: z
				.object({
					thumbnailUrl: z.string(),
					largeUrl: z.string().optional(),
					photographer: z.string().optional(),
					link: z.string().optional(),
					source: z.string().optional(),
				})
				.optional()
				.catch(undefined),
		})
		.optional(),
	signalQuality: z.object({ rssi: optNum }).optional(),
	category: z.string().optional(),
	emergency: z.string().optional(),
	trackHistory: z
		.array(
			z.object({
				lat: num,
				lon: num,
				altitude: num.nullable(),
				timestamp: num,
			}),
		)
		.optional(),
	seen: num,
	seenPos: optNum,
	messages: num,
	firstSeen: num,
	lastUpdated: num,
})
export type Aircraft = z.infer<typeof aircraftSchema>

export const AIRCRAFT_SPEC: FleetSpec<Aircraft> = {
	name: "aircraft",
	path: "/api/aircraft",
	channel: "aircraft",
	events: {
		new: "aircraft:new",
		update: "aircraft:update",
		lost: "aircraft:lost",
	},
	item: aircraftSchema,
	list: listOf("aircraft", unixMs),
	lostKey: lostKeyOf("icao"),
	keyOf: a => a.icao,
	heardAt: a => a.lastUpdated - a.seen * 1000,
	updatedAt: a => a.lastUpdated,
	positionOf: a =>
		a.position
			? {
					lat: a.position.lat,
					lon: a.position.lon,
					at: a.lastUpdated - (a.seenPos ?? a.position.seenPos ?? 0) * 1000,
				}
			: null,
	coreTrail: a =>
		a.trackHistory && a.trackHistory.length > 0
			? a.trackHistory
					.map(p => ({ lat: p.lat, lon: p.lon, at: p.timestamp }))
					.reverse()
			: null,
}

// ---- vessels

const positionSchema = z.object({ lat: num, lon: num, at: iso })

export const vesselSchema = z.object({
	mmsi: z.string(),
	vesselClass: z.enum(["A", "B", "base-station", "aton", "sar", "unknown"]),
	name: z.string().nullable(),
	callsign: z.string().nullable(),
	imo: num.nullable(),
	shipType: num.nullable(),
	destination: z.string().nullable(),
	eta: z.string().nullable(),
	draught: num.nullable(),
	position: positionSchema.nullable(),
	cog: num.nullable(),
	sog: num.nullable(),
	heading: num.nullable(),
	navStatus: num.nullable(),
	messageTypes: z.array(num),
	messageCount: num,
	decoderId: z.string(),
	firstSeen: iso,
	lastSeen: iso,
	lastStaticAt: z.string().nullable(),
	channel: z.enum(["A", "B"]).nullable().optional(),
	aton: z
		.object({
			aidType: num.nullable(),
			virtual: z.boolean().nullable(),
			offPosition: z.boolean().nullable(),
		})
		.nullable()
		.optional(),
	altitudeM: num.nullable().optional(),
})
export type Vessel = z.infer<typeof vesselSchema>

export const VESSEL_SPEC: FleetSpec<Vessel> = {
	name: "vessels",
	path: "/api/vessels",
	channel: "vessels",
	events: { new: "vessel:new", update: "vessel:update", lost: "vessel:lost" },
	item: vesselSchema,
	list: listOf("vessels", isoMs),
	lostKey: lostKeyOf("mmsi"),
	keyOf: v => v.mmsi,
	heardAt: v => ms(v.lastSeen),
	positionOf: v =>
		v.position
			? { lat: v.position.lat, lon: v.position.lon, at: ms(v.position.at) }
			: null,
}

// ---- APRS

export const aprsSchema = z.object({
	key: z.string(),
	kind: z.enum(["station", "object", "item"]),
	callsign: z.string(),
	name: z.string().nullable(),
	position: positionSchema.nullable(),
	altitudeFt: num.nullable(),
	courseDeg: num.nullable(),
	speedKn: num.nullable(),
	symbol: z.string().nullable(),
	comment: z.string().nullable(),
	status: z.string().nullable(),
	weather: z
		.object({
			temperatureF: num.nullable(),
			humidityPct: num.nullable(),
			pressureMbar: num.nullable(),
			windSpeedMph: num.nullable(),
			windDirectionDeg: num.nullable(),
			rainLastHourIn: num.nullable(),
			at: iso,
		})
		.nullable(),
	path: z.array(z.string()),
	lastDataType: z.string(),
	killed: z.boolean(),
	packetCount: num,
	digipeatedCopies: num,
	decoderId: z.string(),
	firstSeen: iso,
	lastSeen: iso,
})
export type Aprs = z.infer<typeof aprsSchema>

export const APRS_SPEC: FleetSpec<Aprs> = {
	name: "APRS",
	path: "/api/aprs/stations",
	channel: "aprs",
	events: { new: "aprs:new", update: "aprs:update", lost: "aprs:lost" },
	item: aprsSchema,
	list: listOf("stations", isoMs),
	lostKey: lostKeyOf("key"),
	keyOf: a => a.key,
	heardAt: a => ms(a.lastSeen),
	positionOf: a =>
		a.position
			? { lat: a.position.lat, lon: a.position.lon, at: ms(a.position.at) }
			: null,
}

// ---- mesh

export const meshSchema = z.object({
	nodeId: z.string(),
	key: z.string(),
	nodeNum: num,
	longName: z.string().nullable(),
	shortName: z.string().nullable(),
	hwModel: num.nullable(),
	role: num.nullable(),
	isLicensed: z.boolean().nullable(),
	position: z
		.object({
			lat: num,
			lon: num,
			altitudeM: num.nullable(),
			at: iso,
			fixAt: z.string().nullable().optional(),
		})
		.nullable(),
	snrDb: num.nullable(),
	rssiDbm: num.nullable(),
	hopsAway: num.nullable(),
	viaMqtt: z.boolean(),
	packetCount: num,
	duplicateCopies: num,
	portnums: z.record(z.string(), num),
	lastPortnum: num,
	decoderId: z.string(),
	firstSeen: iso,
	lastSeen: iso,
	lastNodeInfoAt: z.string().nullable(),
	telemetry: z
		.object({
			batteryPct: num.nullable(),
			powered: z.boolean().nullable(),
			voltageV: num.nullable(),
			channelUtilizationPct: num.nullable(),
			airUtilTxPct: num.nullable(),
			uptimeS: num.nullable(),
			at: iso,
		})
		.nullable()
		.optional(),
	neighbours: z
		.array(z.object({ nodeId: z.string(), snrDb: num.nullable(), at: iso }))
		.optional(),
})
export type Mesh = z.infer<typeof meshSchema>

export const MESH_SPEC: FleetSpec<Mesh> = {
	name: "mesh",
	path: "/api/mesh/nodes",
	channel: "mesh",
	events: { new: "mesh:new", update: "mesh:update", lost: "mesh:lost" },
	item: meshSchema,
	list: listOf("nodes", isoMs),
	lostKey: lostKeyOf("nodeId"),
	keyOf: m => m.nodeId,
	heardAt: m => ms(m.lastSeen),
	positionOf: m =>
		m.position
			? { lat: m.position.lat, lon: m.position.lon, at: ms(m.position.at) }
			: null,
}

export interface Fleets {
	aircraft: FleetStore<Aircraft>
	vessels: FleetStore<Vessel>
	aprs: FleetStore<Aprs>
	mesh: FleetStore<Mesh>
}

export function createFleets(
	api: ApiClient,
	events: EventsClient,
	options: FleetStoreOptions = {},
): Fleets {
	return {
		aircraft: new FleetStore(api, events, AIRCRAFT_SPEC, options),
		vessels: new FleetStore(api, events, VESSEL_SPEC, options),
		aprs: new FleetStore(api, events, APRS_SPEC, options),
		mesh: new FleetStore(api, events, MESH_SPEC, options),
	}
}

// Each schema accepts its DTO (a field the schema requires is one the DTO always has).
type Accepts<Schema, Dto extends Schema> = Dto
export type DtoChecks = [
	Accepts<z.input<typeof aircraftSchema>, AircraftState>,
	Accepts<z.input<typeof vesselSchema>, VesselState>,
	Accepts<z.input<typeof aprsSchema>, AprsStation>,
	Accepts<z.input<typeof meshSchema>, MeshNode>,
]
