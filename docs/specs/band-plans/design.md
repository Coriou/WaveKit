# Band plans and scan presets design (BP1, BP2)

Status: BP1 implemented server-side. BP2 ("Batch 2" sections at the end) implemented
server-side and accepted. See [requirements](requirements.md) and
[tasks](tasks.md).

## Authority audit

- `src/core/scanner/bandplan/{index,builtin}.ts` own the scanner's plans (`Bandplan
{id, region, name, ranges}`); `bandplansFor(region)` picks the EU or US variant and
  fills from `region: "all"`. Both files are hash-pinned by
  `tests/unit/repo/regional-isolation.test.ts`; BP1 imports them and never edits them.
- `GET /api/scanner/bandplans` returns `bandplansFor(region)`; job create accepts
  `bandplans` (≤16 ids) and `ranges` (≤64) (`src/api/routes/scanner-schemas.ts`). The
  scanner treats an absent `rasters`/`obwHz`/`protocols` like `[]`.
- `src/operator-data/` is the durability and transaction precedent. Today operator-data
  routes (reads and writes) are mounted only in protected mode
  (`src/api/server.ts`, `operatorMountIntent && accessController`), mutations re-check
  `authorizeMetadataMutation`. The regional registry is read-only and mounted in both
  modes under root admission. BP1 follows regional for reads and operator-data for writes.
- `packages/api-types` already holds runtime Zod schemas for mutable features
  (`operator-data.ts`, `access-*.ts`) and plain interfaces for read-only ones
  (`regional.ts`). BP1 does both: Zod for request bodies and persisted state, interfaces
  for read views. `src/core/bandplans/contract.ts` holds the in-core service interface,
  pure-function signatures and `BandPlansError`.
- `StationIdentity.effectiveCountry` is `station.country ?? null`; the scanner region is
  the startup `BandRegion`. BP1 reports both as context; the region picks the default pack.

## Module layout and ownership

| Path                                                  | Lane | Role                                                  |
| ----------------------------------------------------- | ---- | ----------------------------------------------------- |
| `packages/api-types/src/bandplans.ts`                 | done | Frozen DTOs, Zod schemas, limits, error codes         |
| `src/core/bandplans/contract.ts`                      | done | Frozen service interface, function types, error class |
| `src/core/bandplans/builtin-packs.ts`                 | A    | Read-only projection of `bandplansFor` per region     |
| `src/core/bandplans/resolve.ts`                       | A    | Pure resolver and edit application                    |
| `src/core/bandplans/domain.ts`                        | A    | Pure CAS transitions over `BandPlanState`             |
| `src/core/bandplans/storage.ts`                       | B    | Dedicated durable file, lock, latch                   |
| `src/core/bandplans/service.ts`                       | B    | `openBandPlanService`, views, bounded queue           |
| `src/core/bandplans/import/sdrpp.ts`                  | C    | Total SDR++ parser                                    |
| `src/core/bandplans/import/group-map.ts`              | C    | Display-group mapping                                 |
| `src/core/bandplans/presets.ts`                       | D    | Built-in presets, issues, preset to job body          |
| `src/api/routes/bandplans.ts`                         | D    | Unmounted Fastify plugin, inject tests on a fake      |
| `src/index.ts`, `src/api/server.ts`, docs, barrel, WS | M    | Composition and publication                           |

Tests live in `tests/unit/bandplans/` and `tests/unit/repo/bandplans-isolation.test.ts`.
`src/core/bandplans/` imports from the scanner only `../scanner/bandplan/index.js`
(`bandplansFor`, `resolveBandplan`) and types; no imports from operator-data, access,
regional or scanner services. No lane edits the contract files; a needed change is a
Main-approved contract amendment.

## Data model

All names below are exports of `packages/api-types/src/bandplans.ts`. Frequencies are
integer Hz in 1..100 GHz, inclusive edges, `startHz < endHz`. Text is trimmed, without
control characters, bounded in code points (names 80, channel names 40, skip reasons 80,
file names 128). Ids match `^[a-z][a-z0-9-]{0,63}$`.

- `Band`: id, name, edges, `group: DisplayGroup`, advisory `mode | bandwidthHz | stepHz`
  (nullable), `skip: {reason} | null`, `channels: BandChannel[]` (≤128; id, name,
  frequencyHz, ≤8 ASCII aliases, registryRef), `parentId` (same pack), `colourHint`
  (`#rrggbb` or null), `registryRef: {familyId,rowId} | null`, `scan: BandScan | null`
  (built-in only: `{bandplanId, ranges: ScanRange[]}`), `provenance: BandProvenance`.
