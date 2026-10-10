# Core access policy — tasks

Foundation and integration have separate checkpoints. Tasks 4 and 5 may proceed
in parallel: prepare adapter contracts while implementing independent provisioning
and persistence. Task 6 requires both completed session flows and a coordinated
scanner integration window. Scanner owns its current shared-file work.

- [x] 1. Implement exact authority/origin, raw-header and canonical credential policy.
  _Requirements: 2.1–2.3, 3.1–3.4_
- [x] 2. Implement persistent snapshot/session contracts and renewable 30-day lifecycle,
  capacity/replacement, revocation and race-safe connection leases.
  _Requirements: 4.1–4.5, 5.1–5.3_
- [x] 3. CHECKPOINT FOUNDATION: targeted meaningful tests, typecheck, lint and independent
  review; verify no existing runtime files/adapters changed and no live protection claimed.
  _Requirements: 1.3, 2.1–5.3_
- [ ] 4. Prepare exact adapter/config/CLI contracts; agree the shared-file integration
  window with scanner and inspect settled route/WS/audio/bootstrap changes before wiring.
  _Requirements: 6.1, 6.5_
- [ ] 5. Implement guided provisioning/pairing/refresh/revoke flows and private persistence,
  including fail-closed startup/storage behavior and bounded failed-attempt handling.
  _Requirements: 1.1, 1.2, 4.1–4.5_
- [ ] 6. Integrate root Fastify/WS and shared HTTP audio admission/lease adapters, exact
  origins/authorities, cookie renewal and protected recording/download routes.
  _Requirements: 2.1–3.4, 5.1–5.3, 6.1_
- [ ] 7. Integrate CLI credentials, liveness/status probes, sanitized logging/validation,
  child-environment isolation and correct public audio URLs.
  _Requirements: 6.3, 6.4_
- [ ] 8. Implement explicit raw-listener policy and verify container/network exposure.
  _Requirements: 6.2_
- [ ] 9. CHECKPOINT PROTECTED MODE: actual WS/audio/download tests, CLI/browser coexistence,
  pairing/renewal/logout/restart and denied-origin/authority/no-secret checks; coordinated
  browser and deployment acceptance before connected web release.
  _Requirements: 1.1–6.5_

## Foundation checkpoint — 2026-10-10

Implementation commit: `49a8778` on `feat/access-policy`. Only ten new source/test
files were added; no existing runtime files changed and no listener is protected.
Independent Astra review approved the final policy/session implementation and
callback cleanup regression. Targeted tests: four files, 88 tests, including two
100-run properties. Typecheck passed. Repository lint passed with zero errors and
59 existing warnings outside the new paths; focused lint has zero warnings.

Integration remains pending. The next independent batch is guided provisioning,
pairing and private durable persistence. Coordinate the shared adapters/config/CLI
window with scanner before tasks 6–8; do not infer live protection from this checkpoint.
