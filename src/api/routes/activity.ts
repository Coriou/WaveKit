/**
 * Activity search, detail, facets and status.
 * Main mounts this plugin. Disabled mode answers 404 ACTIVITY_DISABLED and
 * does not touch the store. Access control stays on the root installAccessHooks
 * admission used by every other /api read.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import type { ActivityStoreStats } from "../../core/activity/storage/contract.js"
import type {
	ActivityCategory,
	ActivityKind,
	ActivityQuery,
	ActivityQueryService,
	ActivityRefType,
	ActivitySearchRequest,
	ActivityBandMapQuery,
	ActivityTimelineQuery,
	ActivityTrailsQuery,
} from "../../core/activity/storage/contract.js"
import { ActivityQueryError } from "../../core/activity/query/errors.js"
import { parseDecimalInteger } from "../../core/activity/query/validate.js"
import { withActivityClient } from "../../core/activity/query/service.js"
import type { ActivityUnavailableState } from "../../core/activity/runtime.js"
import { errorResponseSchema, looseObjectSchema } from "./scanner-schemas.js"

export interface ActivityAccessContext {
	/**
	 * Admitted access principal or device id. Undefined when the request was
	 * not authenticated. Client-chosen headers are not an identity.
	 */
	principalId(request: FastifyRequest): string | undefined
}

export interface ActivityRoutesOptions {
	service: ActivityQueryService
	enabled: boolean
	/** Required for a useful status payload. Omitted when Activity has no store. */
	stats?: () => ActivityStoreStats | Promise<ActivityStoreStats>
	/**
	 * Set when the operator enabled Activity but the store did not open.
	 * Routes answer 503 ACTIVITY_UNAVAILABLE and do not call the service.
	 */
	unavailable?: ActivityUnavailableState
	/**
	 * When false, the 503 body keeps `reason` and replaces `message` with
	 * "Request failed". Defaults to the unavailable state's flag, then true.
	 */
	discloseErrors?: boolean
	/** Admission key. Absent means the request IP. */
	access?: ActivityAccessContext
}

const REF_TYPES = new Set<ActivityRefType>([
	"callId",
	"discoveryId",
	"observationId",
	"jobId",
	"probeId",
	"channelId",
])

const SEARCH_PARAMS = new Set([
	"kinds",
	"sourceIds",
	"decoderIds",
	"protocols",
	"categories",
	"frequencyMin",
	"frequencyMax",
	"producedFrom",
	"producedTo",
	"entityKey",
	"text",
	"refs",
	"order",
	"limit",
	"pageToken",
])

const TRAILS_PARAMS = new Set([
	"producedFrom",
	"producedTo",
	"categories",
	"protocols",
	"entityKey",
])

const trailsResponseSchema = {
	type: "object",
	properties: {
		producedFrom: { type: "string" },
		producedTo: { type: "string" },
		trails: {
			type: "array",
			items: {
				type: "object",
				properties: {
					entityKey: { type: "string" },
					category: { type: "string" },
					protocol: { type: ["string", "null"] },
					points: {
						type: "array",
						items: {
							type: "array",
							items: [
								{ type: "number" },
								{ type: "number" },
								{ type: "number" },
								{ type: ["number", "null"] },
							],
							minItems: 4,
							maxItems: 4,
						},
					},
					truncated: { type: "boolean" },
				},
				required: ["entityKey", "category", "protocol", "points", "truncated"],
			},
		},
		pointCount: { type: "integer" },
		scannedRows: { type: "integer" },
		skippedRows: { type: "integer" },
		truncated: { type: "boolean" },
		truncation: { type: "array", items: { type: "string" } },
		retentionFloor: { type: ["string", "null"] },
		generatedAt: { type: "string" },
	},
	required: [
		"producedFrom",
		"producedTo",
		"trails",
		"pointCount",
		"scannedRows",
		"skippedRows",
		"truncated",
		"truncation",
		"retentionFloor",
		"generatedAt",
	],
} as const

