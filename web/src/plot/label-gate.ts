// Which spectrum signals get a chip (Settings › Signal labels). The core's frame tracks are one block's raw
// segments, with no id, level or age (CORE-GAPS "Stable signal tracks on spectrum frames"), so a flicker of noise
// is a new "signal" every frame. The gate follows each emission across frames, measures how far it stands over the
// floor and for how long, and labels the tuned signal, named channels and clear, steady unknowns, with hysteresis
// so a chip neither blinks nor moves while its signal lasts. Pure: the caller passes the clock.

import type { Track } from "./maths.ts"

export const SIGNAL_LABELS = ["named", "clear", "all"] as const
export type SignalLabelsMode = (typeof SIGNAL_LABELS)[number]

/** A followed emission. `hz` and `widthHz` only move when the signal really moves, so its chip stays put. */
export interface GatedSignal {
	readonly id: number
	readonly hz: number
	readonly widthHz: number
	readonly burst: boolean
	/** Peak dBFS held with a slow decay, rounded to 3 dB; null when unknown. */
	readonly peakDb: number | null
	/** The chip is fading out (drawn last, transparent). */
	readonly leaving: boolean
}

interface Followed {
	id: number
	hz: number
	widthHz: number
	burst: boolean
	peakDb: number | null
	/** Best peak over the floor in the newest frame it was seen in. */
	snrDb: number | null
	lastSeen: number
	/** Since when it has stood clear of the floor without a break; null while it does not. */
	clearSince: number | null
	/** Since when it has been weak while shown; null while it is not. */
	weakSince: number | null
	shown: boolean
	leavingSince: number | null
}

export interface LabelGateState {
	readonly followed: readonly Followed[]
	readonly nextId: number
}

export const EMPTY_LABEL_GATE: LabelGateState = { followed: [], nextId: 1 }

export interface LabelGateFrame {
	tracks: readonly Track[]
	floorDbfs: number
	binHz: number
}

export interface LabelGateContext {
	mode: SignalLabelsMode
	tunedHz: number | null
	/** A band-plan channel (or another name) sits on the signal. */
	isNamed: (hz: number, widthHz: number) => boolean
}

/** An unknown signal earns a chip at this many dB over the floor… */
export const CLEAR_SNR_DB = 10
/** …held this long. */
export const CLEAR_FOR_MS = 1000
/** A shown chip goes once its signal has been under this for `WEAK_FOR_MS` (hysteresis). */
export const KEEP_SNR_DB = 7
export const WEAK_FOR_MS = 1500
/** A named channel is labelled as soon as its signal is this far over the floor. */
export const NAMED_SNR_DB = 6
/** Unknown chips at most at once; those already shown keep their place. */
export const MAX_UNKNOWN = 5
/** A signal unseen this long is forgotten (bursty signals keep their chip between bursts). */
export const HOLD_MS = 1500
export const BURST_HOLD_MS = 4000
/** A leaving chip stays this long, transparent, so it fades instead of vanishing. */
export const LEAVE_MS = 240
/** The held peak falls this fast once the signal weakens. */
const PEAK_DECAY_DB_PER_S = 3
const PEAK_STEP_DB = 3

function near(f: Followed, t: Track, tolHz: number): number | null {
	const lo = f.hz - f.widthHz / 2 - tolHz
	const hi = f.hz + f.widthHz / 2 + tolHz
	if (t.endHz < lo || t.startHz > hi) return null
	return Math.abs((t.startHz + t.endHz) / 2 - f.hz)
}

function isTunedAt(f: Followed, tunedHz: number | null): boolean {
	return (
		tunedHz !== null &&
		Math.abs(f.hz - tunedHz) <= Math.max(3000, f.widthHz / 2)
	)
}

