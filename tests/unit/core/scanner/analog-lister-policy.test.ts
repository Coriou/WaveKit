/**
 * A finalized analog recording another discovery lists, after its own observation was retracted
 * (its discovery stays live through another observation): the ownership table names the other
 * discovery only.
 *
 * - Unknown listers keep the file: with its WAV quarantined at recovery and the listers lookup
 *   throwing (the evidence store answers unknown), deleting the folder's discovery leaves the WAV
 *   that the live lister still lists.
 * - Recovery follows the recorded lister, never the physical folder's discovery: retention with
 *   only the folder's discovery kept ages the WAV out with the lister's own files.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdtemp, realpath, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const T0 = Date.now() - 3_600_000
const DAY = 86_400_000
const BASE_HZ = 430_000_000
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

function bindingOf(targetHz: number): RecordingBinding {
	return {
		sourceId: "src-1",
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 1,
		channelId: "opaque",
		channelGeneration: 1,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: null,
		targetHz,
		captureCentreHz: null,
		tuningTrust: "commanded",
	}
}

/** The service's adapter shape, retainedOwner included. */
const adapterOf = (store: DiscoveryStore): AnalogMetadataAdapter => ({
	authorityHealthy: () => true,
	bindingLive: () => true,
	association: (d, o, b) => store.recordingAssociation(d, o, b),
	retainedOwner: (d, o, alias) => store.retainedRecordingOwner(d, o, alias),
	prepare: async metadata => {
		store.prepareRecording(metadata)
	},
	inverse: async id => {
		store.removePreparedRecording(id)
	},
	buildCommitPlan: id => store.buildRecordingCommitPlan(id),
	commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
	publishCommit: plan => store.publishRecordingCommit(plan),
})

interface Lookup {
	/** The listers lookup throws (its answer is unknown). */
	throws: boolean
}

function evidenceOf(
	dir: string,
	store: DiscoveryStore,
	lookup: Lookup,
): EvidenceStore {
	const ev = new EvidenceStore({
		dir,
		caps: {
			maxRecordingsMb: 64,
			maxEvidenceMb: 64,
			maxAgeDays: 30,
			minFreeDiskMb: 0,
		},
		logger,
		now: () => Date.now(),
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => store.get(id) !== undefined,
		aliases: {
			aliasOwner: id => store.aliasOwner(id),
			aliasesOf: id => store.aliasesOf(id),
			releaseAliases: id => store.releaseAliases(id),
			heldFileNames: (id, removing) => store.heldFileNames(id, removing),
			heldRecordingListers: id => {
				if (lookup.throws) throw new Error("lookup failed")
				return store.heldRecordingListers(id)
			},
			heldRecordingHolders: id => store.heldRecordingHolders(id),
			heldFolderUnknown: id => store.heldFolderUnknown(id),
		},
	})
	store.setFolderLookup(id => ev.folders.holds(id))
	ev.configureAnalog(adapterOf(store))
	return ev
}

/**
 * A's o1 finalizes A's WAV; o1k keeps A live; B's o2 lists the WAV too; o1 is then retracted
 * (truncated). The table lists B only. Returns the store, the file and the ids, with the
 * writing evidence store stopped.
 */