function trailsRequest(params: Record<string, unknown>): ActivityTrailsQuery {
	for (const key of Object.keys(params)) {
		if (!TRAILS_PARAMS.has(key)) {
			throw new ActivityQueryError(
				`Unknown activity trails parameter ${key}`,
				"ACTIVITY_QUERY_INVALID",
				400,
			)
		}
	}
	const request: ActivityTrailsQuery = {}
	for (const name of ["producedFrom", "producedTo"] as const) {
		const value = params[name]
		if (value === undefined) continue
		if (typeof value !== "string") {
			throw new ActivityQueryError(
				`${name} must be a string`,
				"ACTIVITY_QUERY_INVALID",
				400,
			)
		}
		request[name] = value
	}
	if (params["categories"] !== undefined) {
		const values = asStrings(params["categories"])
		if (values.length > 0)
			request.categories = values as unknown as ActivityCategory[]
	}
	if (params["protocols"] !== undefined) {
		const values = asStrings(params["protocols"])
		if (values.length > 0) request.protocols = values
	}
	const entityKey = params["entityKey"]
	if (entityKey !== undefined) {
		// Entity keys may contain commas: repeated parameters only, never split.
		const raw = Array.isArray(entityKey) ? entityKey : [entityKey]
		const keys: string[] = []
		for (const value of raw) {
			if (typeof value !== "string") {
				throw new ActivityQueryError(
					"entityKey must be a string",
					"ACTIVITY_QUERY_INVALID",
					400,
				)
			}
			keys.push(value)
		}
		if (keys.length > 0) request.entityKeys = keys
	}
	return request
}

const BANDMAP_PARAMS = new Set([
	"producedFrom",
	"producedTo",
	"minHz",
	"maxHz",
	"bucketHz",
	"categories",
	"protocols",
])

const TIMELINE_PARAMS = new Set([
	"producedFrom",
	"producedTo",
	"bucketMs",
	"categories",
	"protocols",
	"entityKey",
])

const truncationSchema = { type: "array", items: { type: "string" } } as const

const bandMapResponseSchema = {
	type: "object",
	properties: {
		producedFrom: { type: "string" },
		producedTo: { type: "string" },
		minHz: { type: "integer" },
		maxHz: { type: "integer" },
		bucketHz: { type: "integer" },
		buckets: {
			type: "array",
			items: {
				type: "object",
				properties: {
					startHz: { type: "integer" },
					rows: { type: "integer" },
					lastAt: { type: "string" },
					protocols: {
						type: "array",
						items: {
							type: "object",
							properties: {
								protocol: { type: "string" },
								category: { type: "string" },
								rows: { type: "integer" },
								entities: { type: "integer" },
								lastAt: { type: "string" },
							},
							required: ["protocol", "category", "rows", "entities", "lastAt"],
						},
					},
					otherRows: { type: "integer" },
					topEntities: {
						type: "array",
						items: {
							type: "object",
							properties: {
								entityKey: { type: "string" },
								rows: { type: "integer" },
							},
							required: ["entityKey", "rows"],
						},
					},
				},
				required: [
					"startHz",
					"rows",
					"lastAt",
					"protocols",
					"otherRows",
					"topEntities",
				],
			},
		},
		scannedRows: { type: "integer" },
		countedRows: { type: "integer" },
		noFrequencyRows: { type: "integer" },
		droppedRows: { type: "integer" },
		truncated: { type: "boolean" },
		truncation: truncationSchema,
		coveredFrom: { type: "string" },
		retentionFloor: { type: ["string", "null"] },
		generatedAt: { type: "string" },
	},
	required: [
		"producedFrom",
		"producedTo",
		"minHz",
		"maxHz",
		"bucketHz",
		"buckets",
		"scannedRows",
		"countedRows",
		"noFrequencyRows",
		"droppedRows",
		"truncated",
		"truncation",
		"coveredFrom",
		"retentionFloor",
		"generatedAt",
	],
} as const

