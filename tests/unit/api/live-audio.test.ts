/**
 * Live Audio Routes Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { EventEmitter } from "node:events"
import type { WebSocket } from "ws"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import type { LiveDemodStatus } from "../../../src/core/live-demodulator.js"
import { createLogger } from "../../../src/utils/logger.js"
import { WaveKitError } from "../../../src/utils/errors.js"

function createMockLiveDemodulator() {
	const mock = new EventEmitter()

	const status: LiveDemodStatus = {
		enabled: true,
		running: true,
		sourceId: "rtl-pi",
		sourceConnected: true,
		sourceIqSampleRate: 2_400_000,
		config: {
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: 8081,
			modulation: "nfm",
			bandwidth: 12500,
			squelch: 0,
			noiseReduction: "off",
			lowPass: 0,
			highPass: 0,
			gain: 10,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: true,
			offsetHz: 0,
		},
		effectiveSampleRate: 25000,
		decimationFactor: 96,
		httpUrl: "http://localhost:8081/stream",
		wavUrl: "http://localhost:8081/stream.wav",
		clientCount: 1,
		bytesStreamed: 123456,
		pipelineHealth: "running",
		pipelineRestarts: 0,
		channelPowerDbfs: -62.5,
		squelchOpen: false,
	}

	return Object.assign(mock, {
		getStatus: vi.fn().mockReturnValue(status),
		start: vi.fn(),
		stop: vi.fn(),
		reconfigure: vi.fn(),
	})
}

describe("Live Audio Routes", () => {
	let app: FastifyInstance
	let mockLiveDemod: ReturnType<typeof createMockLiveDemodulator>

	beforeEach(async () => {
		mockLiveDemod = createMockLiveDemodulator()
		app = Fastify({ logger: false })
		await app.register(liveAudioRoutes, {
			liveDemod: mockLiveDemod as unknown as Parameters<
				typeof liveAudioRoutes
			>[1]["liveDemod"],
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it("GET /api/live-audio/status returns status", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})

		expect(response.statusCode).toBe(200)
		const body = JSON.parse(response.body) as LiveDemodStatus
		expect(body.sourceId).toBe("rtl-pi")
		expect(body.pipelineHealth).toBe("running")
		expect(mockLiveDemod.getStatus).toHaveBeenCalled()
	})

	it("accepts manual/auto squelch updates and bounds the margin", async () => {
		const response = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: { squelchMode: "auto", autoMarginDb: 8 },
		})
		expect(response.statusCode).toBe(200)
		expect(mockLiveDemod.reconfigure).toHaveBeenCalledWith({
			squelchMode: "auto",
			autoMarginDb: 8,
		})
		for (const payload of [
			// WG7: "noise" is a mode now (live-audio-wg7.test.ts); unknown modes stay refused.
			{ squelchMode: "loud" },
			{ autoMarginDb: -1 },
			{ autoMarginDb: 41 },
		]) {
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: "/api/live-audio/config",
						payload,
					})
				).statusCode,
			).toBe(400)
		}
	})

	it("accepts agc values, null, and rejects invalid agc", async () => {
		for (const agc of ["off", "slow", "fast", null]) {
			mockLiveDemod.reconfigure.mockClear()
			const response = await app.inject({
				method: "PATCH",
				url: "/api/live-audio/config",
				payload: { agc },
			})
			expect(response.statusCode).toBe(200)
			expect(mockLiveDemod.reconfigure).toHaveBeenCalledWith({ agc })
		}
		const bad = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: { agc: "medium" },
		})
		expect(bad.statusCode).toBe(400)
	})

	it("exposes agc in status and omits config.agc when unset", async () => {
		const status = mockLiveDemod.getStatus() as LiveDemodStatus & {
			agc?: string
		}
		mockLiveDemod.getStatus.mockReturnValue({ ...status, agc: "off" })
		let body = JSON.parse(
			(await app.inject({ method: "GET", url: "/api/live-audio/status" })).body,
		) as { agc?: string; config: { agc?: string } }
		expect(body.agc).toBe("off")
		expect("agc" in body.config).toBe(false)
		mockLiveDemod.getStatus.mockReturnValue({
			...status,
			agc: "slow",
			config: { ...status.config, agc: "slow" },
		})
		body = JSON.parse(
			(await app.inject({ method: "GET", url: "/api/live-audio/status" })).body,
		) as { agc?: string; config: { agc?: string } }
		expect(body.agc).toBe("slow")
		expect(body.config.agc).toBe("slow")
	})

	it("POST /api/live-audio/start starts the pipeline", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/live-audio/start",
		})

		expect(response.statusCode).toBe(200)
		expect(mockLiveDemod.start).toHaveBeenCalled()
	})

	it("POST /api/live-audio/stop stops the pipeline", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/live-audio/stop",
		})

		expect(response.statusCode).toBe(200)
		expect(mockLiveDemod.stop).toHaveBeenCalled()
	})

	it("PATCH /api/live-audio/config updates config", async () => {
		const response = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: {
				modulation: "am",
				bandwidth: 10000,
			},
		})

		expect(response.statusCode).toBe(200)
		expect(mockLiveDemod.reconfigure).toHaveBeenCalledWith({
			modulation: "am",
			bandwidth: 10000,
		})
	})

	it("GET /api/live-audio/status includes the additive stream fields", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		const body = JSON.parse(response.body) as LiveDemodStatus
		expect(body.wavUrl).toBe("http://localhost:8081/stream.wav")
		expect(body.pipelineRestarts).toBe(0)
		expect(body.channelPowerDbfs).toBe(-62.5)
		expect(body.squelchOpen).toBe(false)
		expect(body.config.offsetHz).toBe(0)
	})

	it("GET /api/live-audio/status carries suspendedReason while the source is paused, and omits it otherwise", async () => {
		const read = async () =>
			JSON.parse(
				(await app.inject({ method: "GET", url: "/api/live-audio/status" }))
					.body,
			) as LiveDemodStatus
		expect(Object.hasOwn(await read(), "suspendedReason")).toBe(false)
		mockLiveDemod.getStatus.mockReturnValue({
			...mockLiveDemod.getStatus(),
			sourceConnected: false,
			suspendedReason: "source-paused",
		})
		const paused = await read()
		expect(paused.suspendedReason).toBe("source-paused")
		expect(paused.pipelineHealth).toBe("running")
	})

	it("live-audio:status carries suspendedReason as the REST status does", () => {
		const status: LiveDemodStatus = {
			...mockLiveDemod.getStatus(),
			sourceConnected: false,
			suspendedReason: "source-paused",
		}
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		const messages: string[] = []
		const clients = (
			broadcaster as unknown as {
				clients: Map<
					string,
					{ socket: WebSocket; subscriptions: Set<string>; id: string }
				>
			}
		).clients
		clients.set("client-1", {
			socket: {
				readyState: 1,
				send: (data: string) => {
					messages.push(data)
				},
				close: () => undefined,
				on: () => undefined,
				bufferedAmount: 0,
			} as unknown as WebSocket,
			subscriptions: new Set(["live-audio"]),
			id: "client-1",
		})
		broadcaster.broadcastLiveAudioStatus(status)
		const parsed = JSON.parse(messages[0] ?? "") as {
			data: { suspendedReason?: string }
		}
		expect(parsed.data.suspendedReason).toBe("source-paused")
	})

	it("PATCH /api/live-audio/config forwards offsetHz", async () => {
		const response = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: { offsetHz: 6000 },
		})
		expect(response.statusCode).toBe(200)
		expect(mockLiveDemod.reconfigure).toHaveBeenCalledWith({ offsetHz: 6000 })
	})

	it("PATCH /api/live-audio/config answers 400 for an offset outside the capture", async () => {
		mockLiveDemod.reconfigure.mockRejectedValueOnce(
			new WaveKitError("offsetHz too large", "CHANNEL_OFFSET_OUT_OF_RANGE"),
		)
		const response = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: { offsetHz: 5_000_000 },
		})
		expect(response.statusCode).toBe(400)
		expect(JSON.parse(response.body).message).toMatch(/offsetHz/)
	})

	it("GET status reports csdr, omits an unset fallback, and hides chanBinaryPath", async () => {
		const current = mockLiveDemod.getStatus()
		mockLiveDemod.getStatus.mockReturnValue({
			...current,
			config: {
				...current.config,
				chanBinaryPath: "do-not-leak-chan-binary",
			},
		})
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(response.statusCode).toBe(200)
		const body = JSON.parse(response.body) as {
			engine?: string
			engineFallback?: string
			config: { engine?: string; chanBinaryPath?: string }
		}
		expect(body.engine).toBe("csdr")
		expect(Object.hasOwn(body, "engineFallback")).toBe(false)
		expect(Object.hasOwn(body.config, "chanBinaryPath")).toBe(false)
		expect(response.body).not.toContain("do-not-leak-chan-binary")
	})

	it("GET status includes engineFallback only when set and still hides chanBinaryPath", async () => {
		const current = mockLiveDemod.getStatus()
		mockLiveDemod.getStatus.mockReturnValue({
			...current,
			engine: "csdr",
			engineFallback: "binary-unavailable",
			config: {
				...current.config,
				engine: "rust",
				chanBinaryPath: "do-not-leak-chan-binary",
			},
		})
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(response.statusCode).toBe(200)
		const body = JSON.parse(response.body) as {
			engine?: string
			engineFallback?: string
			config: { engine?: string }
		}
		expect(body.engine).toBe("csdr")
		expect(body.engineFallback).toBe("binary-unavailable")
		expect(body.config.engine).toBe("rust")
		expect(response.body).not.toContain("do-not-leak-chan-binary")
		expect(response.body).not.toContain("chanBinaryPath")
	})

	it("live-audio:status omits chanBinaryPath even when the core config has one", () => {
		const current = mockLiveDemod.getStatus()
		const status: LiveDemodStatus = {
			...current,
			engine: "rust",
			engineFallback: "open-rejected",
			config: {
				...current.config,
				engine: "rust",
				chanBinaryPath: "do-not-leak-chan-binary",
			},
		}
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		const messages: string[] = []
		const socket = {
			readyState: 1,
			send: (data: string) => {
				messages.push(data)
			},
			close: () => undefined,
			on: () => undefined,
			bufferedAmount: 0,
		}
		const clients = (
			broadcaster as unknown as {
				clients: Map<
					string,
					{ socket: WebSocket; subscriptions: Set<string>; id: string }
				>
			}
		).clients
		clients.set("client-1", {
			socket: socket as unknown as WebSocket,
			subscriptions: new Set(["live-audio"]),
			id: "client-1",
		})
		broadcaster.broadcastLiveAudioStatus(status)
		expect(messages).toHaveLength(1)
		const raw = messages[0] ?? ""
		const parsed = JSON.parse(raw) as {
			type: string
			data: {
				engine?: string
				engineFallback?: string
				config: { engine?: string; chanBinaryPath?: string }
			}
		}
		expect(parsed.type).toBe("live-audio:status")
		expect(parsed.data.engine).toBe("rust")
		expect(parsed.data.engineFallback).toBe("open-rejected")
		expect(parsed.data.config.engine).toBe("rust")
		expect(Object.hasOwn(parsed.data.config, "chanBinaryPath")).toBe(false)
		expect(raw).not.toContain("do-not-leak-chan-binary")
		expect(raw).not.toContain("chanBinaryPath")
	})

	it("live-audio:config omits chanBinaryPath", () => {
		const current = mockLiveDemod.getStatus()
		const config = {
			...current.config,
			chanBinaryPath: "SECRET-PATH",
		}
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		const messages: string[] = []
		const socket = {
			readyState: 1,
			send: (data: string) => {
				messages.push(data)
			},
			close: () => undefined,
			on: () => undefined,
			bufferedAmount: 0,
		}
		const clients = (
			broadcaster as unknown as {
				clients: Map<
					string,
					{ socket: WebSocket; subscriptions: Set<string>; id: string }
				>
			}
		).clients
		clients.set("client-1", {
			socket: socket as unknown as WebSocket,
			subscriptions: new Set(["live-audio"]),
			id: "client-1",
		})
		broadcaster.broadcastLiveAudioConfig(config)
		expect(messages).toHaveLength(1)
		const raw = messages[0] ?? ""
		const parsed = JSON.parse(raw) as {
			type: string
			data: { modulation?: string; gain?: number; chanBinaryPath?: string }
		}
		expect(parsed.type).toBe("live-audio:config")
		expect(parsed.data.modulation).toBe("nfm")
		expect(parsed.data.gain).toBe(current.config.gain)
		expect(Object.hasOwn(parsed.data, "chanBinaryPath")).toBe(false)
		expect(raw).not.toContain("SECRET-PATH")
		expect(raw).not.toContain("chanBinaryPath")
	})

	it("PATCH forwards engine", async () => {
		const response = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: { engine: "rust" },
		})
		expect(response.statusCode).toBe(200)
		expect(mockLiveDemod.reconfigure).toHaveBeenCalledWith({ engine: "rust" })
	})

	it("GET /api/live-audio/presets returns presets", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/presets",
		})

		expect(response.statusCode).toBe(200)
		const body = JSON.parse(response.body) as Record<string, unknown>
		expect(body["nfm"]).toBeDefined()
		expect(body["wfm"]).toBeDefined()
		expect(body["raw"]).toBeDefined()
	})
})
