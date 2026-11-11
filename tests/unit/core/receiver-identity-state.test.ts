/**
 * Learned state per receiver on the real ScannerPersistence in a tmp state directory:
 * switching A -> B -> A, an unknown receiver, the one-time adoption of the files from before
 * namespacing, and one INFO line per identity change.
 */
import {
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ScannerPersistence } from "../../../src/core/scanner/store/persistence.js"
import {
	HELD_EXPORTS_MAX,
	RECEIVER_NAMESPACES_FILE_NAME,
	ReceiverLearnedState,
	type LearnedSpectrum,
} from "../../../src/core/receiver-identity-state.js"
import {
	pathSegment,
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
	stateDir = await mkdtemp(join(tmpdir(), "wk-receiver-state-"))
	scannerDir = join(stateDir, "scanner")
})
afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true })
})

const A_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const B_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const HEADER = { magic: "RTL0", tunerType: 5, gainCount: 29 }
const A = resolveReceiverIdentity("rtl", HEADER, { unitId: A_ID })
const B = resolveReceiverIdentity("rtl", HEADER, { unitId: B_ID })
const WEAK = resolveReceiverIdentity("rtl", HEADER, null)
const UNKNOWN = resolveReceiverIdentity("rtl", null, null)

const engine = (dbfs: number): EngineState => ({
	version: 1,
	absoluteFloors: [{ key: "2048000:g:4096", dbfs }],
	spurs: [
		{ key: "2048000:g:4096", basebandBin: 12, widthBins: 2, kind: "baseband" },
	],
	kByRange: [],
})
const occupancy = (bucketHz: number): OccupancyState => ({
	version: 1,
	bucketHz,
	buckets: [],
})

/** The spectrum service's side: what is in memory now, and every replacement it got. */
function fakeSpectrum() {
	let current: {
		engine: EngineState | null
		occupancy: OccupancyState | null
	} = {
		engine: null,
		occupancy: null,
	}
	const replaced: Array<typeof current> = []
	const spectrum: LearnedSpectrum = {
		exportLearnedState: async () => ({ ...current }),
		replaceLearnedState: async (_id, next) => {
			replaced.push(next)
			current = { ...next }
		},
	}
	return {
		spectrum,
		replaced,
		learn: (e: EngineState, o: OccupancyState) => {
			current = { engine: e, occupancy: o }
		},
		now: () => current,
	}
}

function capture() {
	const lines: Array<{ msg?: string; level?: number }> = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, done) {
			for (const line of chunk.toString("utf8").split("\n"))
				if (line.trim() !== "")
					lines.push(JSON.parse(line) as { msg?: string; level?: number })
			done()
		},
	})
	return { logger: pino({ level: "info" }, sink), lines }
}

async function make(logger = silent) {
	const store = new ScannerPersistence({
		dir: scannerDir,
		logger: silent,
		now: Date.now,
	})
	const bound: Array<{ key: string | null; adoptLegacy: boolean }> = []
	const learned = new ReceiverLearnedState({
		stateDir,
		logger,
		tracked: id => id === "rtl",
		onBound: (_id, b) => bound.push(b),
	})
	await learned.load()
	const legacy: SpectrumPersistence = {
		writeEngine: (id, s) => store.writeEngine(id, s),
		loadEngine: id => store.loadEngine(id),
		writeOccupancy: (id, s) => store.writeOccupancy(id, s),
		loadOccupancy: id => store.loadOccupancy(id),
	}
	const persistence = learned.attach(store, legacy, () => true)
	const fake = fakeSpectrum()
	learned.setSpectrum(fake.spectrum)
	return { store, learned, persistence, fake, bound }
}

const nsFile = (id: ReceiverIdentity, name: string) =>
	join(
		scannerDir,
		"engine",
		"receivers",
		pathSegment("rtl"),
		pathSegment(id.key),
		name,
	)

const exists = (path: string) =>
	readFile(path).then(
		() => true,
		() => false,
	)

