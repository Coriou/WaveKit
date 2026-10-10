# Shared operator data design

Status: Astra MEDIUM approved isolated foundation design checkpoint; implementation
and end-to-end acceptance remain unverified, public integration is not mounted.

## Authority audit

- `src/config.ts` validates YAML/env at startup; `stateDir` already owns runtime
  data. Parsed defaults cannot prove YAML vs environment provenance.
- `src/decoders/band-override-store.ts` owns `decoder-band-overrides.json` and
  exposes persisted status. Its memory-only write fallback is unsuitable for
  acknowledged saved records; preserve its existing behavior independently.
- Scanner S1 `src/core/scanner/settings.ts` merges config with typed overrides in
  scanner `settings.json`, reports provenance/bounds and owns PATCH semantics.
  Its storage/retention, passive source behavior and spectrum defaults stay there.
- `packages/api-types/src/live-audio.ts` / `src/config.ts` own current modes and
  bandwidth semantics. Tone detection/squelch is absent; CW/DSB names do not prove
  advanced DSP. `readsb.ts` currently gates latitude/longitude under enableMlat.
- CLI `cli/source/data/{api-client,guards,store}.ts` has defensive operational
  consumers but no saved-preset authority. Tuner history is operational history,
  not arbitrary command ranking text.
- Web snapshot `28280cf`, read without fetch: `docs/web/CORE-GAPS.md`, canvas
  `Tuner.dc.html`, `Settings.dc.html`, `Palette.dc.html` are design references.
  Tuner uses `{f,label,group,mode,bw}` local examples; Settings combines shared
  units/time/palette with future operational controls. This spec supplies a
  narrower honest contract; it does not implement every mocked control.

## Components and owned paths

`src/operator-data/schema.ts`: strict Zod schemas, types and limits.
`domain.ts`: pure immutable transitions, defaults, CAS, typed errors.
`storage.ts`: dedicated local atomic persistence and lifetime ownership.
`service.ts`: bounded serialized transactions over domain/storage; no event bus.
Tests under `tests/unit/operator-data/`. No imports from scanner or access storage.
No root config/bootstrap/API/events/build/public-export edits in this checkpoint.
Future unmounted adapters require reviewed contracts and Main disjoint allocation.

## Schema v1

Disk and wire snapshot share `{version:1, storeId:UUID, revision:integer,
savedFrequencies:SavedFrequency[], preferenceOverrides:PreferenceOverrides,
commandUsage:CommandUsage[]}`. Revision starts at 0, maximum MAX_SAFE_INTEGER.
All objects strict. Arrays in deterministic order (presets by creation order,
usage by most-recent server revision descending). No custom blob values.

SavedFrequency = `{id:UUID, createdAt:ISO UTC, updatedAt:ISO UTC,
name:string, frequencyHz:integer, mode, bandwidthHz:integer, tone, group?:string}`.
Names trimmed, 1–128 Unicode code points; group trimmed 1–64. Control characters
rejected. frequencyHz 1–100 GHz is a storage range, not hardware capability.
Modes `nfm|wfm|am|usb|lsb|dsb|cw|raw` mirror existing contract. bandwidthHz
0–10 MHz; non-raw >0; raw requires 0 to mean full capture span. No runtime support
promise follows from a stored value; applying must validate source/runtime limits.
Tone = `{kind:'none'}` | `{kind:'ctcss', frequencyTenthsHz:integer}` |
`{kind:'dcs', code:string, polarity:'normal'|'inverted'}`. CTCSS stored as integer `frequencyTenthsHz` 600–3000 (60–300 Hz),
DCS exactly three octal digits (preserved leading zeroes), both only for NFM.
This records selected intent; future detection has separate measured provenance.
IDs assigned by crypto.randomUUID on create, never accepted from request bodies;
replace retains identity/createdAt; delete returns absence and removes its usage.
Duplicate names/frequencies allowed. No ID lookup fallback, copied Activity payloads
or cascade deletion into scanner/catalog. Future external links use `(storeId,id)`;
reprovision breaks links and deleting gives 404. UUIDs are never deliberately reused.

Limits: 256 saved frequencies, 64 usage entries, 512 KiB UTF-8 persisted/snapshot
bytes. Requests ≤16 KiB; at most 32 waiting transactions plus one active.
Overflow rejects immediately with busy/quota errors; there is no unbounded queue.

