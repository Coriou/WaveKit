/**
 * WG6 (web-gaps-6 req 3): option schema and descriptors of the dumpvdl2 decoder,
 * written from the reads in src/decoders/builtin/dumpvdl2.ts, its base
 * IqDecimateDecoder (channelHz) and resolveDecoderTargetFrequencies
 * (frequencies, frequency).
 */

import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"

const OUTPUT_FORMAT_VALUES = ["json", "text"] as const

const Hz = z.number().finite().min(1)
const Port = z.number().int().min(1).max(65535)

export const dumpvdl2OptionsSchema = z
	.object({
		channelHz: z.number().finite().positive().optional(),
		deviceSerial: z.string().optional(),
		extraArgs: z.array(z.string()).optional(),
		followCenter: z.boolean().optional(),
		// Empty falls back to the built-in channel list.
		frequencies: z.array(Hz).optional(),
		frequency: Hz.optional(),
		gain: z.union([z.number().finite(), z.string()]).optional(),
		inputCenterFreq: Hz.optional(),
		inputSampleRate: z.number().finite().positive().optional(),
		outputFormat: z.enum(OUTPUT_FORMAT_VALUES).optional(),
		ppm: z.number().finite().optional(),
		rtlTcpHost: z.string().optional(),
		rtlTcpPort: Port.optional(),
		targetSampleRate: z.number().finite().positive().optional(),
	})
	.strict()

export const dumpvdl2OptionDescriptors: DecoderOptionDescriptor[] = [
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
		key: "deviceSerial",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description: "RTL-SDR device serial number (local device mode).",
	},
	{
		key: "extraArgs",
		type: "string-list",
		default: null,
		secret: false,
		effect: "restart",
		description: "Extra dumpvdl2 command-line arguments.",
	},
	{
		key: "followCenter",
		type: "boolean",
		default: false,
		secret: false,
		effect: "restart",
		description: "Decode the capture centre instead of the channel list.",
	},
	{
		key: "frequencies",
		type: "number-list",
		min: 1,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "VDL2 channels (default 136.650, 136.700, 136.975 MHz).",
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
		key: "gain",
		type: "string",
		unit: "dB",
		default: null,
		secret: false,
		effect: "restart",
		description: "Tuner gain (unused when reading the core stream).",
	},
	{
		key: "inputCenterFreq",
		type: "number",
		min: 1,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Centre of the input IQ (the manager sets it).",
	},
	{
		key: "inputSampleRate",
		type: "number",
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"IQ input sample rate (positive; the manager sets it from the source).",
	},
	{
		key: "outputFormat",
		type: "enum",
		enumValues: [...OUTPUT_FORMAT_VALUES],
		default: "json",
		secret: false,
		effect: "restart",
		description: "dumpvdl2 output format read by WaveKit.",
	},
	{
		key: "ppm",
		type: "number",
		unit: "ppm",
		default: null,
		secret: false,
		effect: "restart",
		description: "Frequency correction (unused when reading the core stream).",
	},
	{
		key: "rtlTcpHost",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description: "rtl_tcp host.",
	},
	{
		key: "rtlTcpPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: null,
		secret: false,
		effect: "restart",
		description: "rtl_tcp port.",
	},
	{
		key: "targetSampleRate",
		type: "number",
		unit: "Hz",
		default: 1_050_000,
		secret: false,
		effect: "restart",
		description: "Rate the IQ is decimated to for dumpvdl2 (positive).",
	},
]
