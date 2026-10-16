import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { storageRoutes } from "../../../src/api/routes/storage.js"
import type { StorageReport } from "@wavekit/api-types"

const full: StorageReport = {
	generatedAt: "2026-10-16T12:00:00.000Z",
	cachedUntil: "2026-10-16T12:00:30.000Z",
	filesystem: { totalBytes: 1000, freeBytes: 400, availableBytes: 300 },
	areas: [
		{
			id: "activity",
			class: "automatic",
			bytes: 10,
			files: 2,
			exists: true,
			partial: true,
			partialReason: "entry-limit",
			cap: { bytes: 99 },
			retention: {
				policy: "fair-share",
				effective: "oldest-first",
				maxRows: 5,
				maxDbBytes: 6,
				maxAgeMs: 7,
				rows: 3,
				oldestReceivedAt: "2026-10-01T00:00:00.000Z",
				shares: [
					{
						key: "decoder:adsb",
						rows: 3,
						bytes: 30,
						oldestReceivedAt: null,
					},
				],
				sharesTruncated: false,
			},
		},
		{
			id: "logs",
			class: "other",
			bytes: 0,
			files: 0,
			exists: false,
			partial: false,
			partialReason: null,
			cap: null,
			retention: null,
		},
	],
	kept: null,
	lowSpace: {
		policy: "scanner-evidence-stops-writing",
		minFreeBytes: 500,
		state: "low",
	},
}

describe("storage routes", () => {
	const open: Array<{ close(): Promise<void> }> = []
	afterEach(async () => {
		await Promise.all(open.splice(0).map(a => a.close()))
	})

	async function appWith(report: () => Promise<StorageReport>) {
		const app = Fastify()
		await app.register(storageRoutes, { report: { report } })
		open.push(app)
		return app
	}

	it("round-trips the full report with no-store and no paths", async () => {
		const app = await appWith(async () => full)
		const res = await app.inject({ method: "GET", url: "/api/storage" })
		expect(res.statusCode).toBe(200)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(res.json()).toEqual(full)
		expect(res.body).not.toContain("/state")
		expect(res.body).not.toContain("/secret")
	})

	it("answers HEAD with 200 and no body", async () => {
		const app = await appWith(async () => full)
		const res = await app.inject({ method: "HEAD", url: "/api/storage" })
		expect(res.statusCode).toBe(200)
		expect(res.headers["cache-control"]).toBe("no-store")
		expect(res.body).toBe("")
	})

	it("returns 500 STORAGE_REPORT_FAILED when the report throws", async () => {
		const app = await appWith(async () => {
			throw new Error("/secret/path exploded")
		})
		const res = await app.inject({ method: "GET", url: "/api/storage" })
		expect(res.statusCode).toBe(500)
		expect(res.json()).toEqual({
			error: "Storage report failed",
			code: "STORAGE_REPORT_FAILED",
		})
		expect(res.body).not.toContain("/secret")
	})
})