- `BandPlanPack`: id, kind `builtin | imported`, name, region (built-in only), pack
  provenance, bands. The operator layer is the pseudo-pack `operator`.
- `PlanProvenance`: `builtin` | `imported {trust:"community-unverified", format,
sourceName, author, licence, importedAt, sha256}` | `operator`. `BandProvenance`:
  `builtin-cited {citations}` | `builtin` | `imported` | `operator`. Imported bands defer
  to their pack's provenance, so the details are stored once.
- `PlanStackEntry {packId, enabled}`; `BandEdit {packId, bandId, set, updatedAt}` with
  `set: BandEditFields` (partial, nonempty when stored; `hidden` is edit-only).
- `ScanPreset`: `BuiltinScanPreset {kind:"builtin", id, name, region, job}` or
  `OperatorScanPreset {kind:"operator", id: UUID, name, job, createdAt, updatedAt}`;
  `job: ScanPresetJob` has every key present, null/[] meaning unset.

### Persisted file v1

`<stateDir>/bandplans/state.json`, compact JSON validated by `bandPlanStateSchema`:

```json
{
	"version": 1,
	"storeId": "<uuid>",
	"revision": 0,
	"stack": null,
	"importedPacks": [],
	"operatorBands": [],
	"edits": [],
	"presets": []
}
```

`stack: null` follows the default. Arrays keep deterministic order: imported packs and
operator bands and presets by creation, edits sorted by `packId/bandId`. Built-in packs
and built-in presets are never persisted. The schema rejects duplicates, stack or edit
references to unknown packs, and more than 4 MiB of UTF-8. v1 accepts only v1.

## Built-in projection (lane A)

`projectBuiltinPacks()` returns, for each `BandRegion` in `EU US CA AU NZ JP CN` order, a
pack `builtin-<region lowercase>` named `Built-in (<REGION>)`, provenance `builtin`, with
one band per `bandplansFor(region)` plan, in that order: id and name from the plan; edges
min/max over the plan's ranges; `scan = {bandplanId, ranges}` deep-copied and frozen;
mode, bandwidth, step, skip, parent, colour hint and registry ref null; channels `[]`.
Packs are computed once and frozen; callers receive frozen objects.

Display group by plan id (unknown ids: `other`):

| Group          | Plan ids                         |
| -------------- | -------------------------------- |
| air            | airband                          |
| personal-radio | cb, pmr446, dpmr446              |
| ism-srd        | ism-169, ism-433, ism-868        |
| pagers         | pager-vhf                        |
| land-mobile    | vhf-land-mobile, uhf-land-mobile |
| amateur        | amateur-2m, amateur-70cm, aprs   |
| marine         | marine-vhf                       |

Citations are keyed by (variant region, plan id) and transcribe only the documents and
URLs already cited in `builtin.ts` comments: EU `airband` (Ofcom spectrum pricing, Ofcom
8.33 kHz explanation), EU `cb` (Ofcom IR 2027.2), EU `ism-169` and EU `pager-vhf` (ERC
Report 25), EU `pmr446` and EU `dpmr446` (ECC/DEC/(15)05). Those bands are
`builtin-cited`; all others (including the `all` variants) are `builtin`. A repository
test asserts every URL appears literally in `builtin.ts`.

## Resolution (lane A)

`resolveBandPlans(input)`:

1. Layers: layer 0 is `operatorBands`; then each enabled stack entry whose pack exists,
   numbered 1.. in stack order. Disabled or unknown entries contribute nothing.
2. Per band of layers ≥1, `applyBandEdit(band, edit, siblingIds)` overlays present edit
   fields (except `hidden`). If the edited edges are empty, both edge fields are ignored
   and `edge-conflict` is reported; a `parentId` not in `siblingIds` becomes null with
   `dangling-parent`. `editedFields` lists applied fields in `BAND_EDIT_FIELDS` order.
   `hidden: true` removes the band and adds its key to `hidden`.
