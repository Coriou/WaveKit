import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { serializeSessionCookie } from "./cookies.js"
import type { AccessFlowResult } from "./cookies.js"
import { accessRequestFromHttp } from "./http-request.js"
import type { PairingService } from "./pairing.js"
import type { SessionFlows } from "./session-flows.js"

export interface AccessRouteServices {
	pairing: PairingService
	flows: SessionFlows
}

export interface AccessRouteController {
	/** Rejects even requests admitted by the root hook before their handler starts. */
	stopAdmission(): void
	/** Stops admission and waits for flow completion, including durable persistence. */
	drain(): Promise<void>
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
): AccessRouteController {
	let stopped = false
	let active = 0
	let draining: Promise<void> | undefined
	let drained: (() => void) | undefined
	const controller: AccessRouteController = Object.freeze({
		stopAdmission(): void {
			stopped = true
		},
		drain(): Promise<void> {
			stopped = true
			draining ??=
				active === 0
					? Promise.resolve()
					: new Promise<void>(resolve => {
							drained = resolve
						})
			return draining
		},
	})
	const run = async (
		reply: FastifyReply,
		invoke: () =>
			| AccessFlowResult<unknown>
			| Promise<AccessFlowResult<unknown>>,
	): Promise<FastifyReply> => {
		// No asynchronous gap between this gate and the actual service invocation.
		if (stopped || active >= 512)
			return reply
				.header("Cache-Control", "no-store")
				.code(stopped ? 503 : 429)
				.send({
					code: stopped ? "ACCESS_UNAVAILABLE" : "ACCESS_CAPACITY",
				})
		active++
		try {
			return sendFlow(reply, await invoke())
		} finally {
			// Response close/onResponse cannot release this persistence ownership.
			active--
			if (active === 0) drained?.()
		}
	}
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
	const documented = (summary: string) => ({
		...options,
		schema: { summary, tags: ["access"] },
	})
	app.post(
		"/api/access/pairing-codes",
		documented("Issue a one-time browser pairing code"),
		async (request, reply) =>
			run(reply, () =>
				services.pairing.issue(accessRequestFromHttp(request.raw, "api")),
			),
	)
	app.post(
		"/api/access/pair",
		{
			...options,
			schema: {
				summary: "Exchange a one-time code for a browser session",
				tags: ["access"],
				// Public: the code is the credential, so the document's bearer does not apply.
				security: [],
			},
		},
		async (request, reply) =>
			run(reply, () =>
				services.pairing.redeem(
					accessRequestFromHttp(request.raw, "api"),
					request.body,
				),
			),
	)
	app.get(
		"/api/access/session",
		documented("Read this browser's session"),
		async (request, reply) =>
			run(reply, () =>
				services.flows.status(accessRequestFromHttp(request.raw, "api")),
			),
	)
	app.route({
		method: ["GET", "HEAD"],
		url: "/api/access/devices",
		...documented("List remembered browsers"),
		exposeHeadRoute: false,
		errorHandler(error, request, reply) {
			reply.serializer(JSON.stringify)
			void options.errorHandler(error, request, reply)
		},
		preHandler(
			request: FastifyRequest,
			reply: FastifyReply,
			done: (error?: Error) => void,
		) {
			reply.serializer(JSON.stringify)
			const original = accessRequestFromHttp(request.raw, "api")
			if (
				original.transport !== "http" ||
				original.rawTarget !== "/api/access/devices" ||
				(original.method !== "GET" && original.method !== "HEAD")
			) {
				void reply
					.header("Cache-Control", "no-store")
					.code(400)
					.send({ code: "MALFORMED_REQUEST" })
				return
			}
			done()
		},
		handler(request, reply) {
			reply.serializer(JSON.stringify)
			return run(reply, () =>
				services.flows.devices(accessRequestFromHttp(request.raw, "api")),
			)
		},
	})
	app.post(
		"/api/access/session/refresh",
		documented("Renew this browser's session"),
		async (request, reply) =>
			run(reply, () =>
				services.flows.refresh(accessRequestFromHttp(request.raw, "api")),
			),
	)
	app.post(
		"/api/access/session/logout",
		documented("End this browser's session"),
		async (request, reply) =>
			run(reply, () =>
				services.flows.logout(accessRequestFromHttp(request.raw, "api")),
			),
	)
	app.post(
		"/api/access/devices/label",
		documented("Name a remembered browser"),
		async (request, reply) =>
			run(reply, () =>
				services.flows.label(
					accessRequestFromHttp(request.raw, "api"),
					request.body,
				),
			),
	)
	app.post(
		"/api/access/devices/revoke",
		documented("Revoke a remembered browser"),
		async (request, reply) =>
			run(reply, () =>
				services.flows.revoke(
					accessRequestFromHttp(request.raw, "api"),
					request.body,
				),
			),
	)
	app.post(
		"/api/access/devices/revoke-all",
		documented("Sign out every paired browser"),
		async (request, reply) =>
			run(reply, () =>
				services.flows.revokeAll(accessRequestFromHttp(request.raw, "api")),
			),
	)
	app.route({
		method: ["GET", "HEAD"],
		url: "/api/access/machine/devices",
		...documented("List remembered browsers, with the machine credential"),
		exposeHeadRoute: false,
		errorHandler(error, request, reply) {
			reply.serializer(JSON.stringify)
			void options.errorHandler(error, request, reply)
		},
		preHandler(
			request: FastifyRequest,
			reply: FastifyReply,
			done: (error?: Error) => void,
		) {
			reply.serializer(JSON.stringify)
			const original = accessRequestFromHttp(request.raw, "api")
			if (
				original.transport !== "http" ||
				original.rawTarget !== "/api/access/machine/devices" ||
				(original.method !== "GET" && original.method !== "HEAD")
			) {
				void reply
					.header("Cache-Control", "no-store")
					.code(400)
					.send({ code: "MALFORMED_REQUEST" })
				return
			}
			done()
		},
		handler(request, reply) {
			reply.serializer(JSON.stringify)
			return run(reply, () =>
				services.flows.machineDevices(
					accessRequestFromHttp(request.raw, "api"),
				),
			)
		},
	})
	const machinePost = (
		url:
			| "/api/access/machine/devices/revoke"
			| "/api/access/machine/devices/revoke-all",
		summary: string,
		invoke: (request: FastifyRequest) => Promise<AccessFlowResult<unknown>>,
	): void => {
		app.post(url, documented(summary), async (request, reply) => {
			reply.serializer(JSON.stringify)
			return run(reply, () => invoke(request))
		})
	}
	machinePost(
		"/api/access/machine/devices/revoke",
		"Revoke a remembered browser, with the machine credential",
		request =>
			services.flows.machineRevoke(
				accessRequestFromHttp(request.raw, "api"),
				request.body,
			),
	)
	machinePost(
		"/api/access/machine/devices/revoke-all",
		"Sign out every paired browser, with the machine credential",
		request =>
			services.flows.machineRevokeAll(
				accessRequestFromHttp(request.raw, "api"),
			),
	)
	return controller
}
