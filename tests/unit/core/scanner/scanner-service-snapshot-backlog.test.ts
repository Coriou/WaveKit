/**
 * Core heap OOM (2026-10-17): every 10 s tick cloned and stringified the whole discovery store
 * and queued it behind a lagging disk chain. The tick now starts no snapshot while one is still
 * being written, a journal hole requests a snapshot at once (single-flight, at most once a
 * second), and refused or I/O-failed lines are not logged once per line.
 */
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScannerService } from "../../../../src/core/scanner/scanner-service.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	SCANNER_JOURNAL_BACKLOG_CODE,
	ScannerPersistence,
} from "../../../../src/core/scanner/store/persistence.js"
import {
	HOLE_STREAK_RESET_MS,
	holeSnapshotSpacingMs,
} from "../../../../src/core/scanner/store/snapshot-cadence.js"
import type { SnapshotWorkerRequest } from "../../../../src/core/scanner/store/snapshot-protocol.js"
import type {
	SnapshotWorkerFactory,
	SnapshotWorkerPort,
} from "../../../../src/core/scanner/store/snapshot-writer.js"
import {
	recordingAlias,
	recordingArtifact,
	type PreparedRecordingMetadata,
} from "../../../../src/core/scanner/store/recording-operation.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { createLogger, type Logger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

type Internals = {
	now: () => number
	snapshotClock: () => number
	stateLoaded: boolean
	dirty: boolean
	tick(): void
	log: Logger
	store: DiscoveryStore
	persistence: ScannerPersistence
	onStoreMutation(entry: Parameters<ScannerPersistence["append"]>[0]): void
	storageDir: string
	recordingRecoveryHealthy: boolean
	acknowledgeRecordingMutation(
		mutate: (
			beforeEmit: (entry: Parameters<ScannerPersistence["append"]>[0]) => void,
		) => void,
	): Promise<void>
	recordingAppends: Map<
		Parameters<ScannerPersistence["append"]>[0],
		Promise<number> | null
	>
}

const SNAPSHOT_EVERY_MS = 10_000
const dirs: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

function harness(): {
	service: ScannerService
	internals: Internals
	clock: { t: number }
} {
	const h = serviceHarness()
	dirs.push(h.dir)
	const internals = h.service as unknown as Internals
	const clock = { t: 1_000_000 }
	internals.now = () => clock.t
	internals.snapshotClock = () => clock.t
	internals.stateLoaded = true
	return { service: h.service, internals, clock }
}

