import { DatabaseSync } from "node:sqlite"
import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import { ActivityReaderFailedError } from "../../../src/core/activity/query/errors.js"
import type { ActivityQueryService } from "../../../src/core/activity/storage/contract.js"
import {
	createActivityQueryService,
	type ActivityQueryServiceOptions,
} from "../../../src/core/activity/query/service.js"
import {
	createFixture,
	testLogger,
	type ActivityFixture,
} from "../core/activity/query/fixture.js"

const NOW = Date.parse("2026-10-16T12:00:00.000Z")

function iso(offsetMs: number): string {
	return new Date(NOW + offsetMs).toISOString()
}

function stubService(
	trails: ActivityQueryService["trails"],
): ActivityQueryService {
	const fail = (): never => {
		throw new Error("unexpected call")
	}
	const service: ActivityQueryService = {
		search: fail,
		detail: fail,
		facets: fail,
		replay: fail,
		close: async () => {},
	}
	if (trails) service.trails = trails
	return service
}

describe("GET /api/activity/trails", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	/** Inserts a decoder reception and stamps a position into its summary. */
	function insertPoint(
		store: ActivityFixture,
		eventId: string,
		entityKey: string,
		offsetMs: number,
		position: unknown,
		extra: { category?: "aircraft" | "marine"; protocol?: string } = {},
	): void {
		store.insert({
			eventId,
			entityKey,
			producedAt: iso(offsetMs),
			category: extra.category ?? "aircraft",
			protocol: extra.protocol ?? "adsb",
		})
		const db = new DatabaseSync(store.dbPath)
		try {
			db.prepare(
				"UPDATE activity SET summary_json = json_set(summary_json, '$.position', json(?)) WHERE event_id = ?",
			).run(JSON.stringify(position), eventId)
		} finally {
			db.close()
		}
	}

	async function open(
		overrides: Partial<Omit<ActivityQueryServiceOptions, "store">> = {},
	): Promise<{ app: ReturnType<typeof Fastify>; store: ActivityFixture }> {
		fixture = await createFixture()
		service = openQueryService(fixture, { now: () => NOW, ...overrides })
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		return { app, store: fixture }
	}

	it("returns trails with every DTO field", async () => {
		const { app, store } = await open()
		insertPoint(store, "e1", "icao:A", -120_000, {
			lat: 48.1,
			lon: 2.1,
			altM: 1000,
		})
		insertPoint(store, "e2", "icao:A", -60_000, { lat: 48.2, lon: 2.2 })
		insertPoint(store, "e3", "icao:B", -30_000, { lat: 0, lon: 0 })
		const response = await app.inject({
			method: "GET",
			url: "/api/activity/trails",
		})
		expect(response.statusCode).toBe(200)
		const body = response.json() as Record<string, unknown>
		expect(Object.keys(body).sort()).toEqual(
			[
				"generatedAt",
				"pointCount",
				"producedFrom",
				"producedTo",
				"retentionFloor",
				"scannedRows",
				"skippedRows",
				"trails",
				"truncated",
				"truncation",
			].sort(),
		)
		expect(body["producedTo"]).toBe(iso(0))
		expect(body["producedFrom"]).toBe(iso(-3_600_000))
		expect(body["pointCount"]).toBe(2)
		expect(body["skippedRows"]).toBe(1)
		expect(body["truncated"]).toBe(false)
		const trails = body["trails"] as {
			entityKey: string
			category: string
			protocol: string | null
			points: unknown[]
			truncated: boolean
		}[]
		expect(trails).toHaveLength(1)
		expect(trails[0]).toEqual({
			entityKey: "icao:A",
			category: "aircraft",
			protocol: "adsb",
			points: [
				[NOW - 120_000, 48.1, 2.1, 1000],
				[NOW - 60_000, 48.2, 2.2, null],
			],
			truncated: false,
		})
		await app.close()
	})

	it("answers an empty window with 200 and no trails", async () => {
		const { app } = await open()
		const response = await app.inject({
			method: "GET",
			url: "/api/activity/trails",
		})
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			trails: [],
			pointCount: 0,
			truncated: false,
			truncation: [],
			retentionFloor: null,
		})
		await app.close()
	})

	it("allows producedFrom equal to producedTo", async () => {
		const { app, store } = await open()
		insertPoint(store, "e1", "icao:A", -1000, { lat: 1, lon: 1 })
		const at = encodeURIComponent(iso(-1000))
		const response = await app.inject({
			method: "GET",
			url: `/api/activity/trails?producedFrom=${at}&producedTo=${at}`,
		})
		expect(response.statusCode).toBe(200)
		const body = response.json() as { trails: unknown[]; pointCount: number }
		expect(body.pointCount).toBe(1)
		await app.close()
	})

	it("filters by categories and protocols, comma or repeated", async () => {
		const { app, store } = await open()
		insertPoint(store, "e1", "a", -1000, { lat: 1, lon: 1 })
		insertPoint(
			store,
			"e2",
			"m",
			-1000,
			{ lat: 2, lon: 2 },
			{ category: "marine", protocol: "ais" },
		)
		const one = await app.inject({
			method: "GET",
			url: "/api/activity/trails?categories=marine&protocols=ais",
		})
		expect(
			(one.json() as { trails: { entityKey: string }[] }).trails.map(
				t => t.entityKey,
			),
		).toEqual(["m"])
		const both = await app.inject({
			method: "GET",
			url: "/api/activity/trails?categories=marine,aircraft",
		})
		expect((both.json() as { trails: unknown[] }).trails).toHaveLength(2)
		const repeated = await app.inject({
			method: "GET",
			url: "/api/activity/trails?protocols=ais&protocols=adsb",
		})
		expect((repeated.json() as { trails: unknown[] }).trails).toHaveLength(2)
		await app.close()
	})

	it("does not split repeated entityKey values on commas", async () => {
		const { app, store } = await open()
		insertPoint(store, "e1", "a,b", -1000, { lat: 1, lon: 1 })
		insertPoint(store, "e2", "a", -1000, { lat: 2, lon: 2 })
		insertPoint(store, "e3", "b", -1000, { lat: 3, lon: 3 })
		const response = await app.inject({
			method: "GET",
			url: `/api/activity/trails?entityKey=${encodeURIComponent("a,b")}`,
		})
		expect(response.statusCode).toBe(200)
		expect(
			(response.json() as { trails: { entityKey: string }[] }).trails.map(
				t => t.entityKey,
			),
		).toEqual(["a,b"])
		const two = await app.inject({
			method: "GET",
			url: `/api/activity/trails?entityKey=a&entityKey=${encodeURIComponent("a,b")}`,
		})
		expect((two.json() as { trails: unknown[] }).trails).toHaveLength(2)
		await app.close()
	})

	it("rejects invalid requests with 400 ACTIVITY_QUERY_INVALID", async () => {
		const { app } = await open()
		const keys = Array.from({ length: 65 }, (_, i) => `entityKey=k${i}`).join(
			"&",
		)
		const urls = [
			"?foo=1",
			"?producedFrom=nope",
			"?producedTo=nope",
			`?producedFrom=${encodeURIComponent(iso(0))}&producedTo=${encodeURIComponent(iso(-1000))}`,
			`?producedFrom=${encodeURIComponent(iso(-86_400_001))}&producedTo=${encodeURIComponent(iso(0))}`,
			"?categories=not-a-category",
			`?${keys}`,
		]
		for (const url of urls) {
			const response = await app.inject({
				method: "GET",
				url: `/api/activity/trails${url}`,
			})
			expect(response.statusCode, url).toBe(400)
			expect(response.json(), url).toMatchObject({
				code: "ACTIVITY_QUERY_INVALID",
			})
		}
		const bound = await app.inject({
			method: "GET",
			url: `/api/activity/trails?producedFrom=${encodeURIComponent(iso(-86_400_000))}&producedTo=${encodeURIComponent(iso(0))}`,
		})
		expect(bound.statusCode).toBe(200)
		await app.close()
	})

	it("answers 404 when disabled and 503 when unavailable without calling the service", async () => {
		const service = stubService(() => {
			throw new Error("called")
		})
		const disabled = Fastify({ logger: false })
		await disabled.register(activityRoutes, { service, enabled: false })
		const off = await disabled.inject({
			method: "GET",
			url: "/api/activity/trails",
		})
		expect(off.statusCode).toBe(404)
		expect(off.json()).toMatchObject({ code: "ACTIVITY_DISABLED" })
		await disabled.close()
		const down = Fastify({ logger: false })
		await down.register(activityRoutes, {
			service,
			enabled: true,
			unavailable: { reason: "ACTIVITY_STORE_LOCKED", message: "locked" },
		})
		const bad = await down.inject({
			method: "GET",
			url: "/api/activity/trails",
		})
		expect(bad.statusCode).toBe(503)
		expect(bad.json()).toMatchObject({
			code: "ACTIVITY_UNAVAILABLE",
			reason: "ACTIVITY_STORE_LOCKED",
		})
		await down.close()
	})

	it("answers 429 when admission is full", async () => {
		const { app } = await open({
			readerDelayMs: 150,
			limits: {
				maxQueued: 0,
				maxExecuting: 1,
				deadlineMs: 2_000,
				trailsDeadlineMs: 2_000,
			},
		})
		const [first, second] = await Promise.all([
			app.inject({ method: "GET", url: "/api/activity/trails" }),
			app.inject({ method: "GET", url: "/api/activity/trails" }),
		])
		const codes = [first.statusCode, second.statusCode].sort()
		expect(codes).toEqual([200, 429])
		const busy = first.statusCode === 429 ? first : second
		expect(busy.json()).toMatchObject({ code: "ACTIVITY_QUERY_BUSY" })
		await app.close()
	})

	it("answers 429 when the trails deadline passes", async () => {
		const { app } = await open({
			readerDelayMs: 200,
			limits: { trailsDeadlineMs: 20, deadlineMs: 2_000 },
		})
		const response = await app.inject({
			method: "GET",
			url: "/api/activity/trails",
		})
		expect(response.statusCode).toBe(429)
		expect(response.json()).toMatchObject({ code: "ACTIVITY_QUERY_TIMEOUT" })
		await app.close()
	})

	it("answers 500 when the reader fails, and when the service has no trails", async () => {
		const failing = Fastify({ logger: false })
		await failing.register(activityRoutes, {
			service: stubService(async () => {
				throw new ActivityReaderFailedError()
			}),
			enabled: true,
		})
		const failed = await failing.inject({
			method: "GET",
			url: "/api/activity/trails",
		})
		expect(failed.statusCode).toBe(500)
		expect(failed.json()).toMatchObject({ code: "ACTIVITY_QUERY_FAILED" })
		await failing.close()
		const missing = Fastify({ logger: false })
		await missing.register(activityRoutes, {
			service: stubService(undefined),
			enabled: true,
		})
		const none = await missing.inject({
			method: "GET",
			url: "/api/activity/trails",
		})
		expect(none.statusCode).toBe(500)
		await missing.close()
	})
})

function openQueryService(
	fixture: ActivityFixture,
	overrides: Partial<Omit<ActivityQueryServiceOptions, "store">> = {},
): ActivityQueryService {
	return createActivityQueryService({
		store: fixture.store,
		logger: testLogger,
		execution: "inline",
		...overrides,
		limits: { deadlineMs: 2_000, ...overrides.limits },
	})
}
