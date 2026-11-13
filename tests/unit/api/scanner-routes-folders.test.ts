// The scanner status carries the load-time folder migration counts (`folders`) and the
// recordings quota state (`recordingsQuota`) unchanged.
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

	it("passes the unresolved breakdown and the state backup outcome through", async () => {
		const folders = {
			reattached: 0,
			unresolved: 3,
			unresolvedBy: { noAlias: 2, aliasWithoutOwner: 1 },
		}
		const stateBackup: ScannerStatus["stateBackup"] = {
			outcome: "skipped",
			reason: "copy-failed",
			fromFormat: "unmarked",
			toFormat: "f1-h3-r1",
		}
		const server = await build({ enabled: true, folders, stateBackup })
		const res = await server.inject({ url: "/api/scanner" })
		expect(res.json().folders).toEqual(folders)
		expect(res.json().stateBackup).toEqual(stateBackup)
	})

	it("omits the field before the migration ran", async () => {
		const server = await build({ enabled: true })
		const res = await server.inject({ url: "/api/scanner" })
		expect(res.json()).not.toHaveProperty("folders")
	})

	it("passes the recordings quota state through, and omits it within the quota", async () => {
		const quota = {
			state: "exceeded" as const,
			reason: "storage-cap" as const,
			capBytes: 4096,
			usedBytes: 12288,
			overBytes: 8192,
		}
		const server = await build({ enabled: true, recordingsQuota: quota })
		const res = await server.inject({ url: "/api/scanner" })
		expect(res.json().recordingsQuota).toEqual(quota)
		await app?.close()
		const within = await build({ enabled: true })
		const res2 = await within.inject({ url: "/api/scanner" })
		expect(res2.json()).not.toHaveProperty("recordingsQuota")
	})
})
