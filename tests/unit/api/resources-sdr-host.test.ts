import Fastify from "fastify"
import { describe, expect, it } from "vitest"
import type { SdrHostStatus } from "@wavekit/api-types"
import { resourceRoutes } from "../../../src/api/routes/resources.js"
import type { ResourceAggregator } from "../../../src/core/resource-aggregator.js"

function status(version: string | null): SdrHostStatus {
	return {
		available: true,
		sourceId: "local-iq",
		apiUrl: "http://localhost:8080",
		version,
		uptime: 5,
		rtlTcp: null,
		rtlmux: null,
		dongle: null,
		warnings: [],
		errors: [],
		lastFetchedAt: null,
		fetchError: null,
	}
}

describe("SDR host status route version (WG4 5.5)", () => {
	it.each(["1.0.0", null])("serializes version %j", async version => {
		const aggregator = {
			getSdrHostStatuses: () => [status(version)],
		} as unknown as ResourceAggregator
		const app = Fastify()
		try {
			await app.register(resourceRoutes, { resourceAggregator: aggregator })
			const res = await app.inject({
				method: "GET",
				url: "/api/resources/sdr-hosts",
			})
			expect(res.statusCode).toBe(200)
			expect(res.json()[0].version).toBe(version)
		} finally {
			await app.close()
		}
	})
})
