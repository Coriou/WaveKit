# Web gaps 4 design (WG4)

Status: implemented, pending gates (lanes merged and wired). Requirement 6.9 is pending a user
decision (see "Station write layer"). Requirements in [requirements](requirements.md), tasks in
[tasks](tasks.md). Background: the Activity store
([activity recording catalog](../activity-recording-catalog/requirements.md)), WG3
([design](../web-gaps-3/design.md): RF provenance, coverage per bearing, mesh telemetry).

## Contract (frozen)

| File                                                                 | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/activity.ts`                                 | `ACTIVITY_TRAILS_*` bounds (default window 1 h, max window 24 h, 20 000 points, 2 000 entities, 1 440 per entity, 200 000 scan rows, 64 entity keys); `ActivityTrailsQuery`, `ActivityTrailPoint`, `ActivityTrail`, `ActivityTrailsTruncation`, `ActivityTrails`                                                                                                                                                                                                                            |
| `src/core/activity/storage/contract.ts`                              | identical copies of the trails types; optional `ActivityQueryService.trails?(input)`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/core/activity/storage/index.ts`, `src/core/activity/runtime.ts` | type exports of the trails types; `inertActivityService().trails` rejects like its other methods                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/api-types/src/storage.ts` (new, exported)                  | `StorageAreaId`, `STORAGE_AREA_IDS`, `StorageAreaClass`, `STORAGE_AREA_CLASS`, `StoragePartialReason`, `STORAGE_SCAN_MAX_ENTRIES` (50 000), `STORAGE_SCAN_MAX_DEPTH` (16), `STORAGE_SCAN_MAX_WALL_MS` (2 000), `STORAGE_REPORT_CACHE_MS` (30 000), `StorageFilesystem`, `StorageActivityRetention`, `StorageArea`, `StorageLowSpaceState`, `StorageReport`                                                                                                                                  |
| `src/core/storage-report/contract.ts` (new)                          | `STORAGE_SCAN_FS_CONCURRENCY` (8), `StorageAreaSource`, `StorageReportOptions`, `StorageReportProvider`                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/api-types/src/live-audio.ts`                               | `LiveAudioAgcMode`, `LIVE_AUDIO_AGC_MODES`; optional `LiveAudioConfig.agc`, `LiveAudioStatus.agc`                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/config.ts`, `config/default.yaml`                               | `liveDemod.agc` (`off`/`slow`/`fast`, optional, no default) and its comment                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/api-types/src/mesh.ts`                                     | optional `MeshPosition.fixAt: string \| null`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/api-types/src/resources.ts`                                | optional `SdrHostStatus.version: string \| null`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/api-types/src/station.ts`                                  | `StationProvenance` gains `ui`; optional `StationIdentity.revision`/`writable`; `StationField`, `STATION_FIELDS`, `StationUpdate`, `StationUpdateResult`, `StationErrorCode`, `StationErrorBody`; `STATION_ESTIMATE_ROUNDING_DEG` (0.05), `STATION_ESTIMATE_MIN_UNCERTAINTY_KM` (10), `STATION_ESTIMATE_UNCERTAINTY_STEP_KM` (5), `STATION_ESTIMATE_CACHE_MS` (60 000), `StationEstimateUnavailableReason`, `StationEstimateBasis`, `StationEstimate` (barrel exports listed in `index.ts`) |
| `src/core/station-estimate/contract.ts` (new)                        | `STATION_ESTIMATE_WEIGHTS`, `STATION_ESTIMATE_MQTT_WEIGHT`, `STATION_ESTIMATE_MIN_ENTITIES` (10), `STATION_ESTIMATE_MIN_DIRECT` (3), `STATION_ESTIMATE_MAX_POINTS` (8 000), `STATION_ESTIMATE_MAX_ITERATIONS` (50), `STATION_ESTIMATE_MAX_POSITION_AGE_MS` (4 h), `StationEstimateSources`, `StationEstimateProvider`                                                                                                                                                                       |
| `src/config.ts`                                                      | exported `stationOrigins(config)` and `StationConfigOrigin` (`yaml` / `env`); `stationIdentity` unchanged                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/core/station/contract.ts` (new)                                 | `STATION_WRITE_REQUIRES_ACCESS` (`true`, pending E1), `STATION_STORE_FILE`, `STATION_STORE_SCHEMA_VERSION` (1), `STATION_STORE_MAX_BYTES` (4 096), `STATION_STORE_CORRUPT_KEEP` (1), `STATION_COVERAGE_RESET_M` (1 000), `StationStoredValue`, `StationStoreFile`, `StationService`, `StationServiceOptions`                                                                                                                                                                                |
| `src/api/server.ts`                                                  | optional `ApiServerDependencies.storageReport`, `stationEstimate`, `stationService` (accepted, not mounted until Main wires each lane)                                                                                                                                                                                                                                                                                                                                                      |

`tests/unit/core/wg4-contract.test.ts` pins the constants, the trails copy identity, the
`agc` key without a default, `stationOrigins` and the optional slots. The frozen
`contract.ts` files under `src/core/{station,station-estimate,storage-report}/` are read-only
for their lanes. Names a lane creates and Main consumes at merge (not frozen as code, frozen
here by name): `trails` on the query service (lane T); `createStationEstimator(sources):
StationEstimateProvider` and `stationEstimateRoutes(app, { estimate })` (lane D);
`createStorageReporter(options): StorageReportProvider` and `storageRoutes(app, { report })`
(lane S); `openStationService(options): Promise<StationService>`, `StationUpdateError`
(a `WaveKitError` with `statusCode` and a `StationErrorCode`), `CoverageManager.setStation(
station | null): { cleared: boolean }`, and `stationRoutes(app, { station, service?,
authorizeMutation?, writeRequiresAccess? })` keeping today's `{ station }` call valid (lane
ST). Every DTO addition is optional or new; no WebSocket event changes.

## Pipeline positions

```
REST request
  ├─ T: /api/activity/trails → query admission → reader worker (one read transaction) → JSON
  ├─ D: /api/station/estimate → 60 s cache → tracker getAll() snapshots (pull) → Weiszfeld
  ├─ S: /api/storage → 30 s cache → statfs + bounded lstat walk (async fs, libuv pool)
  └─ ST: PATCH /api/station → validate → serialised write (tmp, fsync, rename) → apply
           └─ coverage setStation; readsb and country at the next start
