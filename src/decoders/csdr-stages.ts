/**
 * Shared CSDR stage builders for IQ-to-audio pipelines (live demodulator,
 * dsd-fme and the other audio-demod decoders).
 *
 * - channelDecimationStage: a `firdecimate` whose filter is sized to the
 *   channel, not to the input rate. A fixed transition of 0.05 at 2.048 Msps
 *   is ~102 kHz wide (81 taps): everything within about ±50 kHz folds into a
 *   25 kHz channel. The matched filter is flat to half the channel bandwidth
 *   and reaches its stopband at the smaller of the output Nyquist frequency
 *   and the channel bandwidth, so nothing aliases into the channel.
 * - shiftStage: `csdr shift` that moves a carrier at +offsetHz to DC before
 *   decimation, away from the receiver's DC spike.
 * - deemphasisStage: `csdr deemphasis --nfm` only exists for 8000, 11025,
 *   12000, 44100 and 48000 Hz and its rate argument is an unsigned integer;
 *   any other rate made the stage exit at start. Other rates use the
 *   single-pole IIR (`--wfm <integer rate> <tau>`).
 */

import { WaveKitError } from "../utils/errors.js"

/** Upstream predefined NFM de-emphasis FIR rates (csdr deemphasis.cpp). */
const NFM_DEEMPHASIS_RATES = new Set([8000, 11025, 12000, 44100, 48000])

/** Single-pole NFM de-emphasis time constant (6 dB/octave above ~212 Hz). */
const NFM_DEEMPHASIS_TAU_SECONDS = 0.00075

/**
 * Lower bound on the normalised transition: caps the filter at ~40k taps so
 * the bounded-ring minimum stays well under the default 65,536 elements.
 */
const MIN_TRANSITION = 0.0001

export interface ChannelFilterPlan {
	/** Transition width normalised to the input rate (firdecimate argument). */
	transition: number
	/** Cutoff normalised to the output rate (firdecimate --cutoff, max 0.5). */
	cutoff: number
	/** Approximate FIR length CSDR builds for this transition. */
	taps: number
	/** Flat passband edge in Hz (half the channel bandwidth). */
	passbandHz: number
	/** Stopband edge in Hz. */
	stopbandHz: number
}

/**
 * How the decimation filter maps onto the output band:
 * - "channel": a DC-centred channel `channelBandwidthHz` wide (FM, AM, digital
 *   voice). Flat to ±bandwidth/2, stopband at min(Nyquist, bandwidth): nothing
 *   aliases into the output band.
 * - "nyquist": keep (almost) the whole output band, for paths that select a
 *   sub-band afterwards (SSB, raw). Flat to 0.85 Nyquist, stopband at 1.15
 *   Nyquist: aliasing lands only above the flat passband.
 */
export type ChannelFilterMode = "channel" | "nyquist"

export function channelFilterPlan(
	inputRate: number,
	decimation: number,
	channelBandwidthHz: number,
	mode: ChannelFilterMode = "channel",
): ChannelFilterPlan {
	const outputRate = inputRate / Math.max(1, decimation)
	const nyquist = outputRate / 2
	let stopbandHz: number
	let passbandHz: number
	if (mode === "nyquist") {
		passbandHz = nyquist * 0.85
		stopbandHz = nyquist * 1.15
	} else {
		const bandwidth =
			channelBandwidthHz > 0 ? channelBandwidthHz : Math.max(1, nyquist)
		stopbandHz = Math.min(nyquist, bandwidth)
		passbandHz = bandwidth / 2
		if (passbandHz >= stopbandHz * 0.9) passbandHz = stopbandHz / 2
	}
	const transition = Math.max(
		MIN_TRANSITION,
		(stopbandHz - passbandHz) / inputRate,
	)
	const cutoff = Math.min(0.5, (passbandHz + stopbandHz) / 2 / outputRate)
	return {
		transition,
		cutoff,
		taps: Math.floor(4 / transition) | 1,
		passbandHz,
		stopbandHz,
	}
}

/** `csdr firdecimate` with a channel-matched filter (see channelFilterPlan). */
export function channelDecimationStage(
	inputRate: number,
	decimation: number,
	channelBandwidthHz: number,
	mode: ChannelFilterMode = "channel",
): string {
	const plan = channelFilterPlan(
		inputRate,
		decimation,
		channelBandwidthHz,
		mode,
	)
	return `csdr firdecimate ${decimation} ${plan.transition.toFixed(6)} --cutoff ${plan.cutoff.toFixed(4)}`
}

/**
 * Throws when the shifted channel would not fit inside the capture, so a bad
 * offset fails at configuration time instead of producing silence.
 */
export function validateChannelOffset(
	offsetHz: number,
	inputRate: number,
	channelBandwidthHz: number,
): void {
	const limit = inputRate / 2 - Math.max(0, channelBandwidthHz) / 2
	if (!Number.isFinite(offsetHz) || Math.abs(offsetHz) > limit) {
		throw new WaveKitError(
			`offsetHz ${offsetHz} puts the channel outside the ${inputRate} Hz capture (limit ±${Math.floor(limit)} Hz)`,
			"CHANNEL_OFFSET_OUT_OF_RANGE",
		)
	}
}

/**
 * Mixer that moves a signal at +offsetHz (relative to the tuned centre) to DC.
 * Returns null at zero offset so the default pipeline is unchanged.
 */
export function shiftStage(offsetHz: number, inputRate: number): string | null {
	if (offsetHz === 0) return null
	return `csdr shift ${(-offsetHz / inputRate).toFixed(10)}`
}

export interface DeemphasisStage {
	stage: string
	/** True when NFM uses the single-pole IIR instead of the predefined FIR. */
	approximated: boolean
}

export function deemphasisStage(
	kind: "nfm" | "wfm",
	sampleRate: number,
	tauMicroseconds = 50,
): DeemphasisStage {
	const rate = Math.max(1, Math.round(sampleRate))
	if (kind === "nfm") {
		if (Math.abs(sampleRate - rate) < 1e-6 && NFM_DEEMPHASIS_RATES.has(rate)) {
			return { stage: `csdr deemphasis --nfm ${rate}`, approximated: false }
		}
		return {
			stage: `csdr deemphasis --wfm ${rate} ${NFM_DEEMPHASIS_TAU_SECONDS}`,
			approximated: true,
		}
	}
	const tauSeconds = Number((tauMicroseconds / 1_000_000).toPrecision(6))
	return {
		stage: `csdr deemphasis --wfm ${rate} ${tauSeconds}`,
		approximated: false,
	}
}
