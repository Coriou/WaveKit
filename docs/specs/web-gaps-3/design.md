# Web gaps 3 design (WG3)

Status: contract frozen (task 0.1); lane work not started. Requirements in
[requirements](requirements.md), tasks in [tasks](tasks.md). Background: the Activity store
([activity recording catalog](../activity-recording-catalog/requirements.md), batch-1 event
foundation), WG1 ([design](../web-gaps-1/design.md): Activity on by default, coalescing) and
WG2 ([design](../web-gaps-2/design.md): presentation, APRS and mesh coalescing, mesh tracker).

## Contract (frozen)

| File                                                 | Addition                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/activity/storage/contract.ts`              | `StoreMetaKey` `holeWatermark`, `holeGeneration`; optional `StoreIdentity.holeWatermark`/`holeGeneration`; `AdmitRejection` `flood-copy`; `ActivityRetentionPolicy`, `ActivityRetentionShare`, `ActivityRetentionStats`; optional `ActivityStoreStats.retention`/`floodCopies` |
| `src/core/activity/storage/limits.ts`                | `ActivityLimits.retentionPolicy`; `ACTIVITY_RETENTION_POLICY_DEFAULT` (`fair-share`, provisional); `ACTIVITY_RETENTION_POLICIES`; `resolveActivityLimits` validates the policy                                                                                                 |
| `src/core/activity/storage/index.ts`                 | exports of the above                                                                                                                                                                                                                                                           |
| `src/core/activity/types.ts`                         | `ActivityDecoderBinding`, `ActivityProvenanceLookup`                                                                                                                                                                                                                           |
| `src/core/activity/ingress.ts`                       | `ActivityIngressOptions.resolveProvenance?` (unused stub; lane P)                                                                                                                                                                                                              |
| `src/core/activity/runtime.ts`                       | `ActivityRetentionOverrides.policy` mapped to `retentionPolicy`; `StartActivityRuntimeOptions.resolveProvenance?` passed through (default null)                                                                                                                                |
| `src/config.ts`, `config/default.yaml`               | `activity.retention.policy` (`fair-share` / `oldest-first`, optional); comment                                                                                                                                                                                                 |
| `src/core/activity/storage/ingress.ts`               | `flood-copy` excluded from the drop-reason helpers (type only; lane H)                                                                                                                                                                                                         |
| `packages/api-types/src/activity.ts`                 | identical copies of the retention types; optional `ActivityStoreStats.retention`/`floodCopies`                                                                                                                                                                                 |
| `packages/api-types/src/coverage.ts` (new, exported) | `CoverageProtocol`, constants, `CoverageSector`, `CoverageProtocolSummary`, `CoverageRejections`, `CoverageResponse`                                                                                                                                                           |
| `packages/api-types/src/mesh.ts`                     | optional `MeshNode.telemetry`/`neighbours`, `MeshDeviceTelemetry`, `MeshNeighbour`, optional `MeshTrackerStats.telemetryPackets`/`neighbourReports`                                                                                                                            |

`tests/unit/core/activity/api-types-compat.test.ts` asserts the retention copies are identical;
`tests/unit/core/wg3-contract.test.ts` pins the defaults. No `events.ts` change: mesh fields
ride `mesh:update`, coverage is REST only. Every addition is optional or new.

The freeze also anchors the Activity test store clock (`fixtureClock` in
`tests/unit/core/activity/storage/helpers.ts`): fixtures dated 2026-10-12/13 were being
age-pruned by the 3-day default once the wall clock passed 2026-10-15.

## Pipeline positions

```
decoder output
  └─ activity/ingress.ts publish        ← P: provenance (every reception, before admission)
       └─ store.admit (storage/ingress.ts, main thread)
            closed → telemetry → H: flood copy → coalescer → paused → queue → tokens → present → queue
                 └─ writer worker: commit → F: counters + prune burst (fair-share planner)
                      └─ readers (query worker): G: hole checks on page and replay
