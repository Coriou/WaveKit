import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, prim, seg, str } from "./common.js"

/**
 * multimon-ng emits POCSAG and FLEX as type "message" (protocol "POCSAG1200",
 * "FLEX", …). Also accept a protocol-less message with an address or capcode.
 */
export function isPagerShape(data: unknown): boolean {
	const o = asObj(data)
	const p = str(o, "protocol")
	if (p !== undefined) return /^(pocsag|flex)/i.test(p)
	return (
		str(o, "message") !== undefined &&
		(prim(o, "address") !== undefined || prim(o, "capcode") !== undefined)
	)
}

export function formatPager(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const proto = str(o, "protocol") ?? ""
	const protocol = type === "flex" || /flex/i.test(proto) ? "FLEX" : "POCSAG"
	const address = prim(o, "capcode") ?? prim(o, "address")
	const fnText = prim(o, "function")
	const mtype = str(o, "messageType")
	const typeLabel =
		mtype === undefined || /^alpha$/i.test(mtype)
			? undefined
			: /^numeric$/i.test(mtype)
				? "numeric"
				: mtype
	const segments = [
		...(address ? [seg(address, 0)] : []),
		...(fnText !== undefined ? [seg(`fn ${fnText}`, 2)] : []),
		...(typeLabel ? [seg(typeLabel, 3)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		...(address ? [{ label: "address", value: address }] : []),
		...(fnText !== undefined ? [{ label: "function", value: fnText }] : []),
		...(mtype ? [{ label: "type", value: mtype }] : []),
	]
	const message = str(o, "message")
	return finish(
		decoderId,
		type,
		protocol,
		"pager",
		segments,
		fields,
		message !== undefined ? { text: message } : {},
	)
}
