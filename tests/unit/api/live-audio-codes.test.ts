import Fastify from "fastify"
import { EventEmitter } from "node:events"
import { ZodError } from "zod"
import { describe, expect, it, vi } from "vitest"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const SUCCESS_GOLDEN =
	'{"enabled":true,"running":true,"sourceId":"rtl-pi","sourceConnected":true,"sourceIqSampleRate":2400000,"config":{"enabled":true,"httpPort":8081,"modulation":"nfm","bandwidth":12500,"squelch":0,"noiseReduction":"off","lowPass":0,"highPass":0,"gain":10,"deEmphasis":false,"deEmphasisTau":50,"audioFormat":"s16le","iqDcBlock":true,"sourceId":"rtl-pi","squelchMode":"manual","autoMarginDb":6,"noiseQuietingDb":6,"offsetHz":0},"effectiveSampleRate":25000,"decimationFactor":96,"httpUrl":"http://localhost:8081/stream","clientCount":0,"bytesStreamed":0,"pipelineHealth":"running","wavUrl":"http://localhost:8081/stream.wav","pipelineRestarts":0,"engine":"csdr"}'

const HOSTILE = "SECRET-<script>-9999"

async function app(reconfigure: () => unknown, redactErrors?: boolean) {
	const liveDemod = Object.assign(new EventEmitter(), {
		reconfigure: vi.fn(reconfigure),
		getStatus: vi.fn().mockReturnValue({
			enabled: true,
			running: true,
			sourceId: "rtl-pi",
			sourceIqSampleRate: 2_400_000,
			sourceConnected: true,
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
				squelchMode: "manual",
			},
			effectiveSampleRate: 25000,
			decimationFactor: 96,
			httpUrl: "http://localhost:8081/stream",
			wavUrl: "http://localhost:8081/stream.wav",
			clientCount: 0,
			bytesStreamed: 0,
			pipelineHealth: "running",
			pipelineRestarts: 0,
		}),
	})
	const fastify = Fastify({ logger: false })
	await fastify.register(liveAudioRoutes, {
		liveDemod: liveDemod as never,
		...(redactErrors === undefined ? {} : { redactErrors }),
	})
	return fastify
}

const patch = (f: Awaited<ReturnType<typeof app>>) =>
	f.inject({
		method: "PATCH",
		url: "/api/live-audio/config",
		payload: { offsetHz: 5 },
	})

const OFFSET_EXPECTED =
	"number, Hz from the tuned centre; the channel must stay inside the capture (|offsetHz| <= sample rate / 2 - bandwidth / 2)"

function zodError(): ZodError {
	return new ZodError([
		{ code: "custom", path: ["gain"], message: `bad ${HOSTILE}` },
	])
}

describe("live audio PATCH 400 codes (WG9 5.3)", () => {
	it("answers VALIDATION_ERROR for a ZodError", async () => {
		const res = await patch(
			await app(() => {
				throw zodError()
			}),
		)
		expect(res.statusCode).toBe(400)
		expect(res.json()).toMatchObject({
			error: "Bad Request",
			code: "VALIDATION_ERROR",
		})
		expect(typeof res.json().message).toBe("string")
	})

	it("answers the WaveKitError code", async () => {
		const res = await patch(
			await app(() => {
				throw new WaveKitError(
					"offset out of range",
					"CHANNEL_OFFSET_OUT_OF_RANGE",
				)
			}),
		)
		expect(res.json()).toEqual({
			error: "Bad Request",
			code: "CHANNEL_OFFSET_OUT_OF_RANGE",
			message: `Invalid request body: offsetHz: ${OFFSET_EXPECTED}`,
			fields: [{ field: "offsetHz", expected: OFFSET_EXPECTED }],
		})
	})

	it("answers static field text when access is configured and never echoes the value", async () => {
		for (const err of [
			zodError(),
			new WaveKitError(`offset ${HOSTILE}`, "CHANNEL_OFFSET_OUT_OF_RANGE"),
		]) {
			const res = await patch(
				await app(() => {
					throw err
				}, true),
			)
			expect(res.statusCode).toBe(400)
			expect(res.json().message).toMatch(
				/^Invalid request body: (gain|offsetHz): /,
			)
			expect(res.json().fields).toHaveLength(1)
			expect(res.body).not.toContain(HOSTILE)
		}
	})

	it("leaves a successful PATCH response unchanged", async () => {
		const res = await patch(await app(() => undefined))
		expect(res.statusCode, res.body).toBe(200)
		expect(res.json()).toMatchObject({ enabled: true, running: true })
		expect(res.json()).not.toHaveProperty("code")
		// Status for this fake. engine is always on the wire; engineFallback is not.
		expect(res.body).toBe(SUCCESS_GOLDEN)
	})
})
