import type { FastifyRequest } from "fastify"
import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import {
	activityClientKey,
	activityRoutes,
} from "../../../src/api/routes/activity.js"
import type { ActivityQueryService } from "../../../src/core/activity/storage/contract.js"
import type { ActivityStoreStats } from "../../../src/core/activity/storage/contract.js"
import {
	createFixture,
	openQueryService,
	type ActivityFixture,
} from "../core/activity/query/fixture.js"

function storeStats(): ActivityStoreStats {
	const stats = {
		admitted: 1,
		committed: 1,
		duplicates: 0,
		dropped: {
			"rate-limited": 0,
			"queue-full": 0,
			"store-paused": 0,
			"write-failed": 0,
			closed: 0,
		},
		excludedTelemetry: 0,
		queueDepth: 0,
		queueBytes: 0,
		dbBytes: 10,
		walBytes: 0,
		rows: 1,
		oldestReceivedAt: null,
		pruneWatermark: "0",
		paused: false,
		writer: "running" as const,
	}
	return stats
}

const stats = storeStats()

function throwingService(): ActivityQueryService {
	const fail = (): never => {
		throw new Error("activity service was called while disabled")
	}
	return {
		search: fail,
		detail: fail,
		facets: fail,
		replay: fail,
		close: async () => {},
	}
}

