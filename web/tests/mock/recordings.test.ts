import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	RecordingInventoryItem,
	RecordingInventoryPage,
} from "@wavekit/api-types"
import { RECORDING_INVENTORY_ID } from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock recordings routes", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const list = async (query = "") => {
		const res = await server.app.inject({
			method: "GET",
			url: `/api/recordings${query}`,
		})
		return { status: res.statusCode, body: res.json<RecordingInventoryPage>() }
	}
	const all = async (): Promise<RecordingInventoryItem[]> =>
		(await list("?limit=200")).body.items
	const enc = encodeURIComponent

	it("lists core-shaped items, newest first, with valid ids", async () => {
		const items = await all()
		expect(items.length).toBeGreaterThan(10)
		for (const it of items)
			expect(RECORDING_INVENTORY_ID.test(it.id)).toBe(true)
		const times = items.map(i => i.modifiedAt)
		expect([...times].sort().reverse()).toEqual(times)
		expect(
			items.some(
				i =>
					i.kind === "scanner-analog" &&
					i.discoveryId !== null &&
					i.frequencyHz !== null,
			),
		).toBe(true)
	})

	it("pages with an opaque cursor and filters by kind", async () => {
		const first = await list("?limit=3")
		expect(first.body.items).toHaveLength(3)
		expect(first.body.nextCursor).not.toBeNull()
		const second = await list(`?limit=3&cursor=${first.body.nextCursor ?? ""}`)
		const everything = await all()
		expect([...first.body.items, ...second.body.items].map(i => i.id)).toEqual(
			everything.slice(0, 6).map(i => i.id),
		)
		const calls = await list("?kind=dsd-fme-call&limit=200")
		expect(calls.body.items.every(i => i.kind === "dsd-fme-call")).toBe(true)
		expect((await list("?limit=0")).status).toBe(400)
		expect((await list("?kind=iq")).status).toBe(400)
		expect((await list("?cursor=%%%")).status).toBe(400)
	})

	it("serves the WAV file with the core's headers", async () => {
		const id = (await all())[0]?.id ?? ""
		const res = await server.app.inject({
			method: "GET",
			url: `/api/recordings/${enc(id)}/file`,
		})
		expect(res.statusCode).toBe(200)
		expect(res.headers["content-type"]).toBe("audio/wav")
		expect(res.headers["content-disposition"]).toMatch(
			/^attachment; filename=".+\.wav"$/,
		)
		expect(res.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF")
		const missing = await server.app.inject({
			method: "GET",
			url: "/api/recordings/nope/file",
		})
		expect(missing.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" })
	})

	it("keeps, refuses to delete kept or scanner recordings, and deletes calls", async () => {
		const items = await all()
		const callItem = items.find(i => i.kind === "dsd-fme-call" && !i.kept)
		const scanItem = items.find(i => i.kind !== "dsd-fme-call" && !i.kept)
		if (!callItem || !scanItem) throw new Error("seeds")
		const keep = await server.app.inject({
			method: "PUT",
			url: `/api/recordings/${enc(callItem.id)}/keep`,
		})
		expect(keep.json()).toEqual({ id: callItem.id, kept: true, changed: true })
		const kept = await server.app.inject({
			method: "DELETE",
			url: `/api/recordings/${enc(callItem.id)}`,
		})
		expect(kept.statusCode).toBe(409)
		expect(kept.json()).toMatchObject({ code: "RECORDING_KEPT" })
		await server.app.inject({
			method: "DELETE",
			url: `/api/recordings/${enc(callItem.id)}/keep`,
		})
		const del = await server.app.inject({
			method: "DELETE",
			url: `/api/recordings/${enc(callItem.id)}`,
		})
		expect(del.json()).toEqual({ id: callItem.id, deleted: true })
		expect((await all()).some(i => i.id === callItem.id)).toBe(false)
		const scanDel = await server.app.inject({
			method: "DELETE",
			url: `/api/recordings/${enc(scanItem.id)}`,
		})
		expect(scanDel.json()).toMatchObject({
			code: "RECORDING_DELETE_UNSUPPORTED",
		})
	})
})
