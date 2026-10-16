/**
 * WG6 (web-gaps-6 req 3): option schema and descriptors of the readsb decoder,
 * written from the reads in src/decoders/builtin/readsb.ts (its base
 * NetworkProducerDecoder reads no options) and resolveDecoderTargetFrequencies
 * (frequencies, frequency).
 */

import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { INTEGER_TEXT, numberOrText } from "./common.js"

const OUTPUT_FORMAT_VALUES = ["sbs", "beast", "json"] as const

const Hz = z.number().finite().min(1)

/** Bounds by meaning (WG7 HW.2): what the radio hardware and the decoders can take. */
export const READSB_BOUNDS = {
	/** A hand-written argv tail; thousands of entries is a mistake or an attack. */
	maxExtraArgs: 64,
	/** Every TCP port. */
	port: { min: 1, max: 65535 },
	/** readsb gain in dB: 0..60 covers every supported SDR, and -10 is readsb's "maximum gain". */
	gainDb: { min: -10, max: 60 },
	/** Crystal error beyond +-1000 ppm is not a correction but a typo. */
	ppm: { min: -1000, max: 1000 },
	/** Below 1 kHz is no IQ stream; above 10 Msps is beyond any supported SDR front end. */
	sampleRateHz: { min: 1_000, max: 10_000_000 },
} as const

const Port = z
	.number()
	.int()
	.min(READSB_BOUNDS.port.min)
	.max(READSB_BOUNDS.port.max)

export const readsbOptionsSchema = z
	.object({
		// Passed to readsb as text: an index or a serial.
		device: z
			.union([z.string(), z.number().int().min(0)])
			.nullable()
			.optional(),
		// device, deviceSerial and enableMlat are read but never used by the adapter.
		deviceSerial: z.string().nullable().optional(),
		enableMlat: z.boolean().nullable().optional(),
		extraArgs: z
			.array(z.string())
			.max(READSB_BOUNDS.maxExtraArgs)
			.nullable()
			.optional(),
		frequencies: z.array(Hz).optional(),
		frequency: Hz.optional(),
		// A bounded number (or its text) or the one readsb keyword "auto".
		gain: z
			.union([
				numberOrText(
					z
						.number()
						.finite()
						.min(READSB_BOUNDS.gainDb.min)
						.max(READSB_BOUNDS.gainDb.max),
				),
				z.literal("auto"),
			])
			.optional(),
		inputSampleRate: z
			.number()
			.finite()
			.min(READSB_BOUNDS.sampleRateHz.min)
			.max(READSB_BOUNDS.sampleRateHz.max)
			.nullable()
			.optional(),
		// coordinate() reads anything but a finite number in range as unset.
		lat: z.number().finite().min(-90).max(90).nullable().optional(),
		lon: z.number().finite().min(-180).max(180).nullable().optional(),
		outputFormat: z.enum(OUTPUT_FORMAT_VALUES).nullable().optional(),
		// Also the TCP port the producer connects to, so it stays a number.
		outputPort: Port.nullable().optional(),
		// Passed through toString(): numeric text gives the same argument.
		ppm: numberOrText(
			z.number().finite().min(READSB_BOUNDS.ppm.min).max(READSB_BOUNDS.ppm.max),
		).optional(),
		rtlTcpHost: z.string().nullable().optional(),
		// Only in the `${host},${port ?? 1234},beast_in` argument.
		rtlTcpPort: numberOrText(Port, INTEGER_TEXT).nullable().optional(),
	})
	.strict()

export const readsbOptionDescriptors: DecoderOptionDescriptor[] = [
	{
		key: "device",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description: "RTL-SDR device index or serial (local device mode).",
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
		key: "enableMlat",
		type: "boolean",
		default: false,
		secret: false,
		effect: "restart",
		description: "Forward MLAT timing data (needs lat and lon).",
	},
	{
		key: "extraArgs",
		type: "string-list",
		default: null,
		secret: false,
		effect: "restart",
		description: "Extra readsb command-line arguments (at most 64 entries).",
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
		key: "gain",
		type: "string",
		unit: "dB",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"Tuner gain in dB (-10 to 60; -10 is maximum) or the keyword auto.",
	},
	{
		key: "inputSampleRate",
		type: "number",
		min: READSB_BOUNDS.sampleRateHz.min,
		max: READSB_BOUNDS.sampleRateHz.max,
		unit: "Hz",
		default: null,
		secret: false,
		effect: "restart",
		description:
			"IQ input sample rate (positive; the manager sets it from the source).",
	},
	{
		key: "lat",
		type: "number",
		min: -90,
		max: 90,
		default: null,
		secret: false,
		effect: "restart",
		description: "Receiver latitude in degrees.",
	},
	{
		key: "lon",
		type: "number",
		min: -180,
		max: 180,
		default: null,
		secret: false,
		effect: "restart",
		description: "Receiver longitude in degrees.",
	},
	{
		key: "outputFormat",
		type: "enum",
		enumValues: [...OUTPUT_FORMAT_VALUES],
		default: "sbs",
		secret: false,
		effect: "restart",
		description: "readsb network output read by WaveKit.",
	},
	{
		key: "outputPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: null,
		secret: false,
		effect: "restart",
		description:
			"readsb output port (default by format: sbs 30003, beast 30005, json 30047).",
	},
	{
		key: "ppm",
		type: "number",
		min: READSB_BOUNDS.ppm.min,
		max: READSB_BOUNDS.ppm.max,
		unit: "ppm",
		default: null,
		secret: false,
		effect: "restart",
		description: "Frequency correction.",
	},
	{
		key: "rtlTcpHost",
		type: "string",
		default: null,
		secret: false,
		effect: "restart",
		description: "rtl_tcp host; readsb then owns its input.",
	},
	{
		key: "rtlTcpPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: 1234,
		secret: false,
		effect: "restart",
		description: "rtl_tcp port.",
	},
]
