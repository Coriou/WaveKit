/**
 * Facts sidecar of a kept scanner analog recording (recording-facts.ts): written beside the
 * operation's receipt at the keep, read by the catalogue as an optional item field, removed with
 * the file by every removal path, never listed or counted as a recording, and never a reason the
 * WAV stops being served. Synthetic ids and numbers only.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	lstat,
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
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import {
	NOISE_QUARANTINE_DIR,
	type NoiseQuarantineFacts,
} from "../../../../src/core/scanner/store/noise-quarantine.js"
import {
	RECORDING_FACTS_FILE,
	RECORDING_FACTS_MAX_BYTES,
	RecordingFactsSchema,
	recordingFactsBytes,
	recordingFactsOf,
	type RecordingFactsInput,
} from "../../../../src/core/scanner/store/recording-facts.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)
const HZ = 433_500_000
const dirs: string[] = []
const closers: (() => void)[] = []
const admission: NoiseQuarantineFacts = {
	frequencyHz: HZ,
	reason: "prior-none",
	strength: "none",
	branch: "noise",
	levelFrames: 320,
	spreadDb: 18.25,
	p10Dbfs: -41.5,
	periodicShare: 0.125,
	burstFrames: 9,
	loudPitchShare: 0.25,
	topSpreadDb: 6.5,
	loudLevelDbfs: null,
}

afterEach(async () => {
	for (const close of closers.splice(0)) close()
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

async function harness() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "wk-facts-")))
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
		targetHz: HZ + 0.4,
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
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
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
		})
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
	// The inventory reads real mtimes: its own clock stays real.
	closers.push(() => inventory.close?.())
	return { root, store, discoveryId, binding, evidence, evidenceOf, inventory }
}

type Harness = Awaited<ReturnType<typeof harness>>

async function keptOp(h: Harness, withAdmission = true) {
	const op = h.evidence.beginAnalog({
		discoveryId: h.discoveryId,
		observationId: "o1",
		binding: h.binding,
	})
	await op.ready
	await op.push(new Int16Array(8000).fill(900))
	const receipt = await op.finish("completed", {
		keptBy: "prior-none",
		speechHeard: true,
		startedAt: new Date(NOW - 5_000).toISOString(),
		...(withAdmission ? { admission } : {}),
	})
	expect(receipt.outcome).toBe("finalized")
	// Settled for the catalogue (it skips files still being written).
	const settled = new Date(Date.now() - 10 * 60_000)
	await utimes(join(h.root, receipt.artifact ?? ""), settled, settled)
	return { op, receipt }
}

const factsPath = (h: Harness, operationId: string): string =>
	join(h.root, ".analog-operations", operationId, RECORDING_FACTS_FILE)

async function filesUnder(dir: string): Promise<string[]> {
	if (!existsSync(dir)) return []
	const out: string[] = []
	for (const name of await readdir(dir, { recursive: true }))
		if ((await lstat(join(dir, name))).isFile()) out.push(name)
	return out.sort()
}

describe("kept analog file: facts sidecar round-trip", () => {
	it("writes the facts beside the receipt and the catalogue item carries them", async () => {
		const h = await harness()
		const { op, receipt } = await keptOp(h)
		const stored = RecordingFactsSchema.parse(
			JSON.parse(await readFile(factsPath(h, op.operationId), "utf8")),
		)
		expect(stored).toMatchObject({
			version: 1,
			operationId: op.operationId,
			discoveryId: h.discoveryId,
			observationId: "o1",
			frequencyHz: HZ,
			startedAt: new Date(NOW - 5_000).toISOString(),
			endedAt: new Date(NOW - 5_000 + 1_000).toISOString(),
			durationMs: 1_000,
			finish: {
				cut: "completed",
				keptBy: "prior-none",
				speechHeard: true,
				cutActive: null,
			},
			admission,
		})
		// No temp file left; nothing but the WAV under recordings/.
		expect(
			await readdir(join(h.root, ".analog-operations", op.operationId)),
		).not.toContain("facts.tmp")
		expect(await filesUnder(join(h.root, "recordings"))).toEqual([
			join("analog", h.discoveryId, `analog-${op.operationId}.wav`),
		])
		const page = await h.inventory.list({ limit: "200" })
		expect(page.items).toHaveLength(1)
		expect(page.counts?.total).toBe(1)
		expect(page.items[0]?.facts).toEqual(stored)
		expect(receipt.artifact).not.toBeNull()
	})

	it("a recovery after restart takes the operation folder with its sidecar as known (no quarantine)", async () => {
		const h = await harness()
		await keptOp(h)
		await h.evidence.stopAnalog()
		const next = h.evidenceOf()
		expect((await next.recoverAnalog()).map(r => r.status)).toEqual([
			"available",
		])
		expect(next.analogQuarantine()).toEqual([])
		await next.stopAnalog()
	})

	it("admission numbers absent: the sidecar is still written, admission null", async () => {
		const h = await harness()
		const { op } = await keptOp(h, false)
		const stored = RecordingFactsSchema.parse(
			JSON.parse(await readFile(factsPath(h, op.operationId), "utf8")),
		)
		expect(stored.admission).toBeNull()
	})
})

describe("missing or malformed sidecar never breaks serving the WAV", () => {
	it.each([
		["missing", null],
		["not JSON", "{"],
		["wrong schema", JSON.stringify({ version: 2 })],
		["oversized", " ".repeat(RECORDING_FACTS_MAX_BYTES + 1)],
	])(
		"%s: item.facts is null, the file is listed and resolvable",
		async (_, body) => {
			const h = await harness()
			const { op } = await keptOp(h)
			if (body === null) await rm(factsPath(h, op.operationId))
			else await writeFile(factsPath(h, op.operationId), body)
			const page = await h.inventory.list({ limit: "200" })
			expect(page.items).toHaveLength(1)
			expect(page.items[0]?.facts).toBeNull()
			expect(page.items[0]?.keptBy).toBe("prior-none")
			const alias = `${h.discoveryId}~analog-${op.operationId}.wav`
			expect(h.evidence.recordingPath(alias)).not.toBeNull()
		},
	)

	it("a sidecar written after the catalogue indexed the file is read on a later pass", async () => {
		const h = await harness()
		const { op, receipt } = await keptOp(h)
		// Young enough that a missing receipt member may still follow (RECORDINGS_RECEIPT_WAIT_MS).
		const young = new Date(Date.now() - 60_000)
		await utimes(join(h.root, receipt.artifact ?? ""), young, young)
		const body = await readFile(factsPath(h, op.operationId), "utf8")
		await rm(factsPath(h, op.operationId))
		expect(
			(await h.inventory.list({ limit: "200" })).items[0]?.facts,
		).toBeNull()
		await writeFile(factsPath(h, op.operationId), body)
		h.inventory.invalidate?.()
		const later = await h.inventory.list({ limit: "200" })
		expect(later.items[0]?.facts?.operationId).toBe(op.operationId)
	})

	it("a sidecar of another operation reads as no facts", async () => {
		const h = await harness()
		const { op } = await keptOp(h)
		const stored: unknown = JSON.parse(
			await readFile(factsPath(h, op.operationId), "utf8"),
		)
		expect(recordingFactsOf(stored, op.operationId)).not.toBeNull()
		expect(recordingFactsOf(stored, randomUUID())).toBeNull()
	})
})

describe("file and sidecar are one unit", () => {
	it("retention past maxAgeDays removes the WAV and its sidecar", async () => {
		const h = await harness()
		const { op, receipt } = await keptOp(h)
		const wav = join(h.root, receipt.artifact ?? "")
		const old = new Date(NOW - 31 * 86_400_000)
		await utimes(wav, old, old)
		await h.evidence.retention(new Set())
		expect(existsSync(wav)).toBe(false)
		expect(existsSync(factsPath(h, op.operationId))).toBe(false)
		expect(existsSync(join(h.root, ".analog-operations", op.operationId))).toBe(
			false,
		)
	})

	it("discovery removal removes the WAV and its sidecar", async () => {
		const h = await harness()
		const { op, receipt } = await keptOp(h)
		await h.evidence.removeDiscovery(h.discoveryId)
		expect(existsSync(join(h.root, receipt.artifact ?? ""))).toBe(false)
		expect(existsSync(factsPath(h, op.operationId))).toBe(false)
	})

	it("a noise cancel moves the audio to the quarantine with its own sidecar and writes no facts", async () => {
		const h = await harness()
		const op = h.evidence.beginAnalog({
			discoveryId: h.discoveryId,
			observationId: "o1",
			binding: h.binding,
		})
		await op.ready
		await op.push(new Int16Array(8000).fill(900))
		op.cancel("cancelled", admission)
		expect((await op.settled).outcome).toBe("aborted")
		const quarantined = await filesUnder(join(h.root, NOISE_QUARANTINE_DIR))
		expect(quarantined.map(f => f.split(/[\\/]/).at(-1)).sort()).toEqual([
			`${op.operationId}.json`,
			`${op.operationId}.wav`,
		])
		expect(existsSync(factsPath(h, op.operationId))).toBe(false)
		expect(await filesUnder(join(h.root, "recordings"))).toEqual([])
	})
})

describe("recordingFactsBytes bounds", () => {
	const base: RecordingFactsInput = {
		operationId: randomUUID(),
		discoveryId: `d_${"A".repeat(126)}`,
		observationId: "o".repeat(128),
		targetHz: 1.7976931348623157e15,
		startedAt: new Date(NOW).toISOString(),
		durationMs: 120_000.12345678901,
		keptAt: NOW,
		cut: "c".repeat(32),
		keptBy: "k".repeat(32),
		speechHeard: false,
		cutActive: true,
		admission: {
			frequencyHz: 1.2345678901234567e15,
			reason: "r".repeat(64),
			strength: "s".repeat(64),
			branch: "data-buzz",
			levelFrames: -1.2345678901234567e-15,
			spreadDb: -1.2345678901234567e-15,
			p10Dbfs: -1.2345678901234567e-15,
			periodicShare: -1.2345678901234567e-15,
			burstFrames: -1.2345678901234567e-15,
			loudPitchShare: -1.2345678901234567e-15,
			topSpreadDb: -1.2345678901234567e-15,
			loudLevelDbfs: -1.2345678901234567e-15,
		},
	}

	it("the largest valid sidecar fits the bound", () => {
		const bytes = recordingFactsBytes(base)
		expect(bytes).not.toBeNull()
		expect(bytes!.length).toBeLessThanOrEqual(RECORDING_FACTS_MAX_BYTES)
	})

	it("a malformed admission block is dropped, not the sidecar", () => {
		const bytes = recordingFactsBytes({
			...base,
			admission: { ...admission, reason: "<script>" },
		})
		expect(JSON.parse(bytes!.toString()).admission).toBeNull()
	})

	it("ids or codes past their bounds refuse the sidecar", () => {
		expect(
			recordingFactsBytes({ ...base, observationId: "o".repeat(129) }),
		).toBeNull()
		expect(recordingFactsBytes({ ...base, keptBy: "k".repeat(33) })).toBeNull()
		expect(recordingFactsBytes({ ...base, operationId: "x" })).toBeNull()
	})

	it("an unparseable start leaves start and end unknown", () => {
		const parsed = JSON.parse(
			recordingFactsBytes({ ...base, startedAt: "nope" })!.toString(),
		) as { startedAt: unknown; endedAt: unknown }
		expect(parsed.startedAt).toBeNull()
		expect(parsed.endedAt).toBeNull()
	})
})