tracker updates (aircraft, vessel) → C: coverage (not Activity)
mesh tracker processPacket → (from, id) dedupe → M: telemetry / neighbour decode
```

## CPU and IO budgets

| Item              | Position                                                  | Budget                                                                                                                 | How measured                                                                                                   |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| P provenance      | ingress, before admission and coalescing; every reception | ≤ 2 µs mean per reception; 1 map lookup, ≤ 2 payload reads, no Zod/JSON                                                | micro-benchmark over 100 000 mixed outputs, reported (not asserted in CI)                                      |
| H flood check     | storage ingress, after telemetry, before coalescer        | 1 string compare for non-mesh outputs; ≤ 5 µs per mesh reception (FNV-1a over ≤ 684 chars); ≤ 20 000 entries (≈ 3 MiB) | benchmark, reported                                                                                            |
| F seed            | writer worker, once at session open                       | ≤ 500 ms for 250 000 rows                                                                                              | one timed run on a 250 000-row fixture, reported                                                               |
| F commit counters | writer worker, after COMMIT                               | O(1) map update per committed row, no SQL                                                                              | by construction                                                                                                |
| F planner         | writer worker, per prune step                             | O(k log k), k shares (≤ 256 in tests)                                                                                  | by construction                                                                                                |
| F prune step      | writer worker, per step                                   | ≤ `pruneBatchRows` rows per transaction; burst bounded by `pruneBurstBatches`/`pruneBurstMs` (unchanged)               | delete rows/s fair vs oldest-first on 250 000 rows, reported; DB file size drift after 10 cap cycles, reported |
| F share oldest    | writer worker, after a step that changed a share          | ≤ 1 indexed point lookup per changed share                                                                             | by construction                                                                                                |
| G checks          | query worker / service, per page and replay iteration     | no extra SQL statement: the hole keys join the existing `store_meta` read (`readObserved`)                             | by construction                                                                                                |
| C observe         | tracker update listener                                   | ≤ 2 µs per update (haversine + atan2 + array write); 17 280 cells of Float64                                           | benchmark, reported                                                                                            |
| M decode          | mesh tracker, unique packets only                         | ≤ 20 µs per telemetry or neighbour payload (≤ 512 bytes)                                                               | benchmark, reported                                                                                            |

## Fair-share retention (lane F)

**Arithmetic.** On-disk ≈ 1 777 B per row on the docs mix, so the 256 MiB byte cap binds first
at ≈ 151 000 rows (docs/API.md). Coalesced feeds: N visible aircraft ≈ N × 1 440 rows/day, so
300 aircraft = 432 000/day; busy APRS ≈ 3 000 packets/h = 72 000/day; a 100-node mesh ≈ 600
rows/h = 14 400/day; pages ≈ 2 000/day (assumption). Oldest-first: 151 000 / ≈ 520 000 per day
keeps ≈ 7 h of every feed. Water-filled over the 3-day demands (pages 6 000, mesh 43 200,
APRS 216 000, ADS-B 1 296 000) with target 151 000: 6 000 + 43 200 + 2L = 151 000, L ≈ 50 900,
so pages 3 days, mesh 3 days, APRS ≈ 17 h, ADS-B ≈ 2.8 h. A station with one feed keeps
exactly what it keeps today. Cap bursts happen at the same rate as today: the 95 % hysteresis
frees ≈ 5 % of the cap (≈ 7 500 rows at the byte cap), which refills in ≈ 20 min at
520 000 rows/day.

**Shares.** `decoder:<decoder_id>` when `decoder_id` is non-null, else `kind:<kind>`.
Selecting a share's oldest rows uses `activity_decoder (decoder_id, seq)` or
`activity_kind (kind, seq)` with `decoder_id IS NULL`.

**Counters.** `Map<shareKey, { rows, bytes }>` in the writer session. Seed:

```sql
SELECT decoder_id, CASE WHEN decoder_id IS NULL THEN kind END AS k,
       COUNT(*) AS n, COALESCE(SUM(record_bytes), 0) AS b
FROM activity GROUP BY decoder_id, k
```

After `commitActivityBatch` returns, add each committed row (by `committedEventIds`, using
the batch row's `decoderId`, `kind` and `recordBytes`). After a prune transaction commits,
subtract what it deleted. A failed transaction changes nothing (rollback first, counters
after COMMIT only).

**Planner** (`storage/fair-share.ts`, pure):

```
level(u[], T): if sum(u) <= T return none
  sort u ascending; remaining = T; n = len
  for each u_i ascending: if u_i * (n - i) <= remaining { remaining -= u_i } else return floor(remaining / (n - i))
