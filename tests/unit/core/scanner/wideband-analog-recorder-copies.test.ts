/**
 * WidebandAnalogRecorder and copy detection (copy-detector.ts): a kept file hands its
 * fingerprint to the detector with its settlement; the intermod parents are captured when the
 * file ENDS, so strong parents whose observations closed long before a provisional keep still
 * mark it; the raster fit comes from `rasterOf`; with copy detection off nothing is captured.
 * The file's settled centre is the median of its joined snapshots (a stride-decimated sample of
 * at most COPY_HZ_SAMPLES_MAX), and a file still holding queued or in-flight audio when it is
 * kept gets no fingerprint. The fake engine, synthetic NFM and made-up frequencies of
 * wideband-recorder-harness.ts.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	CopyDetector,
	type CopyFingerprint,
	type CopyRecord,
	type CopySettled,
} from "../../../../src/core/scanner/channel/copy-detector.js"
import { COPY_FRAME_SAMPLES } from "../../../../src/core/scanner/channel/copy-fingerprint.js"
import {
	COPY_HZ_SAMPLES_MAX,
	sampleCopyHz,
	settledCopyHz,
	type CopyHzSampler,
	type WidebandCloseInfo,
	type WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { PcmQueue } from "../../../../src/core/scanner/channel/pcm-queue.js"
import {
	CENTRE,
	HARNESS_T0,
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

const FC = CENTRE + LOW_OFFSET
/** Two strong made-up parents whose 2·f1 − f2 product lands on the file's frequency. */
const F1 = FC + 30_000
const F2 = FC + 60_000

/** A suspect prior (a sync hint of a digital mode): an untoned voice is held, then kept. */
const suspect: VoicePrior = {
	labels: [
		{ protocol: "dmr", confidence: "activity", owner: true, at: HARNESS_T0 },
	],
	class: "unknown",
	analogVoice: () => false,
}

function fakeCopies() {
	const kept: { fp: CopyFingerprint; settled: Promise<CopySettled> }[] = []
	const det = {
		kept: (fp: CopyFingerprint, settled: Promise<CopySettled>) =>
			kept.push({ fp, settled }),
		forget: () => undefined,
		status: () => ({
			copyCompared: 0,
			copyMarked: 0,
			copySameAudioNoEvidence: 0,
			copyIneligible: 0,
			copyMultiRoot: 0,
			copyUnlinked: 0,
			copyRingOverflow: 0,
			copyQueueDropped: 0,
			copyWriteSkipped: 0,
			copyComparisonMsMax: 0,
		}),
	}
	return { kept, det: det as unknown as CopyDetector }
}

/** One over of `seconds` by `id` at the file's frequency, with the parents on the air over it. */
async function overWithParents(
	h: Harness,
	seconds: number,
	parents: boolean,
): Promise<void> {
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	const parentsFrom = onset - h.fs
	const strong = { peakDbfs: -5, snrDb: 45 }
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
		h.engine.write(h.src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs) {
			h.rec.track(
				input("o", snapshot("o", onset, Math.min(edge, end), { centreHz: FC })),
			)
			if (parents)
				for (const [id, hz] of [
					["p1", F1],
					["p2", F2],
				] as const)
					h.rec.track(
						input(
							id,
							snapshot(id, parentsFrom, edge, { centreHz: hz, ...strong }),
							{ recordAllowed: false },
						),
					)
		}
		await h.pump()
	}
	if (parents)
		for (const [id, hz] of [
			["p1", F1],
			["p2", F2],
		] as const)
			h.rec.closed(
				id,
				snapshot(id, parentsFrom, end, { centreHz: hz, ...strong }),
				null,
			)
	await h.feed(0.6, false)
	h.rec.closed("o", snapshot("o", onset, end, { centreHz: FC }), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
}

