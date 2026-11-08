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
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../../../../src/core/recordings/contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { StoreMutation } from "../../../../src/core/scanner/store/schemas.js"
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
