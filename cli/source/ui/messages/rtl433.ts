import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, prim, seg, str, textGlyphs } from "./common.js"

export function isRtl433Shape(data: unknown): boolean {
	return str(asObj(data), "model") !== undefined
}

/** rtl433 emits type "signal" with rtl_433's own JSON (model, id, channel, readings). */
export function formatRtl433(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const model = str(o, "model") ?? "?"
	const id = prim(o, "id")
	const channel = prim(o, "channel")
	const temp = num(o, "temperature_C")
	const hum = num(o, "humidity")
	const battery = num(o, "battery_ok")
	const tempText =
		temp !== undefined ? `${temp.toFixed(1)}${textGlyphs().degree}C` : undefined
	const segments = [
		seg(model, 0),
		...(id !== undefined ? [seg(`#${id}`, 1)] : []),
		...(channel !== undefined ? [seg(`ch ${channel}`, 4)] : []),
		...(tempText !== undefined ? [seg(tempText, 2)] : []),
		...(hum !== undefined ? [seg(`${hum}%`, 3)] : []),
		...(battery === 0 ? [seg("battery low", 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "model", value: model },
		...(id !== undefined ? [{ label: "id", value: id }] : []),
		...(channel !== undefined ? [{ label: "channel", value: channel }] : []),
		...(tempText !== undefined
			? [{ label: "temperature", value: tempText }]
			: []),
		...(hum !== undefined ? [{ label: "humidity", value: `${hum}%` }] : []),
		...(battery === 0 ? [{ label: "battery", value: "low" }] : []),
	]
	return finish(decoderId, type, "433", "data", segments, fields)
}
