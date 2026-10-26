# Detection quality requirements (WG15 DQ)

Status: reviewed design, not implemented (2026-10-24; revised after spec review the same
day). Amendment (reviewed 2026-10-25): sections 7 and 8. Amendment (draft 2026-10-25):
section 9. See [design](design.md) and [tasks](tasks.md).

## Scope

A watch of a busy narrowband band (PMR446, 1.024 Msps, high manual gain) showed the
discovery list filling with records that are not emitters, one emitter split over several
records, a strong transmission folded into a weak ambient neighbour, and pager bursts
published as analog voice. This spec fixes the store, tracker and Activity rules behind
those four faults, and records the fifth observation ("discoveries rarely update") as a
measurement finding with an acceptance item.

Measured background (rounded, synthetic descriptions):

- The front end clipped: a 0 dBFS carrier produced intermod products 48 to 55 dB down,
  each born on an `overload`-flagged observation, and each became a discovery. About a third
  of the listed records were born on an overload-flagged observation. The strong real
  transmissions were overload-flagged too.
- Of about 200 listed records, a heuristic verdict table rated about 37 real, 94 noise (of
  them 45 overload-born), 52 duplicates and 17 ambient misattaches. Noise had a median best
  channel SNR of 12 dB (range 8 to 15 dB without overload); real users had a median best SNR
  of 30 dB (range 15 to 60 dB).
- One DMR emitter seen as analog-fm by one classifier and as fsk4 by another, about 200 Hz
  apart, gave two records that never converged; a steady carrier gave a dozen records within
  50 Hz of each other, each listing ten or more co-channel partners.
- A strong (0 dBFS, 6 kHz) transmission 564 Hz from a weak ambient carrier (-28 dBFS, 3 to
  4 kHz) merged into the ambient record, raised its best level by about 27 dB and changed its
  class to the transmission's.
- Every pager burst on one channel (1.6 to 2.1 s, constant-envelope FSK) was published as a
  voice analog-transmission Activity row, each with a clean pager decode within 1 s on the
  same frequency and source.

In scope: requirements 1 to 4 (behaviour changes) and 5 (finding, acceptance item).
Amendment: requirement 7 (consolidation of records the store already holds) and
requirement 8 (passive cost guard judged on passive's marginal cost), which replace
follow-up 6.3's guard part. Amendment: requirement 9 (young records and weak protocol
guesses), which amends 2.1, 3.1, 3.2, 3.5 (young records), the family test of `keyTarget` and `settle`, and 7.1.

Out of scope (follow-ups, section 6): band-plan rasters for passive placement; a fixed
2.5 kHz grid key independent of OBW (needs a stored-record key migration); any change to
`packages/api-types`.

Safe-default rule for the whole spec: when an input a rule needs is unknown, non-finite or
malformed, the store rules fall back to the behaviour that **does not create** a new record
and **does not raise** a stored level or identity. The Activity rule (requirement 4) is the
exception: unknown inputs mean **no suppression** (publish as today), because a lost voice
row is worse than a spurious one.

## 1. Admission: no discovery without signal

As an operator I want a discovery to mean "something transmitted here", so the list is not
filled with intermod products and noise.

1.1 An observation is **evidence-less** when its ingest carries no decode evidence that
proves the signal (`decodeProvesSignal` is false). Decode-proven ingest keeps today's path
and is exempt from 1.2 to 1.5.

1.2 An evidence-less observation flagged `overload` that matches no existing record shall
create a discovery only when its channel SNR is at least `DQ_OVERLOAD_CREATE_SNR_DB` =
25 dB, and shall never enter pending. 25 dB sits 10 dB above the measured noise maximum
(15 dB) and 5 dB below the real-user median (30 dB); intermod products 48 to 55 dB below a
clipping carrier measure under it on a per-bin floor 66 dB below full scale in all but the
strongest cases (see 1.9 counts). An overload-flagged observation may still join an existing
record (subject to 3.1), and shall not raise its `signal.best` (3.2).

1.3 An evidence-less observation not flagged `overload` that matches no existing record
shall create a discovery when its channel SNR is at least `DQ_CREATE_SNR_DB` = 18 dB.

1.4 Otherwise (not overload, SNR under 18 dB, finite) the observation shall be held as
**pending** (not stored, not surfaced, not persisted, no Activity or WebSocket change). A
pending entry is promoted, creating a discovery from the promoting observation, when either:

- one of its observations reaches 18 dB, or
- it holds at least `DQ_PENDING_MIN_OBS` = 3 distinct observation ids and the median of
  their SNRs is at least `DQ_PENDING_MEDIAN_SNR_DB` = 15 dB.

  1.4b (amendment 10) **Sustained promotion.** A continuous emitter (FM broadcast, a
  steady carrier) is one observation for as long as it is on, so the repeat rule of 1.4 can
  never fire for it; replayed hunt captures showed FM broadcast tracks at 11 to 13 dB held for
  30 s and real narrow emitters at 7 to 17 dB that never got a record. A not-overload,
  evidence-less observation therefore also creates a discovery when one observation id holds a
  **run** of samples (the store re-ingests a live observation every 1 000 ms) such that:

- every sample is at least `DQ_SUSTAIN_FLOOR_SNR_DB` = 9 dB (the gate's burst pass level,
  k 3 + burst margin 6); a lower sample ends the run;
- no two consecutive samples are more than `DQ_SUSTAIN_MAX_GAP_MS` = 2 500 ms apart (two
  ingest periods plus 500 ms); a longer gap starts a new run;
- the run spans at least `DQ_SUSTAIN_MS` = 3 000 ms from its first sample (60 blocks of
  50 ms, ten times the 300 ms gate minimum) with at least `DQ_SUSTAIN_MIN_SAMPLES` = 3
  samples;
