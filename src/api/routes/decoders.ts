/**
 * Decoder Routes - Decoder management endpoints
 *
 * Requirements:
 * - 9.6: GET /api/decoders returns all decoder statuses
 * - 9.7: POST /api/decoders/:id/start starts the specified decoder
 * - 9.8: POST /api/decoders/:id/stop stops the specified decoder
 * - 9.9: PATCH /api/decoders/:id updates the decoder configuration
 * - 17.1: Decoder capabilities declaration (input type, exclusive requirement, preferred sample rates, output format)
 * - 20.1: Report health as "running" when producing output
 * - 20.2: Report health as "idle" when no output for configured timeout
 * - 20.3: Report health as "faulted" when crashed and exceeded restart limits
 */

import type {
	FastifyInstance,
	FastifyPluginAsync,
	FastifyReply,
	FastifyRequest,
	FastifySchemaValidationError,
} from "fastify"
import { z } from "zod"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderRegistry } from "../../decoders/registry.js"
import type {
	DecoderEfficiencyView,
	DecoderInfo as ApiDecoderInfo,
	DecoderRatePreviewItem,
	DecoderTypeInfo,
	DecoderStatus as ApiDecoderStatus,
} from "@wavekit/api-types"
import type { DecoderStatus as InternalDecoderStatus } from "../../decoders/types.js"
import {
	decoderRateAssessmentSchema,
	decoderRateRequirementsSchema,
} from "./decoder-rate-schemas.js"
import {
	decoderHealthValues,
	decoderStatusSchema,
} from "./decoder-status-schemas.js"
import {
	toApiDecoderCaps,
	toApiDecoderInfo,
	toApiDecoderStatus,
} from "../serializers/decoder-status.js"
import { decoderOptionDescriptors } from "../../decoders/options/index.js"
import { WaveKitError } from "../../utils/errors.js"
import type { DeniedAdmission } from "../../access/types.js"
import {
	DecoderSettingsError,
	type DecoderSettingsService,
} from "../../decoders/settings/contract.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { DECODER_SETTINGS_BODY_MAX_BYTES } from "@wavekit/api-types"

/**
 * Decoder capabilities schema for response (Requirement 17.1)
 */
const decoderCapsSchema = {
	type: "object",
	properties: {
		input: { type: "string", enum: ["audio_pcm", "iq", "external"] },
		wantsExclusiveSource: { type: "boolean" },
		preferredSampleRates: { type: "array", items: { type: "number" } },
		rateRequirements: decoderRateRequirementsSchema,
		output: { type: "string", enum: ["jsonl", "nmea", "beast", "text"] },
		integrationPattern: {
			type: "string",
			enum: ["pure_consumer", "network_producer", "external_sdr"],
		},
	},
	required: ["input", "output", "integrationPattern"],
} as const

/** WG6: documented option keys of a decoder type (GET /api/decoders/types). */
const decoderOptionDescriptorsSchema = {
	type: "array",
	items: {
		type: "object",
		properties: {
			key: { type: "string" },
			type: {
				type: "string",
				enum: [
					"string",
					"integer",
					"number",
					"boolean",
					"enum",
					"string-list",
					"number-list",
					"object",
				],
			},
			enumValues: { type: "array", items: { type: "string" } },
			min: { type: "number" },
			max: { type: "number" },
			unit: { type: "string" },
			default: { type: ["string", "number", "boolean", "null"] },
			secret: { type: "boolean" },
			patchable: { type: "boolean" },
			effect: { type: "string", enum: ["restart"] },
			description: { type: "string" },
		},
		required: ["key", "type", "default", "secret", "effect", "description"],
	},
} as const

/**
 * Extended decoder info schema including capabilities
 */
const decoderInfoSchema = {
	type: "object",
	properties: {
		...decoderStatusSchema.properties,
		caps: decoderCapsSchema,
	},
	required: [...decoderStatusSchema.required],
} as const

