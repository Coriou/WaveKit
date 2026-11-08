/**
 * Storage ownership follows a co-channel split. A recording begun for discovery A whose
 * observation a split moved onto twin B commits to B, while its file stays where it was written,
 * in A's folder (no file move). The file belongs to B, the discovery listing it: no delete path of
 * A (discovery delete, inactive prune, capacity eviction, a fold of A into another discovery that
 * is then deleted) reaches it, it stays playable, and an operator keep of B protects it from
 * retention by age and by size. With or without a recording protection port.
 *
 * The ownership outlives the bounded observation window (it is persisted and journaled apart
 * from it), and it covers every kind: a digital recording listed by the twin is guarded like an
 * analog one.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const CH = 446_006_250
const PMR = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const DAY = 86_400_000
const CAPS: StorageCaps = {
	maxRecordingsMb: 20,
	maxEvidenceMb: 1,
	maxAgeDays: 30,
	minFreeDiskMb: 1,
}
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

/** A port that keeps nothing: every removal takes the guarded per-file path. */
const keepsNothing: RecordingProtection = {
	isProtected: () => false,
	isDsdFmeFileProtected: () => false,
	isScannerFileProtected: () => false,
	discoveryHoldsKept: () => false,
}

const voice = (id: string, startedAt: number, open = true) =>
	makeObs({
		id,
		centreHz: CH,
		startedAt,
		cls: "analog-fm",
		open,
		gate: "passed",
	})

const tone = (at: number): ProofAnalogInput => ({
	outcome: "decoded",
	mode: "nfm",
	voice: false,
	tone: { ctcssHz: 88.5, dcs: null },
	transport: "live",
	at,
})

function checkedDmr(at: number) {
	const ev = evidence("dmr", at, { talkgroups: ["9"] })
	return { ...ev, metadata: { ...ev.metadata, sources: ["1234"] } }
}

function bindingOf(): RecordingBinding {
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
		targetHz: CH,
		captureCentreHz: null,
		tuningTrust: "commanded",
	}
}

function adapterOf(store: DiscoveryStore): AnalogMetadataAdapter {
	return {
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, b) => store.recordingAssociation(d, o, b),
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

/** The evidence store as the scanner service wires it: liveness, merge aliases, analog adapter. */
async function evidenceOver(
	root: string,
	store: DiscoveryStore,
	clock: { now: number },
	protection: RecordingProtection | undefined,
): Promise<EvidenceStore> {
	const ev = new EvidenceStore({
		dir: root,
		caps: CAPS,
		logger,
		now: () => clock.now,
		statfs: async () => ({ freeBytes: 1e12 }),
		isDiscoveryLive: id => store.get(id) !== undefined,
		aliases: {
			aliasOwner: id => store.aliasOwner(id),
			aliasesOf: id => store.aliasesOf(id),
			releaseAliases: id => store.releaseAliases(id),
			heldFileNames: (id, removing) => store.heldFileNames(id, removing),
			heldRecordingOwner: id => store.heldRecordingOwner(id),
		},
		...(protection ? { protection } : {}),
	})
	store.setFolderLookup(id => ev.folders.holds(id))
	ev.configureAnalog(adapterOf(store))
	await ev.recoverAnalog()
	return ev
}

async function record(
	ev: EvidenceStore,
	discoveryId: string,
	observationId: string,
	beforeFinish?: () => void,
): Promise<{ artifact: string; operationId: string }> {
	const op = ev.beginAnalog({
		discoveryId,
		observationId,
		binding: bindingOf(),
	})
	await op.ready
	await op.push(new Int16Array([1, -2, 3, -4]))
	beforeFinish?.()
	const receipt = await op.finish()
	expect(receipt.outcome).toBe("finalized")
	return { artifact: receipt.artifact ?? "", operationId: op.operationId }
}

/**
 * Decoded DMR discovery A; an analog over on A's channel records for A, and its tone splits the
 * observation onto twin B before the recording ends, so the commit credits B. A also owns a
 * recording of its own, so its deletion still has something of its own to remove.
 */
async function splitScene(
	protection: RecordingProtection | undefined,
	digital: "decoded" | "checked" = "decoded",
) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-split-own-")),
	)
	dirs.push(root)
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})
	const ev = await evidenceOver(root, store, clock, protection)
	const a = store.ingest(voice("old", T0, false)).discoveryId ?? ""
	// Decoded DMR, or checked TG/SRC without a colour code (not decoded, so A can be evicted).
	const decoded =
		digital === "decoded"
			? evidence("dmr", T0 + 500, { identity: dmrCc(1) })
			: checkedDmr(T0 + 500)
	expect(store.appendObservationEvidence("old", decoded)).toBe(true)
	store.applyEvidence(a, decoded)
	const own = await record(ev, a, "old")
	const at = T0 + 60_000
	expect(store.ingest(voice("id", at)).discoveryId).toBe(a)
	let b = ""
	const twin = await record(ev, a, "id", () => {
		expect(store.recordAnalog("id", tone(at + 3_000))).toBe(true)
		b = store.discoveryIdOf("id") ?? ""
	})
	expect(b).not.toBe("")
	expect(b).not.toBe(a)
	expect(store.get(b)?.coChannel).toEqual([a])
	// Committed on B, written in A's folder.
	expect(twin.artifact.startsWith(`recordings/analog/${a}/`)).toBe(true)
	expect(store.get(b)?.evidence.recordings).toBe(1)
	const alias = `${a}~${twin.artifact.split("/").at(-1) ?? ""}`
	expect(
		store.snapshot().observations.find(o => o.id === "id")?.recordingIds,
	).toEqual([alias])
	const file = join(root, twin.artifact)
	expect(ev.recordingPath(alias)).toBe(file)
	return {
		root,
		clock,
		store,
		ev,
		a,
		b,
		alias,
		file,
		ownFile: join(root, own.artifact),
	}
}

