import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { storageRoutes } from "../../../src/api/routes/storage.js"
import type { StorageReport } from "@wavekit/api-types"
import { createStorageReporter } from "../../../src/core/storage-report/reporter.js"
import type { StorageAreaScan } from "../../../src/core/storage-report/scan.js"
import type { StorageAreaSource } from "../../../src/core/storage-report/contract.js"
import { STORAGE_COUNT_MAX_SERVE_AGE_MS } from "../../../src/core/storage-report/contract.js"

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
	count: {
		countedAt: "2026-10-16T11:59:58.000Z",
		ageMs: 2_000,
		refreshing: true,
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

	it("round-trips the scanner storage split (parts) and a ready kept summary", async () => {
		const withParts: StorageReport = {
			...full,
			areas: [
				{
					id: "scanner-evidence",
					class: "automatic",
					bytes: 30,
					files: 3,
					exists: true,
					partial: false,
					partialReason: null,
					cap: { bytes: 512 },
					retention: null,
					parts: [
						{
							id: "recordings",
							bytes: 20,
							files: 2,
							exists: true,
							boundedFiles: 2,
							bounds: { maxBytes: 512, maxAgeMs: 9, maxFiles: null },
							overBound: false,
						},
						{
							// Counted in the prune's unit: a WAV and its JSON sidecar are one entry.
							id: "quarantine",
							bytes: 8,
							files: 4,
							exists: true,
							boundedFiles: 2,
							bounds: { maxBytes: null, maxAgeMs: null, maxFiles: 2 },
							overBound: false,
						},
						{
							id: "other",
							bytes: 10,
							files: 1,
							exists: true,
							bounds: { maxBytes: null, maxAgeMs: null, maxFiles: null },
							overBound: null,
						},
					],
				},
			],
			kept: {
				state: "ready",
				recordings: 1,
				bytes: 2,
				maxRecordings: 3,
				maxBytes: 4,
			},
		}
		const app = await appWith(async () => withParts)
		const res = await app.inject({ method: "GET", url: "/api/storage" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(withParts)
	})

	it.each(["loading", "failed"] as const)(
		"serializes an unavailable kept summary (%s)",
		async state => {
			const app = await appWith(async () => ({ ...full, kept: { state } }))
			const res = await app.inject({ method: "GET", url: "/api/storage" })
			expect(res.json().kept).toEqual({ state })
		},
	)

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

	it("serves a real reporter's count state: refreshing first, then complete", async () => {
		let finish: (s: StorageAreaScan[]) => void = () => undefined
		const reporter = createStorageReporter(
			{
				stateDir: "/state",
				areas: [{ id: "logs", paths: ["/secret/logs"], capBytes: null }],
				minFreeBytes: null,
				now: () => 7_000,
			},
			{
				statfs: async () => ({ blocks: 1, bfree: 1, bavail: 1, bsize: 1 }),
				limits: { maxWallMs: 5 },
				scan: (areas, options) => {
					options?.progress?.(() =>
						areas.map(a => ({
							id: a.id,
							bytes: 1,
							files: 1,
							exists: true,
							partialReason: "time-limit" as const,
						})),
					)
					return new Promise<StorageAreaScan[]>(resolve => {
						finish = resolve
					})
				},
			},
		)
		const app = Fastify()
		await app.register(storageRoutes, { report: reporter })
		open.push(app)
		const cold = (
			await app.inject({ method: "GET", url: "/api/storage" })
		).json<StorageReport>()
		expect(cold.count).toEqual({
			countedAt: null,
			ageMs: null,
			refreshing: true,
		})
		expect(cold.areas[0]).toMatchObject({
			partial: true,
			partialReason: "time-limit",
		})
		finish([
			{ id: "logs", bytes: 40, files: 4, exists: true, partialReason: null },
		])
		await new Promise<void>(resolve => setImmediate(resolve))
		const res = await app.inject({ method: "GET", url: "/api/storage" })
		const done = res.json<StorageReport>()
		expect(done.count).toEqual({
			countedAt: new Date(7_000).toISOString(),
			ageMs: 0,
			refreshing: false,
		})
		expect(done.areas[0]).toMatchObject({
			bytes: 40,
			files: 4,
			partial: false,
			partialReason: null,
		})
		expect(res.body).not.toContain("/secret")
	})

	it("accepts a report without count (older providers)", async () => {
		const { count: _count, ...older } = full
		void _count
		const app = await appWith(async () => older)
		const res = await app.inject({ method: "GET", url: "/api/storage" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual(older)
		expect(res.json()).not.toHaveProperty("count")
	})

	/** A real reporter over a scan the test settles; its clock is `clock.t`. */
	function deferredReporter(maxWallMs: number) {
		const clock = { t: 0 }
		const pending: {
			areas: readonly StorageAreaSource[]
			resolve: (s: StorageAreaScan[]) => void
			reject: (e: unknown) => void
		}[] = []
		const reporter = createStorageReporter(
			{
				stateDir: "/state",
				areas: [{ id: "logs", paths: ["/secret/logs"], capBytes: null }],
				minFreeBytes: null,
				now: () => clock.t,
			},
			{
				statfs: async () => ({ blocks: 1, bfree: 1, bavail: 1, bsize: 1 }),
				limits: { maxWallMs },
				scan: areas =>
					new Promise<StorageAreaScan[]>((resolve, reject) => {
						pending.push({ areas, resolve, reject })
					}),
			},
		)
		const counted = (files: number): StorageAreaScan[] => [
			{
				id: "logs",
				bytes: files * 10,
				files,
				exists: true,
				partialReason: null,
			},
		]
		return { reporter, pending, clock, counted }
	}
	const flushIo = () => new Promise<void>(resolve => setImmediate(resolve))

	it("serves a count at the maximum serve age as exact and past it as stale", async () => {
		// Past the age the report waits for the refresh; it ends by its 5 ms budget because the
		// refresh is settled only afterwards.
		const { reporter, pending, clock, counted } = deferredReporter(5)
		reporter.warm?.()
		pending[0]?.resolve(counted(3))
		await flushIo()
		const app = Fastify()
		await app.register(storageRoutes, { report: reporter })
		open.push(app)

		clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS
		const at = await app.inject({ method: "GET", url: "/api/storage" })
		expect(at.statusCode).toBe(200)
		expect(at.json<StorageReport>().areas[0]).toMatchObject({
			files: 3,
			partial: false,
			partialReason: null,
		})

		// The at-age report is shared until the refresh it started finishes; let it fail so
		// the next request builds past the age with a fresh refresh still running.
		pending[1]?.reject(new Error("walk failed"))
		await flushIo()
		clock.t = STORAGE_COUNT_MAX_SERVE_AGE_MS + 1
		const past = await app.inject({ method: "GET", url: "/api/storage" })
		expect(past.statusCode).toBe(200)
		const report = past.json<StorageReport>()
		expect(report.areas[0]).toMatchObject({
			files: 3,
			partial: true,
			partialReason: "stale",
		})
		expect(report.count).toEqual({
			countedAt: new Date(0).toISOString(),
			ageMs: STORAGE_COUNT_MAX_SERVE_AGE_MS + 1,
			refreshing: true,
		})
		expect(past.body).not.toContain("/secret")
	})

	it("answers 500 when the first count fails and caches nothing", async () => {
		const { reporter, pending, counted } = deferredReporter(600_000)
		const app = Fastify()
		await app.register(storageRoutes, { report: reporter })
		open.push(app)
		const failing = app.inject({ method: "GET", url: "/api/storage" })
		await flushIo()
		pending[0]?.reject(new Error("walk failed"))
		const res = await failing
		expect(res.statusCode).toBe(500)
		expect(res.json()).toMatchObject({ code: "STORAGE_REPORT_FAILED" })
		const retry = app.inject({ method: "GET", url: "/api/storage" })
		await flushIo()
		expect(pending).toHaveLength(2)
		pending[1]?.resolve(counted(2))
		const ok = await retry
		expect(ok.statusCode).toBe(200)
		expect(ok.json<StorageReport>().areas[0]).toMatchObject({
			files: 2,
			partial: false,
		})
	})
})
