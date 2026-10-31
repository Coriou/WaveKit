/**
 * GET /api/aircraft-identity/:kind/:value: which identifiers name the same aircraft, with the
 * evidence and lifetime of each link. Only an ICAO address or a registration resolves to an
 * aircraft; a callsign or flight number returns its links and `icao: null`.
 *
 * @module src/api/routes/aircraft-identity
 */
import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import { z } from "zod"
import type {
	AircraftIdentifier,
	AircraftIdentityResponse,
} from "@wavekit/api-types"
import type { AircraftIdentityManager } from "../../core/aircraft-identity/manager.js"
import { icaoId, regId } from "../../core/aircraft-identity/observe.js"

export interface AircraftIdentityRoutesOptions extends FastifyPluginOptions {
	identity: Pick<AircraftIdentityManager, "resolve">
}

const paramsSchema = z.object({
	kind: z.enum(["icao", "reg", "callsign", "flight"]),
	value: z.string().min(1).max(16),
})

/** The query in the registry's canonical form, or null when the value cannot be one. */
export function canonicalQuery(
	kind: AircraftIdentifier["kind"],
	value: string,
): AircraftIdentifier | null {
	if (kind === "icao") return icaoId(value)
	if (kind === "reg") return regId(value)
	const code = value.trim().toUpperCase()
	return /^[A-Z0-9]{2,8}$/.test(code) ? { kind, value: code } : null
}

const identifierSchema = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["icao", "reg", "callsign", "flight"] },
		value: { type: "string" },
	},
	required: ["kind", "value"],
} as const

const responseSchema = {
	type: "object",
	properties: {
		query: identifierSchema,
		icao: { type: ["string", "null"] },
		resolvedBy: {
			anyOf: [
				{ type: "string", enum: ["self", "observed", "database"] },
				{ type: "null" },
			],
		},
		conflict: { type: "boolean" },
		links: {
			type: "array",
			items: {
				type: "object",
				properties: {
					a: identifierSchema,
					b: identifierSchema,
					evidence: { type: "string", enum: ["observed", "database", "hint"] },
					source: {
						type: "string",
						enum: ["adsb", "vdl2", "acars", "database"],
					},
					firstSeen: { type: "string" },
					lastSeen: { type: "string" },
					expiresAt: { type: "string" },
					count: { type: "integer" },
				},
				required: [
					"a",
					"b",
					"evidence",
					"source",
					"firstSeen",
					"lastSeen",
					"expiresAt",
					"count",
				],
			},
		},
		entityKeys: { type: "array", items: { type: "string" } },
		timestamp: { type: "number" },
	},
	required: [
		"query",
		"icao",
		"resolvedBy",
		"conflict",
		"links",
		"entityKeys",
		"timestamp",
	],
} as const

const errorSchema = {
	type: "object",
	properties: { error: { type: "string" } },
	required: ["error"],
} as const

export async function aircraftIdentityRoutes(
	fastify: FastifyInstance,
	options: AircraftIdentityRoutesOptions,
): Promise<void> {
	const { identity } = options
	fastify.get<{
		Params: { kind: string; value: string }
		Reply: AircraftIdentityResponse | { error: string }
	}>(
		"/api/aircraft-identity/:kind/:value",
		{
			schema: {
				summary: "Identifiers that name the same aircraft, with evidence",
				tags: ["aircraft"],
				params: {
					type: "object",
					properties: {
						kind: {
							type: "string",
							enum: ["icao", "reg", "callsign", "flight"],
						},
						value: { type: "string", minLength: 1, maxLength: 16 },
					},
					required: ["kind", "value"],
				},
				response: { 200: responseSchema, 400: errorSchema },
			},
		},
		async (request, reply) => {
			const params = paramsSchema.safeParse(request.params)
			const query = params.success
				? canonicalQuery(params.data.kind, params.data.value)
				: null
			if (query === null) {
				reply.status(400)
				return { error: "Not a valid identifier of that kind" }
			}
			return identity.resolve(query)
		},
	)
}

export default aircraftIdentityRoutes
