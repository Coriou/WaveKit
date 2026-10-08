/**
 * Decoder status contract (CLI-COORDINATION requests 2-4): the new optional
 * fields survive Fastify response schemas on every decoder route and the
 * `decoder:status` WebSocket event carries the identical serialization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import Fastify, { type FastifyInstance } from "fastify"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import { healthRoutes } from "../../../src/api/routes/health.js"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import { createLogger } from "../../../src/utils/logger.js"
import type { DecoderCaps, DecoderStatus } from "../../../src/decoders/types.js"

const logger = createLogger({ level: "fatal" })

const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}

function fullStatus(): DecoderStatus {
	return {
		id: "acars",
		type: "acarsdec",
		running: false,
		health: "running",
		uptime: 0,
		stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
		restartCount: 8,
		sourceId: "rtl-pi",
		targetFrequenciesHz: [131_550_000, 131_725_000],
		idleTimeoutMs: 30_000,
		lastError: {
			kind: "exit",
			message: "Process exited unexpectedly (code 1)",
			at: new Date("2026-10-08T12:00:00.000Z"),
		},
	}
}

const expectedFields = {
	sourceId: "rtl-pi",
	targetFrequenciesHz: [131_550_000, 131_725_000],
	idleTimeoutMs: 30_000,
	lastError: {
		kind: "exit",
		message: "Process exited unexpectedly (code 1)",
		at: "2026-10-08T12:00:00.000Z",
	},
}

describe("decoder REST contract", () => {
	let app: FastifyInstance
	let status: DecoderStatus
	let running = false

	beforeEach(async () => {
		status = fullStatus()
		running = false
		app = Fastify()
		await app.register(decoderRoutes, {
			decoderManager: {
				getAllStatus: () => [status],
				getStatus: () => status,
				getDecoder: () => ({ getStatus: () => ({ ...status, running }) }),
				startDecoder: vi.fn(async () => {
					running = true
				}),
				stopDecoder: vi.fn(),
				restartDecoder: vi.fn(),
			} as unknown as DecoderRoutesOptions["decoderManager"],
			decoderRegistry: {
				getCaps: () => caps,
				getRegisteredTypes: () => ["acarsdec"],
			} as unknown as DecoderRoutesOptions["decoderRegistry"],
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it.each([
		["GET", "/api/decoders", (body: unknown) => (body as unknown[])[0]],
		["GET", "/api/decoders/acars", (body: unknown) => body],
		[
			"POST",
			"/api/decoders/acars/start",
			(body: unknown) => (body as { decoder: unknown }).decoder,
		],
		[
			"POST",
			"/api/decoders/acars/restart",
			(body: unknown) => (body as { decoder: unknown }).decoder,
		],
	] as const)("%s %s keeps the new fields", async (method, url, pick) => {
		const response = await app.inject({ method, url })
		expect(response.statusCode).toBe(200)
		expect(pick(response.json())).toMatchObject(expectedFields)
	})

	it("serializes an external-SDR decoder's device hint and omits absent fields", async () => {
		status = {
			...fullStatus(),
			deviceSerial: "00000003",
		}
		delete status.sourceId
		delete status.lastError
		delete status.targetFrequenciesHz
		const body = (await app.inject("/api/decoders/acars")).json() as Record<
			string,
			unknown
		>
		expect(body["deviceSerial"]).toBe("00000003")
		expect(body).not.toHaveProperty("sourceId")
		expect(body).not.toHaveProperty("lastError")
		expect(body).not.toHaveProperty("targetFrequenciesHz")
	})

	it("bounds lastError.message in the response schema", async () => {
		status.lastError = {
			kind: "error",
			message: "y".repeat(600),
			at: new Date(0),
		}
		const response = await app.inject("/api/decoders/acars")
		expect(response.statusCode).toBe(200)
		expect(response.json().lastError.message.length).toBeLessThanOrEqual(512)
	})
})

describe("legacy /api/status decoder entries", () => {
	it("carries the same new fields", async () => {
		const app = Fastify()
		const status = fullStatus()
		await app.register(healthRoutes, {
			decoderManager: {
				getAllStatus: () => [status],
				getAllHealth: () => new Map([["acars", "running"]]),
			},
			sourceManager: { getAllStatus: () => [] },
			audioOutput: { getConnectedClients: () => 0, getPort: () => 8080 },
		} as never)
		const response = await app.inject("/api/status")
		await app.close()
		expect(response.statusCode).toBe(200)
		expect(response.json().decoders[0]).toMatchObject(expectedFields)
	})
})

describe("decoder:status WebSocket event", () => {
	let server: ApiServer
	let decoderManager: EventEmitter & { getStatus: (id: string) => unknown }

	beforeEach(() => {
		const status = fullStatus()
		decoderManager = Object.assign(new EventEmitter(), {
			getStatus: (id: string) => (id === "acars" ? status : undefined),
			getAllStatus: () => [status],
		})
		const sourceManager = Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
		})
		const fanoutManager = Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({ branches: [] }),
		})
		server = new ApiServer(
			{
				sourceManager: sourceManager as never,
				fanoutManager: fanoutManager as never,
				decoderManager: decoderManager as never,
				decoderRegistry: {
					getCaps: () => caps,
				} as unknown as ApiServerDependencies["decoderRegistry"],
				audioOutput: new EventEmitter() as never,
				logger,
			},
			{ host: "127.0.0.1", port: 0 },
		)
	})

	afterEach(async () => {
		await server.stop()
	})

	it.each([
		["decoder:started", ["acars"]],
		["decoder:stopped", ["acars"]],
		["decoder:error", ["acars", new Error("boom")]],
		["decoder:health", ["acars", "idle"]],
		["decoder:restarting", ["acars", 3, 8000]],
		["decoder:max-restarts", ["acars", 5]],
	] as const)(
		"publishes the GET /api/decoders/:id body on %s",
		async (event, args) => {
			const broadcast = vi.spyOn(server.getWebSocketBroadcaster(), "broadcast")
			decoderManager.emit(event, ...args)
			const call = broadcast.mock.calls.find(
				([, message]) => message.type === "decoder:status",
			)
			expect(call?.[0]).toBe("decoders")
			const data = JSON.parse(JSON.stringify(call?.[1].data)) as unknown
			expect(data).toMatchObject({
				id: "acars",
				running: false,
				restartCount: 8,
				caps,
				...expectedFields,
			})
		},
	)
})