/**
 * Error response schema
 */
const errorResponseSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string" },
		message: { type: "string" },
	},
	required: ["error", "code", "message"],
} as const

/**
 * Success response schema for start/stop/restart
 */
const decoderActionResponseSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		decoder: decoderStatusSchema,
	},
	required: ["message", "decoder"],
} as const

/**
 * Optional POST /start body (band defaults spec §1.1). `pin` defaults to
 * true: an operator start is never band-suspended.
 */
const StartBodySchema = z
	.object({ pin: z.boolean().optional() })
	.strict()
	.nullish()

/**
 * Decoder config update schema for PATCH request
 */
const decoderConfigUpdateSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		options: { type: "object", additionalProperties: true },
	},
	additionalProperties: false,
} as const

/**
 * Options for the decoder routes plugin
 */
export interface DecoderRoutesOptions {
	decoderManager: DecoderManager
	decoderRegistry?: DecoderRegistry | undefined
	/**
	 * WG8: live decoder settings. The settings GET and the working PATCH mount only when BOTH
	 * `settings` and `authorizeSettings` are given (protected mode); either alone is legacy.
	 */
	settings?: DecoderSettingsService | undefined
	/** WG8: mutation admission for the PATCH, run before any lookup or body parse. */
	authorizeSettings?:
		| ((request: FastifyRequest) => DeniedAdmission | undefined)
		| undefined
}

/** WG8 req 2.2: `W/"n"`, `"n"` or bare `n` (station rules plus the weak form). */
const IF_MATCH = /^(?:(?:W\/)?"(\d{1,19})"|(\d{1,19}))$/
const PATCH_BODY_KEYS = new Set(["enabled", "options", "mode"])

function sendJson(reply: FastifyReply, status: number, body: unknown) {
	return reply
		.status(status)
		.header("Cache-Control", "no-store")
		.type("application/json")
		.send(JSON.stringify(body))
}

function sendSettingsDenial(reply: FastifyReply, denied: DeniedAdmission) {
	for (const [name, value] of Object.entries(denied.headers))
		reply.header(name, value)
	return reply
		.status(denied.status)
		.type("application/json")
		.send(JSON.stringify({ code: denied.code }))
}

const settingsError = (
	code: "DECODER_OPTIONS_INVALID" | "DECODER_SETTINGS_LIMIT",
	message: string,
) => new DecoderSettingsError(code, message)

const SETTINGS_UPDATE_FAILED = {
	error: "Internal Server Error",
	code: "DECODER_SETTINGS_UPDATE_FAILED",
	message: "Decoder settings update failed",
} as const

/** Body shape of the protected PATCH: enabled boolean|null, options object, nothing else. */
/** Protected PATCH body: the handler validates strictly, nothing here may coerce. */
const acceptUnvalidated = (): boolean => true

/**
 * Protected PATCH params, matching the default Ajv answer for the documented
 * schema (`id` a string of length >= 1) without a per-route Ajv instance.
 */
const validateIdParam: ((data: unknown) => boolean) & {
	errors?: FastifySchemaValidationError[] | null
} = (data: unknown) => {
	const id = (data as { id?: unknown } | null)?.id
	if (typeof id === "string" && id.length >= 1) {
		validateIdParam.errors = null
		return true
	}
	validateIdParam.errors = [
		typeof id === "string"
			? {
					keyword: "minLength",
					instancePath: "/id",
					schemaPath: "#/properties/id/minLength",
					params: { limit: 1 },
					message: "must NOT have fewer than 1 characters",
				}
			: {
					keyword: "required",
					instancePath: "",
					schemaPath: "#/required",
					params: { missingProperty: "id" },
					message: "must have required property 'id'",
				},
	]
	return false
}

