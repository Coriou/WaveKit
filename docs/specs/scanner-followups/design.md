# Scanner follow-ups design (SF1)

Status: implemented server-side as designed. Requirements in
[requirements](requirements.md), tasks in [tasks](tasks.md). Background: `docs/SCANNER.md`,
the S1 design (`docs/superpowers/specs/2026-10-09-signal-discovery-scanner-design.md`) and
the band-plans spec ([BP2](../band-plans/design.md)).

## Contract (frozen)

| File                                                                                | Addition                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/scanner.ts`, `src/core/scanner/types.ts` (identical copies) | `ScanRange.enabled`, `name`, `dwellMs`, `sensitivity`; `ScanJobSpec.signalsOnly`; `NormalisedJobSpec.signalsOnly?`; `Hop.dwellMs?`; `PlanIssueCode` `range-locked`, `signals-only-unsupported`; DTO only: `ScanJob.preemptedBy?` |
| `src/core/scanner/plan/range-contract.ts` (new)                                     | `RANGE_LIVE_FIELDS`, `RANGE_LOCKED_FIELDS`, `RANGE_NAME_MAX`, `ScanRangeLive`, `StoredScanJobSpec` (`rangeLive?`), `ApplyRangePatch`, `isRangeEnabled`                                                                           |
| `src/api/routes/scanner-schemas.ts`                                                 | range `enabled`, `name` (1 to 100), `dwellMs` (10 to 600000), `sensitivity`; job `signalsOnly`; discovery query `identity` with `IDENTITY_QUERY`                                                                                 |
| `src/core/scanner/store/persistence.ts`                                             | optional range fields and `signalsOnly` in the persisted schemas; `rawSpec: StoredScanJobSpec`                                                                                                                                   |
| `src/core/spectrum/types.ts`, `worker-protocol.ts`, `spectrum-engine.ts`            | `CfarMaskRange` (`FreqRange` + optional `faTargetPerMhzMin`) for the `masks` input and `EngineMasks.cfarRanges`                                                                                                                  |
| `src/core/scanner/job-runner.ts`, `plan/plan-preview.ts`                            | `JobRecord.rawSpec`, `normaliseSpec` and `previewPlan` take `StoredScanJobSpec`                                                                                                                                                  |

Every addition is optional, so existing callers, fixtures and persisted files are
unchanged. `preemptedBy` exists only in the api-types `ScanJob`; the core has no copy.

## Range edits

### Index alignment and storage

The job's effective range list is `spec.ranges`: operator ranges in body order, then each
band plan's ranges (`normaliseSpec`). A PATCH `ranges` refers to that list by index. Band-plan
ranges are not in the stored `rawSpec.ranges`, so edits cannot be written there. Instead
Main stores the validated live snapshot as `rawSpec.rangeLive` (`StoredScanJobSpec`), an
array index-aligned with the effective list. Clients never send `rangeLive`; the create
and PATCH schemas reject it (`additionalProperties: false`).

`normaliseSpec` builds the effective list as today (operator ranges with inherited host
fields, then plan ranges), then, when `rangeLive` is present:

- each entry (`StoredRangeLive`) carries the live keys plus the locked identity of the
  range it was written for (`startHz`, `endHz`, `bandplanId` when set); Main adds the
  identity from `job.spec.ranges[i]` when it stores a validated PATCH;
- an entry applies to the range at its index only when that range has the same identity:
  delete the five live keys from the range and copy the defined keys of the entry;
- entries that do not match (the plan list changed under a stored job: a range added,
  removed or moved), and entries beyond the list, are dropped. One `range-locked`
  **warning** `{ reason: "range-live-stale", dropped, expected, received }` reports them;
  it is never an error, so later PATCHes of any key succeed. A PATCH `ranges` against the
  current list replaces the whole stored snapshot;
- an entry without `startHz`/`endHz` (written before the identity existed, never released)
  matches by index while the counts agree;
- a restored job is not re-normalised (restore uses the persisted normalised spec), so it
  keeps running on its admitted ranges (BP2 rule).

Amended after the integration review (R1 finding 1); the frozen contract gained the
additive `StoredRangeLive` type (`rangeLive?: StoredRangeLive[]`, assignable from the
original `ScanRangeLive[]`). The `range-locked` error remains for the ranges sent in a
PATCH (`applyRangePatch`).

Because `rawSpec.bandplans` stays, every later PATCH re-checks plan ids as in BP2 (1.7).

### PATCH validation (`applyRangePatch`, lane R)

`applyRangePatch(current = job.spec.ranges, patch)` is pure and total:

1. `patch.length !== current.length`: one issue `range-locked`, error, message "a running
   job's ranges cannot be added or removed", details
   `{ reason: "range-count", expected, received }`; `rangeLive: []`.
2. For each index, compare the locked fields with deep equality (`rasters` element-wise
   `spacingHz`/`firstChannelHz` in order; `obwHz` in order; absent equals absent, an empty
   array is not absent). Each index with differences gives one issue `range-locked`,
   error, message "range <i>: <fields> cannot change while the job exists; stop it to
   change edges or channel spacing", details `{ index, fields }` with the field names in
   `RANGE_LOCKED_FIELDS` order.
3. No issue: `rangeLive[i]` = the defined live keys of `patch[i]` (`protocols` copied).

The route converts the `spacingHz` shorthand to `rasters` before the service sees the body,
so a client should send back the `rasters` it read; a shorthand whose derived raster
differs is a locked change.

Main's `patchJob` with `patch.ranges !== undefined`: run `applyRangePatch`, reject its
error issues through the existing `rejectErrors` (400 `SCANNER_PLAN_INVALID`,
`details.issues`), then set `merged.rangeLive` and never merge `patch.ranges` into
`merged.ranges`. The merged spec is previewed as today; preview errors (for example 1.6)
reject the PATCH and nothing is stored. On success `driver.replan` applies the new plan at
the next hop boundary (scheduler `replan`, unchanged).

### Disabled ranges

`isRangeEnabled(r)` (`r.enabled !== false`) is the only test. Normalisation keeps
`enabled: false` on disabled ranges and drops `enabled: true` (absent = enabled), so an
explicit `true` is not stored. Consumers use enabled ranges only:

- plan-preview: range validation (`range-empty` for inverted ranges,
  `range-outside-tuner`) still runs on every range, because locked fields were admitted
  at create; `all-excluded`, the auto-mode window fit, `not-in-window`, the sweep's
  "needs at least one range" check, `planForSpec` input, protocol unions and hop protocol
  estimates use enabled ranges;
- when `ranges.length > 0` and no range is enabled: one `range-empty` error "every range
  is disabled" `{ disabled: n }` in both modes (an in-window job with no enabled range
  would otherwise widen to the whole window);
- `protocols.ts` (`protocolsForFrequency`, `protocolsForHop`), `job-runner.covers`;
- Main: `updateMasks` (CFAR, burst, raster and OBW masks), `rastersAt`,
  `classifierContext` band protocols.

## Per-range dwell

Planner (`hop-planner.ts` or a post-pass in `planForSpec`): for each hop, the overlapping
enabled ranges are those with `r.endHz >= hop.covered.startHz && r.startHz <=
hop.covered.endHz` (the `protocolsInRange` predicate). When at least one of them sets
`dwellMs`, `hop.dwellMs = max(r.dwellMs ?? spec.dwellMs)` over them; otherwise the key is
absent. Plans of specs without per-range dwell are byte-identical to today.

Scheduler: `dwellSamples()` uses the current hop's `dwellMs ?? spec.dwellMs`; the
`minSurfaceBlocks` floor stays. Sweep period (`plan-preview.ts`):
`sum(hopDwell) + revisits * mean(hopDwell)`, equal to today's
`(hops + revisits) * dwellMs` when no hop has its own dwell.

Validation: in sweep mode an enabled range with `dwellMs < minimumDwell` gives the
existing `dwell-too-short` error with details `{ minimumMs, rangeIndex }`. In-window jobs
ignore per-range dwell, as they ignore the job dwell. Provenance `ranges[<i>].dwellMs` =
`operator` when set.

## Per-range sensitivity

Today `sensitivity` selects both integration time and the CFAR false-alarm target
(`buildPipelineConfig`: `low` 0.25, `normal` = `detection.faTargetPerMhzMin`, `high` 2 per
MHz per minute). Integration is engine-wide, so per range only the false-alarm target is
honoured; the job sensitivity still selects integration. Lane D exports
`faTargetForSensitivity(sensitivity, settingsFa)` from `spectrum-engine.ts` (used by
`buildPipelineConfig`, byte-identical) and makes the detector honour
`CfarMaskRange.faTargetPerMhzMin` per CFAR range (rate adaptation of `k` uses the range's
target, else the pipeline's). Main's `updateMasks` sets `faTargetPerMhzMin` on a CFAR
range only when the range sets `sensitivity`; identical `start:end` ranges from several
jobs merge to the largest target (most sensitive). Partial overlaps keep today's
first-match rule. Provenance `ranges[<i>].sensitivity` = `operator` when set.

## Name

`name` is copied through normalisation, `toJobSpec` and persistence; nothing else reads
it. Provenance `ranges[<i>].name` = `operator` when set.

## Protocol precedence

Unchanged and documented in `docs/SCANNER.md`: an operator job-level `protocols`
(provenance `operator`, including `[]`) overrides every range; otherwise the union of the
covering enabled ranges' protocols applies, per signal at runtime and per hop in the
preview. Editing a range's `protocols` while job-level `protocols` is set changes the
stored range but has no runtime effect until the job-level key is cleared; this design does
not add a way to clear a job-level key by PATCH.

## Signals only

- Normalisation: `signalsOnly` is copied when the operator set it (`true` or `false`),
  provenance `signalsOnly` = `operator`; absent otherwise. A `monitor` job with
  `signalsOnly: true` gets `signals-only-unsupported` (error, "monitor jobs need decoders").
- Job runner (`onTrack`): the confirm decision is `needsConfirm && spec.signalsOnly !==
true`; with it false the runner neither requests a probe nor holds for confirmation,
  exactly the path of a track that needs no confirmation today. `requestProbe` also
  returns `null` for a signals-only job (guard against other call paths).
- Main `protocolsFor`: specs with `signalsOnly === true` are left out of the selection
  union, so their "all protocols" never widens another job's probes.
- Unchanged: detection, classification and its priors, discoveries and observations,
  evidence and captures (a capture with `onlyDecoded` simply never fires for this job),
  ambient decoder attribution, passive jobs, other jobs on the same frequency.
- Live PATCH key: `signalsOnly` joins the allowed list; the next track decision uses it;
  probes already running finish their hold.

## preemptedBy

Computed in Main's `toDto`: when `state === "paused" && reason === "preempted-job"` and
`arbiter.holder(spec.sourceId)` is a job other than this one, `preemptedBy = { jobId,
name }` from that job's record (`name` null when unset); otherwise absent. Never persisted.
Main emits the preempted job's `scanner:job` after the new holder is recorded (or emits it
again then), so the event carries the field; when the holder changes while the job stays
preempted, the paused job's view is re-emitted.

## Identity search

Route (lane D): `identity` passes the JSON schema (`IDENTITY_QUERY`), then `toFilter`
splits at the first colon into `{ kind, value }` with `value.trim()`; an empty value after
trimming is 400 `VALIDATION_ERROR` (sent through `sendError` as a `ZodError` or a
`ScannerApiError` with that code). `DiscoveryFilter.identity?: Identity`.

Store (lane D): identity filter: `d.identity?.kind === kind &&
d.identity.value.trim().toLowerCase() === value.toLowerCase()`. `q` (lower-cased once):
`label.includes(q) || (d.identity?.value ?? "").toLowerCase().includes(q)`. Metadata
lists (talkgroups, callsigns, capcodes) are not searched.

## Persistence and restore

- Persisted `spec` (normalised) carries the range fields, `signalsOnly` and the edited live
  state; restore re-plans from it with `planForSpec`, which honours enabled ranges and
  per-hop dwell.
- Persisted `rawSpec` carries `rangeLive`; the Zod check stays a plain-object check.
- Old files: every new key is optional in `ScanRangeSchema` and
  `NormalisedJobSpecSchema`, so they parse and plan exactly as before.

## Correctness properties

Each becomes a fast-check property test (`numRuns >= 100`) tagged
`// Feature: scanner-followups, Property N: <name>`.

