# Core channelizer plan: delta against main e2e82b2

Status: read-only review, 2026-10-09. Applies to
[`2026-10-09-core-channelizer.md`](2026-10-09-core-channelizer.md) (the plan,
commit `891b826`, written on `896ab6a`) and its spec
[`2026-10-09-core-channelizer-prototype-addendum.md`](../specs/2026-10-09-core-channelizer-prototype-addendum.md).
`main` is now `e2e82b2`. Read this doc before the plan. Where the two differ,
**this doc wins**. Nothing in batches 3–5 has been executed yet:
`fixtures/manifest.yaml` is still v1, `fixtures/GOLDENS.md`, `native/` and
`src/core/channelizer/` do not exist, and `fixtures/` has not changed since January.

## 1. What landed since the plan, and why it matters

| Change (commit) | Effect on the plan |
|---|---|
| Live analog rework (`34f56e1`): `buildIqFrontStages()` in `audio-demod-decoder.ts`, `csdr-stages.ts` (`channelFilterPlan`, `channelDecimationStage`, `shiftStage`, `validateChannelOffset`), `offsetHz` → `csdr shift`, channel-matched `firdecimate` whenever `filterTransition` is unset | Task 23's cf32 snippet no longer applies. dsd-fme (12.5 kHz) and acarsdec (25 kHz) now use the matched filter, so the plan's default passband (`out·(1−0.05)`, 45.6 kHz at 48 kHz) is about 3.6 times wider than the raw path. multimon-ng, direwolf and the IQ family still set `filterTransition`, so their requests are unchanged. |
| `shift` bounded in `csdr-buffers.ts` (`fef5a6a`, minimum 2050) | No plan task edits `csdr-buffers.ts`. The cf32 tail must not contain `shift`. |
| `live-demod-pipeline.ts` (front → Node squelch → back), `channel-squelch.ts`, `audio-stream-server.ts` | Live demod stays on raw fanout, so no task changes. It shares `csdr-stages.ts` with the decoders, so its tests become a regression check for Task 23. |
| dsd-fme call segmentation: TLC terminator, `callTimeoutMs` (4 s, checked every 500 ms), `BaseDecoder.emitOutput()`, `call_end` emitted by `stop()` | Event counts depend on timers and stops. dsd-fme goldens count `call_start` only. A channel invalidation restart now ends the current call. |
| Digital voice (`0f4c14c`): `-o udp`, `-V`, `DigitalVoiceService.prepareDecoderConfigs()` rewrites dsd-fme options, HTTP on :8082, on by default (`DIGITAL_VOICE_ENABLED_DEFAULT = true`) | Something outside the decoder now consumes dsd-fme's output. Option injection must merge, not replace (`updateOptions` merges, so this holds today). The harness has to choose the digital-voice port explicitly. |
| `skipDcBlock: true` for dsd-fme (`543d43e`/`9ff133d`). Gate: `scripts/dsd-fme-voice-ab.mjs` on `tests/mocks/fixtures/dsd-fme/run8-dmr-tx2-fmdemod.s16`, with `BACK_CHAIN` pinned by `dsd-fme-calls.test.ts` | The fixture is discriminator output at 2 048 000/43 Hz, so it never sees the front end. The channelizer needs an IQ-level voice gate in addition (§5). |
| Band-aware suspension (`3698ddd`, `9d1053c`) and band defaults (`87f9f06`): `assessEligibility` = rate first, then band; `frequency-out-of-band`; `DecoderSuspensionReasonCode` in api-types; `health.bandSuspension`; region guess; `stateDir` | **The largest hazard.** A fixture or capacity decoder whose centre misses its band default is suspended, decodes nothing, and becomes a zero golden or an exit-5 cell. The band check also ignores `offsetHz` and, for a channelised instance, the channel centre. Task 24's step-8 anchor is gone. |
| `signal-flat`, rate-truth, `source:removed` WebSocket event; `SourceManagerEvents` still lacks `removed` (emitted at `source-manager.ts:1410`) | The plan's Task 21 conditional still applies. Rate-truth only warns. |
| CLI overhaul (`cli/` only), `packages/brand` COPY in `Dockerfile` | Nothing. Dockerfile line hints move by +1 (`final-base` :555, verify step ending :631). |