const timelineResponseSchema = {
	type: "object",
	properties: {
		producedFrom: { type: "string" },
		producedTo: { type: "string" },
		bucketMs: { type: "integer" },
		buckets: {
			type: "array",
			items: {
				type: "object",
				properties: {
					startMs: { type: "integer" },
					total: { type: "integer" },
					counts: {
						type: "object",
						additionalProperties: { type: "integer" },
					},
				},
				required: ["startMs", "total", "counts"],
			},
		},
		totalRows: { type: "integer" },
		scannedRows: { type: "integer" },
		truncated: { type: "boolean" },
		truncation: truncationSchema,
		coveredFrom: { type: "string" },
		retentionFloor: { type: ["string", "null"] },
		generatedAt: { type: "string" },
	},
	required: [
		"producedFrom",
		"producedTo",
		"bucketMs",
		"buckets",
		"totalRows",
		"scannedRows",
		"truncated",
		"truncation",
		"coveredFrom",
		"retentionFloor",
		"generatedAt",
	],
} as const

function invalidParam(message: string): ActivityQueryError {
	return new ActivityQueryError(message, "ACTIVITY_QUERY_INVALID", 400)
}

/** Shared aggregate params: times, categories and protocols (comma lists or repeated). */
function aggregateBase(
	params: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
): {
	producedFrom?: string
	producedTo?: string
	categories?: ActivityCategory[]
	protocols?: string[]
} {
	for (const key of Object.keys(params)) {
		if (!allowed.has(key)) {
			throw invalidParam(`Unknown activity ${label} parameter ${key}`)
		}
	}
	const request: {
		producedFrom?: string
		producedTo?: string
		categories?: ActivityCategory[]
		protocols?: string[]
	} = {}
	for (const name of ["producedFrom", "producedTo"] as const) {
		const value = params[name]
		if (value === undefined) continue
		if (typeof value !== "string")
			throw invalidParam(`${name} must be a string`)
		request[name] = value
	}
	if (params["categories"] !== undefined) {
		const values = asStrings(params["categories"])
		if (values.length > 0)
			request.categories = values as unknown as ActivityCategory[]
	}
	if (params["protocols"] !== undefined) {
		const values = asStrings(params["protocols"])
		if (values.length > 0) request.protocols = values
	}
	return request
}

function bandMapRequest(params: Record<string, unknown>): ActivityBandMapQuery {
	const request: ActivityBandMapQuery & Record<string, unknown> = aggregateBase(
		params,
		BANDMAP_PARAMS,
		"bandmap",
	)
	for (const name of ["minHz", "maxHz", "bucketHz"] as const) {
		const value = params[name]
		if (value === undefined) continue
		if (typeof value !== "string")
			throw invalidParam(`${name} must be a string`)
		request[name] = parseDecimalInteger(value, name)
	}
	return request
}

function timelineRequest(
	params: Record<string, unknown>,
): ActivityTimelineQuery {
	const request: ActivityTimelineQuery & Record<string, unknown> =
		aggregateBase(params, TIMELINE_PARAMS, "timeline")
	const bucketMs = params["bucketMs"]
	if (bucketMs !== undefined) {
		if (typeof bucketMs !== "string") {
			throw invalidParam("bucketMs must be a string")
		}
		request["bucketMs"] = parseDecimalInteger(bucketMs, "bucketMs")
	}
	const entityKey = params["entityKey"]
	if (entityKey !== undefined) {
		// Entity keys may contain commas: repeated parameters only, never split.
		const raw = Array.isArray(entityKey) ? entityKey : [entityKey]
		const keys: string[] = []
		for (const value of raw) {
			if (typeof value !== "string") {
				throw invalidParam("entityKey must be a string")
			}
			keys.push(value)
		}
		if (keys.length > 0) request["entityKeys"] = keys
	}
	return request
}

function aggregateUnavailable(): ActivityQueryError {
	return new ActivityQueryError(
		"Activity aggregates are unavailable",
		"ACTIVITY_UNAVAILABLE",
		503,
	)
}

function correlationOf(request: FastifyRequest): string | undefined {
	const value = (request as FastifyRequest & { correlationId?: string })
		.correlationId
	return typeof value === "string" ? value : undefined
}

function sendError(
	reply: FastifyReply,
	request: FastifyRequest,
	error: unknown,
): FastifyReply {
	if (!(error instanceof ActivityQueryError)) throw error
	const body: {
		error: string
		code: string
		message: string
		reason?: string
		correlationId?: string
	} = {
		error: error.name,
		code: error.code,
		message: error.message,
	}
	if (error.reason !== undefined) body.reason = error.reason
	const correlationId = correlationOf(request)
	if (correlationId !== undefined) body.correlationId = correlationId
	return reply.code(error.statusCode).send(body)
}