describe("ScannerService snapshot backlog", () => {
	it("starts no second snapshot while the first is still being written, across N ticks", async () => {
		const { internals, clock } = harness()
		let release!: () => void
		const stalled = new Promise<void>(resolve => {
			release = resolve
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementationOnce(() => stalled)
			.mockImplementation(() => Promise.resolve())
		const snapshot = vi.spyOn(internals.store, "snapshot")
		for (let i = 0; i < 100; i++) {
			internals.dirty = true // the store keeps mutating during the sweep
			clock.t += SNAPSHOT_EVERY_MS
			internals.tick()
		}
		expect(write).toHaveBeenCalledTimes(1)
		expect(snapshot).not.toHaveBeenCalled() // the mocked writeSnapshotOf takes the store itself
		release()
		await stalled
		await new Promise<void>(resolve => setImmediate(resolve))
		clock.t += SNAPSHOT_EVERY_MS
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2)
	})

	it("retries after a failed snapshot: dirty again, in-flight flag cleared", async () => {
		const { internals, clock } = harness()
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementationOnce(() =>
				Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED")),
			)
			.mockImplementation(() => Promise.resolve())
		internals.dirty = true
		clock.t += SNAPSHOT_EVERY_MS
		internals.tick()
		expect(internals.dirty).toBe(false)
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(internals.dirty).toBe(true)
		clock.t += SNAPSHOT_EVERY_MS
		internals.tick() // no new mutation: the failed state still gets written
		expect(write).toHaveBeenCalledTimes(2)
	})

	it("appends recording operations as reserved and other mutations as plain", () => {
		const { internals } = harness()
		const append = vi
			.spyOn(internals.persistence, "append")
			.mockImplementation(() => Promise.resolve(1))
		const plain = {
			at: new Date(0).toISOString(),
			op: "observation" as const,
			payload: { discoveries: [], observations: [], deleted: [] },
		}
		const recording = { ...plain }
		internals.recordingAppends.set(recording, null)
		internals.onStoreMutation(plain)
		internals.onStoreMutation(recording)
		expect(append.mock.calls).toEqual([
			[plain, {}],
			[recording, { reserved: true }],
		])
		expect(internals.recordingAppends.get(recording)).toBeInstanceOf(Promise)
	})

	it("still snapshots every interval while writes keep up", async () => {
		const { internals, clock } = harness()
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() => Promise.resolve())
		for (let i = 0; i < 5; i++) {
			internals.dirty = true
			clock.t += SNAPSHOT_EVERY_MS
			internals.tick()
			await new Promise<void>(resolve => setImmediate(resolve))
		}
		expect(write).toHaveBeenCalledTimes(5)
	})

	it("warns no per-line failure for refused or I/O-failed lines but requests one snapshot; other failures warn", async () => {
		const { internals } = harness()
		const warn = vi.spyOn(internals.log, "warn")
		let release!: () => void
		const pending = new Promise<void>(resolve => {
			release = resolve
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() => pending)
		const append = vi.spyOn(internals.persistence, "append")
		append.mockImplementation(() =>
			Promise.reject(
				new WaveKitError(
					"Scanner journal backlog full",
					SCANNER_JOURNAL_BACKLOG_CODE,
				),
			),
		)
		for (let i = 0; i < 50; i++) internals.onStoreMutation(entry())
		append.mockImplementation(() =>
			Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED")),
		)
		for (let i = 0; i < 50; i++) internals.onStoreMutation(entry())
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(warn).not.toHaveBeenCalled()
		expect(write).toHaveBeenCalledTimes(1) // single-flight
		append.mockImplementation(() => Promise.reject(new Error("unexpected")))
		internals.onStoreMutation(entry())
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(warn).toHaveBeenCalledTimes(1)
		release()
	})

	it("snapshots at once after a journal hole, at most once a second, and at the interval after a failed snapshot", async () => {
		const { internals, clock } = harness()
		const outcomes: (() => Promise<void>)[] = [
			() => Promise.resolve(),
			() => Promise.resolve(),
			() => Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED")),
			() => Promise.resolve(),
		]
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() =>
				(outcomes.shift() ?? (() => Promise.resolve()))(),
			)
		const hole = () =>
			Promise.reject(new WaveKitError("full", SCANNER_JOURNAL_BACKLOG_CODE))
		vi.spyOn(internals.persistence, "append").mockImplementation(hole)
		const settle = () => new Promise<void>(resolve => setImmediate(resolve))
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(1) // at once, not at the 10 s tick
		clock.t += 500
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(1) // within a second: deferred
		clock.t += 500
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2) // the tick picks the request up
		await settle()
		clock.t += 1_000
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(3) // this one fails
		clock.t += 1_000
		internals.onStoreMutation(entry())
		await settle()
		internals.tick()
		expect(write).toHaveBeenCalledTimes(3) // a failing disk: back to the interval
		clock.t += SNAPSHOT_EVERY_MS
		internals.tick()
		expect(write).toHaveBeenCalledTimes(4)
	})

	it("rolls a refused prepare back: the applied record is removed by the inverse once a snapshot covers the hole", async () => {
		const { internals, clock } = harness()
		internals.recordingRecoveryHealthy = true
		const logger = createLogger({ level: "fatal" })
		// A journal that refuses every plain line (cap 1): any store mutation opens a hole.
		const persistence = new ScannerPersistence({
			dir: internals.storageDir,
			logger,
			now: () => clock.t,
			maxJournalBacklogBytes: 1,
		})
		await persistence.load()
		internals.persistence = persistence
		// The sole append writer, as startUp installs it after load.
		internals.store.on("mutation", internals.onStoreMutation)
		// Hold the hole open while the prepare runs: the first requested snapshot is parked.
		let releaseParked!: () => void
		const parked = new Promise<void>(resolve => {
			releaseParked = resolve
		})
		const write = vi
			.spyOn(persistence, "writeSnapshotOf")
			.mockImplementationOnce(() => parked)
		const { discoveryId } = internals.store.ingest(
			makeObs({ id: "o1", centreHz: 446_000_000, startedAt: clock.t }),
		)
		if (discoveryId === null) throw new Error("Test discovery missing")
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(write).toHaveBeenCalledTimes(1)
		const metadata = preparedMetadata(discoveryId)
		await expect(
			internals.acknowledgeRecordingMutation(before => {
				internals.store.prepareRecording(metadata, before)
			}),
		).rejects.toMatchObject({ code: SCANNER_JOURNAL_BACKLOG_CODE })
		// The store applied the record before the refusal.
		expect(
			internals.store.preparedRecordingOperations().map(o => o.operationId),
		).toEqual([metadata.operationId])
		// The parked snapshot settles; the requested one (real) covers the hole.
		releaseParked()
		await new Promise<void>(resolve => setImmediate(resolve))
		clock.t += 1_000
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2)
		// Analog operations' cleanup: the inverse is accepted behind the covering snapshot.
		await internals.acknowledgeRecordingMutation(before => {
			internals.store.removePreparedRecording(metadata.operationId, before)
		})
		expect(internals.store.preparedRecordingOperations()).toEqual([])
		// Durable state (snapshot + journal replay) holds no prepared record either.
		const loaded = await new ScannerPersistence({
			dir: internals.storageDir,
			logger,
			now: () => clock.t,
		}).load()
		const restored = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => clock.t,
			newId: counterIds(),
		})
		restored.restore({
			discoveries: loaded.discoveries,
			observations: loaded.observations,
			corrections: loaded.corrections,
			...(loaded.recordingOperations
				? { recordingOperations: loaded.recordingOperations }
				: {}),
		})
		for (const e of loaded.entries) restored.replay(e)
		expect(restored.preparedRecordingOperations()).toEqual([])
		expect(restored.get(discoveryId)).toBeDefined()
	})
})

