/**
 * The mock's Activity ↔ recording link, as the core serves it: rows with `recording` (a dsd-fme
 * call's `call_end`, a scanner analog `recording-change`), `hasRecording` and
 * `refs=recordingId:<key>` on GET /api/activity, `activityEventId` on recordings, and the file
 * route taking a link's id.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	ActivitySearchPage,
	RecordingInventoryPage,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock recording links", () => {
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

	it("links rows and recordings both ways on one id, and plays a row's recording", async () => {
		const rows = (
			await get("/api/activity?hasRecording=true&limit=100")
		).json<ActivitySearchPage>()
		expect(rows.items.length).toBeGreaterThan(0)
		expect(rows.items.every(i => i.recording !== undefined)).toBe(true)
		expect(new Set(rows.items.map(i => i.kind))).toEqual(
			new Set(["decoder-reception", "recording-change"]),
		)
		const recordings = (
			await get("/api/recordings?limit=200")
		).json<RecordingInventoryPage>()
		for (const row of rows.items) {
			const item = recordings.items.find(r => r.key === row.recording?.id)
			expect(item?.activityEventId).toBe(row.eventId)
			const byKey = (
				await get(
					`/api/activity?refs=${encodeURIComponent(`recordingId:${row.recording?.id ?? ""}`)}`,
				)
			).json<ActivitySearchPage>()
			expect(byKey.items.map(i => i.eventId)).toEqual([row.eventId])
			const file = await get(
				`/api/recordings/${encodeURIComponent(row.recording?.id ?? "")}/file`,
			)
			expect(file.statusCode).toBe(200)
			expect(file.headers["content-type"]).toContain("audio/wav")
		}
		const without = (
			await get("/api/activity?hasRecording=false&limit=100")
		).json<ActivitySearchPage>()
		expect(without.items.some(i => i.recording !== undefined)).toBe(false)
		expect((await get("/api/activity?hasRecording=maybe")).statusCode).toBe(400)
	})
})