- the median of its newest `DQ_SUSTAIN_SAMPLES` = 8 samples is at least
  `DQ_SUSTAIN_MEDIAN_SNR_DB` = 12 dB (the gate pass level 6 dB + 6 dB, four times the pass
  power).

  A run is memory only (like pending), keyed by observation id, at most
  `DQ_SUSTAIN_PER_SOURCE` = 512 runs per source (oldest evicted first; about 70 kB). A closing
  observation's run ends after its last sample; a retune, source removal or a retraction
  (1.6, flags) drops it; the pending sweep drops runs idle for more than 2 500 ms. A sustained
  create consumes the bucket's pending entry like a threshold create.

  1.4c **Short weak bursts need corroboration.** The 18 dB rule of 1.4 reads the best of the
  slot, best covering slot and matched-window SNRs, a maximum over several noisy readings. An
  observation of fewer than `DQ_SHORT_BURST_BLOCKS` = 20 blocks (1 000 ms at 50 ms
  integration, so a burst that closed before the store's first re-ingest) therefore creates
  on that rule only when its own track SNR is also at least `DQ_CREATE_TRACK_SNR_DB` = 15 dB
  (the measured noise maximum); otherwise it is held as pending (1.4) like any weak sighting.
  Non-finite blocks or track SNR never corroborate. Measured on a private band capture: a
  weak periodic burst (track SNR 12 to 14 dB, best slot 16 to 18.2 dB) passed the gate once in
  120 s and made a one-sighting record; with 1.4c it makes none, and the five real emitters
  keep their records. Fixtures: a 19-block
  burst at an 18 dB best slot creates with a 15 dB track SNR and not with 14.99 dB; at 20
  blocks the threshold alone creates; the same weak burst seen three times creates (1.4).

  1.4d **Push-to-talk airtime.** Separate transmissions are separate observations, so a
  channel used in 2 to 10 s overs never forms a 3 s run (1.4b). A transmission that ends
  without promoting, and whose run was sampled at least twice, banks its run's span and
  samples on its channel (the pending bucket, nearest of b - 1, b, b + 1, so adjacent
  8.33 kHz channels bank apart). A later sample on that channel promotes when the banked
  airtime plus the live run's span reaches `DQ_SUSTAIN_MS` = 3 000 ms, with at
  least 3 samples whose median (banked and live, newest 8 banked) is at least 12 dB. An entry
  lives `DQ_PTT_WINDOW_MS` = 60 000 ms from its first banking (three 2 s overs with 25 s gaps
  fit), at most `DQ_PTT_PER_SOURCE` = 512 entries per source and `DQ_PTT_IDS_MAX` = 8 ids per
  entry; memory only. A create there, a retune or source removal drops it; a retraction of
  any banked id drops the whole entry, and a ninth id restarts the entry empty (so every id
  holding credit stays retractable). A run's span only ever runs from an accepted
  sample through its latest accepted sample: a sample under 9 dB or a gap over 2 500 ms ends
  the run (a closing sample under 9 dB banks the run through its last accepted sample), and
  the time before the first accepted sample never counts. A duration that is non-finite, negative or longer
  than the window counts 0. Fixtures: 1 500 ms banked plus a 1 500 ms over promotes and 1 ms less
  does not; a below-floor first sample or close adds no time; a median of 12 dB promotes and 11.99 dB does not; banked airtime counts
  59 999 ms after banking and not 60 000 ms; a transmission sampled once banks nothing; three
  synthetic 2 s AM voice overs at about 13.5 dB best-slot SNR make one record, one over none;
  two adjacent 8.33 kHz channels taking turns make two records; 20 s of noise makes none.

  1.4e **Edge band.** The detector, segmenter and channel gate see
  `DETECTION_USABLE_FRACTION` = 0.95 of the captured span (±486.4 kHz at 1.024 Msps:
  0.95 × 512 kHz), while windows, hop plans, probes, IQ capture and the activity history keep
  `USABLE_FRACTION` = 0.8 (±409.6 kHz). On a private RTL capture the median floor fell 1.9 dB
  from mid-band to 0.93 to 0.95 of Nyquist and 2.4 dB over the last 3 %: still the passband
  shoulder, so the per-bin floor keeps an SNR there meaningful; the outer 5 % (25.6 kHz a side)
  stays masked against energy folded back from past Nyquist. A segment reaching within the gap
  tolerance of the 0.8 bound is flagged `edge` in window (`truncated` in a sweep). An edge track
  passes the same channel gate, its observation keeps `flags.edge`, it never votes a class (3.4;
  the record shows `unknown`), it is never held to confirm, channel-refined, IQ-captured, burst-captured or given an automatic analog trial
  (whose whole channel and the track centre must lie inside the 0.8 span, refusal `edge` or
  `out-of-window`), and
  on the 18 dB rule of 1.4 it never takes the long-track exemption of 1.4c: its own track SNR
  must also reach `DQ_CREATE_TRACK_SNR_DB` = 15 dB however long it lasts. The image check of
  § 4.9 is symmetric and runs over the whole detection span. Fixtures: an OOK burst at 0.93 of
  Nyquist passes a burst gate and makes one record flagged edge (none with a 0.8 span); a tone
  past 0.95 makes no track; a 30 dB image of a strong carrier at 0.9 and 0.92 of Nyquist is
  flagged and makes no record; a 150 ms tone about 7 dB over the floor at 0.9 does not pass a
  12.5 kHz gate; a 60-block edge track at 18 dB with an 8 dB track SNR makes no record (one
  mid-span), and an edge track creates at a 15 dB track SNR and not 14.99 dB.

  1.5 Pending expiry is a **fixed window anchored at the entry's first sample**: an entry is
  deleted `DQ_PENDING_WINDOW_MS` = 600 000 ms (10 min) after its first sample, whatever
  arrived since; samples are never re-anchored. An observation arriving after deletion starts
  a new entry. So "3 observations in 10 min" means 3 distinct ids whose times lie in
  [first, first + 600 000 ms). Bounds: at most `DQ_PENDING_PER_SOURCE` = 512 entries per
  source and `DQ_PENDING_SAMPLES` = 5 samples per entry (a sixth distinct id replaces the
  lowest-SNR sample, so the median never drops because of the cap); when a source is full,
  the entry with the oldest first sample is evicted. Arithmetic in the design.

  1.6 A re-ingest of an observation id already in a pending entry updates that sample (its SNR
  becomes the larger of old and new; its time stays) and does not count as another
  observation.

  1.7 Safe defaults: an evidence-less observation with a non-finite or absent centre, a
  non-finite SNR or an absent `overload` flag is rejected (transient): it neither creates a
  record nor enters pending.

  1.8 The tracker shall count only blocks with channel SNR >= k (`CHANNEL_GATE_K_DB`, 3 dB)
  toward the gate's minimum on-time (300 ms, burst 100 ms). Blocks between k - 1.5 dB and k
  keep the run alive (hysteresis, unchanged) and the one tolerated off block stays, but neither
  counts toward the duration. With 50 ms blocks a run needs 6 strong blocks (burst: 2). The
  margin rule is unchanged (best block >= k + 3 = 6 dB; burst 9 dB). When a track inherits a
  run (`inheritRun`), the strong-block count is copied with the other run fields.

  1.9 Measured effect (verdict table, record best SNR; an upper bound per create decision
  because a record's best can come from a later observation):

| Rule                                 | Noise (94) | Real (37) |
| ------------------------------------ | ---------- | --------- |
| Today (gate only)                    | 94         | 37        |
| Overload >= 25 dB                    | 8 of 45    | 8 of 10   |
| Not overload >= 18 dB                | 3 of 49    | 26 of 27  |
| Repeat rule (upper bound, see below) | at most 10 | at most 1 |
| Total admitted                       | at most 21 | 34 to 35  |

The repeat rule cannot be evaluated exactly from stored records (it needs per-window
medians); the bound counts non-overload records with best 15 to 18 dB and at least 3
observations. Real records lost: two overload-born at 15 and 23 dB best (each still created
later if a non-overload sighting qualifies) and one at 17 dB with 4 observations (created if
its median reaches 15 dB).

1.10 Regression fixtures (observation and track level, synthetic):

- **Noise only.** Floor -66 dBFS per 1 kHz bin; one non-overload track repeating every 1.5 s
  for 10 min at a fixed centre, OBW 10 to 13 kHz, channel SNR 8.6 to 9.6 dB. Expect no
  discovery.
- **Recurring 10 to 15 dB noise.** Tracks at one centre every 20 s for 30 min, SNR drawn
  uniformly in 10 to 15 dB (median about 12.5). Expect no discovery.
- **Intermod.** A clipping carrier (+0.8 dBFS peak, OBW 7 kHz, 3.3 s, overload, SNR 48 dB)
  and three simultaneous overload tracks 0.3 to 1.4 MHz away at SNR 20, 12 and 9 dB (OBW 16
  to 35 kHz). Expect exactly one discovery (the carrier) and none for the products.
- **Undecoded strong analog.** An overload-flagged NFM over with no decode, SNR 30 dB. Expect
  one discovery. The same over at 22 dB: no discovery and no pending entry.
- **Weak repeat.** Non-overload sightings at 16, 15 and 17 dB within 4 min. Expect no
  discovery after the first two and one discovery at the third.
- **Boundaries.** 18.0 dB creates, 17.99 dB is held; overload 25.0 creates, 24.99 does not; a
  third sample exactly at first + 599 999 ms counts, at first + 600 000 ms starts a new entry;
  median exactly 15.0 promotes.
- **Duplicate ids.** One observation id re-ingested 3 times at 16 dB. Expect one sample, no
  discovery.
- **Invalid centres.** NaN, +Infinity and absent centre; NaN SNR. Expect transient, no pending
  entry.
- **Hysteresis.** 50 ms blocks alternating 2.0 dB and 6.5 dB: 10 blocks (500 ms) hold 5
  strong blocks = 250 ms < 300 ms and do not pass (today they pass on 10 counted blocks);
  12 blocks hold 6 strong blocks = 300 ms with best 6.5 >= 6 dB and pass. A run split by
  `inheritRun` after block 6 passes at the same block as an unsplit run.

  1.11 (amendment 10) **Peak channel.** The creation SNR (`peakChannelSnrDb`, admission only)
  is the highest of: the track's channel SNR; its best single covering slot when it is wider
  than one slot (max(p_i / f_i) >= sum(p) / sum(f), the summed reading is unchanged for the gate);
  and, for a narrow carrier only (matched width at most one 6.25 kHz slot,
  `CHANNEL_GATE_MIN_WIDTH_HZ`), its **matched-window SNR**: the highest mean power of W contiguous segment bins over
  the local floor of 1.15 (median of 12.5 kHz each side), W = the track's OBW in bins, at
  least `MATCHED_MIN_BINS` = 2 and at most the segment (a 1-bin segment may borrow the bin next
  to each edge). A window counts only with at least 2 bins `MATCHED_SUPPORT_DB` = 3 dB or more
  over that floor: an emission spans 2 bins. The gate's own pass rule still reads
  the slot SNR. A slot spreads a narrow carrier over the whole slot: a 1 kHz carrier 15 dB
  over the floor in an 8.33 kHz slot reads 10·log10((31.6 + 7.33) / 8.33) = 6.7 dB, under the
  9 dB run floor of 1.4b, so the hunt captures' VDL2 and airband carriers never sustained.
  Matched to its width it reads 12 to 15 dB. A single hot bin with its neighbours on the floor
  has no matched SNR (no second supporting bin), so admission reads its slot SNR, and spur
  lines are dropped before tracking anyway. Fixture: a tone whose slot SNR is 5.9 to 6.2 dB and whose matched SNR is
  12.4 to 12.9 dB is not admitted at 2.5 s and is admitted by 5 s.

  1.12 (amendment 10) **Airband slots.** A range whose protocols include `analog-am` and which has
  more than one raster sizes its channel slots by its finest raster (`slotRasterOf`): airband
  uses 8.33 kHz slots, not 25 kHz. An AM voice channel occupies about 6 kHz (2 x 3 kHz audio);
  a 25 kHz slot adds 25 / 8.33 = 3 x the noise, 4.8 dB, which put measured AM voice at 4 to
  6.5 dB channel SNR under the 6 dB pass. Every 25 kHz airband channel lies on the 8.33 kHz
  grid (exact thirds), so none loses its slot.

  1.13 (amendment 10) **One emitter, one segment.** Adjacent channels and splatter chained into
  segments 80 to 350 kHz wide (one 1.4 MHz) in the hunt captures, so a busy band gave one
  wideband record for several emitters, or none. The segmenter shall, per block:

- cut a run at a valley at least `DIP_SPLIT_DB` = 6 dB below the highest level on both sides,
  measured on the power smoothed over `DIP_SMOOTH_HZ` = 2 kHz (3 bins at 1 kHz; under a third
  of the narrowest 6.25 kHz raster), when the valley also lies in the lower
  `DIP_FLOOR_FRACTION` = 0.5 of the smaller side's height above the floor (the two lobes of
  one FSK pager keep their valley high above the floor);
- cut at the channel edges of every raster in the masks, each bounded to its range. While the
  passive job runs, the masks also carry the band plans' rasters (as the channel plan already
  carries their slots), so a busy band splits although the passive range has no raster;
