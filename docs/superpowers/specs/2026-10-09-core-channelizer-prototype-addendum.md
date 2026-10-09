# Core channelizer addendum: fixtures, prototype contract, capacity gate

Status: implementation-ready design addendum, 2026-10-09. Refines batches 3–5 of
the [sample-rate and channelizer design](2026-10-08-sample-rate-and-channelizer-design.md)
(§ "Core channelizer prototype contract", § "Acceptance and implementation
batches") and reuses the declaration and suspension contracts of the
[rate-model addendum](2026-10-08-rate-model-instances-and-suspension.md)
(§§ 2.1, 4.1–4.4, 5) without restating them. Facts cite the tree at `eab625f`.
Nothing here is implemented; code for batch 4 starts only after rate-model B2
(suspension) merges. Live evidence this addendum designs against (2026-10-09,
loaded Mac, nine decoders, 2.048 Msps): the app used about 7.5 of 8 cores, every
fanout branch dropped 8–36 %, four `sox rate -h` IQ resamplers cost about 1.5
cores, the LoRa wrapper about 0.3 core, and followCenter decoders burned CPU on
bands they cannot decode.

## 0. Decisions pending user confirmation

| Decision | Taken | Alternative if flipped |
|---|---|---|
| D1 Language | Rust: `rustfft` + own FIR/polyphase resampler; binary `wavekit-chan`; new Dockerfile stage on a Rust bookworm image; amd64/arm64 via `docker/bake.hcl`; no runtime deps. | C++ + libcsdr (GPL-3, integer-only decimation) or C + liquid-dsp (MIT, new dep to build and pin). Only § 10 and the crate list change. |
| D2 Fixture sourcing | Hybrid: public corpora with license recorded per fixture; short own RTL-SDR captures at 2.048/2.4 Msps for POCSAG, DMR, LoRa (`fixtures/lora/README.md` procedure, `scripts/auto-capture.mjs`/`.py`), kept out of git under `fixtures/raw/` (already gitignored, `.gitignore:79`) and fetched by `download.sh` with sha256; synthetic only for DSP property tests. | Public-only (gaps stay uncovered) or own-only (no provenance diversity). Only § 8's acquisition list changes. |
| D3 Transport | One raw Unix socket per channel under `channelizer.socketDir` plus a JSON-lines control protocol (requests on stdin, events on stdout). Node connects per channel and passes the socket `Readable` to `decoder.attachInput()` (`base-decoder.ts:307-321`), so `DecoderManager` contracts do not change. | In-band framed blocks de-framed in Node (extra copy, Node CPU) or fixed extra pipe fds at spawn (cannot add a channel without a restart). Only § 4 and § 11 change. |

Everything under RESOLVED in the parent and rate-model specs stays as decided:
one supervised child process per source, raw fanout preserved, stop/restart on
rate or centre change, direct FIR+resampler first, demod stays in csdr tails,
admission by passband plus margin, bounded per-channel queues, bounded-CSDR
baseline for batch 5, no benchmarks on this Mac, LoRa excluded from migration.

## 1. Channel centre per instance

Add `channelHz?: number | undefined` to `DemodulationConfig` and
`IqDecimationConfig` (`src/decoders/types.ts:91-140`,
`iq-decimate-decoder.ts:32-42`). It is the absolute RF centre the decoder wants
delivered at baseband. Absent means "the source centre", which is today's
behaviour for every stdin decoder. Decoders populate it from a new generic
option `options.channelHz` or from a field they already carry:

| Instance | Source of `channelHz` | Note |
|---|---|---|
| dumpvdl2 | `followCenter` → source centre; else midpoint of `min(frequencies)…max(frequencies)` (`dumpvdl2.ts:23-32, 202, 228-231`) | dumpvdl2 channelises internally, so one channel wide enough for the span is requested (§ 2). `--centerfreq` is set to the channel centre, not the capture centre. |
| acarsdec | `options.channelHz ?? frequencies[0]` when `frequencies.length === 1` (`acarsdec.ts:28, 235-241`) | The audio tail decodes one AM channel; several `frequencies` without `channelHz` is rejected with `channel-request-invalid`. |
| lora-meshtastic | `frequency` / `followCenter` exist (`lora-meshtastic.ts:95, 121-122, 148-151`) | Excluded from migration (§ 7); listed so nobody adds a second field. |
| rtl_433, ais-catcher, multimon-ng, direwolf, dsd-fme | `options.channelHz` only | None carries a frequency today. |

The manager already injects `inputSampleRate` and `inputCenterFreq` from source
caps on wire and on every caps change (`manager.ts:721-726, 949-954`); the
offset `channelHz − inputCenterFreq` is computed inside the channelizer manager,
never in the decoder. A decoder with `useChannelizer: true` and no resolvable
centre falls back to offset 0 and logs at info. The `passive` type list
(`manager.ts:932-943`) stays as is: a channelised decoder is passive to
centre-only retunes only when its channel still fits (§ 4 re-evaluates it).

## 2. Occupied bandwidth and transition margin

Add, mirroring `getRateAdapter` (rate-model § 2.1):

```ts
interface DecoderChannelRequest {
	centerHz: number        // absolute RF centre (§ 1)
	bandwidthHz: number     // two-sided occupied passband, unity gain
	transitionHz: number    // passband edge → stopband edge, one side
	outputRateHz: number    // exact; the channelizer never approximates it
	format: "cu8" | "cf32"
	gain?: number           // cu8 only, default 1.0 (§ 3)
}
interface Decoder {
	getChannelRequest?(input: { sampleRateHz: number; centerHz?: number }): DecoderChannelRequest | undefined
}
```

Derivation is pure and lives beside the existing adapter helpers
(`audioDemodRateAdapter`, `iqDecimateRateAdapter`, rate-model § 2.2) so the
pipeline string and the request cannot disagree. Default passband when the
decoder declares nothing narrower: `t = filterTransition ?? 0.05`,
`transitionHz = outputRateHz × t / 2`, `bandwidthHz = outputRateHz × (1 − t)`,
which reproduces today's `firdecimate` cut at the output Nyquist
(`iq-decimate-decoder.ts:175`, `audio-demod-decoder.ts:217, 235`).
`DemodulationConfig.bandwidth` stays informational, as it is today.

| Instance | outputRateHz | format | Change versus today |
|---|---|---|---|
| ais-catcher | 384 000 | cu8 | replaces `sox rate -h` (`iqResampleCommand`, `process-tools.ts:32-70`) |
| dumpvdl2 | `targetSampleRate` (1 050 000) | cu8 (`U8` in dumpvdl2 terms) | replaces sox; `bandwidthHz = max(default, span + 50 000)` |
| rtl_433 | `targetSampleRate` exactly (250 000 default) | cu8 | integer `fs/k` becomes exact; adapter reports `resample` |
| multimon-ng, direwolf, dsd-fme | `demodSampleRate ?? sampleRate` (48 000) | cf32 | k=43 → 47 627.9 Hz at 2.048 Msps becomes exactly 48 000; sox after demod disappears for direwolf and dsd-fme |
| acarsdec | 24 000 | cf32 | as above, exact |

`frontendIq` in each `DecoderRateRequirements` (rate-model § 2.3) is unchanged:
the channelizer realises the preferred frontend rate exactly, so a channelised
instance's `ResolvedRatePlan.adaptation` is `resample` with
`frontendRateHz = outputRateHz`. The resolver never claims an exact frontend
rate merely because it was requested: the plan is recomputed from the
channelizer's `opened` event (§ 11), not from the request.

## 3. Output IQ format and scaling

The process accepts CU8 input only (the only format every stdin pipeline
assumes, rate-model § 1 item 5). Output formats:

- **cf32**: interleaved little-endian float32 I/Q. Scaling: full-scale CU8
  (0 or 255) maps to ±1.0 within 1 %. The audio tails drop their leading
  `csdr convert -i char -o float` and `csdr firdecimate` and start at `agc`
  (if enabled) or `fmdemod`/`amdemod`.
- **cu8**: `round(127.5 + 127.5 × gain × x)` saturated to 0…255, per component;
  saturations are counted in `stats`. `gain` defaults to 1.0. Property 7 pins
  the mapping to the pinned csdr convert pair within ±1 LSB.

Regression risk (RESEARCH § 7): today the IQ AGC stage runs on the full-rate
capture before decimation (`audio-demod-decoder.ts:230-235`); after migration it
runs on the 48 kHz channel, where out-of-band noise is gone and its reference
level sees a different power. For cu8 consumers the decimation filter removes
noise that previously dithered the 8-bit quantiser, so weak signals may lose
LSBs. Both are why the audio family migrates last (§ 7) and why every
migration requires fixture equality (§ 8), not process uptime. `gain` exists
to recover headroom for cu8 consumers if a fixture shows regression.

## 4. Lifecycle owner and generation linkage

New directory `src/core/channelizer/`:

| File | Responsibility |
|---|---|
| `types.ts` | `DecoderChannelRequest`, `ChannelAdmissionReason`, events |
| `protocol.ts` | Zod schemas for every request/event line (§ 11), version 1 |
| `admission.ts` | pure `admitChannel(req, caps, usableFraction)` |
| `channelizer-process.ts` | spawn `wavekit-chan` detached, `signalDecoder` SIGTERM → SIGKILL after 5 s as `base-decoder.ts:249-290`; stdin/stdout JSON lines; socket connect |
| `channelizer-manager.ts` | one instance per source, lazily created on first request, destroyed when its last channel closes (`releaseUnused` analogue) |

The manager is a fanout consumer: `fanout.addBranch({ id: \`channelizer-${sourceId}\`, sourceId })`
through `SourceFanoutRouter.getFanout` (`source-fanout-router.ts:56-71`), piped
to the process stdin with `pipeline()` and an error handler. It listens to
`caps-changed`, `connected`, `disconnected`, `removed` on `SourceManager`
(`source-manager.ts:113`). Public surface:

```ts
requestChannel(sourceId, decoderId, req): Promise<
	| { ok: true; stream: Readable; channelId: string; generation: number; realised: { outputRateHz; format; groupDelaySamples } }
	| { ok: false; reasonCode: ChannelAdmissionReason; detail: string }>
releaseChannel(channelId): Promise<void>
on("channel-invalidated", (sourceId, generation, channelIds) => void)
on("channel-discontinuity", (channelId, generation, sampleIndex, droppedSamples, cause) => void)
```

Generation rules. `generation` increments on every (re)spawn of a source's
process. It is not `rateGeneration` (rate-model § 4.1); a decoder transition
rechecks both. On `caps-changed` or `disconnected` the manager bumps the
generation, emits `channel-invalidated` once per open channel, destroys the
sockets, discards queues with the process, and spawns nothing until the next
request; it never retunes. A request carries the caller's `state.inputCaps`;
the manager compares them with `sourceManager.getCaps(sourceId)` and spawns or
respawns to match, so the order in which `caps-changed` reaches the two managers
does not matter. Input-branch drops (`FanoutManager` drop-mode,
`fanout-manager.ts:267-271`) do not invalidate channels; the manager sends
`mark-gap` (§ 11) and every channel reports `discontinuity cause: input-gap`
with its filter state reset. Source loss (`disconnected`, `removed`) does
invalidate every derived channel (contract ¶5).

DecoderManager integration (after B2, no contract change): in
`wireDecoderToFanout` (`manager.ts:698-749`), when `config.useChannelizer`,
`channelizer.enabled` and `decoder.getChannelRequest` all hold, call
`requestChannel` instead of `fanout.addBranch` and pass the stream to
`attachInput`. `state.branchId` records the channel id and `state.branchFanout`
is null; `detachBranch`/`unwireDecoderFromFanout` call `releaseChannel`. A
rejection runs the existing `suspend(state, plan)` primitive with the channel
reason (§ 5). `channel-invalidated` for a decoder's channel enqueues that
source into `pendingCapsChanges` so the existing serial `drainCapsChanges`
(`manager.ts:869-884`) re-evaluates it: restart re-requests the channel, a
rejection becomes a suspension, and a later usable centre resumes it. Every
`await` in that path is followed by the rate-model's `gen`/identity/intent
checks plus a channel-generation check.

## 5. Admission reason code

`ChannelAdmissionReason = "channel-outside-capture" | "channel-request-invalid" | "channelizer-unavailable"`.
A rejection is a suspension, never a crash: it does not consume restart budget,
trigger failure backoff, change `enabled`, record `lastError`, or report a
decoder crash (rate-model § 4.2 invariants). `channelizer-unavailable` covers
binary missing or process spawn failure and is logged at error once.

The shared union lives in `packages/api-types/src/decoders.ts:54-64` with a
strict Fastify enum (`src/api/routes/decoder-rate-schemas.ts:90-100`); both are
off limits to this work. Until B3 adds `channel-outside-capture` and
`channel-request-invalid` there, the prototype keeps the reason in
`DecoderState.suspension.reasonCode` typed with a core-internal superset, and
the DTO mapper (`src/api/serializers/decoder-status.ts`) omits `reasonCode`
(it is optional) for channel suspensions rather than emitting a rate code that
would be false. The request to extend the union goes to
`docs/CLI-COORDINATION.md` "Open requests" from the orchestrator, phrased as
additive and published through the existing `decoder:status` event.

## 6. Usable-capture guard and queue budgets

```yaml
channelizer:
  enabled: false
  binaryPath: wavekit-chan          # resolved on PATH
  socketDir: /var/run/wavekit/chan  # exists in the image, Dockerfile:566
  usableFraction: 0.8               # 0.5–0.95
  channelQueueMs: 250               # 50–2000
  inputHighWaterMark: 262144        # fanout branch default
  blockSamples: 16384               # process input block, 8 ms at 2.048 Msps
```

Zod schema in `src/config.ts` beside `CsdrConfigSchema` (`config.ts:255-265`),
added to `ConfigSchema`; env `WAVEKIT_CHANNELIZER__ENABLED=true`. Admission:
`|centerHz − captureCenterHz| + bandwidthHz/2 + transitionHz ≤ fs × usableFraction / 2`
and `bandwidthHz/2 + transitionHz ≤ outputRateHz/2`.

| Quantity | 2.048 Msps | 2.4 Msps |
|---|---|---|
| usable span (0.8) | 1 638 400 Hz | 1 920 000 Hz |
| input branch, 256 KiB per side (`PassThrough` counts readable + writable, `fanout-manager.ts:413-414`) | 64 ms / side, 128 ms total | 55 ms / side, 109 ms total |
| 48 kHz cf32 queue, 250 ms | 96 000 B | same |
| 384 kHz cu8 queue | 192 000 B | same |
| 1.05 MHz cu8 queue | 525 000 B | same |
| 250 kHz cu8 queue | 125 000 B | same |

Process memory is bounded by two input blocks, the per-channel queues above,
and filter state; no unbounded buffer exists anywhere in the path. The parent's
"≈125 ms" input figure counts both sides of the branch.

## 7. Migration order and opt-in shape

`channelizer.enabled` (default false) gates the subsystem; `useChannelizer:
z.boolean().default(false)` on `DecoderConfigSchema` (`config.ts:87-118`)
selects instances. Both false leaves every pipeline byte-identical to today.
Order, each step gated by § 8 equality on its goldens before the next starts:

1. **ais-catcher**: IQ, exact rate, no AGC, removes one sox.
2. **dumpvdl2**: IQ, exact rate, needs `channelHz` (§ 1), removes one sox.
3. **rtl_433**: IQ, integer today → exact 250 kHz; verify decode parity since
   the delivered rate changes.
4. **direwolf, multimon-ng, dsd-fme, acarsdec**: cf32 tails, AGC equivalence
   risk (§ 3), last.

Excluded: readsb (raw fanout, keeps its own resample; a 2.4 Msps capture
removes it, ROADMAP item 6) and lora-meshtastic (`bw × os = 2 000 000` from
2 048 000 is a 125/128 full-rate resample; follow-up: let the LoRa declaration
accept 2 048 000 natively by passing `--samp-rate 2048000` to the wrapper if
`gr-lora_sdr` tolerates a non-integer oversampling, to be checked before any
declaration change).

## 8. Fixture harness (batch 3, first)

Manifest v2 (`fixtures/manifest.yaml`, `version: 2`), validated by a Zod
schema in `tests/integration/fixtures/manifest.ts`; `download.sh` and
`convert.sh` read the same fields. Current defects fixed: duplicate
`sigid_vdlm2` ids, `sample_rate: null`, an audio-only VDL2 entry labelled for
dumpvdl2, no license/sha/centre, and the 12-byte LoRa placeholder.

```yaml
- id: own_ais_162m_2048k           # unique
  role: channelizer-golden         # | tail-golden | parser-transcript | negative
  decoder: ais-catcher
  license: "CC-BY-4.0"             # or "private" for own captures
  provenance: { url: ..., notes: ... }
  file: raw/own_ais_162m_2048k.cu8
  sha256: 64 lowercase hex characters, checked by download.sh
  format: cu8                      # cu8 | cs16 | cf32 | wav
  sample_rate: 2048000
  center_hz: 162000000
  duration_s: 20.5
  expected:
    min_count: 3
    payloads:                      # decoded fields, not grep counts
      - { mmsi: 211234560, type: 1 }
  channel: { center_hz: 161975000 }  # optional: off-centre request for the channelizer run
```

Harness: `tests/integration/iq-fixture-goldens.test.ts`, env-gated like
`decoder-runtime-smoke.test.ts` (`WAVEKIT_DECODER_SMOKE_CONTAINER`) with
`WAVEKIT_FIXTURE_CONTAINER` and `WAVEKIT_FIXTURES_DIR`. Per fixture it writes a
config with one `recording` source (`type: recording`, `filePath`, `loop:
false`, `playbackSpeed`, caps from the manifest; `source-manager.ts:433-539`
emits 50 ms sample-aligned chunks capped at 65 536 B) and one decoder,
starts the app in the container, subscribes to the `decoders` WebSocket
channel and collects `decoder:output` events (docs/API.md § decoder:output)
for `duration_s / playbackSpeed + 10 s`, then asserts `expected.payloads ⊆
observed` and `count ≥ min_count`. Batch 4 runs every `channelizer-golden`
twice, `useChannelizer: false` and `true`, and requires equal observed sets
(Property 15). `negative` fixtures assert zero decodes or a
`channel-outside-capture` suspension. `fixtures/test-decoders.sh` stays a
manual tool and is not a gate.

Acquisition (D2). Public with license verified: SDRplay AIS (WAV → cu8),
SDRangel ADS-B 2.4 Msps (readsb raw baseline only), SigIDwiki POCSAG/FLEX
(rate and centre verified from file metadata before acceptance). Own
2.048/2.4 Msps CU8 captures for POCSAG, DMR, VDL2 (136.8 MHz centre), rtl_433
(433.92 MHz), LoRa; trimmed to the shortest window holding the expected
decodes; pager, ACARS and AIS captures contain real identifiers and stay
private. `rtl_433_tests` samples are `tail-golden` (narrow rates, no capture).
A fixture is a channelizer golden only at ≥ 2.048 Msps CU8 with a known centre.

## 9. Capacity tooling (batch 5)

`scripts/capacity/fake_rtl_tcp.py` gains `--file <cu8> [--loop]` with the same
absolute pacing and 262 144-byte blocks (`fake_rtl_tcp.py:28, 110-117`), reading a
manifest v2 fixture; `--rate` must equal the fixture rate.
`run_capacity.py` gains `--channelizer on|off`, `--channels 1|4|8`,
`--placement spread|clustered`, `--fixture <id>`; spread placement puts channel
k of N at `center + usable × ((k + 0.5)/N − 0.5)` so channels span the capture
(REVIEW item 3). Each placement runs one decoder instance of the fixture's
type with `channelHz` set; the channel containing the signal must decode the
fixture's expected set, the others are load. `meta.json` records image id,
`gitHead`, `wavekit-chan --version`, fixture sha256 and placements;
`sampler.py` adds the channelizer process to its smaps labels and reads the
process `stats` lines from `app.log`; `summarize.py` reports queue high-water,
dropped samples per channel, saturations and CPU for the process separately.
Gate: for 1/4/8 channels at 2.048 and 2.4 Msps, paced and unpaced
(`--playback` unpaced reads the file as fast as the app accepts), the
channelizer path delivers zero `queue-overflow` discontinuities at target load,
bounded RSS/PSS, and the same decoded set as the bounded-CSDR path
(`csdr.boundedBuffers: true`) on the same input. Runs happen on a quiet
machine, never on this Mac.

## 10. Build and packaging (D1)

- Source in `native/wavekit-chan/` with `Cargo.toml`, committed `Cargo.lock`,
  edition 2021; crates `rustfft` (MIT/Apache-2.0), `serde`, `serde_json`
  (MIT/Apache-2.0); no async runtime (std threads, blocking I/O). Licenses are
  recorded in `native/wavekit-chan/LICENSES.md`.
- Dockerfile stage `chan-build` `FROM rust:1-slim-bookworm` pinned by digest at
  implementation time (same discipline as `CSDR_REF`), `cargo build --release
  --locked` with a cache mount on `target/` and the cargo registry; builds
  natively per platform under buildx (amd64, arm64). Binary copied to
  `/usr/local/bin/wavekit-chan` in `final-base` (`Dockerfile:554-630`) and
  added to the verify step (`wavekit-chan --version`).
- `docker/bake.hcl`: add `cache("chan-build")` to the `final` and `final-core`
  chains; `final-sdrpp` and `final-demod` unchanged.
- Dynamic linking only to glibc; `ldd` output is asserted in the verify step.
- Local dev without Docker: `channelizer.enabled: false` keeps today's path;
  `make chan-build` runs cargo on the host when a toolchain exists.

## 11. Control protocol (version 1)

Spawn: `wavekit-chan --generation G --input-format cu8 --input-rate FS
--input-center C --usable-fraction F --block-samples B --socket-dir DIR`.
Requests on stdin, events on stdout, one JSON object per line, every line with
`v: 1`. Zod schemas in `src/core/channelizer/protocol.ts`; unknown request
`type` yields `rejected` with `channel-request-invalid`, never an exit.

```ts
// requests
{ v: 1, type: "open", id, centerHz, bandwidthHz, transitionHz, outputRateHz, format: "cu8" | "cf32", gain?, queueBytes }
{ v: 1, type: "close", id }
{ v: 1, type: "mark-gap" }                 // Node saw an input-branch drop
{ v: 1, type: "shutdown" }
// events
{ v: 1, type: "ready", generation, pid }
{ v: 1, type: "opened", id, generation, socket, outputRateHz, format, filterTaps, groupDelaySamples }
{ v: 1, type: "rejected", id, generation, reasonCode: "channel-outside-capture" | "channel-request-invalid", detail }
{ v: 1, type: "discontinuity", id, generation, sampleIndex, droppedSamples, cause: "queue-overflow" | "input-gap" }
{ v: 1, type: "stats", generation, inputSamples, channels: [{ id, outputSamples, queueHighWaterBytes, droppedSamples, saturatedSamples }] }  // every 5 s
{ v: 1, type: "closed", id, generation, reason: "requested" | "client-gone" }
{ v: 1, type: "input-eof", generation, inputSamples, discardedBytes }
```

The process listens on `DIR/<id>.sock` before emitting `opened`; exactly one
client per socket; client disconnect closes the channel. `sampleIndex` is the
output sample index at which the discontinuity begins, monotonic per channel
per generation. The process re-checks admission (§ 6) and must agree with Node
(Property 1). At input EOF it flushes filter tails, emits `input-eof`, closes
sockets and exits 0; a trailing odd byte is discarded and counted.

## 12. Correctness properties

Each becomes a property or integration test; numbering continues the project's
`// Feature: channelizer, Property N` convention.

1. **Admission agreement.** For random `fs ∈ {2 048 000, 2 400 000, uniform}`,
   centre, bandwidth, transition and rate, `admitChannel` in Node and the
   process's `rejected`/`opened` outcome agree.
2. **Admission rule.** A request is admitted iff
   `|Δf| + bw/2 + tr ≤ fs × F / 2` and `bw/2 + tr ≤ out/2`; admission never
   writes to the tuner or restarts another consumer.
3. **Exact rate.** For N input samples the channel emits
   `⌊N × out / fs⌋ ± 1` samples; over 10 s the error never exceeds one sample.
4. **Chunk-split independence.** Arbitrary byte splits of the same input,
   including splits inside a CU8 pair, produce identical output bytes.
5. **Translation and passband.** A tone at `C + f` inside the passband emerges
   at `f − Δf` with amplitude within ±0.1 dB and continuous phase.
6. **Stopband and image.** Tones in the stopband or at the image frequency are
   attenuated ≥ 60 dB.
7. **Pass-through identity.** `Δf = 0`, `out = fs`, cu8→cu8, gain 1.0
   reproduces the input within ±1 LSB (pins scaling to the pinned csdr
   convert pair).
8. **Bounded queue.** With one stalled reader the channel queue never exceeds
   `queueBytes`, whole complex samples are dropped, `droppedSamples` equals
   the gap, and other channels' output is byte-identical to the unthrottled
   run.
9. **Generation stamping.** Every event carries the generation of the process
   that produced it; the manager never attaches a stream whose generation
   differs from the current one.
10. **Invalidation.** `caps-changed`/`disconnected` emits `channel-invalidated`
    exactly once per open channel per generation, closes sockets and the old
    process exits within the stop timeout.
11. **Rejection is a suspension.** A rejected request never increments
    `restartCount`, records `lastError`, changes `enabled` or spawns a decoder
    process; `desiredRunning` stays true.
12. **Input-gap marking.** `mark-gap` yields one `discontinuity cause:
    input-gap` per open channel, and output after the gap equals a fresh
    start on the post-gap input once the group delay has elapsed.
13. **EOF tail.** At EOF the process emits `input-eof`, exits 0, and a
    trailing odd byte is counted in `discardedBytes`.
14. **Protocol validity.** Every emitted line parses with the v1 Zod schema;
    malformed requests produce `rejected`, not an exit.
15. **Golden equality.** For each `channelizer-golden` fixture, expected
    payloads ⊆ observed on both paths, and the two observed sets are equal.

## 13. Out of scope

SDR-host placement and framed network transport; moving demod/AGC into the
process; FFT versus direct comparison; protocol-aware scanning and power
estimates; readsb migration; automatic retune; public API/CLI exposure of
channel status.
