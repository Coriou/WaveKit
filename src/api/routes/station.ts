import { z } from "zod"
import { StationConfigSchema } from "../../config.js"
import { BAND_REGIONS } from "../../decoders/band-region.js"
import { WaveKitError } from "../../utils/errors.js"
import { STATION_WRITE_REQUIRES_ACCESS } from "../../core/station/contract.js"
import { StationUpdateError } from "../../core/station/errors.js"
import type { DeniedAdmission } from "../../access/types.js"
import type { StationService } from "../../core/station/contract.js"
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify"
import {
	STATION_FIELDS,
	type StationErrorBody,
	type StationField,
	type StationIdentity,
	type StationUpdate,
} from "@wavekit/api-types"
import { describeZodSchema } from "../validation-errors.js"

const provenance = z.enum(["default", "yaml", "env", "ui"])
const stringField = (value: z.ZodString) =>
	z.object({ value: value.nullable(), provenance }).strict()
const numberField = (value: z.ZodNumber) =>
	z.object({ value: value.nullable(), provenance }).strict()
const shape = StationConfigSchema.shape
const stationSchema = z
	.object({
		name: stringField(shape.name.unwrap()),
		lat: numberField(shape.lat.unwrap()),
		lon: numberField(shape.lon.unwrap()),
		altM: numberField(shape.altM.unwrap()),
		callsign: stringField(shape.callsign.unwrap()),
		country: z
			.object({ value: shape.country.unwrap().nullable(), provenance })
			.strict(),
		effectiveCountry: shape.country.unwrap().nullable(),
		region: z.enum(BAND_REGIONS),
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
		writable: z.boolean().optional(),
	})
	.strict()
	.refine(value => value.effectiveCountry === value.country.value)

export interface StationRoutesOptions {
	station: StationIdentity
	/** Live source for GET/HEAD and the PATCH writer. */
	service?: StationService
	/** Present only in protected mode. */
	authorizeMutation?: (request: FastifyRequest) => DeniedAdmission | undefined
	/** Defaults to STATION_WRITE_REQUIRES_ACCESS. */
	writeRequiresAccess?: boolean
}

const PATCH_BODY_LIMIT = 4096
const IF_MATCH_EXPECTED =
	'Invalid If-Match header: expected a station revision, a non-negative integer (quoted "7" or bare 7)'
const IF_MATCH = /^(?:"(\d{1,19})"|(\d{1,19}))$/

function sendDenial(reply: FastifyReply, denied: DeniedAdmission) {
	for (const [name, value] of Object.entries(denied.headers))
		reply.header(name, value)
	return reply
		.status(denied.status)
		.type("application/json")
		.send(JSON.stringify({ code: denied.code }))
}

function sendError(
	reply: FastifyReply,
	status: number,
	body: StationErrorBody,
) {
	return reply
		.status(status)
		.header("Cache-Control", "no-store")
		.type("application/json")
		.send(JSON.stringify(body))
}

const invalid = (message: string): StationErrorBody => ({
	error: "Bad Request",
	code: "STATION_UPDATE_INVALID",
	message,
})

/** What each station field accepts, from the config schema (static text). */
const STATION_EXPECTED: Readonly<Record<StationField, string>> = Object.freeze(
	Object.fromEntries(
		STATION_FIELDS.map(field => [
			field,
			`${describeZodSchema(StationConfigSchema.shape[field], field)} or null to clear`,
		]),
	) as Record<StationField, string>,
)

const OBJECT_EXPECTED = `a JSON object with one or more of ${STATION_FIELDS.join(", ")}`

/**
 * A 400 station refusal in static text. Station 400s keep `fields` as the list of field
 * names (the web settings form marks those); the message states what each accepts. A
 * refusal without named fields (not an object, unknown or no keys) never repeats the core
 * message, which lists the client's unknown keys.
 */
function stationInvalid(error: StationUpdateError): StationErrorBody {
	const named = error.fields ?? []
	if (named.length === 0)
		return invalid(`Invalid request body: expected ${OBJECT_EXPECTED}`)
	// With named fields the core message is static (field names and the lat/lon rule).
	return {
		...invalid(
			`${error.message}; expected ${named.map(f => `${f}: ${STATION_EXPECTED[f]}`).join("; ")}`,
		),
		fields: [...named],
	}
}

