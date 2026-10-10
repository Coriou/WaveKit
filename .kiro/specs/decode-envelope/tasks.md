# Decode envelope — tasks

Status: draft only. No source implementation is authorized yet. Tasks are
sequential and limited to a new-path, unmounted foundation.

- [ ] **1. Design and ownership checkpoint.** Review requirements, exact v1 shape,
      bounds, JSON projection semantics, caller ID ownership and event-time RF context
      with the independent reviewer. Confirm scanner Task 25 refs and the future shared
      publication gate. This draft does not authorize scanner or existing-file edits.
      _Requirements: 1.1–1.5, 2.1–2.3, 3.1–3.5, 4.1–4.4, 6.3._

- [ ] **2. Add internal DTO and bounded projection.** Once authorized, create only
      src/core/activity/types.ts and projection.ts. Implement plain JSON/Date projection,
      undefined object/array semantics, inert unknown keys, safe descriptors and generic
      WaveKitError failures. No IDs, clocks, config, I/O, logging or runtime subscriptions.
      _Requirements: 1.2, 1.5, 5.1–5.5, 6.2, 6.3._

- [ ] **3. Add construction and strict boundary validation.** Create only
      src/core/activity/envelope.ts. Require eventId, decoder attribution and receivedAt;
      preserve producedAt/outputType; apply unknown presentation/provenance defaults;
      validate explicit context, unique typed fields, refs, version and final encoded
      UTF-8 size. Do not infer protocol/frequency from the generic payload or inspect
      existing runtime state. No public API-types entrypoint/export changes.
      _Requirements: 1.1–1.4, 2.1–2.3, 3.1–3.5, 4.1–4.4, 5.4, 6.1–6.3._

- [ ] **4. Add meaningful unit and property tests.** Create only
      tests/unit/core/activity/projection.test.ts and envelope.test.ts. Use real current
      normalized output shapes (ACARS's undefined members and fallback frequency,
      VDL2 zero, aircraft/AIS dates, `rtl_433` unknown fields, pager, mesh and call lifecycle).
      Verify the five design properties with at least 100 property runs where applicable.
      Add hostile getters/custom serializers, cycles/shared subtrees, prototypes,
      invalid dates/numbers, exact UTF-8/escape bounds, conflicting decoder IDs, repeated
      field keys, malformed refs and unsupported versions. No hardware or decoder
      subprocess execution, scanner service or durable store scaffolding.
      _Requirements: 1.1–1.4, 2.1–2.3, 3.1–3.5, 4.1–4.4, 5.1–5.5, 6.1, 6.2, 6.4._

- [ ] **5. Foundation checkpoint.** Freeze owned source after targeted tests and
      focused lint, obtain independent source review, and coordinate repository
      typecheck/lint. Report real outputs and remaining integration gaps. Commit only
      the authorized new paths with requirement references after checkpoint approval.
      Do not mark any runtime/Activity feature complete from foundation-only checks.
      _Requirements: 1.5, 6.3, 6.4._

Deferred follow-up, not authorized by this task list: shared DTO publication and
consumer coordination; event-time source/channel binding APIs; scanner terminal
result ownership and stable target revisions; ingress ID allocation and immutable
broadcast events; admission policy for telemetry; persistent events/search/replay;
recording/transcript links and lifecycle updates. Design those together before
mounting or storage rather than interpreting scanner recovery stores as Activity.