Line numbers in the plan's "Plan-time facts" are stale (`manager.ts` is now 2131
lines). Find code by symbol. Re-anchors: `wireDecoderToFanout` :949,
`unwireDecoderFromFanout` :1007, `evaluateRate` :1343, `suspend` :1397,
`resume` :1452, `detachBranch` :1550, `assessState` :1579, `assessBand` :1635,
`assessEligibility` :1661; dsd-fme `buildPipelineCommand` :883 (front stages
:898); `index.ts` `setSourceManager` :342, `destroy` :593, `startAll` :788.

## 2. D1–D3 (addendum § 0)

| Decision | Verdict | Note |
|---|---|---|
| D1 Rust `wavekit-chan` | **Confirm** | Nothing that landed favours libcsdr. csdr is still integer-decimation only, and the native csdr patches only bound rings. Add disk hygiene: `native/wavekit-chan/target/` and the cargo cache mounts are large, and the disk is about 95 % full. |
| D2 Hybrid fixtures | **Confirm, with a harder DMR requirement** | `docs/DIGITAL-VOICE.md` says "No DMR IQ fixture". The private `own_dmr_*` capture is now **mandatory** before dsd-fme migrates (§5): MS/direct-mode TDMA PTTs from the lab handheld at 2.048 Msps (2.4 if possible), with the dongle tuned 6 kHz below the carrier as in run 8. Capture with the local dongle or a WaveKit Main recording. Never deploy to or retune the Pi. |
| D3 Unix sockets + JSON lines | **Confirm** | Unaffected. The digital-voice UDP path sits downstream of dsd-fme and does not depend on the transport. |

## 3. Per-task classification

Totals: **24 valid, 13 need adjustment, 0 obsolete.** "Valid" includes tasks
whose line hints moved but whose anchor symbols still exist.

| # | Task | Class | Delta (edits in §4) |
|---|---|---|---|
| 1 | Manifest v2 schema | valid | `expected.output_types` already exists; E3 uses it |
| 2 | Manifest v2 + query | valid | `fixtures/` unchanged since plan time |
| 3 | `download.sh` v2 | valid | |
| 4 | Harness helpers | **adjust** | E1: band suspension off, digital-voice port, stateDir |
| 5 | Collector + harness | **adjust** | E2: port stride 8, fail or flag suspended decoders, record status |
| 6 | Public fixtures | **adjust** | E3: record only on an image ≥ e2e82b2 from a clean worktree; never record a suspended or zero run |
| 7 | Own captures | **adjust** | E3/E4: DMR capture spec, `offsetHz` in `decoder_options`, dsd-fme `output_types` |
| 8 | Batch 3 gate | **adjust** | E5: also run the voice A/B and log it in GOLDENS.md |
| 9–15 | Rust crate, DSP, runtime | valid | D1 confirmed. Clean `target/` after use (E14) |
| 16 | Node types/protocol/admission/rate-plan | valid | |
| 17 | Checkpoint 4A | valid | |
| 18 | Re-check | **adjust** | E6: extra symbol checks, new coordination text |
| 19 | Config | valid | Anchors exist (`CsdrConfigSchema`; `maxVersion` then `band` in `DecoderConfigSchema`) |
| 20–22 | Process, manager, real-binary tests | valid | Task 21: `removed` is still missing from `SourceManagerEvents` (its conditional applies) |
| 23 | Decoder requests + cf32 tail | **adjust (major)** | E7–E9: cf32 inside `buildIqFrontStages`, `offsetHz` absorbed, matched passband, `BACK_CHAIN` test |
| 24 | Manager integration | **adjust** | E10: reason union, no-churn guard re-anchored, band at the channel centre, more regression tests |
| 25 | `index.ts` wiring | valid | `setChannelizer` after :342 runs before `startAll` :788 |
| 26 | Docker `chan-build` | valid | Line hints +1 |
| 27 | Checkpoint 4B | **adjust** | E5: voice A/B on the new image; clean-worktree build |
| 28–30 | ais-catcher, dumpvdl2, rtl_433 | valid | IQ family untouched. Gates rely on E1 |
| 31 | Audio family | **adjust (major)** | E8/E11: dsd-fme keeps its sox WAV wrapper, matched requests, voice gate, digital voice smoke |
| 32 | Checkpoint batch 4 | **adjust** | E11: full run includes both voice A/B fronts |
| 33 | `fake_rtl_tcp.py` | valid | |
| 34 | `run_capacity.py` | **adjust** | E12: `health.bandSuspension: false`, `digitalVoice` pinned |
| 35 | `summarize.py` | valid | |
| 36 | Capacity run + doc | **adjust** | E12/E13: record the new settings; never compare with pre-band-suspension CAPACITY docs |
| 37 | Final checkpoint | valid | |

