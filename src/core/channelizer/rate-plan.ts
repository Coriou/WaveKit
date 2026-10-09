import type { DecoderRateAssessment } from "../../decoders/types.js"
import type { RealisedChannel } from "./types.js"

/** Addendum §2: a channelised instance realises its frontend rate exactly, via resampling. */
export function channelisedRatePlan(
	plan: DecoderRateAssessment,
	realised: RealisedChannel,
): DecoderRateAssessment {
	return {
		...plan,
		adaptation: "resample",
		frontendRateHz: realised.outputRateHz,
	}
}
