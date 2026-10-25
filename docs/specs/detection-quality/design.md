# Detection quality design (WG15 DQ)

Status: reviewed design, not implemented (2026-10-24; revised after spec review the same
day). Requirements in [requirements](requirements.md), tasks in [tasks](tasks.md).
Background: the [scanner redesign](../scanner-redesign/design.md) channel gate and evidence
labels, `docs/SCANNER.md`, and the hot-path rules in `docs/PERFORMANCE.md`.

## Root causes (code as of the base commit)

| Fault                     | Where                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noise and intermod admit  | `DiscoveryStore.ingest` (`src/core/scanner/store/discovery-store.ts`) checks only sticky flags, `jobIds`, and `track.gate === "passed"`, then `createFrom`; `overload` is a flag only. Tracker `noteQualified` (`src/core/spectrum/emissions/tracker.ts`) counts `gateOnBlocks`, which includes hysteresis blocks (k - 1.5 dB) and the tolerated off block. |
| One emitter, many records | `stickyMatch` searches only the observation's family list (plus decoded centres); `keyTarget` merges only within a family and drops `carrier` records for unknown observations, so each new carrier sighting creates a record with `coChannel = atKey`. Co-channel links are appended (capped at `LINKS_MAX` 64) and never pruned.                          |
| Ambient misattach         | `stickyMatch` takes the nearest centre within tolerance with no level or OBW check; `settle` then `absorb` merge any two records on the same source, key, family and identity; `absorbStats` raises `signal.best` from any higher-SNR observation; `applyClassificationTo` takes the latest class.                                                          |
| Pager as voice            | `AnalogTransmissionTracker` publishes any qualifying squelch segment (`ANALOG_TRANSMISSION_MIN_MS` 500, 3 carrier blocks); constant-envelope FSK quiets FM fully; `src/core/activity/storage/row.ts` hard-codes `category: "voice"`; `live-audio-evidence.ts` records `heard` with `voice: true`.                                                           |
| Rarely updated            | No passive job for most of the watch: `ingest` returns transient for `jobIds.length === 0`. Likely cause the passive cost guard (requirement 5.1 lists the alternatives).                                                                                                                                                                                   |

## Contract (frozen)

New constants in `src/core/scanner/detection-quality-contract.ts` (new, core only):

| Constant                    | Value                          | Requirement |
| --------------------------- | ------------------------------ | ----------- |
| `DQ_OVERLOAD_CREATE_SNR_DB` | 25                             | 1.2         |
| `DQ_CREATE_SNR_DB`          | 18                             | 1.3, 1.4    |
| `DQ_PENDING_MIN_OBS`        | 3                              | 1.4         |
| `DQ_PENDING_MEDIAN_SNR_DB`  | 15                             | 1.4         |
| `DQ_PENDING_WINDOW_MS`      | 600 000                        | 1.5         |
| `DQ_PENDING_PER_SOURCE`     | 512                            | 1.5         |
| `DQ_PENDING_SAMPLES`        | 5                              | 1.5         |
| `DQ_CROSS_FAMILY_HZ`        | 1 000                          | 2.1, 2.2    |
| `DQ_OBW_RATIO_MIN` / `_MAX` | 0.5 / 2                        | 2.1         |
| `DQ_CO_CHANNEL_MAX`         | 8                              | 2.3         |
| `DQ_IDENTITY_SPLIT_MIN_HZ`  | 6 000                          | 2.4         |
| `DQ_IDENTITY_SPLIT_MAX_HZ`  | 30 000                         | 2.4         |
| `DQ_IDENTITY_OVERLAP_MS`    | 2 000                          | 2.4         |
| `DQ_IDENTITY_WEAKER_DB`     | 10                             | 2.4         |
| `DQ_IDENTITY_PROTOCOLS`     | `dmr`, `p25p1`, `p25p2`, `ysf` | 2.4         |
| `DQ_LEVEL_SPLIT_DB`         | 20                             | 3.1         |
| `DQ_OBW_SPLIT_RATIO`        | 1.5                            | 3.1         |
| `DQ_MIN_HISTORY_OBS`        | 3                              | 3.1, 3.5    |
| `DQ_DATA_FREQ_HZ`           | 1 250                          | 4.1         |
| `DQ_DATA_HOLD_MS`           | 1 000                          | 4.1, 4.3    |
| `DQ_DATA_HELD_MAX`          | 8                              | 4.5         |
| `DQ_DATA_RING`              | 256                            | 4.5         |
| `DQ_DATA_RATE_PER_S`        | 16                             | 4.5         |

