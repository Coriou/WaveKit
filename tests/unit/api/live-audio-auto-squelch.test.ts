/**
 * Evidence squelch on the live audio REST surface (docs/specs/evidence-squelch): the status DTO
 * and its response schema carry `autoSquelch` (requirement 4.1).
 */
import Fastify, { type FastifyInstance } from "fastify"
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import type { LiveDemodStatus } from "../../../src/core/live-demodulator.js"

function baseStatus(): LiveDemodStatus {
	return {
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
			bandwidth: 12_500,
			squelch: 0,
			squelchMode: "auto",
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
		effectiveSampleRate: 25_000,
		decimationFactor: 96,
		httpUrl: "http://localhost:8081/stream",
		wavUrl: "http://localhost:8081/stream.wav",
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
		squelchOpen: true,
	}
}

describe("live audio auto squelch (REST)", () => {
	let app: FastifyInstance
	let status: LiveDemodStatus

	beforeEach(async () => {
		status = baseStatus()
		const liveDemod = Object.assign(new EventEmitter(), {
			getStatus: vi.fn(() => status),
			start: vi.fn(),
			stop: vi.fn(),
			reconfigure: vi.fn(),
		})
		app = Fastify({ logger: false })
		await app.register(liveAudioRoutes, {
			liveDemod: liveDemod as unknown as Parameters<
				typeof liveAudioRoutes
			>[1]["liveDemod"],
		})
	})

	afterEach(async () => {
		await app.close()
	})

	async function getStatusBody(): Promise<Record<string, unknown>> {
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(response.statusCode).toBe(200)
		return JSON.parse(response.body) as Record<string, unknown>
	}

	// Validates: Requirements 4.1
	it("REST status carries autoSquelch", async () => {
		status.autoSquelch = { state: "open", evidence: "ctcss" }
		expect((await getStatusBody())["autoSquelch"]).toEqual({
			state: "open",
			evidence: "ctcss",
		})
		status.autoSquelch = { state: "waiting" }
		const waiting = (await getStatusBody())["autoSquelch"]
		expect(waiting).toEqual({ state: "waiting" })
		expect(Object.keys(waiting as object)).not.toContain("evidence")
		delete status.autoSquelch
		expect(Object.keys(await getStatusBody())).not.toContain("autoSquelch")
	})
})
