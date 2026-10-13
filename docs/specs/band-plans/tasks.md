# Band plans and scan presets tasks (BP1, BP2)

Status: batch 1 implemented server-side (lanes A to D, Main M.1 to M.5); two
independent review rounds, approved. Batch 2 (scanner feed, preview digest, store
identity, WS change notice) is implemented server-side (lanes S, C, W, Main M2.1 to
M2.5), pending acceptance (M2.6). Client consumers (CLI, web) remain open. See [requirements](requirements.md) and
[design](design.md). Lanes A to D work in parallel against the frozen contract files and
touch only their own paths; Main (M) composes, mounts and publishes. Every lane runs its
touched tests, `pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: `packages/api-types/src/bandplans.ts` (DTOs, Zod
      schemas, limits, errors) with its barrel line, and `src/core/bandplans/contract.ts`
      (service interface, function types, `BandPlansError`).
  - _Requirements: 2.1–9.3_

## Lane A: domain, resolver, built-in projection

- [x] A.1 `builtin-packs.ts`: `projectBuiltinPacks`, `builtinPackIdFor`, `builtinGroupFor`,
      citation table transcribed from `builtin.ts` comments; frozen output.
  - _Requirements: 1.3, 2.1–2.4, 3.1_
  - **Property 14: Projection fidelity**
- [x] A.2 `resolve.ts`: `applyBandEdit` and `resolveBandPlans` exactly as designed.
  - _Requirements: 4.1–4.6, 5.1, 5.6, 5.8_
  - **Property 1: Resolver determinism**, **Property 2: Precedence**,
    **Property 3: Fall-through**, **Property 4: Segment shape**
- [x] A.3 `domain.ts`: pure `transition` for every mutation type, CAS, quotas,
      no-op detection, edit validation against the target band, orphan retention.
  - _Requirements: 4.2, 5.2–5.7, 6.6, 6.8, 7.2, 8.2, 8.5_
  - **Property 5: Edit round-trip**, **Property 6: Edit survival**,
    **Property 7: CAS and revision** (pure part)
- [x] A.4 `tests/unit/repo/bandplans-isolation.test.ts`: pinned blobs, import
      confinement of `src/core/bandplans/`, citation URLs present in `builtin.ts`.
  - _Requirements: 1.1, 10.2_
  - **Property 15: Authority isolation**

## Lane B: storage and service

- [x] B.1 `storage.ts`: dedicated `<stateDir>/bandplans/` storage per the operator-data
      durability design; injected stage failures; restart and invalid-state tests on real
      temporary directories.
  - _Requirements: 8.1, 8.3, 8.5_
  - **Property 8: Durability and latch**
- [x] B.2 `service.ts`: `openBandPlanService`, views, bounded queue, synchronous
      `onCommit`, unavailable degradation, close/drain. Composes A, C and D modules; until
      they land, tests use the contract signatures with local stubs. Depends on A.3, B.1.
  - _Requirements: 4.2, 6.6, 8.2, 8.4, 9.2, 9.3_
  - **Property 7: CAS and revision**, **Property 9: Unavailable degradation**,
    **Property 12: Preview-commit equivalence** (with C.1)

## Lane C: SDR++ importer and group map

- [x] C.1 `import/sdrpp.ts`: total `parseSdrppBandPlan` with size check, strict UTF-8,
      row validation and skip counting, deterministic ids, colour hints, SHA-256.
  - _Requirements: 3.2, 3.4, 6.1–6.4, 6.7, 6.8_
  - **Property 10: Importer totality and bounds**
- [x] C.2 `import/group-map.ts`: frozen type and keyword tables, `mapImportGroup`, report
      aggregation; fixed-vector test of both tables.
  - _Requirements: 3.1, 6.5_
  - **Property 11: Group mapping totality**

## Lane D: presets and route plugin

- [x] D.1 `presets.ts`: `builtinPresetsFor`, `presetIssuesFor`, `presetToJobSpec`;
      validate outputs with the real `scanJobSpecSchema` through Fastify's Ajv.
  - _Requirements: 7.1–7.4_
  - **Property 13: Preset to job validity**
- [x] D.2 `src/api/routes/bandplans.ts`: unmounted `bandPlanRoutes` plugin with
      `fastify.inject` tests on a fake `BandPlanService`: every route, key filtering,
      path-id validation, read-only ids, 428/409/413/422/503 mapping, body limits, GET-only
      registration without `authorizeMutation`, denial before admission.
  - _Requirements: 2.5, 9.1, 9.2_

## Checkpoint

- [x] 1. Foundation checkpoint: all lane tests, root typecheck and lint pass; independent
     review of the merged lanes; no mounted or end-to-end claim.
  - _Requirements: 1–8, 10_

## Main (M)

- [x] M.1 `src/core/bandplans/index.ts` barrel exporting `openBandPlanService`, the plugin
      types and the contract.
- [x] M.2 `src/index.ts`: open the service in both access modes with the scanner's
      region, `station.country`, `writable = protectedMode`; register drain-before-close
      ownership like operator-data; storage failure never stops core.
  - _Requirements: 8.4, 9.2_
- [x] M.3 `src/api/server.ts`: register `bandPlanRoutes`; pass `authorizeMutation` only
      with the access controller; optional `bandplans` WS channel and `bandplans:changed`
      notices. Mounted protected and legacy composition tests.
  - _Requirements: 9.1–9.3_
- [x] M.4 Docs: `docs/API.md` band-plan section; `docs/SCANNER.md` note that the scanner
      still uses built-in plans and presets only produce job bodies; `docs/ROADMAP.md` item 3
      progress (settings store and country-from-location remain open).
  - _Requirements: 1.1, 9.1_
- [x] M.5 Acceptance checkpoint: full root suite, typecheck, lint, build, pinned-blob
      test; reconcile spec status. CLI and web consumers are a later allocation.
  - _Requirements: 1–10_

## Batch 2 (BP2)

Lanes S, C and W work in parallel against the amended contract files and touch only
their own paths; Main (M) splices the shared seams serially. No CLI or web task. No lane
edits the four pinned files, either isolation test, `docs/CLI-COORDINATION.md` or the
contract files.

- [x] 2.0 Amend the contract: `ImportPreview.previewDigest`, commit `previewDigest`
      (replaces `previewSha256`), `ImportGroupOverride`, nullable
      `AvailableBandPlanStore.storeId` and `BandPlansChangedEventData.storeId`,
      `BANDPLANS_WS_CHANNEL`, `BANDPLANS_CHANGED_EVENT`, `BandPlansServerMessage`; in
      `contract.ts` `ParsedImportPreview`, `ResolveScannerBandplans`,
      `ScannerBandplanProvider`, `PreviewDigestFor`, `BandPlansBroadcastPort`,
      `BandPlansCommitSink`, `SendBandPlansSnapshot`, optional `effectiveIds` on
      `PresetIssuesFor`; compile-only follow-ups with a `previewDigest = sha256` stub.
  - _Requirements: 11.1–11.9_

### Lane S: scanner feed, presets, plan preview

- [x] S.1 `src/core/bandplans/scanner-feed.ts`: `resolveScannerBandplans` exactly as
      designed; tests in `tests/unit/core/bandplans/scanner-feed.test.ts`, including the
      parity test over every `BandRegion` (pure views and a legacy-open service view).
  - _Requirements: 11.1, 11.2, 11.5_
  - **Property 16: Default scanner parity**, **Property 17: Hidden removal**,
    **Property 18: Feed shape**
- [x] S.2 `src/core/bandplans/presets.ts`: optional `effectiveIds` in `presetIssuesFor`;
      `builtinPresetsFor` and `presetToJobSpec` unchanged.
  - _Requirements: 7.3, 11.6_
  - **Property 19: Preset applicability**
- [x] S.3 `src/core/scanner/plan/plan-preview.ts`: optional `PreviewContext.bandplans`
      for host ranges and plan-id lookup; identity without it; tests under
      `tests/unit/core/scanner/plan/`.
  - _Requirements: 11.2, 11.4_
  - **Property 16: Default scanner parity** (preview part)

### Lane C: preview digest and store identity

- [x] C.1 `previewDigestFor` in `domain.ts`; digest in `service.previewImport`;
      verification in `service.prepare` and the `commit-import` transition; remove the
      contract-step stub; route plugin and its tests follow the field name.
  - _Requirements: 6.6, 11.7_
  - **Property 20: Preview digest binding**
- [x] C.2 `storeId: null` for the never-persisted read-only state across storage,
      service views and the resolution memo; optional `scannerBandplans` service
      dependency feeding `effectiveIds` to `presetIssuesFor`.
  - _Requirements: 11.6, 11.8_
  - **Property 21: Store identity**

### Lane W: change-notice adapter

- [x] W.1 `src/api/websocket/bandplans-broadcast-adapter.ts`: port factory, commit sink,
      subscribe snapshot; tests on a fake transport and a fake service.
  - _Requirements: 9.3, 11.9_
  - **Property 22: Change notice** (adapter part)

### Main (M2), serial after the lanes

- [x] M2.1 `src/core/bandplans/index.ts`: export `resolveScannerBandplans`, wire
      `scannerBandplans` into the service deps; add `./scanner-feed.js` to the
      isolation test's allowed imports (no hash change).
  - _Requirements: 10.2, 11.6_
- [x] M2.2 `scanner-service.ts`: `bandplans` provider in `ScannerServiceDeps`, used by
      `bandplans()`, the preview context and `createIdentifyDriver`.
  - _Requirements: 11.3, 11.4, 11.5_
- [x] M2.3 `src/index.ts`: late-bound scanner provider with the `bandplansFor` fallback;
      late-bound `onCommit` sink set after the API server exists.
  - _Requirements: 11.3, 11.5, 11.9_
- [x] M2.4 `events.ts` channel, `isValidChannel`, `ServerMessage`; `server.ts`
      `getBandPlansBroadcastPort()` and channel observer in both modes; composition
      tests (subscribe snapshot, notice after a protected write, legacy snapshot).
  - _Requirements: 11.9_
  - **Property 22: Change notice** (end to end)
- [x] M2.5 Docs: `docs/API.md` (previewDigest, nullable storeId, `bandplans` channel,
      effective `GET /api/scanner/bandplans`, preset applicability), `docs/SCANNER.md`,
      `docs/ROADMAP.md` item 3; spec status lines and ticks.
  - _Requirements: 1.1, 11.1–11.10_
- [ ] M2.6 Acceptance: one review round, full root suite, typecheck, lint, build,
      pinned-blob tests unchanged.
  - _Requirements: 10, 11_
