/**
 * Learned state per receiver (lane RS) through the REAL SpectrumService and SpectrumEngine, on the
 * real ScannerPersistence in a tmp state directory: the pending window between a reconnect and the
 * next identity (persists and engine opens inside it), and an identity switch while an engine is
 * still opening. Only the pipeline host is a test double (it reports the state it was built from,
 * or what the test says it learned since).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../src/config.js"
import { ScannerPersistence } from "../../../src/core/scanner/store/persistence.js"
import {
	ReceiverLearnedState,
	type ReceiverScopedStore,
} from "../../../src/core/receiver-identity-state.js"
import {
	pathSegment,
	resolveReceiverIdentity,
	type ReceiverIdentity,
} from "../../../src/core/receiver-identity.js"
import { SpectrumService } from "../../../src/core/spectrum/spectrum-service.js"
import { DEFAULT_TUNING } from "../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../src/core/spectrum/pipeline-host.js"
import type {
	EngineState,
	PipelineConfig,
	PipelineInput,
} from "../../../src/core/spectrum/types.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	testSettings,
} from "../../mocks/scanner/engine-fakes.js"

const silent = pino({ level: "silent" })
let stateDir: string
let scannerDir: string
beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "wk-receiver-spectrum-"))
	scannerDir = join(stateDir, "scanner")
})
afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true })
})

const HEADER = { magic: "RTL0", tunerType: 5, gainCount: 29 }
const A = resolveReceiverIdentity(HEADER, {
	receiverId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
})
const B = resolveReceiverIdentity(HEADER, {
	receiverId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
})

const learnedState = (dbfs: number): EngineState => ({
	version: 1,
	absoluteFloors: [{ key: "2048000:g:4096", dbfs }],
	spurs: [
		{ key: "2048000:g:4096", basebandBin: 12, widthBins: 2, kind: "baseband" },
	],
	kByRange: [],
})
const floorOf = (s: EngineState | undefined | null) =>
	s?.absoluteFloors[0]?.dbfs ?? null

/** A pipeline host that exports the state it was built from, or what it "learned" since. */
class StateHost implements PipelineHost {
	learned: EngineState | undefined
	constructor(
		readonly cfg: PipelineConfig,
		readonly handlers: PipelineHostHandlers,
	) {
		this.learned = cfg.persistedEngine
	}
	send(_input: PipelineInput, transfer?: ArrayBuffer): void {
		if (transfer) this.handlers.buffer(transfer)
	}
	exportState(): Promise<EngineState> {
		return Promise.resolve(
			this.learned ?? {
				version: 1,
				absoluteFloors: [],
				spurs: [],
				kByRange: [],
			},
		)
	}
	close(): Promise<void> {
		return Promise.resolve()
	}
	utilization(): number | null {
		return null
	}
}

