import type { FastifyInstance, FastifyReply } from "fastify"
import { serializeSessionCookie } from "./cookies.js"
import type { AccessFlowResult } from "./cookies.js"
import { accessRequestFromHttp } from "./http-request.js"
import type { PairingService } from "./pairing.js"
import type { SessionFlows } from "./session-flows.js"

export interface AccessRouteServices {
	pairing: PairingService
	flows: SessionFlows
}

function sendFlow<T>(
	reply: FastifyReply,
	result: AccessFlowResult<T>,
): FastifyReply {
	for (const [name, value] of Object.entries(result.headers))
		reply.header(name, value)
	if (result.kind === "success" && result.cookie)
		reply.header("Set-Cookie", serializeSessionCookie(result.cookie))
	return reply.code(result.status).send(result.body)
}

/** Register after root access hooks. No prefix exemption; only pairing has its narrow boundary. */
export function registerAccessRoutes(
	app: FastifyInstance,
	services: AccessRouteServices,
): void {
	const options = {
		bodyLimit: 1024,
		errorHandler(
			error: Error & { statusCode?: number },
			_request: unknown,
			reply: FastifyReply,
		) {
			const status =
				error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 503
			return reply
				.header("Cache-Control", "no-store")
				.code(status)
				.send({
					code:
						status === 413
							? "PAYLOAD_TOO_LARGE"
							: status === 400
								? "MALFORMED_REQUEST"
								: "ACCESS_UNAVAILABLE",
				})
		},
	}
	app.post("/api/access/pairing-codes", options, async (request, reply) =>
		sendFlow(
			reply,
			services.pairing.issue(accessRequestFromHttp(request.raw, "api")),
		),
	)
	app.post("/api/access/pair", options, async (request, reply) =>
		sendFlow(
			reply,
			await services.pairing.redeem(
				accessRequestFromHttp(request.raw, "api"),
				request.body,
			),
		),
	)
	app.get("/api/access/session", options, async (request, reply) =>
		sendFlow(
			reply,
			services.flows.status(accessRequestFromHttp(request.raw, "api")),
		),
	)
	app.post("/api/access/session/refresh", options, async (request, reply) =>
		sendFlow(
			reply,
			await services.flows.refresh(accessRequestFromHttp(request.raw, "api")),
		),
	)
	app.post("/api/access/session/logout", options, async (request, reply) =>
		sendFlow(
			reply,
			await services.flows.logout(accessRequestFromHttp(request.raw, "api")),
		),
	)
	app.post("/api/access/devices/revoke", options, async (request, reply) =>
		sendFlow(
			reply,
			await services.flows.revoke(
				accessRequestFromHttp(request.raw, "api"),
				request.body,
			),
		),
	)
	app.post("/api/access/devices/revoke-all", options, async (request, reply) =>
		sendFlow(
			reply,
			await services.flows.revokeAll(accessRequestFromHttp(request.raw, "api")),
		),
	)
}
