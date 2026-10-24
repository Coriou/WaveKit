# Detection quality design (WG15 DQ)

Status: reviewed design, not implemented (2026-10-24). Requirements in
[requirements](requirements.md), tasks in [tasks](tasks.md). Background: the
[scanner redesign](../scanner-redesign/design.md) channel gate and evidence labels,
`docs/SCANNER.md`, and the hot-path rules in `docs/PERFORMANCE.md`.

## Root causes (code as of the base commit)

| Fault                     | Where                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noise and intermod admit  | `DiscoveryStore.ingest` (`src/core/scanner/store/discovery-store.ts`) checks only sticky flags, `jobIds`, and `track.gate === "passed"`, then `createFrom`; `overload` is a flag only. Tracker `noteQualified` (`src/core/spectrum/emissions/tracker.ts`) counts `gateOnBlocks`, which includes hysteresis blocks (k - 1.5 dB) and the tolerated off block. |
| One emitter, many records | `stickyMatch` searches only the observation's family list (plus decoded centres); `keyTarget` merges only within a family and drops `carrier` records for unknown observations, so each new carrier sighting creates a record with `coChannel = atKey`. Co-channel links are appended (capped at `LINKS_MAX` 64) and never pruned.                          |
| Ambient misattach         | `stickyMatch` takes the nearest centre within tolerance with no level or OBW check; `absorbStats` raises `signal.best` from any higher-SNR observation; `applyClassificationTo` takes the latest class.                                                                                                                                                     |
| Pager as voice            | `AnalogTransmissionTracker` publishes any qualifying squelch segment (`ANALOG_TRANSMISSION_MIN_MS` 500, 3 carrier blocks), constant-envelope FSK quiets FM fully; `src/core/activity/storage/row.ts` hard-codes `category: "voice"`; `live-audio-evidence.ts` stamps `voice: true`.                                                                         |
| Rarely updated            | No passive job: `ingest` returns transient for `jobIds.length === 0`; passive ended at the cost guard's first judgement (`PASSIVE_COST_WINDOW_MS` after engine open, limit 0.25 core, clear at 0.20).                                                                                                                                                       |

## Contract (frozen)

New constants in `src/core/scanner/detection-quality-contract.ts` (new, core only):

| Constant                    | Value   | Requirement |
| --------------------------- | ------- | ----------- |
| `DQ_CREATE_SNR_DB`          | 15      | 1.2         |
| `DQ_PENDING_MIN_OBS`        | 3       | 1.3         |
| `DQ_PENDING_WINDOW_MS`      | 600 000 | 1.3, 1.5    |
| `DQ_PENDING_MEDIAN_SNR_DB`  | 10      | 1.3         |
| `DQ_PENDING_PER_SOURCE`     | 512     | 1.5         |
| `DQ_PENDING_SAMPLES`        | 5       | 1.5         |
| `DQ_CROSS_FAMILY_HZ`        | 1 000   | 2.1, 2.2    |
| `DQ_OBW_RATIO_MIN` / `_MAX` | 0.5 / 2 | 2.1         |
| `DQ_CO_CHANNEL_MAX`         | 8       | 2.3         |
| `DQ_IDENTITY_SPLIT_HZ`      | 6 000   | 2.4         |
| `DQ_IDENTITY_CONCURRENT_MS` | 60 000  | 2.4         |
| `DQ_LEVEL_SPLIT_DB`         | 20      | 3.1         |
| `DQ_OBW_SPLIT_RATIO`        | 1.5     | 3.1         |
| `DQ_MIN_HISTORY_OBS`        | 3       | 3.1, 3.4    |
| `DQ_DATA_FREQ_HZ`           | 1 250   | 4.1         |
| `DQ_DATA_HOLD_MS`           | 1 000   | 4.1, 4.3    |
| `DQ_DATA_HELD_MAX`          | 8       | 4.5         |
| `DQ_DATA_RING`              | 256     | 4.5         |

No change to `packages/api-types`, the persisted store schema, the REST or WebSocket shapes,
or `docs/CLI-COORDINATION.md`. Pending entries are memory-only.

## 1. Admission

### Tracker (hot path)

`OpenTrack` gains `gateStrongBlocks: number`, reset wherever `gateOnBlocks` is reset
(`clearGateRun`, run start). In the on branch of the gate step, after `isOn` returns true,
`if (snr >= k) t.gateStrongBlocks++` (one compare, no allocation). `noteQualified` tests
`t.gateStrongBlocks * blockMs < t.gateMinMs` instead of `gateOnBlocks`. `gateOnBlocks` keeps
its other readers (run length, traces). The off and hysteresis paths are unchanged.

### Store creation gate

