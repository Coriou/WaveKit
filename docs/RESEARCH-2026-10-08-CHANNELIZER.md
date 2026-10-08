# Research note: a shared channelizer instead of per-decoder csdr pipelines

Exploratory evidence: read [the subsequent technical review](REVIEW-2026-10-08-CHANNELIZER.md)
before implementing these proposals. It corrects assumptions about rates,
bandwidth, fixtures and the current CSDR baseline.

Date: 2026-10-08. Status: research only, nothing implemented. Written so a
future agent can decide whether to build this and start from measured facts
rather than from the original hunch.

## 1. Why this came up

The question was whether rewriting WaveKit in Rust would improve performance.
Measurements (section 3) showed the TypeScript orchestrator is not the cost:
at 2.4 Msps it spends about 7% of one core fanning IQ into eight OS pipes. The
cost is in the per-decoder `csdr` shell pipelines, which are already C++. Each
IQ-consuming decoder re-runs `csdr convert | csdr firdecimate` on its own
private copy of the full-rate stream, through five to seven processes joined
by pipes. The idea examined here: run that front end **once per source**, in
one process, and hand each decoder a narrowband stream at the rate it wants.

## 2. What the code does today (facts a design must respect)

- **No frequency shifting exists anywhere.** `grep -ri shift src` finds only
  array `.shift()`. Every stdin decoder (`AudioDemodDecoder`,
  `IqDecimateDecoder`) demodulates the **centre** of the capture. The only
  tuning knob is the source centre frequency via `TunerController`
  (`src/core/tuner-controller.ts`), one per source. Two decoders on one
  dongle therefore decode the same channel. Multi-protocol on one dongle
  (POCSAG at 466 MHz plus DMR a few hundred kHz away) is impossible today,
  even though the 2.4 MHz capture contains both.
- **Six of nine builtin decoders take the full-rate stream.**
  `AudioDemodDecoder`: dsd-fme, multimon-ng, direwolf, acarsdec.
  `IqDecimateDecoder`: rtl_433, AIS-catcher, dumpvdl2, lora-meshtastic.
  readsb is a network producer that needs the raw 2.4 Msps stream (or sox
  paired-IQ resampling to 2.4 M, see `iqResampleCommand` in
  `src/decoders/process-tools.ts`) and is out of scope for a channelizer.
- **Per-decoder rate requirements** (from `getDemodConfig()` /
  `getIqDecimationConfig()`):

  | Decoder | Wants from the front end | Then |
  |---|---|---|
  | dsd-fme | 12.5 kHz NFM, demod at 48 k, IQ AGC | fmdemod, gain 2, limit, s16, sox WAV wrap |
  | multimon-ng | 12.5 kHz NFM, demod at 48 k, IQ AGC, transition 0.012 | fmdemod, gain 3, limit, s16, sox to 22050 |
  | direwolf | 12.5 kHz NFM, 48 k, transition 0.012 | fmdemod, gain 3, limit, s16 |
  | acarsdec | 25 kHz AM, demod at 24 k | amdemod, agc, dcblock, s16, sox to 12 k |
  | rtl_433 | IQ at 250 k (integer decimation) | cu8 to rtl_433 stdin |
  | AIS-catcher | IQ at exactly 384 k | cu8 (sox exact-rate path) |
  | dumpvdl2 | IQ at exactly 1.05 M (N x 105 kHz) | cu8 |
  | lora-meshtastic | IQ at exactly bw x oversampling | cu8 to python wrapper |

  Note the mix of integer-decimation and exact-rate consumers. The exact-rate
  ones currently go through `sox rate -h` on paired u8 channels because
  `csdr firdecimate` only takes integer factors.
- **Sources run at two rates.** The Pi sdr-host defaults to 2.048 Msps
  (`packages/sdr-host/src/config.ts`), core defaults assume 2.4 Msps. Any
  front end must handle both, and sample-rate changes at runtime
  (`caps-changed` events already restart pipelines).
- **Process model.** Each decoder owns a detached POSIX process group
  (`signalDecoder`), the shell pipeline string is built by
  `buildPipelineCommand()` and quoted by `shellCommand()`. Tests in
  `tests/unit/decoders/*.test.ts` assert on the generated pipeline strings, so
  a change of front end touches those assertions.
