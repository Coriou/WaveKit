import { glyphs } from "./theme.js"

type N = number | null | undefined
const UNKNOWN = "?"

export function isKnown(n: N): n is number {
	return typeof n === "number" && Number.isFinite(n)
}

const SI = ["B", "KB", "MB", "GB", "TB"] as const

export function formatBytes(n: N, digits = 1): string {
	if (!isKnown(n)) return UNKNOWN
	// Compare the rounded figure, so 999 960 B reads "1.0 MB", never "1000.0 KB".
	const shown = (v: number, i: number): number =>
		i === 0 ? Math.round(v) : Number(v.toFixed(digits))
	let v = n
	let i = 0
	while (Math.abs(shown(v, i)) >= 1000 && i < SI.length - 1) {
		v /= 1000
		i++
	}
	return i === 0
		? `${Math.round(v)} B`
		: `${v.toFixed(digits)} ${SI[i] ?? "TB"}`
}

export function formatRate(bytesPerSec: N): string {
	return isKnown(bytesPerSec) ? `${formatBytes(bytesPerSec)}/s` : UNKNOWN
}

/** Core reports dataRate in KiB/s. */
export function kibToBytes(kib: number): number {
	return kib * 1024
}

export function formatSpaced(n: N): string {
	if (!isKnown(n)) return UNKNOWN
	const sign = n < 0 ? glyphs().minus : ""
	return (
		sign + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
	)
}

/** `−46.0 dBFS` (or `−46 dBFS` with 0 digits); the minus follows the glyph mode (ASCII `-`). */
export function formatDbfs(n: N, digits = 1): string {
	if (!isKnown(n)) return UNKNOWN
	const sign = n < 0 ? glyphs().minus : ""
	return `${sign}${Math.abs(n).toFixed(digits)} dBFS`
}

/** A count with its noun, singular for exactly one: `1 restart`, `2 restarts`, `? restarts`. */
export function counted(n: N, one: string, many = `${one}s`): string {
	return `${formatCount(n)} ${n === 1 ? one : many}`
}

export function formatCount(n: N): string {
	if (!isKnown(n)) return UNKNOWN
	const r = Math.round(n)
	return Math.abs(r) < 1000 ? String(r) : formatSpaced(r)
}

export function formatHz(hz: N): string {
	return isKnown(hz) ? `${formatSpaced(hz)} Hz` : UNKNOWN
}

export function formatSps(sps: N): string {
	return isKnown(sps) ? `${formatSpaced(sps)} S/s` : UNKNOWN
}

export function formatMSps(sps: N): string {
	return isKnown(sps) ? `${(sps / 1e6).toFixed(3)} MS/s` : UNKNOWN
}

export function formatMHzBare(hz: N, decimals = 3): string {
	return isKnown(hz) ? (hz / 1e6).toFixed(decimals) : UNKNOWN
}

export function formatMHz(hz: N, decimals = 3): string {
	return isKnown(hz) ? `${formatMHzBare(hz, decimals)} MHz` : UNKNOWN
}

export function formatWindow(loHz: N, hiHz: N): string {
	if (!isKnown(loHz) || !isKnown(hiHz)) return UNKNOWN
	return `${formatMHzBare(loHz)}${glyphs().range}${formatMHzBare(hiHz)} MHz`
}

export function formatHalfSpan(sampleRate: N): string {
	return isKnown(sampleRate)
		? `${glyphs().plusMinus}${(sampleRate / 2e6).toFixed(3)}`
		: UNKNOWN
}

/** Integer percent; a nonzero ratio never reads 0% and a partial one never reads 100% (T4). */
export function formatPercent(ratio: N): string {
	if (!isKnown(ratio)) return UNKNOWN
	const pct = Math.round(ratio * 100)
	if (pct === 0 && ratio > 0) return "<1%"
	if (pct === 100 && ratio < 1) return ">99%"
	return `${pct}%`
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/**
 * R79 (M11): `<1s`, `9s`, `52s`, then minute precision with no zero-padding:
 * `2m`, `12m`, `1h 3m`, `2h`, `3d`. Negative ages (clock skew) render `<1s`.
 */
export function formatAge(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const s = Math.floor(Math.max(0, ms) / 1000)
	if (s < 1) return "<1s"
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.floor(s / 60)}m`
	if (s < 86400) {
		const h = Math.floor(s / 3600)
		const m = Math.floor((s % 3600) / 60)
		return m > 0 ? `${h}h ${m}m` : `${h}h`
	}
	return `${Math.floor(s / 86400)}d`
}

export function formatDuration(sec: N): string {
	return isKnown(sec) ? formatAge(sec * 1000) : UNKNOWN
}

/** Server-relative sample age: "4 ms", "1.2s", then the age buckets. Floors, like formatAge. */
export function formatSampleAge(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const v = Math.max(0, ms)
	if (v < 1000) return `${Math.floor(v)}ms`
	if (v < 10_000) return `${(Math.floor(v / 100) / 10).toFixed(1)}s`
	return formatAge(v)
}

/** 3/min below 60/min, else 1.2/s. */
export function formatEventRate(perSec: N): string {
	if (!isKnown(perSec) || perSec < 0) return UNKNOWN
	const perMin = perSec * 60
	if (perMin < 1) return "<1/min"
	const r = Math.round(perMin)
	if (r < 60) return `${r}/min`
	return `${perSec.toFixed(1)}/s`
}

export function formatDb(tenths: N): string {
	return isKnown(tenths) ? `${(tenths / 10).toFixed(1)} dB` : UNKNOWN
}

export function formatDeltaHz(hz: N): string {
	if (!isKnown(hz)) return UNKNOWN
	const sign = hz < 0 ? glyphs().minus : "+"
	const a = Math.abs(hz)
	const khz = (a / 1e3).toFixed(1)
	return Number(khz) >= 1000
		? `${sign}${(a / 1e6).toFixed(3)} MHz`
		: `${sign}${khz} kHz`
}

function clockParts(ms: number): {
	h: string
	m: string
	s: string
	ms: string
} {
	const d = new Date(ms)
	return {
		h: pad2(d.getHours()),
		m: pad2(d.getMinutes()),
		s: pad2(d.getSeconds()),
		ms: String(d.getMilliseconds()).padStart(3, "0"),
	}
}

export function formatClock(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const p = clockParts(ms)
	return `${p.h}:${p.m}:${p.s}`
}

export function formatClockShort(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const p = clockParts(ms)
	return `${p.h}:${p.m}`
}

export function formatClockMs(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const p = clockParts(ms)
	return `${p.h}:${p.m}:${p.s}.${p.ms}`
}
