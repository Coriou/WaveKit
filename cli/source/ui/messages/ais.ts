import { isNum, isStr } from "../../data/guards.js"
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, seg, str } from "./common.js"

export function isAisShape(data: unknown): boolean {
	const m = asObj(data)["mmsi"]
	return isNum(m) || isStr(m)
}

export function formatAis(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const mmsi = String(o["mmsi"] ?? "?")
	const name = str(o, "shipname")?.trim()
	const kind =
		str(o, "shiptype_text") ?? (isStr(o["type"]) ? o["type"] : undefined)
	const lat = num(o, "lat")
	const lon = num(o, "lon")
	const speed = num(o, "speed")
	const segments = [
		seg(mmsi, 0),
		...(name ? [seg(name, 1)] : []),
		...(kind ? [seg(kind, 3)] : []),
		...(lat !== undefined && lon !== undefined
			? [seg(`${lat.toFixed(2)},${lon.toFixed(2)}`, 2)]
			: []),
		...(speed !== undefined ? [seg(`${speed.toFixed(1)} kn`, 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "mmsi", value: mmsi },
		...(name ? [{ label: "name", value: name }] : []),
		...(kind ? [{ label: "type", value: kind }] : []),
		...(lat !== undefined && lon !== undefined
			? [{ label: "position", value: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }]
			: []),
	]
	return finish(decoderId, type, "AIS", "data", segments, fields)
}
