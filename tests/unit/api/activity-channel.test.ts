/**
 * The Activity channel contract on each serializer over a real (inline) store and reader: the
 * REST list (`channelHz`, `nearHz` + `toleranceHz`, `channelMatch`, the summary's `channel`), the
 * facets route (`channel` dimension), and the WebSocket subscription (its filter and the summary
 * `channel` in its records). Synthetic rows only.
 */
import { rm } from "node:fs/promises"
import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import {
	createActivitySubscriptions,
	type ActivityClientTransport,
	type ActivityWireMessage,
} from "../../../src/api/activity-subscriptions.js"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import { withEnvelopeMetadata } from "../../../src/core/activity/envelope.js"
import { createActivityQueryService } from "../../../src/core/activity/query/service.js"
import type { ActivitySummary } from "../../../src/core/activity/storage/contract.js"
import {
	envelope,
	logger,
	openStore,
	roots,
	stores,
} from "../core/activity/storage/helpers.js"

const CHANNEL_HZ = 446_006_250
const DISCOVERY = "d_01JTESTROUTE"

afterEach(async () => {
	await Promise.all(stores.splice(0).map(s => s.close().catch(() => undefined)))
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

function voice(eventId: string, hz: number, onChannel: boolean) {
	const plain = envelope({
		eventId,
		category: "voice",
		outputType: "call_start",
		protocol: "dmr",
		entityKey: null,
		title: "TG 9 · radio 1",
		frequencyHz: hz,
	})
	return onChannel
		? withEnvelopeMetadata(plain, {
				channel: { discoveryId: DISCOVERY, frequencyHz: CHANNEL_HZ },
			})
		: plain
}

async function scene() {
	const store = await openStore()
	const service = createActivityQueryService({
		store,
		logger,
		execution: "inline",
	})
	return { store, service }
}

describe("activity routes: channels", () => {
	it("lists a channel's rows with their channel, says mixed for old rows, and counts the channel facet", async () => {
		const { store, service } = await scene()
		store.admit(voice("new-row", CHANNEL_HZ + 500, true))
		store.admit(voice("old-row", CHANNEL_HZ - 200, false))
		store.admit(voice("elsewhere", CHANNEL_HZ + 50_000, false))
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		try {
			const get = async (query: string) => {
				const res = await app.inject({
					method: "GET",
					url: `/api/activity?${query}`,
				})
				return {
					status: res.statusCode,
					body: res.json() as {
						items?: ActivitySummary[]
						channelMatch?: string
						fields?: { field: string }[]
					},
				}
			}
			const exact = await get(`channelHz=${CHANNEL_HZ}`)
			expect(exact.status).toBe(200)
			expect(exact.body.channelMatch).toBe("mixed")
			expect(exact.body.items?.map(i => i.eventId).sort()).toEqual([
				"new-row",
				"old-row",
			])
			expect(
				exact.body.items?.find(i => i.eventId === "new-row")?.channel,
			).toEqual({
				discoveryId: DISCOVERY,
				frequencyHz: CHANNEL_HZ,
			})
			const near = await get(`nearHz=${CHANNEL_HZ}&toleranceHz=50000`)
			expect(near.body.items).toHaveLength(3)
			for (const bad of [
				"toleranceHz=10",
				`channelHz=${CHANNEL_HZ}&nearHz=${CHANNEL_HZ}`,
				"channelHz=abc",
				`nearHz=${CHANNEL_HZ}&toleranceHz=1000001`,
			]) {
				const res = await get(bad)
				expect(res.status, bad).toBe(400)
			}
			const named = await get("channelHz=abc")
			expect(named.body.fields?.map(f => f.field)).toEqual(["channelHz"])
			const facets = await app.inject({
				method: "POST",
				url: "/api/activity/facets",
				payload: {
					query: { channelHz: CHANNEL_HZ },
					dimensions: ["channel", "kind"],
				},
			})
			expect(facets.statusCode).toBe(200)
			const body = facets.json() as {
				facets: Record<string, { value: string | null; count: number }[]>
				channelMatch?: string
			}
			expect(body.channelMatch).toBe("mixed")
			expect(body.facets["channel"]).toEqual([
				{ value: null, count: 1 },
				{ value: String(CHANNEL_HZ), count: 1 },
			])
			expect(
				(body.facets["channel"] ?? []).reduce((n, f) => n + f.count, 0),
			).toBe(exact.body.items?.length)
		} finally {
			await app.close()
			await service.close()
		}
	})
})

class Transport implements ActivityClientTransport {
	readonly delivered: ActivityWireMessage[] = []
	constructor(readonly key: string) {}
	send(message: ActivityWireMessage): boolean {
		this.delivered.push(message)
		return true
	}
	close(): void {}
}

describe("activity subscription: channels", () => {
	it("filters a channel's rows and carries their channel in its records", async () => {
		const { store, service } = await scene()
		const query = { channelHz: CHANNEL_HZ }
		// A cursor at an empty store's high water: the replay sends every later row of the query.
		const start = await service.search({ query })
		store.admit(voice("new-row", CHANNEL_HZ + 500, true))
		store.admit(voice("elsewhere", CHANNEL_HZ + 50_000, false))
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new Transport("client-a")
		try {
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "one",
				query,
				cursor: start.replayCursor,
			})
			const items = (): ActivitySummary[] =>
				transport.delivered.flatMap(m => {
					const message = m as {
						type?: string
						data?: { items?: ActivitySummary[] }
					}
					return message.type === "activity:records"
						? [...(message.data?.items ?? [])]
						: []
				})
			await expect.poll(() => items().length, { timeout: 5_000 }).toBe(1)
			expect(items()[0]).toMatchObject({
				eventId: "new-row",
				channel: { discoveryId: DISCOVERY, frequencyHz: CHANNEL_HZ },
			})
		} finally {
			hub.close()
			await service.close()
		}
	})
})