type Scene = Awaited<ReturnType<typeof splitScene>>

/** The twin still lists, owns and serves its recording file. */
function twinKeeps(s: Scene, ev: EvidenceStore = s.ev): void {
	expect(s.store.get(s.b)?.evidence.recordings).toBe(1)
	expect(existsSync(s.file)).toBe(true)
	expect(ev.recordingPath(s.alias)).toBe(s.file)
}

const DELETE_PATHS: [
	string,
	(s: Scene) => Promise<void>,
	("decoded" | "checked")?,
][] = [
	[
		"discovery delete of A",
		async s => {
			expect(s.store.delete(s.a)).toBe(true)
			await s.ev.removeDiscovery(s.a)
			expect(existsSync(s.ownFile)).toBe(false)
		},
	],
	[
		"inactive prune of A",
		async s => {
			s.store.setOperator(s.b, { keep: true })
			// The store's clock is fixed, so an age bound in the future makes A inactive.
			const removed = s.store.pruneInactive(-1)
			expect(removed).toContain(s.a)
			expect(removed).not.toContain(s.b)
			for (const id of removed) await s.ev.removeDiscovery(id)
			expect(existsSync(s.ownFile)).toBe(false)
		},
	],
	[
		"capacity eviction of A",
		async s => {
			s.store.setOperator(s.b, { keep: true })
			const evicted: string[] = []
			s.store.on("evicted", (ds: Discovery[]) => {
				for (const d of ds) evicted.push(d.id)
			})
			s.store.setLimits({ maxDiscoveries: 2, minSurfaceBlocks: 1 })
			s.store.ingest(
				makeObs({
					id: "far",
					centreHz: CH + 2_000_000,
					startedAt: T0 + 120_000,
					cls: "analog-fm",
					gate: "passed",
				}),
			)
			expect(evicted).toEqual([s.a])
			for (const id of evicted) await s.ev.removeDiscovery(id)
			expect(existsSync(s.ownFile)).toBe(false)
		},
		"checked",
	],
	[
		"fold of A into another discovery that is then deleted",
		async s => {
			const c =
				s.store.ingest(
					makeObs({
						id: "other",
						centreHz: CH + 2_000_000,
						startedAt: T0 + 120_000,
						cls: "analog-fm",
						gate: "passed",
					}),
				).discoveryId ?? ""
			const folded = s.store.applyConsolidation({
				groups: [{ survivor: c, members: [s.a] }],
			})
			expect(folded.absorbed).toBe(1)
			expect(s.store.get(s.a)).toBeUndefined()
			expect(s.store.aliasOwner(s.a)).toBe(c)
			twinKeeps(s)
			expect(s.store.delete(c)).toBe(true)
			await s.ev.removeDiscovery(c)
			expect(existsSync(s.ownFile)).toBe(false)
		},
	],
	[
		"retention by age with the twin kept",
		async s => {
			s.clock.now = Date.now() + 31 * DAY
			const { deleted } = await s.ev.retention(new Set([s.b]))
			// A's own old recording goes; the twin's, kept with the twin, does not.
			expect(deleted).toEqual([s.ownFile.slice(s.root.length + 1)])
		},
	],
	[
		"retention by size with the twin kept",
		async s => {
			s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
			const { deleted } = await s.ev.retention(new Set([s.b]))
			expect(deleted).not.toContain(s.file.slice(s.root.length + 1))
		},
	],
]

