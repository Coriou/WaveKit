/**
 * WG15 DQ frozen contract (docs/specs/detection-quality): admission, association and the
 * data-vs-voice gate. Constants only; each comment carries the arithmetic behind its value.
 * Core only: nothing here crosses `packages/api-types`.
 */

/**
 * Req 1.2: an undecoded overload-flagged observation creates a record only at or above this
 * channel SNR. 25 = measured noise maximum 15 dB + 10 dB, and 5 dB under the real-user median
 * of 30 dB; intermod 48 to 55 dB below a clipping carrier measures under it on a floor 66 dB
 * below full scale.
 */
export const DQ_OVERLOAD_CREATE_SNR_DB = 25

/**
 * Req 1.3, 1.4: an undecoded, not overload-flagged observation creates a record at or above
 * this SNR. 18 = noise maximum 15 dB + 3 dB; admits 26 of 27 measured real non-overload users
 * and 3 of 49 noise records.
 */
export const DQ_CREATE_SNR_DB = 18

/** Req 1.4: distinct observation ids a pending entry needs before it can promote. */
export const DQ_PENDING_MIN_OBS = 3

/**
 * Req 1.4: median SNR of a pending entry's retained samples that promotes it. 15 dB is the
 * measured noise maximum; noise medians sit near 12 dB (10 to 15 dB uniform: 12.5).
 */
export const DQ_PENDING_MEDIAN_SNR_DB = 15

/** Req 1.5: fixed pending window from the first sample, 10 min = 10 × 60 000 ms. */
export const DQ_PENDING_WINDOW_MS = 600_000

/**
 * Req 1.5: pending entries per source. 2 400 000 / 2 500 Hz buckets = 960 buckets in a
 * 2.4 Msps window, so 512 covers more than half; 512 × about 300 B ≈ 150 kB per source.
 */
export const DQ_PENDING_PER_SOURCE = 512

/**
 * Req 1.5: retained samples per entry (top SNRs). 5 ≥ 3 needed, so the median of the first 3 to
 * 5 distinct ids is exact; 5 × about 40 B per sample.
 */
export const DQ_PENDING_SAMPLES = 5

/** Pending bucket width in Hz: `Math.round(centreHz / 2 500)`, one PMR/NFM half raster step. */
export const DQ_PENDING_BUCKET_HZ = 2_500

/** Req 2.1, 2.2: cross-family sticky search radius, min(tolerance, 1 000 Hz). */
export const DQ_CROSS_FAMILY_HZ = 1_000

/** Req 2.1: observation OBW over record median OBW must lie in [0.5, 2] (a factor of 2 each way). */
export const DQ_OBW_RATIO_MIN = 0.5
export const DQ_OBW_RATIO_MAX = 2

/**
 * Req 2.3: co-channel partners kept per record. Worst measured cluster had 7 records in one
 * association window (at most 2 × 2 000 = 4 kHz); 8 holds it unmerged.
 */
export const DQ_CO_CHANNEL_MAX = 8

/**
 * Req 2.4: identity split distance band, [6 000, 30 000] Hz: above one 6.25 kHz-class adjacent
 * leak minimum and within about two 12.5 kHz channels.
 */
export const DQ_IDENTITY_SPLIT_MIN_HZ = 6_000
export const DQ_IDENTITY_SPLIT_MAX_HZ = 30_000

/** Req 2.4: decode interval widened by 2 000 ms each side for the overlap test. */
export const DQ_IDENTITY_OVERLAP_MS = 2_000

/** Req 2.4: only a record at least 10 dB (a factor of 10 in power) weaker is refused. */
export const DQ_IDENTITY_WEAKER_DB = 10

/** Req 2.4: identity split applies only to digital-voice source ids. */
export const DQ_IDENTITY_PROTOCOLS: readonly string[] = Object.freeze([
	"dmr",
	"p25p1",
	"p25p2",
	"ysf",
])

/**
 * Req 3.1: level split. A strong transmission and an ambient carrier differ by 20 dB or more
 * (measured: 0 dBFS vs -28 dBFS = 28 dB).
 */
export const DQ_LEVEL_SPLIT_DB = 20

/** Req 3.1: OBW split ratio, 1.5 (measured 6 kHz vs 3 to 4 kHz = 1.5 to 2). */
export const DQ_OBW_SPLIT_RATIO = 1.5

/** Req 3.1, 3.5: history needed before compatibility is decided (otherwise unknown). */
export const DQ_MIN_HISTORY_OBS = 3

/** Req 4.1: data reception within 1 250 Hz of the close (half a 2.5 kHz raster step). */
export const DQ_DATA_FREQ_HZ = 1_250

/** Req 4.1, 4.3: a close is held 1 000 ms (a decode lands within 1 s of the burst). */
export const DQ_DATA_HOLD_MS = 1_000

/**
 * Req 4.5: held closes per tracker. A published transmission needs ≥ 500 ms, so at most 3 close
 * in one 1 s hold; 8 leaves margin.
 */
export const DQ_DATA_HELD_MAX = 8

/** Req 4.5: reception ring; 256 / 16 per s = at least 16 s of one busy source, ≈ 8 kB. */
export const DQ_DATA_RING = 256

/** Req 4.5: accepted receptions per source per 1 s bucket; the 17th and later are dropped. */
export const DQ_DATA_RATE_PER_S = 16

/** Req 7.3, 7.8: records per consolidation group, the survivor included (at most 15 absorbed). */
export const DQ_CONSOLIDATE_GROUP_MAX = 16

/**
 * Req 7.3, 7.7, 7.8: index entries visited per survivor (nearest first) before any predicate, so
 * a dense colocated set costs at most 32 checks per record.
 */
export const DQ_CONSOLIDATE_SCAN_MAX = 32

/**
 * Req 9.2, 9.6: OBW band factor of a record neither decoded nor carrying an identity:
 * `[obwMin / 3, obwMax x 3]`. 3 = the measured span of one emitter, 13 to 39 kHz (39 / 13 = 3.0),
 * so a record holding any one of its observations accepts every other. Decoded or identified
 * records keep `DQ_OBW_RATIO_MAX` (2).
 */
export const DQ_YOUNG_OBW_RATIO = 3
