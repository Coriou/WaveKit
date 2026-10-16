# Web gaps 8 tasks (WG8)

Status: lanes ST, DP, RC and SB merged; Main wiring (MA.1) and docs (MA.2) done; checkpoint
(MA.3) open. See [requirements](requirements.md) and [design](design.md). Lanes work against the frozen contract
and touch only their own paths; Main (MA.\*) owns the composition files (`src/index.ts`,
`src/api/server.ts`, barrels, `src/config.ts`, `config/*`), the frozen contract files
(`packages/**`, `src/decoders/settings/contract.ts`, `src/core/spectrum/subscribe-options.ts`,
`src/core/scanner/types.ts`, `src/decoders/types.ts`), `src/core/scanner/scanner-service.ts`,
`src/core/digital-voice.ts`, the storage report, the isolation and contract tests and the docs.
No lane edits the pinned band-plan files or `docs/CLI-COORDINATION.md`. Every lane runs its
touched tests, `pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: decoder settings DTOs, bounds, error codes, the access switch,
      the `patchable` descriptor field and the ST/DP ports; the recordings inventory DTOs, id
      pattern, bounds and access switch; the bins cap setting, choices, budgets and the
      `SpectrumLimits.binsCap` view; the `spectrumBinsCap` config key.
  - _Requirements: 1.1, 1.3, 2.1–2.3, 2.6–2.8, 4.1, 4.3, 4.4, 4.6, 5.2–5.4_

## Lane ST: settings store, layers, patch policy

- [x] ST.1 `store.ts` (load, quarantine, seeded revision, atomic serialised writes, bounds) and
      `layers.ts` (effective config, view).
  - _Requirements: 1.1–1.6, 2.7_
  - **Property 1: Override layering**, **Property 2: Store round trip and fail closed**,
    **Property 5: View hides non-patchable values**
- [x] ST.2 `patch-policy.ts` and the `patchable` allowlist in `src/decoders/options/*.ts`;
      `service.ts`.
  - _Requirements: 2.2–2.6, 2.8_
  - **Property 3: Patchable by meaning**, **Property 4: Unrelated issues never fail a patch**

## Lane DP: decoder PATCH and rebuild

- [x] DP.1 Manager staging, rebuild at the next start, `decoder:created` replacement, failure
      path; listener audit.
  - _Requirements: 3.1–3.4_
  - **Property 6: Rebuild equals fresh create**
- [x] DP.2 Routes: protected GET settings and PATCH, legacy 501 unchanged, body limit, If-Match,
      error mapping, descriptor schema `patchable`.
  - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.8_
  - **Property 7: Legacy unchanged**

## Lane RC: recordings inventory

- [x] RC.1 Sources, scan, RIFF header, cache, items, paging; benchmark.
  - _Requirements: 4.2–4.4, 4.6, 4.7_
  - **Property 8: Inventory eligibility**, **Property 9: Paging is a partition**,
    **Property 10: RIFF duration**
- [x] RC.2 `recordingRoutes`: authorize, lease, whole-file download, errors.
  - _Requirements: 4.1, 4.5, 4.7_

## Lane SB: spectrum bins above 2 048

- [x] SB.1 int16 half-dB worker wire, worker cap 8 192; benchmark.
  - _Requirements: 5.1_
  - **Property 11: Lossless wire**
- [x] SB.2 `bin-cap.ts` and its use by the service and engine (clamp, limits, summary budget);
      other summary readers.
  - _Requirements: 5.2–5.6_
  - **Property 12: Cap choice**, **Property 13: Default profile unchanged**

## Main

- [x] MA.1 Merge the lanes; wiring in `src/index.ts`, `src/api/server.ts`, `scanner-service.ts`,
      `src/config.ts` and the storage report; rebuild listeners; contract test updates.
  - _Requirements: 7.1_
- [x] MA.2 Docs (API.md, SCANNER.md, ROADMAP, coordination note for the CLI and the web session)
      and the CLI grep. (The activity-recording-catalog, band-plans, web-gaps-4, web-gaps-6 and
      web-gaps-7 amendment notes are in the spec commit.)
  - _Requirements: 6.1, 6.2, 7.2_
- [ ] MA.3 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 8.1, 8.2_
