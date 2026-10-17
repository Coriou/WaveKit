// The Map's colours (docs/web/canvas/Map.dc.html, MAP / SEA_LAND / COL / ALT; DESIGN.md "Map on Paper"). Data
// colours are fixed per theme and never follow the accent; the ground (sea, land) follows the theme's ground and,
// on Ink, the accent's tint; hairlines take --wk-line-rgb, the station and coverage take --wk-accent-rgb.

export interface ThemeKey {
	readonly theme: "dark" | "light"
	readonly ground: string
	readonly accent: string
}

/** Tokens read from the theme scope (computed style); fallbacks are the phosphor Ink values. */
export interface ThemeTokens {
	readonly accentRgb: string
	readonly lineRgb: string
	readonly text: string
	readonly text3: string
	readonly text4: string
	readonly text5: string
	readonly textSoft: string
	readonly inkRgb: string
	readonly amber: string
	readonly font: string
}

export const FALLBACK_TOKENS: ThemeTokens = {
	accentRgb: "123,236,199",
	lineRgb: "123,236,199",
	text: "#f4f7f5",
	text3: "#8ba598",
	text4: "#758b81",
	text5: "#52645d",
	textSoft: "#d9e4de",
	inkRgb: "244,247,245",
	amber: "#f2b84b",
	font: "sans-serif",
}

/** Five altitude steps (ground, 10 000 ft, FL200, FL300, FL400+), distinct in lightness as well as hue. */
export const ALT_STEPS_FT = [0, 10_000, 20_000, 30_000, 40_000] as const
const ALT_DARK = [
	"#f2a14b",
	"#e8d16a",
	"#7becc7",
	"#9fd8ff",
	"#f4f7f5",
] as const
/** Paper: same order, each ≥ 3:1 on paper land and chart sea. */
const ALT_LIGHT = [
	"#b4560c",
	"#7f6a00",
	"#0b7657",
	"#1d5fa8",
	"#2a241c",
] as const

/** The altitude step 0–4 for feet (null altitude counts as ground). */
export function altStep(ft: number | null): number {
	if (ft === null) return 0
	for (let i = ALT_STEPS_FT.length - 1; i >= 0; i--)
		if (ft >= (ALT_STEPS_FT[i] ?? 0)) return i
	return 0
}

export function altColours(light: boolean): readonly string[] {
	return light ? ALT_LIGHT : ALT_DARK
}

export interface DataColours {
	readonly vessel: string
	readonly aprs: string
	readonly mesh: string
	readonly acars: string
}

const DATA_DARK: DataColours = {
	vessel: "#22a8bf",
	aprs: "#f4f7f5",
	mesh: "#c9a8ff",
	acars: "#f2b84b",
}
const DATA_LIGHT: DataColours = {
	vessel: "#00838f",
	aprs: "#2a241c",
	mesh: "#6a3fc2",
	acars: "#7a4f00",
}

export interface MapPalette {
	readonly light: boolean
	readonly sea: string
	readonly land: string
	readonly grid: string
	readonly coast: string
	readonly coastW: number
	/** Dark grounds: a soft halo under the coastline; null on Paper. */
	readonly coastHalo: string | null
	/** Paper only: the shallow-water band along the shore. */
	readonly shallow: string | null
	readonly ring: string
	readonly ringText: string
	readonly covAdsb: { line: string; fill: string }
	readonly covAis: { line: string; fill: string }
	readonly linkHi: string
	readonly linkLo: string
	readonly selRing: string
	/** The dark outline around glyphs (map ground colour). */
	readonly outline: string
	/** The hole in an APRS dot. */
	readonly hole: string
	readonly apxRing: string
	readonly apxFill: string
	readonly apxDot: string
	readonly station: string
	readonly stationFill: string
	readonly place: string
	readonly placeHalo: string
	readonly labelBox: string
	readonly airText: string
	readonly data: DataColours
	readonly alt: readonly string[]
	readonly font: string
}

// Dark grounds other than Ink + phosphor: [sea, land]. Ink takes the accent's tint, graphite is neutral, black is
// #000 sea with near-black land.
const SEA_LAND: Readonly<Record<string, readonly [string, string]>> = {
	ice: ["#0a0f14", "#111921"],
	violet: ["#0f0d14", "#18161f"],
	coral: ["#130c0f", "#1e1519"],
	mono: ["#0d0f10", "#16191a"],
	graphite: ["#111213", "#1b1c1d"],
	black: ["#000000", "#0b0b0b"],
}

