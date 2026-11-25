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
	TRACK_SPANS_OPEN_MAX,
	TrackSpans,
	intermodEvidenceOf,
	intermodTiedTo,
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
			roots: [f1, f2],
			tolHz: 4_000,
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
			roots: [fa],
			tolHz: 4_000,
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

describe("intermod evidence: rule B's mirror must be a real concurrent signal", () => {
	// A repeater-like pair: a strong output fa and the file 600 kHz away carrying related audio
	// (the wide geometry), with an unrelated track near 2·fa − fc.
	const fa = FC + 600_000
	const mirror = 2 * fa - FC + 1_000
	it("an unrelated weak carrier near 2·fa − fc gives no evidence (SNR under the parent floor)", () => {
		expect(
			intermodEvidenceOf(
				file,
				[span(fa), span(mirror, { peakDbfs: -60, snrDb: 8 })],
				onRaster,
			),
		).toBeNull()
		expect(
			intermodEvidenceOf(
				file,
				[span(fa), span(mirror, { peakDbfs: -40, snrDb: 19.9 })],
				onRaster,
			),
		).toBeNull()
	})

	it("a mirror that does not overlap the file like a parent gives no evidence", () => {
		expect(
			intermodEvidenceOf(
				file,
				[span(fa), span(mirror, { peakDbfs: -40, startSample: 5 * FS + 1 })],
				onRaster,
			),
		).toBeNull()
	})

	it("a true mirror ghost pair (both at the SNR floor, concurrent) still marks", () => {
		expect(
			intermodEvidenceOf(
				file,
				[span(fa), span(mirror, { peakDbfs: -40, snrDb: 20 })],
				onRaster,
			),
		).toEqual({
			rule: "symmetric",
			parents: [{ hz: fa }, { hz: mirror }],
			roots: [fa],
			tolHz: 4_000,
		})
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

	it(`the bound mirrors the tracker: every open track (TRACK_SPANS_OPEN_MAX = ${TRACK_SPANS_OPEN_MAX}) plus as many ended, ${TRACK_SPANS_MAX}`, () => {
		expect(TRACK_SPANS_MAX).toBe(2 * TRACK_SPANS_OPEN_MAX)
		expect(TRACK_SPANS_OPEN_MAX).toBe(512)
		// A busy band: the tracker's full 512 open tracks heard every round, and 4 short tracks
		// ending each round. No live span is ever dropped or restarted.
		const r = new TrackSpans()
		let ended = 0
		for (let round = 0; round < 300; round++) {
			const at = round * 100
			for (let i = 0; i < TRACK_SPANS_OPEN_MAX; i++)
				r.note("s", FS, t(`live${i}`, FC + i, 0, at + 1))
			for (let k = 0; k < 4; k++)
				r.note("s", FS, t(`short${ended++}`, FC, at, at + 1))
		}
		const spans = r.spansOf("s", 1)
		const live = spans.filter(
			x => x.startSample === 0 && x.lastSample === 29_901,
		)
		expect(live).toHaveLength(TRACK_SPANS_OPEN_MAX)
		expect(spans).toHaveLength(TRACK_SPANS_MAX)
		expect(r.overflow).toBe(ended - (TRACK_SPANS_MAX - TRACK_SPANS_OPEN_MAX))
	})

	it("the former bound (256) would have dropped a live parent: 257 live tracks all keep their spans", () => {
		const r = new TrackSpans()
		for (let round = 0; round < 3; round++)
			for (let i = 0; i < 257; i++)
				r.note("s", FS, t(`live${i}`, FC + i, round * 10, round * 10 + 5))
		const spans = r.spansOf("s", 1)
		expect(spans).toHaveLength(257)
		expect(spans.every(x => x.startSample === 0)).toBe(true)
		expect(r.overflow).toBe(0)
	})

	it("prunes expired spans from the front and never returns one past the horizon", () => {
		const horizon = (COPY_HORIZON_MS * FS) / 1000
		const r = new TrackSpans()
		// Heard in this order: "late" ends after "early" but was heard first.
		r.note("s", FS, t("late", FC, 0, 2_000))
		r.note("s", FS, t("early", FC, 0, 1_000))
		r.note("s", FS, t("new", FC, 0, 1_500 + horizon))
		// "early" is past the horizon but behind a span inside it: kept in the map, not returned.
		expect(r.spansOf("s", 1).map(x => x.lastSample)).toEqual([
			2_000,
			1_500 + horizon,
		])
		r.note("s", FS, t("newer", FC, 0, 2_001 + horizon))
		expect(r.spansOf("s", 1).map(x => x.lastSample)).toEqual([
			1_500 + horizon,
			2_001 + horizon,
		])
	})

	it("a returned span is a copy: later snapshots never change it", () => {
		const r = new TrackSpans()
		r.note("s", FS, t("a", FC, 0, 10))
		const [before] = r.spansOf("s", 1)
		r.note("s", FS, t("a", FC + 1_000, 0, 20))
		expect(before?.lastSample).toBe(10)
		expect(before?.hz).toBe(FC)
	})

	it("ignores a late snapshot of an older epoch (a close after the retune): the current ring stays", () => {
		const r = new TrackSpans()
		r.note("s", FS, t("a", FC, 0, 10, 2))
		r.note("s", FS, t("old-close", FC, 0, 5, 1))
		expect(r.spansOf("s", 2)).toHaveLength(1)
		expect(r.spansOf("s", 1)).toEqual([])
		r.note("s", FS, t("b", FC, 0, 12, 2))
		expect(r.spansOf("s", 2)).toHaveLength(2)
	})

	it("starts afresh on a new epoch (a retune moves every frequency)", () => {
		const r = new TrackSpans()
		r.note("s", FS, t("a", FC, 0, 10))
		r.note("s", FS, t("b", FC, 0, 10, 2))
		expect(r.spansOf("s", 1)).toEqual([])
		expect(r.spansOf("s", 2)).toHaveLength(1)
	})
})

describe("intermod evidence: its roots (what a copy may be of)", () => {
	it("rule A names both parents of every pair landing on the file, rule B only fa", () => {
		// Two pairs land on FC: (FC + 60k, FC + 120k) and (FC + 200k, FC + 400k).
		const tracks = [
			span(FC + 60_000),
			span(FC + 120_000),
			span(FC + 200_000),
			span(FC + 400_000),
		]
		const ev = intermodEvidenceOf(file, tracks, onRaster)
		expect(ev?.rule).toBe("2f1-f2")
		expect([...(ev?.roots ?? [])].sort((a, b) => a - b)).toEqual([
			FC + 60_000,
			FC + 120_000,
			FC + 200_000,
			FC + 400_000,
		])
	})

	it(`intermodTiedTo: within tolHz of a root ties, 1 Hz past does not`, () => {
		const ev = intermodEvidenceOf(
			file,
			[span(FC + 60_000), span(FC + 120_000)],
			onRaster,
		)!
		expect(intermodTiedTo(ev, FC + 60_000 + 4_000)).toBe(true)
		expect(intermodTiedTo(ev, FC + 60_000 + 4_001)).toBe(false)
		expect(intermodTiedTo(ev, FC + 120_000 - 4_000)).toBe(true)
		expect(intermodTiedTo(ev, Number.NaN)).toBe(false)
	})
})
