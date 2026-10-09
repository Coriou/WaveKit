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
 *
 * Ranges (band defaults spec §2) are absolute RF intervals: a range fits when
 * the centre lies within the window half-width of the interval.
 */

import { z } from "zod"
import type {
	DecoderBandAssessment,
	DecoderBandBasis,
	DecoderBandRange,
	DecoderBandRegion,
} from "@wavekit/api-types"

export type { DecoderBandRange } from "@wavekit/api-types"

/** Share of a window treated as usable (filter transition margin). */
export const USABLE_WINDOW_FRACTION = 0.8

/** What an instance wants to receive; absent means unknown (never suspended). */
export interface DecoderBandRequirements {
	/** Absolute RF frequencies in Hz; in band when any one fits. */
	targetsHz?: number[]
	/** Absolute RF intervals in Hz; in band when the centre is near any one. */
	rangesHz?: DecoderBandRange[]
	basis: DecoderBandBasis
	/**
	 * The decoder decodes the capture centre itself (followCenter): the
	 * targets bound the band it follows, so it is in band anywhere from the
	 * lowest to the highest target (widened by the window), not only near one.
	 * Applies to targetsHz only.
	 */
	followCenter?: true
	/** Set when a region-dependent default produced the band. */
	region?: DecoderBandRegion
	/** Set when basis is "override". */
	overrideSource?: "config" | "api"
}

/**
 * What a decoder itself knows about its band; the manager resolves it with
 * the overrides, the region and the built-in table (band-defaults.ts).
 */
export interface DecoderBandDeclaration {
	/** Reads its own SDR, not the shared source (readsb rtlTcpHost): always unknown. */
	ownSource?: true
	/** Picks its own channels (AIS-catcher `-c` in extraArgs): no built-in default applies. */
	ownTuning?: true
	/** From frequencies / options.frequency(ies), basis "configured". */
	configured?: DecoderBandRequirements
	/** Protocol constant or the decoder's own option default. */
	intrinsic?: DecoderBandRequirements
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
const Ranges = z
	.array(
		z
			.object({ minHz: Hz, maxHz: Hz })
			.refine(range => range.minHz <= range.maxHz),
	)
	.min(1)

/** Distance from `center` to the interval [minHz, maxHz]; 0 inside it. */
export function distanceToRange(
	center: number,
	range: DecoderBandRange,
): number {
	if (center < range.minHz) return range.minHz - center
	if (center > range.maxHz) return center - range.maxHz
	return 0
}

export function assessDecoderBand(
	requirements: DecoderBandRequirements | undefined,
	context: DecoderBandContext,
): DecoderBandAssessment {
	const targets = Targets.safeParse(requirements?.targetsHz)
	const ranges = Ranges.safeParse(requirements?.rangesHz)
	if (!requirements || (!targets.success && !ranges.success))
		return { verdict: "unknown", reasonCode: "no-target-frequency" }
	const declared = {
		...(targets.success ? { targetsHz: [...targets.data] } : {}),
		...(ranges.success
			? {
					rangesHz: ranges.data.map(range => ({
						minHz: range.minHz,
						maxHz: range.maxHz,
					})),
				}
			: {}),
		basis: requirements.basis,
		...(requirements.region ? { region: { ...requirements.region } } : {}),
		...(requirements.overrideSource
			? { overrideSource: requirements.overrideSource }
			: {}),
	}
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
	const c = center.data
	const targetFits =
		targets.success &&
		(follow
			? c >= Math.min(...targets.data) - windowHalfWidthHz &&
				c <= Math.max(...targets.data) + windowHalfWidthHz
			: targets.data.some(target => Math.abs(target - c) <= windowHalfWidthHz))
	const rangeFits =
		ranges.success &&
		ranges.data.some(range => distanceToRange(c, range) <= windowHalfWidthHz)
	const fits = targetFits || rangeFits
	return {
		verdict: fits ? "in-band" : "out-of-band",
		...(fits ? {} : { reasonCode: "frequency-out-of-band" as const }),
		...declared,
		captureCenterHz: c,
		windowHalfWidthHz,
	}
}
