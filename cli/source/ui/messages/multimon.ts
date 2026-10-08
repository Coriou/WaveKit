import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, prim, seg, str, textGlyphs } from "./common.js"

/** multimon-ng non-pager output: type "decode" (DTMF, AFSK1200, FSK9600) and type "message" for EAS. */
export function isMultimonDecodeShape(type: string, data: unknown): boolean {
	const p = str(asObj(data), "protocol")
	if (p === undefined) return false
	return type === "decode" || (type === "message" && p.toUpperCase() === "EAS")
}

export function formatMultimonDecode(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const protocol = (str(o, "protocol") ?? "?").toUpperCase()
	const digits = prim(o, "digits")
	const from = str(o, "from")
	const to = str(o, "to")
	const via = str(o, "via")?.trim()
	const segments = [
		...(digits !== undefined ? [seg(digits, 0)] : []),
		...(from !== undefined || to !== undefined
			? [seg(`${from ?? "?"}${textGlyphs().arrow}${to ?? "?"}`, 0)]
			: []),
		...(via ? [seg(`via ${via}`, 2)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "protocol", value: protocol },
		...(digits !== undefined ? [{ label: "digits", value: digits }] : []),
		...(from ? [{ label: "from", value: from }] : []),
		...(to ? [{ label: "to", value: to }] : []),
		...(via ? [{ label: "via", value: via }] : []),
	]
	const text = str(o, "rawData") ?? str(o, "rawMessage")
	return finish(
		decoderId,
		type,
		protocol,
		"data",
		segments,
		fields,
		text !== undefined ? { text } : {},
	)
}