3. Coverage `C_i` of layer i is the union of its visible bands' inclusive ranges.
4. Each visible band of layer i gets `segments = [start, end] \ (C_0 ∪ … ∪ C_{i-1})`
   over integer Hz (sorted, disjoint, inclusive). Empty segments: key goes to `shadowed`.
5. Output bands sort by first segment start, then layer, then key (code-unit order);
   `shadowed` and `hidden` sort by key. `orphanedEdits` lists edits whose pack exists but
   whose band id does not, sorted by key.

The resolver allocates O(n) per layer and sorts once per layer; it uses no clock,
randomness or I/O, and treats input as immutable.

## Domain transitions (lane A)

`transition(state, mutation, context, parsedImport)` first checks
`mutation.expected` against `{storeId, revision}` (else `BANDPLANS_CONFLICT` with the
current token), then applies:

| Mutation                                             | Effect and errors                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `set-stack`                                          | Store entries; unknown pack `NOT_FOUND`                                                            |
| `reset-stack`                                        | `stack = null`                                                                                     |
| `patch-band-edit`                                    | Band must exist in pack (`NOT_FOUND`); effective band must validate (`INVALID`); empty set removes |
| `reset-band-edits` / `reset-pack-edits`              | Remove the edit / all edits of the pack (orphans included)                                         |
| `create-operator-band`                               | Id `op-<hex12>`, provenance operator, scan null; parent must be an operator band; quota            |
| `replace-operator-band` / `delete-operator-band`     | Existing id only (`NOT_FOUND`); delete nulls children's `parentId`                                 |
| `commit-import`                                      | Needs `parsedImport`; new id `imported-<hex12>` or `replacesPackId` (`NOT_FOUND`); quota           |
| `delete-pack`                                        | Imported only; removes pack, its edits and stack entry                                             |
| `create-preset` / `replace-preset` / `delete-preset` | UUID ids; replace keeps id and `createdAt`                                                         |

Changed results increment the revision once (overflow rejects) and the whole proposed
state must pass `bandPlanStateSchema` (byte or count overflow: `BANDPLANS_QUOTA`). A
result deep-equal to the current state is a no-op (`changed: false`), including setting
the same edit value twice. Timestamps use `max(now, previous)` like operator-data.
Patch semantics: `set` keys overwrite, `reset` keys delete; the route supplies
`set: null` and `reset: []` when absent.

## SDR++ import (lane C)

Accepted shape (unknown keys ignored): top-level object with optional string
`name`, `country_name`, `country_code`, `author_name`, string-or-number `version`, and
`bands: Array<{name, type, start, end}>` (start/end Hz, finite numbers, rounded to
integers). `parseSdrppBandPlan(bytes, options)`:

1. `bytes.length > importFileBytes` → `IMPORT_TOO_LARGE`. SHA-256 of `bytes`.
2. Strip a UTF-8 BOM; `TextDecoder("utf-8", {fatal:true})` → `encoding`; `JSON.parse`
   inside try → `json`; non-object or missing `bands` array → `shape`;
   `bands.length > importRows` → `row-limit`.
3. Per row in file order: non-object or wrong field types → `malformed-row`; trimmed
   empty name → `unnamed`; control characters or >80 code points → `text-invalid`;
   `start ≥ end` → `invalid-edges`; outside 1..100 GHz → `out-of-range`; same
   name+edges as an accepted row → `duplicate`; beyond 512 accepted → `pack-band-limit`.
4. Band id: lowercase name, non `[a-z0-9]` runs to `-`, trimmed, at most 56 chars,
   prefixed `b-` unless it starts with a letter, `band` if empty; repeats get `-2`, `-3`
   in file order. `type` (trimmed, at most 64 chars) feeds the group map; a `type` that
   is a `#rrggbb` colour becomes the colour hint.
5. No accepted band → `empty`. Meta text fields are bounded the same way (invalid → null).

Every failure is `{ok:false, code, reason}`; the function wraps its body so no exception
escapes. Messages never include file content.

