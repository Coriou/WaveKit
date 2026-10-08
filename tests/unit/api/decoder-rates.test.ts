import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import type { DecoderCaps, DecoderStatus } from "../../../src/decoders/types.js"

describe("decoder rate response contract", () => {
	let app: FastifyInstance
	let status: DecoderStatus
	let caps: DecoderCaps
	const start = vi.fn()
	const stop = vi.fn()

	beforeEach(async () => {
		start.mockReset()
		stop.mockReset()
		status = {
			id: "custom",
			type: "custom",
			running: true,
			health: "idle",
			uptime: 1,
			stats: { bytesIn: 10, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
		caps = {
			input: "audio_pcm",
			output: "text",
			integrationPattern: "pure_consumer",
			preferredSampleRates: [48_000],
		}
		app = Fastify()
		await app.register(decoderRoutes, {
			decoderManager: {
				getAllStatus: () => [status],
				getStatus: () => status,
				startDecoder: start,
				stopDecoder: stop,
			} as unknown as DecoderRoutesOptions["decoderManager"],
			decoderRegistry: {
				getCaps: () => caps,
				getRegisteredTypes: () => ["custom"],
			} as unknown as DecoderRoutesOptions["decoderRegistry"],
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it("reports unknown without interpreting legacy audio preferences or changing lifecycle", async () => {
		const response = await app.inject("/api/decoders")
		expect(response.statusCode).toBe(200)
		expect(response.json()[0]).toMatchObject({
			running: true,
			health: "idle",
			caps: { preferredSampleRates: [48_000] },
			rateAssessment: {
				verdict: "unknown",
				reasonCode: "unknown-requirements",
			},
		})
		expect(start).not.toHaveBeenCalled()
		expect(stop).not.toHaveBeenCalled()
	})

	it("preserves each rate domain and minimum basis through Fastify serialization", async () => {
		status.rateAssessment = {
			verdict: "unusable",
			sourceKind: "iq",
			sourceRateHz: 100_000,
			frontendRateHz: 48_000,
			decoderInputKind: "audio_pcm",
			decoderInputRateHz: 22_050,
			adaptation: "resample",
			reasonCode: "insufficient-sample-rate",
			requiredMinimumHz: 200_000,
			requirementBasis: "implementation",
		}
		const response = await app.inject("/api/decoders/custom")
		expect(response.statusCode).toBe(200)
		expect(response.json().rateAssessment).toEqual(status.rateAssessment)
		expect(response.json().running).toBe(true)
		expect(stop).not.toHaveBeenCalled()
	})

	it("serializes optional declarations including range and discrete sets", async () => {
		caps.rateRequirements = {
			version: 1,
			sourceKind: "iq",
			capture: {
				accepted: [
					{ kind: "range", minHz: 100_000, maxHz: 2_400_000, stepHz: 100_000 },
				],
				preferredHz: [2_400_000],
				minimum: {
					hz: 100_000,
					basis: "implementation",
					evidence: "synthetic-test",
				},
			},
			frontendIq: {
				preferredHz: 48_000,
				accepted: [{ kind: "discrete", valuesHz: [48_000] }],
			},
			decoderInput: {
				kind: "audio_pcm",
				format: "s16le",
				preferredHz: 22_050,
				accepted: [{ kind: "discrete", valuesHz: [22_050] }],
			},
		}
		const types = await app.inject("/api/decoders/types")
		expect(types.statusCode).toBe(200)
		expect(types.json()[0].caps.rateRequirements).toEqual(caps.rateRequirements)
		const instance = await app.inject("/api/decoders/custom")
		expect(instance.json().caps.rateRequirements).toEqual(caps.rateRequirements)
	})
})
