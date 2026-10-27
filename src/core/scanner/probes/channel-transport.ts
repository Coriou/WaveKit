import { audioChannelRequest } from "../../../decoders/audio-demod-decoder.js"
import {
	MULTIMON_CHANNEL_BANDWIDTH_HZ,
	MULTIMON_CHANNEL_TRANSITION_HZ,
} from "../../../decoders/builtin/multimon-ng.js"
import { iqChannelRequest } from "../../../decoders/iq-decimate-decoder.js"
import { acarsdecDemodConfig } from "../../../decoders/builtin/acarsdec.js"
import type { DemodulationConfig } from "../../../decoders/types.js"
import { WaveKitError } from "../../../utils/errors.js"
import { admitChannel } from "../../channelizer/admission.js"
import type { DecoderChannelRequest } from "../../channelizer/types.js"
import { probeCores } from "../plan/cost.js"
import {
	offsetTransport,
	type ProbeDecoderType,
	type TransportStrategy,
} from "./probe-pool.js"

const audioDefault: DemodulationConfig = {
	modulation: "fm",
	bandwidth: 12_500,
	sampleRate: 48_000,
	inputSampleRate: 2_400_000,
	deEmphasis: false,
}
const input = { sampleRateHz: 2_048_000 }

/** Explicit scanner probe rate; the built-in rtl433 default is independently 1 MHz. */
export const RTL433_PROBE_TARGET_RATE_HZ = 250_000

function requestShape(request: DecoderChannelRequest) {
	return Object.freeze({
		bandwidthHz: request.bandwidthHz,
		transitionHz: request.transitionHz,
		outputRateHz: request.outputRateHz,
		format: request.format,
	})
}

/** Default scanner mode requests, checked against the built-in decoder factories in tests. */
export const PROBE_CHANNEL_REQUESTS: Readonly<
	Record<
		Exclude<ProbeDecoderType, "dumpvdl2" | "lora-meshtastic">,
		Readonly<Omit<DecoderChannelRequest, "centerHz">>
	>
> = Object.freeze({
	"dsd-fme": requestShape(audioChannelRequest(audioDefault, input)),
	// The decoder's 12 kHz paging channel filter (decoder-enablement 3.18).
	"multimon-ng": requestShape({
		...audioChannelRequest({ ...audioDefault, filterTransition: 0.012 }, input),
		bandwidthHz: MULTIMON_CHANNEL_BANDWIDTH_HZ,
		transitionHz: MULTIMON_CHANNEL_TRANSITION_HZ,
	}),
	direwolf: requestShape(
		audioChannelRequest({ ...audioDefault, filterTransition: 0.012 }, input),
	),
	// Replay only: the ACARS channel (shape of the replay filter).
	acarsdec: requestShape(
		audioChannelRequest(acarsdecDemodConfig(input.sampleRateHz), input),
	),
	rtl433: requestShape(
		iqChannelRequest(
			{
				inputSampleRate: 2_048_000,
				targetSampleRate: RTL433_PROBE_TARGET_RATE_HZ,
			},
			input,
		),
	),
})

/** Predictive span admission only: this neither acquires nor verifies an actual grant. */
export function probeChannelAdmitted(
	type: ProbeDecoderType,
	targetHz: number,
	capture: { sampleRateHz: number; centerHz: number },
	usableFraction: number,
): boolean {
	if (type === "dumpvdl2" || type === "lora-meshtastic") return false
	const request = PROBE_CHANNEL_REQUESTS[type]
	if (!request || !Number.isFinite(targetHz) || targetHz <= 0) return false
	return admitChannel(
		{ ...request, centerHz: targetHz },
		capture,
		usableFraction,
	).admitted
}

/** Keep offsetTransport as the sole owner of offset eligibility and configuration. */
export const offsetPreRollTransport: TransportStrategy = {
	...offsetTransport,
	supports: (mode, ctx) =>
		ctx.req.preRollFromSample !== null && offsetTransport.supports(mode, ctx),
}

/**
 * Provider presence permits prediction, not a capability claim. DecoderManager owns
 * acquisition; an asynchronous denial/spawn failure terminates the attempt without retry.
 * Granted channel IDs are opaque and are never derived by this transport.
 */
export function createChannelTransport(opts: {
	available: () => boolean
	usableFraction: number
}): TransportStrategy {
	if (!(opts.usableFraction > 0 && opts.usableFraction <= 1))
		throw new WaveKitError(
			"Channel usable fraction must be within (0, 1]",
			"CHANNELIZER_USABLE_FRACTION_INVALID",
		)
	return {
		kind: "channel",
		preRoll: false,
		maxProbes: settings => settings.maxProbes.channel,
		cores: type => probeCores("channel", type),
		supports: (mode, ctx) =>
			opts.available() &&
			ctx.format === "U8_IQ" &&
			probeChannelAdmitted(
				mode.decoderType,
				ctx.req.targetHz,
				{ sampleRateHz: ctx.sampleRateHz, centerHz: ctx.epoch.centreHz },
				opts.usableFraction,
			),
		configure: (base, ctx) => {
			const options = { ...base.options }
			delete options["offsetHz"]
			if (base.type === "rtl433")
				options["targetSampleRate"] = RTL433_PROBE_TARGET_RATE_HZ
			return {
				...base,
				useChannelizer: true,
				options: { ...options, channelHz: ctx.req.targetHz },
			}
		},
	}
}
