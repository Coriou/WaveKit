# Detection quality design (WG15 DQ)

Status: reviewed design, not implemented (2026-10-24; revised after spec review the same
day). Amendment (reviewed 2026-10-25): sections 7 and 8. Amendment (draft 2026-10-25):
section 9. Requirements in
[requirements](requirements.md), tasks in [tasks](tasks.md).
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
| `DQ_CONSOLIDATE_GROUP_MAX`  | 16 (survivor plus 15)          | 7.3, 7.8    |
| `DQ_CONSOLIDATE_SCAN_MAX`   | 32                             | 7.3, 7.7    |
| `DQ_YOUNG_OBW_RATIO`        | 3                              | 9.2, 9.6    |
| `DQ_SUSTAIN_MEDIAN_SNR_DB`  | 12                             | 1.4b        |
| `DQ_SUSTAIN_FLOOR_SNR_DB`   | 9                              | 1.4b        |
| `DQ_SUSTAIN_MS`             | 3 000                          | 1.4b        |
| `DQ_SUSTAIN_MIN_SAMPLES`    | 3                              | 1.4b        |
| `DQ_SUSTAIN_MAX_GAP_MS`     | 2 500                          | 1.4b        |
| `DQ_SUSTAIN_SAMPLES`        | 8                              | 1.4b        |
| `DQ_SUSTAIN_PER_SOURCE`     | 512                            | 1.4b        |
| `DQ_CREATE_TRACK_SNR_DB`    | 15                             | 1.4c        |
| `DQ_SHORT_BURST_BLOCKS`     | 20                             | 1.4c        |
| `DQ_PTT_WINDOW_MS`          | 60 000                         | 1.4d        |
| `DQ_PTT_PER_SOURCE`         | 512                            | 1.4d        |
| `DQ_PTT_IDS_MAX`            | 8                              | 1.4d        |
| `DQ_LOCAL_SNR_DB`           | 6                              | 1.15        |
| `DQ_DC_ADMIT_HZ`            | 12 500                         | 1.15        |

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
isFinite(snr)`: undecided compatibility on a young record allows a best update from a
  non-overload observation; overload never raises best.
- `absorb` of two compatible records keeps the better `signal.best`, skipping a best set by an
  overload-flagged observation and an absorbed best its stored observation fails against the
  survivor's medians. `rehome` (an observation moved by a decode split) applies the same
  overload rule.

Class majority: `applyClassificationTo` sets `class` from the tally (edge and `unknown`
observations excluded; ties to the most recent). The tally reads each observation's persisted
`classVote`; a re-ingest that changes only the vote recomputes and journals the class, and
`absorb` (so every `settle` merge) and `rehome` re-apply the majority to the records whose
observations changed. Protocol refinement from classification is unchanged.

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
  `startedAt - 1 000 <= at <= endedAt + 1 000`. Coverage is checked first (R4.5, revised
  2026-10-25): once the ring has overwritten an entry, a window whose start `startedAt - 1 000`
  is before the oldest retained entry, or at or before any overwritten entry's time, is
  not-data (unknown → publish) whether or not a retained entry matches.
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

## 7. Legacy consolidation (amendment)

### Root cause (code as of the amendment base)

- `stickyMatch` (`src/core/scanner/store/discovery-store.ts`, about lines 1952 to 2026)
  picks the **nearest** record within tolerance (cross-family within 1 kHz for an
  evidence-less observation), tie-break `lastSeenAt` then id. It ignores identity and never
  looks at a second candidate. With two records 100 to 600 Hz apart and observation centres
  jittering about +-440 Hz, each observation goes to whichever record is nearer, so both
  are updated indefinitely.
- `settle` (about line 3124) merges only records returned by `atKey(source, key)` that have
  the same **effective** family (`effectiveLabel`, evidence-derived, not the persisted
  `family`) and the same identity, and it runs only for the record an operation touched.
  Records on different keys, or one labelled `unknown` and one `analog` by evidence, are
  never compared. Nothing walks the store to fold pairs created before 2.1.
- The `g:` key is bandwidth-dependent: `frequencyKey` (`src/core/scanner/bandplan/index.ts`
  line 112) rounds to `gridToleranceHz(obw)` = round(max(2 000, obw / 4) / 500) x 500
  (line 78), so one emitter whose median OBW is 11 kHz on one record and 14 kHz on another
  lands on 3 000 Hz and 3 500 Hz grids and on different keys. This is a contributor, not
  the main cause: in the offline replay about 29 % of joinable pairs differed in key, about
  62 % shared the key but differed in effective family, about 9 % shared key, family and
  identity (an older duplicate `settle` never revisited after a refresh moved it).
  Follow-ups 6.1 and 6.2 remove the key cause; requirement 7 does not depend on keys.
- Existing merges are state-based in the journal: `absorb` (about line 3154) writes the
  survivor, the moved observations, `deleted` and the alias entries through the op's
  `StoreMutation` (`src/core/scanner/store/schemas.ts` line 289); `replay` applies the
  mutation (about line 1922). No merge function is re-run at replay. `rekey` (about line 1286) is the one existing whole-source pass (refresh every record, then `settle` each).

### Store facts used

- Merge function: `absorb(op, keep, drop)` already sums `observationCount` and `airtimeMs`,
  widens first/last seen, picks `signal.best` by 3.3 (`bestEligible`), takes
  `signal.last`/`tuningTrust` from the later record, LRU-merges metadata, unions `jobIds`,
  `sourceIds`, evidence flags and recording counts, ORs operator flags, re-points and
  prunes `coChannel` (2.3), adopts aliases, deletes `drop`, refreshes and re-applies the
  majority class (3.4, `classVote` per stored observation). Requirement 7 reuses it
  unchanged.
- Aliases: `RecordingAliasTable` (`src/core/scanner/recording-aliases.ts`) maps an absorbed
  id to its survivor (O(1) `aliasOwner`, at most `DISCOVERY_RECORDING_ALIASES_MAX` 64 per
  owner, oldest released), persisted in the snapshot `aliases` and in each mutation's
  `aliases`. It is read only by the evidence store for recording folders. The REST route
  `GET /api/scanner/discoveries/:id` (`src/api/routes/scanner.ts` line 621) calls
  `store.get(id)`, which does not consult aliases: an absorbed id answers 404. Requirement 7
  keeps that (follow-up 6.5).

### Algorithm

New pure module `src/core/scanner/store/consolidation.ts`:

```ts
interface ConsolidationRecord {
  id: string; sourceId: string; centreHz: number; obwHz: number; peakDbfs: number
  count: number; young: { peakDbfs: number; obwHz: number }[]
  identity?: { kind: string; value: string }; family: ProtocolFamily
  decoded: boolean; protocol: string; firstSeenAt: string; hasOperator: boolean
}
joinable(a, b): boolean                      // 7.1, pure, O(1) (young <= 2 entries)
rankCompare(a, b): number                    // 7.2
nearest(sorted, centreHz, radiusHz, k): ConsolidationRecord[]   // 7.3 step 2
planConsolidation(records): { groups: { survivor: string; members: string[] }[];
                              truncated: number }               // 7.3, 7.4
