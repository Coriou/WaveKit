// JSON viewer lines (Json board): pretty-printed, one entry per line with its indent and coloured tokens. Pure.

export type JsonTokenKind = "key" | "str" | "num" | "lit" | "punc"

export interface JsonToken {
	s: string
	k: JsonTokenKind
}

export interface JsonLine {
	n: number
	/** Leading spaces, drawn as padding so wrapped text keeps its indent. */
	indent: number
	tokens: JsonToken[]
}

const RE =
	/("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g

export function tokenize(line: string): JsonToken[] {
	const out: JsonToken[] = []
	let last = 0
	RE.lastIndex = 0
	for (let m = RE.exec(line); m; m = RE.exec(line)) {
		if (m.index > last) out.push({ s: line.slice(last, m.index), k: "punc" })
		if (m[1] !== undefined) {
			out.push({ s: m[1], k: m[2] !== undefined ? "key" : "str" })
			if (m[2] !== undefined) out.push({ s: m[2], k: "punc" })
		} else if (m[3] !== undefined) out.push({ s: m[3], k: "num" })
		else if (m[4] !== undefined) out.push({ s: m[4], k: "lit" })
		else out.push({ s: m[5] ?? "", k: "punc" })
		last = RE.lastIndex
	}
	if (last < line.length) out.push({ s: line.slice(last), k: "punc" })
	return out
}

/** At most this many lines are drawn; the copy buttons still carry the whole document. */
export const MAX_LINES = 1500

export function jsonLines(text: string): { lines: JsonLine[]; total: number } {
	const raw = text.split("\n")
	const lines = raw.slice(0, MAX_LINES).map((l, i) => {
		const body = l.trimStart()
		return { n: i + 1, indent: l.length - body.length, tokens: tokenize(body) }
	})
	return { lines, total: raw.length }
}

/** "12 lines · 318 B" (UTF-8 bytes). */
export function jsonMeta(text: string, total: number): string {
	const bytes = new TextEncoder().encode(text).length
	const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
	return `${total} line${total === 1 ? "" : "s"} · ${size}`
}