describe("ScannerService size-scaled snapshot cadence", () => {
	// 90 MB of snapshot text: periodic 90e6 x 86,400,000 / 2e9 = 3,888,000 ms; main-thread
	// spacing ceil(90e6 / 1 MiB x 1 s) = 85,831 ms; journal trigger min(90e6, 64 MiB / 2) = 32 MiB.
	const BIG = 90_000_000
	const PERIODIC_MS = 3_888_000
	const MAIN_SPACING_MS = 85_831
	/** Past every interval since the never-snapshotted start (lastSnapshotAt 0). */
	const LATE = 10_000_000_000

	it("snapshots a 90 MB store twice in two dirty hours, not 720 times, even when every snapshot is a main-thread fallback", async () => {
		const { internals, clock } = harness()
		clock.t = LATE
		vi.spyOn(internals.persistence, "snapshotCadence").mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 0,
			onWorker: false,
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() => Promise.resolve())
		const starts: number[] = []
		write.mockImplementation(() => {
			starts.push(clock.t)
			return Promise.resolve()
		})
		const from = clock.t
		for (let s = 0; s < 7_200; s++) {
			internals.dirty = true
			internals.tick()
			await new Promise<void>(resolve => setImmediate(resolve))
			clock.t += 1_000
		}
		expect(starts).toEqual([from, from + PERIODIC_MS])
	})

	it("a journal tail at the trigger makes a snapshot due after the main-thread spacing; one byte under it does not", async () => {
		const { internals, clock } = harness()
		clock.t = LATE
		const cadence = vi
			.spyOn(internals.persistence, "snapshotCadence")
			.mockReturnValue({
				snapshotBytes: BIG,
				journalBytes: 32 * 1024 * 1024 - 1,
				onWorker: false,
			})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() => Promise.resolve())
		internals.dirty = true
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1)
		await new Promise<void>(resolve => setImmediate(resolve))
		internals.dirty = true
		clock.t += MAIN_SPACING_MS
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1) // under the trigger: periodic
		cadence.mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 32 * 1024 * 1024,
			onWorker: false,
		})
		clock.t -= 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1) // at the trigger, 1 ms before the spacing
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2)
	})

	it("a journal hole is covered after 1 s on or off the worker: the main-thread spacing never delays it", async () => {
		const { internals, clock } = harness()
		clock.t = LATE
		const cadence = vi
			.spyOn(internals.persistence, "snapshotCadence")
			.mockReturnValue({ snapshotBytes: BIG, journalBytes: 0, onWorker: true })
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() => Promise.resolve())
		vi.spyOn(internals.persistence, "append").mockImplementation(() =>
			Promise.reject(new WaveKitError("full", SCANNER_JOURNAL_BACKLOG_CODE)),
		)
		const settle = () => new Promise<void>(resolve => setImmediate(resolve))
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(1)
		clock.t += 1_000
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(2) // worker live: 1 s
		cadence.mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 0,
			onWorker: false,
		})
		clock.t += 999
		internals.onStoreMutation(entry())
		await settle()
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2) // 1 ms short of 1 s
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(3) // main thread: 1 s, not 85,831 ms
		await settle()
		// A non-urgent journal-trigger snapshot still waits out the main-thread spacing.
		cadence.mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 32 * 1024 * 1024,
			onWorker: false,
		})
		internals.dirty = true
		clock.t += MAIN_SPACING_MS - 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(3)
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(4)
	})

	it("a failed hole snapshot on a quiet store is retried after 10 s, not at the periodic interval", async () => {
		const { internals, clock } = harness()
		clock.t = LATE
		vi.spyOn(internals.persistence, "snapshotCadence").mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 0,
			onWorker: false,
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementationOnce(() =>
				Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED")),
			)
			.mockImplementationOnce(() =>
				Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED")),
			)
			.mockImplementation(() => Promise.resolve())
		vi.spyOn(internals.persistence, "append").mockImplementation(() =>
			Promise.reject(new WaveKitError("full", SCANNER_JOURNAL_BACKLOG_CODE)),
		)
		const settle = () => new Promise<void>(resolve => setImmediate(resolve))
		internals.onStoreMutation(entry()) // the only mutation: the store goes quiet
		await settle()
		expect(write).toHaveBeenCalledTimes(1) // fails
		clock.t += SNAPSHOT_EVERY_MS - 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1) // 1 ms short of 10 s
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2) // still requested: 10 s, not 3,888 s; fails again
		await settle()
		clock.t += 2 * SNAPSHOT_EVERY_MS - 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2) // two failures in a row: 10 s x 2 = 20 s
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(3) // the request survives every failure; succeeds
		await settle()
		// Covered: dirty again only by the next change, then the periodic interval applies.
		internals.dirty = true
		clock.t += PERIODIC_MS - 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(3)
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(4)
	})
})

