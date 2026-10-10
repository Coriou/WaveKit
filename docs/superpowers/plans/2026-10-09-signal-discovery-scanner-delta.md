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

**Authority.** The scope comes from two documents on `main`, both user-confirmed:
- `docs/CLI-COORDINATION.md`, "Main → Scanner / CLI / Web: spectrum profile scope — 2026-10-10";
- `docs/ROADMAP.md` § 8, "Spectrum contract amendment for scanner S1-B".

**Reviews folded in.**
- Fix round 1 resolves the design review (`amend-review.md`, findings 1–15).
- It also resolves Main's review "Main → Scanner: amendment review and access integration boundary" (`main` 32fc238,
  items M1–M5).

**Precedence.**
- This section wins over the Task 24, 25, 32, 35/35a (one header note each), 37a and 38 briefs, and over the C5 entries
  it names.
- It folds in preflight ruling R2 and the controller's R2 event rules.
- It supersedes "(per-subscription profiles deferred)" in the Task 37a CORE-GAPS row above. Slice zoom is still not
  delivered.

**Where detail is lost today.**
- The pipeline reduces bins before the event leaves the worker. `SpectrumPipeline.summary()`
  (`src/core/spectrum/pipeline.ts` :1349-1401) max-holds the usable span in groups of
  `d = ceil((hi − lo) / cfg.spectrumBins)` (:1360).
- `cfg.spectrumBins` is the client display setting: Task 32's `buildPipelineConfig` sets
  `spectrumBins: s.ws.spectrumBins` (task-32-brief l.1366).
- At 2.048/2.4 Msps (`fftSize` 2048, 1639 usable bins), the 512 default makes `d = 4`, so `SpectrumService` never sees
  better than 4 RBW.
- A runtime PATCH of `ws.spectrumBins` never reaches a running pipeline, because the setting is read only when the
  pipeline is built.
- The worker transport itself drops nothing: a `{type: "events"}` structured clone (task-32-brief l.846-847) of
  `BlockSummary.bins: number[]`.

### Decisions

| name | type/value | why |
|---|---|---|
| `scanner.ws.spectrumSummaryBins` | int, default **2048 (provisional)**, bounds 512–2048, config/env only (absent from `RuntimeSettingsOverridesSchema` and `NUMERIC_BOUNDS`) | **Role:** the engine's summary-detail budget, read only by `buildPipelineConfig` → `PipelineConfig.spectrumBins`. It is never per client and never PATCHable, so no display choice can rebuild a pipeline. **Why 2048:** it equals the largest client request, and at the default `fftSize` ≤ 2048 it is native (d = 1). **Provisional:** Step 9a's measurement fixes the final value; the fallback is 1024, then 512. |
| `scanner.ws.spectrumMaxProfiles` | int, default **4**, bounds 1–16, config/env only | **Cap:** the size of U, the reserved set: distinct non-default `(sourceId, key)` pairs over every client's `current` and `next` selection. **Exempt:** only the *current* default key; pairs from a former default start counting, and the excess is remapped (M2). **Bounds:** built profiles ≤ engines + cap at all times; reserved ≤ cap + 1 during one transition (M3). |
| Client profile bounds | `hz`: `clamp(round(hz × 2) / 2, 0.5, 25)`; `bins`: `clamp(round(bins), 128, 2048)` (`PROFILE_LIMITS`) | Same bounds as `ws.spectrumHz`/`ws.spectrumBins` and spec § 9. The 0.5 Hz step lets near-equal requests share a profile. |
| Over-limit outcome | **nearest admissible profile, reported**; never rejected for size | **One rule.** Out-of-range values become the nearest bound. Past the cap, a request maps to a shareable active profile on its source or the current default; it prefers candidates ≤ the request on both axes, then the metric (finding 14). **Why:** frames are self-describing (`profile`, `binCount`, `binHz`), and `adjusted` makes the substitution testable. Clamping alone cannot enforce a count cap, and rejection blanks a waterfall over a soft limit. **Rejected with a code:** only requests that cannot be served at all. Main accepted this (32fc238). |
| Nearest metric | `abs(log2(bins / b)) + abs(log2(hz / h))`; ties: fewer bins, then lower hz, then key order | Scale-invariant and deterministic; ties go to the cheaper profile. |
| Selection model | One selection per client: **default** (no options: the default profile on every eligible source) or **one source** with one profile | The option-less contract is unchanged and the cost per client is bounded. |
| Demand | Display consumer `ws:<clientId>` in the source entry's `displays` set; scanner consumers `job:<id>` in `jobs` (R2). The engine runs while either is non-empty | Engines stay shared, and display and scanner demand stay separate. |
| Per-client requests (M4) | At most **1 running + 1 pending** operation per client; a newer request replaces the pending one. A running operation is superseded when a newer request, a disconnect, `stop()` or a removal of its source arrives. A superseded or failed operation sends no ack or snapshot and releases what it acquired | Bounded work. A stale ack or stale demand is impossible. |
| Commit order (finding 1) | Commit sets `current`, then synchronously emits `"profile"(clientId, ack, snapshots)`, which the wiring sends at once. Only after that are unneeded sources released | **Guarantee:** ack → snapshot(s) → live frames, per client. |
| Make-before-break (M3) | The old selection keeps receiving frames until commit. When U is full, a switch whose old pair belongs to that client alone may use the single global **transition slot** | Exact bounds: built (`current`) non-default pairs ≤ cap at all times; reserved (`current` ∪ `next`) ≤ cap + 1. |
| Permanent removal (M1) | `SourceManager` `"source-removed"(sourceId, removedAt)`. `disconnect()` emits it once (`src/core/source-manager.ts` :1400-1408, called by `DELETE /api/sources/:id`, `src/api/routes/sources.ts` :494). `reconnect()` and shutdown emit only the internal `"removed"` (:1411-1446; the comment is at `src/api/server.ts` :351-356) | **Distinguishes permanent removal:** Task 35's `ScannerService` already listens to `"source-removed"` (task-35-brief l.1922). No new signal is needed; 37a adds the event to the documentary `SourceManagerEvents` interface (one line). |
| Wire format | The existing `subscribe` message gains optional `options: { spectrum: SpectrumSubscribeOptions }` | **Switching:** re-subscribe; `subscribe` without options returns to default. **Release:** `unsubscribe` or disconnect. No new client message type, no WS tuning, no command bus. |
| Routing | `"frame"(frame, clientIds)` → `sendToClients` (serialises once) | Each profile is built once per summary group and delivered only to its clients. |
| Snapshot | Sent at commit, for each source the client receives: the last block summary reduced to its profile, `snapshot: true`. Only when the summary's `(stream, epoch)` equals `engine.currentEpoch()`; otherwise none | It matches its profile and epoch. REST `latestFrame` (default profile) stays. |
| Frame cadence (M5) | Count decimation: one frame per `n = max(1, ceil(blockHz / hz))` block summaries of the hold, with `blockHz = 1000 / cfg.integrationMs`. `effectiveHz = blockHz / n` | **Exact:** this is the delivered cadence while summaries flow; with gaps it is labelled an **upper bound** (sweep settle, gaps, alarm blocks emit no summary). It is deterministic and needs no clock. 15 → 10 Hz, 25 → 20 Hz, 7 → 6.67 Hz at 50 ms blocks. |
| Holds | `accumulateHold` per `(source, key)`; a new epoch or bin layout starts a fresh hold. The decimation count is kept across a reset. Holds of keys with no recipient are dropped | Stream/epoch, capture axis and `tuningTrust` come from the summary and its `EngineEpoch`, as before. |
| Resolution reporting | Frame: `binCount`, `binHz` (effective), and new `nativeBinHz = cfg.sampleRateHz / cfg.fftSize` (no frame while `config()` is null). Status: `summaryBinCount`/`summaryBinHz`/`summaryHz` per source; `binCount`/`binHz`/`effectiveHz`/`summariesPerFrame` per profile | `reduceMaxHold` never upsamples. |
| Transport | Unchanged: `number[]` in the structured-cloned `events` message | Keeps C1a, `measureTarget` (35a) and `bestPsd` (35) as written. |
| R2 (controller ruling) | **Task 32:** the engine emits `"stream"(stream, "restart" \| "stop")` before a new stream's first event and from `stop()`. **37a:** it re-emits `"stream"(sourceId, stream, reason)` only while `jobs.size > 0`; for `"stop"`, only when the release that stopped the engine was a `job:` one. `"released"(sourceId, consumer)` fires only for a `job:` release that leaves the engine up. **Never:** display operations (subscribe, switch, profile change, unsubscribe, disconnect, removal cleanup) emit neither event, nor call `reconfigure`/`refreshTuning`. **Hooks:** `closeLiveOn` is re-hooked in 37a Step 6 | Display demand never reaches the scanner. Live observations exist only for jobs (task-35-brief l.2325-2328). |
| Spectrum traffic vs `WsLimiter` | Spectrum frames, acks and snapshots bypass the scanner `WsLimiter` and do not count toward `ws.maxMessagesPerSecond` | Spec § 9, Task 37 l.30. The bound is per-profile rate × bins, inside the 1 MiB / 256-message per-client limits. |

