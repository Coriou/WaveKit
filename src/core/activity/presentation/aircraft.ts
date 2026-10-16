import type { AircraftData } from "../../../decoders/builtin/readsb.js"
import { z } from "zod"
import { isCoalescibleShape } from "../storage/coalesce.js"
import type { DecodePresentation } from "../types.js"
import {
	altitudeFromFeet,
	canonicalIcao,
	clampTitle,
	entityKey,
	firstNumber,
	firstString,
	identifierText,
	asNumber,
	asString,
	objectSchema,
	parsePayload,
	presentation,
	readPosition,
	stringField,
	takeFields,
} from "./budget.js"

const aircraftPayload = objectSchema({
	icao: asString,
	hex: asString,
	callsign: asString,
	flight: asString,
	squawk: asString,
	// Read by `firstNumber` only: an undecodable altitude (NaN, `ground`, a
	// wrong type) omits altM and the Altitude field, never the presentation
	// (req 4.6).
	altitude: z.unknown(),
	alt_baro: z.unknown(),
	groundSpeed: asNumber,
	gs: asNumber,
	track: asNumber,
	verticalRate: asNumber,
	baro_rate: asNumber,
	lat: asNumber,
	lon: asNumber,
})

function callsignOf(
	payload: Record<string, unknown>,
): AircraftData["callsign"] {
	return firstString(payload, ["callsign", "flight"])
}

/**
 * ADS-B aircraft. The Altitude field stays in feet; `position.altM` is the
 * barometric altitude in whole metres (req 4.1). `ground` omits it: ground
 * elevation is unknown.
 */
export function presentAircraft(data: unknown): DecodePresentation | undefined {
	const payload = parsePayload(aircraftPayload, data)
	if (!payload) return undefined
	const icaoRaw =
		identifierText(payload, "icao") ?? identifierText(payload, "hex")
	const icao = icaoRaw === undefined ? null : canonicalIcao(icaoRaw)
	const callsign = callsignOf(payload)
	const title = clampTitle(callsign ?? icao ?? "")
	const key = icao === null ? null : entityKey("icao", icao)
	const altitudeFt = firstNumber(payload, ["altitude", "alt_baro"])
	const position = readPosition(payload, altitudeFromFeet(altitudeFt))
	const fields = isCoalescibleShape("aircraft", payload)
		? []
		: takeFields(
				[
					{ key: "callsign", label: "Callsign", value: callsign },
					{
						key: "squawk",
						label: "Squawk",
						value: stringField(payload, "squawk"),
					},
					{
						key: "altitude",
						label: "Altitude",
						unit: "ft",
						value: altitudeFt,
					},
					{
						key: "groundSpeed",
						label: "Ground speed",
						unit: "kt",
						value: firstNumber(payload, ["groundSpeed", "gs"]),
					},
					{
						key: "track",
						label: "Track",
						unit: "deg",
						value: firstNumber(payload, ["track"]),
					},
					{
						key: "verticalRate",
						label: "Vertical rate",
						unit: "ft/min",
						value: firstNumber(payload, ["verticalRate", "baro_rate"]),
					},
				],
				{ title, omitKeys: callsign === undefined ? [] : ["callsign"] },
			)
	return presentation({
		category: "aircraft",
		protocol: "adsb",
		entityKey: key,
		title,
		position,
		fields,
	})
}
