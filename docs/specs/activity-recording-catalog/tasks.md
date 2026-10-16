# Activity and recording catalog — tasks

Status: independently reviewed design. Event foundation batch 1 is mounted:
envelope publication, the SQLite store, search, facets and cursor replay run
when `activity.enabled` is true and stay absent when it is false. Storage
qualification (task 2) is still open, so tasks 2–8 and the checkpoints stay
unchecked. Still deferred: receipts, kinds other than decoder-reception and
ingestion-gap, recordings and the catalog, CLI and web views, Docker image
verification of the Node 24 base, and measured retention. Follow dependencies;
Main assigns owners at each remaining gate.

- [x] **1. Draft design review checkpoint.** Audit actual core/envelope, scanner candidate and
      planned S2/S3, native recordings/pruners, CLI and external web references. Resolve
      independent Sol research and adversarial review objections. Publish these three
      spec files and retain private ownership/review ledger separately. Two source audits
      and amended-design review passed; accepted-S1 reconciliation is prepared against90bfa031 on released d452b0a;
      its independent delta review passed with no remaining design blockers. Main owns
      local landing and allocation of the implementation gates below.
      _Requirements: 1.1–1.6, 4.1–4.5, 6.6, 7.1–7.3._
- [ ] **2. Runtime/storage qualification, independent first implementation batch.**
      The bounded micro harness is implemented and independently approved. The next
      phase is the independently approved long-scenario extension plan in design.md.
      The driver/admission/report-containment item is accepted. The second sequential
      worker/query/receipt/fault item passed exact review for bounded fixtures only.
      A separately allocated capped consumer and mock tests are implemented with
      narrow driver reservation glue; their exact code review is pending. Long-scenario wiring, unsupported
      growth bounds and any execution window remain separately gated. Fifteen-minute sustained,
      burst, matrix and combined-scanner experiments require a separate resource window; no production modules or shared edits in this batch. Prove feature-specific Node22.13+ floor and exact
      tested patch, harness disabled path on Node20, SQLite/FTS5 direct-worker availability
      and native AMD64/ARM64 runner behavior. Production worker build entries, state
      mounting, disabled-startup behavior and package/image integration belong to a
      separately allocated integration gate after qualification. Use bounded
      disposable fixtures to measure4KiB/row assumption, index plans, worker cancellation,
      WAL cap, fsync behavior and combined100/s workload. No runtime mount or Docker
      image build without a separate authorized window. Stop if runtime floor rejected.
      _Requirements: 2.3, 2.5, 3.1, 5.4, 7.2, 7.3._
- [ ] **CHECKPOINT A — contracts/ownership.** Main accepts S1 and releases shared
      paths. Scanner owner settles target IDs/attempt revisions/outbox and event-time
      binding seams; CLI/web owners review envelope promotion/list/cursor reset shapes.
      Protected-runtime owner confirms admission/lease/origin hooks. No parallel changes
      to packages/api-types, server/events/index/build files without allocation.
      _Requirements: 1.2–1.6, 2.1, 6.1, 7.1._
- [ ] **3. Durable Activity core.** Depends on2 and checkpointA. Promote canonical
      DTOs, add narrow manager ingress/adapters, immutable IDs and qualified clocks;
      implement worker store/transactional FTS, loss accounting, quotas, migrations and
      recovery. Preserve legacy output and completed envelope behavior. Implement
      properties1–3,5,10 with≥100 runs and crash fixtures. No recording mounts yet.
      Batch 1 mounted the enabled-path store and decoder ingress. This task stays
      open: qualification, receipts, migrations and the wider property set are
      not closed.
      _Requirements: 1.1–1.6, 2.1–2.5, 7.2._
