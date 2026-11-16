/**
 * Live audio routes, WG7 (docs/specs/web-gaps-7, requirements 2.1, 2.3, 3.1,
 * 3.4): the PATCH body accepts the noise squelch and tone squelch keys and
 * refuses invalid combinations with 400; status and responses carry them.
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
function createLiveDemod() {
	const status: LiveDemodStatus = {
		enabled: true,
		running: true,
		sourceId: "rtl-pi",
		sourceConnected: true,
		sourceIqSampleRate: 2_400_000,
		config: LiveDemodRuntimeConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			squelchMode: "manual",
			httpPort: 8081,
		}),
		effectiveSampleRate: 25_000,
		decimationFactor: 96,
		httpUrl: "http://localhost:8081/stream",
		wavUrl: "http://localhost:8081/stream.wav",
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
		squelchOpen: false,
		toneSquelch: { state: "off" },
	}
	const reconfigure = vi.fn((updates: Partial<LiveDemodConfig>) => {
		status.config = LiveDemodRuntimeConfigSchema.parse({
			...status.config,
			...updates,
		})
		const tone = status.config.toneSquelch
		status.toneSquelch = {
			state: tone === undefined || tone.kind === "none" ? "off" : "waiting",
		}
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

describe("Live Audio Routes: noise and tone squelch", () => {
	let app: FastifyInstance
	let liveDemod: ReturnType<typeof createLiveDemod>

	beforeEach(async () => {
		liveDemod = createLiveDemod()
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

	const patch = (payload: unknown) =>
		app.inject({
			method: "PATCH",
			url: "/api/live-audio/config",
			payload: payload as Record<string, unknown>,
		})

	// Listen (2026-11-15): deprecated noise is accepted and stored as auto with voiceOnly false.
	it("accepts noise mode (stored as auto without the voice check), the quieting threshold and a tone, and returns them", async () => {
		const response = await patch({
			squelchMode: "noise",
			noiseQuietingDb: 10,
			toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
		})
		expect(response.statusCode).toBe(200)
		expect(liveDemod.reconfigure).toHaveBeenCalledWith({
			squelchMode: "auto",
			voiceOnly: false,
			noiseQuietingDb: 10,
			toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
		})
		const body = response.json<{
			config: Record<string, unknown>
			toneSquelch: unknown
		}>()
		expect(body.config["squelchMode"]).toBe("auto")
		expect(body.config["voiceOnly"]).toBe(false)
		expect(body.config["noiseQuietingDb"]).toBe(10)
		expect(body.config["toneSquelch"]).toEqual({
			kind: "ctcss",
			frequencyTenthsHz: 885,
		})
		expect(body.toneSquelch).toEqual({ state: "waiting" })
		const dcs = await patch({
			toneSquelch: { kind: "dcs", code: "023", polarity: "inverted" },
		})
		expect(dcs.statusCode).toBe(200)
		expect(
			dcs.json<{ config: Record<string, unknown> }>().config["toneSquelch"],
		).toEqual({
			kind: "dcs",
			code: "023",
			polarity: "inverted",
		})
		for (const db of [1, 30])
			expect((await patch({ noiseQuietingDb: db })).statusCode).toBe(200)
	})

	it("refuses noise on AM, a tone on WFM, non-standard tones and out-of-range quieting with 400", async () => {
		for (const payload of [
			{ squelchMode: "noise", modulation: "am" },
			{
				modulation: "wfm",
				bandwidth: 150_000,
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
			},
			{ toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1001 } },
			{ toneSquelch: { kind: "dcs", code: "024", polarity: "normal" } },
			{ toneSquelch: { kind: "dcs", code: "23", polarity: "normal" } },
			{ toneSquelch: { kind: "dcs", code: "023" } },
			{ toneSquelch: { kind: "none", code: "023" } },
			{ toneSquelch: { kind: "loud" } },
			{ toneSquelch: "ctcss" },
			{ noiseQuietingDb: 0.5 },
			{ noiseQuietingDb: 31 },
			{ noiseQuietingDb: "loud" },
		]) {
			const response = await patch(payload)
			expect(response.statusCode, JSON.stringify(payload)).toBe(400)
		}
		expect(liveDemod.status.config.squelchMode).toBe("manual")
		expect(liveDemod.status.config.toneSquelch).toBeUndefined()
	})

	// Listen: noise is no longer stored, so a later modulation change has no noise rule to break;
	// noise sent with a non-FM modulation is still refused with the original noise rule.
	it("refuses noise together with a non-FM modulation; a stored (migrated) noise config may move", async () => {
		const refused = await patch({ squelchMode: "noise", modulation: "usb" })
		expect(refused.statusCode).toBe(400)
		expect(refused.json<{ message: string }>().message).toContain(
			'"noise" needs modulation "nfm" or "wfm"',
		)
		expect(liveDemod.status.config.modulation).toBe("nfm")
		expect((await patch({ squelchMode: "noise" })).statusCode).toBe(200)
		expect(liveDemod.status.config.squelchMode).toBe("auto")
		const moved = await patch({ modulation: "usb" })
		expect(moved.statusCode).toBe(200)
		expect(liveDemod.status.config.modulation).toBe("usb")
	})

	it("GET status carries toneSquelch and the noise quieting default", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(response.statusCode).toBe(200)
		const body = response.json<{
			toneSquelch: unknown
			config: Record<string, unknown>
		}>()
		expect(body.toneSquelch).toEqual({ state: "off" })
		expect(body.config["noiseQuietingDb"]).toBe(6)
		// Listen: the stand-in's manual at squelch 0 is reported as open.
		expect(body.config["squelchMode"]).toBe("open")
		expect("toneSquelch" in body.config).toBe(false)
	})
})