const waitFor = async (check: () => boolean, ms = 5_000) => {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

function gate() {
	let open!: () => void
	const promise = new Promise<void>(resolve => (open = resolve))
	return { promise, open }
}

async function make() {
	const real = new ScannerPersistence({
		dir: scannerDir,
		logger: silent,
		now: Date.now,
	})
	// The real store; the first namespaced engine read can be held to keep an open in flight.
	let holdNextLoad: Promise<void> | null = null
	const reads: string[] = []
	const store: ReceiverScopedStore = {
		receiverNamespacePath: (s, k) => real.receiverNamespacePath(s, k),
		writeEngineIn: (s, k, v) => real.writeEngineIn(s, k, v),
		loadEngineIn: async (s, k) => {
			reads.push(k)
			const hold = holdNextLoad
			holdNextLoad = null
			const value = await real.loadEngineIn(s, k)
			if (hold) await hold
			return value
		},
		writeOccupancyIn: (s, k, v) => real.writeOccupancyIn(s, k, v),
		loadOccupancyIn: (s, k) => real.loadOccupancyIn(s, k),
		adoptLegacyInto: (s, k) => real.adoptLegacyInto(s, k),
		writeEngine: (s, v) => real.writeEngine(s, v),
		loadEngine: s => real.loadEngine(s),
		writeOccupancy: (s, v) => real.writeOccupancy(s, v),
		loadOccupancy: s => real.loadOccupancy(s),
	}
	const learned = new ReceiverLearnedState({
		stateDir,
		logger: silent,
		tracked: id => id === "rtl",
	})
	await learned.load()
	const attached = learned.attach(store, store, () => true)
	// The service's view of it; holdAfterLoad keeps an open in flight after its load returned.
	let holdAfterLoad: Promise<void> | null = null
	const persistence = {
		...attached,
		loadEngine: async (id: string) => {
			const hold = holdAfterLoad
			holdAfterLoad = null
			const value = await attached.loadEngine(id)
			if (hold) await hold
			return value
		},
	}

	const sources = new FakeSources("rtl", { sampleRate: 2_048_000 })
	const fanout = new FakeFanout()
	const hosts: StateHost[] = []
	const service = new SpectrumService({
		sources: sources as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
		} as never,
		tuner: new FakeTuner() as never,
		sourceConfigs: [
			{
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: 1,
				loop: false,
				playbackSpeed: 1,
				caps: sources.getCaps("rtl")!,
			} as SourceConfig,
		],
		settings: () => testSettings(),
		tuning: () => DEFAULT_TUNING,
		persistence,
		logger: silent,
		engineHost: "inline",
		createHost: (cfg: PipelineConfig, handlers: PipelineHostHandlers) => {
			const host = new StateHost(cfg, handlers)
			hosts.push(host)
			return host
		},
	})
	learned.setSpectrum(service)
	await service.start()
	return {
		learned,
		service,
		hosts,
		reads,
		host: () => hosts.at(-1)!,
		hold: (p: Promise<void>) => {
			holdNextLoad = p
		},
		holdAfterLoad: (p: Promise<void>) => {
			holdAfterLoad = p
		},
	}
}

const nsFile = (id: ReceiverIdentity) =>
	join(
		scannerDir,
		"engine",
		"receivers",
		pathSegment("rtl"),
		pathSegment(id.key),
		"engine.json",
	)

