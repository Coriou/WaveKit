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
	RECORDER_TONE_QUIET,
	RECORDING_FACTS_FILE,
	RECORDING_FACTS_MAX_BYTES,
	RecordingFactsSchema,
	DCS_MEASURED_MIN_SAMPLES,
	DCS_CHANCE_HIT_SECONDS,
	DCS_LONE_HIT_SECONDS,
	DCS_LONE_HITS_MIN,
	DCS_PARTIAL_WORDS,
	TONE_MEASURED_MIN_BLOCKS,
	TONE_LOUD_BLOCK_SHARE,
	TONE_LOUD_EDGE_BLOCKS,
	TONE_QUIET_MIN_BLOCKS,
	TONE_MIN_POWER,
	toneLoudBlocksAllowed,
	factsFitFolder,
	toneAudioPower,
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
import {
	NfmSource,
	brokenDcsDeviation,
	dcsDeviation,
	goertzel,
	voicePitchDeviation,
} from "./wideband-nfm-fixtures.js"
import { WidebandNfmChain } from "../../../../src/core/scanner/channel/wideband-nfm.js"
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
			quietBlocks: TONE_QUIET_MIN_BLOCKS,
			dcsSamples: DCS_MEASURED_MIN_SAMPLES,
			dcsChain: 0,
			dcsLoneHits: 0,
			dcsAnyChain: 0,
			dcs: null,
			ownTone: false,
		}
		const code = { code: "023", polarity: "normal" }

		it("the minimums' arithmetic: 10 blocks (2.75 s of CTCSS), 6 000 samples (0.75 s of DCS), 2 words", () => {
			expect(TONE_MEASURED_MIN_BLOCKS).toBe(10)
			// 4 000 + 9 × 2 000 samples at 8 kHz: the bank's tenth block.
			const bank = new CtcssBank()
			for (let i = 0; i < 21_999; i++) bank.pushSample(0)
			expect(bank.blockCount()).toBe(9)
			bank.pushSample(0)
			expect(bank.blockCount()).toBe(TONE_MEASURED_MIN_BLOCKS)
			expect(DCS_MEASURED_MIN_SAMPLES).toBe(6_000)
			expect(DCS_PARTIAL_WORDS).toBe(2)
		})

		// The derived scale (recording-facts.ts toneAudioPower) against the recorder's own JS chain:
		// a carrier with only the tone, its 8 kHz tone audio (toneAudio(), s16 / 32 768 as the
		// recorder pushes it) measured by Goertzel after the filters settled.
		it.each([67, 151.4, 254.1])(
			"the tone audio's scale: a %s Hz tone at 250 Hz deviation reaches the bank at toneAudioPower",
			hz => {
				const chain = new WidebandNfmChain({
					inputRateHz: LOW_FS,
					offsetHz: LOW_OFFSET,
				})
				const src = new NfmSource({
					fs: LOW_FS,
					offsetHz: LOW_OFFSET,
					voice: false,
					noiseSigma: 0,
					ctcssHz: hz,
					ctcssDeviationHz: 250,
				})
				const tone: number[] = []
				for (let i = 0; i < 30; i++) {
					chain.process(src.next(LOW_FS / 10, true))
					for (const t of chain.toneAudio()) tone.push(t / 32_768)
				}
				const measured = 2 * goertzel(tone, 8000, hz, 8000, 24_000)
				expect(measured / toneAudioPower(hz, 250)).toBeGreaterThan(0.95)
				expect(measured / toneAudioPower(hz, 250)).toBeLessThan(1.05)
				if (hz === 254.1) expect(measured / TONE_MIN_POWER).toBeLessThan(1.05)
			},
		)

		it("a confirmed DCS code wins over a settled CTCSS tone; the settled tone wins otherwise", () => {
			expect(toneFactOf(88.5, { ...quiet, dcs: code })).toEqual({
				tone: { kind: "dcs", code: "023", polarity: "normal" },
			})
			// Under the DCS sample minimum the code is no answer: the CTCSS tone.
			expect(
				toneFactOf(88.5, {
					...quiet,
					dcs: code,
					dcsSamples: DCS_MEASURED_MIN_SAMPLES - 1,
				}),
			).toEqual({ tone: { kind: "ctcss", hz: 88.5 } })
			expect(toneFactOf(88.5, null)).toEqual({
				tone: { kind: "ctcss", hz: 88.5 },
			})
			expect(toneFactOf(88.5, { ...quiet, ctcssBlocks: 0 })).toEqual({
				tone: { kind: "ctcss", hz: 88.5 },
			})
			expect(
				toneFactOf(88.5, { ...quiet, dcsLoneHits: 50, ownTone: true }),
			).toEqual({ tone: { kind: "ctcss", hz: 88.5 } })
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
			expect(TONE_QUIET_MIN_BLOCKS).toBe(10)
			expect(toneFactOf(null, quiet)).toEqual({ tone: null })
			expect(
				toneFactOf(null, { ...quiet, ctcssBlocks: 40, quietBlocks: 40 }),
			).toEqual({ tone: null })
			// One quiet block short of the minimum, or none: no proof a tone would have been seen.
			expect(
				toneFactOf(null, {
					...quiet,
					ctcssBlocks: 40,
					quietBlocks: TONE_QUIET_MIN_BLOCKS - 1,
				}),
			).toEqual({})
			expect(
				toneFactOf(null, { ...quiet, ctcssBlocks: 40, quietBlocks: 0 }),
			).toEqual({})
			// Ten quiet blocks of 40: 30 loud blocks, where a tone may hide under voice: absent.
			expect(toneFactOf(null, { ...quiet, ctcssBlocks: 40 })).toEqual({})
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

		it("loud blocks: null at max(2, 10% of the blocks), absent one past", () => {
			expect(TONE_LOUD_EDGE_BLOCKS).toBe(2)
			expect(TONE_LOUD_BLOCK_SHARE).toBe(0.1)
			const at = (ctcssBlocks: number, loud: number) =>
				toneFactOf(null, {
					...quiet,
					ctcssBlocks,
					quietBlocks: ctcssBlocks - loud,
				})
			// 10-29 blocks: the 2 edge blocks bind.
			for (const blocks of [12, 20, 29]) {
				expect(toneLoudBlocksAllowed(blocks)).toBe(2)
				expect(at(blocks, 2)).toEqual({ tone: null })
				expect(at(blocks, 3)).toEqual({})
			}
			// From 30 blocks the 10% share binds (floored): 3 at 30-39, 4 at 40, 10 at 100.
			expect(toneLoudBlocksAllowed(30)).toBe(3)
			expect(toneLoudBlocksAllowed(39)).toBe(3)
			expect(toneLoudBlocksAllowed(40)).toBe(4)
			expect(toneLoudBlocksAllowed(100)).toBe(10)
			expect(at(30, 3)).toEqual({ tone: null })
			expect(at(30, 4)).toEqual({})
			expect(at(40, 4)).toEqual({ tone: null })
			expect(at(40, 5)).toEqual({})
			expect(at(100, 10)).toEqual({ tone: null })
			expect(at(100, 11)).toEqual({})
			// At the quiet minimum both bounds hold: 12 blocks, 10 quiet, 2 loud.
			expect(at(TONE_QUIET_MIN_BLOCKS + 2, 2)).toEqual({ tone: null })
			// More quiet blocks than blocks is inconsistent coverage: not analysed.
			expect(toneFactOf(null, { ...quiet, quietBlocks: 11 })).toEqual({})
		})

		// The edge arithmetic on a real bank: a keying edge in the first 2 000 samples (250 ms)
		// touches only the first block, a squelch tail in the last 2 000 only the last complete
		// block; a 300 ms one touches a second. A burst mid-file touches 2 blocks on the hop
		// grid, 3 off it. Modelled: white noise at 1.0 RMS (about 0.09 of it in the band: loud, no tone), zeros otherwise.
		it("a real bank: an edge of 250 ms makes one loud block, a mid-file burst two or three", () => {
			const loudOf = (total: number, bursts: [number, number][]) => {
				const bank = new CtcssBank(RECORDER_TONE_QUIET)
				const rand = mulberry32(11)
				for (let i = 0; i < total; i++) {
					const on = bursts.some(([from, n]) => i >= from && i < from + n)
					bank.pushSample(on ? gaussian(rand) : 0)
				}
				return {
					blocks: bank.blockCount(),
					loud: bank.blockCount() - bank.quietBlockCount(),
					fact: toneFactOf(bank.result(), coverageOf(bank, dcsOf(total))),
				}
			}
			// 12 blocks: 4 000 + 11 × 2 000 samples.
			const n = 26_000
			expect(
				loudOf(n, [
					[0, 2000],
					[n - 2000, 2000],
				]),
			).toEqual({
				blocks: 12,
				loud: 2,
				fact: { tone: null },
			})
			expect(
				loudOf(n, [
					[0, 2400],
					[n - 2000, 2000],
				]).loud,
			).toBe(3)
			expect(
				loudOf(n, [
					[0, 2000],
					[n - 2400, 2400],
				]).loud,
			).toBe(3)
			expect(
				loudOf(n, [
					[0, 2400],
					[n - 2000, 2000],
				]).fact,
			).toEqual({})
			expect(loudOf(n, [[12_000, 400]]).loud).toBe(2)
			expect(loudOf(n, [[12_500, 2000]]).loud).toBe(3)
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
			// Two words of any valid code, standard or not (a non-standard code): absent; one is not.
			expect(
				toneFactOf(null, { ...quiet, dcsAnyChain: DCS_PARTIAL_WORDS }),
			).toEqual({})
			expect(
				toneFactOf(null, { ...quiet, dcsAnyChain: DCS_PARTIAL_WORDS - 1 }),
			).toEqual({ tone: null })
		})

		it("lone DCS word hits: absent from 2 and one per 3 s analysed, null below either bound", () => {
			expect(DCS_LONE_HITS_MIN).toBe(2)
			expect(DCS_LONE_HIT_SECONDS).toBe(3)
			// About four times the chance rate of one hit per 13 s.
			expect(DCS_CHANCE_HIT_SECONDS / DCS_LONE_HIT_SECONDS).toBeGreaterThan(4)
			const at = (dcsLoneHits: number, seconds: number) =>
				toneFactOf(null, {
					...quiet,
					dcsSamples: seconds * 8000,
					dcsLoneHits,
				})
			// 0.75 s and 3 s analysed: the minimum of 2 binds.
			expect(at(1, 0.75)).toEqual({ tone: null })
			expect(at(2, 0.75)).toEqual({})
			expect(at(1, 3)).toEqual({ tone: null })
			expect(at(2, 3)).toEqual({})
			// 6 s: 2 hits are one per 3 s, exactly at the rate.
			expect(at(1, 6)).toEqual({ tone: null })
			expect(at(2, 6)).toEqual({})
			// 60 s: the rate binds, 20 hits (exactly one per 3 s) and not 19.
			expect(at(19, 60)).toEqual({ tone: null })
			expect(at(20, 60)).toEqual({})
			// One sample past 60 s: 20 hits fall just under one per 3 s.
			expect(
				toneFactOf(null, {
					...quiet,
					dcsSamples: 60 * 8000 + 1,
					dcsLoneHits: 20,
				}),
			).toEqual({ tone: null })
			expect(
				toneFactOf(null, {
					...quiet,
					dcsSamples: 60 * 8000 + 1,
					dcsLoneHits: 21,
				}),
			).toEqual({})
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
				expect(toneFactOf(null, { ...quiet, quietBlocks: n })).toEqual({})
				expect(toneFactOf(null, { ...quiet, dcsChain: n })).toEqual({})
				expect(toneFactOf(null, { ...quiet, dcsLoneHits: n })).toEqual({})
				expect(toneFactOf(null, { ...quiet, dcsAnyChain: n })).toEqual({})
			}
		})
	})

	/** A detector pair's counters as the recorder freezes them (finishFile). */
	const coverageOf = (bank: CtcssBank, dcs: DcsDecoder, ownTone = false) => ({
		ctcssBlocks: bank.blockCount(),
		votedBlocks: bank.votedBlockCount(),
		partialBlocks: bank.partialBlockCount(),
		quietBlocks: bank.quietBlockCount(),
		dcsSamples: dcs.sampleCount(),
		dcsChain: dcs.longestChain(),
		dcsLoneHits: dcs.loneHitCount(),
		dcsAnyChain: dcs.anyValidChain(),
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
		const bank = new CtcssBank(RECORDER_TONE_QUIET)
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
		// and no tone wins or leans on a block, but every block is too loud to prove a tone would
		// have been seen: not determined. The same noise 40 dB down is quiet: a measured "no tone".
		const noiseOf = (sigma: number) => {
			const noisy = new CtcssBank(RECORDER_TONE_QUIET)
			const noisyDcs = new DcsDecoder()
			for (let i = 0; i < 39_200; i++) {
				const x = sigma * gaussian(rand)
				noisy.pushSample(x)
				noisyDcs.pushSample(x)
			}
			expect(noisy.votedBlockCount()).toBe(0)
			expect(noisy.subAudibleBlockCount()).toBeGreaterThan(0)
			return toneFactOf(noisy.result(), coverageOf(noisy, noisyDcs))
		}
		expect(noiseOf(0.3)).toEqual({})
		expect(noiseOf(0.003)).toEqual({ tone: null })
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
		/** The CTCSS peak deviation in Hz (default the source's 350). */
		ctcssDeviationHz?: number
		/**
		 * Whether the talker speaks at t s into the over (each 25 ms chunk; default always): the
		 * voice and `subAudible` are keyed off while not, the carrier and its CTCSS stay on.
		 */
		voiceAt?: (t: number) => boolean
	}

	/** The modelled source: syllabic voice by default, and its noise seed. */
	interface SceneSource {
		syllables?: boolean
		seed?: number
	}

	// Kept files of a scene through the real recorder and store. Each over is its own observation
	// (closed 600 ms into the gap after it, so a gap under the 2 s hang joins the next over into
	// the same file); the source's tone follows each over.
	async function recorderScene(
		overs: readonly Over[],
		source: SceneSource = {},
	) {
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
			source: {
				ctcssHz: overs[0]?.ctcssHz ?? null,
				syllables: source.syllables ?? true,
				...(source.seed === undefined ? {} : { seed: source.seed }),
			},
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
			r.src.setCtcssDeviation(over.ctcssDeviationHz ?? 350)
			r.src.setSubAudible(over.subAudible ?? null)
			r.src.setVoice(true)
			const onset = r.engine.liveEdge()
			const end = onset + over.seconds * r.fs
			for (let i = 0; i < Math.round(over.seconds * 40); i++) {
				if (over.ctcssAt !== undefined) r.src.setCtcss(over.ctcssAt(i / 40))
				if (over.voiceAt !== undefined) {
					const speaking = over.voiceAt(i / 40)
					r.src.setVoice(speaking)
					r.src.setSubAudible(speaking ? (over.subAudible ?? null) : null)
				}
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

	// The modelled voice's bursts (400 Hz up) leave little in the 300 Hz tone audio: its blocks are
	// under the quiet ceiling (a tone at 250 Hz of deviation would have voted in them) and nothing
	// tone-like is heard over 6 s: "No tone heard". Real voice fills the band with its pitch.
	it("untoned voice: both detectors analysed it and heard no tone: null", async () => {
		const { facts, stored } = await recorderKeep(null)
		expect(facts.tone).toBeNull()
		expect(stored.tone).toBeNull()
	}, 120_000)

	// Modelled voice pitch in the sub-audible band (110-170 Hz glide plus its harmonic): no CTCSS
	// tone wins or leans on a block and no DCS word chains, but the pitch fills every block above
	// the quiet ceiling, so a tone under it could have hidden: not determined, never null.
	it("untoned voice with its pitch in the 85-300 Hz band and no pause: absent", async () => {
		const scene = await recorderScene([
			{
				seconds: 6,
				ctcssHz: null,
				gapAfter: 4.1,
				subAudible: voicePitchDeviation(),
			},
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect("tone" in scene.facts[0]!).toBe(false)
		expect("tone" in scene.stored[0]!).toBe(false)
	}, 120_000)

	// The same pitch spoken in phrases with pauses (2 s, a 3 s pause, 1.5 s, a 1.5 s pause, 1 s):
	// the carrier alone in the pauses gives the bank its quiet blocks, but the phrases' loud
	// blocks (far more than max(2, 10%)) could hide a tone, so even the untoned talker is not
	// determined; the same talker over a 254.1 Hz tone at 250 Hz of deviation, the weakest tone
	// ruled out, never reads null either.
	const phrases = (t: number) =>
		t < 2 || (t >= 5 && t < 6.5) || (t >= 8 && t < 9)
	it("a talker with pauses: untoned is not determined, over the weakest credible tone never null", async () => {
		const untoned = await recorderScene([
			{
				seconds: 9,
				ctcssHz: null,
				gapAfter: 4.1,
				subAudible: voicePitchDeviation(600),
				voiceAt: phrases,
			},
		])
		expect(untoned.outcomes).toEqual(["finalized"])
		expect("tone" in untoned.facts[0]!).toBe(false)
		expect("tone" in untoned.stored[0]!).toBe(false)
		const toned = await recorderScene([
			{
				seconds: 9,
				ctcssHz: 254.1,
				ctcssDeviationHz: 250,
				gapAfter: 4.1,
				subAudible: voicePitchDeviation(600),
				voiceAt: phrases,
			},
		])
		expect(toned.outcomes).toEqual(["finalized"])
		expect(toned.facts[0]!.tone).not.toBeNull()
		expect(toned.stored[0]!.tone).not.toBeNull()
	}, 240_000)

	/** The file's tone is never null; when present it is the over's own tone. */
	const neverNull = (
		scene: Awaited<ReturnType<typeof recorderScene>>,
		hz: number,
	) => {
		expect(scene.outcomes).toEqual(["finalized"])
		for (const fact of [scene.facts[0]!, scene.stored[0]!]) {
			expect(fact.tone).not.toBeNull()
			if ("tone" in fact) expect(fact.tone).toEqual({ kind: "ctcss", hz })
		}
	}

	// A tone at 250 Hz of deviation under an in-band voice pitch at 2 and 4 times its deviation
	// (the pitch never pauses for a whole block), two talkers' timings and receiver noise seeds:
	// the pitch keeps every block from voting or leaning, and from being quiet: never null.
	it.each(
		[67, 100, 173.8, 250.3, 254.1].flatMap(hz =>
			[2, 4].map(times => [hz, times] as const),
		),
	)(
		"a %s Hz tone at 250 Hz deviation under a voice pitch %s times its level: never null",
		async (hz, times) => {
			for (const [offsetS, seed] of [
				[0, 7],
				[0.37, 19],
			] as const) {
				const scene = await recorderScene(
					[
						{
							seconds: 6,
							ctcssHz: hz,
							ctcssDeviationHz: 250,
							gapAfter: 4.1,
							subAudible: voicePitchDeviation(250 * times, offsetS),
						},
					],
					{ seed },
				)
				neverNull(scene, hz)
			}
		},
		240_000,
	)

	// Continuous speech (the voice bursts never pause) with its pitch at 2.5 times the tone's
	// deviation, three seeds and timings: never null.
	it.each([
		[88.5, 3, 0],
		[192.8, 11, 0.21],
		[254.1, 29, 0.83],
	])(
		"continuous speech over a %s Hz tone at 250 Hz deviation (seed %s): never null",
		async (hz, seed, offsetS) => {
			const scene = await recorderScene(
				[
					{
						seconds: 5,
						ctcssHz: hz,
						ctcssDeviationHz: 250,
						gapAfter: 4.1,
						subAudible: voicePitchDeviation(625, offsetS),
					},
				],
				{ syllables: false, seed },
			)
			neverNull(scene, hz)
		},
		120_000,
	)

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

	// Modelled clean codes outside the standard set, none a rotation of a standard word: the gate
	// reports no code and no standard word hits, but the any-valid chain holds two words or more:
	// tone-like, so absent, never "No tone heard".
	it.each(["017", "050", "141", "214", "537", "755"])(
		"a non-standard DCS %s over: no code, absent, never null",
		async code => {
			const scene = await recorderScene([
				{
					seconds: 6,
					ctcssHz: null,
					gapAfter: 4.1,
					subAudible: dcsDeviation(code),
				},
			])
			expect(scene.outcomes).toEqual(["finalized"])
			expect("tone" in scene.facts[0]!).toBe(false)
			expect("tone" in scene.stored[0]!).toBe(false)
		},
		120_000,
	)

	// A DCS 023 too broken to chain two words (modelled: one bit in 20 flipped, 5% bit errors):
	// the decoder confirms nothing and never matches two consecutive words, but its clean 23-bit
	// windows hit far above chance: tone-like, so absent, never "No tone heard".
	it("a DCS 023 over with 5% flipped bits: no code, lone hits above chance: absent, never null", async () => {
		const scene = await recorderScene([
			{
				seconds: 6,
				ctcssHz: null,
				gapAfter: 4.1,
				subAudible: brokenDcsDeviation("023", 5),
			},
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect("tone" in scene.facts[0]!).toBe(false)
		expect("tone" in scene.stored[0]!).toBe(false)
	}, 120_000)

	/**
	 * Modelled sub-audible noise as deviation (Hz at t s): white noise through two one-pole
	 * low-passes at 250 Hz, `rmsHz` RMS, plus an 88.5 Hz tone `snrDb` under it (none when null).
	 * Called once per source sample at LOW_FS, in order.
	 */
	const subAudibleNoise = (
		seed: number,
		rmsHz: number,
		snrDb: number | null,
	) => {
		const alpha = 1 - Math.exp((-2 * Math.PI * 250) / LOW_FS)
		const filtered = () => {
			const rand = mulberry32(seed)
			let y1 = 0
			let y2 = 0
			return () => {
				y1 += alpha * (gaussian(rand) - y1)
				y2 += alpha * (y1 - y2)
				return y2
			}
		}
		const probe = filtered()
		let power = 0
		for (let i = 0; i < LOW_FS * 4; i++) power += probe() ** 2
		const scale = rmsHz / Math.sqrt(power / (LOW_FS * 4))
		const next = filtered()
		const toneHz =
			snrDb === null ? 0 : rmsHz * Math.sqrt(2 * 10 ** (snrDb / 10))
		return (t: number) =>
			scale * next() + toneHz * Math.sin(2 * Math.PI * 88.5 * t)
	}

	// An 88.5 Hz tone 12 dB under sub-audible noise: too weak for a block to vote: absent, never
	// null. The same noise alone: nothing leans, but the noise keeps every block above the quiet
	// ceiling (a tone could hide under it): absent too.
	it("a weak 88.5 Hz tone under sub-audible noise: absent; the noise alone: absent", async () => {
		const toned = await recorderScene([
			{
				seconds: 6,
				ctcssHz: null,
				gapAfter: 4.1,
				subAudible: subAudibleNoise(23, 150, -12),
			},
		])
		expect(toned.outcomes).toEqual(["finalized"])
		expect("tone" in toned.facts[0]!).toBe(false)
		expect("tone" in toned.stored[0]!).toBe(false)
		const noise = await recorderScene([
			{
				seconds: 6,
				ctcssHz: null,
				gapAfter: 4.1,
				subAudible: subAudibleNoise(23, 150, null),
			},
		])
		expect(noise.outcomes).toEqual(["finalized"])
		expect("tone" in noise.facts[0]!).toBe(false)
		expect("tone" in noise.stored[0]!).toBe(false)
	}, 240_000)

	it.each([5, 41, 77])(
		"an 88.5 Hz tone 12 dB under sub-audible noise (seed %s): never null",
		async seed => {
			const scene = await recorderScene(
				[
					{
						seconds: 4,
						ctcssHz: null,
						gapAfter: 4.1,
						subAudible: subAudibleNoise(seed, 150, -12),
					},
				],
				{ seed },
			)
			expect(scene.outcomes).toEqual(["finalized"])
			expect(scene.facts[0]!.tone).not.toBeNull()
			expect(scene.stored[0]!.tone).not.toBeNull()
		},
		120_000,
	)

	// A 600 ms over alone: its detectors analysed under 2.75 s (the CTCSS minimum): absent.
	it("a short over (600 ms): the tone is absent, never null", async () => {
		const scene = await recorderScene([
			{ seconds: 0.6, ctcssHz: null, gapAfter: 4.1 },
		])
		expect(scene.outcomes).toEqual(["finalized"])
		expect("tone" in scene.facts[0]!).toBe(false)
		expect("tone" in scene.stored[0]!).toBe(false)
	}, 120_000)

	// Two untoned overs joined across 1.9 s of carrier-off receiver noise: no tone or chained DCS
	// word, and the modelled voice (its bursts from 400 Hz up) leaves its blocks under the quiet
	// ceiling, so the file reads no tone.
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
	// without its tone twin: the part's detectors analysed about 0.73 s, under the 2.75 s CTCSS
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
