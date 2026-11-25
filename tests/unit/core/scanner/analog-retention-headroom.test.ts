/**
 * Retention keeps room for the next analog recording. Admission refuses once used + outstanding +
 * RESERVATION exceeds the recordings cap; retention counts the store full once used + outstanding
 * + ADMISSION_HEADROOM (2 × RESERVATION) exceeds it (the trigger), and then retires evictable
 * files oldest first (by media mtime) until used + outstanding + EVICTION_TARGET_HEADROOM(cap)
 * (max(8 × RESERVATION, 2 % of the cap)) fits (the target, hysteresis). Before, retention evicted
 * only past the cap itself, so a store within one reservation of the cap refused every admission
 * for good; then it stopped at the trigger, one file per recording. The quota status and its
 * warning use the trigger. Synthetic files and ids only.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	unlink,
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
	EVICTION_TARGET_HEADROOM,
	EVICTION_TARGET_MIN_HEADROOM,
	MAX_ANALOG_FILE_BYTES,
	OPERATION_HEADROOM,
	isStorageBytesRefusal,
	isStorageCountRefusal,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
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
/**
 * Held bytes outside analog operations under every default harness store: 64 MiB keeps a cap of
 * used + a few reservations at or above 4 × 8R = 61 965 696 B, so the target is 8R (or 2 %), not
 * the ⌊cap / 4⌋ clamp. Tests of the clamp itself pass `pad: 0`.
 */
const PAD = 64 * MIB
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

async function harness(
	opts: {
		protectedName?: () => string | null
		pad?: number
		serialise?: <T>(id: string, job: () => Promise<T>) => Promise<T>
		io?: AnalogOperationIo
	} = {},
) {
	const pad = opts.pad ?? PAD
	const root = await tempRoot()
	const { store, discoveryId } = storeWithDiscovery()
	const limit = { maxBytes: 1024 * MIB }
	/** Recordings outside analog operations, counted but never offered for removal. */
	const legacy = { bytes: pad }
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
		serialise: opts.serialise ?? (async (_id, job) => job()),
		legacyBytes: async () => legacy.bytes,
		limits: () => ({ maxBytes: limit.maxBytes, minFreeBytes: 0 }),
		freeBytes: async () => 1e12,
		...(opts.protectedName ? { protection } : {}),
		...(opts.io ? { io: opts.io } : {}),
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
	/** Analog bytes plus the held pad: what the quota counts while `legacy.bytes` is the pad. */
	const used = (): number => (ops.managedBytes ?? Number.NaN) + pad
	/** The trigger's shortfall over the live legacy bytes (the pad unless a test sets them). */
	const shortfall = () => ops.quotaShortfall(legacy.bytes)
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
		legacy,
		begin,
		record,
		used,
		shortfall,
		retain,
		admits,
	}
}

/** Artifacts oldest first (distinct mtimes in these tests). */
function oldestFirst(files: readonly Stored[]): string[] {
	return [...files].sort((a, b) => a.mtimeMs - b.mtimeMs).map(f => f.artifact)
}

/**
 * A triggered pass's removals: the oldest-first prefix whose removal lets used + `headroom`
 * (default the target, EVICTION_TARGET_HEADROOM(cap)) fit under the cap.
 */
