import type { AircraftData } from "../../../decoders/builtin/readsb.js"
import { isCoalescibleShape } from "../storage/coalesce.js"
import type { DecodePresentation } from "../types.js"
import {
	canonicalIcao,
	clampTitle,
	entityKey,
	firstNumber,
	firstString,
	asNumber,
	asNumberOrString,
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
	altitude: asNumberOrString,
	alt_baro: asNumberOrString,
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

/** ADS-B aircraft. Altitude stays in feet; position has no altM. */
export function presentAircraft(data: unknown): DecodePresentation | undefined {
	const payload = parsePayload(aircraftPayload, data)
	if (!payload) return undefined
	const icaoRaw = firstString(payload, ["icao", "hex"])
	const icao = icaoRaw === undefined ? null : canonicalIcao(icaoRaw)
	const callsign = callsignOf(payload)
	const title = clampTitle(callsign ?? icao ?? "")
	const key = icao === null ? null : entityKey("icao", icao)
	const position = readPosition(payload)
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
						value: firstNumber(payload, ["altitude", "alt_baro"]),
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
