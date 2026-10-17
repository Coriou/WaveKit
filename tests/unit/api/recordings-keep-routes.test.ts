import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordingKeepError } from "../../../src/core/recordings/contract.js"
import type { RecordingKeepService } from "../../../src/core/recordings/contract.js"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../src/api/routes/recordings.js"

const ID = "dsd:0~20260101_120000_00001_call.wav"
const KEEP = `/api/recordings/${encodeURIComponent(ID)}/keep`
const DEL = `/api/recordings/${encodeURIComponent(ID)}`
const BAD = "/api/recordings/bad%20id"
const GOLDEN_ROUTES =
	"└── /api/recordings (GET, HEAD)\n    └── /:id/file (GET, HEAD)\n"

function fake() {
	return {
		keep: vi.fn(async (id: string) => ({ id, kept: true, changed: true })),
		unkeep: vi.fn(async (id: string) => ({ id, kept: false, changed: false })),
		remove: vi.fn(async (id: string) => ({ id, deleted: true as const })),
	}
}
type Fake = ReturnType<typeof fake>

describe("recording keep routes", () => {
	let app: FastifyInstance
	const warn = vi.fn()
	async function build(extra: Partial<RecordingRoutesOptions>, svc?: Fake) {
		app = Fastify({ logger: false })
		app.addHook("onRequest", async request => {
			request.log = {
				warn,
				info: () => {},
				error: () => {},
				debug: () => {},
				trace: () => {},
				fatal: () => {},
			} as never
		})
		await app.register(recordingRoutes, {
			inventory: {
				list: async () => ({ items: [] }),
				open: async () => undefined,
			},
			authorize: () => undefined,
			access: {},
			...extra,
		} as unknown as RecordingRoutesOptions)
		await app.ready()
		return svc
	}
	afterEach(async () => {
		warn.mockClear()
		await app.close()
	})
	const full = (svc: Fake, deny = false) =>
		build(
			{
				keeps: svc as unknown as RecordingKeepService,
				authorizeMutation: () =>
					deny
						? ({ status: 403, code: "AUTH_FORBIDDEN", headers: {} } as never)
						: undefined,
			},
			svc,
		)
	const calls = [
		["PUT", KEEP],
		["DELETE", KEEP],
		["DELETE", DEL],
	] as const

	it.each(calls)(
		"%s %s: denial wins, service not called",
		async (method, url) => {
			const svc = fake()
			await full(svc, true)
			const res = await app.inject({ method, url })
			expect(res.statusCode).toBe(403)
			expect(res.json()).toEqual({ code: "AUTH_FORBIDDEN" })
			expect(svc.keep).not.toHaveBeenCalled()
			expect(svc.unkeep).not.toHaveBeenCalled()
			expect(svc.remove).not.toHaveBeenCalled()
		},
	)

	it.each([
		["PUT", `${BAD}/keep`],
		["DELETE", `${BAD}/keep`],
		["DELETE", BAD],
		["DELETE", `/api/recordings/${"a".repeat(90)}`],
	] as const)(
		"%s %s: invalid id is 404 with no service call",
		async (method, url) => {
			const svc = fake()
			await full(svc)
			const res = await app.inject({ method, url })
			expect(res.statusCode).toBe(404)
			expect(res.json().code).toBe("RECORDING_NOT_FOUND")
			expect(svc.keep).not.toHaveBeenCalled()
			expect(svc.unkeep).not.toHaveBeenCalled()
			expect(svc.remove).not.toHaveBeenCalled()
		},
	)

	it("200 bodies", async () => {
		const svc = fake()
		await full(svc)
		const a = await app.inject({ method: "PUT", url: KEEP })
		expect(a.statusCode).toBe(200)
		expect(a.json()).toEqual({ id: ID, kept: true, changed: true })
		const b = await app.inject({ method: "DELETE", url: KEEP })
		expect(b.json()).toEqual({ id: ID, kept: false, changed: false })
		const c = await app.inject({ method: "DELETE", url: DEL })
		expect(c.json()).toEqual({ id: ID, deleted: true })
		expect(c.headers["cache-control"]).toBe("no-store")
	})

	it.each([
		["RECORDING_NOT_FOUND", 404],
		["RECORDING_KEPT", 409],
		["RECORDING_BUSY", 409],
		["RECORDING_KEEP_LIMIT", 409],
		["RECORDING_DELETE_UNSUPPORTED", 409],
		["RECORDING_KEEPS_UNAVAILABLE", 503],
	] as const)("%s maps to %i with fixed text", async (code, status) => {
		const svc = fake()
		svc.remove.mockRejectedValue(new RecordingKeepError(code, `/secret/${ID}`))
		await full(svc)
		const res = await app.inject({ method: "DELETE", url: DEL })
		expect(res.statusCode).toBe(status)
		const body = res.json()
		expect(body.code).toBe(code)
		expect(Object.keys(body).sort()).toEqual(["code", "error", "message"])
		expect(res.body).not.toContain("secret")
		expect(res.body).not.toContain("call.wav")
	})

	it("generic error is 500, fixed text, nothing leaked in body or log", async () => {
		const svc = fake()
		const boom = new Error(`ENOENT /var/rec/${ID}`)
		svc.remove.mockRejectedValue(boom)
		svc.keep.mockRejectedValue(boom)
		await full(svc)
		for (const [method, url] of [
			["DELETE", DEL],
			["PUT", KEEP],
		] as const) {
			const res = await app.inject({ method, url })
			expect(res.statusCode).toBe(500)
			expect(res.body).not.toContain("/var/rec")
			expect(res.body).not.toContain("call.wav")
		}
		expect(JSON.stringify(warn.mock.calls)).not.toContain("call.wav")
		expect(JSON.stringify(warn.mock.calls)).not.toContain("/var/rec")
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it("body over 1 KiB is 413 and the service is not called", async () => {
		const svc = fake()
		await full(svc)
		const res = await app.inject({
			method: "PUT",
			url: KEEP,
			headers: { "content-type": "application/json" },
			payload: JSON.stringify({ x: "a".repeat(2000) }),
		})
		expect(res.statusCode).toBe(413)
		expect(svc.keep).not.toHaveBeenCalled()
	})

	it.each([
		["no options", {}],
		["only keeps", { keeps: fake() as unknown as RecordingKeepService }],
		["only authorizeMutation", { authorizeMutation: () => undefined }],
	] as const)(
		"legacy (%s): routes absent, table unchanged",
		async (_n, extra) => {
			await build(extra)
			expect(app.printRoutes({ commonPrefix: false })).toBe(GOLDEN_ROUTES)
			for (const [method, url] of calls) {
				const res = await app.inject({ method, url })
				expect(res.statusCode).toBe(404)
				expect(res.json().message).toContain("not found")
			}
			const list = await app.inject({ method: "GET", url: "/api/recordings" })
			expect(list.statusCode).toBe(200)
			expect(list.body).toBe('{"items":[]}')
		},
	)
})

describe("recording keep routes: review fixes (WG9 RK)", () => {
	let app: FastifyInstance
	const warn = vi.fn()
	afterEach(async () => {
		warn.mockClear()
		await app.close()
	})
	async function build(svc: Fake, deny: boolean) {
		app = Fastify({ logger: false })
		app.addHook("onRequest", async request => {
			request.log = {
				warn,
				info: () => {},
				error: () => {},
				debug: () => {},
				trace: () => {},
				fatal: () => {},
			} as never
		})
		await app.register(recordingRoutes, {
			inventory: { list: async () => ({ items: [] }), open: async () => null },
			authorize: () => undefined,
			access: {},
			keeps: svc,
			authorizeMutation: () =>
				deny
					? ({ status: 403, code: "AUTH_FORBIDDEN", headers: {} } as never)
					: undefined,
		} as unknown as RecordingRoutesOptions)
		await app.ready()
	}
	const calls = [
		["PUT", KEEP],
		["DELETE", KEEP],
		["DELETE", DEL],
	] as const
	const malformed = {
		headers: { "content-type": "application/json" },
		payload: "{not json",
	}

	it.each(calls)(
		"finding 4: %s %s denial wins over a malformed body",
		async (method, url) => {
			const svc = fake()
			await build(svc, true)
			const res = await app.inject({ method, url, ...malformed })
			expect(res.statusCode).toBe(403)
			expect(res.json()).toEqual({ code: "AUTH_FORBIDDEN" })
			expect(svc.keep).not.toHaveBeenCalled()
			expect(svc.unkeep).not.toHaveBeenCalled()
			expect(svc.remove).not.toHaveBeenCalled()
		},
	)

	it.each(calls)(
		"finding 4: %s %s denial wins over an oversized body",
		async (method, url) => {
			const svc = fake()
			await build(svc, true)
			const res = await app.inject({
				method,
				url,
				headers: { "content-type": "application/json" },
				payload: "x".repeat(4096),
			})
			expect(res.statusCode).toBe(403)
		},
	)

	it.each(calls)(
		"finding 4: %s %s authorized malformed small body is ignored",
		async (method, url) => {
			const svc = fake()
			await build(svc, false)
			const res = await app.inject({ method, url, ...malformed })
			expect(res.statusCode).toBe(200)
			const text = await app.inject({
				method,
				url,
				headers: { "content-type": "text/weird" },
				payload: "abc",
			})
			expect(text.statusCode).toBe(200)
		},
	)

	it.each(calls)(
		"finding 4: %s %s authorized body over 1 KiB is 413, service not called",
		async (method, url) => {
			const svc = fake()
			await build(svc, false)
			const res = await app.inject({
				method,
				url,
				headers: { "content-type": "application/octet-stream" },
				payload: Buffer.alloc(1025),
			})
			expect(res.statusCode).toBe(413)
			expect(svc.keep).not.toHaveBeenCalled()
			expect(svc.unkeep).not.toHaveBeenCalled()
			expect(svc.remove).not.toHaveBeenCalled()
		},
	)

	it("finding 5: each operation's 500 carries its own fixed text", async () => {
		const svc = fake()
		const boom = new Error("ENOENT /var/rec/x")
		svc.keep.mockRejectedValue(boom)
		svc.unkeep.mockRejectedValue(boom)
		svc.remove.mockRejectedValue(boom)
		await build(svc, false)
		const k = await app.inject({ method: "PUT", url: KEEP })
		expect(k.statusCode).toBe(500)
		expect(k.json()).toEqual({
			error: "Internal Server Error",
			code: "RECORDING_KEEP_FAILED",
			message: "Recording could not be kept",
		})
		const u = await app.inject({ method: "DELETE", url: KEEP })
		expect(u.json()).toEqual({
			error: "Internal Server Error",
			code: "RECORDING_KEEP_FAILED",
			message: "Recording could not be unkept",
		})
		const d = await app.inject({ method: "DELETE", url: DEL })
		expect(d.json()).toEqual({
			error: "Internal Server Error",
			code: "RECORDING_DELETE_FAILED",
			message: "Recording could not be deleted",
		})
		expect(warn.mock.calls.map(c => c[1])).toEqual([
			"Recording keep failed",
			"Recording unkeep failed",
			"Recording delete failed",
		])
	})
})
