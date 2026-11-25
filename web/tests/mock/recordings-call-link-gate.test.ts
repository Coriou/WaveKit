/**
 * The mock's recordings routes apply the core's rule six: a per-call file (dsd-fme's YSF calls,
 * the call recorder's) is listed, counted and served only while its call's Activity row links
 * it (`activityEventId`) or it is Kept with its Keep's clear verdict; otherwise it is absent and its
 * file route answers 404 by id and by key.
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

		// Kept call seeds carry their Keep's clear verdict: listed without a row.
		const keptCalls = calls.filter(c => c.kept)
		const before = await list()
		expect(
			before.items
				.filter(i => isCall(i.kind))
				.map(i => i.id)
				.sort(),
		).toEqual(keptCalls.map(c => c.id).sort())
		const [linked, unlinked] = calls.filter(c => !c.kept)
		if (!linked || !unlinked) throw new Error("two unkept call seeds expected")
		for (const c of calls.filter(i => !i.kept)) {
			expect(await file(c.id)).toBe(404)
			if (c.key) expect(await file(c.key)).toBe(404)
		}

		linkRecordingActivity(
			state,
			linked.id,
			"00000000-0000-4000-8000-0000000000aa",
		)
		const after = await list()
		expect(
			after.items.filter(i => isCall(i.kind) && !i.kept).map(i => i.id),
		).toEqual([linked.id])
		expect(after.scannedFiles).toBe(before.scannedFiles + 1)
		expect(await file(linked.id)).toBe(200)
		if (linked.key) expect(await file(linked.key)).toBe(200)
		expect(await file(unlinked.id)).toBe(404)
	})

	it("a Kept call file stays without its row until unkept", async () => {
		const state = createRecordingsState()
		const kept = recordingSeeds(state).find(i => isCall(i.kind) && i.kept)
		if (!kept) throw new Error("a kept call seed expected")
		app = Fastify({ logger: false })
		stop = registerRecordingsMock(app, { state, newCallMs: 3_600_000 }).stop
		await app.ready()
		const file = async (id: string) =>
			(
				await app!.inject({
					method: "GET",
					url: `/api/recordings/${encodeURIComponent(id)}/file`,
				})
			).statusCode
		expect(kept.activityEventId ?? null).toBeNull()
		expect(await file(kept.id)).toBe(200)
		const unkeep = await app.inject({
			method: "DELETE",
			url: `/api/recordings/${encodeURIComponent(kept.id)}/keep`,
		})
		expect(unkeep.statusCode).toBe(200)
		// Unkept and unlinked: rule six hides it again, and it cannot be kept back.
		expect(await file(kept.id)).toBe(404)
		const rekeep = await app.inject({
			method: "PUT",
			url: `/api/recordings/${encodeURIComponent(kept.id)}/keep`,
		})
		expect(rekeep.statusCode).toBe(404)
	})
})
