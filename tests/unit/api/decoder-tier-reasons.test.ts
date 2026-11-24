/**
 * dsd-fme evidence tiers: the placement reasons `digital-memory`,
 * `analog-voice` and `no-sync` survive every real decoder status serializer:
 * REST GET /api/decoders and /api/decoders/:id, the legacy /api/status and the
 * `decoder:status` WebSocket event.
 */
import { EventEmitter } from "node:events"
import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"
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

const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}

const reasons = [
	["live-energy", "decoded", "digital-memory"],
	["analog-voice", "no-sync"],
] as const

function status(): DecoderStatus {
	return {
		id: "voice",
		type: "dsd-fme",
		running: true,
		health: "running",
		uptime: 1,
		stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
		restartCount: 0,
		placements: reasons.map((r, i) => ({
			sourceId: "rtl",
			channelHz: 446_006_250 + i * 12_500,
			reach: "channel" as const,
			origin: "activity" as const,
			primary: false,
			running: true,
			costCores: 0.155,
			activity: {
				ranking: "activity" as const,
				state: "hot" as const,
				score: 1,
				live: false,
				reasons: [...r],
			},
		})),
	}
}

const reasonsOf = (body: unknown) =>
	(
		body as { placements: { activity: { reasons: string[] } }[] }
	).placements.map(p => p.activity.reasons)

describe("tier reasons through every decoder status serializer", () => {
	it.each(["/api/decoders", "/api/decoders/voice"])("REST %s", async url => {
		const s = status()
		const app = Fastify()
		await app.register(decoderRoutes, {
			decoderManager: {
				getAllStatus: () => [s],
				getStatus: () => s,
				getDecoder: () => ({ getStatus: () => s }),
				startDecoder: vi.fn(),
				stopDecoder: vi.fn(),
				restartDecoder: vi.fn(),
			} as unknown as DecoderRoutesOptions["decoderManager"],
			decoderRegistry: {
				getCaps: () => caps,
				getRegisteredTypes: () => ["dsd-fme"],
			} as unknown as DecoderRoutesOptions["decoderRegistry"],
		})
		try {
			const response = await app.inject(url)
			expect(response.statusCode).toBe(200)
			const body: unknown = response.json()
			expect(reasonsOf(Array.isArray(body) ? body[0] : body)).toEqual(reasons)
		} finally {
			await app.close()
		}
	})

	it("REST /api/status", async () => {
		const s = status()
		const app = Fastify()
		await app.register(healthRoutes, {
			decoderManager: {
				getAllStatus: () => [s],
				getAllHealth: () => new Map([["voice", "running"]]),
			},
			sourceManager: { getAllStatus: () => [] },
			audioOutput: { getConnectedClients: () => 0, getPort: () => 8080 },
		} as never)
		try {
			const response = await app.inject("/api/status")
			expect(response.statusCode).toBe(200)
			expect(reasonsOf(response.json().decoders[0])).toEqual(reasons)
		} finally {
			await app.close()
		}
	})

	it("WebSocket decoder:status", async () => {
		const s = status()
		const decoderManager = Object.assign(new EventEmitter(), {
			getStatus: (id: string) => (id === "voice" ? s : undefined),
			getAllStatus: () => [s],
		})
		const server = new ApiServer(
			{
				sourceManager: Object.assign(new EventEmitter(), {
					getAllStatus: () => [],
				}) as never,
				fanoutManager: Object.assign(new EventEmitter(), {
					getTelemetrySnapshot: () => ({ branches: [] }),
				}) as never,
				decoderManager: decoderManager as never,
				decoderRegistry: {
					getCaps: () => caps,
				} as unknown as ApiServerDependencies["decoderRegistry"],
				audioOutput: new EventEmitter() as never,
				logger: createLogger({ level: "fatal" }),
			},
			{ host: "127.0.0.1", port: 0 },
		)
		try {
			const broadcast = vi.spyOn(server.getWebSocketBroadcaster(), "broadcast")
			decoderManager.emit("decoder:status-changed", "voice")
			const call = broadcast.mock.calls.find(
				([, message]) => message.type === "decoder:status",
			)
			expect(call).toBeDefined()
			const data = JSON.parse(JSON.stringify(call![1].data)) as unknown
			expect(reasonsOf(data)).toEqual(reasons)
		} finally {
			await server.stop()
		}
	})
})