PreferenceOverrides is partial `{units:'metric'|'nautical'|'imperial',
timeFormat:'local-24h'|'local-12h'|'utc', waterfallPalette:'phosphor'|'amber'|'mono',
showSavedFrequencyLabels:boolean}`. Defaults nautical/local-24h/phosphor/true,
matching web reference. GET effective preferences combines defaults/overrides and
reports per-key `default|operator`; reset explicitly deletes chosen override keys.
Persisting a default intentionally still reports operator; no-op means same stored
state. Language support and layout/accessibility remain device-local; no settings
edit can select engines, change FFT resolution or apply receiver commands.

CommandUsage = `{command:'tune'|'identify'|'listen'|'open-saved-frequency',
savedFrequencyId?:UUID, count:integer 1..1000000, lastUsedAt:ISO UTC,
lastUsedRevision:integer}`. open-saved-frequency requires a live preset ID; others
optionally reference a live preset. Key is command plus optional preset ID. Report
one successful use per CAS transaction, count saturates, time assigned by core;
at 64 keys remove least-recent revision (tie by deterministic key). This bounded
ranking hint is unverified client input, not execution/audit or raw palette history.
Reset empties usage. Deletion prunes usage references. Duplicate reports after
uncertain responses are not automatically retried. No stored free-text arguments.

Station location extension: a future separately reviewed `stationLocation` contract
will be `null | {latitudeDeg:-90..90, longitudeDeg:-180..180,
altitudeM:number|null /* metres above mean sea level */, provenance:'operator'}`. v1 rejects this unknown key until
Main assigns station authority/config precedence; estimates are separate ephemeral
values, never written as authoritative coordinates. Location is not a presentation
preference. Integration must decouple readsb positioning from enableMlat and preserve
explicit deployment pins, with no maps/coverage expansion here.

## Transactions and failure semantics

UUID wire identities are canonical lowercase; uppercase spellings are rejected
rather than creating case-dependent lookup aliases.

Token `{storeId, revision}` is required for all writes, including ranking/reset.
Service validates request synchronously, captures an immutable copy then admits it
to a bounded queue. Inside queue: recheck availability/CAS, apply pure transition,
validate entire state and byte bound, persist if changed, swap committed state.
GET returns a cloned last committed snapshot while a write is in flight.
Conflict returns current token only, avoiding a large error body. Current-token
no-op returns unchanged snapshot and no publication. Old-token no-op still conflicts.
Timestamp is server wall UTC; edits use max(now, previous updatedAt) so backward
wall jumps do not move record time backward. Revision is ordering authority.
New revision overflow fails before persistence. Initial file has durable UUID/rev0.
There is no request-id cache, exactly-once promise or replay journal.

Dedicated `stateDir/operator-data/` holds `state.json` and `.writer-lock/`.
Open requires an absolute path into trusted stable local parent directories, requires that stateDir already exists durably (no ancestor creation), creates
only its operator-data child private (0700), never chmods existing paths. After
creating that child, sync stateDir before initialization or any write succeeds;
sync stateDir again on later open to reconcile an earlier interrupted creation.
Parent-sync failure rejects open without deleting existing data; release only
the lock acquired by this opener, leaving the empty child for safe later reopen.
State initialization failure likewise preserves any renamed state and releases
its own lock only after all attempted I/O settles. Files/child must have private
permissions and current-user ownership, and be regular file/directory types. Atomic mkdir
lock excludes any other opener (including same PID); after crash offline repair
must establish no writer before removing lock. No PID-only liveness guessing.
Files use 0600 and exclusive temp creation, no symlink-following on final file.
State read is at most byte limit+1 before parsing; reject invalid/oversize/version.
Missing file is durably initialized under lock. Directory and file identity/types
are checked; local trusted parent assumption excludes hostile path replacement,
NFS and cross-host writers. Temporary leftovers are not authoritative state and
are ignored; explicit offline cleanup may remove them with the process stopped.

Write: validate → encode bound → exclusive random temp → write → fsync file →
close → rename → fsync directory. Before rename failures remove own temp and keep
memory/token; transaction returns unavailable/write failed but store can retry.
After rename any failure makes disk outcome uncertain: latch unavailable, reject
reads/writes and emit nothing until close/reopen validates disk. Rename is atomic
but no rollback claim is made. Persisted success means host filesystem sync success,
not protection against faulty storage hardware. Close drains accepted work, rejects
new requests and releases lock; error cleanup must retain ownership if uncertain
accepted writes still run. Unknown/corrupt state leaves file untouched and feature
unavailable, not silently empty; core decides whether to disable this feature.
No automatic migration in v1; future migrations must be explicit and reviewed.

