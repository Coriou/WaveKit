# Event foundation, batch 1: scoped amendment

This amendment narrows [design.md](design.md) for the first implementation batch:
decoder envelope publication, a persistent Activity store with search and facets,
and a replay cursor. Where this file and design.md differ, this file governs batch 1;
everything it does not mention keeps the design.md decision or stays deferred.
The frozen code contract is `src/core/activity/storage/contract.ts`.

## Decisions (owner, 2026-10-12)

- **Exposure:** store, ingress, REST and WS replay are mounted but disabled by
  default (`activity.enabled: false`). Disabled means no database file is created,
  no worker starts and the routes answer 404 `ACTIVITY_DISABLED`. The legacy
  `decoder:output` stream is unchanged in either state.
- **Driver:** `node:sqlite` (`DatabaseSync`) in worker threads. The floor is a
  runtime capability probe, not a version string: `node:sqlite` must load and an
  in-memory FTS5 table with `contentless_delete=1` must be creatable. Measured
  locally: Node 22.14.0 has `node:sqlite` but no FTS5 (unsupported); 22.17.1
  (SQLite 3.50.0), 22.23.2, 24.20.0 and 25.2.1 pass. WaveKit's supported
  floor is Node 24 LTS (owner, 2026-10-12: engines, `.nvmrc`, CI and image
  bases); the probe stays as the guard for unusual builds. On a failing runtime,
  enabling Activity fails with `ACTIVITY_UNAVAILABLE` before any state file is
  written; the rest of WaveKit keeps running. `better-sqlite3` is not used.
- **Admission:** simplified. Event IDs are allocated in-process once per decoder
  output; duplicate delivery of the same `eventId` is absorbed by the unique
  index and counted. The epoch/ticket/receipt retry horizon and
  `ADMISSION_EXPIRED` are deferred until an out-of-process or durable producer
  exists (scanner outbox, Task42).
- **Facets:** bounded facet counts are added (below); design.md had none.

## Scope

In: `decoder-reception` and `ingestion-gap` records; schema v1; writer worker;
ingress queue and rate limits; telemetry exclusion; retention and prune watermark;
search, detail, facets; snapshot page tokens; signed replay cursor; WS
subscription; config; shared DTOs in `packages/api-types`; API docs.

Out (deferred): call-lifecycle, analog-transmission, scanner-result and
recording-change producers; recordings and catalog tables; receipts; schema
migration and backup/restore (a mismatched schemaVersion is refused); CLI and web
views; Docker image and ARM64 verification (no image build was authorised);
measured retention defaults.

## Publication seam

`DecoderManager`'s per-decoder output handler allocates `crypto.randomUUID()`
and captures `receivedAt` once, builds the envelope with `createDecodeEnvelope`
(provenance `sourceId`/`frequency` null unless a real owner binding exists), and
hands it to the Activity store when enabled. Envelope construction failure or
store overload never affects the legacy emit, which runs first and unchanged.
Telemetry output types (`sync`, `rates`, `stats` and other replaceable health
outputs, classified by an explicit allow-list) are excluded and counted.

## Storage

- One SQLite file `<stateDir>/activity/activity.db`, WAL, `synchronous=FULL`,
  `busy_timeout=100`, `foreign_keys=ON`, `auto_vacuum=INCREMENTAL` set before
  the schema is created. The writer worker holds the store lock in a separate
  `<stateDir>/activity/activity.lock.db`, opened with
  `PRAGMA locking_mode=EXCLUSIVE` and a write lock kept for the session
  (`BEGIN EXCLUSIVE`, or a write that takes the exclusive lock and holds it).
  The kernel releases that lock on close or process death. A second opener,
  in this process or another, gets `ACTIVITY_STORE_LOCKED`. There is no PID
  file and no rename-aside recovery.
- Schema v1 is `ACTIVITY_SCHEMA_V1` in the contract. `store_meta` holds
  schemaVersion, storeUuid, restoreGeneration (starts 1), pruneWatermark,
  pruneGeneration and the 32-byte cursor key (hex). The key never leaves the
  process.
- One writer worker. Ingress queue 1,024 items / 8 MiB; token buckets 100/s
  burst 1,000 global and 50/s burst 200 per decoder instance; batches of at most
  64 items, 512 KiB or 25 ms, each one transaction (activity row, refs, FTS row).
- Dropped envelopes are counted. One `ingestion-gap` record summarises an
  episode. The episode closes after a quiet period with no drops
  (`gapQuietMs`, default 5 s) or, while drops continue, at most one gap
  record per `gapMaxIntervalMs` (default 60 s) aggregating the counts since
  the previous record. A `gapQuietMs` timer closes and stages the episode
  when admits stop. `close()` stages an open episode into the shutdown
  drain before abandoning the queue. The warn log uses the same limit.
  Closed, paused and rate tokens are checked before the row is built. The
  byte cap is checked after the row is built, and tokens taken for a row
  that does not fit are refunded. A gap record is never itself dropped for
  rate reasons.
- Admits rejected because the writer has stopped are counted as
  `dropped.closed`. Status includes `writer: "running" | "stopped"`. Writes
  use their own timeout (default 30 s), separate from the open timeout. A
  write timeout stops the writer for the session: one error is logged, and
  those rows are not nacked as lost, because the worker may still commit
  them. This batch does not restart the writer.