const hexRgb = (h: string) =>
	[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(",")

export function mapPalette(key: ThemeKey, tokens: ThemeTokens): MapPalette {
	const A = tokens.accentRgb
	const L = tokens.lineRgb
	if (key.theme === "light")
		return {
			light: true,
			sea: "#d9e3e6",
			land: "#f4f0e6",
			grid: "rgba(42,36,28,0.05)",
			coast: "rgba(42,36,28,0.72)",
			coastW: 0.9,
			coastHalo: null,
			shallow: "rgba(96,140,162,0.16)",
			ring: "rgba(42,36,28,0.32)",
			ringText: "#4a4235",
			covAdsb: { line: `rgba(${A},0.55)`, fill: `rgba(${A},0.05)` },
			covAis: { line: "rgba(0,131,143,0.5)", fill: "rgba(0,131,143,0.05)" },
			linkHi: "rgba(106,63,194,0.6)",
			linkLo: "rgba(106,63,194,0.3)",
			selRing: "rgba(42,36,28,0.85)",
			outline: "rgba(251,248,241,0.95)",
			hole: "#fbf8f1",
			apxRing: "rgba(201,138,18,0.8)",
			apxFill: "rgba(201,138,18,0.1)",
			apxDot: "#7a4f00",
			station: `rgb(${A})`,
			stationFill: "#fbf8f1",
			place: "#4a4235",
			placeHalo: "rgba(244,240,230,0.92)",
			labelBox: "rgba(251,248,241,0.9)",
			airText: "#2a241c",
			data: DATA_LIGHT,
			alt: ALT_LIGHT,
			font: tokens.font,
		}
	const pick =
		key.ground === "graphite" || key.ground === "black"
			? key.ground
			: key.accent === "phosphor" || !SEA_LAND[key.accent]
				? null
				: key.accent
	const pair = pick ? SEA_LAND[pick] : undefined
	const sea = pair?.[0] ?? "#08110e"
	const land = pair?.[1] ?? "#0f1c18"
	const sr = hexRgb(sea)
	const tinted = pick === null
	return {
		light: false,
		sea,
		land,
		grid: `rgba(${L},0.045)`,
		coast: `rgba(${L},0.42)`,
		coastW: 1,
		coastHalo: `rgba(${L},0.07)`,
		shallow: null,
		ring: `rgba(${L},0.14)`,
		ringText: `rgba(${A},0.5)`,
		covAdsb: { line: `rgba(${A},0.30)`, fill: `rgba(${A},0.03)` },
		covAis: { line: "rgba(34,168,191,0.4)", fill: "rgba(34,168,191,0.05)" },
		linkHi: "rgba(201,168,255,0.55)",
		linkLo: "rgba(201,168,255,0.25)",
		selRing: tinted ? "rgba(244,247,245,0.9)" : `rgba(${tokens.inkRgb},0.9)`,
		outline: `rgba(${sr},0.9)`,
		hole: sea,
		apxRing: "rgba(242,184,75,0.55)",
		apxFill: "rgba(242,184,75,0.08)",
		apxDot: "#f2b84b",
		station: `rgb(${A})`,
		stationFill: sea,
		place: tinted ? "#6d857a" : tokens.text4,
		placeHalo: `rgba(${sr},0.85)`,
		labelBox: `rgba(${sr},0.78)`,
		airText: tinted ? "#e3ece7" : tokens.textSoft,
		data: DATA_DARK,
		alt: ALT_DARK,
		font: tokens.font,
	}
}

/** Reads the theme tokens from an element inside the theme scope. */
export function readTokens(el: Element): ThemeTokens {
	const cs = getComputedStyle(el)
	const v = (name: string, fallback: string) =>
		cs.getPropertyValue(name).trim() || fallback
	return {
		accentRgb: v("--wk-accent-rgb", FALLBACK_TOKENS.accentRgb),
		lineRgb: v("--wk-line-rgb", FALLBACK_TOKENS.lineRgb),
		text: v("--wk-text", FALLBACK_TOKENS.text),
		text3: v("--wk-text-3", FALLBACK_TOKENS.text3),
		text4: v("--wk-text-4", FALLBACK_TOKENS.text4),
		text5: v("--wk-text-5", FALLBACK_TOKENS.text5),
		textSoft: v("--wk-text-soft", FALLBACK_TOKENS.textSoft),
		inkRgb: v("--wk-ink-rgb", FALLBACK_TOKENS.inkRgb),
		amber: v("--wk-amber", FALLBACK_TOKENS.amber),
		font: v("--wk-font-ui", FALLBACK_TOKENS.font),
	}
}
