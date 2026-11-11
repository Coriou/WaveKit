/**
 * Assert moving the centre back to the operator's held one re-applies its band gain under the
 * operator retune's rule ("apply to my tuning"), instead of only dropping the band gain record.
 */
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
	BandGainSettingsService,
	type BandGainFs,
} from "../../../src/core/band-gain.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"

const logger = pino({ level: "silent" })
const SET_FREQUENCY = 0x01
const SET_GAIN = 0x04
const ISM = 868_100_000
const UHF = 455_500_000
const REST = { origin: "rest" as const }

const settle = async () => {
	for (let i = 0; i < 5; i++)
		await new Promise<void>(resolve => setImmediate(resolve))
}

function memoryFs(): BandGainFs {
	const files = new Map<string, string>()
	return {
		readFile: path => {
			const text = files.get(path)
			return text === undefined
				? Promise.reject(
						Object.assign(new Error("missing"), { code: "ENOENT" }),
					)
				: Promise.resolve(Buffer.from(text))
		},
		atomicWrite: (path, data) => {
			files.set(path, data)
			return Promise.resolve()
		},
	}
}

async function setup(applyToMyTuning: boolean) {
	const writes: [number, number][] = []
	const sourceManager = {
		assertTunerCommandActive: () => {},
		writeToSource: vi.fn((_id: string, payload: Buffer) => {
			writes.push([payload.readUInt8(0), payload.readUInt32BE(1)])
			return true
		}),
		isRtlTcpSource: () => true,
		updateSourceCaps: vi.fn(),
		getCaps: () => undefined,
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
	const bandGain = new BandGainSettingsService({
		stateDir: "/state",
		config: {
			applyToMyTuning,
			entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 }],
		},
		logger,
		fs: memoryFs(),
	})
	await bandGain.load()
	controller.setBandGain(bandGain)
	return { controller, writes }
}

describe("assert and the band gain (Main gate minor 4)", () => {
	it("re-applies the band gain when assert moves the centre back to the operator's", async () => {
		const { controller, writes } = await setup(true)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 200, REST)
		await controller.setFrequency("rtl", ISM, REST)
		expect(controller.getState("rtl")!.bandGain).toMatchObject({
			tenthsDb: 297,
		})
		// A scanner hop out of the band (not accepted): the band gain record goes.
		await controller.setFrequency("rtl", UHF, {
			origin: "scanner",
			accept: false,
		})
		await controller.setGain("rtl", 150, { origin: "scanner", accept: false })
		expect(controller.getState("rtl")!.bandGain).toBeUndefined()
		writes.length = 0
		// A new connection: assert writes the operator's held centre, and its band gain follows.
		controller.synchronizeOnConnect("rtl")
		await settle()
		expect(writes).toContainEqual([SET_FREQUENCY, ISM])
		expect(writes).toContainEqual([SET_GAIN, 297])
		expect(controller.getState("rtl")!).toMatchObject({
			frequency: ISM,
			gain: 297,
			bandGain: { tenthsDb: 297 },
		})
	})

	it("without apply-to-my-tuning leaves the gain alone", async () => {
		const { controller, writes } = await setup(false)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 200, REST)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.setFrequency("rtl", UHF, {
			origin: "scanner",
			accept: false,
		})
		writes.length = 0
		controller.synchronizeOnConnect("rtl")
		await settle()
		expect(writes).toContainEqual([SET_FREQUENCY, ISM])
		// Only the operator's accepted gain is replayed; no band gain.
		expect(writes.filter(([cmd]) => cmd === SET_GAIN)).toEqual([
			[SET_GAIN, 200],
		])
		expect(controller.getState("rtl")!.bandGain).toBeUndefined()
	})
})
