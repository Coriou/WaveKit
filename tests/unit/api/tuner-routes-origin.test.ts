// tests/unit/api/tuner-routes-origin.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { TunerCommandOrigin } from "@wavekit/api-types"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

describe("tuner REST writes carry origin rest (spec § 10.3)", () => {
	let app: FastifyInstance
	let origins: Array<TunerCommandOrigin | undefined>

	beforeEach(async () => {
		const caps: SourceCaps = {
			kind: "iq",
			sampleRate: 2_048_000,
			centerFreq: 100_000_000,
			format: "U8_IQ",
			exclusive: false,
		}
		const transport = {
			writeToSource: () => true,
			isRtlTcpSource: () => true,
			updateSourceCaps: (_id: string, updates: Partial<SourceCaps>) =>
				Object.assign(caps, updates),
			getCaps: () => ({ ...caps }),
			setTuningCaps: () => caps,
		}
		const controller = new TunerController(
			createLogger({ level: "fatal" }),
			transport as unknown as SourceManager,
		)
		controller.initializeSource("rtl-1", { ...caps }, "rtl_tcp")
		origins = []
		controller.on(
			"command-sent",
			(_id: string, _c: string, _v: number, origin?: TunerCommandOrigin) =>
				origins.push(origin),
		)
		app = Fastify({ logger: false })
		await app.register(tunerRoutes, {
			tunerController: controller,
		} as Parameters<typeof tunerRoutes>[1])
	})
	afterEach(async () => {
		await app.close()
	})

	it.each([
		["frequency", { hz: 446_000_000 }],
		["gain", { tenthsDb: 300 }],
		["ppm", { ppm: 2 }],
		["test-mode", { enabled: false }],
		["agc", { enabled: true }],
	] as const)("POST /api/tuner/rtl-1/%s", async (path, payload) => {
		const response = await app.inject({
			method: "POST",
			url: `/api/tuner/rtl-1/${path}`,
			payload,
		})
		expect(response.statusCode).toBe(200)
		// WG10 req 2.8: the first frequency also proves the declared rate (origin rest).
		expect(origins).toEqual(path === "frequency" ? ["rest", "rest"] : ["rest"])
	})

	it("PATCH /api/tuner/rtl-1/config tags every command", async () => {
		const response = await app.inject({
			method: "PATCH",
			url: "/api/tuner/rtl-1/config",
			payload: { frequency: 145_000_000, gain: 200 },
		})
		expect(response.statusCode).toBe(200)
		expect(origins.length).toBeGreaterThan(0)
		expect(origins.every(o => o === "rest")).toBe(true)
	})
})
