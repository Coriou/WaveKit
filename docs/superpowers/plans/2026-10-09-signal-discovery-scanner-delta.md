# Signal discovery scanner plan: delta against main 63c9c49

Status: Task 23 re-check, 2026-10-10. Applies to
[`2026-10-09-signal-discovery-scanner.md`](2026-10-09-signal-discovery-scanner.md) (plan-time facts verified
against `main` c4c1cda). `main` is now `63c9c49` (core channelizer merged, `channelizer.enabled` default false).
Read your task's section before starting. Where this note and the plan differ, **this note wins** for the tasks it
names. Line numbers are on `main` 63c9c49; find code by symbol, since line numbers move.

Form: `**Task N.** <as planned> → <on main @ 63c9c49>; <what the task does instead>`.

## Task 23

- **Task 23 (Step 1).** Channelizer not merged → merged: `git log main -- src/core/channelizer` gives `89df12e`
  (most recent of 5 shown), and `src/core/channelizer/types.ts` exists (`ChannelFormat = "cu8" | "cf32"`). Step 7
  (slip rule) does not apply.
- **Task 23 (Step 6).** Fresh `.claude/worktrees/scanner` + cherry-pick of S1-A → not done. The controller rebased
  `feat/scanner-s1a` onto `main` 63c9c49 (S1-A = 42 commits on top), so S1-B continues in
  `.claude/worktrees/scanner-s1a` on branch `feat/scanner-s1a` (user instruction). No new worktree, no
  `pnpm install`. Baseline `pnpm run typecheck` on that branch: exit 0 (root `tsc --noEmit` clean; workspace
  typechecks were turbo cache hits).
- **Task 23 (Step 5).** CLI acknowledgement of "Core: proposed contract for the signal discovery scanner"
  (`docs/CLI-COORDINATION.md` :716) → **none**. Below the proposal there are only core-authored amendments
  (2026-10-09 spectrum channel, 2026-10-09 identify, 2026-10-10 identify details, 2026-10-10 artefact and spectrum
  shapes); no CLI reply on `main` or any other branch. The brief's no-reply rule would have held back Tasks 25, 29
  (status fields and route codes), 37 and Task 27's WS field. **User decision (2026-10-10): the gate is lifted.**
  Tasks 25, 27 (incl. the WS field), 29 and 37 proceed with the contract as proposed, without a CLI ack. Any later
  CLI change request is recorded in this note under the affected task and handled as a follow-up task. The Core note
  on `ScannerSettingsView` was appended under the proposal.
- **S1-A shared-file baseline.** S1-A touched no shared file except the new
  `src/decoders/builtin/dsd-fme-link.ts`, so every shared file on the branch equals `main`.
- **Unchanged since c4c1cda (no delta, line moves at most):** `src/core/tuner-controller.ts` (`SET_TEST_MODE` :65,
  `command-sent` :197, `applyExternalCommand` :384, `setFrequency` :595, `setTestMode` :659, `synchronizeOnConnect`
  :878 with replay `command-sent` :940, `validateSourceForControl` :1043, `markAccepted` in `sendCommand` :1238;
  the plan's :1237 was off by one at plan time); `src/core/fanout-manager.ts` (`BranchConfig` :18, `addBranch`
  :155, `getBranchTelemetry` :329); `src/core/source-fanout-router.ts` (`getDefaultSourceId` :51-54, `getFanout`
  :56); `src/core/digital-voice.ts` (`prepareDecoderConfigs` :208, `attachDecoder` :257, `/stream` :504);
  `packages/api-types/src/resources.ts` (`cpuUsagePercent` :21); `src/api/routes/*` and
  `packages/api-types/src/decoders.ts` (`decoderSuspensionReasonCodes` :88, `DecoderSuspensionReasonCode` :180);
  `channel-squelch.ts`, `signal-level.ts`, `band-override-store.ts`; `package.json` `build` :19 (only `license`
  changed); nothing in `src/` uses `worker_threads`.

## Task 24

- **Task 24 (carry).** Runtime-settings bounds must import `RuntimeSettingsOverridesSchema`
  (`src/core/scanner/store/persistence.ts` :253), never copy it.
- **Task 24 (anchors).** `ConfigSchema` ends `csdr: CsdrConfigSchema.default({})` → on main it is followed by
  `channelizer: ChannelizerConfigSchema.default({})` (the two fields are at `src/config.ts` :419-420), and
  `ChannelizerConfigSchema` (`src/config.ts` :383-401) sits directly above `ConfigSchema` (:407); the
  `ChannelizerConfig` type follows `CsdrConfig`. Insert as planned
  (the `csdr` anchors are still unique); `ScannerConfigSchema` goes between `ChannelizerConfigSchema` and
  `ConfigSchema`. `config/default.yaml`: the `csdr:` anchor (`bufferElements: 65536` :424, `# Health Monitoring`
  :427) is unchanged; the channelizer's commented block is at the end of the file (:667), so no conflict.

## Task 25

- **Task 25 (Step 5).** CLI ack of the scanner contract → none. Per the user's decision of 2026-10-10 (Task 23),
  Task 25 proceeds with the DTOs as proposed. No DTO changes were requested; any later CLI request goes into this
  section and a follow-up task.
- **Task 25 (A3 mapping, confirmed).** `CoreSuspensionReason = DecoderSuspensionReasonCode |
  ChannelAdmissionReason` (`src/decoders/types.ts` :65-67); `publicSuspension()` (`manager.ts` :196-203) drops the
  object only for `isChannelAdmissionReason(code)` (`channelizer/types.ts` :34-38: `channel-outside-capture`,
  `channel-request-invalid`, `channelizer-unavailable`). Adding `"tuner-scanning"` to
  `DecoderSuspensionReasonCode` and to `decoderSuspensionReasonCodes` makes it public with no channelizer change.
  The three channel codes are still **not** in the public union; the 2026-10-09 coordination request for them is
  open and is not Task 25's scope.
- **Task 25 (carry, plan-preview provenance).** `ranges.rasters` and `fftSize` are labelled `"default"` even when
  config-derived; no correct label exists in the `operator | bandplan | measured | default` vocabulary. Task 25
  decides the label in the DTO (for example a `config` member) and the plan-preview code follows it.
- **Task 25 / C3 (carry).** S1-A added the test-only export
  `trackIdPrefixes(sourceId: string, atMs: number): { main: string; wideband: string }` in
  `src/core/spectrum/pipeline.ts` :84-90. `main` is `` `${sourceId}-${atMs.toString(36)}-` `` and `wideband` is
  `` `${main}w-` ``. Rationale: track ids are prefix + base-36 sequence, so the wideband prefix extends the main
  one with a character outside base 36 (`-`). A bare `w` would make main track 1153 read `…-w1` and collide with
  wideband track 1. Add this C3 contract entry.

## Task 26

- No delta. `SourceManagerEvents` gained only `removed(sourceId)` (internal teardown: permanent removal, reconnect,
  shutdown; `source-manager.ts` :137). U8_IQ alignment is at :399-405 (`iqRemainder` :215). The channelizer accepts
  only CU8 sources (`channelizer-manager.ts` :109), so aligning S16_IQ/FLOAT32LE chunks does not touch it.

## Task 27

- No code delta (`tuner-controller.ts` unchanged).
- **Task 27 (Step 5).** The brief made the WS field (`tuner:command-sent` `origin`) wait for a CLI ack. No ack
  exists, but the user decided on 2026-10-10 (Task 23) to proceed as proposed, so the WS field is in scope with
  the rest of Task 27. Any later CLI request goes into this section and a follow-up task.
- Note for Tasks 33 and 35: every `setFrequency` caps update now also
  invalidates the source's channels when the channelizer is enabled (see Task 33).

## Task 28

- **Task 28 (cf32 tail, corrected).** "The mode flag test asserts on the dsd-fme argument list only" → the test
  asserts on the whole `buildPipelineCommand()` string with whitespace-bounded tokens (`(^|\s)-fi(\s|$)`). The cf32
  tail only made the csdr front stages conditional: `buildIqFrontStages` (`audio-demod-decoder.ts` :386-397)
  returns `convert/shift/decimate: null` when `inputIsChannelIq()` is true (the gate is defined at :322-324 and
  reads `options.inputIqFormat === "cf32"`; it is called at :395). `dsd-fme.ts` :907-913 pushes only the non-null
  stages. The default
  (cu8) path is unchanged and no csdr or sox stage emits a bare `-fi`/`-fm`/`-fn`, so the test stays as written.
