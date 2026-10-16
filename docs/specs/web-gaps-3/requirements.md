# Web gaps 3 requirements (WG3)

Status: contract frozen (task 0.1); lane work not started. See [design](design.md) and
[tasks](tasks.md).

## Scope

The third batch of core features the planned web dashboard needs: fair-share Activity
retention so a busy ADS-B feed no longer evicts pages, APRS, mesh and transmissions; the
read-side contract for the holes that fair-share deletes open; RF provenance (source and
channel frequency) on stored receptions; Meshtastic flood-copy filtering in Activity; a
24-hour coverage map (maximum range per bearing) for ADS-B and AIS; Meshtastic device
telemetry and neighbour links on mesh nodes; readsb receiving the station location; and the
CLI WebSocket client tolerating unknown channels.

Out of scope: CLI and web UI features (the CLI gets a coordination note and requirement 9.2
only); any change to the Activity caps (250 000 rows, 256 MiB, 3 days), admission limits or
`activity.enabled` (on by default since WG1); the access default (`legacy`); scanner defaults;
the channelizer (stays off) and S2 (stays disabled); per-entity retention shares; re-admitting
receptions coalesced behind a failed write (ROADMAP); presentation backfill; persistent
coverage or position trails; Meshtastic environment, air-quality and power metrics; band-plan
import formats; `GET /api/storage`; the files pinned by the band-plans spec
(`src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`,
`src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`); new npm
dependencies.

Every hot-path item states its CPU budget and its pipeline position in the design.

## 1. Fair-share retention (writer)

As an operator of a busy station I want quiet feeds (pages, APRS, mesh, transmissions) to keep
their Activity history while a busy ADS-B feed takes the rest of the store, instead of every
feed keeping the same few hours.

1.1 `activity.retention.policy` shall accept `fair-share` and `oldest-first`; any other value
is a config validation error. Omitted, the store uses `ACTIVITY_RETENTION_POLICY_DEFAULT`,
which is `fair-share`. (Decision, PROVISIONAL pending the user: flipping the default to
`oldest-first` is that one constant.) The env override is
`WAVEKIT_ACTIVITY__RETENTION__POLICY`.
1.2 A retention share shall be keyed `decoder:<decoderId>` for rows with a decoder id and
`kind:<kind>` for rows without one (analog transmissions, ingestion gaps). There are no
per-entity shares.
1.3 Age pruning shall be unchanged under both policies: the same prefix delete of rows older
than `maxAgeMs`, started only once the oldest row is older than `maxAgeMs` plus slack.
1.4 The row and byte cap triggers shall be unchanged: same caps, same start-above-cap and
run-down-to-95 % hysteresis, flags shared across policies, the same `pruneBatchRows` per
transaction and the same `pruneBurstBatches` / `pruneBurstMs` bound per write.
1.5 Under `fair-share`, cap pressure shall remove rows by max-min water-filling: with per-share
usage `u_i` (rows for the row cap, summed `record_bytes` for the byte cap) and target `T`
(the low-water mark), the level `L` is the largest integer with `sum(min(u_i, L)) <= T`. Only
shares with `u_i > L` lose rows, never below `L`, with one exception (the indivisible row):
when the only excess left is live-page excess smaller than any candidate row, so no fair delete
can avoid crossing a share's byte floor, one counted step deletes the single oldest row of the
over-level share with the largest excess (ties: key ascending). It never touches a share at or
under `L`, and it counts in `prefixFallbackSteps`. The true prefix fallback (1.12) still runs
only when no share is above `L`.
1.6 Inside one share the rows removed shall be its lowest `seq` first.
1.7 Per-share row and byte counters shall live in writer memory: seeded once when the session
opens by one grouped scan, increased after a commit by the rows that committed (not duplicates
or failed rows), decreased after a prune transaction commits. No schema change to `activity`.
1.8 Under `fair-share`, a prune transaction shall delete at most `pruneBatchRows` rows, in one
`BEGIN IMMEDIATE` with their FTS rows (refs cascade), then run `incremental_vacuum` as today.
1.9 A prune transaction that fails shall roll back and leave the counters untouched; the
write still succeeds with the existing "retention step failed" note.
1.10 When the planner finds no share above `L` while a cap is still active, the writer shall
reseed its counters once per burst; a planner input that disagrees with `COUNT(*)` is drift and
also reseeds.
1.11 If the seed scan fails, the session shall run `oldest-first` until it is reopened,
report `effective: "oldest-first"` and add one note to the next write result.
1.12 If a cap is still active after a reseed and no share is above `L`, the step shall delete
an oldest-first prefix for that cap, so the caps always bind; `prefixFallbackSteps` counts it.
1.13 With exactly one share, `fair-share` shall delete the same rows as `oldest-first`.
1.14 Under `oldest-first` the writer shall behave exactly as before WG3 (same rows deleted,
same watermark and generation updates, no holes).
1.15 Budgets (design "CPU and IO budgets"): the seed scan at most 500 ms for 250 000 rows on
the development Mac, in the writer worker (measured 330 ms, `oldest-first` open 317 ms);
counter updates O(1) per committed row with no SQL; the planner O(k log k) for k shares;
per-write prune wall time bounded by `pruneBurstMs` as today; fair-share delete throughput and
on-disk size drift measured against `oldest-first` on a 250 000-row fixture and reported
(measured: delete rate 1.20x, file after 10 cap cycles +3 %, rows kept at the byte cap 0.966x).
1.16 Caps, admission limits, `activity.enabled` and the access default shall not change.

