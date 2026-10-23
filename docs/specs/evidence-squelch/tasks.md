# Evidence squelch tasks

Status: not started (2026-10-23). See [requirements](requirements.md) and [design](design.md).

Lanes work against the frozen contract (0.1) and touch only their own paths. Main (M.\*) owns the
contract files (`packages/api-types/src/live-audio.ts`, `src/core/evidence-squelch/contract.ts`),
the shared synthetic test helpers and the acceptance runs. Every lane runs its touched tests,
`pnpm run typecheck` and `pnpm run lint` before reporting; property tests carry
`// Feature: evidence-squelch, Property N: <name>` and `numRuns ≥ 100`. Live steps are run by Main
only. No lane touches a live receiver, its ports or the running core.

| Lane | Files (exclusive)                                                                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M    | `packages/api-types/src/live-audio.ts`; `src/core/evidence-squelch/contract.ts`; `tests/unit/core/evidence-squelch/synthetic.ts`; `tests/unit/core/evidence-squelch/contract.test.ts`; `docs/engineering/EVIDENCE-SQUELCH-2026-10-ACCEPTANCE.md`                                                    |
| EV   | `src/core/evidence-squelch/{voice-meter,tone-evidence,evidence-gate}.ts`; `src/core/scanner/analog-trial.ts` (new exports only, no behaviour change); `tests/unit/core/evidence-squelch/{voice-meter,tone-evidence,evidence-gate}*.test.ts`                                                         |
| PR   | `src/core/evidence-squelch/pre-roll.ts`; `tests/unit/core/evidence-squelch/pre-roll*.test.ts`; `scripts/bench/evidence-squelch.ts`                                                                                                                                                                  |
| FX   | `scripts/evidence-squelch/**` (fixture generator, golden script, scratch Compose project, acceptance driver, README); `tests/mocks/fixtures/evidence-squelch/**`; `tests/unit/core/evidence-squelch/meter-equivalence.test.ts`                                                                      |
| W    | `src/core/live-demodulator.ts`; `src/core/live-demod/rust-run.ts` (only if a carrier-evidence field must be passed through); `src/api/routes/live-audio.ts`; `src/api/websocket/events.ts`; `tests/unit/core/live-demodulator-evidence*.test.ts`; `tests/unit/api/live-audio-auto-squelch*.test.ts` |
| D    | `docs/API.md`; `docs/ROADMAP.md`; `docs/CLI-COORDINATION.md` (append only, never Prettier); `config/default.yaml` (comments only)                                                                                                                                                                   |

Order: 0.1 first. EV, PR, FX.1 and D.1 then run in parallel. W builds against the contract with
fake ports and integrates after EV and PR merge. FX.2 needs EV.1. PR.3 (bench) needs EV.3. Main
runs M.2 as soon as W.3 lands, before any polishing.

## Contract

- [ ] 0.1 Freeze the contract: `LIVE_AUDIO_AUTO_SQUELCH_*` constants and `LiveAudioAutoSquelch`
      in api-types (`autoSquelch?` on `LiveAudioStatus` and `LiveAudioLevel`, doc comment of
      `squelchMode` saying auto is the default and evidence-gated on NFM and AM);
      `EvidenceGatePort` and `PreRollPort` in `contract.ts`; synthetic PCM helpers (CTCSS and DCS
      tones, voice-like audio, carrier silence, FSK bursts, clicks, noise); contract tests pinning
      values and the equalities with `DCS_MIN_AUDIO_SECONDS`, `ANALOG_TRANSMISSION_MERGE_GAP_MS`
      and `ANALOG_TRIAL_FRAME_MS`
  - _Requirements: 4.1, 4.3_

## Lane EV: evidence

- [ ] EV.1 `VoiceFrameMeter`: 8 kHz frames of audio power, syllabic index and cluster score,
      discriminator scaling and `gain` normalisation, preallocated, `reset()`
  - _Requirements: 1.3, 5.2, 6.1_
- [ ] EV.2 `ToneEvidence`: any standard CTCSS tone (two consecutive blocks) or standard DCS code
      in either polarity (`LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT` hits), 750 ms floor; export
      `toneQualified` and `dataLike` from `analog-trial.ts` unchanged in behaviour
  - _Requirements: 1.2, 1.3_
- [ ] EV.3 `EvidenceGate`: one `PcmDecimator`, quiet-block ring, judge order (tone, data-like,
      quieting with voice), latch, hang in stream samples, reopen within the hang, renewal on a
      different tone, `closed()` framing, `reset()`
  - _Requirements: 1.1-1.5, 1.10, 6.1_
  - **Property 1: Monotone in evidence**
  - **Property 2: Judge agreement**
  - **Property 3: Bare carrier and data never open**
  - **Property 4: Latch through the hang**
  - **Property 5: Status at received time** (gate part)
  - **Property 6: Chunk-split invariance** (gate state sequence)

