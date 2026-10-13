/**
 * Per-client spectrum averaging (WG1 req 2). Pure: profile identity, admission and the
 * exponential-average recurrence. SpectrumService applies the results; nothing here touches I/O.
 */
import type {
	SpectrumProfileAdjustment,
	SpectrumProfileView,
} from "@wavekit/api-types"
import { PROFILE_LIMITS } from "./subscribe-options.js"

export interface SpectrumProfile {
	key: string
	hz: number
	bins: number
	/** Omitted when averaging is off (1), so `${hz}:${bins}` profiles stay byte-identical. */
	averaging?: number
}

const clamp = (v: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, v))

/** 1 = off. Absent means off. */
export function averagingOf(profile: { averaging?: number }): number {
	return profile.averaging ?? 1
}

/** `${hz}:${bins}` when off; `${hz}:${bins}:a${n}` otherwise. The off form is the CLI guard. */
export function profileKey(hz: number, bins: number, averaging = 1): string {
	return averaging > 1 ? `${hz}:${bins}:a${averaging}` : `${hz}:${bins}`
}

export function makeProfile(
	hz: number,
	bins: number,
	averaging = 1,
): SpectrumProfile {
	const n = averaging > 1 ? averaging : 1
	return {
		key: profileKey(hz, bins, n),
		hz,
		bins,
		...(n > 1 ? { averaging: n } : {}),
	}
}

/** `averaging` on the wire only when it is doing work. */
export function profileView(profile: SpectrumProfile): SpectrumProfileView {
	const n = averagingOf(profile)
	return {
		key: profile.key,
		hz: profile.hz,
		bins: profile.bins,
		...(n > 1 ? { averaging: n } : {}),
	}
}

/**
 * Omitted fields take the fallback unchanged. Given hz/bins/averaging are snapped and clamped;
 * `adjusted` names each one that changed.
 */
export function normaliseProfile(
	req: {
		hz?: number | undefined
		bins?: number | undefined
		averaging?: number | undefined
	},
	fallback: SpectrumProfile,
): { profile: SpectrumProfile; adjusted: SpectrumProfileAdjustment[] } {
	const adjusted: SpectrumProfileAdjustment[] = []
	let hz = fallback.hz
	let bins = fallback.bins
	let averaging = averagingOf(fallback)
	if (req.hz !== undefined) {
		const { min, max, step } = PROFILE_LIMITS.hz
		hz = clamp(Math.round(req.hz / step) * step, min, max)
		if (hz !== req.hz) adjusted.push("hz")
	}
	if (req.bins !== undefined) {
		const { min, max } = PROFILE_LIMITS.bins
		bins = clamp(Math.round(req.bins), min, max)
		if (bins !== req.bins) adjusted.push("bins")
	}
	if (req.averaging !== undefined) {
		const { min, max } = PROFILE_LIMITS.averaging
		averaging = clamp(Math.round(req.averaging), min, max)
		if (averaging !== req.averaging) adjusted.push("averaging")
	}
	return { profile: makeProfile(hz, bins, averaging), adjusted }
}

const distance = (want: SpectrumProfile, c: SpectrumProfile): number =>
	Math.abs(Math.log2(want.bins / c.bins)) + Math.abs(Math.log2(want.hz / c.hz))

/**
 * Prefers candidates ≤ want on both axes; metric and ties as before averaging existed.
 * Candidates are filtered to `want`'s averaging; if none, to averaging off (the default is
 * always in the list) and `"averaging"` is recorded when that changes the request.
 */
export function nearestProfile(
	want: SpectrumProfile,
	candidates: readonly SpectrumProfile[],
	adjusted?: SpectrumProfileAdjustment[],
): SpectrumProfile {
	const wantAvg = averagingOf(want)
	let pool = candidates.filter(c => averagingOf(c) === wantAvg)
	if (pool.length === 0) {
		pool = candidates.filter(c => averagingOf(c) === 1)
		if (wantAvg !== 1 && adjusted && !adjusted.includes("averaging"))
			adjusted.push("averaging")
	}
	if (pool.length === 0) pool = [...candidates]
	const smaller = pool.filter(c => c.hz <= want.hz && c.bins <= want.bins)
	const pickFrom = smaller.length > 0 ? smaller : pool
	const ranked = [...pickFrom].sort(
		(a, b) =>
			distance(want, a) - distance(want, b) ||
			a.bins - b.bins ||
			a.hz - b.hz ||
			(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
	)
	return ranked[0]!
}

/**
 * Admission of one already-normalised profile. `others` is every other client's current and
 * next selection (duplicates are one pair). The default key is free. Over the cap, the nearest
 * profile on this source with the same averaging wins, else averaging off.
 */
export function admitProfile(
	profile: SpectrumProfile,
	sourceId: string,
	def: SpectrumProfile,
	others: readonly { sourceId: string; profile: SpectrumProfile }[],
	cap: number,
	adjusted: SpectrumProfileAdjustment[],
): SpectrumProfile {
	if (profile.key === def.key) return profile
	const byPair = new Map<
		string,
		{ sourceId: string; profile: SpectrumProfile }
	>()
	for (const o of others) {
		if (o.profile.key === def.key) continue
		byPair.set(`${o.sourceId}:${o.profile.key}`, o)
	}
	const pair = `${sourceId}:${profile.key}`
	const size = byPair.has(pair) ? byPair.size : byPair.size + 1
	if (size <= cap) return profile
	const candidates =
		byPair.size <= cap
			? [...byPair.values()]
					.filter(o => o.sourceId === sourceId)
					.map(o => o.profile)
			: []
	adjusted.push("profile-limit")
	return nearestProfile(profile, [def, ...candidates], adjusted)
}

/**
 * One step of `avg += (frame − avg) / n`, seeded with the first frame. `n <= 1` is the
 * identity (a copy). A null average or a different length restarts.
 */
export function applyAverage(
	avg: Float32Array | null,
	frame: ArrayLike<number>,
	n: number,
): Float32Array {
	if (n <= 1 || !avg || avg.length !== frame.length) {
		const seeded = new Float32Array(frame.length)
		for (let i = 0; i < frame.length; i++) seeded[i] = frame[i]!
		return seeded
	}
	for (let i = 0; i < frame.length; i++)
		avg[i] = avg[i]! + (frame[i]! - avg[i]!) / n
	return avg
}

/** Final averaged frame after `frames`, restarting wherever `restart[i]` is set. */
export function averageSequence(
	frames: readonly ArrayLike<number>[],
	n: number,
	restart: readonly boolean[] = [],
): Float32Array | null {
	let avg: Float32Array | null = null
	for (let i = 0; i < frames.length; i++) {
		const frame = frames[i]!
		if (restart[i]) avg = null
		avg = applyAverage(avg, frame, n)
	}
	return avg
}
