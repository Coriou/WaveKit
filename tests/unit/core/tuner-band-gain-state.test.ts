/**
 * TunerState.bandGain: reported only while a band gain is confirmed on the tuner. Set after
 * the band's writes succeed; cleared by a later gain, gain mode or frequency write, a relay
 * client, a control hand-over or the gain becoming unknown. IF gain and gain index writes set
 * other gain stages: they keep both the band gain and the saved pre-band gain.
 */
import { describe, expect, it, vi } from "vitest"
import pino from "pino"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { BandGainSettingsService } from "../../../src/core/band-gain.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

const logger = pino({ level: "silent" })
const SET_GAIN = 0x04
const ISM = 868_100_000
const OTHER_ISM = 915_000_000
const UHF = 455_500_000
const REST = { origin: "rest" as const }
const SCANNER = { origin: "scanner" as const }

function setup(applyToMyTuning: boolean, steps: number[] | null = null) {
	let failWrites = false
	const sourceManager = {
		assertTunerCommandActive: () => {},
		writeToSource: vi.fn(() => {
			if (failWrites) throw new Error("socket closed")
			return true
		}),
		isRtlTcpSource: () => true,
		updateSourceCaps: vi.fn(),
	}
	const controller = new TunerController(
		logger,
		sourceManager as unknown as SourceManager,
	)
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
		centerFreq: UHF,
	}
	controller.initializeSource("rtl", caps)
	controller.setBandGain(
		new BandGainSettingsService({
			stateDir: "/unused",
			config: {
				applyToMyTuning,
				entries: [
					{
						minHz: 863_000_000,
						maxHz: 870_000_000,
						gain: 400,
						label: "ISM 868",
					},
					{ minHz: 902_000_000, maxHz: 928_000_000, gain: 380 },
				],
			},
			logger,
			fs: {
				readFile: () => Promise.reject(new Error("unused")),
				atomicWrite: () => Promise.resolve(),
			},
		}),
	)
	if (steps !== null) controller.setGainStepsResolver(() => steps)
	return {
		controller,
		failNextWrites: (on: boolean) => {
			failWrites = on
		},
	}
}

async function manual(controller: TunerController, gain: number) {
	await controller.setGainMode("rtl", "manual", REST)
	await controller.setGain("rtl", gain, REST)
}

