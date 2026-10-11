// tests/unit/api/decoder-scanner-guards.test.ts
import { PassThrough } from "node:stream"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { decoderRoutes } from "../../../src/api/routes/decoders.js"
import { decoderBandRoutes } from "../../../src/api/routes/decoder-band.js"
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
let app: FastifyInstance
let manager: DecoderManager

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
	const registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => new RateDecoder(config.id, caps),
		caps,
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.createDecoder({
		id: "dmr",
		type: "rate-test",
		enabled: true,
		sourceId: "rtl",
		options: {},
	})
	await manager.createEphemeralDecoder(
		{
			id: "scan-j1-dmr-1",
			type: "rate-test",
			enabled: true,
			sourceId: "rtl",
			options: {},
		},
		{ owner: "scanner", jobId: "j1", input: new PassThrough() },
	)
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

describe("decoder routes on scanner probes (spec § 6.5)", () => {
	it.each([
		["POST", "/api/decoders/scan-j1-dmr-1/start", { pin: true }],
		["POST", "/api/decoders/scan-j1-dmr-1/stop", undefined],
		["POST", "/api/decoders/scan-j1-dmr-1/restart", undefined],
		["PUT", "/api/decoders/scan-j1-dmr-1/band", { targetsHz: [446_100_000] }],
		["DELETE", "/api/decoders/scan-j1-dmr-1/band", undefined],
	] as const)(
		"%s %s is 409 DECODER_OWNED_BY_SCANNER and changes nothing",
		async (method, url, payload) => {
			const response = await app.inject({
				method,
				url,
				...(payload ? { payload } : {}),
			})
			expect(response.statusCode).toBe(409)
			expect(response.json()).toMatchObject({
				code: "DECODER_OWNED_BY_SCANNER",
			})
			expect(manager.getStatus("scan-j1-dmr-1")).toMatchObject({
				running: true,
				owner: "scanner",
			})
		},
	)

	it("GET still lists the probe", async () => {
		const body = (
			await app.inject("/api/decoders/scan-j1-dmr-1")
		).json() as Record<string, unknown>
		expect(body).toMatchObject({
			owner: "scanner",
			ephemeral: true,
			scannerJobId: "j1",
		})
	})
})

describe("decoder routes on a held source (spec § 10.4)", () => {
	it("start and restart of a configured decoder are 409 SOURCE_HELD_BY_SCANNER", async () => {
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		const start = await app.inject({
			method: "POST",
			url: "/api/decoders/dmr/start",
		})
		expect(start.statusCode).toBe(409)
		expect(start.json()).toMatchObject({ code: "SOURCE_HELD_BY_SCANNER" })
		expect(manager.getStatus("dmr")?.desiredRunning).toBe(false)
		await manager.releaseSource("rtl", "j1")
		expect(
			(await app.inject({ method: "POST", url: "/api/decoders/dmr/start" }))
				.statusCode,
		).toBe(200)
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		const restart = await app.inject({
			method: "POST",
			url: "/api/decoders/dmr/restart",
		})
		expect(restart.statusCode).toBe(409)
		expect(restart.json()).toMatchObject({ code: "SOURCE_HELD_BY_SCANNER" })
		expect(manager.getStatus("dmr")).toMatchObject({
			desiredRunning: true,
			suspended: true,
		})
	})
})
