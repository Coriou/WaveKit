# Web gaps 6 tasks (WG6)

Status: implemented; all tasks done and gates passed. E2 (config export policy) is still a
pending user decision; the shipped behaviour is the recommended one. See [requirements](requirements.md)
and [design](design.md). Lanes work against the frozen contract and touch only their own
paths; Main (MA.\*) owns the composition files (`src/index.ts`, `src/api/server.ts`, barrels
including `src/core/bandplans/index.ts`, `src/config.ts`, `config/*`), the frozen contract files
(`packages/**`, `src/core/scanner/types.ts`, `src/core/scanner/store/persistence.ts`,
`src/core/activity/storage/contract.ts`, `src/core/bandplans/contract.ts`,
`src/decoders/types.ts`), `src/core/scanner/scanner-service.ts`, the isolation tests and the
docs. No lane edits the pinned band-plan files or `docs/CLI-COORDINATION.md`. Every lane runs its
touched tests, `pnpm run typecheck` and `pnpm run lint` before reporting.

E2 (config export redaction) is pending a user decision; CE codes the recommended default behind
the `config-export.ts` constants.

- [x] 0.1 Freeze the contract: decoded-elsewhere DTOs, bounds and the preview-context slot, the
      skip flag and its persistence, hit duration, decoder option DTOs, the DCS field and table,
      band-plan URL import DTOs, error codes and the fetcher type, config export constants, the
      sample-rate presets.
  - _Requirements: 1.1, 1.2, 1.5–1.7, 2.1, 3.3, 3.4, 4.4, 4.5, 5.1–5.4, 6.1, 7.1–7.5, 8.1_

## Lane K: decoded elsewhere and hit duration

- [x] K.1 `plan/decoded-elsewhere.ts` (trust rule, clipping, merge, bounds) and its use in
      `planJob` / `previewPlan` / normalisation; issues; micro-benchmark.
  - _Requirements: 1.1–1.8_
  - **Property 1: Decoded elsewhere is inert without views or flag**, **Property 2: Trust
    rule**, **Property 3: Merge shape**, **Property 4: Skip excludes**
- [x] K.2 `JobHits` `lastObservationId` / `lastDurationMs` and `ended()`; hits route schema; job
      spec request schema accepts `skipDecodedElsewhere`.
  - _Requirements: 1.6, 2.1–2.3_
  - **Property 5: Hit duration**

## Lane DO: decoder option schemas

- [x] DO.1 One schema and descriptor list per built-in in `src/decoders/options/`; the
      adapter-read coverage test; real-config validation test.
  - _Requirements: 3.1, 3.4, 3.6_
  - **Property 6: Option schemas accept real configs**
- [x] DO.2 Validation at create in the manager (issues cached, one warn), `optionIssues` on the
      status, serializer and response schemas; `options` on `GET /api/decoders/types`.
  - _Requirements: 3.2, 3.3, 3.5_
  - **Property 7: Issue bounds and secrecy**

## Lane DCS: Digital-Coded Squelch

- [x] DCS.1 `audio-tones/dcs.ts` detector, synthetic encoder and corpora; benchmark;
      false-alarm measurement.
  - _Requirements: 4.1–4.3, 4.5, 4.8, 4.9_
  - **Property 8: DCS round trip**, **Property 9: DCS never guesses**
- [x] DCS.2 Tone detector and `finishTone` integration; Activity row (validation, summary field,
      FTS, twin); golden rows for the growth bound.
  - _Requirements: 4.4, 4.6, 4.7, 4.10_
  - **Property 10: Tone path unchanged**

## Lane U: band-plan URL import and update check

- [x] U.1 `src/core/bandplan-url/fetch.ts`: allowlist, DNS check and pinned connect, no
      redirects, status, encoding, media type, size and time caps, one in flight.
  - _Requirements: 5.2–5.4_
  - **Property 11: URL refusal**, **Property 12: Fetch bounds**
- [x] U.2 Service `previewImportUrl`, URL-bound digest, `sourceUrl` provenance, capabilities;
      routes (protected only) and the commit key.
  - _Requirements: 5.1, 5.4–5.6_
- [x] U.3 `import/update-diff.ts` and `checkImportUpdate`; route.
  - _Requirements: 6.1–6.3_
  - **Property 13: Update diff**

## Lane CE: config export and sample-rate presets

- [x] CE.1 `src/core/config-export/` redaction walk and YAML; every-secret fixture; route plugin.
  - _Requirements: 7.1–7.5_
  - **Property 14: No secret in export**
- [x] CE.2 `sampleRatePresets` on receiver capabilities (schemas, bounds, tests).
  - _Requirements: 8.1, 8.2_

## Main

- [x] MA.1 Merge the lanes; scanner-service wiring (coverage view, `ScanJob.decodedElsewhere`,
      PATCH key, `ended` calls); `src/index.ts` (URL fetcher and hosts, scanner dep, effective
      config); `src/api/server.ts` (config export mount and guard); contract test updates.
  - _Requirements: 9.1, 9.2_
- [x] MA.2 Docs (API.md, ROADMAP, coordination note) and the CLI grep. (The band-plans 6.1
      and receiver-capabilities 1.3 amendments are in the spec commit.)
  - _Requirements: 5.7, 8.2, 9.3_
- [x] MA.3 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 10.1, 10.2_
