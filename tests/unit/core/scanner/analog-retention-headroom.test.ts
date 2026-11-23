/**
 * Retention keeps room for the next analog recording. Admission refuses once used + outstanding +
 * RESERVATION exceeds the recordings cap; retention counts the store full once used + outstanding
 * + ADMISSION_HEADROOM (2 × RESERVATION) exceeds it, and then retires evictable files oldest
 * first (by media mtime) until the next recording fits. Before, retention evicted only past the
 * cap itself, so a store within one reservation of the cap refused every admission for good.
 * The quota status and its warning use the same test. Synthetic files and ids only.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import {
	ADMISSION_HEADROOM,
	AnalogOperations,
	MAX_ANALOG_FILE_BYTES,
	type AnalogMetadataAdapter,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import { MAX_OPERATION_METADATA_BYTES } from "../../../../src/core/scanner/store/recording-operation.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const RESERVATION = MAX_ANALOG_FILE_BYTES + MAX_OPERATION_METADATA_BYTES
const DAY = 86_400_000
const MAX_AGE_MS = 30 * DAY
const MIB = 1024 * 1024
/** 800 000 samples: a 1 600 044 B WAV, under one RESERVATION, so a shortfall of R needs two. */
const SAMPLES = 800_000
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

async function tempRoot(): Promise<string> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-analog-headroom-")),
	)
	dirs.push(root)
	return root
}

function storeWithDiscovery(): { store: DiscoveryStore; discoveryId: string } {
	const now = Date.now()
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => now,
		newId: counterIds(),
	})
	const { discoveryId } = store.ingest(
		makeObs({ id: "o1", centreHz: 446_000_000, startedAt: now }),
	)
	if (!discoveryId) throw new Error("Missing test discovery")
	return { store, discoveryId }
}

function adapterOf(store: DiscoveryStore): AnalogMetadataAdapter {
	return {
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, historical) =>
			store.recordingAssociation(d, o, historical),
		prepare: async metadata => {
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
}

const binding = (): RecordingBinding => ({
	sourceId: "src-1",
	engineInstanceId: randomUUID(),
	stream: 1,
	epoch: 1,
	channelId: "opaque-native-grant",
	channelGeneration: 1,
	inputFormat: "cf32",
	inputSampleRateHz: 48000,
	groupDelayInputSamples: null,
	targetHz: 446_000_000,
	captureCentreHz: null,
	tuningTrust: "unverified",
})

interface Stored {
	artifact: string
	bytes: number
	mtimeMs: number
}

async function harness(opts: { protectedName?: () => string | null } = {}) {
	const root = await tempRoot()
	const { store, discoveryId } = storeWithDiscovery()
	const limit = { maxBytes: 1024 * MIB }
	const protection: RecordingProtection = {
		isProtected: () => false,
		isDsdFmeFileProtected: () => false,
		isScannerFileProtected: (_d, name) => name === opts.protectedName?.(),
		discoveryHoldsKept: () => false,
	}
	const ops = new AnalogOperations({
		root,
		adapter: adapterOf(store),
		admits: () => true,
		serialise: async (_id, job) => job(),
		legacyBytes: async () => 0,
		limits: () => ({ maxBytes: limit.maxBytes, minFreeBytes: 0 }),
		freeBytes: async () => 1e12,
		...(opts.protectedName ? { protection } : {}),
	})
	await ops.recover()
	const begin = () =>
		ops.begin({ discoveryId, observationId: "o1", binding: binding() })
	/** One finalized file, its media mtime set to `mtimeMs`; its bytes as the inventory counts them. */
	const record = async (mtimeMs: number): Promise<Stored> => {
		const before = ops.managedBytes ?? 0
		const op = begin()
		await op.ready
		for (let i = 0; i < SAMPLES; i += 16_000)
			await op.push(new Int16Array(16_000))
		const receipt = await op.finish()
		expect(receipt.outcome).toBe("finalized")
		const artifact = receipt.artifact!
		await utimes(join(root, artifact), mtimeMs / 1000, mtimeMs / 1000)
		return { artifact, bytes: (ops.managedBytes ?? 0) - before, mtimeMs }
	}
	const used = (): number => ops.managedBytes ?? Number.NaN
	const retain = (keep: ReadonlySet<string> = new Set()) =>
		ops.retained(keep, MAX_AGE_MS, Date.now())
	/** The next admission's outcome: admitted (then cancelled) or its error code. */
	const admits = async (): Promise<true | string> => {
		const op = begin()
		try {
			await op.ready
			op.cancel()
			await op.settled
			return true
		} catch (err: unknown) {
			await op.settled
			return (err as { code?: string }).code ?? "unknown"
		}
	}
	return {
		root,
		ops,
		discoveryId,
		limit,
		record,
		used,
		retain,
		admits,
	}
}

/** The oldest-first prefix whose removal lets used + ADMISSION_HEADROOM fit under the cap. */
function expectedEvictions(
	files: readonly Stored[],
	used: number,
	cap: number,
): string[] {
	const out: string[] = []
	let left = used
	for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
		if (left + ADMISSION_HEADROOM <= cap) break
		out.push(f.artifact)
		left -= f.bytes
	}
	return out
}

