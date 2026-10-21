import Fastify from "fastify"
import { expect, it } from "vitest"
import type { DecoderEfficiencyView } from "@wavekit/api-types"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"

import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"

const placement = {
	decoderId: "dec",
	sourceId: "rtl",
	channelHz: null,
	reach: "raw" as const,
	costCores: 0.1,
	probation: false,
}
const view: DecoderEfficiencyView = {
	budgetCores: 0.5,
	cpuGuardPercent: 90,
	sources: [
		{
			sourceId: "rtl",
			coresInUse: 0.1,
			cpu: { percent: null, limit: 90 },
			drops: "unknown",
			dropBytesPerSecond: null,
			admitted: [placement],
			blocked: [
				{
					...placement,
					decoderId: "blocked",
					detail: "unknown",
					retryAt: "2026-10-21T12:00:00.000Z",
				},
			],
		},
	],
}
it.each([
	"route returns budget, cpu null as null, drops unknown as unknown, ordered admitted and blocked",
	"efficiency route schema keeps every DecoderEfficiencyView field",
])("%s", async () => {
	const app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => view,
		} as unknown as DecoderRoutesOptions["decoderManager"],
		authorizeSettings: () => {
			throw new Error("write authorization must not run")
		},
	})
	try {
		const response = await app.inject("/api/decoders/efficiency")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(view)
	} finally {
		await app.close()
	}
})

it("protected reads use identical admission for decoder inventory and efficiency", async () => {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
	})
	const app = Fastify()
	installAccessHooks(app, {
		sessions,
		policy: new AccessPolicy({
			listenerScheme: "http",
			allowedAuthorities: ["example.test"],
			allowedOrigins: ["http://example.test"],
			sessionCookieName: "wavekit_session",
			machineSecretDigest: digest,
			sessions,
		}),
	})
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => view,
			getAllStatus: () => [],
		} as unknown as DecoderRoutesOptions["decoderManager"],
	})
	const session = await sessions.create()
	if (session.kind !== "created") throw new Error("Missing session")
	try {
		for (const [credentials, expectedStatus] of [
			[{}, 401],
			[{ authorization: "Bearer invalid" }, 401],
			[{ authorization: `Bearer ${token}` }, 200],
			[{ cookie: `wavekit_session=${session.cookieValue}` }, 403],
			[
				{
					cookie: `wavekit_session=${session.cookieValue}`,
					origin: "http://example.test",
				},
				200,
			],
		] as const) {
			const headers = { host: "example.test", ...credentials }
			const inventory = await app.inject({ url: "/api/decoders", headers })
			const efficiency = await app.inject({
				url: "/api/decoders/efficiency",
				headers,
			})
			expect(inventory.statusCode).toBe(expectedStatus)
			expect(efficiency.statusCode).toBe(inventory.statusCode)
			if (efficiency.statusCode === 200) expect(efficiency.json()).toEqual(view)
			else expect(efficiency.json()).toEqual(inventory.json())
		}
	} finally {
		await app.close()
	}
})
