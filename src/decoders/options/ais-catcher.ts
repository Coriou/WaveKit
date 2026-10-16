import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { numberOrText } from "./common.js"

const frequencyHz = z.number().finite().positive()
const port = z.number().int().min(1).max(65535)
/** YAML turns `00000001` or `0` into numbers, so identifiers accept both. */
const stringOrNumber = z.union([z.string(), z.number()])

/** Options read by the AIS-catcher adapter and the IQ-decimate base class. */
export const aisCatcherOptionsSchema = z
	.object({
		// device..spyServerPort and outputPort are read but never used by the adapter.
		device: stringOrNumber.nullable().optional(),
		deviceSerial: stringOrNumber.nullable().optional(),
		rtlTcpHost: z.string().nullable().optional(),
		rtlTcpPort: port.nullable().optional(),
		spyServerHost: z.string().nullable().optional(),
		spyServerPort: port.nullable().optional(),
		// `tuner=${gain}` and ppm.toString(): numeric text gives the same argument.
		gain: numberOrText(z.number().finite()).optional(),
		ppm: numberOrText(z.number().finite()).optional(),
		outputFormat: z.enum(["nmea", "json"]).nullable().optional(),
		outputPort: port.nullable().optional(),
		inputSampleRate: z.number().finite().positive().nullable().optional(),
		extraArgs: z.array(z.string()).nullable().optional(),
		frequencies: z.array(frequencyHz).nullable().optional(),
		frequency: frequencyHz.nullable().optional(),
		channelHz: frequencyHz.nullable().optional(),
	})
	.strict()

const base = { secret: false, effect: "restart" } as const

export const aisCatcherOptionDescriptors: DecoderOptionDescriptor[] = [
	{
		...base,
		key: "channelHz",
		type: "number",
		unit: "Hz",
		default: null,
		description:
			"Absolute RF centre of the wanted channel (channelizer input).",
	},
	{
		...base,
		key: "device",
		type: "string",
		default: null,
		description: "RTL-SDR device index.",
	},
	{
		...base,
		key: "deviceSerial",
		type: "string",
		default: null,
		description: "RTL-SDR device serial number.",
	},
	{
		...base,
		key: "extraArgs",
		type: "string-list",
		default: null,
		description: "Additional AIS-catcher command line arguments.",
	},
	{
		...base,
		key: "frequencies",
		type: "number-list",
		unit: "Hz",
		default: null,
		description: "Target frequencies; declares the band the decoder needs.",
	},
	{
		...base,
		key: "frequency",
		type: "number",
		unit: "Hz",
		default: null,
		description: "Single target frequency (used when frequencies is absent).",
	},
	{
		...base,
		key: "gain",
		type: "number",
		unit: "dB",
		default: null,
		description: "Tuner gain (-gr tuner=).",
	},
	{
		...base,
		key: "inputSampleRate",
		type: "number",
		unit: "Hz",
		default: 2400000,
		description: "IQ sample rate of the source.",
	},
	{
		...base,
		key: "outputFormat",
		type: "enum",
		enumValues: ["nmea", "json"],
		default: "nmea",
		description: "AIS-catcher output format.",
	},
	{
		...base,
		key: "outputPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: null,
		description: "UDP port for output.",
	},
	{
		...base,
		key: "ppm",
		type: "number",
		unit: "ppm",
		default: null,
		description: "Frequency correction (-p).",
	},
	{
		...base,
		key: "rtlTcpHost",
		type: "string",
		default: null,
		description: "rtl_tcp host to connect to instead of a local device.",
	},
	{
		...base,
		key: "rtlTcpPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: null,
		description: "rtl_tcp port.",
	},
	{
		...base,
		key: "spyServerHost",
		type: "string",
		default: null,
		description: "SpyServer host to connect to.",
	},
	{
		...base,
		key: "spyServerPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: null,
		description: "SpyServer port.",
	},
]
