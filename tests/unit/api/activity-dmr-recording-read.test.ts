/**
 * A stored dsd-fme recording link is presented only while its file may be served
 * (dsdFmeNameServable): a DMR call link stored before the DMR recording gate closed and a call
 * name with a label off the allow-list are not presented on the REST list or the WebSocket
 * records, a P25 link and dv call recorder links are (decided by the row's decoder, so a
 * recorder name of a decoder whose id starts with `dmr` is presented). Synthetic rows only.
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
import { createActivityQueryService } from "../../../src/core/activity/query/service.js"
import type { ActivitySummary } from "../../../src/core/activity/storage/contract.js"
import {
	envelope,
	logger,
	openStore,
	roots,
	stores,
} from "../core/activity/storage/helpers.js"

const DMR_KEY = "dsd~20261012_100000_12345_DMR_CC_1_GROUP_TGT_9_SRC_2001.wav"
const P25_KEY = "dsd~20261012_100100_12346_P25_1A3_GROUP_TGT_9_SRC_2002.wav"
/** The dv call recorder's name: its first field is the decoder id, not a protocol. */
const DV_KEY = "dsd~20261012_100200_12347_dsd-fme_GROUP_TGT_9_SRC_2003.wav"
/** The dv call recorder's name of decoder `dmr-main`: its field reads `dmr` as a protocol. */
const DV_DMR_ID_KEY =
	"dsd~20261012_100300_12348_dmr-main_GROUP_TGT_9_SRC_2004.wav"
/** A dsd-fme call name whose label is not on the recordable allow-list. */
const FOO_KEY = "dsd~20261012_100400_12349_FOO_1_GROUP_TGT_9_SRC_2005.wav"

