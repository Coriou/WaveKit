import { z as zod, type z } from "zod"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import {
	LORA_PRESETS,
	LORA_REGIONS,
	RawOptionsSchema,
} from "../builtin/lora-meshtastic.js"

/**
 * The adapter's own strict raw object (its `RawOptionsSchema` minus the transform),
 * so the keys and types can never drift. The transform's one cross-field rule is
 * restated here: samples per symbol (= `oversampling`) must lie in 2..32, so the
 * `oversampling` bound is tightened to match. Unlike the other types the region,
 * preset, frequency and channelKey keys are required: the adapter throws without
 * them.
 */
const rawObject = RawOptionsSchema._def.schema as z.AnyZodObject

export const loraMeshtasticOptionsSchema = rawObject.extend({
	oversampling: zod.number().int().min(2).max(32).optional(),
})

const base = { secret: false, effect: "restart" } as const

export const loraMeshtasticOptionDescriptors: DecoderOptionDescriptor[] = [
	{
		...base,
		key: "bandwidth",
		type: "integer",
		unit: "Hz",
		default: null,
		description: "LoRa bandwidth override; default comes from the preset.",
	},
	{
		...base,
		key: "channelKey",
		type: "string",
		default: null,
		secret: true,
		description: "Meshtastic channel key, padded base64. Required.",
	},
	{
		...base,
		key: "codingRate",
		type: "integer",
		min: 5,
		max: 8,
		default: null,
		description: "Coding rate 5..8 (4/5..4/8); default comes from the preset.",
	},
	{
		...base,
		key: "followCenter",
		type: "boolean",
		default: false,
		description: "Follow the capture centre instead of the fixed frequency.",
	},
	{
		...base,
		key: "frequency",
		type: "integer",
		unit: "Hz",
		default: null,
		description: "Channel frequency. Required.",
	},
	{
		...base,
		key: "inputCenterFreq",
		type: "integer",
		unit: "Hz",
		default: null,
		description: "Capture centre used when followCenter is true.",
	},
	{
		...base,
		key: "inputSampleRate",
		type: "integer",
		unit: "Hz",
		default: 2048000,
		description: "IQ sample rate of the source.",
	},
	{
		...base,
		key: "oversampling",
		type: "integer",
		unit: "x",
		min: 2,
		max: 32,
		default: 8,
		description: "Samples per symbol after decimation.",
	},
	{
		...base,
		key: "preset",
		type: "enum",
		enumValues: [...LORA_PRESETS],
		default: null,
		description: "Meshtastic modem preset. Required.",
	},
	{
		...base,
		key: "region",
		type: "enum",
		enumValues: [...LORA_REGIONS],
		default: null,
		description: "Meshtastic regulatory region. Required.",
	},
	{
		...base,
		key: "spreadingFactor",
		type: "integer",
		min: 6,
		max: 12,
		default: null,
		description: "Spreading factor override; default comes from the preset.",
	},
]
