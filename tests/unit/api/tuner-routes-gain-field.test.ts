/**
 * POST /api/tuner/:sourceId/gain takes {"gain"} (tenths, as GET reports it) with {"tenthsDb"}
 * as a deprecated alias; every tuner 400 names the expected fields and units. Also the
 * per-band gain settings route GET/PUT /api/tuner-band-gain.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import type { BandGainSettingsView, TunerState } from "@wavekit/api-types"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import { TunerValidationError } from "../../../src/core/tuner-controller.js"
import {
	BandGainSettingsService,
	type BandGainFs,
} from "../../../src/core/band-gain.js"
import { BandGainConfigSchema } from "../../../src/core/band-gain-schema.js"

type Options = Parameters<typeof tunerRoutes>[1]

function baseState(): TunerState {
	return {
		sourceId: "rtl-1",
		frequency: 144_800_000,
		sampleRate: 2_400_000,
		gainMode: "manual",
		gain: 296,
		ppm: 0,
		agcMode: false,
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

function memoryFs() {
	const files = new Map<string, string>()
	const fs: BandGainFs = {
		readFile: () =>
			Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })),
		atomicWrite: (path, data) => {
			files.set(path, data)
			return Promise.resolve()
		},
	}
	return { fs, files }
}

let app: FastifyInstance | null = null
afterEach(async () => {
	await app?.close()
	app = null
})

async function build(bandGain: BandGainSettingsService | null = null) {
	const state = baseState()
	const controller = {
		getAllStates: () => [state],
		getState: (id: string) => (id === state.sourceId ? state : undefined),
		proveSampleRateForFrequency: vi.fn().mockResolvedValue(false),
		setFrequency: vi.fn().mockResolvedValue(undefined),
		setGain: vi.fn((_id: string, tenths: number) => {
			if (tenths > 500)
				return Promise.reject(
					new TunerValidationError(
						`gain out of range: ${tenths} (expected 0-500)`,
					),
				)
			state.gain = tenths
			return Promise.resolve()
		}),
		configure: vi.fn().mockResolvedValue(undefined),
	}
	app = Fastify({ logger: false })
	// The parent handler sees every error the tuner routes do not answer themselves.
	app.setErrorHandler((_err, _req, reply) =>
		reply.status(599).send({ parent: true }),
	)
	await app.register(tunerRoutes, {
		tunerController: controller as unknown as Options["tunerController"],
		bandGain,
	})
	return { app, controller, state }
}

const post = (a: FastifyInstance, url: string, payload: unknown) =>
	a.inject({ method: "POST", url, payload: payload as object })

describe("POST /api/tuner/:sourceId/gain field names", () => {
	it('accepts {"gain"} in tenths, the same name and unit as GET', async () => {
		const { app: a, controller } = await build()
		const res = await post(a, "/api/tuner/rtl-1/gain", { gain: 372 })
		expect(res.statusCode).toBe(200)
		expect(controller.setGain).toHaveBeenCalledWith("rtl-1", 372, {
			origin: "rest",
		})
		const get = await a.inject({ method: "GET", url: "/api/tuner/rtl-1" })
		expect((JSON.parse(get.body) as TunerState).gain).toBe(372)
	})

	it('keeps {"tenthsDb"} as a deprecated alias; both equal is fine', async () => {
		const { app: a, controller } = await build()
		expect(
			(await post(a, "/api/tuner/rtl-1/gain", { tenthsDb: 297 })).statusCode,
		).toBe(200)
		expect(
			(await post(a, "/api/tuner/rtl-1/gain", { gain: 297, tenthsDb: 297 }))
				.statusCode,
		).toBe(200)
		expect(controller.setGain).toHaveBeenNthCalledWith(1, "rtl-1", 297, {
			origin: "rest",
		})
		expect(controller.setGain).toHaveBeenCalledTimes(2)
	})

	it("both present and different, or neither, is a 400 naming gain, tenthsDb and the unit", async () => {
		const { app: a, controller } = await build()
		for (const body of [{ gain: 297, tenthsDb: 372 }, {}, { gainDb: 30 }]) {
			const res = await post(a, "/api/tuner/rtl-1/gain", body)
			expect(res.statusCode).toBe(400)
			const message = (JSON.parse(res.body) as { message: string }).message
			expect(message).toContain('"gain"')
			expect(message).toContain('"tenthsDb"')
			expect(message).toContain("tenths of a dB")
		}
		expect(controller.setGain).not.toHaveBeenCalled()
	})

	it("a schema 400 names the expected field and unit and never echoes the value", async () => {
		const { app: a } = await build()
		const res = await post(a, "/api/tuner/rtl-1/gain", { gain: "loud-ECHO" })
		expect(res.statusCode).toBe(400)
		const body = JSON.parse(res.body) as { code: string; message: string }
		expect(body.code).toBe("VALIDATION_ERROR")
		expect(body.message).toContain('"gain"')
		expect(body.message).toContain("tenths of a dB")
		expect(body.message).not.toContain("loud-ECHO")

		const freq = await post(a, "/api/tuner/rtl-1/frequency", { hz: "abc" })
		expect(freq.statusCode).toBe(400)
		const fm = (JSON.parse(freq.body) as { message: string }).message
		expect(fm).toContain('"hz"')
		expect(fm).toContain("Hz")

		const mode = await post(a, "/api/tuner/rtl-1/gain-mode", { mode: "x" })
		expect((JSON.parse(mode.body) as { message: string }).message).toContain(
			'"manual" | "agc"',
		)
	})

	it("a controller 400 also names the expected field and unit", async () => {
		const { app: a } = await build()
		const res = await post(a, "/api/tuner/rtl-1/gain", { gain: 900 })
		expect(res.statusCode).toBe(400)
		const message = (JSON.parse(res.body) as { message: string }).message
		expect(message).toContain("gain out of range")
		expect(message).toContain("tenths of a dB")
	})
})

describe("GET/PUT /api/tuner-band-gain", () => {
	function service() {
		const m = memoryFs()
		const svc = new BandGainSettingsService({
			stateDir: "/state",
			config: BandGainConfigSchema.parse({}),
			logger: pino({ level: "silent" }),
			fs: m.fs,
		})
		return { svc, files: m.files }
	}

	it("is not mounted without settings", async () => {
		const { app: a } = await build(null)
		const res = await a.inject({ method: "GET", url: "/api/tuner-band-gain" })
		expect(res.statusCode).toBe(404)
	})

	it("GET shows the configured table; PUT replaces and persists it", async () => {
		const { svc, files } = service()
		const { app: a } = await build(svc)
		const got = JSON.parse(
			(await a.inject({ method: "GET", url: "/api/tuner-band-gain" })).body,
		) as BandGainSettingsView
		expect(got.provenance).toBe("config")
		expect(got.settings.applyToMyTuning).toBe(false)
		expect(got.limits.maxEntries).toBe(32)
		const next = {
			applyToMyTuning: true,
			entries: [
				{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297, label: "ISM" },
			],
		}
		const put = await a.inject({
			method: "PUT",
			url: "/api/tuner-band-gain",
			payload: next,
		})
		expect(put.statusCode).toBe(200)
		const view = JSON.parse(put.body) as BandGainSettingsView
		expect(view).toMatchObject({ provenance: "runtime", settings: next })
		expect(files.size).toBe(1)
		expect(svc.gainAt(868_000_000)).toBe(297)
	})

	it("an invalid PUT is a 400 naming fields and units; settings unchanged", async () => {
		const { svc } = service()
		const { app: a } = await build(svc)
		for (const payload of [
			{
				applyToMyTuning: true,
				entries: [
					{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
					{ minHz: 869_000_000, maxHz: 875_000_000, gain: 297 },
				],
			},
			{ applyToMyTuning: "yes", entries: [] },
			[1, 2],
		]) {
			const res = await a.inject({
				method: "PUT",
				url: "/api/tuner-band-gain",
				payload: payload as object,
			})
			expect(res.statusCode).toBe(400)
			const message = (JSON.parse(res.body) as { message: string }).message
			expect(message).toContain('"minHz"')
			expect(message).toContain("tenths of a dB")
		}
		expect(svc.view().provenance).toBe("config")
	})

	it("an unexpected error goes to the parent error handler", async () => {
		const { svc } = service()
		vi.spyOn(svc, "put").mockRejectedValue(new Error("boom"))
		const { app: a } = await build(svc)
		const res = await a.inject({
			method: "PUT",
			url: "/api/tuner-band-gain",
			payload: { applyToMyTuning: false, entries: [] },
		})
		expect(res.statusCode).toBe(599)
	})
})
