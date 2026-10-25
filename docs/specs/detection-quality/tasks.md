# Detection quality tasks (WG15 DQ)

Status: not started (2026-10-24; revised after spec review). See [requirements](requirements.md) and
[design](design.md). Each task is sized for one implementer, touches only the paths it
names, and ends with its touched tests, `pnpm run typecheck` and `pnpm run lint`. Main owns
`src/index.ts`, the contract file and the docs. No task edits `packages/api-types` or
`docs/CLI-COORDINATION.md`. Goldens are re-baselined only in the task that changes them,
with each diff explained in the report.

- [ ] DQ.0 Freeze the contract: `src/core/scanner/detection-quality-contract.ts` with every
      constant in the design table and a doc comment carrying its arithmetic; a contract
      test pinning the values.
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 3.1, 4.1, 4.5_

- [ ] DQ.1 Tracker strong-block duration: `gateStrongBlocks` in
      `src/core/spectrum/emissions/tracker.ts`, reset with the run, counted on `snr >= k`,
      used by `noteQualified`, copied by `inheritRun`. Update `frame-tracks*`, `pipeline-gate`, `pipeline-burst`,
      `channel-gate.property` tests and re-baseline `frame-tracks-golden`; add the
      hysteresis fixture.
  - _Requirements: 1.8, 1.10_
  - **Property 4: Strong duration**

- [ ] DQ.2 Pending holder: `src/core/scanner/store/pending-admission.ts` (new) with bucket
      search, fixed-window expiry from the first sample, top-5 samples with a distinct-id
      count, eviction and `clear`; boundary, duplicate-id and window-restart tests and a
      fast-check bound property. No store wiring yet.
  - _Requirements: 1.4, 1.5, 1.6_
  - **Property 3: Pending bound**

- [ ] DQ.3 Store creation gate in `discovery-store.ts`: invalid-input rejection, overload
      create at 25 dB, 18 dB create, pending wiring, retune and source-removal `clear`,
      refresh-tick sweep. Noise-only, recurring 10 to 15 dB noise, intermod, undecoded strong
      analog, weak-repeat, boundary and invalid-centre fixtures; update admission tests listed
      in the design; re-baseline the store-change goldens.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.10_
  - **Property 1: No weak overload birth**, **Property 2: Creation threshold**

- [ ] DQ.4 Medians, compatibility and best: extend `mediansOf` with median peak, count and
      class tally; `compatibility.ts` helper; `stickyMatch`, `keyTarget`, `settle` and
      `absorb` refuse incompatible pairs (settle links them as co-channel); `absorbStats`
      `raiseBest`; majority class. Strong-15-kHz, strong-564-Hz, shared-key and fading-user
      fixtures; attribution and merge-alias tests.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - **Property 8: Ambient best is stable**, **Property 9: No incompatible merge**,
    **Property 10: Majority class**

- [ ] DQ.5 Cross-family sticky and carrier joins in `stickyMatch` (after DQ.4, which it
      reuses for medians). DMR two-classifier and carrier fixtures; evidence-family and
      evidence-sink test updates.
  - _Requirements: 2.1, 2.2, 2.5, 2.6_
  - **Property 5: Cross-family convergence**

- [ ] DQ.6 Co-channel pruning at refresh and the cap of 8 in `createFrom`; reciprocal
      unlink through `syncProofWatch`; overflow (12 records) and re-link tests; merge-alias
      and store-index property updates.
  - _Requirements: 2.3, 2.6_
  - **Property 6: Co-channel bound**

- [ ] DQ.7 Identity split in `applyEvidence`, limited to DMR, P25 and YSF source ids, 6 to
      30 kHz, overlap within 2 s, refusing only the record 10 dB or more weaker;
      adjacent-leak fixture and its controls (pager capcode, stronger record, distance,
      overlap); identity, identity-guard and DMR classify test updates.
  - _Requirements: 2.4, 2.6_
  - **Property 7: Identity rule scope**

- [ ] DQ.8 Checkpoint: run the scanner and spectrum suites and the store and tracker
      benchmarks; report, against the design budgets, the per-block tracker cost (under
      0.001 core) and the per-observation store cost (under 0.01 core desktop, under 0.03
      core Pi 4-class, at 2.048 and 2.4 Msps), and the event-loop p99 change (under 0.5 ms).
      Pi-class figures may be extrapolated from the desktop bench with the stated factor if
      no Pi-class host is available to the task; say which.

- [ ] DQ.9 Data decode gate: `src/core/data-decode-gate.ts` (new) with source and basis
      matching, trust filter, per-source rate cap, ring, hold, timers, `stop` and `stats`;
      unit tests with fake timers; pager, two-source, control and overflow fixtures.
  - _Requirements: 4.1, 4.3, 4.5, 4.6, 4.7_
  - **Property 11: Data suppression**

- [ ] DQ.10 Live evidence `data` flag: core-only field on the analog evidence log entry;
      `live-audio-evidence.ts` skips `recordAnalog` for data; tests through
      `labelFromEvidence` (no analog-fm candidate, no rejected row).
  - _Requirements: 4.2_

- [ ] DQ.11 (Main) Composition: wrap the Activity publisher in `src/index.ts` to feed the
      gate; pass the gate to `wireAnalogTransmissions` and `feedAnalogEvidence`; stop order
      on shutdown; wiring tests.
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] DQ.12 (Main) Full root suite, docs (`docs/SCANNER.md` admission and association
      sections), spec status, and the live acceptance run with passive status recorded.
  - _Requirements: 5.1, 5.2_
