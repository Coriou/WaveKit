/**
 * Unmounted band-plan routes. Main registers this plugin.
 * Without authorizeMutation only GET routes exist (legacy mode).
 * Mutation routes re-check authorization immediately before admission.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import { z, type ZodType } from "zod"
import {
	BANDPLANS_ERROR_DEFINITIONS,
	BANDPLANS_LIMITS,
	OPERATOR_PACK_ID,
	bandIdSchema,
	bandPlanMutationSchema,
	expectedTokenSchema,
	importedPackIdSchema,
	importPreviewRequestSchema,
	packIdSchema,
	stackPackIdSchema,
	uuidSchema,
} from "@wavekit/api-types"
import type {
	BandPlanMutation,
	BandPlansErrorCode,
	BandPlansErrorDto,
	ExpectedToken,
} from "@wavekit/api-types"
import type { DeniedAdmission } from "../../access/types.js"
import { BandPlansError } from "../../core/bandplans/contract.js"
import type { BandPlanService } from "../../core/bandplans/contract.js"
import {
	describeZodSchema,
	zodValidationFields,
	type ValidationField,
} from "../validation-errors.js"

export interface BandPlanRoutesOptions {
	service: BandPlanService
	/** Present only in protected mode. Omission registers GET routes alone. */
	authorizeMutation?: (request: FastifyRequest) => DeniedAdmission | undefined
}

const PREVIEW_KEYS = [
	"format",
	"fileName",
	"contentBase64",
	"groupOverrides",
] as const
const COMMIT_KEYS = [
	...PREVIEW_KEYS,
	"expected",
	"previewDigest",
	"name",
	"author",
	"licence",
	"keepColourHints",
	"replacesPackId",
	"addToStack",
	"sourceUrl",
] as const
const URL_PREVIEW_KEYS = ["url", "format", "groupOverrides"] as const
const builtinPresetIdSchema = z.string().regex(/^builtin-[a-z][a-z0-9-]{0,63}$/)
const readablePresetIdSchema = z.union([uuidSchema, builtinPresetIdSchema])

function knownCode(code: unknown): code is BandPlansErrorCode {
	return (
		typeof code === "string" && Object.hasOwn(BANDPLANS_ERROR_DEFINITIONS, code)
	)
}

function toBandPlansErrorResponse(error: unknown): {
	statusCode: number
	body: BandPlansErrorDto & { fields?: ValidationField[] }
} {
	let code: BandPlansErrorCode = "BANDPLANS_UNAVAILABLE"
	let current: ExpectedToken | undefined
	try {
		if (error instanceof BandPlansError && knownCode(error.code)) {
			code = error.code
			if (code === "BANDPLANS_CONFLICT") {
				const token = expectedTokenSchema.safeParse(error.current)
				if (token.success) current = token.data
			}
		}
	} catch {
		code = "BANDPLANS_UNAVAILABLE"
		current = undefined
	}
	const canonical = new BandPlansError(code)
	const fields =
		code === "BANDPLANS_INVALID"
			? ((typeof error === "object" && error !== null
					? invalidFields.get(error)
					: undefined) ?? [
					{
						field: "body",
						expected: "a band-plan request as documented in docs/API.md",
					},
				])
			: undefined
	return {
		statusCode: canonical.statusCode,
		body: {
			error: "BandPlansError",
			code,
			message: canonical.message,
			...(current ? { details: { current } } : {}),
			...(fields !== undefined && fields.length > 0 ? { fields } : {}),
		},
	}
}

function isImportRequest(request: FastifyRequest): boolean {
	const path = request.url.split("?", 1)[0] ?? ""
	return (
		path === "/api/bandplans/imports" ||
		path === "/api/bandplans/imports/preview" ||
		path === "/api/bandplans/imports/preview-url"
	)
}

/**
 * The fields a BANDPLANS_INVALID names, kept beside the error: the canonical error class
 * carries only its code, and the 400 adds `fields` (schema names and static text).
 */
const invalidFields = new WeakMap<object, ValidationField[]>()