## 4. Required plan edits

**E1 (Task 4, `buildFixtureConfig`).** Add these top-level keys and a test asserting them:
`health: { bandSuspension: false }` (band verdicts are still reported, but no
decoder is band-suspended; the manager reads it via `createDecoderManagerOptions`),
`digitalVoice: { enabled: true, httpPort: apiPort + 2 }` (production default,
so dsd-fme runs `-o udp -V` as in the field), and `stateDir: "/tmp/wk-state-" + apiPort`.
Keep `liveDemod: { enabled: false }`.

**E2 (Task 5).** Use `apiPort = 19100 + index * 8 + (path === "raw" ? 0 : 4)`,
so api, audio (+1) and digital voice (+2) never overlap between the two paths.
After collection, for every non-negative fixture, add
`expect(r.status?.["suspended"], JSON.stringify(r.status?.["bandAssessment"])).not.toBe(true)`.
In record mode, print `suspended`, `suspension` and `bandAssessment` with the
key set, and fail when `suspended` is true or `count` is 0, so a band- or
rate-suspended run can never become a golden.

**E3 (Tasks 6–7, recording).** The record runs and the Task 8 gate use one
image built from a clean `git worktree` of `main` at `e2e82b2` or later. Never
use the shared checkout or an image from before `34f56e1`/`9ff133d`, which
would record the wide filter or the DC blocker. Record the image id and HEAD
in GOLDENS.md. For every dsd-fme fixture set
`expected.output_types: ["call_start"]`, because `call_end` can come from the
TLC, the 4 s timer or `stop()`. Keep `key_fields: ["talkgroup", "source"]`.

**E4 (Task 7, DMR row).** Replace the dsd-fme row with
`own_dmr_ms_<band>_2048k` (and `_2400k` if possible): two or more PTTs from the
lab handheld in MS/direct mode, the dongle tuned 6 kHz below the carrier,
`decoder_options: { offsetHz: 6000 }` and no `channel`. That gives the raw path
(csdr shift) and the channelizer path (absorbed offset, E7) the same RF
channel. The role is `channelizer-golden`. Without this fixture, dsd-fme does
not migrate (Task 31 stops at multimon-ng).

**E5 (Tasks 8, 27).** On the same image as the harness run:
`docker run --rm --network none --entrypoint node -v "$PWD:/w:ro" <image> /w/scripts/dsd-fme-voice-ab.mjs`.
Expected: PASS. Log a GOLDENS.md row with the muted %, AMBE errors,
link-control count, image id and HEAD. Task 27 repeats it to show that the
default-off path is byte-identical. The 2026-10-09 reference is 0.7 % muted and 6 AMBE errors.

