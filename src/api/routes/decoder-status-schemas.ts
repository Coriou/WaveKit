import { DECODER_LAST_ERROR_MAX_LENGTH } from "@wavekit/api-types"
import {
	decoderBandAssessmentSchema,
	decoderRateAssessmentSchema,
	decoderSuspensionReasonCodes,
} from "./decoder-rate-schemas.js"

/**
 * Decoder status response schemas shared by /api/decoders* and /api/status.
 * Fastify response schemas strip unknown properties, so every route that
 * returns a DecoderStatus must use this one definition.
 */

export const decoderStatsSchema = {
	type: "object",
	properties: {
		bytesIn: { type: "number" },
		eventsOut: { type: "number" },
		errors: { type: "number" },
	},
	required: ["bytesIn", "eventsOut", "errors"],
} as const

/** Optional fields from CLI-COORDINATION requests 2-4. */
const efficiencyDetail = {
	type: "string",
	enum: ["budget", "cpu", "drops", "unknown"],
} as const

export const decoderStatusExtensionProperties = {
	mode: { type: "string", enum: ["auto", "always", "off"] },
	modeSource: {
		type: "string",
		enum: ["settings", "config", "legacy-enabled", "legacy-band", "default"],
	},
	origin: { type: "string", enum: ["config", "catalogue"] },
	placements: {
		type: "array",
		items: {
			type: "object",
			properties: {
				sourceId: { type: "string" },
				channelHz: { type: "number" },
				reach: { type: "string", enum: ["channel", "raw", "centre"] },
				origin: {
					type: "string",
					enum: ["configured", "band", "vfo", "bandplan", "fallback"],
				},
				primary: { type: "boolean" },
				running: { type: "boolean" },
				suspension: {
					type: "object",
					properties: {
						reasonCode: { type: "string", enum: decoderSuspensionReasonCodes },
						since: { type: "string", format: "date-time" },
					},
					required: ["reasonCode", "since"],
				},
				efficiencyDetail,
				costCores: { type: "number" },
				probation: { type: "boolean" },
			},
			required: [
				"sourceId",
				"reach",
				"origin",
				"primary",
				"running",
				"costCores",
			],
		},
	},
	efficiency: {
		type: "object",
		properties: {
			detail: efficiencyDetail,
			retryAt: { type: "string", format: "date-time" },
		},
		required: ["detail"],
	},
	rateHistory: {
		type: "array",
		maxItems: 15,
		items: { type: "integer", minimum: 0 },
	},
	sourceId: { type: "string" },
	deviceSerial: { type: "string" },
	targetFrequenciesHz: {
		type: "array",
		items: { type: "number", exclusiveMinimum: 0 },
	},
	lastError: {
		type: "object",
		properties: {
			kind: { type: "string", enum: ["error", "exit"] },
			message: { type: "string", maxLength: DECODER_LAST_ERROR_MAX_LENGTH },
			at: { type: "string", format: "date-time" },
		},
		required: ["kind", "message", "at"],
	},
	idleTimeoutMs: { type: "number", minimum: 0 },
	nextRestartAt: { type: "string", format: "date-time" },
	// Rate model B3 (reversible suspension).
	desiredRunning: { type: "boolean" },
	suspended: { type: "boolean" },
	suspension: {
		type: "object",
		properties: {
			reasonCode: { type: "string", enum: decoderSuspensionReasonCodes },
			since: { type: "string", format: "date-time" },
		},
		required: ["reasonCode", "since"],
	},
	transition: { type: "string", enum: ["suspending", "resuming"] },
	// Band-aware suspension (roadmap item 8).
	bandAssessment: decoderBandAssessmentSchema,
	// Band defaults + operator override: who started the decoder.
	startMode: { type: "string", enum: ["auto", "operator"] },
	// Signal discovery scanner (CLI-COORDINATION scanner proposal).
	owner: { type: "string", enum: ["config", "scanner"] },
	scannerJobId: { type: "string" },
	ephemeral: { type: "boolean", enum: [true] },
	// WG6: report-only option problems.
	optionIssues: {
		type: "array",
		maxItems: 32,
		items: {
			type: "object",
			properties: {
				path: { type: "string", maxLength: 256 },
				code: {
					type: "string",
					enum: ["unknown-key", "invalid-value", "truncated"],
				},
				message: { type: "string", maxLength: 256 },
			},
			required: ["path", "code", "message"],
		},
	},
} as const

/** Every DecoderHealth value; Fastify schemas share this one list. */
export const decoderHealthValues = [
	"running",
	"idle",
	"restarting",
	"faulted",
] as const

/** Decoder status schema (Requirements 9.6, 20.1, 20.2, 20.3). */
export const decoderStatusSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		type: { type: "string" },
		running: { type: "boolean" },
		health: { type: "string", enum: decoderHealthValues },
		pid: { type: "number" },
		uptime: { type: "number" },
		stats: decoderStatsSchema,
		lastOutputAt: { type: "string", format: "date-time", nullable: true },
		restartCount: { type: "number" },
		version: { type: "string" },
		rateAssessment: decoderRateAssessmentSchema,
		...decoderStatusExtensionProperties,
	},
	required: [
		"id",
		"type",
		"running",
		"health",
		"uptime",
		"stats",
		"restartCount",
	],
} as const