describe("ReceiverLearnedState: switching receivers", () => {
	it("A -> B -> A: B starts fresh, A resumes its own spur map and floors", async () => {
		const { learned, persistence, fake } = await make()
		await learned.onIdentity("rtl", A, undefined)
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
		fake.learn(engine(-91), occupancy(12_500))
		await persistence.writeEngine("rtl", engine(-91))

		await learned.onIdentity("rtl", B, A)
		// Nothing of A applies to B, and A's latest state went to A's namespace.
		expect(fake.replaced.at(-1)).toEqual({ engine: null, occupancy: null })
		expect(learned.view("rtl")).toMatchObject({
			key: B.key,
			strength: "unit",
			namespaceState: "fresh",
		})
		fake.learn(engine(-70), occupancy(25_000))

		await learned.onIdentity("rtl", A, B)
		expect(learned.view("rtl")?.namespaceState).toBe("resumed")
		expect(fake.replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(-91)
		expect(fake.replaced.at(-1)?.occupancy?.bucketHz).toBe(12_500)
		// B's state is kept under B, A's under A.
		expect(
			JSON.parse(await readFile(nsFile(B, "engine.json"), "utf8")),
		).toMatchObject({ absoluteFloors: [{ dbfs: -70 }] })
		expect(await persistence.loadEngine("rtl")).toMatchObject({
			absoluteFloors: [{ dbfs: -91 }],
		})
		expect(learned.view("rtl")?.learnedStateNamespace).toBe(
			join("engine", "receivers", pathSegment("rtl"), pathSegment(A.key)),
		)
	})

	it("an unknown receiver applies nothing learned and writes nothing under any key", async () => {
		const { learned, persistence, fake } = await make()
		await learned.onIdentity("rtl", A, undefined)
		fake.learn(engine(-91), occupancy(12_500))
		await learned.onIdentity("rtl", UNKNOWN, A)
		expect(fake.replaced.at(-1)).toEqual({ engine: null, occupancy: null })
		expect(learned.view("rtl")).toMatchObject({
			key: "unknown",
			namespaceState: "none",
			learnedStateNamespace: null,
		})
		expect(await persistence.loadEngine("rtl")).toBeNull()
		await persistence.writeEngine("rtl", engine(-50))
		await persistence.writeOccupancy("rtl", occupancy(1))
		const dirs = await readdir(
			join(scannerDir, "engine", "receivers", pathSegment("rtl")),
		)
		expect(dirs).toEqual([pathSegment(A.key)])
		// The unknown period wrote nothing over A: it still holds what A learned.
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toMatchObject({ absoluteFloors: [{ dbfs: -91 }] })
	})

	it("an untracked source keeps the un-namespaced files exactly as before", async () => {
		const { persistence } = await make()
		await persistence.writeEngine("other", engine(-80))
		expect(
			await exists(
				join(scannerDir, "engine", `${encodeURIComponent("other")}.json`),
			),
		).toBe(true)
		expect(await persistence.loadEngine("other")).toMatchObject({
			absoluteFloors: [{ dbfs: -80 }],
		})
	})
})

describe("ReceiverLearnedState: one-time adoption of the files from before namespacing", () => {
	it("the first receiver identified adopts them; the next one starts fresh; a restart resumes", async () => {
		await mkdir(join(scannerDir, "engine", "occupancy"), { recursive: true })
		await writeFile(
			join(scannerDir, "engine", "rtl.json"),
			JSON.stringify(engine(-88)),
		)
		await writeFile(
			join(scannerDir, "engine", "occupancy", "rtl.json"),
			JSON.stringify(occupancy(12_500)),
		)
		const first = await make()
		await first.learned.onIdentity("rtl", A, undefined)
		expect(first.learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(first.bound.at(-1)).toEqual({
			key: A.key,
			adoptLegacy: true,
			legacyRecorded: true,
		})
		expect(first.fake.replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(
			-88,
		)
		// Copied, not moved: an older image rolled back still reads the originals.
		expect(
			JSON.parse(
				await readFile(join(scannerDir, "engine", "rtl.json"), "utf8"),
			),
		).toEqual(engine(-88))
		expect(
			JSON.parse(
				await readFile(
					join(scannerDir, "engine", "occupancy", "rtl.json"),
					"utf8",
				),
			),
		).toEqual(occupancy(12_500))
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toEqual(engine(-88))
		expect(await exists(nsFile(A, "occupancy.json"))).toBe(true)

		// A legacy file appearing later (an older core wrote it) is never adopted by another receiver.
		await writeFile(
			join(scannerDir, "engine", "rtl.json"),
			JSON.stringify(engine(-10)),
		)
		await first.learned.onIdentity("rtl", B, A)
		expect(first.learned.view("rtl")?.namespaceState).toBe("fresh")
		expect(first.bound.at(-1)).toEqual({ key: B.key, adoptLegacy: false })
		expect(first.fake.replaced.at(-1)).toEqual({
			engine: null,
			occupancy: null,
		})

		// A restart reads the record: A resumes, not adopted again.
		const record = JSON.parse(
			await readFile(join(stateDir, RECEIVER_NAMESPACES_FILE_NAME), "utf8"),
		) as { sources: Array<{ adoptedBy: string; keys: string[] }> }
		expect(record.sources[0]).toMatchObject({
			adoptedBy: A.key,
			keys: [A.key, B.key],
		})
		const second = await make()
		await second.learned.onIdentity("rtl", A, undefined)
		expect(second.learned.view("rtl")?.namespaceState).toBe("resumed")
		expect(second.bound.at(-1)).toEqual({ key: A.key, adoptLegacy: false })
		expect(second.fake.replaced.at(-1)?.engine?.absoluteFloors[0]?.dbfs).toBe(
			-88,
		)
	})

	it("an invalid record file reads as empty (every receiver new), with nothing echoed", async () => {
		await writeFile(
			join(stateDir, RECEIVER_NAMESPACES_FILE_NAME),
			JSON.stringify({
				version: 1,
				sources: [{ sourceId: "rtl", adoptedBy: "../../x", keys: [] }],
			}),
		)
		const { logger, lines } = capture()
		const { learned } = await make(logger)
		expect(lines.some(l => JSON.stringify(l).includes("../../x"))).toBe(false)
		await learned.onIdentity("rtl", A, undefined)
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
	})
})

describe("ReceiverLearnedState: the pending window of a reconnect", () => {
	it("a boundary writes the state so far under the old key and keeps it applied read-only until the settle", async () => {
		const { learned, persistence, fake, bound } = await make()
		await learned.onIdentity("rtl", A, undefined)
		const swaps = fake.replaced.length
		fake.learn(engine(-91), occupancy(12_500))
		await learned.onConnection("rtl")
		// A's latest state went under A; memory keeps it (no swap); the tuner is unbound.
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toMatchObject({ absoluteFloors: [{ dbfs: -91 }] })
		expect(fake.replaced).toHaveLength(swaps)
		expect(bound.at(-1)).toEqual({ key: null, adoptLegacy: false })
		const aBytes = await readFile(nsFile(A, "engine.json"))
		// Read-only: loads read A, writes are dropped.
		expect(await persistence.loadEngine("rtl")).toMatchObject({
			absoluteFloors: [{ dbfs: -91 }],
		})
		await persistence.writeEngine("rtl", engine(-50))
		await persistence.writeOccupancy("rtl", occupancy(1))
		expect(await readFile(nsFile(A, "engine.json"))).toEqual(aBytes)
		// A second boundary before any settle exports nothing: memory now holds the unsettled
		// connection's learning.
		fake.learn(engine(-50), occupancy(1))
		await learned.onConnection("rtl")
		expect(await readFile(nsFile(A, "engine.json"))).toEqual(aBytes)
		await learned.onIdentity("rtl", B, A)
		expect(await readFile(nsFile(A, "engine.json"))).toEqual(aBytes)
		expect(await exists(nsFile(B, "engine.json"))).toBe(false)
		// Another receiver: swapped to B's own (nothing yet).
		expect(fake.replaced.at(-1)).toEqual({ engine: null, occupancy: null })
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
	})

	it("the same key settled again after a reconnect: no swap, the state learned meanwhile kept", async () => {
		const { learned, persistence, fake } = await make()
		await learned.onIdentity("rtl", A, undefined)
		const swaps = fake.replaced.length
		fake.learn(engine(-91), occupancy(12_500))
		await learned.onConnection("rtl")
		await learned.onConnection("rtl")
		fake.learn(engine(-92), occupancy(12_500))
		await learned.onIdentity("rtl", A, A)
		expect(fake.replaced).toHaveLength(swaps)
		expect(fake.now().engine?.absoluteFloors[0]?.dbfs).toBe(-92)
		expect(learned.view("rtl")?.namespaceState).toBe("resumed")
		// Writable again under A once settled.
		await persistence.writeEngine(
			"rtl",
			engine(-92),
			persistence.generation?.("rtl"),
		)
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toMatchObject({ absoluteFloors: [{ dbfs: -92 }] })
	})

	it("an sdr-host restart (new receiverId, same unitId) resumes the same namespace without a swap", async () => {
		const { learned, fake } = await make()
		const before = resolveReceiverIdentity("rtl", HEADER, {
			unitId: A_ID,
			receiverId: "1".repeat(32),
		})
		const after = resolveReceiverIdentity("rtl", HEADER, {
			unitId: A_ID,
			receiverId: "2".repeat(32),
		})
		await learned.onIdentity("rtl", before, undefined)
		const ns = learned.view("rtl")?.learnedStateNamespace
		const swaps = fake.replaced.length
		fake.learn(engine(-91), occupancy(12_500))
		await learned.onConnection("rtl")
		await learned.onIdentity("rtl", after, before)
		expect(learned.view("rtl")).toMatchObject({
			key: A.key,
			namespaceState: "resumed",
			learnedStateNamespace: ns,
		})
		expect(fake.replaced).toHaveLength(swaps)
		expect(fake.now().engine?.absoluteFloors[0]?.dbfs).toBe(-91)
	})

	it("a settle from before a newer boundary binds nothing: the newer connection's settle does", async () => {
		const { learned, persistence, fake } = await make()
		await learned.onIdentity("rtl", A, undefined)
		fake.learn(engine(-91), occupancy(12_500))
		void learned.onConnection("rtl")
		const stale = learned.onIdentity("rtl", B, A)
		void learned.onConnection("rtl")
		await stale
		await learned.idle("rtl")
		expect(learned.view("rtl")?.key).toBe(A.key)
		await learned.onIdentity("rtl", A, A)
		expect(learned.view("rtl")?.namespaceState).toBe("resumed")
		expect(await persistence.loadEngine("rtl")).toMatchObject({
			absoluteFloors: [{ dbfs: -91 }],
		})
	})

	it("the same receiver reconnecting is logged as a reconnect, not a change", async () => {
		const { logger, lines } = capture()
		const { learned } = await make(logger)
		await learned.onIdentity("rtl", A, undefined)
		await learned.onConnection("rtl")
		await learned.onIdentity("rtl", A, A)
		expect(
			lines.filter(l => l.msg?.startsWith("Receiver changed:")),
		).toHaveLength(1)
		expect(
			lines.some(
				l => l.msg === `Receiver reconnected: ${A.key}; learned state resumed`,
			),
		).toBe(true)
	})
})

describe("ReceiverLearnedState: operator visibility", () => {
	it("logs one INFO line per identity change", async () => {
		const { logger, lines } = capture()
		const { learned } = await make(logger)
		await learned.onIdentity("rtl", A, undefined)
		await learned.onIdentity("rtl", B, A)
		await learned.onIdentity("rtl", A, B)
		const changes = lines.filter(l => l.msg?.startsWith("Receiver changed:"))
		expect(changes.map(l => l.msg)).toEqual([
			`Receiver changed: none -> ${A.key}; learned state fresh`,
			`Receiver changed: ${A.key} -> ${B.key}; learned state fresh`,
			`Receiver changed: ${B.key} -> ${A.key}; learned state resumed`,
		])
		expect(changes.every(l => l.level === 30)).toBe(true)
	})

	it("a model identity is logged as weak", async () => {
		const { logger, lines } = capture()
		const { learned } = await make(logger)
		await learned.onIdentity("rtl", WEAK, undefined)
		expect(
			lines.some(l => l.msg?.startsWith("Receiver identified by model only")),
		).toBe(true)
	})
})

describe("ReceiverLearnedState: adoption owed while the store cannot take it", () => {
	const writeLegacy = async () => {
		await mkdir(join(scannerDir, "engine", "occupancy"), { recursive: true })
		await writeFile(
			join(scannerDir, "engine", "rtl.json"),
			JSON.stringify(engine(-88)),
		)
		await writeFile(
			join(scannerDir, "engine", "occupancy", "rtl.json"),
			JSON.stringify(occupancy(12_500)),
		)
	}
	const readRecord = async () =>
		(
			JSON.parse(
				await readFile(join(stateDir, RECEIVER_NAMESPACES_FILE_NAME), "utf8"),
			) as {
				sources: Array<{ adoptedBy: string; keys: string[]; owed?: string[] }>
			}
		).sources[0]

	it("attach() never called, then called: A adopts the gain at once and its spectrum files later; B never gets A's", async () => {
		await writeLegacy()
		const store = new ScannerPersistence({
			dir: scannerDir,
			logger: silent,
			now: Date.now,
		})
		const bound: Array<{ key: string | null; adoptLegacy: boolean }> = []
		const learned = new ReceiverLearnedState({
			stateDir,
			logger: silent,
			tracked: id => id === "rtl",
			onBound: (_id, b) => bound.push(b),
		})
		await learned.load()
		const fake = fakeSpectrum()
		learned.setSpectrum(fake.spectrum)

		// The scanner is off: A is the adopter of record; its gain is adopted now.
		await learned.onIdentity("rtl", A, undefined)
		expect(bound.at(-1)).toEqual({
			key: A.key,
			adoptLegacy: true,
			legacyRecorded: true,
		})
		expect(learned.view("rtl")).toMatchObject({
			namespaceState: "fresh",
			learnedStateNamespace: null,
		})
		expect(await readRecord()).toEqual({
			sourceId: "rtl",
			adoptedBy: A.key,
			keys: [A.key],
			owed: ["spectrum"],
		})

		// B, before and after the store appears: never A's gain, never A's files.
		await learned.onIdentity("rtl", B, A)
		expect(bound.at(-1)).toEqual({ key: B.key, adoptLegacy: false })
		const legacy: SpectrumPersistence = {
			writeEngine: (id, s) => store.writeEngine(id, s),
			loadEngine: id => store.loadEngine(id),
			writeOccupancy: (id, s) => store.writeOccupancy(id, s),
			loadOccupancy: id => store.loadOccupancy(id),
		}
		const persistence = learned.attach(store, legacy, () => true)
		await learned.idle("rtl")
		expect(await exists(nsFile(B, "engine.json"))).toBe(false)
		expect(await persistence.loadEngine("rtl")).toBeNull()
		await persistence.writeEngine("rtl", engine(-70))
		expect(
			JSON.parse(await readFile(nsFile(B, "engine.json"), "utf8")),
		).toEqual(engine(-70))

		// A again, with the store: the files it is owed, for A only, handed to the engine.
		await learned.onIdentity("rtl", A, B)
		await learned.idle("rtl")
		expect(bound.at(-1)).toEqual({ key: A.key, adoptLegacy: false })
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toEqual(engine(-88))
		expect(fake.now().engine?.absoluteFloors[0]?.dbfs).toBe(-88)
		expect(
			JSON.parse(await readFile(nsFile(B, "engine.json"), "utf8")),
		).toEqual(engine(-70))
		expect((await readRecord())?.owed).toBeUndefined()
	})

	it("attach() while the adopter is bound adopts its files then", async () => {
		await writeLegacy()
		const store = new ScannerPersistence({
			dir: scannerDir,
			logger: silent,
			now: Date.now,
		})
		const learned = new ReceiverLearnedState({
			stateDir,
			logger: silent,
			tracked: id => id === "rtl",
		})
		await learned.load()
		const fake = fakeSpectrum()
		learned.setSpectrum(fake.spectrum)
		await learned.onIdentity("rtl", A, undefined)
		learned.attach(store, store, () => true)
		await learned.idle("rtl")
		expect(learned.view("rtl")).toMatchObject({
			namespaceState: "adopted",
			learnedStateNamespace: join(
				"engine",
				"receivers",
				pathSegment("rtl"),
				pathSegment(A.key),
			),
		})
		expect(fake.now().engine?.absoluteFloors[0]?.dbfs).toBe(-88)
	})

	it("a store not writable yet: writes are dropped, and the first write once it is adopts first", async () => {
		await writeLegacy()
		const store = new ScannerPersistence({
			dir: scannerDir,
			logger: silent,
			now: Date.now,
		})
		const learned = new ReceiverLearnedState({
			stateDir,
			logger: silent,
			tracked: id => id === "rtl",
		})
		await learned.load()
		let writable = false
		const persistence = learned.attach(store, store, () => writable)
		const fake = fakeSpectrum()
		learned.setSpectrum(fake.spectrum)
		await learned.onIdentity("rtl", A, undefined)
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
		await persistence.writeEngine("rtl", engine(-1))
		expect(await exists(nsFile(A, "engine.json"))).toBe(false)

		writable = true
		// The fresh in-memory state never lands over the adopted files.
		await persistence.writeEngine("rtl", engine(-1))
		await learned.idle("rtl")
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toEqual(engine(-88))
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(fake.now().engine?.absoluteFloors[0]?.dbfs).toBe(-88)
		await persistence.writeEngine("rtl", engine(-5))
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toEqual(engine(-5))
	})

	it("a record without an adopter: the first eligible receiver adopts; key forms of earlier builds are dropped", async () => {
		await writeLegacy()
		await writeFile(
			join(stateDir, RECEIVER_NAMESPACES_FILE_NAME),
			JSON.stringify({
				version: 1,
				sources: [
					{
						sourceId: "rtl",
						adoptedBy: `sdrhost:${"c".repeat(32)}`,
						keys: [`sdrhost:${"c".repeat(32)}`, "model:5:29", A.key],
					},
				],
			}),
		)
		const { learned, bound } = await make()
		await learned.onIdentity("rtl", B, undefined)
		expect(bound.at(-1)).toEqual({
			key: B.key,
			adoptLegacy: true,
			legacyRecorded: true,
		})
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(await readRecord()).toEqual({
			sourceId: "rtl",
			adoptedBy: B.key,
			keys: [A.key, B.key],
		})
	})

	it("a failed record write says so: the tuner keeps the record from before namespacing", async () => {
		const learned = new ReceiverLearnedState({
			stateDir,
			logger: silent,
			tracked: id => id === "rtl",
			onBound: (_id, b) => bound.push(b),
			fs: {
				readFile: () =>
					Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })),
				atomicWrite: () => Promise.reject(new Error("disk full")),
			},
		})
		const bound: Array<{ key: string | null; adoptLegacy: boolean }> = []
		await learned.load()
		await learned.onIdentity("rtl", A, undefined)
		expect(bound.at(-1)).toEqual({
			key: A.key,
			adoptLegacy: true,
			legacyRecorded: false,
		})
	})
})

