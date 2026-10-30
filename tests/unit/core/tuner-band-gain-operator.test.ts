/**
 * Per-band gain on the real controller and arbiter together: an operator retune that takes
 * the tuner from a band-gain sweep ends at the operator's exact gain (also with "apply to my
 * tuning", whose saved pre-band gain is then the operator's, not the sweep's band gain);
 * overlapping REST retunes are serialised; the saved pre-band gain survives a restart.
 */
import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import pino from "pino"
import { TunerController } from "../../../src/core/tuner-controller.js"
import {
	BAND_GAIN_SAVED_FILE_MAX_BYTES,
	BAND_GAIN_SAVED_FILE_NAME,
	BAND_GAIN_SAVED_MAX_SOURCES,
	BandGainSettingsService,
	type BandGainFs,
} from "../../../src/core/band-gain.js"
import {
	TunerArbiter,
	type ArbiterDeps,
} from "../../../src/core/scanner/tuner-arbiter.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { FakeClock } from "../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })
const SET_FREQUENCY = 0x01
const SET_GAIN_MODE = 0x03
const SET_GAIN = 0x04
const ISM = 868_100_000
const OTHER_ISM = 915_000_000
const UHF = 455_500_000
const REST = { origin: "rest" as const }
const SAVED_PATH = `/state/${BAND_GAIN_SAVED_FILE_NAME}`

const settle = () => new Promise<void>(resolve => setImmediate(resolve))

