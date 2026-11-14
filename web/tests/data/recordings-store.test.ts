import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"

import type { EventsClient } from "../../src/data/events-client.ts"
import {
	FEED_BUSY_MS,
	FEED_RETRY_MS,
	FEED_STALL_MS,
	countNew,
	mergeHead,
} from "../../src/data/paged-feed.ts"
import {
	RecordingsStore,
	compareRecordings,
	recordingsUnavailable,
} from "../../src/data/recordings-store.ts"
import type { RecordingsState } from "../../src/data/recordings-store.ts"
import { panelView } from "../../src/ui/panel-state.ts"
import { json, scripted } from "./fake-fetch.ts"

const item = (
	id: string,
	patch: Partial<RecordingInventoryItem> = {},
): RecordingInventoryItem => ({
	id,
	kind: "dsd-fme-call",
	decoderId: "dsd-fme",
	discoveryId: null,
	startedAtLocal: "2026-10-17T10:00:00",
	modifiedAt: "2026-10-17T08:00:30.000Z",
	bytes: 160_044,
	durationMs: 10_000,
	callType: "group",
	talkgroup: "2081",
	source: "2081012",
	frequencyHz: null,
	kept: false,
	...patch,
})

const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 8, 0, s)).toISOString()
const rec = (n: number) =>
	item(`dsd:0~20261017_100000_${String(n).padStart(5, "0")}_DMR.wav`, {
		modifiedAt: at(n),
	})

const page = (
	items: RecordingInventoryItem[],
	nextCursor: string | null = null,
	extra: Record<string, unknown> = {},
) => ({
	items,
	nextCursor,
	scannedFiles: items.length,
	truncated: false,
	scannedAt: "2026-10-17T08:01:00.000Z",
	revision: 1,
	indexing: false,
	matched: items.length,
	counts: {
		total: items.length,
		kept: 0,
		bytes: 0,
		byKind: {
			"dsd-fme-call": items.length,
			"scanner-dv": 0,
			"scanner-analog": 0,
		},
	},
	truncatedBefore: null,
	...extra,
})

const A = "dsd:0~20261017_100000_00001_DMR_SLOT1_GROUP_TGT_2081_SRC_2081012.wav"
const B = "dsd:0~20261017_090000_00002_DMR_SLOT1_GROUP_TGT_9_SRC_2081045.wav"

/** The panel's view of the store, as the drawer computes it. */
const view = (s: RecordingsState) =>
	panelView({
		status: s.status,
		busy: s.busy,
		rows: s.items.length,
		answered: s.answered,
		error: s.error,
		truncated: s.meta?.truncated === true,
		capped: s.capped,
		indexing: s.meta?.indexing === true,
	})

