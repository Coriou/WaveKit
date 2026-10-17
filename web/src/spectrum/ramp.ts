/** Colour ramps for the waterfall and trace: 256 RGBA entries (a 256×1 texture). */

export type Rgba = [number, number, number, number]

export interface RampStop {
	/** 0–1 */
	at: number
	color: Rgba
}

export const RAMP_SIZE = 256

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba() (comma or space syntax); null otherwise. */
export function parseCssColor(input: string): Rgba | null {
	const s = input.trim().toLowerCase()
	if (s.startsWith("#")) {
		const hex = s.slice(1)
		if (!/^[0-9a-f]+$/.test(hex)) return null
		if (hex.length === 3 || hex.length === 4) {
			const c = [...hex].map(h => parseInt(h + h, 16))
			return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 255]
		}
		if (hex.length === 6 || hex.length === 8) {
			const c = [0, 2, 4, 6].map(i =>
				i < hex.length ? parseInt(hex.slice(i, i + 2), 16) : 255,
			)
			return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 255]
		}
		return null
	}
	const m = /^rgba?\(([^)]*)\)$/.exec(s)
	if (!m) return null
	const parts = (m[1] ?? "").split(/[\s,/]+/).filter(p => p.length > 0)
	if (parts.length < 3 || parts.length > 4) return null
	const channel = (p: string) =>
		p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p)
	const r = channel(parts[0] ?? "")
	const g = channel(parts[1] ?? "")
	const b = channel(parts[2] ?? "")
	const aPart = parts[3]
	const a =
		aPart === undefined
			? 255
			: aPart.endsWith("%")
				? (parseFloat(aPart) / 100) * 255
				: parseFloat(aPart) * 255
	if ([r, g, b, a].some(v => Number.isNaN(v))) return null
	return [r, g, b, a].map(v =>
		Math.round(Math.min(255, Math.max(0, v))),
	) as Rgba
}