function disabled(reply: FastifyReply): FastifyReply {
	return reply.code(404).send({
		error: "NotFound",
		code: "ACTIVITY_DISABLED",
		message: "Activity is disabled",
	})
}

function disclosed(options: ActivityRoutesOptions): boolean {
	if (options.discloseErrors !== undefined) return options.discloseErrors
	const onState = options.unavailable?.discloseErrors
	if (onState !== undefined) return onState
	return true
}

function unavailable(
	reply: FastifyReply,
	options: ActivityRoutesOptions,
	state: ActivityUnavailableState,
): FastifyReply {
	return reply.code(503).send({
		error: "ServiceUnavailable",
		code: "ACTIVITY_UNAVAILABLE",
		reason: state.reason,
		message: disclosed(options) ? state.message : "Request failed",
	})
}

/** Disabled and unavailable answers. Undefined means the handler may proceed. */
function blocked(
	options: ActivityRoutesOptions,
	reply: FastifyReply,
): FastifyReply | undefined {
	if (options.unavailable)
		return unavailable(reply, options, options.unavailable)
	if (!options.enabled) return disabled(reply)
	return undefined
}

/**
 * Stable per caller. The admitted access principal (device id when that is
 * the principal) wins. Otherwise the request IP. Client-chosen headers,
 * including `x-activity-client`, are ignored.
 */
export function activityClientKey(
	request: FastifyRequest,
	access?: ActivityAccessContext,
): string {
	const principalId = access?.principalId(request)
	if (typeof principalId === "string" && principalId.length > 0)
		return `principal:${principalId}`
	return `ip:${request.ip}`
}

function asStrings(value: unknown): string[] {
	if (typeof value === "string") {
		return value
			.split(",")
			.map(part => part.trim())
			.filter(part => part.length > 0)
	}
	if (Array.isArray(value)) {
		const parts: string[] = []
		for (const entry of value) parts.push(...asStrings(entry))
		return parts
	}
	throw new ActivityQueryError(
		"Query parameter must be a string",
		"ACTIVITY_QUERY_INVALID",
		400,
	)
}

function queryFromParams(params: Record<string, unknown>): ActivityQuery {
	for (const key of Object.keys(params)) {
		if (!SEARCH_PARAMS.has(key)) {
			throw new ActivityQueryError(
				`Unknown activity query parameter ${key}`,
				"ACTIVITY_QUERY_INVALID",
				400,
			)
		}
	}
	const query: ActivityQuery = {}
	const list = (name: string): string[] | undefined => {
		if (params[name] === undefined) return undefined
		const values = asStrings(params[name])
		return values.length > 0 ? values : undefined
	}
	const kinds = list("kinds")
	const sourceIds = list("sourceIds")
	const decoderIds = list("decoderIds")
	const protocols = list("protocols")
	const categories = list("categories")
	if (kinds) query.kinds = [...kinds] as ActivityKind[]
	if (sourceIds) query.sourceIds = [...sourceIds]
	if (decoderIds) query.decoderIds = [...decoderIds]
	if (protocols) query.protocols = [...protocols]
	if (categories) query.categories = [...categories] as ActivityCategory[]
	const frequencyMin = params["frequencyMin"]
	const frequencyMax = params["frequencyMax"]
	if (frequencyMin !== undefined || frequencyMax !== undefined) {
		const frequency: { min?: number; max?: number } = {}
		if (frequencyMin !== undefined)
			frequency.min = numberParam(frequencyMin, "frequencyMin")
		if (frequencyMax !== undefined)
			frequency.max = numberParam(frequencyMax, "frequencyMax")
		query.frequencyHz = frequency
	}
	const producedFrom = params["producedFrom"]
	const producedTo = params["producedTo"]
	if (producedFrom !== undefined || producedTo !== undefined) {
		const produced: { from?: string; to?: string } = {}
		if (producedFrom !== undefined) {
			if (typeof producedFrom !== "string") {
				throw new ActivityQueryError(
					"producedFrom must be a string",
					"ACTIVITY_QUERY_INVALID",
					400,
				)
			}
			produced.from = producedFrom
		}
		if (producedTo !== undefined) {
			if (typeof producedTo !== "string") {
				throw new ActivityQueryError(
					"producedTo must be a string",
					"ACTIVITY_QUERY_INVALID",
					400,
				)
			}
			produced.to = producedTo
		}
		query.producedAt = produced
	}
	if (typeof params["entityKey"] === "string")
		query.entityKey = params["entityKey"]
	else if (params["entityKey"] !== undefined) {
		throw new ActivityQueryError(
			"entityKey must be a string",
			"ACTIVITY_QUERY_INVALID",
			400,
		)
	}
	if (typeof params["text"] === "string") query.text = params["text"]
	else if (params["text"] !== undefined) {
		throw new ActivityQueryError(
			"text must be a string",
			"ACTIVITY_QUERY_INVALID",
			400,
		)
	}
	if (params["refs"] !== undefined) {
		const refs: { type: ActivityRefType; value: string }[] = []
		for (const entry of asStrings(params["refs"])) {
			const colon = entry.indexOf(":")
			const type = entry.slice(0, colon)
			const value = entry.slice(colon + 1)
			if (
				colon <= 0 ||
				!REF_TYPES.has(type as ActivityRefType) ||
				value.length === 0
			) {
				throw new ActivityQueryError(
					"refs entries must be type:value",
					"ACTIVITY_QUERY_INVALID",
					400,
				)
			}
			refs.push({ type: type as ActivityRefType, value })
		}
		if (refs.length > 0) query.refs = refs
	}
	return query
}