`mapImportGroup(sourceType, name, overrides)` precedence: operator override for the exact
`sourceType` → `override`; the frozen lowercase type table → `table`; name keyword table
(whole-word, case-insensitive) → `name-keyword`; else `other` / `fallback-other`. Lane C
freezes both tables in `group-map.ts` with a fixed vector test; they must at least cover
the SDR++ types amateur, broadcast, aviation, marine and the keywords PMR446, CB, ISM,
SRD, LPD, pager, POCSAG, airband, marine, AIS, amateur, ham, broadcast, DAB. A bare
"PMR" is not a keyword (it means PMR446 in France and land mobile elsewhere).

Commit (`commit-import`) re-decodes the base64, re-parses with the same overrides and
requires `preview.sha256 === previewSha256` (`IMPORT_MISMATCH`; BP2 replaces the token
with `previewDigest`, see "Batch 2: preview digest"). Unless
`keepColourHints`, stored colour hints are null. Name defaults to meta name, else file
name. With `addToStack`, the pack is appended to the stack (materializing the default
stack first when `stack` is null); a replaced pack keeps its stack position.

## Scan presets (lane D)

`builtinPresetsFor(region)` returns one preset per `bandplansFor(region)` plan, id
`builtin-<plan id>`, name = plan name, `job.bandplans = [id]`, all other job keys
null/[]; then fixed combinations, each emitted only when at least two of its ids resolve
in `region` and listing only the resolving ids:

| Id                                 | Name                 | Plan ids                    |
| ---------------------------------- | -------------------- | --------------------------- |
| `builtin-combo-ism-srd`            | ISM / SRD            | ism-433, ism-868, ism-169   |
| `builtin-combo-personal-radio`     | Personal radio       | pmr446, dpmr446, cb         |
| `builtin-combo-land-mobile-marine` | Land mobile + Marine | vhf-land-mobile, marine-vhf |

`presetToJobSpec(preset)` returns `{name: preset.name, ...}` (no `kind`, `sourceId` or
tuner fields: the client adds those) with each non-null scalar and each non-empty array copied; ranges keep their full form
(`[]` is equivalent to absent for the scanner); exclusions drop a null reason.
`presetIssuesFor(preset, region)` lists bandplan ids for which
`resolveBandplan(id, region)` is undefined. No preset call creates a job.

## Service (lane B)

`openBandPlanService(options: BandPlanServiceOptions): Promise<BandPlanService>` from
`contract.ts`:

```ts
interface BandPlanService {
	view(): BandPlanStackView
	resolved(): ResolvedBandPlanView
	pack(packId: string): BandPlanPackView
	presets(): ScanPresetListView
	presetJob(presetId: string): ScanPresetJobView
	previewImport(request: unknown): ImportPreview
	mutate(input: unknown): Promise<BandPlanMutationResult>
	close(): Promise<void>
}
```

Open never rejects for storage reasons: a storage open failure (lock held, invalid,
oversized, unknown version, parent-sync failure) yields an unavailable service that
serves built-ins (4.2, 8.4). `mutate` rejects synchronously-detected problems before
admission: closing or unavailable, missing `expected` (`PRECONDITION_REQUIRED`), schema
(`INVALID`), request bytes (`QUOTA`), import decode/parse (for `commit-import`, done
before admission), queue full (one active plus 16 waiting, `BUSY`). Inside the queue:
availability recheck, `transition`, persist if changed, swap, then the synchronous
`onCommit({storeId, revision})` with the operator-data delivery semantics (`sent`,
`failed`, `unmounted`, `not-needed`; sink failure never fails the mutation). Views
are built from the last committed state, are detached copies and memoize resolution per
revision. `writable` is copied into `capabilities`.

## Storage (lane B)

A dedicated copy of the operator-data storage design at `<stateDir>/bandplans/`
(`state.json`, `.writer-lock/`): existing durable `stateDir` only, child created 0700 and
parent synced, files 0600 with ownership and type checks, bounded read of at most
`stateBytes + 1` before parse, exclusive random temp, write, fsync, close, rename, dir
fsync; before-rename failure keeps prior state, after-rename failure latches
unavailable until reopen; atomic mkdir lock for the process lifetime, no stealing; close
drains admitted work then releases the lock. No shared helper module with operator-data
(no generic store abstraction); no automatic migration. Mode checks compare permission
bits only (`0o777`), so a setgid parent does not make the store unavailable.