## Lane PR: pre-roll

- [ ] PR.1 `PreRoll`: byte FIFO and run-length tag ring sized per design (Pre-roll sizing),
      output rule, `latch`, `abandon`, `clear`, split-sample hold, fast path; a test at the
      capacity bound for each row of the sizing table
  - _Requirements: 2.1-2.6, 2.8, 2.9_
  - **Property 6: Chunk-split invariance** (output bytes)
  - **Property 7: Nominal rate**
  - **Property 8: Delayed copy, no loss while open**
  - **Property 9: Bounded delay**
  - **Property 10: Onset**
  - **Property 11: Catch-up drops only silence**
  - **Property 13: Lifecycle**
- [ ] PR.2 Allocation check: a test that runs 10 000 chunks through `process` and asserts no
      `Buffer` or typed array is created after construction (spy on the constructors)
  - _Requirements: 2.8, 6.1_
- [ ] PR.3 Bench (after EV.3 merges): gate plus pre-roll per second of 25 kHz and 50 kHz audio and
      per 64 KiB chunk, s16le and f32le, against the frozen tone-gate path; before/after table
  - _Requirements: 6.2_

## Lane FX: fixtures and equivalence

- [ ] FX.1 Fixture generator (48 kHz complex for the analyzer; CU8 at 2.048 and 2.4 Msps for the
      fake `rtl_tcp`) for every class in design, Meter equivalence; golden script running the
      existing `analyze.rs` entry point; goldens committed (small files only)
  - _Requirements: 5.1, 8.1_
- [ ] FX.2 Meter equivalence test (after EV.1 merges): tolerances of 5.1 per fixture and verdict
      agreement; non-default gain case; AGC and de-emphasis cases recorded in the test output only
  - _Requirements: 5.1, 5.2, 8.4_
- [ ] FX.3 Scratch Compose project and acceptance driver (`run_acceptance.py`): per fixture open
      verdict, onset alignment, delay, byte rate, transmission comparison against a manual-mode
      run, event-loop p99; csdr and Rust; CPU-quota variant; cleanup of every scratch resource
  - _Requirements: 8.2_

## Lane W: wiring

- [ ] W.1 Default flip in `LiveDemodRuntimeConfigSchema` and the route fallback; golden tests that
      manual, noise, a configured tone squelch and auto on WFM, USB, LSB, DSB, CW and raw write the
      same registry bytes and `pcm` bytes as the frozen code
  - _Requirements: 1.7-1.9, 3.1_
  - **Property 12: Byte-identical elsewhere**
  - **Property 14: Default**
- [ ] W.2 `handleAudioData` evidence path against fake ports: slices, tags, latch split, guard,
      close handling in `publishSquelchChange`, `noteBlock` from `measureRun` (csdr observer, Rust
      metrics, AM floor rule), lifecycle clears (mode, tone squelch, offset swap, retune, stop),
      pre-roll allocation per NFM or AM run
  - _Requirements: 1.1, 1.5, 1.6, 1.10, 1.11, 2.3, 2.7, 2.9_
  - **Property 5: Status at received time** (wiring part)
- [ ] W.3 Integration with the real gate and pre-roll (after EV and PR merge); `autoSquelch` on
      status, the `level` event and `live-audio:level`; end-to-end unit test on synthetic PCM for
      each class of 8.1
  - _Requirements: 4.1, 4.2, 8.1_

## Lane D: documentation

- [ ] D.1 `docs/API.md` (auto semantics, default, `autoSquelch`, stream delay and catch-up,
      `squelchOpen` unchanged); `config/default.yaml` comments for `squelchMode`
  - _Requirements: 3.1, 7.1_
- [ ] D.2 ROADMAP live-audio squelch item and a Landed paragraph (after W.3); dated
      `docs/CLI-COORDINATION.md` note; check the CLI source for `squelchMode` assumptions and list
      them in the note
  - _Requirements: 7.1, 7.2_

## Main

- [ ] M.1 Merge order EV, PR, FX.1, then W; run the full root suite once after W.3
  - _Requirements: 1.6-1.9_
- [ ] M.2 Fake-link acceptance on csdr and Rust, early; amend `CLOSE_GUARD_MS` from the measured
      back-chain drain if needed; record in the acceptance document
  - _Requirements: 2.6, 6.1, 8.2_
- [ ] M.3 Checkpoint: resolve 8.4 (AM through the fast-AGC chain) before the default flip lands
  - _Requirements: 8.4_
- [ ] M.4 Live acceptance with the user (design, Live acceptance plan)
  - _Requirements: 8.3_
- [ ] M.5 Pi 4-class CPU and event-loop measurement when a host is available (until then the
      table's Pi 4-class column stays an estimate)
  - _Requirements: 6.1_
