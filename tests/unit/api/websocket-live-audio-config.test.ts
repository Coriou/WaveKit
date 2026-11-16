/**
 * Listen: the WebSocket `live-audio:status` and `live-audio:config` payloads report the live-audio
 * config exactly as REST does (one client mapper): the runtime defaults of `voiceOnly` and
 * `listenMode`, and the squelch migrated on read (manual at 0 without a tone is open).
 */
import { describe, it, expect, afterEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { EventEmitter } from "node:events"
import type { WebSocket } from "ws"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import {
	LiveDemodRuntimeConfigSchema,
	type LiveDemodConfig,
	type LiveDemodStatus,
} from "../../../src/core/live-demodulator.js"
import { createLogger } from "../../../src/utils/logger.js"

const SQUELCH_KEYS = [
	"squelchMode",
	"voiceOnly",
	"listenMode",
	"autoMarginDb",
	"noiseQuietingDb",
] as const

function statusFor(config: LiveDemodConfig): LiveDemodStatus {
	return {
		enabled: true,
		running: true,
		sourceId: "src-a",
		sourceConnected: true,
		sourceIqSampleRate: 2_400_000,
		config,
		effectiveSampleRate: 25_000,
		decimationFactor: 96,
		httpUrl: "http://localhost:8081/stream",
		wavUrl: "http://localhost:8081/stream.wav",
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
	}
}

/** The real broadcaster with one subscribed fake socket; returns the parsed messages. */
function broadcasterWithClient(): {
	broadcaster: WebSocketEventBroadcaster
	messages: Array<{ type: string; data: Record<string, unknown> }>
} {
	const broadcaster = new WebSocketEventBroadcaster(
		createLogger({ level: "fatal" }),
	)
	const messages: Array<{ type: string; data: Record<string, unknown> }> = []
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
				messages.push(
					JSON.parse(data) as { type: string; data: Record<string, unknown> },
				)
			},
			close: () => undefined,
			on: () => undefined,
			bufferedAmount: 0,
		} as unknown as WebSocket,
		subscriptions: new Set(["live-audio"]),
		id: "client-1",
	})
	return { broadcaster, messages }
}

function pick(config: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const key of SQUELCH_KEYS) out[key] = config[key]
	return out
}

let app: FastifyInstance | null = null

afterEach(async () => {
	await app?.close()
	app = null
})

/** The REST view of `GET /api/live-audio/status` for a stored config. */
async function restConfig(
	config: LiveDemodConfig,
): Promise<Record<string, unknown>> {
	const status = statusFor(config)
	const liveDemod = Object.assign(new EventEmitter(), {
		getStatus: () => status,
		start: () => undefined,
		stop: () => undefined,
		reconfigure: () => undefined,
	})
	app = Fastify({ logger: false })
	await app.register(liveAudioRoutes, {
		liveDemod: liveDemod as unknown as Parameters<
			typeof liveAudioRoutes
		>[1]["liveDemod"],
	})
	const response = await app.inject({
		method: "GET",
		url: "/api/live-audio/status",
	})
	expect(response.statusCode).toBe(200)
	return (JSON.parse(response.body) as { config: Record<string, unknown> })
		.config
}

/** The WebSocket views (status, then config) of a stored config. */
function wsConfigs(config: LiveDemodConfig): {
	status: Record<string, unknown>
	config: Record<string, unknown>
} {
	const { broadcaster, messages } = broadcasterWithClient()
	broadcaster.broadcastLiveAudioStatus(statusFor(config))
	broadcaster.broadcastLiveAudioConfig(config)
	expect(messages.map(m => m.type)).toEqual([
		"live-audio:status",
		"live-audio:config",
	])
	const status = messages[0]?.data["config"] as Record<string, unknown>
	return { status, config: messages[1]?.data ?? {} }
}

describe("live-audio WebSocket config matches REST", () => {
	it("a default runtime config carries voiceOnly true and listenMode auto on status and config, as REST", async () => {
		const stored = LiveDemodRuntimeConfigSchema.parse({ enabled: true })
		expect(stored.voiceOnly).toBe(true)
		expect(stored.listenMode).toBe("auto")
		const ws = wsConfigs(stored)
		const rest = await restConfig(stored)
		const expected = {
			squelchMode: "auto",
			voiceOnly: true,
			listenMode: "auto",
			autoMarginDb: 6,
			noiseQuietingDb: 6,
		}
		expect(pick(ws.status)).toEqual(expected)
		expect(pick(ws.config)).toEqual(expected)
		expect(pick(rest)).toEqual(expected)
	})

	it("a stored config without the Listen keys gets the same defaults on both paths", async () => {
		const stored = LiveDemodRuntimeConfigSchema.parse({ enabled: true })
		const legacy: LiveDemodConfig = { ...stored }
		delete legacy.voiceOnly
		delete legacy.listenMode
		const ws = wsConfigs(legacy)
		const rest = await restConfig(legacy)
		expect(ws.status["voiceOnly"]).toBe(true)
		expect(ws.status["listenMode"]).toBe("auto")
		expect(pick(ws.config)).toEqual(pick(ws.status))
		expect(pick(rest)).toEqual(pick(ws.status))
	})

	it("manual at 0 without a tone reports open on both paths; with a tone it stays manual", async () => {
		const base = LiveDemodRuntimeConfigSchema.parse({ enabled: true })
		const off: LiveDemodConfig = { ...base, squelchMode: "manual", squelch: 0 }
		const wsOff = wsConfigs(off)
		const restOff = await restConfig(off)
		expect(wsOff.status["squelchMode"]).toBe("open")
		expect(wsOff.config["squelchMode"]).toBe("open")
		expect(pick(restOff)).toEqual(pick(wsOff.status))
		await app?.close()
		app = null

		const toneOnly: LiveDemodConfig = {
			...off,
			toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
		}
		const wsTone = wsConfigs(toneOnly)
		const restTone = await restConfig(toneOnly)
		expect(wsTone.status["squelchMode"]).toBe("manual")
		expect(wsTone.config["squelchMode"]).toBe("manual")
		expect(pick(restTone)).toEqual(pick(wsTone.status))
	})

	it("the WebSocket payloads still never carry chanBinaryPath", () => {
		const stored: LiveDemodConfig = {
			...LiveDemodRuntimeConfigSchema.parse({ enabled: true }),
			chanBinaryPath: "SECRET-PATH",
		}
		const ws = wsConfigs(stored)
		expect(Object.hasOwn(ws.status, "chanBinaryPath")).toBe(false)
		expect(Object.hasOwn(ws.config, "chanBinaryPath")).toBe(false)
	})
})
