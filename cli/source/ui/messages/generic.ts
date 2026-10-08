import type { DecoderOutput } from "@wavekit/api-types"
import type { FormattedMessage } from "../../data/types.js"
import { sanitize } from "../text.js"
import { glyphs } from "../theme.js"
import { asObj, finish, seg, str } from "./common.js"

function compactJson(data: unknown): string {
	try {
		return JSON.stringify(data) ?? String(data)
	} catch {
		return "[unprintable]"
	}
}

export function formatGeneric(
	output: DecoderOutput,
	decoderId: string,
): FormattedMessage {
	const data = output.data
	const o = asObj(data)
	const type = output.type
	if (type === "sync" && str(o, "mode")) {
		return finish(
			decoderId,
			type,
			"SYNC",
			"voice",
			[seg(`sync ${str(o, "mode") ?? ""}`, 0)],
			[],
		)
	}
	const text =
		typeof data === "string" ? data : (str(o, "message") ?? compactJson(data))
	return finish(
		decoderId,
		type,
		type.toUpperCase().slice(0, 6),
		"other",
		[],
		[],
		{ text },
	)
}

/** Pretty JSON for the detail pane: bounded in characters and lines, every line sanitised. */
export function detailJson(
	data: unknown,
	maxLines = 200,
	maxChars = 20_000,
): string[] {
	let s: string
	try {
		s = JSON.stringify(data, null, 2) ?? String(data)
	} catch {
		s = "[unprintable]"
	}
	const truncated = s.length > maxChars
	const lines = (truncated ? s.slice(0, maxChars) : s)
		.split("\n")
		.map(l => sanitize(l))
	const ell = glyphs().ellipsis
	if (lines.length > maxLines) return [...lines.slice(0, maxLines), ell]
	return truncated ? [...lines, ell] : lines
}