1. **Locked fields**: for generated current ranges and patches, `applyRangePatch` returns
   no issue iff lengths match and every locked field deep-equals; each issue names exactly
   the differing fields of one index; with no issue, `rangeLive[i]` equals the live keys
   of `patch[i]` (1.2 to 1.4).
2. **Disabled exclusion**: the plan of a spec with some ranges disabled equals the plan of
   the same spec with those ranges removed (hops, covered spans, channel counts); all
   disabled gives `range-empty` (1.6, 2.2).
3. **Neutral defaults**: adding `enabled: true`, a `name`, or `dwellMs` equal to the job's
   dwell to any range leaves hops, sweep period, protocols and issues unchanged; a spec
   without new fields previews identically with and without `rangeLive` of absent keys
   (2.3, 2.7, 8.1).
4. **Hop dwell**: `hop.dwellMs` is absent iff no overlapping enabled range sets
   `dwellMs`, else the maximum as defined; sweep period equals the formula and today's
   value when no hop dwell is set (2.3).
5. **Protocol precedence**: operator job-level protocols always win; otherwise
   `protocolsForFrequency` equals the union of enabled covering ranges (2.6).
6. **Signals only**: for generated track sequences a signals-only runner issues no probe
   request; the same sequence without the flag gives today's requests (3.2, 3.3).
7. **Per-range target**: the detector's per-range rate adaptation uses the range target
   when set and the pipeline target otherwise; with no range target, `k` evolves exactly
   as today (2.5).
8. **Identity filter**: the result is exactly the discoveries with equal kind and
   case-insensitive equal value, intersected with the other filters (5.2, 5.4).
9. **q superset**: every discovery matched by the old label-only `q` is matched by the new
   `q`; the new `q` adds exactly identity-value matches (5.3).
10. **Persistence round trip**: a job with generated range fields, `signalsOnly` and
    `rangeLive` persists and restores with equal `spec`, `rawSpec` and plan; an old-format
    record restores unchanged (6.1 to 6.3).
11. **preemptedBy presence**: `preemptedBy` is present iff the job is
    `paused(preempted-job)` and another job holds the lease, and it names that holder
    (4.1, 4.2). Pinned with example tests on the service harness plus a fast-check property
    over the pure `toDto` derivation (a property over full service sequences would repeat
    the cost of Property 16).

The existing scanner Property 16 (one lease holder, best runnable sweep) keeps its
assertions and `numRuns: 100` (7.1).
