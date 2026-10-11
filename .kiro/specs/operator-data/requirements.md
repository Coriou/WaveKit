# Shared operator data requirements

## Scope

One operator using CLI and web on a local/LAN core. Core owns named RF presets and
closed shared presentation preferences. Existing config, tuner, live-audio,
decoder-band and scanner authorities continue to own operational behavior.
This feature does not implement accounts, roles, cloud sync, maps, actual tone
recognition, tone squelch, a generic configuration platform or Activity storage.
Independent foundations precede coordinated public exports, mounting and clients.

## 1. Saved RF presets

As an operator I want the same named presets on every client.

1.1 Core shall validate and persist name, frequencyHz, mode, bandwidthHz and
configured tone selection, plus an optional group. Names need not be unique;
frequencies may be shared by distinct presets.
1.2 Each preset shall have a core-assigned UUID stable across edits/restart;
identity shall never be inferred from a name, frequency or array index. Deleted
links shall resolve as absent, never by substituting a similar preset.
1.3 Tone selection shall distinguish none, selected CTCSS frequency and selected
DCS code/polarity. It shall describe operator intent, not observed detection or
proof of enforced squelch. Unsupported tuner/audio behavior shall not be claimed.
1.4 Saving, updating or deleting shall not tune, start audio/decoders, create a
scanner job, or change scanner discoveries/band overrides. Applying a preset
shall later use existing authorized operational commands and arbitration.
1.5 Whole-record replacement shall preserve ID and creation time; deletion shall
remove associated ranking references. No automatic deduplication shall discard
operator records. Optional future Activity links shall not control retention.

## 2. Shared settings boundaries

As an operator I want useful preferences shared without conflicting authorities.

2.1 Shared presentation shall use a closed typed schema: units, clock display,
waterfall palette and saved-frequency labels. Unknown keys shall be rejected.
Language, device layout, reduced motion, active source/profile, filters, selected
items, paused views and draft edits shall remain client-local initially.
2.2 Scanner detection/storage/WS defaults shall remain at scanner settings;
per-client spectrum selections shall remain subscriptions. Tuner, sources,
live-audio, decoder options/bands, access credentials/sessions and recording
retention shall not be copied into operator data or rewritten by preference edits.
2.3 A bounded command-ranking input shall store only a closed command identifier
and optional saved-preset UUID, server count/time; it shall store no raw command,
arguments, credentials, URLs, decoder payloads or free-text queries. It shall not
execute commands or serve as an audit log. Usage is reported after success by a
client, and represents a ranking hint rather than verified receiver activity.
2.4 Station location shall have a narrow extension boundary: explicit manual
latitude/longitude/altitude and provenance, separate from approximate estimates,
map assets and coverage history. Initial foundation shall reserve its contract;
actual ownership/config precedence and readsb integration need coordinated review.
2.5 Shared preference defaults shall be visible and resettable per key; stored
operator overrides shall be distinct from defaults. This feature shall not claim
YAML/environment provenance it cannot derive from current configuration parsing.

## 3. Revisions and concurrent clients

As an operator I want simultaneous CLI/web changes to avoid silent overwrites.

3.1 Every snapshot shall carry an opaque store UUID plus monotonically increasing
safe-integer revision. Every mutation shall require that exact current token.
Validation and compare-and-swap shall occur inside one serialized transaction.
3.2 A stale token shall reject without changes and return the current token;
clients shall fetch/reconcile, preserving drafts. Missing preconditions shall be
explicit errors. A no-op with a current token shall not advance revision.
3.3 Success shall expose the complete committed snapshot; changed state shall
advance revision exactly once. Returned objects shall not mutate internal state.
3.4 New-store identity shall invalidate tokens from deleted/reprovisioned state.
Restart shall retain persisted identity/revision. Revision overflow shall reject.
3.5 Ambiguous mutation outcomes shall not be retried automatically; clients shall
refetch. This version shall not promise exactly-once delivery or replay history.

## 4. Bounded durability and recovery

As an operator I want acknowledged records to survive restart, with honest errors.

4.1 Versioned state shall live in its own operator-data file in existing stateDir;
never in scanner or access stores. One local process shall own the file for its
lifetime; simultaneous writers shall fail closed. No network/shared filesystem
or cross-host lock guarantee shall be claimed.
4.2 Writes shall validate the whole proposed state, bound encoded bytes, sync a
same-directory temporary file, rename atomically and sync the directory before
acknowledging/publishing. Newly created child directory entries shall also sync
the existing durable parent; no unsynced ancestor creation is supported. Memory shall be committed only after durable success.
4.3 Before-rename failure shall preserve prior visible state; uncertain outcomes
after rename shall latch unavailable until reopen and publish no success event.
No memory-only fallback shall acknowledge lost saved data as persisted.
4.4 Missing file shall create a durably initialized empty store; invalid,
oversized or unknown-version existing state shall not be overwritten or silently
replaced with defaults. Operator data may be unavailable while core continues.
4.5 Schema migrations shall be explicit version-to-version validated operations;
v1 shall accept only v1. There shall be no speculative unversioned/legacy import.
Future versions must preserve stable IDs and invalidate tokens when semantics
change, with offline backup/recovery before irreversible migration.
4.6 Limits shall cover record count, strings, frequencies/bandwidth, command
ranking, bytes, queued work and subscribers/transport output. Tests shall exercise
quota edges and failure stages. Startup reads shall bound allocation before JSON
parse; no unbounded readFile on external state.
4.7 Closing shall reject new work, drain accepted writes and release ownership;
leftover crash locks shall require explicit offline repair, never unsafe stealing.

## 5. Public API and synchronization

As a client implementer I want one precise REST/WS state contract.

5.1 REST shall provide a complete bounded snapshot and preset CRUD, typed preference
patch/reset and ranking report/reset, using common schemas/errors and preconditions.
Access admission shall reuse the mounted protected runtime, not a second authority.
5.2 WS shall use existing broadcaster/connection lifecycle. Subscribe shall deliver
a complete current snapshot followed by ordered complete replacement snapshots;
registration and initial capture shall be synchronous with respect to publication.
No feature-owned second event bus or durable replay shall be added. One injected
synchronous commit sink shall run inside the transaction boundary; delivery failure
shall not undo or misreport a durable mutation as a persistence failure.
5.3 Clients shall ignore older/duplicate revisions in the same store; store change
shall force replacement. Reconnect/resubscribe shall recover by snapshot rather
than replay. HTTP responses and WS updates may arrive in either order.
5.4 Snapshot/update payloads shall fit existing bounded WS frames; slow clients
shall use existing disconnect/cleanup. Subscription completion shall not leak
callbacks, queue unbounded snapshots or expose precommit state.
5.5 CLI/web mounting and acceptance shall verify simultaneous edits, reconnect,
restart, deletion and protected access before claiming end-to-end completion.
