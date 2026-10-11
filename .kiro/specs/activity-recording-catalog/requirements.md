# Activity and recording catalog — requirements

Status: reviewed design only. Accepted-S1 reconciliation and the bounded storage
qualification plan passed independent delta review. Only the disposable qualification harness and bounded guard/micro tests are allocated; production implementation remains unallocated. No production implementation is
authorized by this document. Implementation tasks require the checkpoints in
[tasks.md](tasks.md). [design.md](design.md) supplies bounds and failure semantics.
The completed [decode envelope](../decode-envelope/design.md) remains the input
foundation; it is not reimplemented here.

## 1. Identity, time and evidence

As an operator, I want to distinguish received messages, call activity and scanner
results without mistaking process health or a candidate for a confirmed decode.

1.1 Allocate an immutable eventId once at decoder ingress before new Activity
fan-out. Preserve it through retries, storage, links and replay. Equal payloads
from distinct outputs remain distinct; native IDs remain qualified references.
1.2 Preserve producedAt and receivedAt independently. Sample time requires an
owner-supplied source, stream, epoch and sample range with rate and clock basis;
never infer it from parser emission time or filename timestamps.
1.3 Bind RF to the input generation that produced the output. Unknown or ambiguous
bindings remain null/qualified; never look up the current tuner to fill old output.
1.4 Classify receptions, call/transmission lifecycle, telemetry and scanner target
progress separately. Default durable Activity excludes replaceable telemetry and
progress. A decoder event or analog carrier does not imply accepted evidence.
1.5 Preserve scanner discovery/observation IDs, journals and recovery ownership.
Expose links and bounded domain projections, never journals as a public event API.
1.6 A scanner-owned terminal-result adapter assigns stable target attempt identity
and monotonic revisions. Revisions append immutable events; retries do not create
duplicate terminal results. Cancelled, unidentified, candidate and failed outcomes
remain truthful. Recovery must distinguish an interrupted attempt from a result.

## 2. Public contracts and durable ingestion

As a CLI or web client, I want one versioned, bounded public contract and explicit
durability guarantees without changing the existing decoder stream unexpectedly.

2.1 Promote the existing envelope through a coordinated API-types checkpoint with
one canonical definition. Keep its strict v1 shape; extension metadata belongs in
the new versioned Activity record. Preserve legacy decoder streams during migration.
2.2 Acknowledge durable admission only after transactional commit. Persist immutable
payload, sequence, search projection and relationships together. Same eventId plus
same canonical bytes is idempotent during its advertised retry horizon;
conflicting bytes are rejected visibly. Durable expiry fences prevent pruned or
expired retries from being admitted as new events; owner acknowledgement and
receipt reclamation have bounded recovery semantics.
2.3 Bound ingress memory, item size, rate, batch work, reader work and disk use.
Never stall IQ or native stdout on storage. Report losses and unavailable durability
without describing volatile data as persisted or promising exactly-once RF capture.
2.4 Authoritative lifecycle producers use a bounded durable handoff or explicit
failure; no fire-and-forget claim of reliable terminal history. Store outage must
not change scanner confirmation or source ownership.
2.5 Use deployment-compatible local storage, documented runtime qualification,
bounded migrations, safe recovery and backups. Never silently reset a corrupt DB
or rekey restored records. Isolate Activity failure from decoding and access state.

## 3. Search, paging and replay

As an operator, I want to pause, search and reconnect without missing committed
items or confusing a changed filter with a continuation of the old feed.

3.1 Provide bounded typed filters and full-text search over explicitly indexed
fields, with stable sequence ordering and keyset pagination. State what is not
indexed; never imply arbitrary raw JSON or all historical data is searched.
3.2 Snapshot pages share a fixed committed high-water mark and filter contract.
Live replay begins beyond that barrier, preserving global committed order after
filtering. Cursor advancement includes examined nonmatching records.
3.3 Bind cursors to store generation, schema/query version, normalized filters,
ordering and sequence. Duplicate delivery is permitted and deduplicable; silent
loss, reordering, filter reuse and timestamp-only cursors are not.
3.4 Restart on the same intact store preserves valid cursors. Expiration, restore,
retention holes, removed records or schema incompatibility return an explicit reset
reason and new snapshot path. Slow consumers release resources and resume by cursor.
3.5 Mutable recording metadata and future transcript changes must not silently
change membership of an in-progress Activity snapshot. Define update and refresh
semantics separately from immutable event paging.

