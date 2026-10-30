// Which spectrum signals get a chip (Settings › Signal labels). The gate follows each emission across frames and
// labels the tuned signal, named channels and clear, steady unknowns, with hysteresis so a chip neither blinks nor
// moves while its signal lasts. WG11/WG12 cores give each track a stable id, a `surfaced` verdict (the channel gate:
// a real transmission) and a spur flag: the gate then follows by (sourceId, trackId), trusts `surfaced` instead of
// its own clear-for-a-second rule and drops spurs. Older cores send bare segments, which are followed by position
// and measured against the floor as before. A chip on a proven, live discovery holds as long as the discovery's tag
// stays live (PROVEN_LIVE_HOLD_MS), so a control channel that only sends bursts no longer flashes. Pure: the caller
// passes the clock.

import type { SpectrumFrameTrackScanner } from "@wavekit/api-types"

import { PROVEN_LIVE_HOLD_MS } from "./discovery-tags.ts"
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
	/** The scanner's identity of this emission (WG11 frame tracks), when the core sent one. */
	readonly scanner: SpectrumFrameTrackScanner | null
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
	/** `${sourceId}/${trackId}` of the core's track, when the core sends ids. */
	key: string | null
	/** The core's surfacing verdict in the newest frame it was seen in; null when the core sends none. */
	surfaced: boolean | null
	scanner: SpectrumFrameTrackScanner | null
	/** It sits on a proven, live discovery (LabelGateContext.provenLive), re-asked every frame. */
	proven: boolean
}

export interface LabelGateState {
	readonly followed: readonly Followed[]
	readonly nextId: number
	/** The axis (source, epoch, span) of the newest frame; null before the first one or after a reset. */
	readonly axis: string | null
}

export const EMPTY_LABEL_GATE: LabelGateState = {
	followed: [],
	nextId: 1,
	axis: null,
}

/**
 * Forgets every followed signal at once (no fading chip) but keeps the id counter, so a chip of the new
 * axis never reuses the id, and with it the key and last position, of a chip from the old one.
 */
export function resetLabelGate(state: LabelGateState): LabelGateState {
	return { followed: [], nextId: state.nextId, axis: null }
}

export interface LabelGateFrame {
	sourceId: string
	tracks: readonly Track[]
	floorDbfs: number
	binHz: number
	/** The frame's epoch and span: a new epoch, rate or span is a new axis (band view retune correctness). */
	epoch: number
	startHz: number
	binCount: number
}

/** The axis key of a frame: source, epoch, bin width, span. */
export function frameAxisKey(frame: LabelGateFrame): string {
	return `${frame.sourceId}|${frame.epoch}|${frame.binHz}|${frame.startHz}|${frame.binCount}`
}

