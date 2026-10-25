# Scanner redesign tasks (WG12)

Status: implemented; live acceptance pending. See [requirements](requirements.md) and [design](design.md).

Lanes DT, EV, RP and ID run in parallel against the frozen contract (task 0.1) and touch only
their own paths; the four allocations below are pairwise disjoint. Main (0.1, MA.\*) owns the
seams: `src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`, `config/*.yaml`,
`packages/**`, `docs/**`, `src/core/scanner/scanner-service.ts` and `src/core/scanner/types.ts`
(lane changes arrive as exact diffs), `src/core/spectrum/types.ts`, the contract modules
(`src/core/scanner/scanner-redesign-contract.ts`, `src/core/scanner/iq-capture-contract.ts`,
`src/core/scanner/identify-analog-contract.ts`), `src/core/live-demodulator.ts` (owned by the
rust-demod-a lane until it merges; ID's diff after), `cli/**`, the contract and CLI guard tests,
the build and image files (`package.json`, the lockfile, `Dockerfile`, `Makefile`,
`native/wavekit-chan/Cargo.toml`, `Cargo.lock`). No lane edits the pinned band-plan files or
`docs/CLI-COORDINATION.md`. Lanes do no RF, tuning, Pi, Docker or network work; fakes on
ephemeral 127.0.0.1 ports only. Every lane runs its touched tests, `pnpm run typecheck` and
`pnpm run lint` (and `make chan-test` when it touches Rust) before reporting, and lists every
golden it changed with the requirement that changed it.

Allocations (tests: the existing test files of these modules and new test files named after
the new modules, under `tests/unit/`):

- **DT**: `src/core/spectrum/channel-gate.ts` (new), `detector.ts`, `pipeline.ts`,
  `pipeline-host.ts`, `spectrum-worker.ts`, `worker-protocol.ts`, `summary-wire.ts`,
  `frame-tracks.ts`, `spectrum-service.ts`, `spectrum-engine.ts` (amendment A7: the channel plan
  travels as a `PipelineInput` kind replayed on worker restart), `emissions/tracker.ts`;
  `src/core/scanner/scheduler.ts`, `src/core/scanner/tuner-arbiter.ts`;
  `scripts/bench/spectrum-profile.ts` (new), `scripts/bench/frame-tracks.ts`.
- **EV**: `src/core/scanner/classify/**`, `src/core/scanner/band-scan-burst-prior.ts`,
  `src/core/scanner/store/discovery-store.ts`, `store/schemas.ts`, `store/frequency-index.ts`,
  `store/job-counts.ts`, `src/core/scanner/proof.ts` (new), `src/core/scanner/probes/probe-pool.ts`,
  `src/api/routes/scanner.ts`, `src/api/routes/scanner-schemas.ts` (after 0.1),
  `scripts/bench/scanner-store.ts`.
- **RP**: `native/wavekit-chan/src/iqcap/**`, `native/wavekit-chan/src/bin/wavekit-iqcap.rs`,
  `native/wavekit-chan/examples/iqcap_bench.rs`, `src/core/iq-capture/**`,
  `src/core/scanner/replay-plan.ts`, `src/core/scanner/analog-trial.ts` (new),
  `src/core/scanner/probes/replay-transport.ts`, `scripts/bench/iq-capture.ts`,
  `scripts/bench/analog-trial.ts` (new), `tests/mocks/iq/analog-synth.ts` (new, synthetic IQ for
  RP.3). Reads, never edits, the rust-demod-a kernel module.
- **ID**: `src/core/scanner/identify.ts`, `src/core/scanner/job-runner.ts`,
  `src/core/scanner/analog-evidence.ts`, `src/core/scanner/known-protocol.ts`,
  `src/core/scanner/job-phase.ts` (new), `src/core/scanner/live-audio-evidence.ts` (new).

Shared goldens: EV.1 owns regenerating `tests/unit/core/scanner/identify-analog-goldens.test.ts`
and `.json` and `tests/unit/core/scanner/identify-narrow-digital-goldens.test.ts` and `.json`. ID
never rewrites them (it adds golden files of its own if it needs any); Main reconciles at merge.

Dependencies: every lane needs 0.1. RP.2 and RP.3 need the rust-demod-a kernel merged
(design § Analog replay trial, API assumption "pure cf32-in, audio-out NFM/AM kernel in the
wavekit-chan crate"); RP.1 does not. ID.4 uses the `AnalogTrialRunner` port from the contract
(a fake in its tests), not RP's code. No lane compiles against a `DiscoveryStore` member another
lane adds: RP and ID reach the store only through the contract interfaces
`ObservationEvidenceSink` and `DiscoveryNearQuery` (frozen in 0.1, implemented by EV), with fakes
in their tests, so they run in parallel with EV. Their scanner-service and `src/index.ts` diffs
are checked in the lane with `git apply --check` against the 0.1 commit and with their own unit
tests using fakes; the scanner-service tests against the real store run at Main's merge step
(MA.1), after EV merges. Main merges and applies the scanner-service diffs in the order DT, EV,
RP, ID.

- [x] 0.1 (Main) Freeze the contract: the api-types additions and widenings (outcomes, decoder,
      `ended`, proof, evidence level, progress fields, `mergedIds`, query and identify fields,
      frame track `gate`/`channelSnrDb`, live-audio `tone`), the `types.ts` copies, the
      `TrackSnapshot` gate fields, `scanner-redesign-contract.ts` (with the store interfaces
      `ObservationEvidenceSink` and `DiscoveryNearQuery`), the `iq-capture-contract.ts`
      additions, `iqCapture.allowLegacy`, the route schema fields (accepted only), the CLI guard
      widening with `tests/unit/cli/scanner-guards.test.ts`, the new
      `tests/unit/core/scanner-redesign-contract.test.ts`, the `wg10`/`wg11` contract test
      amendments, and the design amendments (design § Contract › Amendments: A4 analyze
      transport, A12 in-memory trial evidence).
  - _Requirements: 2.6, 3.5–3.7, 5.5, 6.1, 6.4, 7.1–7.6, 8.2, 10.1_

## Lane DT: parking, channel gate, profiling

- [x] DT.0 Profile first: `scripts/bench/spectrum-profile.ts` with an in-process fake rtl_tcp on
      port 0 at 2.048 and 2.4 Msps, on the base; worker stage split, engine utilization,
      main-thread ELU and delay split, load average; the Rust detector gate verdict (9.3) in
      the report, numbers for `docs/engineering/scanner-profile.md` (Main commits). Re-run after
      DT.1.
  - _Requirements: 9.1–9.3_
- [x] DT.1 Channel gate in the worker: `createChannelGate`, the `set-channel-plan` worker
      message, `SpectrumService.setChannelPlan`, per-track gate state on `TrackSnapshot`, CFAR
      per range counting unpassed runs, summary wire and frame fields (`gate`, `channelSnrDb`,
      `surfaced` = passed); size test; synthetic false-alarm and detection report; goldens.
  - _Requirements: 2.1–2.4, 2.6–2.8_
  - **Property 1: Noise never passes the gate**, **Property 2: The gate is channel-matched**
- [x] DT.2 Parking: scheduler `parked`, dwell-counted sweeps, null `sweepPeriodMs`, no same-hop
      retune in multi-hop plans; the arbiter's same-centre no-op; tracker ids under a parked job.
  - _Requirements: 1.1–1.6_
  - **Property 3: A fitting window stays tuned**, **Property 4: Same-centre retune writes
    nothing**, **Property 5: Track ids survive parking**
- [x] DT.3 Exact scanner-service diff: `channelPlanOf`, plan updates on job start, stop and range
      edit, gate-aware ingest (transient only for `below`), gate in `nextCandidate` input.
  - _Requirements: 2.1, 2.5, 4.1_

## Lane EV: evidence labels, store, proof and API

- [x] EV.1 Evidence-only labels: replace the prior-to-protocol step and the prior-only ladder
      step (`labelFromEvidence`), keep classes and hypotheses as measurements and trial-order
      inputs; the new ladder; only gated observations create or update discoveries; no
      migration; goldens, including the shared identify goldens (EV.1 owns them).
  - _Requirements: 2.5, 3.1–3.3, 3.9_
  - **Property 6: Only gated tracks surface**, **Property 7: Labels only from evidence**
- [x] EV.2 `proof.ts` (`deriveProof`, `proofSummary`, `evidenceLevelOf`), discovery proof
      selection, cached per discovery version, encrypted wording; store bench with proof.
  - _Requirements: 3.4–3.6, 3.8, 6.5_
  - **Property 8: Proof is a function of the evidence**
- [x] EV.3 API: `evidence` filter, `nearHz`/`toleranceHz` (`DiscoveryStore.near`), `mergedIds` on
      merges, route DTOs carry `proof` and `evidenceLevel`; route tests with absent
      parameters byte-identical.
  - _Requirements: 3.7, 7.5, 7.6_
  - **Property 9: The filter partitions**
- [x] EV.4 Missing decoder program on the probe path → `unsupported`/`decoder-unavailable`,
      memo, no miss, no `no-sync`, listed in `unavailable`; exact scanner-service diff for EV.
  - _Requirements: 4.5, 3.4_

## Lane RP: replay first, analog replay trial, capture readiness

- [x] RP.1 Replay first: capture trigger at gate pass and the replay-first `needsConfirm` rule
      as an exact scanner-service diff; `planReplayTrials` with the analog step, AM/NFM choice
      and the stop rule; the replay queue's `analog` dep and result fields (`analog`,
      `unavailable`); queue drain arithmetic re-measured with fake decoders.
  - _Requirements: 4.2–4.4, 4.6, 5.5, 5.6_
  - **Property 12: Replay order and stop**, **Property 13: Replay before live in scans**
- [x] RP.2 (after the rust-demod-a kernel merges) `wavekit-iqcap analyze`: argv subcommand
      `analyze --in <abs file> --mode nfm|am` (a sibling of `replay`; amendment A4), kernel
      demod, discriminator statistics, 8 kHz s16le audio on stdout, one bounded event line on
      fd 4, fixed error codes; `IqCapturePort.openAnalyze`; crate tests and an `iqcap_bench`
      case at 4 s captures.
  - _Requirements: 5.1, 5.2, 5.7_
  - **Property 11: Analyze is chunk-invariant**
- [x] RP.3 (after RP.2) `classifyAnalogTrial` with calibrated thresholds (amendment diff with
      margins if they move), `createAnalogTrialRunner` (sliced TS CTCSS/DCS pass),
      `scripts/bench/analog-trial.ts` (wall time, CPU, event-loop p99 during a burst of 6);
      exact `src/index.ts` diff for the runner.
  - _Requirements: 5.3, 5.4, 5.7_
  - **Property 10: The analog trial decides by its rules**

## Lane ID: identify, live audio and the phase contract

- [x] ID.1 `waitUntilSignal` and `waitMs` through `IdentifyDeps.gatedAt`; `ended: "no-signal"`;
      timeout from the gated start; the docs text for "Decode here" in the report (Main pastes).
  - _Requirements: 6.1, 6.2_
  - **Property 14: Waiting identify ends honestly**
- [x] ID.2 `jobPhase`, `JobDriverDeps.activity`, `parked`/`holding`/`trial`/`replayQueueDepth` on
      `ScanJobProgress`; exact scanner-service diff for the `scanner:progress` fields.
  - _Requirements: 7.1–7.4, 7.7, 1.3_
  - **Property 15: Phase follows the precedence**
- [x] ID.3 `createLiveAudioEvidence` (closed transmissions → observation analog evidence on
      `commanded`/`relay` frequencies, through `DiscoveryNearQuery` and
      `ObservationEvidenceSink.recordAnalog`, in memory only); exact `src/core/live-demodulator.ts` diff for
      `LiveAudioStatus.tone` (applied by Main after rust-demod-a merges).
  - _Requirements: 6.3–6.5_
  - **Property 16: Live-audio evidence attaches only where it belongs**
- [x] ID.4 Analog replay trial in identify for claimed captures (`IdentifyDeps.analogTrial`),
      feeding the WG10 verdict; trial shape `analog-demod`/`replay`.
  - _Requirements: 6.6, 5.5_

## Main

- [x] MA.1 Merge the lanes; apply the scanner-service diffs (DT, EV, RP, ID), the `src/index.ts`
      wiring (analog trial runner into the replay queue and identify, `gatedAt`, live-audio
      evidence, activity view), the live-demodulator tone diff after rust-demod-a; contract test
      updates; if DT.0 met the gate, amend this spec with the Rust detector engine task first.
  - _Requirements: 10.2, 9.3_
- [x] MA.2 Docs: API.md, SCANNER.md (parking, gate, evidence labels, proof grammar, analog trial,
      replay first, phases, Decode here), ROADMAP, `docs/engineering/scanner-profile.md`;
      coordination note (design § Coordination note text) appended by hand; CLI grep for every
      changed contract.
  - _Requirements: 10.3_
- [ ] MA.3 Checkpoint: full root suite, typecheck, lint, crate tests; spec status and ticks.
  - _Requirements: 12.1, 12.2_
- [ ] MA.4 Live acceptance, capture off: S0–S6 and N1–N6 (design § Live acceptance), results
      recorded generically; receiver gain and AGC restored after.
  - _Requirements: 11.1–11.5_
- [ ] MA.5 Live acceptance, capture on (protected mode): S0–S6 and N1–N6 again.
  - _Requirements: 11.1–11.5_
- [ ] MA.6 (only if MA.5 passes S0–S6) Capture default flip: `iqCapture` default on in protected
      mode, `allowLegacy` for legacy, goldens (parsed shipped config, legacy info line),
      `config/default.yaml` comments, API.md and SCANNER.md, a follow-up coordination note.
      If MA.5 fails, record why in the spec status and leave the default off.
  - _Requirements: 8.1–8.4, 10.4_

## Open items

- Persist trial evidence across restart (WG13). Trial, analog and unavailable evidence is in
  memory only (design § Contract › Amendments, A12), so after a restart only decoded proofs
  survive and other proven discoveries read `weak` until new evidence arrives. Main adds this
  follow-up to docs/ROADMAP.md in MA.2.

## Weak labels and band hints amendment — 2026-10-25

- [ ] WL.1 Weak views publish `UNKNOWN_LABEL` on every discovery read and event path; observation
      views tested label-free; `hintOf` with the 3.11 rules and boundary tests; additive DTO
      field; web weak-row hint.
  - _Requirements: 3.10, 3.11_
  - **Property 17: Weak records publish no guess**
- [ ] WL.2 LPD433 built-in range; `priorsFor` narrowest-range rule; classifier `analog-fm`
      hypothesis for `fsk4-12k5` and `wideband`; ordering tests of 3.12.
  - _Requirements: 3.12_
  - **Property 18: Narrowest range orders**
  - Live (Main): L, a 433 MHz ISM centre: no weak discovery reads as a digital voice protocol;
    an OOK sensor burst shows the ISM hint; identify on an LPD433 voice runs analog first.