excess_i = max(0, u_i - L)
```

Row cap: `u` = rows, `T = activityLowWater(maxRows)`. Byte cap: `u` = record bytes,
`E = dbBytes - activityLowWater(maxDbBytes)` (live pages, as today), `T = sum(u) - E`
(the same record-bytes-freed approximation the prefix prune uses). When both caps are active a
share's step excess is the larger of its row excess and the rows needed to cover its byte
excess. A step allocates at most `pruneBatchRows` rows across over-level shares in proportion
to their excess (largest remainder, ties by key ascending, at least one row per share while the
budget allows), never more than a share's excess, then re-plans from the updated counters on
the next step of the burst.

**Step order.** Policy `oldest-first`: `pruneActivityPrefix` unchanged. Policy `fair-share`:
(1) if age is active (rule unchanged), the step is today's age prefix delete; (2) otherwise, if
a cap is active, a fair step; (3) otherwise stop. The session keeps its hysteresis flags
exactly as today.

**Transaction.** One `BEGIN IMMEDIATE`: per row `DELETE FROM activity_fts WHERE rowid = ?`
and `DELETE FROM activity WHERE seq = ?` (refs cascade); then `W' = max(W, MIN(seq) - 1)` or
the greatest deleted seq when the table is empty; `holes = deleted seqs > W'`; if any, raise
`holeWatermark` and increment `holeGeneration`; if `W' > W`, set `pruneWatermark` and increment
`pruneGeneration`; COMMIT; `incremental_vacuum(incrementalVacuumPages)`.

**Failure paths.** Counter drift (crash between commit and update is impossible to persist:
counters are rebuilt at open; a planner/`COUNT(*)` mismatch reseeds, 1.10). Seed failure:
`effective: "oldest-first"` for the session plus one note (1.11). Residual excess with no share
above `L` after a reseed: one oldest-first prefix step for that cap, counted (1.12), so caps
bind even when record bytes and live pages disagree (fragmentation). A removed decoder's share
keeps its rows until age or until it is above `L`. Generation exhaustion fails the step (3.6).
Restore or a new `storeUuid` is a new session with new counters (3.7).

**Exposure.** The writer snapshot gains the retention block (shares sorted rows desc, key asc,
at most 64); `store.ts` maps it into `stats().retention`. Main adds `floodCopies` from lane H's
ingress getter at merge.

**Existing tests to amend.** `prune.property.test.ts` (the prefix invariant becomes
`oldest-first`-scoped; add the single-share equivalence), `coalesce-retention.test.ts` (WG1 7.8
must still pass under the default `fair-share`).

## Hole contract (lane G)

Notation: `W` prune watermark, `HW` hole watermark, `HG` hole generation; all read in the
reader's transaction by `readObserved` (absent keys = 0).

- Scan bounds unchanged: lower bound `W`.
- Page tokens: the first page records `hg = HG` of its snapshot; continuations carry it
  unchanged. Continuation: today's checks, then `HG > token.hg` → `snapshot-reset`.
- Replay cursors: each issued cursor carries the `HG` read with the rows it follows. Before
  each catch-up read and on resume: if `HG > base` and `HW > position` → `cursor-gap`; if
  `HG > base` and `HW <= position` → `base = HG` and continue (every hole ever opened is at or
  below what the client already has). A live follower at the head has `position >= HW`.
- Tokens without `hg` (issued before WG3) read as 0; the HMAC payload parser accepts both.
- Conservative by design: `HW` is a maximum, so an old hole above the position plus a new hole
  below it resets once. Resets terminate (4.8) because the fresh cursor carries the current
  `HG`. Hole generations advance only in cap bursts (see the arithmetic), so the reset rate is
  that of today's `snapshotLowerBoundPassed` resets.

## RF provenance (lane P)

`activity/ingress.ts` computes provenance per output before building the envelope:

