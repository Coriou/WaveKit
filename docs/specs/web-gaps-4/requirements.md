# Web gaps 4 requirements (WG4)

Status: implemented, pending gates (lanes merged and wired). Requirement 6.9 (who may write the
station) is pending a user decision; the frozen behaviour is the recommended one. See
[design](design.md) and [tasks](tasks.md).

## Scope

The fourth batch of core features the planned web dashboard needs: bulk position trails from
the Activity store for a map overlay with a time cursor; an approximate station location
derived from heard positions, for a map centre when no location is configured; a storage
report for a Settings > Storage page; a selectable AGC mode for live audio, including FM; three
decoder details (the AIS channel, so stored AIS receptions get their frequency; the Meshtastic
GPS fix time; the SDR host version); and a persisted station write layer
(`PATCH /api/station`) with a live coverage map.

Out of scope: CLI and web UI features (the CLI gets a coordination note only); a generic
settings store (the station layer is shaped so one can absorb it); persistent trails beyond
the Activity store; any change to the Activity caps (250 000 rows, 256 MiB, 3 days), admission
limits, retention policy default (`fair-share`) or `activity.enabled`; the access default
(`legacy`); scanner code and defaults (`src/core/scanner/**`, `src/services/scanner-service*`),
including plan-preview `decodedElsewhere` and scanner event replay; the channelizer (stays off)
and S2 (stays disabled); band-plan import formats; tuning-aware reception provenance; DCS;
noise squelch; decoder PATCH; a read-only access role; automatic shortening of retention when
the disk is low (the storage report describes the only existing low-space behaviour); the
files pinned by the band-plans spec (`src/decoders/band-region.ts`,
`src/decoders/band-defaults.ts`, `src/core/scanner/bandplan/index.ts`,
`src/core/scanner/bandplan/builtin.ts`); new npm dependencies.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network or data research, load runs. Fixtures are self-encoded or inline. CPU
figures measured on the Raspberry Pi are open gaps, not acceptance criteria.

Every hot-path item states its CPU budget and its pipeline position in the design.

## 1. Bulk position trails

As a web user I want the last hour of every aircraft, vessel, APRS station and mesh node on
the map, with a time cursor, in one request instead of paging each entity.

1.1 `GET /api/activity/trails` shall return `ActivityTrails`: one trail per `entityKey` of
stored `decoder-reception` rows whose summary carries a valid position, inside a `producedAt`
window.
1.2 Query parameters: `producedFrom`, `producedTo` (ISO), `categories` and `protocols` (comma
lists or repeated, as on the search route) and `entityKey` (repeated, each one key, at most
`ACTIVITY_TRAILS_MAX_ENTITY_KEYS` = 64). Defaults: `producedTo` = now, `producedFrom` =
`producedTo` minus 1 hour. Any other parameter, an unparseable time, `producedFrom >
producedTo`, a window longer than 24 hours, an unknown category or too many keys is 400
`ACTIVITY_QUERY_INVALID`.
1.3 A point is `[producedAtMs, lat, lon, altM | null]`. Points of a trail are ascending by
`producedAt` (ties by `commitSeq`); trails are ordered by their newest point descending, then
`entityKey` ascending. A trail's `category` and `protocol` are those of its newest point.
1.4 Bounds: at most 200 000 rows examined (`ACTIVITY_TRAILS_SCAN_ROWS`), 20 000 points, 2 000
entities, 1 440 points per entity. Rows are taken newest first; a bound that cuts the result
sets `truncated: true` and names itself in `truncation` (`scan-rows`, `points`, `entities`,
`per-entity`); a cut trail has `truncated: true`. Truncation always drops the oldest points.
1.5 A row whose stored position is missing, non-finite, out of range or exactly (0, 0) is
skipped and counted in `skippedRows`; it never fails the request.
1.6 `retentionFloor` is the `producedAt` of the oldest stored row (null when the store is
empty), so a client can say "trail since".
1.7 The read runs in the Activity reader worker in one read transaction, through the existing
query admission (same busy and timeout responses as search, 429), with its own deadline of
1 000 ms; Activity disabled is 404 `ACTIVITY_DISABLED`, unavailable 503
`ACTIVITY_UNAVAILABLE`, a reader failure 500 `ACTIVITY_QUERY_FAILED`, as on the other Activity
routes. The response is a snapshot: no cursor, no page token, no hole checks.
1.8 Budget: at most 150 ms on the development Mac for a one-hour window on a busy store
(about 21 700 rows/h) and at most 1 000 ms at the scan cap; main-thread work is the JSON
serialisation of at most about 1.1 MB.

## 2. Approximate station location

As a web user without a configured location I want the map centred near my receiver, clearly
marked as approximate.