describe("WidebandAnalogRecorder: copy detection", () => {
	it("captures the intermod parents when the file ends: parents closed more than 10 s before the held keep still mark it", async () => {
		const copies = fakeCopies()
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { ctcssHz: null, syllables: true },
			decodedLabel: () => null,
			voicePrior: () => suspect,
			admission: false,
			copies: copies.det,
			rasterOf: (_sourceId, hz) => (hz === FC ? "off" : "on"),
		})
		await h.feed(1, false)
		await overWithParents(h, 5, true)
		// Held provisional: nothing kept yet, so nothing handed to the detector.
		expect(h.timers.length).toBe(1)
		expect(copies.kept).toHaveLength(0)
		// 12 s more of quiet: the parents' observations closed over 10 s before the keep.
		await h.feed(12, false)
		await h.fire()
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(copies.kept).toHaveLength(1)
		const fp = copies.kept[0]!.fp
		expect(fp.intermod).toEqual({
			rule: "2f1-f2",
			parents: [{ hz: F1 }, { hz: F2 }],
			roots: [F1, F2],
			tolHz: 4_000,
		})
		expect(fp.raster).toBe("off")
		expect(fp.hz).toBe(FC)
		expect(fp.operationId).toBe("op-1")
		expect(fp.snrDb).toBe(30)
		expect(fp.samplesPerFrame).toBe((256 * LOW_FS) / 8_000)
		expect(fp.frames).toBeGreaterThan(150)
		// The fingerprint is read once the queue is flushed: every frame the file wrote is in it.
		expect(fp.frames).toBe(Math.floor(h.ops[0]!.frames / COPY_FRAME_SAMPLES))
		const settled = await copies.kept[0]!.settled
		expect(settled.outcome).toBe("finalized")
	}, 120_000)

	it("without parents the kept file carries no intermod evidence", async () => {
		const copies = fakeCopies()
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { ctcssHz: null, syllables: true },
			decodedLabel: () => null,
			admission: false,
			copies: copies.det,
		})
		await h.feed(1, false)
		await overWithParents(h, 5, false)
		await h.rec.idle()
		expect(copies.kept).toHaveLength(1)
		expect(copies.kept[0]!.fp.intermod).toBeNull()
		expect(copies.kept[0]!.fp.raster).toBe("unknown")
	}, 120_000)
})

/** A shadow whose spectrum reads `carrier`: classed only by its own speech (toneOnly, speechOnly). */
const CARRIER: Partial<WidebandTrackInput> = {
	analogFm: false,
	shadowAllowed: true,
	spectralDigital: false,
}
const NOT_ANALOG: WidebandCloseInfo = { analogFm: false, discoveryId: "d_1" }
/** A carrier discovery whose own analog trials mostly heard voice (illustrative counts). */
const voiceChannel: VoicePrior = {
	labels: [],
	class: "carrier",
	analogVoice: () => false,
	ownAnalogTrials: () => ({ attempts: 300, decoded: 240 }),
}

describe("WidebandAnalogRecorder: copy detection of own-audio classes", () => {
	it("a ghost classed by its own speech (toneOnly) is fingerprinted, and marked a copy of the stronger root", async () => {
		const copies = fakeCopies()
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { syllables: true, ctcssHz: null },
			decodedLabel: () => null,
			voicePrior: () => voiceChannel,
			copies: copies.det,
			rasterOf: () => "off",
		})
		await h.feed(1, false)
		const chunk = h.fs / 40
		const onset = h.engine.liveEdge()
		const end = onset + 4 * h.fs
		for (let i = 0; i < 4 * 40; i++) {
			h.engine.write(h.src.next(chunk, true))
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * h.fs)
				h.rec.track(
					input("o", snapshot("o", onset, Math.min(edge, end), LOW), CARRIER),
				)
			await h.pump()
		}
		await h.feed(0.6, false)
		h.rec.closed("o", snapshot("o", onset, end, LOW), null, NOT_ANALOG)
		await h.feed(3.5, false)
		await h.rec.idle()
		expect(h.rec.diagnostics().recent.map(d => d.code)).toContain("classed")
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(copies.kept).toHaveLength(1)
		const ghost = copies.kept[0]!.fp
		expect(ghost.raster).toBe("off")
		expect(ghost.frames).toBe(Math.floor(h.ops[0]!.frames / COPY_FRAME_SAMPLES))
		// The eligibility and evidence gates decide as for any analog file: against a stronger root
		// carrying the same audio, the ghost is marked its copy.
		const writes: { operationId: string; copy: CopyRecord | null }[] = []
		const det = new CopyDetector({
			write: (operationId, copy) => {
				writes.push({ operationId, copy })
				return Promise.resolve("written")
			},
			logger: pino({ level: "silent" }),
		})
		const root: CopyFingerprint = {
			...ghost,
			operationId: "root-op",
			snrDb: ghost.snrDb + 15,
			raster: "on",
			intermod: null,
		}
		const settle = (alias: string): Promise<CopySettled> =>
			Promise.resolve({ outcome: "finalized", alias })
		det.kept(root, settle("d_1~analog-root.wav"))
		await new Promise(r => setImmediate(r))
		await det.idle()
		det.kept(ghost, settle("d_1~analog-ghost.wav"))
		await new Promise(r => setImmediate(r))
		await det.idle()
		expect(det.stateOf("scan:d_1~analog-ghost.wav")).toEqual({
			kind: "copy",
			of: "scan:d_1~analog-root.wav",
		})
		expect(writes.map(w => w.operationId)).toEqual([ghost.operationId])
		expect(writes[0]!.copy?.evidence).toEqual(["off-raster"])
	}, 120_000)
})

