/**
 * GET /api/tuner and GET /api/tuner/:sourceId keep TunerState.proof through Fastify's response
 * serialisation (a property the response schema does not name is dropped silently).
 */
import Fastify, { type FastifyInstance } from "fastify"
import type { TunerState } from "@wavekit/api-types"
import { afterEach, describe, expect, it } from "vitest"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"

type Options = Parameters<typeof tunerRoutes>[1]

function state(): TunerState {
	return {
		sourceId: "rtl-1",
		frequency: 100_000_000,
		sampleRate: 2_048_000,
		gainMode: "agc",
		gain: 0,
		ppm: 0,
		agcMode: true,
		biasTee: false,
		directSampling: "off",
		offsetTuning: false,
		ifGain: 0,
		tunerIfGain: null,
		testMode: false,
		controlMode: "internal",
		commandCount: 2,
		proof: {
			frequency: {
				state: "unverified",
				writer: null,
				session: null,
				reason: "untracked-retune",
			},
			sampleRate: { state: "commanded", writer: "assert", session: 3 },
			assertFights: 4,
		},
	}
}

let app: FastifyInstance | null = null
afterEach(async () => {
	await app?.close()
	app = null
})

async function build(s: TunerState) {
	const controller = {
		getAllStates: () => [s],
		getState: (id: string) => (id === s.sourceId ? s : undefined),
	}
	app = Fastify({ logger: false })
	await app.register(tunerRoutes, {
		tunerController: controller as unknown as Options["tunerController"],
		bandGain: null,
	})
	return app
}

describe("GET /api/tuner proof serialisation", () => {
	it("keeps every proof field, null writer and session included, on both routes", async () => {
		const s = state()
		const a = await build(s)
		const all = await a.inject({ method: "GET", url: "/api/tuner" })
		expect(all.statusCode).toBe(200)
		expect((JSON.parse(all.body) as TunerState[])[0]?.proof).toEqual(s.proof)
		const one = await a.inject({ method: "GET", url: "/api/tuner/rtl-1" })
		expect(one.statusCode).toBe(200)
		expect((JSON.parse(one.body) as TunerState).proof).toEqual(s.proof)
	})

	it("omits proof when the core has no ledger", async () => {
		const s = state()
		delete s.proof
		const a = await build(s)
		const one = await a.inject({ method: "GET", url: "/api/tuner/rtl-1" })
		expect(JSON.parse(one.body) as TunerState).not.toHaveProperty("proof")
	})
})
