import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage, ActivitySummary } from "@wavekit/api-types"
import { ApiClient } from "../../src/data/api-client.ts"
import {
	ActivityFeed,
	compareSeq,
	mergeNewest,
	queryParams,
} from "../../src/data/activity-feed.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { fakeSockets } from "./fake-socket.ts"

const T0 = Date.parse("2026-10-17T08:00:00.000Z")

function summary(
	seq: number,
	over: Partial<ActivitySummary> = {},
): ActivitySummary {
	const iso = new Date(T0 + seq * 1000).toISOString()
	return {
		eventId: `evt_${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: iso,
		receivedAt: iso,
		decoderId: "pocsag",
		sourceId: "pi",
		protocol: "pocsag",
		category: "paging",
		frequencyHz: 160_450_000,
		entityKey: `pocsag:${seq}`,
		title: `Capcode ${seq}`,
		fields: [],
		...over,
	}
}

function page(
	items: ActivitySummary[],
	next: string | null,
	top: number,
): ActivitySearchPage {
	return {
		items,
		nextPageToken: next,
		replayCursor: `c:${top}`,
		snapshot: { lowBarrier: "0", highWater: String(top), expiresAt: "x" },
		searchCoverage: "bounded-projection",
	}
}

function setup(pages: (url: string) => unknown) {
	const urls: string[] = []
	const api = new ApiClient({
		fetch: async url => {
			urls.push(url)
			return new Response(JSON.stringify(pages(url)), { status: 200 })
		},
	})
	const sockets = fakeSockets()
	const events = new EventsClient({ createSocket: sockets.factory })
	events.connect()
	sockets.last().open()
	const feed = new ActivityFeed(api, events, { flushMs: 50, id: "t" })
	const subscribes = () =>
		sockets
			.last()
			.sent.filter(
				m => (m as { type?: string }).type === "activity:subscribe",
			) as {
			id: string
			cursor?: string
			query: unknown
		}[]
	const push = (id: string, items: ActivitySummary[]) =>
		sockets.last().receive({
			type: "activity:records",
			channel: "activity",
			data: { id, items, scannedThrough: "9", cursor: "c:9" },
		})
	return { api, urls, sockets, events, feed, subscribes, push }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("activity feed helpers", () => {
	it("orders decimal commit sequences without number precision", () => {
		expect(compareSeq("9", "10")).toBeLessThan(0)
		expect(compareSeq("9007199254740993", "9007199254740992")).toBeGreaterThan(
			0,
		)
		expect(compareSeq("42", "42")).toBe(0)
	})

	it("merges newest first, drops duplicates and caps the list", () => {
		const list = [summary(3), summary(2)]
		const merged = mergeNewest(list, [summary(4), summary(3), summary(1)])
		expect(merged.map(i => i.commitSeq)).toEqual(["4", "3", "2", "1"])
		expect(mergeNewest(merged, [summary(5)], 2).map(i => i.commitSeq)).toEqual([
			"5",
			"4",
		])
	})

	it("writes the core's flat query parameters", () => {
		expect(
			queryParams({
				categories: ["voice", "paging"],
				frequencyHz: { min: 1, max: 2 },
				entityKey: "pocsag:1",
				text: "",
			}),
		).toEqual({
			categories: "voice,paging",
			frequencyMin: 1,
			frequencyMax: 2,
			entityKey: "pocsag:1",
		})
	})
})

describe("ActivityFeed", () => {
	it("loads the snapshot, then follows live from its replay cursor", async () => {
		const { feed, urls, subscribes } = setup(() =>
			page([summary(2), summary(1)], "p:2", 2),
		)
		await feed.setQuery({ categories: ["paging"] })
		expect(urls[0]).toContain(
			"/api/activity?categories=paging&order=desc&limit=100",
		)
		const s = feed.get()
		expect(s.status).toBe("live")
		expect(s.items.map(i => i.eventId)).toEqual(["evt_2", "evt_1"])
		expect(s.nextPageToken).toBe("p:2")
		// The core accepts subscription ids of [A-Za-z0-9_-] only.
		expect(subscribes()[0]?.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
		expect(subscribes()).toEqual([
			{
				type: "activity:subscribe",
				id: "t-1",
				query: { categories: ["paging"] },
				cursor: "c:2",
			},
		])
	})

	it("batches live records into one update and ignores other feeds", async () => {
		vi.useFakeTimers()
		const { feed, push, subscribes } = setup(() => page([summary(1)], null, 1))
		await feed.setQuery({})
		const id = subscribes()[0]?.id ?? ""
		const updates = vi.fn()
		feed.subscribe(updates)
		push(id, [summary(2)])
		push(id, [summary(3), summary(4)])
		push("someone-else", [summary(9)])
		expect(updates).not.toHaveBeenCalled()
		vi.advanceTimersByTime(60)
		expect(updates).toHaveBeenCalledTimes(1)
		expect(feed.get().items.map(i => i.commitSeq)).toEqual(["4", "3", "2", "1"])
	})

	it("holds arrivals while paused or scrolled away, then releases them", async () => {
		vi.useFakeTimers()
		const { feed, push, subscribes } = setup(() => page([summary(1)], null, 1))
		await feed.setQuery({})
		const id = subscribes()[0]?.id ?? ""
		feed.setHolding(true)
		push(id, [summary(2)])
		vi.advanceTimersByTime(60)
		expect(feed.get().items).toHaveLength(1)
		expect(feed.get().pending.map(i => i.commitSeq)).toEqual(["2"])
		feed.setHolding(false)
		expect(feed.get().items.map(i => i.commitSeq)).toEqual(["2", "1"])
		feed.setPaused(true)
		push(id, [summary(3)])
		vi.advanceTimersByTime(60)
		expect(feed.get().pending).toHaveLength(1)
		feed.setPaused(false)
		expect(feed.get().pending).toHaveLength(0)
		expect(feed.get().items[0]?.commitSeq).toBe("3")
	})

	it("pages older rows with the snapshot's token", async () => {
		const { feed, urls } = setup(url =>
			url.includes("pageToken")
				? page([summary(1)], null, 3)
				: page([summary(3), summary(2)], "p:2:3", 3),
		)
		await feed.setQuery({})
		await feed.loadMore()
		expect(urls[1]).toContain("pageToken=p%3A2%3A3")
		expect(feed.get().items.map(i => i.commitSeq)).toEqual(["3", "2", "1"])
		expect(feed.get().nextPageToken).toBeNull()
	})

	it("reloads and resubscribes after a replay reset, and says so", async () => {
		let top = 2
		const { feed, sockets, subscribes } = setup(() =>
			page([summary(top)], null, top),
		)
		await feed.setQuery({})
		const first = subscribes()[0]?.id ?? ""
		top = 5
		sockets.last().receive({
			type: "activity:reset",
			channel: "activity",
			data: { id: first, reason: "cursor-gap" },
		})
		await vi.waitFor(() => expect(subscribes()).toHaveLength(2))
		expect(subscribes()[1]?.cursor).toBe("c:5")
		expect(subscribes()[1]?.id).not.toBe(first)
		expect(feed.get().reset).toBe("cursor-gap")
		expect(feed.get().items[0]?.commitSeq).toBe("5")
	})

	it("shows Activity as unavailable when the core has it off", async () => {
		const api = new ApiClient({
			fetch: async () =>
				new Response(
					JSON.stringify({ code: "ACTIVITY_DISABLED", message: "off" }),
					{ status: 503 },
				),
		})
		const feed = new ActivityFeed(
			api,
			new EventsClient({ createSocket: fakeSockets().factory }),
		)
		await feed.setQuery({})
		expect(feed.get()).toMatchObject({ status: "error", available: false })
	})

	it("clears for a search that cannot match", async () => {
		const { feed, urls } = setup(() => page([], null, 0))
		await feed.setQuery(null)
		expect(feed.get().status).toBe("idle")
		expect(urls).toHaveLength(0)
	})
})
