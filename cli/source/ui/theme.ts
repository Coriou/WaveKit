import type { Role } from "./line.js"

export interface Glyphs {
	live: string
	neutral: string
	fault: string
	attention: string
	unknown: string
	na: string
	ellipsis: string
	sep: string
	gap: string
	up: string
	down: string
	confirm: string
	cursor: string
	range: string
	/** Final review: every non-ASCII symbol the CLI writes itself has an ASCII form. */
	plusMinus: string
	minus: string
	arrow: string
	times: string
	spark: readonly string[]
}

export const UTF8_GLYPHS: Glyphs = {
	live: "●",
	neutral: "○",
	fault: "×",
	attention: "!",
	unknown: "?",
	na: "—",
	ellipsis: "…",
	sep: "·",
	gap: "─",
	up: "↑",
	down: "↓",
	confirm: "▶",
	cursor: "▏",
	range: "–",
	plusMinus: "±",
	minus: "−",
	arrow: "→",
	times: "×",
	spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
}

export const ASCII_GLYPHS: Glyphs = {
	live: "*",
	neutral: "o",
	fault: "x",
	attention: "!",
	unknown: "?",
	na: "-",
	ellipsis: "...",
	sep: "|",
	gap: "-",
	up: "^",
	down: "v",
	confirm: ">",
	cursor: "|",
	range: "-",
	plusMinus: "+-",
	minus: "-",
	arrow: "->",
	times: "x",
	spark: ["_", ".", "-", "=", "+", "*", "#", "@"],
}

let mode: "utf8" | "ascii" = "utf8"

/** Set once in cli.tsx before rendering; tests reset it to "utf8". */
export function setGlyphMode(next: "utf8" | "ascii"): void {
	mode = next
}

export function glyphs(): Glyphs {
	return mode === "ascii" ? ASCII_GLYPHS : UTF8_GLYPHS
}

type Env = Readonly<Record<string, string | undefined>>

export function detectGlyphMode(env: Env): "utf8" | "ascii" {
	if (env["WAVEKIT_ASCII"] === "1") return "ascii"
	const locale = env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"]
	if (locale === undefined || locale === "") return "utf8"
	return /utf-?8/i.test(locale) ? "utf8" : "ascii"
}

export function detectColor(env: Env, isTTY: boolean): boolean {
	const noColor = env["NO_COLOR"]
	if (noColor !== undefined && noColor !== "") return false
	return isTTY
}

export interface InkTextProps {
	color?: string
	bold?: boolean
	dimColor?: boolean
	inverse?: boolean
}

const ROLE_STYLE: Readonly<Record<Role, InkTextProps>> = {
	label: { dimColor: true },
	value: {},
	live: { color: "green" },
	neutral: {},
	fault: { color: "red" },
	attention: { color: "yellow" },
	unknown: {},
	old: { dimColor: true },
	accent: { color: "cyan" },
	selected: { color: "cyan", inverse: true, bold: true },
	edit: { color: "magenta", bold: true },
}

/** Role → Ink <Text> props. Without colour, keep bold/dim/inverse only (spec §8). */
export function roleProps(
	role: Role,
	color: boolean,
	bold = false,
): InkTextProps {
	const base = ROLE_STYLE[role]
	const out: InkTextProps = {}
	if (color && base.color !== undefined) out.color = base.color
	if (base.dimColor === true) out.dimColor = true
	if (base.inverse === true) out.inverse = true
	if (base.bold === true || bold) out.bold = true
	return out
}

/** Explicit 24-bit capability only; ordinary color support is not sufficient. */
export function spectrumMode(
	env: Env,
	isTTY: boolean,
	depth = 0,
): "truecolor" | "ascii" | "mono" {
	if (detectGlyphMode(env) === "ascii") return "ascii"
	if (
		detectColor(env, isTTY) &&
		(depth >= 24 || /^(truecolor|24bit)$/i.test(env["COLORTERM"] ?? ""))
	)
		return "truecolor"
	return "mono"
}

export const POWER_MIN_DBFS = -120
export const POWER_MAX_DBFS = -20
const PALETTE = [
	"#102030",
	"#204060",
	"#306080",
	"#4080a0",
	"#60a0b0",
	"#90bfc0",
	"#c0ded8",
	"#ffffff",
] as const
/** One pass, max-hold per display cell. Empty cells stay unknown; no invented resolution. */
export function spectrumCells(bins: Uint8Array, width: number): number[] {
	const cols = Math.min(512, Math.max(0, Math.floor(width)))
	return Array.from({ length: cols }, (_, x) => {
		const lo = Math.floor((x * bins.length) / cols)
		const hi = Math.floor(((x + 1) * bins.length) / cols)
		let peak = -1
		for (let i = lo; i < hi; i++) peak = Math.max(peak, bins[i] ?? -1)
		return peak
	})
}
export function powerLevel(byte: number): number {
	return Math.max(
		0,
		Math.min(
			7,
			Math.floor(
				((byte / 2 - 127.5 - POWER_MIN_DBFS) /
					(POWER_MAX_DBFS - POWER_MIN_DBFS)) *
					8,
			),
		),
	)
}
export function powerRamp(cells: readonly number[], ascii: boolean): string {
	const ramp = ascii ? ASCII_GLYPHS.spark : glyphs().spark
	return cells.map(v => (v < 0 ? " " : (ramp[powerLevel(v)] ?? " "))).join("")
}
export interface HalfBlockRun {
	text: string
	foreground: string
	background: string
}
export function halfBlockRuns(
	top: readonly number[],
	bottom: readonly number[],
): HalfBlockRun[] {
	const runs: HalfBlockRun[] = []
	for (let i = 0; i < top.length; i++) {
		const t = top[i] ?? -1,
			b = bottom[i] ?? -1
		const foreground = t < 0 ? "#000000" : (PALETTE[powerLevel(t)] ?? "#000000")
		const background = b < 0 ? "#000000" : (PALETTE[powerLevel(b)] ?? "#000000")
		const prev = runs[runs.length - 1]
		if (prev?.foreground === foreground && prev.background === background)
			prev.text += "▀"
		else runs.push({ text: "▀", foreground, background })
	}
	return runs
}
