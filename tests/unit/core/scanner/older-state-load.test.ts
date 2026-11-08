/**
 * A state directory as an earlier core wrote it loads through the real startup path.
 *
 * The directory is built at test time (synthetic, nothing committed) in the shape that core
 * wrote: a snapshot and a journal with no `heldRecordings`, `heldOverflow`, `heldGuard*` or
 * `heldFormat`; merge aliases at most 64 per owner, the oldest folderless-by-its-rule aliases
 * released past that bound (their folders left behind without an owner); a stray folder nothing
 * traces; one recording another discovery lists too; dv recordings and evidence files on disk.
 * Its snapshot and journal file formats are a strict subset of this tree's (only the held fields
 * were added since), so this tree's persistence writes them once the held fields are removed.
 *
 * The real ScannerService then starts on it (persistence load, sliced restore, journal replay,
 * consolidation, orphan-folder migration, analog recovery), stops, and starts again: it loads
 * with no warning or error, the migration re-attaches each released folder and counts the stray
 * one unresolved, every file is still on disk and every recording plays through its owner, and
 * the second start changes nothing.
 *
 * `SCANNER_OLDER_STATE_DIR`: load a directory an earlier tree's own store wrote instead (its
 * `state/` directory and a `manifest.json` of the same scene: survivor, lister, merged, released,
 * and the recordings as recording id to path relative to `state/`); it is copied first.
 *
 * Analog recordings (second suite): the real DiscoveryStore, EvidenceStore and WAV writer
 * finalize each one (intent.json, receipt.json and the WAV under `.analog-operations/` and
 * `recordings/analog/`, exactly the files a running core leaves), the store's mutations are
 * journaled and its snapshot written in the earlier shape, and recovery then runs once with the
 * earlier rule (an adapter without `retainedOwner`: the observation must still list the file),
 * which quarantines every recording whose observation aged out, leaving every file as it was.
 * The intent and receipt formats are unchanged since (the receipt only gained an optional
 * failure field a finalized receipt omits), so these files are the earlier core's own. Then the
 * real service starts, stops and starts. `SCANNER_OLDER_ANALOG_DIR`: a directory an earlier
 * tree's stores wrote instead (`state/` and a `manifest.json` listing `cases`: name, alias, file
 * relative to `state/`, plays); it is copied first.
 */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import {
	appendFile,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { scannerRoutes } from "../../../../src/api/routes/scanner.js"
import type { ScannerRouteService } from "../../../../src/api/routes/scanner.js"
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../../../../src/core/recordings/contract.js"
import type {
	AnalogMetadataAdapter,
	AnalogReconciliation,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import type { StoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import { QUARANTINE_LOG_LINES } from "../../../../src/core/scanner/scanner-service.js"
import type { ScannerService } from "../../../../src/core/scanner/scanner-service.js"
import { createLogger } from "../../../../src/utils/logger.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const logger = createLogger({ level: "fatal" })
const T0 = Date.now() - 3_600_000
const BASE_HZ = 430_000_000
const MAX = DISCOVERY_RECORDING_ALIASES_MAX
/** Merged past the bound: the oldest RELEASED aliases lose their owner in the earlier core. */
const RELEASED = 3
const dirs: string[] = []
const OLDER_STATE_DIR = process.env["SCANNER_OLDER_STATE_DIR"] ?? ""
const OLDER_ANALOG_DIR = process.env["SCANNER_OLDER_ANALOG_DIR"] ?? ""

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

/** A journal payload as the earlier core wrote it: no held-recording field at all. */
function older(payload: unknown): unknown {
	const {
		heldRecordings: _r,
		heldOverflow: _o,
		heldGuard: _g,
		heldGuardEnd: _e,
		heldFormat: _f,
		...rest
	} = payload as StoreMutation
	return rest
}

/** A snapshot as the earlier core wrote it. */
function olderSnapshot(s: StoreSnapshot): StoreSnapshot {
	const { heldRecordings: _r, heldOverflow: _o, ...rest } = s
	return rest
}

interface OlderState {
	dir: string
	survivor: string
	/** Merged into the survivor; the first RELEASED of them were released past the bound. */
	merged: string[]
	released: string[]
	/** B, which lists the survivor's call.wav too. */
	lister: string
	/** Every recording id written, with its file. */
	recordings: Map<string, string>
}

/** The scene an earlier tree wrote (SCANNER_OLDER_STATE_DIR), copied to a fresh directory. */
async function copiedState(from: string): Promise<OlderState> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "wavekit-older-")))
	dirs.push(dir)
	await cp(join(from, "state"), dir, { recursive: true })
	const m = JSON.parse(await readFile(join(from, "manifest.json"), "utf8")) as {
		survivor: string
		lister: string
		merged: string[]
		released: string[]
		recordings: Record<string, string>
	}
	return {
		dir,
		survivor: m.survivor,
		lister: m.lister,
		merged: m.merged,
		released: m.released,
		recordings: new Map(
			Object.entries(m.recordings).map(([rid, rel]) => [rid, join(dir, rel)]),
		),
	}
}

