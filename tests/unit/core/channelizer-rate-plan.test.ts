import { describe, expect, it } from "vitest"
import {
	audioDemodRateAdapter,
	audioDemodRateRequirements,
} from "../../../src/decoders/audio-demod-decoder.js"
import { iqDecimateRateAdapter } from "../../../src/decoders/iq-decimate-decoder.js"
import { assessDecoderRate } from "../../../src/decoders/rate-resolver.js"
import type { DecoderRateRequirements } from "../../../src/decoders/types.js"
import {
	channelisedRateAdapter,
	channelisedRatePlan,
} from "../../../src/core/channelizer/rate-plan.js"

const FS = 2_048_000
const source = { kind: "iq" as const, rateHz: FS }

describe("channelisedRatePlan (addendum §2)", () => {
	it("recomputes an IQ decoder's plan: frontend and decoder input are both the realised rate", () => {
		// rtl_433-like: the raw path integer-decimates 2.048 Msps by 8 to 256 000 Hz.
		const requirements: DecoderRateRequirements = {
			version: 1,
			sourceKind: "iq",
			capture: {
				accepted: [{ kind: "range", minHz: 250_000 }],
				preferredHz: [FS],
			},
			frontendIq: {
				preferredHz: 250_000,
				accepted: [{ kind: "discrete", valuesHz: [250_000] }],
			},
			decoderInput: {
				kind: "iq",
				format: "cu8",
				preferredHz: 250_000,
				accepted: [{ kind: "discrete", valuesHz: [250_000] }],
			},
		}
		const adapter = iqDecimateRateAdapter(
			{ targetSampleRate: 250_000, inputSampleRate: FS },
			FS,
		)
		expect(assessDecoderRate(requirements, { source, adapter })).toMatchObject({
			verdict: "unusable",
			frontendRateHz: 256_000,
			decoderInputRateHz: 256_000,
		})
		const plan = channelisedRatePlan(
			requirements,
			{ source, adapter },
			{ outputRateHz: 250_000, format: "cu8", groupDelaySamples: 12 },
		)
		expect(plan).toEqual({
			sourceKind: "iq",
			sourceRateHz: FS,
			adaptation: "resample",
			frontendRateHz: 250_000,
			decoderInputKind: "iq",
			decoderInputRateHz: 250_000,
			verdict: "best",
		})
	})

	it("reports the realised IQ format, so a format mismatch is not hidden", () => {
		const adapter = iqDecimateRateAdapter(
			{ targetSampleRate: 250_000, inputSampleRate: FS },
			FS,
		)
		expect(
			channelisedRateAdapter(adapter, {
				outputRateHz: 250_000,
				format: "cf32",
				groupDelaySamples: 0,
			}),
		).toEqual({
			adaptation: "resample",
			frontendRateHz: 250_000,
			decoderInputKind: "iq",
			decoderInputRateHz: 250_000,
			decoderInputFormat: "cf32",
		})
	})

	it("keeps an audio decoder's own stdin rate and format behind the exact frontend", () => {
		const config = {
			bandwidth: 12_500,
			sampleRate: 22_050,
			demodSampleRate: 48_000,
			inputSampleRate: FS,
			deEmphasis: false,
		}
		const stdin = { format: "s16le", rateHz: 22_050 }
		const requirements = audioDemodRateRequirements(config, stdin)
		const adapter = audioDemodRateAdapter(config, stdin, FS)
		expect(adapter.frontendRateHz).toBeCloseTo(47_627.9, 1)
		const plan = channelisedRatePlan(
			requirements,
			{ source, adapter },
			{ outputRateHz: 48_000, format: "cf32", groupDelaySamples: 30 },
		)
		expect(plan).toEqual({
			sourceKind: "iq",
			sourceRateHz: FS,
			adaptation: "resample",
			frontendRateHz: 48_000,
			decoderInputKind: "audio_pcm",
			decoderInputRateHz: 22_050,
			// 2.048 Msps is not the family's preferred capture (2.4 Msps): the same rule as raw.
			verdict: "acceptable",
		})
		const at24 = channelisedRatePlan(
			requirements,
			{ source: { kind: "iq", rateHz: 2_400_000 }, adapter },
			{ outputRateHz: 48_000, format: "cf32", groupDelaySamples: 30 },
		)
		expect(at24.verdict).toBe("best")
	})

	it("marks a channelised plan as resample at the realised rate", () => {
		const plan = channelisedRatePlan(
			undefined,
			{
				source,
				adapter: {
					adaptation: "integer-decimation",
					frontendRateHz: 47_627.9,
					decoderInputKind: "audio_pcm",
					decoderInputRateHz: 48_000,
				},
			},
			{ outputRateHz: 48_000, format: "cf32", groupDelaySamples: 30 },
		)
		expect(plan).toMatchObject({
			verdict: "unknown",
			adaptation: "resample",
			frontendRateHz: 48_000,
			decoderInputRateHz: 48_000,
		})
	})

	it("stays honest without a raw adapter", () => {
		const plan = channelisedRatePlan(
			undefined,
			{ source },
			{ outputRateHz: 48_000, format: "cf32", groupDelaySamples: 30 },
		)
		expect(plan).toEqual({
			sourceKind: "iq",
			sourceRateHz: FS,
			verdict: "unknown",
			reasonCode: "unknown-requirements",
		})
	})
})