```

`nearest` binary-searches the per-source array sorted by (centre, id) and walks outward
with two pointers, taking the nearer side each step (ties: smaller id), stopping after `k`
entries or past the radius: O(log n + k), independent of density. `planConsolidation` builds
the frozen records once (the store fills them from `mediansOf`, `recentOf`,
`effectiveLabel`), sorts by rank, and for each unowned survivor takes `nearest(.., 1000,
32)`, skips owned and higher-ranked entries (they still count toward 32), selects joinable
ones until 16, then marks the group owned. Pure, so order independence and the ownership
rules are property-tested on the function without a store.

Store: `consolidatePlan(): Plan` (builds records, calls the planner) and
`applyConsolidation(plan): { groups, absorbed }`. Each group runs `commit("rekey", op =>
...)`, absorbing each still-live member into the still-live survivor with `absorb` (`planned`: the pair was checked on frozen values, so the 3.2 re-check against medians
earlier members moved is skipped, requirement 7.5), so the journal line is the ordinary merge
mutation. `rekey` is a journal op every existing reader accepts (`JournalLineSchema`,
`src/core/scanner/store/persistence.ts` line 389); `replay` applies the payload whatever
the op name (about line 1922), so an older reader replays a group as an ordinary merge. A
new op name would be skipped by an older reader as an invalid line (`readJournal`, about
lines 1228 to 1235) and resurrect the absorbed records with their observations moved away.

Lazy path: `stickyMatch` returns `best`; the observation's commit then calls
`lazyConsolidate(op, best)`, which builds frozen records for `best` and its 32 nearest
(`CentreIndex.nearest`, a new bounded outward walk over each centre family list of the
source plus the decoded list, merged nearest-first, cut at 32), picks the survivor and
members by 7.7, absorbs them, and returns the survivor that `addObservation` then uses.

Service (`ScannerService.startUp`, after the journal replay and after the mutation listener
is attached, before the change listener and before any job starts):

1. `persistence.readConsolidationPlan()`: a valid file is resumed with `applyConsolidation`;
   an invalid one is logged and treated as none (no new plan this load).
2. Otherwise `store.consolidatePlan()`; if it has groups, `writeConsolidationPlan(plan)`
   (atomic: tmp, fsync, rename) and then `applyConsolidation(plan)`.
3. If any plan file existed or was written: `writeSnapshotOf(store)` and, once it resolves,
   `removeConsolidationPlan()`. A failed snapshot leaves the file; the next load resumes it
   (every group already applied is a no-op: its members are gone).

Crash equivalence: the plan is fixed before any group runs and is reused on resume, groups
are disjoint (ownership), each group is one journal line, and a group already applied has
no live members. So the end state is the same for any crash point. Without the plan file,
a resume would recompute from refreshed survivor medians and could choose differently;
that is why the file exists.

Plan file: `consolidation-plan.json` beside the snapshot, Zod-validated
`{ version: 1, createdAt, groups: { survivor, members[] }[] }`, at most 10 000 groups.

### CPU

As requirement 7.8. Planning: two sorts plus at most 32 visits and 32 O(1) checks per
record. Execution dominated by `absorb` (observation moves). The load path is synchronous;
if a measured run on the reference store exceeds the 50 ms desktop target, groups are
applied in slices with `setImmediate` between slices while the start-up awaits them (ingest
has not started). Lazy path: at most 32 visits and checks per sticky match, inside this
spec's per-observation budget.

## 8. Passive marginal cost guard (amendment)

### Current logic

`checkPassiveCost` (`src/core/scanner/scanner-service.ts` about lines 6619 to 6715): for each
source with an open engine and a passive job (or a guard-disabled one), at open + 60 s then
every 300 s, it computes the engine worker's windowed event-loop utilization
(`windowedUtilization`, `src/core/scanner/passive-cost.ts`) and feeds
`passiveCostDecision`: disable above the limit, clear at or below 0.8 x limit. A
guard-disabled source whose engine closed is re-enabled after `PASSIVE_PROBATION_MS`
(`passiveProbationDue`). The engine is shared: `SpectrumService` keeps per-source
`jobs` (`job:<id>`) and `displays` (`ws:<clientId>`) consumer sets
(`src/core/spectrum/spectrum-service.ts`, `Entry` about line 382; `allocation().consumers`
about line 718) and closes the engine only when both are empty (`release`, about line 562).
So with a display open the utilization is the display's cost plus passive's, and passive
can be disabled for cost it did not cause; and once disabled, it comes back only if the
whole engine (display alone) falls under 0.2 or the display closes.

What passive adds to a shared engine: its job's masks and CFAR ranges (`updateMasks`), the
lease holder's tuning when passive holds the arbiter lease (`engineTuning`, about line
2438; a different FFT size or integration reconfigures the worker and bumps its
generation), and the tracker and observation work in the worker. A display-only engine runs
the FFT and summaries regardless.

### Design

New pure function in `src/core/scanner/passive-cost.ts`, implementing the 8.4 table row by
row:

```ts
passiveGuardDecision(input: {
  passive: "enabled" | "disabled"
  holders: "sole" | "shared" | "off" | "closed"
  measurement: number | null      // U over a completed window (8.2), else null
  baseline: number | null         // valid B (8.3), else null
  limit: number
  recheckDue: boolean             // 300 s since the last judgement of rows 2 to 4
  baselineWindowAllowed: boolean
  trialDue: boolean
  probationDue: boolean           // engine shut, WG11 rule
}): { decision: "keep" | "disable" | "clear" | "baseline" | "trial"; row: number;
      figure: "engine" | "passive" | null }