function invalidWith(fields: ValidationField[]): BandPlansError {
	const error = new BandPlansError("BANDPLANS_INVALID")
	invalidFields.set(error, fields)
	return error
}

function readParam(request: FastifyRequest, name: string): string {
	const params: unknown = request.params
	const value: unknown =
		typeof params === "object" && params !== null
			? Reflect.get(params, name)
			: undefined
	if (typeof value !== "string" || value.length === 0)
		throw invalidWith([{ field: name, expected: "non-empty string" }])
	return value
}

function parseWith<T>(schema: ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value)
	if (!result.success)
		throw invalidWith(zodValidationFields(result.error, schema))
	return result.data
}

/** A path parameter parsed with its schema; a 400 names the parameter. */
function parseParam<T>(
	schema: ZodType<T>,
	request: FastifyRequest,
	name: string,
): T {
	const result = schema.safeParse(readParam(request, name))
	if (!result.success)
		throw invalidWith([
			{ field: name, expected: describeZodSchema(schema, name) },
		])
	return result.data
}

function pickBody(
	body: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	const only = [
		{
			field: "body",
			expected: `a JSON object with only the fields ${keys.join(", ")}`,
		},
	]
	if (typeof body !== "object" || body === null || Array.isArray(body))
		throw invalidWith(only)
	if (Object.keys(body).some(key => !keys.includes(key)))
		throw invalidWith(only)
	const input: Record<string, unknown> = {}
	for (const key of keys)
		if (Object.hasOwn(body, key)) input[key] = Reflect.get(body, key)
	return input
}

function parseMutation(input: Record<string, unknown>): BandPlanMutation {
	if (!Object.hasOwn(input, "expected") || input["expected"] === undefined)
		throw new BandPlansError("BANDPLANS_PRECONDITION_REQUIRED")
	return parseWith(bandPlanMutationSchema, input)
}

function sendDenial(reply: FastifyReply, denied: DeniedAdmission) {
	for (const [name, value] of Object.entries(denied.headers))
		reply.header(name, value)
	return reply
		.status(denied.status)
		.type("application/json")
		.send(JSON.stringify({ code: denied.code }))
}

function guardBuiltinPackDelete(request: FastifyRequest): void {
	if (readParam(request, "packId").startsWith("builtin-"))
		throw new BandPlansError("BANDPLANS_READ_ONLY")
}

function guardOperatorEditPack(request: FastifyRequest): void {
	if (readParam(request, "packId") === OPERATOR_PACK_ID)
		throw new BandPlansError("BANDPLANS_INVALID")
}

function guardBuiltinPreset(request: FastifyRequest): void {
	if (readParam(request, "presetId").startsWith("builtin-"))
		throw new BandPlansError("BANDPLANS_READ_ONLY")
}

function bindPackAndBand(
	request: FastifyRequest,
	input: Record<string, unknown>,
): void {
	input["packId"] = parseParam(stackPackIdSchema, request, "packId")
	input["bandId"] = parseParam(bandIdSchema, request, "bandId")
}

function bindStackPack(
	request: FastifyRequest,
	input: Record<string, unknown>,
): void {
	input["packId"] = parseParam(stackPackIdSchema, request, "packId")
}

function bindImportedPack(
	request: FastifyRequest,
	input: Record<string, unknown>,
): void {
	input["packId"] = parseParam(importedPackIdSchema, request, "packId")
}

function bindOperatorBand(
	request: FastifyRequest,
	input: Record<string, unknown>,
): void {
	input["bandId"] = parseParam(bandIdSchema, request, "bandId")
}

function bindOperatorPreset(
	request: FastifyRequest,
	input: Record<string, unknown>,
): void {
	input["presetId"] = parseParam(uuidSchema, request, "presetId")
}

type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE"
interface MutationRoute {
	kind: "mutation"
	method: WriteMethod
	url: string
	type: BandPlanMutation["type"]
	keys: readonly string[]
	status: 200 | 201
	limit: number
	guard?: (request: FastifyRequest) => void
	bind?: (request: FastifyRequest, input: Record<string, unknown>) => void
}
interface PreviewRoute {
	kind: "preview"
}
type WriteRoute = MutationRoute | PreviewRoute

