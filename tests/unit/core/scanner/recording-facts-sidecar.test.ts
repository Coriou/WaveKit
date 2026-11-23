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
	TONE_MEASURED_MIN_SAMPLES,
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

	it("toneFactOf: a settled tone always; null only from TONE_MEASURED_MIN_SAMPLES with no voted block", () => {
		const fed = (samples: number, votedBlocks = 0) => ({
			samples,
			votedBlocks,
		})
		expect(toneFactOf(88.5, fed(0))).toEqual({
			tone: { kind: "ctcss", hz: 88.5 },
		})
		expect(toneFactOf(88.5, null)).toEqual({
			tone: { kind: "ctcss", hz: 88.5 },
		})
		// At the sample bound counts, one sample below does not.
		expect(toneFactOf(null, fed(TONE_MEASURED_MIN_SAMPLES))).toEqual({
			tone: null,
		})
		expect(toneFactOf(null, fed(TONE_MEASURED_MIN_SAMPLES - 1))).toEqual({})
		// A block held a tone the bank did not settle on: not determined, never a "no tone".
		expect(toneFactOf(null, fed(TONE_MEASURED_MIN_SAMPLES, 1))).toEqual({})
		expect(toneFactOf(null, fed(10 * TONE_MEASURED_MIN_SAMPLES, 3))).toEqual({})
		// No bank, or counts that are not finite numbers.
		expect(toneFactOf(null, null)).toEqual({})
		expect(toneFactOf(null, fed(Number.NaN))).toEqual({})
		expect(toneFactOf(null, fed(Number.POSITIVE_INFINITY))).toEqual({})
		expect(
			toneFactOf(null, fed(TONE_MEASURED_MIN_SAMPLES, Number.NaN)),
		).toEqual({})
	})

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
		const coverage = {
			samples: bank.sampleCount(),
			votedBlocks: bank.votedBlockCount(),
		}
		expect(coverage.samples).toBe(39_200)
		expect(coverage.votedBlocks).toBeGreaterThan(0)
		expect(toneFactOf(bank.result(), coverage)).toEqual({})
		// The same bank's noise alone, as long: no block voted, a measured "no tone".
		const quiet = new CtcssBank()
		for (let i = 0; i < 39_200; i++) quiet.pushSample(0.3 * gaussian(rand))
		expect(quiet.votedBlockCount()).toBe(0)
		expect(
			toneFactOf(quiet.result(), {
				samples: quiet.sampleCount(),
				votedBlocks: quiet.votedBlockCount(),
			}),
		).toEqual({ tone: null })
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
			const onset = r.engine.liveEdge()
			const end = onset + over.seconds * r.fs
			for (let i = 0; i < Math.round(over.seconds * 40); i++) {
				r.engine.write(r.src.next(chunk, true))
				const edge = r.engine.liveEdge()
				if (edge - onset >= 0.1 * r.fs)
					r.rec.track(
						trackInput(id, snapshot(id, onset, Math.min(edge, end), LOW)),
					)
				await r.pump()
			}
			const closeAfter = Math.min(0.6, over.gapAfter)
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

	it("voice over a CTCSS tone: the sidecar carries the tone the recorder heard", async () => {
		const { facts, stored } = await recorderKeep(88.5)
		expect(facts.tone).toEqual({ kind: "ctcss", hz: 88.5 })
		expect(stored.tone).toEqual({ kind: "ctcss", hz: 88.5 })
	}, 120_000)

	it("untoned voice: the sidecar says measured and no tone (null)", async () => {
		const { facts, stored } = await recorderKeep(null)
		expect(facts.tone).toBeNull()
		expect("tone" in stored).toBe(true)
		expect(stored.tone).toBeNull()
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
