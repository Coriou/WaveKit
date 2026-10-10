# Core Channelizer (Batches 3–5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every code task follows superpowers:test-driven-development: write the test, watch it fail, implement, watch it pass, commit.

**Goal:** Land real IQ fixture baselines with expected decodes (batch 3), then an opt-in per-source `wavekit-chan` channelizer that delivers exact-rate per-decoder IQ (batch 4), then a capacity gate against the bounded-CSDR baseline (batch 5).

**Architecture:** Batch 3 replaces the broken `fixtures/manifest.yaml` with a Zod-validated v2 manifest, a sha256-checking `download.sh`, and an env-gated vitest harness. The harness replays each fixture through a `recording` source in a built container and asserts decoded payloads. Batch 4 adds a Rust process, `native/wavekit-chan/`, that turns one CU8 capture into N filtered, resampled channels. Each channel goes out on its own Unix socket and is controlled by JSON lines. A Node `ChannelizerManager` (`src/core/channelizer/`) supervises one process per source as a fanout consumer. `DecoderManager` reaches it only through the existing `attachInput()`/`detachInput()` contract and the rate model's suspension primitives. Batch 5 extends `scripts/capacity/` to run 1/4/8-channel matrices on a quiet host.

**Tech Stack:** TypeScript (strict, ESM), Zod 3, vitest 3 + fast-check 4, yaml 2; Rust 2021 (`serde`, `serde_json`; `proptest` dev-only); bash + sox for fixtures; Python 3 stdlib for capacity scripts; Docker buildx bake (bookworm-slim, amd64 + arm64).

**Spec:** `docs/superpowers/specs/2026-10-09-core-channelizer-prototype-addendum.md` (the addendum). It refines `docs/superpowers/specs/2026-10-08-sample-rate-and-channelizer-design.md` (§ "Core channelizer prototype contract", § "Acceptance and implementation batches") and reuses `docs/superpowers/specs/2026-10-08-rate-model-instances-and-suspension.md` (§§ 2.1, 4.1–4.4, 5). Executors read the addendum and these sections before starting any batch-4 task. The plan's deliberate deviations from the addendum (A1, A3, A5, A10 and the AIS channel centre) are listed in addendum § 14.

**Planning session note:** this plan was written in a docs-only session. Nothing was committed and no code was written. The `git commit` steps below are for the executing sessions. It was revised in place on 2026-10-09 after review (rate model now on `main`; negative fixtures channelizer-only; factory-based decoder construction; harness cleanup by pid; AIS pair centre; `wavekit-chan` close deadlock; channel stream `end: false`; channelizer supervision gaps A14; small test defects).

## Global Constraints

- Scope: batches 3, 4 and 5 only. Batches 1–2 (rate model, owned by the core agent) and 6 (host placement) are out of scope.
- Order: batch 3 first. Batch-4 code that touches `DecoderManager`, decoders, config or `index.ts` starts only after **Task 18 (re-check)**. The rate model B1–B4 is already merged into `main` (see Plan-time facts), so Task 18 is a cheap confirmation, not a wait. Tasks 1–17 have no dependency on it.
- Off limits: `packages/api-types/`, `cli/`, `packages/sdr-host/`, the public contracts of `src/decoders/manager.ts` (existing method signatures, events, `DecoderStatus` shape), `src/api/routes/decoder-rate-schemas.ts`, `src/api/routes/decoder-status-schemas.ts`, `src/api/serializers/decoder-status.ts`.
- New reason codes or status fields are *proposed* in `docs/CLI-COORDINATION.md` "Open requests to other teams" (Task 18 drafts the text). They are never added to shared types.
- Reuse the rate-model contracts and do not invent parallel ones: `DecoderRateRequirements`, `RateSet`, `ResolvedRatePlan`/`DecoderRateAssessment`, `getRateRequirements?()`/`getRateAdapter?()`, `desiredRunning`, `ratePlan`, `suspension { reasonCode, since }`, `transition`, `rateGeneration`, `suspend`/`resume`/`evaluateRate`/`detachBranch`, the serial `drainCapsChanges`, and `decoder:status-changed(id)`.
- A channel admission failure is a suspension, never a crash. It consumes no restart budget, triggers no failure backoff, leaves `enabled` alone, records no `lastError`, and emits no `decoder:restarting`.
- Raw fanout stays for readsb, the tuner relay, recordings and live demod. readsb and lora-meshtastic are never channelised.
- Migration order: ais-catcher → dumpvdl2 → rtl_433 → audio family (direwolf, multimon-ng, dsd-fme, acarsdec). Each step is gated by Property 15 on its goldens.
- `channelizer.enabled: false` (the default) or `useChannelizer: false` (the default) leaves every pipeline byte-identical to today.
- Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), ESM with `.js` relative imports, `import type`, no floating promises (`void` + `.catch`), tabs, no semicolons, `x => …` single-arg arrows.
- Component loggers only (`createComponentLogger`); never `console.log` in `src/`. Throw `WaveKitError` (from `src/utils/errors.ts`) with a code. Streams: `pipeline()` from `stream/promises`, an `error` handler on every stream, `.destroy()` on shutdown. Zod at every boundary: config, control protocol, manifest, decoder options read.
- Tests: vitest globals; fast-check `numRuns: 100`; Rust `proptest` `cases: 100`. Property tests carry `// Feature: core-channelizer, Property N: <name>` and `// Validates: <addendum §>` comments, with N taken from addendum § 12.
- This Mac is heavily loaded. Never run benchmarks, the capacity matrix, `pnpm test` (the full suite) or image builds here. Verify with single files (`pnpm exec vitest run <file>`), `pnpm run typecheck`, `pnpm run lint` and `make chan-test`. Golden runs (Tasks 8, 28–32) and capacity runs (Task 36) happen on a quiet host, and each records the image ID, `git rev-parse HEAD` and `wavekit-chan --version`.
- Never `find /` or search outside the repo. Stage explicit paths when committing (`git add <paths>`); other sessions share the tree. Never push.
- Image facts: Debian bookworm-slim; csdr pinned at `CSDR_REF=1f15b8c5177cb348602da19e82bf0d62426ab8eb` (`Dockerfile:35`); no Rust toolchain or liquid-dsp in existing stages; s6 supervises only `wavekit-api`; decoders are spawned by Node.
- Fixture privacy: own captures (pager, ACARS, AIS, DMR, VDL2, rtl_433, LoRa) contain real identifiers. They are trimmed, kept under the gitignored `fixtures/raw/`, fetched by `download.sh` with sha256 from a private location, and never committed. Golden payloads recorded in the manifest for private fixtures use only the minimum key fields.

## Review Focus

These are the failure modes the addendum implies but leaves unspecified. Each has a test pinned in the task that owns the code.

1. **A default request sitting exactly on the admission boundary.** The default passband gives `bw/2 + tr = out/2` exactly, and float rounding can push it over. Expected: admitted. Both admission implementations compare with a `1e-6 Hz` tolerance. Pinned in Task 14 (Rust) and Task 16 (Node).
2. **A Unix socket path longer than the OS limit.** This happens with a long `socketDir` plus source and decoder ids, or with macOS's long `tmpdir()` (limit about 104 bytes). Expected: `channelizer-unavailable` with detail `socket path too long`, logged, and never a crash or a spawn. Pinned in Task 21.
3. **A source disconnect or retune while a decoder is channelised, or a dying `wavekit-chan`.** Expected: the decoder's stdin never sees EOF from the dying socket. The decoder is handed a `PassThrough` fed from the socket with `end: false`, because Node can see the socket's `end` before the child's `exit` and `BaseDecoder.attachInput` pipes with `end: true`. `detachInput()` runs synchronously inside `channel-invalidated` before the streams are destroyed. The decoder is then restarted through the serial worker with `restartCount` unchanged. A request pending at invalidation is retried, not parked. Pinned in Tasks 21 and 24.
6. **A crash-looping `wavekit-chan`.** Expected: after 5 unexpected exits within 60 s on one source, requests get `channelizer-unavailable` without a spawn until the window passes; an exit 0 after `input-eof` is not a crash. Pinned in Task 21.
7. **Closing a channel whose client stopped reading or vanished.** Expected: `close` returns promptly (no join on a writer blocked in `write_all`, no `ClientGone` send into a full bounded channel), and every other channel keeps flowing. Pinned in Task 15.
4. **The binary is missing, or the spawn fails.** Expected: every channelised decoder is suspended with `channelizer-unavailable` and one error log line, not one per decoder. Raw-path decoders on the same source keep running. Pinned in Task 24.
5. **A non-CU8 source (SDR++ `FLOAT32LE`/`S16_IQ`, audio) with `useChannelizer: true`.** Expected: `channel-request-invalid` suspension with no spawn, never a crash loop. Repeated identical caps cause no status churn. Pinned in Tasks 21 and 24.

---

## Plan-time facts (verified 2026-10-09)

- **Superseded where they differ:** read [`2026-10-09-core-channelizer-delta.md`](2026-10-09-core-channelizer-delta.md) first; its edits E1–E14 win over this plan, and the line numbers here and in the delta (re-anchors in its §1) are hints only. Find code by symbol.
- `main` was at `f49273c` ("feat(core): enable bounded CSDR rings by default") when this was verified; by the end of the revision another session had added the docs-only `896ab6a` ("docs(roadmap)", `docs/ROADMAP.md` only), so every code line reference below still holds. The rate model B1–B4 is **merged** (merge commit `4f99a2c`, "Merge suite reliability fixes and rate model B1–B4"; B3 `617a586` and B4 `caded97` are ancestors of `main`, and `git merge-base --is-ancestor 617a586 main` succeeds). `29f7ca0` (suspended reservations kept across source re-add) and `d283863` (the addendum) are also on `main`. So `tests/mocks/rate-fakes.ts`, `tests/mocks/executables.ts`, `tests/unit/decoders/manager-suspension.test.ts` and the DTO `suspended`/`suspension` fields exist on `main` now.
- `csdr.boundedBuffers` defaults to `true` on `main` (`src/config.ts` :264, `config/default.yaml` :376, from `f49273c`). The batch-5 bounded-CSDR baseline therefore needs no config flip, but every capacity run still records the exact revision (`git rev-parse HEAD`) and passes `--buffers on` explicitly.
- Line references below are taken from `main` at `f49273c`. Code moves; executors find code by symbol name and treat line numbers as hints.
  - `src/decoders/manager.ts` (1886 lines): `interface DecoderState` :79 (`branchId` :92, `branchFanout` :93, `desiredRunning` :108, `suspension` :110, `transition` :112, `rateGeneration` :114); `interface DecoderSuspension` :117; `startDecoder` :314 (wire at :373); `getStatus` :517 (`suspension` spread :528); `handleDecoderExit` :743 (suspension early return :753; restart-timer wire :857); `wireDecoderToFanout` :890; `unwireDecoderFromFanout` :948; `setSourceManager` :984; `enqueueSourceEvaluation` :1071; `drainCapsChanges` :1096; `handleCapsChange` :1117 (`restartDecoders` :1145, passive list :1159–1170, restart loop :1198); `stillWanted` :1270; `evaluateRate` :1283; `suspend` :1336; `resume` :1390 (wire at :1436); `detachBranch` :1485; `assessState` :1514; `emitStatusChanged` :1848.
  - `src/decoders/types.ts`: `DemodulationConfig` :94; `DecoderConfig` interface :170 (no `enabled` on `DecoderStatus` :250); `DecoderSuspensionStatus` :296; `getRateRequirements?` :407; `getRateAdapter?` :413.
  - `packages/api-types/src/decoders.ts`: `DecoderSuspension.reasonCode` is **required** and typed to the rate union (:154). `src/api/routes/decoder-status-schemas.ts` :48–51 marks `suspension.reasonCode` as a required enum.
  - `src/decoders/registry.ts` exports only `DecoderRegistry` (`register` :70, `create` :110) and the `DecoderFactory`/`DecoderFactoryMeta`/`VersionConstraints` types. There is **no** default-registry helper: built-ins are registered inline in `src/index.ts` :316–333 from the per-decoder factories `createDsdFmeDecoder` (`builtin/dsd-fme.ts` :1836), `createMultimonDecoder` (`builtin/multimon-ng.ts` :474), `createRtl433Decoder` (`builtin/rtl433.ts` :255), `createReadsbDecoder` (`builtin/readsb.ts` :720), `createAcarsdecDecoder` (`builtin/acarsdec.ts` :297), `createAisCatcherDecoder` (`builtin/ais-catcher.ts` :511), `createDumpvdl2Decoder` (`builtin/dumpvdl2.ts` :434), `createDirewolfDecoder` (`builtin/direwolf.ts` :1018) and `createLoraMeshtasticDecoder` (`builtin/lora-meshtastic.ts` :412).
- Also on `main`: `src/decoders/iq-decimate-decoder.ts` (`IqDecimationConfig` :37, `buildPipelineCommand` :201, stages :238–239); `src/decoders/audio-demod-decoder.ts` (`audioDemodRates` :62, `audioDemodRateAdapter` :80, pipeline stages :323–337); `src/decoders/builtin/dsd-fme.ts` (`buildPipelineCommand` :570, first stages :587–588); `src/decoders/base-decoder.ts` (`protected config` :77, `start` pipes `inputStream` into stdin :229, `attachInput` :307 with `stream.pipe(this.process.stdin)` :317 (default `end: true`), `updateOptions` :430); `src/decoders/process-tools.ts` (`signalDecoder` :15, `iqResampleCommand` :32); `src/core/fanout-manager.ts` (`BranchConfig.highWaterMark` :20, `addBranch` :155, drop mode :262–318, `getBranchTelemetry` :329, events `backpressure`/`drain`); `src/core/source-fanout-router.ts` (`getFanout` :56, `releaseUnused` :74); `src/core/source-manager.ts` (`SourceManagerEvents` :103–119, which lacks `removed`; `emit("removed")` :1217; recording source :428; `getCaps` :1386); `src/config.ts` (`SourceCapsSchema` :18, `DecoderConfigSchema` :87, `CsdrConfigSchema` :262, `ConfigSchema` :278, `loadConfig` reads `WAVEKIT_CONFIG` :712); `src/utils/errors.ts` re-exports `WaveKitError` from `@wavekit/shared`; `Dockerfile` (`final-base` :554, `/var/run/wavekit` :566, csdr copy :596–597, verify step :617–630); `docker/bake.hcl` (`final` :49, `final-core` :79, `final-sdrpp` :108, `final-demod` :125); `.dockerignore` (has no `native/` entry and excludes `*.md`); `scripts/capacity/{fake_rtl_tcp,run_capacity,sampler,summarize}.py` (`run_capacity.py` imports `from pathlib import Path` and defines no `REPO`); `tests/integration/decoder-runtime-smoke.test.ts` (env-gate pattern); `tests/unit/utils/pi-image.test.ts` (python-from-vitest pattern); `.gitignore:79-80` (`fixtures/raw/`, `fixtures/processed/`).
- `fixtures/manifest.yaml` is `version: 1`. It has duplicate `sigid_vdlm2` ids, `sample_rate: null` entries, no license/sha256/centre fields, and an audio-only VDL2 entry labelled for dumpvdl2. `fixtures/lora/meshtastic-sample.cu8` is a 12-byte placeholder; leave the file alone, because `tests/integration/lora-meshtastic.test.ts` gates on a `.real-fixture` marker. The host has `cargo`/`rustc` (`/usr/local/bin`) and `python3`. The root `package.json` license is `ISC`.

## Assumptions (spec gaps resolved here; each one is bounded to the tasks named)

- **A1 (D3 transport detail; deviation recorded in addendum § 14).** Addendum § 4 pipes IQ to the process stdin, while § 11 puts control requests on stdin. The two cannot share a stream. This plan keeps IQ on stdin, which matches the `input-eof` semantics. Control requests go on **fd 3** (`--control-fd 3`, a fourth `stdio` pipe), events stay on stdout, and logs go to stderr. Affects Tasks 15, 20, 22.
- **A2 (gap position).** `mark-gap` gains optional `atInputByte` and `droppedInputBytes`. Node computes `atInputByte` as `totalBytesWritten − droppedBytesTotal` from `getBranchTelemetry()` at the `backpressure` event. The process applies the reset at the first whole sample at or after that byte, so the reset lands at the true seam instead of wherever the control line happens to be read. Affects Tasks 15, 16, 21.
- **A3 (DTO; deviation recorded in addendum § 14).** After B3, `suspension.reasonCode` is a required rate-union enum in api-types and in the Fastify schema. So for channel reasons `getStatus()` emits `suspended: true` and **omits the whole `suspension` object**, rather than omitting only `reasonCode`. Internally `DecoderState.suspension.reasonCode` is the superset `CoreSuspensionReason`. Affects Task 24.
- **A4 (invalid declarations).** `getChannelRequest?()` returns `DecoderChannelRequest | { invalid: string } | undefined`. This lets acarsdec report "several frequencies, no `channelHz`" as `channel-request-invalid` with a detail string. Affects Tasks 16, 23, 31.
- **A5 (DSP structure, research [3]; the `rustfft` drop is recorded in addendum § 14).** The DSP chain is: shared CU8→f32 conversion; a per-channel NCO; a cascade of decimate-by-2 Kaiser FIR stages while the next rate stays ≥ 1.1 × out; then one rational L/M polyphase stage. If that stage's prototype would exceed 16 384 taps it is split into two rational stages (for example 2.048 Msps → 1.05 Msps becomes 21/32 then 25/32). The design target is 66 dB (margin over the 60 dB property). `rustfft` is **dropped** from the crate list (addendum §10): tone tests use correlation, and filter design uses a hand-written Kaiser window. The crate list is `serde` and `serde_json`, with `proptest` as a dev-dependency only. Affects Tasks 9–13.
- **A6 (cu8 mapping, research [2]).** Input is `u/127.5 − 1` (csdr `convert -i char -o float`). Output is `clamp(floor(127.5·gain·x + 128), 0, 255)` computed as csdr does (`(x·gain·255)·0.5 + 128` in f64), with a saturation count per complex sample. This equals the addendum's `round(127.5 + 127.5·gain·x)` except at exact .5 ties and gives an exact u8 round trip. Affects Task 10.
- **A7 (EOF flush).** "Flushes filter tails" means draining every channel's queue to its client before closing. No zero padding is synthesised, and the few samples the A12 schedule is still holding back are discarded, so Property 3's sample count holds at EOF too. A `queue-overflow` run that is still open is reported before `input-eof` (A13). Affects Task 15.
- **A8 (golden sets).** "Equal observed sets" (Property 15) compares sets of `expected.key_fields` tuples, not whole payloads, because timestamps and levels differ. Affects Tasks 1, 4, 5.
- **A9 (harness timing).** The harness pads each fixture with 5 s of lead and 3 s of tail of byte `0x7f`. The lead lets the collector subscribe before RF arrives; the tail flushes decoder-internal buffers. It runs the app via `docker exec` inside a container started with `--init --entrypoint sleep … infinity` (`--init` makes tini PID 1, so the backgrounded app is reaped and the pid-file cleanup's `kill -0` loop sees it exit), and the collector uses Node 22's global `WebSocket`. Each path's app instance is stopped by pid and waited for before the next path starts. Affects Task 5.
- **A10 (capacity placements; deviation recorded in addendum § 14).** Every placement must pass addendum § 6's own admission rule, `|Δf| + h ≤ fs·F/2` with `h = bw/2 + tr`. For the § 2 default passband, `h = out/2` at any `t`. Applied literally, § 9's spread formula `center + fs·F·((k + 0.5)/N − 0.5)` breaks that rule for wide channels. At N = 8, AIS (384 kHz, `h` = 192 kHz) lands at ±716.8 kHz at 2.048 Msps, which needs 908.8 kHz against 819.2 kHz, and at ±840 kHz at 2.4 Msps, which needs 1.032 MHz against 960 kHz. Both get `channel-outside-capture`, so those decoders are suspended and the gate silently runs fewer channels. So the plan applies the formula to the *admissible* centre range `±L`, where `L = ⌊fs·F/2 − h⌋`. **Spread:** channel k goes at `center + 2L·((k + 0.5)/N − 0.5)`. **Clustered:** channels are spaced `min(1.25 × out, ⌊2L/(N − 1)⌋)` apart, centred on the fixture signal, and the whole cluster is then shifted to fit inside `±L`. In both modes, the channel nearest the fixture signal is then replaced by exactly that centre. Offsets are truncated toward the capture centre, so whole-Hz rounding cannot cross the boundary. Channels may overlap, since they only add load. A fixture signal that is not itself admissible raises `ValueError`. A run in which any of the N instances is suspended or not running fails with exit 5 (Task 34) and counts as a gate failure (Task 36). Affects Tasks 34, 36.
- **A11 (filterCutoff).** No built-in sets `filterCutoff`. A channelised decoder with `filterCutoff` logs a warning and uses the default passband; the cutoff is not translated. The addendum's `t` stays relative to the **output** rate, which is not csdr's input-rate convention (research [2]). Fixture equality is at the decoded level, so this does not block migration. Affects Task 23.
- **A12 (one absolute output schedule, Property 3).** Each `RationalFir` stage emits output k as soon as input sample `⌊kM/L⌋` has arrived, so after n inputs a stage has emitted `⌈nL/M⌉` samples (pinned by a Task 12 test). Along a chain these ceilings add up: at 2.048 Msps → 48 kHz with N = 33, the five decimate-by-2 stages give 17, 9, 5, 3 and 2 samples and the 3/4 stage gives 2, against an ideal `⌊33·48000/2048000⌋ = 0`. A per-stage floor rule does not fix this on 6- and 7-stage chains either, and the planner is not the cause. So `ChannelDsp` owns **one schedule for the whole chain**. With `num/den = out/fs` reduced, the channel's cumulative output after N input samples is always exactly `⌊N·num/den⌋`: output k is released at the first input index where `k < ⌊N·num/den⌋`. The error is 0, inside the addendum's ±1. *The chain never starves the schedule:* by induction over the stages, if stage j gets `n_j ≥ N·Π_{i<j} r_i` inputs (`r_i = l_i/m_i`), it emits `⌈n_j·r_j⌉ ≥ N·Π_{i≤j} r_i`. So the chain has produced at least `N·num/den ≥ ⌊N·num/den⌋` samples. *The hold-back is small:* each ceiling adds less than one sample, and the stages after it scale that down (every `r_i < 1`), so the surplus is below the stage count. `ChannelDsp` therefore holds back at most `stages.len()` samples, at most 2 in a 20 000-case simulation over every rate pair in Task 13. Held samples keep their place in the stream: the schedule delays their release by a few output samples and leaves the group delay unchanged. `reset()` clears the counters and the held samples. Affects Tasks 12, 13, 15.
- **A13 (queue-overflow reporting, Property 8).** A drop run on a channel queue starts at the first dropped sample (`sampleIndex` is that sample's output index). It ends at the next push from which the queue accepts any sample, and the run's `discontinuity cause: queue-overflow` is emitted then, with `droppedSamples` equal to the run length. Within one push, accepted samples come before dropped ones. So a push that both accepts and drops first closes the previous run and then opens a new one. A run still open at `close`, `shutdown`, an input gap or EOF is emitted before that event. Every dropped sample is therefore reported exactly once, and `sampleIndex` stays monotonic per channel. Affects Tasks 15, 22.
- **A14 (process supervision gaps).** The addendum gives no restart policy for `wavekit-chan`. The plan uses: crash-loop backoff of 5 unexpected exits after `ready` within 60 s per source, after which requests get `channelizer-unavailable` without a spawn until the oldest exit leaves the window; an exit 0 after `input-eof` is not a crash; a request pending at invalidation is retried once like a superseded generation; a socket dir that cannot be created is `channelizer-unavailable`; decoders get a `PassThrough` fed with `end: false` so only detach/destroy ends their input. Affects Tasks 20, 21.
- **A15 (AIS channel centre).** AIS channels are requested at the A/B pair centre 162 000 000 Hz, not at channel A as the addendum § 8 example shows (recorded in addendum § 14). Affects Tasks 4, 15, 23, 28, 34, 36.

## Decision-dependent task groups (D1–D3 are working assumptions pending user confirmation)

| Decision | Tasks that change if flipped | Tasks unaffected |
|---|---|---|
| **D1 Rust `wavekit-chan`** | 9, 10, 11, 12, 13, 14, 15 (crate), 22 (binary under test), 26 (Docker stage), 36 (`--version` in meta) | All TS tasks keep the same protocol and interfaces |
| **D2 hybrid fixture sourcing** | 6 (public acquisition), 7 (own captures), and the `candidates:` list in 2 | 1, 3, 4, 5 (schema, download, harness) |
| **D3 per-channel Unix sockets + JSON-lines control** | 15 (runtime transport), 20 (process spawn and fd 3), 21 (socket connect, `mark-gap`), 22 | 16 (protocol schemas stay the request/event vocabulary), 23, 24 (consume `ChannelProvider` only) |

## File structure

| Path | Status | Responsibility |
|---|---|---|
| `fixtures/manifest.yaml` | rewrite | Manifest v2: verified `fixtures` plus `candidates` |
| `fixtures/manifest-query.mjs` | create | Read-only YAML→JSON accessor for bash/python (`list`, `get <id>`) |
| `fixtures/download.sh` | rewrite | Fetch, extract, transform and sha256-verify; private fetch from `WAVEKIT_PRIVATE_FIXTURES_DIR` |
| `fixtures/convert.sh` | modify | Add a deterministic `--wav-to-cu8 IN OUT` mode |
| `fixtures/README.md` | modify | v2 fields, privacy rule, harness invocation |
| `fixtures/GOLDENS.md` | create (Task 8) | Gate log: image id, git head, fixture sha, result per path |
| `tests/integration/fixtures/manifest.ts` | create | Zod v2 schema, `loadManifest`, `parseManifest` |
| `tests/integration/fixtures/harness.ts` | create | Pure helpers: config builder, padding, matching, key sets |
| `tests/integration/fixtures/collect-outputs.mjs` | create | In-container WebSocket collector |
| `tests/integration/iq-fixture-goldens.test.ts` | create | Env-gated golden harness |
| `tests/unit/fixtures/manifest-v2.test.ts` | create | Schema plus committed-manifest validation |
| `tests/unit/fixtures/download-script.test.ts` | create | `download.sh` behaviour with `file://` sources |
| `tests/unit/fixtures/fixture-harness.test.ts` | create | Harness helper unit tests |
| `native/wavekit-chan/{Cargo.toml,Cargo.lock,LICENSES.md}` | create | Crate (D1) |
| `native/wavekit-chan/src/{main,lib,args,convert,design,stages,plan,channel,admission,queue,protocol,runtime}.rs` | create | DSP and process runtime |
| `native/wavekit-chan/tests/dsp_properties.rs` | create | Properties 3–7 (proptest) |
| `src/core/channelizer/types.ts` | create | `DecoderChannelRequest`, reasons, `ChannelProvider` |
| `src/core/channelizer/protocol.ts` | create | Zod v1 request/event schemas, encode/parse |
| `src/core/channelizer/admission.ts` | create | Pure `admitChannel` |
| `src/core/channelizer/rate-plan.ts` | create | `channelisedRatePlan` |
| `src/core/channelizer/channelizer-process.ts` | create | Spawn/stop, fd 3 control, stdout events (D3) |
| `src/core/channelizer/channelizer-manager.ts` | create | One process per source, generations, invalidation, sockets |
| `src/config.ts` | modify | `ChannelizerConfigSchema`, `useChannelizer` |
| `config/default.yaml` | modify | Commented `channelizer:` block |
| `src/decoders/types.ts` | modify | `channelHz`, `getChannelRequest?`, `CoreSuspensionReason`, `useChannelizer?` |
| `src/decoders/iq-decimate-decoder.ts` | modify | `iqChannelRequest`, base `getChannelRequest`, `channelizerSupported()` |
| `src/decoders/audio-demod-decoder.ts` | modify | `audioChannelRequest`, cf32 tail, base `getChannelRequest` |
| `src/decoders/builtin/{dsd-fme,dumpvdl2,acarsdec,ais-catcher,rtl433,multimon-ng,direwolf}.ts` | modify | cf32 tail (dsd-fme), centre/bandwidth overrides, migration flags |
| `src/decoders/manager.ts` | modify (internal only) | Channel wiring, holding for a channel, invalidation, status mapping |
| `src/index.ts` | modify | Construct and destroy `ChannelizerManager` when enabled |
| `tests/mocks/fake-wavekit-chan.ts` | create | Fake protocol binary body (for `writeExecutable`) |
| `tests/mocks/channel-fakes.ts` | create | `FakeChannelProvider` |
| `tests/unit/core/channelizer-{protocol,admission,process,manager}.test.ts` | create | Node-side units |
| `tests/unit/decoders/{channel-requests,manager-channelizer}.test.ts` | create | Decoder and manager integration |
| `tests/unit/utils/channelizer-config.test.ts` | create | Config schema and env override |
| `tests/integration/wavekit-chan-binary.test.ts` | create | Env-gated real-binary tests (Properties 1, 8, 12, 13, 14) |
| `Dockerfile`, `docker/bake.hcl` | modify | `chan-build` stage, copy, verify, cache chain (D1) |
| `tests/unit/docker/chan-build-stage.test.ts` | create | Cache-chain and verify-step assertions |
| `Makefile`, `.gitignore`, `.dockerignore` | modify | `chan-build`, `chan-test`; ignore `native/wavekit-chan/target/` in git and in the Docker build context |
| `scripts/capacity/{fake_rtl_tcp,run_capacity,summarize}.py` | modify | File replay, channel matrix, channelizer reporting |
| `tests/unit/capacity/{test_capacity_channelizer.py,capacity-scripts.test.ts}` | create | Python unit tests plus vitest wrapper |
| `docs/CAPACITY-<run-date>-CHANNELIZER.md` | create (Task 36) | Capacity gate results |

## Task index (Kiro-style checklist)

**Batch 3: fixture baselines (first; no gate)**
- [x] 1. Manifest v2 schema and loader. _Requirements: §8_
- [x] 2. Repair `fixtures/manifest.yaml` to v2 and add `manifest-query.mjs`. _Requirements: §8 (D2: candidates list)_
- [x] 3. `download.sh` v2 with sha256 and private fetch; `convert.sh --wav-to-cu8`. _Requirements: §8, D2_
- [x] 4. Harness pure helpers. _Requirements: §8; Property 15_
- [x] 5. Collector and env-gated golden harness. _Requirements: §8; Property 15_
- [x] 6. **[D2]** Acquire and verify public fixtures. _Requirements: §8 acquisition_
- [x] 7. **[D2]** Own private captures. _Requirements: §8 acquisition_
- [x] 8. **CHECKPOINT: batch 3 gate** (quiet host): every fixture passes on the raw path.

**Batch 4A: standalone process and pure Node pieces (no gate; parallel with batch 3)**
- [x] 9. **[D1]** Crate scaffold, args, `--version`, Makefile targets. _Requirements: §10, §11 spawn line_
- [x] 10. **[D1]** CU8/f32 conversion and the input assembler. _Property 7, Property 4 (byte splits)_
- [x] 11. **[D1]** Kaiser FIR design. _Property 6 (design level)_
- [x] 12. **[D1]** NCO and rational polyphase stage. _Properties 4, 5_
- [x] 13. **[D1]** Chain planner and per-channel DSP. _Properties 3, 4, 5, 6, 7; plan A12_
- [x] 14. **[D1]** Rust admission and bounded queue. _Properties 2, 8; Review Focus 1_
- [x] 15. **[D1][D3]** Protocol and process runtime. _Properties 8, 12, 13, 14; §11; plan A12, A13; Review Focus 7_
- [x] 16. Node `types.ts`, `protocol.ts`, `admission.ts`, `rate-plan.ts`. _Properties 2, 14; §2, §5, §11; Review Focus 1_
- [x] 17. **CHECKPOINT 4A.**

**Batch 4B: integration (after the Task 18 re-check)**
- [x] 18. **RE-CHECK:** rate-model symbols present on `main`; fresh worktree from `main`; coordination request drafted. _Requirements: rate-model §6_
- [x] 19. Channelizer config and `useChannelizer`. _Requirements: §6, §7_
- [x] 20. **[D3]** `ChannelizerProcess` and the fake binary. _Requirements: §4, §11_
- [x] 21. **[D3]** `ChannelizerManager`. _Properties 9, 10, 12; §4, §6; Review Focus 2, 3, 5, 6_
- [x] 22. **[D1][D3]** Env-gated real-binary tests. _Properties 1, 8, 12, 13, 14; Review Focus 7_
- [x] 23. Decoder-side requests and the cf32 tail (no behaviour change). _Requirements: §1, §2, §3_
- [x] 24. `DecoderManager` channel integration. _Property 11; §4, §5; Review Focus 3, 4, 5_
- [x] 25. `index.ts` wiring and docs. _Requirements: §4, §6_
- [x] 26. **[D1]** Docker `chan-build` stage and bake cache chain. _Requirements: §10_
- [x] 27. **CHECKPOINT 4B.**

**Batch 4C: migrations (each gated by Property 15)**
- [x] 28. ais-catcher. _§7 step 1; Property 15_
- [x] 29. dumpvdl2. _§1, §7 step 2; Property 15_
- [x] 30. rtl_433. _§7 step 3; Property 15_
- [x] 31. Audio family (direwolf, multimon-ng, dsd-fme, acarsdec). _§3, §7 step 4; Property 15_
- [x] 32. **CHECKPOINT: batch 4 complete.**

**Batch 5: capacity gate**
- [x] 33. `fake_rtl_tcp.py --file/--loop/--pacing`. _§9_
- [x] 34. `run_capacity.py` channel matrix, admissible placements, decoder-running check, meta. _§9, §6; plan A10_
- [x] 35. `summarize.py` channelizer reporting; sampler label check. _§9_
- [x] 36. **[quiet host]** Capacity gate run and results doc. _§9 gate; plan A10_
- [x] 37. **CHECKPOINT: final.**

---

# Batch 3: Fixture baselines

Work in a worktree from current `main` (at plan time `f49273c`, which already contains the rate model). Batch 3 touches only `fixtures/` and `tests/`.

### Task 1: Manifest v2 schema and loader

**Files:**
- Create: `tests/integration/fixtures/manifest.ts`
- Test: `tests/unit/fixtures/manifest-v2.test.ts`

**Interfaces:**
- Produces: `FixtureSchema`, `ManifestSchema`, `type Fixture`, `type Manifest`, `parseManifest(text: string): Manifest`, `loadManifest(path?: string): Manifest`, `CONTAINER_SAFE_ID = /^[a-z0-9][a-z0-9_]*$/`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/fixtures/manifest-v2.test.ts
import { parseManifest } from "../../integration/fixtures/manifest.js"

const sha = "a".repeat(64)
function golden(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "own_ais_162m_2048k",
		role: "channelizer-golden",
		decoder: "ais-catcher",
		license: "private",
		provenance: { notes: "own capture" },
		fetch: { kind: "private" },
		file: "raw/own_ais_162m_2048k.cu8",
		sha256: sha,
		format: "cu8",
		sample_rate: 2_048_000,
		center_hz: 162_000_000,
		duration_s: 20.5,
		expected: { min_count: 3, payloads: [{ mmsi: "211234560" }], key_fields: ["mmsi"] },
		...overrides,
	}
}
function manifest(fixtures: unknown[], candidates: unknown[] = []): string {
	return JSON.stringify({ version: 2, fixtures, candidates }) // JSON is valid YAML
}

describe("fixture manifest v2", () => {
	it("accepts a well-formed channelizer golden", () => {
		const m = parseManifest(manifest([golden()]))
		expect(m.fixtures[0]?.playback_speed).toBe(1)
		expect(m.fixtures[0]?.large).toBe(false)
	})
	it("rejects duplicate ids across fixtures and candidates", () => {
		const candidate = { id: "own_ais_162m_2048k", decoder: "x", url: null, license: null, blockers: ["dup"] }
		expect(() => parseManifest(manifest([golden()], [candidate]))).toThrow(/duplicate id/)
	})
	it("rejects null sample rates and bad sha256", () => {
		expect(() => parseManifest(manifest([golden({ sample_rate: null })]))).toThrow()
		expect(() => parseManifest(manifest([golden({ sha256: "ABC" })]))).toThrow()
	})
	it("requires a channelizer golden to be cu8 >= 2.048 Msps with a centre and key fields", () => {
		expect(() => parseManifest(manifest([golden({ sample_rate: 1_024_000 })]))).toThrow(/channelizer golden/)
		expect(() => parseManifest(manifest([golden({ center_hz: undefined })]))).toThrow(/channelizer golden/)
		expect(() =>
			parseManifest(manifest([golden({ expected: { min_count: 1, payloads: [] } })])),
		).toThrow(/key_fields/)
	})
	it("ties the private license to private fetch", () => {
		expect(() => parseManifest(manifest([golden({ license: "CC-BY-4.0" })]))).toThrow(/private/)
	})
	it("requires negative fixtures to expect zero decodes", () => {
		expect(() =>
			parseManifest(manifest([golden({ role: "negative", expected: { min_count: 1, payloads: [] } })])),
		).toThrow(/negative/)
	})
	it("validates the committed manifest", async () => {
		const { loadManifest } = await import("../../integration/fixtures/manifest.js")
		expect(() => loadManifest("fixtures/manifest.yaml")).not.toThrow()
	})
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run tests/unit/fixtures/manifest-v2.test.ts`
Expected: FAIL, `Cannot find module '../../integration/fixtures/manifest.js'`.

- [ ] **Step 3: Implement**

```ts
// tests/integration/fixtures/manifest.ts
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { z } from "zod"

export const CONTAINER_SAFE_ID = /^[a-z0-9][a-z0-9_]*$/
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex")
const FixtureId = z.string().regex(CONTAINER_SAFE_ID)

export const FixtureRoleSchema = z.enum([
	"channelizer-golden",
	"tail-golden",
	"parser-transcript",
	"negative",
])
export const FixtureFormatSchema = z.enum(["cu8", "cs16", "cf32", "wav"])

const FetchSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("public"),
			url: z.string().url(),
			archive_sha256: Sha256,
			member: z.string().min(1).optional(),
			transform: z.enum(["none", "wav-to-cu8"]).default("none"),
		})
		.strict(),
	z.object({ kind: z.literal("private") }).strict(),
])

const ExpectedSchema = z
	.object({
		min_count: z.number().int().nonnegative(),
		payloads: z.array(z.record(z.unknown())).default([]),
		key_fields: z.array(z.string().min(1)).min(1).optional(),
		output_types: z.array(z.string().min(1)).min(1).optional(),
		suspension: z.literal("channel-outside-capture").optional(),
	})
	.strict()

export const FixtureSchema = z
	.object({
		id: FixtureId,
		role: FixtureRoleSchema,
		decoder: z.string().min(1),
		decoder_options: z.record(z.unknown()).default({}),
		license: z.string().min(1),
		provenance: z.object({ url: z.string().url().optional(), notes: z.string().min(1) }).strict(),
		fetch: FetchSchema,
		file: z.string().regex(/^raw\/[A-Za-z0-9._-]+$/),
		sha256: Sha256,
		format: FixtureFormatSchema,
		sample_rate: z.number().int().positive(),
		center_hz: z.number().positive().optional(),
		duration_s: z.number().positive(),
		playback_speed: z.number().positive().max(4).default(1),
		large: z.boolean().default(false),
		expected: ExpectedSchema,
		channel: z.object({ center_hz: z.number().positive() }).strict().optional(),
	})
	.strict()
	.superRefine((f, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${f.id}: ${message}` })
		if (f.role === "channelizer-golden") {
			if (f.format !== "cu8" || f.sample_rate < 2_048_000 || f.center_hz === undefined)
				issue("a channelizer golden needs cu8 at >= 2048000 Hz with center_hz")
			if (!f.expected.key_fields) issue("a channelizer golden needs expected.key_fields")
			if (f.expected.min_count < 1) issue("a channelizer golden needs min_count >= 1")
		}
		if (f.role === "negative" && f.expected.min_count !== 0) issue("negative fixtures expect min_count 0")
		if (f.expected.suspension && f.role !== "negative") issue("expected.suspension is for negative fixtures")
		if ((f.license === "private") !== (f.fetch.kind === "private"))
			issue("license 'private' iff fetch.kind 'private'")
	})

export const CandidateSchema = z
	.object({
		id: FixtureId,
		decoder: z.string().min(1),
		url: z.string().url().nullable(),
		license: z.string().min(1).nullable(),
		blockers: z.array(z.string().min(1)).min(1),
		notes: z.string().optional(),
	})
	.strict()

export const ManifestSchema = z
	.object({
		version: z.literal(2),
		fixtures: z.array(FixtureSchema),
		candidates: z.array(CandidateSchema).default([]),
	})
	.strict()
	.superRefine((m, ctx) => {
		const seen = new Set<string>()
		for (const id of [...m.fixtures.map(f => f.id), ...m.candidates.map(c => c.id)]) {
			if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${id}` })
			seen.add(id)
		}
	})

export type Fixture = z.infer<typeof FixtureSchema>
export type Manifest = z.infer<typeof ManifestSchema>

export function parseManifest(text: string): Manifest {
	return ManifestSchema.parse(parse(text))
}

export function loadManifest(path = "fixtures/manifest.yaml"): Manifest {
	return parseManifest(readFileSync(path, "utf8"))
}
```

- [ ] **Step 4: Run it and confirm the schema cases pass**

Run: `pnpm exec vitest run tests/unit/fixtures/manifest-v2.test.ts`
Expected: every case passes except "validates the committed manifest", which still fails (`version` is 1). Task 2 fixes that case.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/fixtures/manifest.ts tests/unit/fixtures/manifest-v2.test.ts
git commit -m "test(fixtures): manifest v2 schema (core channelizer batch 3, addendum §8)"
```

### Task 2: Repair `fixtures/manifest.yaml` to v2 and add `manifest-query.mjs`

**Files:**
- Rewrite: `fixtures/manifest.yaml`
- Create: `fixtures/manifest-query.mjs`
- Modify: `fixtures/README.md`
- Test: `tests/unit/fixtures/manifest-v2.test.ts` (committed-manifest case), `tests/unit/fixtures/download-script.test.ts` (query cases)

**Interfaces:**
- Produces: `node fixtures/manifest-query.mjs list` prints one line per fixture, `id|kind|url|member|transform|file|sha256|archive_sha256|large` (empty fields allowed). `node fixtures/manifest-query.mjs get <id>` prints the fixture JSON. Both honour `WAVEKIT_FIXTURES_MANIFEST`.

- [ ] **Step 1: Write the failing query test**

```ts
// tests/unit/fixtures/download-script.test.ts (first part; Task 3 appends)
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export function tempManifest(fixtures: unknown[]): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "wk-fixtures-"))
	const path = join(dir, "manifest.yaml")
	writeFileSync(path, JSON.stringify({ version: 2, fixtures, candidates: [] }))
	return { dir, path }
}

describe("manifest-query.mjs", () => {
	it("lists fixtures with pipe-separated fetch fields", () => {
		const { path } = tempManifest([
			{ id: "a_fix", fetch: { kind: "private" }, file: "raw/a.cu8", sha256: "b".repeat(64) },
		])
		const r = spawnSync("node", [resolve("fixtures/manifest-query.mjs"), "list"], {
			encoding: "utf8",
			env: { ...process.env, WAVEKIT_FIXTURES_MANIFEST: path },
		})
		expect(r.status, r.stderr).toBe(0)
		expect(r.stdout.trim()).toBe(`a_fix|private|||none|raw/a.cu8|${"b".repeat(64)}||false`)
	})
	it("rejects a v1 manifest", () => {
		const { dir } = tempManifest([])
		const path = join(dir, "v1.yaml")
		writeFileSync(path, "version: 1\nfixtures: []\n")
		const r = spawnSync("node", [resolve("fixtures/manifest-query.mjs"), "list"], {
			encoding: "utf8",
			env: { ...process.env, WAVEKIT_FIXTURES_MANIFEST: path },
		})
		expect(r.status).not.toBe(0)
		expect(r.stderr).toMatch(/version 2/)
	})
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run tests/unit/fixtures/download-script.test.ts`
Expected: FAIL (non-zero status, the module is not found).

- [ ] **Step 3: Implement `fixtures/manifest-query.mjs`**

```js
#!/usr/bin/env node
// Read-only accessor so bash/python read the same v2 fields that
// tests/integration/fixtures/manifest.ts validates (Zod lives there).
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const here = dirname(fileURLToPath(import.meta.url))
const path = process.env.WAVEKIT_FIXTURES_MANIFEST ?? join(here, "manifest.yaml")
const doc = parse(readFileSync(path, "utf8"))
if (!doc || doc.version !== 2 || !Array.isArray(doc.fixtures)) {
	process.stderr.write(`${path}: expected a version 2 manifest\n`)
	process.exit(2)
}
const [command, id] = process.argv.slice(2)
if (command === "list") {
	for (const f of doc.fixtures) {
		const fetch = f.fetch ?? {}
		process.stdout.write(
			[
				f.id,
				fetch.kind ?? "",
				fetch.url ?? "",
				fetch.member ?? "",
				fetch.transform ?? "none",
				f.file ?? "",
				f.sha256 ?? "",
				fetch.archive_sha256 ?? "",
				String(f.large === true),
			].join("|") + "\n",
		)
	}
} else if (command === "get" && id) {
	const f = doc.fixtures.find(x => x.id === id)
	if (!f) {
		process.stderr.write(`unknown fixture ${id}\n`)
		process.exit(3)
	}
	process.stdout.write(JSON.stringify(f) + "\n")
} else {
	process.stderr.write("usage: manifest-query.mjs list | get <id>\n")
	process.exit(2)
}
```

- [ ] **Step 4: Rewrite `fixtures/manifest.yaml` as v2**

Every v1 entry moves to `candidates:` with explicit blockers, including v1's `direwolf_generated` (`gen_packets`), the only deterministic APRS source. Tasks 6–7 promote entries to `fixtures:` once each is verified. Write exactly this:

```yaml
# WaveKit test fixtures, manifest v2 (addendum §8).
# Schema: tests/integration/fixtures/manifest.ts. Accessor: fixtures/manifest-query.mjs.
# `fixtures` are verified (sha256, rate, centre, license, expected decodes).
# `candidates` are known sources that are not verified yet; nothing reads them automatically.
# Private own captures: license "private", fetch.kind "private", never committed.
version: 2

fixtures: []

candidates:
  - id: sigid_pocsag
    decoder: multimon-ng
    url: https://www.sigidwiki.com/images/6/65/POCSAG_IQ.zip
    license: null
    blockers: ["license unverified", "sample rate and centre not verified from file metadata"]
  - id: sigid_flex
    decoder: multimon-ng
    url: https://www.sigidwiki.com/images/e/ec/FLEX_Pager_IQ_20150816_929613kHz_IQ.zip
    license: null
    blockers: ["license unverified", "sample rate unverified (centre 929613000 from filename)"]
  - id: sigid_vdlm2_iq
    decoder: dumpvdl2
    url: https://www.sigidwiki.com/images/d/df/VDL-M2_IQ.zip
    license: null
    blockers: ["v1 listed this archive twice (as IQ and as 48 kHz audio); contents must be inspected", "license unverified"]
  - id: sigid_acars
    decoder: acarsdec
    url: https://www.sigidwiki.com/images/0/00/ACARS_IQ.zip
    license: null
    blockers: ["135498 Hz f32 narrowband: tail-golden at most", "license unverified"]
  - id: sdrangel_dsd
    decoder: dsd-fme
    url: https://www.sdrangel.org/iq/dsd.zip
    license: null
    blockers: ["75 kHz s16: tail-golden at most", "license unverified"]
  - id: sdrplay_ais
    decoder: ais-catcher
    url: https://sdrplay.com/resources/IQ/AIS.zip
    license: null
    blockers: ["WAV rate/centre unverified", "license unverified"]
  - id: sdrangel_adsb
    decoder: readsb
    url: https://www.sdrangel.org/iq/adsb.zip
    license: null
    blockers: ["460 MB: readsb raw baseline only (large: true)", "license unverified"]
  - id: sdrplay_acars
    decoder: acarsdec
    url: https://sdrplay.com/resources/IQ/acars.zip
    license: null
    blockers: ["539 MB WAV; rate estimated", "license unverified"]
  - id: rtl433_tests_repo
    decoder: rtl433
    url: https://github.com/merbanan/rtl_433_tests
    license: null
    blockers: ["per-sample selection needed; tail-golden (narrow rates, no capture)"]
  - id: lora_meshtastic_placeholder
    decoder: lora-meshtastic
    url: null
    license: null
    blockers: ["fixtures/lora/meshtastic-sample.cu8 is a 12-byte placeholder", "LoRa is excluded from channelizer migration"]
  - id: direwolf_generated
    decoder: direwolf
    url: null
    license: null
    blockers: ["generated locally with direwolf's gen_packets as audio WAV, not IQ: parser-transcript or tail-golden at most", "generator command line and packet list not recorded yet"]
    notes: "Kept from v1 (format: generated, generator: gen_packets). The only deterministic APRS source; no download needed."
```

- [ ] **Step 5: Update `fixtures/README.md`**

Replace the "Adding Fixtures" section with:

```markdown
## Manifest v2

`manifest.yaml` is validated by `tests/integration/fixtures/manifest.ts`
(`pnpm exec vitest run tests/unit/fixtures/manifest-v2.test.ts`). Each fixture
records `id`, `role` (`channelizer-golden` | `tail-golden` | `parser-transcript` |
`negative`), `decoder`, `license`, `provenance`, `fetch`, `file` (under `raw/`),
`sha256` of that file, `format`, `sample_rate`, `center_hz`, `duration_s` and
`expected` decodes (`min_count`, `payloads`, `key_fields`). Unverified sources stay
in `candidates` with `blockers`.

Privacy: own captures contain real identifiers (pager, ACARS, AIS, DMR, VDL2).
They use `license: private` and `fetch.kind: private`, are trimmed to the
shortest window holding the expected decodes, and are never committed.
`download.sh` copies them from `WAVEKIT_PRIVATE_FIXTURES_DIR` (a path or an
https base URL) and verifies sha256.

Goldens: `tests/integration/iq-fixture-goldens.test.ts` (env-gated; see its header).
`test-decoders.sh` stays a manual tool and is not a gate.
```

- [ ] **Step 6: Run both tests and confirm they pass**

Run: `pnpm exec vitest run tests/unit/fixtures/manifest-v2.test.ts tests/unit/fixtures/download-script.test.ts`
Expected: PASS, including "validates the committed manifest".

- [ ] **Step 7: Commit**

```bash
git add fixtures/manifest.yaml fixtures/manifest-query.mjs fixtures/README.md tests/unit/fixtures/download-script.test.ts
git commit -m "fix(fixtures): replace broken v1 manifest with v2 candidates (addendum §8)"
```

### Task 3: `download.sh` v2 with sha256 and private fetch; `convert.sh --wav-to-cu8`

**Files:**
- Rewrite: `fixtures/download.sh`
- Modify: `fixtures/convert.sh` (new mode at the top of `main`)
- Test: `tests/unit/fixtures/download-script.test.ts` (append)

**Interfaces:**
- Consumes: `manifest-query.mjs list` (Task 2).
- Produces: `fixtures/download.sh [--all] [--rtl433] [id...]` writes `${WAVEKIT_FIXTURES_DIR:-fixtures}/<file>` only when the sha256 matches. It exits 1 if any selected public fixture fails. A private fixture with no `WAVEKIT_PRIVATE_FIXTURES_DIR` is skipped with a warning and does not fail. Without `--all`, `large: true` fixtures are skipped. `--all` never touches the network beyond the manifest's own URLs: only the separate `--rtl433` flag clones `rtl_433_tests`, and a failed clone or pull (for example offline) is counted as a failure, so the script exits 1, never git's 128.

- [ ] **Step 1: Append the failing tests**

```ts
// append to tests/unit/fixtures/download-script.test.ts
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"

function sha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}
function runDownload(manifest: string, outDir: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
	return spawnSync("bash", [resolve("fixtures/download.sh"), ...args], {
		encoding: "utf8",
		timeout: 30000,
		env: { ...process.env, WAVEKIT_FIXTURES_MANIFEST: manifest, WAVEKIT_FIXTURES_DIR: outDir, ...extraEnv },
	})
}

describe("download.sh v2", () => {
	it("fetches a public raw file and verifies both hashes", () => {
		const src = mkdtempSync(join(tmpdir(), "wk-src-"))
		const raw = join(src, "tone.cu8")
		writeFileSync(raw, Buffer.from([127, 128, 129, 130]))
		const digest = sha(raw)
		const { path, dir } = tempManifest([
			{ id: "tone", fetch: { kind: "public", url: `file://${raw}`, archive_sha256: digest }, file: "raw/tone.cu8", sha256: digest },
		])
		const r = runDownload(path, dir)
		expect(r.status, r.stdout + r.stderr).toBe(0)
		expect(sha(join(dir, "raw/tone.cu8"))).toBe(digest)
	})
	it("refuses a file whose sha256 does not match and leaves no target", () => {
		const src = mkdtempSync(join(tmpdir(), "wk-src-"))
		const raw = join(src, "tone.cu8")
		writeFileSync(raw, Buffer.from([1, 2]))
		const { path, dir } = tempManifest([
			{ id: "tone", fetch: { kind: "public", url: `file://${raw}`, archive_sha256: sha(raw) }, file: "raw/tone.cu8", sha256: "0".repeat(64) },
		])
		const r = runDownload(path, dir)
		expect(r.status).toBe(1)
		expect(r.stdout + r.stderr).toMatch(/sha256 mismatch/)
		expect(existsSync(join(dir, "raw/tone.cu8"))).toBe(false)
	})
	it("copies private fixtures from WAVEKIT_PRIVATE_FIXTURES_DIR and skips without it", () => {
		const priv = mkdtempSync(join(tmpdir(), "wk-priv-"))
		writeFileSync(join(priv, "own.cu8"), Buffer.from([10, 20]))
		const digest = sha(join(priv, "own.cu8"))
		const { path, dir } = tempManifest([
			{ id: "own", fetch: { kind: "private" }, file: "raw/own.cu8", sha256: digest },
		])
		const skipped = runDownload(path, dir)
		expect(skipped.status).toBe(0)
		expect(skipped.stdout + skipped.stderr).toMatch(/WAVEKIT_PRIVATE_FIXTURES_DIR/)
		const fetched = runDownload(path, dir, { WAVEKIT_PRIVATE_FIXTURES_DIR: priv })
		expect(fetched.status, fetched.stderr).toBe(0)
		expect(sha(join(dir, "raw/own.cu8"))).toBe(digest)
	})
	it("skips large fixtures unless --all", () => {
		const { path, dir } = tempManifest([
			{ id: "big", fetch: { kind: "public", url: "file:///nonexistent", archive_sha256: "1".repeat(64) }, file: "raw/big.cu8", sha256: "1".repeat(64), large: true },
		])
		mkdirSync(join(dir, "raw"), { recursive: true })
		expect(runDownload(path, dir).status).toBe(0)
		expect(runDownload(path, dir, {}, ["--all"]).status).toBe(1)
		// --all must not imply --rtl433: no git clone in unit tests
		expect(existsSync(join(dir, "raw/rtl_433_tests"))).toBe(false)
	})
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run tests/unit/fixtures/download-script.test.ts`
Expected: the `download.sh v2` cases fail (the old awk parser ignores the env and the manifest shape).

- [ ] **Step 3: Rewrite `fixtures/download.sh`**

```bash
#!/usr/bin/env bash
# Download + verify fixtures from manifest v2 (addendum §8).
# Usage: ./fixtures/download.sh [--all] [--rtl433] [fixture_id...]
#   default: every non-large fixture; --all includes large ones.
#   --rtl433 (separate on purpose) also clones/pulls merbanan/rtl_433_tests; a failure exits 1.
# Env: WAVEKIT_FIXTURES_MANIFEST (default fixtures/manifest.yaml)
#      WAVEKIT_FIXTURES_DIR      (default fixtures/; files land at <dir>/<file>)
#      WAVEKIT_PRIVATE_FIXTURES_DIR  path or https:// base for private captures
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export WAVEKIT_FIXTURES_MANIFEST="${WAVEKIT_FIXTURES_MANIFEST:-${SCRIPT_DIR}/manifest.yaml}"
OUT_DIR="${WAVEKIT_FIXTURES_DIR:-${SCRIPT_DIR}}"
CACHE_DIR="${OUT_DIR}/raw/.archives"

log_info() { echo "info: $1"; }
log_warn() { echo "warn: $1" >&2; }
log_error() { echo "error: $1" >&2; }

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
	else shasum -a 256 "$1" | awk '{print $1}'; fi
}

fetch_url() { # url dest
	curl -fsSL --retry 2 -o "$2.part" "$1" && mv "$2.part" "$2"
}

# Returns 0 ok, 1 failed, 2 skipped.
fetch_fixture() {
	local id="$1" kind="$2" url="$3" member="$4" transform="$5" file="$6" sha="$7" archive_sha="$8"
	local target="${OUT_DIR}/${file}"
	mkdir -p "$(dirname "$target")" "$CACHE_DIR"
	if [[ -f "$target" && "$(sha256_of "$target")" == "$sha" ]]; then
		log_info "$id: present and verified"; return 0
	fi
	rm -f "$target.part"
	case "$kind" in
	public)
		local archive="${CACHE_DIR}/${id}.download"
		if [[ ! -f "$archive" || "$(sha256_of "$archive")" != "$archive_sha" ]]; then
			log_info "$id: downloading $url"
			fetch_url "$url" "$archive" || { log_error "$id: download failed"; return 1; }
		fi
		if [[ "$(sha256_of "$archive")" != "$archive_sha" ]]; then
			log_error "$id: archive sha256 mismatch"; return 1
		fi
		if [[ -n "$member" ]]; then unzip -p "$archive" "$member" > "$target.part"
		else cp "$archive" "$target.part"; fi
		if [[ "$transform" == "wav-to-cu8" ]]; then
			"${SCRIPT_DIR}/convert.sh" --wav-to-cu8 "$target.part" "$target.part.cu8"
			mv "$target.part.cu8" "$target.part"
		fi
		;;
	private)
		local base="${WAVEKIT_PRIVATE_FIXTURES_DIR:-}"
		if [[ -z "$base" ]]; then
			log_warn "$id: private fixture skipped (set WAVEKIT_PRIVATE_FIXTURES_DIR)"; return 2
		fi
		local name; name="$(basename "$file")"
		if [[ "$base" =~ ^https:// ]]; then fetch_url "$base/$name" "$target.part" || { log_error "$id: private download failed"; return 1; }
		else cp "$base/$name" "$target.part" || { log_error "$id: $base/$name not readable"; return 1; }; fi
		;;
	*) log_error "$id: unknown fetch kind '$kind'"; return 1 ;;
	esac
	local actual; actual="$(sha256_of "$target.part")"
	if [[ "$actual" != "$sha" ]]; then
		log_error "$id: sha256 mismatch (expected $sha, got $actual)"; rm -f "$target.part"; return 1
	fi
	mv "$target.part" "$target"
	log_info "$id: verified ${file}"
}

clone_rtl433_tests() { # returns 0 ok, 1 failed (never git's own exit code)
	local repo_dir="${OUT_DIR}/raw/rtl_433_tests"
	if [[ -d "$repo_dir/.git" ]]; then
		git -C "$repo_dir" pull --quiet || { log_error "rtl_433_tests: pull failed (offline?)"; return 1; }
	else
		git clone --depth 1 https://github.com/merbanan/rtl_433_tests.git "$repo_dir" || { log_error "rtl_433_tests: clone failed (offline?)"; return 1; }
	fi
}

main() {
	command -v curl >/dev/null || { log_error "curl missing"; exit 1; }
	command -v node >/dev/null || { log_error "node missing"; exit 1; }
	local all=false rtl433=false ids=()
	for arg in "$@"; do
		case "$arg" in
		--all) all=true ;;
		--rtl433) rtl433=true ;;
		*) ids+=("$arg") ;;
		esac
	done
	local failed=0
	while IFS='|' read -r id kind url member transform file sha archive_sha large; do
		[[ -z "$id" ]] && continue
		if [[ ${#ids[@]} -gt 0 ]]; then
			local wanted=false; for w in "${ids[@]}"; do [[ "$w" == "$id" ]] && wanted=true; done
			$wanted || continue
		elif [[ "$large" == "true" && "$all" != true ]]; then
			log_info "$id: large, skipped (use --all)"; continue
		fi
		set +e; fetch_fixture "$id" "$kind" "$url" "$member" "$transform" "$file" "$sha" "$archive_sha"; local rc=$?; set -e
		[[ $rc -eq 1 ]] && failed=$((failed + 1))
	done < <(node "${SCRIPT_DIR}/manifest-query.mjs" list)
	if [[ "$rtl433" == true ]]; then
		set +e; clone_rtl433_tests; local clone_rc=$?; set -e
		[[ $clone_rc -ne 0 ]] && failed=$((failed + 1))
	fi
	[[ $failed -gt 0 ]] && { log_error "$failed fixture(s) failed"; exit 1; }
	exit 0
}

main "$@"
```

- [ ] **Step 4: Add `--wav-to-cu8` to `fixtures/convert.sh`**

Insert as the first statement inside `main()` (before `check_deps`):

```bash
	if [[ "${1:-}" == "--wav-to-cu8" ]]; then
		# Deterministic: no dither (-D), repeatable (-R); signed → offset-binary u8.
		# -t wav: download.sh passes "$target.part", which has no .wav extension for sox to infer the type from.
		sox -D -R -t wav "$2" -t raw -e unsigned-integer -b 8 "$3"
		return 0
	fi
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `pnpm exec vitest run tests/unit/fixtures/download-script.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fixtures/download.sh fixtures/convert.sh tests/unit/fixtures/download-script.test.ts
git commit -m "feat(fixtures): sha256-verified v2 download with private fetch (addendum §8)"
```

### Task 4: Harness pure helpers

**Files:**
- Create: `tests/integration/fixtures/harness.ts`
- Test: `tests/unit/fixtures/fixture-harness.test.ts`

**Interfaces:**
- Consumes: `Fixture` (Task 1).
- Produces:
  - `type FixturePath = "raw" | "channelizer"`
  - `LEAD_SECONDS = 5`, `TAIL_SECONDS = 3`, `CONTAINER_FIXTURES_DIR = "/fixtures"`
  - `goldenDecoderId(f: Fixture): string`
  - `buildFixtureConfig(input: { fixture: Fixture; path: FixturePath; apiPort: number; paddedPath: string }): string`
  - `padCommand(f: Fixture, sourcePath: string, paddedPath: string): string`
  - `runSeconds(f: Fixture): number`
  - `interface ObservedOutput { type: string; data: Record<string, unknown> }`
  - `isSubset(expected: unknown, actual: unknown): boolean`
  - `matchExpected(f: Fixture, observed: ObservedOutput[]): { ok: boolean; count: number; missing: Record<string, unknown>[] }`
  - `keySet(f: Fixture, observed: ObservedOutput[]): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/fixtures/fixture-harness.test.ts
import { parse } from "yaml"
import { FixtureSchema } from "../../integration/fixtures/manifest.js"
import {
	buildFixtureConfig,
	isSubset,
	keySet,
	matchExpected,
	padCommand,
	runSeconds,
} from "../../integration/fixtures/harness.js"

const fixture = FixtureSchema.parse({
	id: "own_ais_162m_2048k",
	role: "channelizer-golden",
	decoder: "ais-catcher",
	license: "private",
	provenance: { notes: "own" },
	fetch: { kind: "private" },
	file: "raw/own_ais_162m_2048k.cu8",
	sha256: "a".repeat(64),
	format: "cu8",
	sample_rate: 2_048_000,
	center_hz: 162_100_000, // capture tuned off the AIS pair; the channel request moves back onto it
	duration_s: 20,
	expected: { min_count: 2, payloads: [{ mmsi: "211234560" }], key_fields: ["mmsi", "messageType"] },
	channel: { center_hz: 162_000_000 }, // AIS A/B pair centre: AIS-catcher expects ±25 kHz around its input centre
})

describe("fixture harness helpers", () => {
	it("builds a recording-source config with the channel request on the channelizer path", () => {
		const raw = parse(buildFixtureConfig({ fixture, path: "raw", apiPort: 19100, paddedPath: "/tmp/p.cu8" }))
		expect(raw.sources[0]).toMatchObject({ type: "recording", filePath: "/tmp/p.cu8", loop: false, caps: { kind: "iq", format: "U8_IQ", sampleRate: 2_048_000, centerFreq: 162_100_000 } })
		expect(raw.decoders[0]).toMatchObject({ type: "ais-catcher", useChannelizer: false, options: { channelHz: 162_000_000 } })
		expect(raw.channelizer).toEqual({ enabled: false })
		const chan = parse(buildFixtureConfig({ fixture, path: "channelizer", apiPort: 19102, paddedPath: "/tmp/p.cu8" }))
		expect(chan.decoders[0].useChannelizer).toBe(true)
		expect(chan.channelizer).toEqual({ enabled: true })
		expect(chan.api.port).toBe(19102)
	})
	it("pads lead and tail with 0x7f bytes sized by the fixture rate", () => {
		const cmd = padCommand(fixture, "/fixtures/raw/x.cu8", "/tmp/p.cu8")
		expect(cmd).toContain(`head -c ${5 * 2_048_000 * 2} /dev/zero`)
		expect(cmd).toContain(`head -c ${3 * 2_048_000 * 2} /dev/zero`)
		expect(runSeconds(fixture)).toBe(5 + 20 + 3 + 10)
	})
	it("matches partial payloads and counts outputs", () => {
		const observed = [
			{ type: "ship", data: { mmsi: "211234560", messageType: 1, lat: 1 } },
			{ type: "ship", data: { mmsi: "999", messageType: 3 } },
			{ type: "stats", data: {} },
		]
		expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true)
		expect(isSubset({ a: [1] }, { a: [1, 2] })).toBe(false)
		expect(matchExpected(fixture, observed)).toEqual({ ok: true, count: 2, missing: [] })
		expect(keySet(fixture, observed)).toEqual(['["211234560",1]', '["999",3]'])
	})
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run tests/unit/fixtures/fixture-harness.test.ts`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement**

```ts
// tests/integration/fixtures/harness.ts
import { stringify } from "yaml"
import type { Fixture } from "./manifest.js"

export type FixturePath = "raw" | "channelizer"
export const LEAD_SECONDS = 5
export const TAIL_SECONDS = 3
export const CONTAINER_FIXTURES_DIR = "/fixtures"
const UNCOUNTED_TYPES = new Set(["stats", "error", "sync"])

export interface ObservedOutput {
	type: string
	data: Record<string, unknown>
}

export function goldenDecoderId(f: Fixture): string {
	return `golden-${f.id}`.slice(0, 60)
}

/** One recording source + one decoder. Unknown keys (channelizer, useChannelizer) are stripped by Zod before batch 4. */
export function buildFixtureConfig(input: {
	fixture: Fixture
	path: FixturePath
	apiPort: number
	paddedPath: string
}): string {
	const { fixture: f, path, apiPort, paddedPath } = input
	const channelised = path === "channelizer"
	return stringify({
		sources: [
			{
				id: "fixture",
				type: "recording",
				filePath: paddedPath,
				loop: false,
				playbackSpeed: f.playback_speed,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: f.sample_rate,
					...(f.center_hz !== undefined ? { centerFreq: f.center_hz } : {}),
					exclusive: false,
				},
			},
		],
		decoders: [
			{
				id: goldenDecoderId(f),
				type: f.decoder,
				enabled: true,
				sourceId: "fixture",
				useChannelizer: channelised,
				options: { ...f.decoder_options, ...(f.channel ? { channelHz: f.channel.center_hz } : {}) },
			},
		],
		api: { host: "127.0.0.1", port: apiPort },
		audio: { tcpPort: apiPort + 1, monitoring: false },
		tunerRelay: { enabled: false },
		liveDemod: { enabled: false },
		logging: { level: "info" },
		channelizer: { enabled: channelised },
	})
}

export function padCommand(f: Fixture, sourcePath: string, paddedPath: string): string {
	const bytesPerSecond = f.sample_rate * 2
	const pad = (seconds: number) => `head -c ${seconds * bytesPerSecond} /dev/zero | tr '\\000' '\\177'`
	return `{ ${pad(LEAD_SECONDS)}; cat '${sourcePath}'; ${pad(TAIL_SECONDS)}; } > '${paddedPath}'`
}

export function runSeconds(f: Fixture): number {
	return LEAD_SECONDS + f.duration_s / f.playback_speed + TAIL_SECONDS + 10
}

export function isSubset(expected: unknown, actual: unknown): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			expected.length === actual.length &&
			expected.every((e, i) => isSubset(e, actual[i]))
		)
	}
	if (expected !== null && typeof expected === "object") {
		if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false
		const a = actual as Record<string, unknown>
		return Object.entries(expected as Record<string, unknown>).every(([k, v]) => isSubset(v, a[k]))
	}
	return Object.is(expected, actual)
}

function counted(f: Fixture, observed: ObservedOutput[]): ObservedOutput[] {
	const types = f.expected.output_types
	return observed.filter(o => (types ? types.includes(o.type) : !UNCOUNTED_TYPES.has(o.type)))
}

export function matchExpected(
	f: Fixture,
	observed: ObservedOutput[],
): { ok: boolean; count: number; missing: Record<string, unknown>[] } {
	const outputs = counted(f, observed)
	const missing = f.expected.payloads.filter(p => !outputs.some(o => isSubset(p, o.data)))
	return { ok: missing.length === 0 && outputs.length >= f.expected.min_count, count: outputs.length, missing }
}

export function keySet(f: Fixture, observed: ObservedOutput[]): string[] {
	const fields = f.expected.key_fields ?? []
	const keys = new Set(counted(f, observed).map(o => JSON.stringify(fields.map(k => o.data[k] ?? null))))
	return [...keys].sort()
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm exec vitest run tests/unit/fixtures/fixture-harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/fixtures/harness.ts tests/unit/fixtures/fixture-harness.test.ts
git commit -m "test(fixtures): golden harness helpers (addendum §8, Property 15)"
```

### Task 5: Collector and env-gated golden harness

**Files:**
- Create: `tests/integration/fixtures/collect-outputs.mjs`
- Create: `tests/integration/iq-fixture-goldens.test.ts`

**Interfaces:**
- Consumes: `loadManifest` (Task 1) and all of `harness.ts` (Task 4).
- Produces: env contract
  - `WAVEKIT_FIXTURE_CONTAINER`: a running container.
  - `WAVEKIT_FIXTURES_DIR`: the host fixtures dir, mounted at `/fixtures`.
  - `WAVEKIT_FIXTURE_PATHS`: `raw` (default) or `raw,channelizer`.
  - `WAVEKIT_FIXTURE_IDS`: optional comma list.
  - `WAVEKIT_FIXTURE_RECORD=1`: print observed sets and skip assertions.

- [ ] **Step 1: Write the collector**

```js
// tests/integration/fixtures/collect-outputs.mjs
// Runs INSIDE the container (Node 22: global fetch + WebSocket). Usage:
//   node collect-outputs.mjs <apiPort> <seconds> <decoderId>
// Prints {"kind":"output",...} lines for that decoder, then one {"kind":"status",...}.
const [port, seconds, decoderId] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`
const deadline = Date.now() + Number(seconds) * 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))

for (;;) {
	if (Date.now() > deadline) {
		process.stderr.write("app never became healthy\n")
		process.exit(2)
	}
	try {
		if ((await fetch(`${base}/health`)).ok) break
	} catch {
		// not up yet
	}
	await sleep(100)
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "subscribe", channels: ["decoders"] })))
ws.addEventListener("message", event => {
	const msg = JSON.parse(String(event.data))
	if (msg.type === "decoder:output" && msg.data?.decoderId === decoderId) {
		process.stdout.write(`${JSON.stringify({ kind: "output", output: msg.data.output })}\n`)
	}
})
await sleep(Math.max(0, deadline - Date.now()))
const status = await (await fetch(`${base}/api/decoders/${encodeURIComponent(decoderId)}`)).json()
process.stdout.write(`${JSON.stringify({ kind: "status", status })}\n`)
ws.close()
process.exit(0)
```

- [ ] **Step 2: Write the env-gated harness**

```ts
// tests/integration/iq-fixture-goldens.test.ts
/**
 * IQ fixture goldens (addendum §8). Opt-in; never a default gate on the dev Mac.
 *
 *   docker run -d --init --name wk-fixtures -v "$PWD/fixtures:/fixtures:ro" \
 *     --entrypoint sleep <image> infinity
 *
 * --init is required: with `sleep` as PID 1 nothing reaps the stopped app, and the pid-file cleanup would
 * wait the full 20 s on a zombie for every path.
 *   WAVEKIT_FIXTURE_CONTAINER=wk-fixtures WAVEKIT_FIXTURES_DIR="$PWD/fixtures" \
 *     pnpm exec vitest run tests/integration/iq-fixture-goldens.test.ts
 *
 * Batch 4 adds WAVEKIT_FIXTURE_PATHS=raw,channelizer (Property 15).
 * WAVEKIT_FIXTURE_RECORD=1 prints observed sets for review instead of asserting.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { loadManifest, type Fixture } from "./fixtures/manifest.js"
import {
	CONTAINER_FIXTURES_DIR,
	buildFixtureConfig,
	goldenDecoderId,
	keySet,
	matchExpected,
	padCommand,
	runSeconds,
	type FixturePath,
	type ObservedOutput,
} from "./fixtures/harness.js"

const container = process.env["WAVEKIT_FIXTURE_CONTAINER"]
const fixturesDir = process.env["WAVEKIT_FIXTURES_DIR"]
const record = process.env["WAVEKIT_FIXTURE_RECORD"] === "1"
const paths = (process.env["WAVEKIT_FIXTURE_PATHS"] ?? "raw").split(",") as FixturePath[]
const onlyIds = process.env["WAVEKIT_FIXTURE_IDS"]?.split(",")
const COLLECTOR = "/tmp/wk-collect-outputs.mjs"

function exec(args: string[], options: { input?: string; timeoutMs?: number } = {}) {
	const r = spawnSync("docker", ["exec", ...(options.input !== undefined ? ["-i"] : []), container!, ...args], {
		encoding: "utf8",
		timeout: options.timeoutMs ?? 30000,
		maxBuffer: 64 * 1024 * 1024,
		...(options.input !== undefined ? { input: options.input } : {}),
	})
	if (r.error) throw r.error
	return r
}

interface PathResult {
	observed: ObservedOutput[]
	status: Record<string, unknown> | undefined
	log: string
}

function runFixture(f: Fixture, path: FixturePath, index: number): PathResult {
	const tag = `${f.id}-${path}`
	const apiPort = 19100 + index * 4 + (path === "raw" ? 0 : 2)
	const padded = `/tmp/wk-${tag}.cu8`
	const configPath = `/tmp/wk-${tag}.yaml`
	const logPath = `/tmp/wk-${tag}.log`
	const pidPath = `/tmp/wk-${tag}.pid`
	const seconds = runSeconds(f)
	exec(["sh", "-c", `cat > '${configPath}'`], { input: buildFixtureConfig({ fixture: f, path, apiPort, paddedPath: padded }) })
	exec(["sh", "-c", padCommand(f, `${CONTAINER_FIXTURES_DIR}/${f.file}`, padded)], { timeoutMs: 120000 })
	// $! is the `timeout` process (nohup execs it); `timeout` forwards SIGTERM to node, which stops its decoders.
	exec(["sh", "-c", `WAVEKIT_CONFIG='${configPath}' nohup timeout -s TERM ${Math.ceil(seconds + 20)} node /app/dist/index.js > '${logPath}' 2>&1 & echo $! > '${pidPath}'`])
	const collected = exec(["node", COLLECTOR, String(apiPort), String(seconds), goldenDecoderId(f)], { timeoutMs: (seconds + 30) * 1000 })
	// No match-by-command-line kill: bookworm-slim has no procps, and the config path is in the env, not on the command line.
	// Stop this instance by pid and wait (bounded, 20 s) for it to exit before the next path starts, so two app
	// instances never overlap (doubled decoders, port collisions, a corrupted Property 15 comparison).
	exec(
		["sh", "-c", `pid=$(cat '${pidPath}'); kill -TERM "$pid" 2>/dev/null; i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done; kill -KILL "$pid" 2>/dev/null; rm -f '${padded}' '${pidPath}'`],
		{ timeoutMs: 30000 },
	)
	const observed: ObservedOutput[] = []
	let status: Record<string, unknown> | undefined
	for (const line of collected.stdout.split("\n")) {
		if (!line.trim()) continue
		const msg = JSON.parse(line) as { kind: string; output?: { type: string; data: Record<string, unknown> }; status?: Record<string, unknown> }
		if (msg.kind === "output" && msg.output) observed.push({ type: msg.output.type, data: msg.output.data })
		if (msg.kind === "status") status = msg.status
	}
	return { observed, status, log: exec(["cat", logPath]).stdout }
}

describe.skipIf(!container || !fixturesDir)("IQ fixture goldens", () => {
	const manifest = loadManifest()
	// Negative fixtures are real captures with only channel.center_hz moved out of the capture. options.channelHz is
	// read only by getChannelRequest (Task 23), so on the raw path they decode the real signal. They run on the
	// channelizer path only, and are left out entirely when WAVEKIT_FIXTURE_PATHS has no channelizer (batch 3, Task 8).
	const fixtures = manifest.fixtures.filter(
		f =>
			f.format === "cu8" &&
			(f.role !== "negative" || paths.includes("channelizer")) &&
			(!onlyIds || onlyIds.includes(f.id)) &&
			existsSync(join(resolve(fixturesDir ?? "."), f.file)),
	)
	beforeAll(() => {
		const r = spawnSync("docker", ["cp", resolve("tests/integration/fixtures/collect-outputs.mjs"), `${container!}:${COLLECTOR}`])
		expect(r.status).toBe(0)
	})
	it.each(fixtures.map((f, i) => [f.id, f, i] as const))("%s", (_id, f, index) => {
		const results = new Map<FixturePath, PathResult>()
		for (const path of paths) {
			if (path === "channelizer" && f.role !== "channelizer-golden" && f.role !== "negative") continue
			if (path === "raw" && f.role === "negative") continue // see the filter above: raw ignores channelHz
			results.set(path, runFixture(f, path, index))
		}
		if (record) {
			for (const [path, r] of results) {
				process.stdout.write(`${JSON.stringify({ fixture: f.id, path, count: matchExpected(f, r.observed).count, keys: keySet(f, r.observed), sample: r.observed.slice(0, 5) })}\n`)
			}
			return
		}
		for (const [path, r] of results) {
			const m = matchExpected(f, r.observed)
			if (f.role === "negative") {
				// Only the channelizer path reaches here for a negative (raw is skipped above).
				expect(m.count, `${path}: negative fixture decoded`).toBe(0)
				if (f.expected.suspension) {
					expect(r.status?.["suspended"]).toBe(true)
					expect(r.log).toContain(`"reasonCode":"${f.expected.suspension}"`)
				}
			} else {
				expect(m.missing, `${path}: missing payloads`).toEqual([])
				expect(m.count, `${path}: count`).toBeGreaterThanOrEqual(f.expected.min_count)
			}
		}
		const raw = results.get("raw")
		const chan = results.get("channelizer")
		if (raw && chan && f.role === "channelizer-golden") {
			// Feature: core-channelizer, Property 15: Golden equality
			// Validates: addendum §8, §12.15
			expect(keySet(f, chan.observed)).toEqual(keySet(f, raw.observed))
		}
	}, 600000)
})
```

- [ ] **Step 3: Verify the skip on the Mac**

Run: `pnpm exec vitest run tests/integration/iq-fixture-goldens.test.ts`
Expected: the suite is skipped (no env), exit 0.

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/fixtures/collect-outputs.mjs tests/integration/iq-fixture-goldens.test.ts
git commit -m "test(fixtures): env-gated IQ golden harness (addendum §8, Property 15)"
```

### Task 6: [D2] Acquire and verify public fixtures

**Files:**
- Modify: `fixtures/manifest.yaml` (promote candidates to `fixtures`)

This task runs on any host with network access. The record runs (step 4) need a built image on a quiet host.

- [ ] **Step 1: Inspect each public candidate.** For `sdrplay_ais`, `sigid_pocsag` and `sigid_flex`, download into a scratch dir outside the repo, then list and probe:

```bash
mkdir -p /tmp/wk-acq && cd /tmp/wk-acq
curl -fsSLO https://sdrplay.com/resources/IQ/AIS.zip && unzip -l AIS.zip
unzip -o AIS.zip -d ais && soxi ais/*.wav   # rate, channels, bit depth, duration
shasum -a 256 AIS.zip
```

Repeat for the SigIDwiki zips (`unzip -l`, then `ls -l` the members). A raw member's rate comes only from metadata inside the archive or from the hosting page. If neither states it, the candidate keeps the blocker "sample rate unverified".

- [ ] **Step 2: Verify the license.** Open the hosting page for each archive and record the stated license verbatim in `license` and the page URL in `provenance.url`. If no license is stated, the entry stays a candidate with the blocker `license unverified`. This rule is fixed: no license, no fixture.

- [ ] **Step 3: Decide the role.**
  - `channelizer-golden` only for cu8 (after transform) at ≥ 2 048 000 Hz with a known centre.
  - A WAV IQ at another rate (for example 2 000 000) becomes `tail-golden` and runs on the raw path only.
  - SDRangel ADS-B becomes `tail-golden` with `large: true` (readsb raw baseline).
  - `rtl_433_tests` samples become `tail-golden` entries, one per chosen sample file, with `fetch.member` set.

- [ ] **Step 4: Record expected decodes (quiet host, built image).** Write the entry with `expected: { min_count: 0, payloads: [] }` first, then:

```bash
./fixtures/download.sh <id>
docker run -d --init --name wk-fixtures -v "$PWD/fixtures:/fixtures:ro" --entrypoint sleep <image> infinity
WAVEKIT_FIXTURE_CONTAINER=wk-fixtures WAVEKIT_FIXTURES_DIR="$PWD/fixtures" WAVEKIT_FIXTURE_RECORD=1 \
  WAVEKIT_FIXTURE_IDS=<id> pnpm exec vitest run tests/integration/iq-fixture-goldens.test.ts
```

From the printed line, set `min_count = floor(0.8 × count)`, add up to 3 `payloads` containing only `key_fields` values, and set `key_fields`: AIS `["mmsi", "messageType"]`, POCSAG/FLEX `["address", "function"]`, rtl_433 `["model", "id"]`. Field names must match the decoder's `output.data` keys as printed. AIS `mmsi` is a 9-digit string.

- [ ] **Step 5: Validate**

Run: `pnpm exec vitest run tests/unit/fixtures/manifest-v2.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fixtures/manifest.yaml
git commit -m "feat(fixtures): verified public fixtures with license and expected decodes (addendum §8, D2)"
```

### Task 7: [D2] Own private captures

**Files:**
- Modify: `fixtures/manifest.yaml`

Capture with a local RTL-SDR on the operator's machine (the local dongle is first-class). Never deploy to the Pi for this.

- [ ] **Step 1: Capture at both rates.** Use `rtl_sdr` (or `scripts/auto-capture.py` against a local `rtl_tcp`) at 2 048 000 and 2 400 000 sps:

| id | centre (Hz) | decoder | expected key_fields |
|---|---|---|---|
| `own_pocsag_<band>_2048k` / `_2400k` | local pager channel | multimon-ng | `["address", "function"]` |
| `own_dmr_<band>_2048k` | local DMR repeater | dsd-fme | `["talkgroup", "source"]` |
| `own_vdl2_136800k_2048k` | 136 800 000 | dumpvdl2 | `["icao", "type"]` (as printed) |
| `own_rtl433_433920k_2048k` | 433 920 000 | rtl433 | `["model", "id"]` |
| `own_ais_162m_2048k` | 162 000 000 | ais-catcher | `["mmsi", "messageType"]` |
| `own_lora_869525k_2048k` | 869 525 000 | lora-meshtastic | `tail-golden` only (excluded from migration) |

```bash
rtl_sdr -f 162000000 -s 2048000 -g 40 -n $((2048000*60)) /tmp/wk-acq/own_ais_162m_2048k.full.cu8
```

- [ ] **Step 2: Trim to the shortest window holding the expected decodes.** Find the decode times with the record run, then cut with `dd bs=4096 skip=… count=…` (keep the byte offset even). Aim for ≤ 30 s.
- [ ] **Step 3: Store privately.** Copy the trimmed file to the private store named by `WAVEKIT_PRIVATE_FIXTURES_DIR`, then `shasum -a 256` it. Add the entry: `license: private`, `fetch: { kind: private }`, `provenance.notes` (date, antenna, location granularity no finer than a city), `file: raw/<id>.cu8`. Never `git add` anything under `fixtures/raw/`.
- [ ] **Step 4: Add negatives.** For two fixtures whose decoders migrate first (the AIS and the VDL2 capture), add a `negative` copy (same `file` and `sha256`, `id` suffixed `_outside`) with `channel.center_hz` set to `center_hz + 0.49 × sample_rate`, plus `expected: { min_count: 0, payloads: [], suspension: channel-outside-capture }`. A negative means something only on the channelizer path: `options.channelHz` is read only by `getChannelRequest` (Task 23), so on the raw path the decoder decodes the real signal. The harness (Task 5) therefore never runs a negative on the raw path and leaves negatives out entirely when `WAVEKIT_FIXTURE_PATHS` has no `channelizer`. They are first exercised by their decoder's migration gate (Task 28 for AIS, Task 29 for VDL2), and by Task 32's full run.
- [ ] **Step 5: Record expected decodes** for the non-negative entries with the same command as Task 6 step 4 (negatives have nothing to record; the raw-only record run skips them).
- [ ] **Step 6: Validate and commit**

Run: `pnpm exec vitest run tests/unit/fixtures/manifest-v2.test.ts` (Expected: PASS)

```bash
git add fixtures/manifest.yaml
git commit -m "feat(fixtures): private own-capture goldens at 2.048/2.4 Msps (addendum §8, D2)"
```

### Task 8: CHECKPOINT: batch 3 gate (quiet host)

- [ ] **Step 1:** On a quiet host with the current image, run `./fixtures/download.sh` (with private access) and the harness with no `WAVEKIT_FIXTURE_RECORD` and `WAVEKIT_FIXTURE_PATHS=raw`. Expected: every non-negative fixture passes. The `_outside` negatives from Task 7 are not run on this path (Task 5 filters them out); record them as "not run (channelizer only)" in `GOLDENS.md`.
- [ ] **Step 2:** Create `fixtures/GOLDENS.md` with one table row per run: date, host, image id (`docker image inspect --format '{{.Id}}'`), `git rev-parse HEAD`, path, fixture ids and their sha256 prefixes, and the result.
- [ ] **Step 3:** On the dev Mac (cheap): `pnpm exec vitest run tests/unit/fixtures` then `pnpm run typecheck && pnpm run lint`. Expected: PASS.
- [ ] **Step 4: Commit** `git add fixtures/GOLDENS.md && git commit -m "docs(fixtures): batch 3 raw-path golden gate"`

---

# Batch 4A: Standalone process and pure Node pieces (no gate)

These tasks create new files only (`native/`, `src/core/channelizer/`), plus `Makefile` and `.gitignore`. They can proceed in parallel with batch 3.

### Task 9: [D1] Crate scaffold, args, `--version`, Makefile targets

**Files:**
- Create: `native/wavekit-chan/Cargo.toml`, `native/wavekit-chan/src/main.rs`, `native/wavekit-chan/src/lib.rs`, `native/wavekit-chan/src/args.rs`, `native/wavekit-chan/LICENSES.md`
- Modify: `Makefile` (`.PHONY` list and two targets), `.gitignore`, `.dockerignore`

**Interfaces:**
- Produces: `wavekit_chan::args::{parse, Command, Args}`; `Args { generation: u64, input_rate: u64, input_center: f64, usable_fraction: f64, block_samples: usize, socket_dir: PathBuf, control_fd: i32 }`; `VERSION_LINE = "wavekit-chan 0.1.0 protocol 1"`; exit code 2 on usage errors.

- [ ] **Step 1: Create `Cargo.toml` and the module skeleton**

```toml
# native/wavekit-chan/Cargo.toml
[package]
name = "wavekit-chan"
version = "0.1.0"
edition = "2021"
license = "ISC"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
proptest = "1"

[profile.release]
lto = "thin"
codegen-units = 1

[profile.test]
opt-level = 3
```

```rust
// native/wavekit-chan/src/lib.rs
pub mod admission;
pub mod args;
pub mod channel;
pub mod convert;
pub mod design;
pub mod plan;
pub mod protocol;
pub mod queue;
pub mod runtime;
pub mod stages;
```

Create every listed module as an empty file now (`touch`), so the crate builds after each task.

- [ ] **Step 2: Write the failing args tests** (inside `args.rs`)

```rust
// native/wavekit-chan/src/args.rs
use std::path::PathBuf;

pub const VERSION_LINE: &str = "wavekit-chan 0.1.0 protocol 1";

#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub generation: u64,
    pub input_rate: u64,
    pub input_center: f64,
    pub usable_fraction: f64,
    pub block_samples: usize,
    pub socket_dir: PathBuf,
    pub control_fd: i32,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Version,
    Run(Args),
}

pub fn parse(argv: &[String]) -> Result<Command, String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(s: &str) -> Vec<String> { s.split_whitespace().map(String::from).collect() }

    #[test]
    fn parses_the_spawn_line() {
        let cmd = parse(&v("--generation 3 --input-format cu8 --input-rate 2048000 --input-center 162000000 --usable-fraction 0.8 --block-samples 16384 --socket-dir /tmp/s --control-fd 3")).unwrap();
        assert_eq!(cmd, Command::Run(Args { generation: 3, input_rate: 2_048_000, input_center: 162e6, usable_fraction: 0.8, block_samples: 16384, socket_dir: "/tmp/s".into(), control_fd: 3 }));
    }
    #[test]
    fn version() { assert_eq!(parse(&v("--version")).unwrap(), Command::Version); }
    #[test]
    fn rejects_bad_values() {
        assert!(parse(&v("--generation 1 --input-format cs16 --input-rate 1 --input-center 1 --usable-fraction 0.8 --block-samples 16384 --socket-dir /t --control-fd 3")).is_err());
        assert!(parse(&v("--generation 1 --input-format cu8 --input-rate 2048000 --input-center 1 --usable-fraction 0.99 --block-samples 16384 --socket-dir /t --control-fd 3")).is_err());
        assert!(parse(&v("--generation 1 --input-format cu8 --input-rate 0 --input-center 1 --usable-fraction 0.8 --block-samples 16384 --socket-dir /t --control-fd 3")).is_err());
        assert!(parse(&v("--bogus 1")).is_err());
    }
}
```

- [ ] **Step 3: Add the Makefile targets and the ignore rule.** Append `chan-build chan-test` to the `.PHONY:` list in `Makefile`, and add:

```make
chan-build: ## Build wavekit-chan on the host (needs a Rust toolchain)
	@cargo build --release --locked --manifest-path native/wavekit-chan/Cargo.toml

chan-test: ## Run wavekit-chan unit/property tests (crate only; no benches)
	@cargo test --release --locked --manifest-path native/wavekit-chan/Cargo.toml
```

Append to `.gitignore`: `native/wavekit-chan/target/`. Append to `.dockerignore`, under the `# Build artifacts` block: `native/wavekit-chan/target`. Without it a host `make chan-build` puts hundreds of MB of cargo output into every Docker build context (Task 26's `COPY` lines name only `Cargo.toml`, `Cargo.lock` and `src/`, but the context upload still includes `target/`).

- [ ] **Step 4: Generate the lockfile, then confirm the tests fail**

Run: `cargo generate-lockfile --manifest-path native/wavekit-chan/Cargo.toml && make chan-test`
Expected: FAIL, panics at `todo!()`.

- [ ] **Step 5: Implement `parse` and `main`**

```rust
// replace `todo!()` in parse()
    if argv.len() == 1 && argv[0] == "--version" {
        return Ok(Command::Version);
    }
    let mut map = std::collections::HashMap::new();
    let mut it = argv.iter();
    while let Some(k) = it.next() {
        let key = k.strip_prefix("--").ok_or_else(|| format!("unexpected argument {k}"))?;
        let val = it.next().ok_or_else(|| format!("--{key} needs a value"))?;
        map.insert(key.to_string(), val.clone());
    }
    let get = |k: &str| map.get(k).cloned().ok_or_else(|| format!("missing --{k}"));
    let num = |k: &str| -> Result<f64, String> { get(k)?.parse::<f64>().map_err(|_| format!("--{k} not a number")) };
    let known = ["generation", "input-format", "input-rate", "input-center", "usable-fraction", "block-samples", "socket-dir", "control-fd"];
    if let Some(bad) = map.keys().find(|k| !known.contains(&k.as_str())) {
        return Err(format!("unknown option --{bad}"));
    }
    if get("input-format")? != "cu8" { return Err("only --input-format cu8 is supported".into()); }
    let input_rate = get("input-rate")?.parse::<u64>().map_err(|_| "--input-rate must be an integer".to_string())?;
    if input_rate == 0 { return Err("--input-rate must be > 0".into()); }
    let usable_fraction = num("usable-fraction")?;
    if !(0.5..=0.95).contains(&usable_fraction) { return Err("--usable-fraction must be within 0.5..0.95".into()); }
    let block_samples = get("block-samples")?.parse::<usize>().map_err(|_| "--block-samples must be an integer".to_string())?;
    if !(256..=1 << 20).contains(&block_samples) { return Err("--block-samples must be within 256..1048576".into()); }
    let input_center = num("input-center")?;
    if !input_center.is_finite() { return Err("--input-center must be finite".into()); }
    Ok(Command::Run(Args {
        generation: get("generation")?.parse().map_err(|_| "--generation must be an integer".to_string())?,
        input_rate,
        input_center,
        usable_fraction,
        block_samples,
        socket_dir: PathBuf::from(get("socket-dir")?),
        control_fd: get("control-fd")?.parse().map_err(|_| "--control-fd must be an integer".to_string())?,
    }))
```

```rust
// native/wavekit-chan/src/main.rs
use wavekit_chan::args::{parse, Command, VERSION_LINE};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse(&argv) {
        Ok(Command::Version) => println!("{VERSION_LINE}"),
        Ok(Command::Run(args)) => std::process::exit(wavekit_chan::runtime::run(args)),
        Err(e) => {
            eprintln!("wavekit-chan: {e}");
            std::process::exit(2);
        }
    }
}
```

Until Task 15, `runtime.rs` holds only `pub fn run(_args: crate::args::Args) -> i32 { 0 }`.

- [ ] **Step 6: Write `LICENSES.md`**

```markdown
# wavekit-chan third-party licenses
| crate | license | use |
|---|---|---|
| serde, serde_derive | MIT OR Apache-2.0 | control protocol |
| serde_json | MIT OR Apache-2.0 | control protocol |
| proptest (dev only) | MIT OR Apache-2.0 | property tests, not shipped |
No FFT crate and no GPL code (addendum §10 refined by plan assumption A5).
Regenerate the transitive list with `cargo tree --manifest-path native/wavekit-chan/Cargo.toml -e normal`.
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `make chan-test`
Expected: PASS (3 args tests).

- [ ] **Step 8: Commit**

```bash
git add native/wavekit-chan/Cargo.toml native/wavekit-chan/Cargo.lock native/wavekit-chan/LICENSES.md \
  native/wavekit-chan/src/main.rs native/wavekit-chan/src/lib.rs native/wavekit-chan/src/args.rs \
  native/wavekit-chan/src/admission.rs native/wavekit-chan/src/channel.rs native/wavekit-chan/src/convert.rs \
  native/wavekit-chan/src/design.rs native/wavekit-chan/src/plan.rs native/wavekit-chan/src/protocol.rs \
  native/wavekit-chan/src/queue.rs native/wavekit-chan/src/runtime.rs native/wavekit-chan/src/stages.rs \
  Makefile .gitignore .dockerignore
git commit -m "feat(chan): wavekit-chan crate scaffold and spawn args (addendum §10, §11, D1)"
```

### Task 10: [D1] CU8/f32 conversion and the input assembler

**Files:**
- Create/fill: `native/wavekit-chan/src/convert.rs`

**Interfaces:**
- Produces:
  - `cu8_to_f32(u: u8) -> f32`
  - `f32_to_cu8(x: f32, gain: f32) -> (u8, bool)` (the bool marks saturation)
  - `struct InputAssembler { pub consumed_bytes: u64, pub carry: Option<u8> }` with `push(&mut self, bytes: &[u8], i: &mut Vec<f32>, q: &mut Vec<f32>)` (appends whole samples and keeps an odd trailing byte) and `discarded(&self) -> u64`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // Feature: core-channelizer, Property 7: Pass-through identity (scaling)
    // Validates: addendum §3, §12.7
    #[test]
    fn exact_round_trip_for_every_byte() {
        for u in 0..=255u8 {
            let (back, sat) = f32_to_cu8(cu8_to_f32(u), 1.0);
            assert_eq!(back, u, "byte {u}");
            assert!(!sat);
        }
        assert_eq!(cu8_to_f32(0), -1.0);
        assert_eq!(cu8_to_f32(255), 1.0);
    }
    #[test]
    fn saturates_and_counts() {
        assert_eq!(f32_to_cu8(1.5, 1.0), (255, true));
        assert_eq!(f32_to_cu8(-1.5, 1.0), (0, true));
        assert_eq!(f32_to_cu8(0.5, 3.0), (255, true));
    }
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (byte level)
        // Validates: addendum §12.4
        #[test]
        fn splits_inside_pairs_do_not_change_samples(data in proptest::collection::vec(any::<u8>(), 0..4096), cuts in proptest::collection::vec(0usize..4096, 0..16)) {
            let (mut wi, mut wq) = (Vec::new(), Vec::new());
            InputAssembler::default().push(&data, &mut wi, &mut wq);
            let mut a = InputAssembler::default();
            let (mut si, mut sq) = (Vec::new(), Vec::new());
            let mut points: Vec<usize> = cuts.into_iter().map(|c| c.min(data.len())).collect();
            points.sort_unstable();
            let mut last = 0;
            for p in points.into_iter().chain(std::iter::once(data.len())) {
                a.push(&data[last..p], &mut si, &mut sq);
                last = p;
            }
            prop_assert_eq!(wi, si);
            prop_assert_eq!(wq, sq);
            prop_assert_eq!(a.discarded(), (data.len() % 2) as u64);
        }
    }
}
```

- [ ] **Step 2: Run them and confirm they fail.** `make chan-test`. Expected: compile errors (missing items).
- [ ] **Step 3: Implement**

```rust
// native/wavekit-chan/src/convert.rs
/// csdr `convert -i char -o float`: u / (UCHAR_MAX/2.0) - 1.0, computed in f64, stored f32.
pub fn cu8_to_f32(u: u8) -> f32 {
    (u as f64 / 127.5 - 1.0) as f32
}

/// csdr `convert -i float -o char` (x * UCHAR_MAX * 0.5 + 128, truncated) with saturation.
pub fn f32_to_cu8(x: f32, gain: f32) -> (u8, bool) {
    let v = ((x * gain * 255.0f32) as f64) * 0.5 + 128.0;
    let f = v.floor();
    if f < 0.0 { (0, true) } else if f > 255.0 { (255, true) } else { (f as u8, false) }
}

#[derive(Default, Debug)]
pub struct InputAssembler {
    pub consumed_bytes: u64,
    pub carry: Option<u8>,
}

impl InputAssembler {
    pub fn push(&mut self, bytes: &[u8], i: &mut Vec<f32>, q: &mut Vec<f32>) {
        let mut rest = bytes;
        if let Some(first) = self.carry.take() {
            match rest.split_first() {
                Some((&second, tail)) => {
                    i.push(cu8_to_f32(first));
                    q.push(cu8_to_f32(second));
                    self.consumed_bytes += 2;
                    rest = tail;
                }
                None => {
                    self.carry = Some(first);
                    return;
                }
            }
        }
        let pairs = rest.chunks_exact(2);
        if let [odd] = pairs.remainder() {
            self.carry = Some(*odd);
        }
        for p in pairs {
            i.push(cu8_to_f32(p[0]));
            q.push(cu8_to_f32(p[1]));
        }
        self.consumed_bytes += (rest.len() / 2 * 2) as u64;
    }
    pub fn discarded(&self) -> u64 {
        self.carry.is_some() as u64
    }
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** `make chan-test`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add native/wavekit-chan/src/convert.rs
git commit -m "feat(chan): csdr-exact cu8/f32 conversion and split-safe input assembler (Properties 4, 7)"
```

### Task 11: [D1] Kaiser FIR design

**Files:**
- Fill: `native/wavekit-chan/src/design.rs`

**Interfaces:**
- Produces:
  - `DESIGN_ATTENUATION_DB = 66.0`
  - `kaiser_beta(a: f64) -> f64`
  - `kaiser_len(a: f64, transition: f64) -> usize` (odd; `transition` is a fraction of the sample rate)
  - `lowpass(cutoff: f64, transition: f64, gain: f64) -> Vec<f32>` (cutoff and transition as fractions of the sample rate; DC gain = `gain`)
  - `response_db(taps: &[f32], f: f64) -> f64` (magnitude in dB relative to the DC sum)

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // Feature: core-channelizer, Property 6: Stopband and image (design level)
    // Validates: addendum §12.6
    #[test]
    fn meets_60_db_stopband_and_0_1_db_passband() {
        for &(pass, stop) in &[(0.10, 0.15), (0.02, 0.03), (0.2, 0.45), (0.001, 0.0012)] {
            let taps = lowpass((pass + stop) / 2.0, stop - pass, 1.0);
            assert_eq!(taps.len() % 2, 1);
            for k in 0..=200 {
                let f = pass * k as f64 / 200.0;
                assert!(response_db(&taps, f).abs() <= 0.05, "passband {f}");
            }
            for k in 0..=400 {
                let f = stop + (0.5 - stop) * k as f64 / 400.0;
                assert!(response_db(&taps, f) <= -60.0, "stopband {f}: {}", response_db(&taps, f));
            }
        }
    }
    #[test]
    fn dc_gain_and_symmetry() {
        let taps = lowpass(0.1, 0.05, 3.0);
        let sum: f64 = taps.iter().map(|&t| t as f64).sum();
        assert!((sum - 3.0).abs() < 1e-5);
        for k in 0..taps.len() / 2 { assert!((taps[k] - taps[taps.len() - 1 - k]).abs() < 1e-7); }
    }
}
```

- [ ] **Step 2: Run them and confirm they fail.** `make chan-test`
- [ ] **Step 3: Implement**

```rust
// native/wavekit-chan/src/design.rs
use std::f64::consts::PI;

pub const DESIGN_ATTENUATION_DB: f64 = 66.0;

pub fn kaiser_beta(a: f64) -> f64 {
    if a > 50.0 { 0.1102 * (a - 8.7) } else if a >= 21.0 { 0.5842 * (a - 21.0).powf(0.4) + 0.07886 * (a - 21.0) } else { 0.0 }
}

pub fn kaiser_len(a: f64, transition: f64) -> usize {
    let n = ((a - 7.95) / (14.36 * transition)).ceil() as usize + 1;
    n | 1
}

fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, half) = (1.0, 1.0, x / 2.0);
    for k in 1..200 {
        term *= (half / k as f64) * (half / k as f64);
        sum += term;
        if term < 1e-14 * sum { break; }
    }
    sum
}

pub fn lowpass(cutoff: f64, transition: f64, gain: f64) -> Vec<f32> {
    let n = kaiser_len(DESIGN_ATTENUATION_DB, transition);
    let beta = kaiser_beta(DESIGN_ATTENUATION_DB);
    let m = (n - 1) as f64 / 2.0;
    let i0b = bessel_i0(beta);
    let raw: Vec<f64> = (0..n)
        .map(|k| {
            let x = k as f64 - m;
            let sinc = if x == 0.0 { 2.0 * cutoff } else { (2.0 * PI * cutoff * x).sin() / (PI * x) };
            let r = if m == 0.0 { 0.0 } else { x / m };
            sinc * bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b
        })
        .collect();
    let sum: f64 = raw.iter().sum();
    raw.iter().map(|t| (t * gain / sum) as f32).collect()
}

pub fn response_db(taps: &[f32], f: f64) -> f64 {
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (k, &t) in taps.iter().enumerate() {
        let w = -2.0 * PI * f * k as f64;
        re += t as f64 * w.cos();
        im += t as f64 * w.sin();
    }
    let dc: f64 = taps.iter().map(|&t| t as f64).sum();
    20.0 * ((re * re + im * im).sqrt() / dc.abs()).log10()
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** `make chan-test`. If the narrowest case misses −60 dB because of f32 coefficient rounding, raise `DESIGN_ATTENUATION_DB` in 2 dB steps (never below 66) and re-run.
- [ ] **Step 5: Commit** `git add native/wavekit-chan/src/design.rs && git commit -m "feat(chan): Kaiser windowed-sinc lowpass design (Property 6, A5)"`

### Task 12: [D1] NCO and rational polyphase stage

**Files:**
- Fill: `native/wavekit-chan/src/stages.rs`

**Interfaces:**
- Produces:
  - `Nco::new(offset_hz: f64, rate_hz: f64)`, `Nco::mix(&mut self, i: &mut [f32], q: &mut [f32])`, `Nco::reset(&mut self)`
  - `RationalFir::new(l: usize, m: usize, prototype: &[f32])`, `process(&mut self, i: &[f32], q: &[f32], oi: &mut Vec<f32>, oq: &mut Vec<f32>)`, `reset(&mut self)`, `prototype_len(&self) -> usize`, `l(&self) -> usize`
  - `dot(a: &[f32], b: &[f32]) -> f32` (8-lane, auto-vectorisable)

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::design::lowpass;
    use proptest::prelude::*;

    fn run_split(st: &mut RationalFir, i: &[f32], q: &[f32], cuts: &[usize]) -> (Vec<f32>, Vec<f32>) {
        let (mut oi, mut oq) = (Vec::new(), Vec::new());
        let mut last = 0;
        for &c in cuts.iter().chain(std::iter::once(&i.len())) {
            let c = c.min(i.len()).max(last);
            st.process(&i[last..c], &q[last..c], &mut oi, &mut oq);
            last = c;
        }
        (oi, oq)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (stage level)
        // Validates: addendum §12.4
        #[test]
        fn rational_stage_is_split_independent(l in 1usize..8, m in 1usize..9, n in 1usize..3000, mut cuts in proptest::collection::vec(0usize..3000, 0..10)) {
            let proto = lowpass(0.4 / (l.max(m) as f64), 0.05 / (l.max(m) as f64), l as f64);
            let i: Vec<f32> = (0..n).map(|k| ((k * 7919) % 255) as f32 / 255.0 - 0.5).collect();
            let q: Vec<f32> = (0..n).map(|k| ((k * 104729) % 255) as f32 / 255.0 - 0.5).collect();
            cuts.sort_unstable();
            let whole = run_split(&mut RationalFir::new(l, m, &proto), &i, &q, &[]);
            let split = run_split(&mut RationalFir::new(l, m, &proto), &i, &q, &cuts);
            prop_assert_eq!(whole, split);
        }
        #[test]
        fn nco_is_split_independent(n in 1usize..5000, cut in 0usize..5000) {
            let mut a = (vec![1.0f32; n], vec![0.0f32; n]);
            let mut b = a.clone();
            Nco::new(12_345.6, 2_048_000.0).mix(&mut a.0, &mut a.1);
            let mut nco = Nco::new(12_345.6, 2_048_000.0);
            let c = cut.min(n);
            let (bi0, bi1) = b.0.split_at_mut(c);
            let (bq0, bq1) = b.1.split_at_mut(c);
            nco.mix(bi0, bq0);
            nco.mix(bi1, bq1);
            prop_assert_eq!(a, b);
        }
    }
    #[test]
    fn output_count_matches_rational_ratio() {
        let proto = lowpass(0.1, 0.05, 3.0);
        let mut st = RationalFir::new(3, 4, &proto);
        let (mut oi, mut oq) = (Vec::new(), Vec::new());
        st.process(&vec![0.0; 4000], &vec![0.0; 4000], &mut oi, &mut oq);
        assert_eq!(oi.len(), 3000);
    }
    #[test]
    fn stage_emits_the_ceiling_of_the_ratio() { // plan A12: Task 13's schedule proof relies on exactly this rule
        for &(l, m, n) in &[(1usize, 2usize, 33usize), (1, 2, 1), (3, 4, 2), (3, 4, 5), (16, 25, 7), (125, 256, 3)] {
            let proto = lowpass(0.4 / (l.max(m) as f64), 0.05 / (l.max(m) as f64), l as f64);
            let mut st = RationalFir::new(l, m, &proto);
            let (mut oi, mut oq) = (Vec::new(), Vec::new());
            st.process(&vec![0.0; n], &vec![0.0; n], &mut oi, &mut oq);
            assert_eq!(oi.len(), (n * l + m - 1) / m, "{l}/{m} n={n}");
        }
    }
}
```

- [ ] **Step 2: Run them and confirm they fail.** `make chan-test`
- [ ] **Step 3: Implement**

```rust
// native/wavekit-chan/src/stages.rs
use std::f64::consts::TAU;

const NCO_RESYNC: u64 = 4096;

/// Mixes by e^{-j 2π Δf n / fs}. State depends only on the absolute sample index n.
#[derive(Debug, Clone)]
pub struct Nco { step: f64, n: u64, re: f64, im: f64, c: f64, s: f64 }

impl Nco {
    pub fn new(offset_hz: f64, rate_hz: f64) -> Self {
        let step = offset_hz / rate_hz;
        let w = -TAU * step.rem_euclid(1.0);
        Nco { step, n: 0, re: 1.0, im: 0.0, c: w.cos(), s: w.sin() }
    }
    pub fn reset(&mut self) { self.n = 0; self.re = 1.0; self.im = 0.0; }
    pub fn mix(&mut self, i: &mut [f32], q: &mut [f32]) {
        if self.step == 0.0 { self.n += i.len() as u64; return; }
        for k in 0..i.len() {
            if self.n % NCO_RESYNC == 0 {
                let ph = -TAU * ((self.n as f64) * self.step).rem_euclid(1.0);
                self.re = ph.cos();
                self.im = ph.sin();
            }
            let (xi, xq) = (i[k] as f64, q[k] as f64);
            i[k] = (xi * self.re - xq * self.im) as f32;
            q[k] = (xi * self.im + xq * self.re) as f32;
            let re = self.re * self.c - self.im * self.s;
            self.im = self.re * self.s + self.im * self.c;
            self.re = re;
            self.n += 1;
        }
    }
}

#[inline]
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 8];
    let (ca, cb) = (a.chunks_exact(8), b.chunks_exact(8));
    let (ra, rb) = (ca.remainder(), cb.remainder());
    for (x, y) in ca.zip(cb) {
        for k in 0..8 { acc[k] += x[k] * y[k]; }
    }
    let mut s = ((acc[0] + acc[4]) + (acc[1] + acc[5])) + ((acc[2] + acc[6]) + (acc[3] + acc[7]));
    for (x, y) in ra.iter().zip(rb) { s += x * y; }
    s
}

/// Polyphase L/M resampler. Output k sits at upsampled index kM: n = ⌊kM/L⌋, phase p = kM mod L.
/// Output k is emitted as soon as input n has arrived, so n inputs yield ⌈nL/M⌉ outputs (plan A12).
/// The stage does not try to hit ⌊nL/M⌋; `ChannelDsp` applies one schedule for the whole chain.
#[derive(Debug, Clone)]
pub struct RationalFir {
    l: usize, m: usize, t: usize, proto_len: usize,
    phases_rev: Vec<Vec<f32>>,          // phases_rev[p][j'] = h[p + (t-1-j')·L]
    hist_i: Vec<f32>, hist_q: Vec<f32>, // last t-1 samples, then the current block
    consumed: u64, next_n: u64, next_p: usize,
}

impl RationalFir {
    pub fn new(l: usize, m: usize, prototype: &[f32]) -> Self {
        let t = (prototype.len() + l - 1) / l;
        let phases_rev = (0..l)
            .map(|p| (0..t).map(|jr| prototype.get(p + (t - 1 - jr) * l).copied().unwrap_or(0.0)).collect())
            .collect();
        RationalFir { l, m, t, proto_len: prototype.len(), phases_rev, hist_i: vec![0.0; t - 1], hist_q: vec![0.0; t - 1], consumed: 0, next_n: 0, next_p: 0 }
    }
    pub fn l(&self) -> usize { self.l }
    pub fn prototype_len(&self) -> usize { self.proto_len }
    pub fn reset(&mut self) {
        self.hist_i = vec![0.0; self.t - 1];
        self.hist_q = vec![0.0; self.t - 1];
        self.consumed = 0; self.next_n = 0; self.next_p = 0;
    }
    pub fn process(&mut self, i: &[f32], q: &[f32], oi: &mut Vec<f32>, oq: &mut Vec<f32>) {
        let base = self.consumed;
        self.hist_i.extend_from_slice(i);
        self.hist_q.extend_from_slice(q);
        let end = base + i.len() as u64;
        while self.next_n < end {
            let last = (self.next_n - base) as usize + (self.t - 1);
            let start = last + 1 - self.t;
            let h = &self.phases_rev[self.next_p];
            oi.push(dot(h, &self.hist_i[start..=last]));
            oq.push(dot(h, &self.hist_q[start..=last]));
            self.next_p += self.m;
            self.next_n += (self.next_p / self.l) as u64;
            self.next_p %= self.l;
        }
        self.consumed = end;
        let drop = self.hist_i.len() - (self.t - 1);
        self.hist_i.drain(..drop);
        self.hist_q.drain(..drop);
    }
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** `make chan-test`
- [ ] **Step 5: Commit** `git add native/wavekit-chan/src/stages.rs && git commit -m "feat(chan): split-independent NCO and polyphase L/M stage (Property 4)"`

### Task 13: [D1] Chain planner and per-channel DSP

**Files:**
- Fill: `native/wavekit-chan/src/plan.rs`, `native/wavekit-chan/src/channel.rs`
- Create: `native/wavekit-chan/tests/dsp_properties.rs`

**Interfaces:**
- Consumes: `design::{lowpass, kaiser_len, DESIGN_ATTENUATION_DB}`, `stages::{Nco, RationalFir}`, `convert::{f32_to_cu8}`.
- Produces:
  - `plan::{HALFBAND_MIN_RATIO = 1.1, MAX_PROTOTYPE_TAPS = 16_384, StageSpec { l, m, in_rate: f64, out_rate: f64, pass_hz: f64, stop_hz: f64 }, ChainPlan { stages: Vec<StageSpec> }, plan_chain(fs: u64, out: u64, bw: f64, tr: f64) -> Result<ChainPlan, String>}`
  - `channel::{Format { Cu8, Cf32 }, Format::sample_bytes, Format::parse, ChannelSpec { input_rate: u64, offset_hz: f64, bandwidth_hz: f64, transition_hz: f64, output_rate: u64, format: Format, gain: f32 }, ChannelDsp::new(spec) -> Result<_, String>, ChannelDsp::process(&mut self, i: &[f32], q: &[f32], out: &mut Vec<u8>) -> ProcessOutcome { samples: u64, saturated: u64 }, ChannelDsp::process_f32, ChannelDsp::reset, ChannelDsp::filter_taps, ChannelDsp::group_delay_samples, ChannelDsp::held_samples}`
  - Output count follows the single chain schedule of plan A12. After N input samples, a channel has emitted exactly `⌊N·out/fs⌋` samples, at every chunk boundary.

- [ ] **Step 1: Write the failing planner tests** (in `plan.rs`; values from research [3])

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn halfbands(p: &ChainPlan) -> usize { p.stages.iter().filter(|s| s.l == 1 && s.m == 2).count() }
    fn ratio(p: &ChainPlan) -> f64 { p.stages.iter().map(|s| s.l as f64 / s.m as f64).product() }
    #[test]
    fn stage_counts_match_research_table() {
        let d = |out: u64| (out as f64 * 0.95, out as f64 * 0.025);
        for &(fs, out, hb) in &[(2_048_000, 48_000, 5), (2_048_000, 24_000, 6), (2_048_000, 384_000, 2), (2_048_000, 250_000, 2), (2_048_000, 1_050_000, 0), (2_400_000, 48_000, 5), (2_400_000, 24_000, 6), (2_400_000, 384_000, 2), (2_400_000, 250_000, 3), (2_400_000, 1_050_000, 1)] {
            let (bw, tr) = d(out);
            let p = plan_chain(fs, out, bw, tr).unwrap();
            assert_eq!(halfbands(&p), hb, "{fs}->{out}");
            assert!((ratio(&p) - out as f64 / fs as f64).abs() < 1e-12, "{fs}->{out} exact ratio");
            for s in &p.stages {
                let n = crate::design::kaiser_len(crate::design::DESIGN_ATTENUATION_DB, (s.stop_hz - s.pass_hz) / (s.l as f64 * s.in_rate));
                assert!(n <= MAX_PROTOTYPE_TAPS, "{fs}->{out} prototype {n}");
            }
        }
    }
    #[test]
    fn splits_525_over_1024_into_two_rational_stages() {
        let p = plan_chain(2_048_000, 1_050_000, 997_500.0, 26_250.0).unwrap();
        assert_eq!(p.stages.len(), 2);
        assert!(p.stages[0].out_rate >= 1_050_000.0 * HALFBAND_MIN_RATIO);
    }
    #[test]
    fn identity_when_rates_match() {
        assert!(plan_chain(2_048_000, 2_048_000, 1_900_000.0, 50_000.0).unwrap().stages.is_empty());
    }
}
```

- [ ] **Step 2: Run them and confirm they fail.** `make chan-test`
- [ ] **Step 3: Implement `plan.rs`**

```rust
// native/wavekit-chan/src/plan.rs
use crate::design::{kaiser_len, DESIGN_ATTENUATION_DB};

pub const HALFBAND_MIN_RATIO: f64 = 1.1;
pub const MAX_PROTOTYPE_TAPS: usize = 16_384;

#[derive(Debug, Clone, PartialEq)]
pub struct StageSpec { pub l: usize, pub m: usize, pub in_rate: f64, pub out_rate: f64, pub pass_hz: f64, pub stop_hz: f64 }
#[derive(Debug, Clone, PartialEq)]
pub struct ChainPlan { pub stages: Vec<StageSpec> }

fn gcd(a: u64, b: u64) -> u64 { if b == 0 { a } else { gcd(b, a % b) } }
fn divisors(n: usize) -> Vec<usize> { (1..=n).filter(|d| n % d == 0).collect() }
fn proto_len(s: &StageSpec) -> usize { kaiser_len(DESIGN_ATTENUATION_DB, (s.stop_hz - s.pass_hz) / (s.l as f64 * s.in_rate)) }
fn cost(s: &StageSpec) -> f64 { s.out_rate * proto_len(s) as f64 / s.l as f64 }

/// Intermediate stages keep [-(bw/2+tr), bw/2+tr] alias-free (stop = out_rate − bw/2 − tr);
/// the final stage defines the channel (stop = bw/2 + tr). See plan assumption A5.
pub fn plan_chain(fs: u64, out: u64, bw: f64, tr: f64) -> Result<ChainPlan, String> {
    if out == 0 || out > fs { return Err(format!("output rate {out} must be within 1..={fs}")); }
    if out == fs { return Ok(ChainPlan { stages: vec![] }); }
    let (pass, guard) = (bw / 2.0, bw / 2.0 + tr);
    let mut stages = Vec::new();
    let mut r = fs;
    while r % 2 == 0 && (r / 2) as f64 >= out as f64 * HALFBAND_MIN_RATIO {
        stages.push(StageSpec { l: 1, m: 2, in_rate: r as f64, out_rate: (r / 2) as f64, pass_hz: pass, stop_hz: (r / 2) as f64 - guard });
        r /= 2;
    }
    let g = gcd(out, r);
    let (l, m) = ((out / g) as usize, (r / g) as usize);
    let last = StageSpec { l, m, in_rate: r as f64, out_rate: out as f64, pass_hz: pass, stop_hz: guard };
    if proto_len(&last) <= MAX_PROTOTYPE_TAPS { stages.push(last); return Ok(ChainPlan { stages }); }
    let mut best: Option<(f64, StageSpec, StageSpec)> = None;
    for l1 in divisors(l) {
        for m1 in divisors(m) {
            let r1 = r as f64 * l1 as f64 / m1 as f64;
            if !(r1 < r as f64 && r1 >= out as f64 * HALFBAND_MIN_RATIO) { continue; }
            let a = StageSpec { l: l1, m: m1, in_rate: r as f64, out_rate: r1, pass_hz: pass, stop_hz: r1 - guard };
            let b = StageSpec { l: l / l1, m: m / m1, in_rate: r1, out_rate: out as f64, pass_hz: pass, stop_hz: guard };
            if proto_len(&a) > MAX_PROTOTYPE_TAPS || proto_len(&b) > MAX_PROTOTYPE_TAPS { continue; }
            let c = cost(&a) + cost(&b);
            if best.as_ref().map_or(true, |(bc, _, _)| c < *bc) { best = Some((c, a, b)); }
        }
    }
    let (_, a, b) = best.ok_or_else(|| format!("no feasible rational split for {fs}->{out}"))?;
    stages.push(a);
    stages.push(b);
    Ok(ChainPlan { stages })
}
```

- [ ] **Step 4: Implement `channel.rs`**

```rust
// native/wavekit-chan/src/channel.rs
use crate::{convert::f32_to_cu8, design::lowpass, plan::{plan_chain, StageSpec}, stages::{Nco, RationalFir}};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format { Cu8, Cf32 }
impl Format {
    pub fn sample_bytes(self) -> usize { match self { Format::Cu8 => 2, Format::Cf32 => 8 } }
    pub fn parse(s: &str) -> Option<Self> { match s { "cu8" => Some(Format::Cu8), "cf32" => Some(Format::Cf32), _ => None } }
    pub fn as_str(self) -> &'static str { match self { Format::Cu8 => "cu8", Format::Cf32 => "cf32" } }
}

#[derive(Debug, Clone)]
pub struct ChannelSpec { pub input_rate: u64, pub offset_hz: f64, pub bandwidth_hz: f64, pub transition_hz: f64, pub output_rate: u64, pub format: Format, pub gain: f32 }

pub struct ProcessOutcome { pub samples: u64, pub saturated: u64 }

pub struct ChannelDsp {
    spec: ChannelSpec, nco: Nco, stages: Vec<RationalFir>, filter_taps: usize, group_delay: f64,
    // One absolute output schedule for the whole chain (plan A12): cumulative output is ⌊n_in·num/den⌋.
    num: u64, den: u64, n_in: u64, emitted: u64, held_i: Vec<f32>, held_q: Vec<f32>,
}

fn design(s: &StageSpec) -> Vec<f32> {
    let proto_rate = s.l as f64 * s.in_rate;
    lowpass((s.pass_hz + s.stop_hz) / 2.0 / proto_rate, (s.stop_hz - s.pass_hz) / proto_rate, s.l as f64)
}
fn gcd(a: u64, b: u64) -> u64 { if b == 0 { a } else { gcd(b, a % b) } }

impl ChannelDsp {
    pub fn new(spec: ChannelSpec) -> Result<Self, String> {
        let plan = plan_chain(spec.input_rate, spec.output_rate, spec.bandwidth_hz, spec.transition_hz)?;
        let mut stages = Vec::new();
        let (mut taps, mut delay_s) = (0usize, 0.0f64);
        for s in &plan.stages {
            let proto = design(s);
            taps += proto.len();
            delay_s += (proto.len() as f64 - 1.0) / 2.0 / (s.l as f64 * s.in_rate);
            stages.push(RationalFir::new(s.l, s.m, &proto));
        }
        let g = gcd(spec.output_rate, spec.input_rate);
        Ok(ChannelDsp {
            nco: Nco::new(spec.offset_hz, spec.input_rate as f64), group_delay: delay_s * spec.output_rate as f64, filter_taps: taps, stages,
            num: spec.output_rate / g, den: spec.input_rate / g, n_in: 0, emitted: 0, held_i: Vec::new(), held_q: Vec::new(), spec,
        })
    }
    pub fn filter_taps(&self) -> usize { self.filter_taps }
    pub fn group_delay_samples(&self) -> f64 { self.group_delay }
    pub fn format(&self) -> Format { self.spec.format }
    /// Samples produced by the chain but not yet due under the A12 schedule (≤ stages.len()).
    pub fn held_samples(&self) -> usize { self.held_i.len() }
    /// Fresh-start state (NCO index, filter history, polyphase phase, A12 schedule); used for input gaps.
    pub fn reset(&mut self) {
        self.nco.reset();
        for s in &mut self.stages { s.reset(); }
        self.n_in = 0;
        self.emitted = 0;
        self.held_i.clear();
        self.held_q.clear();
    }
    /// Runs NCO + stages, then releases exactly the samples the chain schedule makes due (plan A12).
    /// Each stage emits ⌈n·l/m⌉ (Task 12), so the chain is never short of ⌊n_in·num/den⌋; the surplus waits in `held_*`.
    fn run_chain(&mut self, i: &[f32], q: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let (mut ai, mut aq) = (i.to_vec(), q.to_vec());
        self.nco.mix(&mut ai, &mut aq);
        for st in &mut self.stages {
            let (mut bi, mut bq) = (Vec::with_capacity(ai.len()), Vec::with_capacity(aq.len()));
            st.process(&ai, &aq, &mut bi, &mut bq);
            ai = bi;
            aq = bq;
        }
        self.held_i.extend_from_slice(&ai);
        self.held_q.extend_from_slice(&aq);
        self.n_in += i.len() as u64;
        let due = (self.n_in as u128 * self.num as u128 / self.den as u128) as u64;
        let want = (due - self.emitted) as usize;
        debug_assert!(want <= self.held_i.len(), "schedule starved: {want} due, {} held (plan A12)", self.held_i.len());
        let release = want.min(self.held_i.len());
        let rest_i = self.held_i.split_off(release);
        let rest_q = self.held_q.split_off(release);
        self.emitted += release as u64;
        debug_assert!(rest_i.len() <= self.stages.len(), "held {} > {} stages (plan A12)", rest_i.len(), self.stages.len());
        (std::mem::replace(&mut self.held_i, rest_i), std::mem::replace(&mut self.held_q, rest_q))
    }
    pub fn process(&mut self, i: &[f32], q: &[f32], out: &mut Vec<u8>) -> ProcessOutcome {
        let (ai, aq) = self.run_chain(i, q);
        let mut saturated = 0u64;
        match self.spec.format {
            Format::Cf32 => for k in 0..ai.len() { out.extend_from_slice(&ai[k].to_le_bytes()); out.extend_from_slice(&aq[k].to_le_bytes()); },
            Format::Cu8 => for k in 0..ai.len() {
                let (bi, si) = f32_to_cu8(ai[k], self.spec.gain);
                let (bq, sq) = f32_to_cu8(aq[k], self.spec.gain);
                out.push(bi); out.push(bq);
                saturated += (si || sq) as u64;
            },
        }
        ProcessOutcome { samples: ai.len() as u64, saturated }
    }
    /// f32 output for property tests (no encoding); same schedule as `process`.
    pub fn process_f32(&mut self, i: &[f32], q: &[f32]) -> (Vec<f32>, Vec<f32>) { self.run_chain(i, q) }
}
```

- [ ] **Step 5: Write the property tests** (`tests/dsp_properties.rs`)

```rust
// native/wavekit-chan/tests/dsp_properties.rs
use proptest::prelude::*;
use std::f64::consts::{PI, TAU};
use wavekit_chan::channel::{ChannelDsp, ChannelSpec, Format};
use wavekit_chan::convert::InputAssembler;

const OUTS: [u64; 5] = [24_000, 48_000, 250_000, 384_000, 1_050_000];
fn spec(fs: u64, out: u64, off: f64, format: Format) -> ChannelSpec {
    ChannelSpec { input_rate: fs, offset_hz: off, bandwidth_hz: out as f64 * 0.95, transition_hz: out as f64 * 0.025, output_rate: out, format, gain: 1.0 }
}
fn tone(fs: u64, f: f64, amp: f64, n: usize) -> (Vec<f32>, Vec<f32>) {
    (0..n).map(|k| { let p = TAU * f * k as f64 / fs as f64; ((amp * p.cos()) as f32, (amp * p.sin()) as f32) }).unzip()
}
/// Correlates against e^{j2π·f_norm·n}, with n the ABSOLUTE output index k0 + k. Then every slice of a
/// tone at f_norm returns the same phase. With a slice-relative index, block b's phase would lead block a's by
/// 2π·f_norm·4096 (mod 2π).
fn correlate(i: &[f32], q: &[f32], k0: usize, f_norm: f64) -> (f64, f64) {
    let (mut re, mut im) = (0.0, 0.0);
    for k in 0..i.len() { let p = -TAU * f_norm * (k0 + k) as f64; let (c, s) = (p.cos(), p.sin()); re += i[k] as f64 * c - q[k] as f64 * s; im += i[k] as f64 * s + q[k] as f64 * c; }
    let n = i.len() as f64;
    ((re * re + im * im).sqrt() / n, im.atan2(re))
}
fn wrap(x: f64) -> f64 { (x + PI).rem_euclid(TAU) - PI }
fn fs_strategy() -> impl Strategy<Value = u64> { prop_oneof![Just(2_048_000u64), Just(2_400_000u64)] }
const MAX_STAGES: usize = 7; // 2.4 Msps → 24 kHz: six halfbands + 16/25

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Feature: core-channelizer, Property 3: Exact rate
    // Validates: addendum §2, §12.3; plan A12
    #[test]
    fn exact_rate(fs in fs_strategy(), oi in 0usize..5, n in 1usize..400_000, mut cuts in proptest::collection::vec(0usize..400_000, 0..8)) {
        let out = OUTS[oi];
        let mut dsp = ChannelDsp::new(spec(fs, out, 0.0, Format::Cu8)).unwrap();
        cuts.sort_unstable();
        let (mut fed, mut got) = (0usize, 0u64);
        for &c in cuts.iter().chain(std::iter::once(&n)) {
            let c = c.min(n).max(fed);
            let z = vec![0f32; c - fed];
            got += dsp.process_f32(&z, &z).0.len() as u64;
            fed = c;
            let ideal = (fed as u128 * out as u128 / fs as u128) as u64;
            // The addendum allows ±1. The A12 schedule is exact at every chunk boundary, so assert equality.
            prop_assert_eq!(got, ideal, "{}->{} after {} samples", fs, out, fed);
            prop_assert!(dsp.held_samples() <= MAX_STAGES);
        }
    }

    // Feature: core-channelizer, Property 4: Chunk-split independence
    // Validates: addendum §12.4
    #[test]
    fn chunk_split_independence(fs in fs_strategy(), oi in 0usize..4, bytes in proptest::collection::vec(any::<u8>(), 2..60_000), mut cuts in proptest::collection::vec(0usize..60_000, 0..12)) {
        let out = OUTS[oi];
        let run = |cuts: &[usize]| {
            let mut dsp = ChannelDsp::new(spec(fs, out, 50_000.0, Format::Cu8)).unwrap();
            let mut asm = InputAssembler::default();
            let mut out_bytes = Vec::new();
            let mut last = 0;
            for &c in cuts.iter().chain(std::iter::once(&bytes.len())) {
                let c = c.min(bytes.len()).max(last);
                let (mut i, mut q) = (Vec::new(), Vec::new());
                asm.push(&bytes[last..c], &mut i, &mut q);
                dsp.process(&i, &q, &mut out_bytes);
                last = c;
            }
            out_bytes
        };
        cuts.sort_unstable();
        prop_assert_eq!(run(&[]), run(&cuts));
    }

    // Feature: core-channelizer, Property 5: Translation and passband
    // Validates: addendum §12.5
    #[test]
    fn translation_and_passband(fs in fs_strategy(), oi in 0usize..5, off_frac in -0.3f64..0.3, g_frac in -0.42f64..0.42) {
        let out = OUTS[oi];
        let usable = fs as f64 * 0.8 / 2.0 - out as f64 / 2.0;
        let off = (off_frac / 0.3) * usable.max(0.0);
        let g = g_frac * out as f64;
        let mut dsp = ChannelDsp::new(spec(fs, out, off, Format::Cf32)).unwrap();
        let skip = dsp.group_delay_samples().ceil() as usize + 64;
        let n_out = skip + 8192;
        let n_in = (n_out as u128 * fs as u128 / out as u128) as usize + 1024;
        let (i, q) = tone(fs, off + g, 0.5, n_in);
        let (oi_, oq_) = dsp.process_f32(&i, &q);
        let f_norm = g / out as f64;
        let a = correlate(&oi_[skip..skip + 4096], &oq_[skip..skip + 4096], skip, f_norm);
        let b = correlate(&oi_[skip + 4096..skip + 8192], &oq_[skip + 4096..skip + 8192], skip + 4096, f_norm);
        prop_assert!((20.0 * (a.0 / 0.5).log10()).abs() <= 0.1, "amplitude a {}", a.0);
        prop_assert!((20.0 * (b.0 / 0.5).log10()).abs() <= 0.1, "amplitude b {}", b.0);
        // On the absolute output index both blocks see the same constant phase φ0, so continuity means equal phases.
        prop_assert!(wrap(a.1 - b.1).abs() < 1e-2, "phase continuity {} {}", a.1, b.1);
    }

    // Feature: core-channelizer, Property 6: Stopband and image
    // Validates: addendum §12.6
    #[test]
    fn stopband_and_image(fs in fs_strategy(), oi in 0usize..5, off_frac in -0.3f64..0.3, f_frac in -0.5f64..0.5, image in any::<bool>()) {
        let out = OUTS[oi];
        let usable = fs as f64 * 0.8 / 2.0 - out as f64 / 2.0;
        let off = (off_frac / 0.3) * usable.max(0.0);
        let guard = out as f64 * 0.95 / 2.0 + out as f64 * 0.025;
        let f = if image { -off - (f_frac * out as f64 * 0.4) } else { f_frac * fs as f64 };
        prop_assume!((f - off).abs() > guard);
        let mut dsp = ChannelDsp::new(spec(fs, out, off, Format::Cf32)).unwrap();
        let skip = dsp.group_delay_samples().ceil() as usize + 64;
        let n_in = ((skip + 4096) as u128 * fs as u128 / out as u128) as usize + 1024;
        let (i, q) = tone(fs, f, 0.5, n_in);
        let (oi_, oq_) = dsp.process_f32(&i, &q);
        let rms = (oi_[skip..skip + 4096].iter().zip(&oq_[skip..skip + 4096]).map(|(a, b)| (*a as f64).powi(2) + (*b as f64).powi(2)).sum::<f64>() / 4096.0).sqrt();
        prop_assert!(rms <= 0.5 * 1e-3, "{fs}->{out} f={f} off={off}: rms {rms}");
    }

    // Feature: core-channelizer, Property 7: Pass-through identity
    // Validates: addendum §3, §12.7
    #[test]
    fn pass_through_identity(fs in fs_strategy(), bytes in proptest::collection::vec(any::<u8>(), 0..20_000)) {
        let mut bytes = bytes; bytes.truncate(bytes.len() / 2 * 2);
        let mut dsp = ChannelDsp::new(ChannelSpec { input_rate: fs, offset_hz: 0.0, bandwidth_hz: fs as f64 * 0.9, transition_hz: fs as f64 * 0.04, output_rate: fs, format: Format::Cu8, gain: 1.0 }).unwrap();
        let (mut i, mut q) = (Vec::new(), Vec::new());
        InputAssembler::default().push(&bytes, &mut i, &mut q);
        let mut out = Vec::new();
        dsp.process(&i, &q, &mut out);
        prop_assert_eq!(out.len(), bytes.len());
        for (a, b) in out.iter().zip(&bytes) { prop_assert!((*a as i16 - *b as i16).abs() <= 1); }
    }
}

// Feature: core-channelizer, Property 3: Exact rate (10 s)
// Validates: addendum §12.3
#[test]
fn ten_seconds_error_at_most_one_sample() {
    let (fs, out) = (2_048_000u64, 48_000u64);
    let mut dsp = ChannelDsp::new(spec(fs, out, 0.0, Format::Cf32)).unwrap();
    let block = vec![0f32; 16_384];
    let mut total = 0u64;
    let mut fed = 0u64;
    while fed < fs * 10 { total += dsp.process_f32(&block, &block).0.len() as u64; fed += block.len() as u64; }
    let ideal = fed * out / fs;
    assert!((total as i64 - ideal as i64).abs() <= 1);
}

// Feature: core-channelizer, Property 3: Exact rate (ceiling-accumulation regressions)
// Validates: addendum §12.3; plan A12
#[test]
fn ceiling_accumulation_cases_are_exact() {
    // 2.048 Msps -> 48 kHz with N = 33: per-stage ceilings give 2 outputs against an ideal 0.
    for &(fs, out, n) in &[(2_048_000u64, 48_000u64, 33usize), (2_048_000, 24_000, 65), (2_400_000, 24_000, 101), (2_048_000, 1_050_000, 3), (2_400_000, 250_000, 9)] {
        let mut dsp = ChannelDsp::new(spec(fs, out, 0.0, Format::Cf32)).unwrap();
        let z = vec![0f32; n];
        assert_eq!(dsp.process_f32(&z, &z).0.len() as u64, n as u64 * out / fs, "{fs}->{out} n={n}");
        assert!(dsp.held_samples() <= MAX_STAGES);
    }
}
```

- [ ] **Step 6: Run the tests and confirm they pass.** `make chan-test`. Do not loosen any test.
  - If Property 6 misses the bound for one rate pair, raise `DESIGN_ATTENUATION_DB` (Task 11).
  - Property 3 is exact by construction (A12). A failure means `run_chain`'s schedule is wrong, or a stage breaks the ceiling rule that Task 12's `stage_emits_the_ceiling_of_the_ratio` pins. It is never a planner problem, and a debug-build `schedule starved` panic points to the same place.
  - Property 5 compares phases on the absolute output index, so a phase-continuity failure is a real DSP defect, not a test artefact. Likely causes are an NCO resync error, stage state lost between `process` calls, or held samples released out of order.
- [ ] **Step 7: Commit**

```bash
git add native/wavekit-chan/src/plan.rs native/wavekit-chan/src/channel.rs native/wavekit-chan/tests/dsp_properties.rs
git commit -m "feat(chan): halfband+rational chain planner and channel DSP (Properties 3-7)"
```

### Task 14: [D1] Rust admission and bounded queue

**Files:**
- Fill: `native/wavekit-chan/src/admission.rs`, `native/wavekit-chan/src/queue.rs`

**Interfaces:**
- Produces:
  - `admission::{ADMISSION_EPSILON_HZ = 1e-6, Reject { code: &'static str, detail: String }, admit(center: f64, bw: f64, tr: f64, out: u64, fs: u64, capture_center: f64, f: f64) -> Result<f64 /*offset*/, Reject>}`, where `code` is `"channel-outside-capture"` or `"channel-request-invalid"`. The arithmetic order is identical to Task 16.
  - `queue::{ChannelQueue::new(capacity_bytes: usize, sample_bytes: usize), push(&self, bytes: &[u8]) -> PushOutcome { accepted_samples: u64, dropped_samples: u64 }, pop_blocking(&self, max: usize, out: &mut Vec<u8>) -> bool, close(&self), high_water(&self) -> usize}`

- [ ] **Step 1: Write the failing tests**

```rust
// in admission.rs
#[cfg(test)]
mod tests {
    use super::*;
    // Feature: core-channelizer, Property 2: Admission rule
    // Validates: addendum §6, §12.2
    #[test]
    fn default_request_on_the_boundary_is_admitted() { // Review Focus 1
        let out = 48_000u64;
        let (bw, tr) = (out as f64 * (1.0 - 0.05), out as f64 * 0.05 / 2.0);
        assert!(admit(162e6, bw, tr, out, 2_048_000, 162e6, 0.8).is_ok());
    }
    #[test]
    fn outside_and_invalid() {
        assert_eq!(admit(162e6 + 900_000.0, 45_600.0, 1_200.0, 48_000, 2_048_000, 162e6, 0.8).unwrap_err().code, "channel-outside-capture");
        assert_eq!(admit(162e6, 50_000.0, 1_200.0, 48_000, 2_048_000, 162e6, 0.8).unwrap_err().code, "channel-request-invalid");
        assert_eq!(admit(f64::NAN, 1.0, 1.0, 48_000, 2_048_000, 162e6, 0.8).unwrap_err().code, "channel-request-invalid");
        assert_eq!(admit(162e6, 1.0, 1.0, 3_000_000, 2_048_000, 162e6, 0.8).unwrap_err().code, "channel-request-invalid");
    }
}
// in queue.rs
#[cfg(test)]
mod tests {
    use super::*;
    // Feature: core-channelizer, Property 8: Bounded queue (unit)
    // Validates: addendum §6, §12.8
    #[test]
    fn drops_whole_samples_beyond_capacity() {
        let q = ChannelQueue::new(10, 8); // cf32: room for one sample (8 B), not two
        let o = q.push(&[0u8; 24]);
        assert_eq!((o.accepted_samples, o.dropped_samples), (1, 2));
        assert!(q.high_water() <= 10);
        let mut buf = Vec::new();
        assert!(q.pop_blocking(1024, &mut buf));
        assert_eq!(buf.len(), 8);
        q.close();
        buf.clear();
        assert!(!q.pop_blocking(1024, &mut buf));
    }
}
```

- [ ] **Step 2: Run them and confirm they fail.** `make chan-test`
- [ ] **Step 3: Implement**

```rust
// native/wavekit-chan/src/admission.rs
pub const ADMISSION_EPSILON_HZ: f64 = 1e-6;
#[derive(Debug, Clone, PartialEq)]
pub struct Reject { pub code: &'static str, pub detail: String }
fn invalid(detail: String) -> Reject { Reject { code: "channel-request-invalid", detail } }

/// Same arithmetic order as src/core/channelizer/admission.ts (Property 1).
pub fn admit(center: f64, bw: f64, tr: f64, out: u64, fs: u64, capture_center: f64, f: f64) -> Result<f64, Reject> {
    if !(center.is_finite() && bw.is_finite() && tr.is_finite() && capture_center.is_finite()) { return Err(invalid("non-finite request".into())); }
    if bw <= 0.0 || tr <= 0.0 || out == 0 || out > fs { return Err(invalid(format!("bandwidth/transition must be > 0 and output rate within 1..={fs}"))); }
    let half_occupied = bw / 2.0 + tr;
    if half_occupied > out as f64 / 2.0 + ADMISSION_EPSILON_HZ { return Err(invalid(format!("bw/2+tr={half_occupied} exceeds out/2={}", out as f64 / 2.0))); }
    let offset = center - capture_center;
    let limit = fs as f64 * f / 2.0;
    if offset.abs() + half_occupied > limit + ADMISSION_EPSILON_HZ {
        return Err(Reject { code: "channel-outside-capture", detail: format!("|Δf|+bw/2+tr={} exceeds usable half-span {limit}", offset.abs() + half_occupied) });
    }
    Ok(offset)
}
```

```rust
// native/wavekit-chan/src/queue.rs
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};

pub struct PushOutcome { pub accepted_samples: u64, pub dropped_samples: u64 }
struct State { buf: VecDeque<u8>, closed: bool, high_water: usize }
pub struct ChannelQueue { state: Mutex<State>, cv: Condvar, capacity: usize, sample_bytes: usize }

impl ChannelQueue {
    pub fn new(capacity: usize, sample_bytes: usize) -> Self {
        ChannelQueue { state: Mutex::new(State { buf: VecDeque::with_capacity(capacity), closed: false, high_water: 0 }), cv: Condvar::new(), capacity, sample_bytes }
    }
    pub fn push(&self, bytes: &[u8]) -> PushOutcome {
        let mut s = self.state.lock().unwrap();
        let total = (bytes.len() / self.sample_bytes) as u64;
        if s.closed { return PushOutcome { accepted_samples: 0, dropped_samples: total }; }
        let room = (self.capacity - s.buf.len()) / self.sample_bytes;
        let take = (room as u64).min(total) as usize;
        s.buf.extend(&bytes[..take * self.sample_bytes]);
        s.high_water = s.high_water.max(s.buf.len());
        drop(s);
        if take > 0 { self.cv.notify_one(); }
        PushOutcome { accepted_samples: take as u64, dropped_samples: total - take as u64 }
    }
    pub fn pop_blocking(&self, max: usize, out: &mut Vec<u8>) -> bool {
        let mut s = self.state.lock().unwrap();
        while s.buf.is_empty() && !s.closed { s = self.cv.wait(s).unwrap(); }
        if s.buf.is_empty() { return false; }
        let n = s.buf.len().min(max);
        out.extend(s.buf.drain(..n));
        true
    }
    pub fn close(&self) { self.state.lock().unwrap().closed = true; self.cv.notify_all(); }
    pub fn high_water(&self) -> usize { self.state.lock().unwrap().high_water }
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** `make chan-test`
- [ ] **Step 5: Commit** `git add native/wavekit-chan/src/admission.rs native/wavekit-chan/src/queue.rs && git commit -m "feat(chan): admission rule and bounded whole-sample queue (Properties 2, 8)"`

### Task 15: [D1][D3] Protocol and process runtime

**Files:**
- Fill: `native/wavekit-chan/src/protocol.rs`, `native/wavekit-chan/src/runtime.rs`

**Interfaces:**
- Consumes: Tasks 9–14.
- Produces:
  - `protocol::{Request { Open(OpenReq), Close { id }, MarkGap { at_input_byte: Option<u64>, dropped_input_bytes: Option<u64> }, Shutdown }, OpenReq { id, center_hz, bandwidth_hz, transition_hz, output_rate_hz: u64, format: Format, gain: f32, queue_bytes: usize }, parse_request(line: &str) -> Result<Request, (String /*id or ""*/, String /*detail*/)>}`
  - `runtime::{Runtime::new(args, sink: Box<dyn FnMut(serde_json::Value) + Send>), on_request(&mut self, Request) -> Option<i32>, on_input(&mut self, &[u8]), on_eof(&mut self) -> i32, on_client_gone(&mut self, &str), maybe_stats(&mut self, now: Instant), run(args) -> i32}`
  - The process behaviour is exactly addendum § 11, with fd 3 control (A1), `mark-gap.atInputByte` (A2), the EOF drain (A7), the chain output schedule (A12) and drop-run reporting (A13).

- [ ] **Step 1: Write the failing protocol tests**

```rust
// in protocol.rs
#[cfg(test)]
mod tests {
    use super::*;
    // Feature: core-channelizer, Property 14: Protocol validity (Rust parse side)
    // Validates: addendum §11, §12.14
    #[test]
    fn parses_v1_and_rejects_everything_else() {
        let ok = parse_request(r#"{"v":1,"type":"open","id":"ais-g1","centerHz":162000000,"bandwidthHz":364800,"transitionHz":9600,"outputRateHz":384000,"format":"cu8","queueBytes":192000}"#);
        assert!(matches!(ok, Ok(Request::Open(_))));
        assert!(matches!(parse_request(r#"{"v":1,"type":"mark-gap","atInputByte":4096}"#), Ok(Request::MarkGap { at_input_byte: Some(4096), .. })));
        for bad in ["not json", r#"{"v":2,"type":"shutdown"}"#, r#"{"v":1,"type":"explode","id":"x"}"#, r#"{"v":1,"type":"open","id":"bad id!"}"#, r#"{"v":1,"type":"open","id":"a","extra":1}"#] {
            assert!(parse_request(bad).is_err(), "{bad}");
        }
        assert_eq!(parse_request(r#"{"v":1,"type":"explode","id":"x"}"#).unwrap_err().0, "x");
    }
}
```

- [ ] **Step 2: Write the failing runtime tests** (in `runtime.rs`, in-process with a collecting sink)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex};

    fn rt(dir: &std::path::Path) -> (Runtime, Arc<Mutex<Vec<serde_json::Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = { let e = events.clone(); Box::new(move |v| e.lock().unwrap().push(v)) };
        let args = crate::args::Args { generation: 7, input_rate: 2_048_000, input_center: 162e6, usable_fraction: 0.8, block_samples: 1024, socket_dir: dir.into(), control_fd: 3 };
        (Runtime::new(args, sink), events)
    }
    fn open(id: &str, center: f64, queue: usize) -> Request {
        parse_request(&format!(r#"{{"v":1,"type":"open","id":"{id}","centerHz":{center},"bandwidthHz":45600,"transitionHz":1200,"outputRateHz":48000,"format":"cf32","queueBytes":{queue}}}"#)).unwrap()
    }
    fn tmp() -> std::path::PathBuf { let p = std::path::PathBuf::from(format!("/tmp/wkchan-{}-{}", std::process::id(), rand_suffix())); std::fs::create_dir_all(&p).unwrap(); p }
    fn rand_suffix() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64 % 1_000_000_007 }

    // Feature: core-channelizer, Property 9: Generation stamping (process side)
    // Validates: addendum §11, §12.9
    #[test]
    fn opened_carries_generation_and_listens_first() {
        let dir = tmp();
        let (mut r, ev) = rt(&dir);
        assert!(r.on_request(open("a", 162e6, 96_000)).is_none());
        let e = ev.lock().unwrap().last().unwrap().clone();
        assert_eq!(e["type"], "opened");
        assert_eq!(e["generation"], 7);
        assert!(UnixStream::connect(e["socket"].as_str().unwrap()).is_ok());
    }
    #[test]
    fn rejects_outside_and_duplicate_without_exiting() {
        let dir = tmp();
        let (mut r, ev) = rt(&dir);
        assert!(r.on_request(open("a", 162e6 + 900_000.0, 96_000)).is_none());
        assert_eq!(ev.lock().unwrap().last().unwrap()["reasonCode"], "channel-outside-capture");
        r.on_request(open("b", 162e6, 96_000));
        r.on_request(open("b", 162e6, 96_000));
        assert_eq!(ev.lock().unwrap().last().unwrap()["reasonCode"], "channel-request-invalid");
    }
    // Feature: core-channelizer, Property 8: Bounded queue (runtime)
    // Validates: addendum §12.8; plan A13
    #[test]
    fn overflow_reports_discontinuity_with_gap_size() {
        let dir = tmp();
        let (mut r, ev) = rt(&dir);
        r.on_request(open("slow", 162e6, 800)); // 100 cf32 samples; the client never connects
        let block = vec![128u8; 2 * 2_048_000 / 10]; // 204 800 input samples → exactly 4 800 output samples (A12)
        let overflows = |ev: &Arc<Mutex<Vec<serde_json::Value>>>| ev.lock().unwrap().iter().filter(|e| e["cause"] == "queue-overflow").cloned().collect::<Vec<_>>();
        r.on_input(&block); // accepts 0..100, drops 100..4800: the run is open, nothing emitted yet
        assert!(overflows(&ev).is_empty());
        r.drain_queue_for_test("slow");
        r.on_input(&block); // accepts 4800..4900, which ends run 1; drops 4900..9600, which opens run 2
        let d = overflows(&ev);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0]["sampleIndex"].as_u64(), d[0]["droppedSamples"].as_u64()), (Some(100), Some(4_700)));
        r.on_eof_no_exit_for_test(); // a run still open at EOF is reported before input-eof
        let d = overflows(&ev);
        assert_eq!(d.len(), 2);
        assert_eq!((d[1]["sampleIndex"].as_u64(), d[1]["droppedSamples"].as_u64()), (Some(4_900), Some(4_700)));
    }
    // Feature: core-channelizer, Property 12: Input-gap marking
    // Validates: addendum §4, §12.12
    #[test]
    fn mark_gap_resets_at_the_exact_byte() {
        let pre: Vec<u8> = (0..40_000u32).map(|k| (k * 31 % 256) as u8).collect();
        let post: Vec<u8> = (0..80_000u32).map(|k| (k * 17 % 256) as u8).collect();
        // a: pre + post in one read, with the gap marked at the seam byte
        let dir_a = tmp();
        let (mut a, ev_a) = rt(&dir_a);
        a.on_request(open("g", 162e6 + 10_000.0, 1 << 22));
        let sock_a = ev_a.lock().unwrap().last().unwrap()["socket"].as_str().unwrap().to_string();
        let mut ca = UnixStream::connect(&sock_a).unwrap();
        a.on_request(Request::MarkGap { at_input_byte: Some(pre.len() as u64), dropped_input_bytes: Some(512) });
        a.on_input(&[pre.clone(), post.clone()].concat());
        // b: a fresh runtime fed only the post-gap input
        let dir_b = tmp();
        let (mut b, ev_b) = rt(&dir_b);
        b.on_request(open("g", 162e6 + 10_000.0, 1 << 22));
        let sock_b = ev_b.lock().unwrap().last().unwrap()["socket"].as_str().unwrap().to_string();
        let mut cb = UnixStream::connect(&sock_b).unwrap();
        b.on_input(&post);
        a.on_eof_no_exit_for_test();
        b.on_eof_no_exit_for_test();
        let (mut out_a, mut out_b) = (Vec::new(), Vec::new());
        ca.read_to_end(&mut out_a).unwrap();
        cb.read_to_end(&mut out_b).unwrap();

        let gaps: Vec<serde_json::Value> = ev_a.lock().unwrap().iter().filter(|e| e["cause"] == "input-gap").cloned().collect();
        assert_eq!(gaps.len(), 1);
        let pre_out = (pre.len() / 2) as u64 * 48_000 / 2_048_000; // A12: exactly ⌊N·out/fs⌋ before the seam
        assert_eq!(gaps[0]["sampleIndex"].as_u64(), Some(pre_out));
        // The reset is total (NCO, filter history, polyphase phase, A12 schedule), so everything after the seam
        // is byte-identical to the fresh run. No group-delay skip is needed. If a partial reset is ever introduced,
        // skip ceil(groupDelaySamples) output samples (from the `opened` event) on both sides instead of a constant.
        assert!(!out_b.is_empty());
        assert!(out_a.len() >= out_b.len());
        let seam = out_a.len() - out_b.len();
        assert_eq!(seam as u64, pre_out * 8, "seam must sit after exactly the pre-gap cf32 samples");
        assert_eq!(&out_a[seam..], &out_b[..]);
    }
    // Review Focus 7: close() must not hang on a writer blocked in write_all (client stopped reading) or on a
    // destroyed client, and the other channels keep flowing. Before the fix, close("requested") joined the writer,
    // which was stuck in write_all or in tx.send(ClientGone) on the full sync_channel(1).
    #[test]
    fn close_of_a_stalled_or_destroyed_client_returns_promptly_and_others_keep_flowing() {
        let dir = tmp();
        let (mut r, ev) = rt(&dir);
        let sock = |ev: &Arc<Mutex<Vec<serde_json::Value>>>| ev.lock().unwrap().last().unwrap()["socket"].as_str().unwrap().to_string();
        r.on_request(open("stalled", 162e6, 1 << 24));
        let _stalled = UnixStream::connect(sock(&ev)).unwrap(); // connected, never reads
        r.on_request(open("gone", 162e6, 1 << 24));
        drop(UnixStream::connect(sock(&ev)).unwrap()); // destroyed client
        r.on_request(open("live", 162e6, 1 << 24));
        let live = UnixStream::connect(sock(&ev)).unwrap();
        let reader = std::thread::spawn(move || { let mut live = live; let mut out = Vec::new(); live.read_to_end(&mut out).unwrap(); out });
        // 1 s of input → exactly 48 000 cf32 samples (A12) = 384 000 B per channel, far past any socket buffer
        let block = vec![128u8; 2 * 2_048_000];
        r.on_input(&block);
        std::thread::sleep(std::time::Duration::from_millis(200)); // the stalled writer is now blocked in write_all
        let t = std::time::Instant::now();
        r.on_request(Request::Close { id: "stalled".into() });
        r.on_request(Request::Close { id: "gone".into() });
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "close blocked for {:?}", t.elapsed());
        let closed: Vec<String> = ev.lock().unwrap().iter().filter(|e| e["type"] == "closed").map(|e| e["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(closed, vec!["stalled".to_string(), "gone".to_string()]);
        r.on_input(&block);
        r.on_eof_no_exit_for_test();
        let out = reader.join().unwrap();
        assert_eq!(out.len(), 2 * 48_000 * 8, "the live channel got every sample of both blocks");
    }
    // Feature: core-channelizer, Property 13: EOF tail
    // Validates: addendum §11, §12.13
    #[test]
    fn eof_counts_trailing_odd_byte() {
        let dir = tmp();
        let (mut r, ev) = rt(&dir);
        r.on_input(&[1, 2, 3]);
        assert_eq!(r.on_eof(), 0);
        let e = ev.lock().unwrap().last().unwrap().clone();
        assert_eq!((e["type"].as_str(), e["discardedBytes"].as_u64(), e["inputSamples"].as_u64()), (Some("input-eof"), Some(1), Some(1)));
    }
}
```

`close_of_a_stalled_or_destroyed_client_returns_promptly_and_others_keep_flowing` pins the close path: `ClientGone` travels on its own unbounded channel (never the bounded input channel), `close()` shuts the writer's cloned stream down before a bounded join (500 ms, then detach), and a writer that accepts after `closing` is set exits at once. `overflow_reports_discontinuity_with_gap_size` pins the A13 rule: a run is emitted when a later push is accepted, or at close/EOF. A push that accepts nothing (the stalled reader) extends the run. `mark_gap_resets_at_the_exact_byte` is exact because the reset is total and the A12 schedule makes the pre-gap output count deterministic.

- [ ] **Step 3: Run them and confirm they fail.** `make chan-test`
- [ ] **Step 4: Implement `protocol.rs`**

```rust
// native/wavekit-chan/src/protocol.rs
use crate::channel::Format;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct OpenReq { pub id: String, pub center_hz: f64, pub bandwidth_hz: f64, pub transition_hz: f64, pub output_rate_hz: u64, pub format: Format, pub gain: f32, pub queue_bytes: usize }
#[derive(Debug, Clone, PartialEq)]
pub enum Request { Open(OpenReq), Close { id: String }, MarkGap { at_input_byte: Option<u64>, dropped_input_bytes: Option<u64> }, Shutdown }

pub fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-') }

fn only(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    match obj.keys().find(|k| !keys.contains(&k.as_str())) { Some(k) => Err(format!("unknown field {k}")), None => Ok(()) }
}

pub fn parse_request(line: &str) -> Result<Request, (String, String)> {
    let v: Value = serde_json::from_str(line).map_err(|e| (String::new(), format!("invalid JSON: {e}")))?;
    let obj = v.as_object().ok_or_else(|| (String::new(), "request must be an object".to_string()))?;
    let id = obj.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let err = |d: String| (id.clone(), d);
    if obj.get("v").and_then(Value::as_u64) != Some(1) { return Err(err("v must be 1".into())); }
    let num = |k: &str| obj.get(k).and_then(Value::as_f64).ok_or_else(|| err(format!("{k} must be a number")));
    let uint = |k: &str| obj.get(k).and_then(Value::as_u64).ok_or_else(|| err(format!("{k} must be a non-negative integer")));
    match obj.get("type").and_then(Value::as_str) {
        Some("open") => {
            only(obj, &["v", "type", "id", "centerHz", "bandwidthHz", "transitionHz", "outputRateHz", "format", "gain", "queueBytes"]).map_err(err)?;
            if !valid_id(&id) { return Err(err("id must match [A-Za-z0-9._-]{1,64}".into())); }
            let format = obj.get("format").and_then(Value::as_str).and_then(Format::parse).ok_or_else(|| err("format must be cu8|cf32".into()))?;
            let gain = match obj.get("gain") { None => 1.0, Some(g) => g.as_f64().filter(|g| *g > 0.0 && g.is_finite()).ok_or_else(|| err("gain must be > 0".into()))? as f32 };
            if obj.contains_key("gain") && format != Format::Cu8 { return Err(err("gain is cu8 only".into())); }
            Ok(Request::Open(OpenReq { id: id.clone(), center_hz: num("centerHz")?, bandwidth_hz: num("bandwidthHz")?, transition_hz: num("transitionHz")?, output_rate_hz: uint("outputRateHz")?, format, gain, queue_bytes: uint("queueBytes")? as usize }))
        }
        Some("close") => { only(obj, &["v", "type", "id"]).map_err(err)?; if !valid_id(&id) { return Err(err("bad id".into())); } Ok(Request::Close { id: id.clone() }) }
        Some("mark-gap") => {
            only(obj, &["v", "type", "atInputByte", "droppedInputBytes"]).map_err(err)?;
            Ok(Request::MarkGap { at_input_byte: obj.get("atInputByte").and_then(Value::as_u64), dropped_input_bytes: obj.get("droppedInputBytes").and_then(Value::as_u64) })
        }
        Some("shutdown") => { only(obj, &["v", "type"]).map_err(err)?; Ok(Request::Shutdown) }
        _ => Err(err("unknown request type".into())),
    }
}
```

- [ ] **Step 5: Implement `runtime.rs`**

```rust
// native/wavekit-chan/src/runtime.rs
use crate::{admission, args::Args, channel::{ChannelDsp, ChannelSpec, Format}, convert::InputAssembler, protocol::{parse_request, OpenReq, Request}, queue::ChannelQueue};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::fd::FromRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const STATS_EVERY: Duration = Duration::from_secs(5);
const CLOSE_JOIN_BUDGET: Duration = Duration::from_millis(500);

/// Bounded main channel (≤ 2 input blocks in flight). ClientGone is NOT on it: a writer must never block on a
/// channel the stdin thread may have filled while the main thread waits on that writer in close().
enum Msg { Input(Vec<u8>), InputEof, Control(Result<Request, (String, String)>), ControlEof }

/// The writer's connection, shared with close(). close() sets `closing` and shuts the stream down, so a writer blocked
/// in write_all to a client that stopped reading fails at once instead of blocking close() (and the main loop).
#[derive(Default)]
struct Conn { closing: bool, stream: Option<UnixStream> }
type ConnSlot = Arc<Mutex<Conn>>;

struct Open {
    dsp: ChannelDsp, queue: Arc<ChannelQueue>, socket: PathBuf, writer: Option<thread::JoinHandle<()>>, conn: ConnSlot,
    out_samples: u64, dropped: u64, saturated: u64, gap: Option<(u64, u64)>, // (sampleIndex, dropped)
}

pub struct Runtime {
    args: Args, sink: Box<dyn FnMut(Value) + Send>, asm: InputAssembler, channels: HashMap<String, Open>,
    pending_gap: Option<(u64, u64)>, last_stats: Instant, gone: Option<mpsc::Sender<String>>, // unbounded: never blocks a writer
}

/// Joins a writer for at most `budget`, then detaches it. A stuck writer must never block the main loop.
fn join_bounded(w: thread::JoinHandle<()>, budget: Duration) {
    let deadline = Instant::now() + budget;
    while !w.is_finished() && Instant::now() < deadline { thread::sleep(Duration::from_millis(5)); }
    if w.is_finished() { let _ = w.join(); }
}

impl Runtime {
    pub fn new(args: Args, sink: Box<dyn FnMut(Value) + Send>) -> Self {
        Runtime { args, sink, asm: InputAssembler::default(), channels: HashMap::new(), pending_gap: None, last_stats: Instant::now(), gone: None }
    }
    fn emit(&mut self, mut v: Value) { v["v"] = json!(1); v["generation"] = json!(self.args.generation); (self.sink)(v) }
    fn reject(&mut self, id: &str, code: &str, detail: String) { self.emit(json!({"type": "rejected", "id": id, "reasonCode": code, "detail": detail})) }

    pub fn on_request(&mut self, req: Request) -> Option<i32> {
        match req {
            Request::Open(o) => self.open(o),
            Request::Close { id } => self.close(&id, "requested"),
            Request::MarkGap { at_input_byte, dropped_input_bytes } => {
                let at = at_input_byte.unwrap_or(self.asm.consumed_bytes + self.asm.carry.is_some() as u64);
                self.pending_gap = Some((at, dropped_input_bytes.unwrap_or(0)));
            }
            Request::Shutdown => return Some(self.shutdown()),
        }
        None
    }

    fn open(&mut self, o: OpenReq) {
        if self.channels.contains_key(&o.id) { return self.reject(&o.id, "channel-request-invalid", "duplicate channel id".into()); }
        let offset = match admission::admit(o.center_hz, o.bandwidth_hz, o.transition_hz, o.output_rate_hz, self.args.input_rate, self.args.input_center, self.args.usable_fraction) {
            Ok(off) => off,
            Err(r) => return self.reject(&o.id, r.code, r.detail),
        };
        let spec = ChannelSpec { input_rate: self.args.input_rate, offset_hz: offset, bandwidth_hz: o.bandwidth_hz, transition_hz: o.transition_hz, output_rate: o.output_rate_hz, format: o.format, gain: o.gain };
        let dsp = match ChannelDsp::new(spec) { Ok(d) => d, Err(e) => return self.reject(&o.id, "channel-request-invalid", e) };
        if o.queue_bytes < o.format.sample_bytes() { return self.reject(&o.id, "channel-request-invalid", "queueBytes below one sample".into()); }
        let socket = self.args.socket_dir.join(format!("{}.sock", o.id));
        let _ = std::fs::remove_file(&socket);
        let listener = match UnixListener::bind(&socket) { Ok(l) => l, Err(e) => return self.reject(&o.id, "channel-request-invalid", format!("bind {}: {e}", socket.display())) };
        let queue = Arc::new(ChannelQueue::new(o.queue_bytes, o.format.sample_bytes()));
        let conn: ConnSlot = Arc::new(Mutex::new(Conn::default()));
        let writer = { let (q, p, gone, id, c) = (queue.clone(), socket.clone(), self.gone.clone(), o.id.clone(), conn.clone()); thread::spawn(move || writer(listener, p, q, gone, id, c)) };
        let (taps, delay) = (dsp.filter_taps(), dsp.group_delay_samples());
        self.channels.insert(o.id.clone(), Open { dsp, queue, socket: socket.clone(), writer: Some(writer), conn, out_samples: 0, dropped: 0, saturated: 0, gap: None });
        self.emit(json!({"type": "opened", "id": o.id, "socket": socket.to_string_lossy(), "outputRateHz": o.output_rate_hz, "format": o.format.as_str(), "filterTaps": taps, "groupDelaySamples": delay}));
    }

    fn close(&mut self, id: &str, reason: &str) {
        if let Some(mut ch) = self.channels.remove(id) {
            if let Some(e) = overflow_event(id, &mut ch) { self.emit(e); } // A13: report an open run before `closed`
            {
                let mut c = ch.conn.lock().unwrap();
                c.closing = true;
                // Unblocks a writer stuck in write_all to a client that stopped reading (or vanished).
                if let Some(s) = c.stream.take() { let _ = s.shutdown(Shutdown::Both); }
            }
            ch.queue.close();
            let _ = UnixStream::connect(&ch.socket); // wakes a writer still blocked in accept(); it sees `closing` and exits
            let _ = std::fs::remove_file(&ch.socket);
            if let Some(w) = ch.writer.take() { join_bounded(w, CLOSE_JOIN_BUDGET); }
            self.emit(json!({"type": "closed", "id": id, "reason": reason}));
        }
    }
    pub fn on_client_gone(&mut self, id: &str) { self.close(id, "client-gone") }

    pub fn on_input(&mut self, bytes: &[u8]) {
        let (mut i, mut q) = (Vec::new(), Vec::new());
        let first_sample = self.asm.consumed_bytes / 2;
        self.asm.push(bytes, &mut i, &mut q);
        let mut start = 0usize;
        if let Some((at, dropped_in)) = self.pending_gap {
            let seam = ((at + 1) / 2).saturating_sub(first_sample) as usize;
            if seam <= i.len() {
                self.feed(&i[..seam], &q[..seam]);
                self.pending_gap = None;
                let ids: Vec<String> = self.channels.keys().cloned().collect();
                for id in ids {
                    let (overflow, idx, dropped) = {
                        let ch = self.channels.get_mut(&id).unwrap();
                        let overflow = overflow_event(&id, ch); // A13: an open drop run is reported before the gap
                        ch.dsp.reset(); // NCO index, filter history, polyphase phase and the A12 schedule
                        (overflow, ch.out_samples, dropped_in / 2 * ch.dsp.output_rate() / self.args.input_rate)
                    };
                    if let Some(e) = overflow { self.emit(e); }
                    self.emit(json!({"type": "discontinuity", "id": id, "sampleIndex": idx, "droppedSamples": dropped, "cause": "input-gap"}));
                }
                start = seam;
            }
        }
        self.feed(&i[start..], &q[start..]);
    }

    fn feed(&mut self, i: &[f32], q: &[f32]) {
        if i.is_empty() { return; }
        let mut events = Vec::new();
        for (id, ch) in self.channels.iter_mut() {
            let mut out = Vec::new();
            let r = ch.dsp.process(i, q, &mut out);
            ch.saturated += r.saturated;
            let p = ch.queue.push(&out);
            // A13: any accepted sample ends the open drop run. Within a push, accepted samples precede dropped ones.
            if p.accepted_samples > 0 {
                if let Some(e) = overflow_event(id, ch) { events.push(e); }
            }
            if p.dropped_samples > 0 {
                let start = ch.out_samples + p.accepted_samples;
                let g = ch.gap.get_or_insert((start, 0));
                g.1 += p.dropped_samples;
                ch.dropped += p.dropped_samples;
            }
            ch.out_samples += r.samples;
        }
        for e in events { self.emit(e); }
    }

    pub fn maybe_stats(&mut self, now: Instant) {
        if now.duration_since(self.last_stats) < STATS_EVERY { return; }
        self.last_stats = now;
        let channels: Vec<Value> = self.channels.iter().map(|(id, c)| json!({"id": id, "outputSamples": c.out_samples, "queueHighWaterBytes": c.queue.high_water(), "droppedSamples": c.dropped, "saturatedSamples": c.saturated})).collect();
        let input = self.asm.consumed_bytes / 2;
        self.emit(json!({"type": "stats", "inputSamples": input, "channels": channels}));
    }

    /// EOF: drain queues to clients (A7), emit input-eof, exit 0.
    pub fn on_eof(&mut self) -> i32 {
        self.drain_all(Duration::from_secs(2));
        let (input, discarded) = (self.asm.consumed_bytes / 2, self.asm.discarded());
        self.emit(json!({"type": "input-eof", "inputSamples": input, "discardedBytes": discarded}));
        0
    }
    fn drain_all(&mut self, budget: Duration) {
        let deadline = Instant::now() + budget;
        let mut writers = Vec::new();
        let mut events = Vec::new();
        for (id, mut ch) in self.channels.drain() {
            if let Some(e) = overflow_event(&id, &mut ch) { events.push(e); } // A13: before input-eof
            ch.conn.lock().unwrap().closing = true; // a writer that never accepted exits; connected writers still flush (A7)
            ch.queue.close();
            let _ = UnixStream::connect(&ch.socket); // wakes a writer still blocked in accept()
            if let Some(w) = ch.writer.take() { writers.push(w); }
            let _ = std::fs::remove_file(&ch.socket);
        }
        for e in events { self.emit(e); }
        while writers.iter().any(|w| !w.is_finished()) && Instant::now() < deadline { thread::sleep(Duration::from_millis(10)); }
    }
    pub fn shutdown(&mut self) -> i32 {
        let ids: Vec<String> = self.channels.keys().cloned().collect();
        for id in ids { self.close(&id, "requested"); }
        0
    }

    #[cfg(test)] pub fn drain_queue_for_test(&mut self, id: &str) { let ch = &self.channels[id]; let mut b = Vec::new(); while ch.queue.high_water() > 0 && { b.clear(); ch.queue.try_pop_for_test(&mut b) } {} }
    #[cfg(test)] pub fn on_eof_no_exit_for_test(&mut self) { self.drain_all(Duration::from_secs(2)); }
}

/// Closes the channel's open drop run, if any, as a `queue-overflow` discontinuity (plan A13).
fn overflow_event(id: &str, ch: &mut Open) -> Option<Value> {
    ch.gap.take().map(|(idx, n)| json!({"type": "discontinuity", "id": id, "sampleIndex": idx, "droppedSamples": n, "cause": "queue-overflow"}))
}

fn writer(listener: UnixListener, path: PathBuf, q: Arc<ChannelQueue>, gone: Option<mpsc::Sender<String>>, id: String, conn: ConnSlot) {
    let stream = loop {
        match listener.accept() { Ok((s, _)) => break s, Err(e) if e.kind() == ErrorKind::Interrupted => continue, Err(_) => return }
    };
    drop(listener);
    let _ = std::fs::remove_file(&path); // exactly one client per socket
    {
        let mut c = conn.lock().unwrap();
        if c.closing { return; } // close()/EOF raced the accept (this is usually close()'s wake-up connection)
        c.stream = stream.try_clone().ok(); // close() shuts this clone down to unblock write_all below
    }
    let mut stream = stream;
    let mut buf = Vec::with_capacity(1 << 16);
    while q.pop_blocking(1 << 16, &mut buf) {
        if stream.write_all(&buf).is_err() {
            q.close();
            // Unbounded Sender: never blocks, even while the main thread is inside close() waiting for this thread.
            if let Some(gone) = gone { let _ = gone.send(id); }
            return;
        }
        buf.clear();
    }
}

pub fn run(args: Args) -> i32 {
    let (tx, rx) = mpsc::sync_channel::<Msg>(1); // ≤ 2 input blocks in flight (addendum §6)
    {
        let tx = tx.clone();
        let block = args.block_samples * 2;
        thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            loop {
                let mut buf = vec![0u8; block];
                match stdin.read(&mut buf) {
                    Ok(0) => { let _ = tx.send(Msg::InputEof); return; }
                    Ok(n) => { buf.truncate(n); if tx.send(Msg::Input(buf)).is_err() { return; } }
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => { let _ = tx.send(Msg::InputEof); return; }
                }
            }
        });
    }
    {
        let tx = tx.clone();
        let fd = args.control_fd;
        thread::spawn(move || {
            // SAFETY: the parent passes an open pipe at this fd (A1); we own it from here on.
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            for line in BufReader::new(file).lines() {
                match line { Ok(l) if l.trim().is_empty() => continue, Ok(l) => { if tx.send(Msg::Control(parse_request(&l))).is_err() { return; } } Err(_) => break }
            }
            let _ = tx.send(Msg::ControlEof);
        });
    }
    drop(tx); // only the stdin and control threads hold senders now
    let (gone_tx, gone_rx) = mpsc::channel::<String>(); // unbounded, writers → main
    let stdout = std::io::stdout();
    let sink = Box::new(move |v: Value| { let mut l = stdout.lock(); let _ = serde_json::to_writer(&mut l, &v); let _ = l.write_all(b"\n"); let _ = l.flush(); });
    let generation = args.generation;
    let mut rt = Runtime::new(args, sink);
    rt.gone = Some(gone_tx);
    rt.emit(json!({"type": "ready", "pid": std::process::id(), "generation": generation}));
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Msg::Input(b)) => rt.on_input(&b),
            Ok(Msg::InputEof) => return rt.on_eof(),
            Ok(Msg::Control(Ok(r))) => if let Some(code) = rt.on_request(r) { return code },
            Ok(Msg::Control(Err((id, detail)))) => rt.reject(&id, "channel-request-invalid", detail),
            Ok(Msg::ControlEof) => return rt.shutdown(),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return rt.shutdown(),
        }
        while let Ok(id) = gone_rx.try_recv() { rt.on_client_gone(&id); } // ≤ 250 ms after the failed write
        rt.maybe_stats(Instant::now());
    }
}
```

Supporting additions in the same commit:
- `ChannelDsp::output_rate(&self) -> u64 { self.spec.output_rate }` in `channel.rs`.
- `ChannelQueue::try_pop_for_test(&self, out: &mut Vec<u8>) -> bool` (`#[cfg(test)]`, non-blocking drain) in `queue.rs`.

- [ ] **Step 6: Run the tests and confirm they pass.** `make chan-test`. Expected: PASS for all crate tests.
- [ ] **Step 7: Commit**

```bash
git add native/wavekit-chan/src/protocol.rs native/wavekit-chan/src/runtime.rs native/wavekit-chan/src/channel.rs native/wavekit-chan/src/queue.rs
git commit -m "feat(chan): v1 control protocol, per-channel sockets and runtime (addendum §11; Properties 8, 9, 12, 13, 14)"
```

### Task 16: Node `types.ts`, `protocol.ts`, `admission.ts`, `rate-plan.ts`

**Files:**
- Create: `src/core/channelizer/types.ts`, `src/core/channelizer/protocol.ts`, `src/core/channelizer/admission.ts`, `src/core/channelizer/rate-plan.ts`
- Test: `tests/unit/core/channelizer-protocol.test.ts`, `tests/unit/core/channelizer-admission.test.ts`

**Interfaces:**
- Produces (exact names used by Tasks 20–24):

```ts
// types.ts
export type ChannelFormat = "cu8" | "cf32"
export interface DecoderChannelRequest { centerHz: number; bandwidthHz: number; transitionHz: number; outputRateHz: number; format: ChannelFormat; gain?: number }
export type DecoderChannelRequestResult = DecoderChannelRequest | { invalid: string }
export type ChannelAdmissionReason = "channel-outside-capture" | "channel-request-invalid" | "channelizer-unavailable"
export const CHANNEL_ADMISSION_REASONS: readonly ChannelAdmissionReason[]
export function isChannelAdmissionReason(code: string): code is ChannelAdmissionReason
export type DiscontinuityCause = "queue-overflow" | "input-gap"
export interface RealisedChannel { outputRateHz: number; format: ChannelFormat; groupDelaySamples: number }
export type ChannelRequestResult = { ok: true; stream: Readable; channelId: string; generation: number; realised: RealisedChannel } | { ok: false; reasonCode: ChannelAdmissionReason; detail: string }
export interface ChannelProvider {
	requestChannel(sourceId: string, decoderId: string, req: DecoderChannelRequest, inputCaps: SourceCaps | undefined): Promise<ChannelRequestResult>
	releaseChannel(channelId: string): Promise<void>
	currentGeneration(sourceId: string): number
	on(event: "channel-invalidated", listener: (sourceId: string, generation: number, channelIds: string[]) => void): this
	on(event: "channel-discontinuity", listener: (channelId: string, generation: number, sampleIndex: number, droppedSamples: number, cause: DiscontinuityCause) => void): this
	off(event: "channel-invalidated" | "channel-discontinuity", listener: (...args: never[]) => void): this
}
// admission.ts
export const ADMISSION_EPSILON_HZ = 1e-6
export type AdmissionVerdict = { admitted: true; offsetHz: number } | { admitted: false; reasonCode: "channel-outside-capture" | "channel-request-invalid"; detail: string }
export function admitChannel(req: DecoderChannelRequest, capture: { sampleRateHz: number; centerHz: number }, usableFraction: number): AdmissionVerdict
// protocol.ts
export const PROTOCOL_VERSION = 1
export const ChannelizerRequestSchema; export const ChannelizerEventSchema
export type ChannelizerRequest; export type ChannelizerEvent; export type OpenedEvent; export type RejectedEvent
export function encodeRequest(req: ChannelizerRequest): string            // validated, newline-terminated
export function parseEventLine(line: string): { ok: true; event: ChannelizerEvent } | { ok: false; error: string }
// rate-plan.ts
export function channelisedRatePlan(plan: DecoderRateAssessment, realised: RealisedChannel): DecoderRateAssessment
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/core/channelizer-admission.test.ts
import fc from "fast-check"
import { admitChannel } from "../../../src/core/channelizer/admission.js"

const capture = { sampleRateHz: 2_048_000, centerHz: 162_000_000 }
describe("admitChannel", () => {
	it("admits the default request exactly on the out/2 boundary", () => { // Review Focus 1
		const out = 48_000
		const t = 0.05
		const v = admitChannel({ centerHz: 162e6, bandwidthHz: out * (1 - t), transitionHz: (out * t) / 2, outputRateHz: out, format: "cf32" }, capture, 0.8)
		expect(v).toEqual({ admitted: true, offsetHz: 0 })
	})
	it("classifies invalid requests", () => {
		const base = { centerHz: 162e6, bandwidthHz: 45_600, transitionHz: 1_200, outputRateHz: 48_000, format: "cf32" as const }
		for (const bad of [{ bandwidthHz: Number.NaN }, { transitionHz: 0 }, { outputRateHz: 48_000.5 }, { outputRateHz: 3_000_000 }, { bandwidthHz: 50_000 }, { gain: 2 }]) {
			const v = admitChannel({ ...base, ...bad }, capture, 0.8)
			expect(v.admitted ? "admitted" : v.reasonCode).toBe("channel-request-invalid")
		}
	})
	// Feature: core-channelizer, Property 2: Admission rule
	// Validates: addendum §6, §12.2
	it("admits iff both inequalities hold", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.constant(2_048_000), fc.constant(2_400_000), fc.integer({ min: 250_000, max: 3_200_000 })),
				fc.double({ min: -1.5e6, max: 1.5e6, noNaN: true }),
				fc.integer({ min: 1_000, max: 1_050_000 }),
				fc.double({ min: 0.5, max: 0.99, noNaN: true }),
				fc.double({ min: 0.001, max: 0.2, noNaN: true }),
				(fs, offset, out, bwFrac, trFrac) => {
					fc.pre(out <= fs)
					const req = { centerHz: 100e6 + offset, bandwidthHz: out * bwFrac, transitionHz: out * trFrac, outputRateHz: out, format: "cu8" as const }
					const v = admitChannel(req, { sampleRateHz: fs, centerHz: 100e6 }, 0.8)
					const half = req.bandwidthHz / 2 + req.transitionHz
					const fits = half <= out / 2 + 1e-6 && Math.abs(req.centerHz - 100e6) + half <= (fs * 0.8) / 2 + 1e-6
					expect(v.admitted).toBe(fits)
				},
			),
			{ numRuns: 100 },
		)
	})
})
```

```ts
// tests/unit/core/channelizer-protocol.test.ts
import fc from "fast-check"
import { encodeRequest, parseEventLine } from "../../../src/core/channelizer/protocol.js"
import { channelisedRatePlan } from "../../../src/core/channelizer/rate-plan.js"

describe("channelizer protocol v1", () => {
	it("encodes validated requests as one line", () => {
		expect(encodeRequest({ v: 1, type: "mark-gap", atInputByte: 10 })).toBe('{"v":1,"type":"mark-gap","atInputByte":10}\n')
		expect(() => encodeRequest({ v: 1, type: "close", id: "bad id" } as never)).toThrow()
	})
	// Feature: core-channelizer, Property 14: Protocol validity
	// Validates: addendum §11, §12.14
	it("parses every well-formed event and rejects malformed lines without throwing", () => {
		const id = fc.stringMatching(/^[A-Za-z0-9._-]{1,64}$/)
		const gen = fc.nat()
		const event = fc.oneof(
			fc.record({ v: fc.constant(1), type: fc.constant("ready"), generation: gen, pid: fc.integer({ min: 1 }) }),
			fc.record({ v: fc.constant(1), type: fc.constant("opened"), id, generation: gen, socket: fc.constant("/tmp/x.sock"), outputRateHz: fc.integer({ min: 1 }), format: fc.constantFrom("cu8", "cf32"), filterTaps: fc.integer({ min: 1 }), groupDelaySamples: fc.double({ min: 0, max: 1e6, noNaN: true }) }),
			fc.record({ v: fc.constant(1), type: fc.constant("discontinuity"), id, generation: gen, sampleIndex: fc.nat(), droppedSamples: fc.nat(), cause: fc.constantFrom("queue-overflow", "input-gap") }),
			fc.record({ v: fc.constant(1), type: fc.constant("input-eof"), generation: gen, inputSamples: fc.nat(), discardedBytes: fc.constantFrom(0, 1) }),
		)
		fc.assert(fc.property(event, e => { expect(parseEventLine(JSON.stringify(e)).ok).toBe(true) }), { numRuns: 100 })
		fc.assert(fc.property(fc.string(), s => { expect(() => parseEventLine(s)).not.toThrow() }), { numRuns: 100 })
		expect(parseEventLine('{"v":2,"type":"ready","generation":1,"pid":3}').ok).toBe(false)
	})
	it("marks a channelised plan as resample at the realised rate", () => {
		const plan = channelisedRatePlan({ verdict: "best", adaptation: "integer-decimation", frontendRateHz: 47_627.9 }, { outputRateHz: 48_000, format: "cf32", groupDelaySamples: 30 })
		expect(plan).toMatchObject({ verdict: "best", adaptation: "resample", frontendRateHz: 48_000 })
	})
})
```

- [ ] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run tests/unit/core/channelizer-admission.test.ts tests/unit/core/channelizer-protocol.test.ts`
- [ ] **Step 3: Implement**

```ts
// src/core/channelizer/types.ts
import type { Readable } from "node:stream"
import type { SourceCaps } from "../../config.js"

export type ChannelFormat = "cu8" | "cf32"
export interface DecoderChannelRequest {
	centerHz: number
	bandwidthHz: number
	transitionHz: number
	outputRateHz: number
	format: ChannelFormat
	gain?: number
}
export type DecoderChannelRequestResult = DecoderChannelRequest | { invalid: string }
export type ChannelAdmissionReason = "channel-outside-capture" | "channel-request-invalid" | "channelizer-unavailable"
export const CHANNEL_ADMISSION_REASONS: readonly ChannelAdmissionReason[] = ["channel-outside-capture", "channel-request-invalid", "channelizer-unavailable"]
export function isChannelAdmissionReason(code: string): code is ChannelAdmissionReason {
	return (CHANNEL_ADMISSION_REASONS as readonly string[]).includes(code)
}
export type DiscontinuityCause = "queue-overflow" | "input-gap"
export interface RealisedChannel {
	outputRateHz: number
	format: ChannelFormat
	groupDelaySamples: number
}
export type ChannelRequestResult =
	| { ok: true; stream: Readable; channelId: string; generation: number; realised: RealisedChannel }
	| { ok: false; reasonCode: ChannelAdmissionReason; detail: string }
export interface ChannelProvider {
	requestChannel(sourceId: string, decoderId: string, req: DecoderChannelRequest, inputCaps: SourceCaps | undefined): Promise<ChannelRequestResult>
	releaseChannel(channelId: string): Promise<void>
	currentGeneration(sourceId: string): number
	on(event: "channel-invalidated", listener: (sourceId: string, generation: number, channelIds: string[]) => void): this
	on(event: "channel-discontinuity", listener: (channelId: string, generation: number, sampleIndex: number, droppedSamples: number, cause: DiscontinuityCause) => void): this
	off(event: "channel-invalidated" | "channel-discontinuity", listener: (...args: never[]) => void): this
}
```

```ts
// src/core/channelizer/admission.ts
import type { DecoderChannelRequest } from "./types.js"

export const ADMISSION_EPSILON_HZ = 1e-6
export type AdmissionVerdict =
	| { admitted: true; offsetHz: number }
	| { admitted: false; reasonCode: "channel-outside-capture" | "channel-request-invalid"; detail: string }

const invalid = (detail: string): AdmissionVerdict => ({ admitted: false, reasonCode: "channel-request-invalid", detail })

/** Pure. Same arithmetic order as native/wavekit-chan/src/admission.rs (Property 1). Never touches a tuner. */
export function admitChannel(req: DecoderChannelRequest, capture: { sampleRateHz: number; centerHz: number }, usableFraction: number): AdmissionVerdict {
	const finite = [req.centerHz, req.bandwidthHz, req.transitionHz, capture.centerHz].every(Number.isFinite)
	if (!finite) return invalid("non-finite request")
	if (!Number.isInteger(req.outputRateHz) || !Number.isInteger(capture.sampleRateHz)) return invalid("rates must be integers")
	if (req.bandwidthHz <= 0 || req.transitionHz <= 0 || req.outputRateHz <= 0 || req.outputRateHz > capture.sampleRateHz)
		return invalid(`bandwidth/transition must be > 0 and output rate within 1..${capture.sampleRateHz}`)
	if (req.gain !== undefined && (req.format !== "cu8" || !(req.gain > 0) || !Number.isFinite(req.gain))) return invalid("gain is cu8 only and must be > 0")
	const halfOccupied = req.bandwidthHz / 2 + req.transitionHz
	if (halfOccupied > req.outputRateHz / 2 + ADMISSION_EPSILON_HZ) return invalid(`bw/2+tr=${halfOccupied} exceeds out/2=${req.outputRateHz / 2}`)
	const offsetHz = req.centerHz - capture.centerHz
	const limit = (capture.sampleRateHz * usableFraction) / 2
	if (Math.abs(offsetHz) + halfOccupied > limit + ADMISSION_EPSILON_HZ)
		return { admitted: false, reasonCode: "channel-outside-capture", detail: `|Δf|+bw/2+tr=${Math.abs(offsetHz) + halfOccupied} exceeds usable half-span ${limit}` }
	return { admitted: true, offsetHz }
}
```

```ts
// src/core/channelizer/protocol.ts
import { z } from "zod"

export const PROTOCOL_VERSION = 1
const v = z.literal(1)
const id = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
const generation = z.number().int().nonnegative()
const format = z.enum(["cu8", "cf32"])
const count = z.number().int().nonnegative()

export const ChannelizerRequestSchema = z.discriminatedUnion("type", [
	z.object({ v, type: z.literal("open"), id, centerHz: z.number().finite(), bandwidthHz: z.number().positive().finite(), transitionHz: z.number().positive().finite(), outputRateHz: z.number().int().positive(), format, gain: z.number().positive().finite().optional(), queueBytes: z.number().int().positive() }).strict(),
	z.object({ v, type: z.literal("close"), id }).strict(),
	z.object({ v, type: z.literal("mark-gap"), atInputByte: count.optional(), droppedInputBytes: count.optional() }).strict(),
	z.object({ v, type: z.literal("shutdown") }).strict(),
])
const OpenedEventSchema = z.object({ v, type: z.literal("opened"), id, generation, socket: z.string().min(1), outputRateHz: z.number().int().positive(), format, filterTaps: z.number().int().positive(), groupDelaySamples: z.number().nonnegative() }).strict()
const RejectedEventSchema = z.object({ v, type: z.literal("rejected"), id: z.string().max(64), generation, reasonCode: z.enum(["channel-outside-capture", "channel-request-invalid"]), detail: z.string() }).strict()
export const ChannelizerEventSchema = z.discriminatedUnion("type", [
	z.object({ v, type: z.literal("ready"), generation, pid: z.number().int().positive() }).strict(),
	OpenedEventSchema,
	RejectedEventSchema,
	z.object({ v, type: z.literal("discontinuity"), id, generation, sampleIndex: count, droppedSamples: count, cause: z.enum(["queue-overflow", "input-gap"]) }).strict(),
	z.object({ v, type: z.literal("stats"), generation, inputSamples: count, channels: z.array(z.object({ id, outputSamples: count, queueHighWaterBytes: count, droppedSamples: count, saturatedSamples: count }).strict()) }).strict(),
	z.object({ v, type: z.literal("closed"), id, generation, reason: z.enum(["requested", "client-gone"]) }).strict(),
	z.object({ v, type: z.literal("input-eof"), generation, inputSamples: count, discardedBytes: count }).strict(),
])
export type ChannelizerRequest = z.infer<typeof ChannelizerRequestSchema>
export type ChannelizerEvent = z.infer<typeof ChannelizerEventSchema>
export type OpenedEvent = z.infer<typeof OpenedEventSchema>
export type RejectedEvent = z.infer<typeof RejectedEventSchema>

export function encodeRequest(req: ChannelizerRequest): string {
	return `${JSON.stringify(ChannelizerRequestSchema.parse(req))}\n`
}

export function parseEventLine(line: string): { ok: true; event: ChannelizerEvent } | { ok: false; error: string } {
	let raw: unknown
	try {
		raw = JSON.parse(line)
	} catch (err: unknown) {
		return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
	}
	const parsed = ChannelizerEventSchema.safeParse(raw)
	return parsed.success ? { ok: true, event: parsed.data } : { ok: false, error: parsed.error.message }
}
```

```ts
// src/core/channelizer/rate-plan.ts
import type { DecoderRateAssessment } from "../../decoders/types.js"
import type { RealisedChannel } from "./types.js"

/** Addendum §2: a channelised instance realises its frontend rate exactly, via resampling. */
export function channelisedRatePlan(plan: DecoderRateAssessment, realised: RealisedChannel): DecoderRateAssessment {
	return { ...plan, adaptation: "resample", frontendRateHz: realised.outputRateHz }
}
```

- [ ] **Step 4: Run the tests, typecheck and lint, and confirm they pass.** `pnpm exec vitest run tests/unit/core/channelizer-admission.test.ts tests/unit/core/channelizer-protocol.test.ts && pnpm run typecheck && pnpm run lint`
- [ ] **Step 5: Commit**

```bash
git add src/core/channelizer/types.ts src/core/channelizer/protocol.ts src/core/channelizer/admission.ts src/core/channelizer/rate-plan.ts tests/unit/core/channelizer-admission.test.ts tests/unit/core/channelizer-protocol.test.ts
git commit -m "feat(core): channelizer types, v1 protocol schemas and admission (addendum §2, §5, §11; Properties 2, 14)"
```

### Task 17: CHECKPOINT 4A

- [ ] `make chan-test` passes (crate only, release profile, no benches).
- [ ] `pnpm exec vitest run tests/unit/core/channelizer-admission.test.ts tests/unit/core/channelizer-protocol.test.ts` passes.
- [ ] `pnpm run typecheck && pnpm run lint` pass.
- [ ] Nothing in `src/decoders/`, `src/config.ts` or `src/index.ts` has changed yet (`git diff --stat main -- src/decoders src/config.ts src/index.ts` is empty).

---

# Batch 4B: Integration (after the Task 18 re-check)

### Task 18: RE-CHECK: rate-model symbols on `main`; fresh worktree; coordination request drafted

B1–B4 were merged into `main` before this plan was revised (merge `4f99a2c`; see Plan-time facts). This task only confirms nothing regressed since then. It takes minutes and runs no test suite.

- [ ] **Step 1: Confirm the rate model is on `main`.**

```bash
git -C /Users/ben/Projects/wavekit merge-base --is-ancestor 617a586 main && echo "B3 on main"
git -C /Users/ben/Projects/wavekit merge-base --is-ancestor caded97 main && echo "B4 on main"
grep -c "private async suspend\|private detachBranch\|rateGeneration: number" /Users/ben/Projects/wavekit/src/decoders/manager.ts
```

Expected: both lines print and the count is `3`. If either check fails, `main` was rewritten after 2026-10-09: stop and report back, because this plan's DTO handling (A3) assumes B3.

- [ ] **Step 2: Create a fresh worktree from `main`** (superpowers:using-git-worktrees) and rebase or merge the Task 1–17 branch into it. Re-run Task 17's checks in the new worktree.
- [ ] **Step 3: Re-locate the integration points by symbol** and record the current line numbers in the task notes (the Plan-time facts give the `f49273c` values): `wireDecoderToFanout`, `unwireDecoderFromFanout`, `detachBranch`, `handleCapsChange` (the passive list), `evaluateRate`, `resume`, `assessState`, `getStatus`, `handleDecoderExit` (the restart-timer wire).
- [ ] **Step 4: The orchestrator posts this request** to `docs/CLI-COORDINATION.md` "Open requests to other teams". This plan's executors do not edit that file.

```markdown
### Core → CLI/API: channel suspension reason codes (additive, low priority)
The opt-in core channelizer (default off) can suspend a decoder for reasons that are
not source-rate reasons: `channel-outside-capture`, `channel-request-invalid`,
`channelizer-unavailable`. Until `DecoderSuspension.reasonCode` (api-types) and the
strict Fastify enum accept them, core publishes such a decoder as `suspended: true`
with **no `suspension` object** (the existing `decoder:status` event and REST body).
Request: add the three codes to the union and enum, additively; core then emits
`suspension { reasonCode, since }` for them. No other field changes.
```

### Task 19: Channelizer config and `useChannelizer`

**Files:**
- Modify: `src/config.ts` (after `CsdrConfigSchema`; in `DecoderConfigSchema`; in `ConfigSchema`; a new type export)
- Modify: `src/decoders/types.ts` (`DecoderConfig` interface: `useChannelizer?: boolean | undefined`)
- Modify: `config/default.yaml` (commented block)
- Test: `tests/unit/utils/channelizer-config.test.ts`

**Interfaces:**
- Produces: `ChannelizerConfigSchema`, `type ChannelizerConfig = z.infer<typeof ChannelizerConfigSchema>`, `Config.channelizer`, `DecoderConfig.useChannelizer`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/utils/channelizer-config.test.ts
import { ChannelizerConfigSchema, ConfigSchema, DecoderConfigSchema } from "../../../src/config.js"

describe("channelizer config (addendum §6, §7)", () => {
	it("defaults off with the documented budgets", () => {
		expect(ChannelizerConfigSchema.parse({})).toEqual({ enabled: false, binaryPath: "wavekit-chan", socketDir: "/var/run/wavekit/chan", usableFraction: 0.8, channelQueueMs: 250, inputHighWaterMark: 262144, blockSamples: 16384 })
		expect(ConfigSchema.parse({}).channelizer.enabled).toBe(false)
		expect(DecoderConfigSchema.parse({ id: "a", type: "x", enabled: true, options: {} }).useChannelizer).toBe(false)
	})
	it("bounds every budget", () => {
		for (const bad of [{ usableFraction: 0.49 }, { usableFraction: 0.96 }, { channelQueueMs: 49 }, { channelQueueMs: 2001 }, { blockSamples: 100 }, { binaryPath: "" }]) {
			expect(ChannelizerConfigSchema.safeParse(bad).success).toBe(false)
		}
	})
})
```

Add a case for the `WAVEKIT_CHANNELIZER__ENABLED=true` override, following the env-override cases already in `tests/unit/utils/config.test.ts` (same helper, same setup and teardown of `process.env`).

- [ ] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run tests/unit/utils/channelizer-config.test.ts`
- [ ] **Step 3: Implement**

```ts
// src/config.ts, after CsdrConfigSchema
/**
 * Opt-in core channelizer (addendum §6). Off by default: every pipeline stays
 * byte-identical. One supervised wavekit-chan process per source.
 */
export const ChannelizerConfigSchema = z.object({
	enabled: z.boolean().default(false),
	binaryPath: z.string().min(1).default("wavekit-chan"),
	socketDir: z.string().min(1).default("/var/run/wavekit/chan"),
	usableFraction: z.number().min(0.5).max(0.95).default(0.8),
	channelQueueMs: z.number().int().min(50).max(2000).default(250),
	inputHighWaterMark: z.number().int().min(65_536).max(16 * 1024 * 1024).default(262_144),
	blockSamples: z.number().int().min(256).max(1 << 20).default(16_384),
})
```

In `DecoderConfigSchema`, after `maxVersion`, add `/** Route this instance through the core channelizer (addendum §7) */ useChannelizer: z.boolean().default(false),`. In `ConfigSchema`, after `csdr`, add `channelizer: ChannelizerConfigSchema.default({}),`. In the type exports, add `export type ChannelizerConfig = z.infer<typeof ChannelizerConfigSchema>`. In the `DecoderConfig` interface in `src/decoders/types.ts`, add `/** Route through the core channelizer (opt-in) */ useChannelizer?: boolean | undefined`.

Append to `config/default.yaml`:

```yaml
# Core channelizer (opt-in prototype; docs/superpowers/specs/2026-10-09-core-channelizer-prototype-addendum.md).
# Off by default. When on, decoders with `useChannelizer: true` get exact-rate IQ
# from one wavekit-chan process per source; raw fanout is unchanged.
# channelizer:
#   enabled: false
#   binaryPath: wavekit-chan
#   socketDir: /var/run/wavekit/chan
#   usableFraction: 0.8
#   channelQueueMs: 250
#   inputHighWaterMark: 262144
#   blockSamples: 16384
```

- [ ] **Step 4: Run the tests, then `pnpm exec vitest run tests/unit/utils/config.test.ts`, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit** `git add src/config.ts src/decoders/types.ts config/default.yaml tests/unit/utils/channelizer-config.test.ts && git commit -m "feat(config): opt-in channelizer config and useChannelizer (addendum §6, §7)"`

### Task 20: [D3] `ChannelizerProcess` and the fake binary

**Files:**
- Create: `src/core/channelizer/channelizer-process.ts`, `tests/mocks/fake-wavekit-chan.ts`
- Test: `tests/unit/core/channelizer-process.test.ts`

**Interfaces:**
- Consumes: `encodeRequest`, `parseEventLine` (Task 16); `signalDecoder` (`src/decoders/process-tools.ts`); `WaveKitError`.
- Produces:

```ts
export interface ChannelizerProcessOptions { binaryPath: string; generation: number; inputRateHz: number; inputCenterHz: number; usableFraction: number; blockSamples: number; socketDir: string; readyTimeoutMs?: number; stopTimeoutMs?: number }
export interface ChannelizerProcessLike extends EventEmitter {
	readonly generation: number
	readonly input: Writable
	start(): Promise<void>                        // resolves on `ready`; rejects WaveKitError code CHANNELIZER_UNAVAILABLE
	send(req: ChannelizerRequest): void
	stop(): Promise<void>                         // shutdown → end input → stopTimeout → SIGTERM → 5 s → SIGKILL
	// events: "event" (ChannelizerEvent), "exit" (code: number | null, signal: string | null; emitted on the child's `close`, after the last stdout line), "protocol-error" (line: string, error: string)
}
export class ChannelizerProcess extends EventEmitter implements ChannelizerProcessLike
export function buildChannelizerArgs(o: ChannelizerProcessOptions): string[]
export const FAKE_WAVEKIT_CHAN: string   // tests/mocks/fake-wavekit-chan.ts: executable body (#!/usr/bin/env node)
```

- [ ] **Step 1: Write the fake binary body** (`tests/mocks/fake-wavekit-chan.ts`)

```ts
// Protocol-faithful stand-in for wavekit-chan (A1: control on fd 3). Behaviour via env:
// FAKE_CHAN_MODE = normal | no-ready | crash-after-open | garbage | stall-input
// stall-input: stdin is not read until FAKE_CHAN_STALL_MS (default 1500) after the first channel opens, then resumes,
// so the fanout branch really drops and then really drains (Task 21). Anchoring to `opened` keeps slow spawns out of the window.
// Channels are identity pass-through, so a discontinuity's output sampleIndex equals the input sample index.
export const FAKE_WAVEKIT_CHAN = `#!/usr/bin/env node
const fs = require("node:fs"), net = require("node:net"), path = require("node:path"), readline = require("node:readline")
const argv = process.argv.slice(2); const arg = k => argv[argv.indexOf("--" + k) + 1]
if (argv[0] === "--version") { process.stdout.write("wavekit-chan 0.0.0-fake protocol 1\\n"); process.exit(0) }
const generation = Number(arg("generation")), dir = arg("socket-dir"), mode = process.env.FAKE_CHAN_MODE || "normal"
const emit = e => process.stdout.write(JSON.stringify({ v: 1, generation, ...e }) + "\\n")
const clients = new Map(); let inputBytes = 0, stallTimer = null
if (mode === "garbage") process.stdout.write("not json\\n")
if (mode !== "no-ready") emit({ type: "ready", pid: process.pid })
readline.createInterface({ input: fs.createReadStream(null, { fd: 3 }) }).on("line", line => {
  let r; try { r = JSON.parse(line) } catch { return emit({ type: "rejected", id: "", reasonCode: "channel-request-invalid", detail: "json" }) }
  if (r.type === "open") {
    if (r.centerHz > 1e12) return emit({ type: "rejected", id: r.id, reasonCode: "channel-outside-capture", detail: "fake" })
    const sock = path.join(dir, r.id + ".sock"); try { fs.unlinkSync(sock) } catch {}
    const server = net.createServer(c => { clients.set(r.id, c); server.close() }); server.listen(sock, () => {
      emit({ type: "opened", id: r.id, socket: sock, outputRateHz: r.outputRateHz, format: r.format, filterTaps: 11, groupDelaySamples: 5 })
      if (mode === "crash-after-open") setTimeout(() => process.exit(1), 50)
      if (mode === "stall-input" && !stallTimer) stallTimer = setTimeout(() => process.stdin.resume(), Number(process.env.FAKE_CHAN_STALL_MS || 1500))
    })
  } else if (r.type === "close") { clients.get(r.id)?.end(); clients.delete(r.id); emit({ type: "closed", id: r.id, reason: "requested" }) }
  else if (r.type === "mark-gap") { for (const id of clients.keys()) emit({ type: "discontinuity", id, sampleIndex: Math.floor((r.atInputByte ?? inputBytes) / 2), droppedSamples: Math.floor((r.droppedInputBytes ?? 0) / 2), cause: "input-gap" }); emit({ type: "stats", inputSamples: Math.floor(inputBytes / 2), channels: [] }) }
  else if (r.type === "shutdown") process.exit(0)
}).on("close", () => process.exit(0))
process.stdin.on("data", b => { inputBytes += b.length; for (const c of clients.values()) c.write(b) })
if (mode === "stall-input") process.stdin.pause() // resumed by the timer armed on the first `opened`
process.stdin.on("end", () => { emit({ type: "input-eof", inputSamples: Math.floor(inputBytes / 2), discardedBytes: inputBytes % 2 }); for (const c of clients.values()) c.end(); setTimeout(() => process.exit(0), 20) })
process.on("SIGTERM", () => process.exit(143))
`
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/core/channelizer-process.test.ts
import { mkdirSync } from "node:fs"
import pino from "pino"
import { ChannelizerProcess, buildChannelizerArgs } from "../../../src/core/channelizer/channelizer-process.js"
import { writeExecutable } from "../../mocks/executables.js"
import { FAKE_WAVEKIT_CHAN } from "../../mocks/fake-wavekit-chan.js"

const logger = pino({ level: "silent" })
const bin = `/tmp/wkc-test-${process.pid}/wavekit-chan`
const socketDir = `/tmp/wkc-test-${process.pid}/s`
beforeAll(() => { mkdirSync(socketDir, { recursive: true }); writeExecutable(bin, FAKE_WAVEKIT_CHAN) })
const opts = (extra: Partial<Parameters<typeof buildChannelizerArgs>[0]> = {}) => ({ binaryPath: bin, generation: 4, inputRateHz: 2_048_000, inputCenterHz: 162e6, usableFraction: 0.8, blockSamples: 16384, socketDir, readyTimeoutMs: 3000, stopTimeoutMs: 1000, ...extra })

describe("ChannelizerProcess", () => {
	it("builds the addendum §11 spawn line plus --control-fd 3", () => {
		expect(buildChannelizerArgs(opts())).toEqual(["--generation", "4", "--input-format", "cu8", "--input-rate", "2048000", "--input-center", "162000000", "--usable-fraction", "0.8", "--block-samples", "16384", "--socket-dir", socketDir, "--control-fd", "3"])
	})
	it("starts on ready, relays events and stops cleanly", async () => {
		const p = new ChannelizerProcess(opts(), logger)
		await p.start()
		const opened = new Promise(resolve => p.on("event", e => { if (e.type === "opened") resolve(e) }))
		p.send({ v: 1, type: "open", id: "a", centerHz: 162e6, bandwidthHz: 45_600, transitionHz: 1_200, outputRateHz: 48_000, format: "cf32", queueBytes: 96_000 })
		expect(await opened).toMatchObject({ id: "a", generation: 4 })
		const exited = new Promise(resolve => p.once("exit", resolve))
		await p.stop()
		await exited
	})
	it("rejects with CHANNELIZER_UNAVAILABLE when the binary is missing or never ready", async () => {
		await expect(new ChannelizerProcess(opts({ binaryPath: "/nonexistent/wavekit-chan" }), logger).start()).rejects.toMatchObject({ code: "CHANNELIZER_UNAVAILABLE" })
		process.env["FAKE_CHAN_MODE"] = "no-ready"
		try {
			await expect(new ChannelizerProcess(opts({ readyTimeoutMs: 300 }), logger).start()).rejects.toMatchObject({ code: "CHANNELIZER_UNAVAILABLE" })
		} finally {
			delete process.env["FAKE_CHAN_MODE"]
		}
	})
	it("reports malformed stdout lines as protocol-error without crashing", async () => {
		process.env["FAKE_CHAN_MODE"] = "garbage"
		try {
			const p = new ChannelizerProcess(opts(), logger)
			const bad = new Promise(resolve => p.once("protocol-error", resolve))
			await p.start()
			expect(await bad).toBe("not json")
			await p.stop()
		} finally {
			delete process.env["FAKE_CHAN_MODE"]
		}
	})
})
```

- [ ] **Step 3: Run it and confirm it fails.** `pnpm exec vitest run tests/unit/core/channelizer-process.test.ts`
- [ ] **Step 4: Implement**

```ts
// src/core/channelizer/channelizer-process.ts
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import type { Writable } from "node:stream"
import { signalDecoder } from "../../decoders/process-tools.js"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { encodeRequest, parseEventLine, type ChannelizerRequest } from "./protocol.js"

export interface ChannelizerProcessOptions {
	binaryPath: string
	generation: number
	inputRateHz: number
	inputCenterHz: number
	usableFraction: number
	blockSamples: number
	socketDir: string
	readyTimeoutMs?: number
	stopTimeoutMs?: number
}

export interface ChannelizerProcessLike extends EventEmitter {
	readonly generation: number
	readonly input: Writable
	start(): Promise<void>
	send(req: ChannelizerRequest): void
	stop(): Promise<void>
}

const KILL_AFTER_MS = 5000

export function buildChannelizerArgs(o: ChannelizerProcessOptions): string[] {
	return ["--generation", String(o.generation), "--input-format", "cu8", "--input-rate", String(o.inputRateHz), "--input-center", String(o.inputCenterHz), "--usable-fraction", String(o.usableFraction), "--block-samples", String(o.blockSamples), "--socket-dir", o.socketDir, "--control-fd", "3"]
}

export class ChannelizerProcess extends EventEmitter implements ChannelizerProcessLike {
	readonly generation: number
	private readonly log: Logger
	private child: ChildProcess | null = null
	private control: Writable | null = null
	private exited = false

	constructor(private readonly options: ChannelizerProcessOptions, logger: Logger) {
		super()
		this.generation = options.generation
		this.log = createComponentLogger(logger, "ChannelizerProcess")
	}

	get input(): Writable {
		const stdin = this.child?.stdin
		if (!stdin) throw new WaveKitError("channelizer not started", "CHANNELIZER_UNAVAILABLE")
		return stdin
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const unavailable = (message: string, cause?: Error) => reject(new WaveKitError(message, "CHANNELIZER_UNAVAILABLE", cause))
			const child = spawn(this.options.binaryPath, buildChannelizerArgs(this.options), { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe", "pipe"] })
			this.child = child
			this.control = child.stdio[3] as Writable
			this.control.on("error", (err: Error) => this.log.warn({ err }, "Control pipe error"))
			child.stdin?.on("error", (err: Error) => this.log.debug({ err }, "Input pipe closed"))
			const timer = setTimeout(() => { unavailable(`no ready within ${this.options.readyTimeoutMs ?? 5000} ms`); void this.stop() }, this.options.readyTimeoutMs ?? 5000)
			child.once("error", (err: Error) => { clearTimeout(timer); unavailable(`spawn ${this.options.binaryPath} failed: ${err.message}`, err) })
			// `close`, not `exit`: it fires after stdout has ended, so every event line (notably `input-eof`) is parsed
			// before the exit is reported. Task 21 relies on that order to tell an end-of-recording exit 0 from a crash.
			child.once("close", (code, signal) => { clearTimeout(timer); this.exited = true; this.emit("exit", code, signal); unavailable(`exited before ready (code ${String(code)})`) })
			createInterface({ input: child.stderr! }).on("line", line => this.log.debug({ line }, "wavekit-chan stderr"))
			createInterface({ input: child.stdout! }).on("line", line => {
				const parsed = parseEventLine(line)
				if (!parsed.ok) {
					this.log.warn({ line, error: parsed.error }, "Invalid channelizer event line")
					this.emit("protocol-error", line, parsed.error)
					return
				}
				if (parsed.event.type === "ready") { clearTimeout(timer); resolve() }
				this.emit("event", parsed.event)
			})
		})
	}

	send(req: ChannelizerRequest): void {
		if (!this.control || this.exited) return
		this.control.write(encodeRequest(req))
	}

	async stop(): Promise<void> {
		const child = this.child
		if (!child || this.exited) return
		// Our own "exit" (emitted on the child's close): a child that already exited but has not closed yet still resolves it.
		const exited = new Promise<void>(resolve => this.once("exit", () => resolve()))
		this.send({ v: 1, type: "shutdown" })
		child.stdin?.end()
		this.control?.end()
		const waitFor = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))])
		if (await waitFor(this.options.stopTimeoutMs ?? 5000)) return
		signalDecoder(child, "SIGTERM")
		if (await waitFor(KILL_AFTER_MS)) return
		this.log.warn({ pid: child.pid }, "wavekit-chan ignored SIGTERM, sending SIGKILL")
		signalDecoder(child, "SIGKILL")
		await exited
	}
}
```

- [ ] **Step 5: Run the test and confirm it passes**, then typecheck and lint.
- [ ] **Step 6: Commit** `git add src/core/channelizer/channelizer-process.ts tests/mocks/fake-wavekit-chan.ts tests/unit/core/channelizer-process.test.ts && git commit -m "feat(core): supervised wavekit-chan process with fd-3 control (addendum §4, §11; D3/A1)"`

### Task 21: [D3] `ChannelizerManager`

**Files:**
- Create: `src/core/channelizer/channelizer-manager.ts`
- Test: `tests/unit/core/channelizer-manager.test.ts`

**Interfaces:**
- Consumes: `ChannelizerProcessLike`/`ChannelizerProcess` (Task 20); `admitChannel`; `ChannelProvider` and the types (Task 16); `ChannelizerConfig` (Task 19); `SourceFanoutRouter.getFanout/releaseUnused`; `FanoutManager.addBranch/removeBranch/getBranchTelemetry` and its `backpressure`/`drain` events; `SourceManager.getCaps` and its events.
- Produces:

```ts
export interface ChannelizerManagerDeps {
	sourceManager: Pick<SourceManager, "getCaps" | "on" | "off">
	routing: Pick<SourceFanoutRouter, "getFanout" | "releaseUnused">
	config: ChannelizerConfig
	logger: Logger
	createProcess?: (o: ChannelizerProcessOptions, logger: Logger) => ChannelizerProcessLike
	connect?: (socketPath: string) => Promise<Readable>
	now?: () => number // injectable clock for the crash-loop window (tests)
}
export const MAX_SOCKET_PATH = 100
export const CRASH_LIMIT = 5
export const CRASH_WINDOW_MS = 60_000
export class ChannelizerManager extends EventEmitter implements ChannelProvider {
	constructor(deps: ChannelizerManagerDeps)
	requestChannel(sourceId, decoderId, req, inputCaps): Promise<ChannelRequestResult>
	releaseChannel(channelId: string): Promise<void>
	currentGeneration(sourceId: string): number
	unexpectedExitCount(sourceId: string): number // within the current CRASH_WINDOW_MS
	destroy(): Promise<void>
}
```

Behaviour contract (addendum § 4):
- Requests are serialised per source.
- Admission runs in Node first, so a rejected request never spawns anything.
- The process is spawned lazily, the generation increments on every spawn, and the socket dir is `${socketDir}/${sanitize(sourceId)}-g${generation}` (mode 0700). A socket dir that cannot be created (for example `EACCES` on the default `/var/run/wavekit/chan` on a Mac, or `ENOTDIR`) gives `channelizer-unavailable` and spawns nothing; it is never thrown out of `requestChannel`.
- The branch id is `channelizer-${sourceId}`, piped to the process input with `pipeline()` and an error handler.
- Channel ids are `${sanitize(decoderId)}-g${generation}`.
- On `caps-changed` (rate or centre differs from the process's caps), `disconnected`, `removed`, or an unexpected process exit: emit `channel-invalidated(sourceId, generation, ids)` **first** and once, then destroy the sockets, stop the process, remove the branch and call `releaseUnused`. Nothing is respawned until the next request.
- The stream handed to a decoder is a `PassThrough` fed from the socket with `socket.pipe(stream, { end: false })`. Node can see the socket's `end` before the child's `exit`, and `BaseDecoder.attachInput` pipes with `end: true`, so a raw socket would give the decoder's stdin EOF (and a recorded crash) before `channel-invalidated` arrives. With the `PassThrough`, only an explicit `detachInput()` or `destroy()` ends a decoder's input. (`pipeline()` cannot express `end: false`; both streams get `error` handlers instead.)
- A request still waiting for `opened`/`rejected` when its source is invalidated is **superseded**, not unavailable: it is retried once against the new state (current caps, a fresh process), exactly like the generation-superseded path, and a second supersession reports `channelizer-unavailable` "generation superseded twice".
- An exit 0 after the process reported `input-eof` (the end of a recording) is expected: it is logged at info as "wavekit-chan finished after input EOF", invalidates the channels and is not counted as a crash. `ChannelizerProcess` reports `exit` on the child's `close` (Task 20), so the `input-eof` line is always parsed first. Note that `FanoutManager` does not end its branches when the source stream ends (`fanout-manager.ts` :124–128 only logs), so in-app the process normally sees EOF only from `removeBranch` during teardown, when `invalidated` is already set; this rule covers any other branch end.
- Crash-loop backoff: an unexpected exit after `ready` is recorded per source. Once `CRASH_LIMIT` (5) such exits fall inside `CRASH_WINDOW_MS` (60 s), `requestChannel` returns `channelizer-unavailable` ("exited unexpectedly 5 times in 60 s; not respawning before <time>") without spawning, until the oldest of them leaves the window. Without this, every unexpected exit invalidates, the decoders re-request, and the process respawns forever at caps-debounce speed. A decoder suspended this way is retried on its source's next evaluation, as with a missing binary (Review Focus 4).
- On fanout `backpressure` for its own branch, record `atInputByte = totalBytesWritten − droppedBytesTotal`. On `drain` with grown drops, send `mark-gap { atInputByte, droppedInputBytes }`.
- Process `discontinuity` events are re-emitted as `channel-discontinuity`. `stats` events are logged at info as `msg: "channelizer stats"` (Task 35 parses that).
- When the last channel is released, the process is stopped.
- A caps `format` other than `U8_IQ`, or a `kind` other than `iq`, gives `channel-request-invalid`. A missing `caps.centerFreq` uses `req.centerHz` as the capture centre (offset 0), logged at info.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/core/channelizer-manager.test.ts
import { EventEmitter } from "node:events"
import { mkdirSync } from "node:fs"
import { PassThrough } from "node:stream"
import pino from "pino"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { CRASH_LIMIT, CRASH_WINDOW_MS, ChannelizerManager, type ChannelizerManagerDeps } from "../../../src/core/channelizer/channelizer-manager.js"
import { ChannelizerProcess, type ChannelizerProcessLike, type ChannelizerProcessOptions } from "../../../src/core/channelizer/channelizer-process.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"
import type { Logger } from "../../../src/utils/logger.js"
import { ChannelizerConfigSchema, type SourceCaps } from "../../../src/config.js"
import { writeExecutable } from "../../mocks/executables.js"
import { FAKE_WAVEKIT_CHAN } from "../../mocks/fake-wavekit-chan.js"

const logger = pino({ level: "silent" })
const root = `/tmp/wkc-mgr-${process.pid}`
const bin = `${root}/wavekit-chan`
const caps = (sampleRate = 2_048_000, centerFreq = 162e6): SourceCaps => ({ kind: "iq", format: "U8_IQ", sampleRate, centerFreq, exclusive: false })
const req = (centerHz = 162e6) => ({ centerHz, bandwidthHz: 45_600, transitionHz: 1_200, outputRateHz: 48_000, format: "cf32" as const })

class Sources extends EventEmitter { caps = new Map<string, SourceCaps>([["rtl", caps()]]); getCaps(id: string) { return this.caps.get(id) } }

let sources: Sources
let fanout: FanoutManager
let released: string[]
function manager(overrides: Partial<ReturnType<typeof ChannelizerConfigSchema.parse>> = {}, extra: Partial<Pick<ChannelizerManagerDeps, "createProcess" | "connect" | "now">> = {}) {
	return new ChannelizerManager({
		sourceManager: sources as never,
		routing: { getFanout: () => fanout, releaseUnused: (id: string) => { released.push(id) } },
		config: ChannelizerConfigSchema.parse({ enabled: true, binaryPath: bin, socketDir: `${root}/s`, ...overrides }),
		logger,
		...extra,
	})
}
/** Real ChannelizerProcess around the fake binary, recording every request the manager sends. */
function recordingProcess(sent: ChannelizerRequest[]) {
	return (o: ChannelizerProcessOptions, l: Logger): ChannelizerProcessLike => {
		const p = new ChannelizerProcess(o, l)
		const send = p.send.bind(p)
		p.send = r => {
			sent.push(r)
			send(r)
		}
		return p
	}
}
beforeAll(() => { mkdirSync(root, { recursive: true }); writeExecutable(bin, FAKE_WAVEKIT_CHAN) })
beforeEach(() => { sources = new Sources(); fanout = new FanoutManager(logger); released = [] })

describe("ChannelizerManager", () => {
	it("spawns one process for concurrent requests and names channels per generation", async () => {
		const m = manager()
		const [a, b] = await Promise.all([m.requestChannel("rtl", "ais", req(), caps()), m.requestChannel("rtl", "vdl", req(162.1e6), caps())])
		expect(a.ok && b.ok).toBe(true)
		expect(m.currentGeneration("rtl")).toBe(1)
		expect(fanout.getBranchIds()).toEqual(["channelizer-rtl"])
		if (a.ok) expect(a.channelId).toBe("ais-g1")
		await m.destroy()
	})
	// Feature: core-channelizer, Property 2: Admission rule (no side effects)
	// Validates: addendum §12.2
	it("rejects outside requests before spawning anything", async () => {
		const m = manager()
		const r = await m.requestChannel("rtl", "ais", req(163e6), caps())
		expect(r).toMatchObject({ ok: false, reasonCode: "channel-outside-capture" })
		expect(fanout.getBranchIds()).toEqual([])
		expect(m.currentGeneration("rtl")).toBe(0)
	})
	it("rejects non-CU8 sources as channel-request-invalid", async () => { // Review Focus 5
		sources.caps.set("rtl", { ...caps(), format: "FLOAT32LE" })
		expect(await manager().requestChannel("rtl", "ais", req(), undefined)).toMatchObject({ ok: false, reasonCode: "channel-request-invalid" })
	})
	it("reports channelizer-unavailable for an over-long socket path", async () => { // Review Focus 2
		const m = manager({ socketDir: `${root}/${"x".repeat(120)}` })
		expect(await m.requestChannel("rtl", "ais", req(), caps())).toMatchObject({ ok: false, reasonCode: "channelizer-unavailable", detail: expect.stringMatching(/socket path too long/) })
	})
	it("reports channelizer-unavailable when the binary is missing", async () => {
		const m = manager({ binaryPath: `${root}/missing` })
		expect(await m.requestChannel("rtl", "ais", req(), caps())).toMatchObject({ ok: false, reasonCode: "channelizer-unavailable" })
		expect(fanout.getBranchIds()).toEqual([])
	})
	// Feature: core-channelizer, Property 10: Invalidation
	// Validates: addendum §4, §12.10
	it("invalidates once per channel before destroying sockets, then respawns on demand", async () => {
		const m = manager()
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		const order: string[] = []
		a.stream.on("close", () => order.push("socket-closed"))
		const events: unknown[] = []
		m.on("channel-invalidated", (...args: unknown[]) => { events.push(args); order.push("invalidated") })
		sources.caps.set("rtl", caps(2_048_000, 163e6))
		sources.emit("caps-changed", "rtl", caps(2_048_000, 163e6))
		sources.emit("caps-changed", "rtl", caps(2_048_000, 163e6))
		await vi.waitFor(() => expect(order).toContain("socket-closed"))
		expect(events).toEqual([["rtl", 1, ["ais-g1"]]])
		expect(order[0]).toBe("invalidated")
		expect(fanout.getBranchIds()).toEqual([])
		expect(released).toContain("rtl")
		// Feature: core-channelizer, Property 9: Generation stamping
		const b = await m.requestChannel("rtl", "ais", req(163e6), caps(2_048_000, 163e6))
		expect(b.ok && b.generation).toBe(2)
		await m.destroy()
	})
	// Feature: core-channelizer, Property 12: Input-gap marking (Node side)
	// Validates: addendum §4, §12.12; plan A2
	it("sends mark-gap at the seam after real branch drops", async () => {
		process.env["FAKE_CHAN_MODE"] = "stall-input"
		process.env["FAKE_CHAN_STALL_MS"] = "1500"
		const sent: ChannelizerRequest[] = []
		const src = new PassThrough()
		try {
			const m = manager({ inputHighWaterMark: 65_536 }, { createProcess: recordingProcess(sent) })
			const a = await m.requestChannel("rtl", "ais", req(), caps())
			expect(a.ok).toBe(true)
			const seams: number[] = []
			fanout.on("backpressure", (id: string) => {
				const t = id === "channelizer-rtl" ? fanout.getBranchTelemetry(id) : undefined
				if (t) seams.push(t.totalBytesWritten - t.droppedBytesTotal)
			})
			const gaps: unknown[][] = []
			m.on("channel-discontinuity", (...args: unknown[]) => gaps.push(args))
			fanout.attachSource(src)
			// The fake reads nothing for 1.5 s after `opened`. The OS pipe, the child stdin and the 64 KiB branch fill up
			// after a few hundred KiB, then FanoutManager drops. 4 MiB is far past that.
			const chunk = 65_536
			const chunks = 64
			for (let k = 0; k < chunks; k++) {
				src.write(Buffer.alloc(chunk, k))
				await new Promise(resolve => setImmediate(resolve))
			}
			const dropped = fanout.getBranchTelemetry("channelizer-rtl")?.droppedBytesTotal ?? 0
			expect(dropped).toBeGreaterThan(0)
			expect(seams.length).toBe(1) // one backpressure episode: the branch stays in drop mode until drain
			const seam = seams[0] ?? -1
			expect(seam + dropped).toBe(chunk * chunks) // every byte was either delivered before the seam or dropped
			// When the stall ends, the fake reads, the branch emits drain, and the manager sends mark-gap.
			await vi.waitFor(() => expect(sent.some(r => r.type === "mark-gap")).toBe(true), { timeout: 10_000 })
			expect(sent.find(r => r.type === "mark-gap")).toEqual({ v: 1, type: "mark-gap", atInputByte: seam, droppedInputBytes: dropped })
			// The fake echoes the request as a pass-through channel would: input-gap at the seam sample.
			await vi.waitFor(() => expect(gaps.length).toBeGreaterThan(0), { timeout: 5_000 })
			expect(gaps[0]).toEqual(["ais-g1", 1, Math.floor(seam / 2), Math.floor(dropped / 2), "input-gap"])
			await m.destroy()
		} finally {
			src.destroy()
			delete process.env["FAKE_CHAN_MODE"]
			delete process.env["FAKE_CHAN_STALL_MS"]
		}
	}, 20_000)
	it("stops the process and frees the branch when the last channel is released", async () => {
		const m = manager()
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		await m.releaseChannel(a.channelId)
		expect(fanout.getBranchIds()).toEqual([])
		expect(released).toEqual(["rtl"])
	})
	it("reports channelizer-unavailable, never a throw, when the socket dir cannot be created", async () => {
		// The parent is a regular file, so mkdir fails with ENOTDIR on every OS without needing a permission setup.
		// On a Mac the real-world case is EACCES on the default /var/run/wavekit/chan.
		const m = manager({ socketDir: `${bin}/not-a-dir` })
		await expect(m.requestChannel("rtl", "ais", req(), caps())).resolves.toMatchObject({ ok: false, reasonCode: "channelizer-unavailable", detail: expect.stringMatching(/socket dir/) })
		expect(fanout.getBranchIds()).toEqual([])
		expect(m.currentGeneration("rtl")).toBe(0)
	})
	it("retries a request whose source was invalidated while it was pending", async () => {
		let held: (() => void) | null = null
		let spawns = 0
		const createProcess = (o: ChannelizerProcessOptions, l: Logger): ChannelizerProcessLike => {
			const p = new ChannelizerProcess(o, l)
			const send = p.send.bind(p)
			const first = ++spawns === 1
			p.send = r => {
				if (first && r.type === "open") {
					held = () => send(r) // generation 1 never answers before it is invalidated
					return
				}
				send(r)
			}
			return p
		}
		const m = manager({}, { createProcess })
		const pending = m.requestChannel("rtl", "ais", req(), caps())
		await vi.waitFor(() => expect(held).not.toBeNull())
		sources.caps.set("rtl", caps(2_400_000)) // rate change, same centre: the request stays admissible
		sources.emit("caps-changed", "rtl", caps(2_400_000))
		expect(await pending).toMatchObject({ ok: true, generation: 2 }) // superseded and retried, not parked as unavailable
		await m.destroy()
	})
	it("never ends the decoder-facing stream when the process dies; invalidation destroys it instead", async () => {
		process.env["FAKE_CHAN_MODE"] = "crash-after-open"
		try {
			const m = manager()
			const invalidated = new Promise(resolve => m.once("channel-invalidated", resolve))
			const a = await m.requestChannel("rtl", "ais", req(), caps())
			if (!a.ok) throw new Error("expected ok")
			let ended = false
			a.stream.on("end", () => { ended = true })
			a.stream.resume() // flowing, so an end would be observed
			const closed = new Promise(resolve => a.stream.once("close", resolve))
			await invalidated
			await closed
			expect(ended).toBe(false) // the socket saw EOF; the PassThrough handed to the decoder did not end
			await m.destroy()
		} finally {
			delete process.env["FAKE_CHAN_MODE"]
		}
	})
	it("does not count an exit 0 after input-eof as a crash", async () => {
		const procs: ChannelizerProcessLike[] = [] // an array, so TS does not narrow a closure-assigned `let` to null
		const m = manager({}, {
			createProcess: (o, l) => {
				const p = new ChannelizerProcess(o, l)
				procs.push(p)
				return p
			},
		})
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		const invalidated = new Promise(resolve => m.once("channel-invalidated", resolve))
		// What an ended input branch does. (FanoutManager does not end branches when its source ends; it only logs.)
		// The fake emits input-eof, then exits 0.
		procs[0]!.input.end()
		await invalidated
		expect(m.unexpectedExitCount("rtl")).toBe(0)
		await m.destroy()
	})
	it("stops respawning a crash-looping wavekit-chan after CRASH_LIMIT exits within CRASH_WINDOW_MS", async () => {
		process.env["FAKE_CHAN_MODE"] = "crash-after-open"
		let clock = 1_000_000
		try {
			const m = manager({}, { now: () => clock })
			// Each spawn crashes once, 50 ms after `opened`. A crash that lands mid-connect makes the request retry
			// (one more spawn and crash), so count exits rather than assuming exactly one per request.
			while (m.unexpectedExitCount("rtl") < CRASH_LIMIT) {
				const before = m.unexpectedExitCount("rtl")
				await m.requestChannel("rtl", "ais", req(), caps()) // ok, or unavailable if the crash beats the connect
				await vi.waitFor(() => expect(m.unexpectedExitCount("rtl")).toBeGreaterThan(before), { timeout: 5_000 })
				clock += 1_000
			}
			const spawned = m.currentGeneration("rtl")
			expect(spawned).toBeGreaterThanOrEqual(CRASH_LIMIT)
			const held = await m.requestChannel("rtl", "ais", req(), caps())
			expect(held).toMatchObject({ ok: false, reasonCode: "channelizer-unavailable", detail: expect.stringMatching(/exited unexpectedly \d+ times in 60 s/) })
			expect(m.currentGeneration("rtl")).toBe(spawned) // nothing spawned while held
			expect(fanout.getBranchIds()).toEqual([])
			clock += CRASH_WINDOW_MS // every recorded exit has left the window
			await m.requestChannel("rtl", "ais", req(), caps())
			expect(m.currentGeneration("rtl")).toBe(spawned + 1)
			await m.destroy()
		} finally {
			delete process.env["FAKE_CHAN_MODE"]
		}
	}, 30_000)
})
```

The mark-gap test causes real drops; firing `backpressure`/`drain` by hand cannot work, because `onDrain` sends `mark-gap` only when `droppedBytesTotal` grew. The fake's `stall-input` mode (Task 20) leaves stdin unread for `FAKE_CHAN_STALL_MS` and then resumes it, so the branch first drops and then really drains. `recordingProcess` wraps the real `ChannelizerProcess`, so the test asserts the exact `mark-gap` the manager sends: `atInputByte = totalBytesWritten − droppedBytesTotal` at the backpressure event (A2), and `droppedInputBytes` = the drops since then. If the stall window proves too short on a loaded machine, raise `FAKE_CHAN_STALL_MS`. Do not fire events by hand.

- [ ] **Step 2: Run them and confirm they fail.** `pnpm exec vitest run tests/unit/core/channelizer-manager.test.ts`
- [ ] **Step 3: Implement**

```ts
// src/core/channelizer/channelizer-manager.ts
import { EventEmitter } from "node:events"
import { mkdirSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ChannelizerConfig, SourceCaps } from "../../config.js"
import type { FanoutManager } from "../fanout-manager.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { SourceManager } from "../source-manager.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { admitChannel } from "./admission.js"
import { ChannelizerProcess, type ChannelizerProcessLike, type ChannelizerProcessOptions } from "./channelizer-process.js"
import type { ChannelizerEvent, OpenedEvent, RejectedEvent } from "./protocol.js"
import type { ChannelProvider, ChannelRequestResult, DecoderChannelRequest } from "./types.js"

export const MAX_SOCKET_PATH = 100
export const CRASH_LIMIT = 5
export const CRASH_WINDOW_MS = 60_000
const OPEN_TIMEOUT_MS = 5000
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)

export interface ChannelizerManagerDeps {
	sourceManager: Pick<SourceManager, "getCaps" | "on" | "off">
	routing: Pick<SourceFanoutRouter, "getFanout" | "releaseUnused">
	config: ChannelizerConfig
	logger: Logger
	createProcess?: (o: ChannelizerProcessOptions, logger: Logger) => ChannelizerProcessLike
	connect?: (socketPath: string) => Promise<Readable>
	now?: () => number
}

/** `socket` is the process's Unix socket; `stream` is what the decoder gets (fed with end: false). */
interface OpenChannel { id: string; socket: Readable; stream: PassThrough }
type OpenReply = OpenedEvent | RejectedEvent | "superseded" | null
interface SourceChannelizer {
	sourceId: string
	generation: number
	caps: { sampleRate: number; centerHz: number }
	process: ChannelizerProcessLike
	dir: string
	fanout: FanoutManager
	branchId: string
	channels: Map<string, OpenChannel>
	waiters: Map<string, (e: OpenReply) => void>
	gapAtByte: number | null
	droppedAtGap: number
	invalidated: boolean
	sawInputEof: boolean
}

function defaultConnect(path: string): Promise<Readable> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path)
		socket.once("connect", () => resolve(socket))
		socket.once("error", reject)
	})
}

export class ChannelizerManager extends EventEmitter implements ChannelProvider {
	private readonly log: Logger
	private readonly active = new Map<string, SourceChannelizer>()
	private readonly generations = new Map<string, number>()
	private readonly queues = new Map<string, Promise<unknown>>()
	private readonly channelOwner = new Map<string, string>()
	private readonly crashes = new Map<string, number[]>() // per source: times of unexpected exits after ready
	private readonly createProcess: NonNullable<ChannelizerManagerDeps["createProcess"]>
	private readonly connect: NonNullable<ChannelizerManagerDeps["connect"]>
	private readonly now: () => number
	private readonly onCaps = (sourceId: string, caps: SourceCaps) => {
		const s = this.active.get(sourceId)
		if (s && (s.caps.sampleRate !== caps.sampleRate || (caps.centerFreq !== undefined && s.caps.centerHz !== caps.centerFreq))) this.invalidate(sourceId, "caps-changed")
	}
	private readonly onGone = (sourceId: string) => this.invalidate(sourceId, "source-lost")

	constructor(private readonly deps: ChannelizerManagerDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "ChannelizerManager")
		this.createProcess = deps.createProcess ?? ((o, l) => new ChannelizerProcess(o, l))
		this.connect = deps.connect ?? defaultConnect
		this.now = deps.now ?? Date.now
		deps.sourceManager.on("caps-changed", this.onCaps)
		deps.sourceManager.on("disconnected", this.onGone)
		deps.sourceManager.on("removed" as never, this.onGone as never)
	}

	currentGeneration(sourceId: string): number {
		return this.generations.get(sourceId) ?? 0
	}

	unexpectedExitCount(sourceId: string): number {
		return this.recentCrashes(sourceId).length
	}

	private recentCrashes(sourceId: string): number[] {
		const now = this.now()
		const recent = (this.crashes.get(sourceId) ?? []).filter(t => now - t < CRASH_WINDOW_MS)
		this.crashes.set(sourceId, recent)
		return recent
	}

	/** Null when a spawn is allowed; otherwise the channelizer-unavailable detail (crash-loop backoff). */
	private crashLoopHold(sourceId: string): string | null {
		const recent = this.recentCrashes(sourceId)
		if (recent.length < CRASH_LIMIT) return null
		const until = new Date((recent[0] ?? this.now()) + CRASH_WINDOW_MS).toISOString()
		return `wavekit-chan exited unexpectedly ${recent.length} times in ${CRASH_WINDOW_MS / 1000} s; not respawning before ${until}`
	}

	requestChannel(sourceId: string, decoderId: string, req: DecoderChannelRequest, inputCaps: SourceCaps | undefined): Promise<ChannelRequestResult> {
		const run = async () => this.request(sourceId, decoderId, req, inputCaps)
		const next = (this.queues.get(sourceId) ?? Promise.resolve()).then(run, run)
		this.queues.set(sourceId, next.catch(() => undefined))
		return next
	}

	private async request(sourceId: string, decoderId: string, req: DecoderChannelRequest, inputCaps: SourceCaps | undefined, retried = false): Promise<ChannelRequestResult> {
		const caps = this.deps.sourceManager.getCaps(sourceId)
		if (!caps || caps.kind !== "iq" || caps.format !== "U8_IQ")
			return { ok: false, reasonCode: "channel-request-invalid", detail: `source ${sourceId} is not CU8 IQ (${caps?.kind ?? "none"}/${caps?.format ?? "none"})` }
		if (inputCaps && (inputCaps.sampleRate !== caps.sampleRate || inputCaps.centerFreq !== caps.centerFreq))
			this.log.debug({ sourceId, decoderId }, "Request carried stale caps; using current source caps")
		const centerHz = caps.centerFreq ?? req.centerHz
		if (caps.centerFreq === undefined) this.log.info({ sourceId, decoderId }, "Capture centre unknown; channel offset 0")
		const verdict = admitChannel(req, { sampleRateHz: caps.sampleRate, centerHz }, this.deps.config.usableFraction)
		if (!verdict.admitted) return { ok: false, reasonCode: verdict.reasonCode, detail: verdict.detail }
		let s = this.active.get(sourceId)
		if (s && (s.caps.sampleRate !== caps.sampleRate || s.caps.centerHz !== centerHz)) {
			this.invalidate(sourceId, "caps-changed")
			s = undefined
		}
		const channelId = `${sanitize(decoderId)}-g${(s?.generation ?? this.currentGeneration(sourceId) + 1)}`
		const dirFor = (g: number) => join(this.deps.config.socketDir, `${sanitize(sourceId)}-g${g}`)
		const probe = join(dirFor(s?.generation ?? this.currentGeneration(sourceId) + 1), `${channelId}.sock`)
		if (Buffer.byteLength(probe) > MAX_SOCKET_PATH) return { ok: false, reasonCode: "channelizer-unavailable", detail: `socket path too long (${Buffer.byteLength(probe)} > ${MAX_SOCKET_PATH}): ${probe}` }
		if (!s) {
			const held = this.crashLoopHold(sourceId)
			if (held) return { ok: false, reasonCode: "channelizer-unavailable", detail: held }
			const spawned = await this.spawn(sourceId, { sampleRate: caps.sampleRate, centerHz }, dirFor(this.currentGeneration(sourceId) + 1))
			if ("error" in spawned) return { ok: false, reasonCode: "channelizer-unavailable", detail: spawned.error }
			s = spawned
		}
		const superseded = (): Promise<ChannelRequestResult> =>
			retried
				? Promise.resolve({ ok: false, reasonCode: "channelizer-unavailable", detail: "generation superseded twice" })
				: this.request(sourceId, decoderId, req, inputCaps, true)
		const queueBytes = Math.ceil((this.deps.config.channelQueueMs / 1000) * req.outputRateHz) * (req.format === "cu8" ? 2 : 8)
		const reply = new Promise<OpenReply>(resolve => {
			const timer = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS)
			s!.waiters.set(channelId, e => { clearTimeout(timer); resolve(e) })
		})
		s.process.send({ v: 1, type: "open", id: channelId, centerHz: req.centerHz, bandwidthHz: req.bandwidthHz, transitionHz: req.transitionHz, outputRateHz: req.outputRateHz, format: req.format, ...(req.gain !== undefined ? { gain: req.gain } : {}), queueBytes })
		const event = await reply
		s.waiters.delete(channelId)
		// Source invalidated while this request was pending: retry once against the new state, like a superseded generation.
		if (event === "superseded") return superseded()
		if (event === null) return { ok: false, reasonCode: "channelizer-unavailable", detail: "no opened/rejected within 5 s" }
		if (event.type === "rejected") return { ok: false, reasonCode: event.reasonCode, detail: event.detail }
		if (s.invalidated || event.generation !== this.currentGeneration(sourceId)) return superseded()
		let socket: Readable
		try {
			socket = await this.connect(event.socket)
		} catch (err: unknown) {
			return { ok: false, reasonCode: "channelizer-unavailable", detail: `connect ${event.socket}: ${err instanceof Error ? err.message : String(err)}` }
		}
		socket.on("error", (err: Error) => this.log.debug({ err, channelId }, "Channel socket error"))
		if (s.invalidated) {
			socket.destroy()
			return superseded()
		}
		// end: false — the socket's EOF (process death) must never end the decoder's stdin; only detach/destroy does.
		const stream = new PassThrough()
		stream.on("error", (err: Error) => this.log.debug({ err, channelId }, "Channel stream error"))
		socket.pipe(stream, { end: false })
		s.channels.set(channelId, { id: channelId, socket, stream })
		this.channelOwner.set(channelId, sourceId)
		return { ok: true, stream, channelId, generation: event.generation, realised: { outputRateHz: event.outputRateHz, format: event.format, groupDelaySamples: event.groupDelaySamples } }
	}

	private async spawn(sourceId: string, caps: { sampleRate: number; centerHz: number }, dir: string): Promise<SourceChannelizer | { error: string }> {
		const generation = this.currentGeneration(sourceId) + 1
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 })
		} catch (err: unknown) {
			// e.g. EACCES on the default /var/run/wavekit/chan outside the image: a suspension, never a crash
			return { error: `socket dir ${dir}: ${err instanceof Error ? err.message : String(err)}` }
		}
		this.generations.set(sourceId, generation)
		const process = this.createProcess({ binaryPath: this.deps.config.binaryPath, generation, inputRateHz: caps.sampleRate, inputCenterHz: caps.centerHz, usableFraction: this.deps.config.usableFraction, blockSamples: this.deps.config.blockSamples, socketDir: dir }, this.deps.logger)
		try {
			await process.start()
		} catch (err: unknown) {
			rmSync(dir, { recursive: true, force: true })
			return { error: err instanceof Error ? err.message : String(err) }
		}
		const fanout = this.deps.routing.getFanout(sourceId)
		const branchId = `channelizer-${sourceId}`
		const s: SourceChannelizer = { sourceId, generation, caps, process, dir, fanout, branchId, channels: new Map(), waiters: new Map(), gapAtByte: null, droppedAtGap: 0, invalidated: false, sawInputEof: false }
		const branch = fanout.addBranch({ id: branchId, sourceId, highWaterMark: this.deps.config.inputHighWaterMark })
		void pipeline(branch, process.input).catch((err: unknown) => this.log.debug({ err, sourceId }, "Channelizer input pipeline ended"))
		process.on("event", (e: ChannelizerEvent) => this.onEvent(s, e))
		process.on("exit", (code: number | null, signal: string | null) => {
			if (s.invalidated) return
			if (s.sawInputEof && code === 0) {
				// End of a recording: expected, not a crash (ChannelizerProcess reports exit on `close`, after input-eof is parsed)
				this.log.info({ sourceId, generation }, "wavekit-chan finished after input EOF")
				this.invalidate(sourceId, "input-eof")
				return
			}
			const recent = this.recentCrashes(sourceId)
			recent.push(this.now())
			this.log.error({ sourceId, generation, code, signal, recentExits: recent.length }, "wavekit-chan exited unexpectedly")
			this.invalidate(sourceId, "process-exit")
		})
		const onBackpressure = (id: string) => {
			if (id !== branchId || s.gapAtByte !== null) return
			const t = fanout.getBranchTelemetry(branchId)
			if (t) { s.gapAtByte = t.totalBytesWritten - t.droppedBytesTotal; s.droppedAtGap = t.droppedBytesTotal }
		}
		const onDrain = (id: string) => {
			if (id !== branchId || s.gapAtByte === null) return
			const t = fanout.getBranchTelemetry(branchId)
			const dropped = (t?.droppedBytesTotal ?? s.droppedAtGap) - s.droppedAtGap
			if (dropped > 0) process.send({ v: 1, type: "mark-gap", atInputByte: s.gapAtByte, droppedInputBytes: dropped })
			s.gapAtByte = null
		}
		fanout.on("backpressure", onBackpressure)
		fanout.on("drain", onDrain)
		process.once("exit", () => { fanout.off("backpressure", onBackpressure); fanout.off("drain", onDrain) })
		this.active.set(sourceId, s)
		this.log.info({ sourceId, generation, dir }, "Channelizer started")
		return s
	}

	private onEvent(s: SourceChannelizer, e: ChannelizerEvent): void {
		if (e.generation !== s.generation) { this.log.warn({ sourceId: s.sourceId, got: e.generation, want: s.generation }, "Ignoring event from another generation"); return }
		switch (e.type) {
			case "opened":
			case "rejected": s.waiters.get(e.id)?.(e); break
			case "discontinuity": this.emit("channel-discontinuity", e.id, e.generation, e.sampleIndex, e.droppedSamples, e.cause); break
			case "stats": this.log.info({ sourceId: s.sourceId, generation: e.generation, inputSamples: e.inputSamples, channels: e.channels }, "channelizer stats"); break
			case "closed": if (e.reason === "client-gone") this.log.info({ channelId: e.id }, "Channel client gone"); break
			case "input-eof": s.sawInputEof = true; this.log.info({ sourceId: s.sourceId, discardedBytes: e.discardedBytes }, "Channelizer input EOF"); break
			case "ready": break
		}
	}

	private invalidate(sourceId: string, cause: string): void {
		const s = this.active.get(sourceId)
		if (!s || s.invalidated) return
		s.invalidated = true
		this.active.delete(sourceId)
		const ids = [...s.channels.keys()]
		if (ids.length > 0) this.emit("channel-invalidated", sourceId, s.generation, ids) // first: listeners detach synchronously
		for (const ch of s.channels.values()) { ch.socket.destroy(); ch.stream.destroy(); this.channelOwner.delete(ch.id) }
		for (const w of s.waiters.values()) w("superseded") // pending requests retry against the new state
		this.teardown(s, cause)
	}

	private teardown(s: SourceChannelizer, cause: string): void {
		s.fanout.removeBranch(s.branchId)
		this.deps.routing.releaseUnused(s.sourceId)
		void s.process.stop().catch((err: unknown) => this.log.warn({ err, sourceId: s.sourceId }, "Channelizer stop failed")).finally(() => rmSync(s.dir, { recursive: true, force: true }))
		this.log.info({ sourceId: s.sourceId, generation: s.generation, cause }, "Channelizer torn down")
	}

	async releaseChannel(channelId: string): Promise<void> {
		const sourceId = this.channelOwner.get(channelId)
		if (!sourceId) return
		this.channelOwner.delete(channelId)
		const s = this.active.get(sourceId)
		const ch = s?.channels.get(channelId)
		if (!s || !ch) return
		s.channels.delete(channelId)
		ch.socket.destroy()
		ch.stream.destroy()
		s.process.send({ v: 1, type: "close", id: channelId })
		if (s.channels.size === 0) {
			s.invalidated = true
			this.active.delete(sourceId)
			this.teardown(s, "last-channel-released")
		}
	}

	async destroy(): Promise<void> {
		this.deps.sourceManager.off("caps-changed", this.onCaps)
		this.deps.sourceManager.off("disconnected", this.onGone)
		this.deps.sourceManager.off("removed" as never, this.onGone as never)
		for (const sourceId of [...this.active.keys()]) this.invalidate(sourceId, "destroy")
	}
}
```

Notes for the implementer:
- If `SourceManagerEvents` does not declare `removed` (it is emitted at `source-manager.ts:1217` but missing from the interface at :102–119), add `removed: (sourceId: string) => void` to that interface in this task. That is an internal type and not a contract change, and it removes the `as never` casts.
- `teardown` awaits nothing on purpose. `invalidate` is called synchronously from event listeners, and `destroy()` awaits each `process.stop()` by tracking the promises; add a `stops: Promise<void>[]` collector to `destroy` so tests can await full shutdown.

- [ ] **Step 4: Run the tests and confirm they pass**, then typecheck and lint.
- [ ] **Step 5: Commit** `git add src/core/channelizer/channelizer-manager.ts src/core/source-manager.ts tests/unit/core/channelizer-manager.test.ts && git commit -m "feat(core): per-source ChannelizerManager with generations and invalidation (addendum §4, §6; Properties 9, 10, 12)"`

### Task 22: [D1][D3] Env-gated real-binary tests

**Files:**
- Create: `tests/integration/wavekit-chan-binary.test.ts`

Gate: `WAVEKIT_CHAN_BIN=native/wavekit-chan/target/release/wavekit-chan`, built with `make chan-build`. The suite skips without it.

- [ ] **Step 1: Write the tests**

```ts
// tests/integration/wavekit-chan-binary.test.ts
import { mkdirSync } from "node:fs"
import { createConnection } from "node:net"
import fc from "fast-check"
import pino from "pino"
import { admitChannel } from "../../src/core/channelizer/admission.js"
import { ChannelizerProcess } from "../../src/core/channelizer/channelizer-process.js"
import type { ChannelizerEvent } from "../../src/core/channelizer/protocol.js"

const bin = process.env["WAVEKIT_CHAN_BIN"]
const logger = pino({ level: "silent" })
const dir = `/tmp/wkc-bin-${process.pid}`

async function spawnChan(fs: number) {
	mkdirSync(dir, { recursive: true })
	const p = new ChannelizerProcess({ binaryPath: bin!, generation: 1, inputRateHz: fs, inputCenterHz: 100e6, usableFraction: 0.8, blockSamples: 16384, socketDir: dir }, logger)
	const events: ChannelizerEvent[] = []
	const protocolErrors: string[] = []
	p.on("event", (e: ChannelizerEvent) => events.push(e))
	p.on("protocol-error", (line: string) => protocolErrors.push(line))
	await p.start()
	return { p, events, protocolErrors }
}
const next = (events: ChannelizerEvent[], pred: (e: ChannelizerEvent) => boolean) => vi.waitFor(() => { const e = events.find(pred); if (!e) throw new Error("waiting"); return e }, { timeout: 5000 })

describe.skipIf(!bin)("wavekit-chan binary", () => {
	// Feature: core-channelizer, Property 1: Admission agreement
	// Validates: addendum §11, §12.1
	it("agrees with admitChannel on random requests", async () => {
		for (const fs of [2_048_000, 2_400_000, 1_800_000 + Math.floor(Math.random() * 1_000_000)]) {
			const { p, events } = await spawnChan(fs)
			let n = 0
			await fc.assert(
				fc.asyncProperty(fc.double({ min: -1.5e6, max: 1.5e6, noNaN: true }), fc.constantFrom(24_000, 48_000, 250_000, 384_000), fc.double({ min: 0.5, max: 0.99, noNaN: true }), fc.double({ min: 0.005, max: 0.2, noNaN: true }), async (off, out, bwF, trF) => {
					const id = `p1-${n++}`
					const req = { centerHz: 100e6 + off, bandwidthHz: out * bwF, transitionHz: out * trF, outputRateHz: out, format: "cu8" as const }
					p.send({ v: 1, type: "open", id, ...req, queueBytes: 4096 })
					const e = await next(events, x => "id" in x && x.id === id && (x.type === "opened" || x.type === "rejected"))
					expect(e.type === "opened").toBe(admitChannel(req, { sampleRateHz: fs, centerHz: 100e6 }, 0.8).admitted)
					if (e.type === "opened") p.send({ v: 1, type: "close", id })
				}),
				{ numRuns: 34 },
			)
			await p.stop()
		}
	}, 120000)
	// Feature: core-channelizer, Property 14: Protocol validity
	// Validates: addendum §11, §12.14
	it("emits only schema-valid lines and survives malformed requests", async () => {
		const { p, events, protocolErrors } = await spawnChan(2_048_000)
		const control = (p as unknown as { control: { write(s: string): void } }).control
		await fc.assert(fc.asyncProperty(fc.string(), async s => { control.write(`${s.replace(/\n/g, " ")}\n`) }), { numRuns: 100 })
		p.send({ v: 1, type: "open", id: "alive", centerHz: 100e6, bandwidthHz: 45_600, transitionHz: 1_200, outputRateHz: 48_000, format: "cf32", queueBytes: 96_000 })
		await next(events, e => e.type === "opened" && e.id === "alive")
		expect(protocolErrors).toEqual([])
		await p.stop()
	}, 60000)
	// Feature: core-channelizer, Property 13: EOF tail
	// Validates: addendum §11, §12.13
	it("emits input-eof with the odd byte and exits 0", async () => {
		const { p, events } = await spawnChan(2_048_000)
		const exit = new Promise<number | null>(resolve => p.once("exit", (code: number | null) => resolve(code)))
		p.input.end(Buffer.from([1, 2, 3]))
		expect(await next(events, e => e.type === "input-eof")).toMatchObject({ inputSamples: 1, discardedBytes: 1 })
		expect(await exit).toBe(0)
	})
	// Feature: core-channelizer, Property 8: Bounded queue (process level)
	// Validates: addendum §6, §12.8
	it("bounds a stalled channel without perturbing the other channel", async () => {
		const input = Buffer.alloc(2 * 2_048_000, 0).map((_, k) => (k * 31) % 256)
		const run = async (withStalled: boolean) => {
			const { p, events } = await spawnChan(2_048_000)
			const open = (id: string, queueBytes: number) => p.send({ v: 1, type: "open", id, centerHz: 100.1e6, bandwidthHz: 45_600, transitionHz: 1_200, outputRateHz: 48_000, format: "cf32", queueBytes })
			open("fast", 1 << 24)
			if (withStalled) open("slow", 8_000)
			const fast = await next(events, e => e.type === "opened" && e.id === "fast")
			const chunks: Buffer[] = []
			const sock = createConnection((fast as { socket: string }).socket)
			sock.on("data", (b: Buffer) => chunks.push(b))
			if (withStalled) {
				const slow = await next(events, e => e.type === "opened" && e.id === "slow")
				createConnection((slow as { socket: string }).socket).pause()
			}
			p.input.end(input)
			await next(events, e => e.type === "input-eof")
			await new Promise(r => sock.once("close", r))
			return { bytes: Buffer.concat(chunks), events }
		}
		const alone = await run(false)
		const loaded = await run(true)
		expect(loaded.bytes.equals(alone.bytes)).toBe(true)
		const overflow = loaded.events.filter(e => e.type === "discontinuity" && e.id === "slow" && e.cause === "queue-overflow")
		expect(overflow.length).toBeGreaterThan(0)
	}, 60000)
	// Review Focus 7 at process level: the main loop's ClientGone path and close() of a writer blocked in write_all
	it("closes a stalled and a destroyed client promptly while another channel keeps flowing", async () => {
		const { p, events } = await spawnChan(2_048_000)
		for (const id of ["stalled", "gone", "live"])
			p.send({ v: 1, type: "open", id, centerHz: 100e6, bandwidthHz: 45_600, transitionHz: 1_200, outputRateHz: 48_000, format: "cf32", queueBytes: 1 << 24 })
		const socketOf = async (id: string) => ((await next(events, e => e.type === "opened" && e.id === id)) as { socket: string }).socket
		createConnection(await socketOf("stalled")).pause() // connected, never reads
		const gone = createConnection(await socketOf("gone"))
		await new Promise(r => gone.once("connect", r))
		gone.destroy()
		const chunks: Buffer[] = []
		const live = createConnection(await socketOf("live"))
		live.on("data", (b: Buffer) => chunks.push(b))
		const second = Buffer.alloc(2 * 2_048_000, 128) // 1 s → 48 000 cf32 samples per channel
		p.input.write(second)
		await next(events, e => e.type === "closed" && e.id === "gone") // reason client-gone, via the unbounded gone channel
		await new Promise(r => setTimeout(r, 300)) // the stalled writer is blocked in write_all by now
		const t = Date.now()
		p.send({ v: 1, type: "close", id: "stalled" })
		await next(events, e => e.type === "closed" && e.id === "stalled")
		expect(Date.now() - t).toBeLessThan(2000)
		p.input.end(second)
		await next(events, e => e.type === "input-eof")
		await new Promise(r => live.once("close", r))
		expect(Buffer.concat(chunks).length).toBe(2 * 48_000 * 8)
	}, 60000)
})
```

- [ ] **Step 2: Run locally only if the binary is already built** (`make chan-build` is a light crate build). If so: `WAVEKIT_CHAN_BIN=native/wavekit-chan/target/release/wavekit-chan pnpm exec vitest run tests/integration/wavekit-chan-binary.test.ts`. Expected: PASS. Without the env var: skipped. Fix runtime bugs in Task 15's files and keep the tests unchanged.
- [ ] **Step 3: Commit** `git add tests/integration/wavekit-chan-binary.test.ts && git commit -m "test(chan): env-gated real-binary tests (Properties 1, 8, 13, 14; close of stalled clients)"`

### Task 23: Decoder-side requests and the cf32 tail (no behaviour change)

**Files:**
- Modify: `src/decoders/types.ts`: add `channelHz?: number | undefined` to `DemodulationConfig`; add to the `Decoder` interface, after `getRateAdapter?`:

```ts
	/**
	 * The channel this instance wants from the core channelizer (addendum §2).
	 * Undefined: not channelisable (raw fanout). Pure: no spawn, no option change.
	 */
	getChannelRequest?(input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequestResult | undefined
```

  plus `export type CoreSuspensionReason = NonNullable<DecoderRateAssessment["reasonCode"]> | ChannelAdmissionReason` and type re-exports of `DecoderChannelRequest`/`DecoderChannelRequestResult` from `../core/channelizer/types.js`.
- Modify: `src/decoders/iq-decimate-decoder.ts`: `channelHz?: number | undefined` on `IqDecimationConfig`, `iqChannelRequest()`, base `getChannelRequest()`, `protected channelizerSupported(): boolean { return false }`.
- Modify: `src/decoders/audio-demod-decoder.ts`: `audioChannelRequest()`, base `getChannelRequest()`, `channelizerSupported()`, and the cf32 tail in `buildPipelineCommand` (stages at :323–337 on `main`).
- Modify: `src/decoders/builtin/dsd-fme.ts` (cf32 tail: first stages at :587–588 in `buildPipelineCommand` :570), `src/decoders/builtin/dumpvdl2.ts` (centre and bandwidth override), `src/decoders/builtin/acarsdec.ts` (centre rule).
- Test: `tests/unit/decoders/channel-requests.test.ts`

**Interfaces:**
- Produces: `iqChannelRequest(config: IqDecimationConfig, input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequest`, `audioChannelRequest(config: DemodulationConfig, input): DecoderChannelRequest`, `readChannelHz(options: Record<string, unknown>): number | undefined`, and the option key `inputIqFormat: "cu8" | "cf32"` that the manager injects.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/decoders/channel-requests.test.ts
import pino from "pino"
import type { DecoderFactory } from "../../../src/decoders/registry.js"
import { createAcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { createAisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { createDirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import { createDsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { createDumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { createLoraMeshtasticDecoder } from "../../../src/decoders/builtin/lora-meshtastic.js"
import { createMultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { createReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { createRtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { iqChannelRequest } from "../../../src/decoders/iq-decimate-decoder.js"
import { audioChannelRequest } from "../../../src/decoders/audio-demod-decoder.js"

const logger = pino({ level: "silent" })
// src/decoders/registry.ts has no default-registry helper; src/index.ts registers these same factories inline (:316–333).
const FACTORIES: Record<string, DecoderFactory> = {
	acarsdec: createAcarsdecDecoder,
	"ais-catcher": createAisCatcherDecoder,
	direwolf: createDirewolfDecoder,
	"dsd-fme": createDsdFmeDecoder,
	dumpvdl2: createDumpvdl2Decoder,
	"lora-meshtastic": createLoraMeshtasticDecoder,
	"multimon-ng": createMultimonDecoder,
	readsb: createReadsbDecoder,
	rtl433: createRtl433Decoder,
}
/** Builds a built-in decoder straight from its factory (no registry, no spawn). Tasks 28–31 reuse it. */
const make = (type: string, options: Record<string, unknown> = {}) => {
	const factory = FACTORIES[type]
	if (!factory) throw new Error(`no factory for ${type}`)
	return factory({ id: `t-${type}`, type, enabled: true, options: { inputSampleRate: 2_048_000, inputCenterFreq: 162e6, ...options } }, logger)
}

describe("channel requests (addendum §1, §2)", () => {
	it("derives the default IQ passband from the output rate", () => {
		// AIS: the channel centre is the A/B pair centre 162.000 MHz (AIS-catcher expects ±25 kHz around it).
		expect(iqChannelRequest({ targetSampleRate: 384_000, inputSampleRate: 2_048_000, filterTransition: 0.05, channelHz: 162_000_000 }, { sampleRateHz: 2_048_000, centerHz: 161.9e6 })).toEqual({ centerHz: 162_000_000, bandwidthHz: 364_800, transitionHz: 9_600, outputRateHz: 384_000, format: "cu8" })
		expect(iqChannelRequest({ targetSampleRate: 250_000, inputSampleRate: 2_048_000 }, { sampleRateHz: 2_048_000, centerHz: 433.92e6 }).centerHz).toBe(433.92e6)
	})
	it("derives cf32 audio requests at the exact demod rate", () => {
		const r = audioChannelRequest({ bandwidth: 12_500, sampleRate: 22_050, demodSampleRate: 48_000, inputSampleRate: 2_048_000, deEmphasis: false, filterTransition: 0.012 }, { sampleRateHz: 2_048_000, centerHz: 1e8 })
		expect(r).toMatchObject({ outputRateHz: 48_000, format: "cf32" })
		// 48000 * (1 - 0.012) and 48000 * 0.012 / 2 are not exact in binary floating point
		expect(r.bandwidthHz).toBeCloseTo(47_424, 6)
		expect(r.transitionHz).toBeCloseTo(288, 6)
	})
	it("keeps every built-in non-channelisable until its migration task", () => {
		for (const type of ["ais-catcher", "dumpvdl2", "rtl433", "direwolf", "multimon-ng", "dsd-fme", "acarsdec", "lora-meshtastic", "readsb"]) {
			expect(make(type).getChannelRequest?.({ sampleRateHz: 2_048_000, centerHz: 162e6 })).toBeUndefined()
		}
	})
	it("cf32 input drops the leading convert and firdecimate from the audio tail", () => {
		const d = make("multimon-ng", { inputSampleRate: 48_000, inputIqFormat: "cf32" }) as unknown as { buildPipelineCommand(): string }
		const cmd = d.buildPipelineCommand()
		expect(cmd).not.toContain("csdr convert -i char -o float")
		expect(cmd).not.toContain("firdecimate")
		expect(cmd).toMatch(/^(csdr agc -f complex|csdr fmdemod)|\| ?csdr (agc -f complex|fmdemod)/)
		const raw = make("multimon-ng") as unknown as { buildPipelineCommand(): string }
		expect(raw.buildPipelineCommand()).toContain("csdr convert -i char -o float")
	})
	it("dsd-fme cf32 input starts at fmdemod", () => {
		const cmd = (make("dsd-fme", { inputSampleRate: 48_000, inputIqFormat: "cf32" }) as unknown as { buildPipelineCommand(): string }).buildPipelineCommand()
		expect(cmd).not.toContain("csdr convert -i char -o float")
		expect(cmd).not.toContain("firdecimate")
	})
})
```

`make()` calls the exported per-decoder factories directly (verify each import with Grep before running; the names and lines are in Plan-time facts). Do not add a default-registry helper to `src/decoders/registry.ts`. `buildPipelineCommand` is `protected`; access it through the cast exactly as above.

- [ ] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run tests/unit/decoders/channel-requests.test.ts`
- [ ] **Step 3: Implement**

```ts
// src/decoders/iq-decimate-decoder.ts (additions)
import { z } from "zod"
import type { DecoderChannelRequest, DecoderChannelRequestResult } from "../core/channelizer/types.js"

const ChannelHzSchema = z.number().finite().positive().optional()
export function readChannelHz(options: Record<string, unknown>): number | undefined {
	const parsed = ChannelHzSchema.safeParse(options["channelHz"])
	return parsed.success ? parsed.data : undefined
}

/** Addendum §2 default passband: t = filterTransition ?? 0.05 relative to the OUTPUT rate (plan A11). */
export function iqChannelRequest(config: IqDecimationConfig, input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequest {
	const t = config.filterTransition ?? 0.05
	const outputRateHz = config.targetSampleRate
	return { centerHz: config.channelHz ?? input.centerHz ?? 0, bandwidthHz: outputRateHz * (1 - t), transitionHz: (outputRateHz * t) / 2, outputRateHz, format: "cu8" }
}

// inside class IqDecimateDecoder
	/** Migration flag (addendum §7): flipped per decoder by Tasks 28–30. */
	protected channelizerSupported(): boolean {
		return false
	}

	getChannelRequest(input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequestResult | undefined {
		if (!this.channelizerSupported()) return undefined
		const config = { ...this.getIqDecimationConfig() }
		config.channelHz ??= readChannelHz(this.config.options)
		if (config.channelHz === undefined) this.logger.info("No channelHz; requesting the capture centre (offset 0)")
		if (config.filterCutoff !== undefined) this.logger.warn({ filterCutoff: config.filterCutoff }, "filterCutoff is not translated to a channel passband")
		return iqChannelRequest(config, input)
	}
```

```ts
// src/decoders/audio-demod-decoder.ts (additions)
export function audioChannelRequest(config: DemodulationConfig, input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequest {
	const t = config.filterTransition ?? 0.05
	const outputRateHz = config.demodSampleRate ?? config.sampleRate
	return { centerHz: config.channelHz ?? input.centerHz ?? 0, bandwidthHz: outputRateHz * (1 - t), transitionHz: (outputRateHz * t) / 2, outputRateHz, format: "cf32" }
}
// the class gets the same channelizerSupported()/getChannelRequest() pair, using getDemodConfig() and audioChannelRequest()

// in buildPipelineCommand, replacing the first stage and the firdecimate push:
		const channelised = this.config.options["inputIqFormat"] === "cf32"
		const csdrStages: string[] = channelised ? [] : ["csdr convert -i char -o float"]
		if (config.enableIqAgc) {
			csdrStages.push("csdr agc -f complex -p slow -r 0.7")
		}
		if (!channelised) {
			csdrStages.push(`csdr firdecimate ${decimation} ${transition}${cutoffArg}`)
		}
```

In `dsd-fme.ts` `buildPipelineCommand`, make the same change to its first two stages: when `this.config.options["inputIqFormat"] === "cf32"`, `csdrStages` starts at `"csdr fmdemod"`.

`dumpvdl2.ts` overrides `getChannelRequest` like this (the base check still applies):

```ts
	override getChannelRequest(input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequestResult | undefined {
		if (!this.channelizerSupported()) return undefined
		const freqs = this.options.frequencies
		const span = freqs.length > 0 ? Math.max(...freqs) - Math.min(...freqs) : 0
		const channelHz = readChannelHz(this.config.options) ?? (this.options.followCenter ? undefined : (Math.min(...freqs) + Math.max(...freqs)) / 2)
		const base = iqChannelRequest({ ...this.getIqDecimationConfig(), ...(channelHz !== undefined ? { channelHz } : {}) }, input)
		return { ...base, bandwidthHz: Math.max(base.bandwidthHz, span + 50_000) }
	}
```

`acarsdec.ts` overrides `getChannelRequest`:

```ts
	override getChannelRequest(input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequestResult | undefined {
		if (!this.channelizerSupported()) return undefined
		const freqs = this.options.frequencies ?? []
		const channelHz = readChannelHz(this.config.options) ?? (freqs.length === 1 ? freqs[0] : undefined)
		if (channelHz === undefined) return { invalid: `acarsdec decodes one AM channel; set options.channelHz (frequencies: ${freqs.join(",")})` }
		return audioChannelRequest({ ...this.getDemodConfig(), channelHz }, input)
	}
```

These rely on `--centerfreq` already coming from `options.inputCenterFreq` (`dumpvdl2.ts` :228–229), which the manager sets to the channel centre in Task 24. Check that the existing `dumpvdl2.test.ts` assertions on `--centerfreq` still pass unchanged.

- [ ] **Step 4: Run the new test and the existing pipeline tests**

Run: `pnpm exec vitest run tests/unit/decoders/channel-requests.test.ts tests/unit/decoders/ais-catcher.test.ts tests/unit/decoders/dumpvdl2.test.ts tests/unit/decoders/rtl433.test.ts tests/unit/decoders/multimon-ng.test.ts tests/unit/decoders/direwolf.test.ts tests/unit/decoders/dsd-fme.test.ts tests/unit/decoders/acarsdec.test.ts tests/unit/decoders/rate-adapters.test.ts`
Expected: PASS, with the existing pipeline-string assertions unchanged (byte-identical default path).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
git add src/decoders/types.ts src/decoders/iq-decimate-decoder.ts src/decoders/audio-demod-decoder.ts src/decoders/builtin/dsd-fme.ts src/decoders/builtin/dumpvdl2.ts src/decoders/builtin/acarsdec.ts tests/unit/decoders/channel-requests.test.ts
git commit -m "feat(decoders): channel requests and cf32 audio tail behind migration flags (addendum §1-§3)"
```

### Task 24: `DecoderManager` channel integration

**Files:**
- Modify: `src/decoders/manager.ts` (internal only; public method signatures and events unchanged; one additive setter)
- Create: `tests/mocks/channel-fakes.ts`
- Test: `tests/unit/decoders/manager-channelizer.test.ts`

**Interfaces:**
- Consumes: `ChannelProvider`, `ChannelAdmissionReason`, `isChannelAdmissionReason`, `RealisedChannel` (Task 16); `channelisedRatePlan` (Task 16); `CoreSuspensionReason`, `getChannelRequest?` (Task 23); `RateDecoder`, `FakeSources`, `iqCaps`, `deferred` (`tests/mocks/rate-fakes.ts`, from B3).
- Produces:
  - `DecoderManager.setChannelizer(provider: ChannelProvider | null): void` (additive, optional; absent means today's behaviour).
  - New `DecoderState` fields: `channel: { channelId: string; sourceId: string; generation: number; realised: RealisedChannel } | null` and `channelStale: boolean`.
  - `DecoderSuspension.reasonCode` widens to `CoreSuspensionReason`.
  - `FakeChannelProvider` in `tests/mocks/channel-fakes.ts`: `results: ChannelRequestResult[]` (scripted FIFO), `calls`, `released`, `invalidate(sourceId, ids)`, `generation`, `pending?: Deferred`.

- [ ] **Step 1: Write the fake provider**

```ts
// tests/mocks/channel-fakes.ts
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { SourceCaps } from "../../src/config.js"
import type { ChannelProvider, ChannelRequestResult, DecoderChannelRequest } from "../../src/core/channelizer/types.js"

export class FakeChannelProvider extends EventEmitter implements ChannelProvider {
	generation = 1
	results: Array<ChannelRequestResult | "ok"> = []
	calls: Array<{ sourceId: string; decoderId: string; req: DecoderChannelRequest; inputCaps: SourceCaps | undefined }> = []
	released: string[] = []
	streams = new Map<string, PassThrough>()
	gate: Promise<void> | null = null
	async requestChannel(sourceId: string, decoderId: string, req: DecoderChannelRequest, inputCaps: SourceCaps | undefined): Promise<ChannelRequestResult> {
		this.calls.push({ sourceId, decoderId, req, inputCaps })
		if (this.gate) await this.gate
		const next = this.results.shift() ?? "ok"
		if (next !== "ok") return next
		const channelId = `${decoderId}-g${this.generation}`
		const stream = new PassThrough()
		this.streams.set(channelId, stream)
		return { ok: true, stream, channelId, generation: this.generation, realised: { outputRateHz: req.outputRateHz, format: req.format, groupDelaySamples: 10 } }
	}
	async releaseChannel(channelId: string): Promise<void> { this.released.push(channelId); this.streams.get(channelId)?.destroy() }
	currentGeneration(): number { return this.generation }
	invalidate(sourceId: string, ids: string[]): void {
		const gen = this.generation++
		this.emit("channel-invalidated", sourceId, gen, ids)
		for (const id of ids) this.streams.get(id)?.destroy()
	}
}
```

- [ ] **Step 2: Write the failing test**

Mirror the setup of `tests/unit/decoders/manager-suspension.test.ts`: fake timers, `FakeSources` with `iqCaps(2_048_000)` plus `centerFreq`, and a registry type `chan-test` whose factory returns `ChannelDecoder`.

```ts
// tests/unit/decoders/manager-channelizer.test.ts (core cases)
class ChannelDecoder extends RateDecoder {
	request: DecoderChannelRequestResult | undefined = { centerHz: 162e6, bandwidthHz: 364_800, transitionHz: 9_600, outputRateHz: 384_000, format: "cu8" }
	attached: Readable[] = []
	detachedAt: string[] = []
	options: Record<string, unknown> = {} // RateDecoder.updateOptions is a no-op; record what the manager injects
	getChannelRequest() { return this.request }
	override updateOptions(updates: Record<string, unknown>) { Object.assign(this.options, updates) }
	override attachInput(s: Readable) { this.attached.push(s); super.attachInput(s) }
	override detachInput() { this.detachedAt.push(this.attached.at(-1)?.destroyed ? "after-destroy" : "before-destroy"); super.detachInput() }
}

describe("DecoderManager + channelizer (addendum §4, §5)", () => {
	it("wires a channel instead of a fanout branch and injects the realised rate", async () => {
		create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		expect(provider.calls).toHaveLength(1)
		expect(fanout.getBranchIds()).not.toContain("decoder-dec")
		expect(decoders.get("dec")!.options).toMatchObject({ inputSampleRate: 384_000, inputCenterFreq: 162e6, inputIqFormat: "cu8" })
		expect(status().rateAssessment).toMatchObject({ adaptation: "resample", frontendRateHz: 384_000 })
	})
	// Feature: core-channelizer, Property 11: Rejection is a suspension
	// Validates: addendum §5, §12.11
	it("turns every rejection into a suspension without failure accounting", async () => {
		for (const reasonCode of ["channel-outside-capture", "channel-request-invalid", "channelizer-unavailable"] as const) {
			provider.results.push({ ok: false, reasonCode, detail: "x" })
			const id = `dec-${reasonCode}`
			create(id, { useChannelizer: true })
			await manager.startDecoder(id)
			const s = manager.getStatus(id)!
			expect(s).toMatchObject({ suspended: true, desiredRunning: true, restartCount: 0 })
			// DecoderStatus has no `enabled`; the manager keeps the DecoderConfig passed to createDecoder by reference
			// (state.config), so Property 11's "enabled unchanged" is checked on that object.
			expect(configs.get(id)!.enabled).toBe(true)
			expect(s.suspension).toBeUndefined() // plan A3: no false rate code in the DTO
			expect(s.lastError ?? null).toBeNull()
			expect(decoders.get(id)!.starts).toBe(0) // RateDecoder counts start() calls in `starts`
		}
		expect(restarting).toEqual([])
	})
	it("logs channelizer-unavailable once across decoders", async () => { // Review Focus 4
		const errors = vi.spyOn(logSink, "error")
		provider.results.push({ ok: false, reasonCode: "channelizer-unavailable", detail: "ENOENT" }, { ok: false, reasonCode: "channelizer-unavailable", detail: "ENOENT" })
		create("a", { useChannelizer: true }); create("b", { useChannelizer: true }); create("raw")
		await manager.startDecoder("a"); await manager.startDecoder("b"); await manager.startDecoder("raw")
		expect(errors.mock.calls.filter(c => JSON.stringify(c).includes("channelizer-unavailable"))).toHaveLength(1)
		expect(status("raw").running).toBe(true)
	})
	it("detaches synchronously on invalidation and restarts through the worker without budget", async () => { // Review Focus 3
		create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		provider.invalidate("rtl", ["dec-g1"])
		expect(decoders.get("dec")!.detachedAt).toEqual(["before-destroy"])
		await settle()
		expect(provider.calls).toHaveLength(2)
		expect(status().restartCount).toBe(0)
		expect(restarting).toEqual([])
	})
	it("suspends when a retune moves the channel out, resumes when it fits again", async () => {
		create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		provider.results.push({ ok: false, reasonCode: "channel-outside-capture", detail: "x" })
		sources.setCaps("rtl", { ...iqCaps(2_048_000), centerFreq: 170e6 })
		provider.invalidate("rtl", ["dec-g1"])
		await settle()
		expect(status().suspended).toBe(true)
		sources.setCaps("rtl", { ...iqCaps(2_048_000), centerFreq: 162e6 })
		await settle()
		expect(status()).toMatchObject({ suspended: false, running: true })
	})
	it("does not churn status for identical caps while channel-suspended", async () => { // Review Focus 5
		provider.results.push({ ok: false, reasonCode: "channel-request-invalid", detail: "x" })
		create("dec", { useChannelizer: true })
		await manager.startDecoder("dec")
		statusEvents.length = 0
		sources.setCaps("rtl", sources.caps.get("rtl")!)
		await settle()
		expect(statusEvents).toEqual([])
		expect(provider.calls).toHaveLength(1)
	})
	it("a stop during a pending request attaches nothing and releases the channel", async () => {
		let open!: () => void
		provider.gate = new Promise(r => { open = r })
		create("dec", { useChannelizer: true })
		const starting = manager.startDecoder("dec")
		await Promise.resolve()
		await manager.stopDecoder("dec")
		open()
		await starting
		expect(decoders.get("dec")!.attached).toEqual([])
		expect(provider.released).toEqual(["dec-g1"])
		expect(status().suspended).toBe(false)
	})
	it("useChannelizer false keeps the raw branch", async () => {
		create("dec")
		await manager.startDecoder("dec")
		expect(provider.calls).toEqual([])
		expect(fanout.getBranchIds()).toContain("decoder-dec")
	})
})
```

Adapt `create`, `status`, `settle`, `sources.setCaps`, `statusEvents`, `restarting` and `logSink` to the helpers `manager-suspension.test.ts` already defines. Add a `useChannelizer` parameter to `create`, make `create` record the `DecoderConfig` it passes in a `configs: Map<string, DecoderConfig>`, and call `manager.setChannelizer(provider)` in `beforeEach`. `RateDecoder` (`tests/mocks/rate-fakes.ts`) has `starts` (not `startCalls`) and a no-op `updateOptions` with no `options` field, so `ChannelDecoder` adds `options` and overrides `updateOptions` as above. Never edit `rate-fakes.ts`, which is owned by the core agent.

- [ ] **Step 3: Run it and confirm it fails.** `pnpm exec vitest run tests/unit/decoders/manager-channelizer.test.ts`
- [ ] **Step 4: Implement in `src/decoders/manager.ts`** (find each site by symbol)

1. Imports: `import type { ChannelAdmissionReason, ChannelProvider, DecoderChannelRequestResult, RealisedChannel } from "../core/channelizer/types.js"`, `import { isChannelAdmissionReason } from "../core/channelizer/types.js"`, `import { channelisedRatePlan } from "../core/channelizer/rate-plan.js"`, `import type { CoreSuspensionReason, DecoderSuspensionStatus } from "./types.js"`.
2. `interface DecoderSuspension { reasonCode: CoreSuspensionReason; since: Date }`. Add to `DecoderState`: `channel: OpenChannelRef | null` and `channelStale: boolean`, and initialise both (`null`, `false`) next to `rateGeneration: 0`.
3. Add these fields and methods:

```ts
	private channelizer: ChannelProvider | null = null
	private channelizerUnavailableLogged = false
	private readonly channelInvalidatedHandler = (sourceId: string, _generation: number, channelIds: string[]): void => {
		for (const state of this.decoders.values()) {
			if (!state.channel || !channelIds.includes(state.channel.channelId)) continue
			// Before the provider destroys the socket: the decoder's stdin must not see EOF.
			try { state.decoder.detachInput() } catch (err: unknown) { this.log.warn({ err, decoderId: state.config.id }, "detachInput failed on channel invalidation") }
			state.branchId = null
			state.channel = null
			state.channelStale = true
		}
		this.enqueueSourceEvaluation(sourceId, { caps: this.sourceManager?.getCaps(sourceId) ?? null, adapt: true })
	}

	/** Optional core channelizer (addendum §4). Null keeps today's raw fanout path. */
	setChannelizer(provider: ChannelProvider | null): void {
		this.channelizer?.off("channel-invalidated", this.channelInvalidatedHandler as never)
		this.channelizer = provider
		provider?.on("channel-invalidated", this.channelInvalidatedHandler)
	}

	private channelRequestFor(state: DecoderState): DecoderChannelRequestResult | undefined {
		if (!this.channelizer || state.config.useChannelizer !== true) return undefined
		const caps = state.inputCaps
		if (!caps) return undefined
		return state.decoder.getChannelRequest?.({ sampleRateHz: caps.sampleRate, ...(caps.centerFreq !== undefined ? { centerHz: caps.centerFreq } : {}) })
	}

	private releaseChannelOf(state: DecoderState): void {
		const ref = state.channel
		if (!ref) return
		state.channel = null
		const provider = this.channelizer
		if (provider) void provider.releaseChannel(ref.channelId).catch((err: unknown) => this.log.warn({ err, channelId: ref.channelId }, "Channel release failed"))
	}

	private holdForChannel(state: DecoderState, outcome: { reasonCode: ChannelAdmissionReason; detail: string }): void {
		state.suspension = { reasonCode: outcome.reasonCode, since: state.suspension?.since ?? new Date() }
		state.transition = null
		const fields = { decoderId: state.config.id, reasonCode: outcome.reasonCode, detail: outcome.detail }
		if (outcome.reasonCode === "channelizer-unavailable") {
			if (!this.channelizerUnavailableLogged) this.log.error(fields, "Channelizer unavailable; channelised decoders suspended")
			this.channelizerUnavailableLogged = true
		} else {
			this.log.info(fields, "Decoder suspended: channel not admitted")
		}
		this.emitStatusChanged(state)
	}
```

4. `wireDecoderToFanout` returns `Promise<WireOutcome>`, where `type WireOutcome = { wired: true } | { wired: false; superseded: true } | { wired: false; superseded: false; reasonCode: ChannelAdmissionReason; detail: string }`. The external early return becomes `return { wired: true }`. After the `assignDecoder` block and before `const branchId = …`, insert:

```ts
		const request = this.channelRequestFor(state)
		if (request && sourceId) return this.wireDecoderToChannel(state, sourceId, request)
		if (config.options["inputIqFormat"] !== undefined) decoder.updateOptions({ inputIqFormat: "cu8" })
```

The function ends with `return { wired: true }`. Add:

```ts
	private async wireDecoderToChannel(state: DecoderState, sourceId: string, request: DecoderChannelRequestResult): Promise<WireOutcome> {
		const provider = this.channelizer!
		if ("invalid" in request) return { wired: false, superseded: false, reasonCode: "channel-request-invalid", detail: request.invalid }
		const generation = state.rateGeneration
		const result = await provider.requestChannel(sourceId, state.config.id, request, state.inputCaps)
		if (!result.ok) return { wired: false, superseded: false, reasonCode: result.reasonCode, detail: result.detail }
		const stale = this.destroying || this.decoders.get(state.config.id) !== state || state.rateGeneration !== generation || !state.desiredRunning || result.generation !== provider.currentGeneration(sourceId)
		if (stale) {
			result.stream.destroy()
			await provider.releaseChannel(result.channelId)
			return { wired: false, superseded: true }
		}
		state.branchId = result.channelId
		state.branchFanout = null
		state.channel = { channelId: result.channelId, sourceId, generation: result.generation, realised: result.realised }
		state.channelStale = false
		state.decoder.updateOptions({ inputSampleRate: result.realised.outputRateHz, inputCenterFreq: request.centerHz, inputIqFormat: result.realised.format })
		state.decoder.attachInput(result.stream)
		if (state.ratePlan && state.ratePlan.verdict !== "unusable") state.ratePlan = channelisedRatePlan(state.ratePlan, result.realised)
		return { wired: true }
	}
```

5. Callers of `wireDecoderToFanout`:
   - `startDecoder`: `const outcome = await this.wireDecoderToFanout(state); if (!outcome.wired) { if (!outcome.superseded) this.holdForChannel(state, outcome); return }` before `await state.decoder.start()`.
   - `resume`: after wiring, `if (!outcome.wired) { if (outcome.superseded || !this.stillWanted(state, generation)) return await abandon(false); this.holdForChannel(state, outcome); return }`.
   - Restart timer in `handleDecoderExit`: `const outcome = await this.wireDecoderToFanout(state); if (!outcome.wired) { if (!outcome.superseded) this.holdForChannel(state, outcome); return }`.
6. Call `this.releaseChannelOf(state)` as the first statement of both `unwireDecoderFromFanout` and `detachBranch`. Both already null-guard `branchFanout`. Also set `state.channelStale = false` in `unwireDecoderFromFanout`.
7. In `handleCapsChange`, extend the restart condition: `if (inputChanged || !passive || state.channelStale) restartDecoders.add(decoderId)`.
8. In the suspended branch of `evaluateRate`, before `else if (plan.verdict !== "unusable")`, add a no-churn guard:

```ts
			} else if (isChannelAdmissionReason(state.suspension.reasonCode) && caps && state.inputCaps && caps.sampleRate === state.inputCaps.sampleRate && caps.centerFreq === state.inputCaps.centerFreq && !state.channelStale) {
				state.ratePlan = plan
				this.publishIfRateChanged(state, before)
```

9. `assessState`: rename the existing method to `assessSourceRate` (same body) and add `private assessState(state, caps) { const plan = this.assessSourceRate(state, caps); return state.channel && plan.verdict !== "unusable" ? channelisedRatePlan(plan, state.channel.realised) : plan }`.
10. `getStatus`: replace `...(state.suspension ? { suspension: { ...state.suspension } } : {})` with `...publicSuspension(state.suspension)`, using this module-level helper:

```ts
/** Plan A3: channel reasons are not in the shared rate union yet; omit the object rather than emit a false code. */
function publicSuspension(s: DecoderSuspension | null): { suspension?: DecoderSuspensionStatus } {
	if (!s) return {}
	const code = s.reasonCode
	if (isChannelAdmissionReason(code)) return {}
	return { suspension: { reasonCode: code, since: s.since } }
}
```

11. In `destroy()`, call `this.setChannelizer(null)`.

- [ ] **Step 5: Run the new test plus the rate-model regression tests**

Run: `pnpm exec vitest run tests/unit/decoders/manager-channelizer.test.ts tests/unit/decoders/manager-suspension.test.ts tests/unit/decoders/manager-lifecycle.test.ts tests/unit/decoders/source-routing.test.ts tests/unit/decoders/health-state-transitions.test.ts tests/unit/api/decoder-status-contract.test.ts tests/unit/api/decoder-rate-contract.test.ts`
Expected: PASS. Existing suites are unchanged.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
git add src/decoders/manager.ts tests/mocks/channel-fakes.ts tests/unit/decoders/manager-channelizer.test.ts
git commit -m "feat(core): route channelised decoders through the channelizer with suspension semantics (addendum §4, §5; Property 11)"
```

### Task 25: `index.ts` wiring and docs

**Files:**
- Modify: `src/index.ts` (after `decoderManager.setSourceManager(sourceManager, sourceRouting)`, about :314; shutdown near `await decoderManager.destroy()`, about :546)
- Modify: `docs/ARCHITECTURE.md` (a short "Core channelizer (opt-in)" subsection)
- Test: `tests/unit/core/channelizer-manager.test.ts` (no new test; the wiring is covered by the typecheck and the Task 27 smoke)

- [ ] **Step 1: Wire it**

```ts
// src/index.ts, after decoderManager.setSourceManager(...)
	const channelizer = config.channelizer.enabled
		? new ChannelizerManager({ sourceManager, routing: sourceRouting, config: config.channelizer, logger })
		: null
	decoderManager.setChannelizer(channelizer)
```

In the shutdown sequence, after `await decoderManager.destroy()`, add `await channelizer?.destroy()`. Add the import `import { ChannelizerManager } from "./core/channelizer/channelizer-manager.js"`.

- [ ] **Step 2: Document it.** Write a 10–15 line subsection in `docs/ARCHITECTURE.md` under the stream pipeline section. It covers: one `wavekit-chan` per source, branch `channelizer-<sourceId>`, per-channel Unix sockets under `channelizer.socketDir`, fd-3 control, opt-in via `channelizer.enabled` plus `useChannelizer`, suspension reasons, and the excluded decoders. Link the addendum.
- [ ] **Step 3: Typecheck and lint.** `pnpm run typecheck && pnpm run lint`
- [ ] **Step 4: Commit** `git add src/index.ts docs/ARCHITECTURE.md && git commit -m "feat(core): wire opt-in ChannelizerManager into startup and shutdown (addendum §4)"`

### Task 26: [D1] Docker `chan-build` stage and bake cache chain

**Files:**
- Modify: `Dockerfile` (global ARG near :35; new stage before `final-base` :554; copy after :597; verify step :617–629)
- Modify: `docker/bake.hcl` (`final`, `final-core` cache-from)
- Test: `tests/unit/docker/chan-build-stage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/docker/chan-build-stage.test.ts
import { readFileSync } from "node:fs"

const bake = readFileSync("docker/bake.hcl", "utf8")
const dockerfile = readFileSync("Dockerfile", "utf8")
const target = (name: string) => bake.slice(bake.indexOf(`target "${name}" {`), bake.indexOf("\n}\n", bake.indexOf(`target "${name}" {`)))

describe("wavekit-chan image integration (addendum §10)", () => {
	it("caches chan-build only in the final and final-core chains", () => {
		expect(target("final")).toContain('cache("chan-build")')
		expect(target("final-core")).toContain('cache("chan-build")')
		expect(target("final-sdrpp")).not.toContain("chan-build")
		expect(target("final-demod")).not.toContain("chan-build")
	})
	it("builds from a digest-pinned Rust bookworm image with --locked and verifies the binary", () => {
		expect(dockerfile).toMatch(/ARG RUST_IMAGE=rust:1-slim-bookworm@sha256:[0-9a-f]{64}/)
		expect(dockerfile).toMatch(/FROM \$\{RUST_IMAGE\} AS chan-build/)
		expect(dockerfile).toContain("cargo build --release --locked")
		expect(dockerfile).toContain("COPY --from=chan-build /usr/local/bin/wavekit-chan /usr/local/bin/")
		expect(dockerfile).toContain("wavekit-chan --version")
		expect(dockerfile).toContain("ldd /usr/local/bin/wavekit-chan")
	})
})
```

- [ ] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run tests/unit/docker/chan-build-stage.test.ts`
- [ ] **Step 3: Resolve the digest** (lightweight registry call, no build): `docker buildx imagetools inspect rust:1-slim-bookworm --format '{{json .Manifest.Digest}}'`. Paste the result into the ARG.
- [ ] **Step 4: Edit the `Dockerfile`**

```dockerfile
# near the other global ARGs (CSDR_REF at :35)
ARG RUST_IMAGE=rust:1-slim-bookworm@sha256:<digest from step 3>

# -----------------------------------------------------------------------------
# chan-build: wavekit-chan core channelizer (Rust; addendum §10, plan D1)
# -----------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS chan-build
ARG TARGETARCH
WORKDIR /src/wavekit-chan
COPY native/wavekit-chan/Cargo.toml native/wavekit-chan/Cargo.lock ./
COPY native/wavekit-chan/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=chan-cargo-registry-${TARGETARCH} \
    --mount=type=cache,target=/src/wavekit-chan/target,id=chan-target-${TARGETARCH} \
    cargo build --release --locked && \
    install -m 0755 target/release/wavekit-chan /usr/local/bin/wavekit-chan
```

In `final-base`, after the csdr copies:

```dockerfile
COPY --from=chan-build /usr/local/bin/wavekit-chan /usr/local/bin/
```

In the verify `RUN`, insert before the final `echo`:

```dockerfile
    wavekit-chan --version && \
    { ldd /usr/local/bin/wavekit-chan | awk '{print $1}' | grep -Ev '^(linux-vdso\.so\.1|/lib.*/ld-linux.*|libc\.so\.6|libm\.so\.6|libgcc_s\.so\.1|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1)$' > /tmp/chan-libs || true; } && \
    { if [ -s /tmp/chan-libs ]; then echo "unexpected wavekit-chan libs:"; cat /tmp/chan-libs; exit 1; fi; } && \
```

Change the final echo to `"All 9 decoders + csdr + wavekit-chan verified successfully"`. In `docker/bake.hcl`, add `cache("chan-build"),` after `cache("csdr-build"),` in `final` and `final-core` only.

- [ ] **Step 5: Run the test and confirm it passes.** `pnpm exec vitest run tests/unit/docker/chan-build-stage.test.ts`. Do **not** build the image on this Mac; Task 27 builds it on the quiet host.
- [ ] **Step 6: Commit** `git add Dockerfile docker/bake.hcl tests/unit/docker/chan-build-stage.test.ts && git commit -m "build(chan): digest-pinned chan-build stage, verify step and bake cache (addendum §10, D1)"`

### Task 27: CHECKPOINT 4B

- [ ] Dev Mac: `pnpm exec vitest run tests/unit/core tests/unit/decoders/channel-requests.test.ts tests/unit/decoders/manager-channelizer.test.ts tests/unit/decoders/manager-suspension.test.ts tests/unit/utils/channelizer-config.test.ts tests/unit/docker/chan-build-stage.test.ts`, then `make chan-test`, then `pnpm run typecheck && pnpm run lint`. Expected: PASS.
- [ ] Quiet host: `make docker-build` (both arches through bake) and confirm the verify step prints `wavekit-chan 0.1.0 protocol 1`. Then run the Task 22 suite against the in-image binary: `docker run --rm --entrypoint wavekit-chan <image> --version`. For the full suite, mount the repo and set `WAVEKIT_CHAN_BIN=/usr/local/bin/wavekit-chan` inside a node container.
- [ ] Quiet host: run the Task 8 harness with `WAVEKIT_FIXTURE_PATHS=raw` on the new image. Expected: identical results to `fixtures/GOLDENS.md` (default-off byte identity). Append a row.

---

# Batch 4C: Migrations (each gated by Property 15)

Each migration flips one decoder's `channelizerSupported()` to `true`, adds decoder-specific request tests, and passes the golden equality run on a quiet host before the next one starts. Every migration test appends to `tests/unit/decoders/channel-requests.test.ts` and builds decoders with that file's `make()`, which calls the exported per-decoder factories directly (Task 23). There is no default-registry helper; do not add one.

### Task 28: ais-catcher

**Files:** Modify `src/decoders/builtin/ais-catcher.ts` (override `protected override channelizerSupported(): boolean { return true }`); Test `tests/unit/decoders/channel-requests.test.ts` (append); Modify `fixtures/GOLDENS.md`.

- [ ] **Step 1: Failing test.** Append (inside the Task 23 `describe`, reusing its factory-based `make()`):

```ts
	it("ais-catcher requests 384 kHz cu8 at its channelHz and, channelised, runs AIS-catcher directly without sox", () => {
		// The AIS channel centre is the A/B pair centre 162.000 MHz; AIS-catcher demodulates A and B at ±25 kHz from it.
		const d = make("ais-catcher", { channelHz: 162_000_000, inputCenterFreq: 161.9e6 })
		expect(d.getChannelRequest?.({ sampleRateHz: 2_048_000, centerHz: 161.9e6 })).toEqual({ centerHz: 162_000_000, bandwidthHz: 364_800, transitionHz: 9_600, outputRateHz: 384_000, format: "cu8" })
		const chan = make("ais-catcher", { inputSampleRate: 384_000, inputIqFormat: "cu8" }) as unknown as { buildPipelineCommand(): string }
		expect(chan.buildPipelineCommand()).not.toMatch(/sox/)
	})
```

Remove `ais-catcher` from the "keeps every built-in non-channelisable" list.
- [ ] **Step 2: Run it, confirm it fails. Implement. Run it, confirm it passes.** `pnpm exec vitest run tests/unit/decoders/channel-requests.test.ts tests/unit/decoders/ais-catcher.test.ts`
- [ ] **Step 3: Golden gate (quiet host).** Build the image, then run with `WAVEKIT_FIXTURE_PATHS=raw,channelizer WAVEKIT_FIXTURE_IDS=<all ais-catcher channelizer-golden and negative ids>`. Expected: PASS, including Property 15 key-set equality. The AIS `_outside` negative runs here for the first time and on the channelizer path only (Task 5 skips negatives on raw): zero decodes, `suspended: true` and a `channel-outside-capture` log line. Append a row to `fixtures/GOLDENS.md` with the image id, head and `wavekit-chan --version`.
- [ ] **Step 4: Commit** `git add src/decoders/builtin/ais-catcher.ts tests/unit/decoders/channel-requests.test.ts fixtures/GOLDENS.md && git commit -m "feat(decoders): channelise ais-catcher (addendum §7 step 1; Property 15 gate passed)"`

### Task 29: dumpvdl2

**Files:** Modify `src/decoders/builtin/dumpvdl2.ts` (`channelizerSupported()` → `true`); Test `tests/unit/decoders/channel-requests.test.ts` (append); `fixtures/GOLDENS.md`.

- [ ] **Step 1: Failing test.** Append:

```ts
	it("dumpvdl2 requests one channel spanning its frequencies and tunes --centerfreq to it", () => {
		const d = make("dumpvdl2", { frequencies: [136_650_000, 136_975_000], inputCenterFreq: 136.8e6 })
		const r = d.getChannelRequest?.({ sampleRateHz: 2_048_000, centerHz: 136.8e6 })
		expect(r).toMatchObject({ centerHz: 136_812_500, outputRateHz: 1_050_000, format: "cu8", bandwidthHz: 997_500 })
		const wide = make("dumpvdl2", { frequencies: [136_000_000, 137_000_000] }).getChannelRequest?.({ sampleRateHz: 2_048_000, centerHz: 136.5e6 })
		expect(wide).toMatchObject({ bandwidthHz: 1_050_000 }) // span + 50 kHz: admission then rejects it as invalid (bw/2+tr > out/2)
		const chan = make("dumpvdl2", { frequencies: [136_650_000], inputSampleRate: 1_050_000, inputCenterFreq: 136_812_500 }) as unknown as { buildPipelineCommand(): string }
		expect(chan.buildPipelineCommand()).toContain("--centerfreq 136812500")
		expect(chan.buildPipelineCommand()).not.toMatch(/sox/)
	})
```

- [ ] **Step 2: Implement, run, confirm it passes.** `pnpm exec vitest run tests/unit/decoders/channel-requests.test.ts tests/unit/decoders/dumpvdl2.test.ts`
- [ ] **Step 3: Golden gate (quiet host)** as in Task 28, for the VDL2 fixtures (`own_vdl2_136800k_2048k`, at both rates when present) and the VDL2 `_outside` negative (channelizer path only).
- [ ] **Step 4: Commit**

```bash
git add src/decoders/builtin/dumpvdl2.ts tests/unit/decoders/channel-requests.test.ts fixtures/GOLDENS.md
git commit -m "feat(decoders): channelise dumpvdl2 (addendum §1, §7 step 2; Property 15 gate passed)"
```

### Task 30: rtl_433

**Files:** Modify `src/decoders/builtin/rtl433.ts` (`channelizerSupported()` → `true`); Test (append); `fixtures/GOLDENS.md`.

- [ ] **Step 1: Failing test.** Assert that `make("rtl433").getChannelRequest?.({ sampleRateHz: 2_048_000, centerHz: 433.92e6 })` equals `{ centerHz: 433.92e6, bandwidthHz: 237_500, transitionHz: 6_250, outputRateHz: 250_000, format: "cu8" }`. Also assert that a channelised instance (`inputSampleRate: 250_000`) builds the direct `rtl_433` command with `-s 250000` and no `csdr`.
- [ ] **Step 2: Implement, run, confirm it passes.** `pnpm exec vitest run tests/unit/decoders/channel-requests.test.ts tests/unit/decoders/rtl433.test.ts`
- [ ] **Step 3: Golden gate (quiet host).** The delivered rate changes from 256 000 to 250 000, so key-set equality must hold. If a payload set differs, stop and report back with both sets; do not adjust fixtures to fit.
- [ ] **Step 4: Commit**

```bash
git add src/decoders/builtin/rtl433.ts tests/unit/decoders/channel-requests.test.ts fixtures/GOLDENS.md
git commit -m "feat(decoders): channelise rtl_433 at exact 250 kHz (addendum §7 step 3; Property 15 gate passed)"
```

### Task 31: Audio family (direwolf, multimon-ng, dsd-fme, acarsdec)

**Files:** Modify `src/decoders/builtin/{direwolf,multimon-ng,dsd-fme,acarsdec}.ts` (`channelizerSupported()` → `true`, one commit per decoder); Test (append); `fixtures/GOLDENS.md`.

- [ ] **Step 1: Failing tests, one per decoder.** Each `getChannelRequest` returns `format: "cf32"` with `outputRateHz` equal to `demodSampleRate ?? sampleRate`: multimon-ng 48 000, direwolf 48 000, dsd-fme 48 000, acarsdec 24 000. acarsdec with two default frequencies and no `channelHz` returns `{ invalid: … }`; with `channelHz` it returns a request centred there. Each channelised pipeline (`inputIqFormat: "cf32"`, `inputSampleRate` = out) has no `convert -i char -o float` and no `firdecimate`. For direwolf and dsd-fme, the tail resampling to `sampleRate` disappears when `sampleRate === demodSampleRate` (assert no `sox` stage).
- [ ] **Step 2: Implement one decoder at a time.** Run `pnpm exec vitest run tests/unit/decoders/channel-requests.test.ts tests/unit/decoders/<decoder>.test.ts` after each.
- [ ] **Step 3: Golden gate per decoder (quiet host), in the order direwolf → multimon-ng → dsd-fme → acarsdec.** This step carries the AGC equivalence risk (addendum § 3). If a payload set differs, try the cu8 `gain` option (cu8 consumers only) or report back; never change goldens to match. Append a `fixtures/GOLDENS.md` row per decoder.
- [ ] **Step 4: Commit per decoder**, staging only that decoder's file (`<decoder>` is `direwolf`, `multimon-ng`, `dsd-fme` or `acarsdec`, in gate order):

```bash
git add src/decoders/builtin/<decoder>.ts tests/unit/decoders/channel-requests.test.ts fixtures/GOLDENS.md
git commit -m "feat(decoders): channelise <decoder> via cf32 tail (addendum §3, §7 step 4; Property 15 gate passed)"
```

If the AGC fallback in Step 3 touched `src/decoders/audio-demod-decoder.ts`, add that path to the same `git add`. Never `git add -A` or a directory.

### Task 32: CHECKPOINT: batch 4 complete

- [ ] Dev Mac: the Task 27 unit set plus every `tests/unit/decoders/<builtin>.test.ts` (single-file runs), then `make chan-test`, typecheck and lint.
- [ ] Quiet host: run the full golden harness with `WAVEKIT_FIXTURE_PATHS=raw,channelizer`. Every fixture passes, and `fixtures/GOLDENS.md` has one row for the complete run.
- [ ] Confirm readsb and lora-meshtastic never channelise: `getChannelRequest` returns undefined, also covered in `channel-requests.test.ts`.

---

# Batch 5: Capacity gate

Script changes are developed and unit-tested on the Mac with Python unit tests and no load. All capacity runs happen on a quiet host.

Baseline note: `csdr.boundedBuffers` is default-on on `main` since `f49273c` ("feat(core): enable bounded CSDR rings by default"; `src/config.ts` :264). The bounded-CSDR baseline therefore needs no config flip. Every run still passes `--buffers on` explicitly (so the baseline does not depend on the default) and records the exact revision (`git rev-parse HEAD`, image id) in `meta.json` and in the results doc, because the default itself is a recent change.

### Task 33: `fake_rtl_tcp.py --file/--loop/--pacing`

**Files:**
- Modify: `scripts/capacity/fake_rtl_tcp.py`
- Create: `tests/unit/capacity/test_capacity_channelizer.py`, `tests/unit/capacity/capacity-scripts.test.ts`

**Interfaces:**
- Produces: `load_period(file: str | None, rate: int, seed: int) -> bytes` (the file bytes trimmed to an even length, or `synthesize`); `next_block(period: bytes, offset: int, loop: bool) -> tuple[bytes, int, bool]` (block, new offset, done); CLI `--file PATH`, `--loop`, `--pacing paced|unpaced` (default `paced`).

- [ ] **Step 1: Failing Python tests plus the vitest wrapper**

```python
# tests/unit/capacity/test_capacity_channelizer.py
import importlib.util, pathlib, sys, tempfile, unittest
ROOT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "capacity"
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

class FakeRtlTcpFile(unittest.TestCase):
    def test_file_period_is_even_and_exact(self):
        fake = load("fake_rtl_tcp")
        with tempfile.NamedTemporaryFile(suffix=".cu8", delete=False) as f:
            f.write(bytes(range(7)))
        self.assertEqual(fake.load_period(f.name, 2048000, 0), bytes(range(6)))
    def test_non_loop_ends_after_the_file(self):
        fake = load("fake_rtl_tcp")
        period = bytes(fake.BLOCK + 10)
        block, offset, done = fake.next_block(period, 0, False)
        self.assertEqual((len(block), done), (fake.BLOCK, False))
        block, offset, done = fake.next_block(period, offset, False)
        self.assertEqual((len(block), done), (10, True))
    def test_loop_wraps(self):
        fake = load("fake_rtl_tcp")
        period = bytes(fake.BLOCK + 10)
        _, offset, _ = fake.next_block(period, 0, True)
        block, offset, done = fake.next_block(period, offset, True)
        self.assertEqual((len(block), offset, done), (fake.BLOCK, (2 * fake.BLOCK) % len(period), False))

if __name__ == "__main__":
    unittest.main()
```

```ts
// tests/unit/capacity/capacity-scripts.test.ts
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
it("validates the capacity script channelizer extensions", () => {
	const r = spawnSync("python3", [resolve("tests/unit/capacity/test_capacity_channelizer.py")], { encoding: "utf8", timeout: 30000 })
	expect(r.status, r.stdout + r.stderr).toBe(0)
}, 35000)
```

- [ ] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run tests/unit/capacity/capacity-scripts.test.ts`
- [ ] **Step 3: Implement** in `fake_rtl_tcp.py`:

```python
def load_period(file, rate, seed):
    if not file:
        return synthesize(rate, seed)
    data = pathlib.Path(file).read_bytes()
    return data[: len(data) // 2 * 2]


def next_block(period, offset, loop):
    if loop:
        looped = period + period[:BLOCK]
        return looped[offset:offset + BLOCK], (offset + BLOCK) % len(period), False
    block = period[offset:offset + BLOCK]
    end = offset + len(block)
    return block, end, end >= len(period)
```

Add `import pathlib`. `serve()` uses `load_period(args.file, args.rate, args.seed)`. In `stream()`, replace `looped[offset:offset + BLOCK]` and the offset update with `block, offset, done = next_block(period, offset, loop)`, `conn.sendall(block)`, `sent += len(block)`, and `if done: break`. When `pacing == "unpaced"`, skip the `due > now` sleep. Add the CLI arguments `--file`, `--loop` (`store_true`) and `--pacing` (`choices=["paced", "unpaced"]`, default `paced`), and include `"file"`, `"loop"` and `"pacing"` in the `listening` event.

Keep the existing synthetic path. With `--loop` and no `--file`, behaviour equals today.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Commit** `git add scripts/capacity/fake_rtl_tcp.py tests/unit/capacity/test_capacity_channelizer.py tests/unit/capacity/capacity-scripts.test.ts && git commit -m "feat(capacity): fixture replay with loop and unpaced modes (addendum §9)"`

### Task 34: `run_capacity.py` channel matrix, admissible placements, decoder-running check, meta

**Files:** Modify `scripts/capacity/run_capacity.py`; Test `tests/unit/capacity/test_capacity_channelizer.py` (append)

**Interfaces:**
- Produces:
  - `placements(center: int, rate: int, usable: float, n: int, mode: str, signal_hz: int, out_rate: int, half_occupied: float | None = None) -> list[int]`. Every returned centre passes addendum § 6 admission (plan A10). `half_occupied` defaults to `out_rate / 2`, the § 2 default `bw/2 + tr`. Raises `ValueError` when the fixture signal is not admissible.
  - `decoder_problems(statuses: list[dict], expected_ids: list[str]) -> list[str]`: one entry per expected id that is missing, `suspended`, or not `running`.
  - `decoder_statuses() -> list[dict]`: `GET /api/decoders` via `docker exec wkcap-app curl`.
  - CLI `--channelizer on|off`, `--channels 1|4|8`, `--placement spread|clustered`, `--fixture <id>`, `--playback paced|unpaced`.
  - `meta.json` gains `channelizer`, `channels`, `placement`, `placements`, `fixture { id, sha256, sample_rate, center_hz }`, `wavekitChanVersion` (from `docker run --rm --entrypoint wavekit-chan <image> --version`), `playback` and `decoderStatus { start: [problems], end: [problems] }`.
  - Exit code `5`: some decoder instance is suspended, missing or not running at window start or end.

- [ ] **Step 1: Failing tests (append)**

```python
def admissible(x, center, rate, usable, half):
    """Addendum §6 with the 1e-6 Hz tolerance of both admission implementations (Review Focus 1)."""
    return abs(x - center) + half <= rate * usable / 2 + 1e-6

class Placements(unittest.TestCase):
    # Capture tuned 100 kHz above the AIS pair; the signal channel is the A/B pair centre 162.000 MHz,
    # because AIS-catcher demodulates A and B at ±25 kHz from its input centre.
    CENTER, SIGNAL, AIS_OUT = 162_100_000, 162_000_000, 384_000

    def test_every_placement_is_admissible(self):
        # Plan A10. Applied literally, the §9 formula puts AIS at ±716.8 kHz (N=8, 2.048 Msps): channel-outside-capture.
        run = load("run_capacity")
        for rate in (2_048_000, 2_400_000):
            for n in (1, 4, 8):
                for mode in ("spread", "clustered"):
                    p = run.placements(self.CENTER, rate, 0.8, n, mode, self.SIGNAL, self.AIS_OUT)
                    self.assertEqual(len(p), n, (rate, n, mode))
                    self.assertIn(self.SIGNAL, p)
                    self.assertTrue(all(isinstance(x, int) for x in p))
                    bad = [x for x in p if not admissible(x, self.CENTER, rate, 0.8, self.AIS_OUT / 2)]
                    self.assertEqual(bad, [], (rate, n, mode))

    def test_spread_spans_the_admissible_range(self):
        run = load("run_capacity")
        p = sorted(run.placements(self.CENTER, 2_048_000, 0.8, 8, "spread", self.CENTER, self.AIS_OUT))
        # admissible half-range L = 819 200 - 192 000 = 627 200; outer spread points at ±L·7/8
        self.assertEqual((p[0] - self.CENTER, p[-1] - self.CENTER), (-548_800, 548_800))

    def test_clustered_spacing_and_single(self):
        run = load("run_capacity")
        p = run.placements(self.CENTER, 2_048_000, 0.8, 8, "clustered", self.CENTER, 48_000)
        self.assertEqual(sorted(p)[1] - sorted(p)[0], 60_000)  # 1.25 × out fits, so the step is unchanged
        self.assertEqual(run.placements(self.CENTER, 2_048_000, 0.8, 1, "spread", self.SIGNAL, self.AIS_OUT), [self.SIGNAL])

    def test_clustered_shrinks_and_shifts_to_fit(self):
        run = load("run_capacity")
        p = sorted(run.placements(self.CENTER, 2_048_000, 0.8, 8, "clustered", self.SIGNAL, self.AIS_OUT))
        self.assertEqual((p[0] - self.CENTER, p[-1] - self.CENTER), (-627_200, 627_200))  # step ⌊2L/7⌋ = 179 200
        self.assertEqual(len(set(p)), 8)

    def test_inadmissible_signal_is_an_error(self):
        run = load("run_capacity")
        with self.assertRaises(ValueError):
            run.placements(self.CENTER, 2_048_000, 0.8, 4, "spread", self.CENTER + 700_000, self.AIS_OUT)

class DecoderReadiness(unittest.TestCase):
    def test_flags_suspended_stopped_and_missing(self):
        run = load("run_capacity")
        statuses = [
            {"id": "ais-catcher-ch0", "running": True, "suspended": False, "health": "running"},
            {"id": "ais-catcher-ch1", "running": False, "suspended": True, "health": "running"},
            {"id": "ais-catcher-ch2", "running": False, "suspended": False, "health": "faulted"},
        ]
        ids = [f"ais-catcher-ch{k}" for k in range(4)]
        self.assertEqual(run.decoder_problems(statuses, ids), [
            "ais-catcher-ch1: suspended",
            "ais-catcher-ch2: not running (faulted)",
            "ais-catcher-ch3: missing",
        ])

    def test_all_running_passes(self):
        run = load("run_capacity")
        self.assertEqual(run.decoder_problems([{"id": "a", "running": True, "suspended": False}], ["a"]), [])

class RepoRoot(unittest.TestCase):
    def test_repo_points_at_the_manifest_accessor(self):
        run = load("run_capacity")
        self.assertTrue((run.REPO / "fixtures" / "manifest-query.mjs").is_file())
```

- [ ] **Step 2: Run it and confirm it fails.** `pnpm exec vitest run tests/unit/capacity/capacity-scripts.test.ts`
- [ ] **Step 3: Implement the placements** (add `import math`)

```python
ADMISSION_EPSILON_HZ = 1e-6  # same tolerance as admission.rs / admission.ts (Review Focus 1)


def placements(center, rate, usable, n, mode, signal_hz, out_rate, half_occupied=None):
    """Addendum §9 placements, restricted to the admissible centre range (plan A10).

    A channel at offset d is admitted iff |d| + h <= rate*usable/2 (addendum §6), h = bw/2 + tr,
    which is out_rate/2 for the §2 default passband at any t. Channels may overlap; they are load.
    """
    h = out_rate / 2 if half_occupied is None else half_occupied
    limit = math.floor(rate * usable / 2 - h + ADMISSION_EPSILON_HZ)  # largest admissible |offset|, whole Hz
    if limit < 0 or abs(signal_hz - center) > limit:
        raise ValueError(f"fixture signal {signal_hz} Hz is not admissible in a {rate} Hz capture at {center} Hz "
                         f"(|offset| must be <= {limit} Hz for bw/2+tr = {h} Hz)")
    if mode == "spread":
        # §9's (k + 0.5)/N spacing over 2·limit instead of the raw usable span; int() truncates toward the centre
        offsets = [int(2 * limit * ((k + 0.5) / n - 0.5)) for k in range(n)]
    else:
        step = round(1.25 * out_rate)
        if n > 1:
            step = min(step, (2 * limit) // (n - 1))
        sig = signal_hz - center
        offsets = [sig + (step * (2 * k - (n - 1))) // 2 for k in range(n)]  # span is exactly step·(n-1) <= 2·limit
        shift = max(-limit - min(offsets), 0) + min(limit - max(offsets), 0)
        offsets = [o + shift for o in offsets]
    points = [center + o for o in offsets]
    nearest = min(range(n), key=lambda k: abs(points[k] - signal_hz))
    points[nearest] = signal_hz
    return points
```

Admissibility holds by construction: spread offsets satisfy `|offset| ≤ L·(1 − 1/N)`, the clustered span is `step·(N − 1) ≤ 2L` and the shift brings it inside `±L`, and the replaced point is the admissible fixture signal. Revised for the AIS centre correction (signal at the pair centre 162.000 MHz, 100 kHz below a 162.1 MHz capture, `h` = 192 kHz), the 2.048 Msps N = 8 values were rechecked by hand: spread outer points ±548.8 kHz; clustered step ⌊2L/7⌋ = 179 200, shifted by +100 kHz to fill ±627.2 kHz, with −89.6 kHz replaced by the signal at −100 kHz, so all 8 points stay distinct.

- [ ] **Step 4: Implement the decoder-running check and the matrix flags**

```python
def decoder_problems(statuses, expected_ids):
    """Plan A10: a capacity cell counts only if all N instances run; channel suspensions report `suspended: true` (A3)."""
    by_id = {s.get("id"): s for s in statuses}
    problems = []
    for decoder_id in expected_ids:
        s = by_id.get(decoder_id)
        if s is None:
            problems.append(f"{decoder_id}: missing")
        elif s.get("suspended"):
            problems.append(f"{decoder_id}: suspended")
        elif not s.get("running"):
            problems.append(f"{decoder_id}: not running ({s.get('health')})")
    return problems


def decoder_statuses():
    result = subprocess.run(
        ["docker", "exec", "wkcap-app", "curl", "-fsS", "http://127.0.0.1:9000/api/decoders"],
        capture_output=True, text=True)
    return json.loads(result.stdout) if result.returncode == 0 else []
```

Then in `main()`:
- Extend `write_config(path, rate, decoders, center, channelizer=False)` to emit `channelizer:\n  enabled: true` when on, and `useChannelizer: true` plus `options.channelHz` per decoder.
- `run_capacity.py` has no `REPO` today. Add a module-level `REPO = Path(__file__).resolve().parents[2]` next to the imports (`scripts/capacity/run_capacity.py` → repo root; the file already does `from pathlib import Path`). With `--fixture`, read the fixture through `subprocess.run(["node", str(REPO / "fixtures/manifest-query.mjs"), "get", id], capture_output=True, text=True, check=True)` and `json.loads` its stdout. Assert `options.rate == fixture["sample_rate"]`, start the fake with `--file /fixtures/<file>`, mount the fixtures dir into the fake container, and set the source centre to `center_hz`.
- Compute `placements(center_hz, rate, 0.8, n, placement, signal_hz, out_rate)`. Take `signal_hz` from the fixture's `channel.center_hz` (manifest v2, Task 1), or its `center_hz` when it has no `channel`, and `out_rate` from the decoder type's channel request (ais-catcher: 384 000). For AIS the signal channel is always the A/B pair centre 162 000 000 Hz, never channel A (161 975 000 Hz is wrong: it shifts baseband by 25 kHz and mis-tunes both AIS channels). A `ValueError` aborts before any container starts, with exit 2 like the existing preflight aborts and the message in `meta.aborted`.
- Build `decoders` as N instances of the fixture's decoder type (`<type>-ch<k>`), each with `channelHz = placements[k]`, and keep `expected_ids = [d[0] for d in decoders]`.
- After `time.sleep(options.warmup)`, record `meta["decoderStatus"] = {"start": decoder_problems(decoder_statuses(), expected_ids)}`. If that list is non-empty, set `aborted = "decoders not all running at window start: " + "; ".join(problems)` and `return 5`, before the sampler starts.
- After the guard loop, record `meta["decoderStatus"]["end"]` the same way. If it is non-empty and nothing else aborted, set `aborted` and `return 5`.
- Both checks apply with `--channelizer off` too, so both sides of the comparison carry the same N.
- Write the new `meta` fields.
- Keep the 5-minute bound assert.
- [ ] **Step 5: Run it and confirm it passes.** `pnpm exec vitest run tests/unit/capacity/capacity-scripts.test.ts`
- [ ] **Step 6: Commit** `git add scripts/capacity/run_capacity.py tests/unit/capacity/test_capacity_channelizer.py && git commit -m "feat(capacity): admissible channel placements, decoder-running check and provenance meta (addendum §6, §9; plan A10)"`

### Task 35: `summarize.py` channelizer reporting; sampler label check

**Files:** Modify `scripts/capacity/summarize.py`; Test (append)

**Interfaces:**
- Produces: `channelizer_stats(app_log: str) -> dict` returning `{ "queueHighWaterBytes": {id: max}, "droppedSamples": {id: last}, "saturatedSamples": {id: last}, "queueOverflowEvents": int }`. It parses pino JSON lines with `msg == "channelizer stats"` and counts `channel-discontinuity` log lines with cause `queue-overflow` (log those in Task 21's `onEvent` discontinuity branch at warn level with `cause`; if they are missing, add that log line in this task). `summarize()` adds `channelizer` (the dict) and `cpu.wavekitChan` (from the `wavekit-chan` process group, which `sampler.label()` already yields as the bare exe name).

- [ ] **Step 1: Failing tests (append)**

```python
class ChannelizerSummary(unittest.TestCase):
    def test_parses_stats_lines(self):
        s = load("summarize")
        log = "\n".join([
            '{"msg":"channelizer stats","channels":[{"id":"a-g1","queueHighWaterBytes":1000,"droppedSamples":0,"saturatedSamples":2}]}',
            '{"msg":"channelizer stats","channels":[{"id":"a-g1","queueHighWaterBytes":4000,"droppedSamples":5,"saturatedSamples":3}]}',
            '{"msg":"Channel discontinuity","cause":"queue-overflow","channelId":"a-g1"}',
            'not json',
        ])
        r = s.channelizer_stats(log)
        self.assertEqual(r["queueHighWaterBytes"], {"a-g1": 4000})
        self.assertEqual(r["droppedSamples"], {"a-g1": 5})
        self.assertEqual(r["queueOverflowEvents"], 1)
    def test_sampler_labels_the_channelizer(self):
        sampler = load("sampler")
        self.assertTrue(hasattr(sampler, "label"))
```

- [ ] **Step 2: Implement `channelizer_stats` and wire it into `summarize()`.** Read `run / "app.log"` if present. Add `wavekitChan` CPU next to the csdr aggregate from `groups["wavekit-chan"]`.
- [ ] **Step 3: Run it and confirm it passes. Commit** `git add scripts/capacity/summarize.py src/core/channelizer/channelizer-manager.ts tests/unit/capacity/test_capacity_channelizer.py && git commit -m "feat(capacity): report channelizer queues, drops, saturation and CPU (addendum §9)"`

### Task 36: [quiet host] Capacity gate run and results doc

**Files:** Create `docs/CAPACITY-<run-date>-CHANNELIZER.md` (follow the layout of `docs/CAPACITY-2026-10-08-CSDR-RINGS.md`)

- [ ] **Step 1: Record the host and revision.** On a quiet host, not this Mac: `git rev-parse HEAD`, the image id, `docker run --rm --entrypoint wavekit-chan <image> --version`, the CPU model and core count, and the load average before the run. Use one fixture per rate: an AIS `channelizer-golden` at 2.048 Msps and one at 2.4 Msps (Task 7 captures both rates). Before the matrix, dry-run `placements()` for each fixture at N = 8 in both modes, and confirm that every centre is admissible and the fixture signal is among them (Task 34 raises otherwise).
- [ ] **Step 2: Run the matrix.** For each rate in {2 048 000, 2 400 000}, channels in {1, 4, 8}, placement in {spread, clustered} and playback in {paced, unpaced}, run both paths:

```bash
python3 scripts/capacity/run_capacity.py --image <image> --rate <r> --buffers on --channelizer off --channels <n> --placement <p> --playback <pb> --fixture <id> --out runs/chan-off-<r>-<n>-<p>-<pb>
python3 scripts/capacity/run_capacity.py --image <image> --rate <r> --buffers on --channelizer on  --channels <n> --placement <p> --playback <pb> --fixture <id> --out runs/chan-on-<r>-<n>-<p>-<pb>
python3 scripts/capacity/summarize.py runs/chan-*
```

`--buffers on` is the bounded-CSDR baseline (`csdr.boundedBuffers: true`, also the default since `f49273c`; pass it anyway and record the revision).
- [ ] **Step 3: Gate criteria** (addendum § 9). At target load (paced), all of these must hold:
  - every run exited 0, so all N decoder instances were running and not suspended at window start and end (`meta.decoderStatus`). An exit-5 cell is a gate **failure** to investigate, never a cell to skip or rerun with fewer channels;
  - zero `queue-overflow` discontinuities;
  - RSS and PSS bounded (no monotonic growth across samples);
  - the decoded set on the signal channel equals the bounded-CSDR run on the same input and covers the fixture's expected payloads;
  - unpaced runs complete without unbounded memory.

  Record CPU user/system for the app and for `wavekit-chan` separately, plus queue high-water marks, drops, saturations and branch drops.
- [ ] **Step 4: Write the results doc.** Include a table per rate, pass/fail per criterion, the revision/image/version block, and observations (for example the cost of direwolf's and multimon-ng's narrow `t = 0.012` filters). If the 8-channel 2.4 Msps run fails on CPU, note research [3]'s AVX2/FMA `target_feature` path as the next step; do not implement it in this plan.
- [ ] **Step 5: Commit** `git add docs/CAPACITY-<run-date>-CHANNELIZER.md && git commit -m "docs(capacity): channelizer 1/4/8-channel gate at 2.048/2.4 Msps vs bounded CSDR (addendum §9)"`

### Task 37: CHECKPOINT: final

- [ ] Dev Mac: `pnpm exec vitest run tests/unit/capacity/capacity-scripts.test.ts tests/unit/fixtures tests/unit/core`, then `make chan-test`, then `pnpm run typecheck && pnpm run lint`.
- [ ] Every Kiro index checkbox is ticked. `fixtures/GOLDENS.md` and the capacity doc record image ids and revisions.
- [ ] `channelizer.enabled` still defaults to `false`. Turning it on by default is out of scope and needs a separate user decision after the capacity results.
