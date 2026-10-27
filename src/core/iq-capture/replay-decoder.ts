/** Decoder configuration for the native tool's U8 replay outputs. */
import type { DecoderConfig } from "../../decoders/types.js"
import { buildDumpvdl2ReplayArgs } from "../../decoders/builtin/dumpvdl2.js"
import {
	LORA_REGIONS,
	parseLoraMeshtasticOptions,
} from "../../decoders/builtin/lora-meshtastic.js"
import { LORA_REGION_RANGES_HZ } from "../../decoders/band-defaults.js"
import { WaveKitError } from "../../utils/errors.js"

/** Null means this is an audio/rtl_433 consumer handled by the existing transport.
 * A mismatched clock is refused before launching a decoder; it must never reinterpret IQ. */
export function configureNativeReplayDecoder(
	base: DecoderConfig,
	targetHz: number,
	rateHz: number,
): DecoderConfig | null {
	if (base.type !== "dumpvdl2" && base.type !== "lora-meshtastic") return null
	const expectedRate = base.type === "dumpvdl2" ? 105_000 : 250_000
	if (rateHz !== expectedRate)
		throw new WaveKitError(
			"Unsupported replay decoder clock",
			"IQ_REPLAY_FAILED",
		)
	if (base.type === "dumpvdl2") {
		buildDumpvdl2ReplayArgs(targetHz)
		return {
			...base,
			useChannelizer: false,
			frequencies: [targetHz],
			options: {
				...base.options,
				inputSampleRate: rateHz,
				targetSampleRate: rateHz,
				inputCenterFreq: targetHz,
				followCenter: true,
			},
		}
	}
	// Region is wrapper metadata. Reuse the shipped ranges; an unknown band has no safe default.
	const region = LORA_REGIONS.find(region => {
		const range = LORA_REGION_RANGES_HZ[region]
		return targetHz >= range.minHz && targetHz <= range.maxHz
	})
	if (!region)
		throw new WaveKitError("Unknown replay LoRa region", "IQ_REPLAY_FAILED")
	const options = {
		region,
		channelKey: "AQ==",
		...base.options,
		frequency: targetHz,
		inputCenterFreq: targetHz,
		followCenter: true,
		preset: "LongModerate",
		bandwidth: 125_000,
		oversampling: 2,
		inputSampleRate: rateHz,
	}
	parseLoraMeshtasticOptions(options)
	return { ...base, useChannelizer: false, frequencies: [targetHz], options }
}
