/**
 * Spec § 4.7 discontinuity alarm. Given the persistent features present in the previous settled
 * block (RF-fixed carriers and long-lived tracks) and this block's segments, decide whether the
 * receiver moved without the core seeing a command: ≥ ALARM_FRACTION of ≥ ALARM_MIN_FEATURES
 * visible features vanished. When most of them reappear at one common shift Δ (± toleranceHz),
 * Δ (apparent: new − old) is reported.
 */
export interface PersistentFeature {
	rfHz: number
	widthHz: number
}

export interface SegmentRange {
	startHz: number
	endHz: number
	centreHz: number
}

export const ALARM_MIN_FEATURES = 3
export const ALARM_FRACTION = 0.6
const MIN_SHIFT_MATCHES = 2
const EPS = 1e-9

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b)
	const mid = s.length >> 1
	return s.length % 2 === 1
		? (s[mid] ?? 0)
		: ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

export function untrackedRetuneAlarm(
	features: readonly PersistentFeature[],
	segments: readonly SegmentRange[],
	opts: {
		toleranceHz: number
		visible: (hz: number) => boolean
		minFeatures?: number
		fraction?: number
	},
): { deltaHz: number | null } | null {
	const tol = opts.toleranceHz
	const minFeatures = opts.minFeatures ?? ALARM_MIN_FEATURES
	const fraction = opts.fraction ?? ALARM_FRACTION
	const eligible = features.filter(f => opts.visible(f.rfHz))
	if (eligible.length < minFeatures) return null
	const present = (hz: number): boolean =>
		segments.some(s => hz >= s.startHz - tol && hz <= s.endHz + tol)
	const vanished = new Set(eligible.filter(f => !present(f.rfHz)))
	if (vanished.size < Math.ceil(fraction * eligible.length - EPS)) return null

	let best: { delta: number; matches: number[] } | null = null
	for (const f of vanished) {
		for (const s of segments) {
			const delta = s.centreHz - f.rfHz
			if (Math.abs(delta) <= tol) continue
			let inView = 0
			const matches: number[] = []
			for (const g of eligible) {
				const target = g.rfHz + delta
				if (!opts.visible(target)) continue
				inView++
				if (!vanished.has(g)) continue
				const m = segments.find(x => Math.abs(x.centreHz - target) <= tol)
				if (m) matches.push(m.centreHz - g.rfHz)
			}
			if (
				matches.length < MIN_SHIFT_MATCHES ||
				matches.length < Math.ceil(fraction * inView - EPS)
			)
				continue
			const better =
				best === null ||
				matches.length > best.matches.length ||
				(matches.length === best.matches.length &&
					Math.abs(delta) < Math.abs(best.delta))
			if (better) best = { delta, matches }
		}
	}
	return { deltaHz: best ? median(best.matches) : null }
}