When `writable` is false (legacy mode) the store opens read-only: no mkdir, no lock, no
init write and no temp sweep. An existing `state.json` gets the same checks and bounded
read; a missing one serves an in-memory empty state reported `available` with the nil
UUID as `storeId` (never persisted; no write route is mounted). BP2 reports that state as
`storeId: null` instead (see "Batch 2: store identity"). A writable open sweeps
leftover `.state-*.tmp` files under the lock. The additive option
`onStoreUnavailable(reason)` reports a fixed token (`lock-held`, `invalid`, `oversized`,
`permissions`, `io`) once when open ends unavailable and once on an after-rename latch;
core logs it at warn level.

## REST (lane D plugin, Main mounts)

`bandPlanRoutes: FastifyPluginAsync<{service: BandPlanService; authorizeMutation?:
(request: FastifyRequest) => DeniedAdmission | undefined}>`. Without
`authorizeMutation`, only GET routes register (legacy mode). Mutation bodies are objects
with only the listed keys; the route adds `type` and path ids, then calls
`authorizeMutation` immediately before the synchronous `service.mutate` call, as
operator-data does. Responses for mutations are `BandPlanWriteDto {view, createdId}`.

| Method and path                                          | Body keys                   | OK  |
| -------------------------------------------------------- | --------------------------- | --- |
| GET `/api/bandplans`                                     |                             | 200 |
| GET `/api/bandplans/resolved`                            |                             | 200 |
| GET `/api/bandplans/packs/:packId`                       |                             | 200 |
| GET `/api/bandplans/presets`                             |                             | 200 |
| GET `/api/bandplans/presets/:presetId/job`               |                             | 200 |
| PUT `/api/bandplans/stack`                               | expected, entries           | 200 |
| DELETE `/api/bandplans/stack`                            | expected                    | 200 |
| PATCH `/api/bandplans/packs/:packId/bands/:bandId/edit`  | expected, set?, reset?      | 200 |
| DELETE `/api/bandplans/packs/:packId/bands/:bandId/edit` | expected                    | 200 |
| DELETE `/api/bandplans/packs/:packId/edits`              | expected                    | 200 |
| DELETE `/api/bandplans/packs/:packId`                    | expected                    | 200 |
| POST `/api/bandplans/operator-bands`                     | expected, band              | 201 |
| PUT `/api/bandplans/operator-bands/:bandId`              | expected, band              | 200 |
| DELETE `/api/bandplans/operator-bands/:bandId`           | expected                    | 200 |
| POST `/api/bandplans/imports/preview`                    | `ImportPreviewRequest` keys | 200 |
| POST `/api/bandplans/imports`                            | `ImportCommitRequest` keys  | 201 |
| POST `/api/bandplans/presets`                            | expected, preset            | 201 |
| PUT `/api/bandplans/presets/:presetId`                   | expected, preset            | 200 |
| DELETE `/api/bandplans/presets/:presetId`                | expected                    | 200 |

Built-in ids on write paths (`builtin-*` pack delete, `builtin-*` preset replace or
delete) return `BANDPLANS_READ_ONLY` before body validation; `operator` as an edit pack
is `BANDPLANS_INVALID`. Import preview is a POST under mutation admission (large body)
that persists nothing. Body limits: `requestBytes` (64 KiB), import routes
`importRequestBytes` (1.5 MiB). Fastify body-too-large maps to `BANDPLANS_QUOTA`, or
`BANDPLANS_IMPORT_TOO_LARGE` on import routes; other 4xx parser errors to `INVALID`.

Errors use `{error:"BandPlansError", code, message, details?}` with the canonical messages
and statuses in `BANDPLANS_ERROR_DEFINITIONS`: INVALID 400, PRECONDITION_REQUIRED 428,
CONFLICT 409 with `details.current`, NOT_FOUND 404, READ_ONLY 409, QUOTA 409,
IMPORT_TOO_LARGE 413, IMPORT_INVALID 422, IMPORT_MISMATCH 409, BUSY 503, UNAVAILABLE 503.
The precondition is the body token (as operator-data), not an `If-Match` header; 409 not
412 for the same reason.

## WebSocket (optional, Main)

