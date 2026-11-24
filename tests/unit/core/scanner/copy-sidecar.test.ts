/**
 * Copy mark of a kept scanner analog recording (copy-facts.ts, AnalogOperations.writeCopy):
 * `<storage>/copies/<operationId>.json`, outside `.analog-operations/` (an older core's recovery
 * scan never sees it), written and removed under the store lock only for a settled, finalized,
 * listed operation, held in an in-memory index the catalogue reads as `copyOf` (taken again on the
 * copy-changed notice although the WAV stat is unchanged; no mark file is opened by the
 * catalogue), filtered by `copies=false` (never a Kept copy), loaded and swept at recovery
 * (orphans, malformed marks, stale temps), removed with the operation. Synthetic ids and made-up
 * frequencies only.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingsChangedEventData } from "@wavekit/api-types"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import {
	type AnalogMetadataAdapter,
	type AnalogNotice,
	type AnalogOperationIo,
} from "../../../../src/core/scanner/store/analog-operations.js"
import {
	COPY_FACTS_MAX_BYTES,
	COPY_MARKS_DIR,
	CopyFactsSchema,
	copyFactsBytes,
	copyFactsOf,
	type CopyFactsInput,
} from "../../../../src/core/scanner/store/copy-facts.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)
const HZ = 151_250_000
const dirs: string[] = []
const closers: (() => void)[] = []

afterEach(async () => {
	for (const close of closers.splice(0)) close()
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

/** The inventory's keep answer in these tests: the keys in `kept` are Kept. */
function keptKeys(kept: Set<string>): RecordingProtection {
	return {
		isProtected: key => kept.has(key),
		isDsdFmeFileProtected: () => false,
		isScannerFileProtected: () => false,
		discoveryHoldsKept: () => false,
	}
}

async function harness(io?: AnalogOperationIo) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wk-copy-")))
	dirs.push(root)
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => NOW,
		newId: counterIds(),
	})
	const discoveryId = store.ingest(
		makeObs({ id: "o1", centreHz: HZ, startedAt: NOW }),
	).discoveryId!
	const binding: RecordingBinding = {
		sourceId: "src-1",
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 1,
		channelId: "opaque-grant",
		channelGeneration: 1,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: null,
		targetHz: HZ,
		captureCentreHz: null,
		tuningTrust: "unverified",
	}
	const adapter: AnalogMetadataAdapter = {
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
		publishCommit: plan => {
			store.publishRecordingCommit(plan)
		},
	}
	const notices: AnalogNotice[] = []
	const evidenceOf = () => {
		const ev = new EvidenceStore({
			dir: root,
			caps: {
				maxRecordingsMb: 20,
				maxEvidenceMb: 1,
				maxAgeDays: 30,
				minFreeDiskMb: 1,
			},
			logger,
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e9 }),
			isDiscoveryLive: id => !!store.get(id),
			...(io ? { analogIo: io } : {}),
		})
		ev.onAnalogNotice(n => notices.push(n))
		ev.configureAnalog(adapter)
		return ev
	}
	let evidence = evidenceOf()
	await evidence.recoverAnalog()
	const kept = new Set<string>()
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => join(root, "recordings"),
		logger,
		protection: keptKeys(kept),
	})
	// As catalogue-wiring binds it: the store's in-memory index, never a file.
	inventory.setCopySource?.(id => evidence.copyOf(id))
	closers.push(() => inventory.close?.())
	/** A restart of the store: a new EvidenceStore recovers (and loads the marks) in place. */
	const restart = async (): Promise<EvidenceStore> => {
		await evidence.stopAnalog()
		evidence = evidenceOf()
		await evidence.recoverAnalog()
		return evidence
	}
	return {
		kept,
		restart,
		get current() {
			return evidence
		},
		root,
		store,
		discoveryId,
		binding,
		evidence,
		evidenceOf,
		inventory,
		notices,
	}
}

type Harness = Awaited<ReturnType<typeof harness>>

/** A kept file of the discovery's observation (`_label` names it in the test only). */
async function keptOp(h: Harness, _label = "first") {
	const op = h.evidence.beginAnalog({
		discoveryId: h.discoveryId,
		observationId: "o1",
		binding: h.binding,
	})
	await op.ready
	await op.push(new Int16Array(8000).fill(900))
	const receipt = await op.finish("completed", { keptBy: "prior-none" })
	expect(receipt.outcome).toBe("finalized")
	const settled = new Date(Date.now() - 10 * 60_000)
	await utimes(join(h.root, receipt.artifact ?? ""), settled, settled)
	const alias = `${h.discoveryId}~analog-${op.operationId}.wav`
	return { op, receipt, alias, key: `scan:${alias}` }
}