```

Service state per source (`ScannerService`): `window` `{ kind: "open" | "baseline" |
"trial" | "restore", engine, generation, startSample, startedAt }`, `baseline` `{ value,
engine, generation, others, at }`, `lastBaselineWindowAt`, `disabledAt`. Each 1 s guard tick
reads `spectrum.allocation().consumers[sourceId]` (holders, others), the engine's
`eluSample()` (generation), and:

- a generation that differs from the window's discards the window and starts a new one at
  this tick (8.2); if the guard did not add or remove passive within the previous tick, the
  baseline is invalidated too (8.3);
- a window is complete when `now - startedAt >= 60 000`; its `U` is `strictUtilization`
  between `startSample` and the current sample: same generation, neither counter going back,
  the total advancing, at least 60 s apart, never a whole-life fallback (null otherwise; the
  engine-open window starts from zero counters, 8.2). A counter that goes back within a
  generation restarts the window at this tick and clears the off-sample history (revised
  2026-10-25);
- `baseline` and `restore` windows, trial start and trial windows are evaluated at their
  deadline on this tick (8.7); `open` windows of rows 2 to 4 are judged at their first
  completion and then every 300 s, as today.

Passive removal and restore reuse `passiveDisabled` plus `refreshPassive()` with reasons
`measuring baseline` (row 6) and the `engine-cpu` / `passive-cpu` figures (rows 2 to 4).
The existing `passiveCostDecision`, `windowedUtilization` and `passiveProbationDue` stay
and are called by the new function (row 2 and 11 are exactly them).

Constants (`src/core/scanner/passive-cost-contract.ts`): `PASSIVE_BASELINE_MAX_AGE_MS`
1 800 000, `PASSIVE_SATURATION` 0.95. No new config key.

Pi protection: a headless receiver has only passive on the engine (row 2, today's rule;
0.99 core disables at open + 60 s). With a display open on such a host `U` saturates and
row 3 disables passive whether or not a baseline exists.

## 9. Young records and weak protocol guesses (amendment)

### Root cause (code as of the amendment base)

All in `src/core/scanner/store/discovery-store.ts` unless named.

- `ingest` (about lines 865 to 922) labels every evidence-less observation `unknown`
  (`labelFromEvidence(emptyProof(..))`), calls `stickyMatch`, then `keyTarget`, then
  `admits` (18 dB, line 940) and `createFrom`.
- `stickyMatch` (about lines 2112 to 2182) searches the `unknown` list with the full
  tolerance, then (2.1) every other family list within `min(tol, 1 000)` where `consider`
  (line 2145) requires `bandwidthJoins` (lines 2184 to 2198): observation OBW over the
  record's **median** OBW in [0.5, 2]. Measured: once the lazy path had folded the
  emitter's `unknown` records into the established `carrier` record beside it (median OBW
  29 to 31 kHz), the burst's first snapshot (13 to 14 kHz, ratio 0.42 to 0.48) matched
  nothing. An offline check on the store copy reproduced it: a 13 kHz observation 660 Hz
  from that record created a record, a 17 kHz one then joined the young record (same
  `unknown` list), and a 33 kHz one stuck to the carrier record and the lazy path absorbed
  the young record, which is the live pattern (each young record vanished at the
  emitter's next burst while the carrier record gained two observations).
- `keyTarget` (about lines 2200 to 2242) works only on the observation's key, and the `g:`
  key is OBW-dependent (`frequencyKey`, `src/core/scanner/bandplan/index.ts` lines 112 to
  120, grid `gridToleranceHz` lines 78 to 80): 13 kHz keys on a 3 500 Hz grid, 31 kHz on an
  8 000 Hz grid, so the fallback misses.
- The young-record rule (`recordsCompatible`, `src/core/scanner/store/compatibility.ts`;
  `obsCompatible` line 3033) returns undecided for a young record, which never refuses: it
  is not the cause. A young record whose effective family later turns `carrier` (sink
  proof) does refuse the other half of the emitter through `bandwidthJoins` (13 over
  33 kHz).
- Weak split: the centre lists are keyed by the effective family (`reindex`, line 4744,
  re-run after `invalidateLabel`), `keyTarget` filters by it (line 2210), `settle` (lines 3284 to 3309) merges only
  equal effective families (line 3291), and `frozenOf` (line 1365) feeds it to `joinable`
  (`consolidation.ts` lines 88 to 93), whose OBW test is the median ratio (line 79). A
  record without proof shows its persisted candidate label (`discoveryView`), so pocsag,
  dmr and analog-fm guesses are three families everywhere.

### Design

- `associationFamily(d)`: from `discoveryView(d)` (cached with the label, so no new proof
  read): the label's family when the label confidence is `decoded`, `d.identity` is
  defined, or the view's evidence is `proven`; otherwise `unknown`. Replaces
  `effectiveLabel(d).family` in the centre-list key (`reindex`; it keeps its persisted-family
  fallback when evidence cannot name a proof, mapped the same way), `keyTarget`, `settle` and `frozenOf`. Decode-driven paths
  (`coChannelEvidence`, `relocateIncompatible`, `establishedFamily`) keep the effective
  family.
- `Medians` gains `obwMin` and `obwMax`, computed in the existing pass over the last 64
  observations (two compares per observation, invalidated with the medians); non-finite OBWs
  are skipped and a window with none finite gives NaN (9.8).
  `bandwidthJoins(d, obw)` becomes the 9.2 band with `f` = `DQ_OBW_RATIO_MAX` when the
  record's effective confidence is `decoded` or it carries an identity, else
  `DQ_YOUNG_OBW_RATIO` (not from the observation count, so the count-3 transition and a
  carrier-only proof never narrow the band); any non-finite input returns false.
- 9.4 in `compatibility.ts`: `compatible` keeps its signature; `recordsCompatible` tests
  every pair of young observations when both records are young (at most 4 calls, false if
  any is false, null only when every pair is undecided), and a new
  `observationCompatible(record, obs)` tests the observation against the medians
  (established) or against each young observation. The store's `obsCompatible` calls it, so
  `stickyMatch` (both routes), `keyTarget`, `raisesBest` and the lazy survivor choice all
  refuse the same pairs; `pairCompatible` (settle, absorb) and `joinable` (plan, lazy)
  call `recordsCompatible`. `frozenOf` already passes the young observations.
- 9.5: `decodedConflict(a, b)` = both effective confidences `decoded` and protocols
  differ. `settle` skips (and links as co-channel) such a pair, `absorb` refuses it unless
  `planned`, `keyTarget` filters such records out of its merge targets, and `stickyMatch`
  skips them for an observation whose ingest decode names another protocol. `joinable`
  keeps its existing test, now on the effective protocol.
- `stickyMatch`: the same-family route (association family list, full tolerance, no band)
  and the cross-family or young route (every other list plus young records of any list,
  `min(tol, 1 000)`, 9.2 band) as 9.3; both routes apply 9.4 and 9.5. Nearest wins.
- `consolidation.ts`: `ConsolidationRecord` gains `obwMin`, `obwMax` and `bandFactor`;
  `joinable` checks each median against the other's band instead of the median ratio, and
  its family test reads the association family the store passes in `family`.
- Contract: `DQ_YOUNG_OBW_RATIO` = 3 in `src/core/scanner/detection-quality-contract.ts`.

Interaction: a weak-guess record now sits in the `unknown` list, so evidence-less
observations reach it with the full same-family tolerance and no OBW gate, exactly as a
record labelled `unknown` today. 9.4 refuses strong-next-to-weak pairs on every path,
young or established.

### CPU

As 9.7: no new index query; `associationFamily` is a field read on the cached view; at most
2 extra `compatible` calls per young candidate for an observation and 4 per young pair
(O(1)); two compares per observation in the medians pass. Ingest cost is measured on the
store bench before and after and reported (9.9), not asserted.

## 10. Sustained admission and segment split (amendment)

Requirements 1.4b and 1.11 to 1.14. Root causes from an offline replay of private hunt
captures through the real scanner (no captured data is committed): the 18 dB create
threshold refused gated tracks at 7 to 17 dB, a continuous emitter is one observation so the
3-observation repeat rule never fired, AM airband was diluted by 25 kHz slots, and busy bands
chained adjacent channels into 80 to 350 kHz segments whose averaged SNR was refused (or,
when admitted, one wideband record covered several emitters).

### Store

`PendingAdmission.sustained(obs)` keeps one run per observation id (`SustainRun`:
`firstAt`, `lastAt`, newest 8 SNRs). `admits()` order: invalid, overload, 18 dB, repeat
rule (`note`), then `sustained`. A sustained promotion returns `"create"`, so the bucket's
pending entry is consumed. The SNR read is `admissionSnrOf`: the track's channel SNR, or its
`peakChannelSnrDb` when that is higher.

### Gate and tracker

`ChannelGateReading.peakChannelSnrDb`: the wide-track branch tracks the best covering slot by
comparing p / f linearly (only the winner pays a `log10`); a one-slot reading copies its
channel SNR. The tracker stores it with the channel SNR and puts it on the snapshot only when
it differs. `slotRasterOf` picks the slot raster per range (1.12). The tracker's -20 dB OBW
is capped at its widest single-block segment.

### Segmenter

`segment()` takes optional `dipSplit`, `channelEdges`, `sideband` and `channel` options;
absent, it behaves as before. Dip cuts come from one O(width) pass over a running box mean
(dB) per run and are merged into the sorted raster edges. `mergeSkirts` takes the rules: the
one-channel and sideband tests come before the prominence test, and a prominence merge whose
merged span holds a channel edge is refused (binary search over the sorted edges). The
pipeline sets the options from `DIP_SMOOTH_HZ`, `SIDEBAND_DB` and `CHANNEL_PEAK_FRACTION`;
`channelEdges` are the edges of each range's coarsest raster. `MaskRaster` adds optional
`startHz`/`endHz`; `applyMasks` cuts a bounded raster only inside its range. The scanner's
masks bound every job raster to its range and, while the passive job runs, add the band
plans' rasters.

### Local floor, DC and channel keys (1.15, 1.16)

The main tracker gets `localBins` (12.5 kHz of bins) and, per extended block, sorts at most
2 x localBins neighbour powers in a reused scratch array for their median; the snapshot
carries the mean (`localSnrDb`). The scanner sets `dcCentred` from the last block summary of
the same epoch. `channelRastersAt` gives the store every raster of each band-plan range while passive runs,
and `rastersAt` includes them; `gridFor` keeps those at least half the observation's OBW wide,
and an observation off every tolerance falls back to the nearest channel of the finest kept. The tracker's `localSnr` also stores the matched-window SNR
(1.11), which feeds `peakChannelSnrDb` in `stepReading`. `classify` clamps the OBW it shows the classifier to
that channel width.

### CPU

Measured with a private bench of `SpectrumPipeline` alone (2.4 Msps, N 2048, 50 ms blocks,
24 NFM carriers in clusters of four, one wide FM, airband rasters, 8.33 kHz channel plan) on
the development Mac; see the lane report for the numbers and load average. The added work is
per block and proportional to the on-bins (one smoothing pass, one valley scan per merge
candidate, a -20 dB width scan only past the cap), never per sample.

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

**Property 12: Plan ownership and bound.** For any record set, `planConsolidation` gives
disjoint groups of at most 16; every member is joinable to its survivor on frozen values,
ranked below it and within 1 000 Hz of its frozen centre; no survivor is a member of
another group; `joinable` is called at most 32 times per record. _Validates 7.3, 7.4, 7.8._

**Property 13: Order independence.** For any record set given in any two orders, the plan
is identical; two stores restored from the same records in different orders end with the
same ids and observation sets after consolidation. _Validates 7.2, 7.3._

**Property 14: Idempotence.** Applying a plan twice equals applying it once; resuming a
plan after it completed changes nothing. _Validates 7.6._

**Property 15: Crash equivalence.** For any record set and any crash point k (groups 1..k
journaled, plan file present), restore plus replay of the journal prefix plus resume of the
plan gives the same store as the uninterrupted run, including over-cap clusters (18
joinable records). _Validates 7.5, 7.6._

**Property 16: Conservation and safety.** Consolidation preserves total observations and
airtime per source, never merges a pair 7.1 excludes, and every absorbed id resolves
through `aliasOwner` to a live survivor (until the 64-alias bound). _Validates 7.1, 7.5._

**Property 17: Guard precedence.** For any input, `passiveGuardDecision` returns the
decision of the first matching 8.4 row; row 2 equals `passiveCostDecision`; a shared
enabled source with `U >= 0.95` is disabled with or without a baseline; a null measurement
always keeps. _Validates 8.4, 8.9._

**Property 18: Guard duty bounds.** For any tick sequence of consumers, generations and
utilizations, passive is off for baseline windows at most 61 s in any 1 800 s, and a
disabled source with a valid baseline starts at most one trial per 900 s. _Validates 8.5
to 8.8._

**Property 19: Young convergence.** For any sequence of evidence-less observations of one
emitter with centres within +-300 Hz of `f`, OBW in [13, 39] kHz in any order (including
any run of narrow observations before the first wide one), peaks within 3 dB, SNR at least
18 dB, any class order and any interleaving of carrier-only sink proofs, exactly one record
results. _Validates 9.2, 9.3._

**Property 20: Weak guesses do not split.** For any set of at most 16 records within
1 000 Hz, not refused by 9.4 and within each other's bands, with arbitrary candidate labels
and no decode, identity or proven evidence, the load plan gives one group and `settle` on a
shared key leaves one record. _Validates 9.1, 9.6._

**Property 21: Proof, protocol and identity still split.** For any two records with
different identities, different decoded protocols (same family included), or incompatible
proven families (analog against a digital family), whatever their candidate labels, no path
(sticky, key match, `settle`, `absorb`, plan, lazy) merges them. _Validates 9.1, 9.5,
9.6, 9.8._

**Property 22: Refusal wins.** For any store state, an observation or record that 9.4
refuses against a record (young or established) is never merged with it on any path; an
observation whose OBW is outside a record's band never joins it by the cross-family or young
route, and joins it only by the same-family route within today's tolerance.
_Validates 9.3, 9.4, 9.8._

**Property 23: Pure noise never promotes.** For any sequence of evidence-less, not-overload
observations at or under 11.99 dB, with any id reuse, cadence and closes, no discovery is
created. _Validates 1.3, 1.4, 1.4b._

**Property 24: Sustained promotion.** For one observation id and any sequence of sample times
and SNRs, a discovery exists iff the 1.4b reference run (samples >= 9 dB, gaps <= 2 500 ms,
span >= 3 000 ms, at least 3 samples, median of the newest 8 >= 12 dB) or the 18 dB rule
fires. _Validates 1.4b._

**Property 25: Pure noise through the pipeline.** For any seed and raster (8.33, 12.5 or
25 kHz, with or without split rasters), 3.5 s of Gaussian noise through the pipeline, gate,
split rules and store at the scanner's ingest cadence creates no discovery.
_Validates 1.3, 1.4, 1.4b._

**Property 26: Split rules only cut.** For any block spectrum, the segments with every 1.13
rule on are ordered, disjoint, non-empty, and every on-bin they hold lies in a segment of the
plain segmenter. _Validates 1.13._

**Property 27: Push-to-talk airtime promotion.** For any sequence of transmissions on one
channel (gaps, durations of 500 to 2 500 ms, SNRs of 9 to 14.99 dB, sampled at the store's
cadence), a discovery exists iff the 1.4d reference (banked airtime of transmissions sampled
twice, inside 60 000 ms of the first banking, plus the live transmission's duration reaches
3 000 ms with at least 3 samples of median at least 12 dB) fires. _Validates 1.4d._

**Property 28: Fragment retirement keeps protected records and sightings.** For any store of
fragments on a few 12.5 kHz channels (random offsets, counts, OBW, levels, ages and
protection), with a retirement predicate that accepts every record, after one pass every
protected record (10.1) is live, the live sightings plus
the retired sightings equal the total, every merged id resolves to a live record or one
retired in that pass, nothing unseen for less than 72 h is retired, and (once no bound is
hit) the next pass changes and journals nothing. Without the predicate nothing retires
(unit tests). _Validates 10.1 to 10.5._

All fast-check properties run with `numRuns: 100` or more and carry the trace comment
(`// Feature: detection-quality, Property N: ...`).

