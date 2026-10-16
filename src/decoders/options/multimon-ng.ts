import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { numberOrText } from "./common.js"

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

/** Options read by the multimon-ng adapter and the audio-demod base class. */
export const multimonNgOptionsSchema = z
	.object({
		modes: z.array(z.enum(MODES)).nullable().optional(),
		// `i < null` adds no -v, like an absent verbosity.
		verbosity: z.number().int().min(0).nullable().optional(),
		charset: z.string().nullable().optional(),
		filters: z
			.object({
				// Each is String()ed into an argument: numeric text gives the same one.
				highpass: numberOrText(z.number().finite()).optional(),
				lowpass: numberOrText(z.number().finite()).optional(),
				gain: numberOrText(z.number().finite()).optional(),
			})
			.strict()
			.nullable()
			.optional(),
		inputSampleRate: z.number().finite().positive().nullable().optional(),
		fmGain: z.number().finite().nullable().optional(),
		frequencies: z.array(frequencyHz).nullable().optional(),
		frequency: frequencyHz.nullable().optional(),
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
		default: null,
		secret: false,
		effect: "restart",
		description: "Number of -v flags passed to multimon-ng.",
	},
]
