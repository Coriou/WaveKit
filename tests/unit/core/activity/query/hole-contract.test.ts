import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { canonicalJson } from "../../../../../src/core/activity/query/canonical.js"
import {
	ActivityCursorGapError,
	ActivityCursorInvalidError,
	ActivityReaderFailedError,
	ActivitySnapshotResetError,
} from "../../../../../src/core/activity/query/errors.js"
import {
	checkReplayHoles,
	holeStateOf,
} from "../../../../../src/core/activity/query/seq.js"
import type {
	ActivityQueryService,
	ActivityReplayFrame,
} from "../../../../../src/core/activity/storage/contract.js"
import { fixtureClock } from "../storage/helpers.js"
import {
	collectReplay,
	createFixture,
	delay,
	openQueryService,
	recordEventIds,
	type ActivityFixture,
} from "./fixture.js"

function payloadOf(token: string): Record<string, unknown> {
	const body = token.slice(0, token.indexOf("."))
	return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
		string,
		unknown
	>
}

/** Re-sign a token after editing its payload (a forged but correctly keyed token). */
function resign(
	token: string,
	key: Buffer,
	edit: (payload: Record<string, unknown>) => void,
): string {
	const payload = payloadOf(token)
	edit(payload)
	const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url")
	const mac = createHmac("sha256", key).update(body).digest("base64url")
	return `${body}.${mac}`
}

function isReset(frames: readonly ActivityReplayFrame[]): boolean {
	return frames.some(frame => frame.type === "reset")
}

function lastCursor(frames: readonly ActivityReplayFrame[]): string {
	for (let index = frames.length - 1; index >= 0; index -= 1) {
		const frame = frames[index]
		if (frame && frame.type !== "reset") return frame.cursor
	}
	throw new Error("no cursor frame")
}

function atHead(fixture: ActivityFixture) {
	return (frames: readonly ActivityReplayFrame[]): boolean =>
		isReset(frames) ||
		frames.some(
			frame =>
				frame.type !== "reset" &&
				frame.scannedThrough === fixture.store.identity().committedMax,
		)
}