for (const [mode, protection] of [
	["without a protection port", undefined],
	["with a protection port", keepsNothing],
] as const) {
	describe(`a split twin's recording file survives every delete path (${mode})`, () => {
		for (const [name, run, digital] of DELETE_PATHS) {
			it(name, async () => {
				const s = await splitScene(protection, digital)
				await run(s)
				twinKeeps(s)
			})
		}

		it("past the bound: retention without a keep of the twin still removes its old file", async () => {
			const s = await splitScene(protection)
			s.clock.now = Date.now() + 31 * DAY
			const { deleted } = await s.ev.retention(new Set())
			expect(deleted).toContain(s.file.slice(s.root.length + 1))
			expect(existsSync(s.file)).toBe(false)
		})
	})
}

describe("a split twin's recording after its folder's discovery is gone", () => {
	it("stays available across a restart of the evidence store", async () => {
		const s = await splitScene(keepsNothing)
		expect(s.store.delete(s.a)).toBe(true)
		await s.ev.removeDiscovery(s.a)
		await s.ev.stopAnalog()
		const next = await evidenceOver(s.root, s.store, s.clock, keepsNothing)
		twinKeeps(s, next)
	})

	it("a delete by A's id finds no cleanup of its own left", async () => {
		const s = await splitScene(undefined)
		expect(s.store.delete(s.a)).toBe(true)
		await s.ev.removeDiscovery(s.a)
		expect(await s.ev.hasAnalogCleanup(s.a)).toBe(false)
		await s.ev.removeDiscovery(s.a)
		twinKeeps(s)
	})
})

/** Tone-confirmed analog overs on the twin's channel until `id` has left the twin's window. */
function rotateWindow(s: Scene): void {
	const start = T0 + 120_000
	for (let i = 0; i < 257; i++) {
		const id = `n${i}`
		const at = start + i * 2_000
		s.store.ingest(voice(id, at, false))
		s.store.recordAnalog(id, tone(at + 500))
		expect(s.store.discoveryIdOf(id)).toBe(s.b)
	}
	expect(s.store.snapshot().observations.some(o => o.id === "id")).toBe(false)
}

