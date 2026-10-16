/**
 * WG6 (web-gaps-6 req 3): option schema and descriptors of the dsd-fme decoder,
 * written from the reads in src/decoders/builtin/dsd-fme.ts, its base
 * AudioDemodDecoder (channelHz, debugRecordPath, debugRecordStages, inputIqFormat,
 * offsetHz), resolveDecoderTargetFrequencies (frequencies, frequency) and the keys
 * src/core/digital-voice.ts routeConfig injects (output, udpHost, udpPort, voiceSlot).
 */

import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { INTEGER_TEXT, numberOrText } from "./common.js"

const DSD_FME_MODE_VALUES = [
	"auto",
	"dmr",
	"p25",
	"ysf",
	"dstar",
	"nxdn",
	"nxdn48",
	"dpmr",
	"provoice",
] as const

const OUTPUT_VALUES = ["null", "wav", "udp"] as const
const DEBUG_STAGE_VALUES = ["demod", "final", "both"] as const
const IQ_FORMAT_VALUES = ["cu8", "cf32"] as const
const VOICE_SLOT_VALUES = ["1", "2", "both"] as const

const Hz = z.number().finite().min(1)

/** Timers (call start delay, timeout, minimum duration): at most 24 h. */
export const DSD_FME_DURATION_MS_MAX = 86_400_000
/** Linear `csdr gain` multiplier; equals audio-demod-decoder FM_GAIN_MAX (+60 dB). */
export const DSD_FME_FM_GAIN_MAX = 1000
/** Equals iq-decimate-decoder SAMPLE_RATE_MAX_HZ: above every supported front end. */
export const DSD_FME_SAMPLE_RATE_MAX_HZ = 64_000_000
/** Retention by age: at most one year (8 760 h); the default is a week. */
export const DSD_FME_RECORDING_MAX_AGE_HOURS_MAX = 8760
/** Retention by size: at most 1 TiB (1 048 576 MB); the default is 512 MB. */
export const DSD_FME_RECORDING_MAX_TOTAL_MB_MAX = 1_048_576
/** Target frequency lists: the decoder's channel limit for single-channel adapters. */
export const DSD_FME_FREQUENCIES_MAX = 64

export const dsdFmeOptionsSchema = z
	.object({
		// Timers are bounded to 24 h (DSD_FME_DURATION_MS_MAX), as the adapter clamps.
		callStartDelayMs: z
			.number()
			.finite()
			.min(0)
			.max(DSD_FME_DURATION_MS_MAX)
			.nullable()
			.optional(),
		callTimeoutMs: z
			.number()
			.finite()
			.positive()
			.max(DSD_FME_DURATION_MS_MAX)
			.nullable()
			.optional(),
		channelHz: z.number().finite().positive().nullable().optional(),
		debugRecordPath: z.string().nullable().optional(),
		debugRecordStages: z.enum(DEBUG_STAGE_VALUES).nullable().optional(),
		emitDebugEvents: z.boolean().nullable().optional(),
		enableIqAgc: z.boolean().nullable().optional(),
		enablePerCallRecording: z.boolean().nullable().optional(),
		// The adapter String()s every element before filtering reserved flags.
		extraArgs: z
			.array(z.union([z.string(), z.number(), z.boolean()]))
			.nullable()
			.optional(),
		// Linear csdr gain multiplier, 0 to +60 dB (the adapter clamps to it).
		fmGain: z
			.number()
			.finite()
			.min(0)
			.max(DSD_FME_FM_GAIN_MAX)
			.nullable()
			.optional(),
		// At most the decoder's channel limit of target frequencies.
		frequencies: z.array(Hz).max(DSD_FME_FREQUENCIES_MAX).optional(),
		frequency: Hz.optional(),
		inputIqFormat: z.enum(IQ_FORMAT_VALUES).nullable().optional(),
		// Rate bound: above every supported front end (the adapter clamps to it).
		inputSampleRate: z
			.number()
			.finite()
			.positive()
			.max(DSD_FME_SAMPLE_RATE_MAX_HZ)
			.nullable()
			.optional(),
		minCallDurationMs: z
			.number()
			.finite()
			.min(0)
			.max(DSD_FME_DURATION_MS_MAX)
			.nullable()
			.optional(),
		mode: z.enum(DSD_FME_MODE_VALUES).nullable().optional(),
		offsetHz: z.number().finite().optional(),
		// YAML `output: null` (unquoted) reaches the adapter as null, read as "null".
		output: z.enum(OUTPUT_VALUES).nullable().optional(),
		perCallRecordingDir: z.string().nullable().optional(),
		// Retention bounds (constants above), as the adapter clamps.
		perCallRecordingMaxAgeHours: z
			.number()
			.finite()
			.positive()
			.max(DSD_FME_RECORDING_MAX_AGE_HOURS_MAX)
			.nullable()
			.optional(),
		perCallRecordingMaxTotalMb: z
			.number()
			.finite()
			.positive()
			.max(DSD_FME_RECORDING_MAX_TOTAL_MB_MAX)
			.nullable()
			.optional(),
		perCallRecordingPrune: z.boolean().nullable().optional(),
		udpHost: z.string().nullable().optional(),
		// Only in the `udp:${host}:${port}` argument, guarded by truthiness.
		udpPort: numberOrText(z.number().int().min(1).max(65535), INTEGER_TEXT)
			.nullable()
			.optional(),
		// The adapter maps "1"/"2" to 1/2 before checking.
		voiceSlot: z
			.union([z.literal(1), z.literal(2), z.enum(VOICE_SLOT_VALUES)])
			.optional(),
		wavDir: z.string().nullable().optional(),
	})
	.strict()

