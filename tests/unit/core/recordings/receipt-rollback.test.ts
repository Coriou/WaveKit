/**
 * Rollback of the kept-file receipt members (`keptBy`, `speechHeard`, `startedAt`): a core
 * before them reads receipt.json with the strict AnalogReceiptSchema minus those three members.
 * That reader refuses a new receipt, so its recovery quarantines the recording
 * (`receipt-unreadable`): nothing is moved, renamed or deleted, retention keeps it, and a core
 * that knows the members admits it again at its next start. The older reader is modelled exactly
 * (the schema without the three members); the quarantine path is the one recovery takes for any
 * receipt member its schema does not know. Modelled data only.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	AnalogReceiptSchema,
	type AnalogMetadataAdapter,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const T0 = Date.now() - 3_600_000
const DAY = 86_400_000
const HZ = 431_000_000
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

/** The receipt schema of a core before the kept-file members: the same, without them, strict. */
const olderReceiptSchema = AnalogReceiptSchema.innerType()
	.omit({ keptBy: true, speechHeard: true, startedAt: true })
	.strict()

function binding(): RecordingBinding {
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
		targetHz: HZ,
		captureCentreHz: null,
		tuningTrust: "commanded",
	}
}

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

function evidenceOf(dir: string, store: DiscoveryStore): EvidenceStore {
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
			heldRecordingListers: id => store.heldRecordingListers(id),
			heldRecordingHolders: id => store.heldRecordingHolders(id),
			heldFolderUnknown: id => store.heldFolderUnknown(id),
		},
	})
	store.setFolderLookup(id => ev.folders.holds(id))
	ev.configureAnalog(adapterOf(store))
	return ev
}

/** Every path under `dir`, sorted (what is on disk, so "nothing moved" is checkable). */
async function tree(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true })
	return entries.map(String).sort()
}

describe("a kept file's receipt on an older core", () => {
	it("is refused by the older reader, quarantined without any change on disk, and admitted again by the new core", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "wk-rollback-")))
		dirs.push(dir)
		const store = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => T0,
			newId: counterIds(),
			logger,
		})
		const writer = evidenceOf(dir, store)
		await writer.loadFolderIndex()
		await writer.recoverAnalog()
		const discoveryId =
			store.ingest(
				makeObs({
					id: "o1",
					centreHz: HZ,
					startedAt: T0 + 1_000,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId ?? ""
		expect(discoveryId).not.toBe("")
		const op = writer.beginAnalog({
			discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		await op.ready
		await op.push(new Int16Array([1, -2, 3, -4, 5, -6]))
		const receipt = await op.finish("completed", {
			keptBy: "final",
			speechHeard: true,
			startedAt: new Date(T0 + 1_000).toISOString(),
		})
		expect(receipt.outcome).toBe("finalized")
		expect(receipt).toMatchObject({ keptBy: "final", speechHeard: true })
		const file = join(dir, receipt.artifact ?? "")
		await writer.stopAnalog()
		const receiptPath = join(
			dir,
			".analog-operations",
			op.operationId,
			"receipt.json",
		)
		const written = await readFile(receiptPath, "utf8")
		const stored: unknown = JSON.parse(written)

		// The older reader refuses it; without the three members it takes it.
		expect(olderReceiptSchema.safeParse(stored).success).toBe(false)
		const { keptBy, speechHeard, startedAt, ...older } = stored as Record<
			string,
			unknown
		>
		expect([keptBy, speechHeard, startedAt]).toHaveLength(3)
		expect(olderReceiptSchema.safeParse(older).success).toBe(true)

		// The recovery path the older core takes for a receipt it cannot parse: a member its
		// schema does not know (here one the current schema does not know either).
		await writeFile(
			receiptPath,
			JSON.stringify({ ...(stored as object), memberFromLater: true }),
		)
		const before = await tree(dir)
		const older1 = evidenceOf(dir, store)
		await older1.loadFolderIndex()
		const recovered = await older1.recoverAnalog()
		expect(recovered.map(r => r.status)).toEqual(["quarantined"])
		// Retention with nothing kept and the file past maxAgeDays never removes it.
		const old = new Date(Date.now() - 31 * DAY)
		await utimes(file, old, old)
		await older1.retention(new Set())
		expect(existsSync(file)).toBe(true)
		expect(await tree(dir)).toEqual(before)
		await older1.stopAnalog()

		// The new core comes back: the receipt it wrote is read as written, and the file is admitted.
		await writeFile(receiptPath, written)
		const back = evidenceOf(dir, store)
		await back.loadFolderIndex()
		expect((await back.recoverAnalog()).map(r => r.status)).toEqual([
			"available",
		])
		expect(existsSync(file)).toBe(true)
		await back.stopAnalog()
	})
})
