# Web gaps 5 tasks (WG5)

Status: 0.1 done; lane tasks in progress. See [requirements](requirements.md) and
[design](design.md). Lanes AG, TA, AIS, V and B work in parallel against the frozen contract
and touch only their own paths; Main (MA.\*) owns the composition files (`src/index.ts`,
`src/api/server.ts`, barrels including `src/core/bandplans/index.ts` and
`src/core/activity/query/index.ts`, `src/config.ts`, `config/*`), the frozen contract files
(`src/core/activity/storage/contract.ts`, `src/core/activity/runtime.ts`,
`src/core/bandplans/contract.ts`), `packages/**`, the scanner files and the docs. No lane
edits the pinned band-plan files, the isolation tests or `docs/CLI-COORDINATION.md`. Every
lane runs its touched tests, `pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: aggregate DTOs and bounds, the optional query-service methods,
      the vessel fields, the import formats and the parser slot, the `ShipData` names, the
      tuner source type.
  - _Requirements: 1.1–1.6, 2.1–2.3, 5.3, 5.5, 6.1, 7.1_

## Lane AG: Activity aggregates

- [ ] AG.1 `query/walk.ts` (the trails walk extracted, trails unchanged) and
      `query/aggregates.ts` (`readBandMap`, `readTimeline`) with the `read.ts` ops;
      `EXPLAIN QUERY PLAN` tests; benchmark.
  - _Requirements: 1.1, 1.3–1.7, 2.3–2.5, 3.2, 3.3_
  - **Property 1: Band map model**, **Property 2: Timeline model**, **Property 3: Aggregate
    walk bounds**
- [ ] AG.2 `service.ts` `bandMap()`/`timeline()` (validation, admission, deadline and wall
      budget keys) and the two routes in `routes/activity.ts`.
  - _Requirements: 1.2, 2.2, 3.1, 3.4, 3.5_

## Lane TA: trail altitude and mesh positions

- [ ] TA.1 Altitude helper and the aircraft, APRS and ship presenters.
  - _Requirements: 4.1–4.3, 4.5, 4.6_
  - **Property 4: Altitude**
- [ ] TA.2 Mesh position decode in the Meshtastic presenter.
  - _Requirements: 4.4, 4.6, 4.8_
  - **Property 5: Mesh position agreement**
- [ ] TA.3 Coalesced row bound 240 B, `altM` through `fitRowBudget`, golden maximum rows.
  - _Requirements: 4.7_
  - **Property 6: Row budget with altitude**

## Lane AIS: types 4, 9, 21 and the vessel channel

- [ ] AIS.1 Bit decoder for types 4, 9, 21; fixture encoders.
  - _Requirements: 5.1–5.3_
  - **Property 7: AIS round trip**, **Property 8: AIS truncation**
- [ ] AIS.2 JSON path with Zod and the new fields.
  - _Requirements: 5.4_
- [ ] AIS.3 Tracker `channel`, `aton`, `altitudeM`; vessel route schemas.
  - _Requirements: 5.5–5.7_
  - **Property 9: Vessel channel and class fields**

## Lane V: verified tuning trust

- [ ] V.1 Tuner snapshots, bind centres, the trust rule and the binding cache in
      `provenance-bindings.ts`; micro-benchmark.
  - _Requirements: 6.1–6.6_
  - **Property 10: Trust rule**

## Lane B: SDR# and Gqrx import

- [ ] B.1 `import/sdrsharp.ts` bounded XML parser and hostile-input tests.
  - _Requirements: 7.2–7.5_
- [ ] B.2 `import/gqrx.ts` bounded CSV parser.
  - _Requirements: 7.2–7.5_
- [ ] B.3 Provenance format from the file in `domain.ts`; service tests with injected parsers.
  - _Requirements: 7.1, 7.6_
  - **Property 11: Import totality**, **Property 12: Import round trip**

## Main

- [ ] MA.1 Merge the lanes; wire the tuner source (V) and the import parsers (B); make
      `bandMap` and `timeline` required and update the query-service fakes (AG); access
      policy check for the two GET routes.
  - _Requirements: 8.1, 8.2_
- [ ] MA.2 Docs (API.md, ROADMAP, coordination note) and the CLI grep.
  - _Requirements: 8.3_
- [ ] MA.3 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 9.1, 9.2_
