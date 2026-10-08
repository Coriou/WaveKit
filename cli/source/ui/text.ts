import type { Line, Span } from "./line.js"
import { glyphs } from "./theme.js"

// CSI, OSC (BEL or ST terminated) and 2-byte ESC sequences.
const ANSI_RE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/gu
const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}\u200B-\u200F\uFE00-\uFE0F]$/u

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	)
}

export function charWidth(ch: string): 0 | 1 | 2 {
	if (ZERO_WIDTH_RE.test(ch)) return 0
	const cp = ch.codePointAt(0) ?? 0
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
	return isWide(cp) ? 2 : 1
}

export function cellWidth(s: string): number {
	let w = 0
	for (const ch of stripAnsi(s)) w += charWidth(ch)
	return w
}

/** Payload strings only: strip ESC sequences and C0/C1/DEL, tabs → space, emoji → "?". Idempotent. */
export function sanitize(s: string): string {
	// Order matters for idempotence: removing a control could otherwise join a
	// pictograph and U+FE0F into a new emoji sequence.
	return s.replace(/\t/g, " ").replace(CONTROL_RE, "").replace(EMOJI_RE, "?")
}

/** Width ≤ w; ends with the ellipsis glyph iff the input was wider than w. */
export function truncate(s: string, w: number): string {
	if (w <= 0) return ""
	if (cellWidth(s) <= w) return s
	const ell = glyphs().ellipsis
	const ellW = cellWidth(ell)
	if (ellW > w) return ".".repeat(w)
	let out = ""
	let used = 0
	for (const ch of s) {
		const cw = charWidth(ch)
		if (used + cw > w - ellW) break
		out += ch
		used += cw
	}
	return out + ell
}

export function padEnd(s: string, w: number): string {
	const t = truncate(s, w)
	return t + " ".repeat(Math.max(0, w - cellWidth(t)))
}

export function padStart(s: string, w: number): string {
	const t = truncate(s, w)
	return " ".repeat(Math.max(0, w - cellWidth(t))) + t
}

export function lineWidth(line: Line): number {
	let w = 0
	for (const s of line) w += cellWidth(s.text)
	return w
}

export function lineText(line: Line): string {
	return line.map(s => s.text).join("")
}

/** Cut a span line to width w, ending in the ellipsis glyph when it was wider. */
export function truncateLine(line: Line, w: number): Line {
	if (lineWidth(line) <= w) return line
	const ell = glyphs().ellipsis
	const budget = w - cellWidth(ell)
	const out: Span[] = []
	let used = 0
	for (const span of line) {
		const sw = cellWidth(span.text)
		if (used + sw <= budget) {
			out.push(span)
			used += sw
			continue
		}
		let part = ""
		for (const ch of span.text) {
			const cw = charWidth(ch)
			if (used + cw > budget) break
			part += ch
			used += cw
		}
		if (part !== "") out.push({ ...span, text: part })
		const last = out[out.length - 1]
		out.push({
			text: budget < 0 ? ".".repeat(w) : ell,
			role: last?.role ?? span.role,
		})
		return out
	}
	return out
}

/** Pad a line with trailing spaces to exactly w (truncating first if wider). */
export function padLine(line: Line, w: number): Line {
	const cut = truncateLine(line, w)
	const gap = w - lineWidth(cut)
	return gap > 0 ? [...cut, { text: " ".repeat(gap), role: "value" }] : cut
}
