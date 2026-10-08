import { sp, type Line } from "../ui/line.js"
import { cellWidth, padEnd, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

export const LABEL_WIDTH = 10

/** Label/value row that wraps on " · " boundaries; continuation rows are indented under the value (spec §8: the detail pane wraps). */
export function wrapKV(
	label: string,
	text: string,
	width: number,
	bold = false,
): Line[] {
	const sep = ` ${glyphs().sep} `
	const room = Math.max(1, width - LABEL_WIDTH)
	const rows: string[] = []
	let cur = ""
	for (const part of text.split(sep)) {
		const next = cur === "" ? part : `${cur}${sep}${part}`
		if (cellWidth(next) <= room || cur === "") cur = next
		else {
			rows.push(cur)
			cur = part
		}
	}
	rows.push(cur)
	return rows.map((r, i) => [
		sp(
			i === 0 ? padEnd(label, LABEL_WIDTH) : " ".repeat(LABEL_WIDTH),
			i === 0 && bold ? "value" : "label",
			i === 0 && bold,
		),
		sp(truncate(r, room)),
	])
}

/** 30 one-minute buckets; unobserved minutes are blank, not ▁ (spec §6.2). */
export function sparkline(buckets: ReadonlyArray<number | undefined>): string {
	const levels = glyphs().spark
	const max = Math.max(
		0,
		...buckets.filter((b): b is number => b !== undefined),
	)
	return buckets
		.map(b => {
			if (b === undefined) return " "
			if (max === 0) return levels[0] ?? " "
			const i = Math.round((b / max) * (levels.length - 1))
			return levels[Math.min(levels.length - 1, i)] ?? " "
		})
		.join("")
}
