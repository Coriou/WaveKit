/**
 * Intermodulation evidence of a kept analog file (copy detection, copy-fingerprint.ts): is the
 * file's frequency where a third-order product of strong signals heard at the same time lands?
 * Evidence only ever marks the WEAKER file of a same-audio pair as a copy (copy-detector.ts).
 *
 * Parents are tracks concurrent with the file on the same source and epoch: overlapping the
 * file's span by at least INTERMOD_MIN_OVERLAP_SHARE of it, with an SNR of INTERMOD_PARENT_MIN_SNR_DB
 * or more and a peak at least INTERMOD_PARENT_MARGIN_DB over the file's own peak; at most the
 * INTERMOD_PARENTS_MAX strongest (by peak).
 * - Rule A (2·f1 − f2): |2·f1 − f2 − fc| ≤ tol for two distinct parents f1, f2.
 * - Rule B (symmetric pair): a parent fa and another concurrent track fc′ (overlapping the
 *   file's span by INTERMOD_MIN_OVERLAP_SHARE, like a parent, and with a parent's SNR floor of
 *   INTERMOD_PARENT_MIN_SNR_DB, so an unrelated weak carrier never stands in for the mirror) at
 *   least INTERMOD_PARENT_MARGIN_DB under fa with |fc + fc′ − 2·fa| ≤ tol (the two products 2·fa − fb
 *   and 2·fb − fa of fa with an unseen fb sit symmetric around fa only when fb is fa's own
 *   mixing partner; two on-raster channels symmetric around a close strong one are ordinary
 *   traffic), AND fc or fc′ is off its raster (fc′ by its span's median centre, not its latest
 *   snapshot) or |fc − fa| ≥ INTERMOD_WIDE_HZ (100 kHz).
 * - tol = 4·max(binHz, 1 000 Hz): four FFT bins of centroid error, at least 4 kHz.
 *
 * The parent set is captured when the file ENDS (the recorder's finishFile), from a per-source,
 * per-epoch ring of recent track spans (TrackSpans): a parent whose observation closed long
 * before the keep (a provisional hold of up to 26 s) still counts.
 *
 * Bounds (arithmetic): Rule A checks 16 × 15 = 240 ordered pairs; Rule B 16 parents × at most
 * TRACK_SPANS_MAX others = 4 096 checks (subtractions only). TrackSpans holds at most
 * TRACK_SPANS_MAX = 256 spans per source (oldest dropped first) and forgets spans that ended more
 * than COPY_HORIZON_MS before the newest one heard on that source. Each span keeps a centre
 * sampler of at most SPAN_HZ_SAMPLES_MAX = 16 values (a partner's raster fit reads its median,
 * not its latest snapshot): 256 × 16 = 4 096 numbers (32 KiB) per source, and spansOf sorts at
 * most 16 values per span (256 × 16 = 4 096 values, once per file end).
 */

import { rasterToleranceHz } from "../bandplan/index.js"
import type { Raster } from "../../spectrum/types.js"

/** Overlap of a parent with the file's span: at least half the file. */
export const INTERMOD_MIN_OVERLAP_SHARE = 0.5
/** A parent's SNR (dB); Rule B's mirror fc′ needs it too. */
export const INTERMOD_PARENT_MIN_SNR_DB = 20
/** A parent's peak over the file's peak (dB); fc′ (Rule B) at least this under fa. */
export const INTERMOD_PARENT_MARGIN_DB = 10
/** Parents considered: the 16 strongest by peak. */
export const INTERMOD_PARENTS_MAX = 16
/** Rule B's wide geometry: |fc − fa| ≥ 100 kHz. */
export const INTERMOD_WIDE_HZ = 100_000
/** The tolerance's floor (Hz per bin): 1 kHz; tol = 4 × max(binHz, this). */
export const INTERMOD_MIN_BIN_HZ = 1_000
export const INTERMOD_TOL_BINS = 4
/**
 * How long a span is remembered after the newest span end on its source (ms): 146 000 = the
 * longest file (120 s) + the late-verdict grace (26 s), the copy horizon.
 */