export const dsdFmeOptionDescriptors: DecoderOptionDescriptor[] = [
	{
		key: "callStartDelayMs",
		type: "number",
		min: 0,
		max: DSD_FME_DURATION_MS_MAX,
		unit: "ms",
		default: 100,
		secret: false,
		effect: "restart",
		description: "Delay before a detected call is reported as started.",
	},
	{
		key: "callTimeoutMs",
		type: "number",
		max: DSD_FME_DURATION_MS_MAX,
		unit: "ms",
		default: 4000,
		secret: false,
		effect: "restart",
		description:
			"Fallback call end when no line of the call arrives for this long (positive).",
	},
	{
		key: "channelHz",
		type: "number",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Absolute RF centre of the wanted channel (positive).",
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
		enumValues: [...DEBUG_STAGE_VALUES],
		default: "both",
		secret: false,
		effect: "restart",
		description: "Pipeline stages recorded when debugRecordPath is set.",
	},
	{
		key: "emitDebugEvents",
		type: "boolean",
		default: false,
		secret: false,
		effect: "restart",
		description: "Emit debug events for unparsed dsd-fme lines.",
	},
	{
		key: "enableIqAgc",
		type: "boolean",
		default: true,
		secret: false,
		effect: "restart",
		description: "Apply AGC to the IQ front end for weak signals.",
	},
	{
		key: "enablePerCallRecording",
		type: "boolean",
		default: false,
		secret: false,
		effect: "restart",
		description: "Write one WAV file per call to perCallRecordingDir.",
	},
	{
		key: "extraArgs",
		type: "string-list",
		default: null,
		// Privacy keys (RC4/AES/basic privacy) can only reach dsd-fme through extra args.
		secret: true,
		effect: "restart",
		description:
			"Extra dsd-fme arguments (mode and audio output flags are dropped); may carry privacy keys.",
	},
	{
		key: "fmGain",
		type: "number",
		min: 0,
		max: DSD_FME_FM_GAIN_MAX,
		default: 2,
		secret: false,
		effect: "restart",
		description: "Gain applied after FM demodulation.",
	},
	{
		key: "frequencies",
		type: "number-list",
		min: 1,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Target frequencies reported for this decoder.",
	},
	{
		key: "frequency",
		type: "number",
		min: 1,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Target frequency reported for this decoder.",
	},
	{
		key: "inputIqFormat",
		type: "enum",
		enumValues: [...IQ_FORMAT_VALUES],
		default: null,
		secret: false,
		effect: "restart",
		description: "IQ input sample format (set by the manager for channel IQ).",
	},
	{
		key: "inputSampleRate",
		type: "number",
		max: DSD_FME_SAMPLE_RATE_MAX_HZ,
		unit: "Hz",
		default: 2_400_000,
		secret: false,
		effect: "restart",
		description:
			"IQ input sample rate (positive; the manager sets it from the source).",
	},
	{
		key: "minCallDurationMs",
		type: "number",
		min: 0,
		max: DSD_FME_DURATION_MS_MAX,
		unit: "ms",
		default: 250,
		secret: false,
		effect: "restart",
		description: "Calls shorter than this are dropped.",
	},
	{
		key: "mode",
		type: "enum",
		enumValues: [...DSD_FME_MODE_VALUES],
		default: "auto",
		secret: false,
		effect: "restart",
		description: "Digital voice protocol to decode.",
	},
	{
		key: "offsetHz",
		type: "number",
		unit: "Hz",
		default: 0,
		secret: false,
		effect: "restart",
		description:
			"Carrier offset from the centre shifted to DC before decimation.",
	},
	{
		key: "output",
		type: "enum",
		enumValues: [...OUTPUT_VALUES],
		default: "null",
		secret: false,
		effect: "restart",
		description: "Decoded audio destination: none, per-call WAV files or UDP.",
	},
	{
		key: "perCallRecordingDir",
		type: "string",
		default: "/app/decoded_calls",
		secret: false,
		effect: "restart",
		description: "Directory for per-call WAV recordings.",
	},
	{
		key: "perCallRecordingMaxAgeHours",
		type: "number",
		max: DSD_FME_RECORDING_MAX_AGE_HOURS_MAX,
		unit: "h",
		default: 168,
		secret: false,
		effect: "restart",
		description: "Prune per-call recordings older than this (positive).",
	},
	{
		key: "perCallRecordingMaxTotalMb",
		type: "number",
		max: DSD_FME_RECORDING_MAX_TOTAL_MB_MAX,
		unit: "MB",
		default: 512,
		secret: false,
		effect: "restart",
		description:
			"Prune the oldest per-call recordings above this total (positive).",
	},
	{
		key: "perCallRecordingPrune",
		type: "boolean",
		default: true,
		secret: false,
		effect: "restart",
		description: "Prune per-call recordings by age and total size.",
	},
	{
		key: "udpHost",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description: "UDP voice destination host (output udp).",
	},
	{
		key: "udpPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: null,
		secret: false,
		effect: "restart",
		description: "UDP voice destination port (output udp).",
	},
	{
		key: "voiceSlot",
		type: "enum",
		enumValues: [...VOICE_SLOT_VALUES],
		default: null,
		secret: false,
		effect: "restart",
		description: "TDMA voice slots to synthesise (1, 2 or both).",
	},
	{
		key: "wavDir",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"Directory for WAV files with output wav (else perCallRecordingDir).",
	},
]