- never merge back a piece without a 6 dB valley (the existing prominence rule) across a
  channel edge of the coarsest raster of its range (25 kHz on airband, 12.5 kHz on land
  mobile), so a plateau of busy channels splits into one piece per channel;
- merge a piece more than `SIDEBAND_DB` = 10 dB under a neighbour peaking within 31.25 kHz
  into it whatever the valley (AM sidebands 10 to 20 dB under the carrier, splatter), across
  channel edges too;
- merge two pieces whose peaks are closer than `CHANNEL_PEAK_FRACTION` = 0.8 of the channel
  grid the gate measures there, whatever the valley: one channel holds one emitter (the two
  lobes of a +/-4.5 kHz POCSAG carrier are 9 kHz apart), across channel edges too. The grid is
  the slot raster of the channel-plan entry covering each peak (`slotRasterOf`: 8.33 kHz on
  airband, so 6.7 kHz; 12.5 kHz on land mobile, so 10 kHz), the finest where entries overlap,
  and the smaller of the two peaks' limits applies; a bin no rastered entry covers has no
  one-channel rule. Two equal airband peaks 8 kHz apart with a 14 dB valley therefore stay two
  pieces (a window-wide coarsest-raster limit, 20 kHz, joined them).

  Without a raster in the window only the dip rule applies, so FM broadcast (no band plan)
  stays one segment. A track's reported OBW never exceeds its widest single-block segment
  (a weak track's -20 dB width otherwise reaches the floor and becomes the union of every
  span it drifted over).

  1.14 (amendment 10) Regression fixtures (synthetic, seeded; `tests/mocks/scanner/admission-scenes.ts`):

- **Sustained broadcast.** One observation re-ingested every second at 12 dB creates one
  record at 3 s. Boundaries: 3 000 ms promotes, 2 999 ms does not; median 12.0 promotes,
  11.99 does not; a 9.0 dB sample keeps the run, 8.99 restarts it; a 2 500 ms gap keeps it,
  2 501 ms restarts it; 512 runs per source, the 513th evicts the oldest.
- **Pure noise.** Any observation sequence at or under 11.99 dB, with any id reuse and
  cadence, creates nothing (property); seeded Gaussian noise through the pipeline, gate,
  split rules and store creates nothing (property).
- **Adjacent carriers.** Two NFM carriers 12.5 kHz apart at 20 dB (no raster) and at 15 dB
  (12.5 kHz raster) become two records at their centres.
- **Wide FM.** One FM signal 90 kHz wide stays one track and one record.
- **Airband AM.** An AM voice carrier passes the gate in its 8.33 kHz slot and not in a
  25 kHz slot.
- **Split bounds.** A 6.0 dB dip splits and 5.9 does not; a valley at half the height splits
  and 0.1 dB higher does not; a prominence merge joins across a fine edge and not across a channel edge (nor one with a
  channel edge inside), while a skirt more than 30 dB down joins across one; a
  sideband 10.5 dB under joins and 10 dB does not, at the reach and not one bin past it; lobes
  9 bins apart join under a 10-bin channel and not under a 9-bin one.

  1.15 (amendment 10) **Local contrast and DC.** Every refusal below, and every invalid-input or
  overload refusal of 1.2 and 1.7, also ends the observation's sustained run (1.4b), so a
  rejected sample never keeps a run alive. A supplied `localSnrDb` that is not finite is
  refused; only an absent one (no channel plan, or no neighbour bins) skips the local check.
  An evidence-less observation never creates a record
  when:

- its track's mean local SNR (`localSnrDb`: per block, the segment's mean power over the median
  of `LOCAL_FLOOR_HZ` = 12.5 kHz of bins each side, skipping the adjacent bin; averaged over the
  track's blocks; for a narrow carrier whose matched width fits one 6.25 kHz slot, the higher of
  that and its matched-window contrast, so a carrier with wide weak sidebands merged into its
  segment still counts) is under `DQ_LOCAL_SNR_DB` = 6 dB, the gate's own pass margin (k 3 +
  margin 3) against the neighbourhood instead of the global floor. A raised plateau of busy
  channels or splatter is then not an emitter of its own; or
- its centre lies within `DQ_DC_ADMIT_HZ` = 12 500 Hz of the tuned centre of its epoch
  (`dcCentred`), measured from the track's nearer edge (centre ± OBW/2, `dcCentredOf`): the
  receiver's DC pedestal peaked 5.5 kHz from DC in the hunt captures, and its neighbouring
  pieces lean on it,
  12.5 kHz is about twice that. A decode still creates there.

  1.16 (amendment 10) **Channel keys.** While the passive job runs, the store's placement rasters
  also hold every raster of each band plan range covering the centre. Per observation only
  the rasters at least half its OBW wide are used (`gridFor`; the coarsest when none is): a
  channel holds its emitter, so a 3 kHz airband carrier keeps the 8.33 kHz grid while a 50 kHz
  VDL2 burst keys to 25 kHz and is not split across fine channels. The observation snaps to
  the nearest of those rasters within tolerance; off every tolerance it keys to the nearest
  channel of the finest of them (`channelRasters`) instead of a grid key. One emitter whose
  measured centre drifts inside its channel stays one record, placed at its channel, and
  adjacent fine channels stay apart. On a rastered band the classifier sees at most one
  coarse channel of OBW, so no `wideband` class appears there. Fixtures: a local SNR
  of 6.0 dB creates and 5.99 dB does not; a DC-centred observation never creates, sustained or
  at 30 dB; four drifting sightings 9 to 12 kHz off a 25 kHz channel make one record at the
  channel, and 12 501 Hz off keys to the next channel; with a 25 kHz raster anchored at
  119 MHz and its 8.33 kHz companion, sightings at 119 MHz and 119 MHz + 8 333 Hz are two
  records, and one 3 kHz past the second joins it; 50 kHz sightings 4 kHz either side of a
  25 kHz channel are one record; an OBW of exactly 2 x 8 333 Hz keeps the 8.33 kHz grid and
  1 Hz more keys to 25 kHz; inside a synthetic 100 kHz plateau of
  carriers every track's local SNR is under 6 dB and no record is created, while a lone
  carrier's is above.

  1.17 **AM voice is not a bare carrier.** Inside a band plan range that lists `analog-am`
  (prior at least 1), a track whose -6 dB width is a carrier's (`narrow`) but whose -20 dB OBW
  lies in [`AM_VOICE_MIN_OBW_HZ` = 6 000, `AM_VOICE_MAX_OBW_HZ` = 12 500] Hz (speech
  sidebands; an unmodulated Hann-windowed carrier reads at most 4 bins, 5.66 kHz at the
  coarsest default bin), and that is longer than 4 blocks, is classified as AM voice: class
  `unknown` (the shared class list has no AM class) with `analog-am` as the first hypothesis,
  never `carrier`. In a range that lists AM but not FM (airband) a `peaked` track in the same
  window counts too; a flat top (data) never does. Any malformed field keeps today's class.
  An unmodulated carrier still classifies `carrier`. A weak AM carrier whose sidebands stay
  under 20 dB below the carrier (OBW from on-bins, about 3 to 4 kHz) cannot be told apart
  from a carrier and keeps that class.

## 2. One emitter, one discovery

As an operator I want one record per emitter, even when two classifiers disagree on its
family or when it is a plain carrier.

