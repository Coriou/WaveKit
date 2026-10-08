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
