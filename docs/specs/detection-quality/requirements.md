# Detection quality requirements (WG15 DQ)

Status: reviewed design, not implemented (2026-10-24). See [design](design.md) and
[tasks](tasks.md).

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
  of the listed records were born on an overload-flagged observation.
- Noise records had a median best channel SNR of 12 dB (range 8 to 15 dB); real users had a
  median best SNR of 30 dB (range 15 to 60 dB).
- One DMR emitter seen as analog-fm by one classifier and as fsk4 by another, about 200 Hz
  apart, gave two records that never converged; a steady carrier gave a dozen records within
  50 Hz of each other, each listing ten or more co-channel partners.
- A strong (0 dBFS, 6 kHz) transmission 564 Hz from a weak ambient carrier (-28 dBFS, 3 to
  4 kHz) merged into the ambient record, raised its best level by about 27 dB and changed its
  class to the transmission's.
- Every pager burst on one channel (1.6 to 2.1 s, constant-envelope FSK) was published as a
  voice analog-transmission Activity row, each with a clean pager decode within 1 s on the
  same frequency.

In scope: requirements 1 to 4 (behaviour changes) and 5 (finding, acceptance item).

Out of scope (follow-ups, section 6): band-plan rasters for passive placement; a fixed
2.5 kHz grid key independent of OBW (needs a stored-record key migration); a redesign of
the passive cost guard; any change to `packages/api-types`.

Safe-default rule for the whole spec: when an input the rule needs is unknown, non-finite
or malformed, the rule falls back to the behaviour that **does not create** a new record and
**does not raise** a stored level or identity, except where a criterion says otherwise.
Where refusing would lose a real decode (requirement 4), the rule fails open to today's
behaviour and says so.

## 1. Admission: no discovery without signal

As an operator I want a discovery to mean "something transmitted here", so the list is not
filled with intermod products and noise.

1.1 The store shall not create a new discovery from an observation flagged `overload` unless
the ingest carries decode evidence that proves the signal (`decodeProvesSignal`). An
overload-flagged observation may still join an existing record (subject to 3.1), and shall
not raise its `signal.best` (3.2).

1.2 An evidence-less observation that matches no existing record shall create a discovery
only when its channel SNR is at least `DQ_CREATE_SNR_DB` = 15 dB. 15 = k 3 + margin 3 + 9:
it sits at the top of the measured noise range (max 15.0 dB) and below the weakest measured
real user (15.4 dB).

1.3 Otherwise the observation shall be held as **pending** (not stored, not surfaced, not
persisted, no Activity or WebSocket change). A pending entry is promoted, creating a
discovery from the promoting observation, when either:

- one of its observations reaches 15 dB (1.2), or
- it holds at least `DQ_PENDING_MIN_OBS` = 3 distinct observation ids whose first sighting
  lies within `DQ_PENDING_WINDOW_MS` = 600 000 ms (10 min) of the newest, and the median of
  their SNRs is at least `DQ_PENDING_MEDIAN_SNR_DB` = 10 dB.

The measured noise median (12 dB) passes 10 dB, so the repeat rule alone does not reject
every noise record; the three-in-ten-minutes requirement plus 1.1 and 1.4 remove the bulk,
and the fixtures (1.8) pin which side each measured class falls on.

1.4 The tracker shall count only blocks with channel SNR >= k (`CHANNEL_GATE_K_DB`, 3 dB)
toward the gate's minimum on-time (300 ms, burst 100 ms). Blocks between k - 1.5 dB and k
keep the run alive (hysteresis, unchanged) and the one tolerated off block stays, but neither
counts toward the duration. With 50 ms blocks, a run needs 6 strong blocks (burst: 2).

1.5 Pending is bounded: at most `DQ_PENDING_PER_SOURCE` = 512 entries per source, each with
at most 5 retained (id, time, SNR) samples. Entries expire 10 min after their first sample.
When full, the entry with the oldest last sample is evicted. Arithmetic in the design.

1.6 A re-ingest of an observation id already in a pending entry updates that sample (its SNR
becomes the larger of old and new) and does not count as a second observation.

1.7 Safe defaults: a non-finite SNR, a non-finite centre or an absent `overload` flag on an
evidence-less observation is treated as "does not qualify" (held at most, never created by
1.2; a non-finite SNR never counts toward the median). Decode-proven ingest keeps today's
path.

1.8 Regression fixtures (observation and track level, synthetic):

