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
  shapes); no CLI reply on `main` or any other branch. Per the brief, Tasks 24, 26, 27 (except the WS field), 28, 30
  and 31 may proceed; **Tasks 25, 29 (status fields and route codes) and 37 wait** for the user's decision to
  proceed without an ack. The Core note on `ScannerSettingsView` was appended under the proposal.
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
  `channelizer: ChannelizerConfigSchema.default({})`, and `ChannelizerConfigSchema` sits directly above
  `ConfigSchema` (`src/config.ts` :383-420); the `ChannelizerConfig` type follows `CsdrConfig`. Insert as planned
  (the `csdr` anchors are still unique); `ScannerConfigSchema` goes between `ChannelizerConfigSchema` and
  `ConfigSchema`. `config/default.yaml`: the `csdr:` anchor (`bufferElements: 65536` :424, `# Health Monitoring`
  :427) is unchanged; the channelizer's commented block is at the end of the file (:667), so no conflict.

## Task 25

- **Task 25 (Step 5 gate).** CLI ack of the scanner contract → none. Task 25 waits for the user's go-ahead. No
  DTO changes were requested.
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
- **Task 25 / C3 (carry).** S1-A added the test-only export `trackIdPrefixes(sourceId, atMs)` in
  `src/core/spectrum/pipeline.ts` :84 (wideband track ids use the `w-` prefix, distinct from narrowband). Add its
  C3 contract entry.

## Task 26

- No delta. `SourceManagerEvents` gained only `removed(sourceId)` (internal teardown: permanent removal, reconnect,
  shutdown; `source-manager.ts` :137). U8_IQ alignment is at :399-405 (`iqRemainder` :215). The channelizer accepts
  only CU8 sources (`channelizer-manager.ts` :109), so aligning S16_IQ/FLOAT32LE chunks does not touch it.

## Task 27

- No delta (`tuner-controller.ts` unchanged). Note for Tasks 33 and 35: every `setFrequency` caps update now also
  invalidates the source's channels when the channelizer is enabled (see Task 33).

## Task 28

- **Task 28 (cf32 tail, corrected).** "The mode flag test asserts on the dsd-fme argument list only" → the test
  asserts on the whole `buildPipelineCommand()` string with whitespace-bounded tokens (`(^|\s)-fi(\s|$)`). The cf32
  tail only made the csdr front stages conditional (`buildIqFrontStages` returns `convert/shift/decimate: null` when
  `options.inputIqFormat === "cf32"`, `audio-demod-decoder.ts` :386-397; `dsd-fme.ts` :907-913). The default
  (cu8) path is unchanged and no csdr or sox stage emits a bare `-fi`/`-fm`/`-fn`, so the test stays as written.
- **Task 28 (anchors).** Mode switch `case "nxdn":` is at `dsd-fme.ts` :1035 (`-fn` :1037); CRC-ERR in
  `updateErrorWindow` :1213; `DMR_TGT_SRC` use :1333, `DMR_ENCRYPTED` use :1370; `findWavFileAsync` :1947.
  `DsdFmeMode` (:164) still has no `nxdn48`/`dpmr`. Keep the channelizer's `channelizerSupported()` override
  (:866) untouched. The brief's grep for `handleCpuIq` matches nothing on c4c1cda or main (the symbol never landed);
  the cf32 tail lives in `buildPipelineCommand`.

## Task 29

- **Task 29 (Step 5 gate).** The status fields and route codes wait for the user's go-ahead (no CLI ack). The
  manager-internal parts (probes, holds) depend on Task 25's `tuner-scanning` code, so in practice all of Task 29
  waits for Task 25.
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
- **Task 35 (rollback order, new).** `rollback()` releases the decoder hold before the lease (plan :32819-32845),
  whereas `teardown()` (plan :32796) and the S1-A transition table (`job-state.ts` :99, :125, :139) restore/release the lease
  first. With the channelizer, releasing the hold first resumes channel-fed decoders at the scan frequency, and the
  restore retune then invalidates their new channels (Task 33 note). In `rollback()`, release the lease (with
  restore) before the decoder hold, matching `teardown()`. Test impact: none of the plan's assertions depend on that
  order.

## Task 35a

- **Task 35a.** `createIdentifyDriver` keeps `channelizer: () => false` in S1-B. The channelizer is merged but is
  not wired into the scanner until Task 40, which flips it.

## Task 36

- **Task 36.** `POST /discoveries/:id/listen` stays the pre-channelizer form as planned (channelizer default off,
  no scanner channel transport in S1). Task 46 upgrades it.

## Task 37

- **Task 37 (Step 5 gate).** Waits for the user's go-ahead (no CLI ack).
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
  - Spec § 4.9 (R6): impulse blanking reference is the plan's (kept), not the spec's current wording. A spec
    amendment is needed (orchestrator to schedule; not in any S1-B file list).
  - Spec § 4.9 (R7): OBW tolerance `max(30 %, 2 RBW)` kept. A spec amendment is needed (same).
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
