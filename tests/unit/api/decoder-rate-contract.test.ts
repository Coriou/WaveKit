/**
 * Rate model B3: suspension fields survive the Fastify response schemas,
 * REST start/stop semantics while suspended, and the pure rate preview.
 * Contract: docs/CLI-COORDINATION.md "proposed rate-suspension contract (B3)".
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
import {
	FakeSources,
	MIN_HZ,
	RateDecoder,
	iqCaps,
} from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}

let app: FastifyInstance
let manager: DecoderManager
let registry: DecoderRegistry
let sources: FakeSources
let decoder: RateDecoder
let statusEvents: number

async function settle() {
	await vi.advanceTimersByTimeAsync(350)
}
async function getBody() {
	const response = await app.inject("/api/decoders/dec")
	expect(response.statusCode).toBe(200)
	return response.json() as Record<string, unknown>
}
/** What `decoder:status` publishes: the same serializer as the REST body. */
function wsPayload() {
	return JSON.parse(
		JSON.stringify(toApiDecoderInfo(manager.getStatus("dec")!, registry)),
	) as Record<string, unknown>
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	sources = new FakeSources()
	sources.caps.set("rtl", iqCaps(20_000))
	registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => {
			decoder = new RateDecoder(config.id, caps)
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
	statusEvents = 0
	manager.on("decoder:status-changed", () => statusEvents++)
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

describe("REST start/stop while the rate is unusable", () => {
	it("start returns 200 with the full suspension, never 409, and repeats as a no-op", async () => {
		for (let i = 0; i < 2; i++) {
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
				suspension: { reasonCode: "insufficient-sample-rate" },
				sourceId: "rtl",
				rateAssessment: {
					verdict: "unusable",
					requiredMinimumHz: MIN_HZ,
					requirementBasis: "implementation",
					sourceRateHz: 20_000,
				},
			})
			expect(
				new Date((body["suspension"] as { since: string }).since).toISOString(),
			).toBe((body["suspension"] as { since: string }).since)
			expect(body).not.toHaveProperty("lastError")
			expect(body).not.toHaveProperty("transition")
		}
		expect(decoder.starts).toBe(0)
	})

	it("stop on a suspended decoder returns 200 and clears intent", async () => {
		await manager.startDecoder("dec")
		const response = await app.inject({
			method: "POST",
			url: "/api/decoders/dec/stop",
		})
		expect(response.statusCode).toBe(200)
		expect(response.json().decoder).toMatchObject({
			desiredRunning: false,
			suspended: false,
		})
		expect(response.json().decoder).not.toHaveProperty("suspension")
		expect(sources.assignments.has("dec")).toBe(false)
	})
})

describe("decoder:status matches the REST body across suspend and resume", () => {
	it("keeps every suspension field through the response schema", async () => {
		sources.caps.set("rtl", iqCaps(2_400_000))
		await manager.startDecoder("dec")
		expect(await getBody()).toEqual(wsPayload())
		expect(await getBody()).toMatchObject({
			running: true,
			desiredRunning: true,
			suspended: false,
		})

		const before = statusEvents
		sources.setRate("rtl", 20_000)
		await settle()
		expect(statusEvents).toBeGreaterThan(before)
		const suspended = await getBody()
		expect(suspended).toEqual(wsPayload())
		expect(suspended).toMatchObject({
			running: false,
			suspended: true,
			suspension: { reasonCode: "insufficient-sample-rate" },
		})

		sources.setRate("rtl", 2_400_000)
		await settle()
		const resumed = await getBody()
		expect(resumed).toEqual(wsPayload())
		expect(resumed).toMatchObject({ running: true, suspended: false })
		expect(resumed).not.toHaveProperty("suspension")
	})

	it("serializes a transition while a stop is pending", async () => {
		sources.caps.set("rtl", iqCaps(2_400_000))
		await manager.startDecoder("dec")
		decoder.failStop = true
		sources.setRate("rtl", 20_000)
		await settle()
		const body = await getBody()
		expect(body).toEqual(wsPayload())
		expect(body).toMatchObject({
			transition: "suspending",
			suspended: true,
			running: true,
		})
		decoder.failStop = false
	})
})

describe("GET /api/decoders/rate-preview", () => {
	it("assesses every decoder selecting the source without side effects", async () => {
		await manager.startDecoder("dec")
		const statusBefore = JSON.stringify(manager.getStatus("dec"))
		const capsBefore = JSON.stringify([...sources.caps])
		const events = statusEvents
		const response = await app.inject(
			"/api/decoders/rate-preview?sourceId=rtl&sampleRateHz=2400000",
		)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([
			{
				decoderId: "dec",
				assessment: expect.objectContaining({
					verdict: "best",
					sourceRateHz: 2_400_000,
					frontendRateHz: 48_000,
				}),
			},
		])
		await settle()
		expect(JSON.stringify(manager.getStatus("dec"))).toBe(statusBefore)
		expect(JSON.stringify([...sources.caps])).toBe(capsBefore)
		expect(statusEvents).toBe(events)
		expect(decoder.starts).toBe(0)
	})

	it("rejects unknown sources, invalid rates and RTL-SDR gap rates", async () => {
		expect(
			(
				await app.inject(
					"/api/decoders/rate-preview?sourceId=nope&sampleRateHz=2400000",
				)
			).statusCode,
		).toBe(404)
		for (const rate of ["0", "-5", "1.5", "abc"]) {
			expect(
				(
					await app.inject(
						`/api/decoders/rate-preview?sourceId=rtl&sampleRateHz=${rate}`,
					)
				).statusCode,
			).toBe(400)
		}
		expect(
			(
				await app.inject(
					"/api/decoders/rate-preview?sourceId=rtl&sampleRateHz=600000",
				)
			).statusCode,
		).toBe(200)
		sources.rtlTcp.add("rtl")
		const gap = await app.inject(
			"/api/decoders/rate-preview?sourceId=rtl&sampleRateHz=600000",
		)
		expect(gap.statusCode).toBe(400)
		expect(gap.json()).toMatchObject({ code: "VALIDATION_ERROR" })
	})
})
