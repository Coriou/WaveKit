/**
 * Band-aware suspension contract (roadmap item 8): bandAssessment and the
 * "frequency-out-of-band" suspension reason survive the Fastify response
 * schemas, and `decoder:status` (same serializer) equals the REST body.
 * Contract: docs/CLI-COORDINATION.md "proposed contracts for roadmap item 8".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { decoderRoutes } from "../../../src/api/routes/decoders.js"
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
})
afterEach(async () => {
	await app.close()
	await manager.destroy()
	vi.useRealTimers()
})

describe("band suspension over REST", () => {
	it("start out of band returns 200 with the band reason and assessment", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/decoders/dec/start",
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
