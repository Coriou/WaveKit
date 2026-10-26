/** JSON schemas for /api/scanner (spec § 12.1). Response bodies are DTOs from @wavekit/api-types. */
import {
	DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
	IDENTIFY_WAIT_MAX_MS,
	IDENTIFY_WAIT_MIN_MS,
} from "@wavekit/api-types"
import { DISCOVERY_ID } from "../../core/scanner/store/evidence-store.js"
import { CAPTURE_ID } from "../../core/scanner/evidence/capture-store.js"
import {
	JOB_HITS_LIMIT_DEFAULT,
	JOB_HITS_LIMIT_MAX,
} from "../../core/scanner/job-hits.js"

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
	"ais",
	"acars",
	"vdl2",
	"lora",
	"adsb",
] as const
const identityKindEnum = [
	"dmr-cc",
	"p25-nac",
	"nxdn-ran",
	"ysf-dgid",
	"dstar-call",
	"dpmr-cc",
	"pocsag-capcode",
	"aprs-call",
	"ism-model",
	"ais-mmsi",
	"acars-reg",
	"vdl2-addr",
	"lora-node",
	"icao",
] as const
/** SF1 `identity=<kind>:<value>`: a known IdentityKind, a colon, a non-empty value. */
export const IDENTITY_QUERY = new RegExp(
	`^(${identityKindEnum.join("|")}):(.+)$`,
)
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
		// SF1 per-range fields (docs/specs/scanner-followups): live-editable in a PATCH `ranges`
		enabled: { type: "boolean" },
		name: { type: "string", minLength: 1, maxLength: 100 },
		dwellMs: { type: "number", minimum: 10, maximum: 600000 },
		sensitivity: { type: "string", enum: ["low", "normal", "high"] },
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
		capture: {
			type: "object",
			properties: {
				enabled: { type: "boolean" },
				mode: { type: "string", enum: ["wideband", "channel"] },
				preMs: { type: "integer", minimum: 0, maximum: 5000 },
				postMs: { type: "integer", minimum: 0, maximum: 10000 },
				onlyDecoded: { type: "boolean" },
				maxPerHour: { type: "integer", minimum: 1, maximum: 60 },
			},
			required: ["enabled"],
			additionalProperties: false,
		},
		// SF1: no decoder trials of the job's own (discover jobs only)
		signalsOnly: { type: "boolean" },
		// WG6 1.6: drop sweep hops already decoded elsewhere
		skipDecodedElsewhere: { type: "boolean" },
		// WG7 6.1: drop sweep hops inside skip-marked band-plan ranges
		skipBandPlanSkips: { type: "boolean" },
	},
	additionalProperties: false,
} as const

export const jobIdParamsSchema = {
	type: "object",
	properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
	required: ["id"],
} as const

/** A discovery id on routes whose id reaches the filesystem: no `..` or `/` slips into a path. */
export const discoveryIdParamsSchema = {
	type: "object",
	properties: {
		id: { type: "string", maxLength: 64, pattern: DISCOVERY_ID.source },
	},
	required: ["id"],
} as const

/** A burst capture id (Task 34a): it reaches the filesystem, so it matches the store's pattern. */
export const captureIdParamsSchema = {
	type: "object",
	properties: {
		id: { type: "string", maxLength: 64, pattern: CAPTURE_ID.source },
	},
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
		identity: {
			type: "string",
			maxLength: 100,
			pattern: IDENTITY_QUERY.source,
		},
		sort: { type: "string", enum: ["lastSeen", "frequency", "confidence"] },
		cursor: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
		// WG12: accepted only. Filtering lands with lane EV.
		evidence: { type: "string", enum: ["proven", "weak", "all"] },
		// 100 GHz is above any receiver. The validator coerces "Infinity" and lets it through
		// the bound, so the handler must refuse a non-finite nearHz or toleranceHz.
		nearHz: { type: "number", exclusiveMinimum: 0, maximum: 100_000_000_000 },
		toleranceHz: {
			type: "number",
			minimum: 0,
			maximum: DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
		},
	},
	additionalProperties: false,
	allOf: [
		{
			if: { required: ["toleranceHz"] },
			then: { required: ["nearHz"] },
		},
	],
} as const

export const observationsQuerySchema = {
	type: "object",
	properties: {
		cursor: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
	},
	additionalProperties: false,
} as const

/** WG2 req 13.3: GET /api/scanner/jobs/:id/hits?limit (1–500, default 100). */
export const jobHitsQuerySchema = {
	type: "object",
	properties: {
		limit: {
			type: "integer",
			minimum: 1,
			maximum: JOB_HITS_LIMIT_MAX,
			default: JOB_HITS_LIMIT_DEFAULT,
		},
	},
	additionalProperties: false,
} as const

const jobHitStatsSchema = {
	type: "object",
	properties: {
		discoveries: { type: "integer" },
		hits: { type: "integer" },
		newDiscoveries: { type: "integer" },
		truncated: { type: "boolean" },
	},
	required: ["discoveries", "hits", "newDiscoveries", "truncated"],
	additionalProperties: false,
} as const

/** `ScanJobHitsResponse`, every field. */
export const jobHitsResponseSchema = {
	type: "object",
	properties: {
		jobId: { type: "string" },
		stats: jobHitStatsSchema,
		hits: {
			type: "array",
			items: {
				type: "object",
				properties: {
					jobId: { type: "string" },
					discoveryId: { type: "string" },
					hits: { type: "integer" },
					firstHitAt: { type: "string" },
					lastHitAt: { type: "string" },
					firstSeenInJob: { type: "boolean" },
					lastDurationMs: {
						anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
					},
				},
				required: [
					"jobId",
					"discoveryId",
					"hits",
					"firstHitAt",
					"lastHitAt",
					"firstSeenInJob",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["jobId", "stats", "hits"],
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

/** POST /api/scanner/identify (spec § 10.8): exactly one of `frequencyHz` or `all: true`. */
export const identifyBodySchema = {
	type: "object",
	properties: {
		sourceId: { type: "string", minLength: 1 },
		target: {
			type: "object",
			properties: {
				frequencyHz: { type: "number", exclusiveMinimum: 0 },
				bandwidthHz: {
					type: "number",
					exclusiveMinimum: 0,
					maximum: 1_000_000,
				},
				all: { type: "boolean", enum: [true] },
			},
			// branches carry no additionalProperties: Fastify's removeAdditional would strip inside oneOf
			oneOf: [{ required: ["frequencyHz"] }, { required: ["all"] }],
			additionalProperties: false,
		},
		timeoutMs: { type: "integer", minimum: 1000, maximum: 120_000 },
		protocols: {
			type: "array",
			items: { type: "string", enum: protocolEnum },
			uniqueItems: true,
		},
		exhaustive: { type: "boolean" },
		record: { type: "boolean" },
		// WG12: accepted only. The wait lands with lane ID.
		waitUntilSignal: { type: "boolean" },
		waitMs: {
			type: "integer",
			minimum: IDENTIFY_WAIT_MIN_MS,
			maximum: IDENTIFY_WAIT_MAX_MS,
		},
	},
	required: ["target"],
	additionalProperties: false,
	allOf: [
		{
			if: { required: ["waitMs"] },
			then: {
				required: ["waitUntilSignal"],
				properties: { waitUntilSignal: { const: true } },
			},
		},
	],
} as const
