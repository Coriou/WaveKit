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
		const body = await client(
			bodyFails(200, new DOMException("t", "TimeoutError")),
		).audio("stop")
		expect(body).toMatchObject({
			outcome: "unknown",
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