2.1 An evidence-less observation shall stick to an existing record of the same source of
**any** family when the centre distance is at most `DQ_CROSS_FAMILY_HZ` = 1 000 Hz (and
within today's tolerance), the observation OBW divided by the record's median OBW lies in
[0.5, 2], and 3.1 does not refuse the pair. The nearest such record wins (today's
tie-break). Same-family matching keeps today's tolerance.

2.2 An observation classed unknown may join a record whose effective family is `carrier`
under the 2.1 rule (the carrier exclusion in `keyTarget` no longer applies inside 1 kHz).

2.3 Co-channel links shall be pruned at refresh: a partner is kept only while it exists and
its median centre lies within the record's association tolerance. A record shall list at
most `DQ_CO_CHANNEL_MAX` = 8 partners, nearest first; on overflow the farthest are dropped
(ties: the least recently seen) and the drop is reciprocal. Justification in the design.

2.4 Applying decode evidence to record `d` shall be refused (no change) only when all hold:

- the protocol is a digital-voice radio protocol (`dmr`, `p25p1`, `p25p2`, `ysf`) and the
  decode carries a radio source id (the talker id, `metadata.sources`); channel identities
  (DMR colour code, P25 NAC, YSF DG-ID) are shared by every radio on a system and never
  count; pager capcodes, ISM ids and every other protocol are never refused by this rule; a
  decode without a source id is never refused;
- another record `o` of the same source lists one of the decode's source ids for the same
  protocol;
- the median centres of `d` and `o` are `DQ_IDENTITY_SPLIT_MIN_HZ` = 6 000 Hz to
  `DQ_IDENTITY_SPLIT_MAX_HZ` = 30 000 Hz apart (inclusive);
- the decode's observation on `d` and an observation of `o` overlap in time within
  `DQ_IDENTITY_OVERLAP_MS` = 2 000 ms;
- `d` is weaker: its median peak is at least `DQ_IDENTITY_WEAKER_DB` = 10 dB below `o`'s.

The decode stays on the stronger record; the stronger record is never refused. When neither
is 10 dB weaker, or any input is missing or non-finite, the decode applies as today. Why:
one radio keys one channel at a time; an adjacent-channel copy of its decode on a 12.5 kHz
plan appears 6.25 to 25 kHz away (measured 9.1 to 9.75 kHz) and well below the source
(the classifier's own leak cap uses 20 dB, so 10 dB is conservative).

2.5 Safe defaults: a non-finite or zero median OBW on the record, or a non-finite
observation OBW, disables the cross-family rule for that pair (today's behaviour). A
non-finite record centre is never a match.

2.6 Regression fixtures:

- **One DMR emitter, two classifiers.** Observations every 1.3 s at centres uniform within
  440 Hz, OBW 9 to 12 kHz, alternately classed analog-fm and fsk4, SNR 20 to 25 dB. Expect
  one discovery.
- **Carrier.** Twelve sightings within 50 Hz, OBW 4 to 8 kHz, SNR 21 to 32 dB, gaps 13 to 98
  min, with carrier-only analog evidence after the first. Expect one discovery with no
  co-channel partners.
- **Adjacent leak.** Record A decoded DMR talker (source id) X at f, median peak -20 dBFS; a
  decode of X on record B at f + 9.4 kHz, median peak -45 dBFS, overlapping A within 1 s.
  Expect B unchanged. Controls: a different talker on the same colour code (including two
  simultaneous radios 12.5 kHz apart), a decode without a talker id, B 5 dB weaker, B 35 kHz
  away, overlap 3 s apart, the same capcode on POCSAG records, and B stronger than A: each
  applies the decode.
- **Co-channel overflow.** Twelve records in one key window; expect at most 8 links each,
  nearest kept, reciprocal, and a pruned partner re-linked if it comes back within tolerance.

## 3. No ambient misattach

As an operator I want a strong transmission to get its own record and the ambient carrier
next to it to keep its own level and class.

3.1 Two signals are **incompatible** when both
`|peak_a - peak_b| >= DQ_LEVEL_SPLIT_DB` = 20 dB and
`max(obw_a, obw_b) >= DQ_OBW_SPLIT_RATIO` = 1.5 × `min(obw_a, obw_b)`. For an observation
against a record, the record side uses the median peak and median OBW over its last 64
observations, and the rule applies only when the record has at least 3 of them. For two
records: when both have at least 3 observations, both sides use their medians; when exactly
one has at least 3, each observation of the other (young) record is tested against the
established record's medians, and the pair is incompatible if any of them is (so `settle`
cannot fold back an observation the sticky test refused); when neither has 3, the pair is
undecided (3.5).

AND, not OR (measured): the ambient carrier varied 7 dB (-23 to -30 dBFS) with OBW ratio at
most 1.33, and the strong transmission differed by 27 dB with ratio 1.5 to 2.0, so either
rule alone splits this case. But a real mobile user fades by 20 dB or more at a fixed OBW
(level alone would split a real user), and a wide noise record's OBW swings 15 to 25 kHz
(ratio 1.67) at constant level (OBW alone would split it). Only the conjunction separates
the measured strong-next-to-ambient case from both.

3.2 Every merge path shall refuse an incompatible pair: sticky match and key match for an
observation, and `settle` and `absorb` for two records (same source, key, family and
identity today). A refused settle leaves both records and lists them as co-channel partners.

3.3 `signal.best` shall be updated only from an observation that is not flagged `overload`
and that 3.1 does not refuse: on a record with 3 or more observations it must be found
compatible; on a record with fewer than 3 (compatibility undecided) any non-overload
observation with a finite SNR may raise it, so a young real signal that gets stronger raises
its best. `signal.last` keeps today's rule. When `absorb` merges two
compatible records, the surviving best is the better of the two bests, counting a best only
when the observation that set it is not overload-flagged and, for the absorbed record's best,
is not refused by (and, with 3 or more observations, is found compatible with) the
survivor's medians. The same overload rule applies when an observation moves between records.

3.4 A record's `class` shall be the majority class of its last 64 observations (ties go to
the most recent of the tied classes; edge-flagged observations and observations classed
`unknown` do not vote, as `unknown` never overwrote a class before), not the latest
observation's class. Each observation's vote is persisted with it (an optional field of the
store's persisted and journaled observation form, never in the DTO); an observation without
the field (written before this change) does not vote. Without any vote the classification's
own class applies as before. The majority is re-applied (and journaled) whenever observations
change records: every merge (`settle`, `absorb`) and every move (`rehome`).

3.5 Safe defaults: fewer than 3 observations, or a non-finite median or observation peak or
OBW, skips 3.1 for merging (merge as today). For `signal.best` (3.3): on a record with fewer
than 3 observations an undecided result allows the update from a non-overload observation
with a finite SNR; on a record with 3 or more, a non-finite median or observation value means
the observation cannot raise `signal.best`.
The one exception is the two-record case of 3.1 with exactly one established record, whose
young side is tested observation by observation; two young records are never split.

3.6 Regression fixtures:

- **Strong 15 kHz away.** Ambient carrier at f, OBW 3 to 4 kHz, peak -23 to -30 dBFS, 20
  sightings; then a 0 dBFS, 6 kHz, overload transmission at f + 15 kHz with SNR 48 dB.
  Expect its own discovery and the ambient record's best <= -23 dBFS and class unchanged.
- **Strong 564 Hz away.** Same ambient; then a transmission at f - 564 Hz, OBW 6 kHz, peak
  -0.7 dBFS, SNR 48 dB, 3.3 s, overload, followed by f - 860 Hz, OBW 7 kHz, +0.8 dBFS,
  2.2 s. Expect one new record holding both transmission observations, ambient best <=
  -23 dBFS, ambient class unchanged.
- **Shared key.** Ambient and strong records forced onto the same placement key and family
  (refresh re-keys both to it); run `settle`. Expect two records, ambient best unchanged.
- **Fading user.** One record, OBW 11 to 12 kHz, peak swinging -30 to -55 dBFS. Expect one
  record.

## 4. Data is not voice

As an operator I want pager and data bursts not to appear as voice transmissions in
Activity.

4.1 A closed analog transmission shall not be published as an `analog-transmission` Activity
row when an accepted decoder reception matches it. A reception matches when all hold:

- `DecodeEnvelope.category` is `paging` or `aprs`;
- `provenance.sourceId` equals the transmission's source id;
- `provenance.frequency.basis` is `channel` and `tuningTrust` is `commanded` or `relay`;
- `|provenance.frequency.hz - transmission frequency| <= DQ_DATA_FREQ_HZ` = 1 250 Hz;
- the envelope's produced time lies in [start - 1 000 ms, end + 1 000 ms].

The pager decode row is the record of that burst.

4.2 For such a transmission the live-audio path shall attach **no analog proof** to the
scanner (it omits the `recordAnalog` call), so it neither gives a candidate analog-fm label
nor writes an invalid row (`heard` requires `voice: true` in the interpreter).

4.3 The decision shall wait `DQ_DATA_HOLD_MS` = 1 000 ms after close, because the measured
decode arrives 0 to +1.0 s after close. The live WebSocket `transmission` event is unchanged
(it is an api-types DTO).

4.4 No change to `packages/api-types` is needed: the row is suppressed rather than
recategorised (the category union has no `data` member). A future `data` hint on the
WebSocket event would be a Main-owned DTO change (follow-up 6.4).

4.5 Bounds, enforced in code: at most `DQ_DATA_HELD_MAX` = 8 closes held per tracker; a ring
of the last `DQ_DATA_RING` = 256 matching receptions; at most `DQ_DATA_RATE_PER_S` = 16
receptions accepted per source per second (excess dropped and counted). A close that cannot
be held, or whose window starts before the oldest retained reception after the ring has
wrapped, publishes as today. Arithmetic in the design.

4.6 Safe defaults: an envelope without provenance, without a source id or frequency, with
basis `probe`, trust `unverified`, a non-finite frequency or produced time, or another
category, never suppresses. A transmission with a null frequency or source publishes as
today.

4.7 Regression fixtures:

- **Pager.** NFM at a fixed channel on source A, pager bursts of 1.6 s and 2.1 s every 300 s,
  channel peak -29 dBFS on a -55 dBFS floor, full quieting; a matching paging decode from
  source A arrives 0 to +1.0 s after each close. Expect zero analog-transmission rows, one
  paging row per burst, and no analog proof recorded (checked through `labelFromEvidence`).
- **Two sources.** The same burst on source A, with the paging decode reported by source B
  at the same frequency. Expect the row on A published.
- **Controls.** No decode, a decode 2 kHz away, 1.5 s after close, with basis `probe`, with
  trust `unverified`, or without provenance: the row is published after the hold.
- **Overflow.** 9 closes held at once: the ninth publishes immediately; 20 receptions in 1 s
  from one source: 16 retained, 4 counted as dropped.

## 5. Finding: "rarely updated" was most likely passive being off

5.1 The spec records that, in the measured watch, discoveries did not update because no
passive job was running for most of it: the passive job ended about 60 s after an engine
open and was not rebuilt, and Activity rows cannot update discoveries by design. The
**likely but unconfirmed** cause is the passive cost guard (its first judgement falls
60 s after engine open, limit 0.25 core, clear at 0.20, and the display kept the engine
open). Alternatives the capture could not exclude: a scanner settings change that disabled
passive, a source capability change that ended the job, and a retune-path ending of the job.
The guard change is requirement 8 (amendment).

5.2 Every detection-quality acceptance run shall record `/api/scanner/status`
`sources[].passive` (`enabled`, `disabledReason`) alongside its discovery snapshots, at the
same cadence, and report the passive-on fraction of the run.

## 6. Follow-ups (not in this spec)

6.1 Band-plan rasters for passive placement (`rastersAt` returns the band-plan rasters the
passive channel plan already uses), so one PMR emitter keys to one raster key at any OBW.

6.2 A fixed 2.5 kHz grid key independent of OBW, with a migration of stored `g:` keys.

6.3 Passive cost guard: now requirement 8. Still a follow-up: optional ingest of trusted
decoder receptions as discovery updates when no job runs.

6.5 REST resolution of an absorbed discovery id (`GET /api/scanner/discoveries/:id` for an
id merged away answering with, or redirecting to, its survivor). Needs an API decision;
requirement 7 behaves like every existing merge (the absorbed id is gone).

6.4 An optional data hint on the analog-transmission WebSocket event (Main-owned DTO change
in `packages/api-types`).

## 7. Legacy consolidation

As an operator I want the duplicates the store already holds folded into one record, so
that a record I watch is the one that updates.

Measured background (rounded): in a 60-minute watch with passive on, several pairs of
records 100 to 600 Hz apart, of compatible bandwidth and on the same placement key, were
both updated during the run (a DMR pair, an unknown/analog pair, and clusters of three or
four records on two PMR channels). An offline replay of a store copy (about 4 200 records)
found about 160 groups that requirement 7.1 joins, absorbing about 190 records (4.5 %); most
groups have two members, one has twelve.

Root cause (design, section 7): requirement 2.1 joins an _observation_ to the nearest record
within 1 kHz, but nothing joins two _records_. `settle` merges only records on the same
key with the same effective family and identity, and only the record an operation touched.
So two records created before 2.1 (or on different OBW-dependent grid keys, or with
different effective families) both stay, and centre jitter larger than their separation
sends each new observation to whichever is nearer: both keep updating.

7.1 Two records `a` and `b` are **joinable** when all hold:

- same first source id;
- finite median centres at most `DQ_CROSS_FAMILY_HZ` = 1 000 Hz apart (the key is not
  consulted);
- finite, positive median OBWs whose ratio (wider over narrower) is at most
  `DQ_OBW_RATIO_MAX` = 2 (the 2.1 range [0.5, 2] seen from either side);
- `recordsCompatible(a, b)` (3.1) is not false, and not null when either side has 3 or more
  observations;
- their identities do not conflict: not both defined and different (`sameIdentity`);
- their effective families are equal, or at least one is `unknown` or `carrier`;
- not both `decoded` with different protocols;
- neither carries operator state (`operator.label`, `notes`, `lockout` or `keep`).

Why each: the first four are the 2.1 and 3.1 predicates an observation already passes to
join either record, so a record pair that each observation could join is one emitter.
Identity and family keep the co-channel split the store makes on purpose (an analog record
and its decoded digital twin on one channel, two colour codes on one channel). Operator
state is never merged silently (a lockout on a duplicate would lock out the real emitter).

7.2 **Rank.** Records are totally ordered by: `decoded` before any other confidence, then
the earliest `firstSeenAt`, then the smaller id. "Ranked above" means earlier in this order.

7.3 **Load plan.** Once per load, after the snapshot is restored and the journal replayed
and before the first ingest, the store computes a plan from the restored records as they
are at that moment (the **frozen** state: centres, OBWs, peaks, counts and labels are read
once and never re-read while planning):

1. Records are visited in rank order; each visited record not yet **owned** is a possible
   survivor `s`.
2. **Enumeration (bounded before any predicate).** Among the records of `s`'s source, the
   `DQ_CONSOLIDATE_SCAN_MAX` = 32 nearest to `s`'s frozen centre (by absolute distance,
   ties by smaller id) with a distance of at most 1 000 Hz are the **scanned set**. Owned
   records and records ranked above `s` count toward the 32 and are skipped.
3. **Selection.** Of the scanned set in nearest-first order, a record is a member when it is
   joinable to `s` (7.1, on frozen values), until `DQ_CONSOLIDATE_GROUP_MAX` = 16 records
   (the survivor plus at most 15 members) are in the group.
4. If the group has a member, it is added to the plan, and `s` and every member become
   owned. **Ownership is immutable**: an owned record is never a survivor or a candidate
   again in this plan.

Because every distance is measured from the survivor's frozen centre and owned records are
never revisited, a group's members are all within 1 000 Hz of the survivor's pre-plan
centre: no chaining (records at f, f + 900 Hz and f + 1 800 Hz give one group of two and
leave f + 1 800 Hz alone in that plan).

7.4 **Incomplete-result contract.** The plan is complete only for the scanned sets. A
survivor whose scanned set held 32 records, or whose group filled at 16 while another
scanned record was joinable, is counted as **truncated**; the store logs one info line
with the group count, the absorbed count and the truncated count. Joinable pairs left by
truncation, by a member that 7.5 refuses, or by the next load's changed medians are left
for the next load's plan or the lazy path (7.7); there is no second pass in the same load.

7.5 **Execution.** Each group is one store operation: the members are absorbed into `s` in
selection order with today's `absorb` (observations moved, `observationCount` and
`airtimeMs` summed, `firstSeenAt`/`lastSeenAt` widened, `signal.best` by 3.3,
`signal.last` from the later record, metadata, job ids, source ids and evidence unioned,
majority class by 3.4, co-channel links re-pointed and pruned by 2.3, the absorbed id's
recording folder adopted as an alias). The 3.2 guard for a planned pair is the plan's
frozen 7.1 check (3.1 included); it is not re-run against medians the group's earlier
members already moved, because that would make the result depend on the apply order and a
resumed plan differ from an uninterrupted one. A survivor or member that carries operator
state when the group runs (set after the plan was written) is skipped. The absorbed ids are
deleted as in every existing merge.