async function olderState(): Promise<OlderState> {
	if (OLDER_STATE_DIR !== "") return copiedState(OLDER_STATE_DIR)
	const dir = await realpath(await mkdtemp(join(tmpdir(), "wavekit-older-")))
	dirs.push(dir)
	const persist = new ScannerPersistence({ dir, logger, now: () => T0 })
	await persist.load()
	// No folder lookup: the earlier core's alias rule (the oldest alias past 64 is released).
	const store = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
	const appends: Promise<unknown>[] = []
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
		appends.push(persist.append({ ...e, payload: older(e.payload) }))
	})
	const flush = async (): Promise<void> => {
		while (appends.length > 0) await Promise.all(appends.splice(0))
	}
	const recordings = new Map<string, string>()
	let n = 0
	const discovery = async (): Promise<string> => {
		n++
		const id =
			store.ingest(
				makeObs({
					id: `o${n}`,
					centreHz: BASE_HZ + n * 100_000,
					startedAt: T0 + n * 1_000,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId ?? ""
		expect(id).not.toBe("")
		const dv = join(dir, "recordings", "dv", id)
		await mkdir(dv, { recursive: true })
		await writeFile(join(dv, "call.wav"), Buffer.alloc(4096))
		const evd = join(dir, "evidence", id)
		await mkdir(evd, { recursive: true })
		await writeFile(join(evd, "psd.json"), "{}")
		store.attachRecordings(`o${n}`, [`${id}~call.wav`], "linked")
		recordings.set(`${id}~call.wav`, join(dv, "call.wav"))
		return id
	}
	const survivor = await discovery()
	const lister = await discovery()
	expect(store.attachRecordings(`o2`, [`${survivor}~call.wav`], "linked")).toBe(
		true,
	)
	const merged: string[] = []
	for (let i = 0; i < MAX + RELEASED; i++) {
		const id = await discovery()
		expect(
			store.applyConsolidation({ groups: [{ survivor, members: [id] }] })
				.absorbed,
		).toBe(1)
		merged.push(id)
		// A snapshot midway: later entries replay on top of it.
		if (i === 9) {
			await flush()
			await persist.writeSnapshot(olderSnapshot(store.snapshot()))
		}
	}
	const released = merged.filter(id => store.aliasOwner(id) === undefined)
	expect(released).toEqual(merged.slice(0, RELEASED))
	expect(store.aliasesOf(survivor)).toHaveLength(MAX)
	// A folder nothing traces (no journal alias, no observation lists its file).
	const stray = join(dir, "recordings", "dv", "d_STRAY")
	await mkdir(stray, { recursive: true })
	await writeFile(join(stray, "lost.wav"), Buffer.alloc(1024))
	await flush()
	await persist.closeSnapshotWorker()
	return { dir, survivor, merged, released, lister, recordings }
}

/** Every regular file under `dir`, relative path to size. */
function filesUnder(dir: string): Map<string, number> {
	const out = new Map<string, number>()
	const walk = (at: string, rel: string): void => {
		for (const name of readdirSync(at)) {
			const path = join(at, name)
			const r = rel === "" ? name : `${rel}/${name}`
			if (statSync(path).isDirectory()) walk(path, r)
			else out.set(r, statSync(path).size)
		}
	}
	for (const top of ["recordings", "evidence"])
		if (existsSync(join(dir, top))) walk(join(dir, top), top)
	return out
}

/** The text of every snapshot and journal file the earlier core's shape allows. */
function stateText(dir: string): string {
	let text = ""
	const walk = (at: string): void => {
		for (const name of readdirSync(at)) {
			const path = join(at, name)
			if (statSync(path).isDirectory()) {
				if (name !== "recordings" && name !== "evidence") walk(path)
			} else if (/\.(json|jsonl|ndjson)$/.test(name) || /journal/.test(at))
				text += readFileSync(path, "utf8")
		}
	}
	walk(dir)
	return text
}

interface Started {
	service: ScannerService
	store: DiscoveryStore
	/** Warning and error lines the service logged. */
	problems: string[]
}

async function start(dir: string): Promise<Started> {
	const h = serviceHarness({
		dir,
		patch: settings => {
			settings.passive.enabled = false
		},
	})
	const problems: string[] = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, done) {
			for (const line of chunk.toString("utf8").split("\n"))
				if (line.trim() !== "") problems.push(line)
			done()
		},
	})
	// The service's own log: every startup failure path warns or errors through it.
	;(h.service as unknown as { log: Logger }).log = pino(
		{ level: "warn" },
		sink,
	) as unknown as Logger
	await h.service.start()
	const store = (h.service as unknown as { store: DiscoveryStore }).store
	return { service: h.service, store, problems }
}