## REST contract (integration pending)

Common errors `{error,code,message,details?}` with generic filesystem messages.
GET `/api/operator-data` → 200 `{snapshot, preferences:{values,provenance},
capabilities:{toneSelection:true,toneDetection:false,toneSquelch:false}, limits}`.
Preset details may be read from the bounded complete snapshot; no pagination needed.
POST `/api/operator-data/saved-frequencies` `{expected, frequency:SavedFrequencyInput}`
→201 `{snapshot, savedFrequencyId}`. PUT `.../:id` `{expected, frequency}` →200
`{snapshot}`; only existing IDs. DELETE `.../:id` body `{expected}` →200 `{snapshot}`;
missing ID returns404 (after CAS). Mutations never apply RF/audio behavior.
PATCH `/api/operator-data/preferences` `{expected,set?:PreferenceOverrides,
reset?:PreferenceKey[]}` →200 `{snapshot}`; nonempty set/reset, no duplicate reset
keys or key in both. POST `/api/operator-data/command-usage` `{expected,command,
savedFrequencyId?}` →200 `{snapshot}`. DELETE same path `{expected}` resets →200.
No broad state replacement/import, YAML edits or operational proxy routes.
Precondition token in body avoids unspecified If-Match grammar; missing →428
OPERATOR_DATA_PRECONDITION_REQUIRED, malformed/unknown keys →400
OPERATOR_DATA_INVALID, stale →409 OPERATOR_DATA_CONFLICT `{current}`,
unknown preset →404 OPERATOR_DATA_NOT_FOUND, count/byte quota →409
OPERATOR_DATA_QUOTA, queue busy →503 OPERATOR_DATA_BUSY,
failed persistence/unavailable →503 OPERATOR_DATA_UNAVAILABLE.
Authentication/origin/CSRF admission comes from protected runtime before mutation;
no route or broadcaster mount before Main allocation and actual protected integration.
GET/request/snapshot limits must use the same schema as domain and published DTOs.

## WS contract (integration pending)

Channel `operator-data`; events `operator-data:snapshot` on subscription and
`operator-data:updated` after changed durable transactions, data = complete
GET body above. Existing envelope type/channel/data/timestamp remains unchanged.
Service accepts one injected synchronous `onCommit(snapshot)` sink, called with
a detached committed snapshot after durable state swap and before queue release
or mutation resolution. Current-token no-ops invoke nothing. The sink belongs to
existing broadcaster integration; no service emitter or subscriber registry is added.
Sink exceptions are delivery failures, isolated from storage: durable mutation still
succeeds, store stays available, and result includes `delivery:'failed'` so integration
can log/close affected streams. Successful callback (or absent unmounted sink) reports
`delivery:'sent'|'unmounted'`; a no-op returns `delivery:'not-needed'`; these are internal results, not persistence guarantees
or public UI flags. No sink promise/async callback is supported. Integrating owner
must enforce the synchronous callback type and handle transport backpressure.
Within existing broadcaster subscription lifecycle, register channel then capture
and enqueue `service.snapshot()` synchronously, without await. JavaScript commit
swap/sink runs without await, so subscription snapshot cannot fall inside that
boundary. Initial state is enqueued before later revisions on that connection.
REST/WS responses may reorder; clients apply only higher revisions in same store and ignore responses from prior server/connection generations.
A new storeId replaces all cached data; no comparison across store identities.
Reconnect always gets complete state; no cursor or replay. Updated snapshots can
coalesce to latest committed state under existing transport bounds, so revision gaps
are normal and require no replay. An unavailable feature emits no fake empty state;
subscription answers unavailable and clients retain stale-marked last-known data.
Integrating owner must guarantee all mutation origins publish and no callbacks leak.

## Correctness properties

