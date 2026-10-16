/**
 * WG6 (web-gaps-6 req 3): option schema and descriptors of the dumpvdl2 decoder,
 * written from the reads in src/decoders/builtin/dumpvdl2.ts, its base
 * IqDecimateDecoder (channelHz) and resolveDecoderTargetFrequencies
 * (frequencies, frequency).
 */

import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { INTEGER_TEXT, numberOrText } from "./common.js"

const OUTPUT_FORMAT_VALUES = ["json", "text"] as const

/** Bounds by meaning (WG7 HW.2): what the radio hardware and the decoders can take. */
export const DUMPVDL2_BOUNDS = {
	/** Tunable range of the supported SDRs (up to 6 GHz). */
	frequencyHz: { min: 1, max: 6_000_000_000 },
	/** VDL2 channels sit within 136.5-137 MHz; eight dwarfs the three in use. */
	maxFrequencies: 8,
	/** Below 1 kHz is no IQ stream; above 10 Msps is beyond any supported SDR front end. */
	inputSampleRateHz: { min: 1_000, max: 10_000_000 },
	/** One to twenty VDL2 symbol-rate multiples (105 kHz each): dumpvdl2 --oversample. */
	targetSampleRateHz: { min: 105_000, max: 2_100_000 },
	/** Crystal error beyond +-1000 ppm is not a correction but a typo. */
	ppm: { min: -1000, max: 1000 },
	port: { min: 1, max: 65535 },
} as const

const Hz = z
	.number()
	.finite()
	.min(DUMPVDL2_BOUNDS.frequencyHz.min)
	.max(DUMPVDL2_BOUNDS.frequencyHz.max)
const Port = z
	.number()
	.int()
	.min(DUMPVDL2_BOUNDS.port.min)
	.max(DUMPVDL2_BOUNDS.port.max)
const Range = (bounds: { min: number; max: number }) =>
	z.number().finite().min(bounds.min).max(bounds.max)

export const dumpvdl2OptionsSchema = z
	.object({
		channelHz: z.number().finite().positive().nullable().optional(),
		// deviceSerial, gain, ppm, rtlTcpHost and rtlTcpPort are read but never used.
		deviceSerial: z.string().nullable().optional(),
		extraArgs: z.array(z.string()).nullable().optional(),
		followCenter: z.boolean().nullable().optional(),
		// Empty falls back to the built-in channel list.
		frequencies: z.array(Hz).max(DUMPVDL2_BOUNDS.maxFrequencies).optional(),
		frequency: Hz.optional(),
		gain: z.union([z.number().finite(), z.string()]).nullable().optional(),
		// Only String()ed / toString()ed into arguments; null would print "null".
		inputCenterFreq: numberOrText(Hz, INTEGER_TEXT).optional(),
		inputSampleRate: Range(DUMPVDL2_BOUNDS.inputSampleRateHz)
			.nullable()
			.optional(),
		outputFormat: z.enum(OUTPUT_FORMAT_VALUES).nullable().optional(),
		ppm: Range(DUMPVDL2_BOUNDS.ppm).nullable().optional(),
		rtlTcpHost: z.string().nullable().optional(),
		rtlTcpPort: Port.nullable().optional(),
		targetSampleRate: Range(DUMPVDL2_BOUNDS.targetSampleRateHz)
			.nullable()
			.optional(),
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
		max: DUMPVDL2_BOUNDS.frequencyHz.max,
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
		max: DUMPVDL2_BOUNDS.frequencyHz.max,
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
		max: DUMPVDL2_BOUNDS.frequencyHz.max,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description: "Centre of the input IQ (the manager sets it).",
	},
	{
		key: "inputSampleRate",
		type: "number",
		min: DUMPVDL2_BOUNDS.inputSampleRateHz.min,
		max: DUMPVDL2_BOUNDS.inputSampleRateHz.max,
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
		min: DUMPVDL2_BOUNDS.ppm.min,
		max: DUMPVDL2_BOUNDS.ppm.max,
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
		min: DUMPVDL2_BOUNDS.targetSampleRateHz.min,
		max: DUMPVDL2_BOUNDS.targetSampleRateHz.max,
		unit: "Hz",
		default: 1_050_000,
		secret: false,
		effect: "restart",
		description: "Rate the IQ is decimated to for dumpvdl2 (positive).",
	},
]