describe("Receiver learned state through the real spectrum service", () => {
	it("a reconnect to another receiver: persists and opens in the pending window never touch A; B never sees A's state", async () => {
		const t = await make()
		await t.learned.onIdentity("rtl", A, undefined)
		await t.service.acquire("rtl", "job:a")
		t.host().learned = learnedState(-91)
		await t.service.persist()
		expect(floorOf(JSON.parse(await readFile(nsFile(A), "utf8")))).toBe(-91)

		// Disconnect, then the next connection: A's state so far is written under A, then pending.
		const boundary = t.learned.onConnection("rtl")
		void t.learned.onConnection("rtl")
		await boundary
		const aBytes = await readFile(nsFile(A))
		// The engine continues fresh in memory: nothing of A in the running pipeline.
		expect(t.host().cfg.persistedEngine).toBeUndefined()

		// B's IQ trains the engine while the identity is pending: a persist writes nothing.
		t.host().learned = learnedState(-50)
		await t.service.persist()
		// An engine opened in the pending window loads nothing (not A's state).
		await t.service.release("rtl", "job:a")
		const hostsBefore = t.hosts.length
		await t.service.acquire("rtl", "job:b")
		expect(t.hosts.length).toBe(hostsBefore + 1)
		expect(t.host().cfg.persistedEngine).toBeUndefined()
		expect(await readFile(nsFile(A))).toEqual(aBytes)

		// B settles: fresh, and its own learning goes under B only.
		await t.learned.onIdentity("rtl", B, A)
		expect(t.learned.view("rtl")).toMatchObject({
			key: B.key,
			namespaceState: "fresh",
		})
		t.host().learned = learnedState(-60)
		await t.service.persist()
		expect(floorOf(JSON.parse(await readFile(nsFile(B), "utf8")))).toBe(-60)
		expect(await readFile(nsFile(A))).toEqual(aBytes)
		// No pipeline after the boundary was ever built from A's state.
		const sinceBoundary = t.hosts.slice(1)
		expect(
			sinceBoundary.every(h => floorOf(h.cfg.persistedEngine) !== -91),
		).toBe(true)

		// Back to A later: A resumes exactly what it had.
		void t.learned.onConnection("rtl")
		await t.learned.onIdentity("rtl", A, B)
		expect(t.learned.view("rtl")?.namespaceState).toBe("resumed")
		expect(floorOf(t.host().cfg.persistedEngine)).toBe(-91)
		await t.service.release("rtl", "job:b")
		await t.service.stop()
	})

	it("the same receiver reconnecting resumes its own state after the pending window", async () => {
		const t = await make()
		await t.learned.onIdentity("rtl", A, undefined)
		await t.service.acquire("rtl", "job:a")
		t.host().learned = learnedState(-91)
		await t.learned.onConnection("rtl")
		expect(t.host().cfg.persistedEngine).toBeUndefined()
		await t.learned.onIdentity("rtl", A, A)
		expect(t.learned.view("rtl")?.namespaceState).toBe("resumed")
		expect(floorOf(t.host().cfg.persistedEngine)).toBe(-91)
		await t.service.release("rtl", "job:a")
		await t.service.stop()
	})

	it("an identity switch while an engine is still opening: the engine ends with the new binding's state", async () => {
		const t = await make()
		// Both receivers have learned state on disk.
		await t.learned.onIdentity("rtl", B, undefined)
		await t.service.acquire("rtl", "job:x")
		t.host().learned = learnedState(-70)
		await t.service.persist()
		void t.learned.onConnection("rtl")
		await t.learned.onIdentity("rtl", A, B)
		t.host().learned = learnedState(-91)
		await t.service.persist()
		await t.service.release("rtl", "job:x")
		// Back on B, with no engine running.
		void t.learned.onConnection("rtl")
		await t.learned.onIdentity("rtl", B, A)

		// An open reads B's state, and is held there while the receiver switches to A.
		const held = gate()
		t.hold(held.promise)
		const opening = t.service.acquire("rtl", "job:y")
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(t.reads.at(-1)).toBe(B.key)
		void t.learned.onConnection("rtl")
		const switched = t.learned.onIdentity("rtl", A, B)
		// The switch runs as far as it can: up to reading A's state (then it would swap an engine
		// that does not exist yet), or until it waits for the open (it never reads A meanwhile).
		const readsBefore = t.reads.length
		await waitFor(() => t.reads.slice(readsBefore).includes(A.key), 500).catch(
			() => undefined,
		)
		await new Promise(resolve => setTimeout(resolve, 20))
		held.open()
		await opening
		await switched
		expect(t.learned.view("rtl")?.key).toBe(A.key)
		expect(floorOf(t.host().cfg.persistedEngine)).toBe(-91)
		expect(
			floorOf(await t.service.exportLearnedState("rtl").then(s => s.engine)),
		).toBe(-91)
		// B's namespace kept B's state (nothing of A written over it).
		expect(floorOf(JSON.parse(await readFile(nsFile(B), "utf8")))).toBe(-70)
		await t.service.release("rtl", "job:y")
		await t.service.stop()
	})

	it("an identity switch after an opening engine's load returned: the switch waits for the open and swaps it", async () => {
		const t = await make()
		await t.learned.onIdentity("rtl", B, undefined)
		await t.service.acquire("rtl", "job:x")
		t.host().learned = learnedState(-70)
		await t.service.release("rtl", "job:x")
		void t.learned.onConnection("rtl")
		await t.learned.onIdentity("rtl", A, B)
		await t.service.acquire("rtl", "job:x")
		t.host().learned = learnedState(-91)
		await t.service.release("rtl", "job:x")
		void t.learned.onConnection("rtl")
		await t.learned.onIdentity("rtl", B, A)

		// The open has B's state in hand (its load returned) but has not started its engine yet.
		const held = gate()
		t.holdAfterLoad(held.promise)
		const opening = t.service.acquire("rtl", "job:y")
		await new Promise(resolve => setTimeout(resolve, 20))
		void t.learned.onConnection("rtl")
		const switched = t.learned.onIdentity("rtl", A, B)
		// The switch runs as far as it can: up to reading A's state (then it would swap an engine
		// that does not exist yet), or until it waits for the open (it never reads A meanwhile).
		const readsBefore = t.reads.length
		await waitFor(() => t.reads.slice(readsBefore).includes(A.key), 500).catch(
			() => undefined,
		)
		await new Promise(resolve => setTimeout(resolve, 20))
		held.open()
		await opening
		await switched
		expect(t.learned.view("rtl")?.key).toBe(A.key)
		expect(floorOf(t.host().cfg.persistedEngine)).toBe(-91)
		expect(floorOf(JSON.parse(await readFile(nsFile(B), "utf8")))).toBe(-70)
		await t.service.release("rtl", "job:y")
		await t.service.stop()
	})
})
