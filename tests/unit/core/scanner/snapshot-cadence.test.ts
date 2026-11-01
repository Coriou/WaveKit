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
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	SCANNER_JOURNAL_BACKLOG_CODE,
	SCANNER_SNAPSHOT_DEFERRED_CODE,
	ScannerPersistence,
} from "../../../../src/core/scanner/store/persistence.js"
import type { SnapshotWorkerOptions } from "../../../../src/core/scanner/store/persistence.js"
import type { SnapshotWorkerRequest } from "../../../../src/core/scanner/store/snapshot-protocol.js"
import type {
	SnapshotWorkerFactory,
	SnapshotWorkerPort,
} from "../../../../src/core/scanner/store/snapshot-writer.js"
import {
	HOLE_SNAPSHOT_BACKOFF_AFTER,
	HOLE_SNAPSHOT_MAX_SPACING_MS,
	JOURNAL_TRIGGER_MIN_BYTES,
	MAIN_SNAPSHOT_MAX_SPACING_MS,
	MAIN_SNAPSHOT_REST_FACTOR,
	SNAPSHOT_MAX_INTERVAL_MS,
	SNAPSHOT_MIN_INTERVAL_MS,
	SNAPSHOT_REQUEST_MIN_MS,
	SNAPSHOT_RETRY_MIN_MS,
	holeSnapshotSpacingMs,
	journalSnapshotTriggerBytes,
	mainSnapshotRestMs,
	mainSnapshotSpacingMs,
	periodicSnapshotIntervalMs,
	snapshotIntervalMs,
	snapshotRetryMs,
} from "../../../../src/core/scanner/store/snapshot-cadence.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import {
	applySeededOps,
	mulberry32,
	seededStore,
} from "./snapshot-mirror-ops.js"

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

