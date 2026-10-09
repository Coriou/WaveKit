/**
 * Digital voice routes and WebSocket events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import type { WebSocket } from "ws"
import { digitalVoiceRoutes } from "../../../src/api/routes/digital-voice.js"
import {
	WebSocketEventBroadcaster,
	type WebSocketChannel,
} from "../../../src/api/websocket/events.js"
import type {
	DigitalVoiceCall,
	DigitalVoiceStatus,
} from "../../../src/core/digital-voice.js"
import { createLogger } from "../../../src/utils/logger.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const call: DigitalVoiceCall = {
	decoderId: "dsd-fme",
	callId: "dsd-fme-mg1x2-1",
	protocol: "dmr",
	talkgroup: 9,
	source: 2060945,
	slot: 1,
	encrypted: false,
	active: true,
	startedAt: "2026-10-09T13:38:38.413Z",
}

const status: DigitalVoiceStatus = {
	enabled: true,
	running: true,
	config: {
		enabled: true,
		httpPort: 8082,
		voiceSlot: "both",
		jitterBufferMs: 250,
		maxBufferMs: 1000,
	},
	sampleRate: 8000,
	audioFormat: "s16le",
	channels: 1,
	httpUrl: "http://localhost:8082/decoders/dsd-fme/stream",
	wavUrl: "http://localhost:8082/decoders/dsd-fme/stream.wav",
	clientCount: 1,
	bytesStreamed: 16000,
	decoders: [
		{
			decoderId: "dsd-fme",
			mode: "auto",
			udpPort: 41234,
			httpUrl: "http://localhost:8082/decoders/dsd-fme/stream",
			wavUrl: "http://localhost:8082/decoders/dsd-fme/stream.wav",
			clientCount: 1,
			bytesStreamed: 16000,
			datagramsReceived: 50,
			datagramsRejected: 0,
			encryptedDatagramsDropped: 0,
			droppedSamples: 0,
			underruns: 1,
			bufferedMs: 40,
			lastDatagramAt: "2026-10-09T13:38:39.000Z",
			call,
		},
	],
	call,
}

describe("Digital voice routes", () => {
	let app: FastifyInstance
	const service = {
		getStatus: vi.fn(() => status),
		start: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		app = Fastify({ logger: false })
		await app.register(digitalVoiceRoutes, {
			digitalVoice: service as unknown as Parameters<
				typeof digitalVoiceRoutes
			>[1]["digitalVoice"],
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it("GET /api/digital-voice/status returns the full status contract", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/digital-voice/status",
		})
		expect(response.statusCode).toBe(200)
		expect(JSON.parse(response.body)).toEqual(status)
	})

	it("serialises an idle status (call null, lastCall present)", async () => {
		const idle = {
			...status,
			call: null,
			decoders: [
				{
					...status.decoders[0]!,
					call: null,
					lastCall: {
						...call,
						active: false,
						endedAt: "2026-10-09T13:38:49.726Z",
					},
				},
			],
		}
		service.getStatus.mockReturnValueOnce(idle)
		const response = await app.inject({
			method: "GET",
			url: "/api/digital-voice/status",
		})
		expect(JSON.parse(response.body)).toEqual(idle)
	})

	it("POST start and stop control the stream", async () => {
		expect(
			(await app.inject({ method: "POST", url: "/api/digital-voice/start" }))
				.statusCode,
		).toBe(200)
		expect(service.start).toHaveBeenCalled()
		expect(
			(await app.inject({ method: "POST", url: "/api/digital-voice/stop" }))
				.statusCode,
		).toBe(200)
		expect(service.stop).toHaveBeenCalled()
	})

	it("POST start answers 409 when no decoder streams voice", async () => {
		service.start.mockRejectedValueOnce(
			new WaveKitError("disabled", "DIGITAL_VOICE_UNAVAILABLE"),
		)
		const response = await app.inject({
			method: "POST",
			url: "/api/digital-voice/start",
		})
		expect(response.statusCode).toBe(409)
		expect(JSON.parse(response.body)).toMatchObject({
			code: "DIGITAL_VOICE_UNAVAILABLE",
		})
	})
})

describe("digital-voice WebSocket channel", () => {
	it("delivers call and status events only to digital-voice subscribers", () => {
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		const sockets = (["digital-voice", "decoders"] as WebSocketChannel[]).map(
			(channel, i) => {
				const messages: string[] = []
				const socket = {
					readyState: 1,
					send: (data: string) => messages.push(data),
					close: vi.fn(),
					on: vi.fn(),
				}
				;(
					broadcaster as unknown as {
						clients: Map<string, unknown>
					}
				).clients.set(`c${i}`, {
					socket: socket as unknown as WebSocket,
					subscriptions: new Set([channel]),
					id: `c${i}`,
				})
				return messages
			},
		)
		broadcaster.broadcastDigitalVoiceCall(call)
		broadcaster.broadcastDigitalVoiceStatus(status)
		const received = sockets[0]!.map(
			m => JSON.parse(m) as { type: string; channel: string; data: unknown },
		)
		expect(received.map(m => [m.type, m.channel])).toEqual([
			["digital-voice:call", "digital-voice"],
			["digital-voice:status", "digital-voice"],
		])
		expect(received[0]!.data).toEqual(call)
		expect(sockets[1]).toHaveLength(0)
	})
})
