/**
 * Tuner state truthfulness (roadmap item 8): fields the core never commanded
 * or observed are listed in `unknownFields` instead of being implied by their
 * placeholder values (the Pi ran manual 49 dB while state said agc / 0 dB).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

const logger = createLogger({ level: "fatal" })
const PLACEHOLDERS = [
	"gainMode",
	"gain",
	"ppm",
	"agcMode",
	"biasTee",
	"directSampling",
	"offsetTuning",
	"ifGain",
	"tunerIfGain",
	"testMode",
]

function caps(overrides: Partial<SourceCaps> = {}): SourceCaps {
	return {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
		...overrides,
	}
}

let current: SourceCaps
let controller: TunerController

function create(config = {}, initial = caps({ centerFreq: 1_090_000_000 })) {
	current = initial
	const sourceManager = {
		writeToSource: vi.fn(() => true),
		isRtlTcpSource: vi.fn(() => true),
		getCaps: vi.fn(() => current),
		updateSourceCaps: vi.fn((_id: string, updates: Partial<SourceCaps>) => {
			current = { ...current, ...updates }
			return current
		}),
		setTuningCaps: vi.fn(
			(_id: string, tuning: { sampleRate: number; centerFreq?: number }) => {
				current = { ...current, ...tuning }
				return current
			},
		),
	}
	controller = new TunerController(
		logger,
		sourceManager as unknown as SourceManager,
		config,
	)
	controller.initializeSource("rtl", initial)
}

describe("TunerState.unknownFields", () => {
	beforeEach(() => create())

	it("lists every placeholder the core never commanded or observed", () => {
		const state = controller.getState("rtl")!
		expect(state.unknownFields).toEqual(PLACEHOLDERS)
		// Values are unchanged for existing consumers.
		expect(state).toMatchObject({ gainMode: "agc", gain: 0 })
	})

	it("treats the configured centre and rate as declared, not unknown", () => {
		expect(controller.getState("rtl")!.unknownFields).not.toContain("frequency")
		expect(controller.getState("rtl")!.unknownFields).not.toContain(
			"sampleRate",
		)
	})

	it("reports the built-in frequency placeholder as unknown", () => {
		create({}, caps())
		expect(controller.getState("rtl")!.unknownFields).toContain("frequency")
	})

	it("drops a field once the core commands it", async () => {
		await controller.setGainMode("rtl", "manual")
		await controller.setGain("rtl", 490)
		const unknown = controller.getState("rtl")!.unknownFields
		expect(unknown).not.toContain("gainMode")
		expect(unknown).not.toContain("gain")
		expect(unknown).toContain("ppm")
	})

	it("drops a field once a relay client's command is observed", () => {
		controller.applyExternalCommand("rtl", 0x04, 490) // set-gain
		const state = controller.getState("rtl")!
		expect(state.gain).toBe(490)
		expect(state.unknownFields).not.toContain("gain")
		// The relay path infers manual mode from a gain command; the state
		// must not show that inference while also calling it unknown.
		expect(state.gainMode).toBe("manual")
		expect(state.unknownFields).not.toContain("gainMode")
	})

	it("an inferred gain mode is not replayed as a command on reconnect", () => {
		controller.applyExternalCommand("rtl", 0x04, 490)
		const result = controller.synchronizeOnConnect("rtl")
		expect(result.commands).toEqual(["set-gain"])
	})

	it("is unknown again after a reconnect with reconnectPolicy reset", () => {
		create({ reconnectPolicy: "reset" })
		controller.applyExternalCommand("rtl", 0x04, 490)
		controller.synchronizeOnConnect("rtl")
		expect(controller.getState("rtl")!.unknownFields).toEqual(PLACEHOLDERS)
	})

	it("is omitted when every field is known", async () => {
		await controller.configure("rtl", {
			gainMode: "manual",
			gain: 490,
			ppm: 1,
			agcMode: false,
			biasTee: true,
			directSampling: "i",
			offsetTuning: true,
			ifGain: 1,
			tunerIfGain: { stage: 1, gain: 10 },
			testMode: true,
		})
		expect(controller.getState("rtl")).not.toHaveProperty("unknownFields")
	})

	it("survives the REST response schema", async () => {
		const app = Fastify()
		await app.register(tunerRoutes, { tunerController: controller })
		const response = await app.inject("/api/tuner/rtl")
		await app.close()
		expect(response.json().unknownFields).toEqual(PLACEHOLDERS)
	})
})
