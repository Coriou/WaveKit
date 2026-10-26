import { EventEmitter, once } from "node:events"
import { PassThrough } from "node:stream"
import type { ServerResponse } from "node:http"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
	iqSnapshotRoutes,
	IQ_SNAPSHOT_MAX_BYTES,
	type IqSnapshotOptions,
} from "../../../src/api/routes/iq-snapshot.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { createLogger } from "../../../src/utils/logger.js"
import type { SourceStatus } from "../../../src/core/source-manager.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import type { DeniedAdmission } from "../../../src/access/types.js"

let app: FastifyInstance
let fanout: FanoutManager
let input: PassThrough
let sources: EventEmitter
let rate: number
let denial: DeniedAdmission | undefined
let response: ServerResponse | undefined
let invalidate: (() => void) | undefined
let release: ReturnType<typeof vi.fn>
const url = "/api/sources/source/iq-snapshot"
const payload = { seconds: 0.1, format: "cu8" }
const start = async (body = payload) => {
	const added = once(fanout, "branch-added")
	const pending = app
		.inject({ method: "POST", url, payload: body })
		.then(result => result)
	await added
	// Branch creation precedes the synchronous installation of its data listener.
	await Promise.resolve()
	return { pending }
}
beforeEach(async () => {
	rate = 1000
	denial = undefined
	response = undefined
	release = vi.fn()
	sources = new EventEmitter()
	fanout = new FanoutManager(createLogger({ level: "fatal" }))
	input = new PassThrough()
	fanout.attachSource(input)
	app = Fastify()
	const options: IqSnapshotOptions = {
		sourceManager: Object.assign(sources, {
			getStatus: () =>
				({
					connected: true,
					caps: {
						kind: "iq",
						format: "U8_IQ",
						sampleRate: rate,
						centerFreq: 12_345,
					},
				}) as SourceStatus,
		}),
		fanoutFor: () => fanout,
		access: {
			authorizeMetadataMutation: () => denial,
			leaseDownload: (_request, raw, cancel) => {
				response = raw
				let released = false
				const finish = () => {
					if (released) return
					released = true
					release()
					cancel()
				}
				invalidate = () => {
					finish()
					raw.destroy()
				}
				raw.once("finish", finish)
				return {
					kind: "attached",
					active: () => !released,
					release: invalidate,
				}
			},
		},
	}
	await app.register(iqSnapshotRoutes, options)
	await app.ready()
})
afterEach(async () => {
	invalidate?.()
	await app.close()
	input.destroy()
	fanout.detachSource()
	vi.restoreAllMocks()
	vi.useRealTimers()
})
it("returns exact bytes, CU8 download headers and first-chunk time", async () => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(1_234_567)
	const { pending } = await start()
	input.write(Buffer.alloc(127, 23))
	input.write(Buffer.alloc(101, 29))
	const result = await pending
	expect(result.statusCode).toBe(200)
	expect(result.rawPayload).toEqual(
		Buffer.concat([Buffer.alloc(127, 23), Buffer.alloc(73, 29)]),
	)
	expect(result.headers).toMatchObject({
		"content-type": "application/octet-stream",
		"content-disposition": 'attachment; filename="snapshot.cu8"',
		"content-length": "200",
		"x-wavekit-center-hz": "12345",
		"x-wavekit-sample-rate": "1000",
		"x-wavekit-start-time": new Date().toISOString(),
	})
	expect(release).toHaveBeenCalledOnce()
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
})
it.each([0.099, 10.001, 0, -1])(
	"rejects seconds outside the window: %s",
	async seconds => {
		const res = await app.inject({
			method: "POST",
			url,
			payload: { ...payload, seconds },
		})
		expect(res.statusCode).toBe(400)
	},
)
it("rejects unsupported format and a mismatched center", async () => {
	expect(
		(
			await app.inject({
				method: "POST",
				url,
				payload: { ...payload, format: "cf32" },
			})
		).statusCode,
	).toBe(400)
	expect(
		(
			await app.inject({
				method: "POST",
				url,
				payload: { ...payload, centerHz: 12_347 },
			})
		).statusCode,
	).toBe(409)
})
it.each([401, 403] as const)(
	"enforces authorization before capture: %s",
	async status => {
		denial = {
			kind: "deny",
			status,
			code: status === 401 ? "AUTH_REQUIRED" : "CSRF_REQUIRED",
			headers: {},
		}
		expect(
			(await app.inject({ method: "POST", url, payload })).statusCode,
		).toBe(status)
		expect(response).toBeUndefined()
	},
)
it("limits the process to one capture and releases the slot", async () => {
	const { pending } = await start()
	expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(
		429,
	)
	input.write(Buffer.alloc(200))
	await pending
	const next = await start()
	input.write(Buffer.alloc(200))
	expect((await next.pending).statusCode).toBe(200)
})
it.each([2_400_000, 3_200_000])(
	"caps bytes at and past the maximum rate: %s",
	async sampleRate => {
		rate = sampleRate
		const { pending } = await start({ seconds: 10, format: "cu8" })
		const sizes: number[] = []
		// Count writes without allocating or retaining a 48 MB response.
		vi.spyOn(response!, "write").mockImplementation(
			(chunk: Buffer | string | Uint8Array) => {
				sizes.push(chunk.length)
				return true
			},
		)
		const block = Buffer.alloc(8192)
		let sent = 0
		while (sent <= IQ_SNAPSHOT_MAX_BYTES) {
			input.write(block)
			sent += block.length
		}
		await pending
		expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(IQ_SNAPSHOT_MAX_BYTES)
		expect(response!.getHeader("Content-Length")).toBe(IQ_SNAPSHOT_MAX_BYTES)
	},
)
it("aborts and detaches on the first refused client write", async () => {
	const { pending } = await start()
	const rejected = pending.catch(() => undefined)
	vi.spyOn(response!, "write").mockReturnValue(false)
	input.write(Buffer.alloc(100))
	expect(response!.destroyed).toBe(true)
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
	expect(release).toHaveBeenCalledOnce()
	await rejected
})
it.each(["caps-changed", "disconnected", "invalidate"])(
	"detaches on %s",
	async reason => {
		const { pending } = await start()
		const rejected = pending.catch(() => undefined)
		if (reason === "invalidate") invalidate?.()
		else sources.emit(reason, "source")
		expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
		await rejected
	},
)
it("aborts silent input at the grace bound", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(7_654_321)
	const { pending } = await start()
	const rejected = pending.catch(() => undefined)
	await vi.advanceTimersByTimeAsync(199)
	expect(response!.destroyed).toBe(false)
	await vi.advanceTimersByTimeAsync(1)
	expect(response!.destroyed).toBe(true)
	await vi.advanceTimersByTimeAsync(1)
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
	await rejected
})