- **Task 28 (anchors).** Mode switch `case "nxdn":` is at `dsd-fme.ts` :1035 (`-fn` :1037); CRC-ERR in
  `updateErrorWindow` :1213; `DMR_TGT_SRC` use :1333, `DMR_ENCRYPTED` use :1370; `findWavFileAsync` :1947.
  `DsdFmeMode` (:164) still has no `nxdn48`/`dpmr`. Keep the channelizer's `channelizerSupported()` override
  (:866) untouched. The brief's grep for `handleCpuIq` matches nothing on c4c1cda or main (the symbol never landed);
  the cf32 tail lives in `buildPipelineCommand`.

## Task 29

- **Task 29 (Step 5).** No CLI ack, but per the user's decision of 2026-10-10 (Task 23) the status fields and
  route codes proceed as proposed. Any later CLI request goes into this section and a follow-up task. Ordering is
  unchanged: Task 29 depends on Task 25's `tuner-scanning` code, so it runs after Task 25.
- **Task 29 (types, corrected).** "If `CoreSuspensionReason` exists, `Eligibility.blockedBy` and
  `DecoderSuspension.reasonCode` are typed with it" → on main `DecoderSuspension.reasonCode` is already
  `CoreSuspensionReason` (`manager.ts` :167-170), and `Eligibility.blockedBy` is `DecoderSuspensionReasonCode | null`
  (:206-210) because channel codes never come from `assessEligibility` (they are set by `holdForChannel`, :1332).
  Change neither type. `"tuner-scanning"` is a `DecoderSuspensionReasonCode` after Task 25, so it fits `blockedBy`
  as is, and `publicSuspension()` passes it through (`isChannelAdmissionReason("tuner-scanning")` is false).
- **Task 29 (hold placement, confirmed).** `assessEligibility` (:2175-2194) has no channelizer additions; use the
  plan's replacement verbatim (hold first). The E10b guard is in `evaluateRate`'s suspended branch (:1808-1814:
  `eligibility.blockedBy === null && this.sameChannelAnswer(state, caps)`), so with a hold it is skipped and the
  last `else` (:1819-1824) sets `state.suspension.reasonCode = "tuner-scanning"`, keeping `since`. A decoder held
  for a channel reason becomes a scanner hold; on release, `sameChannelAnswer` is false (no longer a channel code),
  so `resume` re-requests its channel (:1945-1957). `scheduleChannelRetry` only re-evaluates while a decoder is held
  for `channelizer-unavailable`, so it goes quiet under a hold. The start path (:509-536) takes the existing
  suspended-start branch for `blockedBy: "tuner-scanning"`, as the plan says.