describe("ReceiverLearnedState: a write started before a switch", () => {
	it("is dropped when the binding generation it captured is no longer current", async () => {
		const { learned, persistence } = await make()
		await learned.onIdentity("rtl", A, undefined)
		const before = persistence.generation?.("rtl")
		expect(before).toBeTypeOf("number")
		await learned.onIdentity("rtl", B, A)
		await persistence.writeEngine("rtl", engine(-91), before)
		await persistence.writeOccupancy("rtl", occupancy(12_500), before)
		expect(await exists(nsFile(B, "engine.json"))).toBe(false)
		expect(await exists(nsFile(B, "occupancy.json"))).toBe(false)
		await persistence.writeEngine(
			"rtl",
			engine(-60),
			persistence.generation?.("rtl"),
		)
		expect(
			JSON.parse(await readFile(nsFile(B, "engine.json"), "utf8")),
		).toEqual(engine(-60))
	})
})

describe("ReceiverLearnedState: a persist started during the swap (fence)", () => {
	it("a write with the generation read while the engine state was being replaced is dropped", async () => {
		const { learned, persistence, fake } = await make()
		await learned.onIdentity("rtl", A, undefined)
		fake.learn(engine(-91), occupancy(12_500))
		let midSwap: number | undefined
		const replace = fake.spectrum.replaceLearnedState
		fake.spectrum.replaceLearnedState = async (id, next) => {
			// A persist starting now captures the generation, then exports the outgoing state.
			midSwap = persistence.generation?.("rtl")
			await replace(id, next)
		}
		await learned.onIdentity("rtl", B, A)
		expect(midSwap).toBeTypeOf("number")
		await persistence.writeEngine("rtl", engine(-91), midSwap)
		expect(await exists(nsFile(B, "engine.json"))).toBe(false)
		await persistence.writeEngine(
			"rtl",
			engine(-60),
			persistence.generation?.("rtl"),
		)
		expect(
			JSON.parse(await readFile(nsFile(B, "engine.json"), "utf8")),
		).toEqual(engine(-60))
	})
})

