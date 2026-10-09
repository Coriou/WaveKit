/**
 * Band-aware suspension: does the source centre let a decoder receive any of
 * its target frequencies? Pure; the manager decides what to do with the verdict.
 *
 * Admission follows the channelizer design (2026-10-09 addendum §6): a target
 * fits when it lies inside the usable part of the window the pipeline really
 * sees. Every built-in stdin pipeline is centred on the capture centre, so the
 * window is the capture or, when narrower, the decoder's frontend (an audio
 * demodulator keeps only fs/k ≈ 48 kHz around the centre; a resampler cannot
 * add RF span). The usable fraction is the filter margin. Channel widths are
 * deliberately not subtracted: a carrier inside the usable passband is never
 * declared out of band, so the check errs towards keeping decoders running.
 */

import { z } from "zod"
import type {
	DecoderBandAssessment,
	DecoderBandBasis,
} from "@wavekit/api-types"

/** Share of a window treated as usable (filter transition margin). */
export const USABLE_WINDOW_FRACTION = 0.8

/** What an instance wants to receive; absent means unknown (never suspended). */
export interface DecoderBandRequirements {
	/** Absolute RF frequencies in Hz; in band when any one fits. */
	targetsHz: number[]
	basis: DecoderBandBasis
	/**
	 * The decoder decodes the capture centre itself (followCenter): the
	 * targets bound the band it follows, so it is in band anywhere from the
	 * lowest to the highest target (widened by the window), not only near one.
	 */
	followCenter?: true
}

/** Facts about the current capture and the instance pipeline. */
export interface DecoderBandContext {
	centerHz?: number | undefined
	sampleRateHz?: number | undefined
	/** Rate the pipeline keeps around the centre (from its rate adapter). */
	frontendRateHz?: number | undefined
}

const Hz = z.number().finite().positive()
const Targets = z.array(Hz).min(1)

export function assessDecoderBand(
	requirements: DecoderBandRequirements | undefined,
	context: DecoderBandContext,
): DecoderBandAssessment {
	const targets = Targets.safeParse(requirements?.targetsHz)
	if (!requirements || !targets.success)
		return { verdict: "unknown", reasonCode: "no-target-frequency" }
	const declared = { targetsHz: [...targets.data], basis: requirements.basis }
	const follow = requirements.followCenter === true

	const center = Hz.safeParse(context.centerHz)
	const rate = Hz.safeParse(context.sampleRateHz)
	if (!center.success || !rate.success)
		return {
			verdict: "unknown",
			reasonCode: "source-center-unknown",
			...declared,
		}

	const frontend = Hz.safeParse(context.frontendRateHz)
	const span = frontend.success ? Math.min(rate.data, frontend.data) : rate.data
	const windowHalfWidthHz = (span * USABLE_WINDOW_FRACTION) / 2
	const fits = follow
		? center.data >= Math.min(...targets.data) - windowHalfWidthHz &&
			center.data <= Math.max(...targets.data) + windowHalfWidthHz
		: targets.data.some(
				target => Math.abs(target - center.data) <= windowHalfWidthHz,
			)
	return {
		verdict: fits ? "in-band" : "out-of-band",
		...(fits ? {} : { reasonCode: "frequency-out-of-band" as const }),
		...declared,
		captureCenterHz: center.data,
		windowHalfWidthHz,
	}
}
