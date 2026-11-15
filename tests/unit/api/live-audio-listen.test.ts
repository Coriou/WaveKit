/**
 * Live audio routes, Listen (2026-11-15): PATCH accepts `open`, `voiceOnly` and `listenMode`,
 * stores deprecated `noise` as auto + voiceOnly false and manual at 0 as open, and every status
 * reports the new keys with their defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { EventEmitter } from "node:events"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import {
	LiveDemodRuntimeConfigSchema,
	type LiveDemodConfig,
	type LiveDemodStatus,
} from "../../../src/core/live-demodulator.js"

/** A stand-in that validates like `LiveDemodulator.reconfigure` (merge, then parse). */
function createLiveDemod(initial: Record<string, unknown> = {}) {
	const status: LiveDemodStatus = {
		enabled: true,
		running: true,
		sourceId: "rtl-pi",
		sourceConnected: true,
		sourceIqSampleRate: 2_400_000,
		config: LiveDemodRuntimeConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: 8081,
			...initial,
		}),
		effectiveSampleRate: 25_000,
		decimationFactor: 96,
		httpUrl: "http://localhost:8081/stream",
		wavUrl: "http://localhost:8081/stream.wav",
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
	}
	const reconfigure = vi.fn((updates: Partial<LiveDemodConfig>) => {
		status.config = LiveDemodRuntimeConfigSchema.parse({
			...status.config,
			...updates,
		})
		return Promise.resolve()
	})
	return Object.assign(new EventEmitter(), {
		status,
		getStatus: vi.fn(() => status),
		start: vi.fn(),
		stop: vi.fn(),
		reconfigure,
	})
}

type Body = { config: Record<string, unknown> }

describe("Live Audio Routes: Listen squelch contract", () => {
	let app: FastifyInstance
	let liveDemod: ReturnType<typeof createLiveDemod>

	async function mount(initial: Record<string, unknown> = {}): Promise<void> {
		await app?.close()
		liveDemod = createLiveDemod(initial)
		app = Fastify({ logger: false })
		await app.register(liveAudioRoutes, {
			liveDemod: liveDemod as unknown as Parameters<
				typeof liveAudioRoutes
			>[1]["liveDemod"],
		})
	}

	beforeEach(async () => {
		await mount()
	})

	afterEach(async () => {
		await app.close()
	})

	const patch = (payload: unknown) =>
		app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: payload as Record<string, unknown>,
		})

	it("status reports voiceOnly and listenMode with their defaults", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(response.statusCode).toBe(200)
		expect(response.json<Body>().config).toMatchObject({
			squelchMode: "auto",
			voiceOnly: true,
			listenMode: "auto",
		})
	})

	it("accepts open, voiceOnly and listenMode and returns them", async () => {
		const response = await patch({
			squelchMode: "open",
			voiceOnly: false,
			listenMode: "digital",
		})
		expect(response.statusCode).toBe(200)
		expect(liveDemod.reconfigure).toHaveBeenCalledWith({
			squelchMode: "open",
			voiceOnly: false,
			listenMode: "digital",
		})
		expect(response.json<Body>().config).toMatchObject({
			squelchMode: "open",
			voiceOnly: false,
			listenMode: "digital",
		})
	})

	it("stores deprecated noise as auto with voiceOnly false; never reports noise", async () => {
		const response = await patch({ squelchMode: "noise" })
		expect(response.statusCode).toBe(200)
		expect(liveDemod.reconfigure).toHaveBeenCalledWith({
			squelchMode: "auto",
			voiceOnly: false,
		})
		expect(response.json<Body>().config).toMatchObject({
			squelchMode: "auto",
			voiceOnly: false,
		})
	})

	it("still refuses noise on a modulation without noise squelch (400, unchanged)", async () => {
		const response = await patch({ squelchMode: "noise", modulation: "am" })
		expect(response.statusCode).toBe(400)
		expect(liveDemod.status.config.squelchMode).toBe("auto")
	})

	it("stores manual at 0 as open, from the mode or the level", async () => {
		const both = await patch({ squelchMode: "manual", squelch: 0 })
		expect(both.json<Body>().config["squelchMode"]).toBe("open")
		await patch({ squelchMode: "manual", squelch: -50 })
		expect(liveDemod.status.config.squelchMode).toBe("manual")
		const level = await patch({ squelch: 0 })
		expect(level.json<Body>().config["squelchMode"]).toBe("open")
		// Open keeps a stored level: a line set while open does not leave open.
		const kept = await patch({ squelch: -40 })
		expect(kept.json<Body>().config).toMatchObject({
			squelchMode: "open",
			squelch: -40,
		})
	})

	it("reports an unmigrated stored noise or manual at 0 migrated", async () => {
		await mount({ squelchMode: "noise" })
		const noise = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(noise.json<Body>().config).toMatchObject({
			squelchMode: "auto",
			voiceOnly: false,
		})
		await mount({ squelchMode: "manual", squelch: 0 })
		const off = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(off.json<Body>().config["squelchMode"]).toBe("open")
	})

	it("refuses malformed values with 400 and leaves the config alone", async () => {
		for (const payload of [
			{ squelchMode: "off" },
			{ voiceOnly: "no" },
			{ listenMode: "decoded" },
			{ listenMode: null },
		]) {
			const response = await patch(payload)
			expect(response.statusCode).toBe(400)
		}
		expect(liveDemod.reconfigure).not.toHaveBeenCalled()
	})
})
