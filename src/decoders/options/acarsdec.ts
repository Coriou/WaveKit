import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"

const frequencyHz = z.number().finite().positive()

/** Options read by the acarsdec adapter and the audio-demod base class. */
export const acarsdecOptionsSchema = z
	.object({
		frequencies: z.array(frequencyHz).nullable().optional(),
		frequency: frequencyHz.nullable().optional(),
		// Read but never used by the adapter.
		gain: z.number().finite().nullable().optional(),
		inputSampleRate: z.number().finite().positive().nullable().optional(),
		extraArgs: z.array(z.string()).nullable().optional(),
		channelHz: frequencyHz.nullable().optional(),
		offsetHz: z.number().finite().optional(),
		debugRecordPath: z.string().nullable().optional(),
		debugRecordStages: z.enum(["demod", "final", "both"]).nullable().optional(),
		inputIqFormat: z.enum(["cu8", "cf32"]).nullable().optional(),
	})
	.strict()

export const acarsdecOptionDescriptors: DecoderOptionDescriptor[] = [
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
		description: "Additional acarsdec command line arguments.",
	},
	{
		key: "frequencies",
		type: "number-list",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "ACARS frequencies; defaults to 131.550 and 131.725 MHz.",
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