describe("ScannerService main-thread snapshot duty budget", () => {
	const BIG = 90_000_000
	const LATE = 10_000_000_000
	/** The measured main-thread build of an 88 MiB store. */
	const BUILD_MS = 2_700
	const settle = () => new Promise<void>(resolve => setImmediate(resolve))

	/**
	 * Holes on every 100 ms tick for `windowMs`; `onWorker(n)` says whether the snapshot after `n`
	 * earlier ones is built by the worker or on the main thread (holding the clock for BUILD_MS).
	 * Returns the starts and the main-thread time spent building.
	 */
	async function recurringHoles(
		windowMs: number,
		onWorker: (snapshots: number) => boolean,
	): Promise<{ starts: number[]; from: number; busyMs: number }> {
		const { internals, clock } = harness()
		clock.t = LATE
		const builds = { count: 0, ms: 0 }
		const starts: number[] = []
		vi.spyOn(internals.persistence, "snapshotCadence").mockImplementation(
			() => ({
				snapshotBytes: BIG,
				journalBytes: 0,
				onWorker: onWorker(starts.length),
			}),
		)
		vi.spyOn(internals.persistence, "mainSnapshotBuild").mockImplementation(
			() => ({ ...builds }),
		)
		let busyMs = 0
		vi.spyOn(internals.persistence, "writeSnapshotOf").mockImplementation(
			() => {
				const worker = onWorker(starts.length)
				starts.push(clock.t)
				if (!worker) {
					builds.count += 1
					builds.ms = BUILD_MS
					busyMs += BUILD_MS
					clock.t += BUILD_MS // the synchronous build holds the main thread
				}
				return Promise.resolve()
			},
		)
		vi.spyOn(internals.persistence, "append").mockImplementation(() =>
			Promise.reject(new WaveKitError("full", SCANNER_JOURNAL_BACKLOG_CODE)),
		)
		const from = clock.t
		while (clock.t - from < windowMs) {
			internals.onStoreMutation(entry()) // every change finds the journal refusing
			await settle()
			internals.tick()
			clock.t += 100
		}
		return { starts, from, busyMs }
	}

	it("recurring holes with the worker down: the first is covered at once, then builds stay at or under 10 % of the main thread", async () => {
		const window = 10 * 60_000
		const { starts, from, busyMs } = await recurringHoles(window, () => false)
		expect(starts[0]).toBe(from) // the first hole: at once, well inside 1 s
		// Each next start is the last end plus 9 x 2,700 ms or the hole backoff after i snapshots,
		// whichever is later (within one 100 ms tick), never sooner.
		for (let i = 1; i < starts.length; i++) {
			const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0)
			const due = Math.max(BUILD_MS + 24_300, holeSnapshotSpacingMs(i))
			expect(gap).toBeGreaterThanOrEqual(due)
			expect(gap).toBeLessThan(due + 100)
		}
		// 27 s x 8, then the backoff's 32, 64 and 128 s: 12 builds in 600 s (440 s, the next
		// due at 696 s), not one back-to-back every 2.7 s (222).
		expect(starts.length).toBe(12)
		// Any window holds at most 10 % plus the one build it may end inside; whole build + rest
		// cycles hold 10 % exactly.
		expect(busyMs).toBeLessThanOrEqual(0.1 * window + BUILD_MS)
		const cycles = (starts.at(-1) ?? 0) - from + BUILD_MS + 24_300
		expect(busyMs / cycles).toBeLessThanOrEqual(0.1)
	})

	it("worker-built holes stay at 1 s, even right after a main-thread build, until the hole backoff", async () => {
		// The first snapshot resets the stale mirror on the main thread; the worker builds the rest.
		const { starts, from } = await recurringHoles(60_000, n => n > 0)
		expect(starts[0]).toBe(from)
		// Due 1 s after the first start: the first hole after the 2.7 s build releases the thread.
		expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBe(BUILD_MS + 100)
		// 1 s up to the 5th success in a row, then 2, 4, 8, 16, 32 s.
		const gaps = starts.slice(2).map((t, i) => t - (starts[i + 1] ?? 0))
		expect(gaps).toEqual([1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000])
		expect(starts.length).toBe(9) // 0, 2.8, 3.8, 4.8, 5.8, 7.8, 11.8, 19.8, 35.8 s; next at 67.8 s
	})

	it("rests from the end of a worker fallback the main thread built when the write settled", async () => {
		const { internals, clock } = harness()
		clock.t = LATE
		const builds = { count: 0, ms: 0 }
		vi.spyOn(internals.persistence, "snapshotCadence").mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 0,
			onWorker: false,
		})
		vi.spyOn(internals.persistence, "mainSnapshotBuild").mockImplementation(
			() => ({ ...builds }),
		)
		let finish!: () => void
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementationOnce(
				() =>
					new Promise<void>(resolve => {
						finish = () => {
							builds.count += 1 // the worker failed: built on the main thread
							builds.ms = BUILD_MS
							resolve()
						}
					}),
			)
			.mockImplementation(() => Promise.resolve())
		vi.spyOn(internals.persistence, "append").mockImplementation(() =>
			Promise.reject(new WaveKitError("full", SCANNER_JOURNAL_BACKLOG_CODE)),
		)
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(1)
		clock.t += 5_000
		finish()
		await settle()
		const end = clock.t
		internals.onStoreMutation(entry())
		await settle()
		clock.t = end + 24_300 - 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1) // 1 ms short of 9 x 2,700 ms after its end
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2)
	})
})

