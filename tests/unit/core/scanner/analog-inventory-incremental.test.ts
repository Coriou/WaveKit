/**
 * The analog operation inventory is kept current without scanning the store: admission and
 * settlement read only their own operation, so their cost does not grow with the number of
 * recordings, and the exclusive lock covers only the reservation. Changes from outside this
 * process reach the inventory through the audit (the retention pass runs it), which fails closed
 * on anything unexpected exactly as the full scan does, and never applies reads older than a
 * change this process made since.
 */
import { randomUUID } from "node:crypto"
import {
	chmod,
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rm,
	unlink,
	writeFile,
	type FileHandle,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	AUDIT_CONCURRENCY_IDLE,
	AUDIT_CONCURRENCY_RECORDING,
	AnalogOperations,
	type AnalogMetadataAdapter,
	type AnalogOperationIo,
	type AnalogReceipt,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const dirs: string[] = []
const logger = createLogger({ level: "fatal" })
const NOW = 1_700_000_000_000
const MIB = 1024 * 1024
const caps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 1,
	maxAgeDays: 30,
	minFreeDiskMb: 1,
}
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

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
function adapterFor(store: DiscoveryStore): AnalogMetadataAdapter {
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
async function newRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wavekit-aoinc-")))
	dirs.push(root)
	return root
}
function newStore(): { store: DiscoveryStore; discoveryId: string } {
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => NOW,
		newId: counterIds(),
	})
	const { discoveryId } = store.ingest(
		makeObs({ id: "o1", centreHz: 446_000_000, startedAt: NOW }),
	)
	if (!discoveryId) throw new Error("Missing test discovery")
	return { store, discoveryId }
}
/** Counts every metadata read (intent.json, receipt.json) by its file name. */
function countingIo(reads: string[]): AnalogOperationIo {
	return {
		unlink: path => unlink(path),
		checkpoint: async () => undefined,
		readOpen: (path: string, flags: number): Promise<FileHandle> => {
			reads.push(path)
			return open(path, flags)
		},
	}
}
async function start(
	root: string,
	s: { store: DiscoveryStore; discoveryId: string },
	io?: AnalogOperationIo,
	maxRecordingsMb = caps.maxRecordingsMb,
) {
	const evidence = new EvidenceStore({
		dir: root,
		caps: { ...caps, maxRecordingsMb },
		logger,
		now: () => NOW,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => !!s.store.get(id),
		...(io ? { analogIo: io } : {}),
	})
	evidence.configureAnalog(adapterFor(s.store))
	await evidence.recoverAnalog()
	const record = async (): Promise<AnalogReceipt> => {
		const op = evidence.beginAnalog({
			discoveryId: s.discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3]))
		return op.finish()
	}
	return { evidence, record }
}
const ops = (root: string): string => join(root, ".analog-operations")
/** A store of its own over `root`, as EvidenceStore builds one (no other recordings). */
function direct(
	root: string,
	store: DiscoveryStore,
	io?: AnalogOperationIo,
): AnalogOperations {
	return new AnalogOperations({
		root,
		adapter: adapterFor(store),
		admits: () => true,
		serialise: async (_id, job) => job(),
		legacyBytes: async () => 0,
		limits: () => ({ maxBytes: 20 * MIB, minFreeBytes: 0 }),
		freeBytes: async () => 1e9,
		...(io ? { io } : {}),
	})
}
async function recordWith(
	operations: AnalogOperations,
	discoveryId: string,
): Promise<AnalogReceipt> {
	const op = operations.begin({
		discoveryId,
		observationId: "o1",
		binding: binding(),
	})
	await op.ready
	await op.push(new Int16Array(800))
	return op.finish()
}