2.1 `GET /api/station/estimate` shall return `StationEstimate`, 200 in every non-error case.
2.2 Contributors are the current tracker snapshots: aircraft and vessels with a position
(weight 1), APRS `station` entities with a position (2 when heard without a digipeater, else
1; objects and items never), Meshtastic nodes with a position (4 when `hopsAway` is 0 and not
`viaMqtt`, 1 when relayed over RF, never when last heard via MQTT). Positions older than 4 hours
by their own time are ignored; at most 8 000 contributors, newest positions kept.
2.3 The estimate is available with at least 10 contributors, or at least 3 of weight 4 or 2;
otherwise `available: false, reason: "too-few-positions"`. A set without a unique spherical
median (the weighted mean vector vanishes) is `reason: "degenerate"`.
2.4 The estimator is the weighted geometric median on the unit sphere (3-D unit vectors,
Weiszfeld, at most 50 iterations), so it is antimeridian- and pole-safe.
2.5 `lat` and `lon` are rounded to 0.05° (longitude normalised to [-180, 180)); `uncertaintyKm`
is the weighted median great-circle distance from the estimate to the contributors, rounded
up to a multiple of 5 km, at least 10 km.
2.6 The response always carries `authoritative: false`, the `basis` counts per fleet,
`stationConfigured` (configured lat and lon both set) and `computedAt`/`cachedUntil`. It is
computed whether or not a station is configured.
2.7 The estimate is cached for 60 s and concurrent requests share one computation; nothing
runs on any tracker or decoder path (pull model).
2.8 The estimate never feeds coverage, decoders (readsb), band plans or the station write
layer; a test asserts that no module under `src/core/coverage/`, `src/core/station/` or
`src/decoders/` imports it.
2.9 A snapshot getter that is absent or throws skips that fleet; non-finite positions are
ignored.

## 3. Storage report

As an operator I want to see how much disk WaveKit uses, per area, against the caps it
enforces, without the API exposing file-system paths.

