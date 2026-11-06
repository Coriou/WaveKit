/**
 * GET /api/enums: the accepted values of the closed lists an agent needs, in one call. Built
 * once from the lists the routes validate against, so it cannot drift from them.
 */
import type { FastifyInstance } from "fastify"
import {
	API_ENUMS_PATH,
	DECODER_INPUT_STATES,
	DECODER_RECEPTION_HINTS,
	DECODER_VERDICT_CODES,
	RECORDING_INVENTORY_KINDS,
	SCANNER_PASSIVE_REASONS,
	SCANNER_RECORDER_DECISIONS,
	SOURCE_DEVICE_FACTS,
	SOURCE_VERDICT_CODES,
	TUNER_CHANGE_ACTORS,
	TUNER_CHANGE_FIELDS,
	TUNER_CHANGE_REASONS,
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
		recorderDecisions: SCANNER_RECORDER_DECISIONS,
		passiveReasons: SCANNER_PASSIVE_REASONS,
	},
	activity: {
		kinds: ACTIVITY_QUERY_KINDS,
		categories: ACTIVITY_QUERY_CATEGORIES,
	},
	tuner: {
		gainModes,
		directSamplingModes,
		controlModes: tunerConfigUpdateSchema.properties.controlMode.enum,
		changeActors: TUNER_CHANGE_ACTORS,
		changeReasons: TUNER_CHANGE_REASONS,
		changeFields: TUNER_CHANGE_FIELDS,
	},
	sources: {
		verdictCodes: SOURCE_VERDICT_CODES,
		deviceFacts: SOURCE_DEVICE_FACTS,
	},
	decoders: {
		verdictCodes: DECODER_VERDICT_CODES,
		receptionHints: DECODER_RECEPTION_HINTS,
		inputStates: DECODER_INPUT_STATES,
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