export const COPY_HORIZON_MS = 146_000
/** Spans held per source (oldest dropped). */
export const TRACK_SPANS_MAX = 256

/** Centres a span's sampler keeps (its median: the partner's raster fit). */
export const SPAN_HZ_SAMPLES_MAX = 16

/**
 * The off-raster evidence's floor (Hz): the intermod centroid tolerance's floor, 4 × 1 kHz
 * (INTERMOD_TOL_BINS × INTERMOD_MIN_BIN_HZ). A centre is off raster only when it is at least
 * max(raster tolerance, this) from the nearest channel of EVERY raster at it.
 */
export const COPY_OFF_RASTER_MIN_HZ = INTERMOD_TOL_BINS * INTERMOD_MIN_BIN_HZ

/**
 * Copy detection's raster fit of a corrected centre (the source's learned correction already
 * subtracted) against the rasters placement keeps at it: `on` within one raster's tolerance
 * (rasterToleranceHz: max(1 kHz, spacing / 4), as placement snaps); `off` only when at least
 * max(that tolerance, COPY_OFF_RASTER_MIN_HZ) from the nearest channel of every raster; `unknown`
 * between the two (a centroid error of a few kHz could put an on-raster channel there) and with no
 * raster at all. Arithmetic: 12.5 kHz spacing, tolerance 3 125 Hz: on ≤ 3 125, unknown 3 125 to
 * 4 000, off from 4 000 to 6 250 (half a channel); 25 kHz: tolerance 6 250 ≥ 4 000, off past
 * 6 250; 6.25 kHz: tolerance 1 562.5, and no centre is 4 000 from a channel (half a channel is
 * 3 125): never off.
 */
export function copyRasterFit(
	correctedHz: number,
	rasters: readonly Raster[],
): RasterFit {
	if (!Number.isFinite(correctedHz)) return "unknown"
	let any = false
	let off = true
	for (const r of rasters) {
		if (!(r.spacingHz > 0) || !Number.isFinite(r.firstChannelHz)) continue
		any = true
		const ch = Math.round(
			r.firstChannelHz +
				Math.round((correctedHz - r.firstChannelHz) / r.spacingHz) *
					r.spacingHz,
		)
		const d = Math.abs(correctedHz - ch)
		const tol = rasterToleranceHz(r.spacingHz)
		if (d <= tol) return "on"
		if (d < Math.max(tol, COPY_OFF_RASTER_MIN_HZ)) off = false
	}
	return any && off ? "off" : "unknown"
}

export type RasterFit = "on" | "off" | "unknown"

/**
 * A bounded, evenly spread sample of a series of centres: every `stride`-th value is kept; when
 * `max` are held, every other one is dropped and the stride doubles, so the kept values stay
 * evenly spaced over the whole series at O(max) memory.
 */
export interface HzSampler {
	values: number[]
	stride: number
	seen: number
}

export function newHzSampler(): HzSampler {
	return { values: [], stride: 1, seen: 0 }
}

/** Adds `hz` (non-finite ignored) to `c`, keeping at most `max` (≥ 2) values. */
export function sampleHz(c: HzSampler, hz: number, max: number): void {
	if (!Number.isFinite(hz)) return
	if (c.seen++ % c.stride !== 0) return
	c.values.push(hz)
	if (c.values.length < max) return
	c.values = c.values.filter((_, i) => i % 2 === 0)
	c.stride *= 2
}