- **Task 29 (channelizer-aware edits, confirmed and corrected).**
  - `unwireDecoderFromFanout` (:1434-1452): additive edits only. Keep `this.releaseChannelOf(state)` and
    `state.channelStale = false` in the inner `finally`.
  - `registerDecoder` state literal (:423-454): keep `channel: null, channelStale: false` (:447-448); add the
    owner fields after `startMode: "auto",` (:450). `this.refreshRatePlan(state)` is at :455.
  - `wireDecoderToFanout` returns `Promise<WireOutcome>` (:190-193, :1078); `{ wired: true }` already exists for
    external decoders (:1088). The plan's anchor "`const request = this.channelRequestFor(state)`" → on main the
    block after `if (sourceId && this.sourceManager) { … }` is `const provider = this.channelizer`,
    `state.channelStale = false`, `const request = this.channelRequestFor(state, caps)` (:1116-1119). Insert
    `if (state.input) return { wired: true }` directly before `const provider = this.channelizer`, so a probe with
    its own input never requests a channel, never gets `inputIqFormat: "cu8"` (:1123-1124) and never gets a branch.
    Why this anchor and not the plan's: it is the first line after the source block on main. It is two lines above
    the plan's anchor, so the return also skips the channelizer's `state.channelStale = false` reset. That reset
    is harmless to skip: a probe never holds a channel, so `channelStale` stays false for it. The source block
    (:1098-1115) still runs for probes, as Task 29 requires: `state.inputCaps`, `decoder.updateOptions`
    (`inputSampleRate`, `inputCenterFreq`), `refreshRatePlan`, `sourceManager.assignDecoder` and
    `state.assignedSourceId`. So `status.sourceId` is set and the caps are applied.
    `createEphemeralDecoder` checks `outcome.wired`; when it is false the probe is not started and the remove path
    runs (plan code, unchanged).
  - `handleCapsChange`: the anchor `if (this.selectedSourceId(state) !== sourceId) continue` occurs twice
    (`previewRates` :735 and `handleCapsChange` :1619). Insert the `owner === "scanner"` skip in
    `handleCapsChange`'s first loop only (the one preceded by `if (this.decoders.get(decoderId) !== state)
    continue`).
  - `drainCapsChanges` (:1586-1602): the loop body is unchanged on main, so the plan's `capsWork` chain and
    `runPendingCapsChanges` apply verbatim (`capsWorkerRunning` :305).
  - Other anchors exist as written: `handleDecoderExit` `realExit && !errorThisRun` :962; `getStatus` `startMode`
    spread :709; `removeDecoder` `this.decoders.delete(id)` :778; `restartDecoder` :603 with
    `await this.startDecoder(id, { startMode })` :626; `bandOverrides` field :311.
- **Task 29 (Step 6).** Also run `tests/unit/decoders/manager-channelizer.test.ts` (on main) with the listed tests.

## Task 32

- **Task 32 (anchor).** `Dockerfile` node-build check `RUN ls -la dist/ && head -1 dist/index.js` moved :546 →
  :550 (the channelizer added a Rust build stage). `scripts/build-file.mjs` and `package.json` `build` are unchanged.
- **Task 32 (I3, see Task 35).** If Task 35 cannot synthesize `track-close` cleanly, the fallback is a C3 addition
  `SpectrumPipeline.closeAll()` here.
- **Task 32 (informational).** `SourceManagerEvents.removed(sourceId)` now exists (internal teardown, also fired by
  reconnect); the channelizer uses it with `disconnected`. The engine may use it the same way; no plan change.

## Task 33

- **Task 33/35 (carry).** `preempted-job` is INVALID from job state `starting` (which holds the lease): the arbiter
  never hands the lease over from a starting job.
- **Task 33 (channelizer interaction, informational).** With `channelizer.enabled`, `ChannelizerManager.onCaps`
  invalidates every channel of a source whose sample rate or centre changed (`channelizer-manager.ts` :149-152,
  `capsDiffer` :738-744), so each hop retune tears down that source's channels. No change: the runner awaits
  `holdSource` before its first retune, so channel-fed configured decoders are already suspended. The channelizer
  defaults to off.

## Task 34

- **Task 34 (carry).** multimon confirm pairing is limited to the hold span ±2 s; pass `nxdn` for ambient decoders.
- **Task 34 (probe configs).** S1 probe configs must not set `useChannelizer` (unset is falsy; the Zod default
  only applies to YAML config). Probes created with `input` return from wiring before any channel request (Task 29
  delta). `offsetHz` on the raw cu8 path is unchanged (`buildIqFrontStages` shift stage); `IqDecimateDecoder`
  still has no offset stage on the raw path, but now reads `options.channelHz` for a channel request (`readChannelHz`,
  `iq-decimate-decoder.ts` :95-104). That is Task 40's transport, not S1.

## Task 34a

- **Task 34a (Step 3).** `export const FixtureRoleSchema` (:11) and `export const FixtureSchema` (:55) exist in
  `tests/integration/fixtures/manifest.ts` on main, under those names. The move target stands:
  `src/core/fixtures/manifest-schema.ts`, and the test module re-exports it (a sanctioned exception to "no
  re-exports", so existing importers keep their path). No local Zod copy. `.dockerignore` still drops `tests`
  (:51-52).
- **Task 34a (schema grew, corrected).** The plan's inline copy of the schema block (plan :40229-40322) → stale.
  Main's schema has two additions the move must carry: a third `FetchSchema` member
  `{ kind: "generated", recipe: /^recipes\/[a-z0-9][a-z0-9_]*\.json$/ }` (channelizer T7a), and
  `ExpectedSchema.marginal_keys` (array of JSON-encoded `key_fields` tuples, ruling QH-14) with its `superRefine`
  checks (channelizer goldens with `key_fields` only, tuple length, never equal to a payload key). Move **main's
  block verbatim**: `manifest.ts` :5-164 (from `CONTAINER_SAFE_ID` through the `Fixture`/`Manifest` types). Keep
  `parseManifest`/`loadManifest` (and the `fs`/`yaml` imports) in the test module. Importers to keep green:
  `tests/unit/fixtures/fixture-harness.test.ts` (`FixtureSchema`), `tests/unit/fixtures/manifest-v2.test.ts`,
  `tests/integration/iq-fixture-goldens.test.ts` (`loadManifest`, `Fixture`), `tests/integration/fixtures/harness.ts`
  (`Fixture`). Capture sidecars (`license: "private"`, `fetch: {kind: "private"}`) satisfy the private iff rule.
- **Task 34a (channelizer facts, context).** All 7 per-decoder channelizer flags (`channelizerSupported()` in
  dsd-fme, multimon-ng, direwolf, rtl433, acarsdec, ais-catcher, dumpvdl2) are gate-verified in
  `fixtures/GOLDENS.md` (rulings QH-1..QH-14; QH-3 and QH-5 do not appear in the file), including manifest
  `expected.marginal_keys`. The golden harness runs `docker exec` asynchronously (`spawn`,
  `iq-fixture-goldens.test.ts` :52-75, ruling QH-9). `scripts/dsd-fme-voice-ab.mjs` compares CRC-valid TGT/SRC only
  (CRC ERR lines are reported, not compared, QH-12).

## Task 35

- **Task 32/35 (carry, I3).** On the engine `"stream"` event (restart) and on release (Task 32 `restartPipeline` /
  `stop`), Task 35 synthesizes `track-close` for every live observation of that source. Fallback if that proves
  awkward: add `SpectrumPipeline.closeAll()` (C3 addition, Task 32).
- **Task 35 (carry).** The boot path catches journal I/O rejections from `DiscoveryStore` persistence `load()` (it
  throws on an unreadable journal). Leftover `*.tmp` files are not cleaned by S1-A.
- **Task 35 (rollback order). Controller ruling (2026-10-10).** The plan's `rollback()` (plan :32819-32845)
  releases in the order engine, then decoder hold, then lease. `teardown()` (plan :32796) releases the lease
  (with restore), then the decoder hold, then the engine, and the S1-A transition table (`job-state.ts` :99, :125,
  :139) also puts the lease before `release-decoders`. The plan's own design line (plan :31878) lists "lease with
  restore, decoder hold, engine reference". With the channelizer, releasing the hold first resumes channel-fed
  decoders at the scan frequency, and the restore retune then invalidates their new channels (Task 33 note).
  Ruling: `rollback()` releases in the order lease (with the restore retune), then decoder hold, then engine,
  mirroring `teardown()`. Each step keeps its `before.*` guard and its `.catch` warning. If any plan assertion
  depends on the old order, the Task 35 implementer flags it rather than silently changing the test.

## Task 35a

- **Task 35a.** `createIdentifyDriver` keeps `channelizer: () => false` in S1-B. The channelizer is merged but is
  not wired into the scanner until Task 40, which flips it.

## Task 36

- **Task 36.** `POST /discoveries/:id/listen` stays the pre-channelizer form as planned (channelizer default off,
  no scanner channel transport in S1). Task 46 upgrades it.

## Task 37

- **Task 37 (Step 5).** No CLI ack, but per the user's decision of 2026-10-10 (Task 23) Task 37 proceeds with
  the WS contract as proposed. Any later CLI request goes into this section and a follow-up task.
- **Task 37 (carry).** Pass a monotonic clock (`performance.now()`) to `WsLimiter`; the plan text passes
  `Date.now`.

## Task 37a

- **Task 37a (carry).** An alarm block emits no `block-summary` (wording: "every block" except alarm blocks).
  Occupancy `importState` must not accept untrusted data unvalidated.
- **Task 37a (web dashboard overlap, record only, no scope change).** `docs/web/CORE-GAPS.md` on
  `github/design/web-dashboard` lists these items that overlap 37a:

  | CORE-GAPS item | Task 37a delivers | Overlap |
  |---|---|---|
  | FFT stream for spectrum and waterfall, incl. zoom (higher-resolution FFT of the viewed slice) | `spectrum` WS channel, `spectrum:frame` per source (max-hold, 0.5–25 Hz, 128–2048 bins, one server profile), `GET /api/spectrum` | partial (no zoom or slice FFT; per-subscription profiles deferred) |
  | Low-latency tuner control over WebSocket; drag-to-pan retunes the centre | nothing; cursor tuning uses the existing REST `PATCH /api/live-audio/config` and `POST /api/tuner/:sourceId/frequency` | not covered |
  | Signal history per frequency (auto band map) | `GET /api/spectrum/occupancy` (hourly duty per 12.5 kHz bucket, 7 days); identities come from discoveries (Tasks 35/36) | partial |
  | DC removal, IQ correction, IQ swap | DC is masked in the display only (`masks.dcHz`, `dcGuardHz`) | not covered |
  | IQ capture of the viewed span, IQ playback as a source, SigMF export | nothing in 37a; Task 34a captures burst IQ with manifest v2 sidecars (no playback, no SigMF) | not covered by 37a |

  Scope changes go through the orchestrator; Task 37a executes as planned.

## Task 38

- **Task 38 (anchors, confirmed).** `src/index.ts`: the `DigitalVoiceService` import (:38) is now followed by
  the `ChannelizerManager` import, and the scanner imports still go after it. Decoder loop :389 (`"Failed to create
  decoder"` :400), `// Step 8: Initialize resource monitoring` :405, `aircraftTracker:` in the ApiServer deps :534.
  `decoderConfigs` is now typed `DecoderConfig[]` (from `decoders/types.js`, :383), which matches
  `ScannerServiceDeps.decoderConfigs`. Shutdown uses `shutdown.register` (`GracefulShutdown`, LIFO at
  `graceful-shutdown.ts` :106); the brief's `registerShutdownHook` grep matches nothing on c4c1cda or main.
  Registration order on main is source-manager :552, fanout-manager :562, live-demodulator :573, digital-voice
  :583, tuner-relay :593, **channelizer :605 (only when enabled)**, decoder-manager :616, audio-output :626,
  api-server :636. The scanner hook inserted before api-server therefore runs before decoder-manager **and the
  channelizer**. Add the channelizer to the `## Graceful Shutdown` order line in `docs/ARCHITECTURE.md`. The router
  construction moved to :267-272 (Task 31 replaces it).
- **Plan and spec text fixes (docs wording only; write them into `docs/SCANNER.md` where they apply):**
  - "decoded" means the first ACCEPTED identity, not any identity-bearing evidence.
  - `block-summary` is emitted for every block except alarm blocks (see Task 37a).
  - Spec § 4.9 (R6), impulse blanking. The plan's rule is kept: a frame is blanked when it is ≥ 6 dB over **the
    previous block's integrated mean power per bin** on ≥ 50 % of the usable bins. The first block of an epoch is
    judged against its own per-bin median ÷ ln 2. RFI is active after ≥ 3 impulse **events** (blanked frames within
    2 N samples count as one event) whose last two intervals agree within ± 10 %; the period is their mean. The spec
    currently says a frame "rises ≥ 6 dB over the **per-bin floor** on ≥ 50 % of usable bins" and RFI is "≥ 3
    blanked **frames** at a stable interval (± 10 %)". Reason: the floor reference would blank steady wideband
    occupants (§ 4.3); on noise-only bins the plan's reference equals the floor. A spec amendment is needed
    (orchestrator to schedule; not in any S1-B file list).
  - Spec § 4.9 (R7), IQ image OBW match. The plan's rule is kept: the −6 dB OBWs agree within
    **`max(30 % of A, 2 RBW)`**. The spec currently says "similar OBW (± 30 %)". Reason: the 2 RBW term is needed
    for 1-RBW tones. A spec amendment is needed (same).
  - C1 surfacing rule (c) requires `classification.tier === "channel"`; the spectral tier alone never surfaces.

## Task 40

- **Task 40 (S3, informational).** The pre-check facts hold on main: `admitChannel` (`admission.ts` :33),
  `sanitize` (:45) and channel ids `${sanitize(decoderId)}-g${generation}` (`channelizer-manager.ts` :287),
  `useChannelizer` in `src/config.ts` and `src/decoders/types.ts`, and `getChannelRequest` on all seven migrated
  decoders. The `ChannelizerManager` instance is the `channelizer` const in `src/index.ts` (:347-355, null when
  disabled); pass it as the scanner's `channels` dep. Channels of a source are invalidated on every centre change
  (Task 33 note).

## Task 48