describe("ScannerService snapshot retry, hole backoff and clock", () => {
	const BIG = 90_000_000
	const PERIODIC_MS = 3_888_000
	const LATE = 10_000_000_000
	const settle = () => new Promise<void>(resolve => setImmediate(resolve))
	const failing = () =>
		Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED"))

	it("retries a failing periodic snapshot after 10 s, doubling per failure up to the periodic interval", async () => {
		const { internals, clock } = harness()
		clock.t = LATE
		vi.spyOn(internals.persistence, "snapshotCadence").mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 0,
			onWorker: true,
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(failing)
		internals.dirty = true
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1)
		await settle()
		// 10 s x 2^(f - 1): 10, 20, ... 2,560 s, then the 3,888 s periodic interval caps it.
		const retries = [
			10_000,
			20_000,
			40_000,
			80_000,
			160_000,
			320_000,
			640_000,
			1_280_000,
			2_560_000,
			PERIODIC_MS,
			PERIODIC_MS,
		]
		for (const [i, retry] of retries.entries()) {
			clock.t += retry - 1
			internals.tick()
			expect(write).toHaveBeenCalledTimes(i + 1) // 1 ms short
			clock.t += 1
			internals.tick()
			expect(write).toHaveBeenCalledTimes(i + 2)
			await settle()
		}
		// A success resets the retry: the next change waits the periodic interval again.
		write.mockImplementation(() => Promise.resolve())
		clock.t += PERIODIC_MS
		internals.tick()
		await settle()
		const calls = write.mock.calls.length
		internals.dirty = true
		clock.t += 10_000
		internals.tick()
		expect(write).toHaveBeenCalledTimes(calls)
	})

	it("a hole retry after failures is capped at 5 min, not the periodic interval", async () => {
		const { internals, clock } = harness()
		clock.t = LATE
		vi.spyOn(internals.persistence, "snapshotCadence").mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 0,
			onWorker: true,
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(failing)
		vi.spyOn(internals.persistence, "append").mockImplementation(() =>
			Promise.reject(new WaveKitError("full", SCANNER_JOURNAL_BACKLOG_CODE)),
		)
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(1)
		// 10, 20, 40, 80, 160 s, then min(5 min, 320 s) = 300 s from the 6th failure on.
		for (const [i, retry] of [
			10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
		].entries()) {
			clock.t += retry - 1
			internals.tick()
			expect(write).toHaveBeenCalledTimes(i + 1)
			clock.t += 1
			internals.tick()
			expect(write).toHaveBeenCalledTimes(i + 2)
			await settle()
		}
	})

	/** Six successful worker hole snapshots in a row (streak 6), then `quietMs` without a hole. */
	async function streakThenQuiet(quietMs: number): Promise<{
		internals: Internals
		clock: { t: number }
		write: ReturnType<typeof vi.fn>
	}> {
		const { internals, clock } = harness()
		clock.t = LATE
		vi.spyOn(internals.persistence, "snapshotCadence").mockReturnValue({
			snapshotBytes: BIG,
			journalBytes: 0,
			onWorker: true,
		})
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() => Promise.resolve())
		vi.spyOn(internals.persistence, "append").mockImplementation(() =>
			Promise.reject(new WaveKitError("full", SCANNER_JOURNAL_BACKLOG_CODE)),
		)
		for (let n = 0; n < 6; n++) {
			clock.t += holeSnapshotSpacingMs(n)
			internals.onStoreMutation(entry())
			await settle()
			expect(write).toHaveBeenCalledTimes(n + 1)
		}
		clock.t += quietMs
		internals.onStoreMutation(entry())
		await settle()
		expect(write).toHaveBeenCalledTimes(7) // long past any spacing
		return {
			internals,
			clock,
			write: write as unknown as ReturnType<typeof vi.fn>,
		}
	}

	it("backs off hole snapshots after 5 in a row; a hole 1 ms short of 10 min after the last one is the same episode", async () => {
		const { internals, clock, write } = await streakThenQuiet(
			HOLE_STREAK_RESET_MS - 1,
		)
		// Streak 7 now: 1 s x 2^(7 - 4) = 8 s.
		internals.onStoreMutation(entry())
		await settle()
		clock.t += 8_000 - 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(7)
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(8)
	})

	it("a hole 10 min after the last hole snapshot starts a new episode: 1 s again", async () => {
		const { internals, clock, write } =
			await streakThenQuiet(HOLE_STREAK_RESET_MS)
		internals.onStoreMutation(entry())
		await settle()
		clock.t += 999
		internals.tick()
		expect(write).toHaveBeenCalledTimes(7)
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(8) // streak 1: 1 s
	})

	it("a wall-clock step back does not delay snapshots: the cadence runs on the monotonic clock", async () => {
		const { internals, clock } = harness()
		const mono = { t: 5_000 }
		internals.snapshotClock = () => mono.t
		const write = vi
			.spyOn(internals.persistence, "writeSnapshotOf")
			.mockImplementation(() => Promise.resolve())
		internals.dirty = true
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1) // the first snapshot: at once
		await settle()
		clock.t -= 3_600_000 // NTP steps the wall clock back an hour
		internals.dirty = true
		mono.t += 10_000 - 1
		clock.t += 10_000 - 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(1)
		mono.t += 1
		clock.t += 1
		internals.tick()
		expect(write).toHaveBeenCalledTimes(2) // 10 s on the monotonic clock, not 1 h 10 s
	})
})

