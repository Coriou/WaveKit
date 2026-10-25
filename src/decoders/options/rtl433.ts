import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { INTEGER_TEXT, numberOrText } from "./common.js"

const frequencyHz = z.number().finite().positive()

/** rtl_433 registers about 300 protocol decoders; 999 leaves room for new releases. */
export const RTL433_PROTOCOL_ID_MAX = 999
/** extraArgs is a hand-written argv tail: 64 entries is far past any real one. */
export const RTL433_EXTRA_ARGS_MAX = 64
/** At most 256 `-R` ids: a fraction of the registry, keeps argv bounded. */
export const RTL433_PROTOCOLS_MAX = 256
/** Equals iq-decimate-decoder SAMPLE_RATE_MAX_HZ: above every supported front end. */
export const RTL433_INPUT_SAMPLE_RATE_MAX_HZ = 64_000_000
/** Equals the base classes' 1 kHz floor: below any IQ capture (0 means the default). */
export const RTL433_INPUT_SAMPLE_RATE_MIN_HZ = 1000
/** rtl_433's processing range: its 250 kHz default up to the 3.2 Msps RTL-SDR maximum. */
export const RTL433_TARGET_SAMPLE_RATE_MIN_HZ = 250_000
export const RTL433_TARGET_SAMPLE_RATE_MAX_HZ = 3_200_000
/** Target frequency lists: the decoder's channel limit for single-channel adapters. */
export const RTL433_FREQUENCIES_MAX = 64

/** Options read by the rtl_433 adapter and the IQ-decimate base class. */
export const rtl433OptionsSchema = z
	.object({
		analyze: z.boolean().nullable().optional(),
		// Each protocol is String()ed into `-R`: numeric text gives the same argument.
		// Ids and list length bounded as the adapter clamps them (constants above).
		protocols: z
			.array(
				numberOrText(
					z.number().int().min(0).max(RTL433_PROTOCOL_ID_MAX),
					INTEGER_TEXT,
				),
			)
			.max(RTL433_PROTOCOLS_MAX)
			.nullable()
			.optional(),
		outputFormat: z.enum(["json", "csv"]).nullable().optional(),
		// The manager sets it; out of 1 kHz to 6 GHz the adapter leaves -f out.
		inputCenterFreq: z
			.number()
			.finite()
			.min(1_000)
			.max(6_000_000_000)
			.nullable()
			.optional(),
		// Rate bounds: the adapter clamps to them (constants above).
		inputSampleRate: z
			.number()
			.finite()
			.min(RTL433_INPUT_SAMPLE_RATE_MIN_HZ)
			.max(RTL433_INPUT_SAMPLE_RATE_MAX_HZ)
			.nullable()
			.optional(),
		targetSampleRate: z
			.number()
			.finite()
			.min(RTL433_TARGET_SAMPLE_RATE_MIN_HZ)
			.max(RTL433_TARGET_SAMPLE_RATE_MAX_HZ)
			.nullable()
			.optional(),
		// Hand-written argv tail, capped (the adapter slices to the same bound).
		extraArgs: z
			.array(z.string())
			.max(RTL433_EXTRA_ARGS_MAX)
			.nullable()
			.optional(),
		// At most the decoder's channel limit of target frequencies.
		frequencies: z.array(frequencyHz).max(RTL433_FREQUENCIES_MAX).optional(),
		frequency: frequencyHz.optional(),
		channelHz: frequencyHz.nullable().optional(),
	})
	.strict()

export const rtl433OptionDescriptors: DecoderOptionDescriptor[] = [
	{
		key: "analyze",
		patchable: true,
		type: "boolean",
		default: false,
		secret: false,
		effect: "restart",
		description: "Enable rtl_433 analyze mode for unknown signals.",
	},
	{
		key: "channelHz",
		type: "number",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"Absolute RF centre of the wanted channel (channelizer input).",
	},
	{
		key: "extraArgs",
		type: "string-list",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"Additional rtl_433 command line arguments. At most 64 entries.",
	},
	{
		key: "frequencies",
		patchable: true,
		type: "number-list",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Target frequencies; declares the band the decoder needs.",
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
		key: "inputCenterFreq",
		type: "number",
		min: 1_000,
		max: 6_000_000_000,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Centre of the input IQ, passed as -f (the manager sets it).",
	},
	{
		key: "inputSampleRate",
		type: "number",
		unit: "Hz",
		min: RTL433_INPUT_SAMPLE_RATE_MIN_HZ,
		max: RTL433_INPUT_SAMPLE_RATE_MAX_HZ,
		default: 2048000,
		secret: false,
		effect: "restart",
		description: "IQ sample rate of the source.",
	},
	{
		key: "outputFormat",
		type: "enum",
		enumValues: ["json", "csv"],
		default: "json",
		secret: false,
		effect: "restart",
		description: "rtl_433 output format; json is required for parsing.",
	},
	{
		key: "protocols",
		patchable: true,
		type: "number-list",
		min: 0,
		max: RTL433_PROTOCOL_ID_MAX,
		default: null,
		secret: false,
		effect: "restart",
		description: "rtl_433 protocol ids to enable; empty means all.",
	},
	{
		key: "targetSampleRate",
		type: "number",
		unit: "Hz",
		min: RTL433_TARGET_SAMPLE_RATE_MIN_HZ,
		max: RTL433_TARGET_SAMPLE_RATE_MAX_HZ,
		default: 1000000,
		secret: false,
		effect: "restart",
		description: "Sample rate rtl_433 processes after decimation.",
	},
]
