# Viewed-slice spectrum tasks

Design only; every implementation and qualification item remains unchecked. Existing
S1-B work is a dependency, not repeated here. Read [design](design.md) first.

- [ ] 1. Review the request/ack/status contract with existing spectrum/scanner and access owners; allocate exact shared paths and resource windows.
  - Preserve old DTO/default behavior; verify raw certified seam availability and residual budget authority.
  - _Requirements: 1.1, 1.2, 1.3, 3.1, 4.1, 4.2, 5.3_
  - **Properties 1, 3, 4, 6**
- [ ] 2. Checkpoint: approve explicit implementation allocation, still disabled; resolve raw seam/budget/access objections before coding.
  - No document approval alone releases runtime changes, tests, native work or measurements.
  - _Requirements: 5.1, 5.3_
  - **Property 6**
- [ ] 3. Implement boundary validation, source/view identities, atomic admission and reference-counted lifecycle in allocated paths.
  - Include per-client egress/access accounting, generations, removal, revocation and truthful suspension.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.3, 4.3_
  - **Properties 1, 5**
- [ ] 4. Implement bounded owned raw acquisition, interval deduplication and seam invalidation without detector arithmetic changes.
  - Verify borrowed-buffer reuse, partial samples, markers/settle and continuity-token guards through socket handoff, including same-epoch delayed results.
  - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2_
  - **Properties 3, 4**
- [ ] 5. Implement independent full raw transform, slice/reduction, support metadata and matching snapshot delivery.
  - No interpolation/cropped legacy fallback; no detector reconfiguration; decimation remains deferred.
  - _Requirements: 2.1, 2.2, 2.3, 3.3_
  - **Properties 2, 3**
- [ ] 6. Implement bounded fair scheduling, reservations, deadline drops, transport cleanup and discoverable counters.
  - Account all copies/allocations, every control/snapshot envelope, tentative/closing demand and bounded token bursts/transport queues; preserve scanner/listen/recording/native priority.
  - _Requirements: 1.4, 4.2, 4.3, 5.1_
  - **Properties 4, 5**
- [ ] 7. Checkpoint: run touched tests, typecheck and lint in Main's serial slot; obtain exact independent implementation review.
  - Property tests use fast-check numRuns >=100 and feature/property/requirement trace comments.
  - _Requirements: 1.1–5.3_
  - **Properties 1–6**
- [ ] 8. Qualify synthetic two-tone detail, simultaneous sources/spans, exact detector equivalence, seams, saturation/fairness and memory cleanup.
  - Include same-epoch delayed FFT and maximum periodic load plus rapid resubscribe/reconnect/control regressions. Execute paired and sustained workload plan only after separate resource authorization; preserve raw results and failures.
  - _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 5.1, 5.2_
  - **Properties 2–5**
- [ ] 9. Checkpoint: choose measured platform caps and release decision; retain disabled state on unmet gates.
  - Production enablement requires reviewed evidence and separate authority. Update limits honestly; announce shared contracts through the assigned owner.
  - _Requirements: 5.1, 5.2, 5.3_
  - **Property 6**