describe("ReceiverLearnedState: who adopts the state from before namespacing", () => {
	const writeLegacy = async () => {
		await mkdir(join(scannerDir, "engine", "occupancy"), { recursive: true })
		await writeFile(
			join(scannerDir, "engine", "rtl.json"),
			JSON.stringify(engine(-88)),
		)
	}
	async function makeWith(
		sdrHostConfigured: () => boolean,
		sdrHostAwaited?: () => boolean,
	) {
		const store = new ScannerPersistence({
			dir: scannerDir,
			logger: silent,
			now: Date.now,
		})
		const bound: Array<{
			key: string | null
			adoptLegacy: boolean
			takeOverFrom?: string
		}> = []
		const learned = new ReceiverLearnedState({
			stateDir,
			logger: silent,
			tracked: id => id === "rtl",
			onBound: (_id, b) => bound.push(b),
			sdrHostConfigured,
			...(sdrHostAwaited ? { sdrHostAwaited } : {}),
		})
		await learned.load()
		const persistence = learned.attach(store, store, () => true)
		const fake = fakeSpectrum()
		learned.setSpectrum(fake.spectrum)
		return { learned, persistence, fake, bound }
	}

	it("with an sdr-host, the header-only key never adopts: it waits for the stable key", async () => {
		await writeLegacy()
		const { learned, persistence, fake, bound } = await makeWith(() => true)
		await learned.onIdentity("rtl", WEAK, undefined)
		expect(bound.at(-1)).toEqual({ key: WEAK.key, adoptLegacy: false })
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
		expect(await exists(nsFile(WEAK, "engine.json"))).toBe(false)
		// The weak key learns in its own namespace meanwhile.
		await persistence.writeEngine(
			"rtl",
			engine(-70),
			persistence.generation?.("rtl"),
		)
		expect(
			JSON.parse(await readFile(nsFile(WEAK, "engine.json"), "utf8")),
		).toEqual(engine(-70))
		// The stable answer (an upgrade within the connection): the legacy state is adopted.
		fake.learn(engine(-70), occupancy(12_500))
		await learned.onIdentity("rtl", A, WEAK)
		expect(bound.at(-1)).toMatchObject({ key: A.key, adoptLegacy: true })
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(fake.now().engine).toEqual(engine(-88))
		const record = JSON.parse(
			await readFile(join(stateDir, RECEIVER_NAMESPACES_FILE_NAME), "utf8"),
		) as { sources: Array<{ adoptedBy: string | null }> }
		expect(record.sources[0]?.adoptedBy).toBe(A.key)
	})

	it("without an sdr-host, the source-scoped key adopts", async () => {
		await writeLegacy()
		const { learned, fake, bound } = await makeWith(() => false)
		await learned.onIdentity("rtl", WEAK, undefined)
		expect(bound.at(-1)).toMatchObject({ key: WEAK.key, adoptLegacy: true })
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(fake.now().engine).toEqual(engine(-88))
	})

	it("an awaited sdr-host that never answers: the bound weak key adopts at the recheck, once", async () => {
		await writeLegacy()
		let awaited = true
		const { learned, fake, bound } = await makeWith(() => awaited)
		await learned.onIdentity("rtl", WEAK, undefined)
		expect(bound.at(-1)).toEqual({ key: WEAK.key, adoptLegacy: false })
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
		// Still awaited: a recheck changes nothing.
		await learned.recheckAdoption("rtl")
		expect(bound).toHaveLength(1)
		// Given up (failed polls, never answered): the weak key adopts now, within its connection.
		awaited = false
		const swaps = fake.replaced.length
		await learned.recheckAdoption("rtl")
		expect(bound.at(-1)).toMatchObject({ key: WEAK.key, adoptLegacy: true })
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(fake.replaced).toHaveLength(swaps + 1)
		expect(fake.now().engine).toEqual(engine(-88))
		const record = JSON.parse(
			await readFile(join(stateDir, RECEIVER_NAMESPACES_FILE_NAME), "utf8"),
		) as { sources: Array<{ adoptedBy: string | null }> }
		expect(record.sources[0]?.adoptedBy).toBe(WEAK.key)
		// Once: a later recheck binds nothing again.
		await learned.recheckAdoption("rtl")
		expect(bound).toHaveLength(2)
	})

	it("while the sdr-host is awaited the weak key takes no writes, so the recheck still adopts the legacy state", async () => {
		await writeLegacy()
		let awaited = true
		const { learned, persistence, fake } = await makeWith(
			() => awaited,
			() => awaited,
		)
		await learned.onIdentity("rtl", WEAK, undefined)
		// A persist in the awaited window (also a stop's final write) is dropped; reads still work.
		await persistence.writeEngine(
			"rtl",
			engine(-70),
			persistence.generation?.("rtl"),
		)
		await persistence.writeOccupancy(
			"rtl",
			occupancy(12_500),
			persistence.generation?.("rtl"),
		)
		expect(await exists(nsFile(WEAK, "engine.json"))).toBe(false)
		expect(await exists(nsFile(WEAK, "occupancy.json"))).toBe(false)
		expect(await persistence.loadEngine("rtl")).toBeNull()
		// Given up: the recheck copies the legacy spectrum into the still-empty namespace.
		awaited = false
		await learned.recheckAdoption("rtl")
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(fake.now().engine).toEqual(engine(-88))
		expect(
			JSON.parse(await readFile(nsFile(WEAK, "engine.json"), "utf8")),
		).toEqual(engine(-88))
		// Adopted: writes go to the namespace again.
		await persistence.writeEngine(
			"rtl",
			engine(-66),
			persistence.generation?.("rtl"),
		)
		expect(
			JSON.parse(await readFile(nsFile(WEAK, "engine.json"), "utf8")),
		).toEqual(engine(-66))
	})

	it("a recheck while a connection is pending does nothing (its settle decides)", async () => {
		await writeLegacy()
		let awaited = true
		const { learned, bound } = await makeWith(() => awaited)
		await learned.onIdentity("rtl", WEAK, undefined)
		void learned.onConnection("rtl")
		awaited = false
		await learned.recheckAdoption("rtl")
		// Only the boundary's suspension (nothing applies until the settle), no adoption.
		expect(bound).toEqual([
			{ key: WEAK.key, adoptLegacy: false },
			{ key: null, adoptLegacy: false },
		])
		// The next settle adopts (the sdr-host is no longer awaited).
		await learned.onIdentity("rtl", WEAK, WEAK)
		expect(bound.at(-1)).toMatchObject({ key: WEAK.key, adoptLegacy: true })
	})

	it("a recheck never makes a stable-key source adopt with an sdr-host that answered", async () => {
		await writeLegacy()
		const { learned, bound } = await makeWith(() => true)
		await learned.onIdentity("rtl", WEAK, undefined)
		await learned.recheckAdoption("rtl")
		expect(bound).toEqual([{ key: WEAK.key, adoptLegacy: false }])
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
	})

	it("a stable key arriving later takes over the weak namespace once (same model), without a swap within the connection", async () => {
		await writeLegacy()
		let sdrHost = false
		const { learned, fake, bound } = await makeWith(() => sdrHost)
		// No sdr-host answered yet: the weak key adopted the legacy state, then learned on.
		await learned.onIdentity("rtl", WEAK, undefined)
		fake.learn(engine(-75), occupancy(12_500))
		const swaps = fake.replaced.length
		// The sdr-host answers within the connection: A is new, the legacy state is taken.
		sdrHost = true
		await learned.onIdentity("rtl", A, WEAK)
		expect(bound.at(-1)).toEqual({
			key: A.key,
			adoptLegacy: false,
			takeOverFrom: WEAK.key,
		})
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
		// The engine already runs on the weak key's state: kept, no swap.
		expect(fake.replaced).toHaveLength(swaps)
		expect(fake.now().engine).toEqual(engine(-75))
		// The weak namespace got its state under its own key, untouched since.
		expect(
			JSON.parse(await readFile(nsFile(WEAK, "engine.json"), "utf8")),
		).toEqual(engine(-75))

		// Another unit of the same model later: the weak key was taken over already.
		await learned.onConnection("rtl")
		await learned.onIdentity("rtl", B, A)
		expect(bound.at(-1)).toEqual({ key: B.key, adoptLegacy: false })
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
		expect(fake.now()).toEqual({ engine: null, occupancy: null })
	})

	it("a stable key after a reconnect keeps the weak state applied (no swap); after a restart it loads it from the store", async () => {
		let sdrHost = false
		const first = await makeWith(() => sdrHost)
		await first.learned.onIdentity("rtl", WEAK, undefined)
		first.fake.learn(engine(-77), occupancy(12_500))
		await first.learned.onConnection("rtl")
		const swaps = first.fake.replaced.length
		sdrHost = true
		await first.learned.onIdentity("rtl", A, WEAK)
		expect(first.learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(first.fake.replaced).toHaveLength(swaps)
		expect(first.fake.now().engine).toEqual(engine(-77))

		// Another core start whose first identity is a new stable key of that model.
		await rm(join(stateDir, RECEIVER_NAMESPACES_FILE_NAME))
		const second = await makeWith(() => false)
		await second.learned.onIdentity("rtl", WEAK, undefined)
		await second.learned.onConnection("rtl")
		await second.learned.onIdentity("rtl", UNKNOWN, WEAK)
		await second.learned.onConnection("rtl")
		await second.learned.onIdentity("rtl", B, UNKNOWN)
		expect(second.learned.view("rtl")?.namespaceState).toBe("adopted")
		expect(second.fake.replaced.at(-1)?.engine).toEqual(engine(-77))
	})
})

describe("ReceiverLearnedState: an export the store cannot take yet", () => {
	async function makeGated() {
		const store = new ScannerPersistence({
			dir: scannerDir,
			logger: silent,
			now: Date.now,
		})
		const learned = new ReceiverLearnedState({
			stateDir,
			logger: silent,
			tracked: id => id === "rtl",
		})
		await learned.load()
		const gate = { writable: false }
		const persistence = learned.attach(store, store, () => gate.writable)
		const fake = fakeSpectrum()
		learned.setSpectrum(fake.spectrum)
		return { learned, persistence, fake, gate }
	}

	it("is held in memory under its receiver and written once the store is writable", async () => {
		const { learned, persistence, fake, gate } = await makeGated()
		await learned.onIdentity("rtl", A, undefined)
		fake.learn(engine(-91), occupancy(12_500))
		await learned.onIdentity("rtl", B, A)
		// B runs on its own state; A's was not written (gated) and is not lost.
		expect(fake.now()).toEqual({ engine: null, occupancy: null })
		expect(await exists(nsFile(A, "engine.json"))).toBe(false)
		gate.writable = true
		// Any write attempt once writable flushes the held export first.
		await persistence.writeEngine(
			"rtl",
			engine(-60),
			persistence.generation?.("rtl"),
		)
		await learned.idle("rtl")
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toEqual(engine(-91))
		expect(
			JSON.parse(await readFile(nsFile(A, "occupancy.json"), "utf8")),
		).toEqual(occupancy(12_500))
		expect(
			JSON.parse(await readFile(nsFile(B, "engine.json"), "utf8")),
		).toEqual(engine(-60))
	})

	it("binding that receiver again before then resumes from the held state", async () => {
		const { learned, persistence, fake, gate } = await makeGated()
		await learned.onIdentity("rtl", A, undefined)
		fake.learn(engine(-91), occupancy(12_500))
		await learned.onIdentity("rtl", B, A)
		fake.learn(engine(-70), occupancy(12_500))
		await learned.onIdentity("rtl", A, B)
		expect(fake.now().engine).toEqual(engine(-91))
		gate.writable = true
		// The first write once writable runs A's owed adoption (no legacy files: nothing moves,
		// the engine keeps A's resumed state) and the held flush.
		await persistence.writeEngine(
			"rtl",
			engine(-92),
			persistence.generation?.("rtl"),
		)
		await learned.idle("rtl")
		expect(fake.now().engine).toEqual(engine(-91))
		await persistence.writeEngine(
			"rtl",
			engine(-92),
			persistence.generation?.("rtl"),
		)
		// A's state is the engine's again (written by the persist); B's held one is written now.
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toEqual(engine(-92))
		expect(
			JSON.parse(await readFile(nsFile(B, "engine.json"), "utf8")),
		).toEqual(engine(-70))
	})

	it(`holds at most HELD_EXPORTS_MAX receivers per source, the oldest dropped`, async () => {
		const { learned, persistence, fake, gate } = await makeGated()
		const ids = ["1", "2", "3", "4", "5", "6"].map(c =>
			resolveReceiverIdentity("rtl", HEADER, { unitId: c.repeat(32) }),
		)
		let previous: ReceiverIdentity | undefined
		for (const [i, id] of ids.entries()) {
			await learned.onIdentity("rtl", id, previous)
			fake.learn(engine(-50 - i), occupancy(12_500))
			previous = id
		}
		// Held: ids 1..4 (exported when leaving them); id 0 dropped past the bound of 4.
		gate.writable = true
		await persistence.writeEngine(
			"rtl",
			engine(-1),
			persistence.generation?.("rtl"),
		)
		await learned.idle("rtl")
		expect(HELD_EXPORTS_MAX).toBe(4)
		expect(await exists(nsFile(ids[0]!, "engine.json"))).toBe(false)
		for (const i of [1, 2, 3, 4])
			expect(
				JSON.parse(await readFile(nsFile(ids[i]!, "engine.json"), "utf8")),
			).toEqual(engine(-50 - i))
	})
})
