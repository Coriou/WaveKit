# Band plans and scan presets requirements (BP1, BP2)

Status: BP1 (sections 1 to 10) implemented server-side. BP2 (section 11: scanner feed,
preview digest, store identity, change notice) specified against the amended contract,
not implemented. The shared contract is `packages/api-types/src/bandplans.ts` plus
`src/core/bandplans/contract.ts`. See [design](design.md) and [tasks](tasks.md).

## Scope

One operator, CLI and web, on a local/LAN core. BP1 adds a layered band-plan model for
display (spectrum lanes, Tuner band row, palette) with an operator edit layer, SDR++
import from uploaded bytes, and core scan presets. Owner direction: `docs/ROADMAP.md`
item 3 and the web design branch (`docs/web/CORE-GAPS.md` band plans and presets,
`docs/web/DESIGN.md` owner answers 1 to 8).

Out of scope, each its own later spec or batch: a general settings store with YAML,
environment and UI provenance; station country from coordinates (needs bundled boundary
data); the scanner consuming the resolved stack (BP2); country packs or any new frequency
data; numeric US FRS rows; URL fetch, "Check for update", SDR# XML and Gqrx CSV import;
bundled community packs; deriving "verified" from registry links. BP2 (section 11) brings
the scanner consumption of the stack into scope, limited to built-in plan data.

## 1. Authority isolation

As an operator I want band plans to label and organise the spectrum without silently
changing what the receiver, scanner or decoders do.

1.1 The scanner shall keep consuming today's built-in plan data from `bandplansFor`.
`src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`,
`src/core/scanner/bandplan/index.ts` and `src/core/scanner/bandplan/builtin.ts` shall stay
byte-identical; scanner defaults, ranges, rasters, priors and snapping shall not change.
_Amended by BP2:_ the scanner's plan list, including `GET /api/scanner/bandplans`, is the
effective scanner list of 11.1; under the default stack with no edits it equals
`bandplansFor(region)` (11.2).
1.2 No band-plan read or mutation shall tune, start or stop audio, decoders or scan jobs,
or change scanner settings, decoder band overrides, operator data or the regional
registry. Applying a scan preset shall remain a separate client call to the existing
scanner job API with its existing admission and arbitration.
1.3 BP1 shall add no frequency, channel, raster or regulatory data. Built-in packs are a
read-only projection of `BUILTIN_BANDPLANS`; tuning hints and channel lists of built-in
bands shall be null or empty.
1.4 The effective country shall remain `station.country ?? region` context only; core
shall not infer a country from coordinates.

## 2. Built-in packs

2.1 Core shall expose one read-only built-in pack per `BandRegion` (`builtin-eu` ...
`builtin-cn`) whose bands are exactly the plans of `bandplansFor(region)`, one band per
plan, band id = plan id, edges = minimum start and maximum end of the plan's ranges.
2.2 Each built-in band shall carry a read-only `scan` reference holding the plan id and
an exact copy of the plan's ranges, so BP2 can project without loss.
2.3 Each built-in band shall get a display group from a fixed table keyed by plan id;
an unmapped id shall map to `other`. Every plan id present today shall be mapped
explicitly.
2.4 A built-in band whose plan carries regulatory citations in `builtin.ts` shall have
provenance `builtin-cited` with those citations (title, URL); otherwise `builtin`.
2.5 Built-in packs, bands and presets shall reject every mutation with
`BANDPLANS_READ_ONLY`; operators change them only through the edit layer.

## 3. Display groups and provenance

3.1 Display groups shall be the closed set marine, air, ism-srd, pagers, personal-radio,
amateur, land-mobile, broadcast, other. Unknown imported categories shall map to other.
3.2 Pack provenance shall be `builtin`, `imported` or `operator`. Imported provenance shall
record format, source file name, optional author, optional licence, import time and the
SHA-256 of the file bytes, and shall always be `community-unverified`.
3.3 Bands may carry an optional regional-registry reference (family id, row id). BP1
shall store and return it unchanged and shall derive no verified state from it.
3.4 Imported colours shall be kept only as an optional `#rrggbb` hint, dropped unless the
operator opts in at commit.

## 4. Ordered stack and resolution

As an operator I want several plans active in my order, with my edits on top.

4.1 The stack shall be an ordered list of unique built-in or imported pack ids, each
with an enable switch, at most 16 entries. Index 0 is the highest stack layer.
4.2 When no stack is stored, the effective stack shall be the built-in pack of the
effective region, enabled, reported as `source: "default"`; resetting the stack shall
return to this state. Storing a stack shall report `source: "operator"`.
4.3 The operator layer (operator bands) shall sit above every stack entry.
4.4 Resolution shall consider the operator layer and enabled stack entries whose pack
exists. A band of a lower layer shall keep only the parts of its range not covered by
any visible band of a higher layer; gaps shall fall through. A fully covered band shall
be reported as shadowed, not dropped silently.
4.5 Bands within one layer may overlap or nest; resolution shall not clip them against
each other. Parent ids are display nesting within one pack only.
4.6 Resolution shall be a pure, total, deterministic function of packs, stack, operator
bands and edits; it shall never throw on stored data and never mutate its input.

