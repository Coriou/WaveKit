/**
 * The mock's copies, as the core serves them: scanner analog items carry `copyOf` (one seeded ghost
 * pair, made-up frequencies), `copies=false` leaves copies out of the listing and `matched` but never
 * `counts` (`copiesTotal` counts them), a Kept copy is never left out nor counted, an invalid value is 400, and GET /api/transmissions gives the
 * original its `copy.copies` and the copy its `copy.of`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	RecordingInventoryPage,
	TransmissionDto,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock recordings: copies", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({
			port: 0,
			audioOrigin: "http://localhost:3102",
		})
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const get = (url: string) => server.app.inject({ method: "GET", url })
	const page = async (query: string) =>
		(
			await get(`/api/recordings?limit=200${query}`)
		).json<RecordingInventoryPage>()

	it("lists copies by default; copies=false leaves them out of the listing and matched, never counts", async () => {
		const all = await page("")
		const copies = all.items.filter(i => (i.copyOf ?? null) !== null)
		expect(copies).toHaveLength(1)
		expect(all.counts?.copiesTotal).toBe(1)
		// every scanner analog item says whether it is a copy; other kinds say nothing
		for (const i of all.items)
			if (i.kind === "scanner-analog") expect(i).toHaveProperty("copyOf")
			else expect(i).not.toHaveProperty("copyOf")
		const copy = copies[0]!
		expect(copy.copyOf?.evidence).toEqual(["intermod", "off-raster"])
		const root = all.items.find(i => (i.key ?? i.id) === copy.copyOf?.key)
		expect(root?.copyOf).toBeNull()
		expect(root?.frequencyHz).not.toBe(copy.frequencyHz)
		const hidden = await page("&copies=false")
		expect(hidden.items.some(i => i.id === copy.id)).toBe(false)
		expect(hidden.matched).toBe((all.matched ?? 0) - 1)
		expect(hidden.counts?.total).toBe(all.counts?.total)
		expect(hidden.counts?.copiesTotal).toBe(1)
		expect((await page("&copies=true")).items).toHaveLength(all.items.length)
		const bad = await get("/api/recordings?copies=maybe")
		expect(bad.statusCode).toBe(400)
		expect(bad.json()).toMatchObject({ code: "RECORDINGS_QUERY_INVALID" })
	})

	it("never hides nor counts a Kept copy (the user's word on that file)", async () => {
		const all = await page("")
		const copy = all.items.find(i => (i.copyOf ?? null) !== null)!
		const id = encodeURIComponent(copy.id)
		expect(
			(
				await server.app.inject({
					method: "PUT",
					url: `/api/recordings/${id}/keep`,
				})
			).statusCode,
		).toBeLessThan(300)
		try {
			const hidden = await page("&copies=false")
			expect(hidden.items.some(i => i.id === copy.id)).toBe(true)
			expect(hidden.counts?.copiesTotal).toBe(0)
			expect(hidden.matched).toBe(all.matched)
		} finally {
			await server.app.inject({
				method: "DELETE",
				url: `/api/recordings/${id}/keep`,
			})
		}
		expect((await page("")).counts?.copiesTotal).toBe(1)
	})

	it("serves TransmissionDto.copy: the original's copies, the copy's original", async () => {
		const all = await page("")
		const copy = all.items.find(i => (i.copyOf ?? null) !== null)!
		const rootKey = copy.copyOf!.key
		const root = all.items.find(i => (i.key ?? i.id) === rootKey)!
		const tx = async (key: string) =>
			(
				await get(`/api/transmissions/${encodeURIComponent(`rec:${key}`)}`)
			).json<TransmissionDto>()
		const ofRoot = await tx(rootKey)
		expect(ofRoot.copy).toEqual({
			of: null,
			copies: [
				{
					ref: `rec:${copy.key ?? copy.id}`,
					hz: copy.facts?.frequencyHz ?? copy.frequencyHz,
					recordingKey: copy.key ?? copy.id,
					evidence: ["intermod", "off-raster"],
				},
			],
			copiesTotal: 1,
		})
		const ofCopy = await tx(copy.key ?? copy.id)
		expect(ofCopy.copy).toEqual({
			of: {
				ref: `rec:${rootKey}`,
				hz: root.facts?.frequencyHz ?? root.frequencyHz,
			},
			copies: [],
			copiesTotal: 0,
		})
		// an analog recording with neither: null
		const plain = all.items.find(
			i =>
				i.kind === "scanner-analog" &&
				(i.copyOf ?? null) === null &&
				(i.key ?? i.id) !== rootKey,
		)!
		expect((await tx(plain.key ?? plain.id)).copy).toBeNull()
	})
})
