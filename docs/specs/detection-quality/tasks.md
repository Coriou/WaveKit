# Detection quality tasks (WG15 DQ)

Status: not started (2026-10-24). See [requirements](requirements.md) and
[design](design.md). Each task is sized for one implementer, touches only the paths it
names, and ends with its touched tests, `pnpm run typecheck` and `pnpm run lint`. Main owns
`src/index.ts`, the contract file and the docs. No task edits `packages/api-types` or
`docs/CLI-COORDINATION.md`. Goldens are re-baselined only in the task that changes them,
with each diff explained in the report.

- [ ] DQ.0 Freeze the contract: `src/core/scanner/detection-quality-contract.ts` with every
      constant in the design table and a doc comment carrying its arithmetic; a contract
      test pinning the values.
  - _Requirements: 1.2, 1.3, 1.5, 2.1, 2.3, 2.4, 3.1, 4.1, 4.5_

- [ ] DQ.1 Tracker strong-block duration: `gateStrongBlocks` in
      `src/core/spectrum/emissions/tracker.ts`, reset with the run, counted on `snr >= k`,
      used by `noteQualified`. Update `frame-tracks*`, `pipeline-gate`, `pipeline-burst`,
      `channel-gate.property` tests and re-baseline `frame-tracks-golden`; add the
      hysteresis fixture.
  - _Requirements: 1.4, 1.8_
  - **Property 4: Strong duration**

- [ ] DQ.2 Pending holder: `src/core/scanner/store/pending-admission.ts` (new) with bucket
      search, sample ring, eviction, expiry and `clear`; unit tests and a fast-check bound
      property. No store wiring yet.
  - _Requirements: 1.3, 1.5, 1.6, 1.7_
  - **Property 3: Pending bound**

- [ ] DQ.3 Store creation gate: overload refusal, 15 dB create, pending wiring, retune and
      source-removal `clear`, refresh-tick sweep in `discovery-store.ts`. Noise-only,
      intermod and weak-repeat fixtures; update admission tests listed in the design;
      re-baseline the store-change goldens.
  - _Requirements: 1.1, 1.2, 1.3, 1.7, 1.8_
  - **Property 1: No evidence-less overload birth**, **Property 2: Creation threshold**

- [ ] DQ.4 Medians, compatibility and best: extend `mediansOf` with median peak, count and
      class tally; `compatible` helper; `stickyMatch`/`keyTarget` skip incompatible
      records; `absorbStats` `raiseBest`; majority class. Strong-15-kHz, strong-564-Hz and
      fading-user fixtures; attribution tests.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - **Property 8: Ambient best is stable**, **Property 9: Merge symmetry of the split
    rule**, **Property 10: Majority class**

- [ ] DQ.5 Cross-family sticky and carrier joins in `stickyMatch` (after DQ.4, which it
      reuses for medians). DMR two-classifier and carrier fixtures; evidence-family and
      evidence-sink test updates.
  - _Requirements: 2.1, 2.2, 2.5, 2.6_
  - **Property 5: Cross-family convergence**

- [ ] DQ.6 Co-channel pruning at refresh and the cap of 8 in `createFrom`; reciprocal
      unlink through `syncProofWatch`; merge-alias and store-index property updates.
  - _Requirements: 2.3, 2.6_
  - **Property 6: Co-channel bound**

- [ ] DQ.7 Identity split in `applyEvidence`; adjacent-leak fixture; identity,
      identity-guard and DMR classify test updates.
  - _Requirements: 2.4, 2.6_
  - **Property 7: Identity uniqueness**

- [ ] DQ.8 Checkpoint: run the store benchmarks and the scanner and spectrum suites; confirm
      store CPU stays inside the WG11 budget and report numbers.

- [ ] DQ.9 Data decode gate: `src/core/data-decode-gate.ts` (new) with ring, hold, timers
      and `stop`; unit tests with fake timers; the pager fixture and its controls.
  - _Requirements: 4.1, 4.3, 4.5, 4.6, 4.7_
  - **Property 11: Data suppression**

- [ ] DQ.10 Live evidence `data` flag: core-only field on the analog evidence log entry;
      `live-audio-evidence.ts` builds `voice: false` and `heard` for data; tests.
  - _Requirements: 4.2_

- [ ] DQ.11 (Main) Composition: wrap the Activity publisher in `src/index.ts` to feed the
      gate; pass the gate to `wireAnalogTransmissions` and `feedAnalogEvidence`; stop order
      on shutdown; wiring tests.
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] DQ.12 (Main) Full root suite, docs (`docs/SCANNER.md` admission and association
      sections), spec status, and the live acceptance run with passive status recorded.
  - _Requirements: 5.1, 5.2_
