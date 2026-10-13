# Scanner follow-ups requirements (SF1)

Status: reviewed design; the shared contract (DTO, JSON schema and core type additions) is
frozen. Behaviour is not implemented yet. See [design](design.md) and [tasks](tasks.md).

## Scope

Server-side follow-ups to the signal discovery scanner (S1, `docs/SCANNER.md`) that the
web design branch (`docs/web/CORE-GAPS.md`, Scanner section) and `docs/ROADMAP.md` item 4
ask for: range edits in a running job, per-range name, dwell and sensitivity, a
signals-only job flag, the preempting job on a preempted job, and identity search over
discoveries. Two test gaps close with them: a boot-restore test for admitted band plans and
a lighter lease-holder property test.

Out of scope: CLI and web changes (the CLI gets a coordination note only); new
`ScannerProtocol` values; S2 and S3; per-range exclusions; changes to any scanner default,
built-in band plan, raster or prior; the files pinned by the band-plans spec
(`src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`,
`src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`).

## 1. Range edits in a running job

As an operator I want to switch ranges on and off and change their protocols while a scan
runs, without stopping it.

1.1 `PATCH /api/scanner/jobs/:id` shall accept `ranges`. Every other existing PATCH rule
stays (allowed keys, merge into the stored spec, preview first, 400
`SCANNER_PLAN_INVALID` on preview errors, 409 for ended and identify jobs).
1.2 A PATCH `ranges` array shall be index-aligned with the job's current `spec.ranges`
(the effective list: operator ranges, then band-plan ranges) and have the same length.
1.3 The live fields `enabled`, `protocols`, `name`, `dwellMs` and `sensitivity` of each
element shall replace the range's current live fields (full state: an absent live field
clears it).
1.4 The locked fields `startHz`, `endHz`, `rasters`, `obwHz` and `bandplanId` shall
deep-equal the current values (absent equals absent). A difference, or a length mismatch,
shall reject the PATCH with 400 `SCANNER_PLAN_INVALID` whose `details.issues` holds one
`range-locked` error per offending range, naming the index and the changed fields. Nothing
changes on a rejected PATCH.
1.5 An accepted range edit shall take effect at the next hop, like the other live keys,
and shall be visible at once in the job's `spec.ranges`, `plan` and `scanner:job` event.
1.6 A PATCH whose ranges leave no enabled range shall be rejected with a `range-empty`
error. A job with no ranges at all keeps today's behaviour.
1.7 A PATCH shall re-check the job's band-plan ids exactly as before (BP2): a plan no
longer in the effective list rejects the PATCH with `range-empty`.

## 2. Per-range fields

As an operator I want to label ranges and give some of them their own dwell and
sensitivity.

2.1 A range (create body, PATCH `ranges`, `spec.ranges`) may carry `enabled` (boolean),
`name` (1 to 100 characters), `dwellMs` (10 to 600000, the job-level bounds) and
`sensitivity` (`low`, `normal`, `high`).
2.2 A disabled range shall stay in `spec.ranges` with `enabled: false` and shall not be
planned, swept, masked, used for protocol selection, raster snapping or in-window
coverage. At create time, a job whose ranges are all disabled is rejected with
`range-empty`.
2.3 A hop shall dwell for the largest `dwellMs` of the enabled ranges it overlaps, taking
the job's `dwellMs` for an overlapping range without one. A hop overlapping no range with
`dwellMs` keeps the job's dwell. The plan's sweep period follows the per-hop dwell.
2.4 A sweep range whose `dwellMs` is below the job's minimum dwell shall give the existing
`dwell-too-short` error, naming the range index.
2.5 A range's `sensitivity` shall set the CFAR false-alarm target of that range with the
job-level mapping (`low`, `normal` = the settings value, `high`). Integration time stays
job-level. A range without `sensitivity` keeps today's target.
2.6 Range `protocols` keep today's precedence: an explicit job-level `protocols`
(including an explicit empty list) overrides every range; otherwise a signal or hop uses
the union of the enabled ranges covering it.
2.7 `name` is a label only; it shall change no plan, priority or detection.
2.8 A set per-range field shall add `operator` provenance under `ranges[<i>].<field>`; an
unset one adds no key.

## 3. Signals only

As an operator I want to find signals without spending decoders on them.

3.1 `ScanJobSpec.signalsOnly` (boolean, default absent = false) shall be accepted at
create and as a live PATCH key.
3.2 A signals-only job shall request no decoder trials of its own: no confirm, follow or
reconfirm probe, so no probe-driven voice recording.
3.3 Detection, classification, discoveries, observations, hold and revisit timing, PSD and
IQ evidence, burst captures, ambient decoder evidence and other jobs' probes shall be
unchanged. A signals-only job shall not widen another job's probe protocols.
3.4 `signalsOnly: true` on a `monitor` job shall give a `signals-only-unsupported` error.
3.5 `spec.signalsOnly` shall appear only when the operator set it; jobs without it shall
serialise as today.

## 4. Preempting job

As an operator I want to see which job took my sweep's tuner.

4.1 A job in `paused(preempted-job)` shall carry `preemptedBy: { jobId, name }` naming the
job that holds its source lease now (`name` null when that job has none).
4.2 `preemptedBy` shall be absent in every other state or reason, and when no other job
holds the lease.
4.3 `preemptedBy` shall be derived at read time, never persisted, and present in REST job
views and `scanner:job` events alike.

## 5. Identity search

As an operator I want to find discoveries by the identity a decoder reported.

5.1 `GET /api/scanner/discoveries` shall accept `identity=<kind>:<value>` with a known
`IdentityKind` and a non-empty value (at most 100 characters in total); anything else is
400 `VALIDATION_ERROR`.
5.2 The identity filter shall keep discoveries whose `identity.kind` equals the kind and
whose `identity.value` equals the value, compared case-insensitively after trimming.
5.3 `q` shall match the operator label or the identity value (case-insensitive substring).
Every discovery `q` matched before still matches.
5.4 Filters combine with AND; sort, cursor and limit behave as today.

## 6. Persistence and restore

6.1 The new range fields and `signalsOnly` shall persist with the job and survive a
restart; the restored plan shall honour them.
6.2 Jobs persisted before SF1 (no new fields) shall load and behave unchanged.
6.3 The live state of range edits shall persist with the stored spec, so a later PATCH
(of any key) keeps earlier range edits.
6.4 A test shall pin that a running or paused job restored at boot keeps its admitted plans
and plan after the band-plan stack hides one of them (BP2 follow-up).

## 7. Test reliability and coordination

7.1 The lease-holder property test ("keeps at most one lease holder per source", scanner
Property 16) shall keep `numRuns >= 100` and the same assertions, and shall finish well
inside its timeout under a loaded full-suite run.
7.2 `docs/CLI-COORDINATION.md` shall get an appended note announcing the resume contract
(`resumeAt`, `resumeHeldBy`, Stay here) and the SF1 additions for CLI follow-up. The file
is append-only and never Prettier-formatted.

## 8. Invariants

8.1 No scanner default, setting default, built-in plan, raster, prior or snapping rule
shall change; a job spec without the new fields shall preview, plan and run exactly as
before.
8.2 No CLI, web, Docker, Pi or RF change.
