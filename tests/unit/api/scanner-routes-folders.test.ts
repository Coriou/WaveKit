// The scanner status carries the load-time folder migration counts (`folders`) unchanged.
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScannerStatus } from "@wavekit/api-types"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"

describe("GET /api/scanner folders", () => {
	let app: FastifyInstance | undefined
	afterEach(async () => {
		await app?.close()
		app = undefined
	})

	async function build(status: Partial<ScannerStatus>) {
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: {
				status: vi.fn(() => status),
			} as unknown as ScannerRouteService,
		})
		return app
	}

	it("passes the counts through", async () => {
		const server = await build({
			enabled: true,
			folders: { reattached: 2, unresolved: 3 },
		})
		const res = await server.inject({ url: "/api/scanner" })
		expect(res.statusCode).toBe(200)
		expect(res.json().folders).toEqual({ reattached: 2, unresolved: 3 })
	})

	it("omits the field before the migration ran", async () => {
		const server = await build({ enabled: true })
		const res = await server.inject({ url: "/api/scanner" })
		expect(res.json()).not.toHaveProperty("folders")
	})
})