| Output type (adapter)                                                 | Frequency                                                                                                                   | Source  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| `acars` (acarsdec)                                                    | payload `frequency` (Hz)                                                                                                    | binding |
| `vdl2` (dumpvdl2)                                                     | payload `frequency` (Hz) when > 0                                                                                           | binding |
| `meshtastic` (lora-meshtastic)                                        | payload `frequency` (Hz)                                                                                                    | binding |
| `ship` and other AIS outputs                                          | payload `channel` `A`/`1` → 161 975 000, `B`/`2` → 162 025 000 when the output carries it; else the binding's single target | binding |
| any other output (readsb, direwolf, multimon-ng, dsd-fme, rtl_433, …) | the binding's target when it has exactly one; else null (multimon-ng's string `frequency` is not used: unit unverified)     | binding |

`sourceId = binding?.sourceId ?? null`; `basis: "channel"`; `tuningTrust = binding?.tuningTrust
?? "unverified"`; `hz = Math.round(value)` valid in (0, 10^12]. No binding and no payload
frequency gives `{ sourceId: null, frequency: null }`. The lookup is guarded (try/catch); a
build rejected because of provenance is rebuilt with null provenance and counted
(`provenanceFailures` on `ActivityIngressCounters`, internal). Budget in the table above; the
lane reports a micro-benchmark. Main supplies the lookup from decoder configs
(`resolveDecoderTargetFrequencies`, `sourceId`) in `src/index.ts`; `tuningTrust` is
`unverified` for every decoder in WG3 unless Main finds a decoder whose tuning WaveKit itself
commands.

## Meshtastic flood copies (lane H)

`storage/flood-dedupe.ts` (pure, injected clock-free: times come from `receivedAt`):
`Map<"<from>:<id>", { eventId, atMs, hash }>` in insertion order, at most 20 000 entries
(oldest evicted). `hash` = FNV-1a 32 of `portnum + ":" + payloadB64`. `storage/ingress.ts`:

1. after the telemetry check, for `outputType === "meshtastic"` with uint32 `from`, non-zero
   uint32 `id`: if an entry exists with `0 <= at - entry.atMs <= 30 000` and the same hash →
   `floodCopies++`, return `{ admitted: false, reason: "flood-copy" }`;
2. otherwise continue (coalescing, admission); when the row is queued, remember
   `{ eventId, at, hash }` (replacing any entry);
3. `nack` / `noteSkipped` of that eventId delete the entry if it still names that eventId;
   `ack` and `forgetInFlight` keep it.

Arithmetic: on a 100-node mesh about 600 copy rows/h (14 400/day) are no longer stored
(ROADMAP estimate); position copies were already coalesced, so the saving is on telemetry,
node info and text ports.

## Coverage (lane C)

