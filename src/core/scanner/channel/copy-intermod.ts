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
 * - Rule B (symmetric pair): a parent fa and another concurrent track fc′ at least
 *   INTERMOD_PARENT_MARGIN_DB under fa with |fc + fc′ − 2·fa| ≤ tol (the two products 2·fa − fb
 *   and 2·fb − fa of fa with an unseen fb sit symmetric around fa only when fb is fa's own
 *   mixing partner; two on-raster channels symmetric around a close strong one are ordinary
 *   traffic), AND fc or fc′ is off its raster or |fc − fa| ≥ INTERMOD_WIDE_HZ (100 kHz).
 * - tol = 4·max(binHz, 1 000 Hz): four FFT bins of centroid error, at least 4 kHz.
 *
 * The parent set is captured when the file ENDS (the recorder's finishFile), from a per-source,
 * per-epoch ring of recent track spans (TrackSpans): a parent whose observation closed long
 * before the keep (a provisional hold of up to 26 s) still counts.
 *
 * Bounds (arithmetic): Rule A checks 16 × 15 = 240 ordered pairs; Rule B 16 parents × at most
 * TRACK_SPANS_MAX others = 4 096 checks (subtractions only). TrackSpans holds at most
 * TRACK_SPANS_MAX = 256 spans per source (oldest dropped first) and forgets spans that ended more
 * than COPY_HORIZON_MS before the newest one heard on that source.
 */

/** Overlap of a parent with the file's span: at least half the file. */
export const INTERMOD_MIN_OVERLAP_SHARE = 0.5
/** A parent's SNR (dB). */
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

export type RasterFit = "on" | "off" | "unknown"

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
}

export interface IntermodFile {
	readonly hz: number
	readonly startSample: number
	readonly endSample: number
	readonly peakDbfs: number
	readonly binHz: number | null
}

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
	rasterOf: (hz: number) => RasterFit,
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
	const fileRaster = rasterOf(file.hz)
	for (const fa of parents)
		for (const other of concurrent) {
			if (other === fa) continue
			if (other.peakDbfs > fa.peakDbfs - INTERMOD_PARENT_MARGIN_DB) continue
			if (Math.abs(file.hz + other.hz - 2 * fa.hz) > tol) continue
			if (
				fileRaster === "off" ||
				rasterOf(other.hz) === "off" ||
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
		}
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
		return [...src.spans.values()]
	}

	forgetSource(sourceId: string): void {
		this.sources.delete(sourceId)
	}
}
