import { isNum, isObj, isStr, type Obj } from "../../data/guards.js"
import type {
	FormattedMessage,
	MessageCategory,
	MessageSegment,
} from "../../data/types.js"
import { sanitize } from "../text.js"
import { ASCII_GLYPHS, glyphs } from "../theme.js"

export const MAX_TEXT = 2000
export const MAX_SEARCH = 4000

/** Cut to at most `max` UTF-16 units without leaving a lone high surrogate. */
function cutAt(s: string, max: number): string {
	if (s.length <= max) return s
	const cut = s.slice(0, max)
	const last = cut.charCodeAt(cut.length - 1)
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** Sanitise and bound a payload string (slice first so a 100 KB string costs little). */
export function clip(s: string, max = MAX_TEXT): string {
	return cutAt(sanitize(cutAt(s, max * 2)), max)
}

/** Non-glyph-table symbols, swapped for ASCII in ASCII glyph mode (R32). */
export function textGlyphs(): { arrow: string; degree: string } {
	return glyphs() === ASCII_GLYPHS
		? { arrow: "->", degree: "" }
		: { arrow: "→", degree: "°" }
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

/** A string or finite number as text; objects, arrays and the rest are absent (never "[object Object]"). */
export function prim(o: Obj, key: string): string | undefined {
	const v = o[key]
	if (isStr(v)) return v
	return isNum(v) ? String(v) : undefined
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