async function scene(lookup: Lookup) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "wavekit-lister-")))
	dirs.push(dir)
	const store = new DiscoveryStore({
		maxDiscoveries: 1_000,
		now: () => T0,
		newId: counterIds(),
		logger,
	})
	const writer = evidenceOf(dir, store, lookup)
	await writer.loadFolderIndex()
	await writer.recoverAnalog()
	const ingest = (id: string, hz: number, at: number, truncated = false) =>
		store.ingest(
			makeObs({
				id,
				centreHz: hz,
				startedAt: T0 + at,
				cls: "analog-fm",
				open: false,
				gate: "passed",
				...(truncated ? { truncated: true } : {}),
			}),
		).discoveryId
	const hzA = BASE_HZ + 1_000_000
	const a = ingest("o1", hzA, 1_000) ?? ""
	expect(a).not.toBe("")
	const op = writer.beginAnalog({
		discoveryId: a,
		observationId: "o1",
		binding: bindingOf(hzA),
	})
	await op.ready
	await op.push(new Int16Array([1, -2, 3, -4, 5, -6]))
	const receipt = await op.finish()
	expect(receipt.outcome).toBe("finalized")
	const artifact = receipt.artifact ?? ""
	const file = join(dir, artifact)
	const rid = `${a}~${artifact.split("/").at(-1) ?? ""}`
	expect(ingest("o1k", hzA, 11_000)).toBe(a)
	const b = ingest("o2", BASE_HZ + 2_000_000, 2_000) ?? ""
	expect(b).not.toBe("")
	expect(store.attachRecordings("o2", [rid], "linked")).toBe(true)
	ingest("o1", hzA, 1_000, true)
	expect(store.discoveryIdOf("o1")).toBeUndefined()
	expect(store.get(a)).toBeDefined()
	expect(store.heldRecordingListers(rid)).toEqual([b])
	await writer.stopAnalog()
	expect(existsSync(file)).toBe(true)
	return { dir, store, a, b, rid, file }
}

describe("a finalized analog recording another discovery lists", () => {
	it("unknown listers keep its quarantined WAV when the folder's discovery is deleted", async () => {
		const lookup: Lookup = { throws: false }
		const s = await scene(lookup)
		// One byte appended: recovery quarantines the WAV (media-invalid).
		await appendFile(s.file, Buffer.alloc(1))
		const ev = evidenceOf(s.dir, s.store, lookup)
		await ev.loadFolderIndex()
		const recovered = await ev.recoverAnalog()
		expect(recovered.map(r => r.status)).toEqual(["quarantined"])
		lookup.throws = true
		await ev.removeDiscovery(s.a).catch(() => undefined)
		expect(s.store.get(s.b)).toBeDefined()
		expect(existsSync(s.file)).toBe(true)
		await ev.stopAnalog()
	})

	it("recovery follows its recorded lister: only the folder's discovery kept, it ages out with the lister's files", async () => {
		const s = await scene({ throws: false })
		const ev = evidenceOf(s.dir, s.store, { throws: false })
		await ev.loadFolderIndex()
		const recovered = await ev.recoverAnalog()
		expect(recovered.map(r => r.status)).toEqual(["available"])
		expect(ev.recordingPath(s.rid)).toBe(s.file)
		const old = new Date(Date.now() - 31 * DAY)
		await utimes(s.file, old, old)
		// Kept with its lister.
		await ev.retention(new Set([s.b]))
		expect(existsSync(s.file)).toBe(true)
		// Its lister unkept: aged out, though its folder's discovery is kept.
		await ev.retention(new Set([s.a]))
		expect(existsSync(s.file)).toBe(false)
		// The table's lister is the owner, not the folder's discovery.
		expect(s.store.retainedRecordingOwner(s.a, "o1", s.rid)).toBe(s.b)
		await ev.stopAnalog()
	})

	it("a file only its own folder's discovery owned still recovers after its observation is retracted", async () => {
		const s = await scene({ throws: false })
		// B no longer exists: no lister is recorded; the folder's own discovery is the owner.
		expect(s.store.delete(s.b)).toBe(true)
		expect(s.store.heldRecordingListers(s.rid)).toEqual([])
		expect(s.store.retainedRecordingOwner(s.a, "o1", s.rid)).toBe(s.a)
		const ev = evidenceOf(s.dir, s.store, { throws: false })
		await ev.loadFolderIndex()
		expect((await ev.recoverAnalog()).map(r => r.status)).toEqual(["available"])
		expect(ev.recordingPath(s.rid)).toBe(s.file)
		const old = new Date(Date.now() - 31 * DAY)
		await utimes(s.file, old, old)
		await ev.retention(new Set([s.a]))
		expect(existsSync(s.file)).toBe(true)
		await ev.retention(new Set())
		expect(existsSync(s.file)).toBe(false)
		await ev.stopAnalog()
	})
})
