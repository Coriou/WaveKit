import { MachineCredential } from "../../../cli/source/data/access-credentials.js"
import { createCliFetch } from "../../../cli/source/data/access-transport.js"
import { describe, expect, it, vi } from "vitest"
import { createApiClient } from "../../../cli/source/data/api-client.js"
import type { FetchLike } from "../../../cli/source/data/config.js"

const decoder = {
	id: "readsb",
	type: "readsb",
	running: true,
	health: "idle",
	uptime: 51,
	stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
	restartCount: 0,
}

function respond(status: number, body: unknown) {
	return Promise.resolve({
		ok: status < 400,
		status,
		statusText: status === 500 ? "Internal Server Error" : "OK",
		json: () => Promise.resolve(body),
	})
}

function client(fetchFn: FetchLike) {
	return createApiClient({
		base: () => "http://127.0.0.1:9000",
		fetchFn,
		now: () => 1000,
	})
}

describe("api-client GET", () => {
	it("guards the body and counts rejected items", async () => {
		const r = await client(() => respond(200, [decoder, { nope: 1 }])).get(
			"decoders",
		)
		expect(r).toMatchObject({ ok: true, rejected: 1 })
	})
	it("classifies HTTP errors with the server message", async () => {
		const r = await client(() =>
			respond(500, { error: "x", code: "RESOURCES_ERROR", message: "boom" }),
		).get("resources")
		expect(r).toEqual({
			ok: false,
			error: { kind: "http", status: 500, message: "boom", at: 1000 },
		})
	})
	it("classifies timeouts and refused connections", async () => {
		const timeout = await client(() =>
			Promise.reject(new DOMException("t", "TimeoutError")),
		).get("status")
		expect(timeout).toMatchObject({
			ok: false,
			error: { kind: "timeout", message: "timeout 2s" },
		})
		const refused = await client(() =>
			Promise.reject(
				Object.assign(new TypeError("fetch failed"), {
					cause: { code: "ECONNREFUSED" },
				}),
			),
		).get("status")
		expect(refused).toMatchObject({
			ok: false,
			error: { kind: "network", message: "ECONNREFUSED" },
		})
	})
	it("marks bodies that fail the guard as invalid", async () => {
		const r = await client(() => respond(200, { not: "a list" })).get(
			"decoders",
		)
		expect(r).toMatchObject({ ok: false, error: { kind: "invalid" } })
	})
	it("reports a missing target as a network error", async () => {
		const c = createApiClient({
			base: () => null,
			fetchFn: () => respond(200, []),
			now: () => 1,
		})
		expect(await c.get("decoders")).toMatchObject({
			ok: false,
			error: { kind: "network" },
		})
	})
})

describe("api-client actions", () => {
	it("posts decoder ops without a body", async () => {
		const fetchFn = vi.fn<FetchLike>(() =>
			respond(200, { message: "Decoder restarted", decoder }),
		)
		const r = await client(fetchFn).decoder("readsb", "restart")
		expect(r).toEqual({
			ok: true,
			outcome: "ok",
			status: 200,
			message: "Decoder restarted",
		})
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:9000/api/decoders/readsb/restart",
		)
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "POST" })
		expect(fetchFn.mock.calls[0]?.[1]?.body).toBeUndefined()
	})
	it("posts tuner commands as JSON and surfaces error codes", async () => {
		const fetchFn = vi.fn<FetchLike>(() =>
			respond(409, {
				error: "Conflict",
				code: "TUNER_CONTROL_EXTERNAL",
				message: "device busy",
			}),
		)
		const r = await client(fetchFn).tuner("pi-iq", {
			setting: "frequency",
			body: { hz: 446000000 },
			label: "frequency",
		})
		expect(r).toEqual({
			ok: false,
			outcome: "failed",
			status: 409,
			code: "TUNER_CONTROL_EXTERNAL",
			message: "device busy",
		})
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:9000/api/tuner/pi-iq/frequency",
		)
		expect(fetchFn.mock.calls[0]?.[1]?.body).toBe('{"hz":446000000}')
	})
	it("patches live-audio config", async () => {
		const fetchFn = vi.fn<FetchLike>(() => respond(200, {}))
		await client(fetchFn).patchAudio({ modulation: "nfm", bandwidth: 12500 })
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
			method: "PATCH",
			body: '{"modulation":"nfm","bandwidth":12500}',
		})
	})
	it("never rejects on network failure", async () => {
		const r = await client(() =>
			Promise.reject(new TypeError("fetch failed")),
		).audio("start")
		expect(r).toMatchObject({ ok: false, status: null })
	})
})

function bodyFails(status: number, err: unknown) {
	return () =>
		Promise.resolve({
			ok: status < 400,
			status,
			statusText: "",
			json: () => Promise.reject(err),
		})
}

