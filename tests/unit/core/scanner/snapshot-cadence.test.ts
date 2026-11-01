/**
 * The size-scaled scanner snapshot cadence: the pure interval functions at and past every bound,
 * the inputs ScannerPersistence reports for it, steady snapshots staying on the worker, and a
 * journal replay after a long gap without a snapshot restoring the store.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { SnapshotWorkerOptions } from "../../../../src/core/scanner/store/persistence.js"
import {
	JOURNAL_TRIGGER_MIN_BYTES,
	MAIN_SNAPSHOT_MAX_SPACING_MS,
	SNAPSHOT_MAX_INTERVAL_MS,
	SNAPSHOT_MIN_INTERVAL_MS,
	SNAPSHOT_REQUEST_MIN_MS,
	journalSnapshotTriggerBytes,
	mainSnapshotSpacingMs,
	periodicSnapshotIntervalMs,
	snapshotIntervalMs,
} from "../../../../src/core/scanner/store/snapshot-cadence.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const MIB = 1024 * 1024
const logger = createLogger({ level: "fatal" })

describe("periodicSnapshotIntervalMs", () => {
	it("keeps the 10 s floor up to 2e9 / 8,640 = 231,481 B and leaves it one byte later", () => {
		expect(periodicSnapshotIntervalMs(0)).toBe(SNAPSHOT_MIN_INTERVAL_MS)
		// 231,481 x 86,400,000 / 2e9 = 9,999.98 ms, rounded up to 10,000.
		expect(periodicSnapshotIntervalMs(231_481)).toBe(10_000)
		// 231,482 x 0.0432 = 10,000.02 ms, rounded up.
		expect(periodicSnapshotIntervalMs(231_482)).toBe(10_001)
	})

	it("rewrites a 90 MB store every 3,888 s: 22 a day, under 2 GB", () => {
		const interval = periodicSnapshotIntervalMs(90_000_000)
		expect(interval).toBe(3_888_000)
		const perDay = Math.ceil(86_400_000 / interval)
		expect(perDay).toBe(23) // 22.2, the first one at the start included
		expect((perDay - 1) * 90_000_000).toBeLessThanOrEqual(2_000_000_000)
	})

	it("caps at 2 h from 2e9 / 12 = 166.7 MB on", () => {
		// 166,666,666 x 0.0432 = 7,199,999.97 ms, rounded up to the ceiling itself.
		expect(periodicSnapshotIntervalMs(166_666_666)).toBe(7_200_000)
		expect(periodicSnapshotIntervalMs(166_666_667)).toBe(
			SNAPSHOT_MAX_INTERVAL_MS,
		)
		expect(periodicSnapshotIntervalMs(1_000_000_000)).toBe(
			SNAPSHOT_MAX_INTERVAL_MS,
		)
	})

	it("treats a missing or nonsensical size as no snapshot (the floor)", () => {
		for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY])
			expect(periodicSnapshotIntervalMs(bad)).toBe(SNAPSHOT_MIN_INTERVAL_MS)
		expect(periodicSnapshotIntervalMs(Number.POSITIVE_INFINITY)).toBe(
			SNAPSHOT_MIN_INTERVAL_MS,
		)
	})
})

describe("mainSnapshotSpacingMs", () => {
	it("is 1 s up to 1 MiB, then 1 s per MiB, capped at 10 min from 600 MiB on", () => {
		expect(mainSnapshotSpacingMs(0)).toBe(SNAPSHOT_REQUEST_MIN_MS)
		expect(mainSnapshotSpacingMs(MIB)).toBe(1_000)
		expect(mainSnapshotSpacingMs(MIB + 1)).toBe(1_001)
		// ceil(90e6 / 1,048,576 x 1,000) = 85,831 ms
		expect(mainSnapshotSpacingMs(90_000_000)).toBe(85_831)
		expect(mainSnapshotSpacingMs(600 * MIB)).toBe(MAIN_SNAPSHOT_MAX_SPACING_MS)
		expect(mainSnapshotSpacingMs(601 * MIB)).toBe(MAIN_SNAPSHOT_MAX_SPACING_MS)
	})
})

describe("journalSnapshotTriggerBytes", () => {
	it("is max(1 MiB, snapshot), at most half of the journal cap", () => {
		expect(journalSnapshotTriggerBytes(0, 64 * MIB)).toBe(
			JOURNAL_TRIGGER_MIN_BYTES,
		)
		expect(journalSnapshotTriggerBytes(10 * MIB, 64 * MIB)).toBe(10 * MIB)
		expect(journalSnapshotTriggerBytes(32 * MIB, 64 * MIB)).toBe(32 * MIB)
		expect(journalSnapshotTriggerBytes(32 * MIB + 1, 64 * MIB)).toBe(32 * MIB)
		expect(journalSnapshotTriggerBytes(90_000_000, 64 * MIB)).toBe(32 * MIB)
		expect(journalSnapshotTriggerBytes(10 * MIB, MIB)).toBe(MIB / 2)
		expect(journalSnapshotTriggerBytes(10 * MIB, 0)).toBe(10 * MIB)
	})
})

describe("snapshotIntervalMs", () => {
	const base = {
		snapshotBytes: 0,
		journalBytes: 0,
		maxJournalBytes: 64 * MIB,
		onWorker: false,
		requested: false,
		failed: false,
	}

	it("leaves a small store as it was: 10 s, a hole after 1 s, 10 s after a failure", () => {
		expect(snapshotIntervalMs(base)).toBe(10_000)
		expect(snapshotIntervalMs({ ...base, requested: true })).toBe(1_000)
		expect(snapshotIntervalMs({ ...base, requested: true, failed: true })).toBe(
			10_000,
		)
		expect(snapshotIntervalMs({ ...base, failed: true })).toBe(10_000)
	})

	it("a 90 MB store: hourly, a hole after 1 s on or off the worker, 10 s after a failure", () => {
		const big = { ...base, snapshotBytes: 90_000_000 }
		expect(snapshotIntervalMs(big)).toBe(3_888_000)
		expect(snapshotIntervalMs({ ...big, onWorker: true })).toBe(3_888_000)
		expect(
			snapshotIntervalMs({ ...big, requested: true, onWorker: true }),
		).toBe(1_000)
		// The main-thread spacing (85,831 ms here) never delays covering a hole.
		expect(snapshotIntervalMs({ ...big, requested: true })).toBe(1_000)
		expect(snapshotIntervalMs({ ...big, requested: true, failed: true })).toBe(
			10_000,
		)
		expect(
			snapshotIntervalMs({
				...big,
				snapshotBytes: 600 * MIB,
				requested: true,
				failed: true,
			}),
		).toBe(10_000)
		expect(
			snapshotIntervalMs({
				...big,
				requested: true,
				onWorker: true,
				failed: true,
			}),
		).toBe(10_000)
		expect(snapshotIntervalMs({ ...big, failed: true })).toBe(3_888_000)
	})

	it("a journal tail at its trigger makes one due after 10 s (worker) or the main spacing; one byte less does not", () => {
		const big = { ...base, snapshotBytes: 90_000_000 }
		const trigger = 32 * MIB
		expect(snapshotIntervalMs({ ...big, journalBytes: trigger - 1 })).toBe(
			3_888_000,
		)
		expect(snapshotIntervalMs({ ...big, journalBytes: trigger })).toBe(85_831)
		expect(
			snapshotIntervalMs({ ...big, journalBytes: trigger, onWorker: true }),
		).toBe(10_000)
		// A small store's journal trigger never undercuts the 10 s floor.
		expect(snapshotIntervalMs({ ...base, journalBytes: 100 * MIB })).toBe(
			10_000,
		)
	})

	it("never exceeds the periodic interval, whatever the inputs", () => {
		for (const snapshotBytes of [0, 1, MIB, 90_000_000, 2_000_000_000])
			for (const requested of [false, true])
				for (const failed of [false, true])
					for (const onWorker of [false, true])
						for (const journalBytes of [0, 1_000 * MIB]) {
							const s = {
								...base,
								snapshotBytes,
								requested,
								failed,
								onWorker,
								journalBytes,
							}
							const ms = snapshotIntervalMs(s)
							expect(ms).toBeGreaterThanOrEqual(SNAPSHOT_REQUEST_MIN_MS)
							expect(ms).toBeLessThanOrEqual(
								periodicSnapshotIntervalMs(snapshotBytes),
							)
						}
	})
})

// ── ScannerPersistence: the cadence inputs, the worker steady state, replay after a long gap ──

let workerUrl: URL
let buildDir: string
const dirs: string[] = []

beforeAll(async () => {
	const repository = fileURLToPath(new URL("../../../../", import.meta.url))
	const cache = join(repository, "node_modules", ".cache")
	await mkdir(cache, { recursive: true })
	buildDir = await mkdtemp(join(cache, "wk-snapshot-cadence-"))
	const outfile = join(buildDir, "snapshot-worker.js")
	await build({
		absWorkingDir: repository,
		entryPoints: ["src/core/scanner/store/snapshot-worker.ts"],
		bundle: true,
		outfile,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "silent",
	})
	workerUrl = pathToFileURL(outfile)
})

afterAll(async () => {
	await rm(buildDir, { recursive: true, force: true })
})

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0)

async function setup(worker: SnapshotWorkerOptions): Promise<{
	dir: string
	clock: { now: number }
	store: DiscoveryStore
	p: ScannerPersistence
	ingest: (n: number) => void
}> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-snapcadence-"))
	dirs.push(dir)
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => clock.now,
		newId: counterIds(),
	})
	const p = new ScannerPersistence({
		dir,
		logger,
		now: () => clock.now,
		snapshotWorker: { url: workerUrl, ...worker },
	})
	await p.load()
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
		void p.append(e).catch(() => undefined)
	})
	let next = 0
	return {
		dir,
		clock,
		store,
		p,
		ingest: n => {
			for (let i = 0; i < n; i++, next++) {
				// One ingest every 6 s on 40 channels: 600 of them are an hour of activity.
				clock.now = T0 + next * 6_000
				store.ingest(
					makeObs({
						id: `o-${next}`,
						centreHz: 446_000_000 + (next % 40) * 12_500,
						startedAt: clock.now,
					}),
				)
			}
		},
	}
}

async function journalFileBytes(dir: string): Promise<number> {
	let total = 0
	for (const name of await readdir(join(dir, "journal")))
		total += (await stat(join(dir, "journal", name))).size
	return total
}

async function journalUnits(dir: string): Promise<number> {
	let total = 0
	for (const name of await readdir(join(dir, "journal")))
		total += (await readFile(join(dir, "journal", name), "utf8")).length
	return total
}

describe("ScannerPersistence.snapshotCadence", () => {
	it("reports the journal since the last snapshot, the snapshot's size, and both again after a reload", async () => {
		const h = await setup({ enabled: false })
		expect(h.p.snapshotCadence()).toEqual({
			snapshotBytes: 0,
			journalBytes: 0,
			onWorker: false,
		})
		h.ingest(50)
		await h.p.writeSnapshot(h.store.snapshot()) // after every queued line
		const before = await journalFileBytes(h.dir)
		expect(before).toBeGreaterThan(0)
		const size = (await stat(join(h.dir, "discoveries.json"))).size
		expect(h.p.snapshotCadence()).toEqual({
			snapshotBytes: size,
			journalBytes: 0,
			onWorker: false,
		})
		h.ingest(30)
		await h.p.writeJobs([]) // the chain drains every queued journal line
		const tail = (await journalFileBytes(h.dir)) - before
		expect(tail).toBeGreaterThan(0)
		expect(h.p.snapshotCadence().journalBytes).toBe(tail)
		const reloaded = new ScannerPersistence({
			dir: h.dir,
			logger,
			now: () => h.clock.now,
			snapshotWorker: { enabled: false },
		})
		await reloaded.load()
		expect(reloaded.snapshotCadence()).toEqual({
			snapshotBytes: size,
			journalBytes: tail,
			onWorker: false,
		})
	})

	it("counts UTF-8 bytes on disk, not UTF-16 units, for non-ASCII journal lines and snapshots, at append and at load", async () => {
		const h = await setup({ enabled: false })
		h.store.ingest(
			makeObs({
				id: "o-ünïcødé-π-🎙",
				sourceId: "src-東京",
				centreHz: 446_000_000,
				startedAt: h.clock.now,
			}),
		)
		await h.p.writeSnapshot(h.store.snapshot())
		const file = join(h.dir, "discoveries.json")
		const size = (await stat(file)).size
		expect(size).toBeGreaterThan((await readFile(file, "utf8")).length)
		expect(h.p.snapshotCadence().snapshotBytes).toBe(size)
		const before = await journalFileBytes(h.dir)
		const unitsBefore = await journalUnits(h.dir)
		const deleted = ["ünïcødé-π-🎙-東京".repeat(20)]
		await h.p.append({
			at: new Date(h.clock.now).toISOString(),
			op: "delete",
			payload: { discoveries: [], observations: [], deleted },
		})
		const tail = (await journalFileBytes(h.dir)) - before
		// The line's UTF-16 length undercounts it: these non-ASCII chars are 2-4 bytes on disk.
		const unitsTail = (await journalUnits(h.dir)) - unitsBefore
		expect(tail).toBeGreaterThan(unitsTail)
		expect(h.p.snapshotCadence().journalBytes).toBe(tail)
		const reloaded = new ScannerPersistence({
			dir: h.dir,
			logger,
			now: () => h.clock.now,
			snapshotWorker: { enabled: false },
		})
		await reloaded.load()
		expect(reloaded.snapshotCadence()).toEqual({
			snapshotBytes: size,
			journalBytes: tail,
			onWorker: false,
		})
	})

	it("keeps steady snapshots on the worker: one main-thread reset at the first, no fallback after", async () => {
		const h = await setup({})
		try {
			h.ingest(100)
			await h.p.writeSnapshotOf(h.store) // the first resets the mirror on the main thread
			expect(h.p.snapshotCadence().onWorker).toBe(true)
			for (let round = 0; round < 5; round++) {
				h.ingest(120) // 12 min of activity between snapshots
				await h.p.writeSnapshotOf(h.store)
				const cadence = h.p.snapshotCadence()
				expect(cadence.onWorker).toBe(true)
				expect(cadence.journalBytes).toBe(0)
			}
			expect(h.p.snapshotWorkerStatus()).toMatchObject({
				state: "live",
				fallbacks: 0,
				overflows: 0,
				failures: 0,
			})
			const size = (await stat(join(h.dir, "discoveries.json"))).size
			expect(h.p.snapshotCadence().snapshotBytes).toBe(size)
		} finally {
			await h.p.closeSnapshotWorker()
		}
	})

	it("an hour of journal after the last snapshot replays to the same store", async () => {
		const h = await setup({ enabled: false })
		h.ingest(60)
		await h.p.writeSnapshot(h.store.snapshot())
		h.ingest(600) // an hour at one ingest every 6 s, no snapshot in between
		await h.p.writeJobs([])
		const loaded = await new ScannerPersistence({
			dir: h.dir,
			logger,
			now: () => h.clock.now,
			snapshotWorker: { enabled: false },
		}).load()
		expect(loaded.entries.length).toBeGreaterThan(0)
		const replica = new DiscoveryStore({
			maxDiscoveries: 1_000,
			now: () => h.clock.now,
			newId: counterIds(),
		})
		replica.restore(loaded)
		for (const e of loaded.entries) replica.replay(e)
		expect(replica.snapshot()).toEqual(h.store.snapshot())
		expect(replica.recordCounts()).toEqual(h.store.recordCounts())
	})
})
