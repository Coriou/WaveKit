/**
 * Trusted spur lines per receiver: the engine state of a strong receiver key (a unit key or a
 * strong serial) loaded from that key's own namespace is handed to the spectrum trusted (its
 * lines load verified); a weak key, another receiver, a legacy adoption, a take-over or a new
 * namespace load unverified. Real ScannerPersistence in a tmp state directory.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ScannerPersistence } from "../../../src/core/scanner/store/persistence.js"
import {
	ReceiverLearnedState,
	strongReceiverKey,
	type LearnedSpectrum,
} from "../../../src/core/receiver-identity-state.js"
import {
	resolveReceiverIdentity,
	type ReceiverIdentity,
} from "../../../src/core/receiver-identity.js"
import type { EngineState } from "../../../src/core/spectrum/types.js"
import type { OccupancyState } from "../../../src/core/spectrum/occupancy.js"
import type { SpectrumPersistence } from "../../../src/core/spectrum/spectrum-service.js"

const silent = pino({ level: "silent" })
let stateDir: string
let scannerDir: string
beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "wk-receiver-trust-"))
	scannerDir = join(stateDir, "scanner")
})
afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true })
})

const HEADER = { magic: "RTL0", tunerType: 5, gainCount: 29 }
const A = resolveReceiverIdentity("rtl", HEADER, {
	unitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
})
const B = resolveReceiverIdentity("rtl", HEADER, {
	unitId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
})
const WEAK = resolveReceiverIdentity("rtl", HEADER, null)
const STRONG_SERIAL = resolveReceiverIdentity("rtl", HEADER, {
	vendor: "0bda",
	product: "2838",
	serial: "73015412",
})
const DEFAULT_SERIAL = resolveReceiverIdentity("rtl", HEADER, {
	vendor: "0bda",
	product: "2838",
	serial: "00000001",
})

const engine = (dbfs: number): EngineState => ({
	version: 1,
	absoluteFloors: [{ key: "1024000:agc:1024", dbfs }],
	spurs: [],
	kByRange: [],
	provisionalSpurs: [
		{ key: "1024000:agc:1024", basebandBin: 662, widthBins: 1, comb: false },
	],
})

type Replaced = {
	engine: EngineState | null
	occupancy: OccupancyState | null
	trusted?: boolean
}

async function make(opts: { sdrHostConfigured?: boolean } = {}) {
	const store = new ScannerPersistence({
		dir: scannerDir,
		logger: silent,
		now: Date.now,
	})
	const learned = new ReceiverLearnedState({
		stateDir,
		logger: silent,
		tracked: id => id === "rtl",
		sdrHostConfigured: () => opts.sdrHostConfigured === true,
	})
	await learned.load()
	const legacy: SpectrumPersistence = {
		writeEngine: (id, s) => store.writeEngine(id, s),
		loadEngine: id => store.loadEngine(id),
		writeOccupancy: (id, s) => store.writeOccupancy(id, s),
		loadOccupancy: id => store.loadOccupancy(id),
	}
	const persistence = learned.attach(store, legacy, () => true)
	let current: Replaced = { engine: null, occupancy: null }
	const replaced: Replaced[] = []
	const spectrum: LearnedSpectrum = {
		exportLearnedState: async () => ({
			engine: current.engine,
			occupancy: current.occupancy,
		}),
		replaceLearnedState: async (_id, next) => {
			replaced.push(next)
			current = { ...next }
		},
	}
	learned.setSpectrum(spectrum)
	return {
		store,
		learned,
		persistence,
		replaced,
		learn: (e: EngineState) => {
			current = { engine: e, occupancy: null }
		},
	}
}

/** loadEngine as the spectrum service calls it at an engine open, with its trust. */
async function openLoad(
	persistence: SpectrumPersistence,
): Promise<{ state: EngineState | null; trusted: boolean }> {
	const state = await persistence.loadEngine("rtl")
	return {
		state,
		trusted:
			state !== null && persistence.engineTrusted?.("rtl", state) === true,
	}
}

describe("strongReceiverKey", () => {
	it("is true for a unit key and a strong serial key, false for a model key, a weak serial and unknown", () => {
		expect(strongReceiverKey(A)).toBe(true)
		expect(STRONG_SERIAL.key.startsWith("serial:")).toBe(true)
		expect(strongReceiverKey(STRONG_SERIAL)).toBe(true)
		// A default serial never forms a serial key: the model key, weak.
		expect(DEFAULT_SERIAL.key).toBe(WEAK.key)
		expect(strongReceiverKey(DEFAULT_SERIAL)).toBe(false)
		expect(strongReceiverKey(WEAK)).toBe(false)
		expect(strongReceiverKey(resolveReceiverIdentity("rtl", null, null))).toBe(
			false,
		)
		// Checked again from the key: a serial key of a default serial is never strong.
		const forged: ReceiverIdentity = {
			key: "serial:0bda:2838:00000001",
			strength: "unit",
		}
		expect(strongReceiverKey(forged)).toBe(false)
	})
})