describe("A2 fix round 1", () => {
	it("I1: a body read that times out or resets is timeout/network, not invalid", async () => {
		const t = await client(
			bodyFails(200, new DOMException("t", "TimeoutError")),
		).get("decoders")
		expect(t).toMatchObject({
			ok: false,
			error: { kind: "timeout", message: "timeout 2s" },
		})
		const reset = Object.assign(new TypeError("terminated"), {
			cause: { code: "ECONNRESET" },
		})
		const n = await client(bodyFails(200, reset)).get("decoders")
		expect(n).toMatchObject({
			ok: false,
			error: { kind: "network", message: "ECONNRESET" },
		})
		const html = await client(
			bodyFails(200, new SyntaxError("Unexpected token <")),
		).get("decoders")
		expect(html).toMatchObject({ ok: false, error: { kind: "invalid" } })
	})
	it("M2: an empty statusText falls back to HTTP <status>", async () => {
		const r = await client(bodyFails(500, new SyntaxError("x"))).get("status")
		expect(r).toEqual({
			ok: false,
			error: { kind: "http", status: 500, message: "HTTP 500", at: 1000 },
		})
		const w = await client(bodyFails(502, new SyntaxError("x"))).decoder(
			"readsb",
			"stop",
		)
		expect(w).toEqual({
			ok: false,
			outcome: "failed",
			status: 502,
			message: "HTTP 502",
		})
	})
	it("I4/R23: a write with no reply in time is unknown, never a failure", async () => {
		const timeout = () => Promise.reject(new DOMException("t", "TimeoutError"))
		const r = await client(timeout).decoder("readsb", "restart")
		expect(r).toEqual({
			ok: false,
			outcome: "unknown",
			status: null,
			message: "sent · no reply in 10s",
		})
		const custom = createApiClient({
			base: () => "http://127.0.0.1:9000",
			fetchFn: timeout,
			now: () => 1,
			writeTimeoutMs: 15000,
		})
		expect(
			(
				await custom.tuner("pi-iq", {
					setting: "ppm",
					body: { ppm: 1 },
					label: "ppm",
				})
			).message,
		).toBe("sent · no reply in 15s")
	})
	it("I4: a refused write is a failure (nothing was sent)", async () => {
		const refused = () =>
			Promise.reject(
				Object.assign(new TypeError("fetch failed"), {
					cause: { code: "ECONNREFUSED" },
				}),
			)
		expect(await client(refused).decoder("readsb", "start")).toEqual({
			ok: false,
			outcome: "failed",
			status: null,
			message: "ECONNREFUSED",
		})
	})
	it("outcome and ok agree for every answered write", async () => {
		for (const status of [200, 204, 400, 404, 409, 500, 503]) {
			const r = await client(() => respond(status, {})).audio("start")
			expect(r.ok).toBe(r.outcome === "ok")
			expect(r.outcome).toBe(status < 400 ? "ok" : "failed")
		}
	})
})

describe("A2 re-review: never report a landed write as failed", () => {
	const reset = (code: string) =>
		Object.assign(new TypeError("fetch failed"), { cause: { code } })
	it("judges by the received status when the body read then fails", async () => {
		for (const err of [
			reset("ECONNRESET"),
			new DOMException("t", "TimeoutError"),
		]) {
			expect(
				await client(bodyFails(200, err)).decoder("readsb", "stop"),
			).toEqual({
				ok: true,
				outcome: "ok",
				status: 200,
				message: "ok",
			})
			expect(await client(bodyFails(500, err)).audio("start")).toEqual({
				ok: false,
				outcome: "failed",
				status: 500,
				message: "HTTP 500",
			})
		}
	})
	it("a reset after sending, before any status, is unknown", async () => {
		for (const code of [
			"ECONNRESET",
			"EPIPE",
			"UND_ERR_SOCKET",
			"UND_ERR_CLOSED",
		]) {
			expect(
				await client(() => Promise.reject(reset(code))).decoder(
					"readsb",
					"restart",
				),
			).toEqual({
				ok: false,
				outcome: "unknown",
				status: null,
				message: "sent · connection reset",
			})
		}
	})
	it("a connection that never opened is a failure", async () => {
		for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"]) {
			expect(
				await client(() => Promise.reject(reset(code))).audio("stop"),
			).toMatchObject({
				outcome: "failed",
				message: code,
			})
		}
	})
})

// Validates: core-access-policy requirements 6.3, 6.4.
describe("protected REST denial semantics", () => {
	it.each([401, 403])(
		"keeps %s as an HTTP answer and a failed write without echoing server secrets",
		async status => {
			const secret = Buffer.alloc(32, 7).toString("base64url")
			const request = createCliFetch({
				policy: {
					origin: "http://127.0.0.1:9000",
					credentials: async () => new MachineCredential(secret),
				},
				fetch: async () =>
					new Response(
						JSON.stringify({ code: "AUTH_REQUIRED", message: secret }),
						{ status },
					),
			})
			const api = client(request)
			const get = await api.get("status")
			expect(get).toMatchObject({
				ok: false,
				error: { kind: "http", status, message: `HTTP ${status}` },
			})
			const write = await api.decoder("readsb", "restart")
			expect(write).toMatchObject({
				ok: false,
				outcome: "failed",
				status,
				code: "AUTH_REQUIRED",
				message: `HTTP ${status}`,
			})
			expect(JSON.stringify({ get, write })).not.toContain(secret)
		},
	)
})

