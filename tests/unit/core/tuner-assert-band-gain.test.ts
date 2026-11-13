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
const SET_GAIN_MODE = 0x03
const SET_GAIN = 0x04
const ISM = 868_100_000
const UHF = 455_500_000
/** In a second band whose gain (100) differs from the first one's (297). */
const SECOND = 434_000_000
const REST = { origin: "rest" as const }

const settle = async () => {
	for (let i = 0; i < 5; i++)
		await new Promise<void>(resolve => setImmediate(resolve))
}

/**
 * In-memory state files. `saves` decides each atomic write: "ok" at once, "fail" (rejects), or
 * "defer" (waits until the test calls the returned release).
 */
function memoryFs(saves: Array<"ok" | "fail" | "defer"> = []): BandGainFs & {
	deferred: Array<() => void>
} {
	const files = new Map<string, string>()
	const deferred: Array<() => void> = []
	return {
		deferred,
		readFile: path => {
			const text = files.get(path)
			return text === undefined
				? Promise.reject(
						Object.assign(new Error("missing"), { code: "ENOENT" }),
					)
				: Promise.resolve(Buffer.from(text))
		},
		atomicWrite: (path, data) => {
			const how = saves.shift() ?? "ok"
			if (how === "fail") return Promise.reject(new Error("disk full"))
			if (how === "defer")
				return new Promise<void>(resolve =>
					deferred.push(() => {
						files.set(path, data)
						resolve()
					}),
				)
			files.set(path, data)
			return Promise.resolve()
		},
	}
}

async function setup(
	applyToMyTuning: boolean,
	saves: Array<"ok" | "fail" | "defer"> = [],
) {
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
	const fs = memoryFs(saves)
	const bandGain = new BandGainSettingsService({
		stateDir: "/state",
		config: {
			applyToMyTuning,
			entries: [
				{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
				{ minHz: 433_000_000, maxHz: 435_000_000, gain: 100 },
			],
		},
		logger,
		fs,
	})
	await bandGain.load()
	controller.setBandGain(bandGain)
	return { controller, writes, fs }
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
		expect(writes).toContainEqual([SET_FREQUENCY, ISM])
		const synced = writes.length
		await settle()
		// The re-apply writes exactly the band gain (the mode is manual already), once.
		expect(writes.slice(synced)).toEqual([[SET_GAIN, 297]])
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

describe("assert's band gain re-apply re-checks after its awaits (Main gate A2)", () => {
	/**
	 * The operator's centre is in the band, but its pre-band gain was never saved (the save
	 * failed), so the re-apply after assert has to save it first: a slow save the test releases.
	 */
	async function slowSave() {
		const h = await setup(true, ["fail", "defer"])
		await h.controller.setGainMode("rtl", "manual", REST)
		await h.controller.setGain("rtl", 200, REST)
		await h.controller.setFrequency("rtl", ISM, REST)
		expect(h.controller.getState("rtl")!.bandGain).toBeUndefined()
		await h.controller.setFrequency("rtl", UHF, {
			origin: "scanner",
			accept: false,
		})
		h.writes.length = 0
		h.controller.synchronizeOnConnect("rtl")
		expect(h.writes).toContainEqual([SET_FREQUENCY, ISM])
		const synced = h.writes.length
		await settle()
		// The re-apply waits on the save.
		expect(h.fs.deferred).toHaveLength(1)
		return { ...h, synced }
	}

	it("writes the band gain once its save lands (the control case)", async () => {
		const h = await slowSave()
		h.fs.deferred[0]!()
		await settle()
		expect(h.writes.slice(h.synced)).toEqual([[SET_GAIN, 297]])
	})

	it("writes no gain when a scanner lease was taken meanwhile", async () => {
		const h = await slowSave()
		h.controller.setLeaseView({ holds: () => true, resend: () => {} })
		h.fs.deferred[0]!()
		await settle()
		expect(
			h.writes
				.slice(h.synced)
				.filter(([cmd]) => cmd === SET_GAIN || cmd === SET_GAIN_MODE),
		).toEqual([])
		expect(h.controller.getState("rtl")!.bandGain).toBeUndefined()
	})

	it("writes no stale gain when the operator retuned into another band during the save", async () => {
		const h = await slowSave()
		// Into another band: that retune applies its own band gain.
		await h.controller.setFrequency("rtl", SECOND, REST)
		await settle()
		h.fs.deferred[0]!()
		await settle()
		expect(h.writes.slice(h.synced)).toEqual([
			[SET_FREQUENCY, SECOND],
			[SET_GAIN, 100],
		])
		expect(h.controller.getState("rtl")!).toMatchObject({
			frequency: SECOND,
			gain: 100,
			bandGain: { tenthsDb: 100 },
		})
	})

	it("writes no stale gain when the operator retuned while it waited on a gain restore", async () => {
		const { controller, writes } = await setup(true)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 200, REST)
		await controller.setFrequency("rtl", ISM, REST)
		await controller.setFrequency("rtl", UHF, {
			origin: "scanner",
			accept: false,
		})
		await controller.setGain("rtl", 150, { origin: "scanner", accept: false })
		// The scanner is putting a gain back (a lost lease): band gains wait for it.
		let release = () => {}
		controller.holdBandGainFor(
			"rtl",
			new Promise<void>(resolve => {
				release = resolve
			}),
		)
		writes.length = 0
		controller.synchronizeOnConnect("rtl")
		expect(writes).toContainEqual([SET_FREQUENCY, ISM])
		const synced = writes.length
		await settle()
		// Into another band meanwhile: its own band gain waits on the same restore.
		const retune = controller.setFrequency("rtl", SECOND, REST)
		await settle()
		release()
		await retune
		await settle()
		expect(writes.slice(synced)).toEqual([
			[SET_FREQUENCY, SECOND],
			[SET_GAIN, 100],
		])
		expect(controller.getState("rtl")!).toMatchObject({
			frequency: SECOND,
			gain: 100,
			bandGain: { tenthsDb: 100 },
		})
	})
})
