# Receiver capabilities tasks

Status: reviewed design; not implemented or mounted. The complete public assembly must pass independent review before implementation allocation. No test or hardware qualification is implied.

See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

All implementation checkpoints remain unchecked. Naming a module does not allocate it; source-manager and command-policy integration require separate exact review. Mocks cannot establish physical receiver support.

- [ ] 1 Freeze the complete public requirements/DTO/error/bounds/design assembly after independent exact review.
  - Requirements: 1.1–1.6, 2.1–2.7, 3.1–3.8; Properties 1–6.
  - No implementation follows solely from design approval.
- [ ] 2 Review exact source evidence accessor/allocator/callback-ownership/policy integration allocation and race tests before runtime authoring.
  - Requirements: 1.1–1.2, 2.1–2.7, 3.7; Properties 1, 4, 5.
  - Existing getters cannot substitute. Preserve stream stripping, payload conversion, control behavior and normal retry policy outside the specified race corrections.
- [ ] 3 Implement pure literal RTL0 projection, closed policy DTO and validators.
  - Requirements: 1.2–1.5, 2.4, 3.2; Properties 2, 3.
  - Keep physical support and current values unknown; validate all 15 command rows against shared admitted REST policy, distinguishing numeric setter from REST enum/boolean acceptance.
- [ ] 4 Implement detached synchronous get/page/dispose with bounded errors and every-lookahead validation.
  - Requirements: 1.1, 1.6, 2.2, 2.7, 3.2–3.5, 3.7; Properties 1, 4, 5.
  - Verify empty/precheck no token consumption, allocation before copy/projection, failed-projection token consumption, one capture, <=17 candidates, whole-page failures and final envelope bounds.
- [ ] 5 Implement source accessor/allocator/full callback ownership and shared readonly command-policy export; pass exact code review and race/resource-isolation checkpoint.
  - Requirements: 1.2, 2.1–2.7, 3.7; Properties 1, 2, 4, 5.
  - Include network/recording lifecycle, all-field error/backoff projections, late old callbacks, cleanup/watchdog/retry and reentrant logs/events/stream writes; operational registration continues on evidence allocation failure.
- [ ] 6 Implement route factory and serial composition/exports/public documentation; pass actual mounted protected AND legacy validation.
  - Requirements: 3.1–3.8; Property 6.
  - Execute the complete routing/Unicode/100–101 UTF16/256–257 UTF8/list-to-GET/cursor/HEAD/write matrix, root admission/parser versus local error boundaries, Node framing rejection and excluded synthetic-stream/abort boundaries. Direct handler mocks are insufficient.
- [ ] 7 Pass serial touched tests, typecheck, lint, build, broad merged runtime validation as warranted and exact independent implementation review before normal fast-forward publication.
  - Requirements: 1.1–1.6, 2.1–2.7, 3.1–3.8; Properties 1–6.
  - Execute the deterministic and >=100-run traced property matrices from the design, including exhaustion/permanent failure, literal high-bit magic, source variants and no receiver side effects. No RF/live/Pi/physical-control qualification or activation.
