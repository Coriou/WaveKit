import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import type { RegionalErrorResponse } from "@wavekit/api-types"
import { z } from "zod"
import { WaveKitError } from "../../utils/errors.js"
import type { RegionalRegistry } from "../../core/regional/registry.js"
import {
	CoarseContextSchema,
	DatasetSchema,
	IdSchema,
	RegionSchema,
	RowSchema,
	UnavailableManifestSchema,
	VerifiedManifestSchema,
	canonicalBytes,
	normalizeAlias,
	REGIONAL_LIMITS,
} from "../../core/regional/types.js"
import type { RegionCode } from "../../core/regional/types.js"

export interface RegionalRoutesOptions {
	registry: RegionalRegistry | null
}
type FamiliesQuery = { kind: "families"; region: RegionCode }
type ChannelsQuery = {
	kind: "channels"
	region: RegionCode
	family: string
	offset: number
	limit: number
}
type ResolveQuery = {
	kind: "resolve"
	region: RegionCode
	family: string
	alias: string
}
type Query = FamiliesQuery | ChannelsQuery | ResolveQuery
const queryKey = Symbol("regional validated query")
type RegionalRequest = FastifyRequest & { [queryKey]?: Query }
const paths = [
	"/api/regional/families",
	"/api/regional/channels",
	"/api/regional/resolve",
] as const
const deniedMethods = ["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const
const selectionSchema = z
	.object({
		requestedRegion: RegionSchema,
		source: z.literal("query"),
		coarseContext: CoarseContextSchema.nullable(),
	})
	.strict()
const manifestSchema = z.union([
	UnavailableManifestSchema,
	VerifiedManifestSchema,
])
const headerSchema = DatasetSchema.omit({
	schemaVersion: true,
	familyId: true,
	rows: true,
}).strict()
const common = { schemaVersion: z.literal(1), selection: selectionSchema }
const unavailableSchema = z
	.object({
		...common,
		familyId: z.literal("frs"),
		state: z.literal("unavailable"),
		reason: z.literal("evidence-pending"),
	})
	.strict()
const unsupportedSchema = z
	.object({
		...common,
		familyId: z.literal("frs"),
		state: z.literal("unsupported"),
		reason: z.literal("region-not-covered"),
	})
	.strict()
const familiesSchema = z.union([
	z
		.object({
			...common,
			state: z.literal("available"),
			families: z.tuple([manifestSchema]),
		})
		.strict(),
	z
		.object({
			...common,
			state: z.literal("unsupported"),
			reason: z.literal("region-not-covered"),
			families: z.tuple([]),
		})
		.strict(),
])
const safeInt = (min: number, max: number) =>
	z
		.number()
		.int()
		.min(min)
		.max(max)
		.refine(value => Number.isSafeInteger(value) && !Object.is(value, -0))
const verifiedChannelsSchema = z
	.object({
		...common,
		state: z.literal("verified"),
		dataset: headerSchema,
		total: safeInt(0, 128),
		offset: safeInt(0, 1024),
		limit: safeInt(1, 128),
		rows: z.array(RowSchema).max(128),
		nextOffset: safeInt(0, 1024).nullable(),
	})
	.strict()
const channelsSchema = z.union([
	unavailableSchema,
	unsupportedSchema,
	verifiedChannelsSchema,
])
const verifiedResolveSchema = z
	.object({
		...common,
		state: z.literal("verified"),
		dataset: headerSchema,
		normalizedAlias: z.string(),
		result: z.enum(["matched", "ambiguous", "not-found"]),
		candidates: z.array(RowSchema).max(128),
	})
	.strict()
const resolveSchema = z.union([
	unavailableSchema,
	unsupportedSchema,
	verifiedResolveSchema,
])
const errors: Readonly<Record<400 | 404 | 405 | 503, RegionalErrorResponse>> = {
	400: {
		error: "Bad Request",
		code: "REGIONAL_INVALID_REQUEST",
		message: "Invalid regional registry request",
	},
	404: {
		error: "Not Found",
		code: "REGIONAL_FAMILY_NOT_FOUND",
		message: "Regional family not found",
	},
	405: {
		error: "Method Not Allowed",
		code: "REGIONAL_METHOD_NOT_ALLOWED",
		message: "Regional registry method is not allowed",
	},
	503: {
		error: "Service Unavailable",
		code: "REGIONAL_UNAVAILABLE",
		message: "Regional registry is unavailable",
	},
}
function invalid(): never {
	throw new WaveKitError(
		"Invalid regional registry request",
		"REGIONAL_INVALID_REQUEST",
	)
}
function outputFailure(): never {
	throw new WaveKitError(
		"Regional registry is unavailable",
		"REGIONAL_UNAVAILABLE",
	)
}
function identity(value: unknown): string {
	if (typeof value !== "string") outputFailure()
	return value
}
function sendError(reply: FastifyReply, status: 400 | 404 | 405 | 503) {
	if (status === 405) reply.header("Allow", "GET")
	return reply
		.header("Cache-Control", "no-store")
		.type("application/json; charset=utf-8")
		.serializer(identity)
		.code(status)
		.send(canonicalBytes(errors[status], 256).toString("utf8"))
}
function framed(request: FastifyRequest): boolean {
	let lengths = 0
	for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
		const name = request.raw.rawHeaders[index]?.toLowerCase()
		if (name === "transfer-encoding") return true
		if (name === "content-length") {
			lengths++
			if (lengths > 1 || request.raw.rawHeaders[index + 1] !== "0") return true
		}
	}
	return (
		request.headers["transfer-encoding"] !== undefined ||
		(request.headers["content-length"] !== undefined &&
			request.headers["content-length"] !== "0")
	)
}
function decode(value: string): string {
	try {
		const decoded = decodeURIComponent(value.replace(/\+/g, " "))
		if (/[\p{Cc}\p{Cs}]/u.test(decoded)) invalid()
		return decoded
	} catch {
		return invalid()
	}
}
function parseQuery(request: FastifyRequest, kind: Query["kind"]): Query {
	const target = request.raw.url ?? ""
	const start = target.indexOf("?")
	const raw = start < 0 ? "" : target.slice(start + 1)
	if (raw.length > 1024 || !/^[\x20-\x7e]*$/.test(raw) || raw.includes("#"))
		invalid()
	const pairs = raw === "" ? [] : raw.split("&")
	if (pairs.length > 4) invalid()
	const permitted =
		kind === "families"
			? ["region"]
			: kind === "channels"
				? ["region", "family", "offset", "limit"]
				: ["region", "family", "alias"]
	const values = new Map<string, string>()
	for (const pair of pairs) {
		const equal = pair.indexOf("=")
		if (
			equal <= 0 ||
			equal !== pair.lastIndexOf("=") ||
			equal === pair.length - 1
		)
			invalid()
		const key = decode(pair.slice(0, equal))
		const value = decode(pair.slice(equal + 1))
		if (!permitted.includes(key) || values.has(key)) invalid()
		values.set(key, value)
	}
	const region = RegionSchema.safeParse(values.get("region"))
	if (!region.success) invalid()
	if (kind === "families") return { kind, region: region.data }
	const family = IdSchema.safeParse(values.get("family"))
	if (!family.success) invalid()
	if (kind === "resolve") {
		const alias = values.get("alias")
		if (alias === undefined) invalid()
		return {
			kind,
			region: region.data,
			family: family.data,
			alias: normalizeAlias(alias),
		}
	}
	function decimal(
		name: "offset" | "limit",
		fallback: number,
		min: number,
		max: number,
	): number {
		const text = values.get(name)
		if (text === undefined) return fallback
		if (!/^(0|[1-9][0-9]{0,3})$/.test(text)) invalid()
		const number = Number(text)
		if (number < min || number > max) invalid()
		return number
	}
	return {
		kind,
		region: region.data,
		family: family.data,
		offset: decimal("offset", 0, 0, 1024),
		limit: decimal("limit", 64, 1, 128),
	}
}
function sortedUnique(values: readonly string[]): boolean {
	return values.every(
		(value, index) => index === 0 || values[index - 1]! < value,
	)
}
function validateRows(
	rows: z.infer<typeof RowSchema>[],
	header: z.infer<typeof headerSchema>,
): void {
	if (
		!sortedUnique(header.sourceReferences.map(source => source.id)) ||
		!sortedUnique(rows.map(row => row.id))
	)
		outputFailure()
	const sources = new Set(header.sourceReferences.map(source => source.id))
	for (const row of rows) {
		if (
			row.frequency.kind !== "simplex" ||
			!sortedUnique(row.aliases) ||
			!sortedUnique(row.sourceReferenceIds) ||
			row.sourceReferenceIds.some(id => !sources.has(id))
		)
			outputFailure()
	}
}
function encodeOutput(raw: unknown, query: Query): string {
	// Descriptor-safe copy before Zod: no provider getter/proxy can be invoked.
	const safe: unknown = JSON.parse(
		canonicalBytes(raw, REGIONAL_LIMITS.responseBytes).toString("utf8"),
	)
	if (query.kind === "families") {
		const parsed = familiesSchema.safeParse(safe)
		if (!parsed.success) outputFailure()
		const value = parsed.data
		if (
			value.selection.requestedRegion !== query.region ||
			(query.region === "US") !== (value.state === "available")
		)
			outputFailure()
		return canonicalBytes(value, REGIONAL_LIMITS.responseBytes).toString("utf8")
	}
	if (query.kind === "channels") {
		const parsed = channelsSchema.safeParse(safe)
		if (!parsed.success) outputFailure()
		const value = parsed.data
		if (
			value.selection.requestedRegion !== query.region ||
			(query.region !== "US") !== (value.state === "unsupported")
		)
			outputFailure()
		if (value.state === "verified") {
			const count = Math.min(
				query.limit,
				Math.max(0, value.total - query.offset),
			)
			if (
				value.offset !== query.offset ||
				value.limit !== query.limit ||
				value.rows.length !== count ||
				value.nextOffset !==
					(query.offset + count < value.total ? query.offset + count : null)
			)
				outputFailure()
			validateRows(value.rows, value.dataset)
		}
		return canonicalBytes(value, REGIONAL_LIMITS.responseBytes).toString("utf8")
	}
	const parsed = resolveSchema.safeParse(safe)
	if (!parsed.success) outputFailure()
	const value = parsed.data
	if (
		value.selection.requestedRegion !== query.region ||
		(query.region !== "US") !== (value.state === "unsupported")
	)
		outputFailure()
	if (value.state === "verified") {
		const count = value.candidates.length
		if (
			value.normalizedAlias !== query.alias ||
			(value.result === "matched"
				? count !== 1
				: value.result === "ambiguous"
					? count < 2
					: count !== 0)
		)
			outputFailure()
		validateRows(value.candidates, value.dataset)
		if (value.candidates.some(row => !row.aliases.includes(query.alias)))
			outputFailure()
	}
	return canonicalBytes(value, REGIONAL_LIMITS.responseBytes).toString("utf8")
}