describe("mainSnapshotRestMs", () => {
	it("is 9 x the build (10 % duty), 0 for none, capped at 10 min from 66,667 ms of build on", () => {
		expect(MAIN_SNAPSHOT_REST_FACTOR).toBe(9)
		expect(mainSnapshotRestMs(0)).toBe(0)
		expect(mainSnapshotRestMs(2_700)).toBe(24_300)
		// The duty of a 2.7 s build followed by its rest: 2,700 / 27,000 = 10 %.
		expect(2_700 / (2_700 + mainSnapshotRestMs(2_700))).toBeCloseTo(0.1, 12)
		expect(mainSnapshotRestMs(0.5)).toBe(5) // 4.5 rounded up
		expect(mainSnapshotRestMs(66_666)).toBe(599_994)
		expect(mainSnapshotRestMs(66_667)).toBe(MAIN_SNAPSHOT_MAX_SPACING_MS)
		expect(mainSnapshotRestMs(1e12)).toBe(MAIN_SNAPSHOT_MAX_SPACING_MS)
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(mainSnapshotRestMs(bad)).toBe(0)
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

describe("holeSnapshotSpacingMs", () => {
	it("is 1 s for the first 5 hole snapshots of an episode, then 2^(streak - 4) s, capped at 5 min from streak 13 on", () => {
		expect(HOLE_SNAPSHOT_BACKOFF_AFTER).toBe(5)
		for (const streak of [0, 1, 4])
			expect(holeSnapshotSpacingMs(streak)).toBe(SNAPSHOT_REQUEST_MIN_MS)
		expect(holeSnapshotSpacingMs(5)).toBe(2_000)
		expect(holeSnapshotSpacingMs(6)).toBe(4_000)
		// 2^8 s = 256 s < 300 s at streak 12; 2^9 s = 512 s caps to 300 s at 13.
		expect(holeSnapshotSpacingMs(12)).toBe(256_000)
		expect(holeSnapshotSpacingMs(13)).toBe(HOLE_SNAPSHOT_MAX_SPACING_MS)
		expect(holeSnapshotSpacingMs(10_000)).toBe(300_000)
		expect(holeSnapshotSpacingMs(Number.NaN)).toBe(1_000)
		expect(holeSnapshotSpacingMs(-3)).toBe(1_000)
	})
})

describe("snapshotRetryMs", () => {
	it("is 0 without failures, then 10 s doubling per consecutive failure (callers cap it)", () => {
		expect(snapshotRetryMs(0)).toBe(0)
		expect(snapshotRetryMs(Number.NaN)).toBe(0)
		expect(snapshotRetryMs(1)).toBe(SNAPSHOT_RETRY_MIN_MS)
		expect(snapshotRetryMs(2)).toBe(20_000)
		expect(snapshotRetryMs(9)).toBe(2_560_000)
		expect(snapshotRetryMs(10)).toBe(5_120_000)
		// The exponent stops at 30: never Infinity or NaN.
		expect(snapshotRetryMs(1_000)).toBe(10_000 * 2 ** 30)
	})
})

describe("snapshotIntervalMs", () => {
	const base = {
		snapshotBytes: 0,
		journalBytes: 0,
		maxJournalBytes: 64 * MIB,
		onWorker: false,
		requested: false,
		failures: 0,
		holeStreak: 0,
		mainBuildMs: 0,
		mainBuildEndOffsetMs: 0,
	}

	it("leaves a small store as it was: 10 s, a hole after 1 s, 10 s after a failure", () => {
		expect(snapshotIntervalMs(base)).toBe(10_000)
		expect(snapshotIntervalMs({ ...base, requested: true })).toBe(1_000)
		expect(snapshotIntervalMs({ ...base, requested: true, failures: 1 })).toBe(
			10_000,
		)
		expect(snapshotIntervalMs({ ...base, failures: 1 })).toBe(10_000)
	})

	it("a 90 MB store: hourly, a hole after 1 s on or off the worker, 10 s after a first failure", () => {
		const big = { ...base, snapshotBytes: 90_000_000 }
		expect(snapshotIntervalMs(big)).toBe(3_888_000)
		expect(snapshotIntervalMs({ ...big, onWorker: true })).toBe(3_888_000)
		expect(
			snapshotIntervalMs({ ...big, requested: true, onWorker: true }),
		).toBe(1_000)
		// The main-thread spacing (85,831 ms here) never delays covering a hole.
		expect(snapshotIntervalMs({ ...big, requested: true })).toBe(1_000)
		expect(snapshotIntervalMs({ ...big, requested: true, failures: 1 })).toBe(
			10_000,
		)
		expect(
			snapshotIntervalMs({
				...big,
				snapshotBytes: 600 * MIB,
				requested: true,
				failures: 1,
			}),
		).toBe(10_000)
		expect(
			snapshotIntervalMs({
				...big,
				requested: true,
				onWorker: true,
				failures: 1,
			}),
		).toBe(10_000)
		// A failed periodic snapshot is retried after 10 s, not at the periodic interval.
		expect(snapshotIntervalMs({ ...big, failures: 1 })).toBe(10_000)
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

	it("a main-thread hole snapshot waits out 9 x the last main-thread build after it ended; the worker does not", () => {
		// The last snapshot built 2.7 s on the main thread at its start: it ended 2,700 ms after.
		const after = {
			...base,
			snapshotBytes: 90_000_000,
			requested: true,
			mainBuildMs: 2_700,
			mainBuildEndOffsetMs: 2_700,
		}
		expect(snapshotIntervalMs(after)).toBe(27_000) // 2,700 + 24,300
		expect(snapshotIntervalMs({ ...after, failures: 1 })).toBe(27_000)
		expect(snapshotIntervalMs({ ...after, onWorker: true })).toBe(1_000)
		// A fallback that ended 5 s after the start rests from its own end.
		expect(snapshotIntervalMs({ ...after, mainBuildEndOffsetMs: 5_000 })).toBe(
			29_300,
		)
		// One that ended long before the last (worker) start no longer delays anything.
		expect(
			snapshotIntervalMs({ ...after, mainBuildEndOffsetMs: -24_300 }),
		).toBe(1_000)
		expect(
			snapshotIntervalMs({ ...after, mainBuildEndOffsetMs: -23_299 }),
		).toBe(1_001)
		// A 30 ms build rests 270 ms: inside the 1 s hole spacing.
		expect(
			snapshotIntervalMs({
				...after,
				mainBuildMs: 30,
				mainBuildEndOffsetMs: 30,
			}),
		).toBe(1_000)
		// Never past the periodic interval: no change to a store's normal cadence.
		expect(snapshotIntervalMs({ ...after, requested: false })).toBe(3_888_000)
		expect(
			snapshotIntervalMs({ ...after, mainBuildEndOffsetMs: Number.NaN }),
		).toBe(1_000)
	})

	it("composes the hole backoff, the failure retry and the caps", () => {
		const big = { ...base, snapshotBytes: 90_000_000 }
		const hole = { ...big, requested: true, onWorker: true }
		expect(snapshotIntervalMs({ ...hole, holeStreak: 4 })).toBe(1_000)
		expect(snapshotIntervalMs({ ...hole, holeStreak: 5 })).toBe(2_000)
		expect(snapshotIntervalMs({ ...hole, holeStreak: 40 })).toBe(300_000)
		// The later of the two: a 2 s backoff and a 10 s retry wait 10 s; a 256 s backoff wins.
		expect(snapshotIntervalMs({ ...hole, holeStreak: 5, failures: 1 })).toBe(
			10_000,
		)
		expect(snapshotIntervalMs({ ...hole, holeStreak: 12, failures: 1 })).toBe(
			256_000,
		)
		// A hole's failure retry stops at 5 min (5th failure: 160 s; 6th: 320 s -> 300 s).
		expect(snapshotIntervalMs({ ...hole, failures: 5 })).toBe(160_000)
		expect(snapshotIntervalMs({ ...hole, failures: 6 })).toBe(300_000)
		// A periodic one's at the periodic interval: 9th failure 2,560 s, 10th 5,120 s -> 3,888 s.
		expect(snapshotIntervalMs({ ...big, onWorker: true, failures: 9 })).toBe(
			2_560_000,
		)
		expect(snapshotIntervalMs({ ...big, onWorker: true, failures: 10 })).toBe(
			3_888_000,
		)
		// A small store keeps its 10 s periodic ceiling whatever the backoff.
		expect(
			snapshotIntervalMs({ ...base, requested: true, holeStreak: 40 }),
		).toBe(10_000)
		expect(snapshotIntervalMs({ ...base, failures: 40 })).toBe(10_000)
		// A journal trigger after failures waits the later of its spacing and the retry.
		const trigger = { ...big, onWorker: true, journalBytes: 32 * MIB }
		expect(snapshotIntervalMs({ ...trigger, failures: 3 })).toBe(40_000)
	})

	it("never exceeds the periodic interval, whatever the inputs", () => {
		for (const snapshotBytes of [0, 1, MIB, 90_000_000, 2_000_000_000])
			for (const requested of [false, true])
				for (const failures of [0, 1, 40])
					for (const onWorker of [false, true])
						for (const journalBytes of [0, 1_000 * MIB]) {
							const s = {
								...base,
								snapshotBytes,
								requested,
								failures,
								holeStreak: failures,
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
			expect(h.p.mainSnapshotBuild().count).toBe(1)
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
			expect(h.p.mainSnapshotBuild().count).toBe(1) // worker builds are not counted
		} finally {
			await h.p.closeSnapshotWorker()
		}
	})

	it("times every main-thread build, the store clone included, on the injected build clock", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-snapcadence-"))
		dirs.push(dir)
		const buildTime = { t: 0 }
		const store = new DiscoveryStore({
			maxDiscoveries: 1_000,
			now: () => T0,
			newId: counterIds(),
		})
		const p = new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
			snapshotWorker: { enabled: false },
			buildClock: () => buildTime.t,
		})
		await p.load()
		expect(p.mainSnapshotBuild()).toEqual({ count: 0, ms: 0 })
		const snapshot = store.snapshot.bind(store)
		vi.spyOn(store, "snapshot").mockImplementation(() => {
			buildTime.t += 2_700 // the clone of a large store
			return snapshot()
		})
		await p.writeSnapshotOf(store)
		expect(p.mainSnapshotBuild()).toEqual({ count: 1, ms: 2_700 })
		buildTime.t += 50_000 // idle time between snapshots is not build time
		await p.writeSnapshot(snapshot())
		expect(p.mainSnapshotBuild()).toEqual({ count: 2, ms: 0 })
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

describe("ScannerPersistence main-thread rest at the fallback", () => {
	const BUILD_MS = 2_700

	async function restHarness(snapshotWorker: SnapshotWorkerOptions): Promise<{
		p: ScannerPersistence
		store: DiscoveryStore
		buildTime: { t: number }
		dir: string
	}> {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-snapcadence-"))
		dirs.push(dir)
		const buildTime = { t: 0 }
		const store = new DiscoveryStore({
			maxDiscoveries: 1_000,
			now: () => T0,
			newId: counterIds(),
		})
		const p = new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
			snapshotWorker,
			buildClock: () => buildTime.t,
		})
		await p.load()
		store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
			void p.append(e).catch(() => undefined)
		})
		store.ingest(makeObs({ id: "o1", centreHz: 446_000_000, startedAt: T0 }))
		const snapshot = store.snapshot.bind(store)
		vi.spyOn(store, "snapshot").mockImplementation(() => {
			buildTime.t += BUILD_MS
			return snapshot()
		})
		return { p, store, buildTime, dir }
	}

	it("defers a budgeted main-path snapshot until 9 x the last build after it ended; unbudgeted ones always write", async () => {
		const h = await restHarness({ enabled: false })
		await h.p.writeSnapshotOf(h.store) // built 0 -> 2,700: rest until 27,000
		expect(h.p.mainSnapshotBuild()).toEqual({ count: 1, ms: BUILD_MS })
		expect(h.p.mainSnapshotRestRemainingMs()).toBe(24_300)
		h.buildTime.t = 27_000 - 1
		await expect(
			h.p.writeSnapshotOf(h.store, { deferWithinMainRest: true }),
		).rejects.toMatchObject({ code: SCANNER_SNAPSHOT_DEFERRED_CODE })
		expect(h.p.mainSnapshotBuild().count).toBe(1) // nothing built
		expect(h.p.mainSnapshotRestRemainingMs()).toBe(1)
		// Start-up and shutdown snapshots are not budgeted.
		await h.p.writeSnapshotOf(h.store)
		expect(h.p.mainSnapshotBuild().count).toBe(2) // 26,999 -> 29,699: rest until 53,999
		h.buildTime.t = 53_999
		await h.p.writeSnapshotOf(h.store, { deferWithinMainRest: true })
		expect(h.p.mainSnapshotBuild().count).toBe(3)
	})

	it("defers the main-thread fallback of a failed worker commit inside the rest, and writes nothing", async () => {
		const commits = { count: 0 }
		const factory: SnapshotWorkerFactory = () => {
			let listener: ((value: unknown) => void) | null = null
			const port: SnapshotWorkerPort = {
				postMessage: (m: SnapshotWorkerRequest) => {
					if (m.type === "commit") {
						commits.count += 1
						const id = m.id
						setImmediate(() =>
							listener?.({
								type: "failed",
								id,
								reason: "diverged",
								heapUsedBytes: 0,
							}),
						)
						return
					}
					const charged = m.charged
					setImmediate(() => listener?.({ type: "applied", charged }))
				},
				onMessage: l => {
					listener = l
				},
				onError: () => undefined,
				onExit: () => undefined,
				terminate: () => Promise.resolve(0),
			}
			return port
		}
		const h = await restHarness({ factory })
		try {
			await h.p.writeSnapshotOf(h.store) // main path: resets the mirror, rest until 27,000
			const first = await readFile(join(h.dir, "discoveries.json"), "utf8")
			await new Promise<void>(resolve => setImmediate(resolve)) // the reset is acknowledged
			expect(h.p.snapshotCadence().onWorker).toBe(true)
			h.store.ingest(
				makeObs({ id: "o2", centreHz: 446_012_500, startedAt: T0 + 1 }),
			)
			h.buildTime.t = 10_000
			await expect(
				h.p.writeSnapshotOf(h.store, { deferWithinMainRest: true }),
			).rejects.toMatchObject({ code: SCANNER_SNAPSHOT_DEFERRED_CODE })
			expect(commits.count).toBe(1) // the worker was asked and failed
			expect(h.p.mainSnapshotBuild().count).toBe(1) // no fallback build inside the rest
			expect(await readFile(join(h.dir, "discoveries.json"), "utf8")).toBe(
				first,
			)
			// Past the rest the mirror is stale (diverged): the main path writes it.
			h.buildTime.t = 27_000
			await h.p.writeSnapshotOf(h.store, { deferWithinMainRest: true })
			expect(h.p.mainSnapshotBuild().count).toBe(2)
			expect(await readFile(join(h.dir, "discoveries.json"), "utf8")).not.toBe(
				first,
			)
		} finally {
			await h.p.closeSnapshotWorker()
		}
	})
})

describe("ScannerPersistence journal bytes count only lines written", () => {
	const line = (n: number): Omit<JournalEntry, "seq"> => ({
		at: new Date(T0).toISOString(),
		op: "delete",
		payload: { discoveries: [], observations: [], deleted: [`d-${n}`] },
	})

	it("refused lines (backlog full) never count", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-snapcadence-"))
		dirs.push(dir)
		const p = new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
			snapshotWorker: { enabled: false },
			maxJournalBacklogBytes: 1,
		})
		await p.load()
		await expect(p.append(line(1))).rejects.toMatchObject({
			code: SCANNER_JOURNAL_BACKLOG_CODE,
		})
		await p.writeJobs([])
		expect(p.snapshotCadence().journalBytes).toBe(0)
	})

	it("a failed batch and the batch dropped behind its hole never count; later written lines do, exactly", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-snapcadence-"))
		dirs.push(dir)
		let release!: () => void
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let calls = 0
		const p = new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
			snapshotWorker: { enabled: false },
			appendFile: async (path, data) => {
				calls += 1
				if (calls === 1) {
					await gate
					throw new Error("EIO")
				}
				const { appendFile } = await import("node:fs/promises")
				await appendFile(path, data)
			},
		})
		await p.load()
		const failed = p.append(line(1)).catch((err: unknown) => err)
		await new Promise<void>(resolve => setImmediate(resolve)) // batch 1 is writing
		const dropped = p.append(line(2)).catch((err: unknown) => err)
		release()
		expect(await failed).toMatchObject({ code: "SCANNER_PERSIST_FAILED" })
		expect(await dropped).toMatchObject({ code: SCANNER_JOURNAL_BACKLOG_CODE })
		expect(calls).toBe(1) // the dropped batch was never written
		expect(p.snapshotCadence().journalBytes).toBe(0)
		await p.writeSnapshot({
			discoveries: [],
			observations: [],
			corrections: [],
			recordingOperations: [],
		}) // covers the hole
		await p.append(line(3))
		expect(p.snapshotCadence().journalBytes).toBe(await journalFileBytes(dir))
		expect(await journalFileBytes(dir)).toBeGreaterThan(0)
	})
})

