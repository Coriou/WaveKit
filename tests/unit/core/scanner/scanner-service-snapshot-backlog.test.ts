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
			.spyOn(internals.persistence, "writeSnapshot")
			.mockImplementationOnce(() => stalled)
			.mockImplementation(() => Promise.resolve())
		const snapshot = vi.spyOn(internals.store, "snapshot")
		for (let i = 0; i < 100; i++) {
			internals.dirty = true // the store keeps mutating during the sweep
			clock.t += SNAPSHOT_EVERY_MS
			internals.tick()
		}
		expect(write).toHaveBeenCalledTimes(1)
		expect(snapshot).toHaveBeenCalledTimes(1)
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
			.spyOn(internals.persistence, "writeSnapshot")
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
			.spyOn(internals.persistence, "writeSnapshot")
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
			.spyOn(internals.persistence, "writeSnapshot")
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
			.spyOn(internals.persistence, "writeSnapshot")
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
			.spyOn(persistence, "writeSnapshot")
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