## 2. Retention exposure

2.1 `ActivityStoreStats.retention` (optional) shall carry `policy`, `effective`, `shares`
(`key`, `rows`, `bytes`, `oldestReceivedAt`), `sharesTruncated` and `prefixFallbackSteps`.
2.2 `shares` shall be sorted by rows descending then key ascending and hold at most 64
entries; `sharesTruncated` says whether more exist.
2.3 `oldestReceivedAt` of a share is the `received_at` of its lowest-seq row, refreshed when the
share loses rows or appears; null when unknown.

## 3. Hole bookkeeping (writer)

3.1 `store_meta` shall gain `holeWatermark`, the greatest `seq` ever deleted above the prune
watermark, and `holeGeneration`, both "0" on a store without holes. They are inserted with
`INSERT OR IGNORE` on open; `schemaVersion` stays 1 and older stores open unchanged.
3.2 `holeGeneration` shall increment exactly once per prune transaction that leaves a deleted
`seq` above the new prune watermark; `holeWatermark` shall then be the maximum of its previous
value and those seqs.
3.3 `pruneWatermark` shall keep its meaning: every `seq <= pruneWatermark` is gone. A fair
transaction advances it to `MIN(seq) - 1` of the remaining rows when that is greater (to the
greatest deleted seq when the table is empty).
3.4 `pruneGeneration` shall increment exactly when `pruneWatermark` advances.
3.5 `StoreIdentity` shall carry `holeWatermark` and `holeGeneration` from the same read as the
other identity fields. All meta updates happen in the prune transaction itself.
3.6 A generation at `Number.MAX_SAFE_INTEGER` makes the step fail as today (no wrap).
3.7 A new session (reopen, restore, new `storeUuid`) seeds new counters; nothing carries over.

## 4. Hole contract (readers)

As a paging or replaying client I want a reset instead of a silent omission when retention
removes a row I have not received yet.

4.1 The scan lower bound shall stay `pruneWatermark`; reading across holes needs no change.
4.2 Page tokens shall carry the `holeGeneration` of their snapshot; replay cursors shall carry
the `holeGeneration` read in the same read transaction as the rows they follow.
4.3 A page continuation shall fail with `snapshot-reset` when the store's `holeGeneration` is
greater than the token's.
4.4 Replay shall emit `cursor-gap` when the store's `holeGeneration` is greater than the
cursor's (or the replay's last checked value) and `holeWatermark` is greater than the replay
position; when `holeWatermark` is not greater, it adopts the new generation and continues.
4.5 A live follower at the committed head shall not be reset by holes.
4.6 Missing hole keys (older store) and tokens without the field (issued before WG3) shall read
as 0.
4.7 No frame, reset reason or DTO changes; the reasons used are the existing `cursor-gap` and
`snapshot-reset`.
4.8 Resets shall terminate: a page or replay started after a reset is not reset again unless a
new hole generation lands.
4.9 Facets and detail lookups are unaffected.

## 5. RF provenance on receptions

As a web user I want each stored reception to name the source it came from and the channel
frequency, so I can filter "calls on 446.006" and label the spectrum.

5.1 The Activity ingress shall set `provenance.sourceId` and `provenance.frequency` (`hz`,
`basis: "channel"`, `tuningTrust`) on every reception it can resolve, per the design's
provenance table; otherwise both stay null (today's value).
5.2 Provenance shall come only from the decoder binding Main supplies
(`ActivityProvenanceLookup`: `sourceId`, `targetFrequenciesHz`, `tuningTrust`) and from a
frequency the decoder itself reports in its payload. It is never inferred from decoded content
or from a protocol constant.
5.3 `tuningTrust` shall be the binding's value, `unverified` when there is no binding. (Main
decision: `unverified` unless WaveKit itself commands the tuning the decoder hears.)
5.4 `hz` shall be an integer (rounded) in (0, 10^12]; any other value means no frequency.
5.5 A binding with more than one target frequency and no payload frequency gives
`frequency: null`.
5.6 Provenance runs in `activity/ingress.ts` before store admission (flood filter, coalescing,
rate limits), so it is paid by every reception: at most 2 µs mean per reception, one map lookup
and at most two payload reads, no Zod parse and no JSON.
5.7 A lookup that throws, or an envelope rejected because of provenance, shall never lose the
reception: the envelope is rebuilt with null provenance and `provenanceFailures` counts it;
only a failure of that rebuild counts `buildFailures`.
5.8 `decodedData`, presentation, coalescing and admission shall not change.