- **Task 48 (S4).** It edits `FixtureRoleSchema`/`FixtureSchema` in `src/core/fixtures/manifest-schema.ts`
  (after Task 34a). The schema there includes `generated` fetches and `expected.marginal_keys` (Task 34a delta), so
  a new `scanner-classifier` role must not trip the `marginal_keys` refinement.

## Task 49

- **Task 49 (S4, carry).** Calibrate the P4/P20 noise models from captures (they disagree). CFAR `prevOn` cleared
  after a reset can creep up to +4 dB. A null-Δ untracked-retune alarm is a risk on a simultaneous fade of weak
  features near k (soak check). RF carrier fragments.

## Spectrum-profile amendment (Main, 2026-10-10)

Authority: `docs/CLI-COORDINATION.md` "Main → Scanner / CLI / Web: spectrum profile scope — 2026-10-10" and
`docs/ROADMAP.md` § 8 "Spectrum contract amendment for scanner S1-B" (both on `main` 6b1a0aa; user-confirmed scope).
This section wins over the Task 24, 25, 32 and 37a briefs and over the C5 entries it names. It folds in preflight
ruling R2 (`"stream"`/`"released"` re-emits, `preflight-s1b-part2.md`). It supersedes "(per-subscription profiles
deferred)" in the Task 37a CORE-GAPS row above; slice zoom is still not delivered.

**Where detail is lost today.** `SpectrumPipeline.summary()` (`src/core/spectrum/pipeline.ts` :1349-1401) max-holds the
usable span in groups of `d = ceil((hi − lo) / cfg.spectrumBins)` (:1360) before the event leaves the worker, and Task 32
`buildPipelineConfig` sets `spectrumBins: s.ws.spectrumBins` (task-32-brief l.1366), the client display setting. At
2.048/2.4 Msps (`fftSize` 2048, 1639 usable bins) the 512 default makes `d = 4`, so `SpectrumService` never sees
better than 4 RBW. A runtime PATCH of `ws.spectrumBins` also never reaches a running pipeline (it is read only when
the pipeline is built). The worker transport itself (`{type: "events"}` structured clone, task-32-brief l.846-847,
`BlockSummary.bins: number[]`) drops nothing.

### Decisions

| name | type/value | why |
|---|---|---|
| `scanner.ws.spectrumSummaryBins` | int, default **2048**, bounds 512–2048, config/env only (not in `RuntimeSettingsOverridesSchema`, not in `NUMERIC_BOUNDS`) | The engine's summary-detail budget, read only by `buildPipelineConfig` → `PipelineConfig.spectrumBins`. Never per client, never PATCHable, so no display choice can rebuild a pipeline. 2048 equals the largest client request; at the default `fftSize` ≤ 2048 it is native (d = 1). The 37a measurement step can lower the default (fallback below). |
| `scanner.ws.spectrumMaxProfiles` | int, default **4**, bounds 1–16, config/env only | Cap on distinct active **non-default** profiles, counted as `(sourceId, key)` pairs over every client's current and in-flight selection. A source's default profile never counts, so built profiles ≤ engines + cap. Config-only, so nothing is ever evicted at runtime. |
| Client profile bounds | `hz` 0.5–25 in 0.5 steps; `bins` integer 128–2048 (`PROFILE_LIMITS`) | The same bounds as `ws.spectrumHz`/`ws.spectrumBins` and spec § 9 (2048 × 25 Hz ≈ 70 KB/s per client, inside the 1 MiB / 256-message limits). The 0.5 Hz step lets near-equal requests share one profile. |
| Over-limit outcome | **nearest admissible profile, reported** (never rejected for size) | One rule. A value outside the bounds becomes the nearest bound. A new profile past the cap becomes the nearest active profile on that source (the default profile is always a candidate). The client always gets frames, and every frame names its `profile`, `binCount` and `binHz`, so a substitute cannot be misread. The ack's `adjusted` list makes it testable. Rejection with a code is kept only for requests that cannot be served at all. Clamping alone cannot enforce a count cap, and rejection leaves a waterfall blank over a soft limit. |
| Nearest metric | `abs(log2(bins / b)) + abs(log2(hz / h))`; ties: more bins, then higher hz, then key order | Scale-invariant; deterministic. |
| Selection model | One selection per client: **default** (no options: the default profile on every eligible source, as before) or **one source** with one profile | Keeps the planned contract for option-less clients and bounds the cost per client. Several sources per client is a follow-up. |
| Demand | Consumer id `ws:<clientId>` per held source (`wsConsumer(clientId)`); make-before-break on a switch; requests serialised per client | Engines stay shared and ref-counted. A switch never blanks the client and never stops an engine another consumer holds. An unsubscribe or disconnect that races an in-flight subscribe still ends with no demand. |
| Wire format | Existing `subscribe` message plus optional `options: { spectrum: SpectrumSubscribeOptions }`. Re-subscribing switches; `subscribe` without options returns to the default selection; `unsubscribe`/disconnect releases | No new client message type, no WS tuning, no command bus. |
| Ack | `spectrum:profile` (`SpectrumProfileEventData`), sent only to the requesting client after the request settles | It reports the selection actually served. |
| Routing | `SpectrumService` event `"frame"(frame, clientIds: readonly string[])`; broadcaster `sendToClients(channel, clientIds, message)` serialises once | Each profile is built and serialised once per frame and delivered only to its clients. |
| Snapshot | After the ack: for each source the client receives, the last block summary reduced to the client's profile, with `snapshot: true`, **only if** the summary's `(stream, epoch)` equals `engine.currentEpoch()`; otherwise none (the next live frame follows within 1/hz) | Matches its profile and its epoch; never labels old bins with a new epoch. Replaces nothing: `GET /api/spectrum` `latestFrame` (default profile) stays. |
| Holds | Unchanged: `accumulateHold` per `(source, key)`; a new epoch or bin layout starts a fresh hold. Holds of keys with no recipient are dropped at each summary | Stream/epoch, capture axis (`startHz`, `binHz`, `centerHz`, `sampleRateHz`) and `tuningTrust` come from the summary and its `EngineEpoch` as before. |
| Resolution reporting | Frame `binCount` (actual) and `binHz` (effective), plus new `nativeBinHz` (= fs / fftSize). Status per source `summaryBinCount`, `summaryBinHz`, `summaryHz`; per profile `binCount`, `binHz`, `effectiveHz` | `reduceMaxHold` never upsamples (factor ≥ 1). A 2048-bin request on 1639 native bins reports `binCount` 1639 and `binHz` = `nativeBinHz`. |
| Effective rate | Frames ≤ `min(hz, 1000 / integrationMs)` (20 Hz at the 50 ms default) | Frames come from block summaries; `effectiveHz` says so. |
| Transport | Unchanged: `BlockSummary.bins` stays `number[]` in the structured-cloned `events` message; no transfer list | Keeps C1a, `measureTarget` (35a) and `bestPsd` (35) as written. The 37a measurement decides whether 2048 stays the default. |
| R2 (`"stream"`, `"released"`), controller ruling | Task 32's engine emits `"stream"(stream, reason: "restart" \| "stop")` before a new stream's first event and from `stop()`. `SpectrumService` keeps scanner consumers (`job:`) and display demand (`ws:`) in **separate sets** per entry (`jobs`, `displays`); the engine runs while their union is non-empty. Scanner-facing events are **gated on scanner consumers**: (a) `"released"(sourceId, consumer)` only when a `job:` consumer releases and the engine stays up; (b) `"stream"(sourceId, stream, reason)` is re-emitted only while `jobs.size > 0`, or, for `"stop"`, when the release that stopped the engine was a `job:` consumer's. A client subscribe, switch, profile change, unsubscribe or disconnect never emits either (even when it starts or stops a display-only engine) and never calls `reconfigure`/`refreshTuning`. Task 35's `closeLiveOn(sourceId, endReason)` is re-hooked on both in 37a Step 6 | Display demand never triggers scanner-facing events or restarts the engine/detector. Suppressing events of a display-only engine loses nothing: live observations exist only for jobs, and every job (passive, sweep, identify) is a `job:` consumer. |
| Default-profile PATCH | `ws.spectrumHz`/`ws.spectrumBins` (runtime) keep defining the default profile, read per summary. Default clients follow at the next frame; custom selections and existing `nearest` mappings are not re-evaluated | As planned. No eviction path exists. |

### Task 24 (config)