- **The network is the real bottleneck on the Pi.** `docs/HANDOFF-2026-10-08.md`
  line 389: over Wi-Fi the Pi 3 generated 3.93 MiB/s, delivered 0.685 MiB/s
  and dropped 3.25 MiB/s (about 83% loss). Section 2 of `docs/ROADMAP.md`
  already lists "evaluate on-Pi processing, decimation and transport
  alternatives". A channelizer placed on the Pi cuts the link load from
  4 MB/s to a few hundred kB/s and is therefore not only a CPU optimisation.

## 3. Measurements (this machine: i5-1038NG7, Node 25.2, Docker Desktop)

Benchmark scripts lived in the session scratchpad and are reproducible from
the description; the fanout one bundled the real `FanoutManager` with esbuild
(`--packages=external`) and paced writes with a 20 ms timer.

**Node fanout, realtime-paced 2.4 Msps U8 IQ (4.8 MB/s) into `cat` pipes**

| Branches | Node CPU, share of one core |
|---|---|
| 0 | 1.8% |
| 1 | 3.6% |
| 8 | 6.9% |
| 16 | 10.2% |

Float-to-S16 at 48 kHz audio: 0.35%. Node is not the problem.

**csdr inside `wavekit:local-core`, 20 s of 2.4 Msps random IQ, `time`**

| Pipeline | user | sys | share of a core at realtime |
|---|---|---|---|
| AudioDemod chain (convert, firdecimate 50, fmdemod, dcblock, gain, limit, convert s16), 7 procs | 2.8 s | 10.1 s | ~65% |
| IqDecimate chain (convert, firdecimate 10, convert char), 3 procs | 1.3 s | 3.9 s | ~26% |
| `csdr convert -i char -o float` alone | 0.25 s | 0.37 s | 3% |
| `csdr firdecimate 50 0.05` alone, file in/out | 0.33 s | 5.1 s | user 1.6% |
| `csdr shift 0.1` alone | 0.68 s | 1.5 s | user 3.4% |
| `csdr shift 0.1 \| csdr firdecimate 50` | 1.9 s | 9.0 s | user 10% |
| `csdr fft 32768 32768` (one forward FFT per block, no overlap) | 0.08 s | 0.5 s | user 0.4% |
| fmdemod..s16 on the already-decimated 48 k stream | 0.30 s | 0.29 s | 3% |

Caveats. The sys column is inflated by Docker Desktop's Linux VM (plain
`cat` of a 384 MB file costs 4 s sys there; `dd bs=1M` 0.95 s), so absolute
sys numbers are not portable. The user column is portable and is the actual
DSP compute. On native Linux the pipe overhead is lower but still scales with
process count times bytes moved; on a Pi 3 everything is roughly an order of
magnitude slower per core.

Conclusions that hold regardless of the VM caveat:

1. The DSP arithmetic for one channel (shift plus decimate) is a few percent
   of a core. Seven processes and 384 MB/20 s of float IQ through pipes is
   what makes a decoder cost 25 to 65% of a core.
2. N decoders cost N times that, plus N kernel copies of the 4.8 MB/s stream.
3. One forward FFT per block over the whole 2.4 MHz is cheaper than one
   `csdr shift`, which is why fast-convolution channelizers scale to hundreds
   of channels.

## 4. Options surveyed

### 4a. Per-channel DDC in-process (shift + FIR decimate per decoder)

Simple, matches the current filters exactly (same `firdecimate` transition
and cutoff semantics), and `libcsdr` already contains every needed block as
a C++ class: `shift.hpp`, `firdecimate.hpp`, `fractionaldecimator.hpp`,
`fmdemod.hpp`, `amdemod.hpp`, `agc.hpp`, `dcblock.hpp`, `gain.hpp`,
`limit.hpp`, `deemphasis.hpp`, `converter.hpp`, `audioresampler.hpp`
(libsamplerate) and the composition kit `module.hpp`, `ringbuffer.hpp`,
`reader.hpp`, `writer.hpp`, `source.hpp`, `sink.hpp`. jketterl/csdr is a
C++ rewrite of ha7ilm's csdr; OpenWebRX composes these in-process through
pycsdr with one thread per module and ring buffers, no pipes. Cost is linear
in channels (about 6% user per channel at 2.4 Msps on this i5, cheaper once
the input is converted to float once), fine for the eight-ish channels
WaveKit cares about. Licence: the repo is GPL-3.0 (README says mostly BSD with
optional GPL parts); WaveKit is ISC. Linking libcsdr into a shipped binary
needs a licence check before committing to it.