7.6 **Durability.** The plan is written atomically to a plan file before the first group
runs. Each group is journaled with an existing journal op name (`rekey`) and the existing
mutation payload (discoveries, observations, `deleted`, `aliases`), exactly the shape a
`settle` merge writes, so a reader without this change replays it unchanged. On load, a
plan file left by an interrupted load is resumed (each group: absorb the members that still
exist into its survivor if the survivor exists) instead of computing a new plan. The plan
file is deleted only after a snapshot written after the last group is durable. So a crash
at any point gives the same end state as an uninterrupted run, and a downgrade to a reader
without this change sees ordinary merges (and ignores the plan file).

7.7 **Lazy path.** On every sticky match (2.1) to record `m`, the store scans the 32
records nearest to `m`'s current median centre within 1 000 Hz (the same bounded
enumeration as 7.3, centred on `m`, not on the observation). The group's survivor is the
highest-ranked of `m` and the scanned records joinable to `m`; members are the scanned
records (and `m`) joinable to that survivor and within 1 000 Hz of `m`, at most 15. They are
absorbed in the observation's operation before the observation is added, so the
observation lands on the survivor. Lazy merges emit `deleted` and `merged` changes as every
merge does.

7.8 **Bounds.** At the default `maxDiscoveries` 10 000: planning sorts the records twice
(rank, and centre per source: O(n log n)) and visits at most 32 index entries per record,
so at most 320 000 entry visits and at most 320 000 predicate checks, whatever the density
(10 000 colocated records that are mutually not joinable cost 320 000 checks, not 10^8).
Execution is at most 9 999 absorbs, each bounded by `OBSERVATIONS_PER_DISCOVERY` 256 moved
observations, so a group's journal line holds at most 16 x 256 = 4 096 observations. The
lazy path adds at most 32 entry visits and 32 checks per sticky match. Targets: the load
plan and execution under 0.5 s on a Pi 4-class core and under 50 ms on a desktop for the
measured store size (measured, not a test gate).