function isSettingsPatchShape(body: unknown): boolean {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return false
	for (const key of Object.keys(body))
		if (!PATCH_BODY_KEYS.has(key)) return false
	const enabled: unknown = Reflect.get(body, "enabled")
	if (
		Object.hasOwn(body, "enabled") &&
		enabled !== null &&
		typeof enabled !== "boolean"
	)
		return false
	const mode: unknown = Reflect.get(body, "mode")
	if (Object.hasOwn(body, "mode") && mode !== null && typeof mode !== "string")
		return false
	const opts: unknown = Reflect.get(body, "options")
	if (
		Object.hasOwn(body, "options") &&
		(typeof opts !== "object" || opts === null || Array.isArray(opts))
	)
		return false
	return true
}

/** Parsed If-Match: undefined when absent, null when malformed or not a safe integer. */
function parseIfMatch(
	header: string | string[] | undefined,
): number | null | undefined {
	if (header === undefined) return undefined
	if (typeof header !== "string") return null
	const m = IF_MATCH.exec(header.trim())
	const digits = m?.[1] ?? m?.[2]
	if (digits === undefined) return null
	const value = Number(digits)
	return Number.isSafeInteger(value) ? value : null
}

/**
 * Response types
 */
export interface DecoderActionResponse {
	message: string
	decoder: ApiDecoderStatus
}

export interface ErrorResponse {
	error: string
	code: string
	message: string
}

/** 409 body for mutating routes on a scanner probe (spec § 6.5); null otherwise. */
export function scannerOwnedConflict(
	manager: Pick<DecoderManager, "getStatus">,
	id: string,
): ErrorResponse | null {
	if (manager.getStatus(id)?.owner !== "scanner") return null
	return {
		error: "Conflict",
		code: "DECODER_OWNED_BY_SCANNER",
		message: `Decoder '${id}' is a scanner probe; the scanner owns its lifecycle`,
	}
}

/** 409 body when a start is refused because a scanner sweep holds the source. */
function sourceHeldConflict(err: unknown): ErrorResponse | null {
	if (!(err instanceof WaveKitError) || err.code !== "SOURCE_HELD_BY_SCANNER")
		return null
	return { error: "Conflict", code: err.code, message: err.message }
}

export interface DecoderConfigUpdate {
	enabled?: boolean
	options?: Record<string, unknown>
}

/**
 * Extended decoder info including capabilities (shared with `decoder:status`).
 */
export type DecoderInfo = ApiDecoderInfo

/**
 * Decoder routes plugin for Fastify.
 * Registers /api/decoders endpoints for decoder management.
 */