// Closed documentation/response schemas. Manual output validation above remains
// authoritative; custom serializers send exactly those prevalidated UTF8 bytes.
type JsonSchema = Record<string, unknown>
const object = (properties: Record<string, unknown>): JsonSchema => ({
	type: "object",
	additionalProperties: false,
	properties,
	required: Object.keys(properties),
})
const string = (maxLength: number): JsonSchema => ({
	type: "string",
	minLength: 1,
	maxLength,
})
const literal = (value: string | number | boolean | null): JsonSchema => ({
	const: value,
})
const array = (
	items: JsonSchema,
	minItems: number,
	maxItems: number,
): JsonSchema => ({ type: "array", items, minItems, maxItems })
const integer = (minimum: number, maximum: number): JsonSchema => ({
	type: "integer",
	minimum,
	maximum,
})
const nullable = (schema: JsonSchema): JsonSchema => ({
	anyOf: [schema, { type: "null" }],
})
const idJson = { ...string(64), pattern: "^[a-z][a-z0-9-]{0,63}$" }
const versionJson = { ...string(32), pattern: "^[a-z0-9][a-z0-9.-]{0,31}$" }
const digestJson = { type: "string", pattern: "^[0-9a-f]{64}$" }
const dateJson = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
const applicabilityJson = object({
	kind: literal("national"),
	countryCode: literal("US"),
})
const contextJson = object({
	code: { type: "string", enum: RegionSchema.options },
	source: { type: "string", enum: CoarseContextSchema.shape.source.options },
})
const selectionJson = object({
	requestedRegion: { type: "string", enum: RegionSchema.options },
	source: literal("query"),
	coarseContext: nullable(contextJson),
})
const sourceJson = object({
	id: idJson,
	organization: string(120),
	documentId: string(80),
	title: string(120),
	edition: string(80),
	publishedDate: nullable(dateJson),
	retrievedDate: dateJson,
	url: string(512),
	documentSha256: digestJson,
	applicability: literal("US"),
	redistribution: literal("facts-transcribed"),
	locator: string(120),
})
const headerJson = object({
	datasetId: literal("us-frs"),
	datasetVersion: versionJson,
	dataContentSha256: digestJson,
	applicability: applicabilityJson,
	verifiedAsOf: dateJson,
	sourceReferences: array(sourceJson, 1, 8),
})
const rowJson = object({
	id: { ...idJson, pattern: "^us-frs-[a-z0-9-]+$" },
	displayLabel: string(80),
	aliases: array(string(32), 0, 8),
	frequency: object({
		kind: literal("simplex"),
		frequencyHz: integer(1, 1_000_000_000_000),
	}),
	display: object({
		advisory: literal(true),
		mode: { enum: [null, "nfm", "fm", "am", "digital", "unknown"] },
		bandwidthHz: nullable(integer(1, 10_000_000)),
		stepHz: nullable(integer(1, 10_000_000)),
	}),
	sourceReferenceIds: array(idJson, 1, 4),
})
const manifestJson = {
	anyOf: [
		object({
			familyId: literal("frs"),
			displayLabel: string(80),
			applicability: applicabilityJson,
			state: literal("unavailable"),
			datasetVersion: literal(null),
			reason: literal("evidence-pending"),
		}),
		object({
			familyId: literal("frs"),
			displayLabel: string(80),
			applicability: applicabilityJson,
			state: literal("verified"),
			datasetVersion: versionJson,
			reason: literal(null),
		}),
	],
}
const baseJson = { schemaVersion: literal(1), selection: selectionJson }
const unsupportedJson = object({
	...baseJson,
	familyId: literal("frs"),
	state: literal("unsupported"),
	reason: literal("region-not-covered"),
})
const unavailableJson = object({
	...baseJson,
	familyId: literal("frs"),
	state: literal("unavailable"),
	reason: literal("evidence-pending"),
})
const familiesJson = {
	anyOf: [
		object({
			...baseJson,
			state: literal("available"),
			families: array(manifestJson, 1, 1),
		}),
		object({
			...baseJson,
			state: literal("unsupported"),
			reason: literal("region-not-covered"),
			families: array(manifestJson, 0, 0),
		}),
	],
}
const channelsJson = {
	anyOf: [
		unsupportedJson,
		unavailableJson,
		object({
			...baseJson,
			state: literal("verified"),
			dataset: headerJson,
			total: integer(0, 128),
			offset: integer(0, 1024),
			limit: integer(1, 128),
			rows: array(rowJson, 0, 128),
			nextOffset: nullable(integer(0, 1024)),
		}),
	],
}
const resolveJson = {
	anyOf: [
		unsupportedJson,
		unavailableJson,
		...(["matched", "ambiguous", "not-found"] as const).map(result =>
			object({
				...baseJson,
				state: literal("verified"),
				dataset: headerJson,
				normalizedAlias: string(32),
				result: literal(result),
				candidates: array(
					rowJson,
					result === "matched" ? 1 : result === "ambiguous" ? 2 : 0,
					result === "matched" ? 1 : result === "ambiguous" ? 128 : 0,
				),
			}),
		),
	],
}
const rootDenialJson = object({
	code: {
		type: "string",
		enum: [
			"MALFORMED_REQUEST",
			"HOST_FORBIDDEN",
			"ORIGIN_FORBIDDEN",
			"CSRF_REQUIRED",
			"PREFLIGHT_FORBIDDEN",
			"AUTH_REQUIRED",
			"ACCESS_UNAVAILABLE",
			"ACCESS_CAPACITY",
		],
	},
})
const responseErrors = Object.fromEntries(
	[400, 401, 403, 404, 405, 429, 503].map(status => {
		const local =
			status === 400 || status === 404 || status === 405 || status === 503
				? errors[status]
				: undefined
		return [
			status,
			local
				? {
						anyOf: [
							object({
								error: literal(local.error),
								code: literal(local.code),
								message: literal(local.message),
							}),
							rootDenialJson,
						],
					}
				: rootDenialJson,
		]
	}),
)

