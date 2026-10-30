import { afterEach, describe, expect, it } from "vitest"

import { ApiClient } from "../../src/data/api-client.ts"
import {
	fetchActivityAvailability,
	lifecycleNotice,
} from "../../src/features/activity/lifecycle.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

const servers: MockServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map(s => s.close()))
})

/** An ApiClient on the mock's routes (inject, no socket). */
async function mock(options: Parameters<typeof buildMockServer>[0]) {
	const server = await buildMockServer({ port: 0, ...options })
	servers.push(server)
	await server.app.ready()
	const api = new ApiClient({
		fetch: async (url, init) => {
			const reply = await server.app.inject({
				method: (init?.method ?? "GET") as "GET",
				url,
			})
			return new Response(reply.body, {
				status: reply.statusCode,
				headers: { "content-type": "application/json" },
			})
		},
	})
	return { server, api }
}

/** An ApiClient whose every request answers `status` with `body`. */
function answering(status: number, body: unknown): ApiClient {
	return new ApiClient({
		fetch: async () => new Response(JSON.stringify(body), { status }),
	})
}

describe("Activity store lifecycle in the drawer", () => {
	it("says Activity is starting while the store opens, and reads answer 503", async () => {
		const { server, api } = await mock({ activityStore: { state: "opening" } })
		const read = await server.app.inject({
			method: "GET",
			url: "/api/activity",
		})
		expect(read.statusCode).toBe(503)
		expect(read.json()).toMatchObject({ code: "ACTIVITY_UNAVAILABLE" })
		const availability = await fetchActivityAvailability(api)
		expect(availability).toMatchObject({
			kind: "lifecycle",
			lifecycle: { state: "opening", reason: null },
		})
		expect(lifecycleNotice(availability)).toEqual({
			text: "Activity is starting…",
			tone: "info",
		})
	})

	it("says the store is unavailable and retrying, with the next attempt", async () => {
		const { server, api } = await mock({
			activityStore: { state: "retrying" },
		})
		const read = await server.app.inject({
			method: "GET",
			url: "/api/activity",
		})
		expect(read.json()).toMatchObject({
			code: "ACTIVITY_UNAVAILABLE",
			reason: "ACTIVITY_OPEN_TIMEOUT",
		})
		const availability = await fetchActivityAvailability(api)
		expect(availability.kind).toBe("lifecycle")
		if (availability.kind !== "lifecycle") return
		expect(availability.lifecycle.state).toBe("retrying")
		expect(availability.lifecycle.nextAttemptAt).not.toBeNull()
		expect(lifecycleNotice(availability)).toEqual({
			text: "Activity store unavailable, retrying",
			tone: "warn",
		})
	})

	it("shows no notice once the store is open", async () => {
		const { server, api } = await mock({})
		expect(
			(await server.app.inject({ method: "GET", url: "/api/activity" }))
				.statusCode,
		).toBe(200)
		const availability = await fetchActivityAvailability(api)
		expect(availability).toMatchObject({
			kind: "lifecycle",
			lifecycle: { state: "available" },
		})
		expect(lifecycleNotice(availability)).toBeNull()
	})

	it("opens after the configured delay", async () => {
		const { api } = await mock({
			activityStore: { state: "opening", openAfterMs: 0 },
		})
		expect(lifecycleNotice(await fetchActivityAvailability(api))).toBeNull()
	})

	it("keeps the off notice for a disabled core and reads older cores", async () => {
		const off = await fetchActivityAvailability(
			answering(404, { code: "ACTIVITY_DISABLED" }),
		)
		expect(off).toEqual({ kind: "off" })
		expect(lifecycleNotice(off)?.text).toMatch(/turned off/)
		// An older core: 200 without a lifecycle is an open store.
		const older = await fetchActivityAvailability(
			answering(200, { enabled: true, stats: { rows: 1 } }),
		)
		expect(lifecycleNotice(older)).toBeNull()
		// An older core whose store did not open answers 503: unavailable, no retry.
		const failed = await fetchActivityAvailability(
			answering(503, { code: "ACTIVITY_UNAVAILABLE" }),
		)
		expect(failed).toMatchObject({ lifecycle: { state: "unavailable" } })
		expect(lifecycleNotice(failed)?.tone).toBe("warn")
	})
})
