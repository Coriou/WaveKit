# Web gaps 4 tasks (WG4)

Status: 0.1 done (contract frozen); lane tasks not started. See [requirements](requirements.md)
and [design](design.md). Lanes T, D, S, A, X and ST work in parallel against the frozen
contract and touch only their own paths; Main (MA.\*) owns the composition files
(`src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`, `config/*`), the frozen
contract files (`src/core/activity/storage/contract.ts`, `src/core/activity/runtime.ts`,
`src/core/{station,station-estimate,storage-report}/contract.ts`), `packages/**` (except
lane X's SDR host status route), the scanner files and the docs. No lane edits the pinned
band-plan files, the isolation tests or `docs/CLI-COORDINATION.md`. Every lane runs its
touched tests, `pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: trails DTOs and bounds, the optional query-service method,
      storage DTOs and provider types, the `agc` key, `fixAt`, the SDR host `version`, the
      station provenance `ui`, update and estimate DTOs, `stationOrigins`, the station write
      constant and contract, the server dependency slots.
  - _Requirements: 1.1, 1.4, 2.1, 3.1, 4.1, 5.3, 5.5, 6.3, 6.9_

## Lane T: bulk trails

- [ ] T.1 `query/trails.ts` (SQL, greedy newest-first acceptance, validation of stored
      positions) and the `read.ts` request kind; benchmark.
  - _Requirements: 1.3–1.6, 1.8_
  - **Property 1: Trails model**, **Property 2: Trails truncation keeps the newest**
- [ ] T.2 `service.ts` `trails()` (validation, admission, `trailsDeadlineMs`) and
      `GET /api/activity/trails` in `routes/activity.ts`.
  - _Requirements: 1.1, 1.2, 1.7_

## Lane D: approximate station location

- [ ] D.1 `station-estimate/` estimator (pure) and cached provider; benchmark.
  - _Requirements: 2.2–2.7, 2.9_
  - **Property 3: Estimate equivariance**, **Property 4: Estimate bounds**
- [ ] D.2 `GET /api/station/estimate` and the no-import test.
  - _Requirements: 2.1, 2.8_

## Lane S: storage report

- [ ] S.1 `storage-report/` bounded scanner, statfs, cache and single-flight; benchmark.
  - _Requirements: 3.2–3.6_
  - **Property 5: Storage totals**
- [ ] S.2 `GET /api/storage`.
  - _Requirements: 3.1, 3.7_

## Lane A: live audio AGC

- [ ] A.1 Golden stage lists, `effectiveAgc`, planner stages.
  - _Requirements: 4.2, 4.3, 4.6_
  - **Property 6: AGC planner**
- [ ] A.2 Live demodulator status and the PATCH/route schemas.
  - _Requirements: 4.1, 4.4, 4.5, 4.7_

## Lane X: decoder details

- [ ] X.1 AIS channel in the adapter (NMEA and JSON) and the end-to-end provenance test.
  - _Requirements: 5.1, 5.2_
  - **Property 7: AIS channel normalisation**
- [ ] X.2 Mesh `fixAt` and the mesh route position schema.
  - _Requirements: 5.3, 5.6_
  - **Property 8: Mesh fix time**
- [ ] X.3 SDR host version constant and drift test; poller pass-through and the resources
      route schema.
  - _Requirements: 5.4–5.6_
  - **Property 9: Poller hostility**

## Lane ST: station write layer

- [ ] ST.1 `station/` store and service (layers, precedence, serialised writes, corrupt
      handling).
  - _Requirements: 6.1–6.7, 6.11_
  - **Property 10: Station precedence**, **Property 11: Station store**
- [ ] ST.2 Coverage `setStation`.
  - _Requirements: 6.10_
  - **Property 12: Coverage reset**
- [ ] ST.3 Live GET and PATCH in `routes/station.ts`, tests under both values of
      `STATION_WRITE_REQUIRES_ACCESS`.
  - _Requirements: 6.8, 6.9_

## Main

- [ ] MA.1 Resolve requirement 6.9 with the user decision (keep or flip the constant; update
      the spec wording).
  - _Requirements: 6.9_
- [ ] MA.2 Merge the lanes; wire the providers, routes, station service, readsb location,
      start-up country and coverage; make `trails` required; access policy check.
  - _Requirements: 7.1, 7.2_
- [ ] MA.3 Docs and the coordination note.
  - _Requirements: 7.3_
- [ ] MA.4 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 8.1, 8.2_