for (const [mode, protection] of [
	["without a protection port", undefined],
	["with a protection port", keepsNothing],
] as const) {
	describe(`ownership outlives the observation window (${mode})`, () => {
		it("A's deletion after the twin's window rotated leaves the twin's file", async () => {
			const s = await splitScene(protection)
			s.store.setOperator(s.b, { keep: true })
			rotateWindow(s)
			expect(s.store.recordingAssociation(s.a, "id")?.ownerId).toBe(s.b)
			expect(s.store.delete(s.a)).toBe(true)
			await s.ev.removeDiscovery(s.a)
			expect(existsSync(s.ownFile)).toBe(false)
			twinKeeps(s)
			expect(s.store.recordingAssociation(s.a, "id")?.ownerId).toBe(s.b)
		})

		it("survives a snapshot, a journal replay and an evidence store restart", async () => {
			const s = await splitScene(protection)
			const base = s.store.snapshot()
			const entries: JournalEntry[] = []
			s.store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
				entries.push({ ...e, seq: entries.length + 1 }),
			)
			rotateWindow(s)
			expect(s.store.delete(s.a)).toBe(true)
			const fresh = (): DiscoveryStore =>
				new DiscoveryStore({
					maxDiscoveries: 100,
					now: () => T0,
					newId: counterIds(),
					rasters: () => PMR,
				})
			const restored = fresh()
			restored.restore(s.store.snapshot())
			const replayed = fresh()
			replayed.restore(base)
			for (const e of entries) replayed.replay(e)
			for (const store of [restored, replayed]) {
				expect(store.recordingAssociation(s.a, "id")?.ownerId).toBe(s.b)
				expect(store.heldFileNames(s.a, [s.a]).size).toBe(1)
			}
			await s.ev.stopAnalog()
			const next = await evidenceOver(s.root, restored, s.clock, protection)
			await next.removeDiscovery(s.a)
			expect(existsSync(s.file)).toBe(true)
			expect(next.recordingPath(s.alias)).toBe(s.file)
		})
	})

	describe(`a digital recording the twin lists is guarded too (${mode})`, () => {
		async function digitalScene() {
			const root = await realpath(
				await mkdtemp(join(tmpdir(), "wavekit-split-dv-")),
			)
			dirs.push(root)
			const clock = { now: T0 }
			const store = new DiscoveryStore({
				maxDiscoveries: 100,
				now: () => T0,
				newId: counterIds(),
				rasters: () => PMR,
			})
			const ev = await evidenceOver(root, store, clock, protection)
			const a = store.ingest(voice("old", T0, false)).discoveryId ?? ""
			const decoded = evidence("dmr", T0 + 500, { identity: dmrCc(1) })
			expect(store.appendObservationEvidence("old", decoded)).toBe(true)
			store.applyEvidence(a, decoded)
			const dir = join(root, "recordings", "dv", a)
			await mkdir(dir, { recursive: true })
			const file = join(dir, "clip.wav")
			await writeFile(file, Buffer.alloc(64))
			const own = join(dir, "own.wav")
			await writeFile(own, Buffer.alloc(64))
			const at = T0 + 60_000
			expect(store.ingest(voice("id", at)).discoveryId).toBe(a)
			const rid = `${a}~clip.wav`
			expect(store.attachRecordings("id", [rid], "linked")).toBe(true)
			expect(store.recordAnalog("id", tone(at + 3_000))).toBe(true)
			const b = store.discoveryIdOf("id") ?? ""
			expect(b).not.toBe(a)
			const listed = store.snapshot().observations.find(o => o.id === "id")
			expect(listed?.discoveryId).toBe(b)
			expect(listed?.recordingIds).toEqual([rid])
			return { root, clock, store, ev, a, b, rid, file, own }
		}

		it("A's deletion does not reach the WAV the twin lists", async () => {
			const s = await digitalScene()
			s.store.setOperator(s.b, { keep: true })
			expect(s.store.delete(s.a)).toBe(true)
			await s.ev.removeDiscovery(s.a)
			expect(existsSync(s.own)).toBe(false)
			expect(existsSync(s.file)).toBe(true)
			expect(s.ev.recordingPath(s.rid)).toBe(s.file)
		})

		it("retention by age and by size keeps it with the twin kept", async () => {
			const s = await digitalScene()
			s.clock.now = Date.now() + 31 * DAY
			s.ev.setCaps({ ...CAPS, maxRecordingsMb: 0 })
			const { deleted } = await s.ev.retention(new Set([s.b]))
			expect(deleted).toContain(s.own.slice(s.root.length + 1))
			expect(existsSync(s.file)).toBe(true)
		})
	})
}
