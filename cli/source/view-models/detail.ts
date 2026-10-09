import { sp, type Line } from "../ui/line.js"
import { cellWidth, padEnd, truncate } from "../ui/text.js"
import { ASCII_GLYPHS, glyphs } from "../ui/theme.js"

export const LABEL_WIDTH = 10

/** A part wider than its row is cut; a quoted part is cut inside its quotes, keeping the closing one (R65 M5). */
function fitPart(part: string, room: number): string {
	if (cellWidth(part) <= room) return part
	if (part.endsWith('"') && room >= 3)
		return `${truncate(part.slice(0, -1), room - 1)}"`
	return truncate(part, room)
}

/**
 * Label/value rows that wrap on " · " boundaries; continuation rows are
 * indented under the value column (spec §8: the detail pane wraps). A part
 * wider than a whole row is cut (inside its quotes when quoted). With
 * `wideLabel`, a label longer than the 10-column gutter is shown whole,
 * followed by two spaces (the detail header's decoder id, R65 I5).
 */
export function wrapKV(
	label: string,
	text: string,
	width: number,
	bold = false,
	wideLabel = false,
): Line[] {
	const sep = ` ${glyphs().sep} `
	const labelW = cellWidth(label)
	// N4: an id that leaves under 10 columns for the value gets a row of its own
	// (cut to the pane), and the value wraps under the 10-column gutter.
	if (wideLabel && labelW + 2 > LABEL_WIDTH && width - (labelW + 2) < 10)
		return [
			[sp(truncate(label, Math.max(1, width)), bold ? "value" : "label", bold)],
			...wrapKV("", text, width),
		]
	const firstGutter =
		wideLabel && labelW + 2 > LABEL_WIDTH
			? Math.min(width, labelW + 2)
			: LABEL_WIDTH
	const roomOf = (row: number): number =>
		Math.max(1, width - (row === 0 ? firstGutter : LABEL_WIDTH))
	const rows: string[] = []
	let cur = ""
	for (const part of text.split(sep)) {
		const next = cur === "" ? part : `${cur}${sep}${part}`
		if (cellWidth(next) <= roomOf(rows.length) || cur === "") cur = next
		else {
			rows.push(cur)
			cur = part
		}
	}
	rows.push(cur)
	return rows.map((r, i) => {
		const gutter =
			i > 0
				? " ".repeat(LABEL_WIDTH)
				: firstGutter === LABEL_WIDTH
					? padEnd(label, LABEL_WIDTH)
					: `${truncate(label, Math.max(1, firstGutter - 2))}  `
		const room = roomOf(i)
		const value = r.split(sep).map(p => fitPart(p, room))
		return [
			sp(gutter, i === 0 && bold ? "value" : "label", i === 0 && bold),
			sp(truncate(value.join(sep), room)),
		]
	})
}

/**
 * 30 one-minute buckets; an unobserved minute is a dot, not ▁ (spec §6.2,
 * S3). In ASCII, where "." is a level, it stays blank.
 */
function sparkChars(
	buckets: ReadonlyArray<number | undefined>,
): Array<string | null> {
	const levels = glyphs().spark
	const max = Math.max(
		0,
		...buckets.filter((b): b is number => b !== undefined),
	)
	return buckets.map(b => {
		if (b === undefined) return null
		if (max === 0) return levels[0] ?? " "
		const i = Math.round((b / max) * (levels.length - 1))
		return levels[Math.min(levels.length - 1, i)] ?? " "
	})
}

const unobserved = (): string => (glyphs() === ASCII_GLYPHS ? " " : "·")

export function sparkline(buckets: ReadonlyArray<number | undefined>): string {
	return sparkChars(buckets)
		.map(c => c ?? unobserved())
		.join("")
}

/** The sparkline as spans: unobserved minutes dim (`label`), observed ones plain. */
export function sparkSpans(buckets: ReadonlyArray<number | undefined>): Line {
	const out: Line = []
	for (const c of sparkChars(buckets)) {
		const role = c === null ? "label" : "value"
		const text = c ?? unobserved()
		const prev = out[out.length - 1]
		if (prev && prev.role === role) prev.text += text
		else out.push(sp(text, role))
	}
	return out
}