afterEach(async () => {
	await Promise.all(stores.splice(0).map(s => s.close().catch(() => undefined)))
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

type Store = Awaited<ReturnType<typeof openStore>>

function admitCalls(store: Store): void {
	store.admit(
		envelope({
			eventId: "dmr-call",
			category: "voice",
			outputType: "call_end",
			protocol: "dmr",
			entityKey: null,
		}),
		undefined,
		{ id: DMR_KEY, durationMs: 4200 },
	)
	store.admit(
		envelope({
			eventId: "p25-call",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
		}),
		undefined,
		{ id: P25_KEY, durationMs: 3100 },
	)
	store.admit(
		envelope({
			eventId: "dv-call",
			decoderId: "dsd-fme",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
		}),
		undefined,
		{ id: DV_KEY, durationMs: 2000 },
	)
	store.admit(
		envelope({
			eventId: "dv-dmr-id-call",
			decoderId: "dmr-main",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
		}),
		undefined,
		{ id: DV_DMR_ID_KEY, durationMs: 1500 },
	)
	store.admit(
		envelope({
			eventId: "foo-call",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
		}),
		undefined,
		{ id: FOO_KEY, durationMs: 1200 },
	)
}

function expectPresented(items: readonly ActivitySummary[]): void {
	expect(recordingOf(items, "dv-call")).toEqual({
		id: DV_KEY,
		durationMs: 2000,
	})
	expect(recordingOf(items, "dv-dmr-id-call")).toEqual({
		id: DV_DMR_ID_KEY,
		durationMs: 1500,
	})
	expect(recordingOf(items, "p25-call")).toEqual({
		id: P25_KEY,
		durationMs: 3100,
	})
	expect(recordingOf(items, "dmr-call")).toBeUndefined()
	expect(recordingOf(items, "foo-call")).toBeUndefined()
}

const recordingOf = (items: readonly ActivitySummary[], eventId: string) =>
	items.find(i => i.eventId === eventId)?.recording

class Transport implements ActivityClientTransport {
	readonly delivered: ActivityWireMessage[] = []
	constructor(readonly key: string) {}
	send(message: ActivityWireMessage): boolean {
		this.delivered.push(message)
		return true
	}
	close(): void {}
}

/**
 * The seeded shape of the WG25 acceptance (modelled: shape from a private state, ids
 * synthetic): six dsd-fme DMR call_end rows linked by the baseline image, five to dsd-fme DMR
 * names (a two-digit colour code included) and one to a name whose system field dsd-fme left
 * empty, one of them through its late file update (wavFileUpdate). A P25 row stays presented.
 */
const SEEDED_DMR_KEYS = [
	"dsd~20261012_110000_10001_DMR_CC_11_GROUP_TGT_90001_SRC_901.wav",
	"dsd~20261012_110010_10002_DMR_CC_11_GROUP_TGT_90001_SRC_902.wav",
	"dsd~20261012_110020_10003_DMR_CC_11_GROUP_TGT_90001_SRC_903.wav",
	"dsd~20261012_110030_10004_DMR_CC_1_GROUP_TGT_90002_SRC_904.wav",
	"dsd~20261012_110040_10005_DMR_CC_11_GROUP_TGT_90001_SRC_9.wav",
	"dsd~20261012_110050_10006__GROUP_TGT_9_SRC_9.wav",
]

function admitSeeded(store: Store): void {
	SEEDED_DMR_KEYS.forEach((id, i) =>
		store.admit(
			envelope({
				eventId: `seeded-dmr-${i}`,
				decoderId: "dsd-fme",
				category: "voice",
				outputType: "call_end",
				protocol: "dmr",
				entityKey: null,
				decodedData:
					i === 2
						? { callId: `c${i}`, flags: { wavFileUpdate: true } }
						: { callId: `c${i}` },
			}),
			undefined,
			{ id, durationMs: 1000 + i },
		),
	)
	store.admit(
		envelope({
			eventId: "seeded-p25",
			decoderId: "dsd-fme",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
		}),
		undefined,
		{ id: P25_KEY, durationMs: 3100 },
	)
}

function expectSeededHidden(items: readonly ActivitySummary[], body: string) {
	for (let i = 0; i < SEEDED_DMR_KEYS.length; i++)
		expect(recordingOf(items, `seeded-dmr-${i}`)).toBeUndefined()
	for (const key of SEEDED_DMR_KEYS)
		expect(body).not.toContain(key.slice("dsd~".length))
	expect(recordingOf(items, "seeded-p25")).toEqual({
		id: P25_KEY,
		durationMs: 3100,
	})
}

describe("activity: rows a baseline image linked to DMR call files (seeded store)", () => {
	it("the REST list and a hasRecording query never present their recording", async () => {
		const store = await openStore()
		admitSeeded(store)
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		try {
			const all = await app.inject({ method: "GET", url: "/api/activity" })
			expect(all.statusCode).toBe(200)
			const items = (all.json() as { items: ActivitySummary[] }).items
			expect(items).toHaveLength(SEEDED_DMR_KEYS.length + 1)
			expectSeededHidden(items, all.body)
			// The stored link still matches hasRecording until the link sweep removes it
			// (recording-links.ts; the catalogue answers false for these keys at once), but no
			// row of that page presents a DMR recording either.
			const linked = await app.inject({
				method: "GET",
				url: "/api/activity?hasRecording=true",
			})
			expect(linked.statusCode).toBe(200)
			expectSeededHidden(
				(linked.json() as { items: ActivitySummary[] }).items,
				linked.body,
			)
		} finally {
			await app.close()
			await service.close()
		}
	})

	it("the WebSocket records never present their recording", async () => {
		const store = await openStore()
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const start = await service.search({ query: {} })
		admitSeeded(store)
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new Transport("client-seeded")
		try {
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "seeded",
				query: {},
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
			await expect
				.poll(() => items().length, { timeout: 5_000 })
				.toBe(SEEDED_DMR_KEYS.length + 1)
			expectSeededHidden(items(), JSON.stringify(transport.delivered))
		} finally {
			hub.close()
			await service.close()
		}
	})
})

describe("activity: dsd-fme recording links at read time", () => {
	it("the REST list presents P25 and dv recorder links, never a stored DMR or unlisted-label link", async () => {
		const store = await openStore()
		admitCalls(store)
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		try {
			const res = await app.inject({ method: "GET", url: "/api/activity" })
			expect(res.statusCode).toBe(200)
			const items = (res.json() as { items: ActivitySummary[] }).items
			expect(items.map(i => i.eventId).sort()).toEqual([
				"dmr-call",
				"dv-call",
				"dv-dmr-id-call",
				"foo-call",
				"p25-call",
			])
			expectPresented(items)
			expect(res.body).not.toContain(DMR_KEY)
			expect(res.body).not.toContain(FOO_KEY)
		} finally {
			await app.close()
			await service.close()
		}
	})

	it("the WebSocket records present P25 and dv recorder links, never a stored DMR or unlisted-label link", async () => {
		const store = await openStore()
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const start = await service.search({ query: {} })
		admitCalls(store)
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new Transport("client-a")
		try {
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "one",
				query: {},
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
			await expect.poll(() => items().length, { timeout: 5_000 }).toBe(5)
			expectPresented(items())
			expect(JSON.stringify(transport.delivered)).not.toContain(DMR_KEY)
			expect(JSON.stringify(transport.delivered)).not.toContain(FOO_KEY)
		} finally {
			hub.close()
			await service.close()
		}
	})
})
