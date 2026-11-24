/**
 * Copy detection's raster fit (DiscoveryStore.rasterFit, the off-raster evidence): on discovery
 * placement's terms, so the source's learned frequency correction is subtracted before snapping
 * and the same OBW grid choice applies. A receiver 2 kHz off would otherwise read every channel
 * of a 12.5 kHz band as off raster and mark simulcast or repeated audio as copies.
 * Made-up frequencies on a made-up raster; MODELLED envelopes (copy-envelopes.ts).
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	CopyDetector,
	type CopyFingerprint,
	type CopyRecord,
	type CopySettled,
} from "../../../../src/core/scanner/channel/copy-detector.js"
import {
	intermodEvidenceOf,
	type TrackSpan,
} from "../../../../src/core/scanner/channel/copy-intermod.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import { counterIds } from "../../../mocks/scanner/observations.js"
import { fingerprint, frameVoice, heardAgain, slice } from "./copy-envelopes.js"

const SRC = "src-a"
/** A made-up 12.5 kHz band: channels at FIRST + k·12 500 (tolerance ±3 125 Hz). */
const FIRST = 300_000_000
const SPACING = 12_500
const CH = FIRST + 40 * SPACING
const CORRECTION = 2_000
const FPS = 1000 / 32
const sec = (s: number): number => Math.round(s * FPS)

function store(
	rasters: Raster[] = [{ spacingHz: SPACING, firstChannelHz: FIRST }],
) {
	return new DiscoveryStore({
		maxDiscoveries: 10,
		now: () => 0,
		newId: counterIds(),
		rasters: (_s, hz) =>
			hz >= FIRST && hz <= FIRST + 1_000_000 ? rasters : [],
	})
}

function detector() {
	const writes: { operationId: string; copy: CopyRecord | null }[] = []
	const det = new CopyDetector({
		write: (operationId, copy) => {
			writes.push({ operationId, copy })
			return Promise.resolve("written")
		},
		logger: pino({ level: "silent" }),
	})
	return { det, writes }
}

const keyOf = (fp: CopyFingerprint): string =>
	`scan:d_test~analog-${fp.operationId}.wav`
const finalized = (fp: CopyFingerprint): Promise<CopySettled> =>
	Promise.resolve({
		outcome: "finalized",
		alias: `d_test~analog-${fp.operationId}.wav`,
	})

async function keep(det: CopyDetector, ...fps: CopyFingerprint[]) {
	for (const fp of fps) {
		det.kept(fp, finalized(fp))
		await new Promise(r => setImmediate(r))
		await det.idle()
	}
}