Channel `bandplans`, event `bandplans:changed`, data `BandPlansChangedEventData
{storeId, revision}`; on subscribe the current token when available. Notices carry no
state, so frames stay small regardless of pack size; clients refetch and ignore older
revisions of the same store. Without WS, clients poll or refetch after their own writes.

## Correctness properties

1. **Resolver determinism**: equal inputs (any map insertion order) give deep-equal
   output; input is unchanged; no exception for any schema-valid state (4.6, 5.6).
2. **Precedence**: no segment of a layer-i band contains a frequency covered by a
   visible band of a layer j < i (4.3, 4.4).
3. **Fall-through**: every frequency covered by some visible band of a considered layer
   is in some output segment; disabling an entry equals removing it (4.1, 4.4, 5.8).
4. **Segment shape**: segments are nonempty, sorted, disjoint and inside effective band
   edges; within-layer overlaps are not clipped (4.4, 4.5).
5. **Edit round-trip**: set then reset of the same fields, or reset-band-edits, restores
   the unedited resolution; pack reset removes exactly that pack's edits (5.1–5.4).
6. **Edit survival**: replacing a pack keeps edits of surviving ids applied and reports
   the rest orphaned, never applied elsewhere (5.5, 5.6).
7. **CAS and revision**: stale tokens change nothing; changed commits increment once;
   no-ops never increment; same-token competing writes yield at most one success (8.2).
8. **Durability and latch**: acknowledgment follows file and directory sync; injected
   pre-rename failures keep state; post-rename failures latch unavailable (8.1, 8.3).
9. **Unavailable degradation**: an unavailable store serves built-ins, default stack and
   built-in presets and rejects every mutation (8.4).
10. **Importer totality and bounds**: for arbitrary bytes the parser returns a result
    without throwing; accepted bands validate; counts sum to `rowsTotal`; equal bytes give
    equal previews and ids (6.2–6.4, 6.7, 6.8).
11. **Group mapping totality**: every (type, name, overrides) maps to one display group;
    report counts sum to `accepted`; overrides always win (3.1, 6.5).
12. **Preview-commit equivalence**: committing bytes whose preview was shown stores
    exactly the preview's bands; different bytes reject (6.6).
13. **Preset to job validity**: every built-in preset in every region, and every valid
    operator preset, maps to a body accepted by `scanJobSpecSchema`; built-in bandplan ids
    resolve; operator issues equal unresolved ids (7.1–7.4).
14. **Projection fidelity**: built-in band scan ranges deep-equal `bandplansFor` ranges;
    every current plan id has an explicit group; citation URLs occur in `builtin.ts`
    (2.1–2.4, 1.3).
15. **Authority isolation**: pinned blobs unchanged after all service operations; module
    imports confined (1.1, 1.2, 10.2).

Property 15 and the citation part of 14 are repository tests; 8 uses real temporary
directories with injected storage stages; the rest are fast-check properties with at
least 100 runs and the trace comment `// Feature: band-plans, Property N: <name>`.

## Open points recorded for Main

- Reads in legacy mode deliberately differ from operator-data (which mounts nothing in
  legacy). Band plans are display metadata; writes stay protected-only.
- The SDR++ group and keyword tables are lane C's frozen data; they are display mapping,
  not frequency data. Country packs, URL import and "Check for update" need new data
  research and are not in BP1.

## Batch 2 (BP2) overview

User decisions: the scanner takes built-in plan data only, the stack chooses which
built-in packs apply, and hiding a built-in band removes its plan; `skip`, imported and
operator bands stay display-only. No CLI or web change. The four pinned scanner files
and both isolation hash tables stay unchanged. Main decisions: `GET
/api/scanner/bandplans` serves the effective list (1.1 amended); built-in presets keep
region-derived ids but are validated against the effective list; `storeId` is nullable
on the available store; a new `previewDigest` field, `sha256` stays the file hash; a new
stack applies at the next job create, patch (re-preview) or preview; a resume
(explicit, automatic or boot restore) keeps the admitted plans and a running sweep is
never changed.

