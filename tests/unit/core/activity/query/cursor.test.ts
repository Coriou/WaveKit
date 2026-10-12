import { afterEach, describe, expect, it } from "vitest"
import { issueCursor } from "../../../../../src/core/activity/query/cursor.js"
import { ActivityCursorInvalidError } from "../../../../../src/core/activity/query/errors.js"
import { hashQuery, normaliseQuery } from "../../../../../src/core/activity/query/validate.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../../../src/core/activity/query/service.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import { createFixture, openQueryService, type ActivityFixture } from "./fixture.js"

describe("activity cursors", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	async function pageToken(): Promise<{
		fixture: ActivityFixture
		service: ActivityQueryService
		token: string
		now: { value: number }
	}> {
		fixture = await createFixture()
		const now = { value: Date.parse("2026-06-01T00:00:00.000Z") }
		service = openQueryService(fixture, {
			now: () => now.value,
			limits: { snapshotTtlMs: 60_000 },
		})
		fixture.insert({ eventId: "a" })
		fixture.insert({ eventId: "b" })
		fixture.insert({ eventId: "c" })
		const page = await service.search({ query: {}, order: "asc", limit: 1 })
		if (!page.nextPageToken) throw new Error("expected a page token")
		return { fixture, service, token: page.nextPageToken, now }
	}

	it("rejects a tampered payload, a tampered mac, and a short mac", async () => {
		const { service: query, token } = await pageToken()
		const dot = token.indexOf(".")
		const body = token.slice(0, dot)
		const mac = token.slice(dot + 1)
		const flip = (value: string): string => {
			const chars = [...value]
			const index = Math.min(1, chars.length - 1)
			const current = chars[index] ?? "A"
			chars[index] = current === "A" ? "B" : "A"
			return chars.join("")
		}
		const flippedBody = `${flip(body)}.${mac}`
		const flippedMac = `${body}.${flip(mac)}`
		const shortMac = `${body}.YQ`
		await expect(
			query.search({ query: {}, order: "asc", pageToken: flippedBody }),
		).rejects.toBeInstanceOf(ActivityCursorInvalidError)
		await expect(
			query.search({ query: {}, order: "asc", pageToken: flippedMac }),
		).rejects.toBeInstanceOf(ActivityCursorInvalidError)
		await expect(
			query.search({ query: {}, order: "asc", pageToken: shortMac }),
		).rejects.toBeInstanceOf(ActivityCursorInvalidError)
	})

	it("expires a continuation at the original snapshot time", async () => {
		const { service: query, token, now } = await pageToken()
		const first = await query.search({ query: {}, order: "asc", limit: 1, pageToken: token })
		expect(first.items).toHaveLength(1)
		const expiresAt = Date.parse(first.snapshot.expiresAt)
		now.value = expiresAt
		await expect(
			query.search({
				query: {},
				order: "asc",
				limit: 1,
				pageToken: first.nextPageToken ?? token,
			}),
		).rejects.toMatchObject({
			code: "ACTIVITY_SNAPSHOT_RESET",
			reason: "cursor-expired",
			statusCode: 409,
		})
	})

	it("does not treat a continuation sitting on the prune watermark as a gap", async () => {
		const { fixture: store, service: query, token } = await pageToken()
		store.setIdentity({ pruneWatermark: "1" })
		await expect(
			query.search({ query: {}, order: "asc", limit: 1, pageToken: token }),
		).rejects.toMatchObject({
			code: "ACTIVITY_SNAPSHOT_RESET",
			reason: "snapshot-reset",
			statusCode: 409,
		})
	})

	it("reports a gap when the continuation seq is behind the prune watermark", async () => {
		const { fixture: store, service: query, token } = await pageToken()
		store.setIdentity({ pruneWatermark: "2" })
		await expect(
			query.search({ query: {}, order: "asc", limit: 1, pageToken: token }),
		).rejects.toMatchObject({
			code: "ACTIVITY_CURSOR_GAP",
			reason: "cursor-gap",
			statusCode: 410,
		})
	})

	it("reports a snapshot reset when the lower bound moved but the cursor seq remains", async () => {
		const { fixture: store, service: query } = await pageToken()
		const first = await query.search({ query: {}, order: "desc", limit: 1 })
		store.setIdentity({ pruneWatermark: "1" })
		await expect(
			query.search({
				query: {},
				order: "desc",
				limit: 1,
				pageToken: first.nextPageToken ?? "",
			}),
		).rejects.toMatchObject({
			code: "ACTIVITY_SNAPSHOT_RESET",
			reason: "snapshot-reset",
			statusCode: 409,
		})
	})

	it("resets when the store uuid changes", async () => {
		const opened = await pageToken()
		opened.fixture.setIdentity({ storeUuid: "00000000-0000-4000-8000-000000000000" })
		await expect(
			opened.service.search({ query: {}, order: "asc", pageToken: opened.token }),
		).rejects.toMatchObject({ reason: "store-changed", statusCode: 409 })
	})

	it("resets when the restore generation changes", async () => {
		const opened = await pageToken()
		opened.fixture.setIdentity({ restoreGeneration: 9 })
		await expect(
			opened.service.search({ query: {}, order: "asc", pageToken: opened.token }),
		).rejects.toMatchObject({ reason: "store-changed", statusCode: 409 })
	})

	it("resets when the query or the order changes", async () => {
		const { service: query, token } = await pageToken()
		await expect(
			query.search({
				query: { kinds: ["ingestion-gap"] },
				order: "asc",
				pageToken: token,
			}),
		).rejects.toMatchObject({ reason: "query-changed", statusCode: 409 })
		await expect(
			query.search({ query: {}, order: "desc", pageToken: token }),
		).rejects.toMatchObject({ reason: "query-changed" })
	})

	it("does not treat a replay cursor at the origin as a gap", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture)
		const page = await service.search({ query: {} })
		const frames: { type: string }[] = []
		const followed = service.replay({ query: {}, cursor: page.replayCursor }, {
			send(frame) {
				frames.push(frame)
				return true
			},
		})
		followed.stop()
		expect(frames[0]).toMatchObject({ type: "progress" })
		expect(frames.some(frame => frame.type === "reset")).toBe(false)
		const identity = fixture.store.identity()
		const token = issueCursor({
			key: fixture.store.cursorKey(),
			identity,
			queryHash: hashQuery(normaliseQuery({}, DEFAULT_ACTIVITY_QUERY_LIMITS)),
			order: "asc",
			lastSeq: 0n,
			high: 0n,
			expiresAtMs: Date.now() + 60_000,
		}).token
		expect(identity.pruneWatermark).toBe("0")
		await expect(
			service.search({ query: {}, order: "asc", pageToken: token }),
		).rejects.toBeInstanceOf(ActivityCursorInvalidError)
	})

	it("round-trips the sqlite int64 maximum as a decimal string", () => {
		const key = Buffer.alloc(32, 7)
		const issued = issueCursor({
			key,
			identity: {
				storeUuid: "store",
				restoreGeneration: 1,
				pruneWatermark: "0",
				pruneGeneration: 0,
				committedMax: "9223372036854775807",
			},
			queryHash: "a".repeat(64),
			order: "asc",
			lastSeq: 9223372036854775807n,
			high: 9223372036854775807n,
			expiresAtMs: Date.now() + 1_000,
		})
		expect(issued.lastSeq).toBe("9223372036854775807")
		expect(issued.token.includes(".")).toBe(true)
	})
})