/** A socket stand-in: the channel subscriptions and handlers the store installs. */
function fakeEvents() {
	const handlers = new Map<string, (data: unknown) => void>()
	const reconnect = new Set<() => void>()
	const channels: string[][] = []
	let unsubscribed = 0
	const events = {
		subscribe: (c: readonly string[]) => {
			channels.push([...c])
			return () => (unsubscribed += 1)
		},
		on: (type: string, h: (data: unknown) => void) => {
			handlers.set(type, h)
			return () => handlers.delete(type)
		},
		onReconnected: (h: () => void) => {
			reconnect.add(h)
			return () => reconnect.delete(h)
		},
	} as unknown as EventsClient
	return {
		events,
		channels,
		unsubscribed: () => unsubscribed,
		emit: (type: string, data: unknown) => handlers.get(type)?.(data),
		reconnect: () => {
			for (const h of reconnect) h()
		},
		handlers,
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe("RecordingsStore: pages and filters", () => {
	it("reads the head with the largest page, and the next page on demand", async () => {
		const { api, calls } = scripted(call =>
			call.url.includes("cursor=c1")
				? json(200, page([item(B)]))
				: json(200, page([item(A)], "c1")),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		expect(calls.map(c => c.url)).toEqual(["/api/recordings?limit=200"])
		expect(store.get()).toMatchObject({ status: "ready", nextCursor: "c1" })
		await store.loadMore()
		expect(calls.map(c => c.url)).toEqual([
			"/api/recordings?limit=200",
			"/api/recordings?limit=200&cursor=c1",
		])
		expect(store.get().items.map(i => i.id)).toEqual([A, B])
		expect(store.get().nextCursor).toBeNull()
	})

	it("sends the search to the core and takes its counts", async () => {
		const { api, calls } = scripted(() =>
			json(200, page([item(A)], null, { matched: 1, revision: 7 })),
		)
		const store = new RecordingsStore(api)
		await store.show({
			kept: true,
			talkgroup: "2081",
			minHz: 156_793_750,
			maxHz: 156_806_250,
			q: "x".repeat(80),
		})
		expect(calls[0]?.url).toBe(
			`/api/recordings?limit=200&kept=true&talkgroup=2081&minHz=156793750&maxHz=156806250&q=${"x".repeat(64)}`,
		)
		expect(store.get().meta).toMatchObject({
			matched: 1,
			revision: 7,
			counts: { total: 1 },
		})
	})

	it("drops malformed items and refuses an answer that is not a page", async () => {
		let body: unknown = page([
			item(A),
			{ id: 3 } as unknown as RecordingInventoryItem,
		])
		const { api } = scripted(() => json(200, body))
		const store = new RecordingsStore(api)
		await store.show({})
		expect(store.get().items.map(i => i.id)).toEqual([A])
		body = { nope: true }
		await store.refresh()
		expect(store.get()).toMatchObject({
			status: "error",
			errorCode: "RESPONSE_INVALID",
		})
		expect(store.get().items.map(i => i.id)).toEqual([A])
	})

	it("stops at its window of rows and says so", async () => {
		let n = 0
		const { api } = scripted(() => {
			const items = [rec(1000 - 2 * n), rec(999 - 2 * n)]
			n += 1
			return json(200, page(items, `c${n}`))
		})
		const store = new RecordingsStore(api, null, { maxItems: 5, pageSize: 2 })
		await store.show({})
		await store.loadMore()
		await store.loadMore()
		expect(store.get().items).toHaveLength(5)
		expect(store.get().capped).toBe(true)
		await store.loadMore()
		expect(n).toBe(3)
	})

	it("says the routes need a protected core when they are not mounted, and does not retry", async () => {
		vi.useFakeTimers()
		const { api, calls } = scripted(() =>
			json(404, {
				error: "Not Found",
				code: "NOT_FOUND",
				message: "Route GET:/api/recordings not found",
			}),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		expect(recordingsUnavailable(store.get())).toBe("protected-only")
		expect(store.get().retryAt).toBeNull()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(calls).toHaveLength(1)
	})
})

describe("RecordingsStore: refresh and live notices", () => {
	it("merges a fresh head over the rows held, keeping older pages and their cursor", async () => {
		let head = [rec(10), rec(9)]
		const { api } = scripted(call =>
			call.url.includes("cursor=")
				? json(200, page([rec(8), rec(7)], "c-old"))
				: json(200, page(head, "c-head")),
		)
		const store = new RecordingsStore(api, null, { pageSize: 2 })
		await store.show({})
		await store.loadMore()
		expect(store.get().nextCursor).toBe("c-old")
		// one new at the top, 9 deleted: the head reaches back to 8
		head = [rec(11), rec(10), rec(8)]
		await store.refresh()
		expect(store.get().items.map(i => i.modifiedAt)).toEqual(
			[11, 10, 8, 7].map(at),
		)
		expect(store.get().nextCursor).toBe("c-old")
	})

	it("after more arrivals than a page, replaces the held rows and pages on from the head (no hidden gap)", async () => {
		let head = [rec(10), rec(9)]
		const { api } = scripted(call =>
			call.url.includes("cursor=")
				? json(200, page([rec(8), rec(7)], "c-old"))
				: json(200, page(head, "c-head")),
		)
		const store = new RecordingsStore(api, null, { pageSize: 2 })
		await store.show({})
		await store.loadMore()
		// closed meanwhile: 20 arrived, the head is wholly newer than anything held
		head = [rec(30), rec(29)]
		await store.refresh()
		expect(store.get().items.map(i => i.modifiedAt)).toEqual([30, 29].map(at))
		expect(store.get().nextCursor).toBe("c-head")
	})

	it("a cut at the window drops the cursor", async () => {
		let head = [rec(10), rec(9)]
		const { api } = scripted(call =>
			call.url.includes("cursor=")
				? json(200, page([rec(8), rec(7)], "c-old"))
				: json(200, page(head, "c-head")),
		)
		const store = new RecordingsStore(api, null, { pageSize: 2, maxItems: 4 })
		await store.show({})
		await store.loadMore()
		expect(store.get()).toMatchObject({ capped: true, nextCursor: "c-old" })
		head = [rec(11), rec(10), rec(9)]
		await store.refresh()
		expect(store.get().items.map(i => i.modifiedAt)).toEqual(
			[11, 10, 9, 8].map(at),
		)
		// rec(7) was cut: paging on from "c-old" would skip it
		expect(store.get()).toMatchObject({ capped: true, nextCursor: null })
	})

	it("holds arrivals while the list is scrolled or playing, and merges them on release", async () => {
		let head = [rec(10), rec(9)]
		const { api } = scripted(() => json(200, page(head)))
		const store = new RecordingsStore(api)
		await store.show({})
		store.setHolding(true)
		head = [rec(12), rec(11), rec(10), rec(9)]
		await store.refresh()
		expect(store.get().heldNew).toBe(2)
		expect(store.get().items).toHaveLength(2)
		store.release()
		expect(store.get().items).toHaveLength(4)
		expect(store.get().heldNew).toBe(0)
	})

	it("follows the recordings channel while open: a new revision or a reconnect re-reads the head", async () => {
		let revision = 1
		const { api, calls } = scripted(() =>
			json(200, page([item(A)], null, { revision })),
		)
		const live = fakeEvents()
		const store = new RecordingsStore(api, live.events)
		const detach = store.attach({})
		await vi.waitFor(() => expect(store.get().status).toBe("ready"))
		expect(live.channels).toEqual([["recordings"]])
		expect(calls).toHaveLength(1)
		// the revision shown already: nothing to read
		live.emit("recordings:changed", {
			revision: 1,
			added: 0,
			removed: 0,
			changed: 0,
			indexing: false,
		})
		await Promise.resolve()
		expect(calls).toHaveLength(1)
		revision = 2
		live.emit("recordings:changed", {
			revision: 2,
			added: 1,
			removed: 0,
			changed: 0,
			indexing: false,
		})
		await vi.waitFor(() => expect(calls).toHaveLength(2))
		live.reconnect()
		await vi.waitFor(() => expect(calls).toHaveLength(3))
		detach()
		expect(live.unsubscribed()).toBe(1)
		expect(live.handlers.has("recordings:changed")).toBe(false)
		// closed and opened again: the rows are there at once, refreshed behind them
		const again = store.attach({})
		expect(store.get().items.map(i => i.id)).toEqual([A])
		await vi.waitFor(() => expect(calls).toHaveLength(4))
		again()
	})

	it("a head asked for before a Keep or delete landed does not undo it; the next one is the truth", async () => {
		let release: (() => void) | null = null
		let kept = false
		let slow = false
		const { api } = scripted(call => {
			if (call.method === "PUT")
				return json(200, { id: A, kept: true, changed: true })
			if (call.method === "DELETE") return json(200, { id: B, deleted: true })
			const body = page([item(A, { kept }), item(B)])
			return slow
				? new Promise<Response>(resolve => {
						release = () => resolve(json(200, body))
					})
				: json(200, body)
		})
		const store = new RecordingsStore(api)
		await store.show({})
		slow = true
		const stale = store.refresh()
		await store.setKept(A, true)
		await store.remove(B)
		;(release as unknown as () => void)()
		await stale
		expect(store.get().items.map(i => [i.id, i.kept])).toEqual([[A, true]])
		// the core has both now
		slow = false
		kept = true
		await store.refresh()
		expect(store.get().items.map(i => [i.id, i.kept])).toEqual([
			[A, true],
			[B, false],
		])
	})

	it("never runs two head reads at once, and never loses one asked meanwhile", async () => {
		let release: (() => void) | null = null
		let n = 0
		const { api } = scripted(
			() =>
				new Promise<Response>(resolve => {
					n += 1
					release = () => resolve(json(200, page([rec(n)])))
				}),
		)
		const store = new RecordingsStore(api)
		const first = store.show({})
		void store.refresh()
		void store.refresh()
		expect(n).toBe(1)
		;(release as unknown as () => void)()
		await vi.waitFor(() => expect(n).toBe(2))
		;(release as unknown as () => void)()
		await first
		expect(n).toBe(2)
	})
})

describe("recordings panel states (slow and failing core)", () => {
	it("a slow first read: skeleton, busy at 3 s, rows when it lands", async () => {
		vi.useFakeTimers()
		const { api } = scripted(
			() =>
				new Promise<Response>(resolve =>
					setTimeout(() => resolve(json(200, page([item(A)]))), 5000),
				),
		)
		const store = new RecordingsStore(api)
		void store.show({})
		expect(view(store.get())).toEqual({
			body: "skeleton",
			busy: false,
			progress: false,
			notice: null,
		})
		await vi.advanceTimersByTimeAsync(FEED_BUSY_MS)
		expect(view(store.get())).toMatchObject({ body: "skeleton", busy: true })
		await vi.advanceTimersByTimeAsync(2000)
		expect(view(store.get())).toEqual({
			body: "rows",
			busy: false,
			progress: false,
			notice: null,
		})
	})

	it("a stalled first read: abandoned at 10 s with Try again, then retried on the backoff", async () => {
		vi.useFakeTimers()
		let answer = false
		const { api, calls } = scripted(
			(_call): Promise<Response> =>
				answer
					? Promise.resolve(json(200, page([item(A)])))
					: new Promise<Response>(() => {}),
		)
		// the hanging fetch ignores the abort: the client's own deadline still ends the read
		const store = new RecordingsStore(api)
		void store.show({})
		await vi.advanceTimersByTimeAsync(FEED_STALL_MS)
		expect(store.get()).toMatchObject({
			status: "error",
			errorCode: "REQUEST_TIMEOUT",
			error: "No answer from WaveKit in 10 s",
		})
		expect(view(store.get()).body).toBe("error")
		expect(store.get().retryAt).toBe(Date.now() + (FEED_RETRY_MS[0] ?? 0))
		answer = true
		await vi.advanceTimersByTimeAsync(FEED_RETRY_MS[0] ?? 0)
		expect(calls).toHaveLength(2)
		expect(view(store.get()).body).toBe("rows")
	})

	it("a failing core: error body, retries at 2, 4, 8 s, Try again at once", async () => {
		vi.useFakeTimers()
		const { api, calls } = scripted(() =>
			json(503, {
				error: "Service Unavailable",
				code: "RECORDINGS_UNAVAILABLE",
				message: "Recordings are unavailable",
			}),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		expect(view(store.get()).body).toBe("error")
		expect(store.get().error).toBe("Recordings are unavailable")
		await vi.advanceTimersByTimeAsync(2000)
		expect(calls).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(3999)
		expect(calls).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(calls).toHaveLength(3)
		await store.retry()
		expect(calls).toHaveLength(4)
		// Try again starts the backoff over
		expect(store.get().retryAt).toBe(Date.now() + (FEED_RETRY_MS[0] ?? 0))
	})

	it("notices wait for a planned retry, and a retry keeps the error shown", async () => {
		vi.useFakeTimers()
		let ok = false
		const { api, calls } = scripted(() =>
			ok
				? new Promise<Response>(resolve =>
						setTimeout(() => resolve(json(200, page([item(A)]))), 500),
					)
				: json(503, {
						error: "x",
						code: "RECORDINGS_UNAVAILABLE",
						message: "down",
					}),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		expect(store.get().retryAt).not.toBeNull()
		// a notice a second against a failing core: no read before the retry
		for (let i = 0; i < 3; i++) await store.notify()
		expect(calls).toHaveLength(1)
		ok = true
		await vi.advanceTimersByTimeAsync(FEED_RETRY_MS[0] ?? 0)
		expect(calls).toHaveLength(2)
		// the retry is in flight: still the error, now retrying
		expect(store.get()).toMatchObject({ status: "error", retrying: true })
		expect(view(store.get()).body).toBe("error")
		await vi.advanceTimersByTimeAsync(500)
		expect(store.get()).toMatchObject({ status: "ready", retrying: false })
		expect(view(store.get()).body).toBe("rows")
	})

	it("rows on screen: a slow refresh shows the progress line then busy; a failed one keeps the rows as of the last answer", async () => {
		vi.useFakeTimers()
		let mode: "ok" | "slow" | "fail" = "ok"
		const { api } = scripted(() =>
			mode === "ok"
				? json(200, page([item(A)]))
				: mode === "slow"
					? new Promise<Response>(resolve =>
							setTimeout(() => resolve(json(200, page([item(A)]))), 4000),
						)
					: json(500, { error: "x", code: "X", message: "Internal error" }),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		const asOf = store.get().asOf
		mode = "slow"
		void store.refresh()
		expect(view(store.get())).toEqual({
			body: "rows",
			busy: false,
			progress: true,
			notice: null,
		})
		await vi.advanceTimersByTimeAsync(FEED_BUSY_MS)
		expect(view(store.get()).notice).toBe("busy")
		await vi.advanceTimersByTimeAsync(1000)
		expect(view(store.get())).toMatchObject({ progress: false, notice: null })
		mode = "fail"
		await vi.advanceTimersByTimeAsync(10_000)
		await store.refresh()
		expect(view(store.get())).toMatchObject({ body: "rows", notice: "error" })
		expect(store.get().items).toHaveLength(1)
		expect(store.get().asOf).not.toBeNull()
		expect(store.get().asOf).not.toBe(asOf)
	})

	it("a new search shows the skeleton until its own answer, never the last search's empty state", async () => {
		vi.useFakeTimers()
		let slow = false
		const { api } = scripted(() =>
			slow
				? new Promise<Response>(resolve =>
						setTimeout(() => resolve(json(200, page([]))), 4000),
					)
				: json(200, page([item(A)])),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		slow = true
		void store.show({ talkgroup: "123" })
		expect(view(store.get())).toMatchObject({ body: "skeleton", busy: false })
		expect(store.get().asOf).toBeNull()
		await vi.advanceTimersByTimeAsync(FEED_BUSY_MS)
		expect(view(store.get())).toMatchObject({ body: "skeleton", busy: true })
		await vi.advanceTimersByTimeAsync(1000)
		expect(view(store.get())).toMatchObject({ body: "empty", notice: null })
	})

	it("a refresh does not cut short an older page being read", async () => {
		let releaseMore: (() => void) | null = null
		const { api, calls } = scripted(call =>
			call.url.includes("cursor=")
				? new Promise<Response>(resolve => {
						releaseMore = () => resolve(json(200, page([rec(8)], null)))
					})
				: json(200, page([rec(10), rec(9)], "c1")),
		)
		const store = new RecordingsStore(api, null, { pageSize: 2 })
		await store.show({})
		const more = store.loadMore()
		await store.refresh()
		expect(store.get().loadingMore).toBe(true)
		;(releaseMore as unknown as () => void)()
		await more
		expect(store.get().items.map(i => i.modifiedAt)).toEqual([10, 9, 8].map(at))
		expect(calls.filter(c => c.url.includes("cursor="))).toHaveLength(1)
	})

	it("closing clears a planned retry", async () => {
		vi.useFakeTimers()
		const { api, calls } = scripted(() =>
			json(503, {
				error: "x",
				code: "RECORDINGS_UNAVAILABLE",
				message: "down",
			}),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		expect(store.get().retryAt).not.toBeNull()
		store.stop()
		expect(store.get().retryAt).toBeNull()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(calls).toHaveLength(1)
	})

	it("an empty answer is the empty state; indexing and truncation are notices", async () => {
		let extra: Record<string, unknown> = { indexing: true }
		const { api } = scripted(() => json(200, page([], null, extra)))
		const store = new RecordingsStore(api)
		await store.show({})
		expect(view(store.get())).toMatchObject({
			body: "empty",
			notice: "indexing",
		})
		extra = { truncated: true }
		await store.refresh()
		expect(view(store.get())).toMatchObject({ notice: "truncated" })
	})
})

describe("paged feed merge", () => {
	const id = (n: number) => String(n)
	// newest first: larger first
	const cmp = (a: number, b: number) => b - a
	it("keeps the head, then the held rows older than it, only when the head reaches them", () => {
		expect(mergeHead([9, 8, 7, 6], [11, 10, 8], false, id, cmp)).toEqual([
			11, 10, 8, 7, 6,
		])
		expect(mergeHead([9, 8, 7, 6], [11, 10, 9], false, id, cmp)).toEqual([
			11, 10, 9, 8, 7, 6,
		])
		// a gap: the head ends above the newest held row
		expect(mergeHead([9, 8], [12, 11, 10], false, id, cmp)).toEqual([
			12, 11, 10,
		])
		expect(mergeHead([9, 8, 7], [10], true, id, cmp)).toEqual([10])
		expect(countNew([9, 8], [11, 10, 9, 8], id, cmp)).toBe(2)
		expect(countNew([], [3, 2], id, cmp)).toBe(2)
	})

	// Feature: panels, Property 1: a merged head is sorted, unique, loses no older row it joins, and never keeps rows across a gap
	it("a merged list is sorted, unique, holds the head and every held row older than it", () => {
		const list = fc.uniqueArray(fc.integer({ min: 0, max: 400 }), {
			maxLength: 60,
		})
		fc.assert(
			fc.property(list, list, fc.boolean(), (heldRaw, headRaw, complete) => {
				const held = [...heldRaw].sort(cmp)
				const head = [...headRaw].sort(cmp)
				const out = mergeHead(held, head, complete, id, cmp)
				for (let i = 1; i < out.length; i++)
					expect(cmp(out[i - 1] ?? 0, out[i] ?? 0)).toBeLessThan(0)
				for (const h of head) expect(out).toContain(h)
				const last = head.at(-1)
				const top = held[0]
				const joins =
					!complete && last !== undefined && top !== undefined && last <= top
				if (joins) {
					for (const h of held)
						if (h < (last ?? 0)) expect(out).toContain(h)
				} else expect(out).toEqual(head)
			}),
			{ numRuns: 200 },
		)
	})

	it("orders recordings as the core does", () => {
		const a = item("a", { modifiedAt: at(2) })
		const b = item("b", { modifiedAt: at(2) })
		const c = item("c", { modifiedAt: at(1) })
		expect([c, b, a].sort(compareRecordings).map(r => r.id)).toEqual([
			"a",
			"b",
			"c",
		])
	})
})

describe("RecordingsStore: Keep and delete", () => {
	it("keeps at once, settles on the core's answer and reverts on an error", async () => {
		let answer: Response = json(200, { id: A, kept: true, changed: true })
		const { api, calls } = scripted(call =>
			call.method === "GET" ? json(200, page([item(A)])) : answer,
		)
		const store = new RecordingsStore(api)
		await store.show({})
		const pending = store.setKept(A, true)
		expect(store.get().items[0]?.kept).toBe(true)
		expect(store.marks.get().keeping.has(A)).toBe(true)
		await pending
		expect(calls.at(-1)).toMatchObject({
			method: "PUT",
			url: `/api/recordings/${encodeURIComponent(A)}/keep`,
		})
		expect(store.marks.get().keeping.size).toBe(0)

		answer = json(409, {
			error: "Conflict",
			code: "RECORDING_KEEP_LIMIT",
			message: "Keep limit reached",
		})
		await expect(store.setKept(A, false)).rejects.toMatchObject({
			code: "RECORDING_KEEP_LIMIT",
		})
		expect(calls.at(-1)?.method).toBe("DELETE")
		expect(store.get().items[0]?.kept).toBe(true)
	})

	it("hides a deleted recording, sends the delete after the grace period, and Undo cancels it", async () => {
		vi.useFakeTimers()
		const { api, calls } = scripted(call =>
			call.method === "GET"
				? json(200, page([item(A), item(B)]))
				: json(200, { id: A, deleted: true }),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		const onError = vi.fn()
		const undo = store.scheduleRemove(B, onError, 1000)
		expect(store.marks.get().removing.has(B)).toBe(true)
		undo()
		expect(store.marks.get().removing.has(B)).toBe(false)
		store.scheduleRemove(A, onError, 1000)
		await vi.advanceTimersByTimeAsync(1000)
		expect(calls.filter(c => c.method === "DELETE").map(c => c.url)).toEqual([
			`/api/recordings/${encodeURIComponent(A)}`,
		])
		expect(store.get().items.map(i => i.id)).toEqual([B])
		expect(store.marks.get().removing.size).toBe(0)
		expect(onError).not.toHaveBeenCalled()
	})

	it("shows the recording again when the delete fails", async () => {
		vi.useFakeTimers()
		const { api } = scripted(call =>
			call.method === "GET"
				? json(200, page([item(A)]))
				: json(409, {
						error: "Conflict",
						code: "RECORDING_KEPT",
						message: "Recording is kept; unkeep it first",
					}),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		const onError = vi.fn()
		store.scheduleRemove(A, onError, 10)
		await vi.advanceTimersByTimeAsync(10)
		expect(onError).toHaveBeenCalledTimes(1)
		expect(store.get().items).toHaveLength(1)
		expect(store.marks.get().removing.size).toBe(0)
	})

	it("flushes waiting deletes when the page goes away", async () => {
		const { api, calls } = scripted(call =>
			call.method === "GET"
				? json(200, page([item(A)]))
				: json(200, { id: A, deleted: true }),
		)
		const store = new RecordingsStore(api)
		await store.show({})
		store.scheduleRemove(A, () => {}, 60_000)
		store.flushRemovals()
		await vi.waitFor(() =>
			expect(calls.some(c => c.method === "DELETE")).toBe(true),
		)
	})

	it("fetches the file as a blob and builds the download link", async () => {
		const { api, calls } = scripted(
			() =>
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "Content-Type": "audio/wav" },
				}),
			"http://core:3000",
		)
		const store = new RecordingsStore(api)
		const blob = await store.file(A)
		expect(blob.size).toBe(3)
		expect(calls[0]?.url).toBe(
			`http://core:3000/api/recordings/${encodeURIComponent(A)}/file`,
		)
		expect(store.fileUrl(A)).toBe(
			`http://core:3000/api/recordings/${encodeURIComponent(A)}/file`,
		)
	})
})