export interface LabelGateContext {
	mode: SignalLabelsMode
	tunedHz: number | null
	/** A band-plan channel (or another name) sits on the signal; `scanner` is the core's identity of it, if any. */
	isNamed: (
		hz: number,
		widthHz: number,
		scanner: SpectrumFrameTrackScanner | null,
	) => boolean
	/**
	 * A proven discovery that is live (its tag is lit) sits on the signal: the chip holds PROVEN_LIVE_HOLD_MS
	 * between bursts and is never dropped as weak. Absent: nothing is proven (the chip keeps the usual holds).
	 */
	provenLive?: (
		hz: number,
		widthHz: number,
		scanner: SpectrumFrameTrackScanner | null,
	) => boolean
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
/**
 * A chip on a proven, live discovery holds as long as the discovery's tag stays live after it was last heard
 * (discovery-tags.ts, 5 min): a quiet control channel's bursts come minutes apart, so a 4 s burst hold flashes it.
 */
export const PROVEN_CHIP_HOLD_MS = PROVEN_LIVE_HOLD_MS
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

function holdOf(f: Followed): number {
	return f.proven ? PROVEN_CHIP_HOLD_MS : f.burst ? BURST_HOLD_MS : HOLD_MS
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
	// A retune or rate change (a new axis): what was followed on the old one is gone at once, with no
	// fading chip, and a signal outside the frame's span is never followed (it cannot be heard there).
	const axis = frameAxisKey(frame)
	const fresh = (state.axis ?? null) !== null && state.axis !== axis
	const lo = frame.startHz
	const hi = frame.startHz + frame.binCount * frame.binHz
	const inSpan = (hz: number) => hz >= lo && hz <= hi
	const followed = (fresh ? [] : state.followed)
		.filter(f => inSpan(f.hz))
		.map(f => ({ ...f }))
	let nextId = state.nextId
	const seen = new Set<Followed>()
	const byKey = new Map<string, Followed>()
	for (const f of followed) if (f.key !== null) byKey.set(f.key, f)
	const frameKeys = new Set<string>()
	for (const t of frame.tracks)
		if (t.trackId !== undefined) frameKeys.add(`${frame.sourceId}/${t.trackId}`)
	// strongest tracks first, so a split emission keeps its strongest part
	const tracks = [...frame.tracks]
		.filter(
			t =>
				!t.flags.iqImage && !t.flags.spur && inSpan((t.startHz + t.endHz) / 2),
		)
		.sort((a, b) => (b.peakDb ?? -Infinity) - (a.peakDb ?? -Infinity))
	for (const t of tracks) {
		const key =
			t.trackId === undefined ? null : `${frame.sourceId}/${t.trackId}`
		let best: Followed | null = null
		const same = key === null ? undefined : byKey.get(key)
		if (same && !seen.has(same)) best = same
		else {
			// by position; an emission the core already names differently is another emission, except a
			// held proven chip whose track is gone: the core gives each burst a new track id, and the next
			// burst at its place is the same signal (it adopts the new id instead of a second chip)
			let bestD = Infinity
			for (const f of followed) {
				if (seen.has(f)) continue
				if (
					key !== null &&
					f.key !== null &&
					f.key !== key &&
					!(f.proven && !frameKeys.has(f.key))
				)
					continue
				const d = near(f, t, tol)
				if (d !== null && d < bestD) {
					best = f
					bestD = d
				}
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
				key,
				surfaced: t.surfaced ?? null,
				scanner: t.scanner ?? null,
				proven: false,
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
			best.key = key ?? best.key
			best.surfaced = t.surfaced ?? null
			// the identity is absent for about 1 s after the core's rollover: keep the last one
			if (t.scanner) best.scanner = t.scanner
		}
		seen.add(best)
	}

	const kept: Followed[] = []
	for (const f of followed) {
		// asked every frame, seen or not: a discovery that stops being live (or a throwing lookup) ends the hold
		f.proven = isProvenLive(f, ctx)
		const hold = holdOf(f)
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
			// the core's gate passing is a real transmission, however low its peak reads here
			f.weakSince =
				snr < KEEP_SNR_DB && f.surfaced !== true && !f.proven
					? (f.weakSince ?? now)
					: null
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
		if (f.leavingSince !== null && now - f.lastSeen > holdOf(f)) continue
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
	return { followed: kept, nextId, axis }
}

function isProvenLive(f: Followed, ctx: LabelGateContext): boolean {
	if (!ctx.provenLive) return false
	try {
		return ctx.provenLive(f.hz, f.widthHz, f.scanner) === true
	} catch {
		return false
	}
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
	// a proven, live chip is never weak: between its bursts the trace has nothing to measure
	const weakTooLong =
		!f.proven && f.weakSince !== null && now - f.weakSince >= WEAK_FOR_MS
	if (ctx.isNamed(f.hz, f.widthHz, f.scanner)) {
		if (f.shown) return weakTooLong ? null : "named"
		return snr >= NAMED_SNR_DB ? "named" : null
	}
	if (ctx.mode === "named") return null
	if (unknownSoFar >= MAX_UNKNOWN) return null
	if (f.shown) return weakTooLong ? null : "unknown"
	if (f.surfaced !== null) return f.surfaced ? "unknown" : null
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
				scanner: f.scanner,
			}))
	return [...out(false), ...out(true)]
}