7.9 Safe defaults: a non-finite or missing median centre, OBW or peak makes a pair not
joinable; an undecided compatibility where either side has 3 or more observations is not
joinable; two young records (fewer than 3 observations each) follow 3.5 and may join. An
unreadable or invalid plan file is ignored with a warning (no resume, no new plan this
load) and removed after the next durable snapshot.

7.10 Regression fixtures:

- **Legacy pair.** Two records 270 Hz apart, both 8 kHz, both 40 observations at -52 dBFS,
  one effective family `unknown`, one `analog`. After load: one record, counts and airtime
  summed, the absorbed id adopted as an alias; then 50 observations with centres uniform in
  +-440 Hz update only the survivor.
- **Grid split.** Two records 400 Hz apart, median OBW 11 kHz and 14 kHz (different `g:`
  keys). Expect one record.
- **Kept apart.** A DMR pair with colour codes 11 and 15; an analog record with its decoded
  digital twin; a record with an operator lockout; a 0 dBFS record beside a -45 dBFS record
  (3.1 refuses); records 1 200 Hz apart. Each pair stays two.
- **No chaining.** Records at f, f + 900 Hz and f + 1 800 Hz with f ranked first: one group
  {f, f + 900}; f + 1 800 stays.
- **Over cap.** 18 joinable records within 500 Hz: the first plan holds one group of 16
  (survivor plus 15); the 2 left over are not absorbed in that load and form their own
  group (or join the survivor on the next load). A preferred (higher-ranked) survivor is
  never absorbed by a later group.
- **Dense, not joinable.** 10 000 records within 1 000 Hz of each other, pairwise
  identity-conflicting: no group, and the predicate is evaluated at most 32 times per record.
- **Crash.** Stop after the first of two groups is journaled (plan file present); reload;
  expect the same end state as an uninterrupted run, the plan file gone after the snapshot.
- **Old reader.** The journal lines a plan writes, replayed by the existing `replay` (no
  consolidation code involved) onto the pre-plan snapshot, give the consolidated store.

## 10. Legacy fragment retirement

As an operator I want the fragments older stores hold beside or inside one channel folded
into that channel's record, and stale empty fragments gone, without ever losing a record I
labelled or one that decoded.

Root cause: records written before the 1.16 channel keying and the 2.1 sticky join sit up
to half a channel spacing from the channel's own record, often more than 1 000 Hz away, so
7.1 never joins them, and nothing ages a record faster than
`storage.discoveryMaxAgeDays`.

10.1 A record is **protected** when it carries operator state (7.1), is decoded (stored or
effective), carries an identity, decoded metadata (talkgroups, sources, slots, callsigns,
capcodes, ISM models, CTCSS), recordings, PSD or IQ evidence, is encrypted, shows proof or
proven evidence, or holds a kept recording. Every other record is a **fragment candidate**.

10.2 **Channel merge.** For a candidate `c`, the covering raster is the finest channel
raster at `c`'s median centre (correction removed) among those fit for its OBW (1.16). With
none, `c` takes no channel merge. The channel is the raster channel nearest `c`; the group
is the records of `c`'s source within half a spacing of the channel centre whose nearest
raster channel is the same one (`c` included). The survivor is the group's first record in
the order: operator state, then protected, then most sightings, then earliest
`firstSeenAt`, then smaller id. Members are the group's other fragment candidates whose
median OBW is finite, positive and at most 2 spacings, whose association family equals the
survivor's or either is `unknown` or `carrier`, that lie on the same channel as the
survivor on the finest channel raster covering either of the two (whatever their OBW, so a
20 kHz record keyed to a 25 kHz channel never absorbs a record on a neighbouring 8.33 kHz
channel), that are not decoded as another protocol
(9.5) and that 3.1 does not refuse (undecided joins). Each member is absorbed with `absorb`
(observations, `observationCount`, `airtimeMs`, first/last seen, metadata, evidence moved;
the absorbed id recorded in the absorbed-id index and adopted as an alias). A survivor may
carry operator state; a member never does.

10.3 A protected record is never a member and never retires; it is re-checked on the live
record when the group runs. **The whole fragment pass is behind the caller's
`canFold(id)` predicate**: it is asked for every record that would be merged away or
retired, and a record it does not answer true for (a throw included) stays outside the
group and is never retired. Without the predicate the pass does nothing at all (no merge,
no retirement). The store cannot see every kind of evidence: evidence and recording files
land on disk before the store's flags are set (a crash leaves them unflagged), burst
captures name their discovery only in their own sidecar, analog proof is memory-only while
the trial memory that produced it persists, a merged-away id's trial memory is forgotten on
its `deleted` event, and its evidence folder is not reachable from the survivor. The answer
is cached per pass (one call per record) and at most `FRAGMENT_FOLD_CHECK_MAX` = 1 024
calls are made per pass (a pass folds at most 480 + 256 = 736 records, leaving 288 for
refusals); past it every further record is refused for that pass and the pass is not
settled. A merge that would give the survivor more than
`DISCOVERY_RECORDING_ALIASES_MAX` = 64 aliases is refused (the member stays), so no alias,
and no evidence tied to one, is ever dropped. The scanner service is to supply the
predicate (no evidence, dv or analog recording folder on disk, no capture and no
remembered trial for the id or any alias); until it does, the fragment pass is inactive.
Merging a fragment that carries such evidence would need its evidence folder and trial
memory moved to the survivor first (future work).

10.4 **Retirement.** A fragment candidate not in a group this pass retires (is deleted, one
`evict` operation, reported by `pruneInactive` with the age prune) when it has at most
`FRAGMENT_RETIRE_MAX_SIGHTINGS` = 2 sightings, confidence `activity` or `candidate`,
`lastSeenAt` at least `FRAGMENT_RETIRE_AGE_MS` = 72 h before now, and `canFold(id)` (10.3)
answers true. Stale records are considered oldest first.

10.5 **One pass reaches the fixpoint.** Each round merges, then retires (10.4) on the
merged state, so a merge survivor that is still a stale low-sighting record retires in the
same round. A merge moves the survivor's medians, so a pair a round refused may become
compatible, and a retirement may remove a survivor that refused the records beside it: so
after a round that examined every candidate and merged or retired anything, the pass plans
again, for at most `FRAGMENT_ROUNDS_MAX` = 4 rounds and within the pass's group and retire
caps. A pass that ended on a round with no change and no cap reached is settled. A pass after a pass that hit no bound changes nothing and journals nothing.
Total sightings over the live records plus the retired records equal the total before the
pass.

10.6 **Bounds per pass**, run on the maintenance cadence (the first scanner tick after start, then every 5 minutes). Per round: freezing is
O(n) and the sorts O(n log n) for n records (10 000 by default); at most
`FRAGMENT_SCAN_MAX` = 512 candidates are examined, in id order from an in-memory cursor
that wraps; each visits at most `FRAGMENT_PEER_SCAN_MAX` + 2 = 34 nearest records (the
candidate, 32 others, and one more to detect truncation; a candidate outside the nearest
33 takes the last slot, so a group holds at most 33 records): 17 408 visits and at most
512 x 32 = 16 384 pair checks. At most 4 rounds, so 4 x n freezes and 69 632 visits. Per
pass over all rounds: at most `FRAGMENT_GROUPS_MAX` = 32 groups of at most
`FRAGMENT_GROUP_MAX` = 16 records, so 32 x 15 = 480 absorbs, each moving at most 256
observations (122 880 moves); at most `FRAGMENT_RETIRE_MAX` = 256 retirements, oldest
`lastSeenAt` first. Progress per pass: the 512 is a maximum, not a guarantee, because a
round stops examining candidates once 32 groups formed (5 000 consecutive two-record pairs
cover about 64 records per pass). A pass either examines 512 candidates or forms 32 groups
or retires 256 records, so for N candidates, G mergeable groups and R stale records
everything is reached within ceil(N / 512) + ceil(G / 32) + ceil(R / 256) passes (one
group behind 512 records with nothing to merge takes 2 passes). For a 10 000-record store
of 5 000 two-record groups: 20 + 157 = 177 passes at most (about 15 h at 5 minutes); in
practice merging and examining overlap, so it is near the larger term.
The group cap is kept at 32 so one maintenance call stays well under the 0.5 s Pi target of
7.8; the measured fragment count (a few per cent of a store) clears in a few passes.

