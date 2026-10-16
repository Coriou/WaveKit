# Web gaps 7 design (WG7)

Status: implemented for lanes AMB, GT, BX, HW and MIN (merged and wired; amendments in the
requirements); SQ pending. Requirements in [requirements](requirements.md), tasks in
[tasks](tasks.md). Background: scanner ambient evidence and identify ([SCANNER.md](../../SCANNER.md)
§ 6.4, § 10.8), WG2 CTCSS/DTMF and WG6 DCS (the tone path), WG4 live-audio AGC, the WG6
[decoded-elsewhere ranges](../web-gaps-6/design.md), [band plans](../band-plans/requirements.md),
[receiver capabilities](../receiver-capabilities/requirements.md), WG5 tuning trust, WG6
decoder option schemas, the access spec (protected mode).

## Contract (frozen)

| File                                                                                                                   | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/scanner.ts`                                                                                    | `ScannerProtocol` + `ais`, `acars`, `vdl2`, `lora`; `IdentityKind` + `ais-mmsi`, `acars-reg`, `vdl2-addr`, `lora-node`; `ScannerAmbientDecoderType`; `ScannerIdentifyTrial.decoder` + the ambient types, `transport` + `ambient`, `reason` + `no-ambient-decoder`; `SCANNER_AMBIENT_PROTOCOLS`, `SCANNER_AMBIENT_DECODER_PROTOCOL`, `SCANNER_AIS_CHANNEL_HZ`, `SCANNER_AMBIENT_TARGET_TOLERANCE_HZ` (1 000), `IDENTIFY_AMBIENT_MAX_TRIALS` (8); `BandPlanSkipRange`, `BANDPLAN_SKIP_MAX_SOURCES` (1 024), `BANDPLAN_SKIP_MAX_RANGES` (256); optional `ScanJobSpec.skipBandPlanSkips`, `NormalisedJobSpec.skipBandPlanSkips`, `PlanPreview.bandPlanSkips`, `ScanJobProgress.bandPlanSkips`; `PlanIssueCode` + `bandplan-skips-truncated`, `bandplan-skips-not-applied`; `DECODED_ELSEWHERE_REFRESH_DEBOUNCE_MS` (2 000), `DECODED_ELSEWHERE_REFRESH_MIN_INTERVAL_MS` (30 000) |
| `src/core/scanner/types.ts`                                                                                            | identical copies of the scanner type additions; `BandPlanSkipSource` (the plan's input)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/core/scanner/store/schemas.ts`, `src/core/scanner/evidence/capture-store.ts`, `src/api/routes/scanner-schemas.ts` | protocol and identity-kind enums gain the new values (persisted discoveries and captures, route enums)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/core/scanner/store/persistence.ts`                                                                                | `NormalisedJobSpecSchema.skipBandPlanSkips` optional (old jobs load)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/core/scanner/plan/plan-preview.ts`                                                                                | `PROTOCOL_DECODER` and `PROTOCOL_CLASS` entries (null) for the new protocols; optional `PreviewContext.bandPlanSkips?: () => readonly BandPlanSkipSource[]` (unused until BX)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/core/scanner/classify/classifier.ts`                                                                              | `FAMILY` entries (`packet`) for the new protocols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/core/scanner/job-runner.ts`                                                                                       | optional `JobRecord.bandPlanSkips`; optional `JobDriver.onAmbientEvidence?(observationId, ev)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/api-types/src/bandplans.ts`                                                                                  | `BANDPLAN_SCANNER_PROTOCOLS` + the four (21; preset protocol arrays `max(21)`); `bandPlanImportUrlSchema` judges the raw string as the fetcher does (req 10.1); optional `importedProvenanceSchema.groupOverrides` (≤ 64)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/api-types/src/live-audio.ts`                                                                                 | `LiveAudioSquelchMode` (+ `noise`), `LIVE_AUDIO_SQUELCH_MODES`, `LIVE_AUDIO_NOISE_QUIETING_DB` (default 6, 1–30), `LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS` (nfm, wfm), `LIVE_AUDIO_TONE_SQUELCH_MODULATIONS` (nfm), `LiveAudioToneSquelch` (= saved-frequency tone), `LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT` / `_CLOSE_COUNT` (2); optional `LiveAudioConfig.noiseQuietingDb`, `toneSquelch`; optional `LiveAudioStatus.toneSquelch`; transmission `squelchMode` + `noise`, optional `noiseQuietingDb`                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/api-types/src/activity.ts`, `src/core/activity/storage/contract.ts`                                          | identical `squelchMode` + `noise` and optional `noiseQuietingDb` on the analog transmission payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/config.ts`                                                                                                        | `liveDemod.squelchMode` + `noise`; optional `noiseQuietingDb` (1–30), `toneSquelch` (tone shape); refinements: noise only with nfm/wfm, tone only with nfm, standard CTCSS tones and DCS codes only. No defaults change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/core/live-demodulator.ts`, `src/core/live-demod-activity.ts`, `src/core/analog-transmission.ts`                   | type-only widening of `squelchMode` to the three modes (the runtime schema still refuses `noise` until SQ)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/api-types/src/receiver-capabilities.ts`                                                                      | `RtlTunerName`, `RTL_TUNER_NAMES`, `RTL_TUNER_GAIN_TABLES` (cited), `ReceiverGainTable`; optional `ReceiverCapabilities.gainTable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/api-types/src/config-export.ts`                                                                              | comments only: E2 decided, numbers in options follow the reviewed numeric allowlist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

`tests/unit/core/wg7-contract.test.ts` pins the constants, copy identities, enum membership, the
persisted flag, the config combinations, the gain-table citation shape (lengths 14/5/23/29/29,
ascending, names by type), the URL schema cases and the provenance compatibility.
`tests/unit/core/scanner/discovery-store-identity.test.ts` maps the new identity kinds.

Names a lane creates and Main consumes at merge (frozen here by name):

- AMB: `resolveAmbientTargets(cfg, deps)` in `src/core/scanner/probes/ambient-target.ts`
  returning `AmbientTarget | null` with `targetsHz: readonly number[]` (the existing single `hz`
  stays, = `targetsHz[0]`) and `external: boolean`; `AmbientDeps.tuningTrustOf?: (decoderId:
string, hz: number) => TuningTrust | undefined`; `AmbientEvidence.coverageAt(sourceId, hz,
toleranceHz): readonly AmbientCoverage[]` (`{ decoderId, type, protocol }`);
  `IdentifyDeps.ambient?: (sourceId, hz, toleranceHz) => readonly AmbientCoverage[]`;
  `IdentifyRunner.onAmbientEvidence(observationId, ev)`.
- SQ: `NoiseSquelch` in `src/core/noise-squelch.ts`; `ToneSquelchGate` in
  `src/core/audio-tones/tone-squelch.ts` (no Main wiring: the live demodulator owns both).
- GT: `gainTableFor(peerHeader, transport): ReceiverGainTable` in
  `src/core/tuner-capabilities/gain-table.ts` (no Main wiring).
- BX: `bandPlanSkipSources(view: ResolvedBandPlanView): BandPlanSkipSource[]` and
  `computeBandPlanSkips(sources, spec)` in `src/core/scanner/plan/bandplan-skips.ts`; `planJob`
  returns `{ plan, lockoutExclusions?, decodedElsewhere?, decodedElsewhereIssues?,
bandPlanSkips?, bandPlanSkipIssues? }`; `createCoverageRefresh(options): CoverageRefresh`
  (`notify()`, `dispose()`) and `coverageFingerprint(views)` in
  `src/core/scanner/plan/coverage-refresh.ts`.
- HW: `readNumericOption(value, rule, warn)` and `readNumericArrayOption(...)` in
  `src/decoders/option-values.ts` (no Main wiring).
- MIN: `APP_VERSION` keeps its export from `src/api/routes/health.ts` (value from the build).

Every DTO addition is optional or new; no WebSocket event type is added; no config default changes.

## Pipeline positions

```
decoder output (ais-catcher ship, acarsdec acars, dumpvdl2 vdl2, lora-meshtastic meshtastic)
  → AmbientEvidence (type dispatch; trust rule: same source, not external, tuningTrust, target ±1 kHz, CRC, H2)
  → scanner-service onAmbientEvidence (pair by frequency/time, ±2 s) → applyEvidence → drivers' onAmbientEvidence
  → IdentifyRunner: ambient trial decoded → verdict identified