describe("analog inventory without store scans", () => {
	it("admission and settlement read no other operation's files, at any store size", async () => {
		const root = await newRoot()
		const s = newStore()
		const first = await start(root, s)
		for (let i = 0; i < 12; i++)
			expect((await first.record()).outcome).toBe("finalized")
		await first.evidence.stopAnalog()
		const reads: string[] = []
		const life = await start(root, s, countingIo(reads))
		expect(life.evidence.analogAuthorityReady).toBe(true)
		reads.length = 0
		const receipt = await life.record()
		expect(receipt.outcome).toBe("finalized")
		// Only the new operation's own intent.json, read back by its settlement.
		expect(reads).toEqual([join(ops(root), receipt.operationId, "intent.json")])
	})

	it("an audit fails closed on a foreign file in an operation folder, as the full scan does", async () => {
		const root = await newRoot()
		const s = newStore()
		const life = await start(root, s)
		const kept = await life.record()
		await writeFile(
			join(ops(root), kept.operationId, "foreign.bin"),
			Buffer.alloc(8),
		)
		// Admission does not scan: the outside change is not seen yet.
		expect((await life.record()).outcome).toBe("finalized")
		await life.evidence.auditAnalog()
		expect(life.evidence.analogAuthorityReady).toBe(false)
		const refused = life.evidence.beginAnalog({
			discoveryId: s.discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		await expect(refused.ready).rejects.toThrow()
		expect((await refused.settled).errorCode).toBe("recovery-incomplete")
		// Removed again: the next audit's full scan clears it.
		await unlink(join(ops(root), kept.operationId, "foreign.bin"))
		await life.evidence.auditAnalog()
		expect(life.evidence.analogAuthorityReady).toBe(true)
		expect((await life.record()).outcome).toBe("finalized")
	})

	it("an audit fails closed on a name that is no operation", async () => {
		const root = await newRoot()
		const s = newStore()
		const life = await start(root, s)
		await life.record()
		await mkdir(join(ops(root), "not-an-operation"))
		await life.evidence.auditAnalog()
		expect(life.evidence.analogAuthorityReady).toBe(false)
	})

	it("an audit racing a recording applies nothing older than that recording's own refresh", async () => {
		const root = await newRoot()
		const s = newStore()
		let racing = false
		let during: Promise<AnalogReceipt> | null = null
		const operations: AnalogOperations = direct(root, s.store, {
			unlink: path => unlink(path),
			checkpoint: async name => {
				// The audit has listed; a whole recording lands before it reads anything.
				if (name !== "inventory-listed" || !racing) return
				racing = false
				during = recordWith(operations, s.discoveryId)
				await during
			},
		})
		await operations.recover()
		for (let i = 0; i < 3; i++) await recordWith(operations, s.discoveryId)
		racing = true
		await operations.audit()
		expect(during).not.toBeNull()
		expect((await during!).outcome).toBe("finalized")
		expect(operations.ready).toBe(true)
		const incremental = operations.managedBytes
		await operations.stop()
		// The incremental inventory agrees with a full scan by a fresh process.
		const rescanned = direct(root, s.store)
		await rescanned.recover()
		expect(incremental).not.toBeNull()
		expect(incremental).toBe(rescanned.managedBytes)
		expect((await readdir(ops(root))).length).toBe(4)
	})

	it("an audit never re-adds operations a deletion removed while it was reading", async () => {
		const root = await newRoot()
		const s = newStore()
		let auditing = false
		const race: { deletion: Promise<void> | null } = { deletion: null }
		const operations: AnalogOperations = direct(root, s.store, {
			unlink: path => unlink(path),
			checkpoint: async () => undefined,
			readOpen: (path: string, flags: number): Promise<FileHandle> => {
				// The audit's first read: the deletion is queued before the audit applies anything.
				if (auditing && race.deletion === null && path.endsWith("intent.json"))
					race.deletion = operations.deleteDiscovery(s.discoveryId)
				return open(path, flags)
			},
		})
		await operations.recover()
		const receipts: AnalogReceipt[] = []
		for (let i = 0; i < 4; i++)
			receipts.push(await recordWith(operations, s.discoveryId))
		auditing = true
		await operations.audit()
		auditing = false
		expect(race.deletion).not.toBeNull()
		await race.deletion
		expect(operations.ready).toBe(true)
		for (const receipt of receipts)
			expect(operations.ownsArtifact(receipt.artifact!)).toBe(false)
		expect(operations.managedBytes).toBe(0)
		expect(await readdir(ops(root))).toEqual([])
		await operations.stop()
	})

	it("an audit sees an operation folder removed by hand and credits its bytes", async () => {
		const root = await newRoot()
		const s = newStore()
		const operations = direct(root, s.store)
		await operations.recover()
		const gone = await recordWith(operations, s.discoveryId)
		await recordWith(operations, s.discoveryId)
		const before = operations.managedBytes!
		const dir = join(ops(root), gone.operationId)
		for (const name of await readdir(dir)) await unlink(join(dir, name))
		await rm(dir, { recursive: true })
		await unlink(join(root, gone.artifact!))
		await operations.audit()
		expect(operations.ready).toBe(true)
		expect(operations.managedBytes).toBeLessThan(before)
		expect(operations.ownsArtifact(gone.artifact!)).toBe(false)
		await operations.stop()
	})
})

/** An operation's intent.json read the audit makes, held `delayMs` so concurrent reads overlap. */
function auditReads(delayMs: number): {
	io: AnalogOperationIo
	probe: {
		auditing: boolean
		/** Reads of this id are not counted (an active operation's own settlement). */
		skip: string | null
		inflight: number
		max: number
		reads: string[]
		onRead: (() => void) | null
	}
} {
	const probe = {
		auditing: false,
		skip: null as string | null,
		inflight: 0,
		max: 0,
		reads: [] as string[],
		onRead: null as (() => void) | null,
	}
	return {
		probe,
		io: {
			unlink: path => unlink(path),
			checkpoint: async () => undefined,
			readOpen: async (path: string, flags: number): Promise<FileHandle> => {
				const counted =
					probe.auditing &&
					path.endsWith("intent.json") &&
					(probe.skip === null || !path.includes(probe.skip))
				if (!counted) return open(path, flags)
				probe.reads.push(path)
				probe.inflight++
				probe.max = Math.max(probe.max, probe.inflight)
				probe.onRead?.()
				try {
					await new Promise(resolve => setTimeout(resolve, delayMs))
					return await open(path, flags)
				} finally {
					probe.inflight--
				}
			},
		},
	}
}

describe("the audit reads operations concurrently, bounded by recording activity", () => {
	it(`reads ${AUDIT_CONCURRENCY_IDLE} operations at once while none is active, ${AUDIT_CONCURRENCY_RECORDING} while one records`, async () => {
		const root = await newRoot()
		const s = newStore()
		const { io, probe } = auditReads(20)
		const operations = direct(root, s.store, io)
		await operations.recover()
		for (let i = 0; i < 16; i++) await recordWith(operations, s.discoveryId)
		probe.auditing = true
		await operations.audit()
		probe.auditing = false
		expect(probe.reads).toHaveLength(16)
		expect(probe.max).toBe(AUDIT_CONCURRENCY_IDLE)
		expect(operations.ready).toBe(true)
		// A recording is active for the whole audit: never more than the recording bound.
		const op = operations.begin({
			discoveryId: s.discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		await op.ready
		await op.push(new Int16Array(800))
		probe.skip = op.operationId
		probe.reads = []
		probe.max = 0
		probe.auditing = true
		await operations.audit()
		probe.auditing = false
		expect(probe.reads).toHaveLength(16)
		expect(probe.max).toBe(AUDIT_CONCURRENCY_RECORDING)
		expect((await op.finish()).outcome).toBe("finalized")
		expect(operations.ready).toBe(true)
		// The inventory agrees with a fresh process's full scan.
		const managed = operations.managedBytes
		await operations.stop()
		const rescanned = direct(root, s.store)
		await rescanned.recover()
		expect(managed).toBe(rescanned.managedBytes)
	})

	it("parked readers resume once the recording ends mid-audit", async () => {
		const root = await newRoot()
		const s = newStore()
		const { io, probe } = auditReads(20)
		const operations = direct(root, s.store, io)
		await operations.recover()
		for (let i = 0; i < 24; i++) await recordWith(operations, s.discoveryId)
		const op = operations.begin({
			discoveryId: s.discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		await op.ready
		await op.push(new Int16Array(800))
		probe.skip = op.operationId
		let maxWhileRecording = 0
		let finished: Promise<AnalogReceipt> | null = null
		probe.onRead = () => {
			if (finished === null) {
				maxWhileRecording = Math.max(maxWhileRecording, probe.inflight)
				if (probe.reads.length === 4) {
					finished = op.finish()
					// Only what overlaps the settlement's end is counted from here on.
					probe.max = 0
				}
			}
		}
		probe.auditing = true
		await operations.audit()
		probe.auditing = false
		expect(finished).not.toBeNull()
		expect((await finished!).outcome).toBe("finalized")
		expect(probe.reads).toHaveLength(24)
		expect(maxWhileRecording).toBeLessThanOrEqual(AUDIT_CONCURRENCY_RECORDING)
		expect(probe.max).toBeGreaterThan(AUDIT_CONCURRENCY_RECORDING)
		expect(operations.ready).toBe(true)
		await operations.stop()
	})

	it("a concurrent audit still fails closed on one tampered operation among many", async () => {
		const root = await newRoot()
		const s = newStore()
		const operations = direct(root, s.store)
		await operations.recover()
		const receipts: AnalogReceipt[] = []
		for (let i = 0; i < 16; i++)
			receipts.push(await recordWith(operations, s.discoveryId))
		// An intent edited in place (no rename: its folder listing is unchanged).
		await writeFile(
			join(ops(root), receipts[7]!.operationId, "intent.json"),
			"{}",
		)
		await operations.audit()
		expect(operations.ready).toBe(false)
		await operations.stop()
	})

	it("a concurrent audit still sets crash residue aside among many operations", async () => {
		const root = await newRoot()
		const s = newStore()
		const operations = direct(root, s.store)
		await operations.recover()
		for (let i = 0; i < 16; i++) await recordWith(operations, s.discoveryId)
		const before = operations.managedBytes
		const staging = join(ops(root), `.staging-${randomUUID()}`)
		await mkdir(staging)
		await writeFile(join(staging, "intent.tmp"), "{}")
		await operations.audit()
		expect(operations.ready).toBe(true)
		expect(operations.setAsideStatus()).toEqual({
			setAside: 1,
			lastReason: "staging-residue",
		})
		expect(await readdir(ops(root))).not.toContain(staging.split("/").at(-1))
		expect(operations.managedBytes).toBe(before)
		await operations.stop()
	})
})

describe("the other recordings' bytes are walked, not per admission", () => {
	it("counts them at the first admission, then from the cache until retention walks again", async () => {
		const root = await newRoot()
		const s = newStore()
		const legacy = join(root, "recordings", "dv", s.discoveryId)
		await mkdir(legacy, { recursive: true })
		await writeFile(join(legacy, "call-1.wav"), Buffer.alloc(1024))
		// 4 MiB cap: one analog reservation (about 1.9 MB) fits beside 1 KiB, not beside 3 MiB.
		const life = await start(root, s, undefined, 4)
		expect((await life.record()).outcome).toBe("finalized")
		// Written by another producer since the walk: within LEGACY_BYTES_MAX_AGE_MS the cached
		// count stands (documented staleness), so this one is still admitted...
		await writeFile(join(legacy, "call-2.wav"), Buffer.alloc(3 * MIB))
		expect((await life.record()).outcome).toBe("finalized")
		// ...and the retention pass's walk (it keeps the discovery) refreshes it.
		await life.evidence.retention(new Set([s.discoveryId]))
		const refused = life.evidence.beginAnalog({
			discoveryId: s.discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		await expect(refused.ready).rejects.toThrow()
		expect((await refused.settled).errorCode).toBe("storage-cap")
	})

	it("a failed walk is not trusted: the next admission waits for its own and fails with it", async () => {
		const root = await newRoot()
		const s = newStore()
		const legacy = join(root, "recordings", "dv", s.discoveryId)
		await mkdir(legacy, { recursive: true })
		await writeFile(join(legacy, "call-1.wav"), Buffer.alloc(1024))
		const life = await start(root, s)
		// A warm count first (the walk the first admission waits for)...
		expect((await life.record()).outcome).toBe("finalized")
		await chmod(legacy, 0o000)
		try {
			// ...then a retention pass whose walk fails: the count is dropped, not kept.
			await expect(
				life.evidence.retention(new Set([s.discoveryId])),
			).rejects.toThrow()
			const op = life.evidence.beginAnalog({
				discoveryId: s.discoveryId,
				observationId: "o1",
				binding: binding(),
			})
			await expect(op.ready).rejects.toThrow()
			expect((await op.settled).outcome).not.toBe("finalized")
		} finally {
			await chmod(legacy, 0o755)
		}
		expect((await life.record()).outcome).toBe("finalized")
	})
})
