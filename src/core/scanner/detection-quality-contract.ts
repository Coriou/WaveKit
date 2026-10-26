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

/**
 * Req 1.4c: a short observation (under `DQ_SHORT_BURST_BLOCKS`) creates on the threshold only when
 * its own track SNR is also at least 15 dB, the measured noise maximum (the pending median
 * below). The 18 dB threshold reads the best of the slot, best covering slot and matched-window
 * SNRs, a maximum over several noisy readings: a weak burst whose own SNR is 12 to 14 dB read
 * 18.2 dB once in a recorded band capture. Such a burst waits for a second and third sighting (1.4)
 * instead; a longer observation keeps the threshold alone (a wide track judged at its best slot).
 */
export const DQ_CREATE_TRACK_SNR_DB = 15

/**
 * Req 1.4c: blocks under which an observation is a short burst. 20 blocks = 1 000 ms at the
 * default 50 ms integration (2 000 ms at 100 ms): the store's first re-ingest of a live
 * observation comes 1 000 ms after its start, so only a burst that closed sooner, or the
 * gate-pass ingest, is judged short.
 */
export const DQ_SHORT_BURST_BLOCKS = 20

/** Req 1.4: distinct observation ids a pending entry needs before it can promote. */
export const DQ_PENDING_MIN_OBS = 3

/**
 * Req 1.4: median SNR of a pending entry's retained samples that promotes it. 15 dB is the
 * measured noise maximum; noise medians sit near 12 dB (10 to 15 dB uniform: 12.5).
 */
export const DQ_PENDING_MEDIAN_SNR_DB = 15

/**
 * Req 1.4b (amendment 10): a sustained observation promotes on duration. The median channel SNR of
 * its run must reach 12 dB = the channel gate pass level (k 3 dB + margin 3 dB = 6 dB) + 6 dB,
 * four times the pass power. Measured: FM broadcast tracks at 11 to 13 dB held 30 s, real narrow
 * emitters at 7 to 17 dB; one continuous emitter is one observation, so 1.4 alone never fires.
 */
export const DQ_SUSTAIN_MEDIAN_SNR_DB = 12

/**
 * Req 1.4b: a run sample under 9 dB ends the run. 9 = the gate's burst pass level (k 3 + burst
 * margin 6): below it the channel is back near the noise the gate already rejects.
 */
export const DQ_SUSTAIN_FLOOR_SNR_DB = 9

/**
 * Req 1.4b: the run must span 3 000 ms from its first sample. 3 s = 60 blocks of 50 ms, ten times
 * the 300 ms gate minimum; the store re-ingests a live observation every 1 000 ms, so a 3 s run
 * holds 4 samples (3 s / 1 s + 1).
 */
export const DQ_SUSTAIN_MS = 3_000

/** Req 1.4b: samples a run needs (3 of the 4 a 3 s run holds, so one skipped ingest still counts). */
export const DQ_SUSTAIN_MIN_SAMPLES = 3

/**
 * Req 1.4b: a gap above 2 500 ms between samples restarts the run: two 1 000 ms ingest periods
 * plus 500 ms of slack, so one missed ingest keeps it and a closed-then-reopened track does not.
 */
export const DQ_SUSTAIN_MAX_GAP_MS = 2_500

/** Req 1.4b: newest samples a run keeps for its median (2 × the 4 a 3 s run needs). */
export const DQ_SUSTAIN_SAMPLES = 8

/**
 * Req 1.4b: runs per source, the same budget as pending entries. 512 × (40 B id + 8 × 8 B + 32 B)
 * ≈ 70 kB per source; the oldest run is evicted first.
 */
export const DQ_SUSTAIN_PER_SOURCE = 512

/**
 * Req 1.4d: push-to-talk airtime. Sustained runs on one channel (the pending bucket, nearest of
 * b - 1, b, b + 1) add up for 60 000 ms from the first credited sample: an exchange of three
 * 2 s transmissions with 25 s gaps (2 + 25 + 2 + 25 + 2 = 56 s) fits. A transmission that ends
 * banks the span of its unbroken run, first to latest accepted sample (the store samples at gate
 * pass, 1 000 ms later and at the close, so a 2 s over banks about 2 s and a flicker sampled once
 * banks nothing); the channel promotes like one run: banked plus live run 3 000 ms, 3 samples,
 * median 12 dB.
 */
export const DQ_PTT_WINDOW_MS = 60_000

/**
 * Req 1.4d: airtime entries per source, the pending budget. 512 × (8 × 8 B SNRs + 8 × 40 B ids +
 * 48 B) ≈ 220 kB per source; the oldest entry is evicted first.
 */
export const DQ_PTT_PER_SOURCE = 512

/** Req 1.4d: distinct run ids an airtime entry remembers (for retraction), oldest dropped first. */
export const DQ_PTT_IDS_MAX = 8

/**
 * Req 1.15 (amendment 10): an evidence-less observation creates a record only when its segment
 * stands at least 6 dB over its local floor (median of the neighbouring 12.5 kHz each side):
 * the gate's own pass margin (k 3 + margin 3), now against the neighbourhood, so a raised
 * plateau of busy channels or splatter is not an emitter of its own.
 */
export const DQ_LOCAL_SNR_DB = 6

/**
 * Req 1.15 (amendment 10): no evidence-less create within 12 500 Hz of the tuned centre. The
 * receiver's DC pedestal (LO leakage, 1/f noise) peaked 5.5 kHz from DC in the hunt captures;
 * 12.5 kHz = about twice that, one land-mobile channel. A decode still creates there (ADS-B on
 * its centre is decode-proven).
 */
export const DQ_DC_ADMIT_HZ = 12_500

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
