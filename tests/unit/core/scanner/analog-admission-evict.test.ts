/**
 * Admission makes its own room (B3): an analog admission short of bytes removes up to
 * ANALOG_EVICT_MAX_VICTIMS (8) removable finalized files itself, noise-like first, then other
 * unkept, then voice-like (oldest first within a class), and re-checks once; it is refused for
 * bytes only when no removable bytes remain (`no-removable`), a removal failed (`evict-failed`) or
 * 8 files were not enough (`insufficient`). Before, an always-active noise discovery held the
 * whole quota and a voiced admission was refused. Synthetic files and ids only.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	mkdtemp,
	open,
	readdir,
	lstat,
	realpath,
	rm,
	rmdir,
	unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import {
	ADMISSION_HEADROOM,
	ANALOG_EVICT_MAX_VICTIMS,
	AnalogOperations,
	AnalogStorageBytesError,
	EVICT_VOICE_PERIODIC_SHARE,
	MAX_ANALOG_FILE_BYTES,
	analogEvictClassOf,
	chooseEvictVictims,
	type AnalogEvictClass,
	type AnalogEvictRow,
	type AnalogFinishFacts,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { NoiseQuarantineFacts } from "../../../../src/core/scanner/store/noise-quarantine.js"
import {
	MAX_OPERATION_METADATA_BYTES,
	type RecordingBinding,
} from "../../../../src/core/scanner/store/recording-operation.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const RESERVATION = MAX_ANALOG_FILE_BYTES + MAX_OPERATION_METADATA_BYTES
const MIB = 1024 * 1024
/** Held bytes outside analog operations: keeps every test cap positive. */
const PAD = 64 * MIB
/** Never aged in these tests: only the admission (or the quota) removes. */
const NEVER_AGED = Number.MAX_SAFE_INTEGER
/** 1 000 samples: a 2 044 B WAV, so many files fit one reservation's shortfall. */
const SAMPLES = 1000
const dirs: string[] = []
let clock = 1_700_000_000_000

beforeEach(() => {
	// keptAt (the eviction age) comes from Date.now: one distinct second per call, in order.
	vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000))
})
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

const admissionFacts = (periodicShare: number): NoiseQuarantineFacts => ({
	frequencyHz: 446_000_000,
	reason: "noise",
	strength: "none",
	levelFrames: 150,
	spreadDb: 4.2,
	p10Dbfs: -12.5,
	periodicShare,
	burstFrames: 1,
})

/** Finish facts giving each eviction class (analogEvictClassOf). */
const FACTS: Record<AnalogEvictClass, AnalogFinishFacts> = {
	0: { keptBy: "noise-evidence", admission: admissionFacts(0.02) },
	1: { keptBy: "final" },
	2: { keptBy: "own-tone", tone: { kind: "ctcss", hz: 88.5 } },
}

async function tempRoot(): Promise<string> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-admission-evict-")),
	)
	dirs.push(root)
	return root
}