- [ ] **4. Activity query/replay.** Depends on3. Implement strict filters/indexed
      keyset pages, authenticated cursors, fixed barrier, scannedThrough, duplicate
      handling, restart/retention reset and bounded WS drain. Test property4 and query
      deadlines, filtered-empty pages, live-during-snapshot, restore and slow clients.
      Mount only after protected runtime acceptance; inspect CLI/web consumers.
      Batch 1 mounted search, facets and cursor replay on the activity routes
      and the activity WebSocket channel. CLI and web views are not wired, and
      this task stays open until qualification and protected acceptance land.
      _Requirements: 3.1–3.5, 6.1, 6.6, 7.1–7.3._
- [ ] **CHECKPOINT B — S2/S3 recording contract freeze.** Scanner S2 establishes
      analog lifecycle/close/sample/provenance/cessation; S3 establishes monitor routing,
      ownership and intentional recording coverage. Re-audit final digital close/link
      semantics and all scanner capture/evidence delete paths. Agree exact adapter
      ownership, shared capacities and native recording-disable mechanism. These are
      blockers to managed recording writes, not evidence that S1 already provides them.
      _Requirements: 4.1–4.5, 5.2, 5.4, 7.1._
- [ ] **5. Catalog and media lifecycle.** Depends on2,3 and checkpointB. Implement
      stable IDs/aliases, typed media/provenance/coverage, file intents, no-clobber
      staging/publication, reconciliation and bounded imports. Test property6 including
      producer death and EXDEV; verify native closure rather than waiting a fixed delay.
      Read-only legacy inventory can precede adapters, but cannot enable managed Keep.
      Amended (WG8): the read-only legacy inventory is delivered by
      [web-gaps-8](../web-gaps-8/requirements.md) requirement 4 before checkpoint B (protected
      list and whole-file download; no Keep, delete or trim). This task stays open.
      _Requirements: 4.1–4.5, 2.5, 7.2._
- [ ] **6. Unified deletion decisions and capacity.** Depends on5. Integrate every
      existing deletion owner; implement generation-fenced durable scanner Keep handshake, recording CAS,
      effective protection union, file leases, delete intents, per-filesystem reserve,
      write cessation and accounting. Properties7–8, full deletion-path matrix tests,
      ENOSPC/statfs failures and stale two-store recovery. Enable per-recording Keep only
      after no bypass remains. Preserve unrelated scanner recovery/evidence behavior.
      _Requirements: 5.1–5.5, 4.5, 7.2._
- [ ] **7. Protected playback and WAV trim/export.** Depends on6 and mounted access.
      Implement metadata CAS, validated PCM WAV Range/seek, trim virtual media, pinned
      revision exports, admission quotas and revocable session/file leases. Property9,
      actual client seek/range/401/403/416/disconnect tests; no credentials in links.
      _Requirements: 6.1–6.4, 7.2, 7.3._
- [ ] **CHECKPOINT C — integrated acceptance.** Coordinate quiet-host targeted
      suites, repository typecheck/lint and bounded whole-suite window; measure combined
      scanner/decoders/storage/search workload. Validate restart/crash retention, all
      deletion owners, low disk, actual native closure and protected playback. Publish
      capability/coverage limits; live RF and deployment acceptance are separate. Main
      announces contracts in coordination docs and allocates CLI/web integration.
      _Requirements: 2.3–2.5, 4.4, 5.1–5.5, 6.1–6.4, 7.1–7.3._
- [ ] **8. Later capability batches, separately allocated.** Opus encoding;
      SigMF export and IQ playback/source restoration; manual/live recording across
      validated producers; transcription and mutable catalog search. Each requires
      bounded jobs, capability evidence and owner review. No alias/BER/tone decoding,
      universal settings, map store or full-call coverage is implied.
      _Requirements: 4.4, 6.4–6.6, 7.1–7.3._

For implementation, run touched test files, `pnpm run typecheck`, `pnpm run lint`
and required checkpoint checks, reporting exact outcomes. Use bounded workers and
coordinate full suites. For the disposable harness, validate guardrails and bounded microfixtures, links,
requirement traceability and the owned diff. Independent harness review precedes
broader experiments; harness tests do not prove production persistence contracts.
