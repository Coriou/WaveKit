/**
 * Live Audio Routes Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { EventEmitter } from "node:events"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import type { LiveDemodStatus } from "../../../src/core/live-demodulator.js"
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
