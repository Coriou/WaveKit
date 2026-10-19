# Rust live demodulator, phase A: design

## Overview

```
fanout branch live-demod-<src> (cu8, source rate)
  └─ wavekit-chan (one process per live demodulator, protocol 2)
       stdin cu8 → convert → Nco (phase-continuous retune) → RationalFir chain to 48 kHz cf32
         → channel filter (re-tappable, bandwidthHz) → block metrics (power, noise)
         → demod::Demodulator (kernel) → squelch gate → f32le|s16le → channel socket
  TS: src/core/live-demod/rust-engine.ts reads the socket → handleAudioData (existing HTTP,
      tone gate, transmission tracker) ; events (gate, metrics, retuned) on stdout JSON lines
```

The csdr path in `live-demodulator.ts` is unchanged. A new engine seam selects
`CsdrEngine` (today's code, moved behind an interface only where needed) or `RustEngine`.

## Contract (frozen)

The kernel is `native/wavekit-chan/src/demod/mod.rs`, re-exported as `wavekit_chan::demod`.
It is pure: no I/O, no allocation in `process` after construction (scratch sized by
`max_chunk`), no threads, no clock. The scanner replay trial calls it on 48 kHz cf32 iqcap
files after its own reading; live use is one consumer.

```rust
pub enum Modulation { Nfm, Am }

#[derive(Clone, Debug, PartialEq)]
pub struct DemodConfig {
    pub modulation: Modulation,
    pub sample_rate_hz: f64,      // complex input rate = audio output rate; 8_000..=192_000
    pub deviation_hz: f64,        // NFM: deviation giving 0.8 before gain; default 5_000
    pub gain: f32,                // 0.1..=100, default 2.0; semantics below
    pub de_emphasis_us: Option<u32>, // None | Some(50) | Some(75); NFM only
    pub low_pass_hz: Option<f64>, // audio low pass (from resolveLiveDemodFilters), < rate/2
    pub high_pass_hz: Option<f64>,// audio high pass, < low_pass
    pub max_chunk: usize,         // largest input slice process() accepts; 1..=1<<20
}

pub struct DemodStats { pub non_finite_inputs: u64 }

pub struct Demodulator { /* DSP state only */ }

impl Demodulator {
    pub fn new(config: DemodConfig) -> Result<Demodulator, DemodConfigError>;
    /// in: interleaved-free complex samples; out.len() must equal input.len().
    /// Output is mono f32, finite, within [-1, 1]. Chunk-invariant (bit-identical).
    pub fn process(&mut self, input: &[Complex32], out: &mut [f32]);
    pub fn reconfigure(&mut self, config: DemodConfig) -> Result<(), DemodConfigError>;
    pub fn reset(&mut self);
    pub fn stats(&self) -> DemodStats;
}

/// Block metrics, usable offline for squelch evidence.
pub fn block_power_dbfs(block: &[Complex32]) -> f32;        // floor -160
pub struct NoiseMeter { /* port of noise-squelch.ts */ }
impl NoiseMeter {
    pub fn new(sample_rate_hz: f64) -> NoiseMeter;
    pub fn block_quieting_db(&mut self, block: &[Complex32]) -> f32;
}
```

`Complex32` is the crate's existing complex type (`stages.rs`). `reconfigure` keeps filter
and discriminator state when only `gain` or filters change and resets the kernel when
`modulation` or `sample_rate_hz` changes. `DemodConfigError` is a plain enum with no
payload text. Gain semantics: NFM output = `limit(gain/2 · 0.8 · disc/deviation_norm)` so
the shipped `gain: 2` puts the configured deviation at 0.8 full scale, matching the csdr
chain comment in `config.ts`; AM output = `limit(gain/2 · agc(dcblock(|x|)))`.
Frozen means: names, argument types, rates and these semantics change only by a spec
revision; internals may change.

## Protocol 2 additions (`protocol.rs`, mirrored in `src/core/channelizer/protocol.ts`)

`--version` prints `wavekit-chan 0.2.0 protocol 2`. Protocol-1 requests and events are
unchanged; a `kind`-less `open` is a protocol-1 IQ channel.

```
open   {id, kind:"demod", centerHz, bandwidthHz, modulation:"nfm"|"am", format:"f32le"|"s16le",
        queueBytes, audio:{gain, deviationHz?, deEmphasisUs?, lowPassHz?, highPassHz?},
        squelch:{mode:"off"|"power"|"noise", thresholdDbfs?, hysteresisDb?, hangMs?, quietingDb?},
        metrics?: boolean}
retune {id, centerHz?, bandwidthHz?, modulation?, audio?}
squelch{id, mode, thresholdDbfs?, hysteresisDb?, hangMs?, quietingDb?}
events: opened{..., outputRateHz:48000, kind:"demod"} | retuned{id, atOutputSample}
        | gate{id, open, atOutputSample} | metrics{id, atOutputSample, powerDbfs[], quietingDb[]}
```

`metrics` batches up to 10 blocks (100 ms) per event; values are numbers rounded to 0.01 dB.
TS validates every event with Zod; unknown events are counted and dropped.

## Rust components

- `demod/mod.rs` kernel, `demod/nfm.rs`, `demod/am.rs`, `demod/filters.rs` (biquads: DC block,
  de-emphasis, audio HP/LP), `demod/agc.rs`, `demod/noise.rs` (`NoiseMeter`),
  `demod/squelch.rs` (`PowerGate`, `NoiseGate`, block state machine mirroring
  `ChannelSquelch.processBlock`).
- `demod_channel.rs`: owns `Nco`, the planned `RationalFir` chain to 48 kHz, a channel FIR
  re-designed by `design.rs` on bandwidth change (same tap count per transition so the delay
  line is kept; transition 0.25 · bandwidth), block accumulator, kernel, gate, output encode.
- `Nco::set_frequency` keeps the phase accumulator; retune applies at an input block boundary.
- `runtime.rs` dispatches `kind` and the new requests; DSP stays on the existing DSP thread.

## TypeScript components (`src/core/live-demod/`)

- `engine.ts`: `LiveDemodEngine` interface {start, applyRetune, applySquelch, stop, status}.
- `rust-engine.ts`: spawns `chanBinaryPath` (detached, own group), probes `--version`, sends
  `open`, pipes the fanout branch to stdin with an `error` handler, reads the socket into
  `handleAudioData`, mirrors `gate` into the existing squelch state/events, feeds `metrics`
  power to the auto floor tracker and sends `squelch` on threshold change.
- `rust-protocol.ts`: Zod schemas for the demod events (bounded: line ≤ 64 KiB, arrays ≤ 10).
- `select-engine.ts`: pure function mapping config + caps + probe result to
  `{engine, fallback?}` (Requirement 1.3), unit-tested exhaustively.
- `live-demodulator.ts`: engine selection at pipeline start; reconfigure routes offset,
  bandwidth, modulation and audio keys to `applyRetune` under Rust, keeping csdr behaviour.

## Correctness properties

1. Chunk invariance: any partition of the input gives bit-identical kernel output. (2.4)
2. Finite bounded output for any input incl. NaN/Inf: output finite and in [-1, 1]. (2.6)
3. Sample conservation: across any sequence of retunes and squelch changes, output samples
   = floor(input samples · 48 000 / input rate) ± 1 of the decimator phase; no gap. (3.2, 3.3)
4. Phase continuity: retune to the same frequency produces output identical to no retune. (3.2, 7.2)
5. Gate equivalence: for any block-metric sequence, the Rust gate sequence equals
   `ChannelSquelch` power/noise mode on the same metrics (shared golden vectors). (4.2)
6. Noise meter A/B: `NoiseMeter` within 0.1 dB of `NoiseSquelch` on shared vectors. (4.1)
7. Engine selection: `selectEngine` never returns `rust` when any 1.3 condition holds. (1.3)

## Testing

Rust: unit + proptest in `native/wavekit-chan/tests/demod_properties.rs`, golden vectors
generated by a TS script into `native/wavekit-chan/tests/fixtures/demod/` (small JSON,
committed), process tests in `tests/demod_process.rs`. SINAD via a notch at the test tone.
TS: `tests/unit/core/live-demod-rust-*.test.ts` with a fake process (no binary), and one
opt-in integration test that runs the release binary when present (skips otherwise) on an
ephemeral 127.0.0.1 fake rtl_tcp. CTCSS/DCS through the kernel by feeding binary output into
`src/core/audio-tones/` detectors. Goldens for the csdr default path are recorded at base.

## Performance

Budget arithmetic: 2.048 Msps cu8 → convert + NCO + 3-stage rational decimation ≈ 30 MAC/in
sample ≈ 61 M MAC/s plus kernel at 48 kHz (≈ 2 M ops/s) → ~1–3 % of an M-class core at
scalar f32. Budget 4 % (Requirement 6.1). Bench: `cargo bench`-free example
`examples/demod_bench.rs` and a TS harness comparing with the csdr chain where csdr exists
(Docker image; Main runs it if csdr is absent on the Mac).

## Drop-mode diagnosis

`scripts/bench/` is outside the allocation, so the harness lives in
`tests/unit/core/live-demod/drop-mode.bench.ts` (excluded from vitest collection by name,
run by `pnpm exec tsx`), driving FanoutManager with a fake rtl_tcp on port 0 and consumers:
the Rust engine, the csdr engine (when csdr is installed) and the dsd-fme / multimon-ng
pipelines' csdr fronts with a sink in place of the decoder. Output: per-branch drain rate,
backpressure entries/hour, dropped bytes. The fix proposal goes to the report.

## Defaults

No deliberate default change: `engine: "csdr"`.

## Docker

The image already installs `wavekit-chan`; no Dockerfile change unless a new bin is added
(none planned).

## Contract amendments (additive)

Recorded after implementation; no frozen name, argument type or semantic changed.

- `Complex32 { re, im }` is defined in `wavekit_chan::demod` (the crate had no complex
  sample type).
- `process` with `out.len() != input.len()` writes the shared prefix and never panics.
- Added: `NoiseMeter::with_bandwidth(sample_rate_hz, bandwidth_hz)` (the channel path;
  `new` keeps the full-band reference), `PowerGate` and `NoiseGate` with in-place setters
  for threshold, hysteresis, hang and quieting, and `PowerGate::set_noise_floor_dbfs`.
- AM fast AGC is a peak follower (reference 0.4, 5 ms attack, 300 ms decay); de-emphasis
  is one pole; audio high and low pass are biquads.

## Protocol amendments

- The JSON envelope `v` stays 1; protocol 2 is the `--version` line plus the demod
  vocabulary.
- `squelch` accepts `noiseFloorDbfs` (absent leaves the floor, `null` clears it, a number
  sets it); `open.squelch` does not.
- At most one pending retune and one pending squelch are kept; later requests fold into
  them. One `retuned` is emitted per applied plan, so the client sends identity retunes one
  at a time and folds edits made meanwhile into the next request.
- The channel FIR keeps a 313-sample history across retunes and runs the tap count of the
  current bandwidth (at least 89), centred so the group delay stays 156 samples.
