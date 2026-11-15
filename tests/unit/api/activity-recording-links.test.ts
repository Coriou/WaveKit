/**
 * The Activity routes' recording link parameters over a real (inline) store and reader:
 * `hasRecording` and `refs=recordingId:<key>` (the recording → rows direction), and the summary's
 * `recording` on the wire.
 */
import { rm } from "node:fs/promises"
import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import { createActivityQueryService } from "../../../src/core/activity/query/service.js"
import {
	envelope,
	logger,
	openStore,
	roots,
	stores,
} from "../core/activity/storage/helpers.js"

const KEY = "dsd~20261012_100000_12345_DMR_CC_1_GROUP_TGT_9_SRC_2001.wav"

afterEach(async () => {
	await Promise.all(stores.splice(0).map(s => s.close().catch(() => undefined)))
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

describe("activity routes: recording links", () => {
	it("filters by hasRecording and by a recording's key, and serves the link", async () => {
		const store = await openStore()
		store.admit(
			envelope({
				eventId: "with-audio",
				category: "voice",
				outputType: "call_end",
			}),
			undefined,
			{ id: KEY, durationMs: 4200 },
		)
		store.admit(envelope({ eventId: "plain" }))
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		try {
			const get = async (query: string) => {
				const res = await app.inject({
					method: "GET",
					url: `/api/activity?${query}`,
				})
				return {
					status: res.statusCode,
					body: res.json() as {
						items?: { eventId: string; recording?: unknown }[]
					},
				}
			}
			const withAudio = await get("hasRecording=true")
			expect(withAudio.status).toBe(200)
			expect(withAudio.body.items?.map(i => i.eventId)).toEqual(["with-audio"])
			expect(withAudio.body.items?.[0]?.recording).toEqual({
				id: KEY,
				durationMs: 4200,
			})
			const without = await get("hasRecording=false")
			expect(without.body.items?.map(i => i.eventId)).toEqual(["plain"])
			const byKey = await get(
				`refs=${encodeURIComponent(`recordingId:${KEY}`)}`,
			)
			expect(byKey.body.items?.map(i => i.eventId)).toEqual(["with-audio"])
			expect((await get("hasRecording=yes")).status).toBe(400)
		} finally {
			await app.close()
			await service.close()
		}
	})
})