**E6 (Task 18).** Step 1 also checks
`grep -c "private assessEligibility\|private assessBand\|reasonCode: DecoderSuspensionReasonCode" src/decoders/manager.ts`
(expected 3) and records the §1 re-anchors. In the step-4 coordination text,
replace "until `DecoderSuspension.reasonCode` (api-types) and the strict Fastify
enum accept them" with "until `DecoderSuspensionReasonCode` (api-types: rate
codes plus `frequency-out-of-band`) and the strict Fastify enum accept them".
`docs/CLI-COORDINATION.md` is tracked and shared. Only the orchestrator appends
to it, and stages only that path.

**E7 (Task 23, offsetHz absorbed).** The request centre is
`channelHz ?? (input.centerHz + getOffsetHz())`. When both are set, `channelHz`
wins and a warning is logged once. The relative `offsetHz` follows retunes,
because each caps change invalidates the channel and the request is
recomputed. Tests: `offsetHz: 6000` at a capture centre of 1e8 gives `centerHz`
100 006 000. `channelHz` + `offsetHz` gives `channelHz`. The raw-path pipeline
string is unchanged.

**E8 (Task 23, cf32 tail).** Delete the plan's `buildPipelineCommand`
snippet (the old lines 4512–4523). Instead, `buildIqFrontStages()` returns
`{ convert: string | null; shift: string | null; decimate: string | null }`.
When `options.inputIqFormat === "cf32"`, all three are null and neither
`getOffsetHz()` nor `validateChannelOffset()` runs. At 48 kHz,
`validateChannelOffset` throws for |offset| > 17 750 Hz, which would cause a
start-failure loop, and a shift would move the already centred channel twice.
`AudioDemodDecoder.buildPipelineCommand` and `DsdFmeDecoder.buildPipelineCommand`
push only the non-null stages. multimon-ng's IQ AGC stays and now runs on
channel IQ (addendum §3 risk). Tests: for dsd-fme cf32 with `inputSampleRate: 48_000`,
the pipeline contains
`csdr fmdemod | ${BACK_CHAIN} | csdr convert -i float -o s16 | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme`,
with `BACK_CHAIN` read from the script as in `dsd-fme-calls.test.ts`, and no
`convert -i char`, `shift`, `dcblock` or `firdecimate`. cf32 with
`offsetHz: 300000` builds without throwing.

**E9 (Task 23, passband).** `audioChannelRequest`: if `filterTransition` is
set, keep the plan formula (multimon-ng, direwolf; plan A11 unchanged).
Otherwise derive the passband from the shared helper, so the request and the
raw stage cannot disagree:
`const p = channelFilterPlan(outputRateHz, 1, config.bandwidth)`, then
`bandwidthHz = 2 * p.passbandHz` and `transitionHz = p.stopbandHz - p.passbandHz`.
Expected: dsd-fme gives 12 500 / 6 250 (raw: `firdecimate 43 0.003052 --cutoff 0.1968`),
and acarsdec gives 12 000 / 6 000. acarsdec sits exactly on the admission
boundary, covered by Review Focus 1. Set `CoreSuspensionReason = DecoderSuspensionReasonCode | ChannelAdmissionReason`.
Add to the Step 4 run list: `dsd-fme-calls.test.ts`, `dsd-fme-voice.test.ts`,
`csdr-stages.test.ts`, `csdr-buffers.test.ts`, `tests/unit/core/live-demod-pipeline.test.ts`.