describe("TunerState.bandGain", () => {
	it("is absent until a retune applies the band gain, even with apply to my tuning on", async () => {
		const { controller } = setup(true)
		await manual(controller, 496)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
		await controller.setFrequency("rtl", ISM, REST)
		expect(controller.getState("rtl")?.bandGain).toEqual({
			tenthsDb: 400,
			label: "ISM 868",
			owner: "user",
		})
	})

	it("reports the snapped value written, not the configured one", async () => {
		const { controller } = setup(true, [0, 386, 402, 496])
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, REST)
		expect(controller.getState("rtl")).toMatchObject({
			gain: 402,
			bandGain: { tenthsDb: 402, owner: "user" },
		})
	})

	it("never appears with apply to my tuning off", async () => {
		const { controller } = setup(false)
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, REST)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("an operator gain write clears it", async () => {
		const { controller } = setup(true)
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.setGain("rtl", 400, REST)
		// Same value, but the operator now owns the gain.
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("switching to AGC clears it", async () => {
		const { controller } = setup(true)
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.setGainMode("rtl", "agc", REST)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("a retune out of the bands clears it, and a retune into another band replaces it", async () => {
		const { controller } = setup(true)
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.setFrequency("rtl", OTHER_ISM, REST)
		expect(controller.getState("rtl")?.bandGain).toEqual({
			tenthsDb: 380,
			owner: "user",
		})
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")).toMatchObject({ gain: 496 })
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("a failed band gain write leaves it absent", async () => {
		const { controller, failNextWrites } = setup(true)
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.setFrequency("rtl", UHF, REST)
		const spy = vi.spyOn(controller, "setGain").mockImplementation(() => {
			failNextWrites(true)
			return Promise.reject(new Error("socket closed"))
		})
		await controller.setFrequency("rtl", ISM, REST)
		spy.mockRestore()
		failNextWrites(false)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("a relay client command or a control hand-over clears it", async () => {
		const { controller } = setup(true)
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, REST)
		controller.applyExternalCommand("rtl", SET_GAIN, 400)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
		controller.setControlMode("rtl", "internal")
		await controller.setFrequency("rtl", UHF, REST)
		await controller.setFrequency("rtl", ISM, REST)
		expect(controller.getState("rtl")?.bandGain).toBeDefined()
		controller.setControlMode("rtl", "external")
		controller.setControlMode("rtl", "internal")
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("a relay gain choice supersedes the saved pre-band gain", async () => {
		const { controller } = setup(true)
		await manual(controller, 100)
		await controller.setFrequency("rtl", ISM, REST)
		expect(controller.getState("rtl")?.gain).toBe(400)
		controller.applyExternalCommand("rtl", SET_GAIN, 300)
		controller.setControlMode("rtl", "internal")
		await controller.setFrequency("rtl", UHF, REST)
		// Leaving the band keeps the relay's newer 30.0 dB, not the older 10.0 dB.
		expect(controller.getState("rtl")?.gain).toBe(300)
	})

	it.each([
		["SET_IF_GAIN", 0x06, 30],
		["SET_TUNER_IF_GAIN", 0x0f, (1 << 16) | 30],
		["SET_TUNER_GAIN_INDEX", 0x0d, 12],
	])(
		"a relay %s sets another gain stage: the saved AGC mode still comes back",
		async (_name, command, value) => {
			const { controller } = setup(true)
			await controller.setGainMode("rtl", "agc", REST)
			await controller.setFrequency("rtl", ISM, REST)
			controller.applyExternalCommand("rtl", command, value)
			controller.setControlMode("rtl", "internal")
			await controller.setFrequency("rtl", UHF, REST)
			expect(controller.getState("rtl")?.gainMode).toBe("agc")
		},
	)

	it.each([
		["SET_GAIN_MODE", 0x03, 1],
		["SET_AGC_MODE", 0x08, 1],
	])(
		"a relay %s is a gain choice: the saved pre-band gain is dropped",
		async (_name, command, value) => {
			const { controller } = setup(true)
			await manual(controller, 100)
			await controller.setFrequency("rtl", ISM, REST)
			controller.applyExternalCommand("rtl", command, value)
			controller.setControlMode("rtl", "internal")
			await controller.setFrequency("rtl", UHF, REST)
			// No restore write: the older 10.0 dB never comes back.
			expect(controller.getState("rtl")?.gain).toBe(400)
		},
	)

	it.each([
		["setIfGain", (c: TunerController) => c.setIfGain("rtl", 30, REST)],
		[
			"setTunerGainIndex",
			(c: TunerController) => c.setTunerGainIndex("rtl", 12, REST),
		],
		[
			"setTunerIfGain",
			(c: TunerController) => c.setTunerIfGain("rtl", 1, 30, REST),
		],
	])(
		"a REST %s sets another gain stage: the band gain stays reported and the saved gain comes back",
		async (_name, write) => {
			const { controller } = setup(true)
			await manual(controller, 100)
			await controller.setFrequency("rtl", ISM, REST)
			await write(controller)
			// The tuner gain and mode did not change, so the confirmed band gain stays.
			expect(controller.getState("rtl")?.bandGain).toEqual({
				tenthsDb: 400,
				label: "ISM 868",
				owner: "user",
			})
			await controller.setFrequency("rtl", UHF, REST)
			expect(controller.getState("rtl")).toMatchObject({
				gainMode: "manual",
				gain: 100,
			})
			expect(controller.getState("rtl")?.bandGain).toBeUndefined()
		},
	)

	it("noteBandGainApplied (scanner) is ignored unless the tuner shows that manual gain at that frequency", async () => {
		const { controller } = setup(false)
		await manual(controller, 496)
		await controller.setFrequency("rtl", ISM, SCANNER)
		// Wrong frequency: ignored.
		controller.noteBandGainApplied("rtl", 496, "scanner", OTHER_ISM)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
		// Wrong gain: recorded then dropped by the confirmation.
		controller.noteBandGainApplied("rtl", 400, "scanner", ISM)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
		await controller.setGain("rtl", 400, SCANNER)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
		controller.noteBandGainApplied("rtl", 400, "scanner", ISM)
		expect(controller.getState("rtl")?.bandGain).toEqual({
			tenthsDb: 400,
			label: "ISM 868",
			owner: "scanner",
		})
		// The scanner's restore writes frequency and gain: cleared.
		await controller.setFrequency("rtl", UHF, SCANNER)
		expect(controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("emits state-changed with the field when it is set", async () => {
		const { controller } = setup(true)
		await manual(controller, 496)
		const seen: unknown[] = []
		controller.on("state-changed", (_id, state) => seen.push(state.bandGain))
		await controller.setFrequency("rtl", ISM, REST)
		expect(seen.at(-1)).toEqual({
			tenthsDb: 400,
			label: "ISM 868",
			owner: "user",
		})
	})
})