function numberParam(value: unknown, name: string): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN
	if (!Number.isFinite(parsed)) {
		throw new ActivityQueryError(
			`${name} must be a number`,
			"ACTIVITY_QUERY_INVALID",
			400,
		)
	}
	return parsed
}

function searchRequest(params: Record<string, unknown>): ActivitySearchRequest {
	const request: ActivitySearchRequest = { query: queryFromParams(params) }
	if (params["order"] !== undefined) {
		if (params["order"] !== "asc" && params["order"] !== "desc") {
			throw new ActivityQueryError(
				"order must be asc or desc",
				"ACTIVITY_QUERY_INVALID",
				400,
			)
		}
		request.order = params["order"]
	}
	if (params["limit"] !== undefined) {
		const limit = numberParam(params["limit"], "limit")
		if (!Number.isSafeInteger(limit)) {
			throw new ActivityQueryError(
				"limit must be an integer",
				"ACTIVITY_QUERY_INVALID",
				400,
			)
		}
		request.limit = limit
	}
	if (params["pageToken"] !== undefined) {
		if (typeof params["pageToken"] !== "string") {
			throw new ActivityQueryError(
				"pageToken must be a string",
				"ACTIVITY_QUERY_INVALID",
				400,
			)
		}
		request.pageToken = params["pageToken"]
	}
	return request
}

