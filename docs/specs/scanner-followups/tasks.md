# Scanner follow-ups tasks (SF1)

Status: contract frozen (0.1); lanes R and D and the Main tasks are open. See
[requirements](requirements.md) and [design](design.md). Lanes R and D work in parallel
against the frozen contract and touch only their own paths; Main (M) owns
`src/core/scanner/scanner-service.ts`, the composition files, the contract files and the
docs, and works serially after the lanes. No lane edits the pinned band-plan files, the
isolation tests or `docs/CLI-COORDINATION.md`. Every lane runs its touched tests,
`pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: range fields, `signalsOnly`, `Hop.dwellMs`, the two plan
      issue codes and `ScanJob.preemptedBy` in both type copies; JSON schemas (range
      fields, `signalsOnly`, discovery `identity`); persisted schemas;
      `src/core/scanner/plan/range-contract.ts`; `CfarMaskRange` in the spectrum types and
      worker protocol.
  - _Requirements: 1.1–6.3_

## Lane R: range edits, per-range plan fields, signals only

- [ ] R.1 `src/core/scanner/plan/range-edits.ts` (new): `applyRangePatch` implementing
      `ApplyRangePatch`; tests in `tests/unit/core/scanner/plan/range-edits.test.ts`.
  - _Requirements: 1.2, 1.3, 1.4_
  - **Property 1: Locked fields**
- [ ] R.2 `plan-preview.ts`: copy the new range fields (`copyRange`, `toJobSpec`),
      overlay `rangeLive`, normalise `enabled`, enabled-only consumers, all-disabled
      `range-empty`, per-range `dwell-too-short`, provenance keys, `signalsOnly`
      normalisation and `signals-only-unsupported`, per-hop sweep period; `protocols.ts`
      enabled-only unions; `hop-planner.ts` (or a `planForSpec` post-pass) `hop.dwellMs`.
  - _Requirements: 1.5, 1.6, 2.1–2.4, 2.6–2.8, 3.1, 3.4, 3.5, 8.1_
  - **Property 2: Disabled exclusion**, **Property 3: Neutral defaults**,
    **Property 4: Hop dwell**, **Property 5: Protocol precedence**
- [ ] R.3 `scheduler.ts`: per-hop dwell in `dwellSamples`; `job-runner.ts`: enabled-only
      `covers`, signals-only confirm and probe guard.
  - _Requirements: 2.2, 2.3, 3.2, 3.3_
  - **Property 6: Signals only**

## Lane D: identity search, per-range CFAR target

- [ ] D.1 `discovery-store.ts`: `DiscoveryFilter.identity`, identity filter, `q` over
      label or identity value.
  - _Requirements: 5.2, 5.3, 5.4_
  - **Property 8: Identity filter**, **Property 9: q superset**
- [ ] D.2 `src/api/routes/scanner.ts` (discovery query only): `identity` in
      `DiscoveryQuery` and `toFilter`; route tests for valid, unknown-kind and empty-value
      queries.
  - _Requirements: 5.1_
- [ ] D.3 `spectrum-engine.ts`: export `faTargetForSensitivity` (byte-identical
      `buildPipelineConfig`); `detector.ts` and `pipeline.ts`: per-range
      `faTargetPerMhzMin` from the CFAR masks.
  - _Requirements: 2.5_
  - **Property 7: Per-range target**

## Checkpoint

- [ ] C.1 Both lanes report green checks; Main reviews their diffs before splicing.

## Main (M), serial after the lanes

- [ ] M.1 `scanner-service.ts` `patchJob`: `ranges` through `applyRangePatch` into
      `rangeLive`, `signalsOnly` in the allowed keys.
  - _Requirements: 1.1–1.7, 3.1, 6.3_
- [ ] M.2 `scanner-service.ts` consumers: enabled-only `updateMasks` with per-range
      `faTargetPerMhzMin` (duplicate merge), `rastersAt`, `classifierContext`;
      signals-only specs left out of `protocolsFor`.
  - _Requirements: 2.2, 2.5, 3.3_
- [ ] M.3 `scanner-service.ts` `toDto`: `preemptedBy` via a pure helper; re-emit the
      preempted job when the holder is recorded or changes.
  - _Requirements: 4.1–4.3_
  - **Property 11: preemptedBy presence**
- [ ] M.4 Persistence and restore tests: new fields and `rangeLive` round trip, old-format
      records; boot restore keeps admitted plans after a hide.
  - _Requirements: 6.1–6.4_
  - **Property 10: Persistence round trip**
- [ ] M.5 Lease-holder property test: keep assertions and `numRuns: 100`, cut its cost.
  - _Requirements: 7.1_
- [ ] M.6 Docs: `docs/API.md` (PATCH `ranges`, `signalsOnly`, range fields,
      `preemptedBy`, discovery `identity` and `q`), `docs/SCANNER.md`, `docs/ROADMAP.md`
      item 4, append the CLI note to `docs/CLI-COORDINATION.md` (never Prettier); spec
      status lines and ticks.
  - _Requirements: 7.2_