- `ScannerConfigSchema.ws` (task-24-brief l.419-425), after `spectrumBins`:
```ts
				/** Engine summary-detail budget: block-summary bins per source (config only; never per client, never PATCHed). */
				spectrumSummaryBins: z.number().int().min(512).max(2048).default(2048),
				/** Distinct active non-default spectrum profiles over all sources (config only). */
				spectrumMaxProfiles: z.number().int().min(1).max(16).default(4),
```
- Do **not** add either key to `RuntimeSettingsOverridesSchema` (`persistence.ts` :286-293; its `ws` object is
  `.strict()`, so a PATCH with them is a 400) or to `NUMERIC_BOUNDS`/`SCANNER_SETTINGS_BOUNDS` (runtime-safe keys
  only). `mergeScannerSettings` reports them with provenance `config`/`default`.
- `config/default.yaml` commented line (task-24-brief l.711) becomes
  `#   ws: { maxMessagesPerSecond: 10, spectrumHz: 10, spectrumBins: 512, spectrumSummaryBins: 2048, spectrumMaxProfiles: 4 }   # spectrum feed: default profile 0.5-25 Hz, 128-2048 bins; summary budget 512-2048 and profile cap 1-16 are config-only`.
- `SPEC_DEFAULTS` (task-24-brief l.69): `ws: { maxMessagesPerSecond: 10, spectrumHz: 10, spectrumBins: 512, spectrumSummaryBins: 2048, spectrumMaxProfiles: 4 }`.
- S1-A edits (Task 24 owns them, see below): `ScannerSettings.ws`, `SpectrumSettings.ws`, two test literals.
- Tests (+2): `tests/unit/utils/scanner-config.test.ts` "bounds the config-only spectrum keys" (parses 2048/4 by
  default; rejects `spectrumSummaryBins` 4096 and 256 and `spectrumMaxProfiles` 0 and 17);
  `tests/unit/core/scanner/settings.test.ts` "rejects a PATCH of the config-only spectrum keys"
  (`ScannerSettingsPatchSchema.safeParse({ ws: { spectrumSummaryBins: 1024 } }).success === false`, same for
  `spectrumMaxProfiles`).
- Env: `WAVEKIT_SCANNER__WS__SPECTRUM_SUMMARY_BINS`, `WAVEKIT_SCANNER__WS__SPECTRUM_MAX_PROFILES` (existing mapper, no code).

### Task 25 (DTOs)

- **One DTO is touched, narrowly.** `ScannerSettingsValues.ws` (task-25-brief l.654) becomes
  `{ maxMessagesPerSecond: number; spectrumHz: number; spectrumBins: number; spectrumSummaryBins: number; spectrumMaxProfiles: number }`.
  This is forced by the `Same<Api.ScannerSettingsValues, Core.ScannerSettings>` guard (l.42). Nothing else changes in
  Task 25. Every spectrum DTO lives in Task 37a's `packages/api-types/src/spectrum.ts`.

### Task 32 (worker summary budget and transport)

- `buildPipelineConfig` (task-32-brief l.1366): `spectrumBins: s.ws.spectrumSummaryBins,` (was `s.ws.spectrumBins`).
  Add the comment `// engine summary budget; client bins are applied by SpectrumService (Task 37a)`.
- Transport unchanged: `PipelineConfigSchema.spectrumBins` 16–4096 (l.713) already admits it. Summaries cross as
  `number[]` in `{type: "events"}` by structured clone. `setSpectrumFeed(true)` stays on for every engine (Task 35).
- Test (+1) in `tests/unit/core/spectrum/spectrum-engine.test.ts`: "builds the pipeline with the engine summary budget,
  not the client bins". It calls `buildPipelineConfig("rtl", "U8_IQ", 2_048_000, testSettings(s => { s.ws.spectrumBins = 256 }), DEFAULT_TUNING)`
  and expects `.spectrumBins` to be 2048. With `spectrumSummaryBins = 1024` it expects 1024.
- Effects to accept (no code). Block summaries, so `bestPsd` evidence (Task 35) and identify's `source: "spectrum"`
  measurement (35a `measureTarget`), get up to 4× finer bins. PSD evidence JSON grows by the same factor, inside
  `maxEvidenceMb`. Detection is untouched: tracks come from full-resolution power, and summaries only feed the
  scheduler's block clock.

### Task 37a (spectrum service, WS, REST)

**DTOs** (`packages/api-types/src/spectrum.ts`, additions to the brief's Step 3 file):
```ts
/** `options.spectrum` of a WS `subscribe` that includes "spectrum". Omitted options = the default selection. */
export interface SpectrumSubscribeOptions {
	sourceId: string
	/** 0.5–25, snapped to 0.5 Hz; default `scanner.ws.spectrumHz`. */
	hz?: number
	/** 128–2048 (integer); default `scanner.ws.spectrumBins`. */
	bins?: number
}
export interface SpectrumProfileView { key: string; hz: number; bins: number }
export type SpectrumProfileAdjustment = "hz" | "bins" | "profile-limit"
export type SpectrumSubscribeErrorCode =
	| "SPECTRUM_OPTIONS_INVALID" | "SPECTRUM_SOURCE_NOT_FOUND" | "SPECTRUM_SOURCE_NOT_IQ" | "SPECTRUM_ENGINE_ERROR"
/** `spectrum:profile`: the client's selection after a subscribe (sent to that client only). */
export interface SpectrumProfileEventData {
	/** none: no frames (only after a rejected first request); default: default profile on every eligible source. */
	selection: "none" | "default" | "source"
	sourceId: string | null
	/** Profile served; for "default" the current default profile. null with selection "none". */
	profile: SpectrumProfileView | null
	/** exact: as requested; nearest: see `adjusted`; rejected: the previous selection is kept. */
	outcome: "default" | "exact" | "nearest" | "rejected"
	adjusted: SpectrumProfileAdjustment[]
	code?: SpectrumSubscribeErrorCode
	message?: string
}
export interface SpectrumActiveProfile extends SpectrumProfileView {
	sourceId: string
	isDefault: boolean
	clients: number
	/** From the latest summary (null before one): actual bins, width, and min(hz, block rate). */
	binCount: number | null
	binHz: number | null
	effectiveHz: number | null
}
export interface SpectrumLimits {
	maxProfiles: number
	hz: { min: number; max: number; step: number }
	bins: { min: number; max: number }
}
```
- `SpectrumFrameEventData` gains `nativeBinHz: number` (fs / fftSize; `binHz / nativeBinHz` is the total max-hold
  factor) and `snapshot?: true`. Every other field and the encoding are unchanged.
- `SpectrumSourceStatus` gains `summaryBinCount: number | null`, `summaryBinHz: number | null` (of the latest block
  summary) and `summaryHz: number | null` (1000 / `integrationMs`).
- `SpectrumStatus` becomes `{ defaultProfile: SpectrumProfileView; profiles: SpectrumActiveProfile[]; limits:
  SpectrumLimits; subscribers: number; sources: SpectrumSourceStatus[] }`. `subscribers` counts clients whose
  selection is not `none`.

**`src/core/spectrum/spectrum-service.ts`** (replaces the Step 5 parts named here; the rest of Step 5 stands):
- Remove `WS_CONSUMER`, `profilesFrom`, the `subscribers` field and `setSubscribers`. Add:
```ts
export const WS_CONSUMER_PREFIX = "ws:"
export const wsConsumer = (clientId: string): string => `${WS_CONSUMER_PREFIX}${clientId}`
export const PROFILE_LIMITS = { hz: { min: 0.5, max: 25, step: 0.5 }, bins: { min: 128, max: 2048 } } as const
export const SpectrumSubscribeOptionsSchema = z
	.object({ sourceId: z.string().min(1).max(128), hz: z.number().finite().optional(), bins: z.number().finite().optional() })
	.strict()
export function profileKey(hz: number, bins: number): string // `${hz}:${bins}`
export function defaultProfile(s: SpectrumSettings): SpectrumProfile // key from ws.spectrumHz/spectrumBins, unsnapped
/** Omitted fields take the default's value unchanged; given ones are snapped and clamped, and `adjusted` names those that changed. */
export function normaliseProfile(req: { hz?: number; bins?: number }, fallback: SpectrumProfile): { profile: SpectrumProfile; adjusted: ("hz" | "bins")[] }
export function nearestProfile(want: SpectrumProfile, candidates: readonly SpectrumProfile[]): SpectrumProfile // metric and ties: Decisions
export interface SpectrumSubscribeResult { ack: SpectrumProfileEventData; snapshots: SpectrumFrameEventData[] }
```
- Methods (C5 replaces `setSubscribers`):
  `subscribe(clientId: string, options: unknown): Promise<SpectrumSubscribeResult>` (`undefined` = default
  selection), `unsubscribe(clientId: string): Promise<void>`. Events: `"frame"(frame, clientIds: readonly string[])`,
  `"pipeline"` as before, and R2's `"stream"(sourceId, stream, reason)` and `"released"(sourceId, consumer)` (`job:`
  consumers only).
