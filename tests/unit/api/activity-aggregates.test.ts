import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import { ActivityReaderFailedError } from "../../../src/core/activity/query/errors.js"
import {
	createActivityQueryService,
	type ActivityQueryServiceOptions,
} from "../../../src/core/activity/query/service.js"
import type { ReaderHostEvent } from "../../../src/core/activity/query/reader-host.js"
import type {
	ActivityBandMap,
	ActivityQueryService,
	ActivityTimeline,
} from "../../../src/core/activity/storage/contract.js"
import {
	createFixture,
	testLogger,
	type ActivityFixture,
} from "../core/activity/query/fixture.js"

const NOW = Date.parse("2026-10-16T12:00:00.000Z")
const H = 3_600_000
const iso = (offset: number): string => new Date(NOW + offset).toISOString()
const ROUTES = ["bandmap", "timeline"] as const

function stub(overrides: Partial<ActivityQueryService>): ActivityQueryService {
	const fail = (): never => {
		throw new Error("unexpected call")
	}
	return {
		search: fail,
		detail: fail,
		facets: fail,
		trails: fail,
		bandMap: fail,
		timeline: fail,
		replay: fail,
		close: async () => {},
		...overrides,
	}
}

describe("GET /api/activity/bandmap and /timeline", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	async function open(
		overrides: Partial<Omit<ActivityQueryServiceOptions, "store">> = {},
	): Promise<{
		app: ReturnType<typeof Fastify>
		store: ActivityFixture
		events: ReaderHostEvent[]
	}> {
		fixture = await createFixture()
		const events: ReaderHostEvent[] = []
		service = createActivityQueryService({
			store: fixture.store,
			logger: testLogger,
			execution: "inline",
			now: () => NOW,
			onReaderEvent: event => events.push(event),
			...overrides,
			limits: {
				deadlineMs: 2_000,
				aggregatesDeadlineMs: 2_000,
				...overrides.limits,
			},
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		return { app, store: fixture, events }
	}

	it("returns every band map DTO field", async () => {
		const { app, store } = await open()
		store.insert({
			eventId: "a",
			frequencyHz: 1_090_000_000,
			protocol: "adsb",
			category: "aircraft",
			entityKey: "icao:A",
			producedAt: iso(-1000),
		})
		store.insert({ eventId: "b", frequencyHz: null, producedAt: iso(-2000) })
		const response = await app.inject({
			method: "GET",
			url: "/api/activity/bandmap?bucketHz=1000000",
		})
		expect(response.statusCode).toBe(200)
		const body = response.json() as ActivityBandMap
		expect(Object.keys(body).sort()).toEqual(
			[
				"bucketHz",
				"buckets",
				"countedRows",
				"coveredFrom",
				"droppedRows",
				"generatedAt",
				"maxHz",
				"minHz",
				"noFrequencyRows",
				"producedFrom",
				"producedTo",
				"retentionFloor",
				"scannedRows",
				"truncated",
				"truncation",
			].sort(),
		)
		expect(body.buckets).toEqual([
			{
				startHz: 1_090_000_000,
				rows: 1,
				lastAt: iso(-1000),
				protocols: [
					{
						protocol: "adsb",
						category: "aircraft",
						rows: 1,
						entities: 1,
						lastAt: iso(-1000),
					},
				],
				otherRows: 0,
				topEntities: [{ entityKey: "icao:A", rows: 1 }],
			},
		])
		expect(body.noFrequencyRows).toBe(1)
		await app.close()
	})

	it("returns every timeline DTO field and never comma-splits entityKey", async () => {
		const { app, store } = await open()
		store.insert({
			eventId: "a",
			category: "aircraft",
			entityKey: "k,1",
			producedAt: iso(-1000),
		})
		store.insert({
			eventId: "b",
			category: "aircraft",
			entityKey: "k",
			producedAt: iso(-1000),
		})
		const response = await app.inject({
			method: "GET",
			url: "/api/activity/timeline?entityKey=k%2C1",
		})
		expect(response.statusCode).toBe(200)
		const body = response.json() as ActivityTimeline
		expect(Object.keys(body).sort()).toEqual(
			[
				"bucketMs",
				"buckets",
				"coveredFrom",
				"generatedAt",
				"producedFrom",
				"producedTo",
				"retentionFloor",
				"scannedRows",
				"totalRows",
				"truncated",
				"truncation",
			].sort(),
		)
		expect(body.totalRows).toBe(1)
		expect(body.buckets.find(b => b.total > 0)?.counts).toEqual({ aircraft: 1 })
		await app.close()
	})

	it("answers an empty window and from == to with 200", async () => {
		const { app } = await open()
		const band = await app.inject({
			method: "GET",
			url: `/api/activity/bandmap?producedFrom=${iso(0)}&producedTo=${iso(0)}`,
		})
		expect(band.statusCode).toBe(200)
		expect((band.json() as ActivityBandMap).buckets).toEqual([])
		const line = await app.inject({
			method: "GET",
			url: `/api/activity/timeline?producedFrom=${iso(0)}&producedTo=${iso(0)}`,
		})
		expect(line.statusCode).toBe(200)
		expect((line.json() as ActivityTimeline).buckets).toHaveLength(1)
		await app.close()
	})

	it("answers 400 for each invalid rule, at and past the bound", async () => {
		const { app } = await open()
		const start = Math.floor(NOW / 60_000) * 60_000
		const span = (n: number): string =>
			`producedFrom=${new Date(start).toISOString()}&producedTo=${new Date(start + (n - 1) * 60_000).toISOString()}`
		const keys = (n: number): string =>
			Array.from({ length: n }, (_, i) => `entityKey=k${i}`).join("&")
		const ok = [
			"/api/activity/bandmap?bucketHz=1000",
			"/api/activity/bandmap?bucketHz=1000000",
			"/api/activity/bandmap?minHz=0&maxHz=2000000000",
			"/api/activity/bandmap?minHz=98000000000&maxHz=100000000000",
			`/api/activity/bandmap?producedFrom=${iso(-72 * H)}&producedTo=${iso(0)}`,
			`/api/activity/timeline?${span(1440)}`,
			`/api/activity/timeline?${keys(64)}`,
			"/api/activity/timeline?bucketMs=10000&producedFrom=" +
				iso(-1440 * 10_000 + 10_000),
			"/api/activity/timeline?bucketMs=3600000",
		]
		for (const url of ok) {
			expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(
				200,
			)
		}
		const bad = [
			"/api/activity/bandmap?bucketHz=999",
			"/api/activity/bandmap?bucketHz=1000001",
			"/api/activity/bandmap?bucketHz=12.5",
			"/api/activity/bandmap?bucketHz=1&bucketHz=2",
			"/api/activity/bandmap?minHz=-1",
			"/api/activity/bandmap?minHz=1e3",
			"/api/activity/bandmap?minHz=2&maxHz=1",
			"/api/activity/bandmap?minHz=0&maxHz=2000000001",
			"/api/activity/bandmap?minHz=98000000001&maxHz=100000000001",
			`/api/activity/bandmap?producedFrom=${iso(-72 * H - 1)}&producedTo=${iso(0)}`,
			`/api/activity/bandmap?producedFrom=${iso(0)}&producedTo=${iso(-1)}`,
			"/api/activity/bandmap?producedFrom=yesterday",
			"/api/activity/bandmap?categories=bogus",
			"/api/activity/bandmap?entityKey=x",
			"/api/activity/bandmap?foo=1",
			`/api/activity/timeline?${span(1441)}`,
			`/api/activity/timeline?${keys(65)}`,
			"/api/activity/timeline?bucketMs=9999",
			"/api/activity/timeline?bucketMs=3600001",
			"/api/activity/timeline?bucketMs=abc",
			`/api/activity/timeline?producedFrom=${iso(-72 * H - 1)}&producedTo=${iso(0)}&bucketMs=3600000`,
			"/api/activity/timeline?bucketHz=1000",
			"/api/activity/timeline?categories=bogus",
		]
		for (const url of bad) {
			const response = await app.inject({ method: "GET", url })
			expect(response.statusCode, url).toBe(400)
			expect(response.json(), url).toMatchObject({
				code: "ACTIVITY_QUERY_INVALID",
			})
		}
		await app.close()
	})

	it("answers 404 when disabled and 503 when unavailable without calling the service", async () => {
		const called = stub({
			bandMap: () => {
				throw new Error("called")
			},
			timeline: () => {
				throw new Error("called")
			},
		})
		const disabled = Fastify({ logger: false })
		await disabled.register(activityRoutes, { service: called, enabled: false })
		const down = Fastify({ logger: false })
		await down.register(activityRoutes, {
			service: called,
			enabled: true,
			unavailable: { reason: "ACTIVITY_STORE_LOCKED", message: "locked" },
		})
		for (const name of ROUTES) {
			const off = await disabled.inject({
				method: "GET",
				url: `/api/activity/${name}`,
			})
			expect(off.statusCode).toBe(404)
			expect(off.json()).toMatchObject({ code: "ACTIVITY_DISABLED" })
			const bad = await down.inject({
				method: "GET",
				url: `/api/activity/${name}`,
			})
			expect(bad.statusCode).toBe(503)
			expect(bad.json()).toMatchObject({
				code: "ACTIVITY_UNAVAILABLE",
				reason: "ACTIVITY_STORE_LOCKED",
			})
		}
		await disabled.close()
		await down.close()
	})

	it("answers 429 when admission is full", async () => {
		for (const name of ROUTES) {
			const { app } = await open({
				readerDelayMs: 150,
				limits: { maxQueued: 0, maxExecuting: 1 },
			})
			const [first, second] = await Promise.all([
				app.inject({ method: "GET", url: `/api/activity/${name}` }),
				app.inject({ method: "GET", url: `/api/activity/${name}` }),
			])
			expect([first.statusCode, second.statusCode].sort()).toEqual([200, 429])
			const busy = first.statusCode === 429 ? first : second
			expect(busy.json()).toMatchObject({ code: "ACTIVITY_QUERY_BUSY" })
			expect(busy.headers["retry-after"]).toBe("1")
			await app.close()
			await service?.close()
			await fixture?.close()
			service = undefined
			fixture = undefined
		}
	})

	it("answers 429 when the aggregates deadline passes", async () => {
		for (const name of ROUTES) {
			const { app } = await open({
				readerDelayMs: 200,
				limits: { aggregatesDeadlineMs: 20 },
			})
			const response = await app.inject({
				method: "GET",
				url: `/api/activity/${name}`,
			})
			expect(response.statusCode).toBe(429)
			expect(response.json()).toMatchObject({ code: "ACTIVITY_QUERY_TIMEOUT" })
			await app.close()
			await service?.close()
			await fixture?.close()
			service = undefined
			fixture = undefined
		}
	})

	it("answers 500 when the reader fails", async () => {
		const failing = Fastify({ logger: false })
		await failing.register(activityRoutes, {
			service: stub({
				bandMap: async () => {
					throw new ActivityReaderFailedError()
				},
				timeline: async () => {
					throw new ActivityReaderFailedError()
				},
			}),
			enabled: true,
		})
		for (const name of ROUTES) {
			const response = await failing.inject({
				method: "GET",
				url: `/api/activity/${name}`,
			})
			expect(response.statusCode).toBe(500)
			expect(response.json()).toMatchObject({ code: "ACTIVITY_QUERY_FAILED" })
		}
		await failing.close()
	})

	it("answers 200 time-limit on a spent wall budget without restarting the reader", async () => {
		const { app, store, events } = await open({
			limits: { aggregatesWallBudgetMs: 0 },
			aggregatesLimits: { chunkRows: 1 },
		})
		for (let i = 0; i < 3; i++) {
			store.insert({
				eventId: `e${i}`,
				frequencyHz: 100_000_000,
				producedAt: iso(-(4 - i) * 1000),
			})
		}
		for (const name of ROUTES) {
			const response = await app.inject({
				method: "GET",
				url: `/api/activity/${name}`,
			})
			expect(response.statusCode).toBe(200)
			expect(response.json()).toMatchObject({
				truncated: true,
				truncation: ["time-limit"],
			})
		}
		expect(events.filter(e => e.type === "terminate")).toEqual([])
		await app.close()
	})
})
