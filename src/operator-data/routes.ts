import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import type { OperatorDataMutation } from "@wavekit/api-types"
import { OPERATOR_DATA_LIMITS, uuidSchema } from "@wavekit/api-types"
import type { DeniedAdmission } from "../access/types.js"
import { OperatorDataError, parseMutation } from "./schema.js"
import type { OperatorDataService } from "./service.js"
import {
	toOperatorDataErrorResponse,
	toOperatorDataReadDto,
	toOperatorDataWriteDto,
} from "./transport.js"

export interface OperatorDataRoutesOptions {
	operatorData: OperatorDataService | undefined
	/** Owner reevaluates the original raw request with current API/session/stop policy. */
	authorizeMetadataMutation(
		request: FastifyRequest,
	): DeniedAdmission | undefined
}

function routeMutation(
	request: FastifyRequest,
	type: OperatorDataMutation["type"],
	keys: readonly string[],
	withId: boolean,
): OperatorDataMutation {
	const body: unknown = request.body
	if (typeof body !== "object" || body === null || Array.isArray(body))
		throw new OperatorDataError("OPERATOR_DATA_INVALID")
	if (Object.keys(body).some(key => !keys.includes(key)))
		throw new OperatorDataError("OPERATOR_DATA_INVALID")
	let id: string | undefined
	if (withId) {
		const params: unknown = request.params
		const result = uuidSchema.safeParse(
			typeof params === "object" && params !== null
				? Reflect.get(params, "id")
				: undefined,
		)
		if (!result.success) throw new OperatorDataError("OPERATOR_DATA_INVALID")
		id = result.data
	}
	// Only allowed body keys enter canonical validation; server fields are never copied.
	const input: Record<string, unknown> = { type }
	for (const key of keys)
		if (Object.hasOwn(body, key)) input[key] = Reflect.get(body, key)
	if (withId) input["id"] = id
	return parseMutation(input)
}

/** Unmounted metadata routes. Root read/auth/Origin/CSRF hooks remain owner supplied.
 * The runtime owns the injected service and drains accepted work before transport close.
 */
export const operatorDataRoutes: FastifyPluginAsync<
	OperatorDataRoutesOptions
> = async (app, options) => {
	app.setErrorHandler((error, _request, reply) => {
		let classified: unknown = error
		try {
			if (!(error instanceof OperatorDataError) && error instanceof Error) {
				const code: unknown = Reflect.get(error, "code")
				const statusCode: unknown = Reflect.get(error, "statusCode")
				if (code === "FST_ERR_CTP_BODY_TOO_LARGE")
					classified = new OperatorDataError("OPERATOR_DATA_QUOTA")
				else if (
					typeof statusCode === "number" &&
					statusCode >= 400 &&
					statusCode < 500
				)
					classified = new OperatorDataError("OPERATOR_DATA_INVALID")
			}
		} catch {
			classified = undefined
		}

		const response = toOperatorDataErrorResponse(classified)
		void reply.status(response.statusCode).send(response.body)
	})

	app.get("/api/operator-data", (_request, reply) => {
		if (!options.operatorData)
			throw new OperatorDataError("OPERATOR_DATA_UNAVAILABLE")
		return reply
			.status(200)
			.send(toOperatorDataReadDto(options.operatorData.snapshot()))
	})

	const registerMutation = (
		method: "POST" | "PUT" | "DELETE" | "PATCH",
		url: string,
		type: OperatorDataMutation["type"],
		keys: readonly string[],
		status: 200 | 201 = 200,
		withId = false,
	) => {
		app.route({
			method,
			url,
			bodyLimit: OPERATOR_DATA_LIMITS.requestBytes,
			handler: async (request, reply) => {
				const mutation = routeMutation(request, type, keys, withId)
				const denied = options.authorizeMetadataMutation(request)
				if (denied) {
					for (const [name, value] of Object.entries(denied.headers))
						reply.header(name, value)
					return reply
						.status(denied.status)
						.type("application/json")
						.send(JSON.stringify({ code: denied.code }))
				}
				if (!options.operatorData)
					throw new OperatorDataError("OPERATOR_DATA_UNAVAILABLE")
				// No await between final owner authorization and synchronous admission.
				const accepted = options.operatorData.mutate(mutation)
				const result = await accepted
				return reply.status(status).send(toOperatorDataWriteDto(result))
			},
		})
	}
	registerMutation(
		"POST",
		"/api/operator-data/saved-frequencies",
		"create-saved-frequency",
		["expected", "frequency"],
		201,
	)
	registerMutation(
		"PUT",
		"/api/operator-data/saved-frequencies/:id",
		"replace-saved-frequency",
		["expected", "frequency"],
		200,
		true,
	)
	registerMutation(
		"DELETE",
		"/api/operator-data/saved-frequencies/:id",
		"delete-saved-frequency",
		["expected"],
		200,
		true,
	)
	registerMutation(
		"PATCH",
		"/api/operator-data/preferences",
		"patch-preferences",
		["expected", "set", "reset"],
	)
	registerMutation(
		"POST",
		"/api/operator-data/command-usage",
		"report-command-usage",
		["expected", "command", "savedFrequencyId"],
	)
	registerMutation(
		"DELETE",
		"/api/operator-data/command-usage",
		"reset-command-usage",
		["expected"],
	)
}