## 4. Recording identity and producer ownership

As an operator, I want a recording link to continue identifying the same bytes and
provenance even when its producer closes, moves or recovers the file later.

4.1 Assign an opaque stable recordingId independent of filenames and call IDs.
Maintain explicit compatibility mappings for scanner recording/capture IDs and
qualified native producer references; never join solely by nearby time/frequency.
4.2 Model recording lifecycle, media kind, format, byte/sample counts, provenance,
coverage, source events and incomplete/missing states. A late WAV update is a link
revision, not a second call. Unknown associations remain unknown.
4.3 Publish playable files only after verified producer closure, media validation,
durable file publication and catalog finalization. Handle partial writes, rename,
cross-device import, crashes and restart reconciliation without overwriting files.
4.4 Coordinate existing digital WAV production, scanner evidence/captures, planned
S2 analog recording and S3 monitoring. Do not claim all-call coverage, monitor
recording, seek or export until each producer and delivery path passes its gate.
4.5 Catalog links survive Activity or discovery retention. Deleting a referenced
domain object cannot cascade-delete protected media; missing references remain
explicit. Audio, IQ and encrypted/no-audio events have distinct capabilities.

## 5. Keep, retention and capacity

As an operator, I want Keep to protect media across all deletion paths and storage
pressure to stop new writes safely rather than consume the whole disk.

5.1 Distinguish discovery Keep (collective evidence protection) from recording
Keep (one media object). Effective protection is the union; unkeeping one does not
clear the other. Keep is durable and compare-and-swap versioned across clients.
5.2 Every pruner, orphan cleaner, producer cleanup, discovery deletion, capture
deletion and explicit media deletion consults the same decision authority before
unlinking managed bytes. Kept or leased files cannot be removed by a race. Version discovery protection operations durably;
stale cross-store retries cannot clear newer protection. Pending operations fence
conflicting mutations, new links, merges and deletion until reconciled.
5.3 Serialize Keep with deletion decisions. Return a conflict if deletion won;
never acknowledge protection of bytes already being deleted. Explicit deletion of
protected media requires a distinct, deliberate protection-removal operation.
5.4 Enforce separate metadata/media quotas, per-producer write reservations, minimum
free disk and bounded active writes/exports. Unknown free space denies new writes.
Keep never grants unbounded space or evicts another kept item.
5.5 Report physical/logical totals without double counting, active/temp/export and
unknown bytes, configured retention, actual oldest availability and reasons for
write cessation. Never describe cap eviction as a precise shortened age guarantee.

## 6. Playback, edits and later jobs

As an operator, I want safe playback and non-destructive edits without changing the
original evidence or losing a file during download.

6.1 Serve media by catalog ID under trusted protected-runtime policy. Validate and
admit before headers, files, jobs or producers; enforce session and file leases
through asynchronous setup, streaming, cancellation and revocation.
6.2 Advertise format-specific playback/seek/download capabilities only after media
validation. Bound concurrent streams, ranges, bytes and duration. No client paths,
redirected credentials or shell interpolation.
6.3 Store name, note and sample-aligned half-open trim metadata with CAS revisions.
Keep originals immutable. Playback and exports identify the applied revision and
trim; original download is a separate explicit operation.
6.4 Export requires bounded job admission, a file lease, space reservation and
capability checks. WAV trimming is the first audio export; Opus, SigMF and IQ source
playback require separate format/ownership gates. No speculative capability flags.
6.5 Transcription is a later bounded job on finalized eligible audio with revisioned
results and explicit search update semantics. No automatic inference of speech,
alias, voice BER, CTCSS/DCS code or full call coverage from existing metadata.
6.6 Saved frequencies remain independent operator-owned objects. Links do not copy
payloads or control retention. Activity filters are client-local initially; shared
presentation preference keys require the operator-data owner's typed agreement.

## 7. Delivery and validation

7.1 Keep this lane design-only. Gate public DTOs, mounts and shared recording/audio
changes on assigned ownership, accepted scanner S1, settled S2/S3 producer contracts
and protected-runtime integration. No frontend redesign is part of this spec.
7.2 Verify correctness properties with at least 100 generated runs, deterministic
crash/fault schedules and representative sanitized fixtures. Include actual native
closure/restart and storage capacity validation before enabling production writes.
7.3 Report exact checks, unverified assumptions, unsupported capabilities and
remaining integration gates. A design review or unit pass is not RF, deployment,
storage durability or full-call acceptance.
