import { isStr } from "../../data/guards.js"
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, obj, seg, str, textGlyphs } from "./common.js"

/** direwolf emits type "aprs" with APRSData: source/destination callsigns, path, dataType, optional position, message and weather. */
export function formatAprs(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const source = str(o, "source") ?? "?"
	const destination = str(o, "destination")
	const path = Array.isArray(o["path"]) ? o["path"].filter(isStr) : []
	const dataType = str(o, "dataType")
	const lat = num(o, "lat")
	const lon = num(o, "lon")
	const speed = num(o, "speed")
	const course = num(o, "course")
	const altitude = num(o, "altitude")
	const message = obj(o, "message")
	const addressee = str(message, "addressee")?.trim()
	const wx = obj(o, "weather")
	const tempF = num(wx, "temperature")
	const humidity = num(wx, "humidity")
	const wind = num(wx, "windSpeed")
	const deg = textGlyphs().degree
	const tempC =
		tempF !== undefined
			? `${(((tempF - 32) * 5) / 9).toFixed(1)}${deg}C`
			: undefined
	const segments = [
		seg(source, 0),
		...(addressee ? [seg(`to ${addressee}`, 1)] : []),
		...(dataType ? [seg(dataType, 3)] : []),
		...(lat !== undefined && lon !== undefined
			? [seg(`${lat.toFixed(2)},${lon.toFixed(2)}`, 2)]
			: []),
		...(speed !== undefined ? [seg(`${Math.round(speed)} mph`, 4)] : []),
		...(tempC !== undefined ? [seg(tempC, 2)] : []),
		...(humidity !== undefined ? [seg(`${humidity}%`, 3)] : []),
		...(wind !== undefined ? [seg(`wind ${Math.round(wind)} mph`, 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "from", value: source },
		...(destination ? [{ label: "to", value: destination }] : []),
		...(path.length > 0 ? [{ label: "path", value: path.join(",") }] : []),
		...(dataType ? [{ label: "type", value: dataType }] : []),
		...(lat !== undefined && lon !== undefined
			? [{ label: "position", value: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }]
			: []),
		...(altitude !== undefined
			? [{ label: "altitude", value: `${Math.round(altitude)} ft` }]
			: []),
		...(course !== undefined
			? [{ label: "course", value: `${Math.round(course)}${deg}` }]
			: []),
		...(addressee ? [{ label: "addressee", value: addressee }] : []),
	]
	const text = str(message, "text") ?? str(o, "comment")
	return finish(
		decoderId,
		type,
		"APRS",
		"data",
		segments,
		fields,
		text !== undefined ? { text } : {},
	)
}
