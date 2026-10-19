# Rust live demodulator, phase A: requirements

Status: draft (WG12). Source: `docs/ROADMAP.md`, WG12 "Rust live demodulator, phase A".

## Introduction

The live demodulator (`src/core/live-demodulator.ts`) runs a csdr shell chain per listener:
two `/bin/sh` front and back pipelines with 4 to 9 processes, a Node squelch stage between
them, a pipeline restart on every bandwidth or modulation change, and no csdr build for macOS.
On the live core its fanout branch enters drop-mode about 70 times an hour. Phase A adds a
`demod` channel kind to `wavekit-chan` for NFM and AM, behind `liveDemod.engine`, with the
csdr chain kept as the default and the fallback. The NFM/AM kernel is a pure library module
that the WG12 scanner lane also calls offline on captured IQ (analog replay trial).

Out of scope: the 48 kHz WebSocket audio stream (§5b), WFM, SSB, CW, DSB, raw, engine AGC
modes, noise blanker and notch (phase B); decoder adapters and FanoutManager changes (this
spec only measures them and proposes a fix, Requirement 9); the replay trial itself.

## Glossary

- **Kernel**: the pure DSP module `wavekit_chan::demod` (no I/O, no threads, no process state).
- **Demod channel**: a `wavekit-chan` channel opened with `kind: "demod"`; it runs the channel
  front (NCO, decimation, channel filter) and the kernel, and writes audio to its socket.
- **Block**: 10 ms of audio at the output rate (480 samples at 48 kHz), the squelch unit.
- **Rust engine / csdr engine**: the value of `liveDemod.engine`.

## Requirement 1: engine flag and fallback

**User story:** As an operator, I want to choose the Rust engine by config and still get audio
when it cannot run, so that trying it never costs me listening.

1. 1.1 `LiveDemodConfigSchema` gains `engine: "csdr" | "rust"`, default `"csdr"`, and an
   optional `chanBinaryPath` (string, default `"wavekit-chan"`). With the shipped config the
   live demodulator's argv, routes, HTTP headers, log lines and audio bytes are unchanged
   (goldens recorded from base `5e843735`).
2. 1.2 `engine` is a restart key (not in `NODE_ONLY_KEYS`); a reconfigure from csdr to rust or
   back restarts the pipeline once.
3. 1.3 With `engine: "rust"`, the csdr engine is used instead, with one warn log of fixed text
   (no paths, no tool output) and `status.engine = "csdr"`, `status.engineFallback` set to a
   fixed reason code, when: the binary is missing or fails to spawn (`binary-unavailable`),
   its `--version` protocol is lower than the demod protocol (`protocol-unsupported`), the
   source format is not cu8 (`input-format-unsupported`), the modulation is not `nfm` or `am`
   (`modulation-unsupported`), or `open` is rejected (`open-rejected`). It never throws out of
   `start()` or `reconfigure()` for these causes.
4. 1.4 If the Rust process exits or its socket closes while running, the live demodulator
   restarts under the existing backoff (1 s doubling to 30 s); after 3 consecutive failed
   Rust starts within one backoff window it falls back to csdr (`process-unstable`) until the
   next restart key change.
5. 1.5 `getStatus()` reports `engine` (`"csdr" | "rust"`) and, when set, `engineFallback`.
   The shared DTO change is a Main-seam diff (`packages/api-types`).

## Requirement 2: the kernel (reusable library)

**User story:** As the scanner lane, I want to demodulate captured 48 kHz cf32 IQ offline,
faster than real time, with the same DSP as live audio.

1. 2.1 The kernel accepts complex f32 samples at a caller-stated rate and returns mono f32
   audio at the same rate; it holds only DSP state, does no I/O, spawns nothing and reads no
   clock. Its API is the frozen contract in `design.md` §Contract.
2. 2.2 NFM: a phase-difference (atan2 of `x[n]·conj(x[n−1])`) discriminator scaled so a
   deviation of `deviationHz` (default 5 000) gives amplitude 0.8 before `gain`; optional
   de-emphasis (50 or 75 µs); DC block; optional high/low pass from the existing
   `resolveLiveDemodFilters` result; gain; hard limit to ±1.
3. 2.3 AM: envelope `|x|`, DC block, fast AGC to reference 0.4 (matching `csdr agc -p fast
-r 0.4` within the A/B bounds of 7.4), gain, limit.
4. 2.4 Feeding the same samples split into any chunk sizes gives bit-identical output.
5. 2.5 `reset()` returns the kernel to its freshly constructed state.
6. 2.6 Non-finite input samples are treated as 0 and counted; the output is always finite.

## Requirement 3: demod channel and in-place retune

1. 3.1 `wavekit-chan` protocol 2 adds `open {kind: "demod", ...}` with `modulation`
   (`nfm|am`), `offsetHz`-equivalent `centerHz`, `bandwidthHz`, `audio` options and
   `squelch` options; the output rate is fixed at 48 000 Hz audio, output format f32le or
   s16le. A `kind`-less `open` keeps protocol-1 behaviour byte for byte.
2. 3.2 `retune {id, centerHz?, bandwidthHz?, modulation?, audio?}` applies at the next input
   block boundary without closing the socket: the NCO changes frequency keeping its phase
   accumulator (no phase step), a bandwidth change re-designs the channel filter at the fixed
   48 kHz complex rate and keeps the delay line, a modulation change resets only the kernel.
   The event `retuned {id, atOutputSample}` reports the first output sample of the new state.
