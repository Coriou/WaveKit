import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import {
	TunerController,
	TUNER_REST_COMMAND_POLICY,
} from "../../../src/core/tuner-controller.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const apps: FastifyInstance[] = []
async function setup() {
	const write = vi.fn((_id: string, _buffer: Buffer) => true)
	const source = {
		assertTunerCommandActive: () => {},
		writeToSource: write,
		isRtlTcpSource: () => true,
		updateSourceCaps: vi.fn(),
		setTuningCaps: vi.fn(),
	}
	const tuner = new TunerController(
		createLogger({ level: "fatal" }),
		source as unknown as SourceManager,
	)
	tuner.initializeSource("test", {
		kind: "iq",
		format: "U8_IQ",
		sampleRate: 2400000,
		exclusive: false,
	})
	const app = Fastify()
	apps.push(app)
	await app.register(tunerRoutes, { tunerController: tuner })
	return { app, write }
}
afterEach(async () => {
	for (const app of apps.splice(0)) await app.close()
})
describe("actual Fastify tuner REST enum/boolean policy parity", () => {
	it.each([
		[
			"gain-mode",
			"mode",
			"gainMode",
			["manual", "agc"],
			["off", "MANUAL", "", 1, null],
		],
		[
			"direct-sampling",
			"mode",
			"directSampling",
			["off", "i", "q"],
			["agc", "I", "", 1, null],
		],
	] as const)(
		"%s and bulk update consume the shared enum without changing AJV behavior",
		async (route, field, id, allowed, denied) => {
			const { app, write } = await setup()
			const row = TUNER_REST_COMMAND_POLICY.find(entry => entry.id === id)!
			expect(row.rule).toEqual({ kind: "enum", values: allowed })
			for (const value of allowed) {
				expect(
					(
						await app.inject({
							method: "POST",
							url: `/api/tuner/test/${route}`,
							payload: { [field]: value },
						})
					).statusCode,
				).toBe(200)
				expect(
					(
						await app.inject({
							method: "PATCH",
							url: "/api/tuner/test/config",
							payload: { [id]: value },
						})
					).statusCode,
				).toBe(200)
			}
			for (const value of denied) {
				const count = write.mock.calls.length
				for (const [method, url, payload] of [
					["POST", `/api/tuner/test/${route}`, { [field]: value }],
					["PATCH", "/api/tuner/test/config", { [id]: value }],
				] as const)
					expect((await app.inject({ method, url, payload })).statusCode).toBe(
						400,
					)
				expect(write).toHaveBeenCalledTimes(count)
			}
		},
	)
	it.each([
		["test-mode", "testMode", 7],
		["agc", "agcMode", 8],
		["offset-tuning", "offsetTuning", 10],
		["bias-tee", "biasTee", 14],
	] as const)(
		"%s preserves existing boolean coercion and rejects incompatible inputs",
		async (route, id, opcode) => {
			const { app, write } = await setup()
			expect(TUNER_REST_COMMAND_POLICY[opcode - 1]?.rule).toEqual({
				kind: "boolean",
			})
			for (const [value, expected] of [
				[true, true],
				[false, false],
				["true", true],
				["false", false],
				[1, true],
				[0, false],
				[null, false],
			] as const) {
				const response = await app.inject({
					method: "POST",
					url: `/api/tuner/test/${route}`,
					payload: { enabled: value, extra: "removed by current AJV" },
				})
				expect(response.statusCode).toBe(200)
				expect(response.json<Record<string, unknown>>()[id]).toBe(expected)
				const updated = await app.inject({
					method: "PATCH",
					url: "/api/tuner/test/config",
					payload: { [id]: value },
				})
				expect(updated.statusCode).toBe(200)
				expect(updated.json<Record<string, unknown>>()[id]).toBe(expected)
			}
			for (const value of ["TRUE", "yes", 2, {}, []]) {
				const count = write.mock.calls.length
				expect(
					(
						await app.inject({
							method: "POST",
							url: `/api/tuner/test/${route}`,
							payload: { enabled: value },
						})
					).statusCode,
				).toBe(400)
				expect(
					(
						await app.inject({
							method: "PATCH",
							url: "/api/tuner/test/config",
							payload: { [id]: value },
						})
					).statusCode,
				).toBe(400)
				expect(write).toHaveBeenCalledTimes(count)
			}
		},
	)
	it("numeric route schemas remain integer-only while setters enforce existing bounds", async () => {
		const { app, write } = await setup()
		for (const [value, code] of [
			[24000000, 200],
			[1900000000, 200],
			[23999999, 400],
			[1900000001, 400],
			[24000000.5, 400],
		] as const) {
			const result = await app.inject({
				method: "POST",
				url: "/api/tuner/test/frequency",
				payload: { hz: value },
			})
			expect(result.statusCode).toBe(code)
			if (value === 23999999 || value === 1900000001)
				expect(result.json<{ code: string }>().code).toBe(
					"TUNER_VALIDATION_ERROR",
				)
		}
		// WG10 req 2.8: the first accepted frequency also proves the declared rate once.
		expect(write).toHaveBeenCalledTimes(3)
	})
})
