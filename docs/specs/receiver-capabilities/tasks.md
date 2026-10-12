# Receiver capabilities tasks

Status: read-only foundations and route composition implemented and software-validated in protected and legacy modes. Current numerical regional data and physical receiver support/readback remain unavailable or unknown. No browser, regulatory or hardware qualification is implied.

See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

Provider, coherent SourceManager capture/allocator/callback guards, shared readonly REST policy and actual protected/legacy route composition passed independent code review and software checks. API drain precedes provider disposal and source teardown in both modes. Mocks cannot establish physical receiver support.

- [x] 1 Freeze the complete public requirements/DTO/error/bounds/design assembly after independent exact review.
  - Requirements: 1.1–1.6, 2.1–2.7, 3.1–3.8; Properties 1–6.
  - No implementation follows solely from design approval.
- [x] 2 Review exact source evidence accessor/allocator/callback-ownership/policy integration allocation and race tests before runtime authoring.
  - Requirements: 1.1–1.2, 2.1–2.7, 3.7; Properties 1, 4, 5.
  - Existing getters cannot substitute. Preserve stream stripping, payload conversion, control behavior and normal retry policy outside the specified race corrections.
- [x] 3 Implement pure literal RTL0 projection, closed policy DTO and validators.
  - Requirements: 1.2–1.5, 2.4, 3.2; Properties 2, 3.
  - Keep physical support and current values unknown; validate all 15 command rows against shared admitted REST policy, distinguishing numeric setter from REST enum/boolean acceptance.
- [x] 4 Implement detached synchronous get/page/dispose with bounded errors and every-lookahead validation.
  - Requirements: 1.1, 1.6, 2.2, 2.7, 3.2–3.5, 3.7; Properties 1, 4, 5.
  - Verify empty/precheck no token consumption, allocation before copy/projection, failed-projection token consumption, one capture, <=17 candidates, whole-page failures and final envelope bounds.
- [x] 5 Implement source accessor/allocator/full callback ownership and shared readonly command-policy export; pass exact code review and race/resource-isolation checkpoint.
  - Requirements: 1.2, 2.1–2.7, 3.7; Properties 1, 2, 4, 5.
  - Include network/recording lifecycle, all-field error/backoff projections, late old callbacks, cleanup/watchdog/retry and reentrant logs/events/stream writes; operational registration continues on evidence allocation failure.
- [x] 6 Implement route factory and serial composition/exports/public documentation; pass actual mounted protected AND legacy validation.
  - Requirements: 3.1–3.8; Property 6.
  - Execute the complete routing/Unicode/100–101 UTF16/256–257 UTF8/list-to-GET/cursor/HEAD/write matrix, root admission/parser versus local error boundaries, Node framing rejection and excluded synthetic-stream/abort boundaries. Direct handler mocks are insufficient.
- [x] 7 Pass serial touched tests, typecheck, lint, build, broad merged runtime validation as warranted and exact independent implementation review before normal fast-forward publication.
  - Requirements: 1.1–1.6, 2.1–2.7, 3.1–3.8; Properties 1–6.
  - Execute the deterministic and >=100-run traced property matrices from the design, including exhaustion/permanent failure, literal high-bit magic, source variants and no receiver side effects. No RF/live/Pi/physical-control qualification or activation.

Software checkpoint (2026-10-12): 268 touched tests across six files and 5,520 root tests passed, with 15 root skips retained. Fresh workspace tests include 341 CLI tests. Typecheck and builds passed; lint has zero errors and 62 existing warnings. Normal fast-forward publication follows reviewed merged checks; no physical support or current-value readback is inferred.
