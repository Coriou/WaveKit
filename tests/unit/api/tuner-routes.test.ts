/**
 * Tuner Routes Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import type { TunerState } from "@wavekit/api-types"
import {
	TunerControlModeError,
	TunerValidationError,
} from "../../../src/core/tuner-controller.js"

function createBaseState(): TunerState {
	return {
		sourceId: "rtl-1",
		frequency: 144_800_000,
		sampleRate: 2_400_000,
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
		commandCount: 0,
	}
}

function createMockTunerController(state: TunerState) {
	return {
		getAllStates: vi.fn().mockReturnValue([state]),
		getState: vi
			.fn()
			.mockImplementation((sourceId: string) =>
				sourceId === state.sourceId ? state : undefined,
			),
		setFrequency: vi
			.fn()
			.mockImplementation((_sourceId: string, hz: number) => {
				state.frequency = hz
			}),
		setControlMode: vi
			.fn()
			.mockImplementation(
				(_sourceId: string, mode: TunerState["controlMode"]) => {
					state.controlMode = mode
				},
			),
		configure: vi.fn().mockResolvedValue(undefined),
	}
}

describe("Tuner Routes", () => {
	let app: FastifyInstance
	let state: TunerState
	let tunerController: ReturnType<typeof createMockTunerController>

	beforeEach(async () => {
		state = createBaseState()
		tunerController = createMockTunerController(state)
		app = Fastify({ logger: false })
		await app.register(tunerRoutes, {
			tunerController: tunerController as unknown as Parameters<
				typeof tunerRoutes
			>[1]["tunerController"],
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it("GET /api/tuner returns tuner states", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/tuner",
		})

		expect(response.statusCode).toBe(200)
		const body = JSON.parse(response.body) as TunerState[]
		expect(body).toHaveLength(1)
		expect(body[0]?.sourceId).toBe("rtl-1")
	})

	it("GET /api/tuner/:sourceId returns 404 when missing", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/api/tuner/unknown",
		})

		expect(response.statusCode).toBe(404)
		const body = JSON.parse(response.body) as { code: string }
		expect(body.code).toBe("TUNER_SOURCE_NOT_FOUND")
	})

	it("POST /api/tuner/:sourceId/frequency updates frequency", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 145_000_000 },
		})

		expect(response.statusCode).toBe(200)
		const body = JSON.parse(response.body) as TunerState
		expect(body.frequency).toBe(145_000_000)
		expect(tunerController.setFrequency).toHaveBeenCalledWith(
			"rtl-1",
			145_000_000,
		)
	})

	it("POST /api/tuner/:sourceId/frequency returns validation errors", async () => {
		const erroringController = {
			...tunerController,
			setFrequency: vi.fn().mockRejectedValue(new TunerValidationError("bad")),
		}

		await app.close()
		app = Fastify({ logger: false })
		await app.register(tunerRoutes, {
			tunerController: erroringController as unknown as Parameters<
				typeof tunerRoutes
			>[1]["tunerController"],
		})

		const response = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/frequency",
			payload: { hz: 1 },
		})

		expect(response.statusCode).toBe(400)
	})

	it("POST /api/tuner/:sourceId/control-mode returns conflict when external", async () => {
		const erroringController = {
			...tunerController,
			setControlMode: vi.fn().mockImplementation(() => {
				throw new TunerControlModeError("rtl-1")
			}),
		}

		await app.close()
		app = Fastify({ logger: false })
		await app.register(tunerRoutes, {
			tunerController: erroringController as unknown as Parameters<
				typeof tunerRoutes
			>[1]["tunerController"],
		})

		const response = await app.inject({
			method: "POST",
			url: "/api/tuner/rtl-1/control-mode",
			payload: { mode: "external" },
		})

		expect(response.statusCode).toBe(409)
	})

	it("PATCH /api/tuner/:sourceId/config calls configure", async () => {
		const response = await app.inject({
			method: "PATCH",
			url: "/api/tuner/rtl-1/config",
			payload: { gainMode: "manual" },
		})

		expect(response.statusCode).toBe(200)
		expect(tunerController.configure).toHaveBeenCalled()
	})
})
