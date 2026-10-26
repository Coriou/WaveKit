import pino from "pino"
import { describe, expect, it } from "vitest"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import {
	audioDemodRateAdapter,
	audioDemodRateRequirements,
} from "../../../src/decoders/audio-demod-decoder.js"
import { iqDecimateRateAdapter } from "../../../src/decoders/iq-decimate-decoder.js"
import { assessDecoderRate } from "../../../src/decoders/rate-resolver.js"
import type { DecoderRateRequirements } from "../../../src/decoders/types.js"
import type { RealisedChannel } from "../../../src/core/channelizer/types.js"
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

	it("reports the decoder input dumpvdl2 really reads: a 512 kHz channel resampled to 525 kHz", () => {
		// 3.19: at 1.024 Msps the channel is 512 kHz; dumpvdl2's own pipeline lifts it to
		// 105 kHz x 5. The decoder's adapter for the channel rate says so.
		const vdl2 = new Dumpvdl2Decoder(
			{
				id: "vdl2",
				type: "dumpvdl2",
				enabled: true,
				options: { inputSampleRate: 1_024_000 },
			},
			pino({ level: "silent" }),
		)
		const context = {
			source: { kind: "iq" as const, rateHz: 1_024_000 },
			adapter: vdl2.getRateAdapter({ sampleRateHz: 1_024_000 }),
		}
		const realised: RealisedChannel = {
			outputRateHz: 512_000,
			format: "cf32",
			groupDelaySamples: 0,
		}
		const onChannel = vdl2.getRateAdapter({ sampleRateHz: 512_000 })
		expect(onChannel).toMatchObject({
			adaptation: "resample",
			decoderInputRateHz: 525_000,
		})
		expect(
			channelisedRateAdapter(context.adapter, realised, onChannel),
		).toEqual({
			adaptation: "resample",
			frontendRateHz: 512_000,
			decoderInputKind: "iq",
			decoderInputRateHz: 525_000,
			decoderInputFormat: "u8",
		})
		expect(
			channelisedRatePlan(
				vdl2.getRateRequirements(),
				context,
				realised,
				onChannel,
			),
		).toMatchObject({ frontendRateHz: 512_000, decoderInputRateHz: 525_000 })
		// At 1.05 MHz the channel feeds dumpvdl2 directly: the realised rate and format.
		const direct = vdl2.getRateAdapter({ sampleRateHz: 1_050_000 })
		expect(direct.adaptation).toBe("none")
		expect(
			channelisedRateAdapter(
				context.adapter,
				{ outputRateHz: 1_050_000, format: "cu8", groupDelaySamples: 0 },
				direct,
			),
		).toMatchObject({
			decoderInputRateHz: 1_050_000,
			decoderInputFormat: "cu8",
		})
	})

	it("ignores an audio decoder's channel-rate adapter for an IQ decoder and vice versa", () => {
		const iq = iqDecimateRateAdapter(
			{ targetSampleRate: 250_000, inputSampleRate: FS },
			FS,
		)
		const realised: RealisedChannel = {
			outputRateHz: 250_000,
			format: "cu8",
			groupDelaySamples: 0,
		}
		const audio = {
			adaptation: "integer-decimation" as const,
			frontendRateHz: 48_000,
			decoderInputKind: "audio_pcm" as const,
			decoderInputRateHz: 22_050,
		}
		expect(channelisedRateAdapter(iq, realised, audio)).toMatchObject({
			decoderInputRateHz: 250_000,
			decoderInputFormat: "cu8",
		})
		expect(channelisedRateAdapter(audio, realised, iq)).toEqual({
			...audio,
			adaptation: "resample",
			frontendRateHz: 250_000,
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