live demod: IQ → shift → channel filter → squelch → demod → [de-emphasis] → A: agc → low-pass → dcblock → gain → limit
ais-catcher stdout line → X1: channel parse (one compare) → ShipData → vessel tracker, Activity (WG3 resolver)
mesh tracker processPacket (unique) → POSITION → X2: fixAt window check
sdr-host poller (every poll) → X3: version sanitise
```

## CPU and IO budgets

| Item              | Position                                         | Budget                                                                                                                                | How measured                                      |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| T trails read     | reader worker, per request                       | ≤ 150 ms Mac for 1 h on a busy store (≈ 21 700 rows); ≤ 1 000 ms at the 200 000-row scan cap (own deadline)                           | benchmark on a seeded 250 000-row store, reported |
| T serialisation   | main thread, per request                         | ≤ 20 ms for the largest response (≈ 1.1 MB)                                                                                           | benchmark, reported                               |
| D estimate        | main thread, per uncached request (≤ 1 per 60 s) | ≤ 25 ms Mac for 8 000 contributors (50 × 8 000 = 400 000 chord distances)                                                             | benchmark, reported                               |
| S scan            | async fs, per uncached report (≤ 1 per 30 s)     | ≤ 2 000 ms wall (bound), ≤ 250 ms main-thread CPU at 50 000 entries                                                                   | benchmark on a generated tree, reported           |
| A agc             | CSDR chain                                       | ± one CSDR process at the channel audio rate (48 kHz float ≈ 192 kB/s through one pipe); Pi share ≤ 2 % of a core, unmeasured (gated) | stage-list tests; Pi gated                        |
| X1 channel        | AIS adapter, per sentence                        | one field read and ≤ 4 string compares                                                                                                | by construction                                   |
| X2 fixAt          | mesh tracker, unique POSITION packets            | 3 comparisons and one `toISOString`                                                                                                   | by construction                                   |
| X3 version        | SDR host poller, per poll                        | one regex over ≤ 64 characters                                                                                                        | by construction                                   |
| ST write          | per PATCH (operator rate)                        | ≤ 4 KiB write + fsync + rename; serialised                                                                                            | test with a tmp dir                               |
| ST coverage reset | per location change                              | one haversine; clearing 2 × 24 × 360 cells (≈ 553 KiB `fill`)                                                                         | by construction                                   |

## Bulk trails (lane T)

**Arithmetic.** Positions are coalesced to at most one stored row per entity per 60 s
(WG1/WG2), so one entity yields at most 61 points per hour and 1 441 per day: 1 440 per entity
covers 24 h. 300 aircraft for one hour = 18 000 points, under the 20 000 cap. The WG3 docs mix
is ≈ 520 000 rows/day ≈ 21 700 rows/h across all kinds, so a one-hour window scans ≈ 21 700
rows, well under the 200 000-row scan cap; a 24-hour window on that store hits the cap after
≈ 9.2 h of newest rows and reports `truncation: ["scan-rows"]`. A point serialises to ≈ 40 B
(`[1760000000000,48.12345,2.12345,10668]`), so 20 000 points ≈ 800 kB plus ≤ 2 000 trail
headers of ≈ 100 B ≈ 200 kB: ≤ ≈ 1.1 MB per response. The trails route is exempt from the
512 KiB search page budget (it is a different DTO with its own caps).

**Read** (`query/trails.ts`, called from `read.ts` in the worker):

```sql
SELECT seq, produced_at_ms, entity_key, category, protocol,
       json_extract(summary_json, '$.position') AS position
