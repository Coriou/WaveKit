import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import {
	MAX_RECOVERY_OPERATIONS,
	PreparedRecordingMetadataSchema,
	PreparedRecordingOperationsSchema,
	recordingAlias,
	recordingArtifact,
	recordingEngineInstanceId,
} from "../../../../src/core/scanner/store/recording-operation.js"
import type { PreparedRecordingMetadata } from "../../../../src/core/scanner/store/recording-operation.js"
import { parseStoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const now = () => 1_700_000_000_000
const logger = createLogger({ level: "fatal" })
function setup() {
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now,
		newId: counterIds(),
	})
	const { discoveryId } = store.ingest(
		makeObs({ id: "o1", centreHz: 446_000_000, startedAt: now() }),
	)
	if (discoveryId === null) throw new Error("Test discovery missing")
	const operationId = randomUUID()
	const metadata: PreparedRecordingMetadata = {
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
	return { store, metadata, discoveryId }
}
async function withDir(fn: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-task42-"))
	try {
		await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe("Task42 private prepared metadata", () => {
	it("keeps prepare and inverse invisible to every public store getter and change listener", () => {
		const { store, metadata, discoveryId } = setup()
		const before = {
			d: store.get(discoveryId),
			list: store.list({}),
			obs: store.observations(discoveryId, null, 100),
		}
		const changes = vi.fn()
		const mutations: Omit<JournalEntry, "seq">[] = []
		store.on("change", changes)
		store.on("mutation", entry =>
			mutations.push(entry as Omit<JournalEntry, "seq">),
		)
		let registered: Omit<JournalEntry, "seq"> | undefined
		const entry = store.prepareRecording(metadata, exact => {
			registered = exact
		})
		expect(registered).toBe(entry)
		expect(mutations[0]).toBe(entry)
		expect(parseStoreMutation(entry.payload)?.discoveries).toEqual([])
		expect({
			d: store.get(discoveryId),
			list: store.list({}),
			obs: store.observations(discoveryId, null, 100),
		}).toEqual(before)
		store.removePreparedRecording(metadata.operationId)
		expect(changes).not.toHaveBeenCalled()
		expect(store.get(discoveryId)).toEqual(before.d)
	})

	it("emits the idempotent inverse when the memory entry is already absent", () => {
		const { store, metadata } = setup()
		const mutations = vi.fn()
		store.on("mutation", mutations)
		const entry = store.removePreparedRecording(metadata.operationId)
		expect(mutations).toHaveBeenCalledWith(entry)
		expect(
			parseStoreMutation(entry.payload)?.preparedRecordingOperations,
		).toEqual({ add: [], remove: [metadata.operationId] })
	})

	it("preserves unrelated same-value ABA, cut state and count mutations on abort/replay", () => {
		const { store, metadata, discoveryId } = setup()
		store.prepareRecording(metadata)
		const snapshot = store.snapshot()
		store.attachRecordings("o1", ["other"], "cut")
		store.setEvidenceFlags(discoveryId, { recordings: 7 })
		store.setEvidenceFlags(discoveryId, { recordings: 1 })
		const entries: JournalEntry[] = []
		store.on("mutation", entry =>
			entries.push({
				...(entry as Omit<JournalEntry, "seq">),
				seq: entries.length + 1,
			}),
		)
		store.attachRecordings("o1", [], "encrypted-dropped")
		store.removePreparedRecording(metadata.operationId)
		const restored = new DiscoveryStore({
			maxDiscoveries: 100,
			now,
			newId: counterIds(),
		})
		restored.restore(snapshot)
		for (const entry of entries) restored.replay(entry)
		expect(
			restored.observations(discoveryId, null, 100).items[0]?.recording,
		).toBe("encrypted-dropped")
		expect(restored.preparedRecordingOperations()).toEqual([])
		expect(store.get(discoveryId)?.evidence.recordings).toBe(1)
	})

	it("builds from current state after a simulated marker-fsync await and rejects stale plans", async () => {
		const { store, metadata, discoveryId } = setup()
		store.prepareRecording(metadata)
		const stale = store.buildRecordingCommitPlan(metadata.operationId)
		expect(stale).not.toBeNull()
		await Promise.resolve()
		store.attachRecordings("o1", ["other"], "cut")
		store.setEvidenceFlags(discoveryId, { recordings: 9 })
		expect(stale && store.recordingCommitPlanCurrent(stale)).toBe(false)
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		if (plan === null) throw new Error("Test plan missing")
		expect(plan.recordingCount).toBe(10)
		expect(plan.recordingIds).toEqual(["other", metadata.alias])
		expect(store.recordingCommitPlanCurrent(plan)).toBe(true)
		store.applyRecordingCommitPlan(plan)
		expect(store.get(discoveryId)?.evidence.recordings).toBe(10)
	})

	it("queues projection before a reentrant public change deletes the discovery", () => {
		const { store, metadata, discoveryId } = setup()
		store.prepareRecording(metadata)
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		if (plan === null) throw new Error("Test plan missing")
		store.applyRecordingCommitPlan(plan)
		const entries: JournalEntry[] = []
		store.on("mutation", entry =>
			entries.push({
				...(entry as Omit<JournalEntry, "seq">),
				seq: entries.length + 1,
			}),
		)
		store.once("change", () => {
			store.delete(discoveryId)
		})
		store.publishRecordingCommit(plan)
		const replay = new DiscoveryStore({
			maxDiscoveries: 100,
			now,
			newId: counterIds(),
		})
		for (const entry of entries) replay.replay(entry)
		expect(replay.get(discoveryId)).toBeUndefined()
	})

	it("attempts notification even when the projection listener throws after commit", () => {
		const { store, metadata, discoveryId } = setup()
		store.prepareRecording(metadata)
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		if (plan === null) throw new Error("Test plan missing")
		store.applyRecordingCommitPlan(plan)
		const change = vi.fn()
		store.on("mutation", () => {
			throw new Error("injected listener")
		})
		store.on("change", change)
		expect(() => store.publishRecordingCommit(plan)).toThrow(
			"injected listener",
		)
		expect(change).toHaveBeenCalled()
		expect(store.get(discoveryId)?.evidence.recordings).toBe(1)
	})

	it("rejects unknown versions/keys, invalid identities/output, duplicate and aggregate overflow", () => {
		const { metadata, store } = setup()
		for (const value of [
			{ ...metadata, version: 2 },
			{ ...metadata, foreign: true },
			{ ...metadata, discoveryId: "../escape" },
			{
				...metadata,
				binding: { ...metadata.binding, sourceId: "x".repeat(257) },
			},
			{
				...metadata,
				expectedOutput: { ...metadata.expectedOutput, fileBytes: 1 },
			},
		])
			expect(PreparedRecordingMetadataSchema.safeParse(value).success).toBe(
				false,
			)
		expect(
			PreparedRecordingOperationsSchema.safeParse([metadata, metadata]).success,
		).toBe(false)
		expect(
			PreparedRecordingOperationsSchema.safeParse(
				Array.from({ length: MAX_RECOVERY_OPERATIONS + 1 }, () => metadata),
			).success,
		).toBe(false)
		store.prepareRecording(metadata)
		expect(() =>
			store.prepareRecording({ ...metadata, desiredState: "cut" }),
		).toThrow()
		expect(() =>
			store.replay({
				seq: 1,
				at: "now",
				op: "evidence",
				payload: {
					discoveries: [],
					observations: [],
					deleted: [],
					preparedRecordingOperations: {
						add: [{ ...metadata, desiredState: "cut" }],
						remove: [],
					},
				},
			}),
		).toThrow()
		expect(store.preparedRecordingOperations()[0]?.desiredState).toBe("linked")
	})

	it("rejects aggregate overflow across journal entries before touching public records", () => {
		const { store, metadata } = setup()
		const records = Array.from({ length: MAX_RECOVERY_OPERATIONS }, () => {
			const id = randomUUID()
			return {
				...metadata,
				operationId: id,
				producerRecordingId: id,
				alias: recordingAlias(metadata.discoveryId, id),
				artifact: recordingArtifact(metadata.discoveryId, id),
			}
		})
		store.restore({ ...store.snapshot(), recordingOperations: records })
		const before = store.get(metadata.discoveryId)
		expect(() =>
			store.replay({
				seq: 1,
				at: "later",
				op: "evidence",
				payload: {
					discoveries: [],
					observations: [],
					deleted: [metadata.discoveryId],
					preparedRecordingOperations: { add: [metadata], remove: [] },
				},
			}),
		).toThrow()
		expect(store.get(metadata.discoveryId)).toEqual(before)
		expect(store.preparedRecordingOperations()).toHaveLength(
			MAX_RECOVERY_OPERATIONS,
		)
	})

	it("rejects association removal/replacement and stale operation identity", () => {
		const { store, metadata, discoveryId } = setup()
		store.prepareRecording(metadata)
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		if (plan === null) throw new Error("Test plan missing")
		expect(store.recordingAssociation(discoveryId, "o1")?.aliasIds).toEqual([])
		store.removePreparedRecording(metadata.operationId)
		expect(store.recordingCommitPlanCurrent(plan)).toBe(false)
		store.prepareRecording(metadata)
		expect(store.recordingCommitPlanCurrent(plan)).toBe(false)
		store.delete(discoveryId)
		expect(store.recordingAssociation(discoveryId, "o1")).toBeNull()
		expect(store.buildRecordingCommitPlan(metadata.operationId)).toBeNull()
	})

	it("validates historical source/stream/epoch for recovery without repairing aliases", () => {
		const { store, metadata, discoveryId } = setup()
		const snapshot = store.snapshot()
		const observation = snapshot.observations[0]
		if (observation === undefined) throw new Error("Test observation missing")
		observation.sourceId = "reused-source"
		observation.sampleRange.epoch = 2
		store.restore(snapshot)
		expect(
			store.recordingAssociation(discoveryId, "o1", metadata.binding),
		).toBeNull()
		expect(store.recordingAssociation(discoveryId, "o1")).toEqual({
			aliasIds: [],
		})
		const historical = {
			...metadata.binding,
			sourceId: "reused-source",
			epoch: 2,
			engineInstanceId: null,
			channelId: null,
			channelGeneration: null,
		}
		expect(store.recordingAssociation(discoveryId, "o1", historical)).toEqual({
			aliasIds: [],
		})
		expect(
			store.recordingAssociation(discoveryId, "o1", {
				...historical,
				stream: 2,
			}),
		).toBeNull()
		expect(store.get(discoveryId)?.evidence.recordings).toBe(0)
		expect(
			store.observations(discoveryId, null, 100).items[0]?.recordingIds,
		).toEqual([])
	})

	it("accepts legacy snapshots/mutations and binds engine UUID to object identity", () => {
		const { store } = setup()
		store.restore({ discoveries: [], observations: [], corrections: [] })
		expect(store.preparedRecordingOperations()).toEqual([])
		expect(
			parseStoreMutation({ discoveries: [], observations: [], deleted: [] }),
		).not.toBeNull()
		const engine = {}
		expect(recordingEngineInstanceId(engine)).toBe(
			recordingEngineInstanceId(engine),
		)
		expect(recordingEngineInstanceId({})).not.toBe(
			recordingEngineInstanceId(engine),
		)
	})
})

describe("Task42 persistence authority health", () => {
	it("roundtrips prepared metadata and exact inverse after snapshot of failed prepare", async () =>
		withDir(async dir => {
			const { store, metadata } = setup()
			let fail = true
			const persistence = new ScannerPersistence({
				dir,
				logger,
				now,
				appendFile: async () => {
					if (fail) throw new Error("injected append")
				},
			})
			expect((await persistence.load()).recoveryHealth).toBe("healthy")
			const entry = store.prepareRecording(metadata)
			await expect(persistence.append(entry)).rejects.toThrow()
			await persistence.writeSnapshot(store.snapshot())
			fail = false
			const loaded = await new ScannerPersistence({ dir, logger, now }).load()
			expect(loaded.recordingOperations).toHaveLength(1)
			store.restore(loaded)
			const inverse = store.removePreparedRecording(metadata.operationId)
			// Real sole writer, separate from the deliberately failing writer above.
			const recovery = new ScannerPersistence({ dir, logger, now })
			await recovery.load()
			await recovery.append(inverse)
			const final = await new ScannerPersistence({ dir, logger, now }).load()
			store.restore(final)
			for (const e of final.entries) store.replay(e)
			expect(store.preparedRecordingOperations()).toEqual([])
		}))

	it("marks degraded successful snapshot fallback, unreadable journal and dropped corruption", async () =>
		withDir(async dir => {
			await writeFile(join(dir, "discoveries.json"), "{broken")
			const persistence = new ScannerPersistence({ dir, logger, now })
			expect((await persistence.load()).recoveryHealth).toBe("degraded")
			expect(persistence.recoveryHealth()).toBe("degraded")
			await writeFile(join(dir, "journal"), "not a directory")
			expect(
				(await new ScannerPersistence({ dir, logger, now }).load())
					.recoveryHealth,
			).toBe("degraded")
			await rm(join(dir, "journal"))
			await mkdir(join(dir, "journal"))
			await writeFile(
				join(dir, "journal/observations-20231114.jsonl"),
				"bad\n{torn",
			)
			const state = await new ScannerPersistence({ dir, logger, now }).load()
			expect(state.recoveryHealth).toBe("degraded")
			expect(state.droppedLines).toBe(2)
		}))

	it("marks conflicting prepared journal authority degraded without overwriting it in replay", async () =>
		withDir(async dir => {
			const { store, metadata } = setup()
			const persistence = new ScannerPersistence({ dir, logger, now })
			await persistence.load()
			await persistence.append(store.prepareRecording(metadata))
			await persistence.append({
				at: "later",
				op: "evidence",
				payload: {
					discoveries: [],
					observations: [],
					deleted: [],
					preparedRecordingOperations: {
						add: [{ ...metadata, desiredState: "cut" }],
						remove: [],
					},
				},
			})
			expect(
				(await new ScannerPersistence({ dir, logger, now }).load())
					.recoveryHealth,
			).toBe("degraded")
		}))
})