- `SpectrumServiceDeps` gains `createHost?: SpectrumEngineDeps["createHost"]`, passed through in `open()`. It is a test
  seam for deterministic event sequences; production omits it.
- `Entry.consumers: Set<string>` is replaced by `jobs: Set<string>` (`job:` ids) and `displays: Set<string>` (`ws:`
  ids). `acquire`/`release` route by prefix. The engine stops when both are empty. `status().sources[].consumers` is
  `jobs.size + displays.size`. `open()` subscribes the engine's `"stream"` event and applies the R2 gate (Decisions).
  `release()` decides before deleting: `wasJob = jobs.delete(consumer)`, `stopping = jobs.size + displays.size === 0`.
  It emits `"released"` when `wasJob && !stopping`. A `"stop"` re-emit happens only if `wasJob`, and the gate is
  checked before `stopEngine` so that the engine's own `"stop"` event is filtered by the same flag.
- State: `clients: Map<string, { current: Selection | null; next: Selection | null; held: Set<string>; chain: Promise<unknown> }>`
  with `Selection = { sourceId: string | null; profile: SpectrumProfile | null }`, where `null`/`null` is the default
  selection.
- `subscribe` algorithm. Chain each call on the client's `chain`, so `unsubscribe` and disconnect queue behind it.
  1. If `options === undefined`, the selection is the default selection. Otherwise run
     `SpectrumSubscribeOptionsSchema.safeParse`; on failure, reject with `SPECTRUM_OPTIONS_INVALID`.
  2. Unknown `sourceId` (not in `sourceConfigs`): reject with `SPECTRUM_SOURCE_NOT_FOUND`. A source that is not
     `isScannerIqFormat`: reject with `SPECTRUM_SOURCE_NOT_IQ`.
  3. `def = defaultProfile(settings())`, then `{profile, adjusted} = normaliseProfile(opts, def)`.
  4. Apply the cap when all of these hold: `profile.key !== def.key`, no other selection already uses
     `(sourceId, profile.key)`, and `customCount(excluding this client's current) >= ws.spectrumMaxProfiles`. Then
     `profile = nearestProfile(profile, [def, ...profiles active on sourceId])` and push `"profile-limit"`.
  5. Set `next`. Acquire `wsConsumer(clientId)` on each source the new selection needs and the client does not yet
     hold: every `eligibleSources()` for default, else `[sourceId]`. For default, per-source failures are logged once
     and recorded in `errors`, as the old `setSubscribers` did. For one source, a failure clears `next` and rejects
     with `SPECTRUM_ENGINE_ERROR`.
  6. Commit: `current = next`, `next = null`. Release every held source the new selection does not need.
  7. Return the ack and `snapshots`. The outcome is `default` for the default selection, `exact` when `adjusted` is
     empty, and `nearest` otherwise.
  A rejected request leaves `current` and `held` unchanged. Its ack describes `current`: `selection` is `none`,
  `default` or `source`.
- `unsubscribe`: on the chain, set `current = next = null`, release every held source, and delete the client.
  `stop()` clears `clients`.
- Frames, in `onPipeline` for `block-summary`. Compute `recipients(sourceId): Map<key, { profile, clientIds }>` from the
  `current` selections. Default clients that hold the source go under `def.key`; source clients go under their
  `profile.key`, so a request equal to the default shares it. Drop `entry.holds` entries whose key is absent. For each
  group run `accumulateHold` (unchanged), and emit once per `1000 / hz` with `this.emit("frame", frame, clientIds)`.
  `frame()` adds `nativeBinHz: summary.sampleRateHz / (entry.engine.config()?.fftSize ?? summary.sampleRateHz / summary.binHz)`.
- Snapshots: for each source in the client's recipients, if `entry.lastSummary` and `entry.lastEpoch` exist and
  `lastSummary.stream`/`.epoch` equal `entry.engine.currentEpoch().stream`/`.epoch`, add
  `{ ...frame(…, reduceMaxHold(lastSummary.bins, profile.bins)), snapshot: true }`.
- `status()`:
  - `defaultProfile`, `limits` (`maxProfiles` from settings, plus `PROFILE_LIMITS`), and `profiles` (one entry per
    recipient group per running source, with `factor = max(1, ceil(lastSummary.bins.length / bins))`,
    `binCount = ceil(len / factor)`, `binHz = summary.binHz × factor`, `effectiveHz = min(hz, 1000 / cfg.integrationMs)`).
  - Per source: `summaryBinCount`, `summaryBinHz` and `summaryHz`. `latestFrame` uses the default profile, as before.
- Never: `reconfigure`, `refreshTuning`, `setSpectrumFeed(false)` or any `PipelineConfig` read of client values on a
  subscribe, switch or unsubscribe path.

**`src/api/websocket/events.ts`** (adds to Step 8):
- `ClientMessage` gains `options?: Partial<Record<WebSocketChannel, unknown>>`. `parseClientMessage` copies
  `msg["options"]` only when it is a non-array object.
- `export interface ChannelObserver { subscribed(clientId: string, options: unknown): void; unsubscribed(clientId: string): void }`
  and `observeChannel(channel: WebSocketChannel, observer: ChannelObserver): () => void` (one observer per channel).
- `handleSubscribe` sends `subscribed` first. Then, for each channel in the message that has an observer, it calls
  `subscribed(client.id, message.options?.[channel])`.
- `handleUnsubscribe` calls `unsubscribed` for each observed channel the client actually had. `handleDisconnect`
  (which also covers `terminateClient`) does the same for each observed subscription, and so does `closeAll` before it
  clears.
- `sendToClients(channel: WebSocketChannel, clientIds: Iterable<string>, message: ServerMessage): number` stringifies
  `{ ...message, channel }` once and enqueues it to each listed client still subscribed to `channel`.
- `ServerMessage.type` adds `"spectrum:profile"`. Drop `broadcastSpectrumFrame`; frames go through `sendToClients`.

**`src/api/websocket/spectrum-broadcast.ts`** (replaces the Step 8 file):
`SpectrumBroadcastSource` is `{ on/off("frame", (frame, clientIds) => void); subscribe(clientId, options: unknown): Promise<SpectrumSubscribeResult>; unsubscribe(clientId): Promise<void> }`.
`wireSpectrumBroadcasts(spectrum, broadcaster): { dispose(): void }` does four things:
- It observes `"spectrum"`.
- On `subscribed`, it runs `void spectrum.subscribe(id, options).then(r => { sendToClients("spectrum", [id], { type: "spectrum:profile", data: r.ack }); for (const f of r.snapshots) sendToClients("spectrum", [id], { type: "spectrum:frame", data: f }) }, () => undefined)`.
- On `unsubscribed`, it runs `void spectrum.unsubscribe(id).catch(() => undefined)`.
- It forwards `"frame"` to `sendToClients`.
`dispose()` unobserves, drops the frame listener, and unsubscribes every client id it saw. The poll timer and
`opts.pollMs` go away.

**REST.** `src/api/routes/spectrum.ts` is unchanged apart from the status shape. Its test fake's `status()` returns the
new `SpectrumStatus` (`defaultProfile: { key: "10:512", hz: 10, bins: 512 }`, `profiles: []`, `limits`, …).

**Measurement step (new Step 9a, after Step 9).** File `tests/unit/core/spectrum/spectrum-summary-budget.test.ts`.
It drives `SpectrumPipeline` through `pipeline-harness.ts` `Harness` with seeded `mulberry32` noise plus one tone.
- Always on: test 22 below.
- Gated: `describe.skipIf(process.env["WAVEKIT_MEASURE_SUMMARY"] !== "1")`, one test, 60 s timeout. Run it once:
  `WAVEKIT_MEASURE_SUMMARY=1 pnpm exec vitest run tests/unit/core/spectrum/spectrum-summary-budget.test.ts`.
  - For each budget in `[512, 1024, 2048]`, feed 2 s at 2.048 Msps (`fftSize` 2048, 50 ms blocks) and print one
    `console.info` row per budget:
    - `pipelineMs`: `performance.now()` around all `handle()` calls;
    - `summaries`: the number of block summaries;
    - `summaryBins`;
    - `cloneUs`: the mean of `structuredClone(events)` over every events batch that holds a summary, 20 repeats.
      This is serialise plus deserialise, an upper bound on worker postMessage plus main-thread receive.
    - `bytesPerSummary`: `v8.serialize(events).byteLength`;
    - `bytesPerSec`: `bytesPerSummary` × summaries per second.
  - For profiles 512 and 2048, also print `profileUs`: the mean of
    `encodeBins(accumulateHold(…, reduceMaxHold(summary.bins, bins), epoch).bins!)` over 200 repeats.
  - Copy the table into the 37a report and the Task 38 announcement.