## 6. Meshtastic flood copies in Activity

6.1 A `meshtastic` reception shall be dropped as a flood copy when a reception with the same
`from`, `id`, `portnum` and payload (hash of `payloadB64`) was queued less than 30 s earlier
(by `receivedAt`); the drop returns `flood-copy`.
6.2 The check runs in `storage/ingress.ts` after the closed and telemetry checks and before
coalescing and rate limiting, so copies take no tokens and touch no coalescing state.
6.3 Only queued receptions are remembered; a reception rejected for any other reason is not,
so a later copy can still be stored.
6.4 A failed or skipped write of the remembered reception forgets it; a timed-out write keeps
it (as coalescing does).
6.5 `id` 0 or missing, `from` missing, a non-integer value, a different payload or a time
outside [0, 30 s] (including a backward clock step) means "not a copy".
6.6 Copies count in `floodCopies`; they are not losses and open no ingestion gap.
6.7 The memory is bounded to 20 000 entries, evicting the oldest; a CPU budget of one string
compare for any other output type and at most 5 µs per Meshtastic reception.
6.8 A copy dropped while its original is still queued is not re-admitted if that write later
fails (same class as the ROADMAP coalescing item).

## 7. Coverage per bearing

As a web user I want a coverage layer: how far ADS-B and AIS were heard in each direction over
the last day.

7.1 A coverage manager shall keep, per protocol (`adsb`, `ais`) and 1° bearing bucket from the
configured station, the farthest accepted position in each of 24 hourly buckets; a query
returns the farthest per bearing over the current and the previous 23 hours.
7.2 Range shall be the haversine distance (R = 6 371 000 m) and bearing the initial
great-circle bearing, degrees true, bucket = floor.
7.3 A position shall be rejected as `invalid-position` (non-finite, out of range, or exactly
(0, 0)), `too-far` (more than 500 km), `stale` (older than 60 s when observed) or `no-station`
(no station latitude and longitude).
7.4 Inputs are aircraft and vessel tracker updates; one tracked entity counts only when its
position time advances.
7.5 `GET /api/coverage` (optional `protocol=adsb|ais`, otherwise 400 `VALIDATION_ERROR`)
returns `CoverageResponse`; without a station location it is 200 with `available: false`,
`reason: "no-station-location"` and no protocols.
7.6 State is in memory only and starts empty after a restart.
7.7 CPU at most 2 µs per position update; memory fixed at 2 × 24 × 360 cells.

## 8. Meshtastic telemetry and neighbour links

8.1 The protobuf reader shall decode `Telemetry` (TELEMETRY_APP, port 67) `device_metrics`:
`battery_level` (uint32), `voltage`, `channel_utilization`, `air_util_tx` (float, wire type 5)
and `uptime_seconds` (uint32); other telemetry variants are recognised and ignored.
8.2 The reader shall decode `NeighborInfo` (NEIGHBORINFO_APP, port 71): `node_id` and
`neighbors` (`node_id`, `snr`); other fields are skipped.
8.3 Malformed payloads return null and count `decodeErrors`; the reader never throws, keeps the
existing field-count and nesting limits, and adds no dependency.
8.4 A node's `telemetry` shall be set from device metrics in a unique packet `from` that node;
`battery_level > 100` means `powered: true, batteryPct: null`; absent metrics are null.
8.5 A node's `neighbours` shall be replaced by each unique NeighborInfo report whose `node_id`
equals the packet's `from` (otherwise `invalidPackets`), sorted by nodeId, at most 32; entries
older than the node expiry (4 h) are dropped on cleanup.
8.6 Only unique packets (after the tracker's existing `(from, id)` dedupe) are decoded.
8.7 `telemetryPackets` and `neighbourReports` shall count applied packets.
8.8 Updates ride the existing `mesh:update` (2 s throttle) and the routes return the new fields
(Fastify response schemas extended); Activity storage and the LoRa adapter output are unchanged.

## 9. Main items

9.1 readsb shall receive `--lat`/`--lon` from `station` when both are set and the decoder
options do not set them, independent of `enableMlat`; explicit decoder options still win.
9.2 The CLI WebSocket client shall ignore a frame on an unknown channel instead of reporting
`ws:invalid`.
9.3 docs/API.md, ROADMAP, `config/default.yaml` and the coordination note shall describe the
retention policy and shares, the hole reset semantics, provenance, flood copies, coverage and
mesh telemetry.

## 10. Verification

10.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
10.2 The root suite, typecheck and lint pass at every merge; the existing coalescing-retention
test (WG1 7.8) still passes under the default policy.
