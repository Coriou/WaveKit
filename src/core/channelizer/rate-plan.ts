import { assessDecoderRate } from "../../decoders/rate-resolver.js"
import type {
	DecoderRateAdapter,
	DecoderRateContext,
} from "../../decoders/rate-resolver.js"
import type {
	DecoderRateAssessment,
	DecoderRateRequirements,
} from "../../decoders/types.js"
import type { RealisedChannel } from "./types.js"

/**
 * Addendum §2: what a channelised instance's stdin really receives. The channelizer realises the
 * frontend rate exactly, by resampling; an IQ decoder reads the channel itself, while an audio
 * decoder keeps its demod chain's own stdin rate and format.
 */
export function channelisedRateAdapter(
	raw: DecoderRateAdapter,
	realised: RealisedChannel,
): DecoderRateAdapter {
	const adapter: DecoderRateAdapter = {
		...raw,
		adaptation: "resample",
		frontendRateHz: realised.outputRateHz,
	}
	if (raw.decoderInputKind !== "iq") return adapter
	return {
		...adapter,
		decoderInputRateHz: realised.outputRateHz,
		decoderInputFormat: realised.format,
	}
}

/**
 * Addendum §2: the plan is recomputed from the channelizer's `opened` event, never the request.
 * `context` is what the raw path assesses (the source and the decoder's raw adapter); only the
 * adapter is replaced, so the verdict follows the same rules as every other instance. Throws
 * whatever `assessDecoderRate` throws (malformed requirements).
 */
export function channelisedRatePlan(
	requirements: DecoderRateRequirements | undefined,
	context: DecoderRateContext,
	realised: RealisedChannel,
): DecoderRateAssessment {
	const { adapter, ...rest } = context
	return assessDecoderRate(requirements, {
		...rest,
		...(adapter ? { adapter: channelisedRateAdapter(adapter, realised) } : {}),
	})
}
