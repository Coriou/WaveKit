import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage, ActivitySummary } from "@wavekit/api-types"

import { ApiClient } from "../../src/data/api-client.ts"
import { ActivityFeed, joins } from "../../src/data/activity-feed.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import type { DataLayer } from "../../src/data/index.ts"
import { ActivityController } from "../../src/features/activity/controller.ts"
import { foldedOf } from "../../src/features/activity/fold.ts"
import { fakeSockets } from "../data/fake-socket.ts"

const T0 = Date.parse("2026-10-17T08:00:00.000Z")

/** Synthetic aircraft decodes, one per second: seq n is heard at T0 + n s. */
function aircraft(
	n: number,
	over: Partial<ActivitySummary> = {},
): ActivitySummary {
	const iso = new Date(T0 + n * 1000).toISOString()
	return {
		eventId: `evt_${n}`,
		commitSeq: String(n),
		kind: "decoder-reception",
		producedAt: iso,
		receivedAt: iso,
		decoderId: "readsb",
		sourceId: null,
		protocol: "adsb",
		category: "aircraft",
		frequencyHz: 1_090_000_000,
		entityKey: "icao:ABC123",
		title: n % 10 === 0 ? "WKT101" : "ABC123",
		fields: [],
		...over,
	}
}

const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => aircraft(to - i))

function page(
	items: ActivitySummary[],
	next: string | null,
): ActivitySearchPage {
	const top = items[0]?.commitSeq ?? "0"
	return {
		items,
		nextPageToken: next,
		replayCursor: `c:${top}`,
		snapshot: { lowBarrier: "0", highWater: top, expiresAt: "x" },
		searchCoverage: "bounded-projection",
	}
}

