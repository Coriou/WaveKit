/**
 * Free, keyless online sources of aircraft details. Each answer is validated with
 * Zod at the boundary and mapped to our types; anything unexpected is dropped.
 *
 * - adsbdb.com: airframe (type, registration, owner, airport-data photo) and the
 *   crowd-sourced route and airline of a callsign.
 * - hexdb.io: airframe, used when adsbdb has nothing or is unavailable.
 * - planespotters.net public photo API: photo with photographer credit (their terms
 *   require the credit and a link back, and a descriptive User-Agent).
 *
 * @module src/services/aircraft-info/sources
 */

import { z } from "zod"
import type {
	AircraftAirline,
	AircraftAirport,
	AircraftPhoto,
	AircraftRoute,
	EnrichmentSource,
} from "@wavekit/api-types"
import type { SourceClient } from "./http.js"

/** Identity fields an airframe lookup can fill. */
export interface AirframeInfo {
	registration?: string
	typeCode?: string
	typeDescription?: string
	manufacturer?: string
	operator?: string
	operatorCode?: string
	countryIso?: string
	photo?: AircraftPhoto
	source?: EnrichmentSource
}

export interface CallsignInfo {
	airline?: AircraftAirline
	route?: AircraftRoute
}

const text = z
	.string()
	.transform(s => s.trim())
	.nullish()
const httpsUrl = z
	.string()
	.url()
	.refine(u => u.startsWith("https://"))

function put<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | null | undefined,
): void {
	if (value === null || value === undefined) return
	if (typeof value === "string" && value.length === 0) return
	target[key] = value
}

// ---- adsbdb ---------------------------------------------------------------

const adsbdbAircraftSchema = z.object({
	response: z.object({
		aircraft: z.object({
			type: text,
			icao_type: text,
			manufacturer: text,
			registration: text,
			registered_owner: text,
			registered_owner_operator_flag_code: text,
			registered_owner_country_iso_name: text,
			url_photo: httpsUrl.nullish().catch(null),
			url_photo_thumbnail: httpsUrl.nullish().catch(null),
		}),
	}),
})

export async function adsbdbAirframe(
	client: SourceClient,
	hex: string,
): Promise<AirframeInfo | null> {
	const body = await client.getJson(
		`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(hex)}`,
	)
	if (body === null) return null
	const parsed = adsbdbAircraftSchema.safeParse(body)
	if (!parsed.success) return null
	const a = parsed.data.response.aircraft
	const out: AirframeInfo = {}
	put(out, "registration", a.registration)
	put(out, "typeCode", a.icao_type)
	put(out, "typeDescription", a.type)
	put(out, "manufacturer", a.manufacturer)
	put(out, "operator", a.registered_owner)
	put(out, "operatorCode", a.registered_owner_operator_flag_code)
	put(out, "countryIso", a.registered_owner_country_iso_name)
	const thumb = a.url_photo_thumbnail ?? a.url_photo
	if (thumb) {
		const photo: AircraftPhoto = { thumbnailUrl: thumb, source: "airport-data" }
		if (a.url_photo) photo.largeUrl = a.url_photo
		out.photo = photo
	}
	if (Object.keys(out).length === 0) return null
	out.source = "adsbdb"
	return out
}

const adsbdbAirportSchema = z.object({
	icao_code: z.string().min(3),
	iata_code: text,
	name: z.string().min(1),
	municipality: text,
	country_name: text,
	country_iso_name: text,
	latitude: z.number().finite(),
	longitude: z.number().finite(),
})

const adsbdbCallsignSchema = z.object({
	response: z.object({
		flightroute: z.object({
			callsign: z.string(),
			airline: z
				.object({
					name: z.string().min(1),
					icao: z.string().min(2),
					iata: text,
					country: text,
					country_iso: text,
					callsign: text,
				})
				.nullish()
				.catch(null),
			origin: adsbdbAirportSchema.nullish().catch(null),
			destination: adsbdbAirportSchema.nullish().catch(null),
		}),
	}),
})

