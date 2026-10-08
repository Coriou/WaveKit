import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, prim, seg, str, textGlyphs } from "./common.js"

/** ITU-R M.1371 ship and cargo type → plain words (first digit groups). */
function shipTypeLabel(code: number): string | undefined {
	const exact: Readonly<Record<number, string>> = {
		30: "fishing",
		31: "towing",
		32: "towing",
		33: "dredging",
		34: "diving",
		35: "military",
		36: "sailing",
		37: "pleasure",
		50: "pilot",
		51: "search and rescue",
		52: "tug",
		53: "port tender",
		54: "anti-pollution",
		55: "law enforcement",
		58: "medical",
	}
	const known = exact[code]
	if (known !== undefined) return known
	if (code >= 20 && code <= 29) return "wing in ground"
	if (code >= 40 && code <= 49) return "high speed craft"
	if (code >= 60 && code <= 69) return "passenger"
	if (code >= 70 && code <= 79) return "cargo"
	if (code >= 80 && code <= 89) return "tanker"
	if (code >= 90 && code <= 99) return "other type"
	return undefined
}

const NAV_STATUS: Readonly<Record<number, string>> = {
	0: "under way using engine",
	1: "at anchor",
	2: "not under command",
	3: "restricted manoeuvrability",
	4: "constrained by draught",
	5: "moored",
	6: "aground",
	7: "engaged in fishing",
	8: "under way sailing",
	14: "AIS-SART active",
}

export function isAisShape(data: unknown): boolean {
	return prim(asObj(data), "mmsi") !== undefined
}

/** ais-catcher emits type "ship" with ShipData (name, sog, shipType code, callsign, destination). */
export function formatAis(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const mmsi = prim(o, "mmsi") ?? "?"
	const name = (str(o, "name") ?? str(o, "shipname"))?.trim()
	const code = num(o, "shipType") ?? num(o, "shiptype")
	const codeLabel = code !== undefined ? shipTypeLabel(code) : undefined
	const kind = codeLabel ?? str(o, "shiptype_text") ?? str(o, "shipType")
	const callsign = str(o, "callsign")?.trim()
	const destination = str(o, "destination")?.trim()
	const lat = num(o, "lat")
	const lon = num(o, "lon")
	const sog = num(o, "sog") ?? num(o, "speed")
	const cog = num(o, "cog")
	const status = num(o, "navStatus")
	const statusText = status !== undefined ? NAV_STATUS[status] : undefined
	const imo = prim(o, "imo")
	const draught = num(o, "draught")
	const pos =
		lat !== undefined && lon !== undefined
			? {
					short: `${lat.toFixed(2)},${lon.toFixed(2)}`,
					long: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
				}
			: undefined
	const segments = [
		seg(mmsi, 0),
		...(name ? [seg(name, 1)] : []),
		...(kind ? [seg(kind, 3)] : []),
		...(pos ? [seg(pos.short, 2)] : []),
		...(sog !== undefined ? [seg(`${sog.toFixed(1)} kn`, 4)] : []),
		...(callsign ? [seg(callsign, 5)] : []),
		...(destination ? [seg(`dest ${destination}`, 6)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "mmsi", value: mmsi },
		...(name ? [{ label: "name", value: name }] : []),
		...(callsign ? [{ label: "callsign", value: callsign }] : []),
		...(imo !== undefined ? [{ label: "imo", value: imo }] : []),
		...(kind
			? [
					{
						label: "type",
						value: code !== undefined && codeLabel ? `${kind} (${code})` : kind,
					},
				]
			: []),
		...(statusText ? [{ label: "status", value: statusText }] : []),
		...(pos ? [{ label: "position", value: pos.long }] : []),
		...(sog !== undefined
			? [{ label: "speed", value: `${sog.toFixed(1)} kn` }]
			: []),
		...(cog !== undefined
			? [{ label: "course", value: `${Math.round(cog)}${textGlyphs().degree}` }]
			: []),
		...(destination ? [{ label: "destination", value: destination }] : []),
		...(draught !== undefined
			? [{ label: "draught", value: `${draught} m` }]
			: []),
	]
	return finish(decoderId, type, "AIS", "data", segments, fields)
}
