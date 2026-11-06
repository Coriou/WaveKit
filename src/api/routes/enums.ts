/**
 * GET /api/enums: the accepted values of the closed lists an agent needs, in one call. Built
 * once from the lists the routes validate against, so it cannot drift from them.
 */
import type { FastifyInstance } from "fastify"
import {
	API_ENUMS_PATH,
	RECORDING_INVENTORY_KINDS,
	type ApiEnums,
} from "@wavekit/api-types"
import {
	ACTIVITY_QUERY_CATEGORIES,
	ACTIVITY_QUERY_KINDS,
} from "../../core/activity/query/validate.js"
import {
	confidenceEnum,
	identityKindEnum,
	jobListQuerySchema,
	protocolEnum,
	scanJobSpecSchema,
	discoveryQuerySchema,
} from "./scanner-schemas.js"
import {
	directSamplingModes,
	gainModes,
	tunerConfigUpdateSchema,
} from "./tuner.js"

const { mode, kind, sensitivity } = scanJobSpecSchema.properties

export const API_ENUMS: ApiEnums = {
	scanner: {
		protocols: protocolEnum,
		identityKinds: identityKindEnum,
		confidences: confidenceEnum,
		jobModes: mode.enum,
		jobKinds: kind.enum,
		sensitivities: sensitivity.enum,
		discoveryViews: discoveryQuerySchema.properties.view.enum,
		jobViews: jobListQuerySchema.properties.view.enum,
	},
	activity: {
		kinds: ACTIVITY_QUERY_KINDS,
		categories: ACTIVITY_QUERY_CATEGORIES,
	},
	tuner: {
		gainModes,
		directSamplingModes,
		controlModes: tunerConfigUpdateSchema.properties.controlMode.enum,
	},
	recordings: { kinds: RECORDING_INVENTORY_KINDS },
}

/** Each group's lists with their values, so the OpenAPI document states them too. */
function groupSchema(group: Readonly<Record<string, readonly string[]>>) {
	return {
		type: "object",
		properties: Object.fromEntries(
			Object.entries(group).map(([name, values]) => [
				name,
				{ type: "array", items: { type: "string", enum: [...values] } },
			]),
		),
	}
}

export async function enumRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.get(
		API_ENUMS_PATH,
		{
			schema: {
				summary: "Accepted values of the closed lists (static)",
				tags: ["system"],
				response: {
					200: {
						type: "object",
						properties: Object.fromEntries(
							Object.entries(API_ENUMS).map(([name, group]) => [
								name,
								groupSchema(group),
							]),
						),
					},
				},
			},
		},
		async () => API_ENUMS,
	)
}
