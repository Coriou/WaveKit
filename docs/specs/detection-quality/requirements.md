# Detection quality requirements (WG15 DQ)

Status: reviewed design, not implemented (2026-10-24; revised after spec review the same
day). Amendment (reviewed 2026-10-25): sections 7 and 8. See
[design](design.md) and [tasks](tasks.md).

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
follow-up 6.3's guard part.

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