FROM activity INDEXED BY activity_produced
WHERE produced_at_ms BETWEEN :from AND :to
  AND kind = 'decoder-reception' AND entity_key IS NOT NULL
  [AND category IN (...)] [AND protocol IN (...)] [AND entity_key IN (...)]
ORDER BY produced_at_ms DESC, seq DESC
LIMIT :scanRows
```

`activity_produced` is `(produced_at_ms)` with the rowid (`seq`) implicit, so the order is an
index walk. The lane may drop `INDEXED BY` when an `entity_key IN` filter makes
`activity_entity` cheaper, measured. `retentionFloor` is `SELECT MIN(produced_at_ms)` (an index
end). Acceptance is greedy newest first: a row's point is accepted when its entity already has
a trail or fewer than 2 000 trails exist, the entity has fewer than 1 440 points and fewer than
20 000 points are accepted; the scan stops at 20 000 accepted points or the scan cap. Each
refused row records its bound in `truncation` and marks its trail. Trails are then reversed to
ascending. A position is valid when `lat` ∈ [-90, 90], `lon` ∈ [-180, 180], both finite and not
both 0; `altM` finite or null.

**Service.** `trails(input)` validates (`validate.ts` rules, plus the window and key limits),
acquires query admission like search (`withActivityClient`), runs with `trailsDeadlineMs`
(1 000, a new `ActivityQueryLimits` key with its default in `service.ts`) and returns the DTO.
Errors are the existing `ActivityQueryError` classes. One trails read holds the single
executing slot for up to 1 s; other queries queue (their deadlines start after admission).

**Failure paths.** Disabled 404, unavailable 503, busy or timeout 429, reader failure 500,
invalid 400 (all existing codes); malformed position JSON or a row the reader cannot parse is
skipped and counted; an empty window is 200 with no trails.

## Approximate station location (lane D)

`src/core/station-estimate/estimator.ts` (pure) and a provider with a 60 s cache and
single-flight; `src/api/routes/station-estimate.ts` with a Fastify response schema covering
every field. Contributors: aircraft (`position`, time `lastUpdated - seenPos × 1000` when
`seenPos` is present, as coverage does), vessels (`position.at`), APRS stations (`kind ===
"station"`, `position.at`; direct when no path element is marked used, as the direwolf adapter
reports the path — the lane confirms the format from the adapter and its fixtures and reports
it), mesh nodes (`position.at`, `hopsAway`, `viaMqtt`). Weights from `STATION_ESTIMATE_WEIGHTS`.

**Estimator.** Map each contributor to a unit vector `v_i`. Start at the normalised weighted
mean; if its norm is below 1e-9 the set is `degenerate`. Iterate Weiszfeld in R³ with chord
distances `d_i = |x - v_i|` (a point closer than 1e-12 returns that point), `x' = Σ(w_i v_i /
d_i) / Σ(w_i / d_i)`, normalised back to the sphere, at most 50 iterations or until the step is
below 1e-9 rad. Convert to lat/lon, round each to 0.05° (`Math.round(x / 0.05) × 0.05`, then
fixed to 2 decimals), normalise longitude to [-180, 180). `uncertaintyKm`: weighted median of
haversine distances (R = 6 371 km) from the unrounded estimate, `max(10, 5 × ceil(d / 5))`.

**Arithmetic.** 0.05° is ≈ 5.6 km of latitude, so the rounding error is ≤ 0.025° (≈ 2.8 km),
below the 10 km floor. 8 000 contributors × 50 iterations = 400 000 chord distances (a few
multiplications each): ≈ 5–15 ms on the Mac, ≤ 25 ms budget, at most once per 60 s.

**Failure paths.** Getter absent or throwing → that fleet is skipped (basis 0); non-finite
positions ignored; below thresholds → `too-few-positions`; vanishing mean → `degenerate`; an
unexpected throw → 500 `STATION_ESTIMATE_FAILED`, not cached.

## Storage report (lane S)

`src/core/storage-report/reporter.ts` (`createStorageReporter(options)`) and
`src/api/routes/storage.ts` (`storageRoutes(app, { report })`, GET and HEAD, `Cache-Control:
no-store`, Fastify response schema covering every field).

**Scan.** Per area, each path: `lstat`; a regular file or symlink adds its size and one file;
a directory is read with `readdir` and walked iteratively (explicit stack, depth ≤ 16), never
following symlinks; `exclude` paths are skipped. One shared budget per report: entries
(every lstat counts), wall time from the report start, and a concurrency limiter of 8
in-flight fs calls. When a bound is reached the current area and all later ones are marked
partial with that reason; their totals are what was counted. Activity `retention` comes from
`options.activityRetention()` (Main maps `ActivityStoreStats` and the resolved limits);
`cap` from `capBytes`. `filesystem` from `statfs(stateDir)`: `totalBytes = blocks × bsize`,
`freeBytes = bfree × bsize`, `availableBytes = bavail × bsize`. `lowSpace.state` is `low` when
`availableBytes < minFreeBytes`, `ok` when both are known and it is not, else `unknown`.

**Arithmetic.** 50 000 lstat calls at ≈ 20 µs on an SSD ≈ 1 s; on an SD card several times
slower, so the 2 s wall bound turns a huge tree into a partial report instead of a slow
request. Main-thread work is ≈ 2–5 µs per entry: ≤ 250 ms at the entry cap, at most once per
30 s. A typical install has a handful of Activity files, ≤ 512 MiB of scanner evidence clips
(hundreds to a few thousand files) and small state files.

**Failure paths.** In requirement 3.5 and 3.6; the cache keeps only successful reports.

## Live audio AGC (lane A)

`effectiveAgc(modulation, agc?)`: `raw` → `off`; absent → `fast` for `am`, `cw`, `dsb`, `usb`,
`lsb` and `off` for `nfm`, `wfm`; explicit → explicit. The planner emits
`csdr agc -f float -p <mode> -r ${AGC_REFERENCE}` in today's AM and SSB positions and, for NFM
and WFM, after `fmdemod` and the optional de-emphasis stage, before the low-pass; `off` emits
nothing. `agc` stays a restart key (not in `NODE_ONLY_KEYS`). The route schema
(`src/api/routes/live-audio.ts`) adds `agc` to config (enum), the PATCH body (enum or null:
null deletes the key) and the status (`agc`, effective).

**Golden.** Before changing the planner the lane records the stage lists of the current planner
for 8 modulations × de-emphasis on/off × low-pass 0/3 000 × high-pass 0/300 × both audio formats
(128 cases) and asserts that absent `agc` reproduces them byte for byte.

**Failure paths.** Invalid config value → `ConfigValidationError` at start; invalid PATCH →
400; whether the CSDR build at `CSDR_REF` accepts `-p slow` cannot be checked offline (CSDR is
not installed on the development Mac): open gap for the next image smoke test.

## Decoder details (lane X)

**X1 AIS.** `normaliseAisChannel(raw: unknown): "A" | "B" | undefined` (exported, pure):
strings trimmed and upper-cased; `A`/`1` → `A`, `B`/`2` → `B`; anything else, non-strings
included, → `undefined`. Applied to NMEA field 4 (the field already used in the fragment key)
and to the JSON `channel`. `ShipData.channel?: "A" | "B"`. The WG3 resolver
(`activity/provenance/resolve.ts`) already maps `A`/`B` to the two AIS carriers and is not
edited; the lane adds an end-to-end test file from adapter output to the stored provenance.

**X2 mesh.** On a POSITION applied to a node: `fixAt = timeS` integer, `timeS > 0` and
`at - 7 d ≤ timeS × 1000 ≤ at + 60 s` ? ISO : null. The 60 s matches coverage's future rule;
7 days bounds a node replaying an old fix. Route position schema gains `fixAt`
(`string | null`).

**X3 SDR host.** `packages/sdr-host/src/api/routes/status.ts` exports `SDR_HOST_VERSION` and
replies with it; a test reads `packages/sdr-host/package.json` and asserts equality. (The
image copies the root `package.json`, not the SDR host's, to `/app`, so reading a manifest at
runtime would report the wrong version.) The core poller sets `version` when the field is a
string matching `^[\x20-\x7e]{1,64}$`, else null; `createUnavailableStatus` sets null. The
resources route schema gains `version`.

**Failure paths.** Garbage channel → omitted (frequency stays null, as today); `timeS` 0,
absent, fractional or out of window → null; an old SDR host replies `"1.0.0"`, which passes.

## Station write layer (lane ST)

**Pending user decision (E1).** The frozen behaviour is: a station-only persisted layer now,
shaped as per-field value plus provenance so a future settings store can absorb it; PATCH
mounted only in protected mode (`STATION_WRITE_REQUIRES_ACCESS = true`). The alternative
(`false`) mounts PATCH in legacy mode too. Both are implemented and tested; the decision only
flips the constant.

**Store** (`src/core/station/store.ts`): load at open (`readFile`, size check ≤ 4 096 B, JSON
parse, Zod schema of `StationStoreFile`, each value re-validated with the field's
`StationConfigSchema` entry). Corrupt → warn once, rename to `station.json.corrupt-<ms>`
(remove older `station.json.corrupt-*` first so at most one stays), empty layer, revision 0.
Write: `mkdir -p stateDir`, write `station.json.<pid>.tmp`, `fsync`, `rename`, best-effort
directory `fsync`. Arithmetic: six fields, the longest values 256 + 128 characters, with
provenance and ISO times, serialise to ≤ ≈ 1 KiB, well under the 4 KiB bound.

**Service** (`openStationService`): layers = `stationOrigins(config)` and `config.station`
(env/yaml), the stored UI fields, defaults. Effective field = first set layer in precedence
order; provenance accordingly. lat/lon: an effective pair needs both from the same rule; a
stored half pair is ignored. `update()`: serialised by a promise chain; validates the shape
and values (400), checks pinned fields (409 with the request's pinned fields; lat/lon are
pinned jointly), checks the lat/lon pair (400), checks If-Match (412), writes (503 on
failure, state unchanged), then swaps the in-memory layer, computes `changed`, calls
`onLocationChange` when the effective location changed (a throw is logged, the update
succeeds with `coverageCleared: false`), notifies `onChange` listeners, and returns
`StationUpdateResult`. `identity()` is the live effective identity with `revision` and
`writable`; `effectiveCountry` equals the effective `country.value`.

**Coverage.** `CoverageManager.setStation(next)` / `CoverageTracker.setStation(next)`: when
`next` is null and the station was set, or the haversine distance between the old and new
station is more than 1 000 m (or the old one was null and the new one is set), clear all
cells and per-entity maps and return `{ cleared: true }`; otherwise update the station and
keep the cells (`{ cleared: false }`). The tracker's station field stops being `readonly`.

**Route** (`src/api/routes/station.ts`): GET and HEAD read `service?.identity() ?? station`
per request (no frozen body). PATCH is registered iff `service` is given and
(`authorizeMutation` is given or `writeRequiresAccess` is false); `writeRequiresAccess`
defaults to `STATION_WRITE_REQUIRES_ACCESS` so tests can run both values. The authorization
hook runs first (denial status and headers as the band-plan routes send them); `If-Match`
accepts `"<n>"` or `<n>` (otherwise 400); route `bodyLimit` 4 096. Error bodies are
`StationErrorBody`.

**Failure paths.** In requirements 6.5–6.7; stateDir unwritable → 503 per write, reads keep
working; a pinned field in a mixed patch rejects the whole patch (no partial apply).

## Main wiring

`src/index.ts`: storage area list (`activity` = `<stateDir>/activity` with `capBytes` =
resolved `maxDbBytes` and retention from the store stats and limits; `scanner-evidence` =
the scanner evidence directory with `maxRecordingsMb` and `minFreeDiskMb`; `digital-voice-wav`
= the configured dsd-fme `wavDir`s; `bandplans` = `<stateDir>/bandplans`; `operator-data`;
`access`; `decoder-overrides` = `<stateDir>/decoder-band-overrides.json`; `station` =
`<stateDir>/station.json`; `logs` = `logging.dir` when set); estimate getters
(`getTracker().getAll()` of the four trackers, `stationConfigured` from the station service);
`openStationService` before the decoder registry, its `location()` read by the readsb factory
(read at each readsb start, so a decoder restart applies a changed location) and
its `effectiveCountry` passed to band plans at start; coverage built from
`stationService.location()` and wired through `onLocationChange` to `setStation`.
`src/api/server.ts`: register `storageRoutes`, `stationEstimateRoutes` and the station route
with `service` and, with the access controller only, `authorizeMutation`; `trails` is
required on the query service since lane T merged.

## Correctness properties

1. **Trails model.** For any stored rows (random entities, categories, times, valid and
   invalid positions) and any query, the response equals a naive in-memory model of 1.3–1.5:
   every point is inside the window, every trail is strictly ordered, the caps hold, and
   `skippedRows` counts exactly the invalid positions in the scanned rows. _Validates 1.1,
   1.3–1.5._
2. **Trails truncation keeps the newest.** When any bound cuts the result, each returned
   trail holds its entity's newest accepted points (newest first, by seq), and a refused
   entity is not newer than any returned trail's newest point. Points of different entities
   are not ordered against each other: under the greedy rule an older point of an entity
   already bound can be returned while a newer point of an entity refused by `entities` is
   not. _Validates 1.4._
3. **Estimate equivariance.** Rotating every contributor's longitude by any δ (with
   wrapping) rotates the unrounded estimate by δ within 1e-6°, including across the
   antimeridian. _Validates 2.4._
4. **Estimate bounds.** The unrounded estimate lies within the contributors' spherical
   bounding cap; a set symmetric about a point returns that point within 1e-6°; the rounding
   error is ≤ 0.025°; below the thresholds the result is unavailable. _Validates 2.3–2.5._
5. **Storage totals.** For any generated tree (files, nested directories, symlinks including
   loops) within the bounds, `bytes` and `files` equal a model's sums and `partial` is false;
   with a bound lowered, `partial` is true iff the bound was reached, totals never exceed the
   model, and the scan terminates. _Validates 3.2, 3.4, 3.5._
6. **AGC planner.** For every modulation, filter and de-emphasis combination, absent `agc`
   equals the recorded golden stage list, and the chain has exactly one AGC stage iff the
   effective mode is not `off`, placed as 4.3 states. _Validates 4.2, 4.3._
7. **AIS channel normalisation.** For any input, the result is `A`, `B` or undefined, and it
   is `A`/`B` exactly for the four accepted spellings (after trim and case). _Validates 5.1._
8. **Mesh fix time.** For any receive time and `timeS`, `fixAt` is non-null iff the window
   rule holds, and then equals `timeS × 1000`. _Validates 5.3._
9. **Poller hostility.** For any JSON value as the SDR host body, the poller returns a status
   without throwing and `version` is null or a 1–64 printable string. _Validates 5.5._
10. **Station precedence.** For any env/yaml/ui/default layer combination and any patch, the
    effective identity equals the precedence model, a pinned field never changes, a rejected
    patch changes nothing, and, for every pair a patch can change (config sets both lat and
    lon or neither), the effective lat/lon are both set or both null. A config-pinned half
    pair is reported as-is, unchanged from today. _Validates 6.1–6.3, 6.6._
11. **Station store.** Any valid layer round-trips through the file; any byte string as the
    file loads as an empty layer or a valid one, never throws, and leaves at most one corrupt
    copy. _Validates 6.4, 6.7._
12. **Coverage reset.** For any old and new station, the cells are cleared iff the move is
    more than 1 km or either side is null while the other is set. _Validates 6.10._
