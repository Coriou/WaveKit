import type { AircraftLookup, FormattedMessage } from "../../data/types.js"
import { formatCount, formatSpaced } from "../format.js"
import { glyphs } from "../theme.js"
import { asObj, finish, num, obj, seg, str, textGlyphs } from "./common.js"

export const EMERGENCY_SQUAWKS: readonly string[] = ["7500", "7600", "7700"]
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const

export function isAircraftShape(data: unknown): boolean {
	const o = asObj(data)
	return str(o, "hex") !== undefined || str(o, "icao") !== undefined
}

export function formatAircraft(
	data: unknown,
	decoderId: string,
	type: string,
	lookup: AircraftLookup,
): FormattedMessage {
	const o = asObj(data)
	const icao = (str(o, "icao") ?? str(o, "hex") ?? "?").toUpperCase()
	const known = lookup(icao)
	const ident = obj(o, "identification")
	const reg =
		str(ident, "registration") ??
		str(o, "registration") ??
		str(o, "r") ??
		known?.identification?.registration
	const typeCode =
		str(ident, "typeCode") ??
		str(o, "typeCode") ??
		str(o, "t") ??
		known?.identification?.typeCode
	// R62: operator from the enriched aircraft map when present (never invented).
	const operator =
		str(ident, "operator")?.trim() ?? known?.identification?.operator?.trim()
	const flight = (str(o, "callsign") ?? str(o, "flight"))?.trim()
	const squawk = str(o, "squawk")
	const alt = obj(o, "altitude")
	const onGround =
		o["onGround"] === true ||
		o["alt_baro"] === "ground" ||
		alt["onGround"] === true
	const altFt = num(o, "alt_baro") ?? num(o, "altitude") ?? num(alt, "baro")
	const rate =
		num(o, "baro_rate") ?? num(o, "verticalRate") ?? num(alt, "baroRate")
	const vel = obj(o, "velocity")
	const gs = num(vel, "gs") ?? num(o, "gs") ?? num(o, "groundSpeed")
	const track = num(vel, "track") ?? num(o, "track")
	const pos = obj(o, "position")
	const lat = num(pos, "lat") ?? num(o, "lat")
	const lon = num(pos, "lon") ?? num(o, "lon")
	const rssi = num(obj(o, "signalQuality"), "rssi") ?? num(o, "rssi")
	const seen = num(o, "seen")
	const messages = num(o, "messages") ?? num(o, "messageCount")
	const emergencyField = str(o, "emergency")
	const emergency =
		(squawk !== undefined && EMERGENCY_SQUAWKS.includes(squawk)) ||
		(emergencyField !== undefined &&
			emergencyField !== "none" &&
			emergencyField !== "")
	const g = glyphs()
	const trend =
		rate === undefined
			? ""
			: rate > 300
				? ` ${g.up}`
				: rate < -300
					? ` ${g.down}`
					: ""
	const altText = onGround
		? "GND"
		: altFt === undefined
			? undefined
			: `FL${Math.round(altFt / 100)}${trend}`
	const dir = track === undefined ? undefined : DIRS[Math.round(track / 45) % 8]
	const segments = [
		seg(icao, 0),
		...(reg ? [seg(reg, 2)] : []),
		...(flight ? [seg(flight, 1)] : []),
		...(typeCode ? [seg(typeCode, 3)] : []),
		...(altText ? [seg(altText, 1)] : []),
		...(gs !== undefined ? [seg(`${Math.round(gs)} kt`, 4)] : []),
		...(lat !== undefined && lon !== undefined
			? [seg(`${lat.toFixed(2)},${lon.toFixed(2)}`, 5)]
			: []),
		...(dir ? [seg(dir, 6)] : []),
		...(emergency && squawk
			? [seg(`${g.attention}${squawk}`, 0, "attention")]
			: []),
		// Last and lowest priority: it drops first and never displaces the mockup's segments.
		...(operator ? [seg(operator, 7)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "icao", value: icao },
		...(reg ? [{ label: "reg", value: reg }] : []),
		...(flight ? [{ label: "flight", value: flight }] : []),
		...(typeCode ? [{ label: "type", value: typeCode }] : []),
		...(operator ? [{ label: "operator", value: operator }] : []),
		...(squawk
			? [
					{
						label: "squawk",
						value: emergency ? `${g.attention}${squawk} emergency` : squawk,
						attention: emergency,
					},
				]
			: []),
		...(altText
			? [
					{
						label: "alt",
						value: onGround
							? "GND"
							: `${formatSpaced(altFt)} ft${trend}${rate !== undefined && trend ? ` ${formatSpaced(Math.abs(rate))} ft/min` : ""}`,
					},
				]
			: []),
		...(gs !== undefined
			? [{ label: "speed", value: `${Math.round(gs)} kt` }]
			: []),
		...(track !== undefined
			? [
					{
						label: "track",
						value:
							`${Math.round(track)}${textGlyphs().degree} ${dir ?? ""}`.trim(),
					},
				]
			: []),
		...(lat !== undefined && lon !== undefined
			? [{ label: "position", value: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }]
			: []),
		...(rssi !== undefined
			? [{ label: "rssi", value: `${rssi.toFixed(1)} dBm` }]
			: []),
		...(seen !== undefined
			? [{ label: "seen", value: `${seen.toFixed(1)}s ago` }]
			: []),
		...(messages !== undefined
			? [{ label: "messages", value: formatCount(messages) }]
			: []),
	]
	return finish(decoderId, type, "ADS-B", "aircraft", segments, fields, {
		emergency,
	})
}