function storeWithDiscovery(): { store: DiscoveryStore; discoveryId: string } {
	const now = 1_700_000_000_000
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

function adapterOf(
	store: DiscoveryStore,
	alive: () => void = () => undefined,
): AnalogMetadataAdapter {
	return {
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, historical) =>
			store.recordingAssociation(d, o, historical),
		prepare: async metadata => {
			alive()
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			alive()
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
}

const ENGINE = randomUUID()
const binding = (): RecordingBinding => ({
	sourceId: "src-1",
	engineInstanceId: ENGINE,
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
	id: string
	artifact: string
	name: string
	bytes: number
	cls: AnalogEvictClass
}

/** A per-id promise chain, as EvidenceStore.serialise. */
function serialiser(onTurn?: (id: string) => void) {
	const tails = new Map<string, Promise<unknown>>()
	return async <T>(id: string, job: () => Promise<T>): Promise<T> => {
		onTurn?.(id)
		const prior = tails.get(id) ?? Promise.resolve()
		const run = prior.then(job, job)
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

interface HarnessOptions {
	root?: string
	world?: { store: DiscoveryStore; discoveryId: string }
	io?: AnalogOperationIo
	alive?: () => void
	onSerialise?: (id: string) => void
	listers?: (folderId: string, name: string) => readonly string[] | null
	evicted?: (artifacts: readonly string[]) => void
	admits?: (discoveryId: string) => boolean
	discoveryKept?: (discoveryId: string) => boolean
}

async function harness(opts: HarnessOptions = {}) {
	const root = opts.root ?? (await tempRoot())
	const { store, discoveryId } = opts.world ?? storeWithDiscovery()
	const limit = { maxBytes: 1024 * MIB }
	const legacy = { bytes: PAD }
	const kept = new Set<string>()
	const protection: RecordingProtection = {
		isProtected: () => false,
		isDsdFmeFileProtected: () => false,
		isScannerFileProtected: (_d, name) => kept.has(name),
		discoveryHoldsKept: () => false,
	}
	const ops = new AnalogOperations({
		root,
		adapter: adapterOf(store, opts.alive),
		admits: opts.admits ?? (() => true),
		serialise: serialiser(opts.onSerialise),
		legacyBytes: async () => legacy.bytes,
		limits: () => ({ maxBytes: limit.maxBytes, minFreeBytes: 0 }),
		freeBytes: async () => 1e12,
		protection,
		...(opts.io ? { io: opts.io } : {}),
		...(opts.listers ? { listers: opts.listers } : {}),
		...(opts.evicted ? { evicted: opts.evicted } : {}),
		...(opts.discoveryKept ? { discoveryKept: opts.discoveryKept } : {}),
	})
	await ops.recover()
	const begin = (on = { discoveryId, observationId: "o1" }) =>
		ops.begin({ ...on, binding: binding() })
	/** One finalized file of class `cls`; its bytes as the inventory counts them. */
	const record = async (
		cls: AnalogEvictClass,
		on?: { discoveryId: string; observationId: string },
	): Promise<Stored> => {
		const before = ops.managedBytes ?? 0
		const op = begin(on)
		await op.ready
		await op.push(new Int16Array(SAMPLES))
		const receipt = await op.finish("completed", FACTS[cls])
		expect(receipt.outcome).toBe("finalized")
		const artifact = receipt.artifact!
		return {
			id: receipt.operationId,
			artifact,
			name: artifact.split("/").at(-1)!,
			bytes: (ops.managedBytes ?? 0) - before,
			cls,
		}
	}
	const used = (): number => (ops.managedBytes ?? Number.NaN) + legacy.bytes
	/**
	 * Sets the cap so the next admission is exactly `need` bytes short: over = used + legacy +
	 * outstanding + RESERVATION − cap = need. quotaShortfall = used + legacy + outstanding +
	 * ADMISSION_HEADROOM (2R) − cap, so used + legacy + outstanding = quotaShortfall − 2R + cap.
	 */
	const shortBy = (need: number): void => {
		const committed =
			ops.quotaShortfall(legacy.bytes)! - ADMISSION_HEADROOM + limit.maxBytes
		limit.maxBytes = committed + RESERVATION - need
	}
	const retain = (keep: ReadonlySet<string> = new Set()) =>
		ops.retained(keep, NEVER_AGED, clock)
	/** The next admission: admitted (still active, `release` cancels it) or its refusal. */
	const admit = async (): Promise<
		| { admitted: true; release: () => Promise<void>; id: string }
		| { admitted: false; err: unknown }
	> => {
		const op = begin()
		try {
			await op.ready
		} catch (err: unknown) {
			await op.settled
			return { admitted: false, err }
		}
		return {
			admitted: true,
			id: op.operationId,
			release: async () => {
				op.cancel()
				await op.settled
			},
		}
	}
	const present = (f: Stored): boolean => existsSync(join(root, f.artifact))
	return {
		root,
		store,
		discoveryId,
		ops,
		limit,
		legacy,
		kept,
		begin,
		record,
		used,
		shortBy,
		retain,
		admit,
		present,
	}
}
type Harness = Awaited<ReturnType<typeof harness>>

function reasonOf(err: unknown): string {
	expect(err).toBeInstanceOf(AnalogStorageBytesError)
	return (err as AnalogStorageBytesError).reason
}

interface Internals {
	evicting: Map<string, string>
	earmarked: Map<string, number>
	evictOrder(): unknown
	quarantine: Map<
		string,
		{ operationId: string; discoveryId: string; reason: string }
	>
	uncertainResidue: Map<
		string,
		{ discoveryId: string; bytes: number; descriptors: ReadonlySet<unknown> }
	>
}
const internals = (ops: AnalogOperations): Internals =>
	ops as unknown as Internals

describe("admission eviction class (analogEvictClassOf)", () => {
	it("EVICT_VOICE_PERIODIC_SHARE is a tenth of the admission frames: 0.10", () => {
		expect(EVICT_VOICE_PERIODIC_SHARE).toBe(0.1)
	})

	it.each([
		["own-tone", "own-tone", null, undefined, 2],
		["a heard tone (an object)", "final", null, { kind: "ctcss", hz: 88.5 }, 2],
		["periodic share at 0.10", "prior-none", 0.1, undefined, 2],
		["periodic share past 0.10", undefined, 0.5, undefined, 2],
		["prior-none at 0.05, no tone", "prior-none", 0.05, undefined, 0],
		["prior-none just under 0.10", "prior-none", 0.0999, null, 0],
		["noise-evidence", "noise-evidence", null, undefined, 0],
		[
			"no keptBy and no admission facts, not legacy",
			undefined,
			null,
			undefined,
			1,
		],
		[
			"null keptBy and no admission facts, not legacy",
			null,
			null,
			undefined,
			1,
		],
		["prior-none without admission facts", "prior-none", null, undefined, 1],
		["final under 0.10", "final", 0.05, undefined, 1],
		["no keptBy with admission under 0.10", undefined, 0.05, undefined, 1],
		["'No tone heard' (null) is not a tone", "final", null, null, 1],
	] as const)(
		"%s (keptBy %s, periodic %s, tone %o) → class %s",
		(_label, keptBy, periodic, tone, cls) => {
			const admission = periodic === null ? null : admissionFacts(periodic)
			expect(analogEvictClassOf(keptBy, admission, tone)).toBe(cls)
		},
	)

	it.each([
		["measured: a whole level window (94 frames)", 94, undefined, 0],
		["measured: past the floor", 150, undefined, 0],
		["unmeasured: one frame under the floor, no branch", 93, undefined, 1],
		["unmeasured: no level frames, no branch", 0, undefined, 1],
		["measured: under the floor with the noise branch", 60, "noise", 0],
		["measured: under the floor with the data-buzz branch", 50, "data-buzz", 0],
	] as const)(
		"prior-none under 0.10 is noise-like only when the noise rule measured it: %s → class %s",
		(_label, levelFrames, branch, cls) => {
			const admission = {
				...admissionFacts(0.05),
				levelFrames,
				...(branch ? { branch } : {}),
			}
			expect(analogEvictClassOf("prior-none", admission, undefined)).toBe(cls)
		},
	)

	it("prior-none under 0.10 is noise-like only while no speech was heard", () => {
		const low = admissionFacts(0.05)
		expect(analogEvictClassOf("prior-none", low, undefined)).toBe(0)
		expect(
			analogEvictClassOf("prior-none", low, undefined, { speechHeard: false }),
		).toBe(0)
		expect(
			analogEvictClassOf("prior-none", low, undefined, { speechHeard: null }),
		).toBe(0)
		expect(
			analogEvictClassOf("prior-none", low, undefined, { speechHeard: true }),
		).toBe(1)
		// Voice-like wins over a heard speech reading's class anyway.
		expect(
			analogEvictClassOf("prior-none", admissionFacts(0.2), undefined, {
				speechHeard: true,
			}),
		).toBe(2)
	})

	it("missing keptBy and facts read noise-like only for a receipt that predates keptBy (legacy)", () => {
		expect(
			analogEvictClassOf(undefined, null, undefined, { legacy: true }),
		).toBe(0)
		expect(analogEvictClassOf(null, null, undefined, { legacy: true })).toBe(0)
		expect(
			analogEvictClassOf(undefined, null, undefined, { legacy: false }),
		).toBe(1)
		// Admission facts or a keptBy are never legacy-noise.
		expect(
			analogEvictClassOf(undefined, admissionFacts(0.05), undefined, {
				legacy: true,
			}),
		).toBe(1)
		expect(analogEvictClassOf("final", null, undefined, { legacy: true })).toBe(
			1,
		)
	})
})

describe("admission eviction choice (chooseEvictVictims)", () => {
	const row = (
		id: string,
		cls: AnalogEvictClass,
		ageMs: number,
		bytes = 10,
	): AnalogEvictRow => ({ id, cls, ageMs, bytes })

	it("orders by class, then age, then id; stops once the need is met", () => {
		const rows = [
			row("e", 2, 1),
			row("d", 1, 5),
			row("c", 0, 9),
			row("b", 0, 9),
			row("a", 0, Number.POSITIVE_INFINITY),
		]
		expect(chooseEvictVictims(rows, 25).map(r => r.id)).toEqual(["b", "c", "a"])
		expect(chooseEvictVictims(rows, 30).map(r => r.id)).toEqual(["b", "c", "a"])
		expect(chooseEvictVictims(rows, 31).map(r => r.id)).toEqual([
			"b",
			"c",
			"a",
			"d",
		])
		// No need (0 or less, or not a number): none.
		expect(chooseEvictVictims(rows, 0)).toEqual([])
		expect(chooseEvictVictims(rows, -1)).toEqual([])
		expect(chooseEvictVictims(rows, Number.NaN)).toEqual([])
	})

	it(`at most ANALOG_EVICT_MAX_VICTIMS (${ANALOG_EVICT_MAX_VICTIMS}): a need of exactly 8 rows takes 8, one byte more still 8`, () => {
		expect(ANALOG_EVICT_MAX_VICTIMS).toBe(8)
		const rows = Array.from({ length: 12 }, (_, i) =>
			row(`r${String(i).padStart(2, "0")}`, 0, i),
		)
		expect(chooseEvictVictims(rows, 8 * 10)).toHaveLength(8)
		expect(chooseEvictVictims(rows, 7 * 10 + 1)).toHaveLength(8)
		expect(chooseEvictVictims(rows, 7 * 10)).toHaveLength(7)
		expect(chooseEvictVictims(rows, 8 * 10 + 1)).toHaveLength(8)
		expect(chooseEvictVictims(rows, 1e9)).toHaveLength(8)
	})
})

describe("an admission short of bytes removes removable files itself", () => {
	it("evicts the oldest noise-like file and admits; then other, then voice-like", async () => {
		const h = await harness()
		const voice = await h.record(2)
		const other = await h.record(1)
		const noiseOld = await h.record(0)
		const noiseNew = await h.record(0)
		expect(h.ops.evictionClass(voice.id)).toBe(2)
		expect(h.ops.evictionClass(other.id)).toBe(1)
		expect(h.ops.evictionClass(noiseOld.id)).toBe(0)
		// A pass with room removes nothing but records its keep set.
		expect(await h.retain()).toEqual([])
		const order: Stored[] = []
		for (const expected of [noiseOld, noiseNew, other, voice]) {
			h.shortBy(1)
			const result = await h.admit()
			expect(result.admitted).toBe(true)
			if (result.admitted) await result.release()
			expect(h.present(expected)).toBe(false)
			order.push(expected)
			for (const f of [voice, other, noiseOld, noiseNew])
				if (!order.includes(f)) expect(h.present(f)).toBe(true)
		}
	})

	it("a need of exactly 8 files admits; one byte more evicts 8, refuses `insufficient`; the next admission evicts the 9th", async () => {
		const h = await harness()
		const files: Stored[] = []
		for (let i = 0; i < 18; i++) files.push(await h.record(0))
		await h.retain()
		const sum = (list: readonly Stored[]) =>
			list.reduce((n, f) => n + f.bytes, 0)
		// Exactly the first 8 files' bytes short: 8 go, admitted.
		h.shortBy(sum(files.slice(0, 8)))
		const at = await h.admit()
		expect(at.admitted).toBe(true)
		if (at.admitted) await at.release()
		expect(files.slice(0, 8).map(h.present)).toEqual(Array(8).fill(false))
		expect(files.slice(8).every(h.present)).toBe(true)
		// One byte past 8 files: the 8-victim cap is reached, refused, those 8 are gone.
		const rest = files.slice(8)
		h.shortBy(sum(rest.slice(0, 8)) + 1)
		const past = await h.admit()
		expect(past.admitted).toBe(false)
		if (!past.admitted) expect(reasonOf(past.err)).toBe("insufficient")
		expect(rest.slice(0, 8).map(h.present)).toEqual(Array(8).fill(false))
		expect(rest.slice(8).every(h.present)).toBe(true)
		// The cap unchanged: the next admission is one byte short, the 9th goes, admitted.
		const next = await h.admit()
		expect(next.admitted).toBe(true)
		if (next.admitted) await next.release()
		expect(h.present(rest[8]!)).toBe(false)
		expect(h.present(rest[9]!)).toBe(true)
		expect(internals(h.ops).evicting.size).toBe(0)
		expect(internals(h.ops).earmarked.size).toBe(0)
	})

	it("never chooses kept, unknown-lister, kept-discovery, unresolved or active files", async () => {
		let unknownName: string | null = null
		const h = await harness({
			listers: (_folder, name) => (name === unknownName ? null : []),
		})
		const keptFile = await h.record(0)
		const unknownFile = await h.record(0)
		const victim = await h.record(2)
		h.kept.add(keptFile.name)
		unknownName = unknownFile.name
		await h.retain()
		// An active operation's own folder is not in the index (not finalized).
		const active = h.begin()
		await active.ready
		await active.push(new Int16Array(SAMPLES))
		h.shortBy(1)
		const first = await h.admit()
		expect(first.admitted).toBe(true)
		if (first.admitted) await first.release()
		expect(h.present(keptFile)).toBe(true)
		expect(h.present(unknownFile)).toBe(true)
		expect(h.present(victim)).toBe(false)
		// Nothing removable left: refused `no-removable`, nothing else touched.
		h.shortBy(1)
		const none = await h.admit()
		expect(none.admitted).toBe(false)
		if (!none.admitted) expect(reasonOf(none.err)).toBe("no-removable")
		expect(h.present(keptFile)).toBe(true)
		expect(h.present(unknownFile)).toBe(true)
		const receipt = await active.finish()
		expect(receipt.outcome).toBe("finalized")
		// A keep set naming the discovery holds every file of it.
		const held = await h.record(0)
		await h.retain(new Set([h.discoveryId]))
		h.shortBy(1)
		const keptDiscovery = await h.admit()
		expect(keptDiscovery.admitted).toBe(false)
		expect(h.present(held)).toBe(true)
	})

	it("a victim's unlink failing refuses `evict-failed`; the inventory matches the disk and no mark is left", async () => {
		const failOn = new Set<string>()
		const io: AnalogOperationIo = {
			unlink: async path => {
				if (failOn.has(path))
					throw Object.assign(new Error("injected"), { code: "EIO" })
				await unlink(path)
			},
			checkpoint: async () => undefined,
		}
		const world = storeWithDiscovery()
		const root = await tempRoot()
		const h = await harness({ root, world, io })
		const victim = await h.record(0)
		await h.record(1)
		await h.retain()
		failOn.add(join(h.root, victim.artifact))
		h.shortBy(1)
		const result = await h.admit()
		expect(result.admitted).toBe(false)
		if (!result.admitted) expect(reasonOf(result.err)).toBe("evict-failed")
		expect(h.present(victim)).toBe(true)
		expect(internals(h.ops).evicting.size).toBe(0)
		expect(internals(h.ops).earmarked.size).toBe(0)
		const counted = h.ops.managedBytes
		const fresh = await harness({ root, world })
		expect(fresh.ops.managedBytes).toBe(counted)
	})

	it("a victim kept between the choice and its retire is skipped; the next one in order goes", async () => {
		let onTurn: ((id: string) => void) | null = null
		const h = await harness({ onSerialise: id => onTurn?.(id) })
		const first = await h.record(0)
		const second = await h.record(0)
		const third = await h.record(1)
		await h.retain()
		// The first retire's serialise turn: the chosen file is kept just before it runs.
		onTurn = () => {
			h.kept.add(first.name)
			onTurn = null
		}
		h.shortBy(1)
		const result = await h.admit()
		expect(result.admitted).toBe(true)
		if (result.admitted) await result.release()
		expect(h.present(first)).toBe(true)
		expect(h.present(second)).toBe(false)
		expect(h.present(third)).toBe(true)
	})

	it("two concurrent short admissions take disjoint victims; the freed bytes are earmarked for the evictor", async () => {
		const earmarks: [string, number][][] = []
		let ops: AnalogOperations | null = null
		const h = await harness({
			evicted: () => {
				if (ops) earmarks.push([...internals(ops).earmarked])
			},
		})
		ops = h.ops
		const files: Stored[] = []
		for (let i = 0; i < 4; i++) files.push(await h.record(0))
		await h.retain()
		// One byte short when neither has reserved: each round 0 sees the same need and chooses
		// one file, the other's choice being marked evicting (disjoint).
		h.shortBy(1)
		const [a, b] = await Promise.all([h.admit(), h.admit()])
		expect(files.map(h.present)).toEqual([false, false, true, true])
		// Each freed file was earmarked to its own evictor: every snapshot names only the two
		// admissions, each with one victim's bytes.
		expect(earmarks).toHaveLength(2)
		const ids = new Set(
			[a, b].map(r => (r.admitted ? r.id : null)).filter(id => id !== null),
		)
		for (const snapshot of earmarks)
			for (const [, bytes] of snapshot)
				expect([files[0]!.bytes, files[1]!.bytes]).toContain(bytes)
		expect(internals(h.ops).earmarked.size).toBe(0)
		// The first re-check reserves (the other's freed bytes count as used for it, so it fits
		// on its own victim); the second freed what its first check was short of but then also
		// needs room for the first's whole reservation: refused `raced`, never over the cap (I1).
		const results = [a, b]
		expect(results.filter(r => r.admitted)).toHaveLength(1)
		expect(ids.size).toBe(1)
		for (const r of results)
			if (!r.admitted) expect(reasonOf(r.err)).toBe("raced")
		expect(h.ops.quotaShortfall(h.legacy.bytes)!).toBeLessThanOrEqual(
			ADMISSION_HEADROOM,
		)
		for (const r of results) if (r.admitted) await r.release()
	})

	it("before the first retention pass nothing is evicted (its keep set is unknown): refused `no-removable`", async () => {
		const h = await harness()
		const file = await h.record(0)
		h.shortBy(1)
		const result = await h.admit()
		expect(result.admitted).toBe(false)
		if (!result.admitted) expect(reasonOf(result.err)).toBe("no-removable")
		expect(h.present(file)).toBe(true)
		// The first pass, with room: it removes nothing and records its keep set.
		h.limit.maxBytes = 1024 * MIB
		await h.retain()
		h.shortBy(1)
		const after = await h.admit()
		expect(after.admitted).toBe(true)
		if (after.admitted) await after.release()
		expect(h.present(file)).toBe(false)
	})

	it("the choice does no I/O: it is synchronous, and the admission reads only its victims' and its own folders", async () => {
		const reads: string[] = []
		const io: AnalogOperationIo = {
			unlink: path => unlink(path),
			rmdir: path => rmdir(path),
			readOpen: (path, flags) => {
				reads.push(path)
				return open(path, flags)
			},
			checkpoint: async () => undefined,
		}
		const h = await harness({ io })
		const files: Stored[] = []
		for (let i = 0; i < 6; i++) files.push(await h.record(0))
		await h.retain()
		const order = internals(h.ops).evictOrder()
		expect(Array.isArray(order)).toBe(true)
		expect((order as AnalogEvictRow[]).map(r => r.id)).toEqual(
			files.map(f => f.id),
		)
		reads.length = 0
		h.shortBy(files[0]!.bytes + 1)
		const result = await h.admit()
		expect(result.admitted).toBe(true)
		if (!result.admitted) return
		const allowed = [files[0]!.id, files[1]!.id, result.id]
		for (const path of reads)
			expect(allowed.some(id => path.includes(id))).toBe(true)
		await result.release()
		expect(files.slice(2).every(h.present)).toBe(true)
	})

	it("the class survives a restart (recovery reads receipt and sidecar) and matches the finalize-time class", async () => {
		const world = storeWithDiscovery()
		const root = await tempRoot()
		const h = await harness({ root, world })
		const files = [
			await h.record(2),
			await h.record(1),
			await h.record(0),
			await h.record(0),
		]
		const before = files.map(f => h.ops.evictionClass(f.id))
		expect(before).toEqual([2, 1, 0, 0])
		const restarted = await harness({ root, world })
		expect(files.map(f => restarted.ops.evictionClass(f.id))).toEqual(before)
		expect(restarted.ops.evictionClass(randomUUID())).toBeNull()
	})
})

describe("admission eviction reads the keep live and stays bounded", () => {
	it("a discovery kept after the last retention pass holds its files (live keep): refused, the file survives", async () => {
		const liveKept = new Set<string>()
		const h = await harness({ discoveryKept: id => liveKept.has(id) })
		const file = await h.record(0)
		await h.retain()
		// Kept since that pass: its keep set does not name it, the live keep does.
		liveKept.add(h.discoveryId)
		h.shortBy(1)
		const held = await h.admit()
		expect(held.admitted).toBe(false)
		if (!held.admitted) expect(reasonOf(held.err)).toBe("no-removable")
		expect(h.present(file)).toBe(true)
		// The keep removed again: the same file goes.
		liveKept.clear()
		const after = await h.admit()
		expect(after.admitted).toBe(true)
		if (after.admitted) await after.release()
		expect(h.present(file)).toBe(false)
	})

	it("a keep between the choice and the unlink turn holds the file (re-checked live in its turn)", async () => {
		const liveKept = new Set<string>()
		let onTurn: ((id: string) => void) | null = null
		const h = await harness({
			discoveryKept: id => liveKept.has(id),
			onSerialise: id => onTurn?.(id),
		})
		const first = await h.record(0)
		const second = await h.record(0)
		await h.retain()
		onTurn = id => {
			liveKept.add(id)
		}
		h.shortBy(1)
		const result = await h.admit()
		onTurn = null
		expect(result.admitted).toBe(false)
		if (!result.admitted) expect(reasonOf(result.err)).toBe("no-removable")
		expect(h.present(first)).toBe(true)
		expect(h.present(second)).toBe(true)
		expect(internals(h.ops).evicting.size).toBe(0)
		expect(internals(h.ops).earmarked.size).toBe(0)
	})

	it(`retires that remove nothing count apart: at most ${ANALOG_EVICT_MAX_VICTIMS} skipped, then the admission stops`, async () => {
		let onTurn: ((id: string) => void) | null = null
		const h = await harness({ onSerialise: id => onTurn?.(id) })
		const files: Stored[] = []
		for (let i = 0; i < 20; i++) files.push(await h.record(0))
		await h.retain()
		// Every chosen file is kept in its own turn: 8 retires skip, then the admission stops.
		let turns = 0
		onTurn = () => {
			h.kept.add(files[turns]!.name)
			turns++
		}
		h.shortBy(files.reduce((n, f) => n + f.bytes, 0))
		const skipped = await h.admit()
		onTurn = null
		expect(skipped.admitted).toBe(false)
		if (!skipped.admitted) expect(reasonOf(skipped.err)).toBe("no-removable")
		expect(turns).toBe(ANALOG_EVICT_MAX_VICTIMS)
		expect(files.every(h.present)).toBe(true)
	}, 60_000)

	it("skips do not use up the removals: 8 removals with a skip between each (15 retires) admit; a skip first stops at the 8th skip", async () => {
		let onTurn: ((id: string) => void) | null = null
		const h = await harness({ onSerialise: id => onTurn?.(id) })
		const files: Stored[] = []
		for (let i = 0; i < 30; i++) files.push(await h.record(0))
		await h.retain()
		// Removed at turns 0, 2, …, 14; kept in their own turn at 1, 3, …, 13.
		let turns = 0
		let base = 0
		onTurn = () => {
			if (turns % 2 === 1) h.kept.add(files[base + turns]!.name)
			turns++
		}
		const removed = files.filter((_, i) => i % 2 === 0).slice(0, 8)
		h.shortBy(removed.reduce((n, f) => n + f.bytes, 0))
		const result = await h.admit()
		expect(turns).toBe(2 * ANALOG_EVICT_MAX_VICTIMS - 1)
		expect(result.admitted).toBe(true)
		if (result.admitted) await result.release()
		expect(files.filter(f => !h.present(f)).map(f => f.id)).toEqual(
			removed.map(f => f.id),
		)
		// The next 15 files left in order: kept at turns 0, 2, …, 14 (8 skips), removed at 1, …,
		// 13 (7 removals) and then stopped at the skip bound: 15 retires, 16 at most in any case.
		base = 15
		turns = 0
		onTurn = () => {
			if (turns % 2 === 0) h.kept.add(files[base + turns]!.name)
			turns++
		}
		h.shortBy(files.slice(base).reduce((n, f) => n + f.bytes, 0))
		const stopped = await h.admit()
		onTurn = null
		expect(turns).toBe(2 * ANALOG_EVICT_MAX_VICTIMS - 1)
		expect(stopped.admitted).toBe(false)
		if (!stopped.admitted) expect(reasonOf(stopped.err)).toBe("insufficient")
		expect(files.slice(base).filter(f => !h.present(f)).length).toBe(
			ANALOG_EVICT_MAX_VICTIMS - 1,
		)
	}, 60_000)

	it("unresolved, quarantined and closure-uncertain files are never victims", async () => {
		const world = storeWithDiscovery()
		const other = world.store.ingest(
			makeObs({
				id: "o2",
				centreHz: 430_000_000,
				startedAt: 1_700_000_000_000,
			}),
		).discoveryId
		if (!other) throw new Error("Missing second discovery")
		let otherAdmitted = true
		const h = await harness({
			world,
			admits: id => id !== other || otherAdmitted,
		})
		const unresolved = await h.record(0, {
			discoveryId: other,
			observationId: "o2",
		})
		const quarantined = await h.record(0)
		const uncertain = await h.record(0)
		const victim = await h.record(2)
		await h.retain()
		otherAdmitted = false
		internals(h.ops).quarantine.set(quarantined.id, {
			operationId: quarantined.id,
			discoveryId: h.discoveryId,
			reason: "owner-unresolved",
		})
		internals(h.ops).uncertainResidue.set(uncertain.id, {
			discoveryId: h.discoveryId,
			bytes: 0,
			descriptors: new Set(),
		})
		h.shortBy(unresolved.bytes + quarantined.bytes + uncertain.bytes + 1)
		const result = await h.admit()
		expect(result.admitted).toBe(false)
		if (!result.admitted) expect(reasonOf(result.err)).toBe("insufficient")
		expect(h.present(unresolved)).toBe(true)
		expect(h.present(quarantined)).toBe(true)
		expect(h.present(uncertain)).toBe(true)
		expect(h.present(victim)).toBe(false)
		internals(h.ops).uncertainResidue.delete(uncertain.id)
	})

	it("an admission cancelled mid-eviction reports what it removed and releases its earmark and marks", async () => {
		const reported: string[][] = []
		let onTurn: ((id: string) => void) | null = null
		const h = await harness({
			onSerialise: id => onTurn?.(id),
			evicted: artifacts => reported.push([...artifacts]),
		})
		const first = await h.record(0)
		const second = await h.record(0)
		const third = await h.record(0)
		await h.retain()
		h.shortBy(first.bytes + second.bytes)
		const op = h.begin()
		// Cancelled while its first victim's retire waits for its turn: that retire runs, the
		// admission stops before the next one.
		onTurn = () => {
			onTurn = null
			op.cancel()
		}
		await expect(op.ready).rejects.toBeDefined()
		await op.settled
		expect(h.present(first)).toBe(false)
		expect(h.present(second)).toBe(true)
		expect(h.present(third)).toBe(true)
		expect(reported).toEqual([[first.artifact]])
		expect(internals(h.ops).evicting.size).toBe(0)
		expect(internals(h.ops).earmarked.size).toBe(0)
	})
})

/** Throws at the armed step, then every later injected step throws too: a dead process. */
class Crash {
	steps = 0
	armedAt = -1
	dead = false
	step(): void {
		if (this.dead) throw new Error("crashed")
		if (this.steps++ === this.armedAt) {
			this.dead = true
			throw new Error("crash cut")
		}
	}
	io(): AnalogOperationIo {
		return {
			unlink: async path => {
				this.step()
				await unlink(path)
			},
			rmdir: async path => {
				this.step()
				await rmdir(path)
			},
			checkpoint: async () => {
				this.step()
			},
		}
	}
}

async function listing(root: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (dir: string, prefix: string): Promise<void> => {
		for (const name of (await readdir(dir)).sort()) {
			const path = join(dir, name)
			const info = await lstat(path)
			if (info.isDirectory()) {
				out.push(`${prefix}${name}/`)
				await walk(path, `${prefix}${name}/`)
			} else out.push(`${prefix}${name} ${info.size}`)
		}
	}
	await walk(root, "")
	return out
}

describe("a crash during an admission's eviction", () => {
	/** Seeds a kept file and two noise files, then one admission evicting one; crash at `at`. */
	async function run(at: number): Promise<number> {
		const world = storeWithDiscovery()
		const root = await tempRoot()
		const crash = new Crash()
		const h = await harness({
			root,
			world,
			io: crash.io(),
			alive: () => {
				if (crash.dead) throw new Error("crashed")
			},
		})
		const keptFile = await h.record(0)
		h.kept.add(keptFile.name)
		await h.record(0)
		await h.record(0)
		await h.retain()
		h.shortBy(1)
		const start = crash.steps
		crash.armedAt = at < 0 ? -1 : start + at
		const crashed = await h.admit()
		const steps = crash.steps - start
		// The dead process's admitted operation is cancelled and settled, as the crash-safety
		// harness finishes its operations after a crash (every injected step throws now), so its
		// open payload.wav.part handle is closed explicitly, never by garbage collection.
		if (crashed.admitted) await crashed.release()
		await h.ops.stop()
		// Restart: a fresh owner on the same directory and journaled state.
		const restarted = await harness({ root, world })
		restarted.kept.add(keptFile.name)
		expect(restarted.ops.ready, `crash at admission step ${at}`).toBe(true)
		expect(restarted.present(keptFile)).toBe(true)
		await restarted.retain()
		restarted.limit.maxBytes = 1024 * MIB
		const next = await restarted.admit()
		expect(next.admitted, `crash at admission step ${at}`).toBe(true)
		if (next.admitted) await next.release()
		const once = await listing(root)
		await harness({ root, world })
		expect(await listing(root)).toEqual(once)
		return steps
	}

	it("restarts clean after a crash at every step of the admission (eviction included); the kept file is never lost", async () => {
		const steps = await run(-1)
		// The admission's own steps plus at least the victim's media unlink and its cleanup.
		expect(steps).toBeGreaterThan(6)
		for (let at = 0; at < steps; at++) await run(at)
	}, 240_000)
})

describe("admission eviction invariants (property)", () => {
	type Command =
		| { t: "record"; cls: AnalogEvictClass }
		| { t: "keep"; pick: number }
		| { t: "fail"; pick: number }
		| { t: "admit"; files: number; extra: number }
	const command: fc.Arbitrary<Command> = fc.oneof(
		fc.record({
			t: fc.constant("record" as const),
			cls: fc.constantFrom<AnalogEvictClass>(0, 1, 2),
		}),
		fc.record({ t: fc.constant("keep" as const), pick: fc.nat(20) }),
		fc.record({ t: fc.constant("fail" as const), pick: fc.nat(20) }),
		fc.record({
			t: fc.constant("admit" as const),
			files: fc.integer({ min: 0, max: 3 }),
			extra: fc.integer({ min: 1, max: 600 }),
		}),
	)

	it("I1-I3: reservations fit the cap, refusals say why, victims are the minimal eligible prefix", async () => {
		// Feature: recordings-store-room, Property 1: admission eviction keeps I1-I3
		// Validates: Requirements B1, B3
		await fc.assert(
			fc.asyncProperty(
				fc.array(command, { minLength: 1, maxLength: 5 }),
				async commands => {
					const failOn = new Set<string>()
					const io: AnalogOperationIo = {
						unlink: async path => {
							if (failOn.has(path))
								throw Object.assign(new Error("injected"), { code: "EIO" })
							await unlink(path)
						},
						checkpoint: async () => undefined,
					}
					const h: Harness = await harness({ io })
					const model: (Stored & { keptAt: number })[] = []
					const keptAtOf = (): number => clock
					for (const cls of [0, 1] as const)
						model.push({ ...(await h.record(cls)), keptAt: keptAtOf() })
					await h.retain()
					for (const c of commands) {
						const alive = model.filter(h.present)
						if (c.t === "record") {
							// Room for the recording itself (an admit step left the cap tight).
							h.limit.maxBytes = 1024 * MIB
							model.push({ ...(await h.record(c.cls)), keptAt: keptAtOf() })
							continue
						}
						if (c.t === "keep" || c.t === "fail") {
							const f = alive[c.pick % Math.max(1, alive.length)]
							if (!f) continue
							if (c.t === "keep") h.kept.add(f.name)
							else failOn.add(join(h.root, f.artifact))
							continue
						}
						// admit: `files` of the eligible files plus `extra` bytes short.
						const eligible = alive
							.filter(f => !h.kept.has(f.name))
							.map(f => ({
								id: f.id,
								cls: h.ops.evictionClass(f.id) ?? f.cls,
								ageMs: Number.NaN,
								bytes: f.bytes,
							}))
						const sorted = [...eligible].sort((a, b) => {
							const ma = model.find(m => m.id === a.id)!
							const mb = model.find(m => m.id === b.id)!
							return a.cls - b.cls || ma.keptAt - mb.keptAt
						})
						const need =
							sorted.slice(0, c.files).reduce((n, f) => n + f.bytes, 0) +
							c.extra
						h.shortBy(need)
						// The model's walk: in order until the need is met or 8 were tried;
						// an injected failure stops it.
						let freed = 0
						let tried = 0
						let failed = false
						const gone: string[] = []
						for (const row of sorted) {
							if (tried >= ANALOG_EVICT_MAX_VICTIMS || freed >= need) break
							tried++
							const f = model.find(m => m.id === row.id)!
							if (failOn.has(join(h.root, f.artifact))) {
								failed = true
								break
							}
							gone.push(f.id)
							freed += f.bytes
						}
						const result = await h.admit()
						// I3: exactly the minimal eligible prefix went, nothing kept was touched.
						for (const f of alive)
							expect(h.present(f), `file ${f.id}`).toBe(!gone.includes(f.id))
						if (freed >= need) {
							expect(result.admitted).toBe(true)
							// I1: used + legacy + outstanding (this one's reservation included) ≤ cap.
							expect(h.ops.quotaShortfall(h.legacy.bytes)!).toBeLessThanOrEqual(
								ADMISSION_HEADROOM,
							)
							if (result.admitted) await result.release()
						} else {
							// I2: refused only with a reason the model agrees with.
							expect(result.admitted).toBe(false)
							if (!result.admitted)
								expect(reasonOf(result.err)).toBe(
									failed
										? "evict-failed"
										: tried === 0
											? "no-removable"
											: "insufficient",
								)
						}
						expect(internals(h.ops).evicting.size).toBe(0)
						expect(internals(h.ops).earmarked.size).toBe(0)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 600_000)
})
