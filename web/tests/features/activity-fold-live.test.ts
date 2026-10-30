import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivitySearchPage, ActivitySummary } from "@wavekit/api-types"

import { ApiClient } from "../../src/data/api-client.ts"
import { ActivityFeed, joins } from "../../src/data/activity-feed.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import type { DataLayer } from "../../src/data/index.ts"
import { ActivityController } from "../../src/features/activity/controller.ts"
import { foldedOf, knownFor } from "../../src/features/activity/fold.ts"
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
		const before = foldedOf(feed.get().items, feed)
		expect(before.map(s => s.members.length)).toEqual([1, 20])
		const key = before[1]?.key
		core.push([aircraft(40)])
		await vi.waitFor(() => expect(feed.get().items).toHaveLength(22))
		const after = foldedOf(feed.get().items, feed)
		expect(after).toHaveLength(2)
		expect(after[0]?.key).toBe(key)
		expect(after[0]?.members).toHaveLength(21)
		expect(after[0]?.latest.eventId).toBe("evt_40")
		// the row shows the callsign an older row carried (identity only)
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
		const [stack] = foldedOf(feed.get().items, feed)
		expect(stack?.members).toHaveLength(7)
		expect(stack?.key).toBe(foldedOf(items, feed)[0]?.key)
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
		expect(foldedOf(feed.get().items, feed).map(s => s.members.length)).toEqual(
			[1, 5],
		)
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
		const key = foldedOf(c.feed.get().items, c.feed)[0]?.key
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
		expect(foldedOf(c.feed.get().items, c.feed)[0]?.key).toBe(key)
		expect(foldedOf(c.feed.get().items, c.feed)[0]?.members).toHaveLength(12)
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

	it("drops cached rows the reopened snapshot's retention barrier has pruned", async () => {
		const core = setup()
		core.serve(page(range(1, 300), null))
		const feed = new ActivityFeed(core.api, core.events, { id: "barrier" })
		await feed.setQuery({})
		expect(feed.get().items).toHaveLength(300)
		feed.stop()
		// the store pruned everything up to 150 meanwhile; the snapshot has more pages
		core.serve({
			...page(range(250, 349), "p:2"),
			snapshot: { lowBarrier: "150", highWater: "349", expiresAt: "x" },
		})
		await feed.setQuery({})
		const seqs = feed.get().items.map(i => Number(i.commitSeq))
		expect(seqs.every(n => n > 150)).toBe(true)
		expect(seqs).toEqual(range(151, 349).map(i => Number(i.commitSeq)))
		// everything below the barrier is pruned and 151-249 are held: no page left to fetch
		expect(feed.get().nextPageToken).toBeNull()
	})

	it("drops a cached row the reopened snapshot's range no longer holds", async () => {
		const core = setup()
		core.serve(page(range(1, 300), null))
		const feed = new ActivityFeed(core.api, core.events, { id: "gone" })
		await feed.setQuery({})
		feed.stop()
		const fresh = range(250, 349).filter(i => i.commitSeq !== "260")
		const retitled = fresh.map(i =>
			i.commitSeq === "270" ? { ...i, title: "WKT270" } : i,
		)
		core.serve(page(retitled, "p:2"))
		await feed.setQuery({})
		const items = feed.get().items
		expect(items.some(i => i.commitSeq === "260")).toBe(false)
		expect(items).toHaveLength(348)
		// a row in both is taken as the snapshot has it
		expect(items.find(i => i.commitSeq === "270")?.title).toBe("WKT270")
	})

	it("opens an event exactly as stored, with what earlier rows knew kept apart", async () => {
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
		expect(c.get().openItem).toBe(newest)
		const stack = c.stackFor(newest?.eventId ?? "")
		expect(stack?.members).toHaveLength(12)
		// the detail's "Latest known" block: the callsign title from evt_10
		const known = stack && newest ? knownFor(stack, newest) : null
		expect(known?.title?.value).toBe("WKT101")
		expect(known?.title?.from.eventId).toBe("evt_10")
		const older = c.feed.get().items[5]
		c.open(older ?? null)
		expect(c.get().openItem).toBe(older)
		// evt_7 was heard before evt_10 named it: nothing from a later row
		expect(older?.eventId).toBe("evt_7")
		expect(stack && older ? knownFor(stack, older) : null).toEqual({
			title: null,
			fields: [],
		})
		detach()
		c.dispose()
	})

	it("pages on after a reopen from the cache's own token, never re-fetching cached rows", async () => {
		const core = setup()
		// first open: 201-300, more behind "p:cache"
		core.serve(page(range(201, 300), "p:cache"))
		const feed = new ActivityFeed(core.api, core.events, { id: "token" })
		await feed.setQuery({})
		feed.stop()
		// reopen: the snapshot 290-320 joins the cache; its own next page would start at 289
		core.serve(page(range(290, 320), "p:snapshot"))
		await feed.setQuery({})
		expect(feed.get().items).toHaveLength(120)
		expect(feed.get().nextPageToken).toBe("p:cache")
		core.serve(page(range(101, 200), null))
		await feed.loadMore()
		expect(core.urls.at(-1)).toContain("pageToken=p%3Acache")
		expect(feed.get().items).toHaveLength(220)
		expect(feed.get().nextPageToken).toBeNull()
	})

	it("falls back to the snapshot's token when the core no longer takes the cache's", async () => {
		let reject = false
		const seen: string[] = []
		const answer = { current: page(range(201, 300), "p:cache") }
		const api = new ApiClient({
			fetch: async url => {
				seen.push(url)
				if (reject && url.includes("pageToken=p%3Acache"))
					return new Response(JSON.stringify({ error: "expired" }), {
						status: 400,
					})
				return new Response(JSON.stringify(answer.current), { status: 200 })
			},
		})
		const core = setup()
		const feed = new ActivityFeed(api, core.events, { id: "expired" })
		await feed.setQuery({})
		feed.stop()
		answer.current = page(range(290, 320), "p:snapshot")
		await feed.setQuery({})
		reject = true
		answer.current = page(range(190, 289), null)
		await feed.loadMore()
		expect(seen.at(-2)).toContain("pageToken=p%3Acache")
		expect(seen.at(-1)).toContain("pageToken=p%3Asnapshot")
		expect(feed.get().error).toBeNull()
		expect(feed.get().items).toHaveLength(131)
	})

	it("a stale older page answering after a reopen keeps the reopened fallback token", async () => {
		let reject = false
		let release: (() => void) | null = null
		const seen: string[] = []
		const answer = { current: page(range(201, 300), "p:cache") }
		const api = new ApiClient({
			fetch: async url => {
				seen.push(url)
				if (url.includes("pageToken") && release === null) {
					// the first older-page request answers only after the reopen
					await new Promise<void>(r => {
						release = r
					})
					return new Response(JSON.stringify(page(range(101, 200), null)))
				}
				if (reject && url.includes("pageToken=p%3Acache"))
					return new Response(JSON.stringify({ error: "expired" }), {
						status: 400,
					})
				return new Response(JSON.stringify(answer.current), { status: 200 })
			},
		})
		const core = setup()
		const feed = new ActivityFeed(api, core.events, { id: "stale" })
		await feed.setQuery({})
		const stale = feed.loadMore()
		feed.stop()
		answer.current = page(range(290, 320), "p:snapshot")
		await feed.setQuery({})
		;(release as (() => void) | null)?.()
		await stale
		reject = true
		answer.current = page(range(190, 289), null)
		await feed.loadMore()
		expect(seen.at(-2)).toContain("pageToken=p%3Acache")
		expect(seen.at(-1)).toContain("pageToken=p%3Asnapshot")
		expect(feed.get().error).toBeNull()
		expect(feed.get().items).toHaveLength(131)
	})

	it("pages on after a rolling range moved with the cache token's own query, never re-fetching cached rows", async () => {
		const firstFrom = new Date(T0).toISOString()
		const movedFrom = new Date(T0 + 150_000).toISOString()
		const seen: URLSearchParams[] = []
		const answer = { current: page(range(201, 300), "p:cache") }
		const api = new ApiClient({
			fetch: async url => {
				const params = new URL(String(url), "http://core").searchParams
				seen.push(params)
				// the core binds a cursor to its exact query
				if (
					params.get("pageToken") === "p:cache" &&
					params.get("producedFrom") !== firstFrom
				)
					return new Response(JSON.stringify({ error: "query-changed" }), {
						status: 400,
					})
				return new Response(JSON.stringify(answer.current), { status: 200 })
			},
		})
		const core = setup()
		const feed = new ActivityFeed(api, core.events, { id: "rolling" })
		await feed.setQuery({ producedAt: { from: firstFrom } }, "Last hour")
		feed.stop()
		// "Last hour" advanced; the snapshot 290-320 joins the cache 201-300
		answer.current = page(range(290, 320), "p:snapshot")
		await feed.setQuery({ producedAt: { from: movedFrom } }, "Last hour")
		expect(feed.get().items).toHaveLength(120)
		// the old query's next page: 101-200, of which 150-200 are inside the moved range
		answer.current = page(range(101, 200), null)
		await feed.loadMore()
		const last = seen.at(-1)
		expect(last?.get("pageToken")).toBe("p:cache")
		expect(last?.get("producedFrom")).toBe(firstFrom)
		expect(seen.some(p => p.get("pageToken") === "p:snapshot")).toBe(false)
		expect(feed.get().error).toBeNull()
		expect(feed.get().items).toHaveLength(120 + 51)
		const from = Date.parse(movedFrom)
		expect(feed.get().items.every(i => Date.parse(i.producedAt) >= from)).toBe(
			true,
		)
		expect(feed.get().nextPageToken).toBeNull()
	})

	it("stops paging a moved range's stale days: to the snapshot's token with the current query, else the end", async () => {
		const firstFrom = new Date(T0).toISOString()
		const seen: URLSearchParams[] = []
		const answer = { current: page(range(201, 300), "p:cache") }
		const api = new ApiClient({
			fetch: async url => {
				seen.push(new URL(String(url), "http://core").searchParams)
				return new Response(JSON.stringify(answer.current), { status: 200 })
			},
		})
		const core = setup()
		// "Today" past midnight: the new day starts at 250 s, after the old query's next page
		const feed = new ActivityFeed(api, core.events, { id: "midnight" })
		await feed.setQuery({ producedAt: { from: firstFrom } }, "Today")
		feed.stop()
		const newDay = new Date(T0 + 250_000).toISOString()
		answer.current = page(range(290, 320), "p:snapshot")
		await feed.setQuery({ producedAt: { from: newDay } }, "Today")
		const held = feed.get().items.length
		// the old query's next page lies wholly in the old day: the snapshot's token takes over
		answer.current = page(range(101, 200), "p:older")
		await feed.loadMore()
		expect(seen.at(-1)?.get("pageToken")).toBe("p:cache")
		expect(feed.get().items).toHaveLength(held)
		expect(feed.get().nextPageToken).toBe("p:snapshot")
		answer.current = page(range(250, 289), null)
		await feed.loadMore()
		expect(seen.at(-1)?.get("pageToken")).toBe("p:snapshot")
		expect(seen.at(-1)?.get("producedFrom")).toBe(newDay)
		expect(feed.get().error).toBeNull()
		expect(feed.get().nextPageToken).toBeNull()

		// no snapshot token left (already paged once with the cache's): paging ends
		answer.current = page(range(251, 300), "p:cache")
		const later = new ActivityFeed(api, core.events, { id: "midnight-2" })
		await later.setQuery({ producedAt: { from: firstFrom } }, "Today")
		later.stop()
		const day2 = new Date(T0 + 230_000).toISOString()
		answer.current = page(range(290, 320), "p:snapshot")
		await later.setQuery({ producedAt: { from: day2 } }, "Today")
		answer.current = page(range(201, 250), "p:cache2")
		await later.loadMore()
		expect(later.get().nextPageToken).toBe("p:cache2")
		answer.current = page(range(151, 200), "p:cache3")
		const asked = seen.length
		await later.loadMore()
		expect(seen.at(-1)?.get("pageToken")).toBe("p:cache2")
		expect(later.get().nextPageToken).toBeNull()
		await later.loadMore()
		expect(seen).toHaveLength(asked + 1)
		const from = Date.parse(day2)
		expect(later.get().items.every(i => Date.parse(i.producedAt) >= from)).toBe(
			true,
		)
	})

	it("skips the snapshot's pages of cached rows when the cache's token expired, within a bound", async () => {
		const seen: string[] = []
		const pages: Record<string, ActivitySearchPage> = {
			first: page(range(201, 300), "p:cache"),
			snapshot: page(range(290, 320), "p:s1"),
			"p:s1": page(range(201, 289), "p:s2"),
			"p:s2": page(range(150, 200), null),
		}
		let reopened = false
		const api = new ApiClient({
			fetch: async url => {
				const token = new URL(String(url), "http://core").searchParams.get(
					"pageToken",
				)
				seen.push(token ?? "")
				if (token === "p:cache")
					return new Response(JSON.stringify({ error: "expired" }), {
						status: 400,
					})
				const p =
					token === null
						? reopened
							? pages["snapshot"]
							: pages["first"]
						: pages[token]
				return new Response(JSON.stringify(p), { status: 200 })
			},
		})
		const core = setup()
		const feed = new ActivityFeed(api, core.events, { id: "skip" })
		await feed.setQuery({})
		feed.stop()
		reopened = true
		await feed.setQuery({})
		await feed.loadMore()
		expect(seen.slice(-3)).toEqual(["p:cache", "p:s1", "p:s2"])
		expect(feed.get().items).toHaveLength(120 + 51)
		expect(feed.get().nextPageToken).toBeNull()
	})

	it("keeps a rolling range's cache across reopen a few minutes later, dropping rows before its start", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0 + 3_600_000)
		const core = setup()
		// heard T0 + 250 s to T0 + 400 s
		core.serve(page(range(250, 400), "p:2"))
		const c = new ActivityController({
			api: core.api,
			events: core.events,
		} as unknown as DataLayer)
		c.setRange({ kind: "1h" })
		const detach = c.attach()
		await vi.waitFor(() => expect(c.feed.get().status).toBe("live"))
		const firstFrom = c.feed.get().query?.producedAt?.from
		detach()
		// 5 min later "Last hour" starts 5 min later: the same search, a moved start
		vi.setSystemTime(T0 + 3_600_000 + 5 * 60_000)
		const release = core.hold()
		core.serve(page(range(380, 420), "p:3"))
		const again = c.attach()
		expect(c.feed.get().query?.producedAt?.from).not.toBe(firstFrom)
		// the cache shows at once (loading with items), without the rows now before the range's start
		// (T0 + 300 s): 300-400 stay, 250-299 go
		expect(c.feed.get().status).toBe("loading")
		expect(c.feed.get().items).toHaveLength(101)
		const from = Date.parse(c.feed.get().query?.producedAt?.from ?? "")
		expect(
			c.feed.get().items.every(i => Date.parse(i.producedAt) >= from),
		).toBe(true)
		release()
		await vi.waitFor(() => expect(c.feed.get().status).toBe("live"))
		expect(c.feed.get().items).toHaveLength(121)
		again()
		c.dispose()
	})
})