/** One frame: follow the tracks, then decide which chips show. */
export function stepLabelGate(
	state: LabelGateState,
	frame: LabelGateFrame,
	now: number,
	ctx: LabelGateContext,
): LabelGateState {
	const tol = Math.max(2 * frame.binHz, 1000)
	const followed = state.followed.map(f => ({ ...f }))
	let nextId = state.nextId
	const seen = new Set<Followed>()
	// strongest tracks first, so a split emission keeps its strongest part
	const tracks = [...frame.tracks]
		.filter(t => !t.flags.iqImage)
		.sort((a, b) => (b.peakDb ?? -Infinity) - (a.peakDb ?? -Infinity))
	for (const t of tracks) {
		let best: Followed | null = null
		let bestD = Infinity
		for (const f of followed) {
			if (seen.has(f)) continue
			const d = near(f, t, tol)
			if (d !== null && d < bestD) {
				best = f
				bestD = d
			}
		}
		const hz = (t.startHz + t.endHz) / 2
		const widthHz = t.endHz - t.startHz
		const snr =
			t.peakDb === undefined || t.peakDb === null
				? null
				: t.peakDb - frame.floorDbfs
		if (best === null) {
			best = {
				id: nextId++,
				hz,
				widthHz,
				burst: t.flags.burst,
				peakDb: t.peakDb ?? null,
				snrDb: snr,
				lastSeen: now,
				clearSince: null,
				weakSince: null,
				shown: false,
				leavingSince: null,
			}
			followed.push(best)
		} else {
			// the chip follows a real move (over a quarter of the width), not the edges' jitter
			if (Math.abs(hz - best.hz) > Math.max(tol, best.widthHz / 4)) best.hz = hz
			if (Math.abs(widthHz - best.widthHz) > Math.max(tol, best.widthHz / 4))
				best.widthHz = widthHz
			best.burst = best.burst || t.flags.burst
			const dt = (now - best.lastSeen) / 1000
			const decayed =
				best.peakDb === null ? null : best.peakDb - PEAK_DECAY_DB_PER_S * dt
			const peak = t.peakDb ?? null
			best.peakDb =
				peak === null
					? decayed
					: decayed === null
						? peak
						: Math.max(peak, decayed)
			best.snrDb = snr
			best.lastSeen = now
		}
		seen.add(best)
	}

	const kept: Followed[] = []
	for (const f of followed) {
		const hold = f.burst ? BURST_HOLD_MS : HOLD_MS
		if (f.leavingSince !== null && now - f.leavingSince >= LEAVE_MS) continue
		if (now - f.lastSeen > hold) {
			if (f.shown && f.leavingSince === null) {
				f.shown = false
				f.leavingSince = now
				kept.push(f)
			} else if (f.leavingSince !== null) kept.push(f)
			continue
		}
		if (seen.has(f)) {
			const snr = f.snrDb ?? -Infinity
			if (snr >= CLEAR_SNR_DB) f.clearSince ??= now
			else if (snr < KEEP_SNR_DB) f.clearSince = null
			f.weakSince = snr < KEEP_SNR_DB ? (f.weakSince ?? now) : null
		}
		kept.push(f)
	}

	// decide, chips already shown first so a newcomer never pushes one out
	let unknown = 0
	const order = [...kept].sort(
		(a, b) =>
			Number(b.shown) - Number(a.shown) ||
			(b.snrDb ?? -Infinity) - (a.snrDb ?? -Infinity),
	)
	for (const f of order) {
		if (
			f.leavingSince !== null &&
			now - f.lastSeen > (f.burst ? BURST_HOLD_MS : HOLD_MS)
		)
			continue
		const want = wanted(f, now, ctx, unknown)
		if (want === "unknown") unknown++
		if (want !== null) {
			f.shown = true
			f.leavingSince = null
		} else if (f.shown) {
			f.shown = false
			f.leavingSince = now
		}
	}
	kept.sort((a, b) => a.hz - b.hz)
	return { followed: kept, nextId }
}

function wanted(
	f: Followed,
	now: number,
	ctx: LabelGateContext,
	unknownSoFar: number,
): "tuned" | "named" | "unknown" | null {
	if (isTunedAt(f, ctx.tunedHz)) return "tuned"
	if (ctx.mode === "all") return "unknown"
	const snr = f.snrDb ?? -Infinity
	const weakTooLong = f.weakSince !== null && now - f.weakSince >= WEAK_FOR_MS
	if (ctx.isNamed(f.hz, f.widthHz)) {
		if (f.shown) return weakTooLong ? null : "named"
		return snr >= NAMED_SNR_DB ? "named" : null
	}
	if (ctx.mode === "named") return null
	if (unknownSoFar >= MAX_UNKNOWN) return null
	if (f.shown) return weakTooLong ? null : "unknown"
	return f.clearSince !== null && now - f.clearSince >= CLEAR_FOR_MS
		? "unknown"
		: null
}

/** The chips to draw: shown signals, then leaving ones (placed last, so they never push a shown one). */
export function gatedSignals(state: LabelGateState): GatedSignal[] {
	const out = (leaving: boolean) =>
		state.followed
			.filter(f => (leaving ? f.leavingSince !== null : f.shown))
			.map(f => ({
				id: f.id,
				hz: f.hz,
				widthHz: f.widthHz,
				burst: f.burst,
				peakDb:
					f.peakDb === null
						? null
						: Math.round(f.peakDb / PEAK_STEP_DB) * PEAK_STEP_DB,
				leaving,
			}))
	return [...out(false), ...out(true)]
}
