import { describe, expect, it, vi } from "vitest"

import { EventsClient } from "../../src/data/events-client.ts"
import {
	TrailHistoryStore,
	withHistory,
} from "../../src/data/trail-history-store.ts"
import { json, scripted } from "./fake-fetch.ts"
import { fakeSockets } from "./fake-socket.ts"

const CORE_NOW = Date.parse("2026-10-17T10:00:00.000Z")
/** The browser's clock runs 5 s ahead of the core's. */
const LOCAL_NOW = CORE_NOW + 5000

function answer(points: [number, number, number, number | null][]) {
	return {
		producedFrom: "2026-10-17T09:00:00.000Z",
		producedTo: "2026-10-17T10:00:00.000Z",
		trails: [
			{
				entityKey: "mmsi:227300410",
				category: "marine",
				protocol: "ais",
				points,
				truncated: false,
			},
		],
		pointCount: points.length,
		scannedRows: points.length,
		skippedRows: 0,
		truncated: false,
		truncation: [],
		retentionFloor: "2026-10-14T10:00:00.000Z",
		generatedAt: "2026-10-17T10:00:00.000Z",
	}
}

function events() {
	const sockets = fakeSockets()
	const client = new EventsClient({
		url: "ws://x/ws",
		createSocket: sockets.factory,
	})
	return client
}

describe("TrailHistoryStore", () => {
	it("reads the stored trails once, in this browser's clock, by entity key", async () => {
		const { api, calls } = scripted(() =>
			json(
				200,
				answer([
					[CORE_NOW - 120_000, 48.7, -4, null],
					[CORE_NOW - 60_000, 48.71, -3.99, 12],
				]),
			),
		)
		const store = new TrailHistoryStore(api, events(), {
			now: () => LOCAL_NOW,
		})
		const detach = store.attach()
		await vi.waitFor(() => expect(store.get().status).toBe("ready"))
		expect(calls.map(c => c.url)).toEqual([
			"/api/activity/trails?categories=aircraft,marine,voice,paging,aprs,sensors,mesh,other",
		])
		expect(store.get().trails.get("mmsi:227300410")).toEqual([
			{ lat: 48.7, lon: -4, at: LOCAL_NOW - 120_000 },
			{ lat: 48.71, lon: -3.99, at: LOCAL_NOW - 60_000 },
		])
		detach()
	})

	it("says when the core has no trails route", async () => {
		const { api } = scripted(() =>
			json(404, { error: "Not Found", code: "NOT_FOUND", message: "x" }),
		)
		const store = new TrailHistoryStore(api, events())
		store.attach()
		await vi.waitFor(() => expect(store.get().status).toBe("unavailable"))
		expect(store.get().trails.size).toBe(0)
	})

	it("keeps the last trails when a later read fails", async () => {
		let n = 0
		const { api } = scripted(() => {
			n += 1
			return n === 1
				? json(200, answer([[CORE_NOW - 60_000, 48.7, -4, null]]))
				: json(500, { error: "x", code: "INTERNAL", message: "x" })
		})
		const store = new TrailHistoryStore(api, events())
		await store.load()
		await store.load()
		expect(store.get().status).toBe("ready")
		expect(store.get().error).not.toBeNull()
		expect(store.get().trails.size).toBe(1)
	})
})

describe("withHistory", () => {
	const p = (at: number) => ({ lat: 48, lon: -4, at })

	it("puts the stored points older than the live trail in front of it", () => {
		expect(
			withHistory([p(300), p(400)], [p(100), p(200), p(300), p(350)]),
		).toEqual([p(100), p(200), p(300), p(400)])
	})

	it("keeps the live trail alone when nothing stored is older", () => {
		const live = [p(100)]
		expect(withHistory(live, [p(150)])).toBe(live)
		expect(withHistory(live, undefined)).toBe(live)
		expect(withHistory([], [p(10)])).toEqual([p(10)])
	})
})