it("uses protected admission and POST CSRF authorization with the real access policy", async () => {
	const protectedApp = Fastify()
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
		monotonicNow: () => 123_457,
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.invalid"],
		allowedOrigins: ["http://receiver.invalid"],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const access = installAccessHooks(protectedApp, { policy, sessions })
	await protectedApp.register(iqSnapshotRoutes, {
		sourceManager: Object.assign(sources, {
			getStatus: () =>
				({
					connected: true,
					caps: {
						kind: "iq",
						format: "U8_IQ",
						sampleRate: rate,
						centerFreq: 12_345,
					},
				}) as SourceStatus,
		}),
		fanoutFor: () => fanout,
		access,
	})
	try {
		const missing = await protectedApp.inject({
			method: "POST",
			url,
			payload,
			headers: { host: "receiver.invalid" },
		})
		expect(missing.statusCode).toBe(401)
		const created = await sessions.create()
		if (created.kind !== "created") throw new Error("Expected session")
		const forbidden = await protectedApp.inject({
			method: "POST",
			url,
			payload,
			headers: {
				host: "receiver.invalid",
				origin: "http://receiver.invalid",
				cookie: `wavekit_session=${created.cookieValue}`,
			},
		})
		expect(forbidden.statusCode).toBe(403)
		expect(forbidden.json()).toMatchObject({ code: "CSRF_REQUIRED" })
		const added = once(fanout, "branch-added")
		const download = protectedApp
			.inject({
				method: "POST",
				url,
				payload,
				headers: { host: "receiver.invalid", authorization: `Bearer ${token}` },
			})
			.then(result => result)
		await added
		await Promise.resolve()
		input.write(Buffer.alloc(200, 27))
		const result = await download
		expect(result.statusCode).toBe(200)
		expect(result.rawPayload).toEqual(Buffer.alloc(200, 27))
	} finally {
		await protectedApp.close()
	}
})

it.each([1, 2])(
	"aborts fanout buffering at and past the one-byte watermark: %s",
	async size => {
		const branch = vi.spyOn(fanout, "addBranch")
		const { pending } = await start()
		const rejected = pending.catch(() => undefined)
		const created = branch.mock.results[0]
		if (created?.type !== "return") throw new Error("Expected branch")
		created.value.pause()
		input.write(Buffer.alloc(size))
		expect(response!.destroyed).toBe(true)
		expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
		await rejected
	},
)

it("keeps the process slot until the binary response finishes", async () => {
	const { pending } = await start()
	const end = vi.spyOn(response!, "end").mockReturnValue(response!)
	input.write(Buffer.alloc(200))
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
	expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(
		429,
	)
	end.mockRestore()
	response!.end()
	expect((await pending).statusCode).toBe(200)
})