describe("ReceiverLearnedState: trusted spur lines", () => {
	it("a unit key's own saved namespace loads trusted at its settle and at an engine open", async () => {
		const { store, learned, persistence, replaced } = await make()
		await store.writeEngineIn("rtl", A.key, engine(-80))
		await learned.onIdentity("rtl", A, undefined)
		expect(replaced.at(-1)).toMatchObject({ trusted: true })
		expect(replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(-80)
		const open = await openLoad(persistence)
		expect(open.state?.absoluteFloors[0]?.dbfs).toBe(-80)
		expect(open.trusted).toBe(true)
	})

	it("A -> B -> A: B loads nothing of A's, and A resumed loads trusted", async () => {
		const { learned, persistence, replaced, learn } = await make()
		await learned.onIdentity("rtl", A, undefined)
		learn(engine(-91))
		await persistence.writeEngine("rtl", engine(-91))
		await learned.onIdentity("rtl", B, A)
		expect(replaced.at(-1)).toEqual({ engine: null, occupancy: null })
		expect((await openLoad(persistence)).state).toBeNull()
		learn(engine(-70))
		await learned.onIdentity("rtl", A, B)
		expect(learned.view("rtl")?.namespaceState).toBe("resumed")
		expect(replaced.at(-1)).toMatchObject({ trusted: true })
		expect(replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(-91)
	})

	it("a strong serial key's own namespace loads trusted", async () => {
		const { store, learned, replaced } = await make()
		await store.writeEngineIn("rtl", STRONG_SERIAL.key, engine(-82))
		await learned.onIdentity("rtl", STRONG_SERIAL, undefined)
		expect(replaced.at(-1)).toMatchObject({ trusted: true })
	})

	it("a weak model key, and a default serial (the same model key), load unverified", async () => {
		for (const identity of [WEAK, DEFAULT_SERIAL]) {
			const { store, learned, persistence, replaced } = await make()
			await store.writeEngineIn("rtl", identity.key, engine(-84))
			await learned.onIdentity("rtl", identity, undefined)
			expect(replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(-84)
			expect(replaced.at(-1)?.trusted).toBeUndefined()
			const open = await openLoad(persistence)
			expect(open.state).not.toBeNull()
			expect(open.trusted).toBe(false)
			// A clean state directory for the next identity (afterEach removes the last one).
			await rm(stateDir, { recursive: true, force: true })
			stateDir = await mkdtemp(join(tmpdir(), "wk-receiver-trust-"))
			scannerDir = join(stateDir, "scanner")
		}
	})

	it("a new namespace loads nothing, so nothing trusted", async () => {
		const { learned, persistence, replaced } = await make()
		await learned.onIdentity("rtl", A, undefined)
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
		expect(replaced.at(-1)).toEqual({ engine: null, occupancy: null })
		expect(await openLoad(persistence)).toEqual({
			state: null,
			trusted: false,
		})
	})

	it("a legacy adoption loads unverified, at the settle and at an engine open", async () => {
		await mkdir(join(scannerDir, "engine"), { recursive: true })
		await writeFile(
			join(scannerDir, "engine", "rtl.json"),
			JSON.stringify(engine(-88)),
		)
		const { learned, persistence, replaced } = await make()
		await learned.onIdentity("rtl", A, undefined)
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(-88)
		expect(replaced.at(-1)?.trusted).toBeUndefined()
		const open = await openLoad(persistence)
		expect(open.state?.absoluteFloors[0]?.dbfs).toBe(-88)
		expect(open.trusted).toBe(false)
	})

	it("a take-over of the weak namespace by a unit key loads unverified", async () => {
		const { learned, persistence, replaced, learn } = await make({
			sdrHostConfigured: true,
		})
		// The weak key learns (no adopter: the sdr-host may still name a unit), then a unit key
		// on the next connection takes its state over.
		await learned.onIdentity("rtl", WEAK, undefined)
		learn(engine(-86))
		await persistence.writeEngine("rtl", engine(-86))
		await learned.onConnection("rtl", "close")
		await learned.onConnection("rtl", "open")
		await learned.onConnection("rtl", "close")
		await learned.onConnection("rtl", "open")
		await learned.onIdentity("rtl", A, WEAK)
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(-86)
		expect(replaced.at(-1)?.trusted).toBeUndefined()
	})

	it("a pending connection (its receiver not settled yet) loads unverified", async () => {
		const { store, learned, persistence } = await make()
		await store.writeEngineIn("rtl", A.key, engine(-80))
		await learned.onIdentity("rtl", A, undefined)
		await learned.onConnection("rtl", "close")
		const open = await openLoad(persistence)
		expect(open.state?.absoluteFloors[0]?.dbfs).toBe(-80)
		expect(open.trusted).toBe(false)
		await learned.onConnection("rtl", "open")
		await learned.onIdentity("rtl", A, A)
		expect((await openLoad(persistence)).trusted).toBe(true)
	})

	it("an untracked source never loads trusted", async () => {
		const { store, persistence } = await make()
		await store.writeEngine("other", engine(-80))
		const state = await persistence.loadEngine("other")
		expect(state).not.toBeNull()
		expect(persistence.engineTrusted?.("other", state as EngineState)).toBe(
			false,
		)
	})
})