### 4b. Fast-convolution (overlap-save) channelizer

One forward FFT per block over the full band, then per channel: pick the
bins, multiply by the channel's frequency response, small inverse FFT. This
is ka9q-radio's design (Phil Karn, GPL-3.0, Linux daemons with multicast
output, credits Mark Borgerding's overlap-save filter bank paper). Its README
claims a Raspberry Pi 4 demodulates every NBFM channel on a VHF/UHF band in
real time, several hundred channels. The relevant property for WaveKit: cost
is almost flat in channel count, and each channel can have its own rate and
filter. Constraints: a channel's impulse response must be shorter than the
overlap; the output rate must be `fs x M / N` for integer M bins, so N must
be chosen so every wanted rate is an integer number of bins:

- fs = 2.4 M: N must be a multiple of 400 (covers 24 k, 48 k, 384 k, 1.05 M).
  N = 32000 gives 75 Hz bins and 13 ms blocks. FFTW handles 2^8 x 5^3 fine.
- fs = 2.048 M: N must be a multiple of 1024 (2 kHz bins at N = 1024; use
  N = 16384 or 32768 for sharper filters).
- 22050 and 12000 are not integer bins at either rate; keep the existing
  small sox audio-rate resample for multimon-ng and acarsdec, or resample in
  process with libsamplerate. Those run at audio rate and cost nothing.

ka9q-radio itself is a daemon suite, not a library, with its own device
drivers and multicast transport. Reusing it wholesale would replace rtl_tcp
and rtlmux on the Pi and change the transport contract; reusing the design in
a few hundred lines is realistic.

### 4c. Polyphase filter bank (PFB)

FutureSDR ships `PfbChannelizer` on top of `futuredsp` (which has
`DecimatingFirFilter`, `PolyphaseResamplingFir`, `firdes`). A PFB gives
equally spaced channels of equal width, which does not match WaveKit's
heterogeneous requests (12.5 kHz NFM next to a 1.05 MHz VDL2 slice). Not a
fit on its own; the arbitrary resampler in futuredsp is useful for 4a.

### 4d. Where to put it: process vs addon, core vs Pi

| Placement | Pros | Cons |
|---|---|---|
| Standalone process on the core, stdin IQ in, one Unix socket or pipe per channel out | Language free (C++ with libcsdr, or Rust), isolated crash domain, same supervision as decoders, testable from the shell with fixtures | Still one pipe copy per channel (cheap at 100 to 400 kB/s per channel) |
| napi-rs addon in the Node process | Zero copies into Node; could expose spectrum data to the API directly | Native build matrix (amd64/arm64 glibc, `--use-napi-cross` or zig), a crash takes the orchestrator down, Node 25 ABI churn |
| Standalone process on the Pi (sdr-host), alongside rtlmux | Attacks the measured Wi-Fi bottleneck; Pi 3 stays within budget if fast convolution is used | New host API surface (channel requests, rates, frequencies) and a second transport; raw full-rate stream must remain available for readsb and TunerRelay/SDR++ clients |

Recommendation for a first implementation: **standalone process, run on
the core first**, because it needs no change to the Pi image, can be driven
by the existing `BaseDecoder` plumbing, and the same binary can later be
scheduled on the Pi behind sdr-host. An addon is not worth its build cost
for the data rates involved.

## 5. Proposed shape (for a future design spec, not a plan)

- **Channelizer process** `wavekit-chan` (C++ with libcsdr or Rust with
  rustfft and a small overlap-save implementation). Input: U8 or S16 IQ at
  `fs` on stdin or a TCP/Unix socket; control: a tiny JSON line protocol or
  CLI flags per channel `{id, offsetHz, bandwidthHz, outputRate, format:
  cu8|cf32|s16-audio, demod: none|fm|am}`. Output: one Unix socket or named
  pipe per channel. Emits per-channel power so the API can show activity
  (feeds roadmap section 5, scanning).
