/**
 * The Activity routes mounted as ApiServer mounts them, on the lifecycle's API view: while the
 * store is not open, reads answer 503 ACTIVITY_UNAVAILABLE with the failure code as `reason`
 * and a fixed message, and `/api/activity/status` answers 200 with `stats.lifecycle`.
 */
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import {
	ACTIVITY_NOT_OPEN_MESSAGE,
	startActivityLifecycle,
} from "../../../src/core/activity/lifecycle.js"
import {
	inertActivityService,
	type ActivityRuntime,
} from "../../../src/core/activity/runtime.js"

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => {
	await Promise.all(apps.splice(0).map(app => app.close()))
})

function failing(): ActivityRuntime {
	return {
		status: "unavailable",
		service: inertActivityService(),
		unavailable: {
			reason: "ACTIVITY_STORE_LOCKED",
			message: "Activity store is locked: /private/state/activity.lock.db",
			discloseErrors: false,
			retryable: true,
		},
		discloseErrors: false,
		stats: () => {
			throw new Error("closed")
		},
		bindSubscriptions() {},
		transmissionSink: () => null,
		async close() {},
	}
}

describe("activity routes on the lifecycle view", () => {
	it("answer 503 with the code while the store retries, and report the lifecycle", async () => {
		const life = startActivityLifecycle({
			enabled: true,
			stateDir: "/unused",
			logger: pino({ level: "silent" }),
			discloseErrors: false,
			setPublisher: () => {},
			timers: { setTimeout: () => 1, clearTimeout: () => {} },
			now: () => Date.parse("2026-10-30T12:00:00.000Z"),
			attempt: async () => failing(),
		})
		await life.settled()
		const api = life.api
		const app = Fastify({ logger: false })
		apps.push(app)
		// As ApiServer registers them for a runtime whose status is "ready".
		await app.register(activityRoutes, {
			service: api.service,
			enabled: api.status === "ready",
			discloseErrors: api.discloseErrors,
			stats: () => api.stats(),
		})
		const search = await app.inject({ method: "GET", url: "/api/activity" })
		expect(search.statusCode).toBe(503)
		expect(search.json()).toEqual({
			error: "ActivityQueryError",
			code: "ACTIVITY_UNAVAILABLE",
			reason: "ACTIVITY_STORE_LOCKED",
			message: ACTIVITY_NOT_OPEN_MESSAGE,
		})
		// Protected mode: never the lock path or any other message.
		expect(search.body).not.toContain("/private")
		const status = await app.inject({
			method: "GET",
			url: "/api/activity/status",
		})
		expect(status.statusCode).toBe(200)
		expect(status.json()).toMatchObject({
			enabled: true,
			stats: {
				rows: 0,
				writer: "stopped",
				lifecycle: {
					state: "retrying",
					reason: "ACTIVITY_STORE_LOCKED",
					attempts: 1,
					nextAttemptAt: "2026-10-30T12:00:05.000Z",
					droppedWhileClosed: 0,
				},
			},
		})
		expect(status.body).not.toContain("/private")
		await life.close()
	})
})
