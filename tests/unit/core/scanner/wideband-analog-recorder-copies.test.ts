/**
 * WidebandAnalogRecorder and copy detection (copy-detector.ts): a kept file hands its
 * fingerprint to the detector with its settlement; the intermod parents are captured when the
 * file ENDS, so strong parents whose observations closed long before a provisional keep still
 * mark it; the raster fit comes from `rasterOf`; with copy detection off nothing is captured.
 * The fake engine, synthetic NFM and made-up frequencies of wideband-recorder-harness.ts.
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
import type {
	WidebandCloseInfo,
	WidebandTrackInput,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
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