**E10 (Task 24).** (a) `DecoderSuspension.reasonCode` widens from
`DecoderSuspensionReasonCode` to `CoreSuspensionReason`. `publicSuspension()`
stays: plan A3 still holds, because channel codes are not in the shared union.
(b) Step 8: the anchor `else if (plan.verdict !== "unusable")` no longer
exists. Put the no-churn guard in the suspended branch of `evaluateRate`,
**before** `else if (eligibility.blockedBy === null)`. The guard holds when
`isChannelAdmissionReason(state.suspension.reasonCode)`, `blockedBy === null`,
the rate and centre are identical and `!state.channelStale`; it then keeps the
plan and publishes. A rate or band block still overwrites `reasonCode` through
the existing code. (c) Step 9: `assessState` is now consumed by
`assessEligibility`. Keep the rename and, in `assessBand`, assess a
channelised instance at `centerHz = request.centerHz` with
`frontendRateHz = request.outputRateHz`. Otherwise a direwolf or AIS channel
away from the capture centre is band-suspended although the channelizer could
serve it. With band suspension on, an out-of-capture channel may report
`frequency-out-of-band` before `channel-outside-capture`. That is acceptable,
and the harness (E1) disables band suspension. (d) Use the
`sources.setCenter()` helper now in `rate-fakes.ts` for retune cases, and
still never edit that file. (e) Add a case: after invalidation, `decoders.get(id)`
is the same object and its `"voice-call"` listener count is unchanged, so the
`digitalVoice.attachDecoder` wiring survives the restart. (f) Add
`manager-band-suspension.test.ts`, `manager-options.test.ts` and
`tests/unit/api/decoder-band-contract.test.ts` to the Step 5 list.

**E11 (Tasks 31–32).** Step 1: dsd-fme keeps exactly one `sox`, the WAV
wrapper at `-r 48000` to `-r 48000`. Only direwolf loses its `sox`, and
multimon-ng keeps 48 000 → 22 050. Expected requests: dsd-fme
`{ outputRateHz: 48_000, bandwidthHz: 12_500, transitionHz: 6_250, format: "cf32" }`,
acarsdec `{ 24_000, 12_000, 6_000 }`. dsd-fme's gate is Property 15 on
`own_dmr_*` **and** the voice gate in §5. After it passes, run
`tests/integration/digital-voice-udp-replay.test.ts` and a 60 s harness run
with digital voice on to show that the channelised dsd-fme still emits
`voice-call` and UDP voice. Task 32 runs both voice A/B fronts on the final image.

**E12 (Task 34, `write_config`).** Emit `health:\n  bandSuspension: false`,
`digitalVoice:\n  enabled: false` (pinned; `dsd-fme` there uses `output: null`)
and `stateDir: /tmp/wkcap-state`. Keep `liveDemod: enabled: false`. Add a unit
test that the generated YAML contains all three. Without the band setting, N
AIS instances at spread `channelHz` are band-assessed at their channel centre
(E10c) and exit 5.

**E13 (Task 36).** Record `bandSuspension`, `digitalVoice.enabled`,
`liveDemod.enabled` and rate-truth status in `meta.json` and the doc. Build
baseline and channelizer images from the same clean worktree. Old
`docs/CAPACITY-*.md` numbers predate band suspension and digital voice, so they
are context only, never the baseline.

**E14 (housekeeping).** Update the plan header's "Plan-time facts" to point here
and treat its line numbers as hints. Add §14 rows to the addendum for A16
(matched passband, E9), A17 (`offsetHz` absorbed, E7) and A18 (band at the
channel centre, E10c). Fix addendum §2's table: "sox after demod disappears for
direwolf; dsd-fme keeps its WAV wrapper". Fix §2's claim that the default
"reproduces today's firdecimate cut": that holds only when `filterTransition`
is set. After builds, remove WaveKit-only leftovers (`native/wavekit-chan/target`,
dangling WaveKit images and the chan cache), and never prune other projects.

## 5. offsetHz and the voice A/B gate

**Absorb `offsetHz`: yes, for channelised instances only.** The channelizer's
NCO does what `csdr shift` does, so the receiver's DC spike lands at −offsetHz
inside the channel exactly as on the raw path. On run 8 that is the −6 kHz idle
level that dsd-fme tracks per burst. Do not add DC removal anywhere in the
channel path: this is the `9ff133d` lesson. Raw-path `offsetHz` stays
byte-identical. Deprecating it (ROADMAP: "the channelizer replaces it") is a
separate decision, made only after the channelizer becomes default-on.

