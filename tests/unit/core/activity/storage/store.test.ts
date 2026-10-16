import { rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import { buildActivityRow } from "../../../../../src/core/activity/storage/row.js"
import { TELEMETRY_OUTPUT_TYPES } from "../../../../../src/core/activity/storage/telemetry.js"
import {
	countFts,
	envelope,
	openStore,
	readRecords,
	roots,
	stores,
	tempDir,
} from "./helpers.js"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity store", () => {
	it("persists a reception and ignores a duplicate event id", async () => {
		const stateDir = await tempDir()
		const store = await openStore({ stateDir })
		const commits: string[] = []
		store.onCommit(identity => {
			commits.push(identity.committedMax)
		})
		const event = envelope({ eventId: "plane-1" })
		expect(store.admit(event)).toEqual({ admitted: true })
		expect(store.admit(event)).toEqual({ admitted: true })
		expect(commits).toEqual(["1", "1"])
		expect(store.stats()).toMatchObject({
			admitted: 2,
			committed: 1,
			duplicates: 1,
			rows: 1,
			paused: false,
			excludedTelemetry: 0,
		})
		const records = await readRecords(store.dbPath)
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({
			eventId: "plane-1",
			commitSeq: "1",
			kind: "decoder-reception",
		})
		expect(await countFts(store.dbPath, "alphaunique")).toBe(1)
		expect(await countFts(store.dbPath, "leafunique")).toBe(1)
		expect(store.stats().writer).toBe("running")
		await store.close()
		expect(store.stats().writer).toBe("stopped")
		await expect(
			stat(join(stateDir, "activity", "activity.lock")),
		).rejects.toThrow()
		await expect(
			stat(join(stateDir, "activity", "activity.lock.db")),
		).resolves.toBeTruthy()
	})

	it("does not store telemetry output", async () => {
		const store = await openStore()
		for (const outputType of TELEMETRY_OUTPUT_TYPES)
			expect(store.admit(envelope({ outputType })).admitted).toBe(false)
		expect(store.admit(envelope({ outputType: "future-type" })).admitted).toBe(
			true,
		)
		expect(store.stats().excludedTelemetry).toBe(TELEMETRY_OUTPUT_TYPES.length)
		expect(store.stats().committed).toBe(1)
		const records = await readRecords(store.dbPath)
		expect(records).toHaveLength(1)
		if (records[0]?.kind === "decoder-reception")
			expect(records[0].payload.outputType).toBe("future-type")
	})

	it("writes one gap record after the quiet period, not on the next admit", async () => {
		let clock = 1_000
		const store = await openStore({
			now: () => clock,
			limits: {
				batchWindowMs: 0,
				globalBurst: 1,
				globalRatePerSec: 1,
				decoderBurst: 10,
				decoderRatePerSec: 10,
			},
		})
		expect(
			store.admit(envelope({ eventId: "first", decoderId: "radio" })).admitted,
		).toBe(true)
		expect(
			store.admit(envelope({ eventId: "dropped", decoderId: "radio" })),
		).toEqual({ admitted: false, reason: "rate-limited" })
		clock += 1_000
		expect(
			store.admit(envelope({ eventId: "second", decoderId: "other" })).admitted,
		).toBe(true)
		const early = await readRecords(store.dbPath)
		expect(early.map(record => record.kind)).toEqual([
			"decoder-reception",
			"decoder-reception",
		])
		clock += 5_000
		expect(
			store.admit(envelope({ eventId: "third", decoderId: "other" })).admitted,
		).toBe(true)
		const records = await readRecords(store.dbPath)
		expect(records.map(record => record.kind)).toEqual([
			"decoder-reception",
			"decoder-reception",
			"ingestion-gap",
			"decoder-reception",
		])
		const gap = records[2]
		expect(gap?.kind).toBe("ingestion-gap")
		if (gap?.kind === "ingestion-gap") {
			expect(gap.payload.reason).toBe("rate-limited")
			expect(gap.payload.dropped).toBe(1)
			expect(gap.payload.decoderIds).toEqual(["radio"])
		}
		expect(store.stats().dropped["rate-limited"]).toBe(1)
	})

	it("records a write failure and stores the gap on the next admit", async () => {
		const store = await openStore({
			failNextWrites: 1,
			limits: {
				batchWindowMs: 0,
				globalBurst: 10,
				decoderBurst: 10,
				gapQuietMs: 0,
			},
		})
		expect(store.admit(envelope({ eventId: "lost" })).admitted).toBe(true)
		expect(store.stats().dropped["write-failed"]).toBe(1)
		expect(await readRecords(store.dbPath)).toEqual([])
		expect(store.admit(envelope({ eventId: "kept" })).admitted).toBe(true)
		const records = await readRecords(store.dbPath)
		expect(records.map(record => record.eventId)).toEqual([
			expect.any(String),
			"kept",
		])
		expect(records[0]?.kind).toBe("ingestion-gap")
		if (records[0]?.kind === "ingestion-gap") {
			expect(records[0].payload).toMatchObject({
				reason: "write-failed",
				dropped: 1,
			})
		}
	})

	it("flushes the queued backlog after a thrown write without another admit", async () => {
		const stamp = "2026-10-12T00:00:00.000Z"
		const sample = buildActivityRow({
			version: ACTIVITY_RECORD_VERSION,
			eventId: "a",
			commitSeq: "0",
			producedAt: stamp,
			receivedAt: stamp,
			kind: "decoder-reception",
			payload: envelope({ eventId: "a", receivedAt: stamp }),
		})
		const store = await openStore({
			throwNextWrites: 1,
			limits: {
				batchWindowMs: 40,
				batchMaxItems: 10,
				batchMaxBytes: sample.recordBytes + 1,
				globalBurst: 10,
				decoderBurst: 10,
			},
		})
		expect(store.admit(envelope({ eventId: "a" })).admitted).toBe(true)
		expect(store.admit(envelope({ eventId: "b" })).admitted).toBe(true)
		expect(store.stats().dropped["write-failed"]).toBe(1)
		await new Promise(resolve => {
			setTimeout(resolve, 150)
		})
		const records = await readRecords(store.dbPath)
		expect(records.map(record => record.eventId)).toEqual(["b"])
	})

	it("flushes on the batch cap and on the batch window", async () => {
		const capped = await openStore({
			limits: {
				batchWindowMs: 60_000,
				batchMaxItems: 2,
				globalBurst: 10,
				decoderBurst: 10,
			},
		})
		expect(capped.admit(envelope({ eventId: "one" })).admitted).toBe(true)
		expect(await readRecords(capped.dbPath)).toHaveLength(0)
		expect(capped.admit(envelope({ eventId: "two" })).admitted).toBe(true)
		expect(await readRecords(capped.dbPath)).toHaveLength(2)

		const windowed = await openStore({
			limits: {
				batchWindowMs: 40,
				batchMaxItems: 10,
				globalBurst: 10,
				decoderBurst: 10,
			},
		})
		expect(windowed.admit(envelope({ eventId: "later" })).admitted).toBe(true)
		expect(await readRecords(windowed.dbPath)).toHaveLength(0)
		await new Promise(resolve => {
			setTimeout(resolve, 120)
		})
		expect(await readRecords(windowed.dbPath)).toHaveLength(1)
	})

	it("pauses while a reader holds the WAL and resumes after the checkpoint", async () => {
		const store = await openStore({
			limits: {
				batchWindowMs: 0,
				globalBurst: 10,
				decoderBurst: 10,
				walPassiveBytes: 1,
				walTruncateBytes: 1,
				walPauseBytes: 1,
				pauseRetryMs: 30,
				gapQuietMs: 0,
			},
		})
		expect(store.admit(envelope({ eventId: "visible" })).admitted).toBe(true)
		expect(store.stats().paused).toBe(false)
		const reader = await openSqliteFile(store.dbPath, true)
		reader.exec("BEGIN")
		reader.prepare("SELECT COUNT(*) AS n FROM activity").get()
		expect(store.admit(envelope({ eventId: "held" })).admitted).toBe(true)
		expect(store.stats().paused).toBe(true)
		expect(store.admit(envelope({ eventId: "paused" }))).toEqual({
			admitted: false,
			reason: "store-paused",
		})
		reader.exec("ROLLBACK")
		reader.close()
		await new Promise(resolve => {
			setTimeout(resolve, 150)
		})
		expect(store.stats().paused).toBe(false)
		expect(store.admit(envelope({ eventId: "resumed" })).admitted).toBe(true)
		const records = await readRecords(store.dbPath)
		expect(records.some(record => record.kind === "ingestion-gap")).toBe(true)
		expect(records.some(record => record.eventId === "resumed")).toBe(true)
		expect(store.stats().dropped["store-paused"]).toBeGreaterThan(0)
	}, 5_000)

	it("stages an open ingestion gap when admits stop", async () => {
		const store = await openStore({
			limits: {
				batchWindowMs: 0,
				globalBurst: 1,
				globalRatePerSec: 0,
				decoderBurst: 10,
				decoderRatePerSec: 10,
				gapQuietMs: 5_000,
			},
		})
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "Date"],
			now: Date.now(),
		})
		try {
			expect(
				store.admit(envelope({ eventId: "kept", decoderId: "radio" })).admitted,
			).toBe(true)
			expect(
				store.admit(envelope({ eventId: "dropped", decoderId: "radio" })),
			).toEqual({ admitted: false, reason: "rate-limited" })
			await vi.advanceTimersByTimeAsync(4_999)
			expect(
				(await readRecords(store.dbPath)).some(
					record => record.kind === "ingestion-gap",
				),
			).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			const records = await readRecords(store.dbPath)
			expect(records.map(record => record.kind)).toEqual([
				"decoder-reception",
				"ingestion-gap",
			])
			const gap = records[1]
			expect(gap?.kind).toBe("ingestion-gap")
			if (gap?.kind === "ingestion-gap") {
				expect(gap.payload).toMatchObject({
					reason: "rate-limited",
					dropped: 1,
					decoderIds: ["radio"],
				})
			}
		} finally {
			vi.useRealTimers()
		}
	})

	it("re-arms the gap quiet timer for drops that arrive while it waits", async () => {
		const store = await openStore({
			now: () => Date.now(),
			limits: {
				batchWindowMs: 0,
				globalBurst: 1,
				globalRatePerSec: 0,
				decoderBurst: 10,
				decoderRatePerSec: 10,
				gapQuietMs: 5_000,
			},
		})
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "Date"],
			now: Date.now(),
		})
		try {
			expect(
				store.admit(envelope({ eventId: "kept", decoderId: "radio" })).admitted,
			).toBe(true)
			expect(
				store.admit(envelope({ eventId: "dropped-1", decoderId: "radio" })),
			).toEqual({ admitted: false, reason: "rate-limited" })
			await vi.advanceTimersByTimeAsync(1_000)
			expect(
				store.admit(envelope({ eventId: "dropped-2", decoderId: "radio" })),
			).toEqual({ admitted: false, reason: "rate-limited" })
			await vi.advanceTimersByTimeAsync(4_000)
			expect(
				(await readRecords(store.dbPath)).some(
					record => record.kind === "ingestion-gap",
				),
			).toBe(false)
			await vi.advanceTimersByTimeAsync(999)
			expect(
				(await readRecords(store.dbPath)).some(
					record => record.kind === "ingestion-gap",
				),
			).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			const records = await readRecords(store.dbPath)
			const gap = records.find(record => record.kind === "ingestion-gap")
			expect(gap?.kind).toBe("ingestion-gap")
			if (gap?.kind === "ingestion-gap") {
				expect(gap.payload).toMatchObject({
					reason: "rate-limited",
					dropped: 2,
					decoderIds: ["radio"],
				})
			}
		} finally {
			vi.useRealTimers()
		}
	})

	it("writes an open ingestion gap during close before abandoning it", async () => {
		let clock = 10_000
		const store = await openStore({
			now: () => clock,
			limits: {
				batchWindowMs: 0,
				globalBurst: 1,
				globalRatePerSec: 0,
				decoderBurst: 10,
				gapQuietMs: 60_000,
			},
		})
		expect(
			store.admit(envelope({ eventId: "kept", decoderId: "radio" })).admitted,
		).toBe(true)
		expect(
			store.admit(envelope({ eventId: "dropped", decoderId: "radio" })),
		).toEqual({ admitted: false, reason: "rate-limited" })
		expect(
			(await readRecords(store.dbPath)).some(
				record => record.kind === "ingestion-gap",
			),
		).toBe(false)
		await store.close()
		const records = await readRecords(store.dbPath)
		expect(records.some(record => record.eventId === "kept")).toBe(true)
		const gap = records.find(record => record.kind === "ingestion-gap")
		expect(gap?.kind).toBe("ingestion-gap")
		if (gap?.kind === "ingestion-gap") {
			expect(gap.payload).toMatchObject({
				reason: "rate-limited",
				dropped: 1,
				decoderIds: ["radio"],
			})
		}
	})
})