### Task 24 (config)

- `ScannerConfigSchema.ws` (task-24-brief l.419-425), after `spectrumBins`:
```ts
				/** Engine summary-detail budget: block-summary bins per source (config only; never per client, never PATCHed). */
				spectrumSummaryBins: z.number().int().min(512).max(2048).default(2048),
				/** Distinct active non-default spectrum profiles over all sources (config only). */
				spectrumMaxProfiles: z.number().int().min(1).max(16).default(4),
```
- Do **not** add either key to `RuntimeSettingsOverridesSchema` (`persistence.ts` :287-293). Its `ws` object is
  `.strict()`, so a PATCH that contains them is a 400.
- Do not add either key to `NUMERIC_BOUNDS`/`SCANNER_SETTINGS_BOUNDS` either. `mergeScannerSettings` reports them with
  provenance `config`/`default`.
- The `config/default.yaml` commented line (l.711) becomes:
  `#   ws: { maxMessagesPerSecond: 10, spectrumHz: 10, spectrumBins: 512, spectrumSummaryBins: 2048, spectrumMaxProfiles: 4 }   # spectrum feed: default profile 0.5-25 Hz, 128-2048 bins; summary budget 512-2048 (provisional 2048) and profile cap 1-16 are config-only`.
- `SPEC_DEFAULTS` (l.69): `ws: { maxMessagesPerSecond: 10, spectrumHz: 10, spectrumBins: 512, spectrumSummaryBins: 2048, spectrumMaxProfiles: 4 }`.
- S1-A edits: see "S1-A files" below. Add their four paths to Task 24's Files and `git add`.
- Tests (+2):
  - `tests/unit/utils/scanner-config.test.ts`, "bounds the config-only spectrum keys": defaults are 2048 and 4; it
    rejects a summary budget of 4096 or 256 and a profile cap of 0 or 17.
  - `tests/unit/core/scanner/settings.test.ts`, "rejects a PATCH of the config-only spectrum keys":
    `ScannerSettingsPatchSchema.safeParse({ ws: { spectrumSummaryBins: 1024 } }).success === false`, and the same for
    `spectrumMaxProfiles`.
- Env: `WAVEKIT_SCANNER__WS__SPECTRUM_SUMMARY_BINS` and `WAVEKIT_SCANNER__WS__SPECTRUM_MAX_PROFILES`. The existing
  mapper handles them (`config.ts` :583-586), so there is no code.
- If Step 9a lowers the default, 37a edits `src/config.ts`, `SPEC_DEFAULTS` and the yaml comment (see Step 9a).

### Task 25 (DTOs)

- **One DTO is touched, narrowly.** `ScannerSettingsValues.ws` (task-25-brief l.654) becomes
  `{ maxMessagesPerSecond: number; spectrumHz: number; spectrumBins: number; spectrumSummaryBins: number; spectrumMaxProfiles: number }`.
  - The `Same<Api.ScannerSettingsValues, Core.ScannerSettings>` guard (l.42) forces this.
  - Main accepted it (32fc238).
  - Every spectrum DTO lives in Task 37a's `packages/api-types/src/spectrum.ts`.

### Task 32 (worker summary budget and transport)

- `buildPipelineConfig` (l.1366): change it to `spectrumBins: s.ws.spectrumSummaryBins, // engine summary budget; client bins are applied by SpectrumService (Task 37a)`.
- R2 (controller ruling): the engine emits `"stream"(stream, reason: "restart" | "stop")` before the first event of a
  new stream, and also from `stop()`.
- Transport unchanged:
  - `PipelineConfigSchema.spectrumBins` 16–4096 (l.713) already admits the new value.
  - Summaries still cross as `number[]` in `{type: "events"}`.
  - `setSpectrumFeed(true)` stays on for every engine.
- Test (+1) in `tests/unit/core/spectrum/spectrum-engine.test.ts`, "builds the pipeline with the engine summary budget,
  not the client bins". Call
  `buildPipelineConfig("rtl", "U8_IQ", 2_048_000, testSettings(s => { s.ws.spectrumBins = 256 }), DEFAULT_TUNING)`;
  `.spectrumBins` is 2048, and with `spectrumSummaryBins` 1024 it is 1024.

### Tasks 35 and 35a (header note only)

Add one line under each brief's **Spec** line: "Block summaries come from `ws.spectrumSummaryBins` (provisional 2048)
after Task 32, at native resolution when `fftSize` ≤ 2048. Never assume `ws.spectrumBins`; always read
`summary.binHz`."

The code is unchanged:
- `bestPsd` (task-35-brief l.2461-2466) and `measureTarget` (task-35a-brief l.1556-1558) already use `summary.binHz`.
- Up to 4× finer PSD evidence stays inside `maxEvidenceMb` (accepted by Main).

### Task 37a (spectrum service, WS, REST)

**DTOs** (`packages/api-types/src/spectrum.ts`, additions to Step 3):
```ts
/** `options.spectrum` of a WS `subscribe` that includes "spectrum". Omitted options = the default selection. */
export interface SpectrumSubscribeOptions {
	sourceId: string
	/** 0.5–25, snapped to 0.5 Hz; default `scanner.ws.spectrumHz`. */
	hz?: number
	/** 128–2048, rounded to an integer; default `scanner.ws.spectrumBins`. */
	bins?: number
}
export interface SpectrumProfileView { key: string; hz: number; bins: number }
export type SpectrumProfileAdjustment = "hz" | "bins" | "profile-limit"
export type SpectrumSubscribeErrorCode =
	| "SPECTRUM_OPTIONS_INVALID"
	| "SPECTRUM_SOURCE_NOT_FOUND"
	| "SPECTRUM_SOURCE_NOT_IQ"
	| "SPECTRUM_SOURCE_REMOVED"
	| "SPECTRUM_ENGINE_ERROR"
/**
 * `spectrum:profile`, sent to one client only: its selection after a subscribe (ack), after a permanent source removal
 * (notice), or after a default PATCH remapped it (notice). Every one of them resets the client's waterfall.
 */
export interface SpectrumProfileEventData {
	/** none: no frames; default: the default profile on every eligible source; source: one source. */
	selection: "none" | "default" | "source"
	sourceId: string | null
	/** Profile served (the current default for "default"); null with selection "none". */
	profile: SpectrumProfileView | null
	/** blockHz / summariesPerFrame of `profile` on `sourceId` (null before the engine has a config, or for "default"). */
	effectiveHz: number | null
	/**
	 * exact: as requested; nearest: see `adjusted`; default: no options; rejected: the request failed and the previous
	 * selection is kept; removed: notice that `removedSourceId` was permanently removed.
	 */
	outcome: "default" | "exact" | "nearest" | "rejected" | "removed"
	adjusted: SpectrumProfileAdjustment[]
	removedSourceId?: string
	code?: SpectrumSubscribeErrorCode
	message?: string
}
export interface SpectrumActiveProfile extends SpectrumProfileView {
	sourceId: string
	isDefault: boolean
	clients: number
	/** From the latest summary (null before one). */
	binCount: number | null
	binHz: number | null
	summariesPerFrame: number | null
	/** blockHz / summariesPerFrame: the delivered cadence while summaries flow; an upper bound across pauses. */
	effectiveHz: number | null
}
export interface SpectrumLimits {
	maxProfiles: number
	hz: { min: number; max: number; step: number }
	bins: { min: number; max: number }
}
```
- `SpectrumFrameEventData` gains two fields; every other field and the encoding are unchanged:
  - `nativeBinHz: number`, which is fs / fftSize. `binHz / nativeBinHz` is the total max-hold factor.
  - `snapshot?: true`.