describe("activity hole contract (readers)", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	async function setup(count: number): Promise<{
		store: ActivityFixture
		query: ActivityQueryService
		seqs: string[]
	}> {
		const store = await createFixture({ memory: true })
		fixture = store
		const query = openQueryService(store, {
			now: fixtureClock(),
			limits: { replayPage: 2 },
		})
		service = query
		const seqs: string[] = []
		for (let index = 0; index < count; index += 1) {
			seqs.push(store.insert({ eventId: `e${index}`, protocol: "p" }))
		}
		return { store, query, seqs }
	}

	it("reads a store without hole keys as generation 0 and pages it", async () => {
		const { query } = await setup(3)
		const first = await query.search({ query: {}, order: "asc", limit: 1 })
		if (!first.nextPageToken) throw new Error("expected a token")
		expect(payloadOf(first.nextPageToken)["hg"]).toBe(0)
		expect(payloadOf(first.replayCursor)["hg"]).toBe(0)
		const second = await query.search({
			query: {},
			order: "asc",
			limit: 5,
			pageToken: first.nextPageToken,
		})
		expect(second.items.map(item => item.eventId)).toEqual(["e1", "e2"])
	})

	it("records the snapshot generation on the first page and carries it", async () => {
		const { store, query, seqs } = await setup(5)
		store.openHole([seqs[1] ?? ""])
		const first = await query.search({ query: {}, order: "asc", limit: 1 })
		if (!first.nextPageToken) throw new Error("expected a token")
		expect(payloadOf(first.nextPageToken)["hg"]).toBe(1)
		const second = await query.search({
			query: {},
			order: "asc",
			limit: 1,
			pageToken: first.nextPageToken,
		})
		if (!second.nextPageToken) throw new Error("expected a token")
		expect(payloadOf(second.nextPageToken)["hg"]).toBe(1)
		expect(second.items.map(item => item.eventId)).toEqual(["e2"])
	})

	it("resets a page continuation when a hole lands, cached or only on disk", async () => {
		const { store, query, seqs } = await setup(4)
		const first = await query.search({ query: {}, order: "asc", limit: 1 })
		const token = first.nextPageToken
		if (!token) throw new Error("expected a token")
		store.openHole([seqs[2] ?? ""], { diverge: true })
		const onDisk = query.search({ query: {}, order: "asc", pageToken: token })
		await expect(onDisk).rejects.toBeInstanceOf(ActivitySnapshotResetError)
		await expect(onDisk).rejects.toMatchObject({ reason: "snapshot-reset" })
		store.setIdentity({ holeWatermark: seqs[2] ?? "", holeGeneration: 1 })
		await expect(
			query.search({ query: {}, order: "asc", pageToken: token }),
		).rejects.toMatchObject({ reason: "snapshot-reset" })
		// A fresh page started after the reset is not reset again (4.8).
		const fresh = await query.search({ query: {}, order: "asc", limit: 1 })
		if (!fresh.nextPageToken) throw new Error("expected a token")
		const next = await query.search({
			query: {},
			order: "asc",
			pageToken: fresh.nextPageToken,
		})
		expect(next.items.map(item => item.eventId)).toEqual(["e1", "e3"])
	})

	it("resets pages even for a hole above the snapshot high water (conservative)", async () => {
		const { store, query } = await setup(3)
		const first = await query.search({ query: {}, order: "desc", limit: 1 })
		const token = first.nextPageToken
		if (!token) throw new Error("expected a token")
		const later = store.insert({ eventId: "later" })
		store.openHole([later])
		await expect(
			query.search({ query: {}, order: "desc", pageToken: token }),
		).rejects.toMatchObject({ reason: "snapshot-reset" })
	})

	it("accepts a page token without hg as generation 0", async () => {
		const { store, query, seqs } = await setup(3)
		const first = await query.search({ query: {}, order: "asc", limit: 1 })
		if (!first.nextPageToken) throw new Error("expected a token")
		const key = store.store.cursorKey()
		const legacy = resign(first.nextPageToken, key, payload => {
			delete payload["hg"]
		})
		const page = await query.search({
			query: {},
			order: "asc",
			pageToken: legacy,
		})
		expect(page.items.map(item => item.eventId)).toEqual(["e1", "e2"])
		store.openHole([seqs[2] ?? ""])
		await expect(
			query.search({ query: {}, order: "asc", pageToken: legacy }),
		).rejects.toMatchObject({ reason: "snapshot-reset" })
	})

	it("rejects a malformed hg as an invalid token", async () => {
		const { store, query } = await setup(3)
		const first = await query.search({ query: {}, order: "asc", limit: 1 })
		if (!first.nextPageToken) throw new Error("expected a token")
		const key = store.store.cursorKey()
		for (const bad of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
			const forged = resign(first.nextPageToken, key, payload => {
				payload["hg"] = bad
			})
			await expect(
				query.search({ query: {}, order: "asc", pageToken: forged }),
			).rejects.toBeInstanceOf(ActivityCursorInvalidError)
			const replay = await collectReplay(
				query,
				{ query: {}, cursor: forged },
				isReset,
			)
			expect(replay.frames.at(-1)).toMatchObject({
				type: "reset",
				reason: "invalid-cursor",
			})
			replay.handle.stop()
		}
	})

	it("treats corrupt hole keys like a corrupt prune watermark", async () => {
		const { store, query } = await setup(2)
		const cases: readonly (readonly [string, string])[] = [
			["holeWatermark", "abc"],
			["holeWatermark", "-1"],
			["holeWatermark", "01"],
			["holeWatermark", "99999999999999999999"],
			["holeGeneration", "x"],
			["holeGeneration", "1.5"],
			["holeGeneration", "-2"],
			["holeGeneration", "99999999999999999999"],
		]
		for (const [key, value] of cases) {
			store.writeRawMeta(key, value)
			await expect(query.search({ query: {} })).rejects.toBeInstanceOf(
				ActivityReaderFailedError,
			)
			await expect(
				query.facets({ query: {}, dimensions: ["protocol"] }),
			).rejects.toBeInstanceOf(ActivityReaderFailedError)
			store.writeRawMeta(key, null)
		}
		const page = await query.search({ query: {} })
		expect(page.items).toHaveLength(2)
	})

	it("leaves facets and detail unaffected by holes", async () => {
		const { store, query, seqs } = await setup(4)
		store.openHole([seqs[1] ?? ""])
		const facets = await query.facets({ query: {}, dimensions: ["protocol"] })
		expect(facets.facets["protocol"]).toEqual([{ value: "p", count: 3 }])
		expect(await query.detail("e1")).toBeNull()
		expect(await query.detail("e2")).toMatchObject({ eventId: "e2" })
	})

	it("replay adopts a hole at or below its position and continues", async () => {
		const { store, query, seqs } = await setup(3)
		const page = await query.search({ query: {} })
		store.openHole([seqs[0] ?? ""])
		const later = store.insert({ eventId: "later" })
		const followed = await collectReplay(
			query,
			{ query: {}, cursor: page.replayCursor },
			atHead(store),
		)
		expect(isReset(followed.frames)).toBe(false)
		expect(recordEventIds(followed.frames)).toEqual(["later"])
		const cursor = lastCursor(followed.frames)
		expect(payloadOf(cursor)["hg"]).toBe(1)
		followed.handle.stop()
		expect(later).toBe(store.store.identity().committedMax)
	})

	it("replay resets with cursor-gap when a hole is above its position", async () => {
		const { store, query } = await setup(2)
		const page = await query.search({ query: {} })
		const a = store.insert({ eventId: "a" })
		store.insert({ eventId: "b" })
		store.openHole([a])
		const gapped = await collectReplay(
			query,
			{ query: {}, cursor: page.replayCursor },
			isReset,
		)
		expect(gapped.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "cursor-gap",
		})
		gapped.handle.stop()
		// A replay started after the reset is not reset again (4.8).
		const fresh = await query.search({ query: {} })
		store.insert({ eventId: "c" })
		const again = await collectReplay(
			query,
			{ query: {}, cursor: fresh.replayCursor },
			atHead(store),
		)
		expect(isReset(again.frames)).toBe(false)
		expect(recordEventIds(again.frames)).toEqual(["c"])
		again.handle.stop()
	})

	it("replay detects a hole the cache has not seen on its catch-up read", async () => {
		const { store, query } = await setup(1)
		const page = await query.search({ query: {} })
		const a = store.insert({ eventId: "a" })
		store.insert({ eventId: "b" })
		store.openHole([a], { diverge: true })
		const gapped = await collectReplay(
			query,
			{ query: {}, cursor: page.replayCursor },
			isReset,
		)
		expect(gapped.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "cursor-gap",
		})
		expect(recordEventIds(gapped.frames)).toEqual([])
		gapped.handle.stop()
	})

	it("an old replay cursor without hg resets once when HW is above it", async () => {
		const { store, query, seqs } = await setup(2)
		const page = await query.search({ query: {} })
		const key = store.store.cursorKey()
		const legacy = resign(page.replayCursor, key, payload => {
			delete payload["hg"]
		})
		// Generation 1 at or below the position: adopted.
		store.openHole([seqs[0] ?? ""])
		const adopted = await collectReplay(
			query,
			{ query: {}, cursor: legacy },
			atHead(store),
		)
		expect(isReset(adopted.frames)).toBe(false)
		adopted.handle.stop()
		const above = store.insert({ eventId: "x" })
		store.insert({ eventId: "y" })
		store.openHole([above])
		const reset = await collectReplay(
			query,
			{ query: {}, cursor: legacy },
			isReset,
		)
		expect(reset.frames.at(-1)).toMatchObject({
			type: "reset",
			reason: "cursor-gap",
		})
		reset.handle.stop()
	})

	it("never resets a live follower at the head", async () => {
		const { store, query, seqs } = await setup(3)
		const frames: ActivityReplayFrame[] = []
		const handle = query.replay(
			{ query: {} },
			{
				send(frame) {
					frames.push(frame)
					return true
				},
			},
		)
		await delay(20)
		store.openHole([seqs[1] ?? ""])
		store.notify()
		await delay(20)
		const next = store.insert({ eventId: "next" })
		store.openHole([seqs[2] ?? ""])
		store.notify()
		const started = Date.now()
		while (!recordEventIds(frames).includes("next")) {
			if (Date.now() - started > 1_000)
				throw new Error("follower did not advance")
			await delay(10)
		}
		expect(isReset(frames)).toBe(false)
		expect(lastCursor(frames)).toBeDefined()
		expect(payloadOf(lastCursor(frames))["hg"]).toBe(2)
		expect(next).toBe(store.store.identity().committedMax)
		handle.stop()
	})
})

describe("checkReplayHoles", () => {
	it("keeps, adopts or gaps", () => {
		expect(checkReplayHoles(1, { generation: 1, watermark: 9n }, 3n)).toBe(1)
		expect(checkReplayHoles(0, { generation: 2, watermark: 3n }, 3n)).toBe(2)
		expect(() =>
			checkReplayHoles(0, { generation: 1, watermark: 4n }, 3n),
		).toThrow(ActivityCursorGapError)
	})

	it("reads absent identity keys as 0", () => {
		expect(holeStateOf({})).toEqual({ generation: 0, watermark: 0n })
	})
})
