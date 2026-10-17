# Web gaps 11 tasks (WG11)

Status: frozen for implementation. See [requirements](requirements.md) and [design](design.md).
Lanes work against the frozen contract and touch only their own paths; Main (MA.\*) owns the
composition files (`src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`, `config/*`),
the frozen contract files (`packages/**`, `src/core/scanner/passive-cost-contract.ts`,
`src/core/scanner/iq-capture-contract.ts`, `src/core/spectrum/track-identity-contract.ts`),
`src/core/scanner/scanner-service.ts`, `src/core/scanner/types.ts`, the build and image files
(`package.json`, the lockfile, `Dockerfile`, `Makefile`, `native/wavekit-chan/Cargo.toml` and
`Cargo.lock`), the isolation and contract tests, `cli/**` and the docs. No lane edits the pinned
band-plan files or `docs/CLI-COORDINATION.md`. Every lane runs its touched tests,
`pnpm run typecheck` and `pnpm run lint` (and the crate tests when it touches Rust) before
reporting.

- [x] 0.1 Freeze the contract: `heard` outcome and `replay` transports with the CLI guard; frame
      track fields; `config` command origin; per-source tuner config, passive cost limit and IQ
      capture config; passive cost, IQ capture and track identity contract modules.
  - _Requirements: 1.1, 1.5, 2.1, 4.1, 4.2, 5.1, 5.3, 5.4, 6.1–6.6_

## Lane ID: identify and scan quality

- [ ] ID.1 `heard` outcome; analog evidence no longer ends other trials; narrow digital trials at
      6.25 kHz rasters (`narrowRasterAt`, scanner-service diff).
  - _Requirements: 1.1–1.3_
  - **Property 1: Heard is honest**, **Property 2: Analog never stops digital**,
    **Property 3: Narrow modes where the raster says so**
- [ ] ID.2 Band-scan DMR root cause (synthetic reproduction, fixes, exact diffs); clean stop of an
      ended job.
  - _Requirements: 1.4, 1.6_
  - **Property 4: A stop is clean**

## Lane SC: passive guard and scanner store CPU

- [ ] SC.1 `passiveCostDecision` and the recheck diff.
  - _Requirements: 2.1–2.3_
  - **Property 5: Passive guard decides by the limit**
- [ ] SC.2 Frequency index, cached medians, incremental counts, change detection without clones
      or whole-record stringify; bench before and after.
  - _Requirements: 3.1–3.4, 3.6_
  - **Property 6: Index equals scan**, **Property 7: Counts equal a recount**
- [ ] SC.3 Snapshot worker with a journal-fed mirror and the main-thread fallback.
  - _Requirements: 3.5, 3.6_
  - **Property 8: Snapshot text unchanged**

## Lane GN: gain and AGC on connect

- [ ] GN.1 `configuredTuningFrames`, `setConfiguredTuning`, the connect write with precedence and
      origin `config`, baseline and `reset` behaviour.
  - _Requirements: 4.1–4.6_
  - **Property 9: Configured gain, once, never over the operator**

## Lane TR: stable tracks on spectrum frames

- [ ] TR.1 Track fields from the tracker through the worker wire into frames; identity lookup;
      scanner-service `trackIdentity` diff; size and build budget measured.
  - _Requirements: 5.1–5.6_
  - **Property 10: Track fields are the tracker's**

## Lane IQ: IQ capture and replay

- [ ] IQ.1 `wavekit-iqcap` (ring, capture, replay) with crate tests and a native bench.
  - _Requirements: 6.2, 6.8, 6.9_
  - **Property 12: Capture DSP is chunk-invariant**
- [ ] IQ.2 Bridge, bounded store, startup sweep, `createIqCaptureService`.
  - _Requirements: 6.1, 6.3, 6.4, 6.7, 6.8_
  - **Property 11: Capture store bounds**, **Property 13: Sweep touches only provable captures**
- [ ] IQ.3 Replay transport; exact diffs for identify, probe pool, scanner service and the
      Dockerfile.
  - _Requirements: 6.5–6.7_

## Main

- [ ] MA.1 Merge the lanes; apply their scanner-service diffs (ID, SC, TR, IQ in that order) and
      the IQ identify / probe-pool diffs after ID; `src/index.ts` wiring (tuner config, track
      identity lookup, IQ capture service and replay transport); build entry for the snapshot
      worker; Dockerfile and Makefile for `wavekit-iqcap`; contract test updates.
  - _Requirements: 7.1_
- [ ] MA.2 Docs: API.md (`heard`, `replay`, cancel of an ended job, frame track fields, `config`
      origin, tuner config, passive limit and recheck, IQ capture), SCANNER, ROADMAP, coordination
      note for the CLI and the web session; CLI grep.
  - _Requirements: 7.2_
- [ ] MA.3 ROADMAP fold of the performance and native-code audit; contributor performance rules
      page.
  - _Requirements: 7.3_
- [ ] MA.4 Checkpoint: full root suite, typecheck, lint, crate tests; spec status and ticks.
  - _Requirements: 8.1, 8.2_