live demodulator: front csdr → squelchStream (ChannelSquelch: power | SQ noise metric on the channel IQ) → back csdr
  → handleAudioData → SQ ToneSquelchGate (8 kHz decimation, CTCSS bank / DCS words) → mute or pass → audio clients
  └─ squelch-changed → analog transmission tracker (unchanged by the tone gate)
REST GET /api/receiver/capabilities → provider item → GT gainTableFor(peerHeader) (constant lookup)
REST plan preview / job create / PATCH / restore / replan → planJob → BX bandPlanSkips() once → computeBandPlanSkips → (flag) exclusions
decoder manager events → BX CoverageRefresh.notify (debounce 2 s, ≥ 30 s apart, fingerprint) → existing replan path
audio HTTP request (legacy) → HW CORS headers / OPTIONS 204; (protected) access adapter, unchanged
decoder create → adapter option reads → HW readNumericOption (coerce, clamp, warn once) → argv
```

## CPU and IO budgets

| Item          | Position                                                                                       | Budget                                                                                                                                                      | How measured                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| AMB interpret | per decoder output of the four types (AIS ≲ 50 msg/s busy port, ACARS/VDL2 ≲ 10/s, LoRa ≲ 1/s) | one Map lookup per message plus the existing `DoubleMatch` (O(1)); ≤ 20 µs per message on the Mac                                                           | micro-benchmark over 10 000 synthetic messages, reported                               |
| AMB pairing   | per evidence event                                                                             | the existing scan of live + recent observations (unchanged)                                                                                                 | by construction                                                                        |
| AMB identify  | per identify target                                                                            | ≤ 8 ambient trials, no probe, no timer beyond the job tick                                                                                                  | by construction                                                                        |
| SQ noise      | squelch stage, every 10 ms IQ block while running                                              | ≤ 50 ns per channel IQ sample (discriminator by cross product, one biquad high-pass, one accumulator): 1.25 ms/s at 25 kHz NFM; no allocation per block     | micro-benchmark: 60 s of synthetic IQ at 25 kHz and 240 kHz, median of 3, load average |
| SQ tone gate  | every PCM block while running with a tone set                                                  | ≤ 5 ms CPU per second of audio (one 8 kHz decimation, the existing CTCSS bank or DCS stage); no allocation per block                                        | micro-benchmark: 60 s of synthetic 25 kHz audio, median of 3                           |
| SQ tail       | squelch close                                                                                  | no added latency to the open path; the fix adds at most one 10 ms block of work per close                                                                   | by construction + the tail test                                                        |
| GT            | per capabilities item                                                                          | constant (frozen array reference); item grows ≤ 260 B (largest table 29 values)                                                                             | byte test at the item bound                                                            |
| BX skips      | per plan, never per hop                                                                        | ≤ 1 024 segments sorted + merged O(n log n), ≤ 1 ms Mac; at most one extra `planForSpec` (as lockouts)                                                      | micro-benchmark at the bound                                                           |
| BX refresh    | per decoder event                                                                              | O(1) per notify (timer reschedule); per refresh one fingerprint over ≤ 64 views and, only if it changed, the existing replan path; ≤ 2 refreshes per minute | by construction (fake timers)                                                          |
| HW CORS       | per audio HTTP request                                                                         | two header writes                                                                                                                                           | by construction                                                                        |
| HW clamp      | per decoder create                                                                             | constant per option read                                                                                                                                    | by construction                                                                        |
| MIN           | operator rate (update check, export, health) or per vessel message                             | unchanged or less (the tracker reuses objects)                                                                                                              | by construction                                                                        |

Benchmarks are indicative under batch load; Main re-measures a miss on a quiet box. Raspberry
Pi figures are open gaps.

## Ambient identify (lane AMB)

**Interpreters** (`probes/confirm/ais.ts`, `acars.ts`, `vdl2.ts`, `meshtastic.ts`), each
`(out: DecoderOutputLike, state: InterpreterState, ctx: { targetsHz }) => (DecodeEvidence & { hz:
number })[]` (the extra `hz` is the decode's RF frequency):

| Type            | Output                            | hz                                                   | crcClean                                     | identity (H2)                                                       |
| --------------- | --------------------------------- | ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| ais-catcher     | `ship` (`ShipData`)               | `SCANNER_AIS_CHANNEL_HZ[channel]`; no channel → none | true (the adapter drops bad checksums)       | `ais-mmsi` = 9-digit MMSI                                           |
| acarsdec        | `acars` (`ACARSMessage`)          | `frequency`, else the single target, else none       | `error === 0`                                | `acars-reg` = trimmed `tail` (1–8 of `[A-Z0-9-]`), else no identity |
| dumpvdl2        | `vdl2` (`VDL2Message`)            | `frequency` when finite and > 0                      | true                                         | `vdl2-addr` = `fromaddr` or `icao` (6 hex), else none               |
| lora-meshtastic | `meshtastic` (`MeshtasticPacket`) | `frequency`                                          | `viaMqtt !== true` (else no evidence at all) | `lora-node` = `from` as `!%08x`                                     |

Every interpreter drops a decode whose `hz` is not within `SCANNER_AMBIENT_TARGET_TOLERANCE_HZ`
of one of `targetsHz`, validates every field it reads (Zod or explicit guards; malformed → no
evidence, no throw), and never echoes message text into logs. Metadata stays empty (no new
`DiscoveryMetadata` fields).

**Ambient** (`ambient.ts`). `AMBIENT_TYPES` gains the four types; the dispatch routes each to its
interpreter; `handle` emits `AmbientEvidenceEvent { decoderId, sourceId, hz, ev }` with the
interpreter's `hz` for the new types (the existing types keep `target.hz`). A new-type decode is
emitted only when `deps.tuningTrustOf?.(decoderId, hz)` is `commanded` or `relay` (absent dep or
`undefined` → nothing: fail closed) and the target is not `external`. `coverageAt(sourceId, hz,
tol)` lists the running config-owned new-type decoders on that source (not external) whose
`targetsHz` has a value within `tol` of `hz` (status read at call time: running, health
running/idle, not suspended).

**Targets** (`ambient-target.ts`). `resolveAmbientTargets(cfg, { defaultSourceId, caps,
inputKind })` reproduces today's `ambientTarget` exactly for the existing types (property) and
returns all of `cfg.frequencies` (else `options.frequency`, else the protocol defaults the
adapter uses: AIS the two channels, ACARS and VDL2 their adapter defaults, LoRa the tuned
frequency) as `targetsHz`, `external` = input kind `external`.

**Identify** (`identify.ts`). `IDENTIFY_PROTOCOLS` gains the four. After `identifyScores` plans
probe trials, `planAmbientTrials(target, deps.ambient)` appends one trial per covering protocol
(at most 8, by decoder id; restricted to `request.protocols` when given; an explicitly requested
ambient protocol without coverage is `unsupported`/`no-ambient-decoder`). Ambient trials start
`running` when the target resolves, hold no probe and no run index, and end `decoded` from
`onAmbientEvidence(observationId, ev)` when `observationId` is the target's resolved
observation, `ev.protocol` is the trial's and `ev.identity` is set (sets `t.decoded` like a probe
decode); `timeout` at the deadline; `not-needed` when another trial decoded first and the job is
not exhaustive; `cancelled` on a window move. A target with only ambient trials waits for its
deadline like today.

**Failure paths** (each a test): external decoder, other source, scanner-owned or suspended
decoder, unverified/absent trust, AIS without channel, ACARS `error > 0`, ACARS without frequency
and two targets, VDL2 frequency 0/NaN, Meshtastic `viaMqtt`, decode 1.5 kHz off target, a single
CRC-clean decode (no identity), identities across an epoch change (reset), malformed output,
throwing `tuningTrustOf`.

## Noise and tone squelch, noise tail (lane SQ)

**Noise metric** (`noise-squelch.ts`, used by `ChannelSquelch` in `noise` mode). Per channel IQ
sample `d = Im(z[n]·conj(z[n−1])) / max(|z[n]|·|z[n−1]|, ε)` (≈ sin of the phase step, no
`atan2`), a second-order high-pass at about 0.6 × the audio Nyquist of the channel (above
voice), mean square per 10 ms block. Reference `R(rate, bandwidth)`: the block mean square of
the same chain on unit complex Gaussian noise band-limited like the channel; computed once per
run (closed form or a precomputed table) and checked by a test against measured synthetic noise.
Gate: open when `10·log10(R / ms) ≥ noiseQuietingDb`; while open, a block within 2 dB of the
threshold keeps the hang alive; close after 250 ms below. The power level reporting
(`channelPowerDbfs`, floor) keeps running in every mode.

**Tone gate** (`audio-tones/tone-squelch.ts`). `ToneSquelchGate` takes the PCM block at the
demod rate, decimates to 8 kHz (reusing the tone detector's decimator code), runs the existing
CTCSS bank (500 ms blocks, 250 ms hop) or the DCS stage, and exposes `open(): boolean` and
`state`. Opening needs `LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT` consecutive matches (CTCSS winner
equals the configured tone; DCS word reading equals the code or its twin), closing
`LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT` consecutive misses, and an immediate reset on squelch
close. The live demodulator multiplies the block by 0 when closed (in place, no allocation);
the WAV header and rates are unchanged. `ctcss.ts`, `dcs.ts` and `tone-detector.ts` may gain
additive exports (a streaming per-block result) with their existing results unchanged
(property over the WG2/WG6 corpora).

**Noise tail.** The lane first writes the reproduction: a synthetic pipeline (ChannelSquelch +
a fake back chain modelling the measured csdr delay) where the carrier stops at t0, measuring
the unmuted noise duration at the defaults in `manual` and `auto`. Candidate causes to check
with evidence: the hang counted from the last above-threshold block plus hysteresis refreshes on
noise within 2 dB of a threshold set near the floor; the auto floor rising while open; the 100 ms
power smoother; the back chain's buffered audio emitted after the gate closes (a squelch
`closed` edge could zero the back chain's in-flight audio by sample count). The fix stays inside
the Node pipeline and keeps the threshold/hang semantics; the report states the cause, the
before/after durations and any changed transmission `endedAt`.

**Config and route.** The live demodulator's runtime schema accepts `noise`, `noiseQuietingDb`
(runtime default `LIVE_AUDIO_NOISE_QUIETING_DB.default`) and `toneSquelch`, with the same
refinements as `src/config.ts`; `PATCH /api/live-audio/config` accepts them (response schema
lists `toneSquelch` status and the config keys; Fastify strips unknown keys otherwise); changes
apply without a pipeline restart (Node-only keys). Activity rows accept `squelchMode: "noise"`
and `noiseQuietingDb` (`row.ts` validation).

**Failure paths**: noise mode on AM (refused), NaN or silent IQ (gate stays closed), tone set on
WFM (refused), a non-standard tone (refused), tone gate with squelch off (`squelch` 0, manual:
the tone alone decides), a PATCH switching modes mid-transmission (closes with `config` as
today).

## Gain tables (lane GT)

`gainTableFor(peerHeader, transport)`: non-rtl → not-applicable; header not `advertised` →
unknown `header-not-advertised`; type 0 or 4 → unknown `no-gain-table`; type not in
`RTL_TUNER_GAIN_TABLES` → unknown `unlisted-tuner-type`; `gainCount !== table.length` → unknown
`gain-count-mismatch`; else suggested with the frozen array (same reference). The provider sets
`gainTable` on every item; the Zod item schema (discriminated union, values restricted to the
table of the named tuner) and the route's JSON response schema list it; `RECEIVER_CAPABILITIES_LIMITS`
item and page bounds hold at the largest table. The lane counts the table values outside the
gain command's validated range and reports it (no filtering). Tuning ranges: not added (req 5.6).

## Band-plan skips and decoded-elsewhere refresh (lane BX)

**Sources** (`bandplan-skips.ts`). `bandPlanSkipSources(view)`: for each `view.bands` entry (view
order) whose `band.skip !== null`, one source per `segments` entry `{ key, startHz, endHz }`;
total, never throws (malformed → `[]`); at most `BANDPLAN_SKIP_MAX_SOURCES` (truncation reported
by `computeBandPlanSkips`, which receives the untruncated count). Main builds
`ctx.bandPlanSkips = () => bandPlanSkipSources(bandPlanService.resolved())` (the same view as
`GET /api/bandplans/resolved`).

**Plan.** `computeBandPlanSkips(sources, spec)`: clip each to the enabled ranges
(`isRangeEnabled`), sort, merge touching/overlapping (keys united, sorted), cut to 256, issues.
`planJob`: base plan with lockouts (WG2) → with the flag on a sweep, add the skips as extra
exclusions (`planForSpec(spec, ctx, extra)`); if that yields no hop while the base had hops, none
apply + `bandplan-skips-not-applied`; then the WG6 decoded-elsewhere step runs on top of the
applied skips (its not-applied check compares against the plan with skips). Without the flag
or the view every entry is `applied: false` and the hops are untouched; `previewPlan` adds
`bandPlanSkips` only when non-empty. Normalisation copies the flag only when set (provenance
`operator`); `denormalise` round-trips it; the route schemas accept it (create and PATCH).

**Refresh** (`coverage-refresh.ts`). `createCoverageRefresh({ debounceMs, minIntervalMs, now,
setTimer, clearTimer, fingerprint, onRefresh, onError })`: `notify()` (re)arms a trailing timer
`debounceMs` after the latest notify, but never earlier than `minIntervalMs` after the previous
refresh; on fire it computes `fingerprint()` (throw → `onError`, no refresh) and calls
`onRefresh()` only if it differs from the last refreshed one. `coverageFingerprint(views)` is a
stable string over exactly the fields the WG6 trust rule reads. Main subscribes the scanner to
the manager events and calls `scheduleLockoutReplan()` from `onRefresh`.

## Audio CORS (lane HW)

`AudioHttpServer.handle` in legacy mode (no access adapter): every response it writes
(`acceptAudioStream` 200, 404, 405, 503 with `Retry-After`) adds `Access-Control-Allow-Origin:
*` to the existing headers; `OPTIONS` on a path the resolver knows answers 204 with the 8.2
headers and no body; other `OPTIONS` stay 404. In protected mode the adapter path is untouched;
tests cover allowed origin echo, disallowed refusal, and that no protected response carries
`*`. Both servers (live demodulator, digital voice) share the class, so both get it.

## Numeric options (lane HW)

`readNumericOption(value, { integer, min, max, default }, warn)`: numbers pass when finite;
strings pass when they match the schema's numeric text forms (`INTEGER_TEXT` / decimal);
anything else → `default` (absent) + `warn("invalid")`; out of range → clamped + `warn("clamped")`;
`warn` is once per decoder and key and logs the key and the rule, never the value. Bounds come
from `src/decoders/options/<type>.ts`; a key without a max gets one by meaning (verbosity 10;
ppm ±1 000; gain in tenths −100…500 or dB 0…60 as the adapter's unit; sample rates within the
adapter's supported range; durations ≤ 24 h; frequencies arrays ≤ the decoder's channel limit
(acarsdec and dumpvdl2 8, others 64); rtl_433 `protocols` ≤ 256) and the schema and descriptor
gain the same bound. `audio-demod-decoder.ts` formats `fmGain` with the helper before the
`sh -c` string; the lane greps every `sh -c` / shell string built from options and fixes each.
A property feeds random option objects to each adapter's argv builder: every numeric argv token
is finite and within bounds; real configs produce byte-identical argv.

## Minors (lane MIN)

- URL schema parity: a property over random URL-like strings: `bandPlanImportUrlSchema` accepts
  exactly when `checkBandPlanUrl` (with the host in the list) does not refuse on syntax.
- Group overrides: the commit path writes `provenance.groupOverrides` when the committed preview
  had overrides (bound into the digest already); `checkImportUpdate` passes them to
  `previewFetchedWithBands`; old state without the key checks with `[]`.
- Config export: `CONFIG_EXPORT_SENSITIVE_NAME_EXEMPT_PATHS` in `export.ts`, exact dotted paths
  with `*` for array indices, each with a comment (margin, target count, history limit,
  frequency list), applied only when the value is a number (or an array of numbers) the schema
  types as such; the every-secret fixture stays green; the lane lists every path the pattern
  still over-redacts and why it stays.
- Version: esbuild `define` of a `__WAVEKIT_VERSION__` constant from the root `package.json` in
  `scripts/build-file.mjs` and the same define in the vitest config; `health.ts` reads it with a
  typed declaration; a test asserts `APP_VERSION === package.json version`.
- SDR# reference bound, AIS tracker reuse, trails duplicate keys, relay-disconnect label: as
  requirements 10.5–10.8, each with a failing test first.

## Main wiring

- `src/core/scanner/scanner-service.ts`: `ambientTarget` → `resolveAmbientTargets`; the
  `AmbientEvidence` deps get `tuningTrustOf` (new service dep, built in `src/index.ts` from the
  decoder provenance index lookup); `onAmbientEvidence` also calls
  `this.drivers.get(jobId)?.onAmbientEvidence?.(live.observationId, e.ev)` for each paired
  observation's jobs; `createIdentifyDriver` passes `ambient: (s, hz, tol) =>