/** The state a restart must leave as it found it. */
function stateOf(s: Started, o: OlderState) {
	const snap = s.store.snapshot()
	return {
		discoveries: snap.discoveries.map(d => d.id).sort(),
		observations: snap.observations.map(x => x.id).sort(),
		aliases: snap.aliases,
		heldRecordings: snap.heldRecordings,
		heldOverflow: snap.heldOverflow,
		listers: s.store.heldRecordingListers(`${o.survivor}~call.wav`),
		paths: [...o.recordings.keys()].map(rid => s.service.recordingPath(rid)),
	}
}

describe("a state directory written by an earlier core", () => {
	it("loads, migrates its released folders, deletes and quarantines nothing; a second start is idempotent", async () => {
		const o = await olderState()
		// The earlier shape: no held-recording field anywhere in the state files.
		const text = stateText(o.dir)
		expect(text.length).toBeGreaterThan(0)
		expect(text).not.toMatch(
			/"held(Recordings|Overflow|Guard|GuardEnd|Format)"/,
		)
		const before = filesUnder(o.dir)
		expect(before.size).toBe(2 * (2 + MAX + RELEASED) + 1)

		const first = await start(o.dir)
		let firstState: ReturnType<typeof stateOf>
		try {
			expect(first.problems).toEqual([])
			// Each released folder re-attached from the journal; the stray one counted.
			expect(first.service.status().folders).toEqual({
				reattached: RELEASED,
				unresolved: 1,
			})
			for (const id of o.merged)
				expect(first.store.aliasOwner(id)).toBe(o.survivor)
			expect(first.store.aliasesOf(o.survivor)).toHaveLength(MAX + RELEASED)
			for (const id of [o.survivor, o.lister])
				expect(first.store.get(id)).toBeDefined()
			// The listing another discovery made is an ownership listing now.
			expect(
				first.store.heldRecordingListers(`${o.survivor}~call.wav`),
			).toEqual([o.survivor, o.lister].sort())
			// Every recording plays through its owner, the released folders' too.
			for (const [rid, path] of o.recordings)
				expect(first.service.recordingPath(rid)).toBe(path)
			expect(first.service.recordingPath("d_STRAY~lost.wav")).toBeNull()
			expect(filesUnder(o.dir)).toEqual(before)
			firstState = stateOf(first, o)
		} finally {
			await first.service.stop()
		}
		expect(filesUnder(o.dir)).toEqual(before)

		const second = await start(o.dir)
		try {
			expect(second.problems).toEqual([])
			// Nothing left to attach; the stray folder is still counted, still in place.
			expect(second.service.status().folders).toEqual({
				reattached: 0,
				unresolved: 1,
			})
			expect(stateOf(second, o)).toEqual(firstState)
			expect(filesUnder(o.dir)).toEqual(before)
		} finally {
			await second.service.stop()
		}
		expect(filesUnder(o.dir)).toEqual(before)
	}, 120_000)
})

