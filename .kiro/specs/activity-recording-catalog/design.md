# Activity and recording catalog — design

Status: reviewed design only. Accepted-S1 reconciliation and the bounded storage
qualification plan passed independent delta review. Only the disposable qualification harness and bounded guard/micro tests are allocated; production implementation remains unallocated. Requirements are in
[requirements.md](requirements.md); allocation and acceptance gates are in
[tasks.md](tasks.md). One cohesive spec keeps ingestion, durable links and deletion
invariants together; implementation batches have separate ownership. This is not
a general event bus or a replacement for scanner recovery stores.

## Grounded baseline

Original audit: core `ccc319fe828a991cdd3a060486a81959e071168d`, scanner
`0fc3fdb5a4186741200730f0491b87c34ac5187d`. Reconciled against accepted S1
`90bfa03177135786b7cae28ddf43ffc087d9b1eb` (runtime `6519de733577e4592b80e3d77d4ea8c3040e59d5`)
on released base `d452b0a66eff76fa2864d2d2d5cdbbce9412d336`. Current assertions below
refer to that accepted code; historical defects are not carried as current gaps.
Cached web reference remains `28280cf8f322ff381eada2c4c388063d4d47cf35`;
remote freshness was not checked.

- `src/decoders/manager.ts`, `setupDecoderEventHandlers`, forwards each decoder's
  output to `decoder:output`; `src/api/websocket/events.ts` sends `{decoderId,
output}`. There is no durable ingress identity or event-time RF binding there.
- `src/core/activity/{types,projection,envelope}.ts` is complete and unmounted.
  It preserves caller eventId, two clocks and complete bounded normalized data;
  its 128 KiB/depth16/node4096 limits and null RF defaults remain unchanged.
- `src/decoders/builtin/dsd-fme.ts` generates instance/time/sequence call IDs,
  supports late `wavFileUpdate` call-end output, searches native filenames, and
  invokes `call-recordings.ts` for age/size pruning. Its ten-second mtime guard
  is a heuristic, not a producer-close acknowledgement or Keep support.
- Scanner `store/discovery-store.ts`, `store/persistence.ts` and
  `store/evidence-store.ts` own discoveries, observations, recovery and evidence.
  Existing audio IDs are `discoveryId~filename`; digital linking moves native WAVs
  from probe directories. `evidence/capture-store.ts` owns `cap_*` IQ files and
  sidecars with a distinct delete/retention path. These owners remain authoritative.
  Scanner probe config disables the native per-call pruner; preserve that ownership
  transfer. Observations are capped at256/discovery regardless of Keep.
- Scanner identify progress is mutable target state. S2 analog recorder/channel
  features and S3 monitor are planned in the scanner plan, not capabilities of
  the audited candidate. A monitor's selected audio is not every channel's calls.
- CLI messages use bounded local presentation/search; web `CORE-GAPS.md` and
  `DESIGN.md` on the cached design branch describe Activity and recording UX.
  Mock Keep, seek, tones, transcripts, exports and “all audio” are not backend
  capabilities. Preserve the UI owner boundary; no UI edits here.
- Root `package.json` has no database dependency; docs support Node20+, `.nvmrc`
  pins 25.2.1, Docker's node-build uses Node22, and esbuild externalizes packages.
  Compose mounts state at `/app/data` in relevant profiles; `/recordings` is not
  a universal state mount. Do not store a DB in an ephemeral image layer.

### Accepted S1 failure and settlement contracts

F3's EvidenceStore `admits` combines the authoritative DiscoveryStore existence
predicate with a bounded in-flight removal map. The map is not permanent deletion
history: standalone stores can explicitly re-admit an ID, while production IDs
remain unique and absent discoveries stay unavailable. Merged-away IDs lose
admission/download authority too. Preserve this distinction when importing aliases;
old scanner routes cannot bypass existence checks merely because catalog has bytes.
A kept future catalog object may have an independent catalog link, never revive the
removed scanner discovery. Probe finally cleanup/startup orphan cleanup and separate
CaptureStore retention remain unchanged; F3 is not power-loss atomicity or Keep.

F5's fatal worker exit/error or failed pipeline replacement invalidates engine
generation/readiness/stats, closes host/branch/ring/listeners, clears service cached
summaries/profile reservations and fails affected nonterminal scanner jobs using
`tuner-unavailable`. Active identify trials are cancelled; late old-generation
output cannot refresh evidence. Fresh demand waits for failed-host cleanup before
opening a new supported-IQ engine; there is no automatic unbounded restart loop or
no-data watchdog. Activity adapters must use these owner failure/generation signals
and record interrupted coverage, never present stale summary metadata as live RF.
Do not add a second cleanup authority or deduce absence of receptions from failure.

Terminal REST state/endedAt still becomes visible before awaited teardown; terminal
job WS publication follows teardown. Even WS terminal is not a blanket catalog file
settlement receipt: asynchronous recording linking needs its own operation outcome.
Resource admission can still return409/releasing until cleanup settles. S2/S3 must
extend owner drains to new producer operations and preserve the existing F3/F5
regressions; UI recovery reads actual availability, not elapsed time since terminal.

## Identity and the ingress seam

Add a narrow Activity ingress dependency at the manager's existing per-decoder
output handler. Allocate `crypto.randomUUID()` once, capture receivedAt once,
and construct one detached envelope before new Activity consumers run. Legacy
output fan-out remains compatible. Do not allocate in WS, the database or scanner
listeners. A native output that bypasses the manager must be brought through an
explicit registered adapter using the same ingress entry, never subscribed twice.
An invalid/over-budget output can consume an ID and increment a loss counter; it
does not become a partially truncated persisted envelope. No sequence is promised
until commit. Retrying an accepted item retains ID and canonical bytes.

Use an instance-run UUID in qualified references: `(decoderId, producerRunId,
nativeCallId)`. Preserve nativeCallId verbatim; it is not globally restart unique.
Sample playback creates new receptions with a replay-source reference, rather
than deduplicating by RF payload. Rebuilding an index from stored envelopes uses
the stored IDs. File content hashes check integrity; they are not reception IDs.

The manager alone cannot reconstruct event-time RF truth. Each adapter must hand
off an immutable input binding generation captured before the associated input
can be retuned/reassigned. Delayed stdout, buffered native output and asynchronous
WAV resolution retain that generation. For a producer without such association,
frequency remains null even if current configuration looks plausible. Known source
alone is allowed; multi-channel configured frequency lists do not select one channel.
No ACARS fallback frequency, VDL2 zero or protocol carrier constant is promoted.

Keep producedAt = parser emission timestamp and receivedAt = ingress clock. Optional
Activity `sampleContext` is separate from the strict DecodeEnvelope v1 and contains
sourceId, streamId, epochId, bindingGeneration, integer decimal-string firstSample
and endSampleExclusive, sampleRateHz, gap/settle qualification and clock basis.
Ranges cannot cross a stream/epoch/rate change. UTC sample-time estimates require
an explicit anchor plus uncertainty; otherwise only sample-relative duration is
known. No ordering requirement between the three clocks; commitSeq orders replay.

## Small public record vocabulary

Promote the existing envelope to one canonical shared declaration at the public
checkpoint; core validators import that declaration. Do not maintain two schemas
with independent evolution. Its v1 wire validator remains strict. A new outer
`ActivityRecord` v1 carries these fields (all timestamps canonical UTC):

```
version, eventId, commitSeq (decimal string), producedAt, receivedAt,
kind, subjectRef?, revision?, supersedesEventId?, sampleContext?, payload
```

`kind` is a closed discriminated union: `decoder-reception`, `call-lifecycle`,
`analog-transmission`, `scanner-result`, `recording-change`, `ingestion-gap`.
Decoder-backed payloads embed the existing envelope with the identical eventId;
outer clocks must match. Other payload schemas have their own bounded typed fields,
not arbitrary event names/handlers. Limit each complete Activity record to 144 KiB
so the valid 128 KiB envelope plus bounded metadata fits. Detail GET returns that
record; list/replay summaries are at most 4 KiB and link to detail.

Adapters classify known output types using fixtures, not decoder-name guesses.
Decoded reception is a parsed message, not scanner confidence. `sync`, rates,
stats and replaceable health remain telemetry by default; unknown output types
stay available on the legacy path with exclusion metrics until an adapter is
reviewed. Call start/end are lifecycle; late file resolution produces a distinct
recording relationship revision and never counts another call. Analog squelch
transmission boundaries differ from detector tracks and have their own producer
ID, start/end reason and observed sample coverage. Encryption is an explicit
no-playable-audio fact, not proof of absence of a transmission.

Scanner owns `(jobId, targetId, attemptId, revision)`, where targetId is allocated
once on target creation, attemptId changes only for a new attempt, and revision
increases for an authoritative correction. Existing array position is not an ID.
Terminal adapter publication occurs only after the scanner's durable domain
transition. It records an outbox intent with eventId in the same scanner recovery
transaction, then offers the immutable result to Activity. Retry uses that intent;
Activity deduplicates the owner key as well as eventId. Progress is never an input.
If no durable atomic intent seam exists, this adapter remains disabled until the
scanner owner supplies one; reading journals externally is not a substitute.
Failure to persist the intent reports history unavailable, without changing the
scanner's observed evidence. Bounded outbox exhaustion stops new history-producing
attempt admission, not IQ reception. Interrupted recovery uses an interrupted
outcome, never synthesizes a confirmed result. Old revisions remain inspectable;
current-result views choose the greatest committed revision per attempt.

## Storage decision and deployment gate

Provisionally choose one local SQLite database for Activity plus catalog metadata and their
atomic relationships, with media as ordinary files. Do not move scanner journals,
access sessions or operator presets into it. JSONL would require scanning roughly
250 MiB for 100,000 average 2.5 KiB rows per query and a second crash-consistent
index; whole-file JSON rewrites the same volume per mutation. A remote database
adds another service and network failure mode to a single-process local receiver.
SQLite provides local transactions and indexed keyset/FTS queries without a server.
These are design estimates, not measured throughput results.

