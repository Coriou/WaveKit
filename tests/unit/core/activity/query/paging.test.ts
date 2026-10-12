import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import {
	ActivityQueryError,
	ActivityQueryInvalidError,
} from "../../../../../src/core/activity/query/errors.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../../../src/core/activity/query/service.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import {
	createFixture,
	openQueryService,
	type ActivityFixture,
} from "./fixture.js"

describe("activity search and detail", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	async function setup(): Promise<{ fixture: ActivityFixture; service: ActivityQueryService }> {
		fixture = await createFixture()
		service = openQueryService(fixture)
		return { fixture, service }
	}

	it("pins the page, facet, and deadline defaults", () => {
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.pageDefault).toBe(100)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.pageMax).toBe(200)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.pageBytes).toBe(512 * 1024)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.facetValues).toBe(32)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.facetScan).toBe(50_000)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.deadlineMs).toBe(250)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.snapshotTtlMs).toBe(5 * 60 * 1000)
	})

	it("returns an empty snapshot and a replay cursor for an empty store", async () => {
		const { service: query } = await setup()
		const page = await query.search({ query: {} })
		expect(page.items).toEqual([])
		expect(page.nextPageToken).toBeNull()
		expect(page.searchCoverage).toBe("bounded-projection")
		expect(page.snapshot.lowBarrier).toBe("0")
		expect(page.snapshot.highWater).toBe("0")
		expect(page.replayCursor.length).toBeGreaterThan(0)
	})

	it("overwrites commitSeq from the row seq on search and detail", async () => {
		const { fixture: store, service: query } = await setup()
		const seq = store.insert({ eventId: "evt-1", title: "one", text: "alpha" })
		store.stampStaleCommitSeq("evt-1")
		const page = await query.search({ query: {} })
		expect(page.items.map(item => item.commitSeq)).toEqual([seq])
		expect(page.items[0]?.eventId).toBe("evt-1")
		const record = await query.detail("evt-1")
		expect(record?.commitSeq).toBe(seq)
		expect(record?.eventId).toBe("evt-1")
		expect(record && "commitSeq" in record && record.commitSeq).not.toBe("999")
		expect(await query.detail("missing")).toBeNull()
	})

	it("applies kind, source, text, ref, frequency, time, and entity filters", async () => {
		const { fixture: store, service: query } = await setup()
		store.insert({
			eventId: "keep",
			kind: "decoder-reception",
			sourceId: "src-a",
			protocol: "ais",
			category: "marine",
			frequencyHz: 162_000_000,
			entityKey: "ship-1",
			producedAt: "2026-03-01T00:00:00.000Z",
			text: "alpha beacon",
			refs: [{ type: "callId", value: "call-1" }],
		})
		store.insert({
			eventId: "drop",
			kind: "ingestion-gap",
			sourceId: "src-b",
			protocol: "acars",
			category: "aviation-data",
			frequencyHz: 131_000_000,
			entityKey: "plane-1",
			producedAt: "2026-04-01T00:00:00.000Z",
			text: "alpha",
		})
		const filtered = await query.search({
			query: {
				kinds: ["decoder-reception"],
				sourceIds: ["src-a"],
				protocols: ["ais"],
				categories: ["marine"],
				frequencyHz: { min: 160_000_000, max: 170_000_000 },
				producedAt: { from: "2026-02-01T00:00:00.000Z", to: "2026-03-15T00:00:00.000Z" },
				entityKey: "ship-1",
				text: "beacon",
				refs: [{ type: "callId", value: "call-1" }],
			},
		})
		expect(filtered.items.map(item => item.eventId)).toEqual(["keep"])
		const punctuation = await query.search({ query: { text: "..." } })
		const whitespace = await query.search({ query: { text: "   " } })
		expect(punctuation.items.map(item => item.eventId)).toEqual(["drop", "keep"])
		expect(whitespace.items.map(item => item.eventId)).toEqual(["drop", "keep"])
	})

	it("rejects a page when the read sees a newer prune than the cache", async () => {
		const { fixture: store, service: query } = await setup()
		store.insert({ eventId: "a" })
		store.insert({ eventId: "b" })
		store.insert({ eventId: "c" })
		const first = await query.search({ query: {}, order: "asc", limit: 1 })
		expect(first.items.map(item => item.eventId)).toEqual(["a"])
		if (!first.nextPageToken) throw new Error("expected a page token")
		store.divergePrune("2")
		expect(store.store.identity().pruneWatermark).toBe("0")
		await expect(
			query.search({
				query: {},
				order: "asc",
				limit: 1,
				pageToken: first.nextPageToken,
			}),
		).rejects.toMatchObject({
			code: "ACTIVITY_CURSOR_GAP",
			reason: "cursor-gap",
			statusCode: 410,
		})
	})

	it("resets when the read sees a store change the cache has not", async () => {
		const { fixture: store, service: query } = await setup()
		store.insert({ eventId: "a" })
		store.insert({ eventId: "b" })
		const first = await query.search({ query: {}, order: "asc", limit: 1 })
		if (!first.nextPageToken) throw new Error("expected a page token")
		store.divergeMeta({ storeUuid: "00000000-0000-4000-8000-000000000099" })
		await expect(
			query.search({
				query: {},
				order: "asc",
				limit: 1,
				pageToken: first.nextPageToken,
			}),
		).rejects.toMatchObject({
			code: "ACTIVITY_SNAPSHOT_RESET",
			reason: "store-changed",
			statusCode: 409,
		})
	})

	it("reports a corrupt summary as a query error with status 500", async () => {
		const { fixture: store, service: query } = await setup()
		store.insert({ eventId: "bad" })
		store.corruptSummary("bad")
		const error: unknown = await query.search({ query: {} }).then(
			() => null,
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(ActivityQueryError)
		expect(error).toMatchObject({
			code: "ACTIVITY_RECORD_CORRUPT",
			statusCode: 500,
		})
	})

	it("stops a page on the byte budget and continues with the keyset token", async () => {
		const { fixture: store, service: query } = await setup()
		await query.close()
		service = openQueryService(store, { limits: { pageBytes: 1 } })
		store.insert({ eventId: "older" })
		store.insert({ eventId: "newer" })
		const first = await service.search({ query: {}, order: "desc", limit: 10 })
		expect(first.items.map(item => item.eventId)).toEqual(["newer"])
		expect(first.nextPageToken).not.toBeNull()
		const second = await service.search({
			query: {},
			order: "desc",
			limit: 10,
			pageToken: first.nextPageToken ?? "",
		})
		expect(second.items.map(item => item.eventId)).toEqual(["older"])
		expect(second.nextPageToken).toBeNull()
		expect(second.snapshot.expiresAt).toBe(first.snapshot.expiresAt)
		expect(second.snapshot.highWater).toBe(first.snapshot.highWater)
	})

	it("rejects a limit above the page max", async () => {
		const { service: query } = await setup()
		await expect(query.search({ query: {}, limit: 201 })).rejects.toBeInstanceOf(
			ActivityQueryInvalidError,
		)
	})

	it("rejects an event id that contains a control character", async () => {
		const { service: query } = await setup()
		await expect(query.detail("bad\nid")).rejects.toBeInstanceOf(ActivityQueryInvalidError)
	})

	it("finishes an in-flight search before closing the reader", async () => {
		const store = await createFixture({ memory: true })
		fixture = store
		service = openQueryService(store, { readerDelayMs: 30 })
		const pending = service.search({ query: {} })
		await service.close()
		await expect(pending).resolves.toMatchObject({ items: [] })
	})

	// Feature: event-foundation-batch1, Property 2: keyset paging stability under concurrent inserts
	it("pages a snapshot that ignores rows committed after the first read", async () => {
		const store = await createFixture({ memory: true })
		fixture = store
		service = openQueryService(store)
		const query = service
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 8 }),
				fc.integer({ min: 1, max: 3 }),
				fc.constantFrom("asc" as const, "desc" as const),
				async (count, limit, order) => {
					store.reset()
					const expected: string[] = []
					for (let index = 0; index < count; index += 1) {
						const eventId = `e${index}`
						expected.push(store.insert({ eventId, text: "alpha" }))
					}
					const snapshot = order === "desc" ? [...expected].reverse() : expected
					// search() copies the high water before its first await, so this
					// insert is committed after the snapshot and before the read.
					const pending = query.search({ query: {}, order, limit })
					const extra = store.insert({ eventId: "extra", text: "alpha" })
					const collected: string[] = []
					let token: string | null = null
					const first = await pending
					collected.push(...first.items.map(item => item.commitSeq))
					token = first.nextPageToken
					let guard = 0
					while (token !== null) {
						guard += 1
						expect(guard).toBeLessThan(20)
						const next = await query.search({
							query: {},
							order,
							limit,
							pageToken: token,
						})
						expect(next.snapshot.highWater).toBe(first.snapshot.highWater)
						expect(next.snapshot.expiresAt).toBe(first.snapshot.expiresAt)
						collected.push(...next.items.map(item => item.commitSeq))
						token = next.nextPageToken
					}
					expect(collected).toEqual(snapshot)
					expect(collected).not.toContain(extra)
				},
			),
			{ numRuns: 100 },
		)
	}, 15_000)
})