describe("ScannerPersistence replay of a long journal with merges, rekeys, evictions and prunes", () => {
	it("restores the live store from the snapshot plus thousands of seeded journal lines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-snapcadence-"))
		dirs.push(dir)
		const run = seededStore(40)
		const p = new ScannerPersistence({
			dir,
			logger,
			now: () => run.clock.now,
			snapshotWorker: { enabled: false },
		})
		await p.load()
		run.store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
			void p.append(e).catch(() => undefined)
		})
		const rand = mulberry32(20261101)
		applySeededOps(run, rand, 800)
		await p.writeSnapshot(run.store.snapshot())
		const before = run.entries.length
		applySeededOps(run, rand, 4_000, { obsBase: 100_000 })
		await p.writeJobs([]) // drains every queued journal line
		const tail = run.entries.slice(before)
		const ops = new Set(tail.map(e => e.op))
		for (const op of ["observation", "evidence", "rekey", "evict", "delete"])
			expect(ops.has(op as (typeof tail)[number]["op"])).toBe(true)
		const loaded = await new ScannerPersistence({
			dir,
			logger,
			now: () => run.clock.now,
			snapshotWorker: { enabled: false },
		}).load()
		expect(loaded.droppedLines).toBe(0)
		expect(loaded.entries.length).toBe(tail.length)
		const replica = new DiscoveryStore({
			maxDiscoveries: 40,
			now: () => run.clock.now,
			newId: counterIds(),
			rasters: () => [{ spacingHz: 12_500, firstChannelHz: 446_000_000 }],
		})
		replica.restore(loaded)
		for (const e of loaded.entries) replica.replay(e)
		expect(replica.snapshot()).toEqual(run.store.snapshot())
		expect(replica.recordCounts()).toEqual(run.store.recordCounts())
	}, 60_000)
})
