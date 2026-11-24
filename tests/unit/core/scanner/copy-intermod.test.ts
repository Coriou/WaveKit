/**
 * Intermod evidence (copy-intermod.ts): rule A (2·f1 − f2) at and past its tolerance, rule B
 * (symmetric pair) only off raster or in the wide geometry, the parent filters (concurrency,
 * SNR, margin, the 16 strongest) at and past each bound, and the track-span ring's horizon,
 * count bound and epoch reset. Made-up frequencies (MODELLED), nothing from a real receiver.
 */
import { describe, expect, it } from "vitest"
import {
	COPY_HORIZON_MS,
	INTERMOD_PARENTS_MAX,
	SPAN_HZ_SAMPLES_MAX,
	TRACK_SPANS_MAX,
	TrackSpans,
	intermodEvidenceOf,
	intermodTolerance,
	type IntermodFile,
	type RasterFit,
	type TrackSpan,
} from "../../../../src/core/scanner/channel/copy-intermod.js"

const FS = 96_000
const FC = 151_250_000
const file: IntermodFile = {
	hz: FC,
	startSample: 0,
	endSample: 10 * FS,
	peakDbfs: -40,
	binHz: null,
}
const span = (hz: number, extra: Partial<TrackSpan> = {}): TrackSpan => ({
	hz,
	startSample: 0,
	lastSample: 10 * FS,
	snrDb: 40,
	peakDbfs: -10,
	binHz: null,
	...extra,
})
const onRaster = (): RasterFit => "on"

describe("intermod evidence: rule A (2·f1 − f2)", () => {
	const f1 = FC + 60_000
	const f2 = FC + 120_000
	it("marks a file at 2·f1 − f2", () => {
		expect(intermodEvidenceOf(file, [span(f1), span(f2)], onRaster)).toEqual({
			rule: "2f1-f2",
			parents: [{ hz: f1 }, { hz: f2 }],
		})
	})

	it("tolerance 4 × max(bin, 1 kHz): at 4 kHz it marks, 1 Hz past it does not", () => {
		expect(intermodTolerance(null)).toBe(4_000)
		expect(intermodTolerance(2_000)).toBe(8_000)
		expect(intermodTolerance(500)).toBe(4_000)
		expect(
			intermodEvidenceOf(file, [span(f1), span(f2 - 4_000)], onRaster),
		).not.toBeNull()
		expect(
			intermodEvidenceOf(file, [span(f1), span(f2 - 4_001)], onRaster),
		).toBeNull()
		expect(
			intermodEvidenceOf(
				{ ...file, binHz: 2_000 },
				[span(f1), span(f2 - 8_000)],
				onRaster,
			),
		).not.toBeNull()
	})

	it("a parent must overlap half the file: at 50 % it counts, under it does not", () => {
		const half = { startSample: 5 * FS }
		expect(
			intermodEvidenceOf(file, [span(f1, half), span(f2)], onRaster),
		).not.toBeNull()
		expect(
			intermodEvidenceOf(
				file,
				[span(f1, { startSample: 5 * FS + 1 }), span(f2)],
				onRaster,
			),
		).toBeNull()
	})

	it("a parent needs 10 dB over the file's peak and an SNR of 20 dB: at both it counts, past either it does not", () => {
		expect(
			intermodEvidenceOf(
				file,
				[span(f1, { peakDbfs: -30 }), span(f2)],
				onRaster,
			),
		).not.toBeNull()
		expect(
			intermodEvidenceOf(
				file,
				[span(f1, { peakDbfs: -31 }), span(f2)],
				onRaster,
			),
		).toBeNull()
		expect(
			intermodEvidenceOf(file, [span(f1, { snrDb: 20 }), span(f2)], onRaster),
		).not.toBeNull()
		expect(
			intermodEvidenceOf(file, [span(f1, { snrDb: 19.9 }), span(f2)], onRaster),
		).toBeNull()
	})

	it(`only the ${INTERMOD_PARENTS_MAX} strongest parents count: a pair whose weaker one is the 17th is ignored`, () => {
		// Decoys far apart (no product of theirs lands near the file), all stronger than f2.
		const decoys = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				span(FC + 3_000_000 + i * 1_013_000, { peakDbfs: -5 }),
			)
		const pair = [span(f1, { peakDbfs: -4 }), span(f2, { peakDbfs: -20 })]
		expect(
			intermodEvidenceOf(file, [...decoys(14), ...pair], onRaster),
		).not.toBeNull()
		expect(
			intermodEvidenceOf(file, [...decoys(15), ...pair], onRaster),
		).toBeNull()
	})
})