No change to `packages/api-types`, the REST or WebSocket shapes, or
`docs/CLI-COORDINATION.md`. Pending entries are memory-only. The persisted and journaled
observation form (`StoredObservation`, core only) gains one optional field, `classVote`
(3.4); it is stripped from the DTO, and an observation without it does not vote, so old
snapshots and journals load unchanged.

## 1. Admission

### Tracker (hot path)

`OpenTrack` gains `gateStrongBlocks: number`, initialised to 0 and reset wherever
`gateOnBlocks` is reset (`clearGateRun`, run start). In the on branch of the gate step,
after `isOn` returns true, `if (snr >= k) t.gateStrongBlocks++` (one compare, no
allocation). `noteQualified` tests `t.gateStrongBlocks * blockMs < t.gateMinMs` instead of
`gateOnBlocks`. `inheritRun` copies `next.gateStrongBlocks = prev.gateStrongBlocks` next to
`gateOnBlocks`, so a split track qualifies at the same block as an unsplit one.
`gateOnBlocks` keeps its other readers (run length, traces).

### Store creation gate

In `ingest`, after `keyTarget` returns no merge and before `createFrom`:

```ts
if (!decodeProvesSignal(input, opts.decode)) {
	const { centreHz, snrDb, flags } = input.track
	if (
		!Number.isFinite(centreHz) ||
		!Number.isFinite(snrDb) ||
		typeof flags.overload !== "boolean"
	)
		return TRANSIENT // 1.7
	if (flags.overload) {
		if (snrDb < DQ_OVERLOAD_CREATE_SNR_DB) return TRANSIENT // 1.2, never pending
	} else if (snrDb < DQ_CREATE_SNR_DB && !this.pending.note(input)) {
		return TRANSIENT // 1.4, held or not yet promoted
	}
}
return this.createFrom(input, label, target.coChannel)
```

### Pending holder

`src/core/scanner/store/pending-admission.ts` (new), owned by the store:

```ts
interface PendingSample {
	id: string
	at: number
	snr: number
}
interface PendingEntry {
	firstAt: number
	bucket: number
	samples: PendingSample[]
} // <= 5
class PendingAdmission {
	note(obs: ObservationInput): boolean // true = promote now (entry deleted)
	sweep(now: number): void
	clear(sourceId?: string): void
}
```

- Bucket: `Math.round(centreHz / 2 500)` per source, independent of OBW. Buckets b - 1, b and
  b + 1 are searched; the entry whose bucket is nearest wins (ties: the older entry), so a
  centre near a bucket edge still accumulates.