/** Later observations of one discovery: past its window, so its oldest leave the store. */
const AGE = 270

/** One finalized analog recording and what every start must make of it. */
interface AnalogCase {
	name: string
	alias: string
	file: string
	discoveryId: string
	/** Plays through its owner (false: it stays quarantined, for `reason`). */
	plays: boolean
	/** The closed quarantine reason a start logs for it (when it does not play). */
	reason?: string
}

interface AnalogState {
	dir: string
	cases: AnalogCase[]
	/** The earlier rule's recovery of the same state (null when it was copied). */
	earlier: AnalogReconciliation[] | null
}

function bindingOf(targetHz: number): RecordingBinding {
	return {
		sourceId: "src-1",
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 1,
		channelId: "opaque",
		channelGeneration: 1,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: null,
		targetHz,
		captureCentreHz: null,
		tuningTrust: "commanded",
	}
}

/** The earlier core's adapter: no retainedOwner, so the observation must still list the file. */
const earlierAdapter = (store: DiscoveryStore): AnalogMetadataAdapter => ({
	authorityHealthy: () => true,
	bindingLive: () => true,
	association: (d, o, b) => store.recordingAssociation(d, o, b),
	prepare: async metadata => {
		store.prepareRecording(metadata)
	},
	inverse: async id => {
		store.removePreparedRecording(id)
	},
	buildCommitPlan: id => store.buildRecordingCommitPlan(id),
	commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
	publishCommit: plan => store.publishRecordingCommit(plan),
})

function evidenceOf(dir: string, store: DiscoveryStore): EvidenceStore {
	const ev = new EvidenceStore({
		dir,
		caps: {
			maxRecordingsMb: 64,
			maxEvidenceMb: 64,
			maxAgeDays: 30,
			minFreeDiskMb: 0,
		},
		logger,
		now: () => T0,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => store.get(id) !== undefined,
		aliases: {
			aliasOwner: id => store.aliasOwner(id),
			aliasesOf: id => store.aliasesOf(id),
			releaseAliases: id => store.releaseAliases(id),
			heldFileNames: (id, removing) => store.heldFileNames(id, removing),
			heldRecordingOwner: id => store.heldRecordingOwner(id),
		},
	})
	ev.configureAnalog(earlierAdapter(store))
	return ev
}

async function copiedAnalogState(from: string): Promise<AnalogState> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "wavekit-older-")))
	dirs.push(dir)
	await cp(join(from, "state"), dir, { recursive: true })
	const m = JSON.parse(await readFile(join(from, "manifest.json"), "utf8")) as {
		cases: AnalogCase[]
	}
	return {
		dir,
		cases: m.cases.map(c => ({ ...c, file: join(dir, c.file) })),
		earlier: null,
	}
}

/**
 * Finalized analog recordings in the earlier shape: one whose observation is still stored, one
 * whose observation aged out, one of a discovery merged away (its observation aged out on the
 * survivor), one of a discovery merged away and released past the alias bound (the earlier
 * alias rule; the journal still traces it), and one whose discovery was deleted before its
 * removal touched the files (no owner resolves).
 */