10.7 **Migration.** Existing stores need no conversion: merges are journaled as `rekey`
with the ordinary merge mutation and retirements as `evict`, so an older reader replays
them unchanged.

10.8 Regression fixtures (`tests/unit/core/scanner/fragment-retirement.test.ts`): three
fragments 2.5 to 4 kHz apart on one 12.5 kHz channel merge into the record with the most
sightings; a labelled record is the survivor and a second labelled record stays; decoded
and recording-holding records stay; other channels, no grid, a 30 kHz record and a 3.1
level split stay apart; a 20 kHz record at 118.025 MHz and an 8 kHz record at
118.016667 MHz under 8.33 and 25 kHz rasters stay apart; two stale single-sighting records
on one channel merge and the survivor retires in one pass, the next pass journalling
nothing; 32, 33 and 34 neighbours around a channel; no predicate does nothing (no merge, no retirement), a refusing or throwing predicate keeps the record out of every group and from retirement and an accepting one retires it, at most 1 024 predicate calls per pass, a merge refused at and past the 64-alias cap; retirement (with an accepting predicate) at exactly 72 h and not 1 ms before; each bound at and
one past its limit; an old-reader replay of the journal.

## 8. Passive marginal cost guard

As an operator I want passive discovery to stay on while I watch the waterfall on a host
that can afford it, and still be turned off on a host where passive itself costs too much.

Measured background: the WG11 guard judges the whole spectrum-engine utilization against
`scanner.passive.maxEngineUtilization` (default 0.25 of a core). When a display holds the
engine, the display's own FFT and summary cost counts against passive, so passive is turned
off while the operator is watching, and a guard-disabled source is only re-enabled after
the engine closes (probation) or when the whole engine falls to 0.2 of a core. On a Pi
3B-class receiver the engine alone measured about 0.99 of a core: the guard must still turn
passive off there.

8.1 **Holders.** The guard reads the source's engine consumers from the spectrum service:
**sole** when the only consumer is the source's passive job (`job:passive-<sourceId>`),
**shared** when passive and any display or other job hold it, **off** when passive does
not hold it. An unreadable consumer set counts as sole.

8.2 **Windows.** A measurement is the engine worker's windowed utilization between two
samples of the same worker generation at least `PASSIVE_COST_WINDOW_MS` = 60 000 ms apart.
A window starts:

- at engine open (today);
- for a baseline, at the first guard tick (1 s cadence) at which passive no longer holds
  the engine after the guard removed it;
- for a trial, at the first tick at which passive holds the engine again;
- after a worker generation change (restart or reconfigure), at the first tick that sees
  the new generation (the old window is discarded).

A window shorter than 60 000 ms, or one whose samples are null or non-finite, is **no
measurement**.

8.3 **Baseline.** While the engine is open and passive is off, every completed window gives
the baseline `B`, stamped with the engine instance, the worker generation and the sorted
list of the other consumers. `B` is **valid** while the engine instance and the other
consumers are unchanged, the generation is unchanged except for changes that follow the
guard's own passive removal or restore within one tick, and it is at most
`PASSIVE_BASELINE_MAX_AGE_MS` = 1 800 000 ms old. Otherwise it is **unavailable**.

8.4 **Precedence.** The first matching row decides. `U` is the current measurement, `M =
max(0, U - B)`, `limit` is `scanner.passive.maxEngineUtilization ?? 0.25`.

| #   | State (passive)       | Condition                                | Decision                         |
| --- | --------------------- | ---------------------------------------- | -------------------------------- |
| 1   | any                   | no measurement (8.2)                     | keep                             |
| 2   | enabled, sole         | -                                        | WG11 rule on `U` (unchanged)     |
| 3   | enabled, shared       | `U >= PASSIVE_SATURATION` (0.95)         | disable (baseline irrelevant)    |
| 4   | enabled, shared       | `B` valid                                | WG11 rule on `M`                 |
| 5   | enabled, shared       | `B` unavailable, `U <= limit`            | keep                             |
| 6   | enabled, shared       | `B` unavailable, baseline window allowed | start a baseline window          |
| 7   | enabled, shared       | `B` unavailable, window not allowed      | keep                             |
| 8   | disabled, engine open | `U <= limit x 0.8` (WG11 clear rule)     | clear                            |
| 9   | disabled, engine open | trial due (8.6) and `B` valid            | start a trial (passive restored) |
| 10  | disabled, engine open | otherwise                                | keep (record `B`)                |
| 11  | disabled, engine shut | WG11 probation due                       | clear (today)                    |

A malformed `B` (non-finite) is discarded and counts as unavailable; a malformed `U` is row

1. A trial is judged by rows 3 and 4 when its window completes; a disable there restarts
   the trial clock.

8.5 **Baseline window.** Row 6 removes the passive job (status `enabled: false`,
`disabledReason` `measuring baseline`), measures one window (8.2), records `B`, restores
passive and judges by row 4 after the next completed window. At most one baseline window
starts per source per `PASSIVE_BASELINE_MAX_AGE_MS`. A window that cannot complete within
`2 x PASSIVE_COST_WINDOW_MS` (no measurement) is abandoned and passive restored.

