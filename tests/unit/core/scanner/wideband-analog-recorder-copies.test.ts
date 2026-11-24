/**
 * WidebandAnalogRecorder and copy detection (copy-detector.ts): a kept file hands its
 * fingerprint to the detector with its settlement; the intermod parents are captured when the
 * file ENDS, so strong parents whose observations closed long before a provisional keep still
 * mark it; the raster fit comes from `rasterOf`; with copy detection off nothing is captured.
 * The fake engine, synthetic NFM and made-up frequencies of wideband-recorder-harness.ts.
 */
import { describe, expect, it } from "vitest"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import type {
	CopyDetector,
	CopyFingerprint,
	CopySettled,
} from "../../../../src/core/scanner/channel/copy-detector.js"
import {
	CENTRE,
	HARNESS_T0,
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