/** A core whose snapshot answer can be changed and held between requests. */
function setup() {
	let answer: ActivitySearchPage = page([], null)
	let gate: Promise<void> = Promise.resolve()
	const urls: string[] = []
	const api = new ApiClient({
		fetch: async url => {
			urls.push(url)
			await gate
			return new Response(JSON.stringify(answer), { status: 200 })
		},
	})
	const sockets = fakeSockets()
	const events = new EventsClient({ createSocket: sockets.factory })
	events.connect()
	sockets.last().open()
	const subscribed = () =>
		sockets
			.last()
			.sent.filter(
				m => (m as { type?: string }).type === "activity:subscribe",
			) as { id: string }[]
	const push = (items: ActivitySummary[]) =>
		sockets.last().receive({
			type: "activity:records",
			channel: "activity",
			data: {
				id: subscribed().at(-1)?.id ?? "",
				items,
				scannedThrough: "9",
				cursor: "c:9",
			},
		})
	return {
		api,
		events,
		urls,
		push,
		serve: (p: ActivitySearchPage) => {
			answer = p
		},
		hold: () => {
			let release = () => undefined as void
			gate = new Promise<void>(r => {
				release = r
			})
			return () => release()
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("activity live folding", () => {
	it("folds a live decode into the existing stack, which keeps its key and moves to the top", async () => {
		const core = setup()
		const other = aircraft(30, {
			eventId: "evt_other",
			entityKey: "icao:DEF456",
			title: "DEF456",
		})
		core.serve(page([other, ...range(1, 20)], null))
		const feed = new ActivityFeed(core.api, core.events, {
			flushMs: 20,
			id: "fold",
		})
		await feed.setQuery({})
		const before = foldedOf(feed.get().items)
		expect(before.map(s => s.members.length)).toEqual([1, 20])
		const key = before[1]?.key
		core.push([aircraft(40)])
		await vi.waitFor(() => expect(feed.get().items).toHaveLength(22))
		const after = foldedOf(feed.get().items)
		expect(after).toHaveLength(2)
		expect(after[0]?.key).toBe(key)
		expect(after[0]?.members).toHaveLength(21)
		expect(after[0]?.latest.eventId).toBe("evt_40")
		// the latest state keeps the callsign an older row carried
		expect(after[0]?.view.title).toBe("WKT101")
	})

	it("moves nothing while the list is scrolled away: arrivals wait, then fold in", async () => {
		const core = setup()
		core.serve(page(range(1, 5), null))
		const feed = new ActivityFeed(core.api, core.events, {
			flushMs: 20,
			id: "hold",
		})
		await feed.setQuery({})
		const items = feed.get().items
		feed.setHolding(true)
		core.push([aircraft(6), aircraft(7)])
		await vi.waitFor(() => expect(feed.get().pending).toHaveLength(2))
		expect(feed.get().items).toBe(items)
		feed.setHolding(false)
		const [stack] = foldedOf(feed.get().items)
		expect(stack?.members).toHaveLength(7)
		expect(stack?.key).toBe(foldedOf(items)[0]?.key)
	})

	it("starts a new stack when the aircraft was silent longer than the gap", async () => {
		const core = setup()
		core.serve(page(range(1, 5), null))
		const feed = new ActivityFeed(core.api, core.events, {
			flushMs: 20,
			id: "gap",
		})
		await feed.setQuery({})
		// 5 s + 121 s: past the aircraft's 120 s gap
		core.push([aircraft(126)])
		await vi.waitFor(() => expect(feed.get().items).toHaveLength(6))
		expect(foldedOf(feed.get().items).map(s => s.members.length)).toEqual([
			1, 5,
		])
	})
})

describe("activity cache across close and open", () => {
	it("renders the cached list at once on reopen and merges the overlapping snapshot behind it", async () => {
		const core = setup()
		core.serve(page(range(1, 10), null))
		const c = new ActivityController({
			api: core.api,
			events: core.events,
		} as unknown as DataLayer)
		const detach = c.attach()
		await vi.waitFor(() => expect(c.feed.get().status).toBe("live"))
		const key = foldedOf(c.feed.get().items)[0]?.key
		detach()

		// reopen while the core is slow: the cache shows, marked as refreshing
		const release = core.hold()
		core.serve(page(range(8, 12), "p:2"))
		const again = c.attach()
		expect(c.feed.get().items).toHaveLength(10)
		expect(c.feed.get().status).toBe("loading")
		release()
		await vi.waitFor(() => expect(c.feed.get().status).toBe("live"))
		expect(c.feed.get().items.map(i => i.commitSeq)).toEqual(
			range(1, 12).map(i => i.commitSeq),
		)
		// the same stack, still keyed from its start
		expect(foldedOf(c.feed.get().items)[0]?.key).toBe(key)
		expect(foldedOf(c.feed.get().items)[0]?.members).toHaveLength(12)
		again()
		c.dispose()
	})

	it("drops the cache when the snapshot cannot join it", () => {
		const cache = range(1, 5)
		// a hole: the snapshot's oldest (8) is newer than the cache's newest (5), so 6 and 7 could be missing
		expect(joins(range(8, 12), cache, false)).toBe(false)
		// reaches the cache's newest row exactly: joins
		expect(joins(range(5, 12), cache, false)).toBe(true)
		// a complete snapshot is everything stored: it replaces the cache
		expect(joins(range(5, 12), cache, true)).toBe(false)
		expect(joins(range(5, 12), [], false)).toBe(false)
	})

	it("replaces the cache with a snapshot that leaves a hole after it", async () => {
		const core = setup()
		core.serve(page(range(1, 5), null))
		const feed = new ActivityFeed(core.api, core.events, { id: "hole" })
		await feed.setQuery({})
		feed.stop()
		core.serve(page(range(200, 210), "p:2"))
		await feed.setQuery({})
		expect(feed.get().items.map(i => i.commitSeq)).toEqual(
			range(200, 210).map(i => i.commitSeq),
		)
	})

	it("opens a stack's newest event with the stack's latest state", async () => {
		const core = setup()
		core.serve(page(range(1, 12), null))
		const c = new ActivityController({
			api: core.api,
			events: core.events,
		} as unknown as DataLayer)
		const detach = c.attach()
		await vi.waitFor(() => expect(c.feed.get().status).toBe("live"))
		const newest = c.feed.get().items[0]
		expect(newest?.title).toBe("ABC123")
		c.noteOpenFeed(c.feed)
		c.open(newest ?? null)
		expect(c.get().openItem?.title).toBe("WKT101")
		expect(c.get().openItem?.eventId).toBe(newest?.eventId)
		expect(c.stackFor(newest?.eventId ?? "")?.members).toHaveLength(12)
		// an older member opens as stored
		const older = c.feed.get().items[5]
		c.open(older ?? null)
		expect(c.get().openItem).toBe(older)
		detach()
		c.dispose()
	})
})