- Expiry, one policy: an entry lives in [firstAt, firstAt + 600 000 ms). `note` first drops
  the matched entry if `now >= firstAt + 600 000` and starts a new one. `sweep` (from the
  store's existing refresh tick) deletes expired entries. Samples are never individually
  aged out, so every sample of a live entry is inside its window.
- `note`: same id → keep the larger SNR (1.6); new id → append, or with 5 samples replace the
  lowest-SNR sample if the new SNR is higher (a count of distinct ids seen is kept
  separately, so promotion counts ids, not retained samples). Promote when distinct ids >= 3
  and the median of retained SNRs >= 15 dB. Retaining the highest 5 only raises the median
  versus all samples, so it can promote earlier, never later; with at most 5 retained and 3
  needed, the median of the first 3 to 5 distinct ids is exact.
- Order and eviction: one `Map` per source in insertion order of `firstAt` (entries are not
  re-inserted on touch), so the first key is the oldest first sample; at 512 the first entry
  is evicted (O(1)).
- `clear(sourceId)` runs on source removal and on retune (the store's existing retune hook).

Bound arithmetic: a sample is about 40 B, an entry with 5 samples and its map slot about
300 B, so 512 entries ≈ 150 kB per source. 512 covers more than half of a 2.4 Msps window at
2.5 kHz buckets (2 400 000 / 2 500 = 960 buckets); the measured watch produced about 50
non-overload noise records over 50 min. Eviction only delays a slow candidate. Work per held
observation: up to 3 map lookups and a sort of at most 5 numbers.

Promotion creates the discovery from the promoting observation only; earlier pending
observations are not back-filled. A restart drops pending entries; that only delays creation.

## 2. One emitter, one discovery

### Cross-family sticky

`stickyMatch` keeps today's same-family search. When the observation is evidence-less, it
then searches each other family's centre list over `[centre - min(tol, 1 000) - 1,
centre + min(tol, 1 000) + 1]` (the WG11 1 Hz widening), with the filters
`0.5 <= obs.obwHz / median OBW <= 2` and `compatible(...) !== false` (section 3), both read
from the cached medians. The best candidate across both searches is the nearest. The family
set is fixed and under 16, so this is under 16 range queries per observation, O(F log n).
`keyTarget` keeps its carrier exclusion for key-only merges beyond 1 kHz.

### Co-channel pruning

At `refresh` (where a record's medians and key are recomputed), each record's `coChannel`
is rebuilt: keep ids that exist and whose median centre is within the record's
`toleranceHz`, sort by distance (ties: older `lastSeenAt` last), keep the first 8, and unlink
dropped ids reciprocally through `syncProofWatch`. `createFrom` applies the same cap.

Why 8: partners must sit within one association window, at most 2 × 2 000 = 4 kHz on the
grid path (2 × 1 562 = 3.1 kHz on a 6.25 kHz raster). With 2.1 and 3.2 in place, records in
one window differ either by incompatibility (3.1: at most one strong and one ambient level
class per bandwidth class) or by family with a different OBW. The measured worst cluster
had 7 records in one window (a wide ambient emission, a decoded record, an analog record, a
carrier and three more co-channel records), most of them the duplicates 2.1 and 2.2 now merge;
8 holds even that unmerged cluster. A partner beyond the cap loses only the co-channel proof read
(`proofWatchers`), which is advisory; the proof-watch pin bound (1 + `LINKS_MAX` = 65) only
shrinks. Tests: overflow with 12 records keeps the nearest 8, reciprocal; a pruned partner
returning within tolerance is re-linked at the next refresh.

### Identity split

In `applyEvidence`, before applying evidence with protocol in `DQ_IDENTITY_PROTOCOLS` and at
least one radio source id in `metadata.sources` to record `d` (no source id: apply as
today): scan the source's records. For a record `o` with the same effective protocol whose
`metadata.sources` lists one of those ids (the channel identity, colour code, NAC or DG-ID,
is not used: every radio on a system shares it), compute the distance between median centres; if it is in [6 000, 30 000] Hz,
an observation of `o` overlaps the decode's observation interval widened by 2 000 ms on each
side, and `d`'s median peak is at least 10 dB below `o`'s, return `null` (no change, no
journal entry). Any non-finite median or missing observation interval → apply as today.
Called per decode, not per frame. The stronger record is never refused, because the test
needs `d` to be the weaker one.

## 3. Ambient misattach

`mediansOf` gains the median `peakDbfs`, the observation count and a class tally, computed in
the same pass over the last 64 observations. A pure helper in
`src/core/scanner/store/compatibility.ts` (new):

```ts
type Side = { peakDbfs: number; obwHz: number; count: number } // count = Infinity for an observation
function compatible(a: Side, b: Side): boolean | null
```

returns null when either side has count < 3 or a non-finite value (3.5), false when both 3.1
conditions hold, true otherwise. `recordsCompatible(a, b)` takes each record's medians and,
for a record with fewer than 3 observations, its observations: both established → medians;
one established → each young observation against the established medians (false if any is
refused); both young → null.

Merge paths that consult it (3.2):

- `stickyMatch` `consider` and `keyTarget` merge candidates skip a record that is
  incompatible with the observation.
- `settle` skips a colliding record `other` when `recordsCompatible(d, other)` is false, and links the two as co-channel partners instead (bounded by 2.3). `absorb` asserts
  the same predicate and returns without merging if false, so any future caller is covered.
- `absorbStats` takes `raiseBest = compatible !== false && compatible !== null &&
!overload`; for a record with fewer than 3 observations, `raiseBest = !overload &&
isFinite(snr)`.
- `absorb` of two compatible records keeps the better `signal.best`, skipping a best set by an
  overload-flagged observation and an absorbed best its stored observation fails against the
  survivor's medians. `rehome` (an observation moved by a decode split) applies the same
  overload rule.

Class majority: `applyClassificationTo` sets `class` from the tally (edge and `unknown`
observations excluded; ties to the most recent). The tally reads each observation's persisted
`classVote`; a re-ingest that changes only the vote recomputes and journals the class. Protocol refinement from classification is unchanged.

## 4. Data is not voice

### Data decode gate

`src/core/data-decode-gate.ts` (new, core only):

```ts
export interface DataDecodeGate {
	noteEnvelope(env: DecodeEnvelope): void // via the Activity publisher tap
	hold(event: ClosedTransmission, deliver: (isData: boolean) => void): void
	stop(): void // flushes held closes as not-data
	stats(): { dropped: number; heldOverflow: number }
}
```

- Tap: `src/index.ts` passes the Activity publisher to `decoderManager.setActivityPublisher`.
  The composition wraps that publisher so each envelope is also offered to `noteEnvelope`
  (try/catch, never throws into the decoder path).
- Accept: `category` `paging` or `aprs`; non-null `provenance.sourceId`;
  `provenance.frequency` with `basis === "channel"`, `tuningTrust` `commanded` or `relay`,
  finite `hz`; finite parsed `producedAt`. Anything else is ignored (4.6).
- Rate: a per-source counter over the current 1 s bucket; the 17th and later accepted
  envelopes in one bucket are dropped and counted. The ring keeps the last 256 accepted as
  (sourceId, hz, at); the oldest is overwritten.
- Hold: `wireAnalogTransmissions` gets an optional `dataGate`. Its `closed` handler calls
  `hold`. A close with a null frequency or source, or with 8 already held, is delivered at
  once as not-data. Otherwise one `unref`'d timer of 1 000 ms; on expiry the gate scans the
  ring for an entry with the same source id, `|hz - tx.hz| <= 1 250` and
  `startedAt - 1 000 <= at <= endedAt + 1 000`. If none matches and the ring has wrapped with
  its oldest entry newer than `startedAt - 1 000`, the result is not-data (unknown → publish).
  `stop()` delivers every held close immediately as not-data, so shutdown ordering holds.
- Live evidence: `feedAnalogEvidence` routes closed events through the same gate before
  `log.record`, adding a core-only `data: true` field on the evidence log entry
  (`AnalogEvidenceTransmission` is core, not api-types). `live-audio-evidence.ts` `attach`
  returns before `recordAnalog` when `tx.data === true`: no analog proof is written. Open
  events are recorded as today. Tested through `labelFromEvidence`: a data transmission
  yields no analog-fm candidate and no rejected row.

Bound arithmetic: a published transmission needs at least 500 ms of audio, so one tracker
closes at most 3 transmissions in any 1 s hold window; 8 leaves margin for restarts. At the
enforced 16 receptions per source per second, 256 entries cover at least 16 s of one busy
source; POCSAG at 1 200 bit/s carries a few messages per second, so the real rate is far
below 16. A data transmission longer than the ring's span whose only decode is at its start
publishes as today. Memory: 256 × 3 fields ≈ 8 kB plus at most 8 timers per tracker.

The WebSocket `transmission` closed event is broadcast at close as today, without the hold.

## 5. Passive finding

No code. The acceptance plan records passive status.

## CPU and hot path (`docs/PERFORMANCE.md`)

| Change                              | Rate                      | Cost                                             |
| ----------------------------------- | ------------------------- | ------------------------------------------------ |
| Strong-block count (1.8)            | per track per 50 ms block | one compare, one increment, no allocation        |
| Creation gate, pending (1.2 to 1.5) | per unmatched observation | O(1) map work, at most 5 samples                 |
| Cross-family sticky (2.1)           | per evidence-less obs     | under 16 range queries on sorted indexes         |
| Compatibility, best, majority (3.x) | per merge / settle        | O(1) on cached medians; tally in the 64-obs pass |
| Co-channel prune (2.3)              | per refresh               | at most 64 links sorted, 8 kept                  |
| Identity split (2.4)                | per identity decode       | scan of one source's decoded records             |
| Data gate (4)                       | per envelope / per close  | ring push; one 256-entry scan per close          |

Budgets (checked in DQ.8):

- Per block (1.8): with `CHANNEL_GATE_MAX_SLOTS` 4 096 tracks at 20 blocks/s, at most
  82 000 extra compare-and-increment operations per second, under 0.1 ms of CPU per second
  on a desktop and under 1 ms per second on a Pi 4-class core: under 0.001 core, far below
  the 0.3-core noise floor, at both 2.048 and 2.4 Msps (the cost scales with tracks, not
  sample rate). Event-loop p99 change: none measurable (the tracker runs in the spectrum
  worker).
- Per observation (store, main thread): the added work stays inside the WG11 store CPU
  budget; expected under 0.01 core on a desktop and under 0.03 core on a Pi 4-class core at
  either rate, and under 0.5 ms added to the event-loop p99 (rule 2 allows 2 ms).
- Data gate: negligible (per envelope and per close).

## Tests and goldens expected to change

Found with `grep` over `tests/`:

- Tracker/gate: `tests/unit/core/spectrum/frame-tracks-golden.test.ts`,
  `frame-tracks.test.ts`, `frame-tracks-property.test.ts`, `pipeline-gate.test.ts`,
  `pipeline-burst.test.ts`, `channel-gate.property.test.ts`.
- Store admission, association and settle: `tests/unit/core/scanner/discovery-store.test.ts`,
  `discovery-store-gate.test.ts`, `discovery-store.property.test.ts`,
  `discovery-store-attribution.test.ts`, `discovery-store-evidence-family.test.ts`,
  `discovery-store-evidence-sink.test.ts`, `discovery-store-identity.test.ts`,
  `discovery-store-identity-guard.test.ts`, `gated-surfacing.property.test.ts`,
  `surfacing-noise.test.ts`, `store-index.property.test.ts`, `store-counts.property.test.ts`,
  `merge-alias-store.test.ts`, `merge-alias-property.test.ts`, `merge-alias-goldens.test.ts`,
  `scanner-service-gated.test.ts` (fixtures under 18 dB, or overload under 25 dB, that expect
  a created record need higher SNR or three sightings).
- Store goldens: `store-change-golden.test.ts`, `store-change-golden-dense.test.ts`,
  `store-change-golden-trim.test.ts` with `__goldens__/store-golden-driver.ts` (re-baseline;
  each diff explained in the task report).
- Decode attach: `band-scan-dmr-classify.test.ts`, `identify.test.ts`.
- Data gate: `tests/unit/core/analog-transmission-wiring.test.ts`,
  `live-audio-evidence.test.ts`, `live-audio-evidence.property.test.ts`,
  `labels-from-evidence.property.test.ts`, `scanner-service-analog-wiring.test.ts`.
  `transmission-row*.test.ts` do not change.

## Live acceptance plan

One quiet-host run after the image is final, on a band with PMR users, a pager channel and a
strong local carrier, at least 30 min, recording discovery snapshots, Activity, and
`/api/scanner/status` `sources[].passive` at the same cadence (5.2). Pass when: no record is
born on an undecoded overload observation under 25 dB; no undecoded record has best SNR
under 18 dB unless it reached three sightings with median 15 dB; each emitter maps to one
record; no pager burst appears as an analog-transmission row; the passive-on fraction is
reported. A run with passive off for most of its length is inconclusive for update cadence.

## Correctness properties

**Property 1: No weak overload birth.** For any sequence, no discovery is created without
decode proof from an overload-flagged observation under 25 dB, and no overload-flagged
observation enters pending. _Validates 1.2, 1.7._

**Property 2: Creation threshold.** Preconditions: one source, no retune or source removal,
no pending eviction (fewer than 512 entries), all observations evidence-less, not overload,
finite centre and SNR, centres within one bucket, matching no existing record. Then a
discovery exists after the sequence iff some observation has SNR >= 18 dB, or some entry
window [first, first + 600 000 ms) holds at least 3 distinct ids whose retained median SNR is

> = 15 dB, evaluated in arrival order with the window restarting at the first sample after
> each expiry. _Validates 1.3, 1.4, 1.5, 1.6._

**Property 3: Pending bound.** For any sequence, pending entries per source never exceed 512,
samples per entry never exceed 5, and no entry outlives first + 600 000 ms at a sweep.
_Validates 1.5._

**Property 4: Strong duration.** For any block SNR sequence and any split point handled by
`inheritRun`, the gate passes only if at least `ceil(minMs / blockMs)` blocks of the run
have SNR >= k, at the same block with or without the split. _Validates 1.8._

**Property 5: Cross-family convergence.** For any interleaving of compatible observations
within 1 kHz with OBW ratio in [0.5, 2] and arbitrary family labels, exactly one discovery
results. _Validates 2.1, 2.2._

**Property 6: Co-channel bound.** After any sequence and refresh, every `coChannel` list has
at most 8 existing ids, each within tolerance, and links are reciprocal. _Validates 2.3._

**Property 7: Identity rule scope.** For any decode sequence, a decode is refused only when
all 2.4 conditions hold; a decode on the stronger record, or of a protocol outside the
digital-voice set, is never refused. _Validates 2.4._

**Property 8: Ambient best is stable.** For any ambient history (at least 3 observations)
and any observation that 3.1 refuses or that is overload-flagged, the record's
`signal.best` is unchanged. _Validates 3.1, 3.3, 3.5._

**Property 9: No incompatible merge.** For any sequence of observations, refreshes and
settles, no record ever holds two observations that were incompatible with its medians at
merge time, and `settle`/`absorb` never merge two records whose medians are incompatible.
`compatible` is false iff both 3.1 conditions hold on finite inputs with history >= 3.
_Validates 3.1, 3.2, 3.5._

**Property 10: Majority class.** For any observation window, `class` equals the majority of
the last 64 non-edge classes with the recency tie-break. _Validates 3.4._

**Property 11: Data suppression.** For any set of closes and receptions, a close is withheld
from Activity iff it was held and a reception with the same source, channel basis, trusted
tuning, within 1 250 Hz and the time window was retained; every close is delivered exactly
once. _Validates 4.1, 4.3, 4.5, 4.6._