- **Noise only.** Floor -66 dBFS per 1 kHz bin; one non-overload track repeating every 1.5 s
  for 10 min at a fixed centre, OBW 10 to 13 kHz, peak -48 to -53 dBFS, channel SNR 8.6 to
  9.6 dB. Expect no discovery (median below 10 dB).
- **Intermod.** A clipping carrier (+0.8 dBFS peak, OBW 7 kHz, 3.3 s, overload) and three
  simultaneous overload tracks 0.3 to 1.4 MHz away at -23, -38 and -44 dBFS (OBW 16 to
  35 kHz). Expect exactly one discovery (the carrier, which carries decode evidence in the
  fixture) and none for the three products.
- **Weak repeat.** A non-overload track with SNR 11 to 12 dB seen 3 times in 4 min. Expect
  no discovery after the first two and one discovery at the third.
- **Hysteresis.** A track whose blocks alternate 2 dB and 3.5 dB for 600 ms. Expect the gate
  not to pass (3 strong blocks, 150 ms < 300 ms); the same track at 3.5 dB for 6 blocks passes.

## 2. One emitter, one discovery

As an operator I want one record per emitter, even when two classifiers disagree on its
family or when it is a plain carrier.

2.1 An evidence-less observation shall stick to an existing record of the same source of
**any** family when the centre distance is at most `DQ_CROSS_FAMILY_HZ` = 1 000 Hz (and
within today's tolerance) and the observation OBW divided by the record's median OBW lies in
[0.5, 2]. The nearest such record wins (today's tie-break). Same-family matching keeps
today's tolerance.

2.2 An observation classed unknown may join a record whose effective family is `carrier`
under the 2.1 rule (the carrier exclusion in `keyTarget` no longer applies inside 1 kHz).

2.3 Co-channel links shall be pruned at refresh: a partner is kept only while it exists and
its median centre lies within the record's association tolerance. A record shall list at
most `DQ_CO_CHANNEL_MAX` = 8 partners (nearest first). Arithmetic in the design.

2.4 Applying decode evidence with an identity to a record shall be refused (no change, the
call returns no change) when another record of the same source already holds the same
protocol and identity as `decoded`, its centre is at least `DQ_IDENTITY_SPLIT_HZ` = 6 000 Hz
away, and it was last seen within `DQ_IDENTITY_CONCURRENT_MS` = 60 000 ms. One radio
transmits on one channel at a time, so a second concurrent copy 6 kHz or more away is an
adjacent-channel leak (measured 9.1 to 9.75 kHz on 12.5 kHz DMR). The first decoded record
keeps the identity.

2.5 Safe defaults: a non-finite or zero median OBW on the record, or a non-finite
observation OBW, disables the cross-family rule for that pair (today's behaviour). A
non-finite record centre is never a match.

2.6 Regression fixtures:

- **One DMR emitter, two classifiers.** Observations every 1.3 s at centres uniform within
  440 Hz, OBW 9 to 12 kHz, alternately classed analog-fm and fsk4, peak -45 to -48 dBFS,
  SNR 20 to 25 dB. Expect one discovery.
- **Carrier.** Twelve sightings within 50 Hz, OBW 4 to 8 kHz, -27 to -33 dBFS, SNR 21 to
  32 dB, gaps 13 to 98 min, with carrier-only analog evidence after the first. Expect one
  discovery with no co-channel partners.
- **Adjacent leak.** A record decoded as DMR identity X at f; a decode of identity X applied
  to a record at f + 9.4 kHz 2 s later. Expect the second record unchanged.

## 3. No ambient misattach

As an operator I want a strong transmission to get its own record and the ambient carrier
next to it to keep its own level and class.

3.1 An observation shall not merge into a record (sticky or key match) when both
`|obs.peakDbfs - median peak| >= DQ_LEVEL_SPLIT_DB` = 20 dB and
`obs.obwHz >= DQ_OBW_SPLIT_RATIO` = 1.5 × median OBW, where the medians are over the record's
last 64 observations and the record has at least 3 of them. The observation then matches
the next candidate or creates a record (subject to requirement 1).

AND, not OR (measured): the ambient carrier varied 7 dB (-23 to -30 dBFS) with OBW ratio at
most 1.33, and the strong transmission differed by 27 dB with ratio 1.5 to 2.0, so either
rule alone splits this case. But a real mobile user fades by 20 dB or more at a fixed OBW
(level alone would split a real user), and a wide noise record's OBW swings 15 to 25 kHz
(ratio 1.67) at constant level (OBW alone would split it). Only the conjunction separates
the measured strong-next-to-ambient case from both.

3.2 `signal.best` shall be updated only from an observation that is compatible (3.1 does not
refuse it) and is not flagged `overload`. `signal.last` keeps today's rule.

3.3 A record's `class` shall be the majority class of its last 64 observations (ties go to
the most recent of the tied classes; edge-flagged observations do not vote), not the latest
observation's class.

3.4 Safe defaults: fewer than 3 observations, or a non-finite median or observation peak or
OBW, skips 3.1 (merge as today) but the observation cannot raise `signal.best`.

3.5 Regression fixtures:

- **Strong 15 kHz away.** Ambient carrier at f, OBW 3 to 4 kHz, peak -23 to -30 dBFS, 20
  sightings; then a 0 dBFS, 6 kHz transmission at f + 15 kHz. Expect its own discovery and
  the ambient record's best <= -23 dBFS and class unchanged.
- **Strong 564 Hz away.** Same ambient; then a transmission at f - 564 Hz, OBW 6 kHz, peak
  -0.7 dBFS, SNR 48 dB, 3.3 s, overload, followed by f - 860 Hz, OBW 7 kHz, +0.8 dBFS,
  2.2 s. Expect one new record holding both transmission observations, ambient best <=
  -23 dBFS, ambient class unchanged.
- **Fading user.** One record, OBW 11 to 12 kHz, peak swinging -30 to -55 dBFS. Expect one
  record.

## 4. Data is not voice

As an operator I want pager and data bursts not to appear as voice transmissions in
Activity.

4.1 A closed analog transmission shall not be published as an `analog-transmission` Activity
row when an accepted `paging` or `aprs` decoder reception (by `DecodeEnvelope.category`)
with a channel frequency lands within ±`DQ_DATA_FREQ_HZ` = 1 250 Hz of the transmission
frequency and its produced time lies within [start - 1 000 ms, end + 1 000 ms]. The pager
decode row is the record of that burst.

4.2 The live-audio evidence attached to the scanner for such a transmission shall carry
`voice: false` (and the `heard` outcome), so it no longer gives a candidate analog-fm label.

4.3 The decision shall wait up to `DQ_DATA_HOLD_MS` = 1 000 ms after close, because the
measured decode arrives 0 to +1.0 s after close. The live WebSocket `transmission` event is
unchanged (it is an api-types DTO).

4.4 No change to `packages/api-types` is needed: the row is suppressed rather than
recategorised (the category union has no `data` member). A future `data` hint on the
WebSocket event would be a Main-owned DTO change (follow-up 6.4).

4.5 Bounds: at most 8 closes held per tracker, and a ring of the last 256 data decodes. A
close that cannot be held (cap) or whose window outlives the ring publishes as today (fail
open: a lost voice row is worse than a spurious one). Arithmetic in the design.

4.6 Safe defaults: an envelope without `provenance.frequency`, with a non-finite frequency
or produced time, or of another category, is ignored. A transmission with a null frequency
is published as today.

4.7 Regression fixture: NFM at a fixed channel, pager bursts of 1.6 s and 2.1 s every 300 s,
channel peak -29 dBFS on a -55 dBFS floor, full quieting; a matching paging decode arrives
0 to +1.0 s after each close. Expect zero analog-transmission rows, one paging row per burst
and `voice: false` evidence. Control: the same burst with no decode publishes one row after
the hold; a decode 2 kHz away or 1.5 s after close leaves the row published.

## 5. Finding: "rarely updated" was passive being off

5.1 The spec records that, in the measured watch, discoveries did not update because the
passive job had ended about 60 s after an engine open (the cost guard's first judgement)
and never re-enabled while the display kept the engine open. Activity rows cannot update
discoveries by design. Changing the guard is out of scope (follow-up 6.3).

5.2 Every detection-quality acceptance run shall record `/api/scanner/status`
`sources[].passive` (`enabled`, `disabledReason`) alongside its discovery snapshots, at the
same cadence, and report the passive-on fraction of the run.

## 6. Follow-ups (not in this spec)

6.1 Band-plan rasters for passive placement (`rastersAt` returns the band-plan rasters the
passive channel plan already uses), so one PMR emitter keys to one raster key at any OBW.

6.2 A fixed 2.5 kHz grid key independent of OBW, with a migration of stored `g:` keys.

6.3 Passive cost guard: judge passive-attributable cost or degrade before disabling, and
allow a clear while the engine is shared. Optional ingest of trusted decoder receptions as
discovery updates when no job runs.

6.4 An optional data hint on the analog-transmission WebSocket event (Main-owned DTO change
in `packages/api-types`).