/** Station snapshot; PATCH exists only when a service is given and the access rule allows it. */
export const stationRoutes: FastifyPluginAsync<StationRoutesOptions> = async (
	app,
	options,
) => {
	const { service } = options
	const parsed = stationSchema.safeParse(options.station)
	if (!parsed.success)
		throw new WaveKitError("Invalid station identity", "STATION_INVALID")
	const staticBody = JSON.stringify(parsed.data)
	app.route({
		method: ["GET", "HEAD"],
		url: "/api/station",
		handler: async (request, reply) => {
			const body = service ? JSON.stringify(service.identity()) : staticBody
			reply
				.header("Cache-Control", "no-store")
				.type("application/json")
				.header("Content-Length", Buffer.byteLength(body))
			return reply.send(request.method === "HEAD" ? undefined : body)
		},
	})

	const authorize = options.authorizeMutation
	const requiresAccess =
		options.writeRequiresAccess ?? STATION_WRITE_REQUIRES_ACCESS
	if (!service || (!authorize && requiresAccess)) return
	app.route({
		method: "PATCH",
		url: "/api/station",
		bodyLimit: PATCH_BODY_LIMIT,
		// onRequest runs before body parsing, so denial precedes any parser error.
		onRequest: (request, reply, done) => {
			const denied = authorize?.(request)
			if (denied) {
				void sendDenial(reply, denied)
				return
			}
			done()
		},
		// Route-local: parser failures (bad JSON, too large, wrong content type) become 400.
		errorHandler: (error, request, reply) => {
			const code = (error as { code?: unknown }).code
			if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) {
				void sendError(
					reply,
					400,
					invalid(
						code === "FST_ERR_CTP_BODY_TOO_LARGE"
							? `Invalid request body: at most ${PATCH_BODY_LIMIT} bytes of ${OBJECT_EXPECTED}`
							: code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
								? `Invalid request body: Content-Type must be application/json, ${OBJECT_EXPECTED}`
								: `Invalid request body: expected ${OBJECT_EXPECTED}`,
					),
				)
				return
			}
			request.log.error({ err: error }, "station update failed")
			void reply
				.status(500)
				.header("Cache-Control", "no-store")
				.type("application/json")
				.send(
					JSON.stringify({
						error: "Internal Server Error",
						message: "Station update failed",
					}),
				)
		},
		handler: async (request, reply) => {
			let ifMatch: number | undefined
			const header = request.headers["if-match"]
			if (header !== undefined) {
				const m =
					typeof header === "string" ? IF_MATCH.exec(header.trim()) : null
				const digits = m?.[1] ?? m?.[2]
				if (digits === undefined)
					return sendError(reply, 400, invalid(IF_MATCH_EXPECTED))
				ifMatch = Number(digits)
				if (!Number.isSafeInteger(ifMatch))
					return sendError(reply, 400, invalid(IF_MATCH_EXPECTED))
			}
			const body: unknown = request.body
			if (typeof body !== "object" || body === null || Array.isArray(body))
				return sendError(
					reply,
					400,
					invalid(`Invalid request body: expected ${OBJECT_EXPECTED}`),
				)
			try {
				const result = await service.update(
					body as StationUpdate,
					ifMatch === undefined ? undefined : { ifMatch },
				)
				return reply
					.status(200)
					.header("Cache-Control", "no-store")
					.type("application/json")
					.send(JSON.stringify(result))
			} catch (error) {
				if (error instanceof StationUpdateError)
					return sendError(
						reply,
						error.statusCode,
						error.statusCode === 400 ? stationInvalid(error) : error.toBody(),
					)
				request.log.error({ err: error }, "station update failed")
				return reply
					.status(500)
					.header("Cache-Control", "no-store")
					.type("application/json")
					.send(
						JSON.stringify({
							error: "Internal Server Error",
							message: "Station update failed",
						}),
					)
			}
		},
	})
}
