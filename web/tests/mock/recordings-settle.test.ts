/**
 * As the core's catalogue, the mock links a new call to its Activity row at once but lists and serves its file
 * only once it has been quiet RECORDINGS_IN_PROGRESS_MS: the web's "Saving" disc, then Play.
 */
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryPage } from "@wavekit/api-types"
import { RECORDINGS_IN_PROGRESS_MS } from "@wavekit/api-types"

import {
	createRecordingsState,
	registerRecordingsMock,
} from "../../mock/recordings.ts"

let app: FastifyInstance | undefined
let stop: (() => void) | undefined
afterEach(async () => {
	stop?.()
	await app?.close()
	app = undefined
})

describe("mock recordings: a new call is served once its file is quiet", () => {
	it("links at once, lists and serves only after the in-progress time", async () => {
		let now = Date.UTC(2026, 10, 25, 10, 0, 0)
		const clock = () => now
		const state = createRecordingsState(clock)
		app = Fastify({ logger: false })
		const mock = registerRecordingsMock(app, {
			state,
			now: clock,
			newCallMs: 3_600_000,
			onRecording: () => "evt_new",
		})
		stop = mock.stop
		await app.ready()
		const item = mock.addCall()
		expect(item.activityEventId).toBe("evt_new")
		const listed = async () =>
			(await app!.inject({ method: "GET", url: "/api/recordings?limit=200" }))
				.json<RecordingInventoryPage>()
				.items.some(i => i.id === item.id)
		const file = async () =>
			(
				await app!.inject({
					method: "GET",
					url: `/api/recordings/${encodeURIComponent(item.key ?? item.id)}/file`,
				})
			).statusCode

		expect(await listed()).toBe(false)
		expect(await file()).toBe(404)
		now += RECORDINGS_IN_PROGRESS_MS
		expect(await listed()).toBe(true)
		expect(await file()).toBe(200)
	})
})