In `ingest`, after `keyTarget` returns no merge and before `createFrom`:

```ts
const proven = decodeProvesSignal(input, opts.decode)
if (!proven) {
	if (input.track.flags.overload !== false) return TRANSIENT // 1.1, 1.7 (absent = refuse)
	const snr = input.track.snrDb
	if (!(Number.isFinite(snr) && snr >= DQ_CREATE_SNR_DB)) {
		if (!this.pending.note(input)) return TRANSIENT // held or refused
	}
}
return this.createFrom(input, label, target.coChannel)
```

`decodeProvesSignal` today already lets a decode-proven observation bypass the gate; the
same predicate exempts it here. The sticky and key-merge paths above are unchanged except
for 3.1.

### Pending holder

`src/core/scanner/store/pending-admission.ts` (new), owned by the store:

```ts
interface PendingSample {
	id: string
	at: number
	snr: number
}
interface PendingEntry {
	sourceId: string
	bucket: number
	samples: PendingSample[]
} // <= 5
class PendingAdmission {
	note(obs: ObservationInput): boolean // true = promote now
	clear(sourceId?: string): void
}
```

- Bucket: `Math.round(centreHz / 2 500)` per source, independent of OBW, so the varying-OBW
  keys of 2b do not scatter one candidate. A neighbouring bucket (±1) is also searched so a
  centre near a bucket edge still accumulates; the nearest existing entry wins.
- `note`: drop samples older than `now - DQ_PENDING_WINDOW_MS`; replace the sample with the
  same id (keep the larger SNR, 1.6) or append (drop the oldest beyond 5); promote when at
  least 3 samples remain and their median SNR (non-finite SNRs excluded, 1.7) is >= 10 dB.
  On promotion the entry is deleted.
- Order and eviction: one `Map` per source in insertion order; a touched entry is deleted
  and re-inserted, so the first key is the oldest last sample; when the size reaches 512 the
  first entry is evicted (O(1)).
- Expiry: lazily on `note`, plus a sweep from the store's existing refresh tick that drops
  entries whose newest sample is older than 10 min (bounded by 512 per source).
- `clear(sourceId)` runs on source removal and on retune (the store's existing retune
  hook), so a pending entry never outlives the tuning it was measured under.

Bound arithmetic: a sample is about 3 fields (an id reference, two numbers) ≈ 40 B, an entry
with 5 samples and its map slot ≈ 300 B, so 512 entries ≈ 150 kB per source. 512 covers
more than half of a 2.4 Msps window at 2.5 kHz buckets (2 400 000 / 2 500 = 960 buckets);
the measured watch produced about 70 noise and intermod records across 50 min, far below
the cap. Eviction only delays a slow candidate, never creates one (safe side). Work per
observation: one map lookup per bucket (3), at most 5 samples filtered and one sort of at
most 5 numbers.

Promotion creates the discovery from the promoting observation only; earlier pending
observations are not back-filled (they were never stored). Restarting the core drops
pending entries; that only delays creation.

## 2. One emitter, one discovery

### Cross-family sticky