function airport(a: z.infer<typeof adsbdbAirportSchema>): AircraftAirport {
	const out: AircraftAirport = {
		icao: a.icao_code,
		name: a.name,
		lat: a.latitude,
		lon: a.longitude,
	}
	put(out, "iata", a.iata_code)
	put(out, "city", a.municipality)
	put(out, "country", a.country_name)
	put(out, "countryIso", a.country_iso_name)
	return out
}

export async function adsbdbCallsign(
	client: SourceClient,
	callsign: string,
): Promise<CallsignInfo | null> {
	const body = await client.getJson(
		`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
	)
	if (body === null) return null
	const parsed = adsbdbCallsignSchema.safeParse(body)
	if (!parsed.success) return null
	const r = parsed.data.response.flightroute
	const out: CallsignInfo = {}
	if (r.airline) {
		const airline: AircraftAirline = {
			name: r.airline.name,
			icao: r.airline.icao,
			source: "adsbdb",
		}
		put(airline, "iata", r.airline.iata)
		put(airline, "callsign", r.airline.callsign)
		put(airline, "country", r.airline.country)
		put(airline, "countryIso", r.airline.country_iso)
		out.airline = airline
	}
	if (
		r.origin &&
		r.destination &&
		r.origin.icao_code !== r.destination.icao_code
	)
		out.route = {
			callsign,
			origin: airport(r.origin),
			destination: airport(r.destination),
			source: "adsbdb",
		}
	return out.airline || out.route ? out : null
}

// ---- hexdb ----------------------------------------------------------------

const hexdbSchema = z.object({
	Registration: text,
	ICAOTypeCode: text,
	Type: text,
	Manufacturer: text,
	RegisteredOwners: text,
	OperatorFlagCode: text,
})

export async function hexdbAirframe(
	client: SourceClient,
	hex: string,
): Promise<AirframeInfo | null> {
	const body = await client.getJson(
		`https://hexdb.io/api/v1/aircraft/${encodeURIComponent(hex)}`,
	)
	if (body === null) return null
	const parsed = hexdbSchema.safeParse(body)
	if (!parsed.success) return null
	const a = parsed.data
	const out: AirframeInfo = {}
	put(out, "registration", a.Registration)
	put(out, "typeCode", a.ICAOTypeCode)
	put(out, "typeDescription", a.Type)
	put(out, "manufacturer", a.Manufacturer)
	put(out, "operator", a.RegisteredOwners)
	put(out, "operatorCode", a.OperatorFlagCode)
	if (Object.keys(out).length === 0) return null
	out.source = "hexdb"
	return out
}

// ---- planespotters --------------------------------------------------------

const planespottersSchema = z.object({
	photos: z.array(
		z.object({
			thumbnail: z.object({ src: httpsUrl }),
			thumbnail_large: z.object({ src: httpsUrl }).nullish().catch(null),
			link: httpsUrl.nullish().catch(null),
			photographer: text,
		}),
	),
})

/**
 * Photo of an airframe, by registration when known (a hex lookup can match the
 * wrong airframe for reused or invalid addresses), else by hex.
 */
export async function planespottersPhoto(
	client: SourceClient,
	key: { registration?: string; hex: string },
): Promise<AircraftPhoto | null> {
	const url = key.registration
		? `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(key.registration)}`
		: `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(key.hex)}`
	const body = await client.getJson(url)
	if (body === null) return null
	const parsed = planespottersSchema.safeParse(body)
	if (!parsed.success) return null
	const p = parsed.data.photos[0]
	if (!p) return null
	const photo: AircraftPhoto = {
		thumbnailUrl: p.thumbnail.src,
		source: "planespotters",
	}
	put(photo, "largeUrl", p.thumbnail_large?.src)
	put(photo, "photographer", p.photographer)
	put(photo, "link", p.link)
	return photo
}