function memoryFs() {
	const files = new Map<string, string>()
	const fs: BandGainFs = {
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
	return { fs, files }
}

async function service(applyToMyTuning: boolean, fs: BandGainFs) {
	const s = new BandGainSettingsService({
		stateDir: "/state",
		config: {
			applyToMyTuning,
			entries: [
				{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 },
				{ minHz: 902_000_000, maxHz: 928_000_000, gain: 380 },
			],
		},
		logger,
		fs,
	})
	await s.load()
	return s
}

class Sources extends EventEmitter {
	isRtlTcpSource(id: string): boolean {
		return id === "rtl"
	}
}

async function setup(applyToMyTuning: boolean, fs = memoryFs().fs) {
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
	const bandGain = await service(applyToMyTuning, fs)
	controller.setBandGain(bandGain)
	const clock = new FakeClock()
	const deps: ArbiterDeps = {
		tuner: controller,
		sources: new Sources() as never,
		epochs: id => (id === "rtl" ? clock : undefined),
		settings: () => testSettings(),
		link: () => "network",
		persistLease: () => Promise.resolve(),
		impactSources: {
			liveDemod: null,
			digitalVoice: null,
			decoders: { getAllStatus: () => [] },
		},
		scannerJobsOn: () => [],
		canHandOver: () => true,
		logger,
	}
	const arbiter = new TunerArbiter(deps)
	return { controller, arbiter, writes, bandGain }
}

async function manual(controller: TunerController, gain: number) {
	await controller.setGainMode("rtl", "manual", REST)
	await controller.setGain("rtl", gain, REST)
}

async function sweepOnBand(h: Awaited<ReturnType<typeof setup>>) {
	const r = h.arbiter.acquire("a", "rtl", 50)
	if (!r.ok) throw new Error("acquire failed")
	await h.arbiter.retune(r.lease, {
		centreHz: ISM,
		gainTenthsDb: null,
		sampleRateHz: null,
	})
	expect(h.controller.getState("rtl")).toMatchObject({
		gain: 297,
		bandGain: { tenthsDb: 297, owner: "scanner" },
	})
	return r.lease
}

describe("a REST write takes the tuner from a band-gain sweep", () => {
	it("REST frequency: the operator's gain comes back (apply to my tuning off)", async () => {
		const h = await setup(false)
		await manual(h.controller, 496)
		await sweepOnBand(h)
		await h.controller.setFrequency("rtl", UHF, REST)
		await settle()
		expect(h.controller.getState("rtl")).toMatchObject({
			frequency: UHF,
			gainMode: "manual",
			gain: 496,
		})
		expect(h.controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("REST sample rate: the operator's gain comes back", async () => {
		const h = await setup(false)
		await manual(h.controller, 496)
		await sweepOnBand(h)
		await h.controller.setSampleRate("rtl", 2_400_000, REST)
		await settle()
		expect(h.controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 496,
		})
	})

	it("an AGC operator ends in AGC with the exact gain", async () => {
		const h = await setup(false)
		await manual(h.controller, 300)
		await h.controller.setGainMode("rtl", "agc", REST)
		await sweepOnBand(h)
		await h.controller.setFrequency("rtl", UHF, REST)
		await settle()
		expect(h.controller.getState("rtl")).toMatchObject({
			gainMode: "agc",
			gain: 300,
		})
	})

	it("PATCH config with a gain: the operator's new gain wins over the restore", async () => {
		const h = await setup(false)
		await manual(h.controller, 496)
		await sweepOnBand(h)
		await h.controller.configure("rtl", { frequency: UHF, gain: 421 }, REST)
		await settle()
		expect(h.controller.getState("rtl")).toMatchObject({
			frequency: UHF,
			gain: 421,
		})
	})

	it("with apply to my tuning, into another band: the saved gain is the operator's, not the sweep's", async () => {
		const h = await setup(true)
		await manual(h.controller, 496)
		await sweepOnBand(h)
		await h.controller.setFrequency("rtl", OTHER_ISM, REST)
		await settle()
		expect(h.controller.getState("rtl")).toMatchObject({
			gain: 380,
			bandGain: { tenthsDb: 380, owner: "user" },
		})
		await h.controller.setFrequency("rtl", UHF, REST)
		expect(h.controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 496,
		})
	})

	it("with apply to my tuning, an AGC operator into another band: AGC and the exact gain come back on leaving", async () => {
		const h = await setup(true)
		await manual(h.controller, 300)
		await h.controller.setGainMode("rtl", "agc", REST)
		await sweepOnBand(h)
		await h.controller.setFrequency("rtl", OTHER_ISM, REST)
		await settle()
		expect(h.controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 380,
		})
		await h.controller.setFrequency("rtl", UHF, REST)
		expect(h.controller.getState("rtl")).toMatchObject({
			gainMode: "agc",
			gain: 300,
		})
	})

	it("a relay takeover, then control back: the operator's gain comes back", async () => {
		const h = await setup(false)
		await manual(h.controller, 496)
		await sweepOnBand(h)
		h.controller.applyExternalCommand("rtl", SET_FREQUENCY, UHF)
		await settle()
		expect(h.controller.getState("rtl")?.gain).toBe(297)
		// The arbiter waits for the connection (payload-started) before writing on return.
		;(h.arbiter as unknown as { connected: Set<string> }).connected.add("rtl")
		h.controller.setControlMode("rtl", "internal")
		await settle()
		expect(h.controller.getState("rtl")).toMatchObject({
			frequency: UHF,
			gainMode: "manual",
			gain: 496,
		})
	})

	it("a relay gain choice during the takeover stands", async () => {
		const h = await setup(false)
		await manual(h.controller, 496)
		await sweepOnBand(h)
		h.controller.applyExternalCommand("rtl", SET_FREQUENCY, UHF)
		h.controller.applyExternalCommand("rtl", SET_GAIN, 386)
		;(h.arbiter as unknown as { connected: Set<string> }).connected.add("rtl")
		h.controller.setControlMode("rtl", "internal")
		await settle()
		expect(h.controller.getState("rtl")?.gain).toBe(386)
	})
})

describe("apply to my tuning: overlapping REST retunes and restarts (m4)", () => {
	it("two concurrent setFrequency calls run one after the other", async () => {
		const h = await setup(true)
		await manual(h.controller, 100)
		const mark = h.writes.length
		const a = h.controller.setFrequency("rtl", ISM, REST)
		const b = h.controller.setFrequency("rtl", UHF, REST)
		await Promise.all([a, b])
		// A's band gain lands before B's frequency, and B's restore after it.
		expect(h.writes.slice(mark)).toEqual([
			[SET_FREQUENCY, ISM],
			[SET_GAIN, 297],
			[SET_FREQUENCY, UHF],
			[SET_GAIN, 100],
		])
		expect(h.controller.getState("rtl")).toMatchObject({
			frequency: UHF,
			gain: 100,
		})
		expect(h.controller.getState("rtl")?.bandGain).toBeUndefined()
	})

	it("a failed retune does not block the next one", async () => {
		const h = await setup(true)
		await manual(h.controller, 100)
		const a = h.controller.setFrequency("rtl", 1, REST)
		const b = h.controller.setFrequency("rtl", ISM, REST)
		await expect(a).rejects.toThrow()
		await b
		expect(h.controller.getState("rtl")?.gain).toBe(297)
	})

	it("a restart inside a band still restores the saved gain on leaving it", async () => {
		const disk = memoryFs()
		const first = await setup(true, disk.fs)
		await manual(first.controller, 100)
		await first.controller.setFrequency("rtl", ISM, REST)
		await first.bandGain.saveOperatorGains(
			new Map([["rtl", { gainMode: "manual", gain: 100 }]]),
		)
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "rtl", saved: { gainMode: "manual", gain: 100 } }],
		})
		// A new core on the same state dir: the tuner is still at the band gain.
		const second = await setup(true, disk.fs)
		await second.controller.setFrequency("rtl", UHF, REST)
		expect(second.controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 100,
		})
		// Restored once, then dropped (and the drop is persisted).
		await second.bandGain.saveOperatorGains(new Map())
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [],
		})
	})

	it("the controller persists the saved gain when the band gain goes on and drops it on leaving", async () => {
		const disk = memoryFs()
		const h = await setup(true, disk.fs)
		await manual(h.controller, 100)
		await h.controller.setFrequency("rtl", ISM, REST)
		await settle()
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toMatchObject({
			sources: [{ sourceId: "rtl", saved: { gainMode: "manual", gain: 100 } }],
		})
		await h.controller.setFrequency("rtl", UHF, REST)
		await settle()
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toMatchObject({
			sources: [],
		})
	})

	it.each([
		["not JSON", "{"],
		["the wrong version", JSON.stringify({ version: 2, sources: [] })],
		[
			"an out-of-range gain",
			JSON.stringify({
				version: 1,
				sources: [
					{ sourceId: "rtl", saved: { gainMode: "manual", gain: 501 } },
				],
			}),
		],
		[
			"an unknown key",
			JSON.stringify({
				version: 1,
				sources: [{ sourceId: "rtl", saved: null, extra: 1 }],
			}),
		],
		[
			`more than ${BAND_GAIN_SAVED_MAX_SOURCES} sources`,
			JSON.stringify({
				version: 1,
				sources: Array.from(
					{ length: BAND_GAIN_SAVED_MAX_SOURCES + 1 },
					(_, i) => ({
						sourceId: `s${i}`,
						saved: null,
					}),
				),
			}),
		],
		["past the size bound", " ".repeat(BAND_GAIN_SAVED_FILE_MAX_BYTES + 1)],
	])("a saved gain file with %s is ignored", async (_name, text) => {
		const disk = memoryFs()
		disk.files.set(SAVED_PATH, text)
		const s = await service(true, disk.fs)
		expect(s.savedOperatorGains().size).toBe(0)
	})

	it(`keeps at most ${BAND_GAIN_SAVED_MAX_SOURCES} sources, within the size bound`, async () => {
		const disk = memoryFs()
		const s = await service(true, disk.fs)
		const many = new Map(
			Array.from({ length: BAND_GAIN_SAVED_MAX_SOURCES + 4 }, (_, i) => [
				`${"x".repeat(120)}${i}`,
				{ gainMode: "agc" as const, gain: 496 },
			]),
		)
		await s.saveOperatorGains(many)
		const text = disk.files.get(SAVED_PATH) ?? ""
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
			BAND_GAIN_SAVED_FILE_MAX_BYTES,
		)
		const reloaded = await service(true, disk.fs)
		expect(reloaded.savedOperatorGains().size).toBe(BAND_GAIN_SAVED_MAX_SOURCES)
		// The newest records are kept.
		expect(
			reloaded
				.savedOperatorGains()
				.has(`${"x".repeat(120)}${BAND_GAIN_SAVED_MAX_SOURCES + 3}`),
		).toBe(true)
	})

	it("an operator gain choice in a band drops the saved gain (also on disk)", async () => {
		const disk = memoryFs()
		const h = await setup(true, disk.fs)
		await manual(h.controller, 100)
		await h.controller.setFrequency("rtl", ISM, REST)
		await h.controller.setGainMode("rtl", "agc", REST)
		await settle()
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toMatchObject({
			sources: [],
		})
		const mark = h.writes.length
		await h.controller.setFrequency("rtl", UHF, REST)
		expect(
			h.writes
				.slice(mark)
				.filter(([c]) => c === SET_GAIN || c === SET_GAIN_MODE),
		).toEqual([])
	})
})