Provisional binding choice (unaccepted until runtime/feature/benchmark qualification): `node:sqlite` in dedicated worker threads, **only after an explicit
minimum-runtime gate of Node22.13+ for the enabled feature**, with an exact tested
Node22 patch floor recorded by implementation. Node20 legacy decoding must remain
usable when this optional feature is disabled; dynamic worker loading must not
import the module during legacy startup. Enabling it on an unsupported runtime
fails validation with a capability error before any state write. Main must approve
and document this feature-specific floor before allocation; no silent global
runtime upgrade. If Node20 feature support becomes mandatory, reopen this decision
and qualify a pinned native binding and AMD64/ARM64 packaging rather than silently
shelling out to sqlite3. The [Node22 SQLite API](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html)
documents the synchronous API and experimental status at that floor.

Use one writer and at most one reader worker; SQLite never runs synchronously on
the IQ/event-loop thread. WAL, foreign keys, FULL synchronous durability, explicit
short transactions, `busy_timeout` bounded to 100 ms. Verify FTS5 availability at
startup. No extension loading. A local single-writer lock rejects a second process;
network filesystems are unsupported for this storage profile. State dir contains
DB/WAL/SHM together, restrictive permissions, outside the web root.
[SQLite WAL](https://www.sqlite.org/wal.html) requires deliberate checkpoint handling;
long-lived SQL read transactions are forbidden across HTTP pages or WS sessions.

Initial bounded workload: 100 admitted events/s average, 500/s for two seconds,
2.5 KiB average normalized event, maximum 144 KiB, eight API clients, one active
export, four writers, eight open playback/download streams. At 100/s, unindexed
payload alone is about 20.6 GiB/day; a seven-day all-event promise is untenable.
Default Activity limit is 1,000,000 rows, a shared 2 GiB allocated DB cap and seven days,
whichever limit is reached first. At an assumed 4 KiB total/row the byte cap covers
about 524,000 events or 87 minutes at 100/s. Measure actual payload/FTS/index overhead
before selecting production defaults; expose observed horizon, never “seven days
retained” merely because maxAge is seven days. The87-minute estimate is an upper
bound before catalog occupancy. Reserve256 MiB of that DB cap for catalog and
operation metadata; Activity stops/evicts earlier to preserve it. Catalog maximum
100,000 live/tombstoned media rows,100,000 active owner receipts and100,000 pending
operations; caps apply by bytes too. At metadata exhaustion reject new catalog
writes; never evict Keep/lease/intent records to admit more media. Bound strings,
links (max256/object) and aliases (max16/object); overflow is explicit.
Maximum-size events hit byte/rate
budgets first. Media defaults remain producer settings until coordinated migration.

Bound WAL to 64 MiB operationally: checkpoint between bounded batches at 16 MiB;
at 48 MiB deny new readers and drain/cancel the single reader; at 64 MiB pause writes
and report unavailable until checkpoint succeeds. Reserve at least 128 MiB beyond
the metadata allocation for WAL/recovery, plus migration space. Database cap uses
page allocation, not SUM(payloadBytes); deleted pages can be reused. Incremental
vacuum is bounded maintenance, never a full blocking VACUUM on a receiving host.

Tables (schema version distinct from DTO version):

- `store_meta`: store UUID, restore generation, next sequence, schema version,
  conservative prune watermark, clean-shutdown marker, capability state.
- `activity`: immutable ID, unique integer commitSeq, kind, clocks, source/decoder,
  protocol/category/frequency, canonical payload, payload digest, bounded search text.
- `activity_refs`: typed IDs; indexes on `(refKind, refId, commitSeq)`. No cross-store
  cascading foreign keys into scanner or operator data.
- `owner_events`: unique `(ownerKind, ownerId, attemptId, revision)` to eventId.
- `recordings`, `recording_aliases`, `recording_links`, `recording_mutations`,
  `file_operations`: catalog, compatibility mappings, immutable links, CAS state,
  durable file intents. A bounded changes sequence supports catalog refresh.
- `activity_fts`: external-content FTS5 for immutable Activity search text, updated
  and deleted in the same transaction. Rebuild is an explicit bounded maintenance
  operation. [FTS5 external-content consistency](https://www.sqlite.org/fts5.html)
  is the application's responsibility.

Indexes: primary eventId, unique commitSeq; `(kind, commitSeq)`, `(sourceId,
commitSeq)`, `(protocol, commitSeq)`, `(category, commitSeq)`, `(frequencyHz,
commitSeq)`, `(producedAt, commitSeq)` and refs above. Do not create arbitrary JSON indexes. Validate query
plans on maximum fixtures. Schema changes adding indexes carry a space/time budget.

## Admission and failure contract

Ingress queue is bounded by both 1,024 items and 8 MiB, inclusive; control/result
handoffs have a separate 128-item/2 MiB reservation. Total includes queued and
in-flight buffers. Limit durable decoder admissions with token buckets of 100/s,
burst1,000 globally and 50/s burst200 per instance (configurable only within tested
caps). A rate limit never coalesces two receptions into one. Worker batches at most
64 items/512 KiB or 25 ms of collected work, then yields; final batch transaction
latency is measured separately. Producer-facing offer is synchronous bounded copy
plus accepted/rejected outcome, not an awaited disk operation on IQ input.

Only committed records reach the durable Activity feed. Queue acceptance is not a
durability acknowledgement. Async producers can await a durable receipt off the
IQ path. A native output lost before commit cannot be reconstructed after crash:
report a new session discontinuity at startup if prior shutdown was not clean.
Queue/rate/validation/disk losses increment bounded reason counters and emit one
aggregated ingestion-gap record when storage recovers, with count, interval and
known/unknown precision. Loss intervals cannot claim missing commit sequence IDs
because uncommitted records never had one. Excluded telemetry is separate from
loss. A storage failure leaves legacy decoding available with Activity degraded.

Reserve exhaustion or unknown statfs fails admission; no unbounded fallback journal
or growing in-memory retry list. Retry durable outbox intents with bounded owner
scheduling; no internal retry allocates another ID. Writer crash closes the new
feed; resume only after recovery under the same committed sequence authority.

### Retry horizon and receipt reclamation

Deduplication is a bounded admission contract, not an eternal event-ID registry.
There is no public arbitrary-event ingestion endpoint. Every internal offer carries
an ingress ticket `(admissionGeneration, epochId, eventId, canonicalDigest)` from
the narrow ingress authority; a durable producer persists that exact ticket and
canonical body in its outbox intent before publishing. Digest covers canonical
input bytes before commitSeq/storage decorations, so a retry can compare the same
body after receiving a sequence. Scanner owner keys are covered by the digest.

Before opening admission, the writer durably registers an epoch and its expiry;
only then may the manager issue tickets under that epoch. Rotate epochs at most
once per minute, each expiring16 minutes after creation. Thus ordinary first offers
have at least15 minutes of retry eligibility; the expiry is returned with receipt.
Epoch expiry uses server time with a persisted nondecreasing observed-time floor;
clock regression cannot reopen a closed epoch. Across restart, load the floor and
stored expiry before admission. A forward clock jump may expire tickets early and
must report `ADMISSION_EXPIRED`; no liveness guarantee under clock discontinuity.

`ingress_receipts` stores eventId, ticket identity, canonical digest and original
commitSeq atomically with each Activity append. Retain it until the epoch is
closed, independent of Activity row pruning. Equal retry returns the original
receipt even if its detail has expired; changed bytes returns conflict. A receipt
never promises the payload still exists. Bound receipts to1,000,000 rows/256 MiB,
inside the metadata reservation, and at most32 live epoch records. When those
bounds would be exceeded, reject new offers rather than silently expire receipts
or keep an unbounded cache. Metadata reservation includes catalog plus receipts;
its exhaustion can shorten the _admission_ window by denying new work, not erase
an already valid receipt. Actual row overhead remains a qualification measurement.

At expiry, commit epoch closure before reclaiming any receipts for it. Every offer
checks the live epoch registry before insertion, including offers with an absent
receipt. Unknown/closed/expired epoch returns `ADMISSION_EXPIRED` without allocating
another sequence. Deleted epoch rows therefore act as a deny fence, not permission
for unknown IDs. Epoch IDs are random and never intentionally reused. Issuer
restart creates a new epoch only after durable registration; it cannot reissue
an old output under that new epoch. This makes pruning safe without storing every
historical event ID forever. New independent outputs still get independent IDs.

Owner outbox protocol: commit intent with ticket → retry exact bytes until durable
receipt → persist acknowledgement/removal in the owner store. If the ack write
fails, retry within the same horizon. A retry after expiry is terminally rejected;
owner records an explicit history-delivery-expired outcome (and aggregated gap),
never retickets the same terminal revision. `owner_events` receipts share that
expiry; owner retains its terminal revision and delivery outcome in its normal
bounded domain state. Exhaustion or unavailable ticket issuance reports history
unavailable, not a false durable result. Full-store restore changes
admissionGeneration before reopening; pre-restore tickets explicitly expire even
when their receipt was rolled back. A surviving scanner outbox is not automatically
replayed into a restored history. Reconciliation reports this discontinuity;
operator-requested historical import, if later designed, is a separate operation.

## Search and replay protocol

Proposed routes, not mounted: `GET /api/activity`, `GET /api/activity/:eventId`,
and versioned `activity` WS subscription with a cursor. Query filters are kind,
source, decoder, protocol, category, RF interval, producedAt interval, exact typed
refs and a plain-text query. Limit 16 filter terms, 256 UTF-8 query bytes, eight
quoted literal FTS tokens; no user FTS syntax, regex or unbounded prefix scan.
Index title, protocol, approved typed scalar fields and selected decoded message
text up to 8 KiB per event. Payload remains complete even when indexing is bounded;
return `searchCoverage: bounded-projection`. Raw JSON is detail-only.

Pages default100, max200 summaries and 512 KiB; details fetched independently.
Default sort is commitSeq descending; optional ascending uses a distinct cursor.
No relevance/time sort in v1. An indexed producedAt predicate is a filter, not
chronology authority. Queries have 250 ms worker deadline, global four queued/one
executing reader admission ceiling and per-client one request; worker termination after
deadline cancels stuck read work and recreates only the reader. Repeated expensive
queries return 429, not progressively larger budgets. No total COUNT by default.

First page captures committed high-water `H` and retained lower barrier `L`
(the current conservative prune watermark) and returns snapshot token plus a
replay cursor at H. All subsequent pages require the same query hash and H, and
read `L < seq <= H` with last-key restriction. Snapshot tokens expire after five minutes;
they never pin SQLite transactions or prevent retention. Historical Activity is
immutable, including its search projection. Recording availability/Keep shown
beside an event is current catalog decoration, excluded from Activity membership.
`withAudio` initially means an immutable event has a recording link, not current
file availability. A late link is a recording-change event; clients may refresh
the snapshot. Search of mutable notes/transcripts belongs to a separate catalog
search snapshot, not a retroactive mutation of Activity FTS.

Replay catch-up scans ascending `(C, H]` in bounded pages, then follows commits
greater than H. It reads committed DB rows, using notifications only as wakeups;
notification loss cannot lose data. Each response/frame carries `scannedThrough`,
even if zero matches. Progress advances only after every record through that
sequence has been examined under the filter. WS subscribes before reading its
initial H, and re-reads committed max after drain to close the wakeup race. Clients
apply records by eventId (and domain revision where relevant) before storing the
cursor. Network loss can replay a prefix; duplicate application must be harmless.

Cursor is an opaque authenticated token over `{v, storeUUID, restoreGeneration,
queryVersion, queryHash, order, L?, H?, lastSeq, pruneGeneration, expiresAt}`. Persist
the cursor-signing key with the store, never expose it. Validate all fields and
numeric range; sequence on the wire is decimal string to avoid JS precision loss.
Cursor is continuation state, not authorization. Changed filters require a new
snapshot; auth is checked on every request/subscription independently.

Retention deletes only via transactions which atomically advance a conservative
prune watermark to the greatest deleted sequence. A cursor behind that watermark
gets 410 `ACTIVITY_CURSOR_GAP` even if a deleted row would not match its filter.
A snapshot resets if the watermark advances beyond its captured L; a fresh
snapshot starts at the new L, so historical pruning cannot cause an endless reset.
This is conservative: surviving records below L are detail-addressable but not in
new list snapshots. Byte/age pruning should therefore delete sequence prefixes
where possible. No paged result silently shrinks. Normal restart does not change store UUID/generation; restore,
repair losing records or an incompatible schema increments restore generation.
Expired/changed-query tokens get explicit reset errors, not an empty success.

WS maintains at most 256 messages/1 MiB per client within the existing broadcaster
limits, with at most two Activity subscriptions/client and eight global. Summaries
are batched; overflow closes with resumable reason and last delivered cursor if
possible. No per-client durable buffers. Existing telemetry channels keep their
replaceable semantics. Catch-up TTL is five minutes; longer pauses use new snapshot.

## Catalog identity, state and compatibility

`recordingId` is UUID allocated by the catalog before managed capture creation, or
once on verified legacy import. It names original media, not the current trim or
download artifact. DTO includes version, revision, mediaKind (`audio`/`iq`),
producerKind, qualified producer reference, state, format, bytes, sampleCount,
sampleRate, channel count, sample/production clocks, RF qualification, coverage,
immutable links, name/note/trim, keep and protection reasons, and capabilities.
Paths, native command lines and access secrets never appear in this DTO.

States: `reserved → writing → finalizing → ready`; failures lead to `incomplete`,
`missing` or `quarantined`; `ready → deleting → deleted`. Metadata CAS revision
increments on every mutation. Catalog revision does not revise decoded evidence.
Incomplete files may be inspected as metadata; playable recovery requires explicit
validation and a distinct recovered-ready outcome with truncated coverage.

Alias mapping is unique by `(producer namespace, producer store generation, native
ID)`; scanner IDs remain accepted on existing routes after resolving through their
owner, with links to canonical recordingId. Map `cap_*` separately from scanner
audio `d_*~filename`, since kinds and formats differ. File rename never changes ID.
Legacy filename collisions across analog/digital roots are reported as ambiguous,
not silently chosen. Do not steal/rewrite historical scanner IDs. Native call links
require verified producer manifest/close association; heuristic filename matching
may be retained as `association: inferred`, never upgraded to exact provenance.
Multiple files/slots may link one call, and a file may cover multiple observations.
An event without audio has no manufactured recording.

No media deletion cascades from Activity pruning. Catalog may retain compact source
provenance after linked events expire. Discovery deletion does not unkeep media;
effective discovery protection must be durably transferred or its deletion rejected
until the protected links have an explicit disposition. Saved-preset links are
optional `(storeId, presetId)` UUID pairs and confer no protection. Rename/edit
preserves identity; delete gives404, reprovision changes store lineage; no name or
frequency fallback. Operator-data v1 stores no reciprocal Activity payload/link.

## File publication and restart reconciliation

No filesystem/SQLite distributed transaction is claimed. Use recoverable intents:

1. Reserve bytes and ID transactionally, store root-relative staging/final locations
   and producer generation in file_operations before opening a managed file.
2. Producer writes a unique staging file; catalog tracks a producer lease. Native
   producers need an adapter close/rename acknowledgement. mtime stability or a
   call-end event alone cannot prove closure; when unavailable, import only after
   that producer process has exited and all its handles are closed.
3. Validate file format, lengths, finite duration and coverage; fsync file. Publish
   by no-clobber rename/link within the managed filesystem, sync parent directory.
   Cross-filesystem import copies to local staging, validates and syncs, publishes,
   then acknowledges source disposition. Do not remove source before commit.
4. Commit ready metadata, alias, links and catalog-change event in one DB transaction.
   Only then expose playable capability and release producer/space reservations.

Restart reconciles intents before reopening writes: staging-only files become
incomplete; a published validated file with unfinished intent completes the same ID;
ready row with absent file becomes missing, never reassigns a replacement's bytes.
Size/hash mismatch quarantines; unknown files are counted and quarantined without
automatic deletion. Interrupted cross-device imports dedupe by intent ID and
verified source identity. Scan roots incrementally (max1,000 entries/pass and bounded
memory) using a persisted continuation; serving ready verified files may continue,
but retention stays suspended until protection ownership is reconciled. Never
follow symlinks out of managed roots or accept a client path. Revalidate file identity
on open; opened descriptors, not path re-resolution, back each stream lease.

Delete transaction marks `deleting`, bumps revision and records intent only if
unprotected and unleased. Rename to catalog-owned trash, sync directory, then mark
deleted; unlink trash as resumable cleanup. Crash at each step is reconcilable by
intent and file identity. Stable IDs return a tombstone/410 while retained. Compact
tombstones persist 30 days (bounded by metadata quota); after expiry return404 and
never reuse the ID. No undo guarantee after irreversible deletion; clients must
not promise the mock design's Undo until a trash grace contract is implemented.

## Keep and all deletion owners

Effective protection is `recording.keep OR any linked discovery.keep OR active
producer/read/export lease`. Discovery Keep and per-recording Keep are independent
durable reasons. Discovery unkeep does not clear recording Keep. Unkeep applies
normal age/size eligibility immediately, using original finalization time; it
does not restart the retention clock or promise another seven days.

The catalog coordinator serializes protection updates and deletion intents. Every
media deleter must join; the exact audited gate inventory is below. Unmanaged
external files remain outside this guarantee and are labelled accordingly.
Do not enable per-recording Keep until the exhaustive adapter audit is complete.

Audited deletion/invalidation gates (candidate paths under `src/core/scanner/`
unless specified):

- `src/decoders/builtin/call-recordings.ts:pruneCallRecordings`: final and TEMP
  native WAVs, root and uppercase WAV subdirectory. Legacy association also checks
  lowercase wav; reconcile this difference on case-sensitive filesystems. Scanner
  probes already disable this pruner; do not reenable it alongside scanner cleanup.
- `store/evidence-store.ts:linkProbeRecordings`: TEMP/unmatched/encrypted/low-space
  drops and unconditional residual probe-directory cleanup. Before adoption,
  these are producer-owned uncommitted bytes; once catalog-reserved, cleanup must
  close/fail the corresponding intent and cannot remove leased/protected media.
- `EvidenceStore.removeOrphanProbeDirs`, `retention`, `removeDiscovery`: startup
  cleanup, category/age eviction and directory deletion. Accepted S1 already fences
  per-ID removal and drains accepted serialized PSD/IQ writes and recording moves.
  Preserve this implementation and extend the same accepted-operation boundary to
  new analog commit/abort work; do not recreate a separate discovery tombstone store.
- `scanner-service.ts:deleteDiscovery` and automatic prune dispatch: current
  explicit route synchronously removes DiscoveryStore authority and invalidates
  live/recent producer references, then awaits EvidenceStore.removeDiscovery.
  Downloads and late linking require existing discovery authority; accepted work
  drains before DELETE success, and filesystem failure rejects it. F3 therefore
  resolves the old resurrection/drain gap. Explicit deletion still needs the future
  coordinated Keep/file-lease admission before managed catalog protection ships.
- `store/discovery-store.ts`: explicit removal, inactive-age/capacity eviction,
  merge removal and observation trimming. These are domain metadata operations,
  not permission to cascade media deletion. Merges preserve original aliases and
  transfer all protection links to surviving discovery identity transactionally
  through the conservative handshake; do not rewrite old recording IDs.
- `evidence/capture-store.ts`: startup temporary/orphan cleanup, `discard`, `delete`
  and `retention`; plus `capture-recorder.ts` abort/gap/write-failure/empty/
  required-decode failure disposal. Existing capture cap has no discovery Keep
  predicate. IQ payload, fixture manifest and scanner sidecar form one catalog
  artifact set; protection/deletion covers all, never leaves a playable partial set.
- Planned S2 Task42 WAV abort unlink and finalization failure cleanup must close
  producer intents; future S3 teardown must drain/fence writes before reporting
  recording settlement. Catalog trash/reconciliation/export cleaners join too.
- `store/persistence.ts` journal retention, torn-tail repair, corrupt-file relocation
  and atomic-write temp cleanup remain scanner recovery ownership. Recording Keep
  does **not** retain every journal/observation forever; these operations cannot
  erase the catalog's compact provenance/protection records. No public journal API.

Current scanner Keep only protects discovery and ordinary evidence from automatic
retention, not captures, native global WAVs, observation history or journal history.
This spec's stronger coordinated protection is a future integration gate. Scanner
free-space errors currently fail open; managed writes must fail closed after its
owner reviews the behavior change. Existing512 MiB recordings/64 MiB evidence/
256 MiB captures/64 MiB journal budgets and2 GiB minimum free space are inputs to
capacity reconciliation, not replaced by catalog defaults without migration.

Discovery Keep remains scanner-owned. Its adapter must durably establish catalog
protection before acknowledging keep; removal of protection occurs only after
scanner unkeep commits. During a failed two-store operation, conservatively retain
protection and retry with an operation ID. New links inherit the scanner's current
durable Keep under the same serialization barrier. Recovery starts with deletion
disabled, reconciles scanner protection generations, then enables retention.
This intentionally prefers excess retention to loss; it does not merge the stores.
The authoritative API returns pending/unavailable rather than falsely acknowledging
that both stores committed. Direct legacy scanner delete routes must delegate too.

Protection handshake fencing is mandatory, not supplied by current scanner
`setOperator`. Add scanner-owned durable monotonic `protectionGeneration` and
`pendingProtectionOperation {id,generation,desiredKeep,phase}` per discovery.
Allocate generation and persist intent before contacting catalog. Catalog stores
last applied generation and pending effective protection for that discovery.
Every step/retry is conditional on matching current pending operation and
expected generation; a lower generation is a no-op/stale conflict, never a write.
Operations are serialized per discovery: reject new conflicting Keep/unkeep,
merge or delete with409 `PROTECTION_PENDING` until the earlier operation resolves.
An uncertain response is recovered by reading that operation ID, not creating a
second operation. Persist the resulting generation even when keep=false.

Keep sequence: scanner intent → catalog protective pending reason → scanner
commits keep=true → catalog finalizes generation → scanner clears pending.
Unkeep sequence: scanner intent (catalog protection remains) → scanner commits
keep=false → catalog clears only the matching generation after rechecking scanner
commit → scanner clears pending. A stale unkeep can never clear a newer Keep;
block conflicting mutations while pending and still compare generation on every
retry as defense against delayed callbacks. New links inherit the union of
committed Keep and any pending protective reason; an unkeep cannot race a link
between generation checks. Link admission and protection mutation share the
per-discovery barrier. Restart replays persisted phases before enabling deletion;
ambiguous state stays protected and exposes a pending status for recovery.

Merges acquire both discovery barriers in stable ID order, persist a generation-
qualified transfer intent, establish survivor protection before retiring the old
reason, and keep alias/protection tombstones until pending operations settle.
Deletion uses the same barrier and requires no pending operation and no committed
protection. Scanner reprovision/restore changes its protection authority generation;
catalog conservatively retains previous reasons until an explicit reconciliation
resolves them. Never interpret an absent restored discovery as authorization to
clear its protection. Generation overflow fails closed. Do not create a second
public Keep setting in catalog for discovery ownership.

Keep uses expected revision/If-Match; stale updates get409/412. A delete already
marked deleting wins and Keep fails with410/conflict; a committed Keep wins and
deletion fails. Explicit delete of kept media returns409 with protection reasons;
operator must first clear each durable Keep through its owner's separate action.
Leases cannot be bypassed by “force”. Bounded lease expiry cancels stuck operations
and closes their descriptors before deletion becomes eligible.

## Space accounting and recording cessation

One capacity coordinator accounts reservations and available bytes per filesystem,
including scanner roots and native temporary files; do not subtract the same free
space separately for every directory. Metadata and media caps are distinct. Native
8 kHz mono PCM16 costs 16,000 B/s (~0.92 MiB/min); 48 kHz mono PCM16 costs96,000 B/s
(~5.49 MiB/min). CU8 at2.4 Msps costs4.8 MB/s (~274.7 MiB/min), so512 MiB stores
only~112 seconds of such IQ. These format calculations do not assert the producer
always writes those formats; inspect each finalized header/sidecar.

Default minimum reserve: max(configured producer minFreeDisk, 1 GiB) per filesystem,
plus outstanding maximum-write reservations and128 MiB metadata headroom. Reserve
per admitted media write its hard byte cap, including header/sidecar overhead.
Initial ceilings: four concurrent recordings, audio10 minutes/64 MiB, IQ30 seconds/
256 MiB, one export256 MiB. Reject work whose worst-case cap cannot fit; split long
recordings only through a declared producer segment contract, not fabricated calls.
Recheck free disk at bounded write chunks (at most1 MiB) and at admission. Native
writers that cannot obey reservations/cessation remain unenabled for managed auto
recording until producer integration is proven. Do not kill decoding to stop writes:
need a verified recording-disable/close mechanism or a gated isolated recorder.

Below reserve, stop new recordings/exports immediately, request active writers to
finalize at their next bounded chunk, and mark incomplete on write failure. Never
evict kept files or uncloseable native writers to pretend the reserve holds. statfs
failure means unavailable capacity and cessation. External processes can consume
space despite reservations; reserve is a safety policy, not a filesystem guarantee.
Resume requires reconciliation and free bytes above reserve plus10% hysteresis,
not an unbounded retry loop. No automatic age shortening policy in v1; normal
size-cap eviction selects oldest finalized unprotected media and reports reason.

Storage status reports unique managed bytes, recording-kept, discovery-protected,
union-protected (no overlap double count), eligible automatic, manual, IQ, active,
temporary/export/trash, unknown, DB/WAL allocated, free, reserved and measurement
time per filesystem. Describe unavailable/stale counts. Report configured age/cap,
oldest available unprotected recording and last eviction/write-stop reason. Hard
links are either prohibited for ingestion or accounted by device/inode once.

## Delivery, trimming and future jobs

Proposed catalog routes: list/detail by ID, CAS metadata patch, deliberate delete,
`/media` for validated originals, `/playback` for the current trim and `/exports`
for generated artifacts. Protected runtime supplies trusted origin/session/CSRF
decisions and revocable admission leases. Authenticate before DB detail disclosure,
file open, job allocation or headers; recheck after every asynchronous acquisition.
Acquire a catalog file lease atomically against delete, then open verified bytes;
on auth revocation/disconnect/deadline close streams, cancel jobs, release file and
space leases. Do not make reusable credentials part of stable recording links.

Initial playback supports validated PCM WAV with known chunk layout; byte Range
on originals is single-range only with correct206/416, Content-Length and immutable
ETag. A trim virtual WAV uses regenerated header and sample-aligned data range;
its ETag includes recording ID, content digest and trim revision. Seek is enabled
only after client contract tests prove header/range behavior. Unknown codecs, IQ
and incomplete WAVs do not get an audio seek capability. Eight streams total,
two/client, idle timeout30s, lifetime30min; export one/global, queue two, deadline
two minutes. Bound media bytes by the admitted artifact size, and bandwidth by a
configured shared byte budget with slow-client cancellation, independent of live
audio buffers. Revocation must work on all route/origin variants.

Name max256 UTF-8 bytes, note4 KiB, trim integer sample range `[in,out)` within
validated original sampleCount. Empty/reversed/out-of-range edits fail. Revision
CAS prevents one client's stale trim/Keep from overwriting another; no silent
merge. Original bytes/digest never change. Every playback/export pins a metadata
revision for its whole operation; a later edit affects subsequent operations only.

WAV export is bounded header regeneration and copy, no shell. Opus is later codec
qualification with explicit encoder availability, cancellation and CPU limits.
IQ SigMF export requires trustworthy sample format/rate/frequency/gap metadata
and a tested schema adapter; the current fixture sidecar is not claimed as SigMF.
IQ playback reuses recording source pacing only after source capability and tuner
arbitration review; it must restore live ownership without presenting replay as RF.

Transcription later: finalized eligible audio, one worker, two queued jobs, input
duration/byte/language/model bounds, same lease/reservation system, no encrypted
audio inference. Job IDs and revisioned results separate from recording identity.
Index current transcript/name/note in catalog search with a catalog snapshot version;
mutation invalidates that search token and requests refresh (no full MVCC history
in v1). Append a recording-change Activity event referencing the result revision;
do not mutate old Activity search membership. Model/service selection and privacy
policy are a separate allocation, not an implicit external upload authorization.

## Exact producer integration gates

S2 Task42 (after Tasks17/35/40/41) plans analog FM from a48 kHz cf32 tap to8 kHz
PCM16 mono, maximum120 seconds (~1.83 MiB). Its planned writer opens the final
path, and draft writes do not verify returned byte counts. Before catalog
integration, the scanner owner must supply partial-write loops, staging publication,
producer generation/transmission identity, close/abort receipts, sample gaps and
retune/end reasons, bounded reservations and recording cessation. These are design
amendments for that owner, not assertions about S1 code or authorizations to edit it.
Existing producer caps remain stricter than catalog ceilings.

S3 Tasks44–46 (after CHECKPOINT S2) plan up to16 channels,300 ms routing decisions
and an8 kHz per-job stream. Listen's one-channel monitor explicitly records nothing.
Freeze which discovery jobs own recordings, how selected audio relates to the
transmission IDs, and how preemption/cancel/source loss drains pending work. Expose
separate `jobTerminal` and `recordingsSettled` facts when necessary; a job end time
must not promise asynchronous WAV linking completed. All-call recording coverage
remains unsupported until every intended producer path has acceptance evidence.

Native global DSD and scanner probe DSD need distinct adapters: probes already
close decoders before linking, global DSD may still be running after call-end.
Preserve late WAV updates and qualify heuristic links; map GROUP/PRIVATE/UNIT,
slot/file multiplicity and TEMP outcomes with real sanitized native fixtures.
No planned120-second analog cap or8 kHz live UDP rate proves native WAV duration
or format. Header inspection, actual close evidence and all native cleanup paths
are required before playback/Keep is enabled for that producer.

### Task42 producer receipts and alias handoff

The scanner owns producer identity and recovery. Allocate a unique producer
recording ID and operation ID before reservation/staged write; qualify them by
producer run UUID. A producerStoreId is nullable when no scanner-owned stable
lineage exists; do not create a separate persistent identity store solely for the
catalog. Preserve operation/run identity in scanner-owned recovery metadata when
available; never derive lineage from a filesystem path. Frozen binding includes
an engine-instance UUID because numeric stream/epoch can restart. Do not require
mounting the catalog to record in S2.
When catalog integration is allocated, map this producer identity once to a catalog
UUID and retain the scanner `discoveryId~filename` identifier as a namespaced alias.
The catalog receipt/ticket epoch is for a later Activity handoff, not a replacement
for scanner journaling or a new scanner public API.

Required immutable producer receipt, finalized, aborted or failed: operation/producer IDs,
legacy alias when published, discovery/observation references, frozen source/stream/
epoch/channel binding generation, tuning trust and qualified channel frequency,
realised media format/rate/channels, bytes/sample count, gaps, cut/end reason and
closure outcome. Gap/cut/error values use closed typed enums; retain at most64 gap
entries and an omittedCount. sampleCount is verified written frames (safe integer),
bytes is verified entire file including its actual header;44 bytes is valid only
for the fixed writer layout, never assumed for imported WAVs. Unknown facts are nullable. Internal root-relative artifact
references are never public paths. A completion promise settles all close, publish,
metadata or abort cleanup and reservation release exactly once; repeating operation
completion is idempotent. F3 admission is checked inside its serialized publication
boundary; deletion drains accepted commit/abort before acknowledging. If publication
fails after rename, retain an explicit recovery intent rather than returning ready
or silently losing ownership. Finalized requires verified close/header/count,
rename and metadata acknowledgement. Distinguish journal append acknowledgement
from fsync durability; existing scanner journals do not establish the latter.
Metadata failure conditionally rolls back only this operation's link/alias and
cleans its artifact; failed cleanup retains a scanner-owned intent and accounts
residual bytes until settlement. Releasing an active reservation cannot erase
physical residue from totals. Track accepted operations separately from serialized
publication so delete can cancel/drain without awaiting itself or blocking abort
behind a queue it holds. These constraints are agreed for design; exact receipt
types and transitions still require Task42 owner review. This is a producer contract,
not a claim of file/DB atomicity. Keep stricter Task42 120-second limits. Later Tasks44–46 must include
these operations in preemption/source-failure/cancel drains, independently of REST
terminal visibility and monitor audio selection.

## Storage qualification: disposable harness allocation

The disposable harness and bounded guard/micro tests below are allocated. Independent
review of the exact harness must precede broader experiments. Sustained, burst, runtime
matrix and combined-scanner experiments require a separate resource window; no such
results are claimed here. SQLite and the feature runtime floor remain unaccepted until
measured. This allocation must not add production stores, listeners, DTO exports, catalog writes,
recording/audio mounts, Keep behavior or a second recovery authority.

Exclusively owned new paths for the bounded disposable harness:

- `scripts/qualification/activity-storage/run.mjs`: explicit CLI experiment driver,
  bounds/preflight and machine-readable report; no import from application startup.
- `scripts/qualification/activity-storage/worker.mjs`: isolated SQLite experiment,
  synthetic tables/FTS/receipts and bounded writer/reader load; disposable only.
- `scripts/qualification/activity-storage/workloads.mjs`: seeded sanitized synthetic
  envelopes, queries and fault schedules; no private RF payloads or copied journals.
- `tests/unit/qualification/activity-storage.test.ts`: harness guardrails, deadlines,
  cleanup and report accounting; not production persistence acceptance tests.
- These existing three spec files: record measured decision and revise estimates.

No package/lockfile, Dockerfile, build script, config, API-types, scanner or runtime
path is allocated by this batch. Use direct Node .mjs workers so a harness
can qualify behavior before requesting production worker build integration. Raw
reports/temp DBs stay in a uniquely named ignored `output/qualification/` directory;
only sanitized methodology/results may later enter this spec. The future production
implementation path proposal remains `src/core/activity/storage/` and targeted
`tests/unit/core/activity/storage/`; those are **not** part of qualification.

Runtime matrix, each executable explicitly provided and version captured:

1. Node20 (exact installed patch recorded): with feature disabled, harness startup
   must never load node:sqlite, spawn a worker or create state; enabling returns
   unsupported before state write. This proves the qualification guard only;
   production disabled-path verification is repeated when mounting is allocated.
2. Node22.13.0 minimum candidate: module/FTS5/API/worker/crash tests. If unavailable
   or failing, do not claim support; raise proposed floor to the earliest actually
   tested patch or leave qualification incomplete. No network runtime installation
   or global configuration change is implied by this plan.
3. Exact deployed Node22 patch (accepted S1 runner used22.23.3) and local dev25.2.1:
   repeat the same matrix, with sqlite_version/compile_options, architecture, OS,
   filesystem/mount and sync mode recorded. Experimental module warnings are recorded.
4. Linux AMD64 and ARM64 with existing authorized native runners; native macOS host
   is separate. No Docker image build/publish. Missing native architecture or exact
   runtime is an explicit outstanding gate, never covered by emulation or types.

Commands for the allocated harness: `node scripts/qualification/activity-storage/run.mjs
--scenario <name> --output <unique-dir> --seed 42` under each supplied Node binary;
`pnpm exec vitest run tests/unit/qualification/activity-storage.test.ts
--maxWorkers=1 --minWorkers=1`, then repository typecheck/lint. Driver validates a
closed scenario enum and hard caps, so arguments cannot request unlimited work.
One scenario at a time in a Main-coordinated quiet window, no background watchers
or concurrent full suite. Native runner availability/execution requires Main's
resource allocation. Bounded guard/micro tests precede that gate; they cannot qualify
sustained load, production mounts or unavailable runtime/architecture cells.

Current harness boundary: `disabled`, `runtime` and `micro` are executable. All
long scenario names require `--resource-window <attestation>` and still return
`not-run`; that argument does not grant authorization. Sustained workload execution,
paired baselines, query matrices and fault-pressure measurements need a reviewed
harness extension before their resource window. The streaming workload generator
and reference admission counter preserve the schedules below without running them
against storage. Only seed42 is currently accepted.

The microfixture uses ten synthetic2.5 KiB rows, transactional FTS/receipts,
rollback (including injected ENOSPC), prune-before-receipt-cleanup, closed-epoch
primitives and clean database reopen. It is not a production receipt protocol or
crash-recovery proof. Smaller fixture caps apply:32 queued rows/128 KiB,16 MiB DB,
4 MiB WAL and10-second deadline;1 MiB transaction headroom is checked before
writes. The192 MiB guard measures shared-process RSS, not isolated worker RSS.
Disabled/runtime-guard unit cases simulate version strings; they do not qualify an
unavailable Node executable. Node25.2.1 guard/micro tests passed20 cases, including
100 bounded admission-reference cases. SQLite emitted its experimental warning.
Termination confirmation has a100ms grace; failure raises fatal containment and
skips all artifact inspection/cleanup while a worker may still write. The CLI exits
its owned process; library callers must do likewise. Native/OS stalls can delay
timers and process exit, so the deadline is not a hard real-time guarantee.
Observed elapsed time includes report persistence and cleanup attempts and detected
overruns fail the result. `report.json` is explicitly preliminary (`completion: pending`),
with hashes saved before verified DB cleanup; the returned/CLI result carries
observed completion and finalization errors. Capture CLI stdout separately when
retaining the final result; a preliminary report alone never proves completion.
Disk-admission failure does not suppress safe identity-verified cleanup after join;
unsafe artifacts or failed report persistence preserve files with explicit errors.
Actual journal/synchronous pragmas are recorded before and after clean reopen.
No sustained latency, row-overhead, architecture or production-mount acceptance
is inferred from these tests. SQLite remains provisional.

Scenario set and acceptance (all numbers provisional until measured):

- **Runtime/disabled**: prove module guard and no filesystem side effects above;
  worker startup/exit/error/cancellation and FTS5 capability must be explicit.
- **Steady and burst**: separate15-minute scenarios,2.5 KiB average payload.
  Steady offers100/s distributed evenly across10 producer instances (10/s each).
  Burst scenario repeats58 seconds at80/s then2 seconds at500/s, evenly across
  the same10 instances (8/s then50/s each). Start buckets full; use deterministic
  evenly spaced offers. The burst spends800 global tokens, the58-second interval
  replenishes1,160, so the1,000-token bucket recovers and no rate rejection is
  expected. Mean burst-scenario load is94/s. A separate overload schedule offers
  sustained500/s and compares exact expected global/per-instance rate rejections
  against a reference bucket model; those rejects are not storage loss. Paired baseline uses
  identical scheduled input without storage; p99 added main-loop delay≤5ms,
  queue≤1,024/8 MiB plus reserved128/2 MiB, no unexpected admitted loss, durable
  receipt p99≤250ms. Record offered/admitted/rejected/committed counts separately.
  A maximum144 KiB payload case must hit byte/rate admission rather than grow RSS.
- **Concurrent queries**: eight simulated clients within four queued/one reader
  execution cap, one active request/client; indexed filter/FTS/empty-match/cursor
  cases on seeded100k and up-to500k rows. Include adversarial low-selectivity tokens.
  Successful page p95≤250ms, every deadline cancels within an additional100ms;
  failed queries are explicit, never reported as an empty successful page.
- **Retention and receipts**: advance controlled time through at least20 epoch
  transitions, prune Activity before retries, close epochs before receipt cleanup,
  inject failed owner ack and restore. Original receipt or explicit expiry only;
  no reappend. Explain actual table/index/FTS/receipt bytes per row and attained
  horizon under shared2 GiB cap/256 MiB metadata reservation, not seven-day marketing.
- **Crash and pressure**: child-process termination at transaction/receipt boundaries,
  worker death, blocked reader/checkpoint, busy DB, failed statfs and injected ENOSPC;
  no host disk filling. WAL thresholds16/48/64 MiB, recovery integrity, zero success
  before commit, no reopened expired epochs; SQLite failure never blocks input.
  Keep measured cancellation/WAL overshoot visible; hard64 MiB enforcement requires
  preflight transaction growth allowance, not merely checking size after commit.
- **Memory/disk**: total qualification worker RSS≤192 MiB and retained main-thread
  queue overhead≤32 MiB over paired baseline, measured after warmup and after drain.
  Peak report/artifact allocation≤4 GiB; preflight requires≥8 GiB free plus existing
  configured reserve. Stop on any reserve breach; do not run full VACUUM. Use task-
  owned disposable directories, never stateDir/scanner/access/media roots; remove
  only task DBs after summaries/hashes are saved. Each scenario has a20-minute hard
  wall deadline and process-tree cleanup; cancellation verifies no remaining worker.

First run is synthetic qualification, not sustained combined-scanner acceptance.
After runtime/storage microqualification passes, request a separate Main-coordinated
15-minute paired accepted-scanner recorded-IQ workload (no live receiver) with the
same offered events/queries and preserved native acceptance fixtures. Compare
scanner throughput/drops and event-loop/worker latency against its storage-off
baseline; require no new scanner drops attributable to storage and budgets above.
If that cannot run, storage qualification is provisional. Production power-loss,
media fsync semantics and native recording closure remain later integration tests.

Deliver exact runtime/source/workload versions, commands, seed, offered/admitted
counts, latency distributions, RSS/queue/DB/WAL/FTS/receipt bytes, fault outcomes,
raw-log locations and explicit unsupported matrix cells. Independent review decides
whether to accept SQLite, reduce stated defaults or reopen binding/storage choice.
A pass permits Main to allocate implementation; it does not itself enable anything.

## Long-scenario extension plan (implementation and execution gated)

The accepted microfixture remains the executable baseline. This extension plan
has passed independent design review. The first driver/admission/report-containment item is accepted. The second
worker/query/receipt/fault item is allocated for bounded fixtures; independent
exact review and real execution remain separately gated.
Do not change the current `not-run` responses until the implementation phase is
allocated and reviewed. Keep all changes within the seven paths listed above;
no production modules, dependency changes, scanner imports or generalized store.

### File changes and delivery order

| Owned file                 | Planned extension                                                                                                                                                | Bounded verification before any long run                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.mjs`                  | Closed scenario/phase plan, preflight allocation, scheduled admission, bounded IPC, writer/reader supervision, aggregate metrics and preliminary/final reporting | Virtual clock schedules; queue saturation; cancel/deadline at setup/load/drain/hash/report/cleanup; worker death and unconfirmed termination; low-space and replaced-path refusal |
| `worker.mjs`               | Explicit writer/reader roles; fixture schema/indexes/FTS, bounded transactions/queries, receipt epochs, crash barriers, WAL accounting and recovery              | Small actual SQLite fixtures with fixed failpoints; indexed query plans and result oracle; integrity/receipt checks after process-contained worker termination                    |
| `workloads.mjs`            | Streaming timed offers, independent integer-time admission oracle, deterministic query mix, fixed receipt/fault schedules and seed42 manifest                    | At least100 bounded generated schedules; exact totals, equality boundaries and reason partition; no stored list of all events                                                     |
| `activity-storage.test.ts` | Scaled fixtures, controllable clock/IPC and fault injection; retain all20 micro regressions                                                                      | One worker/test process at a time; short deadlines; no500k-row setup or15-minute run in the test suite                                                                            |
| Three spec files           | Methodology, actual sanitized results, remaining matrix gaps and task state                                                                                      | Preserve requirement/property numbers; no result marked measured before its execution report exists                                                                               |

Implement in one allocated work item at a time: driver/admission/report containment,
then worker/query/receipt/fault scenarios, then exact whole-extension review.
Each item retains small regression tests. These are dependency steps, not permission
to launch parallel implementations. Do not add a generic scenario plugin interface.
The independent design review precedes the first implementation item; exact code
review and required checks precede an execution-window request.

### First driver item: implemented boundary

The first item adds callable driver routines exercised by bounded virtual clocks
and fake acknowledgements: integer token admission, arithmetic stale-offer skipping,
warmup/reset, queue charges retained through acknowledgement, single-assignment query
outcomes, shared stage deadlines, reservation transfer, metadata-only live inventory,
streaming final hashes and residue reporting. The CLI still runs only the accepted
micro/runtime/disabled cases; every long scenario and phase returns `not-run` with
explicit prerequisites. No long scheduler is mounted and no performance result is
claimed. The65 bounded tests include the original20 micro regressions and four
properties with100 cases each; tests do not establish real runtime/platform support.

Warmup/load transition callbacks may arrive from the scheduled boundary through
20ms late inclusive; earlier or later observations fail. The new phase uses the
observed entry epoch, preserving the full900-second measured load. Lateness is
reported and consumes the unchanged1,200-second total budget; it adds no worker
budget. Warmup must already have drained by the scheduled30-second boundary;
asynchronous receipt/control callbacks supply their observed monotonic clock.
Query settlement requires an observed monotonic microsecond timestamp; expiration
at250,000 microseconds is established before accepting a reply, regardless of
timeout callback order. Query terminal accounting retains physical reader ownership
on timeout. A valid
terminal reply confirms settlement; otherwise a matching request/owner-token join
confirmation is required before reuse. Late replies and stale joins cannot change
terminals or release a newer owner; failed join forbids reuse. Batch `bytes` counts
the complete serialized `{id,bytes,rows}` envelope, including array separators and
the size field itself, within262,144 bytes. Data and the separate1 KiB control
reservation remain charged through settlement and release once.

Before the next worker item can execute storage, settle its narrow interface:
one writer batch ID with bounded rows/serialized bytes, exactly one terminal batch
acknowledgement (`committed`, `failed`, or `uncertain`) and a separately observed
receipt clock; baseline acknowledgements must have equivalent queue ownership.
Reader dispatch/cancel/join and bounded result bytes must agree with driver query
accounting before any query worker is connected. Every mutation needs an enforced
DB/WAL growth bound; an `enforced` flag in a virtual fixture is not evidence of an
actual bound. The second item implements this narrow interface for closed tiny fixtures only.
A separately accepted capped capture consumer and post-exit verification remain
required for real runs; the long CLI stays `not-run`.

### Second worker item: bounded fixture boundary

The candidate adds closed writer/reader actions, transactional seed receipts,
20 virtual one-minute epochs with sixteen-minute receipt expiry, prune/retry and
fixed termination barriers. Queries compare indexed/FTS membership with a separate
in-memory oracle across filtered empty pages, fixed high barriers, pruning,
reopening and a simulated generation reset. At most25 rows,16 page requests and
four examined sequence positions per page are used. A reader opens only after the
writer exits. This does not exercise pinned readers or concurrent WAL pressure.
The76 bounded tests retain all65 prior regressions. Exact review is pending.

Persistent fixture writes require Node25.2.1 and the exact SQLite3.50.4 source ID
recorded in `worker.mjs`; a memory-only probe rejects other combinations before
persistent DB creation. Node20 remains disabled before SQLite import/worker/state.
The required deployment floor Node22.13+, Linux AMD64/ARM64, and other exact runtime
patches remain unverified. Source matching is not platform acceptance.

Before opening, configuring or mutating the DB, admission reserves524,288 DB bytes,
597,048 WAL bytes and bootstrap journal/SHM space:1,223,744 bytes in total. Actual
PRAGMAs enforce4096-byte pages,128-page maximum, spilling disabled and FULL sync;
all schema/index/FTS/receipt/prune transactions use the same pre-BEGIN check.
Reopen validates the joined DB/WAL page domain before SQLite can recover it.
The bound follows the unique dirty-page commit path in SQLite's
[pager](https://github.com/sqlite/sqlite/blob/version-3.50.4/src/pager.c) and the
32-byte header,24-byte frame header and sector padding in its
[WAL implementation](https://github.com/sqlite/sqlite/blob/version-3.50.4/src/wal.c).
No custom VFS, extension, backup, VACUUM or arbitrary SQL is admitted. The bound
covers file lengths; filesystem allocation overhead and synchronous OS stalls are
not bounded by this proof. Free-space reserve and process containment remain necessary.
Post-commit inventory is evidence, never the enforcement mechanism.

This small128-page proof cannot support the planned2 GiB database/64 MiB WAL
scenario. Long scenarios remain denied before writes. SQLITE_BUSY, pinned-reader
checkpoint pressure, actual backup restoration, power loss, sustained throughput,
per-index byte attribution and runtime matrix qualification remain unqualified.
ENOSPC is injected before commit without filling disk; generation reset changes
fixture metadata rather than restoring backup bytes. Every receipt/fault test
joins the worker (with an outer process deadline) before reading or removing files.

External capture still needs a separately allocated capped consumer: one exclusive
ignored capture directory, a4 MiB aggregate reservation, stdout/stderr/manifest
caps of1/2/1 MiB, pipe backpressure and capped draining, process-exit confirmation,
then the separate60-second closure/size/hash/accounting reconciliation. No new
consumer path or real execution window is authorized by this item.

### Closed execution phases and containment

Each invocation runs one scenario and one phase (`baseline` or `storage`), with
fixed seed42, runtime executable selected by the operator outside the driver, and
an exclusive fresh output directory. No arbitrary executable, SQL, path or module
argument. A baseline and its storage pair are separate sequential invocations,
never both15-minute phases inside a20-minute deadline. Both must have the same
source/workload hashes, seed, scheduler, metrics settings and scenario duration.
A baseline exercises payload generation, admission, queue accounting and ack-shaped
messages with the database work disabled; label the omitted I/O explicitly.

The main driver owns at most one writer and one reader worker, with one fixed
control channel per worker. No descendants or detached processes. Bounded fixture
crashes terminate an owned worker at an explicit transaction barrier; they do not
claim whole-process/power-loss recovery. Reopen only after confirmed worker exit.
A query deadline terminates its reader when no safe SQL interruption is available;
join before replacement, cap replacements at32 per invocation and fail on excess.
Do not require a newer SQLite interrupt API than the runtime being qualified.

End-to-end budget is1,200 seconds from preflight through the cleanup attempt:
setup at most180s, warmup30s, load900s, drain15s, remaining75s for close, hashing,
report and cleanup. A stage consumes its budget or fails; it cannot borrow by
silently shortening the measured900s. A seed setup that cannot finish in180s is
an explicit setup-cap failure, not permission to keep running. Non-load fault
and receipt cases use at most60s including cleanup. One deadline covers replacements
and recovery too; per-stage timers do not reset it. Retain the100ms worker-join
grace and fatal-containment behavior from the microfixture. If a worker cannot be
joined, exit the owned CLI process without inspecting/deleting its files; preserve
path/phase/failure information on stderr for controlled later recovery. No claim
of absolute interruption while an OS/native call is stalled.

Driver signals stop admission, cancel readers, drain/abort acknowledged work, then
join all workers before file inspection. Failure of statfs must not suppress safe
cleanup. Stream artifact hashing in64 KiB blocks after join instead of reading a
multi-GiB database into memory; check the deadline between blocks. Save hashes in
the preliminary report before deleting verified task files. The saved report stays
`completion: pending`; the returned/CLI result includes final persistence/cleanup
elapsed, cleanup failures and detected deadline overruns. The execution operator
captures bounded stdout as final evidence; a preliminary report alone is incomplete.
No repeated rewriting can make a report include the duration of its own final write.
Preserve unsafe files and explicit residue inventory; never delete an arbitrary
output tree. All output/capture files count toward the artifact limit.

### Admission, offered load and queue measurements

Use integer microsecond scheduled times with a rational/integer token oracle, not
wall-clock floating-point drift. Full starting buckets: global100/s capacity1,000;
each of10 producers50/s capacity200. Offers evenly spaced in each second, round-robin
across producers. Reference admission uses scheduled time; actual scheduling records
lateness independently. A stalled driver must not regenerate an unbounded backlog:
process at most64 due offers per turn. At each turn, any offer more than20ms
late is skipped as a scheduler miss before admission; remaining due offers are
processed in scheduled order up to64, then yield. Unprocessed offers face the same
20ms rule next turn. This threshold is fixed and reported, not adjusted to make a
run pass. Aggregate skipped offers and fail workload fidelity rather than quietly
dropping or catching up forever.
Any missed scheduled offer invalidates latency/load acceptance for that run.

Warmup lasts30s: the first25s offer100/s across10 producers into a separate
warmup identity namespace using the same storage/baseline path; the last5s stop
input and drain. Failure to drain by30s fails setup. Retain warmup rows and report
their count separately; no unbudgeted purge at transition. At measured time zero,
reset both observed and reference buckets to full, all measured counters/histograms
to zero, and establish a fresh monotonic epoch. Observed token decisions and the
independent oracle both use the offer's scheduled microsecond offset; actual dispatch,
queue and receipt latency use monotonic wall time. This qualifies a controlled
scheduled-admission workload, not a production arrival-clock implementation.
Virtual-clock tests cover partial warmup, failed drain, reset, exact refill boundaries,
20ms/20ms-plus lateness and repeated64-item yields without unbounded catch-up.

For900s, steady offers90,000; burst offers84,600 (58s at80/s plus2s at500/s per minute,
94/s mean); overload offers450,000. With ideal scheduled timing the first two have
zero token rejects; overload admits90,999 and rejects359,001 globally (last offer
at899.998s, producers never exceed50/s). Test these totals without real-time waiting.
Reference results remain independent from observed admission. Do not equate expected
token rejection with storage loss or silently grant more tokens after stalls.

Admission order: validate payload, test per-producer/global tokens, test queue slots
and bytes, then consume tokens only for an admitted event. Record rate rejection
separately from byte/queue/storage/disk denial. The reference token-only schedule
is still reported if queue pressure changes actual token consumption. Normal load
must match reference admission; overload must match expected rate rejects absent
other pressure. Queue-pressure fault tests instead compare the full explicit
admission-decision trace against a bounded reference including releases.

At most1,024 data events/8 MiB of unacknowledged serialized bytes and128 control
items/2 MiB, including data transferred into worker IPC queues. Account each
message until ack/rejection, not just until `postMessage` returns. One in-flight
writer batch at a time, at most64 rows/256 KiB and20ms batch dwell; control cannot
bypass transaction serialization or become an unbounded ack backlog. Reject a
144 KiB payload only when actual row/queue budget is exhausted; it fits the designed
maximum and must not be unconditionally treated as oversized. Test oversize separately.

Record offered, invalid, rate-rejected, queue-denied, storage-denied, admitted,
committed, acknowledged, duplicate receipts, uncertain and scheduler-missed counts.
Every admitted ID ends in committed, explicit failed, or uncertain-at-crash; a lost
ack is not proof of lost commit. Receipt latency starts at admission and ends at
ack reception, including queueing and commit. Report all failure/timeout counts
beside percentiles so failures cannot improve apparent latency. Proposed acceptance
remains p99 receipt≤250ms and p99 added main-loop delay≤5ms against matched baseline.

### Fixture schema, search and receipts

Use synthetic immutable rows containing integer commit sequence, event UUID,
producer ID, ingress time, closed kind, frequency and bounded text/payload. Add
unique event identity, `(kind, sequence)`, `(producer, sequence)` and
`(frequency, sequence)` indexes plus external-content FTS5 with transactionally
maintained insert/delete triggers. Explain actual indexed plans for each closed
query; do not claim the production DTO/filter API is implemented. One SQLite writer,
one read-only reader; actual journal mode, synchronous, page size, busy timeout,
max page count and autocheckpoint settings captured at open and each reopen.

The query scenario seeds100k or500k rows as separate invocations. Generate rows
incrementally in64-row/256 KiB batches, checking physical/logical budgets between
transactions. At2.5 KiB/row,500k payload alone is1.19 GiB; indexes/FTS may exceed the
2 GiB database budget. Stop with capacity/setup-cap outcome and report attained row
count instead of reducing payload or raising caps. No500k support claim if seed
cannot fit. Measure100k before requesting500k. Exclude seeding from query latency
but include it in total CPU/time/disk budgets and preserve its metrics separately.

Eight simulated clients, at most one request each, one active reader query plus
four queued requests; excess receives explicit admission denial, no hidden queue.
Fixed mix rotates indexed frequency/kind/producer+keyset, FTS common/rare/empty,
and empty filtered scan pages. Page≤200 rows and1 MiB serialized, tokenized search
≤256 UTF-8 bytes/eight terms, no arbitrary SQL/FTS grammar. Use a deterministic
bounded expected-result oracle computed from fixture generation, with high-water
barrier and scanned-through handling checked across insert/prune/restart fixtures.
The query measurement is explicitly read-only after seed/warmup: no concurrent
writer traffic in this scenario. For900 measured seconds, each client offers one
request per second at offsets clientIndex\*125ms, producing7,200 scheduled requests.
Cycle eight classes by `(second + clientIndex) mod8`: frequency/keyset, kind/keyset,
producer/keyset, FTS-common, FTS-rare, FTS-empty, combined-filter/keyset and filtered
empty-page. Each class receives900 offers. Use fixed seed-derived parameters and
barrier; no next-page feedback changes the schedule. If the client's prior request
is still active or its reply retained, count `client-busy` denial at its next slot,
not a postponed offer. Driver misses use the same20ms rule. Every one of the7,200 planned request slots
has exactly one terminal category: `successful`, `scheduler-missed`, `client-busy`,
`queue-denied`, `queue-expired`, `active-timeout`, `query-failed`,
`cancelled-before-dispatch`, `cancelled-in-flight`, `interrupted-unknown`, or
`not-offered-after-stop`. The last category covers future scheduled slots after
abort, including setup failure before measured time zero. An issued request whose
completion cannot be confirmed on worker/process failure is `interrupted-unknown`,
never silently cancelled or successful. For deliberate cancellation, queued requests
become `cancelled-before-dispatch`; dispatched requests become `cancelled-in-flight`
after confirmed worker settlement, otherwise `interrupted-unknown`. A synchronous
single-assignment terminal transition makes later replies/cancel notifications
no-ops; the first established timeout or terminal result is not counted again.
Cancellation/timeout totals elsewhere are derived views of these categories, not
additional buckets. Reconcile the sum to7,200 (or the scaled planned total), including
not-offered slots, on every completed report. If fatal containment prevents a final
report, label the missing accounting incomplete; a preliminary report is not proof
of reconciliation. Warmup
uses the same schedule for25s then5s drain; reset measured counters/barrier at zero.
Small virtual schedules check totals, class balance, scheduler misses, cancellation,
timeout/reply races and pre-load/mid-load interruption against an independent oracle;
no slot is postponed or counted twice. A separate scaled fixture validates concurrent insertion/
pruning and cursor correctness; it is not a concurrent-write throughput benchmark.
Combined writer/query performance remains a subsequent explicitly specified gate.
Successful query p95≤250ms; deadline250ms plus≤100ms termination confirmation,
including time queued. Report queued expiry, active timeout, cancellation and
rejected requests separately. Slow-reader case withholds at most one reply/client;
response bytes stay charged until released and cannot retain a SQLite transaction.

Receipt fixture:20 virtual minute epochs, independent receipt/event tables,
16-minute admission-ticket expiry, immutable event IDs and unique producer revisions.
Schedules cover commit-before-ack failure, prune-before-retry, retry before/after
expiry, unknown epoch, epoch close/cleanup ordering and restore generation change.
Check original receipt or explicit expiry, never reappend. This is a narrow test
fixture of the approved invariants, not a reusable ingestion framework. Report
live event/index/FTS/receipt bytes separately where SQLite exposes them, otherwise
mark attribution estimated/unavailable and retain aggregate file sizes. Derive
retention horizon from measured overhead and receipt occupancy, not payload alone.

### Fault, WAL and resource budgets

Closed failpoints: before BEGIN, during inserts, after COMMIT before ack, receipt
cleanup, retained reader/checkpoint, SQLITE_BUSY, statfs failure and synthetic
ENOSPC before/during transaction. Capture commit/ack uncertainty, then inspect
integrity, FTS equivalence and receipt uniqueness after confirmed worker death and
reopen. No fault fills the filesystem. Restoration uses only a closed/checkpointed
fixture copy, with both copies charged; no copying a live database without WAL.
Actual power loss, directory durability and native recorder recovery remain outside
this harness. Fixed failpoints must be reachable deterministically without delays.

WAL profile16 MiB checkpoint warning,48 MiB stop ordinary admission/drain reader,
64 MiB hard ceiling. A pinned reader forces measurable pressure in a bounded case.
Before each transaction reserve worst-case growth, not just payload bytes: derive
a conservative page-write ceiling for the closed schema and capped batch, including
FTS/index changes, from page-count/allocation bounds. If no defensible growth bound
can be enforced on an actual runtime, report WAL hard-cap qualification unsupported
and deny that transaction before it starts; all affected scenarios remain unsupported/not-run, including seed setup, ordinary inserts, FTS maintenance, receipt updates and pruning; never claim a post-commit size check enforces
64 MiB. Record reserved vs actual DB/WAL growth and checkpoint busy/overshoot.
No full VACUUM; large cleanup is bounded incremental deletion with transaction caps.
Split live metadata-only inventory from post-join artifact hashing. Per-batch live
checks use bounded lstat/file identity/size information and conservative in-flight
reservations; they must not call the current content-hashing `inspectArtifacts()`.
Hashing is reserved for joined-worker finalization, avoiding live-file races and
unbounded measurement I/O during admission.

Preflight hard limits: DB2 GiB inclusive of256 MiB reserved receipt/catalog-headroom
(no catalog rows implemented); WAL64 MiB; all artifacts including SHM, copies,
reports, captures and residue≤4 GiB. A restore copy is admitted only if worst-case
aggregate fits. Free disk≥8 GiB plus configured reserve (minimum1 GiB) and all
unmaterialized reservations; after materialization transfer reservations to measured
inventory once, without double counting. Unknown statfs/inventory denies admission.
Check at every batch and at least once per second during idle/query phases. Abort
on reserve breach; failed cleanup retains explicit bytes/path ownership in report.

Sample main-loop delay at10ms resolution; fixed histograms with stated bin error,
no unbounded latency sample arrays. CPU comes from process user/system deltas,
reported per phase and as core equivalents; proposed safety stop is sustained

> 1.5 cores for10 consecutive one-second samples, not a claimed throughput target.
> Resource sampling1Hz, at most1,200 samples; aggregate progress≤1 KiB/s; report≤1 MiB
> and bounded final stdout≤1 MiB. Sampling and logging run identically in baseline
> and storage. Report measured instrumentation-only CPU/loop overhead separately;
> no overhead subtraction disguises missed load or failures.

The192 MiB worker-RSS objective cannot be isolated by summing worker_threads RSS,
which is process-wide. Report whole-process peak RSS and separate worker heap/external
metrics, never mislabeled worker RSS. For this extension enforce conservative
whole-process RSS≤192 MiB, plus main retained heap/external growth≤32 MiB over
matched baseline at warmup/drain. If startup alone exceeds this conservative cap,
report unsupported measurement configuration; do not loosen it silently. Sampling
can miss transient/native allocations, so record that limitation and worker heap
limits rather than claiming a hard native-RSS ceiling. Per-worker V8 limits bound
heaps only. CPU/RSS/loop limits abort execution with explicit incomplete accounting.

### Resource-window proposal and known gaps

No window is active. After exact extension review, request individual sequential
slots: actual-runtime disabled/micro smoke first;100k query setup/cases (≤20min);
steady baseline then storage (≤20min each); burst baseline then storage; overload
baseline then storage; receipt/fault cases (≤60s each);500k query case only after
capacity evidence; other approved native runtime/architecture cells separately.
Clean or explicitly account for each slot's residue before the next. Do not queue
an unattended matrix or overlap suites/other lanes. Each slot states exact executable,
source hashes, scenario/phase, deadline, estimated CPU/RSS/disk and abort criteria.
External capture is an explicit operator obligation before each slot: exclusively
create a separate `activity-capture-<UUID>` directory under the same ignored
`output/qualification/` root, with no symlink/reused path, tied to the run UUID.
Reserve4 MiB aggregate capture capacity before driver admission: stdout1 MiB,
stderr2 MiB (including progress, warnings and fatal diagnostics), manifest1 MiB.
Charge this reservation against the4 GiB artifact ceiling and free-space reserve;
never count both its reserved and materialized bytes. No unbounded shell redirection
is accepted. The execution-window proposal must identify an existing bounded pipe
consumer or a separately reviewed capture mechanism; if unavailable, execution
remains not-run rather than inventing a tool or expanding current path ownership.
On cap breach the consumer stops the owned invocation, reports truncation and
fails the run; it must drain/close pipes without deadlocking termination.
After confirmed process exit the operator verifies exit status, EOF/completion,
actual capture sizes/hashes and total driver+capture+residue bytes, then records
these in the bounded manifest. Missing final stdout, truncated captures, unknown
exit or unfinished pipe drain means incomplete evidence. Fatal containment can
leave driver artifacts; the operator only inventories them after process exit and
must not assume cleanup. Driver elapsed ends after its cleanup attempt; external
capture close/verification time is a separate observed duration subject to a60s
post-exit budget. It never changes the driver's20-minute measurement claim.

Paired comparison requires both slots on the same quiet host/settings; unmatched
or interrupted halves remain incomplete, not performance acceptance.

Known actual evidence is Node25.2.1 microtests only. Node20 disabled behavior tested
with injected version strings is not an actual Node20 execution. Node22.13 minimum,
Node22.23.3, native Linux AMD64/ARM64 and deployment filesystems remain unverified
until their exact executables/runners are provided and measured. No runtime install,
container/image build or emulation is inferred. FTS/API support is probed on each
actual cell, not inferred from version parsing. Cross-runtime tests report skips
and unsupported capabilities without converting them into success.

`combined` stays `not-run` throughout this extension: a real accepted-scanner
recorded-IQ baseline requires separately allocated integration/instrumentation and
its own15-minute paired window. No scanner app import, live receiver or production
mount is authorized by these seven paths. Completion of synthetic qualification
can support a storage decision; it cannot accept SQLite packaging, full-system
resource impact or catalog/recording lifecycle integration.

## Migrations, repair and acceptance

Open state load-only during normal boot; explicit feature setup creates directories.
Hold exclusive writer ownership before migrations. Store schema version and reject
newer versions without writing. Transactional bounded migrations preserve IDs and
cursor semantics; incompatible history/index repair bumps restore generation.
Before a destructive migration, require verified local backup and sufficient space
for DB+WAL+backup+reserve; otherwise stay unavailable with actionable status. Use
SQLite backup API or closed/checkpointed DB, never a lone live `.db` copy. Startup
integrity checks and foreign-key checks gate writes; corruption is quarantined for
explicit repair, never “recovered” by silently creating an empty DB. Scanner/access
stores remain usable independently. Missing media produces catalog state, not DB
deletion. Shutdown stops admission, drains bounded commits, closes streams/writers,
checkpoints and sets clean flag; interruption leaves recovery work explicit.

Correctness properties (fast-check minimum100 runs, with requirement comments):

1. **One identity:** arbitrary duplicate retries and equal separate payloads yield
   one committed row per admitted eventId, with conflict rejection for changed bytes
   while the ticket is valid and explicit rejection after expiry. Generate Activity
   prune before retry, owner-ack failure, receipt reclamation, clock jumps and restore;
   no expired retry appends again.
   _Requirements: 1.1, 2.2._
2. **Binding truth:** retune/restart/delayed-output schedules cannot attach a newer
   binding to older output; missing evidence stays null and clocks stay independent.
   _Requirements: 1.2, 1.3._
3. **Outcome authority:** arbitrary progress/cancel/retry/revision schedules create
   only owner-committed terminal revisions and preserve non-decode outcomes.
   _Requirements: 1.4–1.6, 2.4._
4. **Replay partition:** snapshot≤H plus replay>H covers every retained matching
   committed ID exactly once after client dedup, across filter holes and reconnects;
   prune/restore schedules cause explicit reset rather than silent omissions.
   _Requirements: 3.1–3.5._
5. **Bounded failure:** arbitrary payload sizes, bursts, reader stalls and ENOSPC
   never exceed admitted queue/reservation limits or block the IQ caller; loss
   accounting distinguishes uncommitted loss from committed replay gaps.
   _Requirements: 2.3, 2.4, 5.4._
6. **Crash publication:** faults before/after every fsync/rename/DB commit recover
   either the same verified ready ID or explicit incomplete/missing/quarantined
   state; never expose a partial file as ready or overwrite a published artifact.
   _Requirements: 4.1–4.5._
7. **Protection union:** generated Keep/unkeep/link/delete/lease schedules cannot
   remove effectively protected bytes; stale CAS and deletion races have one winner.
   Include failed unkeep → attempted newer Keep → delayed stale retry, generation
   restore, links during pending intent and merge/delete during protection transfer.
   _Requirements: 5.1–5.3._
8. **Accounting conservation:** physical bytes and reservations are counted once
   across all roots/reasons; unknown or low free space cannot admit new writes.
   _Requirements: 5.4, 5.5._
9. **Trim and lease isolation:** arbitrary valid trims/revisions/ranges preserve
   original bytes, deliver only pinned sample bounds, and release every resource on
   disconnect/revocation/cancellation, including asynchronous setup races.
   _Requirements: 6.1–6.4._
10. **Migration identity:** crash/restart/restore and index rebuild preserve IDs,
    reject unsupported schema safely and invalidate incompatible continuations.
    _Requirements: 2.5, 3.4, 7.2._

Deterministic fixtures supplement properties: late native WAV update, TEMP file
after death, two same-second native calls, ambiguous scanner aliases, encrypted
call, scanner candidate/artefact/window-moved, sample-gap analog recording, cross-
device copy interruption, slow HTTP range reader, SQLite busy/corruption, FTS delete
consistency and two-store Keep failure. Benchmark combined decoder/scanner load in
a coordinated quiet window; target added main-loop p99≤5ms and bounded queues at
the stated100/s profile. Measure worker RSS, fsync latency, disk growth, search
deadline and gap counters. Missing the target requires smaller defaults or revised
storage scheduling, not a performance claim from empty synthetic inserts.

## Design review status

Two independent source audits and an amended-design review resolved bounded receipt
lifetime and generation-fenced Keep. Accepted-S1 F3/F5 reconciliation now preserves
implemented deletion authority/drains and fatal-generation cleanup while retaining
terminal/file-settlement distinctions. The reconciliation and exact qualification
plan passed independent delta review with no remaining design blockers. SQLite remains provisional; S2/S3, protected
mounts and every deletion-owner/Keep gate still require their allocated checkpoints.