1. **Validation closure**: accepted request/transition state always validates, has
unique IDs/references, stays within count/string/byte bounds (1.1,1.3,2.1,2.3,4.6).
2. **Stable identity**: replace preserves ID/creation time and deletion removes
only that preset plus its ranking references, no frequency fallback (1.2,1.5).
3. **CAS isolation**: same-token competing changed writes yield at most one success;
stale or invalid/no-op-stale input leaves state unchanged (3.1–3.3).
4. **Revision monotonicity**: changed success increments once, current no-op never
increments, timestamps cannot reorder revisions, store identity survives reopen
(3.3–3.4).
5. **Durability boundary**: acknowledgment happens after file/directory sync; every
injected pre-rename failure preserves visible/disk prior state, post-rename failure
latches unavailable with no acknowledged change (4.2–4.3).
6. **Recovery preservation**: invalid/future/oversized state is unchanged, successful
restart restores exact state, only one writer opens (4.1,4.4–4.7).
7. **Authority isolation**: all transitions affect only presets/preferences/ranking;
unknown operational keys rejected, returned values detached (1.4,2.2,3.3).
8. **Bounded ranking**: sequence of uses retains ≤64 keys/count cap, deterministic
oldest eviction, live references only, no raw inputs (2.3,4.6).
9. **Bounded lifecycle**: busy admission is finite and close drains accepted work,
rejects new work and releases ownership after completion (4.6–4.7).
10. **Snapshot convergence**: duplicates/reordered REST/WS of same store never
regress client state; reconnect replaces with committed current snapshot (5.2–5.5).

Property tests run ≥100 cases and reference numbered requirements. Filesystem
failure and concurrency tests use real temporary directories plus injected narrow
storage operations; they never access live state. Sink ordering/exception and subscription-capture race tests cover the unmounted
foundation seam without a new bus. Property10 requires actual client
integration and remains a later gate, not claimed by pure-domain tests.

## Initial Astra consultation decisions

Accepted: separate authorities, strict typed records, integer tenths-Hz tone
selection, UUIDs, global CAS over complete transaction, strong durability with
uncertain post-rename latch, complete revisioned snapshots and explicit provenance.
Bounded quotas deliberately use 256 presets/512 KiB (below 1 MiB WS frame cap),
not the suggested 1000/1 MiB. Global CAS uses 409 conflict with body token because
this API does not use HTTP conditional headers (412 would imply header semantics).
Core-assigned fresh UUIDs keep curated identity server-owned; ambiguous creates
require refetch/reconciliation and no automated retry, without exactly-once claims.
No caller UUID/create-only mechanism or request cache is introduced in v1.
Shared Activity fields stay client-local per peer agreement; no shared generic
store or duplicated operational configuration. Ranking has a closed finite schema
and bounded retention by count; raw history is excluded. Station altitude datum
is mean sea level; station authority/config precedence remains its later gate.

## Spec review round 2 resolutions

P1: stateDir must be an existing durable local directory; sync its entry after
operator-data creation (and on reopen), never create ancestor chains. Parent-sync
failed initialization rejects, releases only own lock after settled I/O and leaves
existing/renamed state untouched. Injected parent-sync coverage required.
P2: one synchronous injected onCommit sink executes inside serialized durable
commit before mutation resolves/queue releases; detached input, no no-op calls.
Sink failure cannot roll back or masquerade as persistence failure; internal
delivery result is failed while committed mutation succeeds. Subscription uses
existing broadcaster lifecycle with synchronous register/capture/enqueue.
No second bus/subscriber registry or mounted integration in this checkpoint.

## Foundation verification sample (before independent code review)

Domain/storage/service are independent and unmounted. Four unit files pass97
tests; Properties1–9 (excluding integration-only10) run100 cases each where
applicable. Repository typecheck and lint pass (59 existing warnings,0errors).
Test globals imports/UID mock typing initially failed root typecheck and were fixed
in owned tests; no source or shared configuration changes were needed.
Synthetic maximum state on Darwin24.6.0/x64 Intel i5-1038NG7 Node25.2.1:
256presets +64ranking keys encode275522bytes (275540 after preferences). Ten serial
actual-fsync mutations including snapshot capture:124.99/142.62/167.92ms
minimum/median/maximum in the parent combined touched run. This is bounded local
latency/size evidence, not sustained multi-client transport or power-loss acceptance.
Admission is one active +32waiting; response loss does not cancel admitted work.
Close rejects new work and drains accepted operations before releasing ownership.
Operational admission/lease checks at mounting and slow-reader/network recovery
remain Main/client integration gates; no client or mounted capability is claimed.