/** The sampler's median (the mean of the middle two, rounded, for an even count), or null. */
export function medianHz(c: HzSampler): number | null {
	if (c.values.length === 0) return null
	const sorted = [...c.values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 === 1
		? sorted[mid]!
		: Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

export interface IntermodEvidence {
	readonly rule: "2f1-f2" | "symmetric"
	readonly parents: readonly { readonly hz: number }[]
}

/** One track as the evidence reads it (a span on its source's sample clock). */
export interface TrackSpan {
	readonly hz: number
	readonly startSample: number
	readonly lastSample: number
	readonly snrDb: number
	readonly peakDbfs: number
	readonly binHz: number | null
	/** The latest OBW heard (the raster fit's grid choice); absent or null: unknown. */
	readonly obwHz?: number | null
	/**
	 * The median of the centres heard over the span (TrackSpans' bounded sampler); absent: `hz`.
	 * Rule B's partner raster fit reads it, so a partner drifting at its tail is judged where it
	 * settled.
	 */
	readonly medianHz?: number
}

export interface IntermodFile {
	/** The file's settled centre (the median of its joined snapshots). */
	readonly hz: number
	readonly startSample: number
	readonly endSample: number
	readonly peakDbfs: number
	readonly binHz: number | null
	/** The file's OBW (the raster fit's grid choice); absent or null: unknown. */
	readonly obwHz?: number | null
}

/**
 * Whether a raw centre is on its band's raster, on discovery placement's terms (the source's
 * learned correction subtracted, the rasters kept for `obwHz`); unknown: no evidence from it.
 */
export type RasterOf = (hz: number, obwHz: number | null) => RasterFit

/** The tolerance (Hz) for these bins: 4 × max(bin, 1 kHz). */
export function intermodTolerance(binHz: number | null): number {
	const bin = binHz !== null && Number.isFinite(binHz) && binHz > 0 ? binHz : 0
	return INTERMOD_TOL_BINS * Math.max(bin, INTERMOD_MIN_BIN_HZ)
}

/** Share of the file's span the track covers. */
function overlapShare(t: TrackSpan, f: IntermodFile): number {
	const len = f.endSample - f.startSample
	if (!(len > 0)) return 0
	const o =
		Math.min(t.lastSample, f.endSample) - Math.max(t.startSample, f.startSample)
	return Math.max(0, o) / len
}

/**
 * The intermod evidence of `file` among `tracks` (same source and epoch, the caller's), or null.
 * `rasterOf` answers whether a frequency is on its band's raster (unknown: no evidence from it).
 */
export function intermodEvidenceOf(
	file: IntermodFile,
	tracks: readonly TrackSpan[],
	rasterOf: RasterOf,
): IntermodEvidence | null {
	const tol = intermodTolerance(file.binHz)
	const concurrent = tracks.filter(
		t =>
			Math.abs(t.hz - file.hz) > tol &&
			overlapShare(t, file) >= INTERMOD_MIN_OVERLAP_SHARE,
	)
	const parents = concurrent
		.filter(
			t =>
				t.snrDb >= INTERMOD_PARENT_MIN_SNR_DB &&
				t.peakDbfs >= file.peakDbfs + INTERMOD_PARENT_MARGIN_DB,
		)
		.sort((a, b) => b.peakDbfs - a.peakDbfs)
		.slice(0, INTERMOD_PARENTS_MAX)
	for (const f1 of parents)
		for (const f2 of parents) {
			if (f1 === f2) continue
			if (Math.abs(2 * f1.hz - f2.hz - file.hz) <= tol)
				return { rule: "2f1-f2", parents: [{ hz: f1.hz }, { hz: f2.hz }] }
		}
	const fileRaster = rasterOf(file.hz, file.obwHz ?? null)
	for (const fa of parents)
		for (const other of concurrent) {
			if (other === fa) continue
			// The mirror must be a real signal: a parent's SNR floor (its overlap is `concurrent`'s).
			if (other.snrDb < INTERMOD_PARENT_MIN_SNR_DB) continue
			if (other.peakDbfs > fa.peakDbfs - INTERMOD_PARENT_MARGIN_DB) continue
			if (Math.abs(file.hz + other.hz - 2 * fa.hz) > tol) continue
			if (
				fileRaster === "off" ||
				rasterOf(other.medianHz ?? other.hz, other.obwHz ?? null) === "off" ||
				Math.abs(file.hz - fa.hz) >= INTERMOD_WIDE_HZ
			)
				return {
					rule: "symmetric",
					parents: [{ hz: fa.hz }, { hz: other.hz }],
				}
		}
	return null
}

interface SpanEntry {
	hz: number
	startSample: number
	lastSample: number
	snrDb: number
	peakDbfs: number
	binHz: number | null
	obwHz: number | null
	centres: HzSampler
}

/**
 * Recent track spans per source and epoch (the evidence's input): every snapshot the recorder
 * hears, its close included, by track id. A new epoch on a source starts its ring afresh (a
 * retune moves every frequency). Spans whose end is older than COPY_HORIZON_MS before the
 * newest end heard on the source are forgotten; at most TRACK_SPANS_MAX per source.
 */
export class TrackSpans {
	private readonly sources = new Map<
		string,
		{ epoch: number; fs: number; newest: number; spans: Map<string, SpanEntry> }
	>()
	/** Spans dropped by the count bound (diagnostics). */
	overflow = 0

	note(
		sourceId: string,
		fs: number,
		track: {
			readonly trackId: string
			readonly epoch: number
			readonly startSample: number
			readonly lastSample: number
			readonly centreHz: number
			readonly snrDb: number
			readonly peakDbfs: number
			readonly binHz?: number | undefined
			readonly obwHz?: number | undefined
		},
	): void {
		if (
			!Number.isFinite(track.centreHz) ||
			!Number.isFinite(track.lastSample) ||
			!(fs > 0)
		)
			return
		let src = this.sources.get(sourceId)
		if (src === undefined || src.epoch !== track.epoch) {
			src = {
				epoch: track.epoch,
				fs,
				newest: Number.NEGATIVE_INFINITY,
				spans: new Map(),
			}
			this.sources.set(sourceId, src)
		}
		const prev = src.spans.get(track.trackId)
		const entry: SpanEntry = {
			hz: track.centreHz,
			startSample: Math.min(
				prev?.startSample ?? track.startSample,
				track.startSample,
			),
			lastSample: Math.max(
				prev?.lastSample ?? track.lastSample,
				track.lastSample,
			),
			snrDb: Math.max(prev?.snrDb ?? Number.NEGATIVE_INFINITY, track.snrDb),
			peakDbfs: Math.max(
				prev?.peakDbfs ?? Number.NEGATIVE_INFINITY,
				track.peakDbfs,
			),
			binHz:
				typeof track.binHz === "number" && Number.isFinite(track.binHz)
					? track.binHz
					: (prev?.binHz ?? null),
			obwHz:
				typeof track.obwHz === "number" && Number.isFinite(track.obwHz)
					? track.obwHz
					: (prev?.obwHz ?? null),
			centres: prev?.centres ?? newHzSampler(),
		}
		sampleHz(entry.centres, track.centreHz, SPAN_HZ_SAMPLES_MAX)
		src.spans.delete(track.trackId)
		src.spans.set(track.trackId, entry)
		const horizon = (COPY_HORIZON_MS * src.fs) / 1000
		// At most TRACK_SPANS_MAX spans walked per snapshot.
		const newest = Math.max(entry.lastSample, src.newest)
		src.newest = newest
		for (const [id, s] of src.spans)
			if (s.lastSample < newest - horizon) src.spans.delete(id)
		while (src.spans.size > TRACK_SPANS_MAX) {
			const oldest = src.spans.keys().next()
			if (oldest.done === true) break
			src.spans.delete(oldest.value)
			this.overflow++
		}
	}

	/** The spans of `sourceId` in `epoch` (empty for another epoch). */
	spansOf(sourceId: string, epoch: number): TrackSpan[] {
		const src = this.sources.get(sourceId)
		if (src === undefined || src.epoch !== epoch) return []
		return [...src.spans.values()].map(e => {
			const median = medianHz(e.centres)
			return {
				hz: e.hz,
				startSample: e.startSample,
				lastSample: e.lastSample,
				snrDb: e.snrDb,
				peakDbfs: e.peakDbfs,
				binHz: e.binHz,
				obwHz: e.obwHz,
				...(median === null ? {} : { medianHz: median }),
			}
		})
	}

	forgetSource(sourceId: string): void {
		this.sources.delete(sourceId)
	}
}
