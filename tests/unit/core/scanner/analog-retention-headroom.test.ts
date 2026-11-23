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
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import type { DiscoveryAliasLookup } from "../../../../src/core/scanner/recording-aliases.js"
import {
	ADMISSION_HEADROOM,
	AnalogOperations,
	AnalogStorageBytesError,
	AnalogStorageCountError,
	MAX_ANALOG_FILE_BYTES,
	OPERATION_HEADROOM,
	isStorageBytesRefusal,
	isStorageCountRefusal,
	type AnalogMetadataAdapter,
	type LegacyRetentionFile,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import {
	MAX_OPERATION_METADATA_BYTES,
	MAX_RECOVERY_OPERATIONS,
} from "../../../../src/core/scanner/store/recording-operation.js"
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
	const record = async (
		mtimeMs: number,
		samples = SAMPLES,
	): Promise<Stored> => {
		const before = ops.managedBytes ?? 0
		const op = begin()
		await op.ready
		for (let i = 0; i < samples; i += 16_000)
			await op.push(new Int16Array(Math.min(16_000, samples - i)))
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
		begin,
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

/**
 * The recordings quota is one oldest-first pass over both pools: the recordings outside analog
 * operations (legacy: digital voice, probes) and the analog files, on admission's own full test.
 * Before, legacy files were removed only past the cap itself, so a store whose removable files
 * were legacy refused every analog admission and reported nothing removable.
 */
describe("retention removes legacy and analog files oldest first on one full test", () => {
	/** A 1 600 000 B legacy recording file: under one RESERVATION, so a shortfall of R needs two. */
	const LEGACY_BYTES = 1_600_000

	async function evidenceHarness(
		opts: {
			protection?: RecordingProtection
			aliases?: DiscoveryAliasLookup
		} = {},
	) {
		const root = await tempRoot()
		const { store, discoveryId } = storeWithDiscovery()
		const caps = {
			maxRecordingsMb: 1024,
			maxEvidenceMb: 20,
			maxAgeDays: 30,
			minFreeDiskMb: 0,
		}
		const ev = new EvidenceStore({
			dir: root,
			caps,
			logger: pino({ level: "silent" }) as unknown as Logger,
			now: () => Date.now(),
			statfs: async () => ({ freeBytes: 1e12 }),
			isDiscoveryLive: id => store.get(id) !== undefined,
			...(opts.protection ? { protection: opts.protection } : {}),
			...(opts.aliases ? { aliases: opts.aliases } : {}),
		})
		ev.configureAnalog(adapterOf(store))
		await ev.recoverAnalog()
		const analog = (ev as unknown as { analog: AnalogOperations }).analog
		const begin = () =>
			ev.beginAnalog({ discoveryId, observationId: "o1", binding: binding() })
		/**
		 * A legacy (digital voice) file `rel` under recordings/dv/<folder>/ (default the
		 * discovery's own folder), its mtime set.
		 */
		const legacy = async (
			name: string,
			mtimeMs: number,
			folder: string = discoveryId,
		): Promise<string> => {
			const dir = join(root, "recordings", "dv", folder)
			await mkdir(dir, { recursive: true })
			const path = join(dir, name)
			await writeFile(path, Buffer.alloc(LEGACY_BYTES))
			await utimes(path, mtimeMs / 1000, mtimeMs / 1000)
			return join("recordings", "dv", folder, name)
		}
		/** One finalized analog file, its media mtime set; its bytes as the inventory counts them. */
		const record = async (mtimeMs: number): Promise<Stored> => {
			const before = analog.managedBytes ?? 0
			const op = begin()
			await op.ready
			for (let i = 0; i < SAMPLES; i += 16_000)
				await op.push(new Int16Array(16_000))
			const receipt = await op.finish()
			expect(receipt.outcome).toBe("finalized")
			const artifact = receipt.artifact!
			await utimes(join(root, artifact), mtimeMs / 1000, mtimeMs / 1000)
			return { artifact, bytes: (analog.managedBytes ?? 0) - before, mtimeMs }
		}
		const setCap = (capBytes: number) =>
			ev.setCaps({ ...caps, maxRecordingsMb: capBytes / MIB })
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
		const exists = (rel: string) => existsSync(join(root, rel))
		return { ev, analog, discoveryId, legacy, record, setCap, admits, exists }
	}

	it("a legacy-only store at cap − RESERVATION + 1 (stuck before): the oldest legacy files go and the next analog admission succeeds", async () => {
		const h = await evidenceHarness()
		const now = Date.now()
		const files: string[] = []
		for (const [i, daysAgo] of [2, 4, 1, 3].entries())
			files.push(
				await h.legacy(`2026110${i}_120000_${i}.wav`, now - daysAgo * DAY),
			)
		const used = 4 * LEGACY_BYTES
		h.setCap(used + RESERVATION - 1)
		// A pass first so admission counts the legacy bytes from a walk.
		await h.ev.retention(new Set([h.discoveryId]))
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		// The discovery kept: nothing removable, reported so.
		expect(h.ev.recordingsQuotaExceeded).not.toBeNull()
		const { deleted } = await h.ev.retention(new Set())
		// 1.6 MB < the shortfall (used + 2R − cap = R + 1 B): the two oldest (4 and 3 days).
		expect(deleted).toEqual([files[1], files[3]])
		expect(h.exists(files[0]!)).toBe(true)
		expect(h.exists(files[2]!)).toBe(true)
		expect(h.analog.quotaShortfall(2 * LEGACY_BYTES)).toBeLessThanOrEqual(0)
		expect(h.ev.recordingsQuotaExceeded).toBeNull()
		expect(await h.admits()).toBe(true)
		await h.ev.stopAnalog()
	}, 60_000)

	it("a mixed store with legacy L > cap − 2R: legacy files go too, oldest first across both pools", async () => {
		const h = await evidenceHarness()
		const now = Date.now()
		const legacy5 = await h.legacy("20261101_120000_5.wav", now - 5 * DAY)
		const analog4 = await h.record(now - 4 * DAY)
		const legacy3 = await h.legacy("20261103_120000_3.wav", now - 3 * DAY)
		const legacy2 = await h.legacy("20261104_120000_2.wav", now - 2 * DAY)
		const legacyBytes = 3 * LEGACY_BYTES
		// L > cap − 2R: no analog eviction alone can make room.
		const cap = legacyBytes + RESERVATION
		expect(legacyBytes).toBeGreaterThan(cap - ADMISSION_HEADROOM)
		h.setCap(cap)
		const { deleted } = await h.ev.retention(new Set())
		// Shortfall A + R ≈ 3.5 MB: the 5-day legacy, the 4-day analog, then the 3-day legacy.
		expect(deleted).toEqual(
			expect.arrayContaining([legacy5, analog4.artifact, legacy3]),
		)
		expect(deleted).toHaveLength(3)
		expect(h.exists(legacy5)).toBe(false)
		expect(h.exists(analog4.artifact)).toBe(false)
		expect(h.exists(legacy3)).toBe(false)
		expect(h.exists(legacy2)).toBe(true)
		expect(h.ev.recordingsQuotaExceeded).toBeNull()
		expect(await h.admits()).toBe(true)
		await h.ev.stopAnalog()
	}, 60_000)

	it("ordering across pools is by file time: a younger legacy file outlives an older analog file", async () => {
		const h = await evidenceHarness()
		const now = Date.now()
		const analogOld = await h.record(now - 6 * DAY)
		const legacyMid = await h.legacy("20261102_120000_m.wav", now - 5 * DAY)
		const analogMid = await h.record(now - 4 * DAY)
		const legacyNew = await h.legacy("20261104_120000_n.wav", now - 1 * DAY)
		const used = 2 * LEGACY_BYTES + analogOld.bytes + analogMid.bytes
		// Shortfall of one byte: only the oldest file of either pool goes.
		h.setCap(used + ADMISSION_HEADROOM - 1)
		const first = await h.ev.retention(new Set())
		expect(first.deleted).toEqual([analogOld.artifact])
		// Shortfall of one byte again: now the 5-day legacy file is the oldest.
		h.setCap(used - analogOld.bytes + ADMISSION_HEADROOM - 1)
		const second = await h.ev.retention(new Set())
		expect(second.deleted).toEqual([legacyMid])
		expect(h.exists(analogMid.artifact)).toBe(true)
		expect(h.exists(legacyNew)).toBe(true)
		await h.ev.stopAnalog()
	}, 60_000)

	it("protected legacy files survive the combined pass: kept, probe, in progress, and a DV file a kept discovery lists", async () => {
		const KEPT_LISTER = "d-kept-lister"
		const protection: RecordingProtection = {
			isProtected: () => false,
			isDsdFmeFileProtected: () => false,
			isScannerFileProtected: (_d, name) => name === "20261101_120000_kept.wav",
			discoveryHoldsKept: () => false,
		}
		const aliases: DiscoveryAliasLookup = {
			aliasOwner: () => undefined,
			aliasesOf: () => [],
			heldRecordingListers: id =>
				id.endsWith("~20261101_120000_linked.wav") ? [KEPT_LISTER] : [],
		}
		const h = await evidenceHarness({ protection, aliases })
		const now = Date.now()
		const kept = await h.legacy("20261101_120000_kept.wav", now - 6 * DAY)
		const probe = await h.legacy(
			"20261101_120000_probe.wav",
			now - 6 * DAY,
			"probe-p1",
		)
		const linked = await h.legacy("20261101_120000_linked.wav", now - 6 * DAY)
		// Written just now: in progress (RECORDING_IN_PROGRESS_MS).
		const recent = await h.legacy("20261101_120000_recent.wav", now)
		const plain = await h.legacy("20261101_120000_plain.wav", now - 5 * DAY)
		const analogOld = await h.record(now - 4 * DAY)
		// A cap far below the store: everything removable goes.
		h.setCap(MIB)
		const { deleted } = await h.ev.retention(new Set([KEPT_LISTER]))
		expect(deleted).toEqual([plain, analogOld.artifact])
		for (const rel of [kept, probe, linked, recent])
			expect(h.exists(rel)).toBe(true)
		// Nothing removable is left: reported so.
		expect(h.ev.recordingsQuotaExceeded).not.toBeNull()
		await h.ev.stopAnalog()
	}, 60_000)
})

/**
 * The operation inventory bound (MAX_RECOVERY_OPERATIONS) refuses admission with the same public
 * code as the byte cap. Retention keeps OPERATION_HEADROOM (8) operations free under it, oldest
 * first, so that refusal cannot stick; and only the byte refusal is an AnalogStorageBytesError.
 * The inventory is padded with held synthetic intents (a kept discovery) rather than 4 000 files.
 */
describe("retention keeps the operation inventory under its bound", () => {
	type Intents = Map<string, { operationId: string; discoveryId: string }>
	const PAD_DISCOVERY = "d-pad"
	const keep = new Set([PAD_DISCOVERY])

	function padder(ops: AnalogOperations) {
		const box = ops as unknown as { inventory: { intents: Intents } }
		let inventory = box.inventory
		const template = [...inventory.intents.values()][0]!
		const pads = new Map<string, { operationId: string; discoveryId: string }>()
		// A full scan (a retire's refresh may run one) rebuilds the inventory from disk, where the
		// pads are not: they are put back into every inventory that replaces this one.
		Object.defineProperty(box, "inventory", {
			configurable: true,
			get: () => inventory,
			set: (next: { intents: Intents }) => {
				inventory = next
				for (const [id, pad] of pads)
					if (!next.intents.has(id)) next.intents.set(id, pad)
			},
		})
		/** Pads the inventory to `total` intents with held clones (none of them on disk). */
		const padTo = (total: number) => {
			while (inventory.intents.size < total) {
				const operationId = randomUUID()
				const pad = { ...template, operationId, discoveryId: PAD_DISCOVERY }
				inventory.intents.set(operationId, pad)
				pads.set(operationId, pad)
			}
		}
		const clear = () => {
			for (const id of pads.keys()) inventory.intents.delete(id)
			pads.clear()
		}
		return {
			get intents() {
				return inventory.intents
			},
			padTo,
			clear,
		}
	}

	it("OPERATION_HEADROOM is the in-flight limit, 8: retention evicts from 4096 − 8 = 4088 intents", () => {
		expect(OPERATION_HEADROOM).toBe(8)
		expect(MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM).toBe(4088)
	})

	it("at 4087 intents nothing is evicted; at 4088 the oldest goes; at 4089 the two oldest", async () => {
		const h = await harness()
		const files = await shuffledFour(h)
		const pad = padder(h.ops)
		const bound = MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM
		pad.padTo(bound - 1)
		expect(await h.retain(keep)).toEqual([])
		pad.padTo(bound)
		expect(await h.retain(keep)).toEqual([files[1]!.artifact])
		expect(pad.intents.size).toBe(bound - 1)
		pad.padTo(bound + 1)
		expect(await h.retain(keep)).toEqual([
			files[3]!.artifact,
			files[0]!.artifact,
		])
		expect(pad.intents.size).toBe(bound - 1)
		expect(existsSync(join(h.root, files[2]!.artifact))).toBe(true)
		pad.clear()
		await h.ops.stop()
	}, 60_000)

	it("the inventory-limit refusal shares the storage-cap code but is not a byte refusal; the byte refusal is", async () => {
		const h = await harness()
		await h.record(Date.now() - DAY)
		const pad = padder(h.ops)
		const refusal = async (): Promise<unknown> => {
			const op = h.ops.begin({
				discoveryId: h.discoveryId,
				observationId: "o1",
				binding: binding(),
			})
			const err = await op.ready.then(
				() => null,
				(e: unknown) => e,
			)
			if (err === null) op.cancel()
			await op.settled
			return err
		}
		pad.padTo(MAX_RECOVERY_OPERATIONS)
		const count = await refusal()
		expect((count as { code?: string }).code).toBe("SCANNER_ANALOG_STORAGE_CAP")
		expect(isStorageBytesRefusal(count)).toBe(false)
		expect(count).not.toBeInstanceOf(AnalogStorageBytesError)
		// Its own class: retention can clear it, so it asks for an early pass too.
		expect(count).toBeInstanceOf(AnalogStorageCountError)
		expect(isStorageCountRefusal(count)).toBe(true)
		pad.clear()
		h.limit.maxBytes = h.used() + RESERVATION - 1
		const bytes = await refusal()
		expect((bytes as { code?: string }).code).toBe("SCANNER_ANALOG_STORAGE_CAP")
		expect(isStorageBytesRefusal(bytes)).toBe(true)
		expect(isStorageCountRefusal(bytes)).toBe(false)
		await h.ops.stop()
	}, 60_000)

	// Regression: before, a full inventory whose held operations alone reached 4088 never left
	// the full state, so one pass retired every removable analog file.
	it("held operations alone at 4088: no count eviction (reported); at 4087 the removable ones clear it", async () => {
		const h = await harness()
		const files = await shuffledFour(h)
		const pad = padder(h.ops)
		const bound = MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM
		// 4 removable + 4088 held.
		pad.padTo(bound + files.length)
		expect(await h.retain(keep)).toEqual([])
		expect(h.ops.operationsHeldFull).toBe(true)
		for (const f of files)
			expect(existsSync(join(h.root, f.artifact))).toBe(true)
		// One held fewer (4087): every removable goes, oldest first, and the state clears.
		pad.clear()
		pad.padTo(bound - 1 + files.length)
		expect(await h.retain(keep)).toEqual([
			files[1]!.artifact,
			files[3]!.artifact,
			files[0]!.artifact,
			files[2]!.artifact,
		])
		expect(h.ops.operationsHeldFull).toBe(false)
		expect(pad.intents.size).toBe(bound - 1)
		pad.clear()
		await h.ops.stop()
	}, 60_000)

	it("held 4080 + 20 removable (4100): exactly the excess 4100 − 4087 = 13 oldest go", async () => {
		const h = await harness()
		const now = Date.now()
		const files: Stored[] = []
		// Ages 1 to 20 min, in an order unrelated to the write order (7 is coprime to 20).
		for (let i = 0; i < 20; i++)
			files.push(await h.record(now - (20 - ((i * 7) % 20)) * 60_000, 8_000))
		const pad = padder(h.ops)
		const bound = MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM
		pad.padTo(4080 + 20)
		const oldest = [...files]
			.sort((a, b) => a.mtimeMs - b.mtimeMs)
			.map(f => f.artifact)
		const deleted = await h.retain(keep)
		expect(deleted).toEqual(oldest.slice(0, 13))
		expect(pad.intents.size).toBe(bound - 1)
		for (const a of oldest.slice(13))
			expect(existsSync(join(h.root, a))).toBe(true)
		pad.clear()
		await h.ops.stop()
	}, 120_000)

	it("count eviction skips held files: a kept artifact among the oldest stays, the next oldest goes", async () => {
		let protectedName: string | null = null
		const h = await harness({ protectedName: () => protectedName })
		const files = await shuffledFour(h)
		// The oldest (4 days) is kept.
		protectedName = files[1]!.artifact.split("/").at(-1)!
		const pad = padder(h.ops)
		const bound = MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM
		pad.padTo(bound)
		expect(await h.retain(keep)).toEqual([files[3]!.artifact])
		expect(existsSync(join(h.root, files[1]!.artifact))).toBe(true)
		expect(pad.intents.size).toBe(bound - 1)
		pad.clear()
		await h.ops.stop()
	}, 60_000)

	it("an admission that leaves fewer than 8 operations under the bound reports roomShort.count; 8 left reports nothing", async () => {
		const h = await harness()
		await h.record(Date.now() - DAY)
		const pad = padder(h.ops)
		const roomShort = async () => {
			const op = h.begin()
			await op.ready
			const short = op.roomShort
			op.cancel()
			await op.settled
			return short
		}
		// 4087 + this one = 4088: 8 left, enough.
		pad.padTo(MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM - 1)
		expect(await roomShort()).toBeNull()
		// 4088 + this one = 4089: 7 left.
		pad.padTo(MAX_RECOVERY_OPERATIONS - OPERATION_HEADROOM)
		expect(await roomShort()).toEqual({ bytes: false, count: true })
		pad.clear()
		await h.ops.stop()
	}, 60_000)
})

describe("an admission that leaves less than one more recording's room says so (roomShort)", () => {
	it("room after it < RESERVATION: bytes; exactly RESERVATION left: null", async () => {
		const h = await harness()
		await h.record(Date.now() - DAY)
		const roomShort = async () => {
			const op = h.begin()
			await op.ready
			const short = op.roomShort
			op.cancel()
			await op.settled
			return short
		}
		// used + R (this one) + R (the next) fits exactly.
		h.limit.maxBytes = h.used() + 2 * RESERVATION
		expect(await roomShort()).toBeNull()
		h.limit.maxBytes -= 1
		expect(await roomShort()).toEqual({ bytes: true, count: false })
		// Admission's own edge (exactly one reservation left before it) still admits.
		h.limit.maxBytes = h.used() + RESERVATION
		expect(await roomShort()).toEqual({ bytes: true, count: false })
		await h.ops.stop()
	}, 60_000)
})

describe("retention before the analog inventory is ready", () => {
	it("trims the legacy pool to the cap, oldest first, and removes nothing analog", async () => {
		const root = await tempRoot()
		const { store } = storeWithDiscovery()
		const cap = 10_000
		// Never recovered: not ready.
		const ops = new AnalogOperations({
			root,
			adapter: adapterOf(store),
			admits: () => true,
			serialise: async (_id, job) => job(),
			legacyBytes: async () => 0,
			limits: () => ({ maxBytes: cap, minFreeBytes: 0 }),
			freeBytes: async () => 1e12,
		})
		expect(ops.ready).toBe(false)
		const removed: string[] = []
		const file = (
			key: string,
			bytes: number,
			kept = false,
		): LegacyRetentionFile => ({
			mtimeMs: 0,
			key,
			bytes,
			remove: async () => {
				if (kept) return false
				removed.push(key)
				return true
			},
		})
		// Already oldest first (the caller's order); 16 000 B over a 10 000 B cap.
		const pool = {
			bytes: 16_000,
			files: [
				file("a", 3_000),
				file("b", 2_000, true),
				file("c", 4_000),
				file("d", 5_000),
			],
		}
		expect(await ops.retained(new Set(), MAX_AGE_MS, Date.now(), pool)).toEqual(
			[],
		)
		// a (13 000), b kept, c (9 000 ≤ cap): d stays.
		expect(removed).toEqual(["a", "c"])
		expect(pool.bytes).toBe(9_000)
		// Exactly at the cap: nothing more.
		removed.length = 0
		pool.bytes = cap
		expect(await ops.retained(new Set(), MAX_AGE_MS, Date.now(), pool)).toEqual(
			[],
		)
		expect(removed).toEqual([])
	})
})

/**
 * Live-clone finding: a pass whose last removal left the store fitting, then an admission or a
 * finalization before the quota was measured (the pass's folder listing awaits after its last
 * removal decision), reported "nothing removable" with removable files left; that state
 * suppressed the early pass and refused admissions until the next regular pass removed more.
 * The quota state is now measured against what is removable NOW: such a shortfall asks for
 * another pass (`again`) instead, and only a genuinely held store warns.
 */
describe("a shortfall a pass's own tail created is not 'nothing removable'", () => {
	async function tailHarness() {
		const root = await tempRoot()
		const now = Date.now()
		const store = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => now,
			newId: counterIds(),
		})
		const first = store.ingest(
			makeObs({ id: "o1", centreHz: 446_000_000, startedAt: now }),
		).discoveryId
		const second = store.ingest(
			makeObs({ id: "o2", centreHz: 162_025_000, startedAt: now }),
		).discoveryId
		if (!first || !second || first === second)
			throw new Error("Missing test discoveries")
		const lines: Record<string, unknown>[] = []
		const sink = new Writable({
			write(chunk: Buffer, _enc, done) {
				for (const text of chunk.toString("utf8").split("\n"))
					if (text.trim() !== "")
						lines.push(JSON.parse(text) as Record<string, unknown>)
				done()
			},
		})
		const caps = {
			maxRecordingsMb: 1024,
			maxEvidenceMb: 20,
			maxAgeDays: 30,
			minFreeDiskMb: 0,
		}
		const ev = new EvidenceStore({
			dir: root,
			caps,
			logger: pino({ level: "info" }, sink) as unknown as Logger,
			now: () => Date.now(),
			statfs: async () => ({ freeBytes: 1e12 }),
			isDiscoveryLive: id => store.get(id) !== undefined,
		})
		ev.configureAnalog(adapterOf(store))
		await ev.recoverAnalog()
		const analog = (ev as unknown as { analog: AnalogOperations }).analog
		const begin = (discoveryId = first, observationId = "o1") =>
			ev.beginAnalog({ discoveryId, observationId, binding: binding() })
		const record = async (
			mtimeMs: number,
			discoveryId = first,
		): Promise<Stored> => {
			const before = analog.managedBytes ?? 0
			const op = begin(discoveryId, discoveryId === first ? "o1" : "o2")
			await op.ready
			for (let i = 0; i < SAMPLES; i += 16_000)
				await op.push(new Int16Array(16_000))
			const receipt = await op.finish()
			expect(receipt.outcome).toBe("finalized")
			const artifact = receipt.artifact!
			await utimes(join(root, artifact), mtimeMs / 1000, mtimeMs / 1000)
			return { artifact, bytes: (analog.managedBytes ?? 0) - before, mtimeMs }
		}
		/** Runs `job` once, after the next pass's last removal decision, before it measures. */
		const atPassTail = (job: () => Promise<void>) => {
			const internals = ev as unknown as {
				loadFolderIndex(): Promise<string[]>
			}
			const original = internals.loadFolderIndex.bind(ev)
			let pending: (() => Promise<void>) | null = job
			internals.loadFolderIndex = async () => {
				const run = pending
				pending = null
				if (run) await run()
				return original()
			}
		}
		const warned = () =>
			lines.filter(
				l =>
					l["reason"] === "storage-cap" &&
					l["level"] === 40 &&
					String(l["msg"]).includes("exceeded"),
			)
		/** Three files, oldest first; the cap leaves room after removing the oldest, 1 000 B spare. */
		const fill = async (): Promise<Stored[]> => {
			const files: Stored[] = []
			for (const daysAgo of [4, 3, 2])
				files.push(await record(now - daysAgo * DAY))
			const used = analog.managedBytes!
			const capBytes = used - files[0]!.bytes + ADMISSION_HEADROOM + 1_000
			ev.setCaps({ ...caps, maxRecordingsMb: capBytes / MIB })
			return files
		}
		return {
			ev,
			analog,
			first,
			second,
			begin,
			record,
			atPassTail,
			warned,
			fill,
		}
	}

	it("a finalization after the last removal: no false warning, `again`, and the next pass removes the oldest", async () => {
		const t = await tailHarness()
		const files = await t.fill()
		t.atPassTail(async () => {
			await t.record(Date.now() - 60_000)
		})
		const pass = await t.ev.retention(new Set())
		expect(pass.deleted).toEqual([files[0]!.artifact])
		// Short again (the new file used the room), with removable files left.
		expect(t.analog.quotaShortfall(0)).toBeGreaterThan(0)
		expect(t.warned()).toHaveLength(0)
		expect(t.ev.recordingsQuotaExceeded).toBeNull()
		expect(pass.again).toBe(true)
		const next = await t.ev.retention(new Set())
		expect(next.deleted).toEqual([files[1]!.artifact])
		expect(next.again).toBeUndefined()
		expect(t.analog.quotaShortfall(0)).toBeLessThanOrEqual(0)
		expect(t.ev.recordingsQuotaExceeded).toBeNull()
		expect(t.warned()).toHaveLength(0)
		await t.ev.stopAnalog()
	}, 120_000)

	it("an admission (a new reservation) after the last removal: no false warning, the next pass removes the oldest", async () => {
		const t = await tailHarness()
		const files = await t.fill()
		// Another discovery's recording, admitted at the pass's tail and still in flight.
		let op: ReturnType<typeof t.begin> | null = null
		t.atPassTail(async () => {
			op = t.begin(t.second, "o2")
			await op.ready
		})
		const pass = await t.ev.retention(new Set())
		expect(pass.deleted).toEqual([files[0]!.artifact])
		expect(t.analog.quotaShortfall(0)).toBeGreaterThan(0)
		expect(t.warned()).toHaveLength(0)
		expect(t.ev.recordingsQuotaExceeded).toBeNull()
		expect(pass.again).toBe(true)
		const next = await t.ev.retention(new Set())
		expect(next.deleted[0]).toBe(files[1]!.artifact)
		expect(t.analog.quotaShortfall(0)).toBeLessThanOrEqual(0)
		const admitted = op as ReturnType<typeof t.begin> | null
		expect(admitted).not.toBeNull()
		admitted!.cancel()
		await admitted!.settled
		await t.ev.stopAnalog()
	}, 120_000)

	it("a held-only store short of room still warns once and reports the quota; no `again`", async () => {
		const t = await tailHarness()
		await t.fill()
		const keep = new Set([t.first])
		// A file finalized at the tail into the kept discovery is held too.
		t.atPassTail(async () => {
			await t.record(Date.now() - 60_000)
		})
		const pass = await t.ev.retention(keep)
		expect(pass.deleted).toEqual([])
		expect(pass.again).toBeUndefined()
		expect(t.ev.recordingsQuotaExceeded).not.toBeNull()
		expect(t.warned()).toHaveLength(1)
		const next = await t.ev.retention(keep)
		expect(next.again).toBeUndefined()
		expect(t.ev.recordingsQuotaExceeded).not.toBeNull()
		expect(t.warned()).toHaveLength(1)
		await t.ev.stopAnalog()
	}, 120_000)
})