describe("copy raster fit: the learned correction and placement's rasters", () => {
	it("subtracts the source's correction before snapping: a channel heard 4 kHz high is off raster uncorrected, on once the source is known 2 kHz high", () => {
		const s = store()
		// 4 kHz high: past the 3 125 Hz tolerance with no correction.
		expect(s.rasterFit(SRC, CH + 4_000, null)).toBe("off")
		s.rekey(SRC, CORRECTION)
		expect(s.rasterFit(SRC, CH + 4_000, null)).toBe("on")
		expect(s.rasterFit(SRC, CH + CORRECTION, 11_000)).toBe("on")
		// Half a channel off, corrected: still off.
		expect(s.rasterFit(SRC, CH + CORRECTION + 6_250, null)).toBe("off")
		// No raster at it: unknown (no evidence).
		expect(s.rasterFit(SRC, 100_000_000, null)).toBe("unknown")
		expect(s.rasterFit(SRC, Number.NaN, null)).toBe("unknown")
	})

	it("keeps placement's OBW grid choice: a wide emission keys to the coarse raster only", () => {
		const s = store([
			{ spacingHz: 6_250, firstChannelHz: FIRST },
			{ spacingHz: 25_000, firstChannelHz: FIRST },
		])
		// FIRST + 12 500 is a 6.25 kHz channel, half-way between two 25 kHz ones.
		expect(s.rasterFit(SRC, FIRST + 12_500, 5_000)).toBe("on")
		expect(s.rasterFit(SRC, FIRST + 12_500, 40_000)).toBe("off")
	})

	it("+2 kHz correction: an on-raster same-audio pair with no intermod is never marked; an off-raster ghost still is", async () => {
		const s = store()
		s.rekey(SRC, CORRECTION)
		const voice = slice(frameVoice(31, sec(200)), 0, sec(20))
		// Both heard 2 kHz high, as the whole source is: two on-raster channels with the same audio
		// (a simulcast); the weaker is 3.5 kHz high raw, past the 3 125 Hz tolerance uncorrected.
		const rawA = CH + CORRECTION
		const rawB = CH + 2 * SPACING + CORRECTION + 1_500
		const a = fingerprint(voice, {
			snrDb: 30,
			hz: rawA,
			raster: s.rasterFit(SRC, rawA, 11_000),
		})
		const b = fingerprint(heardAgain(voice, 32, -6), {
			snrDb: 18,
			hz: rawB,
			raster: s.rasterFit(SRC, rawB, 11_000),
		})
		expect([a.raster, b.raster]).toEqual(["on", "on"])
		const pair = detector()
		await keep(pair.det, a, b)
		expect(pair.det.stateOf(keyOf(a))).toEqual({ kind: "root" })
		expect(pair.det.stateOf(keyOf(b))).toEqual({ kind: "root" })
		expect(pair.writes).toEqual([])
		expect(pair.det.status().copySameAudioNoEvidence).toBe(1)
		// A ghost half a channel off its raster, corrected: still off, still marked.
		const rawG = CH + 5 * SPACING + SPACING / 2 + CORRECTION
		const g = fingerprint(heardAgain(voice, 33, -20), {
			snrDb: 8,
			hz: rawG,
			raster: s.rasterFit(SRC, rawG, 11_000),
		})
		expect(g.raster).toBe("off")
		const ghost = detector()
		await keep(ghost.det, a, g)
		expect(ghost.det.stateOf(keyOf(g))).toEqual({
			kind: "copy",
			of: keyOf(a),
		})
		expect(ghost.writes[0]?.copy?.evidence).toEqual(["off-raster"])
	})

	it("Rule B reads the partner's raster fit with its OBW, corrected: an on-raster partner and file never qualify close in", () => {
		const s = store()
		s.rekey(SRC, CORRECTION)
		const fa = CH + CORRECTION
		const fc = fa - 2 * SPACING
		const partner = fa + 2 * SPACING
		const span = (hz: number, peak: number): TrackSpan => ({
			hz,
			startSample: 0,
			lastSample: 1_000_000,
			snrDb: 40,
			peakDbfs: peak,
			binHz: 1_000,
			obwHz: 11_000,
		})
		const seen: (number | null)[] = []
		const ev = intermodEvidenceOf(
			{
				hz: fc,
				startSample: 0,
				endSample: 1_000_000,
				peakDbfs: -60,
				binHz: 1_000,
				obwHz: 11_000,
			},
			[span(fa, -10), span(partner, -55)],
			(hz, obw) => {
				seen.push(obw)
				return s.rasterFit(SRC, hz, obw)
			},
		)
		expect(ev).toBeNull()
		expect(seen).toEqual([11_000, 11_000])
		// The partner half a channel off (corrected): the symmetric pair qualifies.
		const off = intermodEvidenceOf(
			{
				hz: fc - SPACING / 2,
				startSample: 0,
				endSample: 1_000_000,
				peakDbfs: -60,
				binHz: 1_000,
			},
			[span(fa, -10), span(partner + SPACING / 2, -55)],
			(hz, obw) => s.rasterFit(SRC, hz, obw),
		)
		expect(off?.rule).toBe("symmetric")
	})
})
