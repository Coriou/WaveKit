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
} from "../../core/activity/storage/contract.js"
import { ActivityQueryError } from "../../core/activity/query/errors.js"
import { withActivityClient } from "../../core/activity/query/service.js"
import { errorResponseSchema, looseObjectSchema } from "./scanner-schemas.js"

export interface ActivityRoutesOptions {
	service: ActivityQueryService
	enabled: boolean
	/** Required for a useful status payload. Omitted when Activity has no store. */
	stats?: () => ActivityStoreStats | Promise<ActivityStoreStats>
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

function correlationOf(request: FastifyRequest): string | undefined {
	const value = (request as FastifyRequest & { correlationId?: string }).correlationId
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

/** Stable per caller. `x-activity-client` wins; otherwise the request IP. */
export function activityClientKey(request: FastifyRequest): string {
	const header = request.headers["x-activity-client"]
	if (typeof header === "string" && header.length > 0 && header.length <= 128) {
		return `client:${header}`
	}
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
	throw new ActivityQueryError("Query parameter must be a string", "ACTIVITY_QUERY_INVALID", 400)
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
		if (frequencyMin !== undefined) frequency.min = numberParam(frequencyMin, "frequencyMin")
		if (frequencyMax !== undefined) frequency.max = numberParam(frequencyMax, "frequencyMax")
		query.frequencyHz = frequency
	}
	const producedFrom = params["producedFrom"]
	const producedTo = params["producedTo"]
	if (producedFrom !== undefined || producedTo !== undefined) {
		const produced: { from?: string; to?: string } = {}
		if (producedFrom !== undefined) {
			if (typeof producedFrom !== "string") {
				throw new ActivityQueryError("producedFrom must be a string", "ACTIVITY_QUERY_INVALID", 400)
			}
			produced.from = producedFrom
		}
		if (producedTo !== undefined) {
			if (typeof producedTo !== "string") {
				throw new ActivityQueryError("producedTo must be a string", "ACTIVITY_QUERY_INVALID", 400)
			}
			produced.to = producedTo
		}
		query.producedAt = produced
	}
	if (typeof params["entityKey"] === "string") query.entityKey = params["entityKey"]
	else if (params["entityKey"] !== undefined) {
		throw new ActivityQueryError("entityKey must be a string", "ACTIVITY_QUERY_INVALID", 400)
	}
	if (typeof params["text"] === "string") query.text = params["text"]
	else if (params["text"] !== undefined) {
		throw new ActivityQueryError("text must be a string", "ACTIVITY_QUERY_INVALID", 400)
	}
	if (params["refs"] !== undefined) {
		const refs: { type: ActivityRefType; value: string }[] = []
		for (const entry of asStrings(params["refs"])) {
			const colon = entry.indexOf(":")
			const type = entry.slice(0, colon)
			const value = entry.slice(colon + 1)
			if (colon <= 0 || !REF_TYPES.has(type as ActivityRefType) || value.length === 0) {
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
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
	if (!Number.isFinite(parsed)) {
		throw new ActivityQueryError(`${name} must be a number`, "ACTIVITY_QUERY_INVALID", 400)
	}
	return parsed
}

function searchRequest(params: Record<string, unknown>): ActivitySearchRequest {
	const request: ActivitySearchRequest = { query: queryFromParams(params) }
	if (params["order"] !== undefined) {
		if (params["order"] !== "asc" && params["order"] !== "desc") {
			throw new ActivityQueryError("order must be asc or desc", "ACTIVITY_QUERY_INVALID", 400)
		}
		request.order = params["order"]
	}
	if (params["limit"] !== undefined) {
		const limit = numberParam(params["limit"], "limit")
		if (!Number.isSafeInteger(limit)) {
			throw new ActivityQueryError("limit must be an integer", "ACTIVITY_QUERY_INVALID", 400)
		}
		request.limit = limit
	}
	if (params["pageToken"] !== undefined) {
		if (typeof params["pageToken"] !== "string") {
			throw new ActivityQueryError("pageToken must be a string", "ACTIVITY_QUERY_INVALID", 400)
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
	const disabledReply = { 404: errorResponseSchema }

	fastify.get(
		"/api/activity",
		{
			schema: {
				tags,
				summary: "Search activity summaries inside a snapshot",
				querystring: { type: "object", additionalProperties: true },
				response: { 200: looseObjectSchema, ...disabledReply, 400: errorResponseSchema, 409: errorResponseSchema, 410: errorResponseSchema, 429: errorResponseSchema },
			},
		},
		async (request, reply) => {
			if (!options.enabled) return disabled(reply)
			try {
				const params = request.query as Record<string, unknown>
				return await withActivityClient(activityClientKey(request), () =>
					options.service.search(searchRequest(params)),
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
			if (!options.enabled) return disabled(reply)
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
				response: { 200: looseObjectSchema, ...disabledReply, 400: errorResponseSchema, 409: errorResponseSchema, 429: errorResponseSchema },
			},
		},
		async (request, reply) => {
			if (!options.enabled) return disabled(reply)
			try {
				const body = request.body as { query?: unknown; dimensions?: unknown }
				return await withActivityClient(activityClientKey(request), () =>
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
				response: { 200: looseObjectSchema, ...disabledReply, 400: errorResponseSchema, 404: errorResponseSchema },
			},
		},
		async (request, reply) => {
			if (!options.enabled) return disabled(reply)
			try {
				const record = await withActivityClient(activityClientKey(request), () =>
					options.service.detail(request.params.eventId),
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

type ActivityFacetDimensions = Parameters<ActivityQueryService["facets"]>[0]["dimensions"]
