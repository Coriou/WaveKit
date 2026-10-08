import { isNum, isObj, isStr, type Obj } from "../../data/guards.js"
import type {
	FormattedMessage,
	MessageCategory,
	MessageSegment,
} from "../../data/types.js"
import { sanitize } from "../text.js"

export const MAX_TEXT = 2000
export const MAX_SEARCH = 4000

/** Sanitise and bound a payload string (slice first so a 100 KB string costs little). */
export function clip(s: string, max = MAX_TEXT): string {
	const t = sanitize(s.length > max * 2 ? s.slice(0, max * 2) : s)
	return t.length > max ? t.slice(0, max) : t
}

export function seg(
	text: string,
	priority: number,
	role?: MessageSegment["role"],
): MessageSegment {
	return role
		? { text: clip(text, 200), priority, role }
		: { text: clip(text, 200), priority }
}

export function obj(o: Obj, key: string): Obj {
	const v = o[key]
	return isObj(v) ? v : {}
}

export function str(o: Obj, key: string): string | undefined {
	const v = o[key]
	return isStr(v) ? v : undefined
}

export function num(o: Obj, key: string): number | undefined {
	const v = o[key]
	return isNum(v) ? v : undefined
}

export function asObj(data: unknown): Obj {
	return isObj(data) ? data : {}
}

export function finish(
	decoderId: string,
	type: string,
	protocol: string,
	category: MessageCategory,
	segments: MessageSegment[],
	fields: FormattedMessage["fields"],
	extra: { text?: string; emergency?: boolean } = {},
): FormattedMessage {
	const text = extra.text !== undefined ? clip(extra.text) : undefined
	const search = [
		decoderId,
		protocol,
		type,
		...segments.map(s => s.text),
		text ?? "",
	]
		.join(" ")
		.toLowerCase()
	return {
		protocol: clip(protocol, 8),
		category,
		segments,
		fields: fields.map(f => ({ ...f, value: clip(f.value, 400) })),
		emergency: extra.emergency ?? false,
		searchText: clip(search, MAX_SEARCH),
		...(text !== undefined && text !== "" ? { text } : {}),
	}
}
