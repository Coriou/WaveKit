/**
 * The saved pre-band gain is kept per receiver. Each record of
 * tuner-band-gain-saved-receivers.json names its receiver; tuner-band-gain-saved.json keeps the
 * format older images read (no receiver keys). A tracked source applies only its current
 * receiver's record, the one from before namespacing (no key) only when the first receiver adopts
 * the legacy state (it stays in the legacy file for an image rolled back; the receiver's own
 * keyed record wins over it), and nothing while the receiver is unknown. Real controller and settings service over an in-memory file system.
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
const A = "unit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const B = "unit:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

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

	it("keeps the legacy record in its file after the adoption (a rollback still reads it)", async () => {
		for (const legacyRecorded of [true, false]) {
			const disk = memoryFs(legacy)
			const a = await setup(disk.fs)
			a.controller.noteReceiverBound("rtl", {
				key: A,
				adoptLegacy: true,
				legacyRecorded,
			})
			await settle()
			const kept = JSON.parse(disk.files.get(SAVED_PATH) ?? "null") as {
				sources: unknown[]
			}
			expect(kept.sources).toHaveLength(2)
			expect(kept.sources).toEqual(expect.arrayContaining(legacy.sources))
			expect(JSON.parse(disk.files.get(RECEIVERS_PATH) ?? "null")).toEqual({
				version: 1,
				sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(150) }],
			})
			// Another receiver later, and back: the legacy record is still there, A keeps its own.
			a.controller.noteReceiverBound("rtl", { key: B, adoptLegacy: false })
			a.controller.noteReceiverBound("rtl", { key: A, adoptLegacy: false })
			await settle()
			expect(
				(
					JSON.parse(disk.files.get(SAVED_PATH) ?? "null") as {
						sources: unknown[]
					}
				).sources,
			).toEqual(expect.arrayContaining(legacy.sources))
			await a.controller.setFrequency("rtl", UHF, REST)
			expect(a.controller.getState("rtl")?.gain).toBe(150)
		}
	})

	it("a deferred adoption of the receiver bound now (same key) takes the legacy record", async () => {
		const W = "source:rtl|model:5:29"
		const disk = memoryFs(legacy)
		const { controller } = await setup(disk.fs)
		controller.noteReceiverBound("rtl", { key: W, adoptLegacy: false })
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).not.toBe(150)
		// No sdr-host answered: the same key adopts within its connection.
		controller.noteReceiverBound("rtl", { key: W, adoptLegacy: true })
		await settle()
		expect(JSON.parse(disk.files.get(RECEIVERS_PATH) ?? "null")).toEqual({
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: W, saved: saved(150) }],
		})
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).toBe(150)
	})

	it("a deferred adoption keeps the bound receiver's own record", async () => {
		const W = "source:rtl|model:5:29"
		const disk = memoryFs(legacy, {
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: W, saved: saved(120) }],
		})
		const { controller } = await setup(disk.fs)
		controller.noteReceiverBound("rtl", { key: W, adoptLegacy: false })
		controller.noteReceiverBound("rtl", { key: W, adoptLegacy: true })
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).toBe(120)
	})

	it("the receiver's keyed record wins over the legacy one at the adoption", async () => {
		const disk = memoryFs(legacy, {
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: A, saved: saved(120) }],
		})
		const { controller } = await setup(disk.fs)
		controller.noteReceiverBound("rtl", { key: A, adoptLegacy: true })
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).toBe(120)
		await settle()
		expect(
			(
				JSON.parse(disk.files.get(SAVED_PATH) ?? "null") as {
					sources: unknown[]
				}
			).sources,
		).toEqual(expect.arrayContaining(legacy.sources))
	})

	it("a stable key taking over a weak key copies its saved gain; the weak key keeps it", async () => {
		const WEAK = "source:rtl|model:5:29"
		const disk = memoryFs(undefined, {
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: WEAK, saved: saved(130) }],
		})
		const { controller } = await setup(disk.fs)
		controller.noteReceiverBound("rtl", {
			key: A,
			adoptLegacy: false,
			takeOverFrom: WEAK,
		})
		await settle()
		const records = (
			JSON.parse(disk.files.get(RECEIVERS_PATH) ?? "null") as {
				sources: unknown[]
			}
		).sources
		expect(records).toEqual(
			expect.arrayContaining([
				{ sourceId: "rtl", receiverKey: WEAK, saved: saved(130) },
				{ sourceId: "rtl", receiverKey: A, saved: saved(130) },
			]),
		)
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).toBe(130)
	})

	it("legacy wins: with a legacy record the taken-over weak key's gain is not used; without one it applies", async () => {
		const WEAK = "source:rtl|model:5:29"
		const weakRecord = {
			version: 1,
			sources: [{ sourceId: "rtl", receiverKey: WEAK, saved: saved(130) }],
		}
		const withLegacy = memoryFs(legacy, weakRecord)
		const first = await setup(withLegacy.fs)
		first.controller.noteReceiverBound("rtl", {
			key: A,
			adoptLegacy: true,
			takeOverFrom: WEAK,
		})
		await first.controller.setFrequency("rtl", UHF, REST)
		expect(first.controller.getState("rtl")?.gain).toBe(150)
		const noLegacy = memoryFs(undefined, weakRecord)
		const second = await setup(noLegacy.fs)
		second.controller.noteReceiverBound("rtl", {
			key: A,
			adoptLegacy: true,
			takeOverFrom: WEAK,
		})
		await second.controller.setFrequency("rtl", UHF, REST)
		expect(second.controller.getState("rtl")?.gain).toBe(130)
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
			"rtl",
			{ magic: "RTL0", tunerType: 5, gainCount: 29 },
			{ unitId: "a".repeat(32) },
		)
		const idB = resolveReceiverIdentity(
			"rtl",
			{ magic: "RTL0", tunerType: 5, gainCount: 29 },
			{ unitId: "b".repeat(32) },
		)
		expect(idA.key).toBe(A)
		current.set("rtl", idA)
		await learned.onIdentity("rtl", idA, undefined)
		await controller.setFrequency("rtl", UHF, REST)
		expect(controller.getState("rtl")?.gain).toBe(150)
		await settle()
		expect(
			(
				JSON.parse(disk.files.get(SAVED_PATH) ?? "null") as {
					sources: unknown[]
				}
			).sources,
		).toEqual(expect.arrayContaining(legacy.sources))

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
