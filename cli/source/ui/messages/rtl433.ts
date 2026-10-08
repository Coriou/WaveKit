import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, seg, str } from "./common.js"

export function isRtl433Shape(data: unknown): boolean {
	return str(asObj(data), "model") !== undefined
}

export function formatRtl433(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const model = str(o, "model") ?? "?"
	const id = o["id"]
	const temp = num(o, "temperature_C")
	const hum = num(o, "humidity")
	const battery = num(o, "battery_ok")
	const segments = [
		seg(model, 0),
		...(id !== undefined && id !== null ? [seg(`#${String(id)}`, 1)] : []),
		...(temp !== undefined ? [seg(`${temp.toFixed(1)}°C`, 2)] : []),
		...(hum !== undefined ? [seg(`${hum}%`, 3)] : []),
		...(battery === 0 ? [seg("battery low", 4)] : []),
	]
	return finish(decoderId, type, "433", "data", segments, [
		{ label: "model", value: model },
	])
}
