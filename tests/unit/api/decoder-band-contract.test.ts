/**
 * Band-aware suspension contract (roadmap item 8): bandAssessment and the
 * "frequency-out-of-band" suspension reason survive the Fastify response
 * schemas, and `decoder:status` (same serializer) equals the REST body.
 * Contract: docs/CLI-COORDINATION.md "proposed contracts for roadmap item 8".
 * Band defaults + operator override (2026-10-09 spec §1.1, §5.2, §6): start
 * modes, the start body and the band override routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { decoderRoutes } from "../../../src/api/routes/decoders.js"
import { decoderBandRoutes } from "../../../src/api/routes/decoder-band.js"
import { toApiDecoderInfo } from "../../../src/api/serializers/decoder-status.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
const TARGET = 144_800_000
const ELSEWHERE = 162_000_000

let app: FastifyInstance
let manager: DecoderManager
let registry: DecoderRegistry
let sources: FakeSources
let decoder: RateDecoder

async function settle() {
	await vi.advanceTimersByTimeAsync(350)
}
async function getBody() {
	const response = await app.inject("/api/decoders/dec")
	expect(response.statusCode).toBe(200)
	return response.json() as Record<string, unknown>
}
function wsPayload() {
	return JSON.parse(
		JSON.stringify(toApiDecoderInfo(manager.getStatus("dec")!, registry)),
	) as Record<string, unknown>
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
	registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => {
			decoder = new RateDecoder(config.id, caps)
			decoder.band = { targetsHz: [TARGET], basis: "configured" }
			return decoder
		},
		caps,
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.createDecoder({
		id: "dec",
		type: "rate-test",
		enabled: true,
		options: {},
	})
	app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: manager,
		decoderRegistry: registry,
	})
	await app.register(decoderBandRoutes, { decoderManager: manager })
})
afterEach(async () => {
	await app.close()
	await manager.destroy()
	vi.useRealTimers()
})

describe("band suspension over REST", () => {
	it("an auto start out of band returns 200 with the band reason and assessment", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/decoders/dec/start",
			payload: { pin: false },
		})
		expect(response.statusCode).toBe(200)
		const { decoder: body, message } = response.json() as {
			decoder: Record<string, unknown>
			message: string
		}
		expect(message).toContain("suspended")
		expect(body).toMatchObject({
			running: false,
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
			bandAssessment: {
				verdict: "out-of-band",
				reasonCode: "frequency-out-of-band",
				targetsHz: [TARGET],
				basis: "configured",
				captureCenterHz: ELSEWHERE,
				windowHalfWidthHz: 19_200,
			},
		})
		expect(body).not.toHaveProperty("lastError")
		expect(body).toMatchObject({ startMode: "auto" })
		expect(decoder.starts).toBe(0)
	})

	it("decoder:status equals the REST body across a band suspend and resume", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: TARGET })
		await manager.startDecoder("dec")
		expect(await getBody()).toEqual(wsPayload())
		expect(await getBody()).toMatchObject({
			suspended: false,
			bandAssessment: { verdict: "in-band" },
		})

		sources.setCenter("rtl", ELSEWHERE)
		await settle()
		const suspended = await getBody()
		expect(suspended).toEqual(wsPayload())
		expect(suspended).toMatchObject({
			running: false,
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
		})

		sources.setCenter("rtl", TARGET)
		await settle()
		const resumed = await getBody()
		expect(resumed).toEqual(wsPayload())
		expect(resumed).toMatchObject({ running: true, suspended: false })
	})
})

async function start(payload?: unknown) {
	return app.inject({
		method: "POST",
		url: "/api/decoders/dec/start",
		...(payload !== undefined ? { payload: payload as object } : {}),
	})
}

describe("start modes over REST (spec §1.1)", () => {
	it("a bare start on a stopped decoder pins it and runs out of band", async () => {
		const response = await start()
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			decoder: {
				running: true,
				suspended: false,
				startMode: "operator",
				bandAssessment: { verdict: "out-of-band" },
			},
		})
		expect(await getBody()).toEqual(wsPayload())
	})

	it("run anyway: a bare start resumes a band-suspended decoder", async () => {
		await start({ pin: false })
		expect(decoder.starts).toBe(0)
		const response = await start()
		expect(response.statusCode).toBe(200)
		expect(decoder.starts).toBe(1)
		expect(response.json()).toMatchObject({
			decoder: { running: true, suspended: false, startMode: "operator" },
		})
	})

	it("{ pin: false } on a band-suspended decoder is a 200 no-op", async () => {
		await start({ pin: false })
		const response = await start({ pin: false })
		expect(response.statusCode).toBe(200)
		expect(decoder.starts).toBe(0)
		expect(response.json()).toMatchObject({
			decoder: { suspended: true, startMode: "auto" },
		})
	})

	it("a rate-suspended decoder stays suspended; the pin is recorded", async () => {
		sources.caps.set("rtl", { ...iqCaps(20_000), centerFreq: TARGET })
		const response = await start()
		expect(response.statusCode).toBe(200)
		expect(decoder.starts).toBe(0)
		expect(response.json()).toMatchObject({
			decoder: {
				suspended: true,
				suspension: { reasonCode: "insufficient-sample-rate" },
				startMode: "operator",
			},
		})
	})

	it("running: bare start is 409; a body changes the mode (200)", async () => {
		await start()
		expect((await start()).statusCode).toBe(409)
		expect((await start({ pin: true })).json()).toMatchObject({
			decoder: { running: true, startMode: "operator" },
		})
		const back = await start({ pin: false })
		expect(back.statusCode).toBe(200)
		expect(back.json()).toMatchObject({
			decoder: { running: true, startMode: "auto" },
		})
		// The worker then band-suspends it.
		await settle()
		expect(await getBody()).toMatchObject({
			running: false,
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
			startMode: "auto",
		})
		expect(await getBody()).toEqual(wsPayload())
	})

	it("rejects an invalid body with 400", async () => {
		const response = await start({ pin: "yes" })
		expect(response.statusCode).toBe(400)
		expect(response.json()).toMatchObject({ code: "INVALID_START_REQUEST" })
		expect((await start({ other: 1 })).statusCode).toBe(400)
	})
})

describe("band override routes (spec §5.2)", () => {
	it("GET reports the layers, the region and the assessment", async () => {
		const response = await app.inject("/api/decoders/dec/band")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({
			decoderId: "dec",
			override: null,
			configOverride: null,
			region: { code: "EU", source: "default" },
			persisted: false,
			bandAssessment: {
				verdict: "out-of-band",
				reasonCode: "frequency-out-of-band",
				targetsHz: [TARGET],
				basis: "configured",
				captureCenterHz: ELSEWHERE,
				windowHalfWidthHz: 19_200,
			},
		})
	})

	it("PUT applies a ranged override; the new fields survive REST and decoder:status", async () => {
		await start({ pin: false })
		const range = { minHz: ELSEWHERE - 500_000, maxHz: ELSEWHERE + 500_000 }
		const response = await app.inject({
			method: "PUT",
			url: "/api/decoders/dec/band",
			payload: { rangesHz: [range], region: "us" },
		})
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({
			decoderId: "dec",
			override: { rangesHz: [range], region: "US" },
			configOverride: null,
			region: { code: "US", source: "decoder" },
			persisted: false,
			bandAssessment: {
				verdict: "in-band",
				rangesHz: [range],
				basis: "override",
				overrideSource: "api",
				captureCenterHz: ELSEWHERE,
				windowHalfWidthHz: 19_200,
			},
		})
		await settle()
		const body = await getBody()
		expect(body).toEqual(wsPayload())
		expect(body).toMatchObject({
			running: true,
			suspended: false,
			bandAssessment: { rangesHz: [range], overrideSource: "api" },
		})

		const cleared = await app.inject({
			method: "DELETE",
			url: "/api/decoders/dec/band",
		})
		expect(cleared.statusCode).toBe(200)
		expect(cleared.json()).toMatchObject({
			override: null,
			bandAssessment: { verdict: "out-of-band", basis: "configured" },
		})
		const again = await app.inject({
			method: "DELETE",
			url: "/api/decoders/dec/band",
		})
		expect(again.statusCode).toBe(200)
	})

	it("reports a region-default assessment with its region", async () => {
		decoder.band = undefined
		registry.register(
			"rtl433",
			config => {
				decoder = new RateDecoder(config.id, caps)
				return decoder
			},
			caps,
		)
		manager.createDecoder({
			id: "ism",
			type: "rtl433",
			enabled: true,
			options: {},
		})
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 433_920_000 })
		await manager.startDecoder("ism", { startMode: "auto" })
		const response = await app.inject("/api/decoders/ism")
		expect(response.json()).toMatchObject({
			bandAssessment: {
				verdict: "in-band",
				basis: "region-default",
				region: { code: "EU", source: "default" },
				rangesHz: [
					{ minHz: 433_050_000, maxHz: 434_790_000 },
					{ minHz: 863_000_000, maxHz: 870_000_000 },
				],
			},
			startMode: "auto",
		})
	})

	it("rejects invalid bodies with 400 INVALID_BAND_OVERRIDE", async () => {
		for (const payload of [
			{},
			{ rangesHz: [{ minHz: 2, maxHz: 1 }] },
			{ targetsHz: [-1] },
			{ region: "XX" },
			{ unknown: true },
			{ rangesHz: [] },
		]) {
			const response = await app.inject({
				method: "PUT",
				url: "/api/decoders/dec/band",
				payload,
			})
			expect(response.statusCode, JSON.stringify(payload)).toBe(400)
			expect(response.json()).toMatchObject({ code: "INVALID_BAND_OVERRIDE" })
		}
	})

	it("404 for an unknown decoder, 409 for an external-input decoder", async () => {
		for (const method of ["GET", "PUT", "DELETE"] as const) {
			const response = await app.inject({
				method,
				url: "/api/decoders/missing/band",
				...(method === "PUT" ? { payload: { targetsHz: [1] } } : {}),
			})
			expect(response.statusCode).toBe(404)
			expect(response.json()).toMatchObject({ code: "DECODER_NOT_FOUND" })
		}
		const external: DecoderCaps = { ...caps, input: "external" }
		registry.register(
			"external-test",
			config => new RateDecoder(config.id, external),
			external,
		)
		manager.createDecoder({
			id: "ext",
			type: "external-test",
			enabled: true,
			options: {},
		})
		const response = await app.inject({
			method: "PUT",
			url: "/api/decoders/ext/band",
			payload: { targetsHz: [1] },
		})
		expect(response.statusCode).toBe(409)
		expect(response.json()).toMatchObject({
			code: "DECODER_BAND_NOT_APPLICABLE",
		})
	})
})