**Keeping the voice A/B regression gate inside the golden gate.**
1. The default script mode does not change. It feeds discriminator output into
   `BACK_CHAIN`, so it does not depend on the front end. It must PASS on every
   image (Tasks 8, 27, 31, 32), and the E8 test pins the cf32 back chain to the
   same `BACK_CHAIN`.
2. Add an IQ mode to the same script in Task 31's dsd-fme step:
   `--iq <cu8> --rate <fs> --offset <hz> --front csdr|chan`. `csdr` runs the
   decoder's own front (`convert | shift | firdecimate <matched> | fmdemod`),
   with the stage string pinned to `DsdFmeDecoder.buildPipelineCommand` by a
   unit test like `BACK_CHAIN`. `chan` spawns the in-image `wavekit-chan`. A
   short `.mjs` v1 client opens one channel over fd 3 (centre = capture centre
   + offset, 12 500 / 6 250, 48 000, cf32) and pipes the socket into
   `csdr fmdemod | BACK_CHAIN | …`. Each front then runs the existing three-way
   check: `-o null`, `-o udp -V 3` and `-o udp`.
3. The gate on `own_dmr_*`: both fronts pass the existing limits (a terminator
   decoded, < 5 % muted, < 300 AMBE errors, an identical decode across the
   three output modes). The `chan` front's set of `TGT=…  SRC=…` lines must
   equal the `csdr` front's set, which is Property 15 at the dsd-fme level.
   **Proposed** tolerance: `chan` AMBE errors must not exceed
   `max(1.25 × csdr, csdr + 20)`; confirm it with the user at Task 31. Log both
   fronts in GOLDENS.md with the image id, HEAD and `wavekit-chan --version`.
   If the `.mjs` client turns out heavier than about 80 lines, the fallback is
   a harness-only check: run the app with `debugRecordPath` on both paths and
   feed the recorded discriminator output to the default script mode. Do not
   change the Rust protocol for this.

## 6. Goldens versus current decoder output

No golden or expected-decode record exists yet. Batch 3 has not run, so
nothing recorded is stale. The risks are all in **how** goldens will be recorded:
- Band suspension would record zero-decode goldens (E1/E2). multimon-ng has
  no band default (it is "unknown", so never suspended), but direwolf (APRS
  targets per region), rtl_433 (ISM ranges per region) and acarsdec (129–137 MHz)
  do. A US FLEX/APRS/915 MHz capture under the guessed EU region would be suspended.
- dsd-fme and acarsdec output changed with `34f56e1` and `9ff133d` (matched filter,
  no dcblock). Any golden must come from an image at or after `e2e82b2` (E3).
- Committed `tests/mocks/fixtures/dsd-fme/*` are parser transcripts and the run-8
  discriminator capture. They are not IQ and stay outside manifest v2
  (`file` must be under `raw/`).
- Field names still match the plan: AIS `mmsi`/`messageType`; dsd-fme
  `talkgroup`/`source` on `call_start`/`call_end`. The WebSocket
  `decoder:output` `{ decoderId, output }` shape and `GET /api/decoders/:id`
  the collector relies on are unchanged.

## 7. Guardrails check

| Guardrail | Still fits? | Change |
|---|---|---|
| Never touch `manager.ts` contracts | Yes | Task 24 stays internal (private `assessBand`, `evaluateRate`). The additive `setChannelizer` is already planned |
| Never touch `packages/api-types`, `cli/`, `packages/sdr-host/` | Yes | A3 still needed: channel codes are outside `DecoderSuspensionReasonCode` |
| Reach decoders only via `attachInput`/`detachInput` | Yes | Name the existing `updateOptions` injection (`inputSampleRate`, `inputCenterFreq`, `inputIqFormat`) as allowed. It merges options, so digital voice's `output`/`udpHost`/`udpPort` survive |
| Stage explicit paths, never push | Yes | Also: only the orchestrator appends to the tracked `docs/CLI-COORDINATION.md` |
| Batch 5 and benchmarks on a quiet host, with revisions and image IDs | Yes, widen it | Apply it to every golden and voice A/B run too. Build images from a clean worktree of `main`, never the shared checkout |
| Add: raw path byte-identical | New | `skipDcBlock`, the matched filter, `BACK_CHAIN` and the `offsetHz` shift stay as they are on the raw path. The default script mode is extend-only |
| Add: no Pi deploys or retunes | New | Captures come from the local dongle or WaveKit Main recordings. Do not run live soaks while SDR++ drives the Pi |
| Add: disk hygiene | New | E14 |

