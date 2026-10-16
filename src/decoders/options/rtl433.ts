import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"

const frequencyHz = z.number().finite().positive()

/** Options read by the rtl_433 adapter and the IQ-decimate base class. */
export const rtl433OptionsSchema = z
	.object({
		analyze: z.boolean().optional(),
		protocols: z.array(z.number().int().min(0)).optional(),
		outputFormat: z.enum(["json", "csv"]).optional(),
		inputSampleRate: z.number().finite().positive().optional(),
		targetSampleRate: z.number().finite().positive().optional(),
		extraArgs: z.array(z.string()).optional(),
		frequencies: z.array(frequencyHz).optional(),
		frequency: frequencyHz.optional(),
		channelHz: frequencyHz.optional(),
	})
	.strict()

export const rtl433OptionDescriptors: DecoderOptionDescriptor[] = [
	{
		key: "analyze",
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
		description: "Additional rtl_433 command line arguments.",
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
		key: "inputSampleRate",
		type: "number",
		unit: "Hz",
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
		type: "number-list",
		min: 0,
		default: null,
		secret: false,
		effect: "restart",
		description: "rtl_433 protocol ids to enable; empty means all.",
	},
	{
		key: "targetSampleRate",
		type: "number",
		unit: "Hz",
		default: 1000000,
		secret: false,
		effect: "restart",
		description: "Sample rate rtl_433 processes after decimation.",
	},
]