## 5. Edit layer and operator bands

As an operator I want to rename, re-edge, regroup, hide and annotate bands, and reset.

5.1 Edits shall be field-level overrides keyed by (pack id, band id) for built-in and
imported bands. Present fields override; absent fields fall through to the pack.
5.2 Editable fields shall be name, start, end, group, mode, bandwidth, step, skip (with a
reason), channels, parent, colour hint, registry reference and hidden.
5.3 An edit patch shall set and/or reset named fields; a reset field shall fall through
again; an edit left with no fields shall be removed. Resetting a band shall remove its
edit; resetting a pack shall remove all its edits ("Reset to France").
5.4 A patch shall be accepted only for a band present in its pack and only if the
resulting effective band is valid. Setting a value equal to the pack value shall still be
stored and reported as edited.
5.5 When an imported pack is replaced, edits whose band id still exists shall keep
applying; others shall be kept and reported as orphaned, never applied to another band.
Deleting an imported pack shall delete its edits and remove it from the stack.
5.6 If a stored edit makes a band's edges empty after its pack changed, resolution shall
ignore the edge fields of that edit and report `edge-conflict`; a dangling parent shall
resolve to no parent and report `dangling-parent`.
5.7 Operators shall create, replace and delete their own bands (at most 256) in the
operator layer, with server-assigned ids and provenance `operator`.
5.8 Hidden bands shall not appear or shadow lower layers, and shall be listed as hidden.

## 6. SDR++ import

As an operator I want to bring a community SDR++ band plan in, see what it will do, then
commit it.

6.1 Import shall accept SDR++ band-plan JSON only, as uploaded file bytes (base64 in a
JSON body). Core shall fetch no URL.
6.2 Files larger than 1 MiB shall be rejected with `BANDPLANS_IMPORT_TOO_LARGE` before
decoding. Bytes shall be decoded as strict UTF-8 (a leading BOM ignored) and parsed once.
6.3 Parsing shall be a total function on bytes: every input yields a preview or a typed
error, never an exception, unbounded allocation or echoed file content.
6.4 Rows shall be validated one by one; invalid, unnamed, out-of-range, duplicate and
over-limit rows shall be skipped and counted by reason; a file with more than 4096 rows
or no usable band shall be rejected with `BANDPLANS_IMPORT_INVALID`.
6.5 Each accepted band shall get a display group by operator override, then the type
table, then name keywords, else other. The preview shall report per source type the
group, rule and count, plus mapped and to-other totals.
6.6 Preview shall persist nothing. Commit shall present the same bytes, the preview's
SHA-256 and the same overrides; a different file shall be rejected with
`BANDPLANS_IMPORT_MISMATCH`. _Amended by BP2:_ the commit token is the preview digest
of 11.7, which also binds the overrides. Commit may set name, author and licence, keep colour hints,
replace an existing imported pack (keeping its id and edits) and append to the stack.
6.7 Imported band ids shall be derived deterministically from names in file order, so
re-importing the same file yields the same ids.
6.8 At most 8 imported packs with at most 512 bands each shall be stored.

## 7. Scan presets

As an operator I want the same scan presets on every client.

7.1 Built-in presets shall be derived for the effective region: one per plan of
`bandplansFor(region)`, plus fixed combinations of existing plan ids that resolve in that
region. They shall be read-only; "Save as new" is a client copy into an operator preset.
7.2 Operator presets (at most 64) shall have a core-assigned UUID, a name and a closed
job description that is a subset of the scanner job create body (mode, bandplan ids,
ranges, exclusions, protocols, sensitivity, threshold, FFT size, integration, dwell,
settle) within the job schema's bounds; at least one bandplan or range is required.
7.3 Core shall map any preset to a scanner job create body without creating a job. A
preset naming a bandplan id unknown in the effective region shall be listed as not
applicable with its issues, not rewritten. _Amended by BP2:_ "unknown" means absent from
the effective scanner list (11.6).
7.4 Built-in preset mappings shall always be valid job bodies whose bandplan ids resolve
through `resolveBandplan(id, region)`.

## 8. Store, revisions and durability

