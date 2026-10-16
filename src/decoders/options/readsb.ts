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
const Port = z.number().int().min(1).max(65535)

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
		extraArgs: z.array(z.string()).nullable().optional(),
		frequencies: z.array(Hz).optional(),
		frequency: Hz.optional(),
		// Passed through toString(): a number or readsb's own text (e.g. "auto").
		gain: z.union([z.number().finite(), z.string()]).optional(),
		inputSampleRate: z.number().finite().positive().nullable().optional(),
		// coordinate() reads anything but a finite number in range as unset.
		lat: z.number().finite().min(-90).max(90).nullable().optional(),
		lon: z.number().finite().min(-180).max(180).nullable().optional(),
		outputFormat: z.enum(OUTPUT_FORMAT_VALUES).nullable().optional(),
		// Also the TCP port the producer connects to, so it stays a number.
		outputPort: Port.nullable().optional(),
		// Passed through toString(): numeric text gives the same argument.
		ppm: numberOrText(z.number().finite()).optional(),
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
		description: "Extra readsb command-line arguments.",
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
		description: "Tuner gain in dB (a number) or a readsb gain keyword.",
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