export const activityRoutes: FastifyPluginAsync<ActivityRoutesOptions> = async (
	fastify,
	options,
) => {
	const tags = ["activity"]
	const disabledReply = { 404: errorResponseSchema, 503: errorResponseSchema }

	fastify.get(
		"/api/activity",
		{
			schema: {
				tags,
				summary: "Search activity summaries inside a snapshot",
				querystring: { type: "object", additionalProperties: true },
				response: {
					200: looseObjectSchema,
					...disabledReply,
					400: errorResponseSchema,
					409: errorResponseSchema,
					410: errorResponseSchema,
					429: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const blockedReply = blocked(options, reply)
			if (blockedReply) return blockedReply
			try {
				const params = request.query as Record<string, unknown>
				return await withActivityClient(
					activityClientKey(request, options.access),
					() => options.service.search(searchRequest(params)),
				)
			} catch (error) {
				return sendError(reply, request, error)
			}
		},
	)

	fastify.get(
		"/api/activity/trails",
		{
			schema: {
				tags,
				summary: "Bulk position trails, one per entity, newest bounded",
				querystring: { type: "object", additionalProperties: true },
				response: {
					200: trailsResponseSchema,
					...disabledReply,
					400: errorResponseSchema,
					429: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const blockedReply = blocked(options, reply)
			if (blockedReply) return blockedReply
			try {
				const params = request.query as Record<string, unknown>
				const query = trailsRequest(params)
				return await withActivityClient(
					activityClientKey(request, options.access),
					() => options.service.trails(query),
				)
			} catch (error) {
				return sendError(reply, request, error)
			}
		},
	)

	fastify.get(
		"/api/activity/bandmap",
		{
			schema: {
				tags,
				summary: "Band map: decoded rows per frequency bucket",
				querystring: { type: "object", additionalProperties: true },
				response: {
					200: bandMapResponseSchema,
					...disabledReply,
					400: errorResponseSchema,
					429: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const blockedReply = blocked(options, reply)
			if (blockedReply) return blockedReply
			try {
				const params = request.query as Record<string, unknown>
				const query = bandMapRequest(params)
				const read = options.service.bandMap
				if (!read) throw aggregateUnavailable()
				return await withActivityClient(
					activityClientKey(request, options.access),
					() => read.call(options.service, query),
				)
			} catch (error) {
				return sendError(reply, request, error)
			}
		},
	)

	fastify.get(
		"/api/activity/timeline",
		{
			schema: {
				tags,
				summary: "Timeline: rows per time bucket and category",
				querystring: { type: "object", additionalProperties: true },
				response: {
					200: timelineResponseSchema,
					...disabledReply,
					400: errorResponseSchema,
					429: errorResponseSchema,
					500: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const blockedReply = blocked(options, reply)
			if (blockedReply) return blockedReply
			try {
				const params = request.query as Record<string, unknown>
				const query = timelineRequest(params)
				const read = options.service.timeline
				if (!read) throw aggregateUnavailable()
				return await withActivityClient(
					activityClientKey(request, options.access),
					() => read.call(options.service, query),
				)
			} catch (error) {
				return sendError(reply, request, error)
			}
		},
	)

	fastify.get(
		"/api/activity/status",
		{
			schema: {
				tags,
				summary: "Activity store status",
				response: { 200: looseObjectSchema, ...disabledReply },
			},
		},
		async (_request, reply) => {
			const blockedReply = blocked(options, reply)
			if (blockedReply) return blockedReply
			if (!options.stats) {
				return reply.code(500).send({
					error: "InternalServerError",
					code: "ACTIVITY_STATUS_UNAVAILABLE",
					message: "Activity status is unavailable",
				})
			}
			return { enabled: true, stats: await options.stats() }
		},
	)

	fastify.post(
		"/api/activity/facets",
		{
			schema: {
				tags,
				summary: "Bounded facet counts for an activity query",
				body: { type: "object", additionalProperties: true },
				response: {
					200: looseObjectSchema,
					...disabledReply,
					400: errorResponseSchema,
					409: errorResponseSchema,
					429: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const blockedReply = blocked(options, reply)
			if (blockedReply) return blockedReply
			try {
				const body = request.body as { query?: unknown; dimensions?: unknown }
				return await withActivityClient(
					activityClientKey(request, options.access),
					() =>
						options.service.facets({
							query: (body?.query ?? {}) as ActivityQuery,
							dimensions: (body?.dimensions ?? []) as ActivityFacetDimensions,
						}),
				)
			} catch (error) {
				return sendError(reply, request, error)
			}
		},
	)

	fastify.get<{ Params: { eventId: string } }>(
		"/api/activity/:eventId",
		{
			schema: {
				tags,
				summary: "Fetch one activity record",
				params: {
					type: "object",
					properties: { eventId: { type: "string" } },
					required: ["eventId"],
				},
				response: {
					200: looseObjectSchema,
					...disabledReply,
					400: errorResponseSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const blockedReply = blocked(options, reply)
			if (blockedReply) return blockedReply
			try {
				const record = await withActivityClient(
					activityClientKey(request, options.access),
					() => options.service.detail(request.params.eventId),
				)
				if (!record) {
					return reply.code(404).send({
						error: "NotFound",
						code: "NOT_FOUND",
						message: "Activity event not found",
					})
				}
				return record
			} catch (error) {
				return sendError(reply, request, error)
			}
		},
	)
}

type ActivityFacetDimensions = Parameters<
	ActivityQueryService["facets"]
>[0]["dimensions"]
