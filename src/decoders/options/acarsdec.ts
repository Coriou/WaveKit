import { z } from "zod"
import type { BandRegion, DecoderOptionDescriptor } from "@wavekit/api-types"

const frequencyHz = z.number().finite().positive()

/** Bounds by meaning (WG7 HW.2): what the radio hardware and the decoders can take. */
export const ACARSDEC_BOUNDS = {
	/** A hand-written argv tail; thousands of entries is a mistake or an attack. */
	maxExtraArgs: 64,
	/** Below 1 kHz is no IQ stream; above 10 Msps is beyond any supported SDR front end. */
	sampleRateHz: { min: 1_000, max: 10_000_000 },
	/** Tunable range of the supported SDRs (up to 6 GHz). */
	frequencyHz: { min: 1, max: 6_000_000_000 },
	/** A few channels fit one ~2.4 Msps capture; by meaning, not an acarsdec limit. */
	maxFrequencies: 8,
} as const

/**
 * The VHF ACARS channels an acarsdec decoder listens to by default: the one source the adapter
 * default, the decoder catalogue and the scanner's ambient targets read.
 * - Everywhere: 131.550 MHz (the worldwide primary ACARS channel) and 131.725 MHz (the European
 *   primary), as before.
 * - EU (requirement 3.20): the commonly published European ACARS channels 131.525, 131.550,
 *   131.725, 131.825 and 131.850 MHz. The 136.7-136.975 MHz channels are VDL Mode 2 (dumpvdl2).
 */
export const ACARS_DEFAULT_CHANNELS_HZ: readonly number[] = Object.freeze([
	131_550_000, 131_725_000,
])
export const ACARS_REGION_CHANNELS_HZ: Readonly<
	Partial<Record<BandRegion, readonly number[]>>
> = Object.freeze({
	EU: Object.freeze([
		131_525_000, 131_550_000, 131_725_000, 131_825_000, 131_850_000,
	]),
})

/** The default ACARS channels for `region` (no region, or one without its own list: 131.550/131.725 MHz). */
export function acarsDefaultChannelsHz(region?: BandRegion): readonly number[] {
	return (
		(region !== undefined ? ACARS_REGION_CHANNELS_HZ[region] : undefined) ??
		ACARS_DEFAULT_CHANNELS_HZ
	)
}

/** Options read by the acarsdec adapter and the audio-demod base class. */
export const acarsdecOptionsSchema = z
	.object({
		frequencies: z
			.array(frequencyHz.max(ACARSDEC_BOUNDS.frequencyHz.max))
			.max(ACARSDEC_BOUNDS.maxFrequencies)
			.optional(),
		frequency: frequencyHz.optional(),
		// Read but never used by the adapter.
		gain: z.number().finite().nullable().optional(),
		inputSampleRate: z
			.number()
			.finite()
			.min(ACARSDEC_BOUNDS.sampleRateHz.min)
			.max(ACARSDEC_BOUNDS.sampleRateHz.max)
			.nullable()
			.optional(),
		extraArgs: z
			.array(z.string())
			.max(ACARSDEC_BOUNDS.maxExtraArgs)
			.nullable()
			.optional(),
		channelHz: frequencyHz.nullable().optional(),
		// Experimental, pending measurement (acarsdec.ts acarsChannelFilterStage).
		channelFilter: z.boolean().optional(),
		offsetHz: z.number().finite().optional(),
		debugRecordPath: z.string().nullable().optional(),
		debugRecordStages: z.enum(["demod", "final", "both"]).nullable().optional(),
		inputIqFormat: z.enum(["cu8", "cf32"]).nullable().optional(),
	})
	.strict()

export const acarsdecOptionDescriptors: DecoderOptionDescriptor[] = [
	{
		key: "channelFilter",
		type: "boolean",
		default: false,
		secret: false,
		effect: "restart",
		description:
			"Experimental, pending measurement: a 9.2 kHz AM channel filter before demodulation (flat to ±4.6 kHz, −55 dB at ±5.6 kHz). It rejects 8.33 kHz neighbours but narrows the receiver's frequency tolerance to about 2 ppm.",
	},
	{
		key: "channelHz",
		type: "number",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"The single AM channel to decode; required when several frequencies are set.",
	},
	{
		key: "debugRecordPath",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description: "Directory to save demodulated audio for debugging.",
	},
	{
		key: "debugRecordStages",
		type: "enum",
		enumValues: ["demod", "final", "both"],
		default: "both",
		secret: false,
		effect: "restart",
		description: "Which audio stages to record when debugRecordPath is set.",
	},
	{
		key: "extraArgs",
		type: "string-list",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"Additional acarsdec command line arguments (at most 64 entries).",
	},
	{
		key: "frequencies",
		patchable: true,
		type: "number-list",
		max: ACARSDEC_BOUNDS.frequencyHz.max,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "ACARS frequencies; defaults to 131.550 and 131.725 MHz.",
	},
	{
		key: "frequency",
		patchable: true,
		type: "number",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Single target frequency (used when frequencies is absent).",
	},
	{
		key: "gain",
		type: "number",
		unit: "dB",
		default: null,
		secret: false,
		effect: "restart",
		description: "Gain setting (metadata only).",
	},
	{
		key: "inputIqFormat",
		type: "enum",
		enumValues: ["cu8", "cf32"],
		default: null,
		secret: false,
		effect: "restart",
		description:
			"IQ format the decoder reads; the manager sets it when it feeds channel IQ.",
	},
	{
		key: "inputSampleRate",
		type: "number",
		min: ACARSDEC_BOUNDS.sampleRateHz.min,
		max: ACARSDEC_BOUNDS.sampleRateHz.max,
		unit: "Hz",
		default: 2400000,
		secret: false,
		effect: "restart",
		description: "IQ sample rate of the source.",
	},
	{
		key: "offsetHz",
		type: "number",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Channel offset from the tuned centre.",
	},
]
