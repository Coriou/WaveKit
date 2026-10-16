import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { issueCursor } from "../../../../../src/core/activity/query/cursor.js"
import { ActivityReaderFailedError } from "../../../../../src/core/activity/query/errors.js"
import { startReplay } from "../../../../../src/core/activity/query/replay.js"
import {
	hashQuery,
	normaliseQuery,
} from "../../../../../src/core/activity/query/validate.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../../../src/core/activity/query/service.js"
import type {
	ActivityQuery,
	ActivityQueryService,
	ActivityReplayFrame,
	StoreIdentity,
} from "../../../../../src/core/activity/storage/contract.js"
import {
	collectReplay,
	createFixture,
	delay,
	openQueryService,
	recordEventIds,
	testLogger,
	type ActivityFixture,
} from "./fixture.js"

const query: ActivityQuery = {}

function originCursor(
	fixture: ActivityFixture,
	nowMs: number,
	ttlMs = DEFAULT_ACTIVITY_QUERY_LIMITS.snapshotTtlMs,
): string {
	return issueCursor({
		key: fixture.store.cursorKey(),
		identity: fixture.store.identity(),
		queryHash: hashQuery(normaliseQuery(query, DEFAULT_ACTIVITY_QUERY_LIMITS)),
		order: "asc",
		lastSeq: 0n,
		high: 0n,
		expiresAtMs: nowMs + ttlMs,
	}).token
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const started = Date.now()
	while (!predicate()) {
		if (Date.now() - started > 1_000)
			throw new Error("timed out waiting for replay")
		await delay(10)
	}
}