| Path                                                  | Lane | Role                                               |
| ----------------------------------------------------- | ---- | -------------------------------------------------- |
| `packages/api-types/src/bandplans.ts`, `contract.ts`  | done | Amended contract (BP2 step 0)                      |
| `src/core/bandplans/scanner-feed.ts`                  | S    | Pure `resolveScannerBandplans`                     |
| `src/core/bandplans/presets.ts`                       | S    | `presetIssuesFor` with optional `effectiveIds`     |
| `src/core/scanner/plan/plan-preview.ts`               | S    | Lookups through `PreviewContext.bandplans`         |
| `src/core/bandplans/{domain,service,storage}.ts`      | C    | `previewDigestFor`, digest checks, `storeId: null` |
| `src/core/bandplans/import/sdrpp.ts`, routes plugin   | C    | Contract follow-ups only                           |
| `src/api/websocket/bandplans-broadcast-adapter.ts`    | W    | Port factory, commit sink, subscribe snapshot      |
| scanner-service, `src/index.ts`, server, events, docs | M    | Provider, composition order, channel mount, docs   |

## Batch 2: scanner feed (lane S)

`resolveScannerBandplans(view: BandPlanStackView): readonly Bandplan[]`
(`ResolveScannerBandplans` in `contract.ts`) in `src/core/bandplans/scanner-feed.ts`:

1. Built-in pack regions come from `view.packs` (`kind: "builtin"`, `region` non-null).
2. Hidden keys are the `packId/bandId` of `view.edits` whose `set.hidden` is `true`.
3. For each `view.stack.entries` entry with `enabled` whose pack is built-in, in order:
   for each plan of `bandplansFor(region)` in order, skip it when its key is hidden or
   its id was already emitted, else emit the plan object as returned by `bandplansFor`.
4. Return the list. Nothing else of the view is read.

The feed uses the stack view, not `ResolvedBandPlanView`: shadowed bands drop out of the
resolved view's `bands` without their layer, and operator coverage must not remove a
plan. Plans are the scanner's own objects (exact ranges with rasters, OBW and protocols,
the variant `region` and the original name), so an edited name or edges never reach the
scanner. Under the default stack the result is `bandplansFor(region)` element by element.
If the operator disables every built-in pack, or stacks only imported packs, the list is
empty: plan-id jobs and presets then report `range-empty` / not applicable, explicit
ranges still scan (without host inheritance).

`src/core/bandplans/` keeps importing only `../scanner/bandplan/index.js` and types from
the scanner. The scanner never imports `src/core/bandplans/`: it receives a provider.

## Batch 2: scanner integration (lane S module, Main splice)

- `PreviewContext` gains optional `bandplans?: readonly Bandplan[]`. `plan-preview.ts`
  uses `ctx.bandplans ?? bandplansFor(ctx.region)` for both the host-range list and the
  plan-id lookup (`find` by id); the issue text and code are unchanged. Absent, the
  output is identical to BP1.
- `ScannerServiceDeps` gains optional `bandplans?: () => readonly Bandplan[]` (structural
  `ScannerBandplanProvider`), default `() => bandplansFor(this.deps.region)`. The
  service reads it at `bandplans()` (`GET /api/scanner/bandplans`), in the preview
  context builder, and in `createIdentifyDriver`; it never caches the result across
  calls. Running and resumed jobs keep their admitted plans: resume and boot restore
  replan the persisted normalised spec and never resolve plan ids again. Identify
  priors come from the effective ranges, so a hidden band also drops its priors.
- `createScannerBandplanProvider(getView, region, onError?)` in `scanner-feed.ts` is
  the provider: `resolveScannerBandplans(getView())`, or `bandplansFor(region)` when
  `getView` returns undefined or throws (then `onError`). `src/index.ts` constructs the
  scanner before the band-plan service opens, so it passes a late-bound
  `() => bandPlanService?.view()` and logs `onError` (11.5).
- Built-in presets: `presetIssuesFor(preset, region, effectiveIds?)`; with the set, an
  id is an issue iff absent from it. The service takes the set from an injected optional
  `scannerBandplans` dependency over its own current view (wired in the barrel), so
  `applicable` and `/presets/:id/job` issues follow the effective list. Built-in preset
  ids and job bodies stay region-derived (7.1, 7.4).

## Batch 2: preview digest (lane C)

