import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import {
	jobHitsResponseSchema,
	scanJobSpecSchema,
} from "../../../src/api/routes/scanner-schemas.js"

function hit(lastDurationMs: number | null) {
	return {
		jobId: "j_1",
		discoveryId: "d_1",
		hits: 1,
		firstHitAt: "2026-10-13T12:00:00.000Z",
		lastHitAt: "2026-10-13T12:00:05.000Z",
		firstSeenInJob: true,
		lastDurationMs,
	}
}

describe("WG6 scanner schemas", () => {
	let app: FastifyInstance
	afterEach(async () => {
		await app.close()
	})

	it("job spec accepts boolean skipDecodedElsewhere and rejects a non-coercible value", async () => {
		app = Fastify({ logger: false })
		app.post("/spec", { schema: { body: scanJobSpecSchema } }, req => ({
			body: req.body,
		}))
		await app.ready()
		const base = { mode: "sweep" }
		const ok = await app.inject({
			method: "POST",
			url: "/spec",
			payload: { ...base, skipDecodedElsewhere: true },
		})
		expect(ok.statusCode).toBe(200)
		expect(ok.json().body.skipDecodedElsewhere).toBe(true)
		// Fastify's default ajv coerces "true" to a boolean, so use an object.
		const bad = await app.inject({
			method: "POST",
			url: "/spec",
			payload: { ...base, skipDecodedElsewhere: { x: 1 } },
		})
		expect(bad.statusCode).toBe(400)
	})

	it("hits response keeps lastDurationMs as a number or null", async () => {
		const jobHits = vi.fn(() => ({
			jobId: "j_1",
			stats: { discoveries: 1, hits: 1, newDiscoveries: 0, truncated: false },
			hits: [hit(1235), hit(null)],
		}))
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: { jobHits } as unknown as ScannerRouteService,
		})
		const res = await app.inject({ url: "/api/scanner/jobs/j_1/hits" })
		expect(res.statusCode).toBe(200)
		expect(
			res
				.json()
				.hits.map((x: { lastDurationMs: number | null }) => x.lastDurationMs),
		).toEqual([1235, null])
		expect(jobHitsResponseSchema.properties.hits.items.required).not.toContain(
			"lastDurationMs",
		)
	})
})
