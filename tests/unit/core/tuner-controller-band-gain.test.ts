/**
 * Per-band gain on the controller: an operator retune changes gain only with
 * "apply to my tuning"; then leaving the bands puts the operator's exact gain back.
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
const SET_GAIN_MODE = 0x03
const SET_GAIN = 0x04
const ISM = 868_100_000
const OTHER_ISM = 915_000_000
const UHF = 455_500_000

function setup(applyToMyTuning: boolean, steps: number[] | null = null) {
	const writes: [number, number][] = []
	const sourceManager = {
		assertTunerCommandActive: () => {},
		writeToSource: vi.fn((_id: string, payload: Buffer) => {
			writes.push([payload.readUInt8(0), payload.readUInt32BE(1)])
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
	const bandGain = new BandGainSettingsService({
		stateDir: "/unused",
		config: {
			applyToMyTuning,
			entries: [
				{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
				{ minHz: 902_000_000, maxHz: 928_000_000, gain: 380 },
				{ minHz: 1_085_000_000, maxHz: 1_095_000_000, gain: "keep" },
			],
		},
		logger,
		fs: {
			readFile: () => Promise.reject(new Error("unused")),
			atomicWrite: () => Promise.resolve(),
		},
	})
	controller.setBandGain(bandGain)
	if (steps !== null) controller.setGainStepsResolver(() => steps)
	const gainWrites = (from = 0) =>
		writes
			.filter(([cmd]) => cmd === SET_GAIN || cmd === SET_GAIN_MODE)
			.slice(from)
	return { controller, writes, gainWrites }
}

const REST = { origin: "rest" as const }

describe("TunerController per-band gain", () => {
	it("bandGainFor answers the band gain, null for keep or no entry, snapped to known steps", () => {
		const { controller } = setup(false, [0, 297, 372, 386, 496])
		expect(controller.bandGainFor("rtl", ISM)).toBe(297)
		// 380 snaps to the nearest step 386.
		expect(controller.bandGainFor("rtl", OTHER_ISM)).toBe(386)
		expect(controller.bandGainFor("rtl", 1_090_000_000)).toBeNull()
		expect(controller.bandGainFor("rtl", UHF)).toBeNull()
	})

	it("bandGainFor is null without settings and when the step resolver throws", () => {
		const { controller } = setup(false)
		controller.setGainStepsResolver(() => {
			throw new Error("boom")
		})
		expect(controller.bandGainFor("rtl", ISM)).toBeNull()
		controller.setBandGain(null)
		controller.setGainStepsResolver(null)
		expect(controller.bandGainFor("rtl", ISM)).toBeNull()
	})

	it("apply to my tuning off (default): a manual retune never changes gain", async () => {
		const { controller, gainWrites } = setup(false)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 496, REST)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.configure("rtl", { frequency: OTHER_ISM }, REST)
		await controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites().length).toBe(2)
		expect(controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 496,
		})
	})

	it("apply to my tuning on: band gains apply, and leaving the bands restores the exact manual gain", async () => {
		const { controller, gainWrites } = setup(true)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 496, REST)
		const mark = gainWrites().length
		await controller.setFrequency("rtl", ISM, REST)
		expect(controller.getState("rtl")).toMatchObject({ gain: 297 })
		await controller.configure("rtl", { frequency: OTHER_ISM }, REST)
		expect(controller.getState("rtl")).toMatchObject({ gain: 380 })
		await controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites(mark)).toEqual([
			[SET_GAIN, 297],
			[SET_GAIN, 380],
			[SET_GAIN, 496],
		])
		expect(controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 496,
		})
		// Outside the bands with nothing saved: no gain write.
		const again = gainWrites().length
		await controller.setFrequency("rtl", UHF + 25_000, REST)
		expect(gainWrites(again)).toEqual([])
	})

	it("apply to my tuning on: an AGC operator gets AGC back, gain first and mode last", async () => {
		const { controller, gainWrites } = setup(true)
		await controller.setGain("rtl", 120, REST)
		await controller.setGainMode("rtl", "agc", REST)
		let mark = gainWrites().length
		await controller.setFrequency("rtl", ISM, REST)
		expect(gainWrites(mark)).toEqual([
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 297],
		])
		mark = gainWrites().length
		await controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites(mark)).toEqual([
			[SET_GAIN, 120],
			[SET_GAIN_MODE, 0],
		])
		expect(controller.getState("rtl")).toMatchObject({
			gainMode: "agc",
			gain: 120,
		})
	})

	it("apply to my tuning on: an AGC operator whose gain was never set gets AGC back (mode only)", async () => {
		const { controller, gainWrites } = setup(true)
		await controller.setGainMode("rtl", "agc", REST)
		await controller.setFrequency("rtl", ISM, REST)
		const mark = gainWrites().length
		await controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites(mark)).toEqual([[SET_GAIN_MODE, 0]])
		expect(controller.getState("rtl")!.gainMode).toBe("agc")
	})

	it("an explicit operator gain inside a band supersedes the saved gain", async () => {
		const { controller, gainWrites } = setup(true)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 496, REST)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.setGain("rtl", 250, REST)
		const mark = gainWrites().length
		await controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites(mark)).toEqual([])
		expect(controller.getState("rtl")!.gain).toBe(250)
	})

	it("scanner-origin retunes never apply the operator band gain", async () => {
		const { controller, gainWrites } = setup(true)
		await controller.setFrequency("rtl", ISM, { origin: "scanner" })
		expect(gainWrites()).toEqual([])
	})

	it("a failed restore write keeps the saved gain; the next out-of-band retune retries it", async () => {
		const { controller, writes, gainWrites } = setup(true)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 496, REST)
		await controller.setFrequency("rtl", ISM, REST)
		const sm = (
			controller as unknown as {
				sourceManager: { writeToSource: ReturnType<typeof vi.fn> }
			}
		).sourceManager
		const healthy = sm.writeToSource.getMockImplementation()
		sm.writeToSource.mockImplementation((_id: string, payload: Buffer) => {
			if (payload.readUInt8(0) === SET_GAIN) throw new Error("socket closed")
			writes.push([payload.readUInt8(0), payload.readUInt32BE(1)])
			return true
		})
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")!.gain).toBe(297)
		sm.writeToSource.mockImplementation(healthy!)
		const mark = gainWrites().length
		await controller.setFrequency("rtl", UHF + 25_000, REST)
		expect(gainWrites(mark)).toEqual([[SET_GAIN, 496]])
		expect(controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 496,
		})
		// Restored: the saved gain is gone, so a further retune writes nothing.
		const again = gainWrites().length
		await controller.setFrequency("rtl", UHF + 50_000, REST)
		expect(gainWrites(again)).toEqual([])
	})

	it("a failed band gain write leaves the retune itself successful", async () => {
		const { controller, writes } = setup(true)
		const sm = (
			controller as unknown as {
				sourceManager: { writeToSource: ReturnType<typeof vi.fn> }
			}
		).sourceManager
		sm.writeToSource.mockImplementation((_id: string, payload: Buffer) => {
			if (payload.readUInt8(0) === SET_GAIN_MODE)
				throw new Error("socket closed")
			writes.push([payload.readUInt8(0), payload.readUInt32BE(1)])
			return true
		})
		await expect(
			controller.setFrequency("rtl", ISM, REST),
		).resolves.toBeUndefined()
		expect(controller.getState("rtl")!.frequency).toBe(ISM)
	})
})
