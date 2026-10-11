import type { FastifyPluginAsync } from "fastify"
import { accessRequestFromHttp } from "../../access/http-request.js"
import { encodeAccessBootstrap } from "../../access/public-bootstrap.js"
import type { AccessPolicy } from "../../access/policy.js"
import type { FastifyAccessController } from "../../access/fastify-adapter.js"

export interface AccessBootstrapRoutesOptions {
	policy: AccessPolicy
	controller: FastifyAccessController
	/** Synchronous configured projection source; null/invalid/throw means unavailable. */
	provideBootstrap: () => unknown
}

/** Composition must mount this together with the root hook's explicit opt-in. */
export const accessBootstrapRoutes: FastifyPluginAsync<
	AccessBootstrapRoutesOptions
> = async (app, options) => {
	// Override inherited/global mappings; error causes and serializer internals stay private.
	app.setErrorHandler((_error, _request, reply) =>
		reply
			.serializer(value => JSON.stringify(value))
			.code(503)
			.send({ code: "ACCESS_UNAVAILABLE" }),
	)
	app.route({
		method: ["GET", "HEAD"],
		url: "/api/access/bootstrap",
		exposeHeadRoute: false,
		handler: (request, reply) => {
			reply.serializer(value => JSON.stringify(value))
			const admission = options.policy.validatePublicBootstrapRequest(
				accessRequestFromHttp(request.raw, "api"),
			)
			for (const [name, value] of Object.entries(admission.headers))
				reply.header(name, value)
			if (options.controller.admissionStopped)
				return reply.code(503).send({ code: "ACCESS_UNAVAILABLE" })
			if (admission.kind === "deny")
				return reply.code(admission.status).send({ code: admission.code })
			try {
				const body = encodeAccessBootstrap(options.provideBootstrap())
				// A provider/getter can synchronously seal admission; never publish after it.
				if (options.controller.admissionStopped)
					return reply.code(503).send({ code: "ACCESS_UNAVAILABLE" })
				return reply.type("application/json").send(body)
			} catch {
				return reply.code(503).send({ code: "ACCESS_UNAVAILABLE" })
			}
		},
	})
}
