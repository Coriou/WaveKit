/**
 * Auto listen route on the live audio REST surface (docs/specs/auto-listen-route 6.1, 6.3): the
 * status response schema keeps `autoRoute` (not stripped), with the legacy URL rewrite applied
 * to its stream URLs like `/stream`.
 */
import Fastify, { type FastifyInstance } from "fastify"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LiveAudioAutoRoute } from "@wavekit/api-types"
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
			httpPort: 41_234,
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
		httpUrl: "http://localhost:41234/stream",
		wavUrl: "http://localhost:41234/stream.wav",
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
	}
}

const DIGITAL: LiveAudioAutoRoute = {
	active: "digital",
	protocol: "DMR",
	decoderId: "dsd-fme",
	slot: 1,
	since: "2026-10-24T12:00:00.000Z",
	httpUrl: "http://localhost:41234/auto",
	wavUrl: "http://localhost:41234/auto.wav",
	clientCount: 2,
	digitalAvailable: true,
	underruns: 3,
	droppedMs: 12.5,
	clockRebases: 1,
	latencyMs: 80,
}

let app: FastifyInstance | null = null
afterEach(async () => {
	await app?.close()
	app = null
})

async function body(
	status: LiveDemodStatus,
	legacyAudioHost = false,
	host?: string,
): Promise<Record<string, unknown>> {
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
		legacyAudioHost,
	})
	const response = await app.inject({
		method: "GET",
		url: "/api/live-audio/status",
		...(host !== undefined ? { headers: { host } } : {}),
	})
	expect(response.statusCode).toBe(200)
	return JSON.parse(response.body) as Record<string, unknown>
}

describe("live audio auto route (REST)", () => {
	it("keeps every autoRoute field, including a null slot", async () => {
		expect(
			(await body({ ...baseStatus(), autoRoute: DIGITAL }))["autoRoute"],
		).toEqual(DIGITAL)
		const analog: LiveAudioAutoRoute = {
			active: "analog",
			slot: null,
			since: DIGITAL.since,
			httpUrl: DIGITAL.httpUrl,
			wavUrl: DIGITAL.wavUrl,
			clientCount: 1,
			digitalAvailable: false,
			underruns: 0,
			droppedMs: 0,
			clockRebases: 0,
			latencyMs: 20,
		}
		expect(
			(await body({ ...baseStatus(), autoRoute: analog }))["autoRoute"],
		).toEqual(analog)
	})

	it("omits autoRoute when the core does not report it", async () => {
		expect(Object.keys(await body(baseStatus()))).not.toContain("autoRoute")
	})

	it("legacy mode rewrites the /auto URLs with the request host like /stream", async () => {
		const out = await body(
			{ ...baseStatus(), autoRoute: DIGITAL },
			true,
			"receiver.local:8080",
		)
		const route = out["autoRoute"] as LiveAudioAutoRoute
		const httpUrl = out["httpUrl"] as string
		expect(httpUrl).toBe("http://receiver.local:41234/stream")
		expect(route.httpUrl).toBe(httpUrl.replace(/\/stream$/, "/auto"))
		expect(route.wavUrl).toBe(httpUrl.replace(/\/stream$/, "/auto.wav"))
		expect(route.active).toBe("digital")
	})
})