function expectedEvictions(
	files: readonly Stored[],
	used: number,
	cap: number,
	headroom = EVICTION_TARGET_HEADROOM(cap),
): string[] {
	const out: string[] = []
	let left = used
	for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
		if (left + headroom <= cap) break
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

/**
 * `n` files (n coprime with 5) aged 1 to n days, written in an order unrelated to their ages:
 * about 1.6 MB each, so the target (8 × RESERVATION ≈ 15.5 MB) needs several of them.
 */
async function shuffled(h: Awaited<ReturnType<typeof harness>>, n: number) {
	const now = Date.now()
	const files: Stored[] = []
	for (let i = 0; i < n; i++)
		files.push(await h.record(now - (((i * 5) % n) + 1) * DAY))
	return files
}

describe("analog retention keeps room for the next recording", () => {
	it("ADMISSION_HEADROOM is two reservations: 2 × (1 920 044 + 16 384) = 3 872 856 B", () => {
		expect(ADMISSION_HEADROOM).toBe(3_872_856)
		expect(ADMISSION_HEADROOM).toBe(2 * RESERVATION)
	})

	it("EVICTION_TARGET_HEADROOM is max(8 × RESERVATION, 2 % of the cap): 8R wins at 512 MiB, 2 % at 1 GiB", () => {
		expect(EVICTION_TARGET_MIN_HEADROOM).toBe(15_491_424)
		expect(EVICTION_TARGET_MIN_HEADROOM).toBe(8 * RESERVATION)
		// Default 512 MiB: 2 % = 10 737 418 B < 8R.
		expect(Math.floor((512 * MIB) / 50)).toBe(10_737_418)
		expect(EVICTION_TARGET_HEADROOM(512 * MIB)).toBe(15_491_424)
		// 1 GiB: 2 % = 21 474 836 B > 8R.
		expect(EVICTION_TARGET_HEADROOM(1024 * MIB)).toBe(21_474_836)
		// The crossover, 50 × 8R = 774 571 200 B: 8R up to it, 2 % one step (50 B) past it.
		expect(EVICTION_TARGET_HEADROOM(774_571_200)).toBe(15_491_424)
		expect(EVICTION_TARGET_HEADROOM(774_571_249)).toBe(15_491_424)
		expect(EVICTION_TARGET_HEADROOM(774_571_250)).toBe(15_491_425)
		// Zero, negative, non-finite caps: the floor, unclamped.
		expect(EVICTION_TARGET_HEADROOM(0)).toBe(15_491_424)
		expect(EVICTION_TARGET_HEADROOM(-1)).toBe(15_491_424)
		expect(EVICTION_TARGET_HEADROOM(Number.NaN)).toBe(15_491_424)
		expect(EVICTION_TARGET_HEADROOM(Number.POSITIVE_INFINITY)).toBe(15_491_424)
		// The floor beats the trigger's room, so an unclamped target ends the full state.
		expect(EVICTION_TARGET_MIN_HEADROOM).toBeGreaterThan(ADMISSION_HEADROOM)
	})

	it("the target is clamped to ⌊cap / 4⌋: unclamped from 4 × 8R = 61 965 696 B up, clamped one byte under", () => {
		expect(4 * EVICTION_TARGET_MIN_HEADROOM).toBe(61_965_696)
		// At the bound: ⌊cap / 4⌋ = 8R exactly, both agree.
		expect(EVICTION_TARGET_HEADROOM(61_965_696)).toBe(15_491_424)
		// One byte under: ⌊61 965 695 / 4⌋ = 15 491 423.
		expect(EVICTION_TARGET_HEADROOM(61_965_695)).toBe(15_491_423)
		// Past it: the floor again (⌊cap / 4⌋ above 8R).
		expect(EVICTION_TARGET_HEADROOM(61_965_700)).toBe(15_491_424)
		// The default 512 MiB and 1 GiB caps are unchanged (cap / 4 is far above).
		expect(Math.floor((512 * MIB) / 4)).toBe(134_217_728)
		expect(EVICTION_TARGET_HEADROOM(512 * MIB)).toBe(15_491_424)
		expect(EVICTION_TARGET_HEADROOM(1024 * MIB)).toBe(21_474_836)
		// 18 MiB = 18 874 368 B: ⌊cap / 4⌋ = 4 718 592 B < 8R, clamped.
		expect(EVICTION_TARGET_HEADROOM(18 * MIB)).toBe(4_718_592)
		// 1 MiB: 262 144 B, under the trigger's room (2R); 4096 B: 1024 B.
		expect(EVICTION_TARGET_HEADROOM(MIB)).toBe(262_144)
		expect(EVICTION_TARGET_HEADROOM(4096)).toBe(1024)
		// The clamped target falls under the trigger's room below 8R = 15 491 424 B (≈ 14.8 MiB).
		expect(EVICTION_TARGET_HEADROOM(15_491_424)).toBe(3_872_856)
		expect(EVICTION_TARGET_HEADROOM(15_491_424)).toBe(ADMISSION_HEADROOM)
		expect(EVICTION_TARGET_HEADROOM(15_491_423)).toBeLessThan(
			ADMISSION_HEADROOM,
		)
	})

	// Regression: the trigger latched only on a quota check, which an age-expired candidate
	// skips (`old || …` short-circuits). Two aged files at the front removed the shortfall
	// before any check, so the pass never latched and stopped just under the trigger.
	it("a store past the trigger whose oldest candidates are age-expired: the pass still ends at cap − target", async () => {
		const h = await harness()
		const now = Date.now()
		const files: Stored[] = []
		for (const daysAgo of [5, 40, 3, 9, 35, 1, 7, 2, 10, 4, 8, 6])
			files.push(await h.record(now - daysAgo * DAY))
		// One byte past the trigger: the aged pair alone (≈ 3.2 MB) clears the shortfall.
		h.limit.maxBytes = h.used() + ADMISSION_HEADROOM - 1
		expect(h.shortfall()).toBe(1)
		const aged = files.filter(f => now - f.mtimeMs > MAX_AGE_MS)
		expect(aged).toHaveLength(2)
		expect(aged.reduce((n, f) => n + f.bytes, 0)).toBeGreaterThan(1)
		const expected = expectedEvictions(files, h.used(), h.limit.maxBytes)
		expect(expected.length).toBeGreaterThan(aged.length)
		expect(expected.slice(0, 2)).toEqual(oldestFirst(aged))
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		expect(
			h.used() + EVICTION_TARGET_HEADROOM(h.limit.maxBytes),
		).toBeLessThanOrEqual(h.limit.maxBytes)
		await h.ops.stop()
	}, 60_000)

	it("an 18 MiB cap (target clamped to 4 718 592 B): the pass ends at cap − ⌊cap / 4⌋, not cap − 8R", async () => {
		const h = await harness({ pad: 0 })
		const files = await shuffled(h, 13)
		const cap = 18 * MIB
		expect(cap).toBe(18_874_368)
		h.limit.maxBytes = cap
		expect(h.used()).toBeGreaterThan(cap)
		const target = EVICTION_TARGET_HEADROOM(cap)
		expect(target).toBe(4_718_592)
		expect(target).toBeGreaterThan(ADMISSION_HEADROOM)
		const expected = expectedEvictions(files, h.used(), cap)
		// Fewer than the unclamped 8R target would remove, short of everything.
		expect(expected.length).toBeLessThan(
			expectedEvictions(files, h.used(), cap, EVICTION_TARGET_MIN_HEADROOM)
				.length,
		)
		expect(expected.length).toBeLessThan(files.length)
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		expect(h.used() + target).toBeLessThanOrEqual(cap)
		const last = files.find(f => f.artifact === deleted.at(-1))!
		expect(h.used() + last.bytes + target).toBeGreaterThan(cap)
		expect(h.shortfall()).toBeLessThanOrEqual(0)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("a cap under 8R (clamped target < the trigger's 2R): the trigger wins, the pass ends at cap − 2R, not at the target", async () => {
		const h = await harness({ pad: 0 })
		const files = await shuffled(h, 11)
		const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)
		// After the four oldest go, the store sits between the target and the trigger: within
		// ⌊cap / 4⌋ of room (the target met) but one byte short of 2R (the trigger still holds).
		const k = 4
		const left = sorted.slice(k).reduce((n, f) => n + f.bytes, 0)
		const cap = left + ADMISSION_HEADROOM - 1
		h.limit.maxBytes = cap
		expect(cap).toBeLessThan(EVICTION_TARGET_MIN_HEADROOM)
		expect(EVICTION_TARGET_HEADROOM(cap)).toBe(Math.floor(cap / 4))
		expect(EVICTION_TARGET_HEADROOM(cap)).toBeLessThan(ADMISSION_HEADROOM)
		expect(left + EVICTION_TARGET_HEADROOM(cap)).toBeLessThanOrEqual(cap)
		// Stopping at the target would remove k; the trigger needs k + 1.
		expect(expectedEvictions(files, h.used(), cap)).toHaveLength(k)
		const expected = expectedEvictions(files, h.used(), cap, ADMISSION_HEADROOM)
		expect(expected).toEqual(sorted.slice(0, k + 1).map(f => f.artifact))
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		// The full state is over: the trigger no longer holds, the next admission fits.
		expect(h.shortfall()).toBeLessThanOrEqual(0)
		const last = files.find(f => f.artifact === deleted.at(-1))!
		expect(h.used() + last.bytes + ADMISSION_HEADROOM).toBeGreaterThan(cap)
		expect(await h.admits()).toBe(true)
		// A second pass evicts nothing.
		expect(await h.retain()).toEqual([])
		await h.ops.stop()
	}, 60_000)

	it("a 1 MiB cap (one reservation alone is over it): every file goes, every admission is refused, a pass ends", async () => {
		const h = await harness({ pad: 0 })
		const files = await shuffled(h, 3)
		h.limit.maxBytes = MIB
		expect(RESERVATION).toBeGreaterThan(MIB)
		expect(EVICTION_TARGET_HEADROOM(MIB)).toBe(262_144)
		const deleted = await h.retain()
		expect(deleted).toEqual(oldestFirst(files))
		expect(h.used()).toBe(0)
		// The trigger still holds over an empty store (2R > cap): full, nothing removable.
		expect(h.shortfall()).toBe(ADMISSION_HEADROOM - MIB)
		expect(h.ops.removableNow()).toBe(0)
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		// A later pass has nothing to try and returns at once.
		expect(await h.retain()).toEqual([])
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		await h.ops.stop()
	}, 60_000)

	// Regression: before the fix this store refused every admission and retention evicted nothing.
	it("a store at cap − RESERVATION + 1 (stuck before): retention evicts the oldest down to the target, the next admission succeeds", async () => {
		const h = await harness()
		const files = await shuffled(h, 12)
		h.limit.maxBytes = h.used() + RESERVATION - 1
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		const expected = expectedEvictions(files, h.used(), h.limit.maxBytes)
		// Past the trigger's own prefix (two files), short of everything.
		expect(expected.length).toBeGreaterThan(
			expectedEvictions(files, h.used(), h.limit.maxBytes, ADMISSION_HEADROOM)
				.length,
		)
		expect(expected.length).toBeLessThan(files.length)
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		expect(deleted).toEqual(oldestFirst(files).slice(0, expected.length))
		for (const f of files)
			expect(existsSync(join(h.root, f.artifact))).toBe(
				!deleted.includes(f.artifact),
			)
		expect(h.used() + EVICTION_TARGET_MIN_HEADROOM).toBeLessThanOrEqual(
			h.limit.maxBytes,
		)
		expect(h.shortfall()).toBeLessThanOrEqual(0)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("a store at exactly cap − RESERVATION (admission's edge) is full: evicts oldest until used + target fits, then admits", async () => {
		const h = await harness()
		const files = await shuffled(h, 12)
		h.limit.maxBytes = h.used() + RESERVATION
		const expected = expectedEvictions(files, h.used(), h.limit.maxBytes)
		expect(expected.length).toBeGreaterThan(0)
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		expect(
			h.used() + EVICTION_TARGET_HEADROOM(h.limit.maxBytes),
		).toBeLessThanOrEqual(h.limit.maxBytes)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("a store exactly at the cap: evicts oldest until cap − target, no further", async () => {
		const h = await harness()
		const files = await shuffled(h, 12)
		h.limit.maxBytes = h.used()
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		const expected = expectedEvictions(files, h.used(), h.limit.maxBytes)
		const deleted = await h.retain()
		expect(deleted).toEqual(expected)
		expect(deleted).toEqual(oldestFirst(files).slice(0, expected.length))
		const target = EVICTION_TARGET_HEADROOM(h.limit.maxBytes)
		expect(target).toBe(EVICTION_TARGET_MIN_HEADROOM)
		expect(h.used() + target).toBeLessThanOrEqual(h.limit.maxBytes)
		// Minimal: the last file it removed would not have fit back under the target.
		const last = files.find(f => f.artifact === deleted.at(-1))!
		expect(h.used() + last.bytes + target).toBeGreaterThan(h.limit.maxBytes)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("between the trigger and the target nothing is evicted; one byte past the trigger evicts to the target", async () => {
		const h = await harness()
		const files = await shuffled(h, 12)
		// Exactly the trigger's edge: not full.
		h.limit.maxBytes = h.used() + ADMISSION_HEADROOM
		expect(h.shortfall()).toBe(0)
		expect(await h.retain()).toEqual([])
		expect(await h.admits()).toBe(true)
		// Between: less than the target's room left, the trigger not met: no eviction.
		h.limit.maxBytes = h.used() + EVICTION_TARGET_MIN_HEADROOM - 1
		expect(h.shortfall()).toBeLessThan(0)
		expect(await h.retain()).toEqual([])
		expect(await h.admits()).toBe(true)
		// One byte past the trigger: the pass runs on to the target, not one file.
		h.limit.maxBytes = h.used() + ADMISSION_HEADROOM - 1
		expect(h.shortfall()).toBe(1)
		const expected = expectedEvictions(files, h.used(), h.limit.maxBytes)
		expect(expected.length).toBeGreaterThan(1)
		expect(await h.retain()).toEqual(expected)
		expect(h.used() + EVICTION_TARGET_MIN_HEADROOM).toBeLessThanOrEqual(
			h.limit.maxBytes,
		)
		await h.ops.stop()
	}, 60_000)

	it("the target bound: a cap landing the store exactly at the target after k removals stops at k; one byte less needs k + 1, one more still k", async () => {
		for (const delta of [-1, 0, 1]) {
			const h = await harness()
			const files = await shuffled(h, 12)
			const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)
			// k: the fewest oldest files whose bytes exceed 6R + 1, so the trigger holds at every delta.
			let k = 0
			let freed = 0
			while (freed <= EVICTION_TARGET_MIN_HEADROOM - ADMISSION_HEADROOM + 1)
				freed += sorted[k++]!.bytes
			const used = h.used()
			const cap = used - freed + EVICTION_TARGET_MIN_HEADROOM + delta
			h.limit.maxBytes = cap
			expect(EVICTION_TARGET_HEADROOM(cap)).toBe(EVICTION_TARGET_MIN_HEADROOM)
			expect(h.shortfall()).toBeGreaterThan(0)
			const deleted = await h.retain()
			const n = delta < 0 ? k + 1 : k
			expect(deleted).toEqual(sorted.slice(0, n).map(f => f.artifact))
			const room = cap - h.used()
			if (delta === 0) expect(room).toBe(EVICTION_TARGET_MIN_HEADROOM)
			if (delta === 1) expect(room).toBe(EVICTION_TARGET_MIN_HEADROOM + 1)
			if (delta === -1)
				expect(room).toBe(EVICTION_TARGET_MIN_HEADROOM - 1 + sorted[k]!.bytes)
			await h.ops.stop()
		}
	}, 180_000)

	it("a cap where 2 % > 8R (1 GiB): the pass evicts to cap − 2 % of the cap", async () => {
		const h = await harness({ pad: 0 })
		const files = await shuffled(h, 16)
		const cap = 1024 * MIB
		h.limit.maxBytes = cap
		// The other recordings fill the store to one byte past admission's edge.
		h.legacy.bytes = cap - h.used() - RESERVATION + 1
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		const target = EVICTION_TARGET_HEADROOM(cap)
		expect(target).toBe(21_474_836)
		const used = h.used() + h.legacy.bytes
		const expected = expectedEvictions(files, used, cap)
		// More than an 8R target would remove, fewer than all.
		expect(expected.length).toBeGreaterThan(
			expectedEvictions(files, used, cap, EVICTION_TARGET_MIN_HEADROOM).length,
		)
		expect(expected.length).toBeLessThan(files.length)
		expect(await h.retain()).toEqual(expected)
		expect(h.used() + h.legacy.bytes + target).toBeLessThanOrEqual(cap)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 120_000)

	it("the default 512 MiB cap (8R > 2 %): the pass evicts to cap − 15 491 424 B", async () => {
		const h = await harness({ pad: 0 })
		const files = await shuffled(h, 12)
		const cap = 512 * MIB
		h.limit.maxBytes = cap
		h.legacy.bytes = cap - h.used() - RESERVATION + 1
		const target = EVICTION_TARGET_HEADROOM(cap)
		expect(target).toBe(15_491_424)
		const used = h.used() + h.legacy.bytes
		const expected = expectedEvictions(files, used, cap)
		// More than a 2 % target (10 737 418 B) would remove.
		expect(expected.length).toBeGreaterThan(
			expectedEvictions(files, used, cap, Math.floor(cap / 50)).length,
		)
		expect(expected.length).toBeLessThan(files.length)
		expect(await h.retain()).toEqual(expected)
		expect(h.used() + h.legacy.bytes + target).toBeLessThanOrEqual(cap)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 120_000)

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
		const files = await shuffled(h, 12)
		const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)
		const oldest = sorted[0]!
		protectedName = oldest.artifact.split("/").at(-1)!
		h.limit.maxBytes = h.used() + RESERVATION - 1
		// The discovery kept: nothing evictable, nothing evicted, still refused.
		expect(await h.retain(new Set([h.discoveryId]))).toEqual([])
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		// The oldest kept: the next oldest go instead, down to the target.
		const expected = expectedEvictions(
			sorted.slice(1),
			h.used(),
			h.limit.maxBytes,
		)
		const deleted = await h.retain()
		expect(deleted).not.toContain(oldest.artifact)
		expect(deleted).toEqual(expected)
		expect(deleted).toEqual(
			sorted.slice(1, 1 + expected.length).map(f => f.artifact),
		)
		expect(existsSync(join(h.root, oldest.artifact))).toBe(true)
		expect(h.used() + EVICTION_TARGET_MIN_HEADROOM).toBeLessThanOrEqual(
			h.limit.maxBytes,
		)
		expect(await h.admits()).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("a store held at its cap over repeated fills: each triggered pass brings it to the target, admissions keep succeeding", async () => {
		const h = await harness()
		const now = Date.now()
		const alive = await shuffled(h, 12)
		// Full: exactly admission's edge.
		h.limit.maxBytes = h.used() + RESERVATION
		const cap = h.limit.maxBytes
		const target = EVICTION_TARGET_HEADROOM(cap)
		let landed = 0
		for (let cycle = 0; cycle < 3; cycle++) {
			expect(h.shortfall()).toBeGreaterThan(0)
			const expected = expectedEvictions(alive, h.used(), cap)
			const deleted = await h.retain()
			expect(deleted.length).toBeGreaterThan(0)
			expect(deleted).toEqual(expected)
			for (const a of deleted)
				alive.splice(
					alive.findIndex(f => f.artifact === a),
					1,
				)
			expect(h.used() + target).toBeLessThanOrEqual(cap)
			// New recordings land (each younger than all before) until the trigger holds again:
			// every one is admitted, and a pass in between evicts nothing.
			let added = 0
			while ((h.shortfall() ?? 0) <= 0) {
				expect(await h.retain()).toEqual([])
				expect(await h.admits()).toBe(true)
				alive.push(await h.record(now - (1_000 - landed++) * 1_000))
				added++
				expect(added).toBeLessThanOrEqual(12)
			}
			// The target's slack holds several recordings, not one.
			expect(added).toBeGreaterThan(1)
		}
		await h.ops.stop()
	}, 180_000)
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

	it("a held store between the trigger and the target is not exceeded and does not ask again", async () => {
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
		// Less than the target's room left, more than the trigger's.
		ev.setCaps({
			...caps,
			maxRecordingsMb: (used + EVICTION_TARGET_MIN_HEADROOM - 1) / MIB,
		})
		const pass = await ev.retention(new Set([discoveryId]))
		await new Promise(resolve => setImmediate(resolve))
		expect(pass.again).toBeUndefined()
		expect(ev.recordingsQuotaExceeded).toBeNull()
		expect(
			lines.filter(
				l =>
					l["reason"] === "storage-cap" &&
					String(l["msg"]).includes("exceeded"),
			),
		).toHaveLength(0)
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
			bytes = LEGACY_BYTES,
		): Promise<string> => {
			const dir = join(root, "recordings", "dv", folder)
			await mkdir(dir, { recursive: true })
			const path = join(dir, name)
			await writeFile(path, Buffer.alloc(bytes))
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
		/** PAD bytes in a live probe's folder: counted against the cap, never removed. */
		const pad = () =>
			legacy("20261101_120000_pad.wav", Date.now() - 6 * DAY, "probe-p1", PAD)
		return {
			ev,
			analog,
			discoveryId,
			legacy,
			pad,
			record,
			setCap,
			admits,
			exists,
		}
	}

	/** Legacy files as Stored (path, LEGACY_BYTES, mtime) for expectedEvictions. */
	const legacyStored = (artifact: string, mtimeMs: number): Stored => ({
		artifact,
		bytes: LEGACY_BYTES,
		mtimeMs,
	})
	const sortedIds = (ids: readonly string[]) => [...ids].sort()

	it("a legacy-only store at cap − RESERVATION + 1 (stuck before): the oldest legacy files go down to the target and the next analog admission succeeds", async () => {
		const h = await evidenceHarness()
		const now = Date.now()
		const files: Stored[] = []
		for (let i = 0; i < 12; i++) {
			const mtimeMs = now - (((i * 5) % 12) + 1) * DAY
			const name = `202611${String(i + 1).padStart(2, "0")}_120000_${i}.wav`
			files.push(legacyStored(await h.legacy(name, mtimeMs), mtimeMs))
		}
		await h.pad()
		const used = 12 * LEGACY_BYTES + PAD
		const cap = used + RESERVATION - 1
		h.setCap(cap)
		// A pass first so admission counts the legacy bytes from a walk.
		await h.ev.retention(new Set([h.discoveryId]))
		expect(await h.admits()).toBe("SCANNER_ANALOG_STORAGE_CAP")
		// The discovery kept: nothing removable, reported so.
		expect(h.ev.recordingsQuotaExceeded).not.toBeNull()
		const expected = expectedEvictions(files, used, cap)
		expect(expected.length).toBeGreaterThan(2)
		expect(expected.length).toBeLessThan(files.length)
		const { deleted } = await h.ev.retention(new Set())
		// The oldest legacy files, until used + 8R fits.
		expect(sortedIds(deleted)).toEqual(sortedIds(expected))
		for (const f of files)
			expect(h.exists(f.artifact)).toBe(!expected.includes(f.artifact))
		const left = used - expected.length * LEGACY_BYTES
		expect(left + EVICTION_TARGET_MIN_HEADROOM).toBeLessThanOrEqual(cap)
		expect(h.analog.quotaShortfall(left)).toBeLessThanOrEqual(0)
		expect(h.ev.recordingsQuotaExceeded).toBeNull()
		expect(await h.admits()).toBe(true)
		await h.ev.stopAnalog()
	}, 60_000)

	it("a mixed store with legacy L > cap − 2R: legacy files go too, oldest first across both pools", async () => {
		const h = await evidenceHarness()
		const now = Date.now()
		const files: Stored[] = []
		// Fourteen legacy files aged 1 to 14 days, one analog file at 8.5 days, one at 1.5 days.
		for (let d = 14; d >= 1; d--) {
			const mtimeMs = now - d * DAY
			const name = `202611${String(d).padStart(2, "0")}_120000_${d}.wav`
			files.push(legacyStored(await h.legacy(name, mtimeMs), mtimeMs))
		}
		const analogOld = await h.record(now - 8.5 * DAY)
		const analogNew = await h.record(now - 1.5 * DAY)
		files.push(analogOld, analogNew)
		await h.pad()
		const legacyBytes = 14 * LEGACY_BYTES + PAD
		// L > cap − 2R: no analog eviction alone can make room.
		const cap = legacyBytes + RESERVATION
		expect(legacyBytes).toBeGreaterThan(cap - ADMISSION_HEADROOM)
		h.setCap(cap)
		const used = legacyBytes + analogOld.bytes + analogNew.bytes
		const expected = expectedEvictions(files, used, cap)
		const { deleted } = await h.ev.retention(new Set())
		expect(sortedIds(deleted)).toEqual(sortedIds(expected))
		// Both pools gave files; the young analog file and the youngest legacy files stay.
		expect(deleted).toContain(analogOld.artifact)
		expect(deleted).toContain(files[0]!.artifact)
		expect(h.exists(analogNew.artifact)).toBe(true)
		expect(h.exists(files[13]!.artifact)).toBe(true)
		expect(h.ev.recordingsQuotaExceeded).toBeNull()
		expect(await h.admits()).toBe(true)
		await h.ev.stopAnalog()
	}, 60_000)

	it("ordering across pools is by file time: a younger legacy file outlives an older analog file", async () => {
		const h = await evidenceHarness()
		const now = Date.now()
		const files: Stored[] = []
		// Alternating pools, oldest (12 days) to youngest (1 day): analog on even days.
		for (let d = 12; d >= 1; d--) {
			const mtimeMs = now - d * DAY
			if (d % 2 === 0) files.push(await h.record(mtimeMs))
			else {
				const name = `202611${String(d).padStart(2, "0")}_120000_${d}.wav`
				files.push(legacyStored(await h.legacy(name, mtimeMs), mtimeMs))
			}
		}
		await h.pad()
		const used = files.reduce((n, f) => n + f.bytes, PAD)
		// Shortfall of one byte at the trigger: the pass runs to the target, oldest first.
		const cap = used + ADMISSION_HEADROOM - 1
		h.setCap(cap)
		const expected = expectedEvictions(files, used, cap)
		expect(expected.length).toBeGreaterThan(2)
		expect(expected.length).toBeLessThan(files.length - 1)
		const { deleted } = await h.ev.retention(new Set())
		expect(sortedIds(deleted)).toEqual(sortedIds(expected))
		// Removed: exactly a prefix by file time across both pools.
		expect(sortedIds(deleted)).toEqual(
			sortedIds(files.slice(0, expected.length).map(f => f.artifact)),
		)
		// The cut falls between pools: an older analog file went, a younger legacy one stays.
		const kept = files.slice(expected.length)
		expect(kept.some(f => f.artifact.startsWith("recordings/dv/"))).toBe(true)
		expect(
			files
				.slice(0, expected.length)
				.some(f => !f.artifact.startsWith("recordings/dv/")),
		).toBe(true)
		for (const f of kept) expect(h.exists(f.artifact)).toBe(true)
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
		/** Twelve files, oldest first; the cap one byte past the trigger (a pass runs to the target). */
		const fill = async (): Promise<Stored[]> => {
			const files: Stored[] = []
			for (let daysAgo = 12; daysAgo >= 1; daysAgo--)
				files.push(await record(now - daysAgo * DAY))
			const used = analog.managedBytes!
			const capBytes = used + ADMISSION_HEADROOM - 1
			ev.setCaps({ ...caps, maxRecordingsMb: capBytes / MIB })
			return files
		}
		/** At the pass's tail: finalizations (the youngest files) until the store is short again. */
		const fillToTrigger = async (): Promise<void> => {
			for (let i = 0; (analog.quotaShortfall(0) ?? 0) <= 0; i++) {
				expect(i).toBeLessThan(12)
				await record(Date.now() - 60_000 + i)
			}
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
			fillToTrigger,
		}
	}

	it("finalizations after the last removal: no false warning, `again`, and the next pass removes the oldest", async () => {
		const t = await tailHarness()
		const files = await t.fill()
		// fill's cap: used + ADMISSION_HEADROOM − 1.
		const used = t.analog.managedBytes!
		const expected = expectedEvictions(
			files,
			used,
			used + ADMISSION_HEADROOM - 1,
		)
		// The tail fills the target's room again (several recordings, the youngest).
		t.atPassTail(t.fillToTrigger)
		const pass = await t.ev.retention(new Set())
		expect(pass.deleted).toEqual(expected)
		// Short again (the new files used the room), with removable files left.
		expect(t.analog.quotaShortfall(0)).toBeGreaterThan(0)
		expect(t.warned()).toHaveLength(0)
		expect(t.ev.recordingsQuotaExceeded).toBeNull()
		expect(pass.again).toBe(true)
		const next = await t.ev.retention(new Set())
		expect(next.deleted[0]).toBe(files[expected.length]!.artifact)
		expect(next.again).toBeUndefined()
		expect(t.analog.quotaShortfall(0)).toBeLessThanOrEqual(0)
		expect(t.ev.recordingsQuotaExceeded).toBeNull()
		expect(t.warned()).toHaveLength(0)
		await t.ev.stopAnalog()
	}, 120_000)

	it("an admission (a new reservation) after the last removal: no false warning, the next pass removes the oldest", async () => {
		const t = await tailHarness()
		const files = await t.fill()
		const used = t.analog.managedBytes!
		const expected = expectedEvictions(
			files,
			used,
			used + ADMISSION_HEADROOM - 1,
		)
		// Finalizations until one more admission crosses the trigger, then another discovery's
		// recording, admitted at the pass's tail and still in flight.
		let op: ReturnType<typeof t.begin> | null = null
		t.atPassTail(async () => {
			for (
				let i = 0;
				(t.analog.quotaShortfall(0) ?? 0) + RESERVATION <= 0;
				i++
			) {
				expect(i).toBeLessThan(12)
				await t.record(Date.now() - 60_000 + i)
			}
			op = t.begin(t.second, "o2")
			await op.ready
		})
		const pass = await t.ev.retention(new Set())
		expect(pass.deleted).toEqual(expected)
		expect(t.analog.quotaShortfall(0)).toBeGreaterThan(0)
		expect(t.warned()).toHaveLength(0)
		expect(t.ev.recordingsQuotaExceeded).toBeNull()
		expect(pass.again).toBe(true)
		const next = await t.ev.retention(new Set())
		expect(next.deleted[0]).toBe(files[expected.length]!.artifact)
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
		// B2: nothing changed since the exceeded pass, so no early pass while exceeded...
		expect(t.ev.recordingsQuotaInventoryChanged).toBe(false)
		// ...until the inventory changes (a finalized file): the state stays until the next pass.
		t.ev.setCaps({
			maxRecordingsMb: 2048,
			maxEvidenceMb: 20,
			maxAgeDays: 30,
			minFreeDiskMb: 0,
		})
		await t.record(Date.now() - 30_000)
		expect(t.ev.recordingsQuotaExceeded).not.toBeNull()
		expect(t.ev.recordingsQuotaInventoryChanged).toBe(true)
		await t.ev.retention(keep)
		expect(t.ev.recordingsQuotaExceeded).toBeNull()
		expect(t.ev.recordingsQuotaInventoryChanged).toBe(false)
		await t.ev.stopAnalog()
	}, 120_000)
})

/** A per-id promise chain, as EvidenceStore.serialise. */
function serialiser() {
	const tails = new Map<string, Promise<unknown>>()
	return async <T>(id: string, job: () => Promise<T>): Promise<T> => {
		const run = (tails.get(id) ?? Promise.resolve()).then(job, job)
		tails.set(
			id,
			run.then(
				() => undefined,
				() => undefined,
			),
		)
		return run
	}
}

describe("an active operation holds only its own files (B1)", () => {
	// Regression: the hold was discovery-wide, so an always-active noise discovery kept every
	// older file of it; retention then removed the newest real recordings of other discoveries
	// and a voiced admission was refused.
	it("a cap pass removes the older files of a discovery with an active operation, never the operation's own", async () => {
		const h = await harness()
		const files = await shuffledFour(h)
		const active = h.begin()
		await active.ready
		await active.push(new Int16Array(16_000))
		// One byte past the trigger, counting the active reservation (quotaShortfall does).
		h.limit.maxBytes += (h.shortfall() ?? 0) - 1
		expect(h.shortfall()).toBe(1)
		const deleted = await h.retain()
		expect(deleted.length).toBeGreaterThan(0)
		expect(deleted).toEqual(oldestFirst(files).slice(0, deleted.length))
		const receipt = await active.finish()
		expect(receipt.outcome).toBe("finalized")
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
		await h.ops.stop()
	}, 60_000)

	it("removableNow counts the active discovery's finalized files (so the quota is not entered as exceeded: `again`)", async () => {
		const h = await harness()
		await shuffledFour(h)
		const active = h.begin()
		await active.ready
		// A pass with room tries nothing: all four are left removable now.
		expect(await h.retain()).toEqual([])
		expect(h.ops.removableNow()).toBe(4)
		await active.finish()
		// The finalized operation is removable too once settled.
		expect(h.ops.removableNow()).toBe(5)
		await h.ops.stop()
	}, 60_000)

	it("a sibling retire queued while the active operation finishes (gate at 'prepared') leaves its commit current; both settle", async () => {
		let gateId: string | null = null
		let reached: () => void = () => undefined
		const atGate = new Promise<void>(done => {
			reached = done
		})
		let release: () => void = () => undefined
		const gate = new Promise<void>(done => {
			release = done
		})
		const io: AnalogOperationIo = {
			unlink: path => unlink(path),
			checkpoint: async (name, id) => {
				if (name === "prepared" && id === gateId) {
					reached()
					await gate
				}
			},
		}
		const h = await harness({ serialise: serialiser(), io })
		const files = await shuffledFour(h)
		const active = h.begin()
		await active.ready
		await active.push(new Int16Array(16_000))
		gateId = active.operationId
		const finishing = active.finish()
		await atGate
		// The pass's retires queue behind the finish's turn of the same discovery.
		h.limit.maxBytes += (h.shortfall() ?? 0) - 1
		const pass = h.retain()
		release()
		const [receipt, deleted] = await Promise.all([finishing, pass])
		expect(receipt.outcome).toBe("finalized")
		expect(existsSync(join(h.root, receipt.artifact!))).toBe(true)
		expect(deleted.length).toBeGreaterThan(0)
		expect(deleted).toEqual(oldestFirst(files).slice(0, deleted.length))
		for (const artifact of deleted)
			expect(existsSync(join(h.root, artifact))).toBe(false)
		await h.ops.stop()
	}, 60_000)

	it("hasCleanup still holds a discovery with an active operation (deletion waits for it)", async () => {
		const h = await harness()
		const active = h.begin()
		await active.ready
		await expect(h.ops.hasCleanup(h.discoveryId)).resolves.toBe(true)
		active.cancel()
		await active.settled
		await expect(h.ops.hasCleanup(h.discoveryId)).resolves.toBe(false)
		await h.ops.stop()
	}, 60_000)
})