export function mix(a: Rgba, b: Rgba, t: number): Rgba {
	return [0, 1, 2, 3].map(i =>
		Math.round((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t),
	) as Rgba
}

/** Interpolates `stops` (sorted by `at`) into 256 RGBA entries. */
export function buildRamp(stops: RampStop[]): Uint8Array {
	const out = new Uint8Array(RAMP_SIZE * 4)
	const sorted = [...stops].sort((x, y) => x.at - y.at)
	const first = sorted[0]
	if (!first) return out
	for (let i = 0; i < RAMP_SIZE; i++) {
		const t = i / (RAMP_SIZE - 1)
		let color = first.color
		for (let k = 0; k < sorted.length; k++) {
			const s = sorted[k] as RampStop
			const next = sorted[k + 1]
			if (t <= s.at) {
				color = s.color
				break
			}
			if (!next) {
				color = s.color
				break
			}
			if (t <= next.at) {
				const span = next.at - s.at
				color = mix(s.color, next.color, span > 0 ? (t - s.at) / span : 1)
				break
			}
		}
		out.set(color, i * 4)
	}
	return out
}

export interface ThemeColors {
	plotBg: Rgba
	accent: Rgba
	text: Rgba
	/** --wk-ink-rgb: the strongest marks (text colour without alpha). Defaults to `text`. */
	ink?: Rgba
	/** Paper (light theme): strong signals are the darkest marks. */
	light?: boolean
}

export const WATERFALL_NAMES = ["match", "amber", "mono", "classic"] as const
export type WaterfallName = (typeof WATERFALL_NAMES)[number]

const opaque = (c: Rgba): Rgba => [c[0], c[1], c[2], 255]
const rgb = (r: number, g: number, b: number): Rgba => [r, g, b, 255]

function toHsl(c: Rgba): [number, number, number] {
	const r = c[0] / 255
	const g = c[1] / 255
	const b = c[2] / 255
	const mx = Math.max(r, g, b)
	const mn = Math.min(r, g, b)
	const l = (mx + mn) / 2
	const d = mx - mn
	if (!d) return [0, 0, l]
	const s = d / (1 - Math.abs(2 * l - 1))
	const h =
		mx === r
			? ((g - b) / d + 6) % 6
			: mx === g
				? (b - r) / d + 2
				: (r - g) / d + 4
	return [h * 60, s, l]
}

function fromHsl(h: number, s: number, l: number): Rgba {
	const C = (1 - Math.abs(2 * l - 1)) * s
	const hp = ((((h % 360) + 360) % 360) / 60) % 6
	const X = C * (1 - Math.abs((hp % 2) - 1))
	const m = l - C / 2
	const [r, g, b] =
		hp < 1
			? [C, X, 0]
			: hp < 2
				? [X, C, 0]
				: hp < 3
					? [0, C, X]
					: hp < 4
						? [0, X, C]
						: hp < 5
							? [X, 0, C]
							: [C, 0, X]
	return [r, g, b]
		.map(v => Math.round(Math.min(255, Math.max(0, (v + m) * 255))))
		.concat(255) as Rgba
}

/**
 * The waterfall's colour stops, weak to strong: the Spectrum board's rampStops() (Paper uses ramp a, the
 * default). Every ramp starts on the plot background so the noise floor sits on the ground.
 */
export function waterfallStops(
	name: WaterfallName,
	theme: ThemeColors,
): RampStop[] {
	const bg = opaque(theme.plotBg)
	const acc = opaque(theme.accent)
	const ink = opaque(theme.ink ?? theme.text)
	const paper = theme.light === true
	const at = (pairs: readonly (readonly [number, Rgba])[]): RampStop[] =>
		pairs.map(([a, color]) => ({ at: a, color }))
	switch (name) {
		case "amber":
			return paper
				? at([
						[0, bg],
						[0.35, rgb(240, 214, 160)],
						[0.6, rgb(214, 150, 40)],
						[0.82, rgb(150, 84, 10)],
						[1, rgb(70, 36, 6)],
					])
				: at([
						[0, bg],
						[0.35, rgb(40, 34, 54)],
						[0.6, rgb(130, 60, 82)],
						[0.82, rgb(242, 184, 75)],
						[1, rgb(255, 246, 222)],
					])
		case "mono":
			return paper
				? at([
						[0, bg],
						[0.5, mix(bg, ink, 0.38)],
						[1, ink],
					])
				: at([
						[0, bg],
						[0.55, mix(bg, ink, 0.3)],
						[1, ink],
					])
		case "classic":
			return paper
				? at([
						[0, bg],
						[0.2, rgb(200, 218, 230)],
						[0.42, rgb(96, 170, 190)],
						[0.62, rgb(214, 168, 48)],
						[0.8, rgb(196, 72, 34)],
						[1, rgb(96, 16, 20)],
					])
				: at([
						[0, bg],
						[0.25, rgb(16, 40, 120)],
						[0.45, rgb(20, 140, 200)],
						[0.62, rgb(40, 210, 200)],
						[0.78, rgb(240, 220, 60)],
						[0.9, rgb(240, 110, 30)],
						[1, rgb(200, 30, 30)],
					])
		case "match": {
			if (paper)
				return at([
					[0, bg],
					[0.38, mix(bg, acc, 0.3)],
					[0.72, acc],
					[1, ink],
				])
			const [h, sA] = toHsl(acc)
			const lb = toHsl(bg)[2]
			return at([
				[0, bg],
				[0.3, fromHsl(h + 4, sA * 0.68, Math.max(0.104, lb + 0.03))],
				[0.5, fromHsl(h + 4, sA * 0.91, 0.269)],
				[0.7, fromHsl(h + 1, sA * 0.68, 0.494)],
				[0.86, acc],
				[1, ink],
			])
		}
	}
}

/** The 256-entry waterfall ramp for `name` on `theme`. */
export function waterfallRamp(
	name: WaterfallName,
	theme: ThemeColors,
): Uint8Array {
	return buildRamp(waterfallStops(name, theme))
}

/** The Match-accent ramp: plot background → accent → ink for the strongest signals. */
export function matchAccentRamp(theme: ThemeColors): Uint8Array {
	return waterfallRamp("match", theme)
}

/** A CSS gradient of the same stops, for previews (Settings, ⌘K). */
export function rampGradient(name: WaterfallName, theme: ThemeColors): string {
	const stops = waterfallStops(name, theme).map(
		s =>
			`rgb(${s.color[0]} ${s.color[1]} ${s.color[2]}) ${Math.round(s.at * 100)}%`,
	)
	return `linear-gradient(90deg, ${stops.join(", ")})`
}

/** Dark default theme (packages/brand/tokens/ui.css `[data-wk-theme]`). */
export const DEFAULT_THEME: ThemeColors = {
	plotBg: [0x0b, 0x15, 0x12, 255],
	accent: [0x7b, 0xec, 0xc7, 255],
	text: [0xf4, 0xf7, 0xf5, 255],
}

/** Reads --wk-plot-bg, --wk-accent, --wk-text and --wk-ink-rgb from `element`'s computed style (defaults per token). */
export function themeColors(element: Element): ThemeColors {
	const style = getComputedStyle(element)
	const read = (name: string, fallback: Rgba): Rgba =>
		parseCssColor(style.getPropertyValue(name)) ?? fallback
	const text = read("--wk-text", DEFAULT_THEME.text)
	const ink = parseCssColor(`rgb(${style.getPropertyValue("--wk-ink-rgb")})`)
	return {
		plotBg: read("--wk-plot-bg", DEFAULT_THEME.plotBg),
		accent: read("--wk-accent", DEFAULT_THEME.accent),
		text,
		ink: ink ?? text,
		light: element.closest('[data-wk-theme="light"]') !== null,
	}
}

/** The waterfall setting in scope (`data-wk-waterfall` on an ancestor); Match accent when none. */
export function waterfallIn(element: Element): WaterfallName {
	const v = element
		.closest("[data-wk-waterfall]")
		?.getAttribute("data-wk-waterfall")
	return (WATERFALL_NAMES as readonly string[]).includes(v ?? "")
		? (v as WaterfallName)
		: "match"
}

/** The waterfall ramp for the theme and setting `element` sits in. Call again when either changes. */
export function rampFromTheme(element: Element): Uint8Array {
	return waterfallRamp(waterfallIn(element), themeColors(element))
}
