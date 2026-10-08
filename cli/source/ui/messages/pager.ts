import { isNum, isStr } from "../../data/guards.js"
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, seg, str } from "./common.js"

export function formatPager(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const proto = str(o, "protocol") ?? ""
	const protocol = type === "flex" || /flex/i.test(proto) ? "FLEX" : "POCSAG"
	const rawAddress = str(o, "capcode") ?? o["address"]
	const address =
		isStr(rawAddress) || isNum(rawAddress) ? String(rawAddress) : undefined
	const fn = o["function"]
	const fnText = isStr(fn) || isNum(fn) ? String(fn) : undefined
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