describe("intermod evidence: rule B (symmetric pair)", () => {
	it("the wide geometry (|fc − fa| ≥ 100 kHz) marks with both channels on raster", () => {
		const fa = FC + 140_000
		const twin = 2 * fa - FC
		const ev = intermodEvidenceOf(
			file,
			[span(fa), span(twin, { peakDbfs: -40 })],
			onRaster,
		)
		expect(ev).toEqual({
			rule: "symmetric",
			parents: [{ hz: fa }, { hz: twin }],
		})
	})

	it("two on-raster channels symmetric around a close strong one (25 kHz) do not qualify; off raster they do", () => {
		const fa = FC + 25_000
		const twin = 2 * fa - FC
		const tracks = [span(fa), span(twin, { peakDbfs: -40 })]
		expect(intermodEvidenceOf(file, tracks, onRaster)).toBeNull()
		expect(
			intermodEvidenceOf(file, tracks, hz => (hz === twin ? "off" : "on")),
		).not.toBeNull()
		expect(intermodEvidenceOf(file, tracks, () => "unknown")).toBeNull()
	})

	it("the partner's raster fit reads its span's median: a tail drifting off raster gives no evidence", () => {
		const fa = FC + 25_000
		const twin = 2 * fa - FC
		// The partner settled 6 kHz under the twin point (past the 4 kHz tolerance, on raster) and
		// its last snapshot drifted onto the twin point, which is off raster.
		const settled = twin - 6_000
		const rasterOf = (hz: number): RasterFit => (hz === twin ? "off" : "on")
		const r = new TrackSpans()
		const note = (id: string, hz: number, last: number, peakDbfs: number) =>
			r.note("s", FS, {
				trackId: id,
				epoch: 1,
				startSample: 0,
				lastSample: last,
				centreHz: hz,
				snrDb: 40,
				peakDbfs,
			})
		note("fa", fa, 10 * FS, -10)
		for (let i = 1; i < 30; i++) note("twin", settled, i * FS, -40)
		note("twin", twin, 10 * FS, -40)
		const spans = r.spansOf("s", 1)
		const partner = spans.find(x => x.hz === twin)
		expect(partner?.medianHz).toBe(settled)
		expect(intermodEvidenceOf(file, spans, rasterOf)).toBeNull()
		// Judged by its latest snapshot alone, the same partner would mark the file.
		const latestOnly = spans.map(x => ({ ...x, medianHz: x.hz }))
		expect(intermodEvidenceOf(file, latestOnly, rasterOf)).toMatchObject({
			rule: "symmetric",
		})
	})

	it("the twin must be 10 dB under the parent (a twin strong enough to be a parent is rule A's)", () => {
		const fa = FC + 140_000
		const twin = 2 * fa - FC
		// fa at −25 dBFS (a parent: 15 dB over the file); the twin under the parent bound (−30).
		const parent = span(fa, { peakDbfs: -25 })
		expect(
			intermodEvidenceOf(
				file,
				[parent, span(twin, { peakDbfs: -35 })],
				onRaster,
			),
		).toMatchObject({ rule: "symmetric" })
		expect(
			intermodEvidenceOf(
				file,
				[parent, span(twin, { peakDbfs: -34 })],
				onRaster,
			),
		).toBeNull()
		expect(
			intermodEvidenceOf(
				file,
				[parent, span(twin, { peakDbfs: -30 })],
				onRaster,
			),
		).toMatchObject({ rule: "2f1-f2" })
	})
})

describe("intermod evidence: the track-span ring", () => {
	const t = (
		id: string,
		hz: number,
		start: number,
		last: number,
		epoch = 1,
	) => ({
		trackId: id,
		epoch,
		startSample: start,
		lastSample: last,
		centreHz: hz,
		snrDb: 30,
		peakDbfs: -10,
	})

	it("keeps a track's widest span and strongest reading", () => {
		const r = new TrackSpans()
		r.note("s", FS, { ...t("a", FC, 100, 200), snrDb: 25 })
		r.note("s", FS, { ...t("a", FC, 150, 400), snrDb: 35, peakDbfs: -20 })
		expect(r.spansOf("s", 1)).toEqual([
			{
				hz: FC,
				startSample: 100,
				lastSample: 400,
				snrDb: 35,
				peakDbfs: -10,
				binHz: null,
				obwHz: null,
				medianHz: FC,
			},
		])
	})

	it(`keeps a bounded median of a span's centres (at most SPAN_HZ_SAMPLES_MAX = ${SPAN_HZ_SAMPLES_MAX})`, () => {
		const r = new TrackSpans()
		// 200 snapshots settled on FC, then 20 drifting 6 kHz up: the median stays FC.
		for (let i = 0; i < 200; i++) r.note("s", FS, t("a", FC, 0, i + 1))
		for (let i = 0; i < 20; i++) r.note("s", FS, t("a", FC + 6_000, 0, 201 + i))
		const [only] = r.spansOf("s", 1)
		expect(only?.hz).toBe(FC + 6_000)
		expect(only?.medianHz).toBe(FC)
	})

	it(`forgets spans ending more than COPY_HORIZON_MS (${COPY_HORIZON_MS} ms) before the newest: at it kept, past it gone`, () => {
		const horizon = (COPY_HORIZON_MS * FS) / 1000
		const r = new TrackSpans()
		r.note("s", FS, t("old", FC, 0, 1_000))
		r.note("s", FS, t("older", FC, 0, 999))
		r.note("s", FS, t("new", FC, 0, 1_000 + horizon))
		const ids = r.spansOf("s", 1).map(x => x.lastSample)
		expect(ids).toContain(1_000)
		expect(ids).not.toContain(999)
	})

	it(`holds at most TRACK_SPANS_MAX (${TRACK_SPANS_MAX}) spans per source, oldest out, counted`, () => {
		const r = new TrackSpans()
		for (let i = 0; i < TRACK_SPANS_MAX; i++)
			r.note("s", FS, t(`t${i}`, FC, i, i + 1))
		expect(r.spansOf("s", 1)).toHaveLength(TRACK_SPANS_MAX)
		expect(r.overflow).toBe(0)
		r.note("s", FS, t("one-more", FC, 0, TRACK_SPANS_MAX + 1))
		expect(r.spansOf("s", 1)).toHaveLength(TRACK_SPANS_MAX)
		expect(r.overflow).toBe(1)
	})

	it("starts afresh on a new epoch (a retune moves every frequency)", () => {
		const r = new TrackSpans()
		r.note("s", FS, t("a", FC, 0, 10))
		r.note("s", FS, t("b", FC, 0, 10, 2))
		expect(r.spansOf("s", 1)).toEqual([])
		expect(r.spansOf("s", 2)).toHaveLength(1)
	})
})