- `SpectrumSourceStatus` gains:
  - `summaryBinCount: number | null`;
  - `summaryBinHz: number | null`;
  - `summaryHz: number | null` (= 1000 / `integrationMs`);
  - `reason` widens to `"source-not-iq" | "source-removed"`.
- `SpectrumStatus` becomes
  `{ defaultProfile: SpectrumProfileView; profiles: SpectrumActiveProfile[]; limits: SpectrumLimits; subscribers: number; sources: SpectrumSourceStatus[] }`.
  `subscribers` counts clients whose `current` is not null.
- The Step 3 DTO comment on `profile` (l.316) becomes `` /** `${hz}:${bins}`: the default profile (scanner.ws) or a client's (options.spectrum). */ ``.

**`src/core/spectrum/spectrum-service.ts`**. This replaces the Step 5 parts named here; the rest of Step 5 stands.

Remove `WS_CONSUMER`, `profilesFrom`, the `subscribers` field and `setSubscribers`, and add:
```ts
export const WS_CONSUMER_PREFIX = "ws:"
export const wsConsumer = (clientId: string): string => `${WS_CONSUMER_PREFIX}${clientId}`
export const PROFILE_LIMITS = { hz: { min: 0.5, max: 25, step: 0.5 }, bins: { min: 128, max: 2048 } } as const
export const SpectrumSubscribeOptionsSchema = z
	.object({ sourceId: z.string().min(1).max(128), hz: z.number().finite().optional(), bins: z.number().finite().optional() })
	.strict()
export function profileKey(hz: number, bins: number): string // `${hz}:${bins}`
export function defaultProfile(s: SpectrumSettings): SpectrumProfile // from ws.spectrumHz/spectrumBins, unsnapped
/** Omitted fields take the fallback's value unchanged; given ones are snapped and clamped (Decisions); `adjusted` names those that changed. */
export function normaliseProfile(
	req: { hz?: number | undefined; bins?: number | undefined },
	fallback: SpectrumProfile,
): { profile: SpectrumProfile; adjusted: ("hz" | "bins")[] }
/** Prefers candidates ≤ want on both axes; metric and ties as in Decisions. `candidates` is never empty (the default is always in it). */
export function nearestProfile(want: SpectrumProfile, candidates: readonly SpectrumProfile[]): SpectrumProfile
/** n = max(1, ceil(blockHz / hz)). */
export function summariesPerFrame(blockHz: number, hz: number): number
```

Public surface (C5 replaces `setSubscribers`, the `"frame"` signature and `"frame"`-only events):
- `subscribe(clientId: string, options: unknown): Promise<void>`. `undefined` means the default selection.
- `unsubscribe(clientId: string): Promise<void>`.
- Neither method rejects. Internal errors are logged with the component logger and become `SPECTRUM_ENGINE_ERROR`
  acks, so the wiring calls them with `void`.
- Events:
  - `"profile"(clientId, ack: SpectrumProfileEventData, snapshots: SpectrumFrameEventData[])`, emitted
    synchronously;
  - `"frame"(frame, clientIds: readonly string[])`;
  - `"pipeline"`, as before;
  - `"stream"` and `"released"`, gated by R2.
- `SpectrumServiceDeps` gains `createHost?: SpectrumEngineDeps["createHost"]`, passed through in `open()`. It is a test
  seam; production omits it.

State:
```ts
interface Selection { sourceId: string | null; profile: SpectrumProfile | null }   // null/null = the default selection
type ClientOp = { kind: "subscribe"; options: unknown } | { kind: "unsubscribe" }
interface ClientState {
	current: Selection | null
	next: Selection | null                // admitted, being acquired (counted in U)
	held: Set<string>                     // sources holding wsConsumer(clientId), added the moment acquire resolves
	running: Promise<void> | null
	pending: ClientOp | null              // latest wins
	seq: number                           // bumped by every request, disconnect, stop and removal of a source of `next`
}
// SpectrumService fields
private readonly clients = new Map<string, ClientState>()
private transitionHolder: string | null = null          // M3: at most one over-cap switch in flight
private defaultKey: string | null = null                // M2: last default key seen by syncDefault()
private readonly removedSources = new Set<string>()     // M1: permanently removed until "connected" again
private readonly sourceGen = new Map<string, number>()  // M1: bumped on each permanent removal
private readonly closing = new Map<string, Promise<void>>()   // finding 3
private stopping = false
// Entry: `consumers` → `jobs: Set<string>` and `displays: Set<string>` (R2); `holds` values gain `count: number` (replaces `at`)
```

**Requests (M4, findings 2 and 7).** `subscribe` and `unsubscribe` both call `request(clientId, op)`. Up to the start
or queueing of the op, it runs synchronously:
- `unsubscribe` of an unknown client creates no state and returns at once.
- Otherwise it gets or creates the client state and runs `seq++`.
- If an op is running, `pending = op`, which silently drops an earlier pending op: that op is superseded and gets no
  ack.
- Otherwise it starts the op.

When an op finishes, it starts `pending` if there is one. Otherwise, if `current === null && held.size === 0`, it
deletes the client state. The state therefore lives exactly as long as work or demand exists, and a queued op always
finds its own entry (finding 2).

Each running op captures `mySeq = state.seq`. It is **superseded** when, after any `await`, `state.seq !== mySeq` or
`this.stopping`.

**Subscribe op.** Steps 1–5 run without any `await`.
1. Call `syncDefault()` (M2 below) and keep `def`.
2. Validate:
   - `options === undefined` gives the default selection.
   - Otherwise run `SpectrumSubscribeOptionsSchema.safeParse`. A failure rejects with `SPECTRUM_OPTIONS_INVALID`.
   - A source missing from `sourceConfigs` rejects with `SPECTRUM_SOURCE_NOT_FOUND`.
   - A source in `removedSources` rejects with `SPECTRUM_SOURCE_REMOVED`.
   - A source that fails `isScannerIqFormat` rejects with `SPECTRUM_SOURCE_NOT_IQ`.
   - A rejection emits `"profile"` with `outcome: "rejected"`. Its fields describe `current`, which stays unchanged,
     and the op ends.
3. Normalise: `{profile, adjusted} = normaliseProfile(opts, def)`.
4. Admission, for a source selection with `profile.key !== def.key` (finding 8, M2, M3):
   - **Pairs.** Let P = `(sourceId, profile.key)`.
   - **U.** U is the set of distinct non-default pairs (key ≠ `def.key`) over every client's `current` and `next`.
   - **Leaving pair.** Let L be this client's own `current` pair if it is non-default and no other client's `current`
     or `next` uses it. L leaves U at commit.
   - **Shareable.** Shareable pairs are U minus the transition holder's leaving pair.
   - **Admit** when one of these holds:
     - P is shareable;
     - `|U| < cap`;
     - L exists and `transitionHolder === null`. In this case set `transitionHolder = clientId`.
   - **Otherwise map** P with `profile = nearestProfile(profile, [def, ...shareable profiles on sourceId])` and push
     `"profile-limit"`.
   - Default-key and default selections always pass.