export const decoderRoutes: FastifyPluginAsync<DecoderRoutesOptions> = async (
	fastify: FastifyInstance,
	options: DecoderRoutesOptions,
) => {
	const { decoderManager, decoderRegistry } = options

	fastify.get<{
		Params: { id: string }
		Querystring: { lines?: number }
	}>(
		"/api/decoders/:id/log",
		{
			schema: {
				tags: ["decoders"],
				description:
					"Raw decoder stdout/stderr output; lines are capped at 4096 characters and may contain sensitive decoder output.",
				querystring: {
					type: "object",
					properties: {
						lines: { type: "integer", minimum: 1, maximum: 500, default: 200 },
					},
					additionalProperties: false,
				},
			},
		},
		async (request, reply) => {
			const decoder = decoderManager.getDecoder(request.params.id)
			if (!decoder)
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${request.params.id}' not found`,
				})
			return {
				decoderId: decoder.id,
				lines: decoder.getLog?.(request.query.lines ?? 200) ?? [],
			}
		},
	)

	const enrichWithCaps = (status: InternalDecoderStatus): DecoderInfo =>
		toApiDecoderInfo(status, decoderRegistry)

	/**
	 * GET /api/decoders - List all decoders
	 * Requirement 9.6: Returns all decoder statuses
	 * Requirements 20.1, 20.2, 20.3: Includes health status
	 */
	fastify.get<{ Reply: DecoderInfo[] }>(
		"/api/decoders",
		{
			schema: {
				tags: ["decoders"],
				summary: "List all decoders",
				description:
					"Returns all configured decoders with their status, health, and capabilities",
				response: {
					200: {
						type: "array",
						items: decoderInfoSchema,
					},
				},
			},
		},
		async () => {
			const statuses = decoderManager.getAllStatus()
			return statuses.map(enrichWithCaps)
		},
	)

	const efficiencyPlacementSchema = {
		type: "object",
		required: [
			"decoderId",
			"sourceId",
			"channelHz",
			"reach",
			"costCores",
			"probation",
		],
		properties: {
			decoderId: { type: "string" },
			sourceId: { type: "string" },
			channelHz: { type: ["number", "null"] },
			reach: { type: "string", enum: ["channel", "raw", "centre"] },
			costCores: { type: "number" },
			probation: { type: "boolean" },
			detail: {
				type: "string",
				enum: ["budget", "cpu", "drops", "unknown", "late-drops", "configured"],
			},
			retryAt: { type: ["string", "null"] },
		},
	} as const
	fastify.get<{ Reply: DecoderEfficiencyView }>(
		"/api/decoders/efficiency",
		{
			schema: {
				tags: ["decoders"],
				response: {
					200: {
						type: "object",
						required: ["budgetCores", "cpuGuardPercent", "sources"],
						properties: {
							budgetCores: { type: "number" },
							cpuGuardPercent: { type: "number" },
							sources: {
								type: "array",
								items: {
									type: "object",
									required: [
										"sourceId",
										"coresInUse",
										"cpu",
										"drops",
										"dropBytesPerSecond",
										"admitted",
										"blocked",
									],
									properties: {
										sourceId: { type: "string" },
										coresInUse: { type: "number" },
										cpu: {
											type: "object",
											required: ["percent", "limit"],
											properties: {
												percent: { type: ["number", "null"] },
												limit: { type: "number" },
											},
										},
										drops: {
											type: "string",
											enum: ["ok", "dropping", "clearing", "unknown"],
										},
										dropBytesPerSecond: { type: ["number", "null"] },
										attribution: {
											type: "string",
											enum: ["none", "link", "host", "consumer", "unknown"],
										},
										lateDrops: {
											type: "object",
											required: [
												"condemningWindows",
												"windows",
												"cooldownUntil",
												"sheddable",
												"held",
											],
											properties: {
												condemningWindows: { type: "integer", minimum: 0 },
												windows: { type: "integer", minimum: 0 },
												cooldownUntil: { type: ["string", "null"] },
												sheddable: { type: "integer", minimum: 0 },
												held: {
													type: ["string", "null"],
													enum: ["nothing-sheddable", "link-or-unknown", null],
												},
											},
										},
										admitted: {
											type: "array",
											items: efficiencyPlacementSchema,
										},
										blocked: {
											type: "array",
											items: efficiencyPlacementSchema,
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async () => decoderManager.efficiencyView(),
	)

	/**
	 * GET /api/decoders/rate-preview - Rate plans if a source ran at a rate.
	 * Pure: no tuner write, no caps change (rate model B3).
	 */
	fastify.get<{
		Querystring: { sourceId: string; sampleRateHz: number }
		Reply: DecoderRatePreviewItem[] | ErrorResponse
	}>(
		"/api/decoders/rate-preview",
		{
			schema: {
				tags: ["decoders"],
				summary: "Preview decoder rate plans",
				description:
					"Returns each decoder's rate assessment for the source as if it ran at sampleRateHz, without changing anything",
				querystring: {
					type: "object",
					properties: {
						sourceId: { type: "string", minLength: 1 },
						sampleRateHz: { type: "integer", exclusiveMinimum: 0 },
					},
					required: ["sourceId", "sampleRateHz"],
					additionalProperties: false,
				},
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								decoderId: { type: "string" },
								assessment: decoderRateAssessmentSchema,
							},
							required: ["decoderId", "assessment"],
						},
					},
					400: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { sourceId, sampleRateHz } = request.query
			const preview = decoderManager.previewRates(sourceId, sampleRateHz)
			if (preview.ok) return preview.items
			if (preview.reason === "source-not-found")
				return reply.status(404).send({
					error: "NotFound",
					code: "SOURCE_NOT_FOUND",
					message: `Source with id '${sourceId}' not found`,
				})
			return reply.status(400).send({
				error: "BadRequest",
				code: "VALIDATION_ERROR",
				message: `Sample rate ${sampleRateHz} Hz is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)`,
			})
		},
	)

	/**
	 * GET /api/decoders/:id - Get decoder status
	 * Requirement 9.6: Returns decoder status by ID
	 * Requirements 20.1, 20.2, 20.3: Includes health status
	 */
	fastify.get<{
		Params: { id: string }
		Reply: DecoderInfo | ErrorResponse
	}>(
		"/api/decoders/:id",
		{
			schema: {
				tags: ["decoders"],
				summary: "Get decoder status",
				description:
					"Returns the status, health, and capabilities of a specific decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderInfoSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			const status = decoderManager.getStatus(id)
			if (!status) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}

			return enrichWithCaps(status)
		},
	)

	/**
	 * POST /api/decoders/:id/start - Start decoder
	 * Requirement 9.7: Starts the specified decoder
	 */
	fastify.post<{
		Params: { id: string }
		Body: unknown
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id/start",
		{
			schema: {
				tags: ["decoders"],
				summary: "Start decoder",
				description:
					"Starts the specified decoder. Optional body { pin?: boolean } (default true): a pinned (operator) decoder is never band-suspended; on a running decoder a body changes the start mode.",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderActionResponseSchema,
					400: errorResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			// Check if decoder exists
			const decoder = decoderManager.getDecoder(id)
			if (!decoder) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}
			const owned = scannerOwnedConflict(decoderManager, id)
			if (owned) return reply.status(409).send(owned)

			const body = StartBodySchema.safeParse(request.body)
			if (!body.success) {
				return reply.status(400).send({
					error: "BadRequest",
					code: "INVALID_START_REQUEST",
					message: body.error.issues
						.map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`)
						.join("; "),
				})
			}
			const startMode = (body.data?.pin ?? true) ? "operator" : "auto"

			// A bare start on a running decoder is a conflict; a body is an
			// explicit start-mode change (pin / return to auto).
			const currentStatus = decoder.getStatus()
			if (currentStatus.running) {
				if (body.data === undefined || body.data === null) {
					return reply.status(409).send({
						error: "Conflict",
						code: "DECODER_ALREADY_RUNNING",
						message: `Decoder '${id}' is already running`,
					})
				}
				decoderManager.setStartMode(id, startMode)
				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message:
							"Decoder start mode was set but status could not be retrieved",
					})
				}
				return {
					message: `Decoder '${id}' is running; start mode set to '${startMode}'`,
					decoder: toApiDecoderStatus(status),
				}
			}

			try {
				await decoderManager.startDecoder(id, { startMode, refuseIfHeld: true })

				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message: "Decoder was started but status could not be retrieved",
					})
				}

				return {
					message: status.suspended
						? `Decoder '${id}' start recorded; suspended until the source rate and band are usable`
						: `Decoder '${id}' started successfully`,
					decoder: toApiDecoderStatus(status),
				}
			} catch (err) {
				const held = sourceHeldConflict(err)
				if (held) return reply.status(409).send(held)
				const error = err as Error
				return reply.status(500).send({
					error: "InternalServerError",
					code: "DECODER_START_ERROR",
					message: error.message,
				})
			}
		},
	)

	/**
	 * POST /api/decoders/:id/stop - Stop decoder
	 * Requirement 9.8: Stops the specified decoder
	 */
	fastify.post<{
		Params: { id: string }
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id/stop",
		{
			schema: {
				tags: ["decoders"],
				summary: "Stop decoder",
				description: "Stops the specified decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderActionResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			// Check if decoder exists
			const decoder = decoderManager.getDecoder(id)
			if (!decoder) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}
			const owned = scannerOwnedConflict(decoderManager, id)
			if (owned) return reply.status(409).send(owned)

			// Check if already stopped; a suspended decoder (or one waiting in
			// restart backoff) is not running but can still be stopped.
			const currentStatus = decoder.getStatus()
			if (
				!currentStatus.running &&
				!decoderManager.getStatus(id)?.desiredRunning
			) {
				return reply.status(409).send({
					error: "Conflict",
					code: "DECODER_NOT_RUNNING",
					message: `Decoder '${id}' is not running`,
				})
			}

			try {
				await decoderManager.stopDecoder(id)

				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message: "Decoder was stopped but status could not be retrieved",
					})
				}

				return {
					message: `Decoder '${id}' stopped successfully`,
					decoder: toApiDecoderStatus(status),
				}
			} catch (err) {
				const error = err as Error
				return reply.status(500).send({
					error: "InternalServerError",
					code: "DECODER_STOP_ERROR",
					message: error.message,
				})
			}
		},
	)

	/**
	 * POST /api/decoders/:id/restart - Restart decoder
	 * Requirement 9.8: Restarts the specified decoder
	 */
	fastify.post<{
		Params: { id: string }
		Reply: DecoderActionResponse | ErrorResponse
	}>(
		"/api/decoders/:id/restart",
		{
			schema: {
				tags: ["decoders"],
				summary: "Restart decoder",
				description: "Restarts the specified decoder",
				params: {
					type: "object",
					properties: {
						id: { type: "string", minLength: 1 },
					},
					required: ["id"],
				},
				response: {
					200: decoderActionResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params

			// Check if decoder exists
			const decoder = decoderManager.getDecoder(id)
			if (!decoder) {
				return reply.status(404).send({
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				})
			}
			const owned = scannerOwnedConflict(decoderManager, id)
			if (owned) return reply.status(409).send(owned)

			try {
				await decoderManager.restartDecoder(id, { refuseIfHeld: true })

				const status = decoderManager.getStatus(id)
				if (!status) {
					return reply.status(500).send({
						error: "InternalServerError",
						code: "DECODER_STATUS_ERROR",
						message: "Decoder was restarted but status could not be retrieved",
					})
				}

				return {
					message: status.suspended
						? `Decoder '${id}' restart recorded; suspended until the source rate is usable`
						: `Decoder '${id}' restarted successfully`,
					decoder: toApiDecoderStatus(status),
				}
			} catch (err) {
				const held = sourceHeldConflict(err)
				if (held) return reply.status(409).send(held)
				const error = err as Error
				return reply.status(500).send({
					error: "InternalServerError",
					code: "DECODER_RESTART_ERROR",
					message: error.message,
				})
			}
		},
	)

	const { settings, authorizeSettings } = options
	if (settings && authorizeSettings) {
		/** WG8 req 2.7: GET /api/decoders/:id/settings (root admission only). */
		fastify.get<{ Params: { id: string } }>(
			"/api/decoders/:id/settings",
			{
				schema: {
					tags: ["decoders"],
					summary: "Get decoder settings",
					description:
						"Effective settings of a configured decoder with their sources and the store revision",
					params: {
						type: "object",
						properties: { id: { type: "string", minLength: 1 } },
						required: ["id"],
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params
				const notFound = {
					error: "NotFound",
					code: "DECODER_NOT_FOUND",
					message: `Decoder with id '${id}' not found`,
				}
				if (!decoderManager.getDecoder(id))
					return sendJson(reply, 404, notFound)
				const owned = scannerOwnedConflict(decoderManager, id)
				if (owned) return sendJson(reply, 409, owned)
				const view = settings.view(id)
				if (!view) return sendJson(reply, 404, notFound)
				return sendJson(reply, 200, view)
			},
		)

		/** WG8 req 2.2-2.6: PATCH /api/decoders/:id (protected), applied at the next start. */
		fastify.route<{ Params: { id: string }; Body: unknown }>({
			method: "PATCH",
			url: "/api/decoders/:id",
			bodyLimit: DECODER_SETTINGS_BODY_MAX_BYTES,
			schema: {
				tags: ["decoders"],
				summary: "Update decoder settings",
				description:
					"JSON merge patch of the decoder override ({ enabled?: boolean | null, options?: object, mode?: string | null }); enabled and options apply when the decoder next starts; mode applies immediately",
				params: {
					type: "object",
					properties: { id: { type: "string", minLength: 1 } },
					required: ["id"],
				},
				// Documentation only: see validatorCompiler below.
				body: {
					type: "object",
					properties: {
						enabled: { type: ["boolean", "null"] },
						options: { type: "object", additionalProperties: true },
						mode: {
							type: ["string", "null"],
							enum: ["auto", "always", "off", null],
						},
					},
					additionalProperties: false,
				},
			},
			// The default validator would coerce ("true" -> true) and drop unknown
			// keys; the handler's strict shape check is the only body gate. An
			// empty id param fails validation and maps to a fixed 400.
			validatorCompiler: ({ httpPart }) =>
				httpPart === "params" ? validateIdParam : acceptUnvalidated,
			// onRequest runs before body parsing: a denial precedes any lookup or parser error.
			onRequest: (request, reply, done) => {
				const denied = authorizeSettings(request)
				if (denied) {
					void sendSettingsDenial(reply, denied)
					return
				}
				done()
			},
			errorHandler: (error, request, reply) => {
				const code = (error as { code?: unknown }).code
				if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
					const err = settingsError(
						"DECODER_SETTINGS_LIMIT",
						"Body is too large",
					)
					void sendJson(reply, err.statusCode, err.toBody())
					return
				}
				// Params validation (empty id): a fixed 400, no echo.
				if (code === "FST_ERR_VALIDATION") {
					const err = settingsError(
						"DECODER_OPTIONS_INVALID",
						"Decoder id is required",
					)
					void sendJson(reply, err.statusCode, err.toBody())
					return
				}
				// Fastify's own parser answers (415, invalid JSON) are kept as on other routes.
				if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) {
					void reply.send(error)
					return
				}
				request.log.error(
					{ err: safeErrorFields(error) },
					"decoder settings update failed",
				)
				void sendJson(reply, 500, SETTINGS_UPDATE_FAILED)
			},
			handler: async (request, reply) => {
				const { id } = request.params
				if (!decoderManager.getDecoder(id))
					return sendJson(reply, 404, {
						error: "NotFound",
						code: "DECODER_NOT_FOUND",
						message: `Decoder with id '${id}' not found`,
					})
				const owned = scannerOwnedConflict(decoderManager, id)
				if (owned) return sendJson(reply, 409, owned)
				const ifMatch = parseIfMatch(request.headers["if-match"])
				if (ifMatch === null) {
					const err = settingsError(
						"DECODER_OPTIONS_INVALID",
						"If-Match must be a revision",
					)
					return sendJson(reply, err.statusCode, err.toBody())
				}
				const body: unknown = request.body
				if (!isSettingsPatchShape(body)) {
					const err = settingsError(
						"DECODER_OPTIONS_INVALID",
						"Body must be a JSON object with only enabled (boolean or null), options (object) and mode (string or null)",
					)
					return sendJson(reply, err.statusCode, err.toBody())
				}
				try {
					const result = await settings.update(
						id,
						body,
						ifMatch === undefined ? undefined : { ifMatch },
					)
					return sendJson(reply, 200, result)
				} catch (error) {
					if (error instanceof DecoderSettingsError)
						return sendJson(reply, error.statusCode, error.toBody())
					request.log.error(
						{ err: safeErrorFields(error) },
						"decoder settings update failed",
					)
					return sendJson(reply, 500, SETTINGS_UPDATE_FAILED)
				}
			},
		})
	} else {
		/**
		 * PATCH /api/decoders/:id - Update decoder configuration
		 * Requirement 9.9: Updates the decoder configuration
		 */
		fastify.patch<{
			Params: { id: string }
			Body: DecoderConfigUpdate
			Reply: DecoderActionResponse | ErrorResponse
		}>(
			"/api/decoders/:id",
			{
				schema: {
					tags: ["decoders"],
					summary: "Update decoder configuration",
					description: "Updates the configuration of a specific decoder",
					params: {
						type: "object",
						properties: {
							id: { type: "string", minLength: 1 },
						},
						required: ["id"],
					},
					body: decoderConfigUpdateSchema,
					response: {
						501: errorResponseSchema,
						404: errorResponseSchema,
						400: errorResponseSchema,
					},
				},
			},
			async (request, reply) => {
				const { id } = request.params
				const updates = request.body

				// Check if decoder exists
				const decoder = decoderManager.getDecoder(id)
				if (!decoder) {
					return reply.status(404).send({
						error: "NotFound",
						code: "DECODER_NOT_FOUND",
						message: `Decoder with id '${id}' not found`,
					})
				}

				// Validate that at least one field is being updated
				if (updates.enabled === undefined && updates.options === undefined) {
					return reply.status(400).send({
						error: "BadRequest",
						code: "NO_UPDATE_FIELDS",
						message: "At least one field (enabled or options) must be provided",
					})
				}

				return reply.status(501).send({
					error: "NotImplemented",
					code: "DECODER_CONFIG_UPDATE_UNSUPPORTED",
					message:
						"Runtime decoder configuration updates are not implemented. Edit the YAML configuration and restart WaveKit; use the start/stop endpoints for lifecycle control.",
				})
			},
		)
	}

	/**
	 * GET /api/decoders/types - List available decoder types
	 * Requirement 17.1: Returns all registered decoder types with their capabilities
	 */
	fastify.get<{
		Reply: Array<DecoderTypeInfo> | ErrorResponse
	}>(
		"/api/decoders/types",
		{
			schema: {
				tags: ["decoders"],
				summary: "List available decoder types",
				description:
					"Returns all registered decoder types with their capabilities and integration patterns",
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								type: { type: "string" },
								caps: decoderCapsSchema,
								options: decoderOptionDescriptorsSchema,
							},
							required: ["type", "caps"],
						},
					},
					501: errorResponseSchema,
				},
			},
		},
		async (_request, reply) => {
			if (!decoderRegistry) {
				return reply.status(501).send({
					error: "NotImplemented",
					code: "REGISTRY_NOT_AVAILABLE",
					message: "Decoder registry is not available",
				})
			}

			const types = decoderRegistry.getRegisteredTypes()
			return types.map(type => {
				const options = decoderOptionDescriptors(type)
				return {
					type,
					caps: toApiDecoderCaps(decoderRegistry.getCaps(type)!),
					...(options ? { options } : {}),
				}
			})
		},
	)

	/**
	 * GET /api/decoders/health - Get health status of all decoders
	 * Requirements 20.1, 20.2, 20.3: Returns health status for all decoders
	 */
	fastify.get<{
		Reply: Array<{ id: string; health: string }>
	}>(
		"/api/decoders/health",
		{
			schema: {
				tags: ["decoders"],
				summary: "Get health status of all decoders",
				description:
					"Returns the health status (running, idle, faulted) for all configured decoders",
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								health: {
									type: "string",
									enum: decoderHealthValues,
								},
							},
							required: ["id", "health"],
						},
					},
				},
			},
		},
		async () => {
			const healthMap = decoderManager.getAllHealth()
			return Array.from(healthMap.entries()).map(([id, health]) => ({
				id,
				health,
			}))
		},
	)
}

export default decoderRoutes