function mutation(
	method: WriteMethod,
	url: string,
	type: BandPlanMutation["type"],
	keys: readonly string[],
	status: 200 | 201,
	extra?: {
		limit?: number
		guard?: (request: FastifyRequest) => void
		bind?: (request: FastifyRequest, input: Record<string, unknown>) => void
	},
): MutationRoute {
	return {
		kind: "mutation",
		method,
		url,
		type,
		keys,
		status,
		limit: extra?.limit ?? BANDPLANS_LIMITS.requestBytes,
		...(extra?.guard ? { guard: extra.guard } : {}),
		...(extra?.bind ? { bind: extra.bind } : {}),
	}
}

const writeRoutes: readonly WriteRoute[] = [
	mutation(
		"PUT",
		"/api/bandplans/stack",
		"set-stack",
		["expected", "entries"],
		200,
	),
	mutation("DELETE", "/api/bandplans/stack", "reset-stack", ["expected"], 200),
	mutation(
		"PATCH",
		"/api/bandplans/packs/:packId/bands/:bandId/edit",
		"patch-band-edit",
		["expected", "set", "reset"],
		200,
		{ guard: guardOperatorEditPack, bind: bindPackAndBand },
	),
	mutation(
		"DELETE",
		"/api/bandplans/packs/:packId/bands/:bandId/edit",
		"reset-band-edits",
		["expected"],
		200,
		{ guard: guardOperatorEditPack, bind: bindPackAndBand },
	),
	mutation(
		"DELETE",
		"/api/bandplans/packs/:packId/edits",
		"reset-pack-edits",
		["expected"],
		200,
		{ guard: guardOperatorEditPack, bind: bindStackPack },
	),
	mutation(
		"DELETE",
		"/api/bandplans/packs/:packId",
		"delete-pack",
		["expected"],
		200,
		{ guard: guardBuiltinPackDelete, bind: bindImportedPack },
	),
	mutation(
		"POST",
		"/api/bandplans/operator-bands",
		"create-operator-band",
		["expected", "band"],
		201,
	),
	mutation(
		"PUT",
		"/api/bandplans/operator-bands/:bandId",
		"replace-operator-band",
		["expected", "band"],
		200,
		{ bind: bindOperatorBand },
	),
	mutation(
		"DELETE",
		"/api/bandplans/operator-bands/:bandId",
		"delete-operator-band",
		["expected"],
		200,
		{ bind: bindOperatorBand },
	),
	{ kind: "preview" },
	mutation(
		"POST",
		"/api/bandplans/imports",
		"commit-import",
		COMMIT_KEYS,
		201,
		{ limit: BANDPLANS_LIMITS.importRequestBytes },
	),
	mutation(
		"POST",
		"/api/bandplans/presets",
		"create-preset",
		["expected", "preset"],
		201,
	),
	mutation(
		"PUT",
		"/api/bandplans/presets/:presetId",
		"replace-preset",
		["expected", "preset"],
		200,
		{ guard: guardBuiltinPreset, bind: bindOperatorPreset },
	),
	mutation(
		"DELETE",
		"/api/bandplans/presets/:presetId",
		"delete-preset",
		["expected"],
		200,
		{ guard: guardBuiltinPreset, bind: bindOperatorPreset },
	),
]

