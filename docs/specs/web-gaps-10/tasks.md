# Web gaps 10 tasks (WG10)

Status: frozen for implementation. See [requirements](requirements.md) and [design](design.md).
Lanes work against the frozen contract and touch only their own paths; Main (MA.\*) owns the
composition files (`src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`, `config/*`),
the frozen contract files (`packages/**`, `src/core/recordings/contract.ts`,
`src/core/scanner/identify-analog-contract.ts`), `src/core/scanner/scanner-service.ts`,
`src/core/scanner/store/**`, `src/core/scanner/types.ts`, `src/core/digital-voice.ts`, the
storage report, the isolation and contract tests and the docs. No lane edits the pinned
band-plan files or `docs/CLI-COORDINATION.md`. Every lane runs its touched tests,
`pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: identify analog evidence DTO, trial decoder and reason widening,
      unavailable decoder list and memo bound; spectrum warning suspects and log interval; storage
      kept summary; live audio silence and swap bounds; recording delete progress names, sweep and
      alias bounds, keep totals, scanner deleter port; the identify analog evidence port.
  - _Requirements: 1.1, 1.5, 1.8, 1.9, 2.2, 2.3, 2.9, 3.1–3.5_

## Lane RK2: recording follow-ups

- [ ] RK2.1 Scanner recording delete through the coordinator (keep service `scannerDeleter`,
      `recording-delete.ts`, shared verified unlink with progress names); exact diffs for the
      evidence store, discovery store (`forgetRecording`) and scanner service, with tests.
  - _Requirements: 1.1–1.4, 1.11_
  - **Property 1: No scanner delete of a kept or unverified file**
- [ ] RK2.2 Merge aliases and eviction removal (exact store, evidence and scanner-service diffs);
      kept totals and `keptSummaryOf` with the reporter diff; startup delete leftover sweep;
      capture store staging cleanup.
  - _Requirements: 1.5–1.10_
  - **Property 2: Aliases keep meaning**, **Property 3: Sweep touches only provable leftovers**

## Lane SM: smooth live audio, squelch and tuning trust

- [ ] SM.1 Clients survive restarts; silence fill; offset change by front swap with fallback;
      stand-in harness with before and after gap numbers.
  - _Requirements: 2.1–2.5_
  - **Property 4: Clients stay, time stays filled**, **Property 5: Offset swap keeps the back**
- [ ] SM.2 Carrier-aware auto floor (quieting observer, auto nfm/wfm only); overload check.
  - _Requirements: 2.6, 2.7_
  - **Property 6: A carrier never seeds the floor**
- [ ] SM.3 Operator frequency proves the rate once per connection; untracked-retune root cause,
      in-core fixes, classifiers, warning fields and log rate limit.
  - _Requirements: 2.8–2.10_
  - **Property 7: Rate written once, only when unproven**, **Property 8: Alarm classification**

## Lane ID: identify for analog voice

- [ ] ID.1 Analog evidence log and identify analog trials, verdict and result fields.
  - _Requirements: 3.1–3.4, 3.6_
  - **Property 9: Analog evidence fails closed**
- [ ] ID.2 Unavailable decoder memo and `decodersUnavailable`; startup pre-connect log minors
      (spectrum service; scanner service as an exact diff).
  - _Requirements: 3.5, 4.2_
  - **Property 10: Memo is honest**

## Main

- [ ] MA.1 Merge the lanes; wiring in `src/index.ts` (scanner deleter, sweep, kept summary,
      analog evidence); apply the lanes' scanner-service, store and reporter diffs with their
      tests; contract test updates.
  - _Requirements: 1.1, 1.5, 1.6, 1.8, 1.9, 3.1, 4.2, 5.1_
- [ ] MA.2 Docs (API.md: scanner recording delete, kept totals, identify analog result and
      `decodersUnavailable`, warning fields, operator rate write, live audio continuity; ROADMAP;
      SCANNER; coordination note for the CLI and the web session) and the CLI grep.
  - _Requirements: 5.2_
- [ ] MA.3 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 6.1, 6.2_