5. Set `next`. The sources it needs are every non-removed `eligibleSources()` entry for the default selection, else
   `[sourceId]`.
6. For each needed source the client does not hold, `await this.acquireDisplay(source, clientId, state)`. If the op is
   superseded after any await, **abort** without emitting.
   - Default selection: a per-source failure, including removal, is logged once (the `errors` map) and skipped.
   - Source selection: a failure aborts. If the op was not superseded, it emits `"profile"` with `outcome: "rejected"`
     and `code` `SPECTRUM_SOURCE_REMOVED` or `SPECTRUM_ENGINE_ERROR`.
7. **Commit** (synchronous):
   - `current = next`, `next = null`;
   - if `transitionHolder === clientId`, then `transitionHolder = null`;
   - build the ack (`outcome`: `default`, `exact` when `adjusted` is empty, else `nearest`), with `effectiveHz` from the
     engine config;
   - build the snapshots (below);
   - `this.emit("profile", clientId, ack, snapshots)`.
8. Release the held sources the new `current` does not need, through `releaseDisplay`, awaited in order.

**Abort.** `next = null`, and the transition slot is freed if this client holds it. Every held source that `current`
does not need is released. Abort never emits `"profile"`, except for the not-superseded rejections in step 6.

**Unsubscribe op.** It sets `current = next = null`, frees the transition slot if held, and releases every held source.
It emits nothing: the broadcaster has already sent `unsubscribed`.

**`acquireDisplay(sourceId, clientId, state)`.**
1. Run `const gen = sourceGen.get(sourceId) ?? 0`.
2. Throw `WaveKitError` `SPECTRUM_STOPPED` when `stopping`, or `SPECTRUM_SOURCE_REMOVED` when `removedSources` has the
   source.
3. `await this.acquire(sourceId, wsConsumer(clientId))`, then `state.held.add(sourceId)`.
4. If `(sourceGen.get(sourceId) ?? 0) !== gen || removedSources.has(sourceId)`:
   `state.held.delete(sourceId)`, `await this.releaseDisplay(sourceId, clientId)`, and throw `SPECTRUM_SOURCE_REMOVED`.

**Engine acquire and release** (`acquire`, `release`, shared with jobs; finding 3, R2).
- `acquire` first awaits `this.closing.get(sourceId)?.catch(() => undefined)`.
- It then adds the consumer to `jobs` or `displays` by prefix. Unchanged: inflight `opening`, then `open()`.
- `release` decides first: `wasJob = jobs.delete(c)`, otherwise `displays.delete(c)`, and
  `stopping = jobs.size + displays.size === 0`.
  - If the engine stays up, emit `"released"` only when `wasJob`.
  - If the engine stops: `entries.delete`, then `const p = this.stopEngine(sourceId, entry, { reemitStop: wasJob })`.
    Set `closing.set(sourceId, p)`, `await p`, and delete it in `finally`.
- `status().sources[].consumers` is `jobs.size + displays.size`.

**Permanent removal (M1).**
- In `start()`, subscribe `deps.sources.on("source-removed", this.onSourceRemoved)` and `.on("connected", this.onSourceConnected)`;
  `stop()` removes both listeners. `"removed"`, the reconnect and shutdown teardown, is **not** listened to here.
  Reconnects keep every selection, because the engine already handles stream boundaries.
- `onSourceRemoved(sourceId)` runs synchronously first.
  1. `removedSources.add(sourceId)`, then bump `sourceGen`.
  2. For each client:
     - If `current.sourceId === sourceId`: `current = null`, then emit `"profile"` with
       `{selection: "none", sourceId: null, profile: null, effectiveHz: null, outcome: "removed", adjusted: [], removedSourceId, code: "SPECTRUM_SOURCE_REMOVED"}`.
     - If `current` is the default selection and it holds `sourceId`, emit the same notice with `selection: "default"`
       and the default profile. That client keeps its other sources.
     - If `next.sourceId === sourceId` and the op is in flight, run `seq++` so the op is superseded. The op's own
       not-superseded check would then fail too, so the client gets nothing for that op. Instead, the client gets the
       `outcome: "removed"` notice right away, with `selection` describing `current`.
     - Delete `sourceId` from `held`. The transition slot is freed by the aborting op as usual, or at the holder's
       commit.
  3. It then runs `void this.dropDisplays(sourceId)`. That method clears the entry's `displays`, drops its holds, and
     stops the engine if `jobs` is empty (through the `closing` map). `stopEngine` removes the fanout branch
     `scanner-<sourceId>`, and a missing branch or router fanout is tolerated.
  4. If `jobs` is not empty, the engine stays up until Task 35's own `"source-removed"` handler fails those jobs and
     releases them. Ordering between the two listeners does not matter.
- No R2 event comes from display cleanup.
- An acquire that is still opening completes, sees the bumped `sourceGen` in `acquireDisplay`, and releases its demand.
  No ack, snapshot or demand survives.
- `eligibleSources()` excludes `removedSources`.
- `onSourceConnected(sourceId)` deletes the id from `removedSources`, which covers a source re-added with the same id.
  Default clients are not extended automatically; that is a follow-up.
- `status()` reports a removed source with `eligible: false, reason: "source-removed"`.

**Default PATCH (M2, finding 8): `syncDefault(): SpectrumProfile`.** It runs at every admission and at every block
summary before `recipients()`.
1. `def = defaultProfile(settings())`. If `def.key === defaultKey`, return `def`.
2. Otherwise `prev = defaultKey` and `defaultKey = def.key`.
3. Count `others` = |U excluding pairs keyed `prev`|. Every pair keyed `prev` is a former exempt pair and now counts.
4. Keep the first `max(0, cap − others)` of them, ordered by `sourceId`. For every client on a remaining former pair,
   whether `current` or `next`:
   - set its profile to `def`;
   - emit `"profile"` with `{selection: "source", sourceId, profile: def, outcome: "nearest", adjusted: ["profile-limit"], …}`.
     This goes for `current` only. A remapped `next` reports in its commit ack.

The invariant is restored: |U| ≤ cap, plus 1 while a transition is in flight. It holds over any PATCH sequence.

**Frames and decimation (M5, findings 4 and 9).** On `block-summary`:
1. Call `syncDefault()`, then `recipients(sourceId)`. Default clients that hold the source go under `def.key`; source
   clients go under `current.profile.key`.
2. Drop holds of absent keys.
3. If `entry.engine.config()` is null, skip.
4. Compute `blockHz = 1000 / cfg.integrationMs` and `n = summariesPerFrame(blockHz, profile.hz)`.
5. `hold = accumulateHold(…)`, unchanged except that its `count` survives a reset. Then `hold.count += 1`.
6. When `hold.count >= n`, emit `"frame"(frame, clientIds)` and set `hold.bins = null`, `hold.count = 0`.

`frame()` sets `nativeBinHz = cfg.sampleRateHz / cfg.fftSize`. The decimation needs no wall clock, and `now` is used
only for `at`.

**Snapshots.** These are built in the commit step for each source the client now receives. A snapshot is added only
when all of these hold:
- `entry.lastSummary` and `entry.lastEpoch` exist;
- `config()` is set;
- the summary's `stream` and `epoch` equal `engine.currentEpoch()`.

The snapshot is `{ ...frame(…, reduceMaxHold(lastSummary.bins, profile.bins)), snapshot: true }`.

**`status()`.**
- `defaultProfile`, and `limits` (the cap from settings plus `PROFILE_LIMITS`).
- `profiles`: one entry per recipient group per running source, computed from `lastSummary` with
  `factor = max(1, ceil(len / bins))`. The entry carries `binCount = ceil(len / factor)`, `binHz`,
  `summariesPerFrame = n` and `effectiveHz = blockHz / n`.
