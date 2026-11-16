/**
 * The mock serves the core's channel contract: a scanner recording's Activity row on its channel
 * ("FM voice", `channel`), `channelHz` / `nearHz` filters with `channelMatch` on the list and the
 * facets (`channel` dimension), and the recordings list's verdict facts and channel scopes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	ActivityFacetResult,
	ActivitySearchPage,
	RecordingInventoryPage,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock channel contract", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const get = async <T>(url: string) => {
		const res = await server.app.inject({ method: "GET", url })
		return { status: res.statusCode, body: res.json<T>() }
	}

	it("lists scanner recording rows on their channel, and filters and counts by channel", async () => {
		const rows = await get<ActivitySearchPage>(
			"/api/activity?kinds=recording-change&limit=500",
		)
		const row = rows.body.items[0]
		expect(row).toBeDefined()
		expect(row?.title).toBe("FM voice")
		expect(row?.channel?.frequencyHz).toBe(row?.frequencyHz)
		const channelHz = row?.channel?.frequencyHz ?? 0
		const exact = await get<ActivitySearchPage>(
			`/api/activity?channelHz=${channelHz}&limit=500`,
		)
		expect(exact.status).toBe(200)
		// The channel's analog transmissions carry no channel and match by their frequency: mixed.
		expect(exact.body.items.some(i => i.channel === undefined)).toBe(true)
		expect(exact.body.channelMatch).toBe("mixed")
		// Its recordings alone all carry the channel: exact.
		const recordings = await get<ActivitySearchPage>(
			`/api/activity?channelHz=${channelHz}&kinds=recording-change&limit=500`,
		)
		expect(recordings.body.items.length).toBeGreaterThan(0)
		expect(recordings.body.channelMatch).toBe("exact")
		const recordingFacets = (
			await server.app.inject({
				method: "POST",
				url: "/api/activity/facets",
				payload: {
					query: { channelHz, kinds: ["recording-change"] },
					dimensions: ["channel"],
				},
			})
		).json<ActivityFacetResult>()
		expect(recordingFacets.channelMatch).toBe("exact")
		// No channel scope: no channelMatch.
		expect(
			(await get<ActivitySearchPage>("/api/activity?limit=1")).body
				.channelMatch,
		).toBeUndefined()
		expect(exact.body.items.map(i => i.eventId)).toContain(row?.eventId)
		const res = await server.app.inject({
			method: "POST",
			url: "/api/activity/facets",
			payload: { query: { channelHz }, dimensions: ["channel"] },
		})
		const facets = res.json<ActivityFacetResult>()
		const sum = (facets.facets["channel"] ?? []).reduce(
			(n, f) => n + f.count,
			0,
		)
		expect(sum).toBe(exact.body.items.length)
		expect(facets.channelMatch).toBe("mixed")
		expect((await get(`/api/activity?toleranceHz=10`)).status).toBe(400)
	})

	it("serves the verdict facts and the channel scopes on recordings", async () => {
		const all = await get<RecordingInventoryPage>("/api/recordings?limit=200")
		const analog = all.body.items.filter(i => i.kind === "scanner-analog")
		expect(analog.length).toBeGreaterThan(0)
		for (const item of all.body.items) {
			expect(["heard", "not-heard", "unchecked"]).toContain(item.speech)
			expect(item).toHaveProperty("keptBy")
			expect(item).toHaveProperty("startedAt")
			expect(item).toHaveProperty("observationId")
		}
		expect(
			analog.some(i => i.speech === "not-heard" && i.keptBy === "prior-none"),
		).toBe(true)
		const hz = analog[0]?.frequencyHz ?? 0
		const exact = await get<RecordingInventoryPage>(
			`/api/recordings?channelHz=${hz}&limit=200`,
		)
		expect(exact.body.items.every(i => i.frequencyHz === hz)).toBe(true)
		const near = await get<RecordingInventoryPage>(
			`/api/recordings?nearHz=${hz}&toleranceHz=50000&limit=200`,
		)
		const counted = (near.body.matchedByChannel ?? []).reduce(
			(n, c) => n + c.count,
			0,
		)
		expect(counted).toBe(near.body.matched)
		expect(
			(await get(`/api/recordings?channelHz=${hz}&nearHz=${hz}`)).status,
		).toBe(400)
	})
})
