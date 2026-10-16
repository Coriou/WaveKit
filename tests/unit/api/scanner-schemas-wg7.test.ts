import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"

const SKIPS = [
	{
		startHz: 446_000_000,
		endHz: 446_100_000,
		bandKeys: ["op/a"],
		applied: true,
	},
]

describe("WG7 scanner schemas", () => {
	let app: FastifyInstance
	afterEach(async () => {
		await app.close()
	})

	async function build(): Promise<{
		preview: ReturnType<typeof vi.fn>
		create: ReturnType<typeof vi.fn>
		patch: ReturnType<typeof vi.fn>
	}> {
		const preview = vi.fn((spec: unknown) => ({ spec, bandPlanSkips: SKIPS }))
		const create = vi.fn((spec: unknown) => ({ id: "j_1", spec }))
		const patch = vi.fn((_id: string, spec: unknown) => ({ id: "j_1", spec }))
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: {
				preview,
				createJob: create,
				patchJob: patch,
			} as unknown as ScannerRouteService,
		})
		await app.ready()
		return { preview, create, patch }
	}

	it("preview, create and PATCH accept a boolean skipBandPlanSkips", async () => {
		const { preview, create, patch } = await build()
		const body = { mode: "sweep", skipBandPlanSkips: true }
		const p = await app.inject({
			method: "POST",
			url: "/api/scanner/plan",
			payload: body,
		})
		expect(p.statusCode).toBe(200)
		expect(preview.mock.calls[0]?.[0]).toMatchObject({
			skipBandPlanSkips: true,
		})
		// The preview response keeps bandPlanSkips after serialisation.
		expect(p.json().bandPlanSkips).toEqual(SKIPS)
		const c = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: body,
		})
		expect(c.statusCode).toBeLessThan(300)
		expect(create).toHaveBeenCalled()
		expect(create.mock.calls[0]?.[0]).toMatchObject({ skipBandPlanSkips: true })
		const u = await app.inject({
			method: "PATCH",
			url: "/api/scanner/jobs/j_1",
			payload: { skipBandPlanSkips: false },
		})
		expect(u.statusCode).toBeLessThan(300)
		expect(patch).toHaveBeenCalled()
		expect(JSON.stringify(patch.mock.calls[0])).toContain(
			'"skipBandPlanSkips":false',
		)
	})

	it("rejects a non-boolean skipBandPlanSkips with 400", async () => {
		const { preview, create, patch } = await build()
		// Fastify's default ajv coerces "true" to a boolean, so use an object.
		for (const [method, url] of [
			["POST", "/api/scanner/plan"],
			["POST", "/api/scanner/jobs"],
			["PATCH", "/api/scanner/jobs/j_1"],
		] as const) {
			const res = await app.inject({
				method,
				url,
				payload: { mode: "sweep", skipBandPlanSkips: { x: 1 } },
			})
			expect(res.statusCode).toBe(400)
		}
		expect(preview).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
		expect(patch).not.toHaveBeenCalled()
	})
})