async function olderAnalogState(): Promise<AnalogState> {
	if (OLDER_ANALOG_DIR !== "") return copiedAnalogState(OLDER_ANALOG_DIR)
	const dir = await realpath(await mkdtemp(join(tmpdir(), "wavekit-older-")))
	dirs.push(dir)
	const persist = new ScannerPersistence({ dir, logger, now: () => T0 })
	await persist.load()
	// No folder lookup: the earlier core's alias rule (the oldest alias past 64 is released).
	const store = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
	const appends: Promise<unknown>[] = []
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
		appends.push(persist.append({ ...e, payload: older(e.payload) }))
	})
	const flush = async (): Promise<void> => {
		while (appends.length > 0) await Promise.all(appends.splice(0))
	}
	const ev = evidenceOf(dir, store)
	await ev.recoverAnalog()
	let n = 0
	const ingest = (hz: number): { id: string; observationId: string } => {
		n++
		const id =
			store.ingest(
				makeObs({
					id: `o${n}`,
					centreHz: hz,
					startedAt: T0 + n * 1_000,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId ?? ""
		expect(id).not.toBe("")
		return { id, observationId: `o${n}` }
	}
	const record = async (
		name: string,
		hz: number,
		plays: boolean,
		reason?: string,
	): Promise<AnalogCase & { observationId: string }> => {
		const { id, observationId } = ingest(hz)
		const op = ev.beginAnalog({
			discoveryId: id,
			observationId,
			binding: bindingOf(hz),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3, -4, 5, -6]))
		const receipt = await op.finish()
		expect(receipt.outcome).toBe("finalized")
		const artifact = receipt.artifact ?? ""
		return {
			name,
			alias: `${id}~${artifact.split("/").at(-1) ?? ""}`,
			file: join(dir, artifact),
			plays,
			...(reason === undefined ? {} : { reason }),
			discoveryId: id,
			observationId,
		}
	}
	// At the owner's current centre (a merge moves it), so each joins that discovery.
	const age = (owner: string): void => {
		const hz = store.get(owner)?.frequencyHz ?? 0
		for (let i = 0; i < AGE; i++) expect(ingest(hz).id).toBe(owner)
	}
	const stored = await record("observation stored", BASE_HZ + 1_000_000, true)
	const aged = await record("observation aged out", BASE_HZ + 2_000_000, true)
	age(aged.discoveryId)
	const survivor = ingest(BASE_HZ + 3_000_000).id
	const merged = await record("merged-away owner", BASE_HZ + 3_500_000, true)
	expect(
		store.applyConsolidation({
			groups: [{ survivor, members: [merged.discoveryId] }],
		}).absorbed,
	).toBe(1)
	age(survivor)
	const keeper = ingest(BASE_HZ + 4_000_000).id
	const released = await record(
		"released, re-attached owner",
		BASE_HZ + 4_500_000,
		true,
	)
	const absorb = (id: string): void => {
		expect(
			store.applyConsolidation({
				groups: [{ survivor: keeper, members: [id] }],
			}).absorbed,
		).toBe(1)
	}
	absorb(released.discoveryId)
	age(keeper)
	// MAX folderless merges after it: the earlier rule releases it, the oldest.
	for (let i = 0; i < MAX; i++)
		absorb(ingest(BASE_HZ + 10_000_000 + i * 100_000).id)
	expect(store.aliasOwner(released.discoveryId)).toBeUndefined()
	const deleted = await record(
		"unresolvable owner",
		BASE_HZ + 5_000_000,
		false,
		"owner-unresolved",
	)
	// Deleted before its removal ran: its files are left with no owner.
	expect(store.delete(deleted.discoveryId)).toBe(true)
	// A live owner, but its WAV no longer matches its receipt (one byte appended).
	const damaged = await record(
		"media mismatch",
		BASE_HZ + 6_000_000,
		false,
		"media-invalid",
	)
	await appendFile(damaged.file, Buffer.alloc(1))
	const cases = [stored, aged, merged, released, deleted, damaged]
	const kept = new Set(store.snapshot().observations.map(o => o.id))
	expect(kept.has(stored.observationId)).toBe(true)
	for (const c of [aged, merged, released, deleted])
		expect(kept.has(c.observationId)).toBe(false)
	await ev.stopAnalog()
	await flush()
	const saved = olderSnapshot(store.snapshot())
	await persist.writeSnapshot(saved)
	await flush()
	await persist.closeSnapshotWorker()
	// An earlier start on the saved state: its rule quarantines what it cannot associate, and
	// writes nothing.
	const loaded = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
	loaded.restore(saved)
	const earlierEv = evidenceOf(dir, loaded)
	const earlier = await earlierEv.recoverAnalog()
	await earlierEv.stopAnalog()
	return {
		dir,
		cases: cases.map(({ observationId: _o, ...c }) => c),
		earlier,
	}
}

/** Every regular file of the recordings and their operations, relative path to content hash. */
function mediaUnder(dir: string): Map<string, string> {
	const out = new Map<string, string>()
	const walk = (at: string, rel: string): void => {
		for (const name of readdirSync(at)) {
			const path = join(at, name)
			const r = rel === "" ? name : `${rel}/${name}`
			if (statSync(path).isDirectory()) walk(path, r)
			else
				out.set(
					r,
					createHash("sha256").update(readFileSync(path)).digest("hex"),
				)
		}
	}
	for (const top of ["recordings", "evidence", ".analog-operations"])
		if (existsSync(join(dir, top))) walk(join(dir, top), top)
	return out
}

/** One logged warning line, parsed (pino JSON). */
interface Problem {
	msg: string
	quarantined?: number
	operationId?: string
	discoveryId?: string
	reason?: string
	suppressed?: number
}

/** The service's evidence store (retention and its counts). */
const evidenceIn = (s: Started): EvidenceStore =>
	(s.service as unknown as { evidence: EvidenceStore }).evidence

describe("finalized analog recordings written by an earlier core", () => {
	it("each with a live owner plays after start, stop and start; nothing moves, the rest stay quarantined and are logged", async () => {
		const o = await olderAnalogState()
		if (o.earlier !== null) {
			// The earlier rule admitted only the recording whose observation is stored; every other
			// one it quarantined, its files left as they were.
			const admitted = o.earlier.filter(r => r.status === "available")
			expect(admitted.map(r => r.discoveryId)).toEqual([
				o.cases[0]?.discoveryId,
			])
			expect(o.earlier.filter(r => r.status === "quarantined")).toHaveLength(
				o.cases.length - 1,
			)
		}
		expect(stateText(o.dir)).not.toMatch(
			/"held(Recordings|Overflow|Guard|GuardEnd|Format)"/,
		)
		const before = mediaUnder(o.dir)
		for (const c of o.cases) expect(existsSync(c.file)).toBe(true)
		const paths = (s: Started): (string | null)[] =>
			o.cases.map(c => s.service.recordingPath(c.alias))
		const expected = o.cases.map(c => (c.plays ? c.file : null))
		const kept = o.cases.filter(c => !c.plays)
		/** A start's only warnings: the count, then one line per quarantined operation. */
		const expectWarnings = (s: Started): void => {
			const lines = s.problems.map(line => JSON.parse(line) as Problem)
			expect(lines.filter(l => l.quarantined !== undefined)).toEqual(
				kept.length > 0
					? [expect.objectContaining({ quarantined: kept.length })]
					: [],
			)
			const items = lines.filter(l => l.reason !== undefined)
			expect(lines).toHaveLength(items.length + (kept.length > 0 ? 1 : 0))
			expect(items.map(l => [l.discoveryId, l.reason]).sort()).toEqual(
				kept.map(c => [c.discoveryId, c.reason]).sort(),
			)
			for (const l of items) {
				expect(l.msg).toBe("Scanner recording quarantined")
				expect(l.operationId).toMatch(/^[0-9a-f-]{36}$/)
				expect(Object.keys(l).filter(k => /path|file|alias/i.test(k))).toEqual(
					[],
				)
			}
		}

		const first = await start(o.dir)
		try {
			expect(paths(first)).toEqual(expected)
			expectWarnings(first)
			// The scanner route serves each one through its owner (and 404s the rest).
			const app = Fastify({ logger: false })
			await app.register(scannerRoutes, {
				scanner: first.service as unknown as ScannerRouteService,
			})
			try {
				for (const c of o.cases) {
					const res = await app.inject({
						method: "GET",
						url: `/api/scanner/recordings/${encodeURIComponent(c.alias)}`,
					})
					expect([c.name, res.statusCode]).toEqual([
						c.name,
						c.plays ? 200 : 404,
					])
					if (c.plays) {
						expect(res.headers["content-type"]).toMatch(/^audio\/wav/)
						expect(res.rawPayload.equals(readFileSync(c.file))).toBe(true)
					}
				}
			} finally {
				await app.close()
			}
			expect(mediaUnder(o.dir)).toEqual(before)
		} finally {
			await first.service.stop()
		}
		expect(mediaUnder(o.dir)).toEqual(before)

		const second = await start(o.dir)
		try {
			expect(paths(second)).toEqual(expected)
			expectWarnings(second)
			expect(mediaUnder(o.dir)).toEqual(before)
		} finally {
			await second.service.stop()
		}
		expect(mediaUnder(o.dir)).toEqual(before)
	}, 120_000)

	it("retention keeps every quarantined recording at and past maxAgeDays and at a zero quota, counted", async () => {
		const o = await olderAnalogState()
		const kept = o.cases.filter(c => !c.plays)
		expect(kept.length).toBeGreaterThan(0)
		const keptBefore = new Map(
			[...mediaUnder(o.dir)].filter(([rel]) =>
				kept.some(c => c.file.endsWith(rel)),
			),
		)
		expect(keptBefore.size).toBe(kept.length)
		const s = await start(o.dir)
		try {
			const ev = evidenceIn(s)
			const day = 86_400_000
			const caps = {
				maxRecordingsMb: 64,
				maxEvidenceMb: 64,
				maxAgeDays: 30,
				minFreeDiskMb: 0,
			}
			// Exactly at maxAgeDays, then a day past it, then a zero quota as well.
			for (const [ageDays, maxRecordingsMb] of [
				[30, 64],
				[31, 64],
				[31, 0],
			] as const) {
				const at = new Date(Date.now() - ageDays * day)
				for (const c of kept) await utimes(c.file, at, at)
				ev.setCaps({ ...caps, maxRecordingsMb })
				await ev.retention(new Set())
				for (const c of kept) expect(existsSync(c.file)).toBe(true)
				expect(ev.quarantinedRecordingCount).toBe(kept.length)
				for (const c of kept)
					expect(s.service.recordingPath(c.alias)).toBeNull()
			}
			// Contents unchanged (only their times were set here).
			expect(
				new Map(
					[...mediaUnder(o.dir)].filter(([rel]) =>
						kept.some(c => c.file.endsWith(rel)),
					),
				),
			).toEqual(keptBefore)
			// Their operations' metadata is still whole.
			for (const item of ev.analogQuarantine())
				for (const name of ["intent.json", "receipt.json"])
					expect(
						existsSync(
							join(o.dir, ".analog-operations", item.operationId, name),
						),
					).toBe(true)
		} finally {
			await s.service.stop()
		}
	}, 120_000)

	it(`logs at most ${QUARANTINE_LOG_LINES} quarantined operations one per line, then one suppressed count`, async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "wavekit-older-")))
		dirs.push(dir)
		const persist = new ScannerPersistence({ dir, logger, now: () => T0 })
		await persist.load()
		const store = new DiscoveryStore({
			maxDiscoveries: 1_000,
			now: () => T0,
			newId: counterIds(),
			logger,
		})
		const appends: Promise<unknown>[] = []
		store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
			appends.push(persist.append({ ...e, payload: older(e.payload) }))
		})
		const ev = evidenceOf(dir, store)
		await ev.recoverAnalog()
		const count = QUARANTINE_LOG_LINES + 2
		for (let i = 0; i < count; i++) {
			const hz = BASE_HZ + 1_000_000 + i * 100_000
			const id =
				store.ingest(
					makeObs({
						id: `q${i}`,
						centreHz: hz,
						startedAt: T0 + i * 1_000,
						cls: "analog-fm",
						open: false,
						gate: "passed",
					}),
				).discoveryId ?? ""
			const op = ev.beginAnalog({
				discoveryId: id,
				observationId: `q${i}`,
				binding: bindingOf(hz),
			})
			await op.ready
			await op.push(new Int16Array([1, -1]))
			expect((await op.finish()).outcome).toBe("finalized")
			// Its removal never ran: no owner resolves, so it stays quarantined.
			expect(store.delete(id)).toBe(true)
		}
		await ev.stopAnalog()
		while (appends.length > 0) await Promise.all(appends.splice(0))
		await persist.writeSnapshot(olderSnapshot(store.snapshot()))
		await persist.closeSnapshotWorker()
		const s = await start(dir)
		try {
			const lines = s.problems.map(line => JSON.parse(line) as Problem)
			expect(lines.filter(l => l.quarantined !== undefined)).toEqual([
				expect.objectContaining({ quarantined: count }),
			])
			const items = lines.filter(l => l.reason !== undefined)
			expect(items).toHaveLength(QUARANTINE_LOG_LINES)
			expect(new Set(items.map(l => l.reason))).toEqual(
				new Set(["owner-unresolved"]),
			)
			expect(lines.filter(l => l.suppressed !== undefined)).toEqual([
				expect.objectContaining({ suppressed: 2 }),
			])
			expect(lines).toHaveLength(QUARANTINE_LOG_LINES + 2)
		} finally {
			await s.service.stop()
		}
	}, 120_000)
})