Tests for the amendment: `tests/unit/core/scanner/consolidation.property.test.ts` (new,
Properties 12 to 16), `tests/unit/core/scanner/discovery-store-consolidate.test.ts` (new,
the 7.10 fixtures including the old-reader replay), `tests/unit/core/scanner/passive-guard.test.ts`
and `passive-guard.property.test.ts` (new, the 8.10 table and Properties 17 and 18). Expected
to change: persistence tests for the plan file; scanner-service passive guard wiring tests.

Tests for amendment 9: `tests/unit/core/scanner/discovery-store-young.test.ts` (new, the
9.10 fixtures), `tests/unit/core/scanner/discovery-store-young.property.test.ts` (new,
Properties 19 to 22). Expected to change: `consolidation.property.test.ts` and
`discovery-store-consolidate.test.ts` (band test, association family),
`discovery-store-evidence-family.test.ts` and `store-index.property.test.ts` (list key),
and any 2.6 fixture that relied on the median ratio.

Tests for amendment 10: `tests/unit/core/scanner/discovery-store-sustained.test.ts`
(1.4b and 1.11 fixtures, Properties 23 and 24), `tests/unit/core/spectrum/segment-split.test.ts`
(1.14 scene fixtures, Property 25), `tests/unit/core/spectrum/emissions/segmenter-split.test.ts`
(1.13 bounds, Property 26), `tests/unit/core/scanner/slot-raster.test.ts` (1.12). Changed:
`detection-quality-contract.test.ts` (new constants), `channel-gate.test.ts` (peak slot),
`scanner-service-range-masks.test.ts` (bounded rasters).

