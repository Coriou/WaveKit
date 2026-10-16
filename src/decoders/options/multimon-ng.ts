import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { INTEGER_TEXT, numberOrText } from "./common.js"

/** Modes `multimon-ng.ts` accepts (MULTIMON_MODES); others are dropped with a warning. */
const MODES = [
	"POCSAG512",
	"POCSAG1200",
	"POCSAG2400",
	"FLEX",
	"EAS",
	"AFSK1200",
	"FSK9600",
	"DTMF",
] as const

const frequencyHz = z.number().finite().positive()

/** Bound on `verbosity`: the adapter pushes one -v per step; multimon-ng gains nothing past a few. */
export const MULTIMON_VERBOSITY_MAX = 10
/** Filter corners in Hz: multimon-ng reads 22 050 Hz audio, Nyquist 11 025 Hz. */
export const MULTIMON_FILTER_HZ_MAX = 11_025
/** Filter gain in dB, symmetric: ±60 dB is ×1000 amplitude, past any usable level. */
export const MULTIMON_FILTER_GAIN_DB_MAX = 60
/** Linear `csdr gain` multiplier; equals audio-demod-decoder FM_GAIN_MAX (+60 dB). */
export const MULTIMON_FM_GAIN_MAX = 1000
/** Equals iq-decimate-decoder SAMPLE_RATE_MAX_HZ: above every supported front end. */
export const MULTIMON_SAMPLE_RATE_MAX_HZ = 64_000_000
/** Equals the base classes' 1 kHz floor: below any IQ capture (0 means the default). */
export const MULTIMON_SAMPLE_RATE_MIN_HZ = 1000
/** Target frequency lists: the decoder's channel limit for single-channel adapters. */
export const MULTIMON_FREQUENCIES_MAX = 64

/** Options read by the multimon-ng adapter and the audio-demod base class. */
export const multimonNgOptionsSchema = z
	.object({
		modes: z.array(z.enum(MODES)).nullable().optional(),
		// null adds no -v, like an absent verbosity; "2" coerces. The adapter clamps to
		// MULTIMON_VERBOSITY_MAX (it pushes one -v per step).
		verbosity: numberOrText(
			z.number().int().min(0).max(MULTIMON_VERBOSITY_MAX),
			INTEGER_TEXT,
		)
			.nullable()
			.optional(),
		charset: z.string().nullable().optional(),
		filters: z
			.object({
				// Each is String()ed into an argument: numeric text gives the same one.
				// Bounded as the adapter clamps them (see the constants above).
				highpass: numberOrText(
					z.number().finite().min(0).max(MULTIMON_FILTER_HZ_MAX),
				).optional(),
				lowpass: numberOrText(
					z.number().finite().min(0).max(MULTIMON_FILTER_HZ_MAX),
				).optional(),
				gain: numberOrText(
					z
						.number()
						.finite()
						.min(-MULTIMON_FILTER_GAIN_DB_MAX)
						.max(MULTIMON_FILTER_GAIN_DB_MAX),
				).optional(),
			})
			.strict()
			.nullable()
			.optional(),
		// Rate bound: above every supported front end (the adapter clamps to it).
		inputSampleRate: z
			.number()
			.finite()
			.min(MULTIMON_SAMPLE_RATE_MIN_HZ)
			.max(MULTIMON_SAMPLE_RATE_MAX_HZ)
			.nullable()
			.optional(),
		// Linear csdr gain multiplier, 0 to +60 dB (the adapter clamps to it).
		fmGain: z
			.number()
			.finite()
			.min(0)
			.max(MULTIMON_FM_GAIN_MAX)
			.nullable()
			.optional(),
		// At most the decoder's channel limit of target frequencies.
		frequencies: z.array(frequencyHz).max(MULTIMON_FREQUENCIES_MAX).optional(),
		frequency: frequencyHz.optional(),
		channelHz: frequencyHz.nullable().optional(),
		offsetHz: z.number().finite().optional(),
		debugRecordPath: z.string().nullable().optional(),
		debugRecordStages: z.enum(["demod", "final", "both"]).nullable().optional(),
		inputIqFormat: z.enum(["cu8", "cf32"]).nullable().optional(),
	})
	.strict()

export const multimonNgOptionDescriptors: DecoderOptionDescriptor[] = [
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
		key: "charset",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description: "Character set passed to multimon-ng (-c).",
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
		key: "filters",
		type: "object",
		default: null,
		secret: false,
		effect: "restart",
		description: "Audio filters: highpass and lowpass in Hz, gain in dB.",
	},
	{
		key: "fmGain",
		type: "number",
		min: 0,
		max: MULTIMON_FM_GAIN_MAX,
		default: 3,
		secret: false,
		effect: "restart",
		description: "Gain applied after FM demodulation.",
	},
	{
		key: "frequencies",
		type: "number-list",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Target frequencies; declares the band the decoder needs.",
	},
	{
		key: "frequency",
		type: "number",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Single target frequency (used when frequencies is absent).",
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
		unit: "Hz",
		min: MULTIMON_SAMPLE_RATE_MIN_HZ,
		max: MULTIMON_SAMPLE_RATE_MAX_HZ,
		default: 2400000,
		secret: false,
		effect: "restart",
		description: "IQ sample rate of the source.",
	},
	{
		key: "modes",
		type: "string-list",
		enumValues: [...MODES],
		default: null,
		secret: false,
		effect: "restart",
		description: "Protocols to decode; empty or absent means the POCSAG modes.",
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
	{
		key: "verbosity",
		type: "integer",
		min: 0,
		max: MULTIMON_VERBOSITY_MAX,
		default: null,
		secret: false,
		effect: "restart",
		description: "Number of -v flags passed to multimon-ng.",
	},
]
