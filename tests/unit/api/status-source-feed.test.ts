/**
 * Legacy GET /api/status: each source entry keeps its `feed` (pause / resume state); the
 * response schema must not strip it.
 */
import { describe, expect, it } from "vitest"
import Fastify from "fastify"
import { healthRoutes } from "../../../src/api/routes/health.js"

describe("GET /api/status source feed", () => {
	it.each([
		{ state: "paused", since: "2026-10-31T09:00:00.000Z" },
		{
			state: "error",
			since: "2026-10-31T09:00:00.000Z",
			error: "The receiver could not be reached; resume again to retry",
		},
	])("carries the feed of a source: $state", async feed => {
		const app = Fastify()
		await app.register(healthRoutes, {
			decoderManager: {
				getAllStatus: () => [],
				getAllHealth: () => new Map(),
			},
			sourceManager: {
				getAllStatus: () => [
					{
						id: "rtl",
						connected: false,
						bytesReceived: 0,
						dataRate: 0,
						reconnectAttempts: 0,
						feed,
					},
				],
			},
			audioOutput: { getConnectedClients: () => 0, getPort: () => 8080 },
		} as never)
		const response = await app.inject("/api/status")
		await app.close()
		expect(response.statusCode).toBe(200)
		expect(response.json().sources[0].feed).toEqual(feed)
	})
})
