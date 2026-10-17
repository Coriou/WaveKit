# Web gaps 7 tasks (WG7)

Status: implemented; checkpoint (MA.3) passed (build, typecheck, lint, contract, CLI, sdr-host and the full root suite); real-RF acceptance open. See [requirements](requirements.md) and
[design](design.md). Lanes work against the frozen contract and touch only their own paths;
Main (MA.\*) owns the composition files (`src/index.ts`, `src/api/server.ts`, barrels including
`src/core/bandplans/index.ts`, `src/config.ts`, `config/*`), the frozen contract files
(`packages/**`, `src/core/scanner/types.ts`, `src/core/scanner/store/**`,
`src/core/scanner/job-runner.ts`, `src/core/activity/storage/contract.ts`,
`src/core/bandplans/contract.ts`, `src/decoders/types.ts`), `src/core/scanner/scanner-service.ts`,
the isolation and contract tests and the docs. No lane edits the pinned band-plan files or
`docs/CLI-COORDINATION.md`. Every lane runs its touched tests, `pnpm run typecheck` and
`pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: ambient-only protocols, identity kinds and identify trial fields,
      the driver hook; band-plan skip DTOs, bounds, the flag and its persistence; the refresh
      timing; squelch modes, noise threshold, tone squelch shape and config refinements; the
      cited gain tables; the stricter URL schema and stored group overrides; E2 comments.
  - _Requirements: 1.1, 1.5, 1.8, 2.1–2.4, 3.1, 3.4, 5.1, 5.2, 6.1–6.4, 7.1, 10.1, 10.2, 11.1_

## Lane AMB: ambient identify

- [x] AMB.1 Interpreters `confirm/{ais,acars,vdl2,meshtastic}.ts`, the new types in
      `ambient.ts` (trust rule, `tuningTrustOf`, `coverageAt`), `ambient-target.ts`.
  - _Requirements: 1.2–1.4, 1.8_
  - **Property 1: Ambient trust rule**, **Property 2: Existing ambient unchanged**,
    **Property 3: Identity needs two clean decodes**
- [x] AMB.2 Identify ambient trials (`IDENTIFY_PROTOCOLS`, planning, `onAmbientEvidence`,
      verdict).
  - _Requirements: 1.5–1.7_
  - **Property 4: Ambient identify inert without coverage**

## Lane SQ: noise squelch, tone squelch, noise tail

- [x] SQ.1 Noise metric and `noise` mode in `ChannelSquelch` / the live demodulator; runtime
      schema, PATCH route, Activity row; benchmark.
  - _Requirements: 2.1–2.6_
  - **Property 5: Manual and auto squelch unchanged**, **Property 6: Noise squelch on noise and
    carrier**
- [x] SQ.2 `ToneSquelchGate` and the audio mute; status; benchmark.
  - _Requirements: 3.1–3.6_
  - **Property 7: Tone gate**
- [x] SQ.3 Noise tail: reproduction, cause, fix.
  - _Requirements: 4.1–4.3_

## Lane GT: gain tables

- [x] GT.1 `gainTableFor`, provider, Zod and JSON schemas, byte bounds.
  - _Requirements: 5.1–5.4_
  - **Property 8: Gain table match**

## Lane BX: band-plan skips and decoded-elsewhere refresh

- [x] BX.1 `bandplan-skips.ts` and its use in `planJob` / `previewPlan` / normalisation; route
      schemas; benchmark.
  - _Requirements: 6.1–6.6_
  - **Property 9: Band-plan skips inert without view or flag**, **Property 10: Skip merge
    shape**, **Property 11: Skip excludes**
- [x] BX.2 `coverage-refresh.ts` (debounce, interval, fingerprint).
  - _Requirements: 7.1–7.3_
  - **Property 12: Refresh bounds**

## Lane HW: audio CORS and bounded options

- [x] HW.1 Legacy audio CORS and preflight; protected-mode tests.
  - _Requirements: 8.1–8.3_
  - **Property 13: Audio CORS**
- [x] HW.2 `option-values.ts`; every adapter's numeric reads, array bounds and shell strings;
      schema bounds and descriptors.
  - _Requirements: 9.1–9.5_
  - **Property 14: Bounded numeric options**

## Lane MIN: minors

- [x] MIN.1 URL schema parity property; stored group overrides in commit and update check.
  - _Requirements: 10.1, 10.2_
  - **Property 15: URL schema parity**
- [x] MIN.2 Config export exempt paths; `APP_VERSION` from the build.
  - _Requirements: 10.3, 10.4_
- [x] MIN.3 SDR# reference bound, AIS tracker reuse, trails duplicate keys, relay-disconnect
      label.
  - _Requirements: 10.5–10.8_

## Main

- [x] MA.1 Merge the lanes; scanner-service and `src/index.ts` wiring (ambient targets, trust
      and identify hook; band-plan skip view, `ScanJob.bandPlanSkips`, PATCH key; coverage
      refresh; storage report decoder list); contract test updates.
  - _Requirements: 12.1_
- [x] MA.2 Docs (API.md, ROADMAP, coordination note for the CLI and the web session) and the CLI
      grep. (The band-plans 11.1, receiver-capabilities 1.3 and web-gaps-6 E2 amendments are in
      the spec commit.)
  - _Requirements: 5.5, 6.7, 11.1, 12.2_
- [x] MA.3 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 13.1, 13.2_
- [ ] MA.4 RF-window preparation: checklist and scripts for one supervised session after WG7
      (noise and tone squelch, DCS/CTCSS on real RF, the noise tail, REST drag-to-tune latency);
      nothing runs on the receiver without the user's go.
  - _Requirements: 12.3_