describe("ScannerService main-thread budget at the real fallback", () => {
	const BUILD_MS = 2_700
	const settle = () => new Promise<void>(resolve => setImmediate(resolve))

	/** A worker that acknowledges every charged message (resets included) and never commits. */
	function ackingWorker(): SnapshotWorkerFactory {
		return () => {
			let listener: ((value: unknown) => void) | null = null
			const port: SnapshotWorkerPort = {
				postMessage: (m: SnapshotWorkerRequest) => {
					if (m.type === "commit") return
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
	}

	it("recurring holes whose worker request overflows (maxQueuedBytes 1) keep main-thread builds at or under 10 %", async () => {
		const { internals, clock } = harness()
		clock.t = 10_000_000_000
		const persistence = new ScannerPersistence({
			dir: internals.storageDir,
			logger: createLogger({ level: "fatal" }),
			now: () => clock.t,
			buildClock: () => clock.t,
			snapshotWorker: { factory: ackingWorker(), maxQueuedBytes: 1 },
		})
		await persistence.load()
		internals.persistence = persistence
		internals.store.ingest(
			makeObs({ id: "o1", centreHz: 446_000_000, startedAt: clock.t }),
		)
		const snapshot = internals.store.snapshot.bind(internals.store)
		const builds: number[] = []
		vi.spyOn(internals.store, "snapshot").mockImplementation(() => {
			builds.push(clock.t)
			clock.t += BUILD_MS // the synchronous clone + stringify holds the main thread
			return snapshot()
		})
		const write = vi.spyOn(persistence, "writeSnapshotOf")
		const warn = vi.spyOn(internals.log, "warn")
		// Failed journal batches (no line reaches the mirror, so each reset leaves it live): every
		// hole finds the worker live and its request overflowing to the main path.
		vi.spyOn(persistence, "append").mockImplementation(() =>
			Promise.reject(new WaveKitError("disk", "SCANNER_PERSIST_FAILED")),
		)
		const window = 60_000
		const from = clock.t
		try {
			while (clock.t - from < window) {
				internals.onStoreMutation(entry())
				await settle()
				internals.tick()
				await settle()
				clock.t += 100
			}
		} finally {
			await persistence.closeSnapshotWorker()
		}
		expect(persistence.snapshotWorkerStatus()?.overflows).toBeGreaterThan(0)
		// Deferred requests, not builds: the worker was asked about every second.
		expect(write.mock.calls.length).toBeGreaterThan(builds.length)
		// 0, 27 and 54 s: each build 2.7 s, then 9 x 2.7 s of rest.
		expect(builds.length).toBe(3)
		for (let i = 1; i < builds.length; i++)
			expect((builds[i] ?? 0) - (builds[i - 1] ?? 0)).toBeGreaterThanOrEqual(
				BUILD_MS + 24_300,
			)
		const busyMs = builds.length * BUILD_MS
		expect(busyMs).toBeLessThanOrEqual(0.1 * window + BUILD_MS)
		// A deferral is no failure: nothing warns.
		expect(warn).not.toHaveBeenCalledWith(
			expect.anything(),
			"Snapshot write failed",
		)
	})
})

function entry(): Parameters<ScannerPersistence["append"]>[0] {
	return {
		at: new Date(0).toISOString(),
		op: "observation",
		payload: { discoveries: [], observations: [], deleted: [] },
	}
}

function preparedMetadata(discoveryId: string): PreparedRecordingMetadata {
	const operationId = randomUUID()
	return {
		version: 1,
		operationId,
		producerRecordingId: operationId,
		discoveryId,
		observationId: "o1",
		alias: recordingAlias(discoveryId, operationId),
		artifact: recordingArtifact(discoveryId, operationId),
		desiredState: "linked",
		binding: {
			sourceId: "src-1",
			engineInstanceId: randomUUID(),
			stream: 1,
			epoch: 1,
			channelId: "opaque",
			channelGeneration: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48000,
			groupDelayInputSamples: null,
			targetHz: 446_000_000,
			captureCentreHz: null,
			tuningTrust: "commanded",
		},
		expectedOutput: {
			sampleRateHz: 8000,
			channelCount: 1,
			outputFrames: 80,
			fileBytes: 204,
		},
	}
}