3. 3.3 Across a retune the output has no sample gap and no duplicated sample: the output
   sample count equals input samples × 48 000 / input rate (± the filter's fractional phase).
4. 3.4 `bandwidthHz` range 2 500 to 40 000 Hz; outside it `retune` and `open` are rejected
   with `channel-request-invalid` and the channel keeps its prior state.
5. 3.5 Hostile control input (oversize line > 64 KiB, unknown keys, non-finite numbers, wrong
   types) is rejected without a panic; existing protocol bounds still hold.

## Requirement 4: squelch

1. 4.1 The demod channel computes per block the channel power in dBFS before demodulation
   (|IQ| = 1 is 0 dBFS, floor −160) and, for NFM, the noise-quieting measure of
   `NoiseSquelch` (`src/core/noise-squelch.ts`), within 0.1 dB of the JS reference on the
   same channel IQ.
2. 4.2 The power gate opens when block power ≥ threshold, holds while within `hysteresisDb`
   (default 2) below it subject to the WG7 noise-tail rule (floor + hysteresis), and closes
   after `hangMs` (default 250) of stream time below; the noise gate uses `quietingDb`.
   Semantics equal `ChannelSquelch` for the same block metrics (golden-equal gate sequences).
3. 4.3 A closed gate outputs zeros for the block (sample count preserved). Gate changes are
   emitted as `gate {id, open, atOutputSample}` events.
4. 4.4 `squelch {id, mode: off|power|noise, thresholdDbfs?, hysteresisDb?, hangMs?,
quietingDb?}` changes take effect at the next block, without a retune or restart.
5. 4.5 Auto mode stays in TypeScript: the existing floor tracker consumes the per-block power
   the channel reports in a metrics record and sends `squelch` with the derived threshold.
6. 4.6 Squelch latency: from a step in carrier power to the gate change is at most 1 block
   (open) and `hangMs` + 1 block (close), pinned by goldens.
7. 4.7 Tone squelch, CTCSS and DCS detection stay in TypeScript on the audio, unchanged.

## Requirement 5: live wiring

1. 5.1 With the Rust engine, one `wavekit-chan` process per live demodulator is fed by its
   existing fanout branch (`live-demod-<sourceId>`) at the source rate; no shell and no csdr
   process is spawned.
2. 5.2 An `offsetHz`, `bandwidth` or `modulation` (nfm↔am) change maps to `retune`; HTTP
   clients stay connected and the transmission tracker sees a `config` close as today.
   `gain`, filters, de-emphasis and audioFormat map to `retune {audio}`.
3. 5.3 HTTP live audio uses the existing server; `X-Sample-Rate` is 48000 under the Rust engine.
4. 5.4 Shutdown sends `shutdown`, then kills the process group after 2 s; no process outlives
   `stop()`.
5. 5.5 Native stderr and event text never reach logs or HTTP bodies unfiltered
   (`safeErrorFields`).

## Requirement 6: performance

1. 6.1 CPU budget: one Rust demod channel at 2.048 Msps cu8 input uses at most 4 % of one
   core on the dev Mac (Apple Silicon, release build) and at most half the CPU of the csdr
   NFM chain measured on the same host and input. Measured by a bench, reported with load
   average; not a CI assertion.
2. 6.2 The Rust engine drains its fanout branch fast enough that a 10-minute synthetic run at
   2.048 Msps shows zero `backpressure` entries on the live-demod branch (harness counter).

## Requirement 7: tests

1. 7.1 Synthetic NFM (1 kHz tone, ±3 kHz deviation, CNR 20 dB): SINAD ≥ 20 dB; AM (1 kHz,
   m = 0.5, CNR 20 dB): SINAD ≥ 20 dB. Bounds at and past the limit are tested by CNR.
2. 7.2 Phase continuity: a continuous carrier retuned by 0 Hz offset change shows no output
   discontinuity above −60 dBFS; a real offset change shows no sample gap (3.3).
3. 7.3 Squelch latency goldens (4.6), gate sequence goldens equal to `ChannelSquelch`.
4. 7.4 A/B: on fixture IQ, Rust NFM audio vs the JS/csdr reference: normalised
   cross-correlation ≥ 0.98 after alignment; AM ≥ 0.95.
5. 7.5 CTCSS 67.0, 100.0 and 250.3 Hz and one DCS code survive the chain: the TS detectors
   identify them from Rust audio.
6. 7.6 Proptests (proptest, ≥ 100 cases): chunk invariance (2.4), finite output (2.6),
   sample-count conservation across retunes (3.3).
7. 7.7 Fallback paths of 1.3 and 1.4 each have a TS test with a fake process.

## Requirement 8: defaults

1. 8.1 Deliberate default changes: none. `engine` defaults to `csdr`; Main enables `rust`
   in the live config after the live A/B.

## Requirement 9: drop-mode diagnosis

1. 9.1 A harness with an in-process fake rtl_tcp (port 0) at 2.048 Msps cu8 measures, per
   consumer (csdr live demod, Rust live demod, dsd-fme chain, multimon-ng chain with each decoder
   binary replaced by a byte sink), drain rate, backpressure
   entries per hour and dropped bytes, plus the FanoutManager thresholds in force.
2. 9.2 The report states the slowest consumer with numbers and an exact proposal for the
   decoder branches (decimation in `wavekit-chan` before the decoder, channelizer routing or
   a threshold change), as a diff for Main where outside this lane's allocation.