const copiesDir = (h: Harness): string => join(h.root, COPY_MARKS_DIR)
const copyPath = (h: Harness, operationId: string): string =>
	join(copiesDir(h), `${operationId}.json`)
const copyTemp = (h: Harness, operationId: string): string =>
	join(copiesDir(h), `${operationId}.tmp`)

/**
 * The names a pre-copy core's recovery scan admits in an operation folder (frozen from that core's
 * analog-operations.ts scanFolder: any other name marks the inventory unknown and quarantines
 * every operation; at most 8 children are listed).
 */
const BASE_OPERATION_FOLDER_NAMES = [
	"intent.json",
	"intent.tmp",
	"receipt.json",
	"receipt.tmp",
	"payload.wav.part",
	"facts.json",
	"facts.tmp",
] as const

const record = (key: string, operationId: string): CopyFactsInput => ({
	of: { key, operationId },
	score: { r: 0.931, z: 11.2, neff: 180, lagFrames: -1 },
	evidence: ["intermod", "off-raster"],
})

describe("copy mark: writeCopy under the store lock", () => {
	it("writes copies/<id>.json for a finalized, listed operation and notifies copy-changed", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		expect(
			await h.evidence.writeCopy(
				copy.op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("written")
		const stored = CopyFactsSchema.parse(
			JSON.parse(await readFile(copyPath(h, copy.op.operationId), "utf8")),
		)
		expect(stored).toMatchObject({
			version: 1,
			operationId: copy.op.operationId,
			of: { key: root.key, operationId: root.op.operationId },
			evidence: ["intermod", "off-raster"],
		})
		expect(existsSync(copyTemp(h, copy.op.operationId))).toBe(false)
		expect(h.evidence.copyOf(copy.op.operationId)?.of.key).toBe(root.key)
		expect(h.notices).toContainEqual({
			kind: "copy-changed",
			alias: copy.alias,
		})
		// Removing it: "removed", notified, gone.
		expect(await h.evidence.writeCopy(copy.op.operationId, null)).toBe(
			"removed",
		)
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(false)
		expect(h.evidence.copyOf(copy.op.operationId)).toBeNull()
		// Nothing to remove: skipped, no notice.
		const before = h.notices.length
		expect(await h.evidence.writeCopy(copy.op.operationId, null)).toBe(
			"skipped",
		)
		expect(h.notices.length).toBe(before)
	})

	it("skips an operation still active (its finish not settled), an unknown one and a removed one", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const op = h.evidence.beginAnalog({
			discoveryId: h.discoveryId,
			observationId: "o1",
			binding: h.binding,
		})
		await op.ready
		await op.push(new Int16Array(800).fill(500))
		expect(
			await h.evidence.writeCopy(
				op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("skipped")
		await op.finish("completed", {})
		expect(
			await h.evidence.writeCopy(
				randomUUID(),
				record(root.key, root.op.operationId),
			),
		).toBe("skipped")
		expect(await h.evidence.writeCopy("not-a-uuid", null)).toBe("skipped")
		const gone = await keptOp(h, "o4")
		await h.evidence.removeDiscovery(h.discoveryId)
		expect(
			await h.evidence.writeCopy(
				gone.op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("skipped")
		expect(existsSync(copyPath(h, gone.op.operationId))).toBe(false)
	})

	it("renames through the io seam: a failed rename leaves no sidecar and no temp, skipped, no notice", async () => {
		let failRename = false
		const renamed: string[] = []
		const h0 = { root: "" }
		const h = await harness({
			unlink: path => unlink(path),
			checkpoint: async () => undefined,
			rename: async (from, to) => {
				renamed.push(to)
				if (failRename && to.startsWith(join(h0.root, COPY_MARKS_DIR)))
					throw Object.assign(new Error("injected"), { code: "EIO" })
				await rename(from, to)
			},
		})
		h0.root = h.root
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		failRename = true
		const before = h.notices.length
		expect(
			await h.evidence.writeCopy(
				copy.op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("skipped")
		expect(
			renamed.filter(p => p === copyPath(h, copy.op.operationId)),
		).toHaveLength(1)
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(false)
		expect(existsSync(copyTemp(h, copy.op.operationId))).toBe(false)
		expect(h.evidence.copyOf(copy.op.operationId)).toBeNull()
		expect(h.notices.length).toBe(before)
		// The folder is as it was: the next write succeeds through the same seam.
		failRename = false
		expect(
			await h.evidence.writeCopy(
				copy.op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("written")
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(true)
	})

	it("skips an aborted operation (never finalized)", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const op = h.evidence.beginAnalog({
			discoveryId: h.discoveryId,
			observationId: "o1",
			binding: h.binding,
		})
		await op.ready
		op.cancel("cancelled")
		expect((await op.settled).outcome).toBe("aborted")
		expect(
			await h.evidence.writeCopy(
				op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("skipped")
	})

	it("a write racing a retention removal never leaves an orphaned mark (one lock)", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		const wav = join(h.root, copy.receipt.artifact ?? "")
		const old = new Date(NOW - 31 * 86_400_000)
		await utimes(wav, old, old)
		await utimes(join(h.root, root.receipt.artifact ?? ""), old, old)
		const [, written] = await Promise.all([
			h.evidence.retention(new Set()),
			h.evidence.writeCopy(
				copy.op.operationId,
				record(root.key, root.op.operationId),
			),
		])
		expect(["written", "skipped"]).toContain(written)
		expect(
			existsSync(join(h.root, ".analog-operations", copy.op.operationId)),
		).toBe(false)
		expect(h.notices).toContainEqual({
			kind: "removed",
			operationId: copy.op.operationId,
		})
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(false)
		expect(h.evidence.copyOf(copy.op.operationId)).toBeNull()
	})

	it("paces a burst: each write takes the lock alone, so another lock user waits for one write, not the burst", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const others = [
			await keptOp(h, "o2"),
			await keptOp(h, "o3"),
			await keptOp(h, "o4"),
		]
		const order: string[] = []
		// A burst as the detector sends it (never awaited), then a lock user (a retention pass).
		const burst = [...others, ...others, ...others].map((o, i) =>
			h.evidence
				.writeCopy(
					o.op.operationId,
					i % 2 === 0 ? record(root.key, root.op.operationId) : null,
				)
				.then(r => {
					order.push("write")
					return r
				}),
		)
		const retention = h.evidence.retention(new Set()).then(() => {
			order.push("retention")
		})
		await Promise.all([...burst, retention])
		// The retention pass ran before the burst finished (it queued once, behind at most a write).
		expect(order.indexOf("retention")).toBeLessThan(order.length - 1)
	})
})

describe("copy mark: a cleanup that gives up", () => {
	it("a removal that fails before the folder goes leaves the operation writable again", async () => {
		let failWav: string | null = null
		const h = await harness({
			unlink: async path => {
				if (path === failWav)
					throw Object.assign(new Error("injected"), { code: "EIO" })
				await unlink(path)
			},
			checkpoint: async () => undefined,
			rename: (from, to) => rename(from, to),
		})
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		const wav = join(h.root, copy.receipt.artifact ?? "")
		failWav = wav
		const old = new Date(NOW - 31 * 86_400_000)
		await utimes(wav, old, old)
		await h.evidence.retention(new Set()).catch(() => undefined)
		expect(existsSync(wav)).toBe(true)
		expect(h.notices).not.toContainEqual({
			kind: "removed",
			operationId: copy.op.operationId,
		})
		// The cleanup gave up: the operation is no longer retiring, so the mark is written.
		failWav = null
		expect(
			await h.evidence.writeCopy(
				copy.op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("written")
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(true)
	})
})

describe("copy mark: outside the operation folder, removed with the operation, swept at recovery", () => {
	it("retention removes the mark and its temp with the operation and notifies removed", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		await writeFile(copyTemp(h, copy.op.operationId), "{")
		const old = new Date(NOW - 31 * 86_400_000)
		await utimes(join(h.root, copy.receipt.artifact ?? ""), old, old)
		await h.evidence.retention(new Set())
		expect(
			existsSync(join(h.root, ".analog-operations", copy.op.operationId)),
		).toBe(false)
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(false)
		expect(existsSync(copyTemp(h, copy.op.operationId))).toBe(false)
		expect(h.evidence.copyOf(copy.op.operationId)).toBeNull()
		expect(h.notices).toContainEqual({
			kind: "removed",
			operationId: copy.op.operationId,
		})
	})

	it("rollback: a pre-copy core's frozen 7-name list admits every operation folder the new code writes; the marks sit outside .analog-operations", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		expect(
			await h.evidence.writeCopy(
				copy.op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("written")
		const operations = join(h.root, ".analog-operations")
		for (const id of [root.op.operationId, copy.op.operationId]) {
			const names = await readdir(join(operations, id))
			// What that core's scanFolder checks: at most 8 children, each one of its 7 names.
			expect(names.length).toBeLessThanOrEqual(8)
			expect(
				names.filter(
					n => !(BASE_OPERATION_FOLDER_NAMES as readonly string[]).includes(n),
				),
			).toEqual([])
		}
		// Top-level `.analog-operations/` entries: operation folders (and cleanup markers) only.
		for (const name of await readdir(operations))
			expect(name).toMatch(
				/^(\.set-aside|\.staging-[0-9a-f-]{36}|[0-9a-f-]{36}(\.cleanup)?)$/,
			)
		// The marks live beside it, directly under the storage root.
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(true)
		expect(copiesDir(h).startsWith(operations)).toBe(false)
		expect(await readdir(copiesDir(h))).toEqual([`${copy.op.operationId}.json`])
	})

	it("recovery loads valid marks into the index (copies-loaded), removes orphans, malformed marks and stale temps, leaves foreign names", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		const orphan = randomUUID()
		const bytes = copyFactsBytes(
			orphan,
			record(root.key, root.op.operationId),
			NOW,
		)!
		await writeFile(copyPath(h, orphan), bytes)
		await writeFile(copyTemp(h, copy.op.operationId), "{")
		await writeFile(copyPath(h, root.op.operationId), "{ not json")
		await writeFile(join(copiesDir(h), "README"), "foreign")
		const before = h.notices.length
		const next = await h.restart()
		expect(next.analogQuarantine()).toEqual([])
		expect(h.notices.slice(before)).toContainEqual({ kind: "copies-loaded" })
		expect(next.copyOf(copy.op.operationId)?.of.key).toBe(root.key)
		expect(next.copyOf(root.op.operationId)).toBeNull()
		expect(next.copyOf(orphan)).toBeNull()
		expect((await readdir(copiesDir(h))).sort()).toEqual(
			[`${copy.op.operationId}.json`, "README"].sort(),
		)
		// The catalogue takes the loaded marks on the notice (memory: copiesReloaded).
		h.inventory.copiesReloaded?.()
		await vi.waitFor(async () =>
			expect(
				(await h.inventory.list({ limit: "200" })).items.find(
					i => i.key === copy.key,
				)?.copyOf?.key,
			).toBe(root.key),
		)
	})

	it("an oversized mark reads as no copy and is removed; a symlinked copies dir loads nothing and removes nothing", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		await mkdir(copiesDir(h), { recursive: true })
		await writeFile(
			copyPath(h, copy.op.operationId),
			" ".repeat(COPY_FACTS_MAX_BYTES + 1),
		)
		let next = await h.restart()
		expect(next.copyOf(copy.op.operationId)).toBeNull()
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(false)
		// A symlink in place of the directory: fail closed (nothing loaded, nothing followed).
		await rm(copiesDir(h), { recursive: true })
		const elsewhere = await mkdtemp(join(tmpdir(), "wk-copy-elsewhere-"))
		dirs.push(elsewhere)
		await writeFile(
			join(elsewhere, `${copy.op.operationId}.json`),
			copyFactsBytes(
				copy.op.operationId,
				record(root.key, root.op.operationId),
				NOW,
			)!,
		)
		const { symlink } = await import("node:fs/promises")
		await symlink(elsewhere, copiesDir(h))
		next = await h.restart()
		expect(next.copyOf(copy.op.operationId)).toBeNull()
		expect(existsSync(join(elsewhere, `${copy.op.operationId}.json`))).toBe(
			true,
		)
	})
})

describe("copy mark: the catalogue's copyOf, copies filter and memory index", () => {
	async function wired(h: Harness) {
		h.evidence.onAnalogNotice(n => {
			if (n.kind === "copy-changed") h.inventory.copyChanged?.(n.alias)
		})
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		const other = await keptOp(h, "o3")
		// Indexed before any sidecar exists.
		const first = await h.inventory.list({ limit: "200" })
		expect(first.items).toHaveLength(3)
		expect(first.items.every(i => i.copyOf === null)).toBe(true)
		expect(first.counts?.copiesTotal).toBe(0)
		return { root, copy, other }
	}

	it("takes the mark from the index on the notice although the WAV stat is unchanged; never opens a mark file", async () => {
		const h = await harness()
		const { root, copy } = await wired(h)
		const wav = join(h.root, copy.receipt.artifact ?? "")
		const before = await lstat(wav)
		// Written behind the store's back: not in the index, so never a copy, even after a re-read.
		await mkdir(copiesDir(h), { recursive: true })
		await writeFile(
			copyPath(h, copy.op.operationId),
			copyFactsBytes(
				copy.op.operationId,
				record(root.key, root.op.operationId),
				NOW,
			)!,
		)
		h.inventory.invalidate?.(copy.key)
		const stale = await h.inventory.list({ limit: "200" })
		expect(stale.items.find(i => i.key === copy.key)?.copyOf).toBeNull()
		// Through the store: the notice takes the index's mark.
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		const page = await h.inventory.list({ limit: "200" })
		expect(page.items.find(i => i.key === copy.key)?.copyOf).toEqual({
			key: root.key,
			evidence: ["intermod", "off-raster"],
		})
		// Memory, not the file: the mark file gone behind the store's back changes nothing shown.
		await unlink(copyPath(h, copy.op.operationId))
		h.inventory.invalidate?.(copy.key)
		const still = await h.inventory.list({ limit: "200" })
		expect(still.items.find(i => i.key === copy.key)?.copyOf?.key).toBe(
			root.key,
		)
		const after = await lstat(wav)
		expect(after.mtimeMs).toBe(before.mtimeMs)
		expect(after.size).toBe(before.size)
	})

	it("never hides a Kept copy and never counts it in copiesTotal", async () => {
		const h = await harness()
		const { root, copy, other } = await wired(h)
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		expect((await h.inventory.list({ limit: "200" })).counts?.copiesTotal).toBe(
			1,
		)
		h.kept.add(copy.key)
		h.inventory.invalidate?.(copy.key)
		const hidden = await h.inventory.list({ limit: "200", copies: "false" })
		expect(hidden.items.map(i => i.key).sort()).toEqual(
			[root.key, copy.key, other.key].sort(),
		)
		expect(hidden.items.find(i => i.key === copy.key)?.copyOf?.key).toBe(
			root.key,
		)
		expect(hidden.matched).toBe(3)
		expect(hidden.counts?.copiesTotal).toBe(0)
		h.kept.delete(copy.key)
		h.inventory.invalidate?.(copy.key)
		const again = await h.inventory.list({ limit: "200", copies: "false" })
		expect(again.items.some(i => i.key === copy.key)).toBe(false)
		expect(again.counts?.copiesTotal).toBe(1)
	})

	it("lists copies by default; copies=false leaves them out of the listing and `matched`, never `counts`", async () => {
		const h = await harness()
		const { root, copy, other } = await wired(h)
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		const all = await h.inventory.list({ limit: "200" })
		expect(all.items).toHaveLength(3)
		expect(all.matched).toBe(3)
		expect(all.counts?.copiesTotal).toBe(1)
		const shown = await h.inventory.list({ limit: "200", copies: "false" })
		expect(shown.items.map(i => i.key).sort()).toEqual(
			[root.key, other.key].sort(),
		)
		expect(shown.matched).toBe(2)
		expect(shown.counts?.total).toBe(3)
		expect(shown.counts?.copiesTotal).toBe(1)
		expect(
			(await h.inventory.list({ limit: "200", copies: "true" })).items,
		).toHaveLength(3)
		await expect(h.inventory.list({ copies: "maybe" })).rejects.toThrow()
		// GET by id and the memory indexes ignore the filter.
		expect(await h.inventory.resolve(copy.key)).not.toBeNull()
		expect(h.inventory.keysOfCopyRoot?.(root.key)).toEqual([copy.key])
		expect(h.inventory.itemsOfKeys?.([copy.key])[0]?.copyOf?.key).toBe(root.key)
		// A filtered listing (kind) still honours copies=false.
		expect(
			(await h.inventory.list({ kind: "scanner-analog", copies: "false" }))
				.items,
		).toHaveLength(2)
	})

	it("a copy whose root is not listed, or is itself a copy, reads as no copy (shown again)", async () => {
		const h = await harness()
		const { root, copy, other } = await wired(h)
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		// The root becomes a copy of another file: its own copy reads as no copy.
		await h.evidence.writeCopy(
			root.op.operationId,
			record(other.key, other.op.operationId),
		)
		const page = await h.inventory.list({ limit: "200" })
		expect(page.items.find(i => i.key === copy.key)?.copyOf).toBeNull()
		expect(page.items.find(i => i.key === root.key)?.copyOf?.key).toBe(
			other.key,
		)
		expect(page.counts?.copiesTotal).toBe(1)
		expect(h.inventory.keysOfCopyRoot?.(root.key)).toEqual([])
		// A named root that is not listed at all.
		await h.evidence.writeCopy(
			other.op.operationId,
			record(`scan:${h.discoveryId}~analog-${randomUUID()}.wav`, randomUUID()),
		)
		const later = await h.inventory.list({ limit: "200" })
		expect(later.items.find(i => i.key === other.key)?.copyOf).toBeNull()
	})

	it("a root that becomes a copy counts its listed copies as changed too (their copyOf changes)", async () => {
		const h = await harness()
		const { root, copy, other } = await wired(h)
		const events: RecordingsChangedEventData[] = []
		const off = h.inventory.onChange?.(e => events.push(e))
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		await h.inventory.list({ limit: "200" })
		await vi.waitFor(
			() => expect(events.reduce((n, e) => n + e.changed, 0)).toBe(1),
			{ timeout: 3_000 },
		)
		const before = events.length
		// The root becomes a copy: the root and the one copy naming it read differently.
		await h.evidence.writeCopy(
			root.op.operationId,
			record(other.key, other.op.operationId),
		)
		await h.inventory.list({ limit: "200" })
		await vi.waitFor(
			() =>
				expect(events.slice(before).reduce((n, e) => n + e.changed, 0)).toBe(2),
			{ timeout: 3_000 },
		)
		off?.()
	})

	it("removing the sidecar shows the file again", async () => {
		const h = await harness()
		const { root, copy } = await wired(h)
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		expect(
			(await h.inventory.list({ limit: "200" })).items.find(
				i => i.key === copy.key,
			)?.copyOf,
		).not.toBeNull()
		await h.evidence.writeCopy(copy.op.operationId, null)
		expect(
			(await h.inventory.list({ limit: "200" })).items.find(
				i => i.key === copy.key,
			)?.copyOf,
		).toBeNull()
	})
})

describe("copy mark: bounds and strict parsing", () => {
	const own = randomUUID()
	const longKey = `scan:d_${"a".repeat(62)}~analog-${randomUUID()}.wav`

	it(`the largest valid mark fits COPY_FACTS_MAX_BYTES (${COPY_FACTS_MAX_BYTES})`, () => {
		const bytes = copyFactsBytes(
			own,
			{
				of: { key: longKey, operationId: randomUUID() },
				score: {
					r: -0.123456789,
					z: -999.123456789,
					neff: 9_999.123456,
					lagFrames: -16,
				},
				evidence: ["intermod", "off-raster"],
			},
			Date.UTC(2026, 11, 31, 23, 59, 59, 999),
		)
		expect(bytes).not.toBeNull()
		expect(bytes!.length).toBeLessThanOrEqual(COPY_FACTS_MAX_BYTES)
	})

	it("refuses a key past its bound, an unknown evidence code, a copy of itself, a lag past 16", () => {
		const ok = record(longKey, randomUUID())
		expect(copyFactsBytes(own, ok, NOW)).not.toBeNull()
		expect(
			copyFactsBytes(own, { ...ok, of: { ...ok.of, key: `${longKey}x` } }, NOW),
		).toBeNull()
		expect(copyFactsBytes(own, { ...ok, evidence: ["weaker"] }, NOW)).toBeNull()
		expect(copyFactsBytes(own, { ...ok, evidence: [] }, NOW)).toBeNull()
		expect(
			copyFactsBytes(own, { ...ok, of: { ...ok.of, operationId: own } }, NOW),
		).toBeNull()
		expect(
			copyFactsBytes(
				own,
				{ ...ok, score: { ...ok.score, lagFrames: 17 } },
				NOW,
			),
		).toBeNull()
		expect(
			copyFactsBytes(
				own,
				{ ...ok, score: { ...ok.score, lagFrames: 16 } },
				NOW,
			),
		).not.toBeNull()
	})

	it("reads unknown members, malformed JSON shapes and another operation's mark as no copy", () => {
		const bytes = copyFactsBytes(own, record(longKey, randomUUID()), NOW)!
		const json = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>
		expect(copyFactsOf(json, own)).not.toBeNull()
		expect(copyFactsOf({ ...json, extra: 1 }, own)).toBeNull()
		expect(copyFactsOf({ ...json, version: 2 }, own)).toBeNull()
		expect(copyFactsOf(json, randomUUID())).toBeNull()
		expect(copyFactsOf("{", own)).toBeNull()
		expect(copyFactsOf(null, own)).toBeNull()
	})
})
