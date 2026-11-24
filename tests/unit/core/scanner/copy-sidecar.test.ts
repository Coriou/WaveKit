/**
 * Copy sidecar of a kept scanner analog recording (copy-facts.ts, AnalogOperations.writeCopy):
 * written and removed under the store lock only for a settled, finalized, listed operation, read
 * by the catalogue as `copyOf` (re-read on the copy-changed notice although the WAV stat is
 * unchanged), filtered by `copies=false`, recovered as a known name, removed with the operation.
 * Synthetic ids and made-up frequencies only.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	lstat,
	mkdtemp,
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
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import {
	OPERATION_FOLDER_NAMES,
	type AnalogMetadataAdapter,
	type AnalogNotice,
	type AnalogOperationIo,
} from "../../../../src/core/scanner/store/analog-operations.js"
import {
	COPY_FACTS_FILE,
	COPY_FACTS_MAX_BYTES,
	COPY_FACTS_TEMP,
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
	const evidence = evidenceOf()
	await evidence.recoverAnalog()
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => join(root, "recordings"),
		logger,
	})
	closers.push(() => inventory.close?.())
	return {
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

const copyPath = (h: Harness, operationId: string): string =>
	join(h.root, ".analog-operations", operationId, COPY_FACTS_FILE)

const record = (key: string, operationId: string): CopyFactsInput => ({
	of: { key, operationId },
	score: { r: 0.931, z: 11.2, neff: 180, lagFrames: -1 },
	evidence: ["intermod", "off-raster"],
})

describe("copy sidecar: writeCopy under the store lock", () => {
	it("writes copy.json for a finalized, listed operation and notifies copy-changed", async () => {
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
		expect(
			existsSync(
				join(
					h.root,
					".analog-operations",
					copy.op.operationId,
					COPY_FACTS_TEMP,
				),
			),
		).toBe(false)
		expect(h.notices).toContainEqual({
			kind: "copy-changed",
			alias: copy.alias,
		})
		// Removing it: "removed", notified, gone.
		expect(await h.evidence.writeCopy(copy.op.operationId, null)).toBe(
			"removed",
		)
		expect(existsSync(copyPath(h, copy.op.operationId))).toBe(false)
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
		const h = await harness({
			unlink: path => unlink(path),
			checkpoint: async () => undefined,
			rename: async (from, to) => {
				renamed.push(to)
				if (failRename && to.endsWith(COPY_FACTS_FILE))
					throw Object.assign(new Error("injected"), { code: "EIO" })
				await rename(from, to)
			},
		})
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
		expect(renamed.filter(p => p.endsWith(COPY_FACTS_FILE))).toHaveLength(1)
		const dir = join(h.root, ".analog-operations", copy.op.operationId)
		expect(existsSync(join(dir, COPY_FACTS_FILE))).toBe(false)
		expect(existsSync(join(dir, COPY_FACTS_TEMP))).toBe(false)
		expect(h.notices.length).toBe(before)
		// The folder is as it was: the next write succeeds through the same seam.
		failRename = false
		expect(
			await h.evidence.writeCopy(
				copy.op.operationId,
				record(root.key, root.op.operationId),
			),
		).toBe("written")
		expect(existsSync(join(dir, COPY_FACTS_FILE))).toBe(true)
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

	it("a write racing a retention removal never leaves an orphaned sidecar (one lock)", async () => {
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
	})
})

describe("copy sidecar: a cleanup that gives up", () => {
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

describe("copy sidecar: removed with the operation, recovered as a known name", () => {
	it("retention removes copy.json and copy.tmp with the folder and notifies removed", async () => {
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		await writeFile(
			join(h.root, ".analog-operations", copy.op.operationId, COPY_FACTS_TEMP),
			"{",
		)
		const old = new Date(NOW - 31 * 86_400_000)
		await utimes(join(h.root, copy.receipt.artifact ?? ""), old, old)
		await h.evidence.retention(new Set())
		expect(
			existsSync(join(h.root, ".analog-operations", copy.op.operationId)),
		).toBe(false)
		expect(h.notices).toContainEqual({
			kind: "removed",
			operationId: copy.op.operationId,
		})
	})

	it(`a folder holding every allowed name (${OPERATION_FOLDER_NAMES.length}, copy.tmp included) recovers; one more name fails closed`, async () => {
		expect(OPERATION_FOLDER_NAMES).toContain(COPY_FACTS_FILE)
		expect(OPERATION_FOLDER_NAMES).toContain(COPY_FACTS_TEMP)
		const h = await harness()
		const root = await keptOp(h)
		const copy = await keptOp(h, "o2")
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		const dir = join(h.root, ".analog-operations", copy.op.operationId)
		for (const name of [
			"intent.tmp",
			"receipt.tmp",
			"facts.tmp",
			COPY_FACTS_TEMP,
		])
			await writeFile(join(dir, name), "{")
		await writeFile(join(dir, "payload.wav.part"), "")
		await h.evidence.stopAnalog()
		const next = h.evidenceOf()
		const statuses = (await next.recoverAnalog()).map(r => r.status)
		expect(statuses).toEqual(["available", "available"])
		expect(next.analogQuarantine()).toEqual([])
		await next.stopAnalog()
		// One name past the list: the folder's listing overflows its bound (fail closed).
		await writeFile(join(dir, "extra.json"), "{}")
		const third = h.evidenceOf()
		const after = await third.recoverAnalog()
		expect(after.map(r => r.status)).not.toEqual(["available", "available"])
		await third.stopAnalog()
	})
})

describe("copy sidecar: the catalogue's copyOf, copies filter and re-read", () => {
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

	it("re-reads only copy.json on the notice although the WAV stat is unchanged; a plain listing never would", async () => {
		const h = await harness()
		const { root, copy } = await wired(h)
		const wav = join(h.root, copy.receipt.artifact ?? "")
		const before = await lstat(wav)
		// Written behind the store's back: no notice, the WAV stat is unchanged, nothing re-reads.
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
		// Through the store: the notice re-reads the sidecar.
		await h.evidence.writeCopy(
			copy.op.operationId,
			record(root.key, root.op.operationId),
		)
		const page = await h.inventory.list({ limit: "200" })
		expect(page.items.find(i => i.key === copy.key)?.copyOf).toEqual({
			key: root.key,
			evidence: ["intermod", "off-raster"],
		})
		const after = await lstat(wav)
		expect(after.mtimeMs).toBe(before.mtimeMs)
		expect(after.size).toBe(before.size)
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

describe("copy sidecar: bounds and strict parsing", () => {
	const own = randomUUID()
	const longKey = `scan:d_${"a".repeat(62)}~analog-${randomUUID()}.wav`

	it(`the largest valid sidecar fits COPY_FACTS_MAX_BYTES (${COPY_FACTS_MAX_BYTES})`, () => {
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

	it("reads unknown members, malformed JSON shapes and another operation's sidecar as no copy", () => {
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