describe("activity routes", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	it("answers 404 ACTIVITY_DISABLED for every route without calling the service", async () => {
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service: throwingService(),
			enabled: false,
		})
		const paths = [
			{ method: "GET" as const, url: "/api/activity" },
			{ method: "GET" as const, url: "/api/activity/status" },
			{ method: "POST" as const, url: "/api/activity/facets" },
			{ method: "GET" as const, url: "/api/activity/evt-1" },
		]
		for (const path of paths) {
			const response = await app.inject({
				...path,
				payload: { query: {}, dimensions: ["kind"] },
			})
			expect(response.statusCode).toBe(404)
			expect(response.json()).toMatchObject({
				error: "NotFound",
				code: "ACTIVITY_DISABLED",
				message: "Activity is disabled",
			})
		}
		await app.close()
	})

	it("answers 503 ACTIVITY_UNAVAILABLE with the open failure and does not call the service", async () => {
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service: throwingService(),
			enabled: true,
			unavailable: {
				reason: "ACTIVITY_STORE_LOCKED",
				message: "Activity store is locked",
			},
		})
		const paths = [
			{ method: "GET" as const, url: "/api/activity" },
			{ method: "GET" as const, url: "/api/activity/status" },
			{ method: "POST" as const, url: "/api/activity/facets" },
			{ method: "GET" as const, url: "/api/activity/evt-1" },
		]
		for (const path of paths) {
			const response = await app.inject({
				...path,
				payload: { query: {}, dimensions: ["kind"] },
			})
			expect(response.statusCode).toBe(503)
			expect(response.json()).toMatchObject({
				error: "ServiceUnavailable",
				code: "ACTIVITY_UNAVAILABLE",
				reason: "ACTIVITY_STORE_LOCKED",
				message: "Activity store is locked",
			})
		}
		await app.close()
	})

	it("hides the open error when discloseErrors is false and still returns reason", async () => {
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service: throwingService(),
			enabled: true,
			discloseErrors: false,
			unavailable: {
				reason: "ACTIVITY_UNAVAILABLE",
				message: "EACCES /data/activity/activity.db",
			},
		})
		const response = await app.inject({
			method: "GET",
			url: "/api/activity/status",
		})
		expect(response.statusCode).toBe(503)
		expect(response.json()).toEqual({
			error: "ServiceUnavailable",
			code: "ACTIVITY_UNAVAILABLE",
			reason: "ACTIVITY_UNAVAILABLE",
			message: "Request failed",
		})
		expect(response.body).not.toContain("/data/activity")
		await app.close()
	})

	it("ignores x-activity-client and keys admission on the access principal", () => {
		const request = {
			ip: "203.0.113.8",
			headers: { "x-activity-client": "rotate-me" },
		} as unknown as FastifyRequest
		expect(activityClientKey(request)).toBe("ip:203.0.113.8")
		expect(
			activityClientKey(request, {
				principalId: () => "device_abc",
			}),
		).toBe("principal:device_abc")
		expect(
			activityClientKey(
				{
					ip: "203.0.113.9",
					headers: { "x-activity-client": "other" },
				} as unknown as FastifyRequest,
				{ principalId: () => "device_abc" },
			),
		).toBe("principal:device_abc")
		expect(activityClientKey(request, { principalId: () => undefined })).toBe(
			"ip:203.0.113.8",
		)
		expect(activityClientKey(request, { principalId: () => "" })).toBe(
			"ip:203.0.113.8",
		)
	})

	it("searches, reads detail, counts facets, and reports status", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store)
		store.insert({
			eventId: "evt-1",
			kind: "decoder-reception",
			sourceId: "src-a",
			text: "alpha beacon",
			refs: [{ type: "callId", value: "call-1" }],
		})
		store.insert({
			eventId: "evt-2",
			kind: "ingestion-gap",
			sourceId: "src-b",
			text: "other",
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service,
			enabled: true,
			stats: () => stats,
		})
		const status = await app.inject({
			method: "GET",
			url: "/api/activity/status",
		})
		expect(status.statusCode).toBe(200)
		expect(status.json()).toMatchObject({ enabled: true, stats })

		const search = await app.inject({
			method: "GET",
			url: "/api/activity?kinds=decoder-reception&sourceIds=src-a&text=beacon&refs=callId:call-1&limit=10",
		})
		expect(search.statusCode).toBe(200)
		const page = search.json() as {
			items: { eventId: string; commitSeq: string }[]
			searchCoverage: string
		}
		expect(page.searchCoverage).toBe("bounded-projection")
		expect(page.items.map(item => item.eventId)).toEqual(["evt-1"])

		const detail = await app.inject({
			method: "GET",
			url: "/api/activity/evt-1",
		})
		expect(detail.statusCode).toBe(200)
		expect(detail.json()).toMatchObject({
			eventId: "evt-1",
			commitSeq: page.items[0]?.commitSeq,
		})

		const missing = await app.inject({
			method: "GET",
			url: "/api/activity/missing",
		})
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toMatchObject({ code: "NOT_FOUND" })

		const facets = await app.inject({
			method: "POST",
			url: "/api/activity/facets",
			payload: { query: {}, dimensions: ["kind"] },
		})
		expect(facets.statusCode).toBe(200)
		const counted = facets.json() as {
			facets: { kind: { value: string; count: number }[] }
		}
		expect(counted.facets.kind).toEqual([
			{ value: "decoder-reception", count: 1 },
			{ value: "ingestion-gap", count: 1 },
		])
		await app.close()
	})

	it("returns 500 when status has no stats provider", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture)
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		const status = await app.inject({
			method: "GET",
			url: "/api/activity/status",
		})
		expect(status.statusCode).toBe(500)
		expect(status.json()).toMatchObject({ code: "ACTIVITY_STATUS_UNAVAILABLE" })
		await app.close()
	})

	it("rejects an unknown parameter, an invalid query, and a tampered page token", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store)
		store.insert({ eventId: "evt-1" })
		store.insert({ eventId: "evt-2" })
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, {
			service,
			enabled: true,
			stats: () => stats,
		})
		const unknown = await app.inject({
			method: "GET",
			url: "/api/activity?foo=1",
		})
		expect(unknown.statusCode).toBe(400)
		expect(unknown.json()).toMatchObject({ code: "ACTIVITY_QUERY_INVALID" })

		const invalid = await app.inject({
			method: "GET",
			url: "/api/activity?kinds=not-a-kind",
		})
		expect(invalid.statusCode).toBe(400)
		expect(invalid.json()).toMatchObject({ code: "ACTIVITY_QUERY_INVALID" })

		const first = await app.inject({
			method: "GET",
			url: "/api/activity?limit=1&order=asc",
		})
		const token = (first.json() as { nextPageToken: string | null })
			.nextPageToken
		expect(token).toBeTruthy()
		const dot = token?.indexOf(".") ?? -1
		const mac = token?.slice(dot + 1) ?? ""
		const macChars = [...mac]
		const lead = macChars[0] ?? "A"
		macChars[0] = lead === "A" ? "B" : "A"
		const tampered = `${token?.slice(0, dot)}.${macChars.join("")}`
		const bad = await app.inject({
			method: "GET",
			url: `/api/activity?limit=1&order=asc&pageToken=${encodeURIComponent(tampered)}`,
		})
		expect(bad.statusCode).toBe(400)
		expect(bad.json()).toMatchObject({
			code: "ACTIVITY_CURSOR_INVALID",
			reason: "invalid-cursor",
		})

		store.setIdentity({ pruneWatermark: "1" })
		const gap = await app.inject({
			method: "GET",
			url: `/api/activity?limit=1&order=asc&pageToken=${encodeURIComponent(token ?? "")}`,
		})
		expect(gap.statusCode).toBe(410)
		expect(gap.json()).toMatchObject({
			code: "ACTIVITY_CURSOR_GAP",
			reason: "cursor-gap",
		})
		await app.close()
	})
})
