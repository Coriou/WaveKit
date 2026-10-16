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
}

/** The Match-accent ramp: plot background → dim accent → accent → text for the strongest signals. */
export function matchAccentRamp(theme: ThemeColors): Uint8Array {
	const bg: Rgba = [theme.plotBg[0], theme.plotBg[1], theme.plotBg[2], 255]
	const accent: Rgba = [theme.accent[0], theme.accent[1], theme.accent[2], 255]
	const text: Rgba = [theme.text[0], theme.text[1], theme.text[2], 255]
	return buildRamp([
		{ at: 0, color: bg },
		{ at: 0.18, color: mix(bg, accent, 0.12) },
		{ at: 0.45, color: mix(bg, accent, 0.5) },
		{ at: 0.75, color: accent },
		{ at: 1, color: mix(accent, text, 0.85) },
	])
}

/** Dark default theme (packages/brand/tokens/ui.css `[data-wk-theme]`). */
export const DEFAULT_THEME: ThemeColors = {
	plotBg: [0x0b, 0x15, 0x12, 255],
	accent: [0x7b, 0xec, 0xc7, 255],
	text: [0xf4, 0xf7, 0xf5, 255],
}

/** Reads --wk-plot-bg, --wk-accent and --wk-text from `element`'s computed style (defaults per token). */
export function themeColors(element: Element): ThemeColors {
	const style = getComputedStyle(element)
	const read = (name: string, fallback: Rgba): Rgba =>
		parseCssColor(style.getPropertyValue(name)) ?? fallback
	return {
		plotBg: read("--wk-plot-bg", DEFAULT_THEME.plotBg),
		accent: read("--wk-accent", DEFAULT_THEME.accent),
		text: read("--wk-text", DEFAULT_THEME.text),
	}
}

/** The Match-accent ramp for the theme `element` sits in. Call again when the theme or accent changes. */
export function rampFromTheme(element: Element): Uint8Array {
	return matchAccentRamp(themeColors(element))
}