- Per source: `summaryBinCount`, `summaryBinHz`, `summaryHz`. `latestFrame` uses the default profile, as before.

**`stop()` (M4).**
1. `stopping = true`. For every client, run `seq++` and set `pending = null`.
2. `await Promise.allSettled(running ops)`. Each op aborts at its next check and releases what it holds.
3. Clear `clients`, set `transitionHolder = null`, and stop the engines as before.

**Never** call `reconfigure`, `refreshTuning`, `setSpectrumFeed(false)` or read client values into a `PipelineConfig`
on any display path.

**`src/core/source-manager.ts`.** This is the only shared-file line. Add
`"source-removed": (sourceId: string, removedAt: Date) => void` to the documentary `SourceManagerEvents` interface
(:126-148), with the comment "permanent removal only (disconnect()); never on reconnect or shutdown". It matches the
emit at :1407 and adds no behaviour.

**`src/api/websocket/events.ts`** (adds to Step 8):
- `ClientMessage` gains `options?: Partial<Record<WebSocketChannel, unknown>>`. `parseClientMessage` copies
  `msg["options"]` only when it is a non-array object.
- Add `export interface ChannelObserver { subscribed(clientId: string, options: unknown): void; unsubscribed(clientId: string): void }`
  and `observeChannel(channel, observer): () => void`, with one observer per channel.
- `handleSubscribe` sends `subscribed` first. Then it calls `subscribed(client.id, message.options?.[channel])` for each
  observed channel in the message.
- `handleUnsubscribe` calls `unsubscribed` for each observed channel the client actually had.
- `handleDisconnect` gains a first line, `if (!this.clients.has(client.id)) return` (finding 7). After it, the method
  notifies `unsubscribed` for each observed subscription. This makes a late `close` after `terminateClient` or
  `closeAll` a no-op. `closeAll` notifies before it clears.
- `sendToClients(channel, clientIds: Iterable<string>, message: ServerMessage): number` stringifies
  `{ ...message, channel }` once. It enqueues the string only to listed clients that are subscribed to `channel` with
  `socket.readyState === 1`, the same filter as `broadcast`.
- `ServerMessage.type` adds `"spectrum:profile"`. Drop `broadcastSpectrumFrame`.

**`src/api/websocket/spectrum-broadcast.ts`** (replaces the Step 8 file).
- `SpectrumBroadcastSource` has `on/off` for `"frame"` and `"profile"`, plus `subscribe(clientId, options: unknown): Promise<void>`
  and `unsubscribe(clientId): Promise<void>`.
- `wireSpectrumBroadcasts(spectrum, broadcaster): { dispose(): void }`:
  - observes `"spectrum"`;
  - forwards `subscribed`/`unsubscribed` as `void spectrum.subscribe(id, options)` / `void spectrum.unsubscribe(id)`;
  - on `"profile"(id, ack, snapshots)`, calls `sendToClients("spectrum", [id], { type: "spectrum:profile", data: ack })`,
    then one `spectrum:frame` per snapshot, synchronously;
  - forwards `"frame"` to `sendToClients`.
- `dispose()` unobserves, removes both listeners, and unsubscribes every client id it has seen. There is no timer and no
  `opts`.

**REST.** `src/api/routes/spectrum.ts` is unchanged apart from the status shape. The test fake returns the new
`SpectrumStatus`.

**Measurement (new Step 9a, finding 5 and item C).** It lives in the file
`tests/unit/core/spectrum/spectrum-summary-budget.test.ts`.

Gated test: `describe.skipIf(process.env["WAVEKIT_MEASURE_SUMMARY"] !== "1")`, one test, 120 s timeout. Run it once:
`WAVEKIT_MEASURE_SUMMARY=1 pnpm exec vitest run tests/unit/core/spectrum/spectrum-summary-budget.test.ts`.

**Fixed workload.**
- Generate once 1 s at 2.048 Msps: seeded `mulberry32` Gaussian noise σ 0.05 plus one tone at +93.75 kHz, amplitude
  0.3.
- Pack it as one CU8 `Uint8Array` of 4,096,000 bytes, reused by every run.

**Run.**
- Each run is `new Harness({ sampleRateHz: 2_048_000, fftSize: 2048, integrationMs: 50, spectrumBins: B })` with
  `h.start()`, which sends `new-stream` and `spectrum-feed` on.
- Feed exactly one block per call (102,400 samples, 204,800 bytes) with `h.send({ kind: "bytes", startSample, bytes })`,
  and `await yieldToRpc()` between blocks.
- Time only the `handle()` calls.

**Rounds.** Run 5 rounds with a rotating order: `[512, 1024, 2048]`, `[1024, 2048, 512]`, `[2048, 512, 1024]`, and so
on.

**Metrics.** Measure on each `block-summary` event alone:
- `bytesPerSummary`: `v8.serialize(ev).byteLength`, which is deterministic;
- `cloneUs`: the mean of 50 × `structuredClone(ev)`. This is serialise plus deserialise, an upper bound for the worker
  post plus the main-thread receive.
- `profileUs`, on the 2048 run's summaries for the 512 and 2048 profiles: the mean of 50 ×
  `encodeBins(accumulateHold(undefined, reduceMaxHold(s.bins, bins), s.epoch).bins!)`.
- `pipelineMs`, reported only.

**Output.** Print one `console.info` table with, per budget: the median and minimum of each timing,
`bytesPerSummary`, `summaryBins` and the summary rate (20/s).

**Decision rule.** Noise only inflates timings, so the CPU criteria use the **minimum** over the 5 rounds. 2048 stays
the default iff all three hold:
- (a) `bytesPerSummary` × 20 ≤ 512 KiB/s per source;
- (b) min `cloneUs` × 20 ≤ 10 ms/s;
- (c) min `profileUs` of the 2048-bin profile × 20 ≤ 5 ms/s.

There is no `pipelineMs` criterion, because `summary()` iterates the same bins at every budget (`pipeline.ts`
:1358-1366). Otherwise take the largest budget that passes, 1024 and then 512.

**Fallback edits.** Change `src/config.ts` (default), Task 24's `SPEC_DEFAULTS` and the `default.yaml` comment. Record
the table and the decision in the 37a report and in the Task 38 announcement.

**Platform note.** These are Mac numbers. The Pi 4 is about 3–5× slower [INFERENCE], so the Pi check belongs to
CHECKPOINT S1/S4.

**Brief text replaced (finding 11).** Task 37a executes these replacements verbatim.

- **Files.**
  - Add `tests/unit/core/spectrum/spectrum-summary-budget.test.ts` (Test).
  - Add `src/core/source-manager.ts` (Modify: `SourceManagerEvents` line).
  - Add "`ChannelObserver`, `sendToClients`, `spectrum:profile`" to the `events.ts` description.
- **Design bullet l.16.** "and `ws` for `spectrum` subscribers" becomes "and `ws:<clientId>` for each `spectrum`
  client (display demand, kept in a separate set, Spectrum-profile amendment)".
- **Design bullet l.17.** "built only while `subscribers > 0` … Today there is one profile … Per-subscription profiles
  can be added later without changing the frame shape" becomes "built per active profile (the default from
  `ws.spectrumHz`/`ws.spectrumBins`, plus client profiles, see the amendment) and emitted every
  `ceil(blockHz / hz)` summaries".
- **Step 3.**
  - The `profile` comment changes as above.
  - The bullet at l.376 becomes "Task 24 adds `ws.spectrumSummaryBins`/`ws.spectrumMaxProfiles`; Task 25 touches
    only `ScannerSettingsValues.ws`".
- **Step 8.**
  - The test "forwards spectrum frames and reports the subscriber count once per change" (l.1127) is **deleted** and
    replaced by W2–W5 below.
  - The `wireSpectrumBroadcasts` code fence is replaced by the wiring above.