this.ambient.coverageAt(s, hz, tol)`; review `probeProtocols` / `BURST_PROTOCOLS` per the AMB
  report. `previewContext().bandPlanSkips` from a new dep (`bandPlanSkips?: () => readonly
BandPlanSkipSource[]`); `ScanJob.bandPlanSkips` from `planJob` beside `decodedElsewhere`
  (create, PATCH, replan compare, restore); `skipBandPlanSkips` in the PATCH allowed keys; a
  `CoverageRefresh` subscribed to `decoder:created|started|stopped|error|restarting|max-restarts|removed|health|status-changed`,
  `onRefresh` → `scheduleLockoutReplan()`, disposed on stop.
- `src/index.ts`: the two scanner deps above; the storage report's `decoders` getter from the
  manager's current configs.
- Docs, coordination note, CLI grep, contract test updates after merges, the RF-window prep.

## Correctness properties

1. **Ambient trust rule.** For random decoder states, trust values and decoder outputs of the four
   new types, evidence is emitted only when every condition of 1.3 holds, and then with `hz`
   within 1 kHz of a target. _Validates 1.2, 1.3._
2. **Existing ambient unchanged.** For random outputs of dsd-fme, multimon-ng, direwolf and
   rtl433 decoders, the emitted evidence and targets equal the pre-WG7 module's. _Validates 1.4._
3. **Identity needs two clean decodes.** For random message sequences, an identity appears only
   on the second CRC-clean occurrence of the same value within one epoch. _Validates 1.3._
4. **Ambient identify inert without coverage.** For random identify requests with no covering
   ambient decoder (and no ambient protocol requested), trials and results equal today's.
   _Validates 1.5, 1.6._
5. **Manual and auto squelch unchanged.** For random IQ block sequences, the gate sequence in
   `manual` and `auto` equals the pre-WG7 `ChannelSquelch` except where the tail fix applies (the
   difference is confined to blocks after the last above-threshold block). _Validates 2.1, 4.2._
6. **Noise squelch on noise and carrier.** Random noise seeds never open the gate at the default;
   carriers at ≥ 12 dB CNR open it within 50 ms. _Validates 2.2, 2.5._
7. **Tone gate.** For random tone sequences, audio passes only while the configured tone (or DCS
   twin) is matched per 3.2; other standard tones never open it; transmission events and tone
   results equal those without the gate. _Validates 3.2, 3.3, 3.5._
8. **Gain table match.** For random headers and transports, `gainTable` is `suggested` exactly
   when advertised, listed and the count equals the table length, with the frozen values; else
   the stated reason. _Validates 5.1–5.3._
9. **Band-plan skips inert without view or flag.** For random specs, with `bandPlanSkips` absent,
   throwing or empty the preview deep-equals today's; with entries but no flag the hops equal
   today's. _Validates 6.1, 6.6._
10. **Skip merge shape.** Entries sorted, non-overlapping and non-touching, clipped to enabled
    ranges, keys sorted and unique, at most 256. _Validates 6.3._
11. **Skip excludes.** With the flag on a sweep job and entries applied, the plan deep-equals the
    plan with the applied ranges added as operator exclusions; when none applied the
    `bandplan-skips-not-applied` warning is present and the plan equals the plan without the flag.
    _Validates 6.4._
12. **Refresh bounds.** For random notify timings over a window T with a fake clock, refreshes are
    at most ⌈T / 30 s⌉ + 1, none fires earlier than 2 s after the latest notify before it, and
    `onRefresh` never runs for an unchanged fingerprint. _Validates 7.1, 7.2._
13. **Audio CORS.** For random paths and methods, legacy responses carry `*` and never
    credentials; protected responses never carry `*`. _Validates 8.1–8.3._
14. **Bounded numeric options.** For random option objects, every adapter's numeric argv token is
    finite and within its bounds, no option string reaches a shell string, and the real configs'
    argv are unchanged. _Validates 9.1–9.5._
15. **URL schema parity.** The schema accepts a URL exactly when the fetcher's syntactic checks
    accept it. _Validates 10.1._
