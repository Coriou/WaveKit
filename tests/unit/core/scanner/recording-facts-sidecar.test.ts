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
import { CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import { DcsDecoder } from "../../../../src/core/audio-tones/dcs.js"
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
	DCS_MEASURED_MIN_SAMPLES,
	DCS_PARTIAL_WORDS,
	TONE_MEASURED_MIN_BLOCKS,
	factsFitFolder,
	recordingFactsBytes,
	recordingFactsOf,
	toneFactOf,
	withinFactsBound,
	type RecordingFactsInput,
} from "../../../../src/core/scanner/store/recording-facts.js"
import {
	MAX_OPERATION_METADATA_BYTES,
	type RecordingBinding,
} from "../../../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { gaussian, mulberry32 } from "../audio-tones/synth.js"
import { dcsDeviation, voicePitchDeviation } from "./wideband-nfm-fixtures.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import type { AnalogHandle } from "../../../../src/core/scanner/store/analog-operations.js"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness as recorderHarness,
	input as trackInput,
	snapshot,
} from "./wideband-recorder-harness.js"

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
		// The longest bounded hz as JSON (18 characters).
		tone: { kind: "ctcss", hz: 254.09999999999997 },
	}

	it("the largest valid sidecar fits the bound", () => {
		const bytes = recordingFactsBytes(base)
		expect(bytes).not.toBeNull()
		expect(bytes!.length).toBeLessThanOrEqual(RECORDING_FACTS_MAX_BYTES)
	})

	// The longest tone member: a DCS code with the longer polarity (57 B, past the CTCSS 48 B).
	it("the largest valid sidecar with the longest DCS tone fits the bound", () => {
		const tone = { kind: "dcs", code: "754", polarity: "inverted" }
		const bytes = recordingFactsBytes({ ...base, tone })
		expect(bytes).not.toBeNull()
		expect(bytes!.length).toBeLessThanOrEqual(RECORDING_FACTS_MAX_BYTES)
		expect(JSON.parse(bytes!.toString()).tone).toEqual(tone)
		const ctcss = recordingFactsBytes(base)!
		expect(bytes!.length - ctcss.length).toBe(57 - 48)
	})

	it("a malformed admission block is dropped, not the sidecar", () => {
		const bytes = recordingFactsBytes({
			...base,
			admission: { ...admission, reason: "<script>" },
		})
		expect(JSON.parse(bytes!.toString()).admission).toBeNull()
	})

	it("a tone round-trips: CTCSS, DCS, null; no tone given leaves the member out", () => {
		const read = (tone: unknown) => {
			const json = JSON.parse(
				recordingFactsBytes({ ...base, tone })!.toString(),
			) as unknown
			return recordingFactsOf(json, base.operationId)
		}
		expect(read({ kind: "ctcss", hz: 88.5 })?.tone).toEqual({
			kind: "ctcss",
			hz: 88.5,
		})
		expect(read({ kind: "dcs", code: "023" })?.tone).toEqual({
			kind: "dcs",
			code: "023",
		})
		for (const polarity of ["normal", "inverted"])
			expect(read({ kind: "dcs", code: "023", polarity })?.tone).toEqual({
				kind: "dcs",
				code: "023",
				polarity,
			})
		expect(read(null)?.tone).toBeNull()
		const { tone: _omitted, ...noTone } = base
		void _omitted
		const json = JSON.parse(recordingFactsBytes(noTone)!.toString()) as object
		expect("tone" in json).toBe(false)
		expect(recordingFactsOf(json, base.operationId)).not.toBeNull()
	})

	it.each([
		["below the CTCSS table", { kind: "ctcss", hz: 66.99 }],
		["above the CTCSS table", { kind: "ctcss", hz: 254.11 }],
		["not finite", { kind: "ctcss", hz: Number.NaN }],
		["a DCS code with an 8", { kind: "dcs", code: "028" }],
		["a DCS code of four digits", { kind: "dcs", code: "0234" }],
		["an unknown DCS polarity", { kind: "dcs", code: "023", polarity: "up" }],
		["an unknown kind", { kind: "dtmf", code: "1" }],
		["an extra member", { kind: "ctcss", hz: 88.5, extra: 1 }],
		["not an object", "88.5"],
	])("a malformed tone (%s) is dropped, not the sidecar", (_name, tone) => {
		const json = JSON.parse(
			recordingFactsBytes({ ...base, tone })!.toString(),
		) as object
		expect("tone" in json).toBe(false)
		expect(recordingFactsOf(json, base.operationId)).not.toBeNull()
	})

	it("the table's edge tones are within the bound (67.0 and 254.1 Hz)", () => {
		for (const hz of [67, 254.1]) {
			const json = JSON.parse(
				recordingFactsBytes({
					...base,
					tone: { kind: "ctcss", hz },
				})!.toString(),
			) as { tone?: unknown }
			expect(json.tone).toEqual({ kind: "ctcss", hz })
		}
	})

	it("a sidecar read with a malformed tone reads as no facts (fail closed)", () => {
		const json = JSON.parse(recordingFactsBytes(base)!.toString()) as Record<
			string,
			unknown
		>
		expect(recordingFactsOf(json, base.operationId)).not.toBeNull()
		expect(
			recordingFactsOf(
				{ ...json, tone: { kind: "ctcss", hz: 300 } },
				base.operationId,
			),
		).toBeNull()
	})

	describe("toneFactOf decision table", () => {
		/** Coverage that reads null: both detectors analysed exactly their minimum, heard nothing. */
		const quiet = {
			ctcssBlocks: TONE_MEASURED_MIN_BLOCKS,
			votedBlocks: 0,
			partialBlocks: 0,
			dcsSamples: DCS_MEASURED_MIN_SAMPLES,
			dcsChain: 0,
			dcs: null,
			ownTone: false,
		}
		const code = { code: "023", polarity: "normal" }

		it("the minimums' arithmetic: 3 blocks (1 s of CTCSS), 6 000 samples (0.75 s of DCS), 2 words", () => {
			expect(TONE_MEASURED_MIN_BLOCKS).toBe(3)
			// 4 000 + 2 × 2 000 samples at 8 kHz: the bank's third block.
			const bank = new CtcssBank()
			for (let i = 0; i < 7_999; i++) bank.pushSample(0)
			expect(bank.blockCount()).toBe(2)
			bank.pushSample(0)
			expect(bank.blockCount()).toBe(TONE_MEASURED_MIN_BLOCKS)
			expect(DCS_MEASURED_MIN_SAMPLES).toBe(6_000)
			expect(DCS_PARTIAL_WORDS).toBe(2)
		})

		it("a settled CTCSS tone always wins, a DCS code too", () => {
			const both = { ...quiet, dcs: code }
			expect(toneFactOf(88.5, both)).toEqual({
				tone: { kind: "ctcss", hz: 88.5 },
			})
			expect(toneFactOf(88.5, null)).toEqual({
				tone: { kind: "ctcss", hz: 88.5 },
			})
			expect(toneFactOf(88.5, { ...quiet, ctcssBlocks: 0 })).toEqual({
				tone: { kind: "ctcss", hz: 88.5 },
			})
		})

		it("a confirmed DCS code beats a CTCSS that did not settle, at its sample minimum and not below", () => {
			const dcs = { tone: { kind: "dcs", code: "023", polarity: "normal" } }
			expect(toneFactOf(null, { ...quiet, dcs: code, votedBlocks: 4 })).toEqual(
				dcs,
			)
			expect(toneFactOf(null, { ...quiet, dcs: code, ownTone: true })).toEqual(
				dcs,
			)
			expect(toneFactOf(null, { ...quiet, dcs: code, ctcssBlocks: 0 })).toEqual(
				dcs,
			)
			expect(
				toneFactOf(null, {
					...quiet,
					dcs: code,
					dcsSamples: DCS_MEASURED_MIN_SAMPLES - 1,
				}),
			).toEqual({})
			expect(
				toneFactOf(null, {
					...quiet,
					dcs: { code: "047", polarity: "inverted" },
				}),
			).toEqual({ tone: { kind: "dcs", code: "047", polarity: "inverted" } })
		})

		it.each([
			["a code outside the standard set", { code: "024", polarity: "normal" }],
			["a malformed code", { code: "02x", polarity: "normal" }],
			["a malformed polarity", { code: "023", polarity: "up" }],
			["not an object", "023"],
		])("a DCS reading that fails the live gate (%s) is no code", (_n, dcs) => {
			expect(toneFactOf(null, { ...quiet, dcs })).toEqual({ tone: null })
		})

		it("null exactly at both minimums; absent one past either", () => {
			expect(toneFactOf(null, quiet)).toEqual({ tone: null })
			expect(toneFactOf(null, { ...quiet, ctcssBlocks: 40 })).toEqual({
				tone: null,
			})
			expect(
				toneFactOf(null, {
					...quiet,
					ctcssBlocks: TONE_MEASURED_MIN_BLOCKS - 1,
				}),
			).toEqual({})
			expect(
				toneFactOf(null, {
					...quiet,
					dcsSamples: DCS_MEASURED_MIN_SAMPLES - 1,
				}),
			).toEqual({})
		})

		it("tone-like evidence that did not settle is absent, never null", () => {
			expect(toneFactOf(null, { ...quiet, votedBlocks: 1 })).toEqual({})
			expect(toneFactOf(null, { ...quiet, partialBlocks: 1 })).toEqual({})
			expect(
				toneFactOf(null, { ...quiet, dcsChain: DCS_PARTIAL_WORDS }),
			).toEqual({})
			// A lone DCS word is no evidence (random registers hit about once per 13 s).
			expect(
				toneFactOf(null, { ...quiet, dcsChain: DCS_PARTIAL_WORDS - 1 }),
			).toEqual({ tone: null })
		})

		it("a file kept for its own tone is never null", () => {
			expect(toneFactOf(null, { ...quiet, ownTone: true })).toEqual({})
		})

		it("no coverage, or counts that are not finite numbers, are absent", () => {
			expect(toneFactOf(null, null)).toEqual({})
			for (const n of [Number.NaN, Number.POSITIVE_INFINITY]) {
				expect(toneFactOf(null, { ...quiet, ctcssBlocks: n })).toEqual({})
				expect(toneFactOf(null, { ...quiet, dcsSamples: n })).toEqual({})
				expect(toneFactOf(null, { ...quiet, votedBlocks: n })).toEqual({})
				expect(toneFactOf(null, { ...quiet, partialBlocks: n })).toEqual({})
				expect(toneFactOf(null, { ...quiet, dcsChain: n })).toEqual({})
			}
		})
	})

	/** A detector pair's counters as the recorder freezes them (finishFile). */
	const coverageOf = (bank: CtcssBank, dcs: DcsDecoder, ownTone = false) => ({
		ctcssBlocks: bank.blockCount(),
		votedBlocks: bank.votedBlockCount(),
		partialBlocks: bank.partialBlockCount(),
		dcsSamples: dcs.sampleCount(),
		dcsChain: dcs.longestChain(),
		dcs: dcs.result(),
		ownTone,
	})
	/** A DCS decoder fed `n` silent samples (analysed, no code). */
	const dcsOf = (n: number) => {
		const dcs = new DcsDecoder()
		for (let i = 0; i < n; i++) dcs.pushSample(0)
		return dcs
	}

	// Two 1.5 s toned overs with 1.9 s of hang noise between them, straight into a real bank: the
	// tone wins its blocks but under 60% of all of them, so the bank settles on none. Blocks
	// voted, so the fact is not determined (no member), never a "no tone".
	it("a bank whose tone was diluted under its 60% share gives no member, never null", () => {
		const bank = new CtcssBank()
		const rand = mulberry32(7)
		const tone = (n: number) => {
			for (let i = 0; i < n; i++)
				bank.pushSample(0.2 * Math.sin((2 * Math.PI * 88.5 * i) / 8000))
		}
		tone(12_000)
		for (let i = 0; i < 15_200; i++) bank.pushSample(0.3 * gaussian(rand))
		tone(12_000)
		expect(bank.result()).toBeNull()
		expect(bank.sampleCount()).toBe(39_200)
		expect(bank.votedBlockCount()).toBeGreaterThan(0)
		expect(toneFactOf(bank.result(), coverageOf(bank, dcsOf(39_200)))).toEqual(
			{},
		)
		// The same bank's noise alone, as long (modelled white noise): it fills the sub-audible band
		// but no tone wins or leans on a block and no DCS word chains: a measured "no tone".
		const noisy = new CtcssBank()
		const noisyDcs = new DcsDecoder()
		for (let i = 0; i < 39_200; i++) {
			const x = 0.3 * gaussian(rand)
			noisy.pushSample(x)
			noisyDcs.pushSample(x)
		}
		expect(noisy.votedBlockCount()).toBe(0)
		expect(noisy.subAudibleBlockCount()).toBeGreaterThan(0)
		expect(toneFactOf(noisy.result(), coverageOf(noisy, noisyDcs))).toEqual({
			tone: null,
		})
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

describe("kept analog file: the recorder's own finish writes its admission numbers", () => {
	// The real WidebandAnalogRecorder over a modelled syllabic voice (no digital evidence: kept by
	// its finish path, as wideband-analog-recorder-admission.test.ts): its finish facts go to a real
	// EvidenceStore operation, whose sidecar must carry the admission numbers it measured.
	/** One keyed over of a scene: its seconds on the air, its tone, the carrier-off gap after it. */
	interface Over {
		seconds: number
		ctcssHz: number | null
		gapAfter: number
		/** The over's CTCSS at t s into it (overrides ctcssHz each 25 ms chunk). */
		ctcssAt?: (t: number) => number | null
		/** Extra deviation in Hz at absolute source time t s (NfmSource.setSubAudible). */
		subAudible?: (t: number) => number
	}

	// Kept files of a scene through the real recorder and store. Each over is its own observation
	// (closed 600 ms into the gap after it, so a gap under the 2 s hang joins the next over into
	// the same file); the source's tone follows each over.
	async function recorderScene(overs: readonly Over[]) {
		const h = await harness()
		const given: unknown[] = []
		const real: ReturnType<EvidenceStore["beginAnalog"]>[] = []
		const analogFm: VoicePrior = {
			labels: [],
			class: "analog-fm",
			analogVoice: () => false,
		}
		const r = recorderHarness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { ctcssHz: overs[0]?.ctcssHz ?? null, syllables: true },
			decodedLabel: () => null,
			voicePrior: () => analogFm,
			beginWrap: begin => recorderInput => {
				const fake = begin(recorderInput)
				const op = h.evidence.beginAnalog({
					discoveryId: h.discoveryId,
					observationId: "o1",
					binding: h.binding,
				})
				real.push(op)
				const fakeFinish = fake.finish.bind(fake)
				const finish: AnalogHandle["finish"] = async (cut, facts) => {
					given.push(facts)
					await op.ready
					await op.push(new Int16Array(8000).fill(900))
					await op.finish(cut, facts)
					return fakeFinish(cut, facts)
				}
				return Object.assign(fake, { finish })
			},
		})
		await r.feed(1, false)
		const chunk = r.fs / 40
		for (const [n, over] of overs.entries()) {
			const id = `o${n}`
			r.src.setCtcss(over.ctcssHz)
			r.src.setSubAudible(over.subAudible ?? null)
			const onset = r.engine.liveEdge()
			const end = onset + over.seconds * r.fs
			for (let i = 0; i < Math.round(over.seconds * 40); i++) {
				if (over.ctcssAt !== undefined) r.src.setCtcss(over.ctcssAt(i / 40))
				r.engine.write(r.src.next(chunk, true))
				const edge = r.engine.liveEdge()
				if (edge - onset >= 0.1 * r.fs)
					r.rec.track(
						trackInput(id, snapshot(id, onset, Math.min(edge, end), LOW)),
					)
				await r.pump()
			}
			const closeAfter = Math.min(0.6, over.gapAfter)
			r.src.setSubAudible(null)
			await r.feed(closeAfter, false)
			r.rec.closed(id, snapshot(id, onset, end, LOW), null, {
				analogFm: true,
				discoveryId: "d_1",
			})
			await r.feed(over.gapAfter - closeAfter, false)
		}
		await r.rec.idle()
		await r.fire()
		await r.rec.idle()
		const stored = []
		for (const op of real) {
			const path = factsPath(h, op.operationId)
			if (!existsSync(path)) continue
			stored.push(
				RecordingFactsSchema.parse(JSON.parse(await readFile(path, "utf8"))),
			)
		}
		return {
			outcomes: r.ops.map(o => o.outcome),
			facts: given as { admission?: NoiseQuarantineFacts; tone?: unknown }[],
			stored,
		}
	}

	// One kept file through the real recorder and store; `ctcssHz` is the modelled source's tone.
	async function recorderKeep(ctcssHz: number | null) {
		const scene = await recorderScene([{ seconds: 6, ctcssHz, gapAfter: 4.1 }])
		expect(scene.outcomes).toEqual(["finalized"])
		expect(scene.facts).toHaveLength(1)
		expect(scene.stored).toHaveLength(1)
		return { facts: scene.facts[0]!, stored: scene.stored[0]! }
	}

	it("a kept voice's sidecar carries the finish path's admission numbers", async () => {
		const { facts, stored } = await recorderKeep(null)
		// The recorder gave measured numbers, and the real store wrote them beside the receipt.
		expect(facts.admission).toMatchObject({
			strength: "none",
			frequencyHz: expect.any(Number) as number,
			p10Dbfs: expect.any(Number) as number,
			spreadDb: expect.any(Number) as number,
		})
		expect(stored.admission).toEqual(facts.admission)
	}, 120_000)

	// Modelled voice over each edge and a middle CTCSS tone of the table.
	it.each([67, 88.5, 254.1])(
		"voice over a %s Hz CTCSS tone: the sidecar carries the tone the recorder heard",
		async hz => {
			const { facts, stored } = await recorderKeep(hz)
			expect(facts.tone).toEqual({ kind: "ctcss", hz })
			expect(stored.tone).toEqual({ kind: "ctcss", hz })
		},
		120_000,
	)

	// The modelled voice's bursts (400 Hz up) leave little in the 300 Hz tone audio; with the
	// discriminator's noise under it nothing tone-like is heard over 6 s: "No tone heard".
	it("untoned voice: both detectors analysed it and heard no tone: null", async () => {
		const { facts, stored } = await recorderKeep(null)
		expect(facts.tone).toBeNull()
		expect(stored.tone).toBeNull()
	}, 120_000)

	// Modelled voice pitch in the sub-audible band (110-170 Hz glide plus its harmonic): it fills
	// the band, but no CTCSS tone wins or leans on a block and no DCS word chains: null.
	it("untoned voice with its pitch in the 85-300 Hz band: null", async () => {
		const scene = await recorderScene([
			{
				seconds: 6,
				ctcssHz: null,
				gapAfter: 4.1,
				subAudible: voicePitchDeviation(),
			},
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect(scene.facts[0]!.tone).toBeNull()
		expect(scene.stored[0]!.tone).toBeNull()
	}, 120_000)

	// Modelled DCS codes at 600 Hz deviation under the voice. An inverted 023 is the same bit
	// stream as 047 normal; the standard set reports it the way the live path does: 047 normal.
	it.each([
		["023", false, { code: "023", polarity: "normal" }],
		["023", true, { code: "047", polarity: "normal" }],
		["754", false, { code: "754", polarity: "normal" }],
	])(
		"a DCS %s (inverted %s) over: the sidecar carries the code the recorder heard",
		async (code, inverted, heard) => {
			const scene = await recorderScene([
				{
					seconds: 6,
					ctcssHz: null,
					gapAfter: 4.1,
					subAudible: dcsDeviation(code, inverted),
				},
			])
			expect(scene.outcomes).toEqual(["finalized"])
			expect(scene.facts[0]!.tone).toEqual({ kind: "dcs", ...heard })
			expect(scene.stored[0]!.tone).toEqual({ kind: "dcs", ...heard })
		},
		120_000,
	)

	// Random NRZ at 134.4 bps (modelled, no valid code word): no CTCSS tone wins or leans on a
	// block and no two consecutive DCS words match, so it reads as no tone. A DCS code too broken
	// to hold two consecutive words reads the same: the disclosed limit of "No tone heard".
	it("a DCS-like random NRZ over: no code word chains, null", async () => {
		const bits = mulberry32(19)
		const levels: number[] = []
		const nrz = (t: number): number => {
			const bit = Math.floor(t * 134.4)
			while (levels.length <= bit) levels.push(bits() < 0.5 ? -500 : 500)
			return levels[bit]!
		}
		const scene = await recorderScene([
			{ seconds: 6, ctcssHz: null, gapAfter: 4.1, subAudible: nrz },
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect(scene.facts[0]!.tone).toBeNull()
		expect(scene.stored[0]!.tone).toBeNull()
	}, 120_000)

	// A 600 ms over alone: its detectors analysed under 1 s (the CTCSS minimum): absent.
	it("a short over (600 ms): the tone is absent, never null", async () => {
		const scene = await recorderScene([
			{ seconds: 0.6, ctcssHz: null, gapAfter: 4.1 },
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect("tone" in scene.facts[0]!).toBe(false)
		expect("tone" in scene.stored[0]!).toBe(false)
	}, 120_000)

	// Two untoned overs joined across 1.9 s of carrier-off receiver noise (inside the session's
	// activity, so the detectors hear it): FM noise fills the band without any one tone or a
	// chained DCS word, so the file still reads no tone.
	it("two untoned overs joined across receiver noise: null", async () => {
		const scene = await recorderScene([
			{ seconds: 1.5, ctcssHz: null, gapAfter: 1.9 },
			{ seconds: 1.5, ctcssHz: null, gapAfter: 4.1 },
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect(scene.facts[0]!.tone).toBeNull()
		expect(scene.stored[0]!.tone).toBeNull()
	}, 120_000)

	// One 124 s over rolls over at WIDEBAND_MAX_FILE_MS (120 s). Its 88.5 Hz tone stops 118 s in
	// (with the 1 s pre-roll, about 1 s before the cut): the first part settles on it, the
	// roll-over part (about 5 s untoned) is judged on its own analysed audio only, never on the
	// tone its session heard before or on the tail carried into it: null.
	it("a roll-over part is judged on its own analysed audio", async () => {
		const scene = await recorderScene([
			{
				seconds: 124,
				ctcssHz: 88.5,
				gapAfter: 4.1,
				ctcssAt: t => (t < 118 ? 88.5 : null),
			},
		])
		expect(scene.outcomes).toEqual(["finalized", "finalized"])
		expect(scene.facts[0]!.tone).toEqual({ kind: "ctcss", hz: 88.5 })
		expect(scene.stored[0]!.tone).toEqual({ kind: "ctcss", hz: 88.5 })
		expect(scene.facts[1]!.tone).toBeNull()
		expect(scene.stored[1]!.tone).toBeNull()
	}, 300_000)

	// A 121.4 s over: the roll-over part holds about 1.7 s of activity, but about 1 s of it is the
	// tail produced past the cut before the first part finished, carried into the new part
	// without its tone twin: the part's detectors analysed about 0.73 s, under the 1 s CTCSS
	// minimum. The carried tail never counts toward the minimums: absent, never null.
	it("a short roll-over part: its carried-in tail does not count, the tone is absent", async () => {
		const scene = await recorderScene([
			{ seconds: 121.4, ctcssHz: null, gapAfter: 4.1 },
		])
		expect(scene.outcomes).toEqual(["finalized", "finalized"])
		expect(scene.facts[0]!.tone).toBeNull()
		expect("tone" in scene.facts[1]!).toBe(false)
		expect("tone" in scene.stored[1]!).toBe(false)
	}, 300_000)

	// Two DCS 023 overs joined across the noise: the code confirmed in the first over stays
	// confirmed (the noise breaks the chain but never undoes a confirmed code).
	it("two DCS 023 overs joined across receiver noise: the code", async () => {
		const scene = await recorderScene([
			{
				seconds: 1.5,
				ctcssHz: null,
				gapAfter: 1.9,
				subAudible: dcsDeviation("023"),
			},
			{
				seconds: 1.5,
				ctcssHz: null,
				gapAfter: 4.1,
				subAudible: dcsDeviation("023"),
			},
		])
		expect(scene.outcomes).toEqual(["finalized"])
		const dcs = { kind: "dcs", code: "023", polarity: "normal" }
		expect(scene.facts[0]!.tone).toEqual(dcs)
		expect(scene.stored[0]!.tone).toEqual(dcs)
	}, 120_000)

	// The tone keyed 300 ms on, 300 ms off for the whole over: too broken for a block to vote,
	// yet the band holds it: absent, never null.
	it("a voice over an 88.5 Hz tone broken up 300 ms on / 300 ms off: the tone is absent, never null", async () => {
		const scene = await recorderScene([
			{
				seconds: 6,
				ctcssHz: 88.5,
				gapAfter: 4.1,
				ctcssAt: t => (Math.floor(t / 0.3) % 2 === 0 ? 88.5 : null),
			},
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect("tone" in scene.facts[0]!).toBe(false)
		expect("tone" in scene.stored[0]!).toBe(false)
	}, 120_000)

	// The file's tone fact is the bank's own coverage frozen at its finish, never the session's
	// span: here the next over raises the session's activity 2.7 s after the first started, while
	// the first file's bank heard only its 600 ms (under the bank's minimum): no member, not null.
	it("a 600 ms toned over followed by the next over at 2.7 s: the first file's tone is absent, never null", async () => {
		const scene = await recorderScene([
			{ seconds: 0.6, ctcssHz: 88.5, gapAfter: 2.1 },
			{ seconds: 3, ctcssHz: 88.5, gapAfter: 4.1 },
		])
		expect(scene.outcomes).toEqual(["finalized", "finalized"])
		expect(scene.facts).toHaveLength(2)
		expect("tone" in scene.facts[0]!).toBe(false)
		expect("tone" in scene.stored[0]!).toBe(false)
		expect(scene.facts[1]!.tone).toEqual({ kind: "ctcss", hz: 88.5 })
		expect(scene.stored[1]!.tone).toEqual({ kind: "ctcss", hz: 88.5 })
	}, 120_000)

	it("two toned overs joined into one file across the hang: the tone, never null", async () => {
		const scene = await recorderScene([
			{ seconds: 1.5, ctcssHz: 88.5, gapAfter: 1.9 },
			{ seconds: 1.5, ctcssHz: 88.5, gapAfter: 4.1 },
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect(scene.facts[0]!.tone).toEqual({ kind: "ctcss", hz: 88.5 })
		expect(scene.stored[0]!.tone).toEqual({ kind: "ctcss", hz: 88.5 })
	}, 120_000)

	// A toned over joined to a longer untoned turnaround: the tone's blocks fall under the bank's
	// 60% share, so it settles on none, but blocks did vote for it: not determined, no member.
	it("a toned over joined to a longer untoned one: the tone is absent, never null", async () => {
		const scene = await recorderScene([
			{ seconds: 1.5, ctcssHz: 88.5, gapAfter: 1 },
			{ seconds: 4, ctcssHz: null, gapAfter: 4.1 },
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect(scene.facts).toHaveLength(1)
		expect("tone" in scene.facts[0]!).toBe(false)
		expect("tone" in scene.stored[0]!).toBe(false)
	}, 120_000)
})

describe("facts sidecar bounds, at and one past", () => {
	it("the writer keeps exactly RECORDING_FACTS_MAX_BYTES and refuses one byte more", () => {
		const at = Buffer.alloc(RECORDING_FACTS_MAX_BYTES)
		expect(withinFactsBound(at)).toBe(at)
		expect(
			withinFactsBound(Buffer.alloc(RECORDING_FACTS_MAX_BYTES + 1)),
		).toBeNull()
	})

	it("a sidecar joins its folder exactly at MAX_OPERATION_METADATA_BYTES, not one byte past", () => {
		const metadata = MAX_OPERATION_METADATA_BYTES - 1_000
		expect(factsFitFolder(metadata, 1_000)).toBe(true)
		expect(factsFitFolder(metadata, 1_001)).toBe(false)
		// The sidecar's own bound holds even in an empty folder.
		expect(factsFitFolder(0, RECORDING_FACTS_MAX_BYTES)).toBe(true)
		expect(factsFitFolder(0, RECORDING_FACTS_MAX_BYTES + 1)).toBe(false)
	})

	it.each([
		[RECORDING_FACTS_MAX_BYTES, true],
		[RECORDING_FACTS_MAX_BYTES + 1, false],
	])("the reader takes a valid sidecar of %i bytes: %s", async (size, read) => {
		const h = await harness()
		const { op } = await keptOp(h)
		const file = factsPath(h, op.operationId)
		const json = (await readFile(file, "utf8")).trimEnd()
		// Valid JSON padded with trailing spaces to exactly `size` bytes.
		await writeFile(file, json + " ".repeat(size - Buffer.byteLength(json)))
		expect((await lstat(file)).size).toBe(size)
		const page = await h.inventory.list({ limit: "200" })
		expect(page.items).toHaveLength(1)
		if (read) expect(page.items[0]?.facts).toMatchObject({ version: 1 })
		else expect(page.items[0]?.facts).toBeNull()
	})
})