describe("apply to my tuning: the saved gain is a durable, superseded record (WG18 gate)", () => {
	function gainWrites(writes: [number, number][], mark: number) {
		return writes
			.slice(mark)
			.filter(([c]) => c === SET_GAIN || c === SET_GAIN_MODE)
	}

	it("the band gain waits until the saved gain is on disk", async () => {
		const disk = memoryFs()
		let release: () => void = () => {}
		const write = disk.fs.atomicWrite
		disk.fs.atomicWrite = (path, data) =>
			path === SAVED_PATH
				? new Promise<void>(resolve => {
						release = () => {
							void write(path, data).then(resolve)
						}
					})
				: write(path, data)
		const h = await setup(true, disk.fs)
		await manual(h.controller, 100)
		const mark = h.writes.length
		const retune = h.controller.setFrequency("rtl", ISM, REST)
		await settle()
		expect(gainWrites(h.writes, mark)).toEqual([])
		release()
		await retune
		expect(gainWrites(h.writes, mark)).toEqual([[SET_GAIN, 297]])
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toMatchObject({
			sources: [{ sourceId: "rtl", saved: { gainMode: "manual", gain: 100 } }],
		})
	})

	it("a failed save keeps the user's gain and applies no band gain", async () => {
		const disk = memoryFs()
		const write = disk.fs.atomicWrite
		disk.fs.atomicWrite = (path, data) =>
			path === SAVED_PATH
				? Promise.reject(Object.assign(new Error("x"), { code: "ENOSPC" }))
				: write(path, data)
		const h = await setup(true, disk.fs)
		await manual(h.controller, 100)
		const mark = h.writes.length
		await h.controller.setFrequency("rtl", ISM, REST)
		expect(gainWrites(h.writes, mark)).toEqual([])
		expect(h.controller.getState("rtl")).toMatchObject({
			frequency: ISM,
			gainMode: "manual",
			gain: 100,
		})
		expect(h.controller.getState("rtl")?.bandGain).toBeUndefined()
		// Nothing saved in memory either: leaving the band restores nothing.
		const leave = h.writes.length
		await h.controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites(h.writes, leave)).toEqual([])
	})

	it("an operator gain choice while the save is in flight wins: no band gain, nothing saved", async () => {
		const disk = memoryFs()
		let release: () => void = () => {}
		const write = disk.fs.atomicWrite
		let hold = true
		disk.fs.atomicWrite = (path, data) =>
			path === SAVED_PATH && hold
				? new Promise<void>(resolve => {
						hold = false
						release = () => {
							void write(path, data).then(resolve)
						}
					})
				: write(path, data)
		const h = await setup(true, disk.fs)
		await manual(h.controller, 100)
		const retune = h.controller.setFrequency("rtl", ISM, REST)
		await settle()
		await h.controller.setGain("rtl", 420, REST)
		release()
		await retune
		await settle()
		expect(h.controller.getState("rtl")?.gain).toBe(420)
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toMatchObject({
			sources: [],
		})
	})

	it("a REST AGC choice in a band supersedes the saved gain and counts as a gain choice", async () => {
		const disk = memoryFs()
		const h = await setup(true, disk.fs)
		await manual(h.controller, 100)
		await h.controller.setFrequency("rtl", ISM, REST)
		const before = h.controller.gainChoiceCount("rtl")
		// The tuner's baseline is AGC on: turning it off changes the mode.
		await h.controller.setAgcMode("rtl", false, REST)
		expect(h.controller.gainChoiceCount("rtl")).toBe(before + 1)
		expect(h.controller.getState("rtl")?.bandGain).toBeUndefined()
		await settle()
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toMatchObject({
			sources: [],
		})
		const mark = h.writes.length
		await h.controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites(h.writes, mark)).toEqual([])
	})

	it("a scanner AGC write is not an operator choice", async () => {
		const h = await setup(true)
		await manual(h.controller, 100)
		await h.controller.setFrequency("rtl", ISM, REST)
		const before = h.controller.gainChoiceCount("rtl")
		await h.controller.setAgcMode("rtl", false, { origin: "scanner" })
		expect(h.controller.gainChoiceCount("rtl")).toBe(before)
		const mark = h.writes.length
		await h.controller.setFrequency("rtl", UHF, REST)
		expect(gainWrites(h.writes, mark)).toEqual([[SET_GAIN, 100]])
	})

	it.each([
		["gain equal to the band gain", { gain: 297 }, true],
		["gain mode equal to the tuner's", { gainMode: "manual" as const }, false],
		["AGC equal to the tuner's", { agcMode: true }, false],
	])(
		"PATCH config with a %s is a choice: no write, saved gain superseded",
		async (_name, update, dropsBandGain) => {
			const disk = memoryFs()
			const h = await setup(true, disk.fs)
			await manual(h.controller, 100)
			await h.controller.setFrequency("rtl", ISM, REST)
			expect(h.controller.getState("rtl")?.bandGain).toBeDefined()
			const before = h.controller.gainChoiceCount("rtl")
			const mark = h.writes.length
			await h.controller.configure("rtl", update, REST)
			expect(h.writes.slice(mark)).toEqual([])
			expect(h.controller.gainChoiceCount("rtl")).toBe(before + 1)
			expect(h.controller.getState("rtl")?.bandGain === undefined).toBe(
				dropsBandGain,
			)
			await settle()
			expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toMatchObject({
				sources: [],
			})
			await h.controller.setFrequency("rtl", UHF, REST)
			expect(gainWrites(h.writes, mark)).toEqual([])
		},
	)

	it("ids of escaped characters: the file stays within the read bound and reads back", async () => {
		const disk = memoryFs()
		const s = await service(true, disk.fs)
		// 128 control characters serialise to 768 bytes each ("\u0001").
		const id = (i: number) =>
			`${String.fromCharCode(i + 1)}${"\u0001".repeat(127)}`
		const many = new Map(
			Array.from({ length: BAND_GAIN_SAVED_MAX_SOURCES }, (_, i) => [
				id(i),
				{ gainMode: "manual" as const, gain: 100 },
			]),
		)
		const naive = JSON.stringify(
			{
				version: 1,
				sources: [...many].map(([sourceId, saved]) => ({ sourceId, saved })),
			},
			null,
			"\t",
		)
		expect(Buffer.byteLength(naive)).toBeGreaterThan(
			BAND_GAIN_SAVED_FILE_MAX_BYTES,
		)
		const newest = id(BAND_GAIN_SAVED_MAX_SOURCES - 1)
		await expect(s.saveOperatorGains(many, newest)).resolves.toBe(true)
		const text = disk.files.get(SAVED_PATH) ?? ""
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
			BAND_GAIN_SAVED_FILE_MAX_BYTES,
		)
		const reloaded = await service(true, disk.fs)
		const loaded = reloaded.savedOperatorGains()
		expect(loaded.size).toBe(
			(JSON.parse(text) as { sources: unknown[] }).sources.length,
		)
		expect(loaded.size).toBeGreaterThan(0)
		expect(loaded.has(newest)).toBe(true)
		// The oldest went first.
		expect(loaded.has(id(0))).toBe(false)
	})

	it("one more escaped record past the bound drops one more of the oldest", async () => {
		const disk = memoryFs()
		const s = await service(true, disk.fs)
		const id = (i: number) =>
			`${String.fromCharCode(i + 1)}${"\u0001".repeat(127)}`
		const sizes: number[] = []
		for (const n of [9, 10, 11]) {
			const gains = new Map(
				Array.from({ length: n }, (_, i) => [id(i), null] as const),
			)
			await s.saveOperatorGains(gains)
			const text = disk.files.get(SAVED_PATH) ?? ""
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
				BAND_GAIN_SAVED_FILE_MAX_BYTES,
			)
			sizes.push((JSON.parse(text) as { sources: unknown[] }).sources.length)
		}
		// 10 records fit (about 7.8 KiB); the 11th pushes the oldest out.
		expect(sizes).toEqual([9, 10, 10])
	})

	it("a source id the file cannot hold is not durable", async () => {
		const s = await service(true, memoryFs().fs)
		await expect(
			s.saveOperatorGains(new Map([["y".repeat(129), null]]), "y".repeat(129)),
		).resolves.toBe(false)
	})
})