/** Unmounted plugin. The caller owns the service and drains it before close. */
export const bandPlanRoutes: FastifyPluginAsync<BandPlanRoutesOptions> = async (
	app,
	options,
) => {
	const service = options.service
	const authorizeMutation = options.authorizeMutation

	app.setErrorHandler((error, request, reply) => {
		let classified: unknown = error
		try {
			if (!(error instanceof BandPlansError) && error instanceof Error) {
				const code: unknown = Reflect.get(error, "code")
				const statusCode: unknown = Reflect.get(error, "statusCode")
				if (code === "FST_ERR_CTP_BODY_TOO_LARGE")
					classified = new BandPlansError(
						isImportRequest(request)
							? "BANDPLANS_IMPORT_TOO_LARGE"
							: "BANDPLANS_QUOTA",
					)
				else if (
					typeof statusCode === "number" &&
					statusCode >= 400 &&
					statusCode < 500
				)
					classified = new BandPlansError("BANDPLANS_INVALID")
			}
		} catch {
			classified = undefined
		}
		const response = toBandPlansErrorResponse(classified)
		void reply.status(response.statusCode).send(response.body)
	})

	app.get("/api/bandplans", async (_request, reply) => {
		return reply.status(200).send(service.view())
	})
	app.get("/api/bandplans/resolved", async (_request, reply) => {
		return reply.status(200).send(service.resolved())
	})
	app.get("/api/bandplans/packs/:packId", async (request, reply) => {
		const packId = parseParam(packIdSchema, request, "packId")
		return reply.status(200).send(service.pack(packId))
	})
	app.get("/api/bandplans/presets", async (_request, reply) => {
		return reply.status(200).send(service.presets())
	})
	app.get("/api/bandplans/presets/:presetId/job", async (request, reply) => {
		const presetId = parseParam(readablePresetIdSchema, request, "presetId")
		return reply.status(200).send(service.presetJob(presetId))
	})

	if (!authorizeMutation) return

	const admit = (request: FastifyRequest, reply: FastifyReply) => {
		const denied = authorizeMutation(request)
		if (!denied) return undefined
		return sendDenial(reply, denied)
	}

	for (const route of writeRoutes) {
		if (route.kind === "preview") {
			app.route({
				method: "POST",
				url: "/api/bandplans/imports/preview",
				bodyLimit: BANDPLANS_LIMITS.importRequestBytes,
				handler: async (request, reply) => {
					const parsed = parseWith(
						importPreviewRequestSchema,
						pickBody(request.body, PREVIEW_KEYS),
					)
					const denial = admit(request, reply)
					if (denial) return denial
					return reply.status(200).send(service.previewImport(parsed))
				},
			})
			continue
		}
		app.route({
			method: route.method,
			url: route.url,
			bodyLimit: route.limit,
			handler: async (request, reply) => {
				route.guard?.(request)
				const input = pickBody(request.body, route.keys)
				input["type"] = route.type
				route.bind?.(request, input)
				if (route.type === "patch-band-edit") {
					if (!Object.hasOwn(input, "set")) input["set"] = null
					if (!Object.hasOwn(input, "reset")) input["reset"] = []
				}
				const mutation = parseMutation(input)
				const denial = admit(request, reply)
				if (denial) return denial
				const accepted = service.mutate(mutation)
				const result = await accepted
				return reply.status(route.status).send({
					view: result.view,
					createdId: result.createdId,
				})
			},
		})
	}

	if (typeof service.previewImportUrl === "function")
		app.route({
			method: "POST",
			url: "/api/bandplans/imports/preview-url",
			bodyLimit: BANDPLANS_LIMITS.requestBytes,
			handler: async (request, reply) => {
				const input = pickBody(request.body, URL_PREVIEW_KEYS)
				const denial = admit(request, reply)
				if (denial) return denial
				if (!service.previewImportUrl)
					throw new BandPlansError("BANDPLANS_URL_IMPORT_DISABLED")
				return reply.status(200).send(await service.previewImportUrl(input))
			},
		})
	if (typeof service.checkImportUpdate === "function")
		app.route({
			method: "POST",
			url: "/api/bandplans/packs/:packId/check-update",
			bodyLimit: BANDPLANS_LIMITS.requestBytes,
			handler: async (request, reply) => {
				const packId = parseParam(packIdSchema, request, "packId")
				const denial = admit(request, reply)
				if (denial) return denial
				if (!service.checkImportUpdate)
					throw new BandPlansError("BANDPLANS_URL_IMPORT_DISABLED")
				return reply.status(200).send(await service.checkImportUpdate(packId))
			},
		})
}
