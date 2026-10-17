/**
 * Spec § 4.7 discontinuity alarm. Given the persistent features present in the previous settled
 * block (RF-fixed carriers and long-lived tracks) and this block's segments, decide whether the
 * receiver moved without the core seeing a command: ≥ ALARM_FRACTION of ≥ ALARM_MIN_FEATURES
 * visible features vanished. When most of them reappear at one common shift Δ (± toleranceHz),
 * Δ (apparent: new − old) is reported.
 */
import type { SpectrumWarningSuspect } from "@wavekit/api-types"

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
/** WG10 req 2.9: signal-change needs this many eligible features still in place (fail closed). */
export const ALARM_MIN_SURVIVORS = 2
const MIN_SHIFT_MATCHES = 2
/**
 * WG10 R1 M2: a signal-change survivor must still be the same emission: a segment whose centroid
 * is within max(tolerance, width / 4) of the feature and whose width is within a factor of two
 * of the feature's (± 2·tolerance for narrow features). A wide new occupancy that merely covers
 * an old position is no evidence that the old scene is still there.
 */
export const SURVIVOR_CENTRE_FRACTION = 0.25
export const SURVIVOR_WIDTH_RATIO = 2

export function survivorMatches(
	f: PersistentFeature,
	segments: readonly SegmentRange[],
	toleranceHz: number,
): boolean {
	const centreTol = Math.max(toleranceHz, SURVIVOR_CENTRE_FRACTION * f.widthHz)
	return segments.some(s => {
		const w = s.endHz - s.startHz
		return (
			Math.abs(s.centreHz - f.rfHz) <= centreTol &&
			w <= SURVIVOR_WIDTH_RATIO * f.widthHz + 2 * toleranceHz &&
			w >= f.widthHz / SURVIVOR_WIDTH_RATIO - 2 * toleranceHz
		)
	})
}
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

/**
 * WG10 req 2.9: the visible features of `features` that are absent from `segments` (the alarm's
 * vanished set, same visibility and tolerance rules as untrackedRetuneAlarm).
 */
export function vanishedFeatures(
	features: readonly PersistentFeature[],
	segments: readonly SegmentRange[],
	opts: { toleranceHz: number; visible: (hz: number) => boolean },
): PersistentFeature[] {
	const tol = opts.toleranceHz
	return features.filter(
		f =>
			opts.visible(f.rfHz) &&
			!segments.some(s => f.rfHz >= s.startHz - tol && f.rfHz <= s.endHz + tol),
	)
}

export type AlarmSuspect = SpectrumWarningSuspect

/**
 * WG10 req 2.9: classify a fired alarm (run only when untrackedRetuneAlarm fired).
 *
 * - `iq-byte-slip`: at least MIN_SHIFT_MATCHES vanished features off the centre, and at least
 *   ALARM_FRACTION of those whose mirror `2·centre − f` is visible, reappear in a segment at the
 *   mirror (an I/Q swap mirrors the spectrum about the centre). A label only: the caller starts
 *   the same unverified epoch as external-control and never re-aligns the stream (WG10 R1 M1).
 * - `signal-change`: no common shift (Δ null), every vanished feature belongs to a strong
 *   transmission that ended (the caller's `ended`, which must rest on positive end evidence),
 *   and eligible features are still present (at least ALARM_MIN_SURVIVORS, and every survivor
 *   matches a segment of similar width at its old centre (survivorMatches): a scene that moved
 *   and left coincidental or covering matches, or vanished entirely, is never explained away:
 *   fail closed).
 * - `external-control` otherwise (the safe answer: a new unverified epoch).
 */
export function classifyAlarm(input: {
	features: readonly PersistentFeature[]
	segments: readonly SegmentRange[]
	centreHz: number
	toleranceHz: number
	visible: (hz: number) => boolean
	deltaHz: number | null
	ended: (f: PersistentFeature) => boolean
	fraction?: number
}): AlarmSuspect {
	const tol = input.toleranceHz
	const fraction = input.fraction ?? ALARM_FRACTION
	const eligible = input.features.filter(f => input.visible(f.rfHz))
	const vanished = vanishedFeatures(input.features, input.segments, input)
	const contains = (hz: number): boolean =>
		input.segments.some(s => hz >= s.startHz - tol && hz <= s.endHz + tol)

	let inView = 0
	let mirrored = 0
	for (const f of vanished) {
		if (Math.abs(f.rfHz - input.centreHz) <= tol) continue
		const m = 2 * input.centreHz - f.rfHz
		if (!input.visible(m)) continue
		inView++
		if (contains(m)) mirrored++
	}
	if (
		mirrored >= MIN_SHIFT_MATCHES &&
		mirrored >= Math.ceil(fraction * inView - EPS)
	)
		return "iq-byte-slip"

	const gone = new Set(vanished)
	const survivors = eligible.filter(f => !gone.has(f))
	if (
		input.deltaHz === null &&
		vanished.length > 0 &&
		survivors.length >= ALARM_MIN_SURVIVORS &&
		survivors.every(f => survivorMatches(f, input.segments, tol)) &&
		vanished.every(f => input.ended(f))
	)
		return "signal-change"
	return "external-control"
}