3.1 `GET /api/storage` shall return `StorageReport` with one `StorageArea` per configured area
in `STORAGE_AREA_IDS` order (`activity`, `scanner-evidence`, `digital-voice-wav`, `bandplans`,
`operator-data`, `access`, `decoder-overrides`, `station`, `logs`); Main supplies the list.
Paths are never returned.
3.2 Each area reports `bytes` (lstat sizes of regular files and symlinks), `files`, `exists`,
`partial` with `partialReason`, its class from `STORAGE_AREA_CLASS`, `cap` (configured bytes or
null) and `retention` (Activity only: policy, effective policy, caps, rows, oldest row and the
retention shares from the store's own stats).
3.3 `filesystem` reports total, free and available bytes of the file system holding
`stateDir` (null when `statfs` fails). `lowSpace` describes the only low-space behaviour
(`scanner-evidence-stops-writing`), its `minFreeBytes` and a state `ok`, `low` or `unknown`.
`kept` is null.
3.4 Bounds, shared by all areas of one report: at most 50 000 entries, depth 16, 2 000 ms
wall time, file-system concurrency 8. A bound reached marks the current and every remaining
area `partial` with the matching reason. Symlinks are never followed.
3.5 A missing area root is `exists: false, bytes: 0`, not partial; an entry that vanishes
during the scan is ignored; EACCES or EPERM is `partial` with `permission`; any other error
`io-error`.
3.6 The report is cached for 30 s; concurrent requests share one scan; a scan that throws is
500 `STORAGE_REPORT_FAILED` and is not cached.
3.7 The report and its documentation shall not claim that WaveKit shortens retention when
the disk is low.

## 4. Live audio AGC

As a listener I want to turn AGC off, slow or fast, including on FM.

4.1 `liveDemod.agc` shall accept `off`, `slow` and `fast`; any other value is a config
validation error. It has no default.
4.2 Absent `agc` yields exactly today's chain: AM, CW, DSB, USB and LSB with `csdr agc -p
fast`; NFM, WFM and raw without AGC.
4.3 Explicit `off` removes the AGC stage; `slow` or `fast` sets the profile; on NFM and WFM it
inserts `csdr agc -f float -p <mode> -r <reference>` after the discriminator and de-emphasis,
before the low-pass. Raw never gets AGC.
4.4 `PATCH /api/live-audio/config` shall accept `agc` (`off`, `slow`, `fast`, or null to
return to the modulation default); an invalid value is 400 as for other invalid fields. A
change restarts the CSDR chain (it is not a Node-only key), which closes an open transmission
with reason `config`, as today.
4.5 `LiveAudioStatus.agc` reports the effective mode of the running chain; `config.agc` echoes
the configured value (absent when unset).
4.6 AGC does not affect squelch (squelch measures IQ channel power before demodulation).
4.7 Budget: at most one CSDR process more or less, at the channel audio rate.

## 5. Decoder details

5.1 AIS: `ShipData.channel` shall be `A` or `B` from the NMEA radio channel field (`A` or `1`
gives `A`, `B` or `2` gives `B`, after trimming and upper-casing; anything else omits it) and
from the AIS-catcher JSON `channel` with the same rule. A multi-fragment message takes the
channel of its fragment group.
5.2 As a result, stored AIS receptions carry `provenance.frequency` 161 975 000 Hz (A) or
162 025 000 Hz (B) through the existing WG3 resolver, which is not changed.
5.3 Meshtastic: `MeshPosition.fixAt` shall be the ISO time of `Position.time` when it is an
integer greater than 0 and lies between 7 days before and 60 s after the receive time `at`;
otherwise null. The position replacement order (by receive time) is unchanged.
5.4 SDR host: `GET /api/status` on the SDR host shall report its own version from one exported
constant that a test keeps equal to `packages/sdr-host/package.json`.
5.5 The core SDR host poller shall pass `version` through when it is a string of 1 to 64
printable ASCII characters, else null; it never throws on hostile JSON.
5.6 The mesh and resources route response schemas shall carry `fixAt` and `version`.

## 6. Station write layer

As an operator I want to set the station location and identity from the web UI, unless the
deployment pins them in YAML or the environment.

6.1 `PATCH /api/station` shall accept a strict JSON object, at most 4 KiB, with at least one of
`name`, `lat`, `lon`, `altM`, `callsign`, `country`; a value sets the UI layer (validated like
the YAML `station` block), null clears it. Otherwise 400 `STATION_UPDATE_INVALID`.
6.2 `lat` and `lon` shall be set or cleared together (400 otherwise); after a patch every
pair a patch can change is either both set or both unset. A config-pinned half pair (YAML or
env sets only `lat` or only `lon`) is reported as-is, unchanged from today (6.3, 6.11): no
patch can change it and the UI layer never fills the missing half.
6.3 Precedence per field: env > yaml > ui > default. A field set by YAML or env is pinned: a
patch naming it is 409 `STATION_FIELD_PINNED` with `fields`; when either of `lat`/`lon` is
pinned, both are.
6.4 The UI layer persists to `<stateDir>/station.json`
`{ schemaVersion: 1, revision, fields: { <field>: { value, provenance: "ui", updatedAt } } }`,
at most 4 096 bytes, written to a temporary file, fsynced and renamed. `revision` increments
by one per successful write.
6.5 `If-Match` with a revision is optional; a mismatch is 412 `STATION_REVISION_MISMATCH`.
6.6 A write that cannot be persisted is 503 `STATION_STORE_UNAVAILABLE` and changes nothing.
Concurrent patches are serialised.
6.7 A missing file is an empty layer; a corrupt, oversized or wrong-version file is ignored
(logged once), renamed `station.json.corrupt-<ms>` (at most one kept) and the next patch writes
a fresh file. A stored value that fails validation, or a stored lat without lon, is ignored.
6.8 `GET /api/station` shall become live: it returns the effective identity with `revision`
and `writable`, in both access modes.
6.9 **Pending user decision (E1).** While `STATION_WRITE_REQUIRES_ACCESS` is `true` (frozen
default), PATCH is mounted only with the access controller (protected mode) behind
`authorizeMetadataMutation`; in legacy mode it does not exist (404) and `writable` is false.
With the constant `false`, PATCH is also mounted in legacy mode, without an authorization hook.
Flipping it is a one-line change; the route tests run under both values.
6.10 Live apply: a changed location calls the coverage manager's `setStation`; a move of more
than 1 km, or clearing the location, clears the coverage map (`coverageCleared: true`); a
smaller move keeps it. readsb picks the effective location up at its next start
(`appliesOnRestart: ["readsb"]`); a country change takes effect after a restart
(`restartRequired: ["country"]`) because band plans bind it at startup.
6.11 The UI layer is read in both access modes; YAML and env behaviour without a UI layer is
exactly today's.

## 7. Main items

7.1 Main wires the providers (storage area list, estimate snapshot getters, station service,
coverage `setStation`, readsb effective location, start-up country) and mounts the new routes.
7.2 Main verifies the access policy treats the new GET routes like the existing read routes in
protected mode, and PATCH `/api/station` like the band-plan mutations.
7.3 docs/API.md, ROADMAP, `config/default.yaml` and the coordination note shall describe
trails, the estimate, the storage report, AGC, the AIS channel and frequency, `fixAt`, the SDR
host version and the station write layer.

## 8. Verification

8.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
8.2 The root suite, typecheck and lint pass at every merge.
