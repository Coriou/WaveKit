/**
 * The mock's recordings routes apply the core's rule six: a per-call file (dsd-fme's YSF calls,
 * the call recorder's) is listed, counted and served only while its call's Activity row links
 * it (`activityEventId`); unlinked, it is absent and its file route answers 404 by id and by key.
 */
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryPage } from "@wavekit/api-types"
import {
	createRecordingsState,
	linkRecordingActivity,
	recordingSeeds,
	registerRecordingsMock,
} from "../../mock/recordings.ts"

let app: FastifyInstance | undefined
let stop: (() => void) | undefined
afterEach(async () => {
	stop?.()
	await app?.close()
	app = undefined
})

const isCall = (kind: string) => kind === "dsd-fme-call" || kind === "dv-call"

describe("mock recordings: a call file only with its call row's link", () => {
	it("lists and serves no unlinked call file, then the one its row links", async () => {
		const state = createRecordingsState()
		const calls = recordingSeeds(state).filter(i => isCall(i.kind))
		expect(calls.length).toBeGreaterThan(1)
		app = Fastify({ logger: false })
		// No new calls during the test (each would land with its own row).
		stop = registerRecordingsMock(app, { state, newCallMs: 3_600_000 }).stop
		await app.ready()
		const list = async () =>
			(
				await app!.inject({ method: "GET", url: "/api/recordings?limit=200" })
			).json<RecordingInventoryPage>()
		const file = async (id: string) =>
			(
				await app!.inject({
					method: "GET",
					url: `/api/recordings/${encodeURIComponent(id)}/file`,
				})
			).statusCode

		const before = await list()
		expect(before.items.filter(i => isCall(i.kind))).toEqual([])
		expect(before.counts?.byKind["dsd-fme-call"]).toBe(0)
		expect(before.counts?.byKind["dv-call"]).toBe(0)
		const [linked, unlinked] = calls
		if (!linked || !unlinked) throw new Error("two call seeds expected")
		for (const c of calls) {
			expect(await file(c.id)).toBe(404)
			if (c.key) expect(await file(c.key)).toBe(404)
		}

		linkRecordingActivity(
			state,
			linked.id,
			"00000000-0000-4000-8000-0000000000aa",
		)
		const after = await list()
		expect(after.items.filter(i => isCall(i.kind)).map(i => i.id)).toEqual([
			linked.id,
		])
		expect(after.scannedFiles).toBe(before.scannedFiles + 1)
		expect(await file(linked.id)).toBe(200)
		if (linked.key) expect(await file(linked.key)).toBe(200)
		expect(await file(unlinked.id)).toBe(404)
	})
})
