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
	TONE_MEASURED_MIN_MS,
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

	it("toneFactOf: a heard tone always; null from TONE_MEASURED_MIN_MS of activity, nothing one below", () => {
		expect(toneFactOf(88.5, 0)).toEqual({ tone: { kind: "ctcss", hz: 88.5 } })
		expect(toneFactOf(null, TONE_MEASURED_MIN_MS)).toEqual({ tone: null })
		expect(toneFactOf(null, TONE_MEASURED_MIN_MS - 1)).toEqual({})
		expect(toneFactOf(null, Number.NaN)).toEqual({})
		expect(toneFactOf(null, Number.POSITIVE_INFINITY)).toEqual({})
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
	// One kept file through the real recorder and store; `ctcssHz` is the modelled source's tone.
	async function recorderKeep(ctcssHz: number | null) {
		const h = await harness()
		const given: unknown[] = []
		let real: ReturnType<EvidenceStore["beginAnalog"]> | null = null
		const analogFm: VoicePrior = {
			labels: [],
			class: "analog-fm",
			analogVoice: () => false,
		}
		const r = recorderHarness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { ctcssHz, syllables: true },
			decodedLabel: () => null,
			voicePrior: () => analogFm,
			beginWrap: begin => recorderInput => {
				const fake = begin(recorderInput)
				const op = h.evidence.beginAnalog({
					discoveryId: h.discoveryId,
					observationId: "o1",
					binding: h.binding,
				})
				real = op
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
		const onset = r.engine.liveEdge()
		const end = onset + 6 * r.fs
		const chunk = r.fs / 40
		for (let i = 0; i < 6 * 40; i++) {
			r.engine.write(r.src.next(chunk, true))
			const edge = r.engine.liveEdge()
			if (edge - onset >= 0.1 * r.fs)
				r.rec.track(
					trackInput("o", snapshot("o", onset, Math.min(edge, end), LOW)),
				)
			await r.pump()
		}
		await r.feed(0.6, false)
		r.rec.closed("o", snapshot("o", onset, end, LOW), null, {
			analogFm: true,
			discoveryId: "d_1",
		})
		await r.feed(3.5, false)
		await r.rec.idle()
		expect(r.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(given).toHaveLength(1)
		const op = real as ReturnType<EvidenceStore["beginAnalog"]> | null
		expect(op).not.toBeNull()
		const stored = RecordingFactsSchema.parse(
			JSON.parse(await readFile(factsPath(h, op!.operationId), "utf8")),
		)
		return {
			facts: given[0] as {
				admission?: NoiseQuarantineFacts
				tone?: unknown
			},
			stored,
		}
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