// WG3 req 2.1, 6.5: status exposes the retention block and the flood-copy count.
describe("activity store stats: retention and flood copies", () => {
	it("counts a Meshtastic flood copy and reports per-share retention", async () => {
		const store = await openStore({
			limits: { globalBurst: 100, decoderBurst: 100 },
		})
		const mesh = (eventId: string, offsetMs: number) =>
			envelope({
				eventId,
				decoderId: "mesh-1",
				outputType: "meshtastic",
				category: "mesh",
				protocol: "meshtastic",
				entityKey: null,
				receivedAt: new Date(
					Date.parse("2026-10-12T00:00:00.000Z") + offsetMs,
				).toISOString(),
				decodedData: {
					from: 0x1234abcd,
					id: 42,
					portnum: 1,
					payloadB64: "aGk=",
				},
			})
		expect(store.admit(mesh("original", 0))).toEqual({ admitted: true })
		expect(store.admit(mesh("copy", 2_000))).toEqual({
			admitted: false,
			reason: "flood-copy",
		})
		expect(
			store.admit(envelope({ eventId: "plane", decoderId: "readsb" })),
		).toEqual({ admitted: true })
		expect(await readRecords(store.dbPath)).toHaveLength(2)
		const stats = store.stats()
		expect(stats.floodCopies).toBe(1)
		expect(Object.values(stats.dropped).reduce((a, b) => a + b, 0)).toBe(0)
		expect(stats.retention).toMatchObject({
			policy: "fair-share",
			effective: "fair-share",
			sharesTruncated: false,
			prefixFallbackSteps: 0,
		})
		expect(
			stats.retention?.shares.map(share => [share.key, share.rows]),
		).toEqual([
			["decoder:mesh-1", 1],
			["decoder:readsb", 1],
		])
	})
})
