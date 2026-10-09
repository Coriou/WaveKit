import type { Line, Span } from "./line.js"
import { glyphs } from "./theme.js"

// CSI, OSC (BEL or ST terminated) and 2-byte ESC sequences.
const ANSI_RE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// C0, DEL, C1, plus bidi marks/embeddings/overrides/isolates and the Unicode
// line/paragraph separators (hostile-payload vectors that reorder or break rows).
const CONTROL_RE =
	/[\u0000-\u001f\u007f-\u009f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g
/** Non-global, so `.test()` is stateless; copy-rules reuses it. */
export const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u
const EMOJI_RE = new RegExp(EMOJI.source, "gu")
const EMOJI_PRESENTATION_RE = /^\p{Emoji_Presentation}$/u
const ZERO_WIDTH_RE =
	/^[\p{Mn}\p{Me}\u00AD\u200B-\u200F\u2060\uFE00-\uFE0F\uFEFF]$/u

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
		(cp >= 0x1f680 && cp <= 0x1f6ff) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x1fa70 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	)
}

export function charWidth(ch: string): 0 | 1 | 2 {
	if (ZERO_WIDTH_RE.test(ch)) return 0
	const cp = ch.codePointAt(0) ?? 0
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
	return isWide(cp) || EMOJI_PRESENTATION_RE.test(ch) ? 2 : 1
}

export function cellWidth(s: string): number {
	let w = 0
	for (const ch of stripAnsi(s)) w += charWidth(ch)
	return w
}

const ESC = 0x1b
const C1_CSI = 0x9b
/** DCS, SOS, OSC, PM, APC: string introducers ended by BEL or ST. */
const C1_STRINGS: ReadonlySet<number> = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f])
const ESC_STRINGS = "]PX^_"

const isIntroducer = (c: number): boolean =>
	c === ESC || c === C1_CSI || C1_STRINGS.has(c)

/**
 * Remove whole terminal sequences (R27) in one linear pass: CSI (`ESC [` or
 * 0x9B, then params, intermediates and a final byte) and OSC/DCS/SOS/PM/APC
 * strings ended by BEL, ST, the next ESC or the end. A run of introducers is
 * one nested sequence: its bodies are consumed innermost-first, so
 * `ESC ESC[0m [2J` leaves nothing and `ESC×k + "[m"×k` costs O(k), not O(k²).
 * `steps` counts loop iterations so tests can assert linearity without timing.
 */
export function stripSequences(s: string): { text: string; steps: number } {
	const n = s.length
	const parts: string[] = []
	let i = 0
	let steps = 0
	const at = (k: number): number => (k < n ? s.charCodeAt(k) : -1)
	/** Advance over code units in [lo, hi]; at most `max` of them. */
	const skipRange = (lo: number, hi: number, max = Infinity): void => {
		let taken = 0
		while (taken < max && at(i) >= lo && at(i) <= hi) {
			i++
			taken++
			steps++
		}
	}
	const csiBody = (): void => {
		skipRange(0x30, 0x3f) // parameters
		skipRange(0x20, 0x2f) // intermediates
		skipRange(0x40, 0x7e, 1) // final byte
	}
	const stringBody = (): void => {
		while (i < n) {
			steps++
			const c = at(i)
			if (c === 0x07 || c === 0x9c) {
				i++
				return
			}
			if (c === ESC) {
				if (s[i + 1] === "\\") i += 2
				return
			}
			i++
		}
	}
	while (i < n) {
		const start = i
		while (i < n && !isIntroducer(at(i))) {
			i++
			steps++
		}
		if (i > start) parts.push(s.slice(start, i))
		const runStart = i
		while (i < n && isIntroducer(at(i))) {
			i++
			steps++
		}
		for (let k = i - 1; k >= runStart; k--) {
			steps++
			const intro = s.charCodeAt(k)
			if (intro === C1_CSI) csiBody()
			else if (intro !== ESC) stringBody()
			else if (s[i] === "[") {
				i++
				csiBody()
			} else if (ESC_STRINGS.includes(s[i] ?? "[")) {
				i++
				stringBody()
			} else break
		}
	}
	return { text: parts.join(""), steps }
}

/** Tabs → space, then C0/C1/DEL, bidi and U+2028/9 removed, then emoji → "?". */
function clean(t: string): string {
	// Order matters for idempotence: removing a control could otherwise join a
	// pictograph and U+FE0F into a new emoji sequence.
	return t.replace(/\t/g, " ").replace(CONTROL_RE, "").replace(EMOJI_RE, "?")
}

/**
 * Payload strings for one row: strip ESC sequences, a run of line breaks
 * becomes one space (R76: "END\nPOS" reads "END POS"), then C0/C1/DEL, bidi
 * controls and U+2028/9 go, tabs → space, emoji → "?". Idempotent.
 */
export function sanitize(s: string): string {
	return clean(stripSequences(s).text.replace(/[\r\n]+/g, " "))
}

/** Like sanitize, but keeps line breaks (CR LF and CR become "\n") for bodies that wrap per line (R76). Idempotent. */
export function sanitizeMultiline(s: string): string {
	return stripSequences(s)
		.text.replace(/\r\n?/g, "\n")
		.split("\n")
		.map(clean)
		.join("\n")
}

/** Width ≤ w; ends with the ellipsis glyph iff the input was wider than w. */
export function truncate(s: string, w: number): string {
	if (w <= 0) return ""
	if (cellWidth(s) <= w) return s
	const ell = glyphs().ellipsis
	const ellW = cellWidth(ell)
	// Accepted: in ASCII mode below 3 columns the result is dots without "...".
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
	if (w <= 0) return []
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
		const from = out[out.length - 1] ?? span
		out.push({
			text: budget < 0 ? ".".repeat(w) : ell,
			role: from.role,
			...(from.bold !== undefined ? { bold: from.bold } : {}),
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