8.1 Stored state (stack, imported packs, operator bands, edits, operator presets) shall
live in `<stateDir>/bandplans/state.json`, its own versioned file, with the same
durability as operator-data storage: private 0700/0600 modes, exclusive temporary file,
file sync, rename, directory sync, lifetime writer lock, post-rename failure latch,
bounded reads before parse, explicit schema version 1 and no generic store abstraction.
8.2 Every snapshot shall carry a store UUID and revision. Every mutation shall require the
exact current token in its body; stale tokens shall be rejected with the current token;
a current-token no-op shall not advance the revision.
8.3 A missing file shall be initialised durably; invalid, oversized or unknown-version
state shall be left untouched and the store reported unavailable.
8.4 When the store is unavailable, reads shall still serve built-in packs, the default
stack and built-in presets, marked `store: unavailable`; mutations shall fail with
`BANDPLANS_UNAVAILABLE`. Core shall continue running.
8.5 Limits shall cover state bytes (4 MiB), request bytes (64 KiB; 1.5 MiB for import),
counts in 2.x to 7.x, waiting transactions (16) and the revision range.

## 9. API, access and notification

9.1 REST shall live under `/api/bandplans`, with complete bounded views, the error body
`{error, code, message, details?}` and the operator-data precondition style.
9.2 Reads shall be mounted in legacy and protected modes under the normal root
admission. Mutation and import routes shall be mounted only in protected mode and
re-authorized through the protected runtime immediately before admission, as
operator-data mutations are. Views shall report whether writes are mounted.
9.3 Core may publish a change notice `{storeId, revision}` on WebSocket channel
`bandplans` after each changed durable commit; clients refetch. Delivery failure shall
not undo or misreport a durable mutation. Wiring is Main's and optional for BP1.
_BP2:_ required, see 11.9.

## 10. Verification obligations

10.1 Property tests (fast-check, at least 100 runs, trace comments) shall cover the design
properties: resolver determinism, precedence, fall-through and segment shape; edit reset
round-trip; store CAS, revision and failure latch; importer totality and bounds; group
mapping totality; preset-to-job validity; built-in projection fidelity.
10.2 A repository test shall prove the four pinned files unchanged, every built-in
citation URL present in `builtin.ts`, and `src/core/bandplans/` importing from the
scanner only `bandplan/index.js`, `bandplan/builtin.js` and type modules.

## 11. Batch 2 (BP2): scanner feed, preview digest, store identity, change notice

As an operator I want the band-plan stack I chose to decide which built-in plans the
scanner offers, hidden bands to leave the scanner, imports to bind what I previewed, and
clients to learn about changes without polling.

11.1 The effective scanner list shall be derived from the current stack view: for each
enabled stack entry, in stack order, whose pack is built-in, the plans of
`bandplansFor(<pack region>)` in that order, omitting a plan whose band carries a stored
`hidden: true` edit and any plan id already taken from a higher entry. Imported packs,
operator bands, `skip`, all other edit fields, segments and shadowing shall not change
the list.
11.2 With the default stack and no edits, including an unavailable store, the effective
scanner list shall deep-equal `bandplansFor(region)` for every `BandRegion`. The four
files pinned by 1.1 shall stay byte-identical, and scanner defaults, ranges, rasters,
priors and snapping shall not change.
11.3 The scanner shall read the effective scanner list when serving
`GET /api/scanner/bandplans`, when previewing or admitting a job (create, patch, resume
and passive jobs) and when creating an identify driver. A running sweep shall keep the
plans it was admitted with; a change shall apply at the next admission, patch or resume.
11.4 Job plan ids and the host ranges that operator ranges inherit rasters, OBW,
protocols and plan id from shall resolve against the effective scanner list. An id that
is not in it shall be reported as `range-empty`, as an id unknown in the region is today.
11.5 Until the band-plan service is open, and whenever reading the stack view throws, the
scanner shall use `bandplansFor(region)`. A band-plan failure shall never stop the
scanner or core.
11.6 Built-in presets shall stay region-derived (7.1, 7.4). Preset issues and
`applicable` shall be computed against the effective scanner list.
11.7 Import preview shall return `previewDigest`, a SHA-256 that binds the file bytes and
the set of group overrides, independent of override order; `sha256` shall remain the
hash of the file bytes. Commit shall present `previewDigest` (replacing
`previewSha256`); any other bytes or overrides shall be rejected with
`BANDPLANS_IMPORT_MISMATCH` and change nothing.
11.8 An available store shall report `storeId: null` if and only if the served state is
the never-persisted in-memory empty state of a read-only (legacy) open without
`state.json`; otherwise it shall report the persisted UUID. No view shall expose the nil
UUID. An unavailable store stays `{state: "unavailable"}`.
11.9 Core shall publish `bandplans:changed` `{storeId, revision}` on WebSocket channel
`bandplans` after each changed durable commit, and to a subscribing client the current
token when the store is available (nothing when unavailable). The channel shall be
mounted in legacy and protected modes under the normal socket admission. No-op and
rejected mutations publish nothing; a delivery failure shall not undo or misreport the
mutation, and a transport failure shall invalidate the channel's clients so they refetch.
11.10 BP2 shall change no CLI or web client, add no frequency data and edit none of the
files pinned by 1.1.
11.11 Property tests (fast-check, at least 100 runs, trace comments) shall cover design
properties 16 to 22, including the scanner parity of 11.2 for every `BandRegion`.
