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

- [x] RK2.1 Scanner recording delete through the coordinator (keep service `scannerDeleter`,
      `recording-delete.ts`, shared verified unlink with progress names); exact diffs for the
      evidence store, discovery store (`forgetRecording`) and scanner service, with tests.
  - _Requirements: 1.1–1.4, 1.11_
  - **Property 1: No scanner delete of a kept or unverified file**
- [x] RK2.2 Merge aliases and eviction removal (exact store, evidence and scanner-service diffs);
      kept totals and `keptSummaryOf` with the reporter diff; startup delete leftover sweep;
      capture store staging cleanup.
  - _Requirements: 1.5–1.10_
  - **Property 2: Aliases keep meaning**, **Property 3: Sweep touches only provable leftovers**

## Lane SM: smooth live audio, squelch and tuning trust

- [x] SM.1 Clients survive restarts; silence fill; offset change by front swap with fallback;
      stand-in harness with before and after gap numbers.
  - _Requirements: 2.1–2.5_
  - **Property 4: Clients stay, time stays filled**, **Property 5: Offset swap keeps the back**
- [x] SM.2 Carrier-aware auto floor (quieting observer, auto nfm/wfm only); overload check.
  - _Requirements: 2.6, 2.7_
  - **Property 6: A carrier never seeds the floor**
- [x] SM.3 Operator frequency proves the rate once per connection; untracked-retune root cause,
      in-core fixes, classifiers, warning fields and log rate limit.
  - _Requirements: 2.8–2.10_
  - **Property 7: Rate written once, only when unproven**, **Property 8: Alarm classification**

## Lane ID: identify for analog voice

- [x] ID.1 Analog evidence log and identify analog trials, verdict and result fields.
  - _Requirements: 3.1–3.4, 3.6_
  - **Property 9: Analog evidence fails closed**
- [x] ID.2 Unavailable decoder memo and `decodersUnavailable`; startup pre-connect log minors
      (spectrum service; scanner service as an exact diff).
  - _Requirements: 3.5, 4.2_
  - **Property 10: Memo is honest**

## Main

- [x] MA.1 Merge the lanes; wiring in `src/index.ts` (scanner deleter, sweep, kept summary,
      analog evidence); apply the lanes' scanner-service, store and reporter diffs with their
      tests; contract test updates.
  - _Requirements: 1.1, 1.5, 1.6, 1.8, 1.9, 3.1, 4.2, 5.1_
- [x] MA.2 Docs (API.md: scanner recording delete, kept totals, identify analog result and
      `decodersUnavailable`, warning fields, operator rate write, live audio continuity; ROADMAP;
      SCANNER; coordination note for the CLI and the web session) and the CLI grep.
  - _Requirements: 5.2_
- [x] MA.R2 Activity hygiene review fixes: summed segment audio, single-segment carrier, tone
      split between speakers, carrier base on resume, max-duration continuation, identify settle
      wait and pending opening; meter micro-benchmark.
  - _Requirements: 3.2, 3.7_
  - **Property 11: Hygiene output is sound**, **Property 12: A qualifying opening is exactly one row**
- [ ] MA.3 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 6.1, 6.2_

## Amendment 2026-10-24: carrier-bounded transmissions

Requirement 3.8, design section "Amendment 2026-10-24". Paths: `src/core/analog-transmission.ts`,
the hook in `src/core/live-demodulator.ts` (only the lines named below), tests. No change to
`src/core/evidence-squelch/**`, `src/core/channel-squelch.ts`, `packages/**` or `src/index.ts`.

- [ ] A1.1 Carrier-run hook. `src/core/live-demodulator.ts`: fields `carrierRunCount` and
      `blocksSinceCarrier` next to `carrierBlockCount`, updated only at the existing
      `carrierBlockCount` increment in the per-block measurement (both the sampled and the
      `run.squelch.blockCarrier()` branch), reset when a pipeline run starts; public
      `readCarrierRun(into)` beside `carrierBlocks()`, same null rule. Verify a Rust metrics
      point is one 10 ms block (else scale the counts) and say so in the test.
  - _Requirements: 3.8.1, 3.8.7_
- [ ] A1.2 Tracker. `src/core/analog-transmission.ts`: `AnalogCarrierRun`,
      `AnalogTransmissionSource.readCarrierRun?`, constants
      `ANALOG_TRANSMISSION_CARRIER_RUN_BLOCKS` and `ANALOG_CARRIER_BLOCK_MS`; carrier mode chosen
      in `openTransmission`'s caller (`handleSquelch`) by the hook; new private
      `observeCarrier(now)` called from `handlePcm`, `handleLevel` and `handleSquelch`; span
      qualification replaces the bare-open path of `handleSquelch`/`resumeSegment`; `endSegment`
      and `canMerge` use the last carrier block end; `close`/`finalise` end at it; `pending()`
      returns only a qualified span; `discardedSegments()`. Fallback path untouched.
  - _Requirements: 3.8.2–3.8.5, 3.8.7, 3.8.8_
- [ ] A1.3 Tone input. `handlePcm` feeds the detector and the split detector only per 3.8.6
      through the preallocated pre-roll ring; `noteAudio` counts fed audio only; ring sized
      once per PCM format.
  - _Requirements: 3.8.6_
- [ ] A1.4 Tests. `tests/unit/core/analog-transmission-hygiene-fakes.ts` gains an opt-in block
      script (power open, quieted per block, tagged PCM) driving `readCarrierRun` and the clock;
      new `tests/unit/core/analog-transmission-carrier.test.ts` (the five 3.8.9 cases, the bounds
      9 vs 10 run blocks, 1500 vs 1501 ms merge, 249 vs 250 ms span hang, the run2 timeline
      regression, the am fallback golden), with real `ToneDetector` and synthetic 79.7 Hz and
      D031N PCM (reuse the DCS synth of `tests/unit/core/analog-transmission-dcs.test.ts`); new
      `tests/unit/core/analog-transmission-carrier.property.test.ts` (Properties 13, 14); hook
      test in `tests/unit/core/live-demodulator-wg7.test.ts` (run and since-last counts on a
      `carrierWindows` channel). Existing tracker tests stay unchanged (their fakes have no
      hook); any golden that changes is listed with 3.8.
  - _Requirements: 3.8.9_
  - **Property 13: Spans bound transmissions**, **Property 14: Tone hears only carrier**
- [ ] A1.5 Checkpoint: touched tests, `pnpm run typecheck`, `pnpm run lint`; CPU check of the
      hook and the ring against the design budget; spec ticks.
  - _Requirements: 3.8, 6.1_