- Acceptance for the 2048 default. Each "Δ" is measured against the 512 row.
  - Δ`cloneUs` × summaries/s ≤ 10 ms/s (1 % of one core).
  - Δ`pipelineMs` ≤ 10 % of the 512 row.
  - `bytesPerSec` ≤ 512 KiB/s.
  - `profileUs` × 20 ≤ 5 ms/s.
- Fallback when 2048 fails: set the default to the largest passing budget (1024, else 512). Make the change in
  `src/config.ts`, Task 24's `SPEC_DEFAULTS`, the `default.yaml` comment and this note, and say so in the report.
  These Mac numbers are not Pi numbers: the Pi 4 is about 3–5× slower [INFERENCE], so the Pi check belongs to
  CHECKPOINT S1/S4.

**Tests.** They replace the brief's `setSubscribers` tests. "runs an engine only while a consumer holds it" and the
scanner-disabled test now use `subscribe("c1", undefined)`/`unsubscribe("c1")`. The brief's other service tests stay
("emits encoded frames…" with a default subscriber). Expected count: 37a was 1 + 7 + 2 + 1 = 11. It becomes 30:
1 trust, 21 service (the brief's 7 plus new tests 2–14 and 16), 2 routes, 4 new WS tests (18–21; 17 renames an
existing Task 37 test) and 2 budget tests. Test 15 is Task 32's.

Source/service tests (`tests/unit/core/spectrum/spectrum-service.test.ts`; two-source harness: `FakeSources` with
`caps`/`streams` for `rtl` and `air`, `getFanout: id => fanouts.get(id)`, and a fake-host variant via
`createHost`):
1. "runs an engine only while a consumer holds it" (rewritten).
2. "serves a subscription without options the 10 Hz × 512 default on every eligible source". The ack is `default`
   with profile `10:512`. Frames for both sources have `binCount ≤ 512`.
3. "builds each distinct profile once and routes frames only to its clients". On one source: CLI `c1` without options,
   web `c2` and `c3` with `{rtl, 25, 2048}`. Per frame interval there is one `"frame"` per key, `"25:2048"` goes to
   `[c2, c3]`, `"10:512"` goes to `[c1]`, and no client id appears under two keys.
4. "never upsamples: a profile above the native detail reports the true bin count and width". At FS 1.024 Msps (819
   usable bins), `{bins: 2048}` gives `binCount === 819` and `binHz === nativeBinHz`.
5. "serves the nearest admissible profile". Clamping: `{hz: 99, bins: 50}` → `25:128`, `adjusted ["hz","bins"]`.
   Profile limit: `spectrumMaxProfiles` 2, `{20, 1024}` and `{25, 128}` active, then `{25, 2048}` →
   `20:1024`, `outcome "nearest"`, `adjusted ["profile-limit"]`. A request equal to the default key does not count
   toward the limit.
6. "rejects unservable requests with a code and keeps the previous selection". Covers `SPECTRUM_OPTIONS_INVALID`
   (`{hz: "x"}`, no `sourceId`, an extra key), `SPECTRUM_SOURCE_NOT_FOUND`, and `SPECTRUM_SOURCE_NOT_IQ` (an
   `audio_pcm` config). Frames to the client continue on its old profile.
7. "switches source and profile make-before-break and releases the old source's demand". Run `c1 {rtl}` →
   `{air, 25, 1024}`: the rtl engine stops (no other consumer), the air engine runs, and no frame for rtl reaches
   `c1` after the ack. Then `{air, 10, 512}` changes only the key, with the same engine instance.
8. "sends a late-joining client a snapshot of its own profile and the current epoch" (fake host). After a block
   summary for epoch 3, `c2 {rtl, 25, 2048}` gets an ack and then one frame with `snapshot: true`, `profile
   "25:2048"`, `epoch 3` and the summary's `tuningTrust`.
9. "sends no snapshot across a retune boundary" (fake host). After `epoch-started` 4 and before its first block
   summary, a new subscriber gets the ack and no frame. After the epoch-4 summary, a reconnecting client (new client
   id) gets an epoch-4 snapshot.
10. "restarts every profile's hold at an epoch change and carries the epoch's trust" (fake host). Two profiles; epoch-3
    and epoch-4 summaries land inside one frame interval. The next frame of each profile has `epoch 4` and only
    epoch-4 bins. An `unverified` epoch's frames say `tuningTrust: "unverified"`.
11. "releases demand on unsubscribe, disconnect and a subscribe still in flight". `subscribe` then `unsubscribe`
    before the acquire resolves leaves, after settle, `sourceIds()` empty and `fanout.branches.size` 0. Two default
    clients: the engine stops only when the second leaves.
12. "display choices never restart the engine or reach the detector". `job:a` holds rtl. Three clients subscribe,
    switch profiles and leave. `createHost` was called once, its `PipelineConfig.spectrumBins` equals
    `ws.spectrumSummaryBins`, no `"stream"` or `"released"` event fired, and `engine(rtl)` is the same instance.
13. "reports active profiles, limits and summary detail in the status".
14. "the default profile follows a settings change at the next frame". Mutating `ws.spectrumBins` to 256 changes the
    default clients' key to `10:256`. A custom `{rtl, 25, 2048}` client is unchanged.
15. (Task 32 file, listed under Task 32 above.)
16. "accumulateHold, normaliseProfile and nearestProfile are pure and bounded". The brief's encoding and hold cases
    stay. Add snapping (`7.3` → `7.5`), clamping, nearest ties, and the omitted-field passthrough of an unsnapped
    default (`hz` 7.3 stays 7.3).

WS tests (`tests/unit/api/scanner-ws.test.ts`):

