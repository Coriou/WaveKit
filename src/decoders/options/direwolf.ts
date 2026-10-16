import { z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import { INTEGER_TEXT, numberOrText } from "./common.js"

const frequencyHz = z.number().finite().positive()
const port = z.number().int().min(1).max(65535)

/** Options read by the Direwolf adapter and the audio-demod base class. */
export const direwolfOptionsSchema = z
	.object({
		// audioDevice, sampleRate and callsign are read but never used by the adapter.
		audioDevice: z.string().nullable().optional(),
		sampleRate: z.number().finite().positive().nullable().optional(),
		// Also the TCP port the adapter connects to, so it stays a number.
		kissPort: port.nullable().optional(),
		// Only `(agwPort ?? default).toString()`: numeric text gives the same argument.
		agwPort: numberOrText(port, INTEGER_TEXT).nullable().optional(),
		callsign: z.string().nullable().optional(),
		extraArgs: z.array(z.string()).nullable().optional(),
		inputSampleRate: z.number().finite().positive().nullable().optional(),
		frequencies: z.array(frequencyHz).nullable().optional(),
		frequency: frequencyHz.nullable().optional(),
		channelHz: frequencyHz.nullable().optional(),
		offsetHz: z.number().finite().optional(),
		debugRecordPath: z.string().nullable().optional(),
		debugRecordStages: z.enum(["demod", "final", "both"]).nullable().optional(),
		inputIqFormat: z.enum(["cu8", "cf32"]).nullable().optional(),
	})
	.strict()

const base = { secret: false, effect: "restart" } as const

export const direwolfOptionDescriptors: DecoderOptionDescriptor[] = [
	{
		...base,
		key: "agwPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: 8000,
		description: "TCP port for the AGW protocol.",
	},
	{
		...base,
		key: "audioDevice",
		type: "string",
		default: null,
		description: "Audio device, or stdin for piped audio.",
	},
	{
		...base,
		key: "callsign",
		type: "string",
		default: null,
		description: "Station callsign.",
	},
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
		key: "debugRecordPath",
		type: "string",
		default: null,
		description: "Directory to save demodulated audio for debugging.",
	},
	{
		...base,
		key: "debugRecordStages",
		type: "enum",
		enumValues: ["demod", "final", "both"],
		default: "both",
		description: "Which audio stages to record when debugRecordPath is set.",
	},
	{
		...base,
		key: "extraArgs",
		type: "string-list",
		default: null,
		description: "Additional Direwolf command line arguments.",
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
		key: "inputIqFormat",
		type: "enum",
		enumValues: ["cu8", "cf32"],
		default: null,
		description:
			"IQ format the decoder reads; the manager sets it when it feeds channel IQ.",
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
		key: "kissPort",
		type: "integer",
		min: 1,
		max: 65535,
		default: 8001,
		description: "TCP port for KISS packet output.",
	},
	{
		...base,
		key: "offsetHz",
		type: "number",
		unit: "Hz",
		default: null,
		description: "Channel offset from the tuned centre.",
	},
	{
		...base,
		key: "sampleRate",
		type: "number",
		unit: "Hz",
		default: 48000,
		description: "Audio sample rate (the adapter fixes 48000).",
	},
]