- **Step 9 Run.** Append `tests/unit/core/spectrum/spectrum-summary-budget.test.ts`. The Expected count changes as
  described below.
- **Step 10.**
  - Add `tests/unit/core/spectrum/spectrum-summary-budget.test.ts` and `src/core/source-manager.ts` to the eslint
    paths and to both path lists of the `git add … -- …` command.
  - Commit them with the rest.
- **`task-35a-brief.md` l.58-84.** That block repeats the old C5 spectrum names as context only, and no code there
  uses them. This section wins; edit nothing.

**Tests.** The brief's 11 tests (1 trust, 7 service, 2 routes, 1 WS) become **39**: 1 + 30 + 2 + 4 + 2. There is also
1 test in Task 32's file. Unchanged brief tests:
- the occupancy test;
- the three pure tests, with `accumulateHold`'s `count` added.

Rewritten brief tests:
- "runs an engine only while a consumer holds it" and the scanner-disabled test use `subscribe("c1", undefined)` and
  `unsubscribe("c1")`.
- "emits encoded frames…" uses a default subscriber and expects `profile "4:256"` frames on every 5th summary
  (blockHz 20, hz 4).

New service tests (`tests/unit/core/spectrum/spectrum-service.test.ts`):
- **Harness.**
  - Two sources: `FakeSources` with `caps`/`streams` for `rtl` and `air`, and `getFanout: id => fanouts.get(id)`.
  - A fake-host variant via `createHost`, whose `close()` can be held open by a deferred.
  - A `memoryPersistence` whose `loadEngine(id)` can be gated by a deferred, to hold an acquire in flight.
- **Message order.** "Ack → snapshot → live" order is asserted on the sequence of `"profile"` and `"frame"` emits per
  client id.

S1. "serves a subscription without options the 10 Hz × 512 default on every eligible source". The ack is `default`.
    Frames for rtl and air have `binCount ≤ 512`.
S2. "builds each distinct profile once and routes frames only to its clients (CLI and web on one source)".
    - `c1` has no options; `c2` and `c3` request `{rtl, 25, 2048}`.
    - Per summary group there is one `"frame"` per key: `"25:2048"` goes to `[c2, c3]` and `"10:512"` goes to `[c1]`.
    - No client id appears under two keys.
S3. "never upsamples: a profile above the native detail reports the true bin count and width". At FS 1.024 Msps (819
    usable bins), `{bins: 2048}` gives `binCount === 819` and `binHz === nativeBinHz === 1000`.
S4. "serves the nearest admissible profile".
    - Clamping: `{hz: 99, bins: 50}` becomes `25:128`, `adjusted ["hz","bins"]`.
    - Profile limit, cap 2. With `20:1024` and `25:128` active, `{25, 2048}` becomes `20:1024` (`"profile-limit"`).
    - Prefer-not-larger: with cap 1 and `25:2048` active, `{20, 1024}` becomes the default `10:512`, not `25:2048`.
    - A request equal to the default key needs no slot.
S5. "rejects unservable requests with a code and keeps the previous selection". Cases: `OPTIONS_INVALID` (`{hz: "x"}`,
    missing `sourceId`, an extra key), `SOURCE_NOT_FOUND` and `SOURCE_NOT_IQ`. Frames continue on the old profile.
S6. "switches make-before-break: ack, then snapshot, then live frames, while the old engine is still closing".
    - `c1` requests `{rtl}` and then switches to `{air, 25, 1024}`, while the fake rtl host's `close()` is held.
    - An air summary is emitted during the hold.
    - `c1` sees ack, then snapshot, then live air frames. It gets no rtl frame after the ack.
    - After the release, the rtl engine is gone.
S7. "sends a late-joining client a snapshot of its own profile and the current epoch" (fake host). After a summary for
    epoch 3, `c2 {rtl, 25, 2048}` gets an ack and a `snapshot: true` frame with `profile "25:2048"`, epoch 3 and its
    `tuningTrust`.
S8. "sends no snapshot across a retune boundary, and a reconnect gets the new epoch's snapshot" (fake host).
    - After `epoch-started` 4 and before its first summary, a subscriber gets only the ack.
    - After the epoch-4 summary, a new client id gets an epoch-4 snapshot.
S9. "restarts every profile's hold at an epoch change and carries the epoch's trust" (fake host).
    - Epoch-3 and epoch-4 summaries fall inside one decimation group of two profiles.
    - The next frames carry epoch 4 and only epoch-4 bins.
    - An `unverified` epoch gives `tuningTrust: "unverified"`.
S10. "releases demand on unsubscribe, disconnect and a subscribe still in flight, and survives unsubscribe → subscribe
     in one tick".
     - With `loadEngine` gated, `subscribe` then `unsubscribe` leaves `sourceIds()` empty and
       `fanout.branches.size` 0. The client gets no ack.
     - `subscribe(c1, {rtl})`, `unsubscribe(c1)` and `subscribe(c1, {rtl, 25, 2048})` in one tick: `c1` gets exactly
       one ack, for `25:2048`. rtl's `displays` is `{ws:c1}`.
     - A final `unsubscribe` leaves nothing.
     - Two default clients: the engine stops only when the second leaves.
S11. "coalesces requests to one running and one pending; superseded requests send nothing and keep no demand".
     - With `loadEngine(air)` gated, `c1` requests A `{air}`, then B `{rtl, 20, 1024}`, then C `{rtl, 25, 2048}`
       synchronously.
     - B is never acquired and A's acquisition is released.
     - Exactly one ack arrives, for C. The `displays` sets end as `rtl: {ws:c1}` and `air: {}`.
S12. "stop() cancels in-flight subscribes". `stop()` during a gated acquire produces no ack, `clients.size` 0, and no
     engine or branch remains.
S13. "an acquire waits for a closing engine of the same source" (finding 3).
     - `c1` holds rtl alone; the fake host's `close()` is held.
     - `unsubscribe(c1)` and `subscribe(c2, {rtl})` run without an await between them.
     - After the close resolves, `fanout.branches.size === 1` and `c2` receives frames.
S14. "permanent removal releases display demand and notifies affected clients; a reconnect does not".
     - `sources.emit("removed", "rtl")` alone (a reconnect) changes nothing.
     - `sources.emit("source-removed", "rtl", new Date())` sends notices:
       - `c1 {rtl}` gets `outcome "removed"`, `selection "none"`, `removedSourceId "rtl"`;
       - default client `c2` gets `outcome "removed"`, `selection "default"`, and keeps its air frames.
     - With no job, the rtl engine and its branch are gone. No `"stream"` or `"released"` event fires.
     - With `job:a` also holding rtl, the engine stays until `release("rtl", "job:a")`.
     - A new `{rtl}` subscribe is rejected with `SPECTRUM_SOURCE_REMOVED`.
     - After `sources.emit("connected", "rtl")`, the same subscribe succeeds.
S15. "a removal during an in-flight acquire sends one removal notice and keeps no demand".
     - With `loadEngine(rtl)` gated, `c1 {rtl}` is in flight; then `"source-removed"` fires and the gate opens.
     - `c1` receives only the `removed` notice: no ack and no snapshot.
     - rtl's `displays` is empty, no engine runs and no branch remains.
S16. "the profile cap stays bounded across default PATCH changes" (M2). Cap 1, default A = `10:512`.
     - `c1 {rtl, 10, 512}` is exempt.
     - PATCH the default to B = `10:256`: `c1` now counts (|U| = 1).
     - `c2 {rtl, 10, 256}` is exempt.
     - PATCH to C = `10:128`, then let the next summary or admission run `syncDefault`. The pair B no longer fits.
       `c2` is remapped to C with a `nearest`/`profile-limit` notice, and `c1` keeps A (it already counted).
     - After every step, |U| ≤ 1 and the status shows at most 1 non-default profile.
