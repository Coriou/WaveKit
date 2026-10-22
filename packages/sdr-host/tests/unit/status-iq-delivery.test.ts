import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { expect, it } from "vitest"
import { registerStatusRoutes } from "../../src/api/routes/status.js"
import { SdrHostConfigSchema } from "../../src/config.js"

it("advertises raw IQ delivery in status", async () => {
	const app = Fastify()
	const state = {
		running: false,
		pid: null,
		restartCount: 0,
		lastRestartAt: null,
		lastError: null,
	}
	app.decorate("processManager", {
		getRtlTcpState: () => state,
		getRtlmuxState: () => state,
		getRtlmuxStats: () => null,
		getSampling: () => null,
		getDelivery: () => null,
		getSamplingHistory: () => [],
	} as unknown as FastifyInstance["processManager"])
	app.decorate("preflightResult", {
		warnings: [],
		errors: [],
		dongle: null,
	} as unknown as FastifyInstance["preflightResult"])
	app.decorate("startTime", Date.now())
	app.decorate("receiverId", "test-receiver")
	app.decorate("hostTelemetry", {
		snapshot: () => ({ network: { state: "unavailable" } }),
	} as unknown as FastifyInstance["hostTelemetry"])
	registerStatusRoutes(app, SdrHostConfigSchema.parse({}))
	try {
		const response = await app.inject({ method: "GET", url: "/api/status" })
		expect(response.statusCode).toBe(200)
		expect(
			response.json<{ iqDelivery: { modes: string[] } }>().iqDelivery,
		).toEqual({ modes: ["raw"] })
	} finally {
		await app.close()
	}
})
