/**
 * WG12 req 6.4: GET live-audio status carries the transmission tone the
 * demodulator has noted, and omits it before any note and after stop.
 */
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import type { LiveDemodStatus } from "../../../src/core/live-demodulator.js"

const TONE = {
	ctcssHz: 88.5,
	dcs: null,
	at: "2026-10-17T10:00:02.000Z",
} as const

const DCS_TONE = {
	ctcssHz: null,
	dcs: { code: "023", polarity: "normal" as const },
	at: "2026-10-17T10:00:08.000Z",
}

function createToneDemod() {
	const status: LiveDemodStatus = {
		enabled: true,
		running: true,
		sourceId: "rtl-pi",
		sourceConnected: true,
		sourceIqSampleRate: 2_400_000,
		config: {
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: 19080,
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
		httpUrl: "http://localhost:19080/stream",
		wavUrl: "http://localhost:19080/stream.wav",
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
	}
	return Object.assign(new EventEmitter(), {
		getStatus: () => status,
		start: () => Promise.resolve(),
		stop: () => {
			status.running = false
			status.pipelineHealth = "stopped"
			delete status.tone
			return Promise.resolve()
		},
		reconfigure: () => Promise.resolve(),
		noteTransmissionTone(
			tone: {
				ctcssHz: number | null
				dcs: { code: string; polarity: "normal" | "inverted" } | null
				at: string
			} | null,
		) {
			if (tone === null) {
				delete status.tone
				return
			}
			status.tone = {
				ctcssHz: tone.ctcssHz,
				dcs: tone.dcs === null ? null : { ...tone.dcs },
				at: tone.at,
			}
		},
	})
}

describe("live audio status tone", () => {
	let app: FastifyInstance
	let demod: ReturnType<typeof createToneDemod>

	afterEach(async () => {
		await app.close()
	})

	it("omits tone before a note, returns it after a note, and omits it after stop", async () => {
		demod = createToneDemod()
		app = Fastify({ logger: false })
		await app.register(liveAudioRoutes, {
			liveDemod: demod as unknown as Parameters<
				typeof liveAudioRoutes
			>[1]["liveDemod"],
		})

		const before = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(before.statusCode).toBe(200)
		const quiet = JSON.parse(before.body) as LiveDemodStatus
		expect(quiet.running).toBe(true)
		expect(quiet.tone).toBeUndefined()
		expect(before.body).not.toContain('"tone"')

		demod.noteTransmissionTone(TONE)
		const noted = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(noted.statusCode).toBe(200)
		expect((JSON.parse(noted.body) as LiveDemodStatus).tone).toEqual(TONE)

		demod.noteTransmissionTone(DCS_TONE)
		const coded = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(coded.statusCode).toBe(200)
		expect((JSON.parse(coded.body) as LiveDemodStatus).tone).toEqual(DCS_TONE)

		const stopped = await app.inject({
			method: "POST",
			url: "/api/live-audio/stop",
		})
		expect(stopped.statusCode).toBe(200)
		const after = await app.inject({
			method: "GET",
			url: "/api/live-audio/status",
		})
		expect(after.statusCode).toBe(200)
		const done = JSON.parse(after.body) as LiveDemodStatus
		expect(done.running).toBe(false)
		expect(done.tone).toBeUndefined()
		expect(after.body).not.toContain('"tone"')
	})
})
