/**
 * POST /api/sources/:id/pause and /resume, and the `feed` field of GET /api/sources: idempotent
 * answers, 404 for unknown ids, 409 for recordings, 503 with the safe message when a resume
 * cannot reach the receiver, and the access policy in front of both writes.
 */
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	SOURCE_RESUME_FAILED_MESSAGE,
	type SourceFeed,
} from "@wavekit/api-types"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import type {
	SourceManager,
	SourceStatus,
} from "../../../src/core/source-manager.js"
import { WaveKitError } from "../../../src/utils/errors.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { SessionStore } from "../../../src/access/sessions.js"
import { AccessPolicy } from "../../../src/access/policy.js"

const SINCE = "2026-01-01T00:00:00.000Z"

function fakeSources() {
	let feed: SourceFeed = { state: "live", since: SINCE }
	let resumeFails = false
	const status = (): SourceStatus => ({
		id: "rtl",
		type: "rtl_tcp",
		url: "127.0.0.1:1234",
		connected: feed.state === "live",
		activity: {
			state: "waiting",
			lastSampleAt: null,
			sampleAgeMs: null,
			timeoutMs: 10_000,
		},
		bytesReceived: 0,
		dataRate: 0,
		reconnectAttempts: 0,
		caps: {
			kind: "iq",
			sampleRate: 2_048_000,
			format: "U8_IQ",
			exclusive: false,
		},
		feed,
	})
	const known = (id: string) => {
		if (id === "file")
			throw new WaveKitError(
				"A recording source has no receiver feed to pause",
				"SOURCE_FEED_UNSUPPORTED",
			)
	}
	const manager = {
		getStatus: vi.fn((id: string) =>
			id === "rtl" || id === "file" ? status() : undefined,
		),
		getAllStatus: vi.fn(() => [status()]),
		getSourceAssignments: vi.fn(() => []),
		isSourceAvailable: vi.fn(() => true),
		pause: vi.fn(async (id: string) => {
			known(id)
			const changed = feed.state !== "paused"
			if (changed) feed = { state: "paused", since: SINCE }
			return { feed, changed }
		}),
		resume: vi.fn(async (id: string) => {
			known(id)
			if (feed.state === "live") return { feed, changed: false }
			feed = resumeFails
				? {
						state: "error",
						since: SINCE,
						error: SOURCE_RESUME_FAILED_MESSAGE,
					}
				: { state: "live", since: SINCE }
			return { feed, changed: true }
		}),
	}
	return {
		manager,
		failResume(fail: boolean) {
			resumeFails = fail
		},
	}
}

let app: FastifyInstance
afterEach(async () => {
	await app.close()
})

async function build(manager: ReturnType<typeof fakeSources>["manager"]) {
	app = Fastify({ logger: false })
	await app.register(sourceRoutes, {
		sourceManager: manager as unknown as SourceManager,
	})
}

describe("source feed routes", () => {
	it("pause and resume are idempotent and GET /api/sources carries the feed", async () => {
		const { manager } = fakeSources()
		await build(manager)

		const pause = await app.inject({
			method: "POST",
			url: "/api/sources/rtl/pause",
		})
		expect(pause.statusCode).toBe(200)
		expect(pause.json()).toEqual({
			id: "rtl",
			changed: true,
			feed: { state: "paused", since: SINCE },
		})
		const again = await app.inject({
			method: "POST",
			url: "/api/sources/rtl/pause",
		})
		expect(again.statusCode).toBe(200)
		expect(again.json()).toMatchObject({ changed: false })

		const list = await app.inject({ url: "/api/sources" })
		expect(list.json()).toEqual([
			expect.objectContaining({
				id: "rtl",
				feed: { state: "paused", since: SINCE },
			}),
		])

		const resume = await app.inject({
			method: "POST",
			url: "/api/sources/rtl/resume",
		})
		expect(resume.json()).toMatchObject({
			changed: true,
			feed: { state: "live" },
		})
		const resumeAgain = await app.inject({
			method: "POST",
			url: "/api/sources/rtl/resume",
		})
		expect(resumeAgain.statusCode).toBe(200)
		expect(resumeAgain.json()).toMatchObject({ changed: false })
	})

	it("answers 404 for an unknown id and 409 for a recording", async () => {
		const { manager } = fakeSources()
		await build(manager)
		for (const action of ["pause", "resume"]) {
			const missing = await app.inject({
				method: "POST",
				url: `/api/sources/nope/${action}`,
			})
			expect(missing.statusCode).toBe(404)
			expect(missing.json()).toMatchObject({ code: "SOURCE_NOT_FOUND" })
			const file = await app.inject({
				method: "POST",
				url: `/api/sources/file/${action}`,
			})
			expect(file.statusCode).toBe(409)
			expect(file.json()).toMatchObject({ code: "SOURCE_FEED_UNSUPPORTED" })
		}
		expect(manager.pause).not.toHaveBeenCalledWith("nope")
	})

	it("a failed resume answers 503 with the safe message and the error feed; a retry succeeds", async () => {
		const sources = fakeSources()
		await build(sources.manager)
		await app.inject({ method: "POST", url: "/api/sources/rtl/pause" })
		sources.failResume(true)
		const failed = await app.inject({
			method: "POST",
			url: "/api/sources/rtl/resume",
		})
		expect(failed.statusCode).toBe(503)
		expect(failed.json()).toEqual({
			error: "ServiceUnavailable",
			code: "SOURCE_RESUME_FAILED",
			message: SOURCE_RESUME_FAILED_MESSAGE,
			id: "rtl",
			feed: {
				state: "error",
				since: SINCE,
				error: SOURCE_RESUME_FAILED_MESSAGE,
			},
		})
		sources.failResume(false)
		const retried = await app.inject({
			method: "POST",
			url: "/api/sources/rtl/resume",
		})
		expect(retried.statusCode).toBe(200)
		expect(retried.json()).toMatchObject({ feed: { state: "live" } })
	})

	it("goes through the access policy: denied without credentials, allowed with them", async () => {
		const token = generateMachineToken()
		const digest = digestMachineToken(token)
		const sessions = await SessionStore.open({
			credentialBinding: sessionCredentialBinding(digest),
			persist: async () => {},
		})
		const policy = new AccessPolicy({
			listenerScheme: "http",
			allowedAuthorities: ["synthetic.invalid"],
			allowedOrigins: ["http://synthetic.invalid"],
			sessionCookieName: "wavekit_session",
			machineSecretDigest: digest,
			sessions,
		})
		const { manager } = fakeSources()
		app = Fastify()
		installAccessHooks(app, { policy, sessions })
		await app.register(sourceRoutes, {
			sourceManager: manager as unknown as SourceManager,
		})
		for (const action of ["pause", "resume"]) {
			const denied = await app.inject({
				method: "POST",
				url: `/api/sources/rtl/${action}`,
				headers: { host: "synthetic.invalid" },
			})
			expect(denied.statusCode).toBe(401)
		}
		expect(manager.pause).not.toHaveBeenCalled()
		expect(manager.resume).not.toHaveBeenCalled()
		const allowed = await app.inject({
			method: "POST",
			url: "/api/sources/rtl/pause",
			headers: {
				host: "synthetic.invalid",
				authorization: `Bearer ${token}`,
			},
		})
		expect(allowed.statusCode).toBe(200)
		expect(manager.pause).toHaveBeenCalledWith("rtl")
	})
})