17. "accepts subscriptions to scanner and spectrum" (the brief's rename).
18. "passes spectrum subscribe options to the service and sends the ack and snapshots to that client only". A fake
    service records `(clientId, options)`. The other client gets nothing.
19. "routes spectrum frames only to the named clients, serialised once". Spy on `JSON.stringify` calls in
    `sendToClients`, or compare the identical string instances.
20. "releases spectrum demand on unsubscribe and on disconnect". Covers unsubscribe, socket `close`, and
    `terminateClient` on outbound overflow.
21. "switching options re-subscribes without a new message type". A second `subscribe` with other options calls the
    service again. One without options passes `undefined`.

Summary-budget test (`tests/unit/core/spectrum/spectrum-summary-budget.test.ts`):

22. Always-on test: "keeps the 10 Hz × 512 default frames identical with a 512 or a 2048 summary budget when the
    native span is ≤ 2048 bins". Use FS 1.024 Msps (`fftSize` 1024) and the same seeded input. `reduceMaxHold(s2048.bins, 512)`
    must equal `reduceMaxHold(s512.bins, 512)` in bins, `binHz × factor` and `startHz`. The identity holds only
    when d = 1 at 2048. At `fftSize` 4096 the default frame has 410 instead of 469 bins, still ≤ 512, and that case is
    covered by test 2's `binCount ≤ bins`.
23. Measurement, the gated test (above).

12a. "a display-only engine's start, restart and stop emit no scanner-facing event" (fake host). With no `job:`
    consumer, `c1` subscribes to rtl, a rate change restarts the pipeline (engine `"stream"` with `"restart"`), and
    `c1` leaves (engine `"stream"` with `"stop"`). The service emits no `"stream"` or `"released"`. Repeat with
    `job:a` also holding rtl: the restart is re-emitted once, `release("rtl", "job:a")` while `c1` stays emits
    `"released"("rtl", "job:a")`, and `c1` leaving afterwards emits nothing.

The R2 tests stay as the preflight ruling defines them (Tasks 35 and 37a). Tests 12 and 12a guard that display demand
triggers neither event. The service count is now 22 and the 37a total 31.

### S1-A files (edited by Task 24, the first task that needs them)

| File | Anchor | Change |
|---|---|---|
| `src/core/scanner/types.ts` | :514-515 `ws: { maxMessagesPerSecond: number; spectrumHz: number; spectrumBins: number }` and its doc line | add `spectrumSummaryBins: number; spectrumMaxProfiles: number`; doc: "spectrumSummaryBins 2048 (512–2048) and spectrumMaxProfiles 4 (1–16) are config-only" |
| `src/core/spectrum/types.ts` | :248 `ws: { spectrumHz: number; spectrumBins: number }` (in `SpectrumSettings`) | add `spectrumSummaryBins: number; spectrumMaxProfiles: number` |
| `src/core/spectrum/types.ts` | :101 `/** ≤ spectrumBins, dBFS max-hold, rounded to 0.5. */` (`BlockSummary.bins`) | `/** ≤ PipelineConfig.spectrumBins (the engine summary budget), dBFS max-hold, rounded to 0.5. */` |
| `src/core/spectrum/types.ts` | :184 `spectrumBins: number` (`PipelineConfig`) | add the doc line `/** Summary budget (ws.spectrumSummaryBins), never a client's bins. */` above it; keep the name |
| `tests/unit/core/scanner/plan/plan-preview.test.ts` | :64 `ws: { maxMessagesPerSecond: 10, spectrumHz: 2, spectrumBins: 512 },` | append `spectrumSummaryBins: 2048, spectrumMaxProfiles: 4` |
| `tests/unit/core/scanner/plan/plan-preview-p15.test.ts` | :82 same literal | same |

`pipeline.ts` needs no change. Add these four paths to Task 24's Files and `git add`.

### Contract to announce (Task 38 or the controller posts it in CLI-COORDINATION before landing; text only)

> **Core → CLI/Web: spectrum profiles (scanner Task 37a, amendment of 2026-10-10).**
>
> **Default selection.** `{"type":"subscribe","channels":["spectrum"]}` with no options gets the default profile on
> every eligible source, as planned. That profile is `scanner.ws.spectrumHz` 10 × `scanner.ws.spectrumBins` 512, and
> both stay runtime-PATCHable.
>
> **Per-client selection.** `{"type":"subscribe","channels":["spectrum"],"options":{"spectrum":{"sourceId":"rtl","hz":25,"bins":2048}}}`:
> - One source and one profile per client.
> - Subscribing again switches without a gap; subscribing with no options returns to the default selection.
> - `unsubscribe` or a disconnect releases the demand.
> - `hz` is 0.5–25 in 0.5 steps and `bins` is 128–2048. Omitted fields take the default's values.
>
> **Ack.** `spectrum:profile` goes to the requesting client only:
> `{selection: "none"|"default"|"source", sourceId, profile: {key, hz, bins}|null, outcome: "default"|"exact"|"nearest"|"rejected", adjusted: ("hz"|"bins"|"profile-limit")[], code?, message?}`.
>
> **Limits.** The server serves the **nearest admissible profile** and never rejects a request for its size.
> - Out-of-range values are clamped.
> - Above `scanner.ws.spectrumMaxProfiles` (4 distinct non-default profiles over all sources, config-only, 1–16), the
>   request maps to the nearest active profile on that source.
> - Only unservable requests are rejected, and the previous selection is kept: `SPECTRUM_OPTIONS_INVALID`,
>   `SPECTRUM_SOURCE_NOT_FOUND`, `SPECTRUM_SOURCE_NOT_IQ`, `SPECTRUM_ENGINE_ERROR`.
>
> **Frames.** `spectrum:frame` keeps its shape and adds `nativeBinHz` and `snapshot?: true`.
> - `binCount ≤ bins` and is never upsampled; `binHz` is the true width.
> - Frames arrive at ≤ min(hz, 1000 / `integrationMs`), which is 20 Hz at the default.
> - Each profile is built once per source and sent only to its clients.
>
> **Snapshots.** After the ack, the client gets one `snapshot: true` frame per source it receives. Each is the latest
> block of the current epoch at the client's profile; there is none while a retune is settling.
>
> **Client rules.**
> - Compare `(sourceId, epoch)` for equality only. On any change of epoch, `profile`, `binHz` or `startHz`, clear the
>   waterfall.
> - Epochs restart when an engine restarts, so after a reconnect treat the snapshot as a fresh start.
>
> **Engine summary budget.** `scanner.ws.spectrumSummaryBins` is 2048, config-only, 512–2048. It is not a client
> setting. Measured: <37a table>.
>
> **REST.** `GET /api/spectrum` returns `{defaultProfile, profiles: [{sourceId, key, hz, bins, isDefault, clients, binCount, binHz, effectiveHz}], limits, subscribers, sources: [… + summaryBinCount, summaryBinHz, summaryHz]}`.
>
> **Settings view.** `ScannerSettingsValues.ws` gains `spectrumSummaryBins` and `spectrumMaxProfiles`. They are
> read-only, so `PATCH /api/scanner/settings` rejects them.
>
> **Not in this change.** No WS tuning and no new command message. Slice-zoom FFT is a separate follow-up.

Task 38 also documents the subscribe options and `spectrum:profile` in `docs/API.md`, next to the planned `spectrum`
channel text.

### Effort estimate (rough)

| Task | Source lines | Test lines | Tests |
|---|---|---|---|
| 24 | +12 (schema, yaml comment, 4 S1-A type/doc lines) | +25, 2 literals edited | +2 |
| 25 | +1 (DTO `ws`) | 0 | 0 |
| 32 | +2 | +15 | +1 |
| 37a | `spectrum-service.ts` +170 / −25; `spectrum.ts` +45; `events.ts` +55; `spectrum-broadcast.ts` ≈ 40 (rewrite) | +650 (service +14 and the two-source/fake-host harness, ws +4, budget 2) | +20 net (31 vs 11) |

About +330 source lines and +690 test lines in total. 37a grows by roughly half. One measurement run produces the
numbers.

### Out of scope and follow-ups

- **Genuine slice-zoom FFT** (a higher-resolution FFT of the viewed slice, with bounded DSP and full-stream detection
  unchanged) is a ROADMAP § 8 follow-up, **not S1-B**. Cropping or magnifying published bins does not satisfy it.
- WS tuning (it follows the REST/accepted-state latency measurement) and any new WS command message.
- Several sources per client selection; re-upgrading a `nearest`-mapped client when a profile slot frees.
- Releasing WS demand when a source is removed, and picking up sources that become eligible after a default
  subscription (both are as in the pre-amendment design; the client re-subscribes).
- A `Float32Array`/transfer-list summary transport (only if the measurement fails at every budget).
- Pi 4 numbers for the summary budget (CHECKPOINT S1 / S4 soak, with the user).

### Conflicts

1. **Spec § 12.2 "no replay; clients refetch over REST after a reconnect"** vs ROADMAP's "late-joining clients get
   a matching snapshot". The WS snapshot is the current state, not a replay of missed messages, and REST
   `latestFrame` stays. Recommendation: accept, and add one sentence to spec § 12.2 when the R6/R7 spec amendments are
   scheduled. Task 38's `docs/SCANNER.md` should state the snapshot rule.
2. **Task 25 "keep DTO edits narrow"** vs the `Same<ScannerSettingsValues, ScannerSettings>` guard. Two config keys
   force two fields into `ScannerSettingsValues.ws`. Recommendation: accept (additive, read-only). The alternative,
   hard-coded constants, would make the summary budget untunable on a Pi.
3. **Spec § 9 "2048 bins at 25 Hz"**: frames cannot exceed the block rate, which is 20 Hz at `integrationMs` 50 and
   10 Hz at `sensitivity: "high"`. Recommendation: accept, since `effectiveHz` reports it. A 25 Hz feed would need
   shorter blocks, which are detection config and not a display choice.
4. **Summary budget vs evidence/identify resolution.** 2048 summary bins also sharpen `bestPsd` evidence and
   identify's `source: "spectrum"` measurements (Tasks 35/35a). They are not detection, but their output changes.
   Recommendation: accept, since they are measurements and finer is truthful. If the measurement forces 512, those
   paths keep today's resolution.
5. **C5 names changed before landing.** `WS_CONSUMER`, `profilesFrom`, `setSubscribers`,
   `WebSocketEventBroadcaster.broadcastSpectrumFrame`, the `"frame"` signature and `wireSpectrumBroadcasts` `opts`
   are replaced as above. Nothing on `main` uses them. Recommendation: the 37a brief carries this section verbatim;
   no plan-head edit is needed (this note wins).

None of these is a scope change; the scope Main approved is implemented as written.
