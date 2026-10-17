/**
 * WG9 req 5.3 / 5.5 (Main wiring): through the real ApiServer, legacy mode derives the
 * live-audio, digital-voice and scanner listen stream URLs from the request Host and keeps the live-audio
 * PATCH 400 message; protected mode keeps the localhost URLs and redacts the message like the
 * global error handler.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })
const SECRET = "offsetHz 999999 SECRET-DETAIL"

function runtimeOptions(directory: string): NamedAccessRuntimeOptions {
	return {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [host],
			allowedOrigins: [origin],
			externalAudioOrigins: [
				"http://receiver.lan:9001",
				"http://receiver.lan:9002",
			],
		},
		audio: {
			analog: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
	}
}

function liveStatus() {
	return {
		enabled: true,
		running: true,
		sourceId: "rtl",
		sourceIqSampleRate: 2_400_000,
		sourceConnected: true,
		config: {
			enabled: true,
			sourceId: "rtl",
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
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
	}
}

function digitalStatus() {
	const url = "http://localhost:8082/decoders/dsd/stream"
	return {
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
		httpUrl: url,
		wavUrl: `${url}.wav`,
		clientCount: 0,
		bytesStreamed: 0,
		decoders: [
			{
				decoderId: "dsd",
				mode: "auto",
				udpPort: 41234,
				httpUrl: url,
				wavUrl: `${url}.wav`,
				clientCount: 0,
				bytesStreamed: 0,
				datagramsReceived: 0,
				datagramsRejected: 0,
				encryptedDatagramsDropped: 0,
				droppedSamples: 0,
				underruns: 0,
				bufferedMs: 0,
				call: null,
			},
		],
		call: null,
	}
}

function dependencies(
	extra: Partial<ApiServerDependencies>,
): ApiServerDependencies {
	const liveDemod = Object.assign(new EventEmitter(), {
		getStatus: () => liveStatus(),
		reconfigure: () => {
			throw new WaveKitError(SECRET, "CHANNEL_OFFSET_OUT_OF_RANGE")
		},
	})
	return {
		logger,
		sourceManager: Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
		}),
		decoderManager: Object.assign(new EventEmitter(), {
			getAllDecoders: () => [],
			getAllStatus: () => [],
			getAllHealth: () => new Map(),
		}),
		fanoutManager: Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
		audioOutput: Object.assign(new EventEmitter(), {
			getConnectedClients: () => 0,
			getPort: () => 0,
		}),
		liveDemod,
		digitalVoice: Object.assign(new EventEmitter(), {
			getStatus: () => digitalStatus(),
		}),
		scanner: Object.assign(new EventEmitter(), {
			settings: () => ({ ws: { maxMessagesPerSecond: 10 } }),
			listen: () =>
				Promise.resolve({
					mode: "live-audio",
					sourceId: "rtl",
					frequencyHz: 446_056_250,
					offsetHz: 0,
					httpUrl: "http://localhost:8081/stream",
					wavUrl: "http://localhost:8081/stream.wav",
				}),
		}),
		...extra,
	} as unknown as ApiServerDependencies
}

describe("legacy audio host and live-audio redaction through the API server (WG9 5.3, 5.5)", () => {
	const cleanup: Array<() => Promise<void> | void> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	it("legacy: stream URLs follow the Host; PATCH 400 keeps its message", async () => {
		const server = new ApiServer(dependencies({}), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const headers = { host: "receiver.lan:9000" }

		const live = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
			headers,
		})
		expect(live.statusCode).toBe(200)
		expect(live.headers["cache-control"]).toBe("no-store")
		expect(live.json()).toMatchObject({
			httpUrl: "http://receiver.lan:8081/stream",
			wavUrl: "http://receiver.lan:8081/stream.wav",
		})

		const digital = await app.inject({
			method: "GET",
			url: "/api/digital-voice/status",
			headers,
		})
		expect(digital.statusCode).toBe(200)
		const body = digital.json<ReturnType<typeof digitalStatus>>()
		expect(body.httpUrl).toBe("http://receiver.lan:8082/decoders/dsd/stream")
		expect(body.decoders[0]?.wavUrl).toBe(
			"http://receiver.lan:8082/decoders/dsd/stream.wav",
		)

		const listen = await app.inject({
			method: "POST",
			url: "/api/scanner/discoveries/d_1/listen",
			headers,
		})
		expect(listen.statusCode).toBe(200)
		expect(listen.json()).toMatchObject({
			httpUrl: "http://receiver.lan:8081/stream",
			wavUrl: "http://receiver.lan:8081/stream.wav",
		})

		const patch = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			headers,
			payload: { offsetHz: 5 },
		})
		expect(patch.statusCode).toBe(400)
		expect(patch.json()).toEqual({
			error: "Bad Request",
			code: "CHANNEL_OFFSET_OUT_OF_RANGE",
			message: SECRET,
		})
	})

	it("protected: stream URLs unchanged; PATCH 400 redacted", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "audio-host-wiring-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			ownership: "single-host-pid-namespace",
			mode: "provision",
		})
		const token = storage.useMachineCredential(value => value)
		await storage.close()
		const access = await openAccessRuntime(runtimeOptions(directory))
		cleanup.push(() => access.close())
		const server = new ApiServer(dependencies({ access }), {
			host: "127.0.0.1",
			port: 0,
			accessBootstrap: runtimeOptions(directory).bootstrap,
			publicOrigins: {
				api: origin,
				analogAudio: "http://receiver.lan:9001",
				digitalAudio: "http://receiver.lan:9002",
			},
		})
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const headers = { host, authorization: `Bearer ${token}` }

		const live = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
			headers,
		})
		expect(live.statusCode).toBe(200)
		expect(live.json()).toMatchObject({
			httpUrl: "http://localhost:8081/stream",
			wavUrl: "http://localhost:8081/stream.wav",
		})

		const digital = await app.inject({
			method: "GET",
			url: "/api/digital-voice/status",
			headers,
		})
		expect(digital.statusCode).toBe(200)
		const body = digital.json<ReturnType<typeof digitalStatus>>()
		expect(body.httpUrl).toBe("http://localhost:8082/decoders/dsd/stream")
		expect(body.decoders[0]?.httpUrl).toBe(
			"http://localhost:8082/decoders/dsd/stream",
		)

		const listen = await app.inject({
			method: "POST",
			url: "/api/scanner/discoveries/d_1/listen",
			headers,
		})
		expect(listen.statusCode).toBe(200)
		expect(listen.json()).toMatchObject({
			httpUrl: "http://localhost:8081/stream",
			wavUrl: "http://localhost:8081/stream.wav",
		})

		const patch = await app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			headers,
			payload: { offsetHz: 5 },
		})
		expect(patch.statusCode).toBe(400)
		expect(patch.json()).toEqual({
			error: "Bad Request",
			code: "CHANNEL_OFFSET_OUT_OF_RANGE",
			message: "Request failed",
		})
		expect(patch.body).not.toContain("SECRET")
	})
})