S17. "make-before-break uses one bounded transition slot" (M3). Cap 1.
     - `c1 {rtl, 20, 1024}` gives |U| = 1.
     - `c1` switches to `{air, 25, 2048}` with `loadEngine(air)` gated. It takes the slot, so reserved |U| = 2 = cap + 1,
       while built non-default profiles stay 1 (the status shows only `rtl 20:1024`).
     - During the hold, `c2 {rtl, 15, 256}` and `c3 {rtl, 20, 1024}` are both mapped to `10:512` (`profile-limit`).
       `c3` is mapped because the leaving pair is not shareable.
     - After the gate opens: |U| = 1 and the slot is free.
S18. "the reported effective rate equals the delivered cadence" (M5; fake host, `integrationMs` 50).
     - 40 summaries delivered to profiles of 15, 25 and 7 Hz give 20, 40 and 13 frames.
     - `summariesPerFrame` is 2, 1 and 3, and `effectiveHz` is 10, 20 and 6.667.
     - Each satisfies `frames === floor(40 / summariesPerFrame)` and
       `effectiveHz === frames / (40 / blockHz)` (± 1 frame).
S19. "display choices never restart the engine or reach the detector".
     - `job:a` holds rtl while 3 clients subscribe, switch and leave.
     - `createHost` was called once, with `PipelineConfig.spectrumBins === ws.spectrumSummaryBins`.
     - No `"stream"` or `"released"` event fires, and `engine("rtl")` is the same instance.
S20. "a display-only engine's start, restart and stop emit no scanner-facing event" (fake host).
     - Without a job: a rate-change restart and the last client leaving emit no service event.
     - With `job:a` as well:
       - the restart is re-emitted once;
       - `release("rtl", "job:a")` while a display stays emits `"released"`;
       - the last display leaving emits nothing.
S21. "reports active profiles, limits and summary detail in the status". It includes `effectiveHz` 10 for a 15 Hz
     profile and `reason: "source-removed"`.
S22. "the default profile follows a settings change at the next frame". Setting `ws.spectrumBins` to 256 moves the
     default clients to `10:256`; a custom `{rtl, 25, 2048}` client is unchanged.
S23. "normaliseProfile, nearestProfile and summariesPerFrame are pure and bounded".
     - `hz`: 7.3 → 7.5, 0.1 → 0.5, 99 → 25.
     - `bins`: 300.4 → 300 with `"bins"` adjusted; 50 → 128.
     - An omitted `hz` passes an unsnapped default 7.3 through unchanged.
     - Nearest prefers candidates that are not larger, then the metric, with deterministic ties.
     - `summariesPerFrame(20, 15) === 2`.

WS tests (`tests/unit/api/scanner-ws.test.ts`; "accepts subscriptions to scanner and spectrum" is the brief's rename
of an existing Task 37 test and is not counted):

W2. "passes spectrum subscribe options to the service and forwards the ack and snapshots to that client only". A fake
    source records `(clientId, options)` and emits `"profile"`. Another subscribed client receives nothing.
W3. "sendToClients serialises once and skips unlisted and closed clients" (finding 15).
    - `vi.spyOn(JSON, "stringify")` around one `sendToClients("spectrum", ["c1", "c2"], msg)` records exactly 1 call.
    - `c3`, subscribed but not listed, receives nothing.
    - A listed client with `readyState` 3 receives nothing.
W4. "releases spectrum demand on unsubscribe, close and terminate, exactly once" (finding 7).
    - An unsubscribe, a socket `close`, and a `terminateClient` (on outbound overflow) followed by its `close` each
      give one `unsubscribed`.
    - `closeAll()` followed by late `close` events gives one per client.
W5. "re-subscribing switches without a new message type". A second `subscribe` with other options calls the service
    again, and one without options passes `undefined`.

Summary-budget tests (`tests/unit/core/spectrum/spectrum-summary-budget.test.ts`):

B1. Always-on: "keeps the 10 Hz × 512 default bins identical with a 512 or a 2048 summary budget when the native span
    is ≤ 2048 bins".
    - Use FS 1.024 Msps (`fftSize` 1024) and the same seeded input.
    - `reduceMaxHold(s2048.bins, 512)` equals `reduceMaxHold(s512.bins, 512)` in bins, `binHz × factor` and `startHz`.
    - The identity holds when d = 1 at 2048. At `fftSize` 4096 the default frame has 410 bins instead of 469, still
      ≤ 512 (S1).
B2. Gated: the measurement (Step 9a).

### Task 38 (docs; finding 6)

Replace these `task-38-brief.md` passages; Task 38 executes the replacements verbatim:

- **l.144, the `## Spectrum and waterfall` paragraph.** Keep the frame fields, the decoding example, the trust and the
  warnings. Replace "The profile key … 128–2048)." and "Engines run only while … `scanner.enabled: false`." with the
  subscription rules from "Contract to announce" below:
  - default selection, options, `spectrum:profile` and its outcomes;
  - limits and nearest admissible;
  - frame cadence (`effectiveHz`);
  - `nativeBinHz`;
  - the snapshot and ordering rule, and the client rules;
  - spectrum traffic sits outside `WsLimiter`.
  Add: "Engines run while a job or a `spectrum` client needs them, also with `scanner.enabled: false`".
- **l.174, `GET /api/spectrum`.** "status per source with the latest frame" becomes "`{defaultProfile, profiles,
  limits, subscribers, sources}`", with the `SpectrumActiveProfile`, `SpectrumLimits` and new `SpectrumSourceStatus`
  fields.
- **l.178.** Add `spectrum:profile` to the `####` list, documenting the ack/notice fields, outcomes and codes. On the
  `spectrum` channel, document `options.spectrum` on `subscribe`.
- **l.190.** "ref-counts one engine per source by consumer (`job:<id>`, `ws`)" becomes "ref-counts one engine per
  source; scanner consumers (`job:<id>`) and display clients (`ws:<clientId>`) are separate sets, and only scanner
  consumers produce `stream`/`released` events".
- **`docs/SCANNER.md`.** Add one sentence: "A `spectrum` subscriber gets the current state on subscribe (ack, then one
  snapshot per source of the current epoch, then live frames). This is not a replay of missed messages."
- **Spec § 12.2.** It gets the same sentence when the orchestrator schedules the R6/R7 spec amendments (Main accepted
  it; no task owns spec edits).

### S1-A files (edited by Task 24, the first task that needs them)

| File | Anchor | Change |
|---|---|---|
| `src/core/scanner/types.ts` | :514-515 `ws: { maxMessagesPerSecond: number; spectrumHz: number; spectrumBins: number }` and its doc line | add `spectrumSummaryBins: number; spectrumMaxProfiles: number`; doc: "spectrumSummaryBins 2048 (512–2048, provisional) and spectrumMaxProfiles 4 (1–16) are config-only" |
| `src/core/spectrum/types.ts` | :248 `ws: { spectrumHz: number; spectrumBins: number }` (`SpectrumSettings`) | add `spectrumSummaryBins: number; spectrumMaxProfiles: number` |
| `src/core/spectrum/types.ts` | :101 `/** ≤ spectrumBins, dBFS max-hold, rounded to 0.5. */` | `/** ≤ PipelineConfig.spectrumBins (the engine summary budget), dBFS max-hold, rounded to 0.5. */` |
| `src/core/spectrum/types.ts` | :184 `spectrumBins: number` (`PipelineConfig`) | add `/** Summary budget (ws.spectrumSummaryBins), never a client's bins. */` above it; keep the name |
| `tests/unit/core/scanner/plan/plan-preview.test.ts` | :64 `ws: { maxMessagesPerSecond: 10, spectrumHz: 2, spectrumBins: 512 },` | append `spectrumSummaryBins: 2048, spectrumMaxProfiles: 4` |
| `tests/unit/core/scanner/plan/plan-preview-p15.test.ts` | :82 same literal | same |

`pipeline.ts` needs no change.

### Contract to announce (Task 38 or the controller posts it in CLI-COORDINATION before landing; text only)