`previewDigestFor(fileSha256, groupOverrides)` (`PreviewDigestFor`, pure, in
`domain.ts`): lowercase hex SHA-256 of the UTF-8 bytes of
`JSON.stringify({v: 1, sha256: fileSha256, groupOverrides: [[sourceType, group], ...]})`
with pairs sorted by `sourceType` in code-unit order (override source types are unique
by schema). `ImportPreview` gains `previewDigest`; the parser's preview
(`ParsedImportPreview`) omits it and the service adds it in `previewImport` from the
request's overrides. `importCommitFieldsSchema` replaces `previewSha256` with
`previewDigest`. `service.prepare` and the `commit-import` transition both recompute the
digest from the presented bytes and overrides and reject a mismatch with
`BANDPLANS_IMPORT_MISMATCH` before any state change. The contract step left a stub
(`previewDigest = sha256`) so the tree stays green until lane C lands.

## Batch 2: store identity (lane C)

`AvailableBandPlanStore.storeId` is `string | null`. Storage keeps its internal state
schema (a UUID) but reports whether the served state is persisted; the service maps the
never-persisted read-only empty state to `storeId: null`, and the resolution memo key
uses a distinct token for it. Any other available store, legacy read-only over an
existing file included, reports its persisted UUID. A null store only exists with `writable`
false, so no write route is mounted and `mutate` keeps its BP1 rejection. `BANDPLAN_READ_ONLY_EMPTY_STORE_ID` stops appearing in views.

## Batch 2: change notice (lane W adapter, Main splice)

`src/api/websocket/bandplans-broadcast-adapter.ts`, modelled on
`src/operator-data/broadcast-adapter.ts`:

- `createBandPlansBroadcastPort(transport, onPublishFailure)`: `BandPlansBroadcastPort`
  over a structural transport with `broadcast("bandplans", message)` and
  `sendToClients("bandplans", ids, message)`, sending `BandPlansServerMessage`
  `{type: "bandplans:changed", channel: "bandplans", data}`. A throwing broadcast calls
  `onPublishFailure` (Main: invalidate the channel's clients); `sendSnapshot` is true
  iff exactly one client accepted.
- `createBandPlansCommitSink(port)`: the service's `onCommit`, copying the token.
- `sendBandPlansSnapshot(service, port, clientId)`: `"unavailable"` when the service is
  absent or its store unavailable, else the current `{storeId, revision}` (null storeId
  allowed) and `"sent"` or `"rejected"`; Main invalidates the client on `"rejected"`.

Main adds `"bandplans"` to `WebSocketChannel`, `isValidChannel` and the `ServerMessage`
union, mounts the channel in both access modes (socket-level adoption applies in
protected mode), exposes `ApiServer.getBandPlansBroadcastPort()` and observes the
channel for subscribe snapshots. `src/index.ts` opens the service with a late-bound
`onCommit` that forwards to the sink once the server exists.

## Batch 2 correctness properties

16. **Default scanner parity**: for every `BandRegion`, a default stack view (store
    unavailable, or available with no stack and no edits) gives a feed deep-equal to
    `bandplansFor(region)`, element order included; preview output with
    `ctx.bandplans = bandplansFor(region)` equals output without it (11.2, 11.4, 1.1).
17. **Hidden removal**: hiding a built-in band of an enabled entry removes that plan
    unless another enabled built-in entry supplies the same id; unhiding restores the
    list; imported packs, operator bands, `skip` and other edit fields never change it
    (11.1).
18. **Feed shape**: ids are unique; each plan deep-equals the `bandplansFor` plan of its
    entry's region; order is stack order then plan order; disabled and imported entries
    contribute nothing; the feed never throws (11.1, 11.5).
19. **Preset applicability**: with `effectiveIds`, a preset's issues are exactly its
    plan ids absent from the effective list; without it, BP1 behaviour (11.6, 7.3).
20. **Preview digest binding**: equal bytes with permuted overrides give equal digests;
    different bytes or a different override set give a different digest; a commit with
    a mismatched digest rejects `BANDPLANS_IMPORT_MISMATCH` and changes nothing (11.7).
21. **Store identity**: `storeId` is null iff the state is the never-persisted
    read-only empty state; writable and file-backed opens report the file's UUID
    (11.8).
22. **Change notice**: exactly one notice per changed commit carrying the new token,
    none for no-op or rejected mutations; the subscribe snapshot equals the current
    view's token and is not sent for an unavailable store; a throwing transport never
    fails the mutation (11.9).