8.6 **Trial.** A guard-disabled source with its engine open is due a trial every
`PASSIVE_PROBATION_MS` (900 000 ms, today's constant) since it was disabled.

8.7 **Deadlines.** The baseline window end, the window after restoring passive, the trial
start and the trial window end are checked on every guard tick (1 s), not on the 300 s
recheck interval; the 300 s interval applies only to rows 2 to 4 on an engine with no
pending window.

8.8 **Bounds.** A baseline window keeps passive off for at most 61 s (one window plus one
tick) per 1 800 000 ms, at most 3.4 % of the time; an abandoned window at most 121 s, 6.7 %.
A source whose passive cost stays over the limit runs passive at most 61 s per 900 000 ms
(6.8 %). The guard adds one consumer-set read and one subtraction per tick per source: no
measurable cost.

8.9 Safe defaults: as the table. No new config key: the limit stays
`scanner.passive.maxEngineUtilization`. `disabledReason` names the figure: `engine-cpu N %
of a core` (row 2 or 3), `passive-cpu N % of a core` (row 4).

8.10 Regression fixtures (pure decision function, plus service wiring with fake engines):

- **Sole over limit.** Only passive holds, `U` 0.99, limit 0.25: disable at open + 60 s.
- **Shared, cheap passive.** Display plus passive, `B` 0.30, `U` 0.38: keep.
- **Shared, costly passive.** `B` 0.30, `U` 0.62: disable with `passive-cpu 32 %`.
- **No baseline.** Display plus passive, `U` 0.40: one baseline window, then judged on `M`;
  a second window is refused within 30 min.
- **Saturated.** `U` 0.97 with no baseline, and `U` 0.96 with a valid `B` 0.94: disable both.
- **Invalidation.** A display joins, the generation changes without a guard toggle, or `B`
  is 31 min old: `B` unavailable.
- **Trial.** Disabled with display open, `B` 0.30: after 15 min passive restarts; `U` 0.40
  keeps it, `U` 0.70 disables it again; a trial or baseline end is judged within 1 s of its
  deadline, not at the next 300 s check.

## 9. Young records and weak protocol guesses (amendment)

As an operator I want a new emitter to get one record from its first sighting, and I do
not want a guess that no decode confirmed to keep one emitter apart in several records.

Measured background (rounded) from a 60-minute watch with requirement 7 live:

- **Fan-out.** One emitter, keyed every 2.5 to 5 min, peak steady near -34 dBFS, SNR 21 to
  25 dB, centre mostly within 700 Hz of its median (outliers to 1.3 kHz), OBW swinging
  13 to 39 kHz (often a 13 to 17 kHz and a 25 to 39 kHz track in one burst), class
  alternating analog-fm, wideband and carrier. It created 9 records with one observation
  each in the hour, up to three on one placement key with three different classes. Each
  lived 0.2 to 5 min until the emitter's next burst stuck to the established record beside
  it and the lazy path (7.7) folded it in: list churn, and a trial spent on every young
  record.
- **Weak split.** Three records on one key, within 200 Hz, same class and OBW (15 kHz), each
  labelled by a different candidate guess (pocsag, dmr, analog-fm; confidence candidate, no
  decode, no identity), were all updated during the hour (about 50, 150 and 100 new
  observations). A second channel showed the same with pocsag, analog-fm and dpmr.

Root cause (design, section 9): the young-record rule of 3.1 and 3.5 is not the cause (an
observation against a young record, and two young records, are undecided and never
refused). (a) The 2.1 OBW gate compares an observation with the record's **median** OBW:
the 13 to 14 kHz first snapshot of a burst against the 29 to 31 kHz record beside it gives
a ratio of 0.42 to 0.48, below 0.5; the key fallback misses because the `g:` key depends on
OBW; the observation passes the 18 dB admission (1.3) and creates a record. A young record
whose sink proof turned it `carrier` refuses the other half of the same emitter the same
way (13 over 33 kHz is 0.39). (b) The centre index, `keyTarget`, `settle` and 7.1 compare
**effective** families, and the effective family of a record without proof is the
persisted label of its candidate guess.

9.1 **Association family.** A record's association family is its effective family when at
least one holds: its effective confidence is `decoded`; it carries an identity; its shown
evidence level is `proven` (a decode, analog audio heard, or carrier-only evidence).
Otherwise it is `unknown`. The association family replaces the effective family in the
sticky centre lists (2.1), the key match (`keyTarget`), `settle` (3.2) and 7.1 (and so the
7.7 lazy path). Unchanged: the label shown to the operator, the decode-driven co-channel
split and relocation, the 2.4 identity rule, and the 7.1 identity and decoded-protocol
tests. So a weak guess never keeps records apart; a decoded protocol, a proven analog or
digital family, and an identity (colour code, NAC, talker id, capcode) still do.

9.2 **OBW band.** For an evidence-less observation and a record `r`, the band of `r` is
`[obwMin / f, obwMax x f]`, where `obwMin` and `obwMax` are the smallest and largest finite
OBW of `r`'s last 64 observations (a non-finite OBW is left out, see 9.8). `f = DQ_OBW_RATIO_MAX` = 2 when `r` is decoded or carries an
identity, and `f = DQ_YOUNG_OBW_RATIO` = 3 otherwise, whatever its observation count or
proven analog or carrier evidence (so reaching 3 observations or a carrier-only proof never
narrows the band). The observation passes when its OBW lies in the band. This replaces the
2.1 test "observation OBW over median OBW in [0.5, 2]". Arithmetic: the measured emitter
spans 13 to 39 kHz, a ratio of 3.0, so a record holding any one of its observations `x`
accepts every other `y` (`y / x` lies in [1/3, 3]); three 13 kHz observations give
[4.3, 39] kHz, so a following 39 kHz one joins; a history of 16 to 39 kHz accepts 5.3 to
117 kHz. A record whose history is narrow keeps a narrow band (a 4 to 8 kHz carrier accepts
1.3 to 24 kHz); 3.1 still refuses a strong signal beside a weak one.

9.3 **Join rule and precedence.** An evidence-less observation may join a record of the
same source by one of two routes:

- **same association family** (today's same-family route, now keyed by 9.1): within
  today's tolerance, with **no** OBW band;
- **cross-family or young** (2.1 amended): any association family, within
  `min(tolerance, DQ_CROSS_FAMILY_HZ)` = at most 1 000 Hz, and only when the observation
  passes 9.2. A record with fewer than 3 observations is reachable by this route whatever its
  family.

On both routes the 9.4 refusal applies; it wins over every other rule. The nearest
candidate across both routes wins (today's tie-break). So the band gates only the
cross-family and young route; a same-family candidate is never band-gated, but is never
joined against a 9.4 refusal. Arithmetic: with centre jitter of +-300 Hz, two observations
of one emitter are at most 600 Hz apart and a record's median centre lies within the span
of its observations, so every later observation is within 600 Hz of it, inside 1 000 Hz.
Outliers beyond 1 000 Hz may still create a record; the lazy path and the next load fold
it (9.6).

9.4 **Young refusal, on every path.** 3.1 and 3.5 are amended. A young record (fewer than 3
observations) is no longer undecided: its observations are tested one by one, both sides as
single observations (`count` treated as enough history):

- observation against record: refused when 3.1 refuses the observation against the
  record's medians (3 or more observations) or against **any** observation of a young
  record;
- record against record: refused when both are established and their medians are
  incompatible (3.1 as today), when one is young and any of its observations is refused by
  the other's medians (as today), or when both are young and **any** pair of their
  observations (at most 2 x 2) is refused.

The refusal applies on every merge path: sticky match (both routes of 9.3), key match
(`keyTarget`), `settle`, `absorb`, the load plan and the lazy path (7.1). A refused pair in
`settle` is linked as co-channel partners (3.2). Only non-finite peaks or OBWs make a test
undecided, which does not refuse.

9.5 **Decoded protocol guard.** Two records whose effective confidence is `decoded` with
different decoded protocols shall never merge on any path: key match, `settle`, `absorb`
(an unplanned call), the load plan and the lazy path (7.1 already has this test), and an
observation carrying a decode of protocol P never sticks to or key-matches a record decoded
as another protocol. This holds within one family (DMR against P25, POCSAG against FLEX).

9.6 **Consolidation.** 7.1 is amended: the family test uses the association family (9.1),
the compatibility test is 9.4, and the OBW test is that each record's median OBW lies in
the other record's band (9.2, with each record's own `f`). Every other 7.1 condition
stays, including 9.5. So the next load's plan folds the existing weak-guess splits (records
apart only by candidate labels) and the young records left by fan-out, and the lazy path
folds new ones.

9.7 **Bounds.** 9.1 reads the cached proof label (no new proof read). 9.2 adds the OBW
minimum and maximum to the existing 64-observation medians pass. 9.4 adds at most 4
compatibility checks per young pair (2 per young candidate for an observation) and no index
query. Per observation the added work is O(1) per candidate, inside the section 2 budget.

9.8 Safe defaults: a non-finite or missing OBW minimum, maximum or median, or a non-finite
observation OBW, fails 9.2 for that pair (no cross-family or young join; the same-family
route is unchanged); a non-finite OBW inside the window is left out of the minimum and maximum
(otherwise one bad measurement would close the band for the next 64 observations), and a
window with no finite OBW has none, which fails, as does a non-finite median OBW; a non-finite centre never matches; a non-finite peak or OBW on either
side makes a 9.4 test undecided, which does not refuse (as 3.5). An unreadable evidence
level or confidence counts as not proven and not decoded (and so takes `f` = 3 only when
it also has no identity). A malformed identity counts as present and different from every
other identity, so it never merges two records.

9.9 Measurements (report, not tests): the per-observation ingest cost before and after on
the existing store bench (desktop, with the Pi 4-class factor stated); an offline replay of
a store copy giving, per cluster within 1 kHz, the record count before and after the load
plan and after replaying its observations through ingest. No wall-clock assertion in tests.

9.10 Regression fixtures:

- **New emitter.** Empty store; 40 evidence-less observations 3 to 5 s apart, centres
  `f +- 300 Hz` (fixed pseudo-random sequence), OBW cycling 13, 17, 33 and 39 kHz, class
  cycling analog-fm, wideband and carrier, peak -34 +- 1 dBFS, SNR 24 to 25 dB, with
  carrier-only analog evidence after the first. Expect exactly one record holding all 40.
- **Narrow first.** Empty store; three 13 kHz observations at one centre, carrier-only
  evidence after the first, then a 39 kHz observation 300 Hz away at a centre where the
  3 500 Hz and 10 000 Hz grids give different keys. Expect one record.
- **Established neighbour.** A `carrier` record with 64 observations at `f`, OBW alternating
  16 to 17 and 25 to 39 kHz (median about 29 kHz); then observations at `f + 700 Hz`, OBW
  13 kHz. Expect no new record.
- **Weak trio.** Three records on one key within 200 Hz, OBW 15 kHz, 20 observations each,
  stored candidate labels pocsag, dmr and analog-fm, no decode, no identity. Expect one
  record after load (plan), and one record when the same trio is built by ingest (settle).
- **Kept apart.** Two decoded DMR records 150 Hz apart with colour codes 1 and 2; a decoded
  DMR record beside a decoded POCSAG record; a proven analog record beside a decoded pager
  record. Each pair stays two, by ingest and by consolidation.
- **Same family, different decoded protocol.** A decoded DMR record and a decoded P25
  record, no identity, same key, 200 Hz apart, compatible levels and OBW. Expect two after
  `settle`, after the load plan, after the lazy path and after an observation decoded as
  P25 at the shared key.
- **Young refusal, per path.** A young record of one observation at -60 dBFS, 4 kHz, and a
  -30 dBFS, 12 kHz, SNR 30 dB signal 300 Hz away on the same key (3.1 refuses). Expect two
  records when the signal arrives as an observation via the sticky route, via the key
  match (sticky disabled by distance through a forced placement), as a second young record
  passed to `settle`, through the load plan (both stored young) and through the lazy path.
  The same pair with the second signal at -45 dBFS (15 dB, not refused) gives one record on
  every path.
- **Same-family precedence.** An `unknown` record with 64 observations at 8 kHz and an
  evidence-less 30 kHz observation 1 500 Hz away at the same level: joins by the same-family
  route (no band); the same observation at 1 500 Hz from a `carrier` record does not.
- The 3.6 fixtures and the 7.10 fixtures keep their expectations.
