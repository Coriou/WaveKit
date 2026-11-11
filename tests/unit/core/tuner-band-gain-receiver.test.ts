/**
 * The saved pre-band gain is kept per receiver. Each record of
 * tuner-band-gain-saved-receivers.json names its receiver; tuner-band-gain-saved.json keeps the
 * format older images read (no receiver keys). A tracked source applies only its current
 * receiver's record, the one from before namespacing (no key) only when the first receiver adopts
 * the legacy state (it leaves the legacy file once that adoption is on record), and nothing while
 * the receiver is unknown. Real controller and settings service over an in-memory file system.
 */
import { describe, expect, it, vi } from "vitest"
import pino from "pino"
import { TunerController } from "../../../src/core/tuner-controller.js"
import {
	BAND_GAIN_SAVED_FILE_NAME,
	BAND_GAIN_SAVED_RECEIVERS_FILE_NAME,
	BandGainSettingsService,
	type BandGainFs,
} from "../../../src/core/band-gain.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { ReceiverLearnedState } from "../../../src/core/receiver-identity-state.js"
import { receiverBoundToTuner } from "../../../src/core/receiver-identity-wiring.js"
import {
	resolveReceiverIdentity,
	type ReceiverIdentity,
} from "../../../src/core/receiver-identity.js"

const logger = pino({ level: "silent" })
const UHF = 455_500_000
const REST = { origin: "rest" as const }
const SAVED_PATH = `/state/${BAND_GAIN_SAVED_FILE_NAME}`
const RECEIVERS_PATH = `/state/${BAND_GAIN_SAVED_RECEIVERS_FILE_NAME}`
const A = "sdrhost:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const B = "sdrhost:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function memoryFs(initial?: unknown, receivers?: unknown) {
	const files = new Map<string, string>()
	if (initial !== undefined) files.set(SAVED_PATH, JSON.stringify(initial))
	if (receivers !== undefined)
		files.set(RECEIVERS_PATH, JSON.stringify(receivers))
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

async function setup(fs: BandGainFs) {
	const sourceManager = {
		assertTunerCommandActive: () => {},
		writeToSource: vi.fn(() => true),
		isRtlTcpSource: () => true,
		updateSourceCaps: vi.fn(),
		getCaps: () => undefined,
	}
	const controller = new TunerController(
		logger,
		sourceManager as unknown as SourceManager,
		{ receiverTracked: id => id === "rtl" },
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
			applyToMyTuning: true,
			entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 }],
		},
		logger,
		fs,
	})
	await bandGain.load()
	controller.setBandGain(bandGain)
	return { controller, bandGain }
}

const saved = (gain: number) => ({ gainMode: "manual" as const, gain })
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

