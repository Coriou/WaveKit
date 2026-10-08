import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, obj, seg, str } from "./common.js"

export function formatAcars(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const vdl = obj(obj(obj(o, "vdl2"), "avlc"), "acars")
	const a = Object.keys(vdl).length > 0 ? vdl : o
	const protocol =
		type === "vdl2" || decoderId === "dumpvdl2" ? "VDL2" : "ACARS"
	const reg = str(a, "tail") ?? str(a, "reg")
	const flight = str(a, "flight")?.trim()
	const label = str(a, "label")
	const freq = num(o, "freq")
	const text = str(a, "text") ?? str(a, "msg_text")
	const segments = [
		...(reg ? [seg(reg, 0)] : []),
		...(flight ? [seg(flight, 1)] : []),
		...(label ? [seg(label, 2)] : []),
		...(freq !== undefined ? [seg(`${freq.toFixed(3)} MHz`, 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		...(reg ? [{ label: "reg", value: reg }] : []),
		...(flight ? [{ label: "flight", value: flight }] : []),
		...(label ? [{ label: "label", value: label }] : []),
	]
	return finish(
		decoderId,
		type,
		protocol,
		"aircraft",
		segments,
		fields,
		text !== undefined ? { text } : {},
	)
}
