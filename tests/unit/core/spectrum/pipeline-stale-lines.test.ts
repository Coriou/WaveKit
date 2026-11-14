import { describe, expect, it } from "vitest"
import type { PipelineConfig } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { BIN_HZ, BLOCK, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

/**
 * Spec § 4.6 stale check against receiver lines: a line under every centre sits at the same
 * baseband bins after a retune, so its old track bins are no evidence that a block is stale.
 * Without that rule an unverified line cost STALE_MAX_MS (1 s = 20 blocks of 50 ms) on every
 * retune, and anything new in that second was discarded with it. The exemption covers SpurMap
 * candidates and comb lines, and a provisional line only while its 12.5 kHz slot level is under
 * the gate's 6 dB pass level: a real carrier parked long enough to be a provisional line still
 * marks its old-centre samples stale. It covers the line's ±1-bin footprint only, never a line on
 * a confirmed real signal, and follows the old (pre-retune) gain key's lines.
 */
const SIGMA = 0.005
const NOISE_BIN_POWER = (SIGMA * SIGMA * 1.5) / N
const toneAmp = (perBinSnrDb: number): number =>
	Math.sqrt(NOISE_BIN_POWER * 10 ** (perBinSnrDb / 10))
/** 20 dB in 12.5 kHz (the pipeline tests' SNR convention). */
const EMISSION_AMP = Math.sqrt((SIGMA * SIGMA * 12_500 * 100) / FS)
/** The line: 0.1 bin off bin 88's centre. */
const LINE_BIN = 88
const LINE_HZ = (LINE_BIN - N / 2 + 0.1) * BIN_HZ
/**
 * A receiver line under the gate: 10 dB per bin. Its 12.5 kHz slot level is about
 * (13 + 1.5 × 10) / 13 ≈ 2.2, +3.3 dB, under the 6 dB bound (real receiver lines measured ≤ +3.5 dB).
 */
const WEAK_DB = 10
/** A parked real carrier: 25 dB per bin, slot level ≈ (13 + 1.5 × 10^2.5) / 13 ≈ 37.5, +15.7 dB. */
const STRONG_DB = 25
/** The provisional window the harness gives the pipeline: a 2 s stay makes the line a candidate. */
const WINDOW_MS = 1_000
const REAL_HZ = 30_000
const NEW_CENTRE = CENTRE + 1e6
const KEY = `${FS}:m:496:${N}`

function withLine(seed: number, n: number, db = WEAK_DB): Iq {
	const iq = gaussianNoise(mulberry32(seed), n, SIGMA)
	return addInto(iq, tone(n, FS, LINE_HZ, toneAmp(db)))
}

function harness(over: Partial<PipelineConfig> = {}): Harness {
	const h = new Harness(
		{ format: "FLOAT32LE", ...over },
		{ provisionalWindowMs: WINDOW_MS },
	)
	h.start()
	return h
}

/** The private state the bin-exact checks read (no behaviour is changed through it). */
interface Internals {
	provisional: {
		lines(key: string): { startBin: number; endBin: number; comb: boolean }[]
	}
	ep: {
		absKey: string
		centreHz: number
		staleRef: Uint8Array | null
		staleLines: Uint8Array | null
	}
	lineCandidates(key: string): Uint8Array
	isStale(
		segs: { startBin: number; endBin: number; centroidBin: number }[],
		ep: Internals["ep"],
	): boolean
}
const internals = (h: Harness): Internals => h.pipeline as unknown as Internals

const spurRanges = (h: Harness) =>
	h.of("block-summary").flatMap(e => e.summary.masks.spurRanges)
const discarded = (h: Harness): number =>
	h.of("stale-discard").reduce((s, d) => s + d.blocks, 0)
const tracksNear = (h: Harness, epoch: number, hz: number) =>
	h
		.tracks()
		.filter(t => t.epoch === epoch && Math.abs(t.centreHz - hz) <= 1_000)

describe("stale check and receiver lines", () => {
	it("a weak unverified line under every centre discards nothing, and a burst 100 ms after the retune is tracked", () => {
		const h = harness()
		h.push(withLine(1, 40 * BLOCK), 8192) // 2 s: the line is a provisional line (on 100 % of 1 s)
		const lines = internals(h).provisional.lines(KEY)
		expect(lines.filter(l => !l.comb)).toHaveLength(1)
		const retuneSample = h.sample
		h.pending({ epoch: 2, centreHz: NEW_CENTRE }) // timer, zero allowance
		// 1 s at the new centre: the line again, and a real 150 ms tone from 100 ms (blocks 2 to 5)
		const fresh = withLine(2, 20 * BLOCK)
		addInto(
			fresh,
			tone(3 * BLOCK, FS, REAL_HZ, EMISSION_AMP),
			Math.round(0.1 * FS),
		)
		h.push(fresh, 8192)
		// was 20 discards (1 s of 50 ms blocks); the harness feeds no old samples, so 0 is right
		expect(h.of("stale-discard")).toEqual([])
		const ends = h
			.of("block-summary")
			.filter(e => e.summary.epoch === 2)
			.map(e => e.summary.endSample)
		expect(ends).toHaveLength(20)
		expect(ends[0]).toBe(retuneSample + BLOCK)
		const real = tracksNear(h, 2, NEW_CENTRE + REAL_HZ).filter(
			(t, i, a) => a.findIndex(o => o.trackId === t.trackId) === i,
		)
		expect(real).toHaveLength(1)
		// opened within the first 300 ms of the new centre
		expect(real[0]!.startSample - retuneSample).toBeLessThan(0.3 * FS)
		// the line itself is tracked as a signal under both centres, never masked
		expect(tracksNear(h, 1, CENTRE + LINE_HZ).length).toBeGreaterThan(0)
		expect(tracksNear(h, 2, NEW_CENTRE + LINE_HZ).length).toBeGreaterThan(0)
		expect(spurRanges(h)).toEqual([])
	})

	it("a real emitter at the old bins is still stale-discarded beside the line", () => {
		const h = harness()
		// 2 s of line; the real tone on for its last 0.5 s only (50 % of the 1 s window, under the
		// 95 % a provisional line needs), so it is a track and no line candidate
		const before = withLine(3, 40 * BLOCK)
		addInto(before, tone(10 * BLOCK, FS, REAL_HZ, EMISSION_AMP), 30 * BLOCK)
		h.push(before, 8192)
		h.pending({ epoch: 2, centreHz: NEW_CENTRE })
		// 3 blocks of the old centre's samples still in flight (line and tone), then the new centre
		const stale = withLine(4, 3 * BLOCK)
		addInto(stale, tone(3 * BLOCK, FS, REAL_HZ, EMISSION_AMP))
		h.push(stale, 8192)
		h.push(withLine(5, 6 * BLOCK), 8192)
		const discards = h.of("stale-discard")
		expect(discards).toHaveLength(3)
		expect(discards.every(d => d.epoch === 2 && d.blocks === 1)).toBe(true)
		expect(tracksNear(h, 2, NEW_CENTRE + REAL_HZ)).toEqual([])
	})

	it("a strong real carrier parked long enough to be a provisional line, the only old track, is stale-discarded: no ghost at the new centre", () => {
		const h = harness()
		h.push(withLine(6, 40 * BLOCK, STRONG_DB), 8192)
		// it is a provisional line (no comb, no SpurMap candidate), over the gate's 6 dB
		expect(
			internals(h)
				.provisional.lines(KEY)
				.filter(l => !l.comb),
		).toHaveLength(1)
		expect(internals(h).lineCandidates(KEY).includes(1)).toBe(false)
		h.pending({ epoch: 2, centreHz: NEW_CENTRE })
		// 3 blocks of the old centre's samples (the carrier), then the new centre: noise only
		h.push(withLine(7, 3 * BLOCK, STRONG_DB), 8192)
		h.push(gaussianNoise(mulberry32(8), 10 * BLOCK, SIGMA), 8192)
		expect(discarded(h)).toBe(3)
		expect(tracksNear(h, 2, NEW_CENTRE + LINE_HZ)).toEqual([])
	})

	it("an old track covering a line's footprint and bins beside it is stale", () => {
		// a restored spur candidate: exempt whatever its level, so only the footprint rule is under test
		const h = harness({
			persistedEngine: {
				version: 1,
				absoluteFloors: [],
				spurs: [
					{ key: KEY, basebandBin: LINE_BIN, widthBins: 1, kind: "baseband" },
				],
				kByRange: [],
			},
		})
		// an FM emitter 3 bins above the line (≈ 8 kHz wide) on for the last 0.5 s of a 2 s stay
		const fmHz = LINE_HZ + 3 * BIN_HZ
		const fm = (seed: number, n: number): Iq =>
			analogFm(mulberry32(seed), n, FS, fmHz, EMISSION_AMP)
		const before = gaussianNoise(mulberry32(9), 40 * BLOCK, SIGMA)
		addInto(before, fm(10, 10 * BLOCK), 30 * BLOCK)
		h.push(before, 8192)
		h.pending({ epoch: 2, centreHz: NEW_CENTRE })
		const ep = internals(h).ep
		const ref = ep.staleRef!
		const lines = ep.staleLines!
		// the line's footprint is exempt: [LINE_BIN − 1, LINE_BIN + 1]
		expect([...lines.subarray(LINE_BIN - 2, LINE_BIN + 3)]).toEqual([
			0, 1, 1, 1, 0,
		])
		// the old track covers the footprint and bins off it
		expect(ref[LINE_BIN]).toBe(1)
		expect(ref[LINE_BIN + 3]).toBe(1)
		const stale = gaussianNoise(mulberry32(11), 3 * BLOCK, SIGMA)
		addInto(stale, fm(12, 3 * BLOCK))
		h.push(stale, 8192)
		h.push(gaussianNoise(mulberry32(13), 6 * BLOCK, SIGMA), 8192)
		expect(discarded(h)).toBe(3)
		expect(tracksNear(h, 2, NEW_CENTRE + fmHz)).toEqual([])
	})

	it("the exemption is the line's bins ± 1 exactly: an old track at line + 1 bin is no stale evidence, at line + 2 it is", () => {
		const h = harness()
		h.push(withLine(14, 40 * BLOCK), 8192)
		const [line] = internals(h)
			.provisional.lines(KEY)
			.filter(l => !l.comb)
		expect(line).toBeDefined()
		const lo = line!.startBin
		const hi = line!.endBin - 1 // last core bin
		h.pending({ epoch: 2, centreHz: NEW_CENTRE })
		const pi = internals(h)
		const lines = pi.ep.staleLines
		const stale = (bin: number): boolean => {
			const ref = new Uint8Array(N)
			ref[bin] = 1
			return pi.isStale(
				[{ startBin: bin, endBin: bin + 1, centroidBin: bin }],
				{
					...pi.ep,
					staleRef: ref,
					staleLines: lines,
				},
			)
		}
		expect(stale(hi + 1)).toBe(false)
		expect(stale(hi + 2)).toBe(true)
		expect(stale(lo - 1)).toBe(false)
		expect(stale(lo - 2)).toBe(true)
	})

	it("a gain-key change at the retune keeps the old key's lines exempt", () => {
		const h = harness()
		h.push(withLine(15, 40 * BLOCK), 8192)
		h.pending({ epoch: 2, centreHz: NEW_CENTRE, gainKey: "m:300" })
		expect(internals(h).ep.absKey).not.toBe(KEY)
		// the new key has no line of its own yet: only the old key's line explains the old bins
		expect(internals(h).provisional.lines(internals(h).ep.absKey)).toEqual([])
		h.push(withLine(16, 20 * BLOCK), 8192)
		expect(h.of("stale-discard")).toEqual([])
		expect(
			h.of("block-summary").filter(e => e.summary.epoch === 2),
		).toHaveLength(20)
	})

	it("a line on a signal the scanner confirmed real is no exemption", () => {
		const h = harness()
		h.push(withLine(17, 40 * BLOCK), 8192)
		h.send({
			kind: "masks",
			exclusions: [],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
			realRanges: [
				{ startHz: CENTRE + LINE_HZ - 500, endHz: CENTRE + LINE_HZ + 500 },
			],
		})
		h.pending({ epoch: 2, centreHz: NEW_CENTRE })
		expect(internals(h).ep.staleLines!.includes(1)).toBe(false)
		h.push(withLine(18, 20 * BLOCK), 8192)
		// the old track bins are evidence again: the whole stale allowance (1 s) is discarded
		expect(discarded(h)).toBe(20)
	})
})