describe("activity replay", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	it("starts live at the committed max and follows later commits", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store)
		const live = await collectReplay(
			service,
			{ query },
			frames => frames.length >= 1,
		)
		const first = live.frames[0]
		expect(first).toMatchObject({ type: "progress", scannedThrough: "0" })
		live.handle.stop()
		store.insert({ eventId: "later" })
		const cursor = first && first.type !== "reset" ? first.cursor : ""
		const followed = await collectReplay(service, { query, cursor }, frames =>
			recordEventIds(frames).includes("later"),
		)
		expect(recordEventIds(followed.frames)).toEqual(["later"])
		followed.handle.stop()
	})

	it("pauses when the sink is full and resumes without duplicating rows", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store, { limits: { replayPage: 1 } })
		for (const eventId of ["a", "b", "c", "d"]) store.insert({ eventId })
		const frames: ActivityReplayFrame[] = []
		let block = true
		const handle = service.replay(
			{ query, cursor: originCursor(store, Date.now()) },
			{
				send(frame) {
					frames.push(frame)
					if (block && frame.type === "records") return false
					return true
				},
			},
		)
		await waitFor(() => recordEventIds(frames).length === 1)
		block = false
		handle.resume()
		await waitFor(() => recordEventIds(frames).length === 4)
		expect(recordEventIds(frames)).toEqual(["a", "b", "c", "d"])
		handle.stop()
		handle.stop()
		expect(store.listenerCount()).toBe(0)
	})

	it("resets on gap, store change, query change, and expiry", async () => {
		fixture = await createFixture()
		const store = fixture
		let now = Date.parse("2026-06-01T00:00:00.000Z")
		service = openQueryService(store, {
			now: () => now,
			limits: { snapshotTtlMs: 1_000, replayPage: 2 },
		})
		store.insert({ eventId: "a" })
		store.insert({ eventId: "b" })
		store.insert({ eventId: "c" })
		const caught = await collectReplay(
			service,
			{ query, cursor: originCursor(store, now) },
			frames => recordEventIds(frames).length === 3,
		)
		const cursor = caught.frames.find(frame => frame.type === "records")
		if (!cursor || cursor.type !== "records")
			throw new Error("expected records")
		caught.handle.stop()

		store.setIdentity({ pruneWatermark: cursor.scannedThrough })
		const level = await collectReplay(
			service,
			{ query, cursor: cursor.cursor },
			frames => frames.length >= 1,
		)
		expect(level.frames.some(frame => frame.type === "reset")).toBe(false)
		level.handle.stop()

		store.setIdentity({
			pruneWatermark: String(BigInt(cursor.scannedThrough) + 1n),
		})
		const gapped = await collectReplay(
			service,
			{ query, cursor: cursor.cursor },
			frames => frames.some(frame => frame.type === "reset"),
		)
		expect(gapped.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "cursor-gap",
		})
		gapped.handle.stop()
		store.setIdentity({ pruneWatermark: "0" })

		const live = await collectReplay(
			service,
			{ query },
			frames => frames.length >= 1,
		)
		store.setIdentity({ storeUuid: "changed-store" })
		store.notify()
		await waitFor(() => live.frames.some(frame => frame.type === "reset"))
		expect(live.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "store-changed",
		})
		live.handle.stop()

		const other = hashQuery(
			normaliseQuery(
				{ kinds: ["ingestion-gap"] },
				DEFAULT_ACTIVITY_QUERY_LIMITS,
			),
		)
		expect(other).not.toBe(
			hashQuery(normaliseQuery(query, DEFAULT_ACTIVITY_QUERY_LIMITS)),
		)
		const changed = await collectReplay(
			service,
			{ query: { kinds: ["ingestion-gap"] }, cursor: originCursor(store, now) },
			frames => frames.some(frame => frame.type === "reset"),
		)
		expect(changed.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "query-changed",
		})
		changed.handle.stop()

		const fresh = originCursor(store, now, 1_000)
		now += 5_000
		const expired = await collectReplay(
			service,
			{ query, cursor: fresh },
			frames => frames.some(frame => frame.type === "reset"),
		)
		expect(expired.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "cursor-expired",
		})
		expired.handle.stop()
	})

	it("stops once and ignores later commits", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store)
		const live = await collectReplay(
			service,
			{ query },
			frames => frames.length >= 1,
		)
		const before = live.frames.length
		live.handle.stop()
		live.handle.stop()
		store.insert({ eventId: "after" })
		store.notify()
		await delay(30)
		expect(live.frames).toHaveLength(before)
		expect(store.listenerCount()).toBe(0)
	})

	it("treats a prune the cache has not seen as a cursor gap", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store)
		store.insert({ eventId: "a" })
		store.insert({ eventId: "b" })
		store.insert({ eventId: "c" })
		const cursor = originCursor(store, Date.now())
		store.divergePrune("2")
		expect(store.store.identity().pruneWatermark).toBe("0")
		const gapped = await collectReplay(service, { query, cursor }, frames =>
			frames.some(frame => frame.type === "reset"),
		)
		expect(recordEventIds(gapped.frames)).toEqual([])
		expect(gapped.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "cursor-gap",
		})
		gapped.handle.stop()
	})

	it("sends reader-failed when a read fails after the commit wakeup", async () => {
		const key = Buffer.alloc(32, 4)
		let committed = 0n
		const listeners = new Set<(identity: StoreIdentity) => void>()
		const identity = (): StoreIdentity => ({
			storeUuid: "store",
			restoreGeneration: 1,
			pruneWatermark: "0",
			pruneGeneration: 0,
			committedMax: committed.toString(),
		})
		let reads = 0
		const frames: ActivityReplayFrame[] = []
		const handle = startReplay(
			{
				store: {
					identity,
					cursorKey: () => Buffer.from(key),
					onCommit(listener) {
						listeners.add(listener)
						return () => {
							listeners.delete(listener)
						}
					},
				},
				now: () => Date.parse("2026-06-01T00:00:00.000Z"),
				limits: DEFAULT_ACTIVITY_QUERY_LIMITS,
				log: testLogger,
				clientKey: "client",
				read: () => {
					reads += 1
					return Promise.reject(
						new ActivityReaderFailedError("reader exploded"),
					)
				},
				register() {},
				unregister() {},
			},
			{ query },
			{
				send(frame) {
					frames.push(frame)
					return true
				},
			},
		)
		await delay(20)
		expect(frames[0]).toMatchObject({ type: "progress", scannedThrough: "0" })
		expect(reads).toBe(0)
		committed = 1n
		for (const listener of listeners) listener(identity())
		await waitFor(() => frames.some(frame => frame.type === "reset"))
		expect(frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "reader-failed",
		})
		expect(reads).toBe(1)
		const before = frames.length
		committed = 2n
		for (const listener of listeners) listener(identity())
		await delay(30)
		expect(frames).toHaveLength(before)
		handle.stop()
	})

	it("sends an invalid-cursor reset when the service is already closed", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture)
		await service.close()
		const frames: ActivityReplayFrame[] = []
		const handle = service.replay(
			{ query },
			{
				send(frame) {
					frames.push(frame)
					return true
				},
			},
		)
		expect(frames).toEqual([{ type: "reset", reason: "invalid-cursor" }])
		handle.stop()
		service = undefined
	})

	// Feature: event-foundation-batch1, Property 3: replay no-loss and harmless duplicates
	it("replays every committed row, and a reconnect repeats only a prefix", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store, { limits: { replayPage: 3 } })
		const queryService = service
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 0, max: 6 }), async count => {
				store.reset()
				const expected: string[] = []
				for (let index = 0; index < count; index += 1) {
					expected.push(`e${index}`)
					store.insert({ eventId: `e${index}` })
				}
				const cursor = originCursor(store, Date.now())
				const first = await collectReplay(
					queryService,
					{ query, cursor },
					frames =>
						count === 0
							? frames.some(frame => frame.type === "progress")
							: recordEventIds(frames).length >= count,
				)
				const firstIds = recordEventIds(first.frames)
				expect(firstIds).toEqual(expected)
				expect(new Set(firstIds).size).toBe(expected.length)
				first.handle.stop()

				const second = await collectReplay(
					queryService,
					{ query, cursor },
					frames =>
						count === 0
							? frames.some(frame => frame.type === "progress")
							: recordEventIds(frames).length >= count,
				)
				expect(recordEventIds(second.frames)).toEqual(expected)
				second.handle.stop()

				const records = first.frames.find(frame => frame.type === "records")
				if (records && records.type === "records") {
					const through = BigInt(records.scannedThrough)
					const suffix = first.frames
						.flatMap(frame =>
							frame.type === "records" ? [...frame.items] : [],
						)
						.filter(item => BigInt(item.commitSeq) > through)
						.map(item => item.eventId)
					const resumed = await collectReplay(
						queryService,
						{ query, cursor: records.cursor },
						frames =>
							frames.some(frame => frame.type === "reset") ||
							recordEventIds(frames).length >= suffix.length,
					)
					expect(resumed.frames.some(frame => frame.type === "reset")).toBe(
						false,
					)
					expect(recordEventIds(resumed.frames)).toEqual(suffix)
					resumed.handle.stop()
				}
			}),
			{ numRuns: 100 },
		)
	}, 15_000)
})