- **Orchestrator changes.** A new base, say `ChannelDecoder`, replacing the
  csdr prefix of `AudioDemodDecoder` and `IqDecimateDecoder`:
  `getChannelRequest()` returns the rows above; the decoder is spawned with
  stdin connected to the channel socket instead of a fanout branch. The rest
  of each pipeline (fmdemod, gain, limit, sox) can stay as a much shorter
  csdr tail in phase 1 and move in-process in phase 2. `DemodulationConfig`
  and `IqDecimationConfig` gain an `offsetHz` (relative to source centre)
  and decoders gain a `frequency` option that the manager resolves against
  the source centre frequency, rejecting channels outside `fs/2`.
- **Fanout stays** for readsb, TunerRelay, LiveDemodulator and recordings.
  The channelizer is one more fanout branch per source, not a replacement.
- **Rate handling.** Exact-rate consumers (AIS 384 k, VDL2 1.05 M, LoRa)
  come out of the channelizer at their exact rate, removing the sox
  paired-IQ resample and its roadmap item about chunk-boundary independence.
- **Pi later.** Same binary behind sdr-host with a channel-request API;
  core selects "channels from host" vs "raw IQ" per source based on link
  budget. Measure Pi 3 cost first; expect fast convolution to be mandatory
  there and per-channel DDC to be too expensive beyond two channels.

## 6. Validation plan

- Golden decode tests with the existing fixtures (`fixtures/manifest.yaml`,
  `fixtures/test-decoders.sh`, `scripts/demod-test.sh`): run the current
  csdr chain and the channelizer on the same recording, require the same
  message count or better for POCSAG, rtl_433, ACARS, AIS, VDL2.
- Property tests (fast-check, 100 runs) on the resampling arithmetic: for
  every supported `fs` and requested rate, `N` selection yields integer bins
  and the realised rate equals the requested one; chunk-boundary
  independence (split input arbitrarily, concatenated output identical).
- Unit tests for pipeline strings in `tests/unit/decoders/` will change for
  every migrated decoder; keep the old base classes until all fixtures pass.
- CPU: repeat the section 3 table with the channelizer replacing the
  prefixes, on native Linux as well as Docker Desktop, with 1, 4 and 8
  channels. Then on the Pi 3 with the sdr-host image.

## 7. Risks and open questions

- Licence: libcsdr/GPL-3.0 versus WaveKit ISC. A separate process at arm's
  length is the usual answer; linking into the Node process is not.
- Filter equivalence: dsd-fme and multimon-ng were tuned empirically
  (transition 0.012, specific gains, IQ AGC before decimation). The
  channelizer must reproduce the IQ AGC stage per channel or the decode
  rates will regress on weak signals.
- readsb passive mode and TunerRelay still need the raw stream, so the Pi
  link cannot drop to channel-only unless those features are disabled or
  relocated.
- Runtime retune: a channel request outside the current capture needs a
  source retune and today's serialised restart logic; multi-channel makes
  "who owns the tuner" (roadmap section 5) more pressing, not less.
- Rust versus C++: Rust avoids the GPL question (rustfft is MIT/Apache) and
  cross-compiles cleanly to arm64 with no runtime dependencies; C++ with
  libcsdr reuses proven filters. Either is a few hundred lines for 4a and
  under a thousand for 4b.

## 8. Decision summary

Not a rewrite. Do not touch the orchestrator's language. If the Pi link and
multi-protocol-per-dongle matter, build one channelizer process using fast
convolution, first on the core, then on the Pi. If neither matters, the
cheapest win is still large: a single in-process `convert | shift |
firdecimate` per channel in one process removes most of the measured cost.

## References

- jketterl/csdr headers (module, ringbuffer, shift, firdecimate, fmdemod,
  fftfilter): https://github.com/jketterl/csdr/tree/develop/include
- pycsdr, in-process composition used by OpenWebRX:
  https://github.com/jketterl/pycsdr
- ka9q-radio, overlap-save multichannel receiver:
  https://github.com/ka9q/ka9q-radio
- Borgerding, "Turning overlap-save into a multiband mixing, downsampling
  filter bank": https://ieeexplore.ieee.org/document/1598092
- FutureSDR blocks (PfbChannelizer, futuredsp FIR/resampler):
  https://docs.rs/crate/futuresdr/0.7.0/source/src/blocks/mod.rs
- napi-rs cross compilation (arm64 via `--use-napi-cross` or zig):
  https://napi.rs/docs/cross-build
- Pi Wi-Fi delivery measurement: `docs/HANDOFF-2026-10-08.md` line 389.
