// The Map's datalink layers follow live: reported positions arrive and age by the clock, and the selected
// aircraft's identity is asked again so later links add a registration and conflicts drop it. One shared
// aviation-data subscription serves both (the core allows two per client). Identifiers are fictional.
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"

import { EventsClient } from "../../src/data/events-client.ts"
import {
	AviationLive,
	LIVE_WINDOW_ROWS,
} from "../../src/features/map/aviation-live.ts"
import {
	DatalinkFollower,
	IDENTITY_MIN_GAP_MS,
	IDENTITY_REFRESH_MS,
	type FollowedStory,
} from "../../src/features/map/datalink.ts"
import {
	REPORTED_MAX_AGE_MS,
	REPORTED_MAX_LIVE,
	REPORTED_TICK_MS,
	ReportedPositionsStore,
	latestReports,
} from "../../src/features/map/reported.ts"
import { json, scripted } from "../data/fake-fetch.ts"
import { fakeSockets } from "../data/fake-socket.ts"

const T0 = Date.parse("2026-10-17T08:00:00.000Z")
let seq = 0

function row(over: Partial<ActivitySummary>): ActivitySummary {
	seq += 1
	const iso = new Date(T0).toISOString()
	return {
		eventId: `e${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: iso,
		receivedAt: iso,
		decoderId: "d",
		sourceId: "s",
		protocol: "vdl2",
		category: "aviation-data",
		frequencyHz: 136_975_000,
		entityKey: "icao:0A0B01",
		title: "ACARS message",
		fields: [],
		...over,
	} as ActivitySummary
}

function page(items: ActivitySummary[]) {
	return {
		items,
		nextPageToken: null,
		replayCursor: "c:1",
		snapshot: { lowBarrier: "0", highWater: "1", expiresAt: "x" },
		searchCoverage: "bounded-projection",
	}
}

const trails = {
	producedFrom: "2026-10-17T07:00:00.000Z",
	producedTo: "2026-10-17T08:00:00.000Z",
	trails: [],
	pointCount: 0,
	scannedRows: 0,
	skippedRows: 0,
	truncated: false,
	truncation: [],
	retentionFloor: "2026-10-14T08:00:00.000Z",
	generatedAt: "2026-10-17T08:00:00.000Z",
}

const ICAO_ONLY = {
	icao: "0A0B01",
	conflict: false,
	links: [],
	entityKeys: ["icao:0A0B01"],
}
const LINKED = {
	icao: "0A0B01",
	conflict: false,
	links: [
		{
			a: { kind: "icao", value: "0A0B01" },
			b: { kind: "reg", value: "N0WK01" },
			evidence: "observed",
			source: "vdl2",
			lastSeen: "2026-10-17T08:00:00.000Z",
		},
	],
	entityKeys: ["icao:0A0B01", "reg:N0WK01"],
}

function setup(
	identity: () => unknown,
	options: {
		start?: number
		trails?: (n: number) => Response | Promise<Response>
	} = {},
) {
	let now = options.start ?? T0
	let trailReads = 0
	const { api, calls } = scripted(call => {
		if (call.url.includes("/api/activity/trails")) {
			trailReads += 1
			return options.trails?.(trailReads) ?? json(200, trails)
		}
		if (call.url.includes("/api/aircraft-identity/"))
			return json(200, identity())
		if (call.url.includes("/api/activity")) return json(200, page([]))
		return json(404, { error: "not found" })
	})
	const sockets = fakeSockets()
	const events = new EventsClient({
		url: "ws://x/ws",
		createSocket: sockets.factory,
	})
	events.connect()
	sockets.last().open()
	const subscribes = () =>
		sockets
			.last()
			.sent.filter(
				m => (m as { type?: string }).type === "activity:subscribe",
			) as { id: string }[]
	const push = (items: ActivitySummary[]) => {
		const id = subscribes().at(-1)?.id ?? ""
		sockets.last().receive({
			type: "activity:records",
			channel: "activity",
			data: { id, items, scannedThrough: "9", cursor: "c:9" },
		})
	}
	const aviation = new AviationLive(api, events)
	return {
		api,
		calls,
		events,
		aviation,
		subscribes,
		push,
		clock: () => now,
		advance: (ms: number) => {
			now += ms
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("reported positions follow live", () => {
	it("a position reported after the Map opened appears at once and leaves after the hour", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		})
		const t = setup(() => ICAO_ONLY)
		const store = new ReportedPositionsStore(t.api, t.events, {
			now: t.clock,
			aviation: t.aviation,
		})
		const off = store.attach()
		await vi.advanceTimersByTimeAsync(0)
		expect(latestReports(store.get().trails, t.clock())).toEqual([])
		t.push([row({ position: { lat: 48.7, lon: -4 } })])
		await vi.advanceTimersByTimeAsync(200)
		const reports = latestReports(store.get().trails, t.clock())
		expect(reports).toEqual([
			{ entityKey: "icao:0A0B01", lat: 48.7, lon: -4, at: T0 },
		])
		// a row without a position adds nothing
		t.push([row({ entityKey: "reg:N0WK01" })])
		await vi.advanceTimersByTimeAsync(200)
		expect(latestReports(store.get().trails, t.clock())).toHaveLength(1)
		// ages by the clock: the minute tick moves `now` on, and an hour later the report is gone
		t.advance(REPORTED_MAX_AGE_MS)
		await vi.advanceTimersByTimeAsync(REPORTED_TICK_MS)
		expect(store.get().now).toBe(t.clock())
		expect(latestReports(store.get().trails, store.get().now)).toHaveLength(1)
		t.advance(1)
		await vi.advanceTimersByTimeAsync(REPORTED_TICK_MS)
		expect(latestReports(store.get().trails, store.get().now)).toEqual([])
		off()
	})
})

describe("reported positions: live follow and stored trails agree", () => {
	const fakeTimers = () =>
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		})
	const trailsWith = (points: [number, number, number, number | null][]) => ({
		...trails,
		trails: [{ entityKey: "icao:0A0B01", points }],
		pointCount: points.length,
	})

	it("a report between the first trails read and the subscription is read again, not lost", async () => {
		fakeTimers()
		let answerFirst: (r: Response) => void = () => {}
		// the first read is in flight while the subscription goes live, answered from before the report
		const t = setup(() => ICAO_ONLY, {
			trails: n =>
				n === 1
					? new Promise<Response>(resolve => {
							answerFirst = resolve
						})
					: json(200, trailsWith([[T0 - 30_000, 48.7, -4, null]])),
		})
		const store = new ReportedPositionsStore(t.api, t.events, {
			now: t.clock,
			aviation: t.aviation,
		})
		const off = store.attach()
		await vi.advanceTimersByTimeAsync(0)
		expect(t.subscribes()).toHaveLength(1) // live, with the first read still out
		const reads = () =>
			t.calls.filter(c => c.url.includes("/api/activity/trails")).length
		expect(reads()).toBe(1)
		answerFirst(json(200, trails))
		await vi.advanceTimersByTimeAsync(0)
		expect(reads()).toBe(2)
		expect(latestReports(store.get().trails, t.clock())).toEqual([
			{ entityKey: "icao:0A0B01", lat: 48.7, lon: -4, at: T0 - 30_000 },
		])
		// the report arriving live as well is not drawn twice
		t.push([
			row({
				position: { lat: 48.7, lon: -4 },
				producedAt: new Date(T0 - 30_000).toISOString(),
			}),
		])
		await vi.advanceTimersByTimeAsync(200)
		expect(store.get().trails.get("icao:0A0B01")).toHaveLength(1)
		off()
	})

	it("a replayed report keeps its real age: 4 minutes old, it leaves 56 minutes later", async () => {
		fakeTimers()
		// this browser runs 7 s ahead of the core: the trails answer gives the offset
		const skew = 7_000
		const t = setup(() => ICAO_ONLY, { start: T0 + skew })
		const store = new ReportedPositionsStore(t.api, t.events, {
			now: t.clock,
			aviation: t.aviation,
		})
		const off = store.attach()
		await vi.advanceTimersByTimeAsync(0)
		const produced = T0 - 4 * 60_000
		t.push([
			row({
				position: { lat: 48.7, lon: -4 },
				producedAt: new Date(produced).toISOString(),
			}),
		])
		await vi.advanceTimersByTimeAsync(200)
		expect(latestReports(store.get().trails, t.clock())).toEqual([
			{ entityKey: "icao:0A0B01", lat: 48.7, lon: -4, at: produced + skew },
		])
		// an older replayed report of the same aircraft does not replace it
		t.push([
			row({
				position: { lat: 10, lon: 10 },
				producedAt: new Date(produced - 60_000).toISOString(),
			}),
		])
		await vi.advanceTimersByTimeAsync(200)
		expect(latestReports(store.get().trails, t.clock())[0]?.lat).toBe(48.7)
		// at exactly the hour it is still shown; a millisecond past it, gone
		t.advance(56 * 60_000)
		await vi.advanceTimersByTimeAsync(REPORTED_TICK_MS)
		expect(store.get().now - (produced + skew)).toBe(REPORTED_MAX_AGE_MS)
		expect(latestReports(store.get().trails, store.get().now)).toHaveLength(1)
		t.advance(1)
		await vi.advanceTimersByTimeAsync(REPORTED_TICK_MS)
		expect(latestReports(store.get().trails, store.get().now)).toEqual([])
		off()
	})

	it("a report never ages ahead of its arrival when the core's clock runs ahead", async () => {
		fakeTimers()
		const t = setup(() => ICAO_ONLY, { start: T0 - 5_000 })
		const store = new ReportedPositionsStore(t.api, t.events, {
			now: t.clock,
			aviation: t.aviation,
		})
		const off = store.attach()
		await vi.advanceTimersByTimeAsync(0)
		t.push([row({ position: { lat: 1, lon: 2 }, producedAt: "not a time" })])
		t.push([
			row({
				entityKey: "icao:0A0B02",
				position: { lat: 3, lon: 4 },
				producedAt: new Date(T0 + 60_000).toISOString(),
			}),
		])
		await vi.advanceTimersByTimeAsync(200)
		for (const r of latestReports(store.get().trails, t.clock()))
			expect(r.at).toBeLessThanOrEqual(t.clock())
		expect(latestReports(store.get().trails, t.clock())).toHaveLength(2)
		off()
	})

	it("follows 2,000 aircraft live; the 2,001st pushes out the one heard longest ago", async () => {
		fakeTimers()
		expect(REPORTED_MAX_LIVE).toBe(2_000)
		const t = setup(() => ICAO_ONLY)
		const store = new ReportedPositionsStore(t.api, t.events, {
			now: t.clock,
			aviation: t.aviation,
		})
		const off = store.attach()
		await vi.advanceTimersByTimeAsync(0)
		const key = (i: number) => `icao:F${String(i).padStart(5, "0")}`
		const report = (i: number) =>
			row({ entityKey: key(i), position: { lat: 1, lon: 1 } })
		for (let b = 0; b < REPORTED_MAX_LIVE; b += LIVE_WINDOW_ROWS) {
			const batch: ActivitySummary[] = []
			// newest first, as the core sends them
			for (let i = b; i < b + LIVE_WINDOW_ROWS; i++) batch.unshift(report(i))
			t.push(batch)
			await vi.advanceTimersByTimeAsync(200)
		}
		expect(store.get().trails.size).toBe(REPORTED_MAX_LIVE)
		t.push([report(REPORTED_MAX_LIVE)])
		await vi.advanceTimersByTimeAsync(200)
		expect(store.get().trails.size).toBe(REPORTED_MAX_LIVE)
		expect(store.get().trails.has(key(0))).toBe(false)
		expect(store.get().trails.has(key(1))).toBe(true)
		expect(store.get().trails.has(key(REPORTED_MAX_LIVE))).toBe(true)
		off()
	})
})

describe("the live aviation window", () => {
	it("hands on 500 new rows of one batch; past that the oldest of the batch is not seen", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		})
		expect(LIVE_WINDOW_ROWS).toBe(500)
		const t = setup(() => ICAO_ONLY)
		const got: string[][] = []
		const offRows = t.aviation.onRows(rows =>
			got.push(rows.map(r => r.eventId)),
		)
		const off = t.aviation.attach()
		await vi.advanceTimersByTimeAsync(0)
		const batch = (n: number) => {
			const rows: ActivitySummary[] = []
			for (let i = 0; i < n; i++) rows.unshift(row({}))
			return rows
		}
		const exact = batch(LIVE_WINDOW_ROWS)
		t.push(exact)
		await vi.advanceTimersByTimeAsync(200)
		expect(got.flat()).toHaveLength(LIVE_WINDOW_ROWS)
		got.length = 0
		const past = batch(LIVE_WINDOW_ROWS + 1)
		t.push(past)
		await vi.advanceTimersByTimeAsync(200)
		const delivered = got.flat()
		expect(delivered).toHaveLength(LIVE_WINDOW_ROWS)
		expect(delivered).not.toContain(past.at(-1)?.eventId)
		got.length = 0
		// rows already handed on are never handed on again
		const one = batch(1)
		t.push(one)
		await vi.advanceTimersByTimeAsync(200)
		expect(got.flat()).toEqual([one[0]?.eventId])
		offRows()
		off()
	})
})

describe("the selected aircraft's identity follows later links", () => {
	it("adds the registration once linked, and drops it when the link conflicts", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		})
		let answer: unknown = ICAO_ONLY
		const t = setup(() => answer)
		const stories: FollowedStory[] = []
		const follower = new DatalinkFollower(
			t.api,
			t.events,
			"0A0B01",
			s => stories.push(s),
			{ now: t.clock, aviation: t.aviation },
		)
		follower.start()
		await vi.advanceTimersByTimeAsync(0)
		expect(follower.keys).toEqual(["icao:0A0B01"])
		expect(stories.at(-1)?.linkedBy).toBeNull()

		answer = LINKED
		await vi.advanceTimersByTimeAsync(IDENTITY_REFRESH_MS)
		expect(follower.keys).toEqual(["icao:0A0B01", "reg:N0WK01"])
		expect(stories.at(-1)?.linkedBy).toMatch(/N0WK01 heard with this address/)
		const reads = t.calls.filter(c => c.url.includes("entityKey=reg%3AN0WK01"))
		expect(reads).toHaveLength(1)

		// a registration claimed by another aircraft too: the core leaves it out of entityKeys
		answer = { ...LINKED, entityKeys: ["icao:0A0B01"] }
		await vi.advanceTimersByTimeAsync(IDENTITY_REFRESH_MS)
		expect(follower.keys).toEqual(["icao:0A0B01"])
		follower.stop()
	})

	it("a new message asks again soon, at most once per gap", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		})
		const t = setup(() => ICAO_ONLY)
		const stories: FollowedStory[] = []
		const follower = new DatalinkFollower(
			t.api,
			t.events,
			"0A0B01",
			s => stories.push(s),
			{ now: t.clock, aviation: t.aviation },
		)
		follower.start()
		await vi.advanceTimersByTimeAsync(0)
		const asked = () =>
			t.calls.filter(c => c.url.includes("/api/aircraft-identity/")).length
		expect(asked()).toBe(1)
		t.push([row({ title: "Position report" })])
		t.push([row({ title: "Another report" })])
		await vi.advanceTimersByTimeAsync(200)
		expect(stories.at(-1)?.story.messageCount).toBe(2)
		// rows of other aircraft are not this story's
		t.push([row({ entityKey: "icao:0A0B02" })])
		await vi.advanceTimersByTimeAsync(200)
		expect(stories.at(-1)?.story.messageCount).toBe(2)
		t.advance(IDENTITY_MIN_GAP_MS)
		await vi.advanceTimersByTimeAsync(IDENTITY_MIN_GAP_MS)
		expect(asked()).toBe(2)
		follower.stop()
	})

	it("the ACARS layer and the story share one Activity subscription", async () => {
		const t = setup(() => LINKED)
		const store = new ReportedPositionsStore(t.api, t.events, {
			now: t.clock,
			aviation: t.aviation,
		})
		const off = store.attach()
		const follower = new DatalinkFollower(t.api, t.events, "0A0B01", () => {}, {
			now: t.clock,
			aviation: t.aviation,
		})
		follower.start()
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(follower.keys).toHaveLength(2)
		expect(t.subscribes()).toHaveLength(1)
		// the core takes ids of [A-Za-z0-9_-] only
		expect(t.subscribes()[0]?.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
		follower.stop()
		off()
	})
})
