/**
 * Capture output rates: which rate a capture is made at, and the replay shape of the decoders
 * that read a capture at its own rate. Pure.
 */
import type { TrackSnapshot } from "../spectrum/types.js"
import { classOf } from "../scanner/classify/classifier.js"
import {
	IQ_CAPTURE_RATE_BY_PROTOCOL,
	IQ_CAPTURE_RATE_HZ,
	IQ_CAPTURE_RATES,
	type IqCaptureRateHz,
} from "../scanner/iq-capture-contract.js"
import type { ScannerProtocol } from "../scanner/types.js"

/** The replay tool's narrowest transition (`wavekit-iqcap replay` refuses less). */
export const IQ_REPLAY_MIN_TRANSITION_HZ = 100

export function isCaptureRate(v: unknown): v is IqCaptureRateHz {
	return (
		typeof v === "number" && (IQ_CAPTURE_RATES as readonly number[]).includes(v)
	)
}

/**
 * The shape that keeps the whole capture passband at `rateHz`: `bandwidthHz` and a transition up
 * to the capture's Nyquist edge, (rate − bandwidth) / 2 (288 Hz for the 47 424 Hz capture at
 * 48 kHz, 24 288 Hz at 96 kHz), so bandwidth / 2 + transition = rate / 2, the replay tool's bound.
 * A bandwidth that leaves less than the 100 Hz minimum transition is narrowed to rate − 200 Hz; a
 * non-finite or non-positive one, or a rate outside IQ_CAPTURE_RATES, gives null.
 */
export function wholeCaptureShapeAt(
	bandwidthHz: number,
	rateHz: number,
): { bandwidthHz: number; transitionHz: number } | null {
	if (!Number.isFinite(bandwidthHz) || bandwidthHz <= 0) return null
	if (!isCaptureRate(rateHz)) return null
	const bw = Math.min(bandwidthHz, rateHz - 2 * IQ_REPLAY_MIN_TRANSITION_HZ)
	return { bandwidthHz: bw, transitionHz: (rateHz - bw) / 2 }
}

/** The spectral shapes a track may carry (`TrackSnapshot.spectralShape`). */
const SPECTRAL_SHAPES: ReadonlySet<unknown> = new Set<
	TrackSnapshot["spectralShape"]
>(["flat", "peaked", "narrow"])

/** A track the classifier can read: finite positive OBW, at least one whole block, a shape. */
function wellFormed(track: unknown): track is TrackSnapshot {
	if (typeof track !== "object" || track === null) return false
	const t = track as Partial<TrackSnapshot>
	return (
		typeof t.blocks === "number" &&
		Number.isSafeInteger(t.blocks) &&
		t.blocks >= 1 &&
		typeof t.obwHz === "number" &&
		Number.isFinite(t.obwHz) &&
		t.obwHz > 0 &&
		SPECTRAL_SHAPES.has(t.spectralShape)
	)
}

/**
 * The rate of a capture: the fastest rate any protocol the capture may hold needs
 * (IQ_CAPTURE_RATE_BY_PROTOCOL), else 48 kHz. A protocol counts when the band plan lists it at the
 * capture (prior at least 1) and its prior is not 0; ISM also counts for an OOK-burst track (the
 * replay plan's rtl_433 trial is called the same way). Malformed priors count for nothing.
 */
export function captureRateFor(input: {
	priors: Partial<Record<ScannerProtocol, number>>
	track: TrackSnapshot | null
}): IqCaptureRateHz {
	// Malformed input is the safe answer: 48 kHz (the default capture).
	if (typeof input !== "object" || input === null) return IQ_CAPTURE_RATE_HZ
	const priors: Partial<Record<ScannerProtocol, number>> =
		typeof input.priors === "object" && input.priors !== null
			? input.priors
			: {}
	const track = wellFormed(input.track) ? input.track : null
	let rate: IqCaptureRateHz = IQ_CAPTURE_RATE_HZ
	const raise = (r: IqCaptureRateHz | undefined): void => {
		if (r !== undefined && r > rate) rate = r
	}
	for (const [protocol, r] of Object.entries(IQ_CAPTURE_RATE_BY_PROTOCOL) as [
		ScannerProtocol,
		IqCaptureRateHz,
	][]) {
		const prior = priors[protocol]
		if (prior === 0) continue
		if (typeof prior === "number" && Number.isFinite(prior) && prior >= 1)
			raise(r)
		else if (protocol === "ism" && track !== null && ookBurst(track)) raise(r)
	}
	return rate
}

function ookBurst(track: TrackSnapshot): boolean {
	try {
		return classOf(track) === "ook-burst"
	} catch {
		return false
	}
}
