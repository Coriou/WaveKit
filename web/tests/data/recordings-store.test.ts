import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"
import { RecordingsStore } from "../../src/data/recordings-store.ts"
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

const page = (
	items: RecordingInventoryItem[],
	nextCursor: string | null = null,
) => ({
	items,
	nextCursor,
	scannedFiles: items.length,
	truncated: false,
	scannedAt: "2026-10-17T08:01:00.000Z",
})

const A = "dsd:0~20261017_100000_00001_DMR_SLOT1_GROUP_TGT_2081_SRC_2081012.wav"
const B = "dsd:0~20261017_090000_00002_DMR_SLOT1_GROUP_TGT_9_SRC_2081045.wav"

afterEach(() => {
	vi.useRealTimers()
})

describe("RecordingsStore", () => {
	it("reads every page with the largest page size, following the cursor", async () => {
		const { api, calls } = scripted(call =>
			call.url.includes("cursor=c1")
				? json(200, page([item(B)]))
				: json(200, page([item(A)], "c1")),
		)
		const store = new RecordingsStore(api)
		await store.refresh()
		expect(calls.map(c => c.url)).toEqual([
			"/api/recordings?limit=200",
			"/api/recordings?limit=200&cursor=c1",
		])
		expect(store.get().items.map(i => i.id)).toEqual([A, B])
		expect(store.get()).toMatchObject({
			loaded: true,
			loading: false,
			unavailable: null,
			error: null,
		})
	})

	it("says the routes need a protected core when the route is not mounted", async () => {
		const { api } = scripted(() =>
			json(404, {
				error: "Not Found",
				code: "NOT_FOUND",
				message: "Route GET:/api/recordings not found",
			}),
		)
		const store = new RecordingsStore(api)
		await store.refresh()
		expect(store.get()).toMatchObject({
			loaded: true,
			unavailable: "protected-only",
			error: null,
		})
	})

	it("keeps the list and reports a failed refresh", async () => {
		let fail = false
		const { api } = scripted(() =>
			fail
				? json(503, {
						error: "Service Unavailable",
						code: "RECORDINGS_UNAVAILABLE",
						message: "Recordings are unavailable",
					})
				: json(200, page([item(A)])),
		)
		const store = new RecordingsStore(api)
		await store.refresh()
		fail = true
		await store.refresh()
		expect(store.get().items).toHaveLength(1)
		expect(store.get().error).toBe("Recordings are unavailable")
	})

	it("keeps at once, settles on the core's answer and reverts on an error", async () => {
		let answer: Response = json(200, { id: A, kept: true, changed: true })
		const { api, calls } = scripted(call =>
			call.method === "GET" ? json(200, page([item(A)])) : answer,
		)
		const store = new RecordingsStore(api)
		await store.refresh()
		const pending = store.setKept(A, true)
		expect(store.get().items[0]?.kept).toBe(true)
		expect(store.get().keeping.has(A)).toBe(true)
		await pending
		expect(calls.at(-1)).toMatchObject({
			method: "PUT",
			url: `/api/recordings/${encodeURIComponent(A)}/keep`,
		})
		expect(store.get().keeping.size).toBe(0)

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
		await store.refresh()
		const onError = vi.fn()
		const undo = store.scheduleRemove(B, onError, 1000)
		expect(store.get().removing.has(B)).toBe(true)
		undo()
		expect(store.get().removing.has(B)).toBe(false)
		store.scheduleRemove(A, onError, 1000)
		await vi.advanceTimersByTimeAsync(1000)
		expect(calls.filter(c => c.method === "DELETE").map(c => c.url)).toEqual([
			`/api/recordings/${encodeURIComponent(A)}`,
		])
		expect(store.get().items.map(i => i.id)).toEqual([B])
		expect(store.get().removing.size).toBe(0)
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
		await store.refresh()
		const onError = vi.fn()
		store.scheduleRemove(A, onError, 10)
		await vi.advanceTimersByTimeAsync(10)
		expect(onError).toHaveBeenCalledTimes(1)
		expect(store.get().items).toHaveLength(1)
		expect(store.get().removing.size).toBe(0)
	})

	it("flushes waiting deletes when the page goes away", async () => {
		const { api, calls } = scripted(call =>
			call.method === "GET"
				? json(200, page([item(A)]))
				: json(200, { id: A, deleted: true }),
		)
		const store = new RecordingsStore(api)
		await store.refresh()
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
