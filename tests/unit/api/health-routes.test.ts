/**
 * /health and /health/ready: the HTTP status code and the body agree. A 200 says
 * "ok"; a 503 says it is unhealthy or not ready, with a fixed reason code.
 */

import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	healthRoutes,
	type HealthRoutesOptions,
} from "../../../src/api/routes/health.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import type { AudioOutput } from "../../../src/core/audio-output.js"

interface DecoderStub {
	id: string
	running: boolean
}

function managers(opts: {
	sources: { id: string; connected: boolean; lastError?: string }[]
	decoders: DecoderStub[]
}): HealthRoutesOptions {
	const sourceManager = {
		getAllStatus: () =>
			opts.sources.map(s => ({
				...s,
				bytesReceived: 0,
				dataRate: 0,
				reconnectAttempts: 0,
				caps: { kind: "iq" },
			})),
	} as unknown as SourceManager
	const decoderManager = {
		getAllStatus: () =>
			opts.decoders.map(d => ({ ...d, origin: "config", health: "running" })),
		getAllHealth: () =>
			new Map(
				opts.decoders.map(d => [d.id, d.running ? "running" : "restarting"]),
			),
		isDecoderConfirmedStopped: () => false,
	} as unknown as DecoderManager
	const audioOutput = {
		getPort: () => 0,
		getConnectedClients: () => 0,
	} as unknown as AudioOutput
	return { sourceManager, decoderManager, audioOutput }
}

let app: FastifyInstance | undefined

async function serve(options: HealthRoutesOptions): Promise<FastifyInstance> {
	app = Fastify({ logger: false })
	await app.register(healthRoutes, options)
	await app.ready()
	return app
}

afterEach(async () => {
	await app?.close()
	app = undefined
})

const secret = "rtl-pi: connect ECONNREFUSED 10.0.0.9:1234"

describe("GET /health", () => {
	it("answers 200 with status ok when healthy", async () => {
		const server = await serve(
			managers({
				sources: [{ id: "rtl", connected: true }],
				decoders: [{ id: "adsb", running: true }],
			}),
		)
		const res = await server.inject({ method: "GET", url: "/health" })
		expect(res.statusCode).toBe(200)
		const body = res.json<Record<string, unknown>>()
		expect(body["status"]).toBe("ok")
		expect(body).not.toHaveProperty("reason")
		expect(typeof body["timestamp"]).toBe("string")
	})

	it("answers 200 ok while degraded (source down, decoders running)", async () => {
		const server = await serve(
			managers({
				sources: [{ id: "rtl", connected: false, lastError: secret }],
				decoders: [{ id: "adsb", running: true }],
			}),
		)
		const res = await server.inject({ method: "GET", url: "/health" })
		expect(res.statusCode).toBe(200)
		expect(res.json<{ status: string }>().status).toBe("ok")
	})

	it("answers 503 unhealthy with the reason when every decoder is down", async () => {
		const server = await serve(
			managers({
				sources: [{ id: "rtl", connected: false, lastError: secret }],
				decoders: [
					{ id: "adsb", running: false },
					{ id: "ais", running: false },
				],
			}),
		)
		const res = await server.inject({ method: "GET", url: "/health" })
		expect(res.statusCode).toBe(503)
		const body = res.json<Record<string, unknown>>()
		expect(body["status"]).toBe("unhealthy")
		expect(body["reason"]).toBe("all_decoders_down")
		expect(typeof body["timestamp"]).toBe("string")
		expect(res.body).not.toContain("ECONNREFUSED")
	})
})

describe("GET /health/ready", () => {
	it("answers 200 with status ok when ready", async () => {
		const server = await serve(
			managers({
				sources: [{ id: "rtl", connected: true }],
				decoders: [{ id: "adsb", running: true }],
			}),
		)
		const res = await server.inject({ method: "GET", url: "/health/ready" })
		expect(res.statusCode).toBe(200)
		expect(res.json<{ status: string }>().status).toBe("ok")
	})

	it("answers 200 when nothing is configured", async () => {
		const server = await serve(managers({ sources: [], decoders: [] }))
		const res = await server.inject({ method: "GET", url: "/health/ready" })
		expect(res.statusCode).toBe(200)
		expect(res.json<{ status: string }>().status).toBe("ok")
	})

	it("answers 503 not_ready when no configured source is connected", async () => {
		const server = await serve(
			managers({
				sources: [{ id: "rtl", connected: false, lastError: secret }],
				decoders: [{ id: "adsb", running: true }],
			}),
		)
		const res = await server.inject({ method: "GET", url: "/health/ready" })
		expect(res.statusCode).toBe(503)
		const body = res.json<Record<string, unknown>>()
		expect(body["status"]).toBe("not_ready")
		expect(body["reason"]).toBe("no_source_connected")
		expect(typeof body["timestamp"]).toBe("string")
		expect(res.body).not.toContain("ECONNREFUSED")
	})

	it("answers 503 not_ready when no configured decoder runs", async () => {
		const server = await serve(
			managers({
				sources: [{ id: "rtl", connected: true }],
				decoders: [{ id: "adsb", running: false }],
			}),
		)
		const res = await server.inject({ method: "GET", url: "/health/ready" })
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({
			status: "not_ready",
			reason: "no_decoder_running",
		})
	})
})

describe("GET /health/live", () => {
	it("answers 200 ok", async () => {
		const server = await serve(managers({ sources: [], decoders: [] }))
		const res = await server.inject({ method: "GET", url: "/health/live" })
		expect(res.statusCode).toBe(200)
		expect(res.json<{ status: string }>().status).toBe("ok")
	})
})
