/** JSON schemas for /api/scanner (spec § 12.1). Response bodies are DTOs from @wavekit/api-types. */

const protocolEnum = [
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
	"digital-unknown",
	"carrier",
	"unknown",
] as const
const confidenceEnum = [
	"activity",
	"candidate",
	"classified",
	"decoded",
] as const

/**
 * Flat error body. `details` is untyped and extra keys pass: the central handler adds
 * `correlationId`, and its schema-validation errors carry `details` as an array.
 */
export const errorResponseSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string" },
		message: { type: "string" },
		details: {},
	},
	required: ["error", "code", "message"],
	additionalProperties: true,
} as const

export const looseObjectSchema = {
	type: "object",
	additionalProperties: true,
} as const

const rangeSchema = {
	type: "object",
	properties: {
		startHz: { type: "number", minimum: 0 },
		endHz: { type: "number", minimum: 0 },
		spacingHz: { type: "number", exclusiveMinimum: 0 },
		firstChannelHz: { type: "number" },
		rasters: {
			type: "array",
			items: {
				type: "object",
				properties: {
					spacingHz: { type: "number", exclusiveMinimum: 0 },
					firstChannelHz: { type: "number" },
				},
				required: ["spacingHz", "firstChannelHz"],
				additionalProperties: false,
			},
		},
		obwHz: { type: "array", items: { type: "number", exclusiveMinimum: 0 } },
		protocols: { type: "array", items: { type: "string", enum: protocolEnum } },
		bandplanId: { type: "string" },
	},
	required: ["startHz", "endHz"],
	// § 5.1 shorthand: spacingHz (+ optional firstChannelHz) is one raster; the route converts it.
	dependencies: { firstChannelHz: ["spacingHz"] },
	not: { required: ["spacingHz", "rasters"] },
	additionalProperties: false,
} as const

/** § 5.1: `{startHz, endHz}` or a frequency with a width; the route converts the latter. */
const exclusionSchema = {
	type: "object",
	properties: {
		startHz: { type: "number", minimum: 0 },
		endHz: { type: "number", minimum: 0 },
		frequencyHz: { type: "number", minimum: 0 },
		widthHz: { type: "number", exclusiveMinimum: 0 },
		reason: { type: "string", maxLength: 200 },
	},
	oneOf: [
		{ required: ["startHz", "endHz"] },
		{ required: ["frequencyHz", "widthHz"] },
	],
	additionalProperties: false,
} as const

/** ScanJobSpec (spec § 10.1); semantic validation happens in the plan preview. */
export const scanJobSpecSchema = {
	type: "object",
	properties: {
		name: { type: "string", maxLength: 100 },
		sourceId: { type: "string", minLength: 1 },
		mode: { type: "string", enum: ["in-window", "sweep", "auto"] },
		kind: { type: "string", enum: ["discover", "monitor"] },
		ranges: { type: "array", items: rangeSchema, maxItems: 64 },
		bandplans: { type: "array", items: { type: "string" }, maxItems: 16 },
		exclusions: { type: "array", items: exclusionSchema, maxItems: 256 },
		protocols: { type: "array", items: { type: "string", enum: protocolEnum } },
		sensitivity: { type: "string", enum: ["low", "normal", "high"] },
		thresholdDb: { type: "number", minimum: 0, maximum: 40 },
		fftSize: { type: "integer", enum: [512, 1024, 2048, 4096, 8192, 16384] },
		integrationMs: { type: "number", minimum: 5, maximum: 1000 },
		dwellMs: { type: "number", minimum: 10, maximum: 600000 },
		settleMs: { type: "number", minimum: 0, maximum: 10000 },
		hold: {
			type: "object",
			properties: {
				policy: { type: "string", enum: ["hold", "confirm", "never"] },
				confirmHoldMs: { type: "number", minimum: 0, maximum: 600000 },
				maxHoldMs: { type: "number", minimum: 0, maximum: 3600000 },
				hangMs: { type: "number", minimum: 0, maximum: 60000 },
			},
			required: ["policy"],
			additionalProperties: false,
		},
		revisit: {
			type: "object",
			properties: {
				share: { type: "number", minimum: 0, maximum: 1 },
				maxIntervalMs: { type: "number", minimum: 0 },
			},
			additionalProperties: false,
		},
		record: {
			type: "object",
			properties: {
				voice: { type: "boolean" },
				analog: { type: "boolean" },
				data: { type: "boolean" },
			},
			additionalProperties: false,
		},
		evidence: {
			type: "object",
			properties: { psd: { type: "boolean" }, iq: { type: "boolean" } },
			additionalProperties: false,
		},
		tuner: {
			type: "object",
			properties: {
				sampleRateHz: { type: "integer", minimum: 225001, maximum: 3200000 },
				gainTenthsDb: { type: "integer", minimum: 0, maximum: 500 },
				agc: { type: "boolean" },
				overload: { type: "string", enum: ["flag", "reduce-gain"] },
			},
			additionalProperties: false,
		},
		stop: {
			type: "object",
			properties: {
				afterSweeps: { type: "integer", minimum: 1 },
				afterMs: { type: "integer", minimum: 1000 },
				onFirstDecoded: { type: "boolean" },
			},
			additionalProperties: false,
		},
		priority: { type: "integer", minimum: 0, maximum: 100 },
		takeover: { type: "boolean" },
		resume: {
			type: "object",
			properties: {
				autoAfterIdleMs: {
					anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
				},
				onBoot: { type: "boolean" },
			},
			additionalProperties: false,
		},
		txDurationHintMs: { type: "integer", minimum: 100, maximum: 600000 },
		monitor: looseObjectSchema,
	},
	additionalProperties: false,
} as const

export const jobIdParamsSchema = {
	type: "object",
	properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
	required: ["id"],
} as const

export const resumeBodySchema = {
	type: ["object", "null"],
	properties: { takeover: { type: "boolean" } },
	additionalProperties: false,
} as const

export const discoveryQuerySchema = {
	type: "object",
	properties: {
		jobId: { type: "string" },
		sourceId: { type: "string" },
		protocol: { type: "string", enum: protocolEnum },
		minConfidence: { type: "string", enum: confidenceEnum },
		freqMinHz: { type: "number", minimum: 0 },
		freqMaxHz: { type: "number", minimum: 0 },
		since: { type: "string", format: "date-time" },
		encrypted: { type: "boolean" },
		q: { type: "string", maxLength: 100 },
		sort: { type: "string", enum: ["lastSeen", "frequency", "confidence"] },
		cursor: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
	},
	additionalProperties: false,
} as const

export const observationsQuerySchema = {
	type: "object",
	properties: {
		cursor: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
	},
	additionalProperties: false,
} as const

export const discoveryPatchSchema = {
	type: "object",
	properties: {
		label: { type: "string", maxLength: 100 },
		notes: { type: "string", maxLength: 2000 },
		lockout: { type: "boolean" },
		keep: { type: "boolean" },
	},
	additionalProperties: false,
	minProperties: 1,
} as const