describe("bounded Scan HTTP bodies", () => {
	it("caps actual streamed bytes before parsing despite a false small Content-Length", async () => {
		const { readBoundedJson, SCAN_BODY_BYTES } =
			await import("../../../cli/source/data/api-client.js")
		let cancelled = false
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(SCAN_BODY_BYTES))
				c.enqueue(new Uint8Array(1))
			},
			cancel() {
				cancelled = true
			},
		})
		await expect(
			readBoundedJson(
				{
					ok: true,
					status: 200,
					statusText: "",
					headers: { get: () => "1" },
					body,
					json: async () => {
						throw new Error("uncapped parser")
					},
				},
				new AbortController().signal,
			),
		).rejects.toMatchObject({ kind: "too-large" })
		expect(cancelled).toBe(true)
	})
	it("never falls back to unbounded json and aborts a stalled reader", async () => {
		const { readBoundedJson } =
			await import("../../../cli/source/data/api-client.js")
		const json = vi.fn(async () => ({}))
		await expect(
			readBoundedJson(
				{ ok: true, status: 200, statusText: "", json },
				new AbortController().signal,
			),
		).rejects.toMatchObject({ kind: "unavailable" })
		expect(json).not.toHaveBeenCalled()
		const controller = new AbortController()
		const read = readBoundedJson(
			{
				ok: true,
				status: 200,
				statusText: "",
				json,
				body: new ReadableStream<Uint8Array>(),
			},
			controller.signal,
		)
		controller.abort()
		await expect(read).rejects.toMatchObject({ kind: "timeout" })
	})
	it("keeps safe HTTP code/status, rejects malformed JSON, and guards successful DTOs", async () => {
		const { getScan } = await import("../../../cli/source/data/api-client.js")
		const response =
			(body: string, status = 200) =>
			async () =>
				new Response(body, { status })
		await expect(
			getScan(
				response(
					'{"code":"SCANNER_STATE_UNAVAILABLE","message":"secret"}',
					503,
				),
				"http://core",
				"jobs",
				"/api/scanner/jobs",
				new AbortController().signal,
			),
		).rejects.toMatchObject({
			status: 503,
			code: "SCANNER_STATE_UNAVAILABLE",
			message: "HTTP 503 SCANNER_STATE_UNAVAILABLE",
		})
		await expect(
			getScan(
				response("{"),
				"http://core",
				"jobs",
				"/api/scanner/jobs",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ kind: "invalid" })
		await expect(
			getScan(
				response("[]"),
				"http://core",
				"jobs",
				"/api/scanner/jobs",
				new AbortController().signal,
			),
		).resolves.toEqual([])
	})
})

it("bounds Scan waiting even when an injected fetch ignores abort", async () => {
	const { getScan } = await import("../../../cli/source/data/api-client.js")
	const controller = new AbortController()
	const read = getScan(
		() => new Promise(() => undefined),
		"http://localhost",
		"status",
		"/api/scanner",
		controller.signal,
	)
	const result = expect(read).rejects.toMatchObject({ kind: "timeout" })
	controller.abort()
	await result
})

it("preserves authenticated body streams for bounded Scan reads", async () => {
	const { getScan } = await import("../../../cli/source/data/api-client.js")
	const { SCAN_STATUS } = await import("../../../cli/source/test/fixtures.js")
	const nativeFetch = vi.fn(
		async () => new Response(JSON.stringify(SCAN_STATUS)),
	)
	vi.stubGlobal("fetch", nativeFetch)
	try {
		const fetchFn = createCliFetch({
			policy: {
				origin: "http://localhost:9000",
				credentials: async () =>
					new MachineCredential(Buffer.alloc(32, 7).toString("base64url")),
			},
		})
		const value = await getScan(
			fetchFn,
			"http://localhost:9000",
			"status",
			"/api/scanner",
			new AbortController().signal,
		)
		expect(value.enabled).toBe(SCAN_STATUS.enabled)
		expect(nativeFetch).toHaveBeenCalledTimes(1)
	} finally {
		vi.unstubAllGlobals()
	}
})

it("handles a fetch rejection arriving after caller cancellation", async () => {
	const { getScan } = await import("../../../cli/source/data/api-client.js")
	const controller = new AbortController()
	let rejectLate: ((reason: Error) => void) | undefined
	const read = getScan(
		() =>
			new Promise((_resolve, reject) => {
				rejectLate = reject
			}),
		"http://localhost",
		"jobs",
		"/api/scanner/jobs",
		controller.signal,
	)
	const result = expect(read).rejects.toMatchObject({ kind: "timeout" })
	controller.abort()
	await result
	rejectLate!(new Error("late fetch rejection"))
	await Promise.resolve()
	await Promise.resolve()
})
