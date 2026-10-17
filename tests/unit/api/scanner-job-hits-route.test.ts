import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScanJobHitsResponse } from "@wavekit/api-types"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { ScannerApiError } from "../../../src/core/scanner/errors.js"

const BODY: ScanJobHitsResponse = {
	jobId: "j_1",
	stats: { discoveries: 1, hits: 3, newDiscoveries: 1, truncated: false },
	hits: [
		{
			jobId: "j_1",
			discoveryId: "d_1",
			hits: 3,
			firstHitAt: "2026-10-13T12:00:00.000Z",
			lastHitAt: "2026-10-13T12:00:05.000Z",
			firstSeenInJob: true,
			lastDurationMs: null,
		},
	],
}

describe("GET /api/scanner/jobs/:id/hits (WG2 req 13.3)", () => {
	let app: FastifyInstance
	const jobHits = vi.fn((id: string, _limit: number) => {
		if (id !== "j_1")
			throw new ScannerApiError(
				`Job ${id} not found`,
				"SCANNER_JOB_NOT_FOUND",
				404,
			)
		return BODY
	})

	async function build(): Promise<void> {
		jobHits.mockClear()
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: { jobHits } as unknown as ScannerRouteService,
		})
	}

	afterEach(async () => {
		await app.close()
	})

	it("returns every field with the default limit of 100", async () => {
		await build()
		const res = await app.inject({ url: "/api/scanner/jobs/j_1/hits" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(BODY)
		expect(jobHits).toHaveBeenCalledWith("j_1", 100)
	})

	it("passes limit 1 to 500 and rejects values outside", async () => {
		await build()
		for (const limit of [1, 500]) {
			const res = await app.inject({
				url: `/api/scanner/jobs/j_1/hits?limit=${limit}`,
			})
			expect(res.statusCode).toBe(200)
			expect(jobHits).toHaveBeenLastCalledWith("j_1", limit)
		}
		jobHits.mockClear()
		for (const bad of ["0", "501", "abc", "1.5"]) {
			const res = await app.inject({
				url: `/api/scanner/jobs/j_1/hits?limit=${bad}`,
			})
			expect(res.statusCode).toBe(400)
		}
		expect(jobHits).not.toHaveBeenCalled()
	})

	it("answers 404 for an unknown job", async () => {
		await build()
		const res = await app.inject({ url: "/api/scanner/jobs/j_nope/hits" })
		expect(res.statusCode).toBe(404)
		expect(res.json()).toMatchObject({ code: "SCANNER_JOB_NOT_FOUND" })
	})
})