/** Four files written in an order unrelated to their ages (and to their random ids). */
async function shuffledFour(h: Awaited<ReturnType<typeof harness>>) {
	const now = Date.now()
	const files: Stored[] = []
	for (const daysAgo of [2, 4, 1, 3])
		files.push(await h.record(now - daysAgo * DAY))
	return files
}

describe("analog retention keeps room for the next recording", () => {
	it("ADMISSION_HEADROOM is two reservations: 2 × (1 920 044 + 16 384) = 3 872 856 B", () => {
		expect(ADMISSION_HEADROOM).toBe(3_872_856)
		expect(ADMISSION_HEADROOM).toBe(2 * RESERVATION)
	})

	// Regression: before the fix this store refused every admission and retention evicted nothing.
	it("a store at cap − RESERVATION + 1 (stuck before): retention evicts the oldest, the next admission succeeds", async () => {
		const h = await harness()
		const files = await shuffledFour(h)
		h.limit.maxBytes = h.used() + RESERVATION - 1
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		const expected = expectedEvictions(files, h.used(), h.limit.maxBytes)
		expect(expected).toHaveLength(2)
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		// The two oldest (4 and 3 days) went, written second and fourth.
		expect(deleted).toEqual([files[1]!.artifact, files[3]!.artifact])
		for (const f of files)
			expect(existsSync(join(h.root, f.artifact))).toBe(
				!deleted.includes(f.artifact),
			)
		expect(h.ops.quotaShortfall(0)).toBeLessThanOrEqual(0)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("a store at exactly cap − RESERVATION (admission's edge) is full: evicts oldest until used + headroom fits, then admits", async () => {
		const h = await harness()
		const files = await shuffledFour(h)
		h.limit.maxBytes = h.used() + RESERVATION
		const expected = expectedEvictions(files, h.used(), h.limit.maxBytes)
		expect(expected.length).toBeGreaterThan(0)
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		expect(h.used() + ADMISSION_HEADROOM).toBeLessThanOrEqual(h.limit.maxBytes)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("at exactly cap − ADMISSION_HEADROOM nothing is evicted; one byte more evicts only the oldest", async () => {
		const h = await harness()
		const files = await shuffledFour(h)
		h.limit.maxBytes = h.used() + ADMISSION_HEADROOM
		expect(h.ops.quotaShortfall(0)).toBe(0)
		expect(await h.retain()).toEqual([])
		expect(await h.admits()).toBe(true)
		h.limit.maxBytes -= 1
		expect(h.ops.quotaShortfall(0)).toBe(1)
		expect(await h.retain()).toEqual([files[1]!.artifact])
		expect(h.ops.quotaShortfall(0)).toBeLessThanOrEqual(0)
		await h.ops.stop()
	}, 60_000)

	it("age expiry is unchanged: an aged file goes even with room, oldest first", async () => {
		const h = await harness()
		const now = Date.now()
		const young = await h.record(now - DAY)
		const aged = await h.record(now - 31 * DAY)
		h.limit.maxBytes = 1024 * MIB
		expect(await h.retain()).toEqual([aged.artifact])
		expect(existsSync(join(h.root, young.artifact))).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("held files are never evicted: a kept artifact is skipped (the next oldest goes), a kept discovery keeps all", async () => {
		let protectedName: string | null = null
		const h = await harness({ protectedName: () => protectedName })
		const files = await shuffledFour(h)
		protectedName = files[1]!.artifact.split("/").at(-1)!
		h.limit.maxBytes = h.used() + RESERVATION - 1
		// The discovery kept: nothing evictable, nothing evicted, still refused.
		expect(await h.retain(new Set([h.discoveryId]))).toEqual([])
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		// The oldest kept: the next two oldest go instead.
		const deleted = await h.retain()
		expect(deleted).not.toContain(files[1]!.artifact)
		expect(deleted).toEqual([files[3]!.artifact, files[0]!.artifact])
		expect(existsSync(join(h.root, files[1]!.artifact))).toBe(true)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("a store that keeps filling to its cap keeps admitting across retention passes (repeated fill)", async () => {
		const h = await harness()
		const now = Date.now()
		const first = await h.record(now - 5 * DAY)
		await h.record(now - 4 * DAY)
		await h.record(now - 3 * DAY)
		// Three files fill the store to exactly cap − ADMISSION_HEADROOM.
		h.limit.maxBytes = h.used() + ADMISSION_HEADROOM
		const gone: string[] = []
		for (let pass = 0; pass < 4; pass++) {
			expect(await h.admits()).toBe(true)
			// A new file lands (now-ish: the youngest), overfilling the headroom.
			await h.record(now - (2 - pass) * 60_000)
			expect(h.ops.quotaShortfall(0)).toBeGreaterThan(0)
			const deleted = await h.retain()
			expect(deleted).toHaveLength(1)
			gone.push(...deleted)
			expect(h.ops.quotaShortfall(0)).toBeLessThanOrEqual(0)
		}
		expect(gone[0]).toBe(first.artifact)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 120_000)
})

describe("the recordings quota status uses admission's full test", () => {
	function capture(): { log: Logger; lines: Record<string, unknown>[] } {
		const lines: Record<string, unknown>[] = []
		const sink = new Writable({
			write(chunk: Buffer, _enc, done) {
				for (const text of chunk.toString("utf8").split("\n"))
					if (text.trim() !== "")
						lines.push(JSON.parse(text) as Record<string, unknown>)
				done()
			},
		})
		return { log: pino({ level: "info" }, sink) as unknown as Logger, lines }
	}

	it("a store within one reservation of its cap with nothing removable warns and reports recordingsQuota (under the cap)", async () => {
		const root = await tempRoot()
		const { store, discoveryId } = storeWithDiscovery()
		const { log, lines } = capture()
		const caps = {
			maxRecordingsMb: 1024,
			maxEvidenceMb: 20,
			maxAgeDays: 30,
			minFreeDiskMb: 0,
		}
		const ev = new EvidenceStore({
			dir: root,
			caps,
			logger: log,
			now: () => Date.now(),
			statfs: async () => ({ freeBytes: 1e12 }),
			isDiscoveryLive: id => store.get(id) !== undefined,
		})
		ev.configureAnalog(adapterOf(store))
		await ev.recoverAnalog()
		const op = ev.beginAnalog({
			discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		await op.ready
		await op.push(new Int16Array(8_000))
		expect((await op.finish()).outcome).toBe("finalized")
		const analog = (ev as unknown as { analog: AnalogOperations }).analog
		const used = analog.managedBytes!
		const capBytes = used + RESERVATION - 1
		ev.setCaps({ ...caps, maxRecordingsMb: capBytes / MIB })
		// Kept discovery: nothing removable.
		await ev.retention(new Set([discoveryId]))
		await new Promise(resolve => setImmediate(resolve))
		const quota = ev.recordingsQuotaExceeded
		expect(quota).not.toBeNull()
		expect(quota!.usedBytes).toBe(used)
		expect(quota!.usedBytes).toBeLessThan(quota!.capBytes)
		expect(Math.abs(quota!.capBytes - capBytes)).toBeLessThan(1)
		// What retention must free so the next recording plus one in flight fit.
		expect(quota!.overBytes).toBeCloseTo(
			used + ADMISSION_HEADROOM - capBytes,
			3,
		)
		const warned = lines.filter(
			l =>
				l["reason"] === "storage-cap" && String(l["msg"]).includes("exceeded"),
		)
		expect(warned).toHaveLength(1)
		expect(warned[0]!["level"]).toBe(40)
		// Room again (the cap raised): cleared, one info line.
		ev.setCaps({ ...caps, maxRecordingsMb: 1024 })
		await ev.retention(new Set([discoveryId]))
		await new Promise(resolve => setImmediate(resolve))
		expect(ev.recordingsQuotaExceeded).toBeNull()
		expect(
			lines.filter(l => String(l["msg"]).includes("no longer exceeded")),
		).toHaveLength(1)
		await ev.stopAnalog()
	}, 60_000)
})