/** Encapsulated child: root admission always precedes this hook and every read. */
export const regionalRoutes: FastifyPluginAsync<RegionalRoutesOptions> = async (
	app,
	options,
) => {
	const local = new WeakSet<FastifyRequest>()
	app.setErrorHandler((error, request, reply) => {
		if (!local.has(request)) {
			// The parent owns pre-feature failures. Avoid this route's response
			// schemas stripping its existing global envelope during delegation.
			reply.serializer(value => {
				// Delegation clears media headers at parent-handler entry. Restore
				// the standard parent JSON type only during its later serialization.
				if (!reply.hasHeader("Content-Type"))
					reply.type("application/json; charset=utf-8")
				return JSON.stringify(value)
			})
			return reply.send(error)
		}
		return sendError(reply, 503)
	})
	app.addHook("onRequest", async (request, reply) => {
		local.add(request)
		if (framed(request)) return sendError(reply, 400)
		if (request.method !== "GET") return sendError(reply, 405)
		const kind =
			request.routeOptions.url === paths[0]
				? "families"
				: request.routeOptions.url === paths[1]
					? "channels"
					: "resolve"
		try {
			;(request as RegionalRequest)[queryKey] = parseQuery(request, kind)
		} catch {
			return sendError(reply, 400)
		}
	})
	app.addHook("onSend", async (request, reply, payload) => {
		if (local.has(request)) reply.header("Cache-Control", "no-store")
		return payload
	})
	for (const [index, path] of paths.entries()) {
		const success =
			index === 0 ? familiesJson : index === 1 ? channelsJson : resolveJson
		app.route({
			method: "GET",
			url: path,
			exposeHeadRoute: false,
			schema: { response: { 200: success, ...responseErrors } },
			handler: (request, reply) => {
				const query = (request as RegionalRequest)[queryKey]
				if (!query || !options.registry) return sendError(reply, 503)
				if (query.kind !== "families" && query.family !== "frs")
					return sendError(reply, 404)
				try {
					const value =
						query.kind === "families"
							? options.registry.listFamilies(query.region)
							: query.kind === "channels"
								? options.registry.listChannels({
										region: query.region,
										family: query.family,
										offset: query.offset,
										limit: query.limit,
									})
								: options.registry.resolveAlias({
										region: query.region,
										family: query.family,
										alias: query.alias,
									})
					return reply
						.header("Cache-Control", "no-store")
						.type("application/json; charset=utf-8")
						.serializer(identity)
						.code(200)
						.send(encodeOutput(value, query))
				} catch (error) {
					if (
						error instanceof WaveKitError &&
						error.code === "REGIONAL_FAMILY_NOT_FOUND"
					)
						return sendError(reply, 404)
					return sendError(reply, 503)
				}
			},
		})
		app.route({
			method: [...deniedMethods],
			url: path,
			schema: { response: responseErrors },
			handler: (_request, reply) => sendError(reply, 405),
		})
	}
}
