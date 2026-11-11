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
const A = resolveReceiverIdentity(HEADER, { receiverId: A_ID })
const B = resolveReceiverIdentity(HEADER, { receiverId: B_ID })
const UNKNOWN = resolveReceiverIdentity(null, null)

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
	it("a boundary writes the state so far under the old key, then reads and writes nothing until the settle", async () => {
		const { learned, persistence, fake, bound } = await make()
		await learned.onIdentity("rtl", A, undefined)
		fake.learn(engine(-91), occupancy(12_500))
		await learned.onConnection("rtl")
		// A's latest state went under A; memory is fresh; the tuner is unbound too.
		expect(
			JSON.parse(await readFile(nsFile(A, "engine.json"), "utf8")),
		).toMatchObject({ absoluteFloors: [{ dbfs: -91 }] })
		expect(fake.replaced.at(-1)).toEqual({ engine: null, occupancy: null })
		expect(bound.at(-1)).toEqual({ key: null, adoptLegacy: false })
		const aBytes = await readFile(nsFile(A, "engine.json"))
		expect(await persistence.loadEngine("rtl")).toBeNull()
		expect(await persistence.loadOccupancy("rtl")).toBeNull()
		await persistence.writeEngine("rtl", engine(-50))
		await persistence.writeOccupancy("rtl", occupancy(1))
		expect(await readFile(nsFile(A, "engine.json"))).toEqual(aBytes)
		// A second boundary (disconnect, then connect) is idempotent: nothing exported again.
		fake.learn(engine(-50), occupancy(1))
		await learned.onConnection("rtl")
		expect(await readFile(nsFile(A, "engine.json"))).toEqual(aBytes)
		await learned.onIdentity("rtl", B, A)
		expect(await readFile(nsFile(A, "engine.json"))).toEqual(aBytes)
		expect(await exists(nsFile(B, "engine.json"))).toBe(false)
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
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
		expect(await persistence.loadEngine("rtl")).toBeNull()
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
		await learned.onIdentity(
			"rtl",
			resolveReceiverIdentity(HEADER, null),
			undefined,
		)
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

	it("a record from before this rule (receivers, no adopter) owes everything to its first receiver", async () => {
		await writeLegacy()
		await writeFile(
			join(stateDir, RECEIVER_NAMESPACES_FILE_NAME),
			JSON.stringify({
				version: 1,
				sources: [{ sourceId: "rtl", adoptedBy: null, keys: [A.key] }],
			}),
		)
		const { learned, bound } = await make()
		await learned.onIdentity("rtl", B, undefined)
		expect(bound.at(-1)).toEqual({ key: B.key, adoptLegacy: false })
		expect(learned.view("rtl")?.namespaceState).toBe("fresh")
		await learned.onIdentity("rtl", A, B)
		expect(bound.at(-1)).toEqual({
			key: A.key,
			adoptLegacy: true,
			legacyRecorded: true,
		})
		expect(learned.view("rtl")?.namespaceState).toBe("adopted")
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