- Indexed FTS text: title, protocol, field labels, string, numeric and
  boolean field values, and decoded string leaves, truncated to 8 KiB UTF-8
  per event.

## Retention

Defaults, provisional and unmeasured: 1,000,000 rows, 2 GiB database, 7 days,
whichever is reached first; WAL checkpoint (PASSIVE) at 16 MiB, TRUNCATE attempt
at 48 MiB, writes paused (and counted as `store-paused`) at 64 MiB. `maxRows`
is an integer of at least 1,000. `maxDbBytes` is an integer of at least
16 MiB. Age pruning runs only when the oldest
`receivedAt` is older than `now - maxAge - slack`, where `slack` is
`max(60 s, 1% of maxAge)`, and then deletes down to `now - maxAge`. The
writer session keeps hysteresis for the row cap and the byte cap. A cap
turns on when the store crosses it and stays on until the store is at or
under a low-water mark of 95% of that cap: once active, rows continue while
`count > lowWater`, and bytes continue while live bytes are above
`lowWater(maxDbBytes)`. Live bytes are
`(page_count - freelist_count) * page_size`, so pages on the freelist do
not keep the byte cap on. While a cap is active, one write runs consecutive
prune transactions back to back, stopping at `pruneBurstBatches` (default 20) or `pruneBurstMs` (default 300 ms), whichever comes first. Each
transaction deletes an ascending `seq` prefix of at most
`pruneBatchRows` and, for the row cap, never more than `count - lowWater`
rows. It advances `pruneWatermark` to the greatest deleted seq and
increments `pruneGeneration`, then runs `PRAGMA incremental_vacuum`. Never
a full VACUUM. Stats report the observed oldest record, not the configured
age.

## Search, detail and facets

As design.md "Search and replay protocol" (filters, 16 terms, 256-byte text,
8 quoted tokens, page 100/200/512 KiB, keyset by seq, 250 ms reader deadline,
one in-flight request per admitted access principal, or per request IP when
the request has no principal, four queued and one executing globally, 429
`ACTIVITY_QUERY_BUSY` / `ACTIVITY_QUERY_TIMEOUT`), with one reader worker that
is terminated and recreated on deadline. The key is that principal's id:
the device id for a session, otherwise the machine id. A client-chosen
header is not the key.
Plain text is tokenised by the server and quoted; user FTS operators are
never passed through. Whitespace- or punctuation-only text is no text filter.
A corrupt stored record or a failed read is HTTP 500
(`ACTIVITY_RECORD_CORRUPT` or `ACTIVITY_QUERY_FAILED`).

Facets: `dimensions` from category, protocol, decoderId, sourceId, kind, at most
5 per request. Counts are computed over the same filter inside `(L, H]`, examining
at most 50,000 rows in descending seq; when the cap is hit, `truncated: true` and
counts are lower bounds. At most 32 values per dimension. Same deadline and
admission as search.

## Cursor and replay

Page tokens and replay cursors are base64url `payload.mac` tokens with an
HMAC-SHA256 over the payload fields listed in design.md; `queryHash` is
SHA-256 of the canonical (sorted, normalised) query. Validation failure,
expiry, a changed store UUID or restore generation, or a changed query hash
yield explicit resets (400 `ACTIVITY_CURSOR_INVALID`, 409
`ACTIVITY_SNAPSHOT_RESET`; WS `reset` frames). A cursor is a gap only when
`lastSeq < watermark`. A cursor exactly at the watermark missed nothing and
is not a gap (REST 410 `ACTIVITY_CURSOR_GAP`, WS `cursor-gap`). Replay maps
a snapshot reset to `cursor-gap` and does not send `snapshot-reset`. A read
that fails sends WS `reset` with `reader-failed` and releases the
subscription. Replay: subscribe to commit wakeups first, read committed
max, catch up ascending in bounded pages, then follow; every frame carries
`scannedThrough`. WS limits: 2 subscriptions per client, 8 global, 256
messages or 1 MiB queued per client; overflow pauses the replay (not a
durable buffer) and closes with a resumable reason and the last delivered
cursor of each subscription, `{ reason, cursors: { [id]: cursor } }`.

## Routes (mounted, disabled by default)

- `GET /api/activity` search page; `GET /api/activity/:eventId` detail;
  `POST /api/activity/facets`; `GET /api/activity/status` (enabled, stats,
  including `writer` and `dropped.closed`).
- WS `activity` subscription with `{ query, cursor? }` and frames as the contract.
- Access policy: read routes follow the existing read permission for decoder
  data; no new write routes.

## Acceptance for batch 1

Unit and property tests for: schema creation and refusal of other versions;
lock rejection; admission limits and loss counters; gap records; telemetry
exclusion; FTS escaping; keyset paging stability under concurrent commits;
facet caps; cursor tamper, expiry, gap and store-change resets; replay with no
loss and harmless duplicates across reconnect; prune watermark monotonicity;
disabled mode creates no files. The capability probe is checked against local
Node 22.14.0 (must refuse) and 22.17.1 (must pass). Local, laptop-only qualification of the existing harness is allowed;
no Docker, Pi, receiver or load runs.