describe("pre-band gain per receiver", () => {
	it("restores only the current receiver's saved gain on leaving a band", async () => {
		const disk = memoryFs(undefined, {
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(100) }],
		})
		const { controller } = await setup(disk.fs)
		// Not yet identified: nothing learned applies.
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).not.toBe(100)
		// Receiver B: A's saved gain is not B's.
		controller.noteReceiverBound("rtl", { key: B, adoptLegacy: false })
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).not.toBe(100)
		// Receiver A: its own saved gain comes back on leaving the band.
		controller.noteReceiverBound("rtl", { key: A, adoptLegacy: false })
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")).toMatchObject({
			gainMode: "manual",
			gain: 100,
		})
	})

	it("keeps another receiver's record on disk, tagged, while this one is bound", async () => {
		const disk = memoryFs(undefined, {
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(100) }],
		})
		const { controller } = await setup(disk.fs)
		controller.noteReceiverBound("rtl", { key: B, adoptLegacy: false })
		await settle()
		expect(JSON.parse(disk.files.get(RECEIVERS_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(100) }],
		})
		// The legacy file holds no receiver keys (older images refuse them).
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [],
		})
	})

	it("a keyed record in the legacy file (an earlier build) moves to the receivers file", async () => {
		const disk = memoryFs({
			version: 1,
			sources: [
				{ sourceId: "other", saved: saved(50) },
				{ sourceId: "rtl", receiverKey: A, saved: saved(100) },
			],
		})
		const { controller, bandGain } = await setup(disk.fs)
		expect(bandGain.savedOperatorGainRecords()).toHaveLength(2)
		controller.noteReceiverBound("rtl", { key: B, adoptLegacy: false })
		await settle()
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "other", saved: saved(50) }],
		})
		expect(JSON.parse(disk.files.get(RECEIVERS_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(100) }],
		})
	})

	it("an untracked source alone never creates the receivers file", async () => {
		const disk = memoryFs()
		const { bandGain } = await setup(disk.fs)
		await bandGain.saveOperatorGains(new Map([["other", saved(50)]]))
		expect(disk.files.has(RECEIVERS_PATH)).toBe(false)
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "other", saved: saved(50) }],
		})
	})

	it("the record from before namespacing goes to the adopting receiver only", async () => {
		const legacy = {
			version: 1,
			sources: [{ sourceId: "rtl", saved: saved(150) }],
		}
		const first = await setup(memoryFs(legacy).fs)
		first.controller.noteReceiverBound("rtl", { key: B, adoptLegacy: false })
		await first.controller.setFrequency("rtl", UHF, REST)
		expect(first.controller.getState("rtl")?.gain).not.toBe(150)

		const disk = memoryFs(legacy)
		const second = await setup(disk.fs)
		second.controller.noteReceiverBound("rtl", { key: A, adoptLegacy: true })
		await settle()
		// Adopted: written under A's key in the receivers file; the legacy record stays for an
		// older image rolled back.
		expect(JSON.parse(disk.files.get(RECEIVERS_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(150) }],
		})
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toEqual(legacy)
		await second.controller.setFrequency("rtl", UHF, REST)
		expect(second.controller.getState("rtl")?.gain).toBe(150)
	})

	it("a record with a malformed receiver key makes the file invalid (ignored, nothing applied)", async () => {
		const bad = {
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: "../../x", saved: saved(100) }],
		}
		expect(
			(await setup(memoryFs(bad).fs)).bandGain.savedOperatorGainRecords(),
		).toEqual([])
		expect(
			(
				await setup(memoryFs(undefined, bad).fs)
			).bandGain.savedOperatorGainRecords(),
		).toEqual([])
	})

	it("refuses the band gain while the receiver is not bound, with the reason logged", async () => {
		const lines: Array<{ msg?: string; reason?: string }> = []
		const capture = pino(
			{ level: "warn" },
			{
				write: (line: string) => {
					lines.push(JSON.parse(line) as { msg?: string; reason?: string })
				},
			},
		)
		const sourceManager = {
			assertTunerCommandActive: () => {},
			writeToSource: vi.fn(() => true),
			isRtlTcpSource: () => true,
			updateSourceCaps: vi.fn(),
			getCaps: () => undefined,
		}
		const controller = new TunerController(
			capture,
			sourceManager as unknown as SourceManager,
			{ receiverTracked: id => id === "rtl" },
		)
		controller.initializeSource("rtl", {
			kind: "iq",
			sampleRate: 2_048_000,
			format: "U8_IQ",
			exclusive: false,
			centerFreq: UHF,
		})
		const bandGain = new BandGainSettingsService({
			stateDir: "/state",
			config: {
				applyToMyTuning: true,
				entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 }],
			},
			logger,
			fs: memoryFs().fs,
		})
		await bandGain.load()
		controller.setBandGain(bandGain)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 100, REST)
		await controller.setFrequency("rtl", 868_000_000, REST)
		expect(controller.getState("rtl")?.gain).toBe(100)
		expect(lines.some(l => l.reason === "receiver not identified")).toBe(true)
	})
})