/** One over of `seconds` at FC whose first joined snapshot reads `firstHz`, the rest FC. */
async function overDrifting(
	h: Harness,
	seconds: number,
	firstHz: number,
): Promise<void> {
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	let first = true
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
		h.engine.write(h.src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs) {
			const centreHz = first ? firstHz : FC
			first = false
			h.rec.track(
				input("o", snapshot("o", onset, Math.min(edge, end), { centreHz })),
			)
		}
		await h.pump()
	}
	await h.feed(0.6, false)
	h.rec.closed("o", snapshot("o", onset, end, { centreHz: FC }), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
}

describe("WidebandAnalogRecorder: a file's settled centre", () => {
	it("a file whose first snapshot is off raster but whose later joined snapshots are on it fits on raster", async () => {
		const copies = fakeCopies()
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { ctcssHz: null, syllables: true },
			decodedLabel: () => null,
			admission: false,
			copies: copies.det,
			rasterOf: (_sourceId, hz) => (hz === FC ? "on" : "off"),
		})
		await h.feed(1, false)
		await overDrifting(h, 5, FC + 3_000)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(copies.kept).toHaveLength(1)
		expect(copies.kept[0]!.fp.hz).toBe(FC)
		expect(copies.kept[0]!.fp.raster).toBe("on")
	}, 120_000)

	const fresh = (): CopyHzSampler => ({
		values: [],
		stride: 1,
		seen: 0,
		obwHz: null,
	})
	const spacing = (c: CopyHzSampler): number[] =>
		c.values.slice(1).map((v, i) => v - c.values[i]!)

	it(`keeps every centre under COPY_HZ_SAMPLES_MAX (${COPY_HZ_SAMPLES_MAX})`, () => {
		const c = fresh()
		for (let i = 0; i < COPY_HZ_SAMPLES_MAX - 1; i++) sampleCopyHz(c, i, 11_000)
		expect(c.values).toHaveLength(COPY_HZ_SAMPLES_MAX - 1)
		expect(c.stride).toBe(1)
		expect(c.obwHz).toBe(11_000)
	})

	it("at COPY_HZ_SAMPLES_MAX halves to evenly spaced samples, and past it keeps them evenly spaced", () => {
		const c = fresh()
		for (let i = 0; i < COPY_HZ_SAMPLES_MAX; i++) sampleCopyHz(c, i, 11_000)
		expect(c.stride).toBe(2)
		expect(c.values).toHaveLength(COPY_HZ_SAMPLES_MAX / 2)
		expect(c.values[0]).toBe(0)
		expect(new Set(spacing(c))).toEqual(new Set([2]))
		// Past it: 64 more centres refill the sampler and halve it again (stride 4).
		for (let i = COPY_HZ_SAMPLES_MAX; i < 2 * COPY_HZ_SAMPLES_MAX; i++)
			sampleCopyHz(c, i, 11_000)
		expect(c.stride).toBe(4)
		expect(c.values).toHaveLength(COPY_HZ_SAMPLES_MAX / 2)
		expect(c.values[0]).toBe(0)
		expect(new Set(spacing(c))).toEqual(new Set([4]))
		// Many more: never over the bound, still evenly spaced from the first centre.
		for (let i = 2 * COPY_HZ_SAMPLES_MAX; i < 1_000; i++)
			sampleCopyHz(c, i, 11_000)
		expect(c.values.length).toBeLessThan(COPY_HZ_SAMPLES_MAX)
		expect(new Set(spacing(c))).toEqual(new Set([c.stride]))
		expect(settledCopyHz(c, -1)).toBeGreaterThan(400)
		expect(settledCopyHz(fresh(), -1)).toBe(-1)
	})
})

/** The recorder's private keep hook, wrapped by the tests below to inject queued or in-flight audio. */
interface KeepHook {
	noteKept(
		s: unknown,
		file: { queue: PcmQueue; writing: boolean },
		handle: unknown,
	): void
}

describe("WidebandAnalogRecorder: no fingerprint for a file with audio still pending", () => {
	for (const pending of ["queued", "in-flight"] as const)
		it(`a file with ${pending} audio when it is kept gets no fingerprint`, async () => {
			const copies = fakeCopies()
			const h = harness({
				fs: LOW_FS,
				offset: LOW_OFFSET,
				source: { ctcssHz: null, syllables: true },
				decodedLabel: () => null,
				admission: false,
				copies: copies.det,
			})
			const hook = h.rec as unknown as KeepHook
			const original = hook.noteKept.bind(h.rec)
			let calls = 0
			hook.noteKept = (s, file, handle) => {
				calls++
				const writing = file.writing
				if (pending === "queued") file.queue.push(new Int16Array(16))
				else file.writing = true
				original(s, file, handle)
				// Put the file back as it was: the injection only exists at the keep.
				if (pending === "queued") file.queue.take(16)
				file.writing = writing
			}
			await h.feed(1, false)
			await overWithParents(h, 5, false)
			await h.rec.idle()
			expect(calls).toBe(1)
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(copies.kept).toHaveLength(0)
		}, 120_000)
})
