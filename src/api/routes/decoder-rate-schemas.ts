const rate = { type: "number", exclusiveMinimum: 0 } as const
const inputKind = {
	type: "string",
	enum: ["iq", "audio_pcm", "external"],
} as const
const accepted = {
	type: "array",
	minItems: 1,
	items: {
		anyOf: [
			{
				type: "object",
				properties: {
					kind: { type: "string", const: "discrete" },
					valuesHz: { type: "array", items: rate, minItems: 1 },
				},
				required: ["kind", "valuesHz"],
			},
			{
				type: "object",
				properties: {
					kind: { type: "string", const: "range" },
					minHz: rate,
					maxHz: rate,
					stepHz: rate,
				},
				required: ["kind", "minHz"],
			},
		],
	},
} as const

export const decoderRateRequirementsSchema = {
	type: "object",
	properties: {
		version: { type: "number", const: 1 },
		sourceKind: inputKind,
		capture: {
			type: "object",
			properties: {
				accepted,
				preferredHz: { type: "array", items: rate },
				minimum: {
					type: "object",
					properties: {
						hz: rate,
						basis: { type: "string", enum: ["implementation", "verified-rf"] },
						evidence: { type: "string" },
					},
					required: ["hz", "basis", "evidence"],
				},
			},
			required: ["accepted", "preferredHz"],
		},
		frontendIq: {
			type: "object",
			properties: { preferredHz: rate, accepted },
			required: ["preferredHz", "accepted"],
		},
		decoderInput: {
			type: "object",
			properties: {
				kind: inputKind,
				format: { type: "string" },
				preferredHz: rate,
				accepted,
			},
			required: ["kind"],
		},
	},
	required: ["version", "sourceKind", "decoderInput"],
} as const

export const decoderRateReasonCodes = [
	"insufficient-sample-rate",
	"unsupported-sample-rate",
	"unsupported-input-kind",
	"unsupported-input-format",
	"unsupported-frontend-rate",
	"unsupported-decoder-input-rate",
	"unknown-requirements",
	"source-rate-unknown",
	"adaptation-unknown",
	"external-input",
] as const

export const decoderRateAssessmentSchema = {
	type: "object",
	properties: {
		verdict: {
			type: "string",
			enum: ["best", "acceptable", "unusable", "unknown"],
		},
		sourceKind: inputKind,
		sourceRateHz: rate,
		frontendRateHz: rate,
		decoderInputKind: inputKind,
		decoderInputRateHz: rate,
		adaptation: {
			type: "string",
			enum: ["none", "integer-decimation", "resample"],
		},
		reasonCode: { type: "string", enum: decoderRateReasonCodes },
		requiredMinimumHz: rate,
		requirementBasis: {
			type: "string",
			enum: ["implementation", "verified-rf"],
		},
	},
	required: ["verdict"],
} as const