describe("pre-band gain from before namespacing", () => {
	const legacy = {
		version: 1,
		sources: [
			{ sourceId: "other", saved: saved(50) },
			{ sourceId: "rtl", saved: saved(150) },
		],
	}

	it("leaves the legacy file once the adoption is on record, and stays while it is not", async () => {
		const recorded = memoryFs(legacy)
		const a = await setup(recorded.fs)
		a.controller.noteReceiverBound("rtl", {
			key: A,
			adoptLegacy: true,
			legacyRecorded: true,
		})
		await settle()
		expect(JSON.parse(recorded.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "other", saved: saved(50) }],
		})
		expect(JSON.parse(recorded.files.get(RECEIVERS_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(150) }],
		})
		// Another receiver later, and back: the old record never comes back.
		a.controller.noteReceiverBound("rtl", { key: B, adoptLegacy: false })
		a.controller.noteReceiverBound("rtl", { key: A, adoptLegacy: false })
		await settle()
		expect(JSON.parse(recorded.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "other", saved: saved(50) }],
		})

		const unrecorded = memoryFs(legacy)
		const b = await setup(unrecorded.fs)
		b.controller.noteReceiverBound("rtl", {
			key: A,
			adoptLegacy: true,
			legacyRecorded: false,
		})
		await settle()
		const kept = JSON.parse(unrecorded.files.get(SAVED_PATH) ?? "null") as {
			sources: unknown[]
		}
		expect(kept.sources).toHaveLength(2)
		expect(kept.sources).toEqual(expect.arrayContaining(legacy.sources))
		await b.controller.setFrequency("rtl", UHF, REST)
		expect(b.controller.getState("rtl")?.gain).toBe(150)
	})

	it("scanner off: the first receiver identified adopts it through the production chain; the next never gets it", async () => {
		const stateDir = "/state"
		const disk = memoryFs(legacy)
		const { controller } = await setup(disk.fs)
		const namespaceFiles = new Map<string, string>()
		const current = new Map<string, ReceiverIdentity>()
		const learned = new ReceiverLearnedState({
			stateDir,
			logger,
			tracked: id => id === "rtl",
			onBound: receiverBoundToTuner(
				{ current: id => current.get(id) },
				() => controller,
			),
			fs: {
				readFile: path => {
					const text = namespaceFiles.get(path)
					return text === undefined
						? Promise.reject(
								Object.assign(new Error("missing"), { code: "ENOENT" }),
							)
						: Promise.resolve(Buffer.from(text))
				},
				atomicWrite: (path, data) => {
					namespaceFiles.set(path, data)
					return Promise.resolve()
				},
			},
		})
		await learned.load()
		// No attach(): the scanner (and its store) is off.
		const idA = resolveReceiverIdentity(
			{ magic: "RTL0", tunerType: 5, gainCount: 29 },
			{ receiverId: "a".repeat(32) },
		)
		const idB = resolveReceiverIdentity(
			{ magic: "RTL0", tunerType: 5, gainCount: 29 },
			{ receiverId: "b".repeat(32) },
		)
		expect(idA.key).toBe(A)
		current.set("rtl", idA)
		await learned.onIdentity("rtl", idA, undefined)
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).toBe(150)
		await settle()
		expect(JSON.parse(disk.files.get(SAVED_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "other", saved: saved(50) }],
		})

		// B, in this process and after a restart: never A's gain from before.
		await learned.onConnection("rtl")
		current.set("rtl", idB)
		await learned.onIdentity("rtl", idB, idA)
		await controller.setGainMode("rtl", "manual", REST)
		await controller.setGain("rtl", 90, REST)
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).toBe(90)

		const restarted = new ReceiverLearnedState({
			stateDir,
			logger,
			tracked: id => id === "rtl",
			onBound: (_id, b) => bindings.push(b),
			fs: {
				readFile: path => {
					const text = namespaceFiles.get(path)
					return text === undefined
						? Promise.reject(new Error("missing"))
						: Promise.resolve(Buffer.from(text))
				},
				atomicWrite: () => Promise.resolve(),
			},
		})
		const bindings: Array<{ key: string | null; adoptLegacy: boolean }> = []
		await restarted.load()
		await restarted.onIdentity("rtl", idB, undefined)
		expect(bindings.at(-1)).toEqual({ key: B, adoptLegacy: false })
	})
})