`stickyMatch` keeps today's same-family search. When the observation is evidence-less, it
then searches each other family's centre list over `[centre - min(tol, 1 000) - 1,
centre + min(tol, 1 000) + 1]` (the WG11 1 Hz widening), with the extra filter
`0.5 <= obs.obwHz / median OBW <= 2` read from the cached medians (`mediansOf`). The best
candidate across both searches is the nearest (today's tie-break on equal distance). The
family count is a small fixed set (under 16), so this is under 16 range queries per
observation on the sorted per-family index, O(F log n). This also covers carrier records
(2.2), so `keyTarget` keeps its carrier exclusion for key-only merges beyond 1 kHz.

### Co-channel pruning

At `refresh` (where a record's medians and key are recomputed), each record's `coChannel`
is rebuilt from its current list: keep ids that exist and whose median centre is within the
record's `toleranceHz`, sort by distance, keep the first 8; then unlink dropped ids
reciprocally through the existing `syncProofWatch` path. `createFrom` also caps at 8.

Bound arithmetic: the association window is at most 2 × tolerance, i.e. 2 × 2 000 = 4 kHz
on the grid path for narrowband (and 2 × 1 562 = 3.1 kHz on a 6.25 kHz raster). Distinct
co-located emitters in 4 kHz on one source are at most one per family plus a carrier; 8
leaves room for two per family pair without truncating real partners. The proof-watch pin
bound (1 + `LINKS_MAX` = 65 pinned observations) only shrinks.

### Identity split

In `applyEvidence`, before applying identity evidence to record `d`: scan the source's
records whose confidence is `decoded` (bounded by `maxDiscoveries`; decoded records are a
small subset). If one other than `d` has the same protocol, `sameIdentity`, a median centre
at least 6 000 Hz from `d`'s, and `lastSeenAt >= now - 60 000`, return `null` (no change, no
journal entry). Called per decode, not per frame.

## 3. Ambient misattach

`mediansOf` gains the median `peakDbfs` and the observation count it used (computed in the
same pass over the last 64 observations; no new walk). A pure helper
`compatible(obs, medians): boolean | null` returns null when history < 3 or any input is
non-finite (3.4), false when both 3.1 conditions hold, true otherwise. `stickyMatch`'s
`consider` and `keyTarget`'s merge candidates skip a `false` record. `absorbStats` takes a
`raiseBest` flag: `compatible !== false && compatible !== null && !overload` For a record with
fewer than 3 observations the flag is `!overload` with a finite SNR, so a young record still
learns its best; non-finite inputs never raise it.

Class majority: a class tally over the same 64-observation window, built in the medians pass
(edge observations excluded); ties broken by the most recent. `applyClassificationTo` uses
the majority class for `class`; protocol refinement from classification is unchanged.

## 4. Data is not voice

### Data decode gate

`src/core/data-decode-gate.ts` (new, core only):

```ts
export interface DataDecodeGate {
	noteEnvelope(env: DecodeEnvelope): void // via the Activity publisher tap
	hold(event: ClosedTransmission, deliver: (isData: boolean) => void): void
	stop(): void // flushes held closes as not-data
}
```

- Tap: `src/index.ts` already passes the Activity publisher to
  `decoderManager.setActivityPublisher`. The composition wraps that publisher so each
  envelope is also offered to `noteEnvelope` (try/catch, never throws into the decoder
  path). Only `category` `paging` or `aprs` with finite `provenance.frequency.hz` and a
  finite `producedAt` are kept; the ring holds the last 256 as (hz, at).
- Hold: `wireAnalogTransmissions` gets an optional `dataGate`. Its `closed` handler calls
  `hold`; after `DQ_DATA_HOLD_MS` (one timer per held close, `unref`'d) the gate scans the
  ring for an entry with `|hz - tx.hz| <= 1 250` and `startedAt - 1 000 <= at <= endedAt +