## 8. New risks

1. **Band suspension masking results** (zero goldens, exit-5 capacity cells):
   E1, E2 and E12.
2. **Double shift or offset-validation crash** in cf32 tails inherited from
   `buildIqFrontStages`: E8.
3. **Passband mismatch** making the channel about 3.6 times wider than raw for
   dsd-fme and acarsdec (adjacent-channel energy, golden inequality, voice
   regression): E9.
4. **Digital voice consumes dsd-fme output.** Every channel invalidation (caps
   change, `wavekit-chan` exit) restarts dsd-fme, and `stop()` emits
   `call_end`, so a PTT spanning a retune is split and the :8082 stream has a
   gap. That is accepted, but it must be documented in Task 25's ARCHITECTURE
   note. `mark-gap` resets channel filter state without a restart, so expect
   AMBE errors around branch drops. The voice gate runs paced, with no
   discontinuities.
5. **TDMA burst sensitivity.** Any IIR high-pass, DC removal or fast AGC in the
   channel path reproduces the `9ff133d` chopped voice. The Rust chain (FIR,
   NCO, polyphase) has none. Keep it that way and let §5 catch regressions.
6. **Two-process live demod.** Its front (convert, shift, matched firdecimate)
   is an obvious future cf32 channel consumer. It stays out of scope and on raw
   fanout, and it shares `csdr-stages.ts`, which is guarded by E9's regression
   list. Capacity runs keep `liveDemod` off; record that.
7. **Stale `caps.centerFreq` or rate** when SDR++ retunes the Pi without going
   through the relay (ROADMAP item 6) or leaves it at 2.16 Msps. Channel
   centres then land on the wrong RF and the exact rates are wrong. Rate-truth
   only warns. Note it in the ARCHITECTURE section. Golden and capacity runs use
   recordings or the fake source only.
8. **Shared tree and disk.** CLI and Pi sessions are active, and the disk is
   about 95 % full: E14 and the guardrails above.

## 9. Corrected starting prompt

> Execute docs/superpowers/plans/2026-10-09-core-channelizer.md using superpowers:subagent-driven-development, one Opus subagent per task with review between tasks. First read docs/superpowers/plans/2026-10-09-core-channelizer-delta.md: the plan was written against 896ab6a, main is now e2e82b2 or later, and the delta's required edits E1–E14 override the plan where they differ. Spec: docs/superpowers/specs/2026-10-09-core-channelizer-prototype-addendum.md (refines the 2026-10-08 channelizer and rate-model specs). Confirm or flip D1-D3 in the addendum's section 0 before Task 9 (the delta recommends confirming all three, with the own DMR IQ capture made mandatory). Guardrails: never touch src/decoders/manager.ts contracts, packages/api-types, cli/ or packages/sdr-host/; reach decoders only via attachInput/detachInput plus the manager's existing updateOptions injection; keep every raw-path pipeline byte-identical (dsd-fme skipDcBlock, matched filter and offsetHz shift) and scripts/dsd-fme-voice-ab.mjs passing; stage explicit paths, never push; batch 5, any benchmark and every golden or voice A/B run only on a quiet host, with images built from a clean worktree of main and revisions and image IDs recorded; never deploy to or retune the Pi; clean WaveKit-only build leftovers afterwards. Goal: batch 3 goldens green (band suspension off in the harness), then the opt-in channelizer passing the golden equality gate including the dsd-fme voice gate, then the 1/4/8-channel capacity doc.
