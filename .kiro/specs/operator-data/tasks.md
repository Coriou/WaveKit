# Operator data implementation sequence

- [x] 1. Audit config/band/scanner/live-audio/CLI/web authorities and agree peer
  boundaries; reserve independent paths with Main.
  _Requirements: 1.4, 2.1–2.5_
- [x] 2. Astra MEDIUM design advice, resolve findings and independent spec review.
  Record exact reviewed contracts privately; no implementation before checkpoint.
  _Requirements: 1–5_
- [x] 3. Design checkpoint: requirements/design/tasks consistent; public integration
  explicitly deferred; ownership fences remain disjoint.
  _Requirements: 2.2, 5.5_
- [x] 4. Implement strict domain schemas, pure transitions/defaults/errors with
  unit/property tests (validation, IDs, CAS/revisions, authority isolation, ranking).
  _Requirements: 1.1–1.5, 2.1–2.5, 3.1–3.5, 4.6_
- [x] 5. Implement dedicated persistence with bounded reads, lifetime ownership,
  atomic sync/rename (including newly-created-directory parent sync), failure latch
  and restart/initialization failure tests; no generic store abstraction.
  Depends on4.
  _Requirements: 4.1–4.7_
- [x] 6. Implement bounded service transactions and lifecycle; verify concurrency,
  no-op publication results, injected synchronous sink ordering/exception behavior,
  copies, overload, shutdown and injected failures.
  Depends on4–5.
  _Requirements: 3.1–3.5, 4.2–4.3, 4.6–4.7_
- [ ] 7. Foundation checkpoint: touched tests (bounded workers), repository
  typecheck/lint, independent Astra MEDIUM review; resolve and recheck findings.
  Record exact commits/results and remaining gates; no end-to-end delivery claim.
  _Requirements: 1–4_
- [ ] 8. Main allocation gate after accepted scanner S1 and protected-runtime
  coordination: assign DTO/export/route/WS/bootstrap/config/client paths explicitly;
  announce shared contracts and inspect latest CLI/web consumers before editing.
  _Requirements: 2.2, 5.1–5.5_
- [ ] 9. With allocation, publish DTOs and schemas; mount protected REST and existing
  broadcaster snapshots; preserve scanner/access/build behavior. Contract tests
  cover invalid/precondition/conflict/access/late subscribe and unavailable state.
  Depends on7–8.
  _Requirements: 3.1–3.5, 5.1–5.4_
- [ ] 10. CLI/web consumers use canonical presets/preferences/ranking, retain
  drafts on conflicts and mark stale/unavailable state. Explicit apply actions
  reuse existing commands; unsupported tones show selected metadata only.
  Depends on9 and client owner allocation.
  _Requirements: 1.3–1.4, 2.1–2.3, 5.3–5.5_
- [ ] 11. Acceptance checkpoint: simultaneous CLI/web writes, ordering/reconnect,
  restart persistence, quotas/deletion, protected access, touched/full agreed
  checks and Main review/landing. Station-location extension is separately
  allocated/reviewed with config/readsb owner; no full maps scope.
  _Requirements: 2.4, 3.1–3.5, 4.1–4.7, 5.5_
