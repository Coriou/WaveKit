import Fastify from "fastify"
import { expect, it } from "vitest"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { SessionStore } from "../../../src/access/sessions.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { registerRouteIndex } from "../../../src/api/routes/route-index.js"
import { decoderSummaryRoutes } from "../../../src/api/routes/decoder-summary.js"

it("requires the same authenticated read admission for the index and summary", async () => {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["synthetic.invalid"],
		allowedOrigins: ["http://synthetic.invalid"],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const app = Fastify()
	installAccessHooks(app, { policy, sessions })
	registerRouteIndex(app)
	await app.register(decoderSummaryRoutes, {
		decoderManager: { getAllStatus: () => [] },
	})
	try {
		for (const url of ["/api", "/api/decoders/summary"]) {
			expect(
				(await app.inject({ url, headers: { host: "synthetic.invalid" } }))
					.statusCode,
			).toBe(401)
			expect(
				(
					await app.inject({
						url,
						headers: {
							host: "synthetic.invalid",
							authorization: `Bearer ${token}`,
						},
					})
				).statusCode,
			).toBe(200)
		}
	} finally {
		await app.close()
	}
})