`src/core/coverage/coverage-tracker.ts` (pure): per protocol, `Float64Array`s of 24 × 360 for
range, lat, lon and time plus an `Int32Array` of hour indices per slot. Slot for a position at
`t`: `hour = floor(t / 3 600 000)`, `slot = hour mod 24`; a slot whose stored hour differs is
cleared before use. Query at `now`: slots with `hour > floor(now / 3 600 000) - 24`, per bearing
the maximum range. `coverage-manager.ts` subscribes to tracker emitters given to it
(structural `on`/`off` types; trackers imported with `import type`): aircraft `aircraft:new`/
`aircraft:update` (position time = `lastUpdated - seenPos × 1000` when `seenPos` is present),
vessel `vessel:new`/`vessel:update` (`position.at`). A per-entity last position time (bounded
by the trackers' own caps, cleared on `:lost`) makes repeated updates without a new position
count once. `src/api/routes/coverage.ts` exports `coverageRoutes(app, { coverage })` with a
Fastify response schema. Memory: 2 × 8 640 cells × 4 arrays × 8 B ≈ 553 KiB.

## Mesh telemetry and neighbours (lane M)

Wire format (public Meshtastic protobufs; field numbers as constants with the message and field
names in comments):

| Message         | Field                                       | Number | Wire                                 |
| --------------- | ------------------------------------------- | ------ | ------------------------------------ |
| `Telemetry`     | `time`                                      | 1      | fixed32 (ignored)                    |
| `Telemetry`     | `device_metrics`                            | 2      | length-delimited                     |
| `Telemetry`     | other variants (`environment_metrics` 3, …) | ≥ 3    | skipped                              |
| `DeviceMetrics` | `battery_level`                             | 1      | varint uint32                        |
| `DeviceMetrics` | `voltage`                                   | 2      | fixed32 float                        |
| `DeviceMetrics` | `channel_utilization`                       | 3      | fixed32 float                        |
| `DeviceMetrics` | `air_util_tx`                               | 4      | fixed32 float                        |
| `DeviceMetrics` | `uptime_seconds`                            | 5      | varint uint32                        |
| `NeighborInfo`  | `node_id`                                   | 1      | varint uint32                        |
| `NeighborInfo`  | `last_sent_by_id`                           | 2      | varint (skipped)                     |
| `NeighborInfo`  | `node_broadcast_interval_secs`              | 3      | varint (skipped)                     |
| `NeighborInfo`  | `neighbors`                                 | 4      | repeated length-delimited `Neighbor` |
| `Neighbor`      | `node_id`                                   | 1      | varint uint32                        |
| `Neighbor`      | `snr`                                       | 2      | fixed32 float                        |

The reader adds a float reader (`DataView.getFloat32(…, true)`) and one nested-message level;
non-finite floats are null. At most 64 neighbours are read per report (more is a decode error);
the node keeps 32 (by nodeId ascending). The test encoder in `tests/mocks/fixtures/meshtastic/`
gains float, telemetry and neighbour helpers; fixtures are self-encoded. The route schemas in
`src/api/routes/mesh.ts` gain the new fields.

## Main wiring

`src/index.ts`: the provenance lookup into `startActivityRuntime({ resolveProvenance })`; the
coverage manager fed by the aircraft and vessel trackers with `config.station`; readsb station
location (9.1). `src/api/server.ts`: `coverageRoutes`. `store.ts` stats line for `floodCopies`
after lanes F and H merge. Docs per 9.3. CLI ws-client unknown channels (9.2).

## Correctness properties

1. **Fair floor.** For any share usages and active caps, a fair step removes no row from a share
   with `u_i <= L`, and no share ends a burst below `min(u_i, L)`. _Validates 1.5, 1.6._
2. **Caps bind.** For any sequence of commits with prune bursts unconstrained by time, rows end
   at or below the row low-water mark once the row cap triggered, and the byte cap likewise
   (including the prefix fallback). _Validates 1.4, 1.12._
3. **Single share equals oldest-first.** With one share, `fair-share` deletes exactly the rows
   `oldest-first` deletes, with the same watermark, and opens no hole; `oldest-first` matches the
   pre-WG3 model. _Validates 1.13, 1.14._
4. **Counters.** After any sequence of commits (with duplicates and failed rows), failed and
   successful prune transactions, the counters equal the grouped scan. _Validates 1.7, 1.9, 1.10._
5. **Hole bookkeeping.** After every transaction: no row `<= W` exists; every deleted seq
   `> W` is `<= HW`; `HG` increments iff a hole opened; `pruneGeneration` iff `W` advanced.
   _Validates 3.1–3.4._
6. **No silent skip.** For any interleaving of commits, fair deletes, page continuations and
   replay steps, a client either receives every row of its range that existed when its token
   was issued and was not deleted before that, or receives `snapshot-reset` / `cursor-gap`.
   _Validates 4.2–4.4, 4.6._
7. **Reset termination.** A page or replay started after a reset with no new hole generation is
   never reset by holes; a follower at the head never is. _Validates 4.5, 4.8._
8. **Provenance resolution.** For any output and binding (including hostile values and a
   throwing lookup), the ingress yields exactly one envelope, provenance follows the table, and
   `hz` is an integer in range or the frequency is null. _Validates 5.1–5.5, 5.7._
9. **Flood copies.** For any sequence of mesh receptions, write outcomes and times, a reception
   is dropped iff an equal `(from, id, portnum, payload)` was queued 0–30 s earlier and its write
   has not failed; every drop is counted and none is a loss. _Validates 6.1–6.6._
10. **Coverage maximum.** For any accepted positions, each returned sector equals the farthest
    accepted position in that bearing over the window, and rejected positions never appear.
    _Validates 7.1–7.3._
11. **Mesh telemetry round trip.** Encoded device metrics and neighbour reports decode to their
    values; truncated, oversized or garbage payloads return null without throwing.
    _Validates 8.1–8.3._
12. **Neighbour state.** A node's neighbours equal its latest valid report (sorted, at most 32)
    minus entries older than 4 h. _Validates 8.5._