Tests for 1.4c, 1.4d and 1.17: `tests/unit/core/scanner/pending-airtime.test.ts` (1.4c and
1.4d bounds, Property 27), `tests/unit/core/spectrum/am-voice-admission.test.ts` (synthetic
push-to-talk AM voice through the pipeline, classifier and store),
`tests/unit/core/scanner/classify/classifier.test.ts` (1.17 bounds). `classifySpectral`
checks `isAmVoice` before `classOf`; `PendingAdmission` banks a closing run's transmission
(`bank`) and checks banked airtime on each sustained sample (`airtimePromotes`).

Tests for requirement 10: `tests/unit/core/scanner/fragment-retirement.test.ts` (the 10.8
fixtures and bounds) and `fragment-retirement.property.test.ts` (Property 28). Changed:
`merge-alias-goldens.test.ts` (the prune now also reports a stale one-sighting record).

Tests for 1.4e: `tests/unit/core/spectrum/emissions/segmenter-edge-band.test.ts` (bin bounds
of both spans, at and past each), `tests/unit/core/spectrum/pipeline-edge-span.test.ts`
(synthetic OOK, tones, images and a weak burst through the pipeline and store) and
`tests/unit/core/scanner/edge-admission.test.ts` (the edge threshold bounds). The pipeline
takes an optional `edgeFraction` next to `usableFraction`; the segmenter flags against
`edgeStartBin` / `edgeEndBin`, which default to the usable bounds.
