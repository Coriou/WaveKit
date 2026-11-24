/**
 * The mock's GET /api/transmissions/:ref, as the core answers it: 400 for a malformed ref, 404 for
 * an unknown one (and every `tx_`: the mock mints no ids), a recording's and its Activity row's
 * transmission by `rec:` and `evt:`, and a digital call's file only when its row links it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	ActivitySearchPage,
	RecordingInventoryPage,
	TransmissionDto,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock transmissions", () => {
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
	const tx = (ref: string) =>
		get(`/api/transmissions/${encodeURIComponent(ref)}`)

	it("400 for a malformed ref, 404 for an unknown one", async () => {
		for (const ref of ["bogus", "rec:", "rec:a b"]) {
			const res = await tx(ref)
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({ code: "TRANSMISSION_REF_INVALID" })
		}
		for (const ref of [
			`tx_01JTESTTX${"A".repeat(17)}`,
			"rec:scan:none",
			"evt:none",
			"obs:none",
		]) {
			const res = await tx(ref)
			expect(res.statusCode).toBe(404)
			expect(res.json()).toMatchObject({ code: "TRANSMISSION_NOT_FOUND" })
		}
	})

	it("a recording and its row resolve to one transmission", async () => {
		const rows = (
			await get("/api/activity?hasRecording=true&limit=100")
		).json<ActivitySearchPage>()
		const recordings = (
			await get("/api/recordings?limit=200")
		).json<RecordingInventoryPage>()
		const row = rows.items.find(i => i.kind === "recording-change")
		expect(row).toBeDefined()
		const key = row!.recording!.id
		const byRec = (await tx(`rec:${key}`)).json<TransmissionDto>()
		const byEvt = (await tx(`evt:${row!.eventId}`)).json<TransmissionDto>()
		for (const dto of [byRec, byEvt]) {
			expect(dto.id).toBeNull()
			expect(dto.kind).toBe("voice-analog")
			expect(dto.refs.recordingKeys).toEqual([key])
			expect(dto.refs.eventIds).toEqual([row!.eventId])
			expect(dto.artefacts.map(a => a.id)).toEqual([key])
			expect(dto.privacy).toBeNull()
		}
		const call = recordings.items.find(
			i => i.kind === "dsd-fme-call" && typeof i.activityEventId === "string",
		)
		if (call) {
			const dto = (
				await tx(`rec:${call.key ?? call.id}`)
			).json<TransmissionDto>()
			expect(dto.kind).toBe("voice-digital")
			expect(dto.privacy).toBe("clear")
			expect(dto.artefacts).toHaveLength(1)
		}
		const unlinked = recordings.items.find(
			i => i.kind === "dsd-fme-call" && i.activityEventId == null,
		)
		if (unlinked) {
			const dto = (
				await tx(`rec:${unlinked.key ?? unlinked.id}`)
			).json<TransmissionDto>()
			expect(dto.privacy).toBe("unproven")
			expect(dto.artefacts).toEqual([])
		}
	})
})