> **Core → CLI/Web: spectrum profiles (scanner Task 37a, amendment of 2026-10-10, reviewed; Main 32fc238).**
>
> **Default selection.**
> - `{"type":"subscribe","channels":["spectrum"]}` without options gets the default profile on every eligible source.
> - The default profile is `scanner.ws.spectrumHz` 10 × `scanner.ws.spectrumBins` 512, and both stay runtime-PATCHable.
>
> **Per-client selection.**
> - The message is `{"type":"subscribe","channels":["spectrum"],"options":{"spectrum":{"sourceId":"rtl","hz":25,"bins":2048}}}`.
> - A client has one source and one profile.
> - `hz` is snapped to 0.5 and clamped to 0.5–25. `bins` is rounded and clamped to 128–2048. Omitted fields take the
>   default's values.
> - Subscribing again switches without a gap, and subscribing without options returns to the default selection.
> - `unsubscribe` or a disconnect releases the demand.
> - Rapid re-subscribes coalesce: only the latest request is answered, and superseded ones get no reply.
>
> **`spectrum:profile`.** Sent to that client only:
> `{selection: "none"|"default"|"source", sourceId, profile: {key, hz, bins}|null, effectiveHz, outcome: "default"|"exact"|"nearest"|"rejected"|"removed", adjusted: ("hz"|"bins"|"profile-limit")[], removedSourceId?, code?, message?}`.
> - It is the ack to a subscribe, or a notice after a permanent source removal or a default-profile change that
>   remapped the client.
> - `selection: "none"` means the client receives no frames.
> - Codes: `SPECTRUM_OPTIONS_INVALID`, `SPECTRUM_SOURCE_NOT_FOUND`, `SPECTRUM_SOURCE_NOT_IQ`, `SPECTRUM_SOURCE_REMOVED`,
>   `SPECTRUM_ENGINE_ERROR`. A rejected request keeps the previous selection.
>
> **Limits.**
> - The server serves the nearest admissible profile and never rejects a request for its size.
> - Above `scanner.ws.spectrumMaxProfiles` (default 4 distinct non-default profiles over all sources; config-only,
>   1–16), a request maps to an active profile on that source or to the default. It prefers profiles not larger than
>   the request, so a substitute can still exceed it only when nothing smaller is active.
> - The status reports `limits: {maxProfiles, hz: {min, max, step}, bins: {min, max}}`.
>
> **Frames.** `spectrum:frame` keeps its shape and adds `nativeBinHz` and `snapshot?: true`.
> - `binCount ≤ bins`, never upsampled, and `binHz` is the true width.
> - Cadence: one frame per `ceil(blockHz / hz)` block summaries, with `blockHz = 1000 / integrationMs` (20 at the
>   default). `effectiveHz` is that cadence while blocks flow and an upper bound across sweep settles and gaps. For
>   example, 25 Hz gives 20 Hz, and 10 or 15 Hz gives 10 Hz.
> - Each profile is built once per source and sent only to its clients.
>
> **Ordering.**
> - Per client: ack first, then one `snapshot: true` frame per source received (the latest block of the current epoch
>   at that client's profile; none while a retune settles), then live frames.
> - Spectrum messages bypass the scanner limiter and do not count toward `ws.maxMessagesPerSecond`.
>
> **Client rules.**
> - Never merge or accumulate rows across a change of `sourceId`, epoch, `profile`, `binHz` or `startHz`; each row
>   carries its own axis.
> - Reset on every `spectrum:profile`.
> - Compare epochs for equality only, because they restart when an engine restarts.
>
> **Permanent source removal** (`DELETE /api/sources/:id`, which emits `source:removed`):
> - affected clients get `outcome: "removed"` (a source selection becomes `selection: "none"`);
> - a request in flight for that source ends with that notice only;
> - the server releases the demand at once.
>
> A reconnect changes nothing. A source re-added with the same id can be selected again, but default subscribers pick
> it up only on their next subscribe.
>
> **Engine summary budget.** `scanner.ws.spectrumSummaryBins` is **provisionally 2048** (config-only, 512–2048; the
> fallback is 1024, then 512). It is final once Task 37a reports its measurement: <table>. It is not a client setting.
>
> **REST.** `GET /api/spectrum` returns `{defaultProfile, profiles: [{sourceId, key, hz, bins, isDefault, clients, binCount, binHz, summariesPerFrame, effectiveHz}], limits, subscribers, sources: [… + summaryBinCount, summaryBinHz, summaryHz, reason?: "source-not-iq"|"source-removed"]}`.
>
> **Settings.** `ScannerSettingsValues.ws` gains `spectrumSummaryBins` and `spectrumMaxProfiles`. They are read-only:
> `PATCH /api/scanner/settings` rejects them.
>
> **Not in this change.** No WS tuning, no new command message, and no slice-zoom FFT (a separate follow-up).

### Effort estimate (rough)

| Task | Source lines | Test lines | Tests |
|---|---|---|---|
| 24 | +12 (schema, yaml comment, 4 S1-A type/doc lines) | +25, 2 literals edited | +2 |
| 25 | +1 (DTO `ws`) | 0 | 0 |
| 32 | +2 (budget line; the R2 `"stream"` emit is counted under the controller's ruling) | +15 | +1 |
| 35, 35a | 1 header line each (brief text) | 0 | 0 |
| 37a | `spectrum-service.ts` about +330 / −25 (requests, admission, removal, syncDefault, decimation, status); `spectrum.ts` +60; `events.ts` +65; `spectrum-broadcast.ts` about 45 (rewrite); `source-manager.ts` +1 | about +1100 (harness with gates and a fake host, 23 new service tests, 4 WS tests, 2 budget tests) | 11 → 39 (+28) |
| 38 | docs text only (replacements above) | 0 | 0 |

That is about +490 source lines and +1140 test lines in total. Task 37a roughly doubles. One measurement run produces
the numbers.

### Out of scope and follow-ups

- **Genuine slice-zoom FFT** is a ROADMAP § 8 follow-up, **not S1-B**: a higher-resolution FFT of the viewed slice,
  with bounded DSP and full-stream detection unchanged. Cropping or magnifying published bins does not satisfy it.
- WS tuning (after the REST/accepted-state latency measurement) and any new WS command message.
- Several sources per client selection.
- Re-upgrading a `nearest`-mapped client when a slot frees.
- Automatic pickup of newly eligible or re-added sources for existing default subscribers (allowed by Main). The client
  re-subscribes.
- A `Float32Array`/transfer-list summary transport, only if the measurement fails at every budget.
- Pi 4 numbers for the summary budget (CHECKPOINT S1 / S4 soak, with the user).

### Accepted by Main (32fc238)

The five design conflicts are closed. Main accepted them within the approved scope ("Main → Scanner: amendment review
and access integration boundary") and needs no further product approval:
1. **WS snapshot vs spec § 12.2 "no replay".** A current-state snapshot is not an event replay. The Task 38 docs and
   the § 12.2 sentence are given above.
2. **Task 25 narrowness vs the `Same<>` guard.** The two config-only fields in `ScannerSettingsValues.ws` are narrow
   additions.
3. **Spec § 9's "25 Hz" vs the block rate.** Reported rates must be honest, and are: `effectiveHz` is the exact
   decimated cadence (M5).
4. **Finer evidence and identify summaries.** They stay within the existing storage and performance bounds. The 35/35a
   header note is given above.
5. **C5 interfaces.** The delta may replace unlanded C5 interfaces. The replaced names are `WS_CONSUMER`,
   `profilesFrom`, `setSubscribers`, `broadcastSpectrumFrame`, the `"frame"` signature and the wiring `opts`.
   `"profile"` and `ChannelObserver` are new.

Main's prerequisites M1–M5 are resolved in this section: M1 removal, M2 `syncDefault`, M3 the transition slot,
M4 requests, M5 decimation.
