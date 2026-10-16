import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { numberOrText } from "./common.js"

const frequencyHz = z.number().finite().positive()

/** Bounds by meaning (WG7 HW.2): what the radio hardware and the decoders can take. */
export const AIS_CATCHER_BOUNDS = {
	/** A hand-written argv tail; thousands of entries is a mistake or an attack. */
	maxExtraArgs: 64,
	/** Every TCP port. */
	port: { min: 1, max: 65535 },
	/** RTL-SDR tuner gains top out near 50 dB; 60 dB covers every supported SDR. */
	gainDb: { min: 0, max: 60 },
	/** Crystal error beyond +-1000 ppm is not a correction but a typo. */
	ppm: { min: -1000, max: 1000 },
	/** Below 1 kHz is no IQ stream; above 10 Msps is beyond any supported SDR front end. */
	sampleRateHz: { min: 1_000, max: 10_000_000 },
} as const

const port = z
	.number()
	.int()
	.min(AIS_CATCHER_BOUNDS.port.min)
	.max(AIS_CATCHER_BOUNDS.port.max)
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
		gain: numberOrText(
			z
				.number()
				.finite()
				.min(AIS_CATCHER_BOUNDS.gainDb.min)
				.max(AIS_CATCHER_BOUNDS.gainDb.max),
		).optional(),
		ppm: numberOrText(
			z
				.number()
				.finite()
				.min(AIS_CATCHER_BOUNDS.ppm.min)
				.max(AIS_CATCHER_BOUNDS.ppm.max),
		).optional(),
		outputFormat: z.enum(["nmea", "json"]).nullable().optional(),
		outputPort: port.nullable().optional(),
		inputSampleRate: z
			.number()
			.finite()
			.min(AIS_CATCHER_BOUNDS.sampleRateHz.min)
			.max(AIS_CATCHER_BOUNDS.sampleRateHz.max)
			.nullable()
			.optional(),
		extraArgs: z
			.array(z.string())
			.max(AIS_CATCHER_BOUNDS.maxExtraArgs)
			.nullable()
			.optional(),
		frequencies: z.array(frequencyHz).optional(),
		frequency: frequencyHz.optional(),
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
		description:
			"Additional AIS-catcher command line arguments (at most 64 entries).",
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
		min: AIS_CATCHER_BOUNDS.gainDb.min,
		max: AIS_CATCHER_BOUNDS.gainDb.max,
		unit: "dB",
		default: null,
		description: "Tuner gain (-gr tuner=).",
	},
	{
		...base,
		key: "inputSampleRate",
		type: "number",
		min: AIS_CATCHER_BOUNDS.sampleRateHz.min,
		max: AIS_CATCHER_BOUNDS.sampleRateHz.max,
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
		min: AIS_CATCHER_BOUNDS.ppm.min,
		max: AIS_CATCHER_BOUNDS.ppm.max,
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