1 000`, then calls `deliver(isData)`. The Activity sink receives the payload only when not
  data. A close with a null frequency, or arriving with 8 already held, is delivered at once
  as not-data (4.5, 4.6). `stop()` delivers every held close immediately, so shutdown
  ordering (closed events before Activity closes) holds.
- Live evidence: `feedAnalogEvidence` routes closed events through the same gate before
  `log.record`, adding a core-only `data: true` field on the evidence log entry (the
  `AnalogEvidenceTransmission` type is core, not api-types). `live-audio-evidence.ts`
  builds `voice: !tx.data` with outcome `heard` when data. Open events are recorded as
  today.

Bound arithmetic: a published transmission needs at least 500 ms of audio, so one tracker
closes at most 3 transmissions in any 1 s hold window; 8 held closes leave margin for
tracker restarts. The ring of 256 at a generous 4 data decodes per second covers 64 s; the
match window needs decodes from `start - 1 s`, so a data transmission longer than about 60 s
whose only decode is at its start can fail open (published as today). Memory: 256 × 2
numbers ≈ 4 kB plus at most 8 timers.

The WebSocket `transmission` closed event is broadcast at close as today, without the hold.

## 5. Passive finding

No code. The acceptance plan (below) records passive status.

## CPU and hot path (`docs/PERFORMANCE.md`)

| Change                              | Rate                      | Cost                                                                                  |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| Strong-block count (1.4)            | per track per 50 ms block | one compare and one increment; no allocation                                          |
| Creation gate, pending (1.1 to 1.3) | per unmatched observation | O(1) map work, at most 5 samples                                                      |
| Cross-family sticky (2.1)           | per evidence-less obs     | under 16 range queries on sorted indexes                                              |
| Compatibility, best, majority (3.x) | per merged observation    | O(1) compares on cached medians; tally in the 64-obs pass already run on invalidation |
| Co-channel prune (2.3)              | per refresh               | at most 64 links sorted, then 8 kept                                                  |
| Identity split (2.4)                | per identity decode       | scan of decoded records of one source                                                 |
| Data gate (4)                       | per envelope / per close  | ring push; one 256-entry scan per close                                               |

Only 1.4 touches the per-block path. Store work stays per observation (throttled) and
remains inside the WG11 store CPU budget; task DQ.8 measures it with the existing store
benchmarks.

## Tests and goldens expected to change

Found with `grep` over `tests/`:

- Tracker/gate: `tests/unit/core/spectrum/frame-tracks-golden.test.ts`,
  `frame-tracks.test.ts`, `frame-tracks-property.test.ts`, `pipeline-gate.test.ts`,
  `pipeline-burst.test.ts`, `channel-gate.property.test.ts` (runs that qualified on
  hysteresis blocks now need strong blocks).
- Store admission and association: `tests/unit/core/scanner/discovery-store.test.ts`,
  `discovery-store-gate.test.ts`, `discovery-store.property.test.ts`,
  `discovery-store-attribution.test.ts`, `discovery-store-evidence-family.test.ts`,
  `discovery-store-evidence-sink.test.ts`, `discovery-store-identity.test.ts`,
  `discovery-store-identity-guard.test.ts`, `gated-surfacing.property.test.ts`,
  `surfacing-noise.test.ts`, `store-index.property.test.ts`, `store-counts.property.test.ts`,
  `merge-alias-store.test.ts`, `scanner-service-gated.test.ts` (fixtures with SNR below
  15 dB or overload that expect a created record need either higher SNR or three sightings).
- Store goldens: `store-change-golden.test.ts`, `store-change-golden-dense.test.ts`,
  `store-change-golden-trim.test.ts` with `__goldens__/store-golden-driver.ts`
  (re-baseline; each diff explained in the task report).
- Decode attach: `band-scan-dmr-classify.test.ts`, `identify.test.ts`.
- Data gate: `tests/unit/core/analog-transmission-wiring.test.ts`,
  `live-audio-evidence.test.ts`, `live-audio-evidence.property.test.ts`, and the composition
  test that covers `feedAnalogEvidence` (`scanner-service-analog-wiring.test.ts`).
  `transmission-row*.test.ts` do not change (rows are suppressed, not recategorised).
- Constants: none in `scanner-redesign-contract.test.ts` (gate constants unchanged).

## Live acceptance plan

One quiet-host run after the image is final, on a band with PMR users, a pager channel and
a strong local carrier, at least 30 min, recording discovery snapshots, Activity, and
`/api/scanner/status` `sources[].passive` at the same cadence (5.2). Pass when: no record is
born on an overload observation without decode evidence; no record has best SNR under
15 dB unless it reached three sightings; each emitter maps to one record; no pager burst
appears as an analog-transmission row; the passive-on fraction is reported. A run with
passive off for most of its length is reported as inconclusive for update cadence, not as a
pass.

## Correctness properties

**Property 1: No evidence-less overload birth.** For any sequence of observations, a
discovery created without decode proof is never created from an overload-flagged or
non-finite-SNR observation. _Validates 1.1, 1.7._

**Property 2: Creation threshold.** For any evidence-less sequence at one centre, a
discovery exists iff some observation has SNR >= 15 dB or some 10-minute window holds 3
distinct ids with median SNR >= 10 dB (with no pending eviction in the run). _Validates 1.2, 1.3, 1.6._

**Property 3: Pending bound.** For any sequence, pending entries per source never exceed
512 and samples per entry never exceed 5. _Validates 1.5._

**Property 4: Strong duration.** For any block SNR sequence, the gate passes only if at
least `ceil(minMs / blockMs)` blocks of the run have SNR >= k. _Validates 1.4._

**Property 5: Cross-family convergence.** For any interleaving of observations within
1 kHz with OBW ratio in [0.5, 2] and arbitrary family labels, exactly one discovery
results. _Validates 2.1, 2.2._

**Property 6: Co-channel bound.** After any sequence and refresh, every `coChannel` list has
at most 8 existing ids, each within tolerance, and links are reciprocal. _Validates 2.3._

**Property 7: Identity uniqueness.** For any decode sequence, no two concurrently seen
decoded records of one source with the same protocol and identity lie 6 kHz or more apart.
_Validates 2.4._

**Property 8: Ambient best is stable.** For any ambient history (at least 3 observations)
and any observation that 3.1 refuses or that is overload-flagged, the record's
`signal.best` is unchanged. _Validates 3.1, 3.2, 3.4._

**Property 9: Merge symmetry of the split rule.** `compatible` is false iff both the 20 dB
and 1.5× conditions hold on finite inputs with history >= 3; otherwise it never refuses.
_Validates 3.1, 3.4._

**Property 10: Majority class.** For any observation window, `class` equals the majority of
the last 64 non-edge classes with the recency tie-break. _Validates 3.3._

**Property 11: Data suppression.** For any set of closes and data decodes, a close is
withheld from Activity iff a qualifying decode exists in its frequency and time window and
the close was held; every close is delivered exactly once. _Validates 4.1, 4.3, 4.5._
