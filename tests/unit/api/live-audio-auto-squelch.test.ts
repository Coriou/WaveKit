/**
 * Evidence squelch on the live audio REST surface (docs/specs/evidence-squelch): the status DTO
 * and its response schema carry `autoSquelch`, and so does the `live-audio:level` broadcast
 * (requirement 4.1).
 */
import Fastify, { type FastifyInstance } from "fastify"
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import { createLogger } from "../../../src/utils/logger.js"
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
	let getStatus: ReturnType<typeof vi.fn>

	beforeEach(async () => {
		status = baseStatus()
		getStatus = vi.fn((options?: { diagnostics?: boolean }) =>
			options?.diagnostics === true
				? {
						...status,
						autoSquelch: {
							state: "waiting" as const,
							diagnostics: {
								verdict: "low-audio" as const,
								frames: 20,
								audioDb: -33.2,
								syllabic: 1.29,
								cluster: 0.33,
								quietBlocks: 100,
								notedBlocks: 100,
								windowResets: 1,
								audioMs: 4_000,
								deviationHz: 2_500,
							},
						},
					}
				: status,
		)
		const liveDemod = Object.assign(new EventEmitter(), {
			getStatus,
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

	// Diagnostic and unstable (2026-10-24): opt-in only.
	it("?diagnostics=true adds autoSquelch.diagnostics; the default status has none", async () => {
		status.autoSquelch = { state: "waiting" }
		expect((await getStatusBody())["autoSquelch"]).toEqual({ state: "waiting" })
		expect(getStatus).toHaveBeenLastCalledWith()
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status?diagnostics=true",
		})
		expect(response.statusCode).toBe(200)
		const body = JSON.parse(response.body) as Record<string, unknown>
		expect(getStatus).toHaveBeenLastCalledWith({ diagnostics: true })
		expect(body["autoSquelch"]).toEqual({
			state: "waiting",
			diagnostics: {
				verdict: "low-audio",
				frames: 20,
				audioDb: -33.2,
				syllabic: 1.29,
				cluster: 0.33,
				quietBlocks: 100,
				notedBlocks: 100,
				windowResets: 1,
				audioMs: 4_000,
				deviationHz: 2_500,
			},
		})
	})

	// Validates: Requirements 3.1
	it("status config reports auto when the core config lacks squelchMode", async () => {
		delete status.config.squelchMode
		const config = (await getStatusBody())["config"] as Record<string, unknown>
		expect(config["squelchMode"]).toBe("auto")
	})
})

describe("live audio auto squelch (WebSocket level)", () => {
	// Validates: Requirements 4.1, 4.2
	it("live-audio:level carries autoSquelch unchanged", () => {
		const broadcaster = new WebSocketEventBroadcaster(
			createLogger({ level: "fatal" }),
		)
		const sent: unknown[] = []
		vi.spyOn(broadcaster, "broadcast").mockImplementation(
			(channel, message) => {
				sent.push({ channel, message })
			},
		)
		const base = {
			sourceId: "rtl-pi",
			channelPowerDbfs: -40,
			noiseFloorDbfs: -60,
			squelchOpen: true,
			thresholdDbfs: -54,
		}
		broadcaster.broadcastLiveAudioLevel({
			...base,
			autoSquelch: { state: "open", evidence: "dcs" },
		})
		broadcaster.broadcastLiveAudioLevel({
			...base,
			autoSquelch: { state: "waiting" },
		})
		broadcaster.broadcastLiveAudioLevel(base)
		expect(sent).toEqual([
			{
				channel: "live-audio",
				message: {
					type: "live-audio:level",
					data: { ...base, autoSquelch: { state: "open", evidence: "dcs" } },
				},
			},
			{
				channel: "live-audio",
				message: {
					type: "live-audio:level",
					data: { ...base, autoSquelch: { state: "waiting" } },
				},
			},
			{
				channel: "live-audio",
				message: { type: "live-audio:level", data: base },
			},
		])
	})
})
