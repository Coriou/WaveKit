# Evidence squelch design

Status: design, not implemented (2026-10-23). Requirements in [requirements](requirements.md).
Background: the live demodulator (`src/core/live-demodulator.ts`, its `handleAudioData` and
`measureRun`), stage 1 (`src/core/channel-squelch.ts`, `src/core/noise-squelch.ts`, the Rust
power gate behind `src/core/live-demod/rust-run.ts`), the WG7 tone squelch gate
(`src/core/audio-tones/tone-squelch.ts`) and its detectors (`src/core/audio-tones/ctcss.ts`,
`src/core/audio-tones/dcs.ts`, `PcmDecimator` in `src/core/audio-tones/tone-detector.ts`), the
analog trial judge (`src/core/scanner/analog-trial.ts`,
`src/core/scanner/scanner-redesign-contract.ts`), the frame statistics of
`native/wavekit-chan/src/iqcap/analyze.rs`, the client registry
(`src/core/audio-stream-server.ts`) and the [performance rules](../../PERFORMANCE.md).

## Overview

```
IQ ─> front ─> stage 1 (ChannelSquelch | Rust power gate) ─> back (demod) ─> PCM chunk
                 │  10 ms blocks: power, carrier evidence                     │
                 │                                                            ├─> "pcm" event (unchanged:
                 v                                                            │    transmissions, tones,
          measureRun ── noteBlock(carrier) ──────────────┐                    │    recordings)
                 │                                       v                    v
          squelch-changed (stage 1) ─────────────> EvidenceGate <── push(PCM while stage 1 open)
          transmissions, Activity (unchanged)       │ 8 kHz: VoiceFrameMeter, ToneEvidence,
                                                    │ latch and hang state machine
                                                    │ latched at sample k / abandoned
                                                    v
                                   PreRoll (tagged FIFO, one output byte per input byte)
                                                    │ chunk rewritten in place
                                                    v
                                   client registry ─> HTTP raw PCM and WAV (nominal rate)
```

Three ideas carry the design:

1. **Gate what listeners hear, not what the core sees.** Stage 1 stays the carrier detector that
   every other consumer relies on. Stage 2 is a second, stricter opinion applied only to the
   bytes written to the client registry, exactly where the WG7 tone gate already mutes.
2. **Judge with the scanner's rules.** Voice, data-like and tone qualification reuse the pinned
   analog trial thresholds and judge functions, fed by an audio-rate meter whose statistics
   match `analyze.rs`.
3. **Delay instead of clip.** A gate that needs about a second of evidence would cut the first
   second of every over. Holding that second and replaying it costs a bounded, constant delay
   inside the over, paid back from the silence after it.

**Amendment (2026-10-23, A12): csdr engine only.** The diagram's stage 2 and pre-roll run on
csdr runs only (the default engine). A Rust run builds no gate or pre-roll, and `auto` on Rust is
the stage-1 auto squelch, byte-identical, with `autoSquelch` `off`, as AM under A8. Rust sends
stage-1 gate events on stdout and audio on a separate socket, and aligning the two in TypeScript
has races that cannot be closed there: close events that arrive early or late against the audio,
native audio drops that shift the events' `atOutputSample` indices, and input-gap resets that
produce no gate event. The follow-up is in-band stage-1 gate markers on the Rust audio socket
(see the Rust-engine onset finding).

## Options weighed

### A. Where evidence is measured

- **Rust, in the demod channel.** Statistics at IQ rate, exactly as `analyze.rs`. Only covers the
  Rust engine; csdr (the default) would need a second path. Rejected: both engines must behave
  the same, and rust-demod-a keeps auto logic in TypeScript.
- **TypeScript on PCM at 8 kHz (chosen).** One implementation for both engines, the same
  decimation the tone gate uses, per-sample work at audio rate only (rule 1). Cost: the statistics
  are measured after the back chain's filters, so equivalence with `analyze.rs` is a tested
  tolerance, not identity (section Meter equivalence).

### B. Onset handling

- **Clip:** open late, lose the first 0.75 to 1 s of each over. Rejected by the user decision.
- **Optimistic open:** pass audio at stage 1 and mute when evidence fails. Lets every burst
  through for a second, which is the defect being fixed.
- **Pre-roll (chosen):** buffer, then play from the onset; bounded delay, catch-up from silence.

### C. Tone evidence source

- **Tap the transmission tracker's `ToneDetector`.** Would couple listening to tone results.
  Rejected (events and tone results must stay byte-identical).
- **Own `CtcssBank` and `DcsDecoder` behind one `PcmDecimator` (chosen),** as the tone squelch
  gate does, run only while stage 1 is open.

## Components

### Contract (`src/core/evidence-squelch/contract.ts`, constants in `packages/api-types`)

Constants added to `packages/api-types/src/live-audio.ts` (requirement 4.3):

| Constant                                      | Value     | Basis                                                         |
| --------------------------------------------- | --------- | ------------------------------------------------------------- |
| `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS`         | `["nfm"]` | requirement 1.1 (amendment A8, 2026-10-23: AM removed)        |
| `LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS`    | `["nfm"]` | requirement 1.2 (AM: voice only)                              |
| `LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS`            | 50        | `ANALOG_TRIAL_FRAME_MS`                                       |
| `LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES`        | 20        | `SYLLABIC_WINDOW` in `analyze.rs`: 1 s                        |
| `LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS` | 100       | 10 ms IQ blocks in the 1 s voice window                       |
| `LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS`         | 750       | `DCS_MIN_AUDIO_SECONDS` × 1 000                               |
| `LIVE_AUDIO_AUTO_SQUELCH_HANG_MS`             | 1 500     | `ANALOG_TRANSMISSION_MERGE_GAP_MS`                            |
| `LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS`      | 1 500     | voice window 1 000 ms + up to 500 ms late speech after key-up |
| `LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS`      | 200       | back-chain drain after stage 1 closes (measured in 8.2)       |

Type: `LiveAudioAutoSquelch = { state: "off" | "waiting" | "open"; evidence?: "voice" | "ctcss" | "dcs" }`,
added as optional `autoSquelch` to `LiveAudioStatus` and `LiveAudioLevel`. The core contract
file holds the port interfaces below so the wiring lane can build against fakes.

### VoiceFrameMeter (`src/core/evidence-squelch/voice-meter.ts`)

Consumes mono samples at 8 kHz (already decimated, scaled to the analyzer's deviation scale) and
emits one frame every 400 samples (50 ms) with `audioDb`, `syllabic` and `cluster`, computed as the
textbook algorithms `analyze.rs` documents (no line-by-line port):

- **audioDb:** mean square of the 300 Hz high-pass then 3 kHz low-pass biquads (RBJ cookbook at
  8 kHz), over the frame, in dB relative to `FULL_DEVIATION_MEAN_SQUARE` (0.32, a full-deviation
  sine at gain 2); -160 for zero power.
- **syllabic:** the frame's band power pushed into a 20-entry envelope ring; one-pole 2 Hz
  high-pass over the ring started at rest, RMS of the output over the ring mean, clamped to
  0..160; 0 for fewer than two entries or a silent mean.
- **cluster:** the analyzer's histogram k-means score (256 bins, 6 iterations, k = 2 and k = 4,
  15 % acceptance band, minimum centroid span 0.15 in discriminator units) on two views of the
  frame: the 2.4 kHz low-passed audio (the analyzer's `disc_lo`) and the audio as received, which
  stands in for `disc_hi` (4.8 kHz cannot exist at 8 kHz; the back chain already limits the audio
  to about 3.4 kHz). The score is the larger of the two. Samples are converted to discriminator
  radians at the analyzer's 48 kHz scale before the span test:
  `rad = pcm × (2π × 5 000 / 48 000) / 0.8 / (gain / 2)`.

Scaling: the analyzer demodulates with gain 2, no de-emphasis and a 3.4 kHz low-pass, the live
default chain. The meter divides by `gain / 2` (requirement 5.2), so non-default gains measure the
same deviation. With AGC or de-emphasis on, audio power and the span test are not on the
analyzer's scale; verdicts are recorded, not gated (5.2). AM uses the same reference, after the AM
chain's AGC (requirement 8.4 covers the risk that fast AGC flattens the syllabic index).

All state (biquads, envelope ring `Float64Array(20)`, two `Float32Array(400)` frame views,
`Uint32Array(256)` histogram, centroid scratch) is allocated in the constructor. `reset()` returns
to the constructed state. A non-finite input resets the frame and marks it non-finite, which the
judge fails closed.

**Amendment (2026-10-24, A13): deviation normalisation.** `VoiceFrameMeter` takes an optional
`deviationHz` (default 5 000) and multiplies samples by `(2 / gain) × (5 000 / deviationHz)`, so
the channel's own full deviation lands on the analyzer's reference. The wiring passes
`evidenceDeviationHz(config.bandwidth)` (`contract.ts`: 2 500 Hz for a bandwidth of at most
12 500 Hz, else 5 000 Hz) on `nfm`, and rebuilds the gate when the bandwidth changes in place (as
for modulation and gain). Physics: FM audio amplitude is set by deviation only (the RF level is
removed by the discriminator's normalisation), and the 12.5 kHz plan halves the peak deviation,
so the same speech reads 6.02 dB lower than on the 25 kHz plan the thresholds were set on.
Measured on the live PMR446 overs (12.5 kHz, about +1 dBFS channel power, ungated run, 1 s windows
every 0.5 s):

| Segment             | median audioDb (5 kHz ref) | syllabic    | cluster     | FM quieting per block   | latch from onset, 5 kHz / 2.5 kHz |
| ------------------- | -------------------------- | ----------- | ----------- | ----------------------- | --------------------------------- |
| over 1 (normal)     | -32.9 to -29.6             | 0.28 - 0.62 | 0.00        | 38.9 - 52.6 dB (p5-p95) | 2.6 s / 1.5 s                     |
| over 2 (normal)     | -25.2 to -20.8             | 0.37 - 0.76 | 0.00        | 43.8 - 53.9 dB          | 1.0 s / 1.0 s                     |
| noise between overs | -4.2 to -3.7               | 0.06 - 0.09 | 0.29 - 0.31 | -2.0 - 0.5 dB           | never / never                     |

Rejected alternatives: an `audioDb` offset alone (+6.02 dB, cluster untouched) opens the
synthetic impulse train of the end-to-end suite (median audio -36.4 dB at 5 kHz, syllabic 0.34,
cluster 0 because its decimated span is under 0.15 rad): the scale must apply to the span test
too, where the narrow plan makes the impulses data-like (cluster 1.00). Lowering
`ANALOG_TRIAL_AUDIO_MIN_DB` would retune the scanner's pinned judge for every channel. Kurtosis
does not separate the synthetic voice (window medians 21-26) from impulses (36-59).

### ToneEvidence (`src/core/evidence-squelch/tone-evidence.ts`)

Owns one `CtcssBank` and one `DcsDecoder` fed by the gate's 8 kHz samples (NFM only).

- **CTCSS:** after each completed 500 ms block, `lastBlockToneIndex()`; two consecutive blocks
  with the same standard index qualify that tone (first possible at 750 ms, the WG7 count).
- **DCS:** after each bit, `wordReading()` and `wordHits()`; a reading whose code is one of
  `DCS_STANDARD_CODES` (either polarity; a lookup table of packed readings built once) with at
  least `LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT` hits qualifies.
- A qualification counts as evidence only after `LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS` of audio
  since stage 1 opened (the analog trial's `toneQualified` rule).
- Exposes `current(): { kind: "ctcss"; index } | { kind: "dcs"; packed } | null`, allocation
  free (numbers in fields; the object is a reused record).

### Judge reuse (`src/core/scanner/analog-trial.ts`, exports only)

`isVoice` is already exported. `toneQualified` and a `dataLike(stats)` helper (the median cluster
test inside `classifyAnalogTrial`) are exported without behaviour change. The gate calls them
with a reused `AnalogTrialStats` whose `frames` array of 20 reused frame records is refreshed in
place from the meter ring; `carrierDb` and `hfNoiseDb` are not used by these functions (quieting
is the gate's own count, below). The judge allocates small arrays for its medians; it runs at
most 20 times per second and only while stage 1 is open and the gate is waiting (at most 30 calls
per over), which is outside steady-state streaming. A property pins agreement with
`classifyAnalogTrial` (Property 2). Because the gate equals the judge, syllable-timed FSK bursts
that the judge calls voice also latch the gate (requirements, known limitation after 1.4).

### EvidenceGate (`src/core/evidence-squelch/evidence-gate.ts`)

Per run, built for an NFM or AM stream (rate and format known; wired for NFM only, amendment A8). Interface:

```ts
interface EvidenceGatePort {
	readonly state: "waiting" | "open"
	readonly evidence: "voice" | "ctcss" | "dcs" | null
	/** One 10 ms IQ block while stage 1 is open: carrier evidence of that block. Returns
	 *  `EVIDENCE_NOTE_*` bit flags (amendment 2026-10-23, revised: was `void`): RESET (1) when
	 *  the block reset the voice window on a carrier onset while waiting, plus DISCARD (2)
	 *  when the unquieted run before it was ≥ 5 blocks; on DISCARD the owner abandons the
	 *  pre-roll. */
	noteBlock(carrier: boolean): number
	/** PCM bytes [start, end) received while stage 1 is open. Returns the byte offset in
	 *  [start, end] of the first sample after the gate latched in this call, or -1. */
	push(
		pcm: Buffer,
		format: "s16le" | "f32le",
		start: number,
		end: number,
	): number
	/** PCM bytes received while stage 1 is closed: advance the hang and the close guard, keep
	 *  sample framing. Returns the count of leading bytes inside the close guard (0 unless
	 *  latched). Amendment: originally returned `void`; the guard bytes keep the guard clock
	 *  inside the gate and the guard/drop boundary exact for any chunk split. */
	closed(byteCount: number, format: "s16le" | "f32le"): number
	/** Stage 1 closed with no latch, a retune, a mode change: drop all evidence and the latch. */
	reset(): void
}
```

State machine (stream time counted in PCM samples, so chunking does not matter):

| State   | Event                                                       | Next                                   |
| ------- | ----------------------------------------------------------- | -------------------------------------- |
| idle    | PCM while stage 1 open                                      | waiting (audio clock starts at 0)      |
| waiting | tone qualified and audio ≥ 750 ms (NFM)                     | open (`ctcss` or `dcs`)                |
| waiting | voice judgement passes on a new frame (window full)         | open (`voice`)                         |
| waiting | stage 1 closes                                              | idle (evidence discarded)              |
| open    | PCM while stage 1 open; a different standard tone qualifies | open (evidence renewed)                |
| open    | stage 1 closed for `HANG_MS` of PCM                         | idle                                   |
| open    | stage 1 reopens within the hang                             | open (latch carried; tone stage reset) |

Voice judgement on a new frame: not `dataLike` over the 20 frames; quiet count ≥
`ANALOG_TRIAL_MIN_QUIET_FRACTION` × blocks noted in the last `QUIET_WINDOW_BLOCKS` (a
`Uint8Array(100)` ring); `isVoice` true. Order follows `classifyAnalogTrial`: tone, then
data-like, then quieting with voice. Carrier evidence per block: on NFM the owner passes the WG10
carrier evidence (csdr `blockQuieted()` of the auto observer; Rust `metricsQuieted`); on AM it
passes `powerDbfs ≥ noiseFloorDbfs + ANALOG_TRIAL_AM_CARRIER_DB` (false while no floor exists).

**Amendment 2026-10-23 (revised after review): voice window reset on carrier onset.** Stage 1
can open on unquieted noise before an over (its power gate, or its 250 ms hang), so the gate's
first voice window could judge that noise with the key-up. The gate tracks the noted blocks with
scalar state (no allocation), from stage-1 open and also before the first PCM:

- **Armed** at the start of every episode (stage-1 open or `reset()`, including the reset after
  the hang inside `closed()`), and again after an unquieted run of at least
  `EVIDENCE_ONSET_ARM_UNQUIETED_BLOCKS` = 5 blocks (50 ms, one frame).
- While armed and waiting, every quieted block that follows an unquieted block resets the voice
  meter, the 20-frame window and the quiet ring (`noteBlock` returns RESET). Resets happen on
  every such onset, not once per episode, so a quieted flicker inside the lead-in cannot
  consume the reset.
- Analysis reset and playback discard are separate (review, 2026-10-23): the held audio is
  discarded (DISCARD, the wiring calls `preRoll.abandon()`) only when the unquieted run before
  the onset was at least 5 blocks, a real noise lead-in. An early 10-40 ms fade inside the over
  resets the analysis window but keeps the held speech, so playback still starts at the over's
  first sample (nfm-voice with blocks 0-3 quieted, 4 unquieted: window reset at 50 ms, latch
  1.05 s, first played sample = over sample 0). Consequence: a noise lead-in shorter than 5
  blocks (10-40 ms) is not discarded and plays before the over.
- **Disarmed** after `EVIDENCE_ONSET_DISARM_QUIETED_BLOCKS` = 5 consecutive quieted blocks
  (50 ms). Afterwards fades of 1-4 blocks (10-40 ms) inside the over neither arm nor reset; the
  quiet-fraction rule judges them as before.

Judge thresholds are unchanged; only which frames are judged changes. The tone stage,
decimator and audio clock are kept (tone evidence needs no window, and resetting it would delay
CTCSS/DCS by the lead-in; the 750 ms tone minimum then counts from stage-1 open, so DCS 023N
after a 500 ms lead-in latched 0.34 s after the onset instead of 0.75 s). Arithmetic: the reset
falls on the over's first block, the window is full at onset + 1.0 s (20 × 50 ms), and the
pre-roll then holds 1.0 s of the over, inside its 1.5 s capacity; when the block is measured
after its PCM (as in the e2e harness) the first 10 ms block is dropped with the lead-in, inside
the 20 ms onset tolerance.

Limits (tested, pending decision):

- A fade of 50 ms or more (5 blocks) while waiting arms and resets the window: 50 ms fades every
  500 ms never latch (40 ms fades every 500 ms latch). Weak fluttery voice with 10-30 ms
  dropouts at least 50 ms apart latches within 1.5 s; dropouts closer than 50 ms keep the reset
  armed at the start of the over and delay the latch until a 50 ms dropout-free stretch.
- A quieted run of 50 ms or more inside the noise disarms; if fewer than 5 noise blocks then
  precede the over, they are judged with it (indistinguishable from a fade). With 20 noise, 5
  quieted and 1-4 noise blocks before the over, `nfm-dmr-4fsk-continuous` (1-4) and
  `nfm-clicks` (1) latch voice; every other never-open NFM fixture stays closed.
- A quieted flicker on the noise right before the over (no unquieted block between it and the
  over) is judged as the over's start: with 250 ms of noise whose last 1-4 blocks are flagged
  quieted, `nfm-dmr-4fsk-continuous` (2-4 blocks) and `nfm-clicks` (1) latch voice. Flickers
  followed by at least one unquieted block never open any never-open NFM fixture (property).
- Independent of the reset: `nfm-clicks` latches voice when only 10 or 60 ms of quiet carrier
  (silence, no noise) precede it; the 50 ms frame edges move and the first window is judged
  voice. The continuous-4FSK and clicks goldens are close to the voice judge; small changes in
  the first window open them.

Accepted limitation (Main decision, 2026-10-23; requirements, known limitation after 1.4): the
three residual cases above (a: 10-40 ms of noise flagged quieted touching the onset; b: a 50 ms
quieted stretch of noise then under 50 ms of noise before the over; c: clicks on a quieted
carrier) stay open. Clicks on a quieted carrier can latch from the pinned judge alone, already
before the window reset existed. A 10-40 ms noise lead-in may play before the over. If live
acceptance (M.4) shows real interference opening the gate, a stage-2 data test is the next
squelch task, not a backlog item.

| State   | Event                                       | Next                                        |
| ------- | ------------------------------------------- | ------------------------------------------- |
| waiting | armed, quieted block after an unquieted one | waiting (voice window and quiet ring empty) |

**Amendment (2026-10-24, A14): carrier hang.** The hang no longer counts stage-1-closed PCM only.
`sinceCarrier` counts every PCM sample after the latch, open or closed; it returns to 0 on each
sample while the last noted block was quieted (`carrierNow`, cleared by `closed()`), when the
latched tone or code is current in the tone stage, on a renewal and at the latch. The latch ends
when `sinceCarrier` reaches `HANG_MS`: inside `closed()` as before (to idle), or inside `push()`
(to waiting, fresh window, onset armed; the wiring tags the rest of that slice `pending`, so the
weak re-open is held and abandoned when stage 1 closes). Rows changed:

| State | Event                                                      | Next                                                                |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| open  | `HANG_MS` of PCM (open or closed) without carrier evidence | idle (closed) or waiting (stage 1 open)                             |
| open  | stage 1 reopens within the hang                            | open (latch carried; the hang keeps counting until a quieted block) |

Live timeline (run2): after the CTCSS latch at 09:25:48 the status showed `open`/`ctcss` on every
poll to the end of the auto capture (09:28:48), across the DCS over, the quiet over and the bare
key-up, with weak re-opens at -44 to -50 dBFS against a -55 dBFS floor. In the client stream after
the latch (93.8 s) the longest muted stretch is 0.74 s (stage 1 closed beyond the 200 ms guard),
so no close reached the 1.5 s hang, and 69.7 % of that time played interference as full-scale
noise (about -3 dBFS RMS). Bound: with no stage-1
close after the tone ends, the tone stage keeps its last 500 ms CTCSS block current, so the latch
can outlive the tone by the hang plus one block (tested: at most 2.0 s).

Samples go through one `PcmDecimator` (as `ToneSquelchGate`, with its split-sample hold) to the
meter and, on NFM, to `ToneEvidence`. While closed or idle nothing is analysed (`closed()` only
counts samples and keeps framing).

### PreRoll (`src/core/evidence-squelch/pre-roll.ts`)

A FIFO of PCM bytes with run-length tags, preallocated, writing its output into the chunk it was
given. Every sample entering the FIFO carries one tag:

| Tag       | Assigned to samples received                                                    | Played?            | Droppable in catch-up? |
| --------- | ------------------------------------------------------------------------------- | ------------------ | ---------------------- |
| `pending` | stage 1 open, gate waiting                                                      | not yet            | only by overflow       |
| `pass`    | stage 1 open, gate open; and every `pending` sample when the gate latches       | yes                | no                     |
| `guard`   | stage 1 closed, gate open, within the first `CLOSE_GUARD_MS` after close        | yes                | no                     |
| `drop`    | stage 1 closed otherwise; and every `pending` sample when the over is abandoned | as zero at delay 0 | yes                    |

Retagging only ever touches the `pending` suffix (pending samples are always the newest), so it
is O(1) on the run-length ring.

**Output rule (per input sample; implemented per run of samples).** Append the input sample with
its tag. Then produce exactly one output sample:

1. While the head is `drop` and the FIFO holds more than one sample, discard the head.
2. Head `pass` or `guard`: remove it and emit it.
   Head `drop` (it is the sample just appended): remove it and emit zero.
   Head `pending`: emit zero and keep it (the delay grows by one sample).
3. If the FIFO now holds more than the capacity, discard the oldest `pending` samples until it
   fits (evidence later than `PREROLL_MAX_MS` loses the over's earliest audio, requirement 2.1).

Consequences, each a property below:

- **Delay** `d` = samples left in the FIFO after step 3, at most the capacity (requirement 2.2).
- **Nominal rate:** one output sample per input sample; the chunk is rewritten in place over the
  same byte range, after the `pcm` listeners and the gate have read it (requirement 2.3).
  Listeners of `pcm` consume synchronously (as the WG7 in-place mute already relies on), and the
  chunk is a fresh buffer per read, so the registry may keep it in its queues.
- **Onset:** at stage 1 open the FIFO head is the first `pending` sample; zeros are emitted while
  waiting; on latch the head becomes `pass` and playback starts from the onset with `d` equal to
  the wait (requirement 2.1).
- **No loss inside an over:** while the head is `pass`, one sample leaves for each that enters; `d`
  is constant (requirement 2.4).
- **Exact catch-up rule:** after stage 1 closes, the remaining `pass` samples (the last `d` of the
  over) and the `guard` samples play; then step 1 discards every `drop` sample behind them in one
  step and `d` returns to 0. Only `drop` samples (gate silence after close, outside the guard, and
  abandoned overs) are ever discarded by catch-up; overflow discards only `pending` samples
  (requirement 2.5). A new over starting during the tail queues behind it as `pending`; a reopen
  within the hang queues as `pass`, and the `drop` samples between are skipped.
- **Fast path:** with an empty FIFO and a `drop` tag (stage 1 closed, nothing queued) the chunk is
  zeroed in place with no copy, as the frozen tone gate does today.

Byte framing: the FIFO stores bytes; tags start and end on sample boundaries; a sample split
across chunks is carried by a `width`-byte hold for input and a remaining-bytes counter for the
output sample in flight, so output is the same byte stream for any chunk split (Property 6).

Interface:

```ts
interface PreRollPort {
	/** Copy [start, end) of chunk in with `tag`, then overwrite the same range with output. */
	process(
		chunk: Buffer,
		start: number,
		end: number,
		tag: "pending" | "pass" | "guard" | "drop",
	): void
	latch(): void // pending suffix -> pass
	abandon(): void // pending suffix -> drop
	clear(): void // empty, delay 0 (requirement 2.9)
	readonly delaySamples: number
}
```

### Pre-roll sizing

`capacitySamples = ceil(rate × LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS / 1 000)`;
`bytes = (capacitySamples + 1) × width`, width 2 (s16le) or 4 (f32le). The audio rate is the
pipeline's effective rate, `iqRate / round(iqRate / (2 × bandwidth))`:

| Case                                    | Rate (Hz) | Samples | s16le bytes | f32le bytes |
| --------------------------------------- | --------- | ------- | ----------- | ----------- |
| NFM 12.5 kHz at 2.048 Msps (default)    | 24 975.6  | 37 464  | 74 930      | 149 860     |
| NFM 12.5 kHz at 2.4 Msps                | 25 000    | 37 500  | 75 002      | 150 004     |
| NFM 25 kHz channel at 2.4 Msps          | 50 000    | 75 000  | 150 002     | 300 004     |
| AM 10 kHz at 2.048 Msps (not wired, A8) | 20 078.4  | 30 118  | 60 238      | 120 476     |

Tag ring: tags change at most once per stage-1 transition, latch, guard expiry or overflow. Stage
1 decisions are 10 ms blocks, so a full FIFO holds at most `ceil(1 500 / 10) + 3` = 153 runs;
`Int32Array(2 × 160)` (run length, tag). Allocated once per run with the FIFO; a run of another
modulation allocates nothing. Maximum delay: 1 500 ms of stream time, reached only when evidence
comes 1.5 s or later after key-up. Expected delay: about 750 to 800 ms for a toned over (CTCSS
second block, DCS 750 ms floor), about 1 000 to 1 100 ms for voice (20 frames plus frame
alignment), plus the back chain's own latency as today.

### Wiring (`src/core/live-demodulator.ts`)

- **Applies when** `squelchMode === "auto"`, the modulation is in
  `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS`, `configuredTone(config) === null`, the run is on the
  csdr engine (amendment A12: `run.rust` unset) and the run has a pre-roll (allocated at run start
  for csdr NFM streams only, amendments A8 and A12). The predicate is `evidenceAppliesTo(run)`; a
  flip of it resets the gate and clears the pre-roll. An engine change always builds a new run,
  so a Rust fallback onto csdr starts with a fresh gate. Otherwise `handleAudioData` takes its
  frozen path unchanged (requirements 1.7 to 1.9).
- **Per chunk:** emit `pcm` first (unchanged); then walk the chunk in slices of at most
  `TONE_SLICE_MS` (10 ms) on sample boundaries. For each slice: stage 1 open
  (`runGateOpen(run)` at chunk arrival, as the tone gate does) → `gate.push`; if it latched at
  offset `k`, process `[start, k)` as `pending`, call `preRoll.latch()`, process `[k, end)` as
  `pass`; else process as `pass` or `pending` by gate state. Stage 1 closed → `g = gate.closed(...)`; tag
  the first `g` bytes `guard` (the gate reports bytes inside the close guard while latched), the
  rest `drop`. Then `audio.write(chunk)` once.
- **Stage 1 transitions:** `publishSquelchChange` on close without a latch calls `gate.reset()` and
  `preRoll.abandon()`; with a latch it only starts the guard and hang clocks (inside the gate).
- **Blocks:** `measureRun` (both engines) calls `gate.noteBlock(carrier)` for each measured block
  while stage 1 is open, after the floor update, and calls `preRoll.abandon()` when the result
  has `EVIDENCE_NOTE_DISCARD` (amendment 2026-10-23, revised: the gate is the only onset
  tracker).
- **Lifecycle (requirement 2.9):** mode change out of auto, `toneSquelch` set, offset swap
  (`gateHeld`), retune and stop: `gate.reset()` and `preRoll.clear()`. Mode change into auto:
  the gate starts idle with an empty FIFO; if stage 1 is open the current over starts waiting from
  that instant. A modulation change restarts the pipeline; the silence fill keeps writing to the
  registry directly. `NODE_ONLY_KEYS` already holds `squelchMode` and `toneSquelch`.
- **Default flip (requirement 3.1):** `.default("auto")` in `LiveDemodRuntimeConfigSchema`;
  `config.squelchMode ?? "auto"` in `src/api/routes/live-audio.ts`.
- **Status (requirement 4.1):** `autoSquelch` on `getStatus()` and the `level` event, derived from
  the gate (`off` when the gate does not apply); `squelchOpen` unchanged.
  `src/api/websocket/events.ts` copies the field into `live-audio:level`.

### Audio outputs

- **HTTP raw PCM and WAV.** Both endpoints share the registry and receive the rewritten chunk; the
  WAV header is unchanged and written once per client. Rate, format and byte count are those of
  the demodulator, so the per-client one-second queue (`liveAudioClientQueueLimit`) and stall rules
  behave as today. A client that attaches mid-over hears that over from the current delayed
  position.
- **WebSocket.** The core sends no PCM over the WebSocket; `live-audio:status` and
  `live-audio:level` carry `squelchOpen` and `autoSquelch` at received time, so the "open"
  indication and the start of played audio coincide at the server (playback starts from the
  FIFO at the latch), while `squelchOpen` leads the played audio by the pre-roll delay. Any future
  WebSocket audio transport must take its bytes after `PreRoll`, from the same rewritten chunk.
- **Digital voice stream.** Separate registry, untouched.

### Interaction with a configured tone squelch

A tone squelch is strictly stronger and keeps its WG7 path byte for byte: no evidence gate, no
pre-roll, no delay; audio passes from the tone gate's open (about 750 ms after key-up, as today).
Setting a tone squelch while the evidence gate runs clears the FIFO at once (delay 0) and hands
the next slice to the tone gate; clearing it starts the evidence gate idle. Pre-roll for the tone
squelch is a possible follow-up, not part of this spec.

### Interaction with modulation changes

Only `nfm` runs on the csdr engine allocate a gate and pre-roll (amendment A8, 2026-10-23: AM and
every other modulation allocate none; amendment A12: Rust runs allocate none). On the csdr engine a modulation change restarts the pipeline (rule 5 allows a restart
because the stream changes), so the old run's FIFO and gate are dropped with the run and nothing
queued is played; the new run allocates its own gate and FIFO, at its own rate and format, only if
its modulation is `nfm`. The standalone gate class still supports `am` (voice evidence only), but
it is not wired.

## Budgets (performance rule 3)

Per-sample work is at the audio rate (about 25 kHz for a 12.5 kHz channel at both 2.048 and
2.4 Msps, since the pipeline picks the decimation per IQ rate), then at 8 kHz after the
decimator; the IQ rate changes nothing. Pi 4-class figures are estimates at 4 × the desktop cost
per core until measured (no Pi 4-class host is available for this batch).

| Item                           | When                           | Desktop 2.048 / 2.4 Msps     | Pi 4-class 2.048 / 2.4 Msps (est.) | Basis                                         |
| ------------------------------ | ------------------------------ | ---------------------------- | ---------------------------------- | --------------------------------------------- |
| Decimator                      | stage 1 open                   | ≤ 0.001 / 0.001 core         | ≤ 0.004 / 0.004                    | 25 k samples/s, as the tone gate              |
| VoiceFrameMeter                | stage 1 open                   | ≤ 0.001 / 0.001              | ≤ 0.004 / 0.004                    | 4 biquads per 8 kHz sample; k-means per 50 ms |
| ToneEvidence (CTCSS + DCS)     | stage 1 open, NFM              | ≤ 0.003 / 0.003              | ≤ 0.012 / 0.012                    | 50 Goertzel updates per 8 kHz sample          |
| Judge                          | waiting only, ≤ 20 calls/s     | < 0.001                      | < 0.004                            | 20-element medians                            |
| PreRoll copy                   | stage 1 open or FIFO not empty | < 0.001                      | < 0.004                            | two memcpy of ≤ 100 KB/s                      |
| Fast path (closed, FIFO empty) | idle                           | as today                     | as today                           | one `fill(0)`                                 |
| Total while a carrier is up    |                                | ≤ 0.006 core                 | ≤ 0.024 core                       | below the 0.3-core noise floor                |
| Total idle                     |                                | ≈ 0                          | ≈ 0                                |                                               |
| Event-loop p99 added           | 2.048 Msps                     | ≤ 1 ms (largest chunk)       | ≤ 2 ms target                      | rule 2 cap 2 ms; measured in 8.2              |
| Memory                         | per NFM run (A8)               | 75–300 KB FIFO; < 8 KB other | same                               | Pre-roll sizing                               |

Largest synchronous step: one PCM chunk. A 64 KiB s16le chunk is 32 768 samples (1.3 s at
25 kHz), about 10 500 decimated samples through the meter and 50 Goertzel filters, estimated
0.5 to 1 ms on the desktop. The bench reports this case; if the Pi 4-class estimate exceeds the
2 ms cap, the bench records it and the fake-link run under a CPU quota measures it.

## Meter equivalence

Fixtures are generated as complex baseband at 48 kHz (`scripts/evidence-squelch/fixtures.py`):
NFM with CTCSS 67.0, 100.0, 250.3 Hz and voice-like audio (harmonic speech-shaped signal with a
4 Hz syllabic envelope and pauses), NFM with DCS 023N and 754I and voice, NFM voice with no tone,
AM voice, bare NFM and AM carrier, DMR-like 4FSK (4 800 symbols/s, 30 ms TDMA bursts), POCSAG
(512 and 1 200 baud, the existing `fixtures/generators/pocsag.py` modulator), clicks (2 ms
impulses at 3 to 20 Hz), impulse noise and unquieted noise, each at most 4 s (the analyzer's
80-frame cap). The existing `analyze.rs` entry point turns each into frame statistics and its
8 kHz audio; both are stored as goldens in
`tests/mocks/fixtures/evidence-squelch/`. The equivalence test feeds that audio to
`VoiceFrameMeter` and checks requirement 5.1. The fake-link scenario repeats the verdicts through
the real csdr and Rust chains (requirement 8.2), which covers the back chain's filters that the
golden audio does not.

**Amendment 2026-10-23 (A8 applied; requirement 5.1 amended, accepted; see requirements 5.1).**
Requirement 5.1 as first written (1.5 dB, identical verdicts against the analyzer) was not met: the
analyzer's 48 kHz statistics and the meter's 8 kHz statistics measure different signal paths.
The analyzer takes audio power from its 48 kHz DC-blocked demod output before DC restore, clamp
and the 3.4 kHz FIR decimation, and clusters 48 kHz discriminator samples through 2.4 and
4.8 kHz views; the 8 kHz PCM has no 4.8 kHz view. Accepted revision of 5.1, as the test
(`tests/unit/core/evidence-squelch/meter-equivalence.test.ts`) checks it:

- **Same-path equivalence (asserted).** `scripts/evidence-squelch/pcm_reference.py` (standard
  library) is an adapted reference of the analyzer's statistic definitions applied to the
  committed 8 kHz PCM at 8 kHz, writing `<name>.pcmstats.json`. It is not an exact oracle:
  its filter, histogram and k-means arithmetic is float64 where `analyze.rs` uses binary32;
  only the discriminator views are rounded to binary32, as the analyzer stores them. The meter
  must match it per frame, for gain 2 and for 1.5× audio at gain 3, with identical verdicts on
  all 17 fixtures:

  | Statistic | Bound | Measured  | Justification                                              |
  | --------- | ----- | --------- | ---------------------------------------------------------- |
  | audioDb   | 1e-12 | ≤ 1.5e-14 | float64 on both sides; summation-order rounding only       |
  | syllabic  | 1e-12 | ≤ 9e-16   | float64 on both sides; summation-order rounding only       |
  | cluster   | 1e-12 | 0         | binary32 views on both sides give bit-identical histograms |

  Without the binary32 rounding the per-frame cluster delta reached 0.16: one sample crossing a
  bin edge reseeds the k-means, so the score is not continuous in its input.

- **Cross-path verdicts (asserted, one listed exception).** On the 15 NFM fixtures the meter's
  whole-file verdict equals the analyzer's, except `nfm-dmr-4fsk-continuous` (analyzer
  data-like, 8 kHz PCM neither: median cluster 0.49 against 0.80, the missing 4.8 kHz view).
  The exception holds on the condition that continuous 4FSK never opening is asserted at gate
  level, with an ideal and with a noisy stage-1 onset (golden and synthetic 25 kHz seeds).
- **Cross-path numeric deltas (informational).** Printed, not bounded: no bound follows from
  first principles for two different paths, and bounds fitted to these fixtures would only
  restate them. Measured on the 15 NFM fixtures: audioDb ≤ 1.81 dB, syllabic ≤ 0.07, cluster
  ≤ 0.09 (0.31 for the exception).
- **AM (informational).** Under A8 the evidence gate applies to NFM only; the analyzer's AM
  cluster (no AM zeroing) is a different observable from the meter's.

The AGC case of requirement 5.2 uses an additional AGC stress transform (peak follower, instant
attack, 100 ms release, reference 0.4, gain ≤ 1 000). It is not the Rust fast AGC (5 ms attack,
300 ms decay, max gain 65 535); its verdicts and the `EVIDENCE-SQUELCH 8.4:` line are
informational.

**Resolved (2026-10-23): stage 1 open on noise before the over.** With stage 1 already open on
unquieted pre-over noise, the first 20-frame window used to hold that noise and the key-up with
75 of 100 blocks quieted, and `nfm-dmr-4fsk-continuous` (window medians −10.05 dB, syllabic
0.3124, cluster 0.48) and `nfm-clicks` (−22.24 dB, 0.4134, 0.31) latched voice at 1.0 s. The
window reset on carrier onset (EvidenceGate state machine amendment, revised) closes it: every
never-open NFM fixture stays closed with an ideal onset, after any 0-500 ms noise lead-in, with
quieted flickers of 1-4 blocks inside it, and after kerchunk → noise → over; the residual case
is listed under that amendment's limits.

## Correctness properties

Each becomes a property test (`fast-check`, `numRuns ≥ 100`) with the trace comment
`// Feature: evidence-squelch, Property N: <name>`. Tests use synthetic PCM, scripted stage-1
schedules (stage 1 state per sample index) and scripted carrier evidence.

1. **Monotone in evidence.** For any frame sequence, making frames more voice-like (syllabic and
   audio not lower, cluster not higher, carrier blocks a superset) or adding a qualified tone
   never makes the gate open later or not at all. _Validates 1.2, 1.3._
2. **Judge agreement.** For any 20-frame statistics, tone record and quiet fraction, the gate's
   decision equals "`classifyAnalogTrial` is `decoded` or `heard`" on the same statistics with
   frame quieting set to match the quiet count. _Validates 1.2, 1.3, 1.4._
3. **Bare carrier and data never open.** For any stage-1 schedule, PCM that is silence, a steady
   tone outside the CTCSS table, noise without carrier evidence, or frames with median cluster at
   or above 0.6 and no qualified tone never opens the gate. _Validates 1.4._
4. **Latch through the hang.** Once open, the gate stays open for every sample while stage 1 is
   open and until `HANG_MS` of stage-1-closed samples have passed; a reopen within the hang keeps
   it open; a closure without a latch discards all evidence. _Validates 1.5._
   Amendment A14 (2026-10-24): "while stage 1 is open" reads "while the transmission shows
   carrier evidence"; the test notes the over's blocks quieted and a quieted reopen.
5. **Status at received time.** The sample index at which `state` becomes `open` depends only on
   the received PCM and blocks, not on the pre-roll delay; `squelchOpen` is stage 1 for every
   sample. _Validates 2.7, 4.1, 4.2._
6. **Chunk-split invariance.** For any PCM byte stream, stage-1 schedule and two splittings into
   chunks (including splits inside a sample), the gate's state sequence per sample and the output
   byte stream are equal. _Validates 2.3 (performance rule 7)._
7. **Nominal rate.** For every chunk, output bytes equal input bytes in count, and the output is
   written to the same range. _Validates 2.3._
8. **Delayed copy, no loss while open.** For any schedule, the output restricted to `pass` samples
   is the input `pass` samples in order with nothing removed, repeated or reordered, and the delay
   is constant across every run of consecutive `pass` samples. _Validates 2.4._
9. **Bounded delay.** For any schedule, the delay never exceeds `capacitySamples`. _Validates 2.2._
10. **Onset.** For any over whose evidence arrives within `PREROLL_MAX_MS` of stage 1 opening, the
    first sample played after the waiting zeros is the first sample received after the open.
    _Validates 2.1._
11. **Catch-up drops only silence.** Every sample discarded by catch-up was tagged `drop`; every
    sample discarded by overflow was `pending`; no `pass` or `guard` sample is ever discarded; the
    delay is zero within one sample after the last `pass` or `guard` sample has played.
    _Validates 2.5, 2.6._
12. **Byte-identical elsewhere.** For any PCM stream and config with modulation other than
    `nfm` (A8: `am` included), a Rust run (A12), mode `manual` or `noise`, or a configured tone squelch, the bytes written to the
    registry and the `pcm` event bytes equal those of the frozen `handleAudioData`; for every
    config the `pcm` event bytes are unchanged. _Validates 1.6 to 1.9._
13. **Lifecycle.** After `clear()` the delay is zero and no sample queued before it is ever
    emitted. _Validates 2.9._
14. **Default.** Parsing a runtime config without `squelchMode` gives `auto`; an explicit value is
    kept. _Validates 3.1._
15. **Deviation normalisation (A13, 2026-10-24).** For any deviation, gain and PCM, a meter at
    deviation `d` emits the same frames as the 5 kHz meter fed the samples × 5 000 / `d`.
    _Validates 1.3, 5.2._
16. **Latch needs carrier evidence (A14, 2026-10-24).** After an over's last quieted block and a
    stage-1 close, for any pattern of unquieted re-opens and closes the gate stays open exactly
    until `HANG_MS` of PCM has passed and is waiting from then on. _Validates 1.5._

## Fake-link acceptance plan (requirement 8.2, run early)

- `scripts/evidence-squelch/fixtures.py` writes the fixtures of Meter equivalence as CU8 at
  2.048 and 2.4 Msps with the over placed at a known offset and silence between overs;
  `scripts/capacity/fake_rtl_tcp.py --file ... --loop` serves them inside a scratch Compose
  project (a unique project name, a private network, the API published on an ephemeral loopback
  port only). The core runs with `liveDemod.enabled: true` on NFM (AM for the AM fixtures), first
  on csdr, then on Rust.
- `scripts/evidence-squelch/run_acceptance.py` reads `/stream` for each fixture, records the
  bytes with arrival times, samples `live-audio:level` and status, and collects transmission
  events. Verdicts: opened or not per fixture; onset alignment by cross-correlating the played
  audio with the fixture's demodulated reference (first played sample within 20 ms of the over's
  onset); delay per over ≤ 1.5 s; stream byte rate within 0.5 % of nominal over each minute;
  transmission events equal (count, open and close times within one block) to a manual-mode run
  on the same file; event-loop p99 from the core's metrics within 2 ms of a run with
  `squelchMode: manual`; the close guard covers the measured back-chain drain (or the constant is
  amended from the measurement).
- A CPU-quota variant (as the link-burst acceptance) stands in for a weak host. The record goes
  to `docs/engineering/EVIDENCE-SQUELCH-2026-10-ACCEPTANCE.md`. Every scratch container, network
  and volume is removed after each run.
- Amendment A8 (2026-10-23), driver note. AM auto runs are judged as stage-1 auto rather than as
  evidence-gated overs. The 2.048 Msps csdr `am-voice` run was invalid ("no stage-1 transmission
  recorded for played over -1") because a closed AM stage 1 is not exact zeros. The -80 dBFS hold
  through the fast AGC and DC block leaves about -29 dBFS RMS of low-frequency residue on both
  the auto and the manual run, so the whole 130 s stream was one played run that started before
  over 0. The driver now requires `autoSquelch` `off` and an auto stream equal to the manual
  stage-1 stream: within 1 LSB, apart from edge clusters of at most 0.5 s, at most two per period.
  It skips the onset, playback, delay and drain verdicts on AM. Measured on that run: aligned shift
  1 500 samples, 99.8 % of samples equal, 2 190 samples differing by 1 LSB, and one 0.165 s edge
  cluster. On NFM, audio played before the first over now fails "never opens without evidence"
  instead of making the run invalid. `scripts/evidence-squelch/README.md` has the details.
  Review round 1 (2026-10-23) tightened the AM check:
  - The content shift must match the arrival-time shift. Tolerance 7.9 ms on that run, cap 20 ms;
    measured miss 1.3 ms. This catches a playback delay that content alignment would hide.
  - Each difference cluster must start within 84 ms of a stage-1 gate edge of either run, placed
    per over from the manual stream's open step, with at most one cluster per over edge. The one
    cluster on that run started 30 ms from its close edge.
    Review round 2 (2026-10-23): a cluster's divergence (its start and its largest difference) must
    lie inside the window from the earlier to the later of the two runs' edge stamps, ±84 ms.
  - Past that window the difference may only decay through the back chain's memory: at most
    0.7 times the in-window peak per 10 ms block. Measured 0.607 per block (τ 20.0 ms) over 13
    blocks on the am-voice close.
  - A cluster cannot fit inside ±84 ms. That cluster is 165 ms long because the chain decays
    for about 135 ms after both gates agree, so a length bound of block + chunk phase would
    reject the recorded run. The decay bound rejects a 400 ms mute 80 ms after the open and a
    mute of an over's first 400 ms.
  - The open-step locator allows a 5 ms rise.
- Amendment (2026-10-23): measurement windows for 6.1 and 8.2. Requirement 6.1 ("at most 2 ms added
  to event-loop delay p99") and the hot-path table's "Event-loop p99 added" row mean steady
  streaming. The driver compares only loop-meter intervals wholly after the source's first over
  onset.
  - The meter takes one interval per 2 s (`EFFICIENCY_SAMPLE_MS`). Follow-up (2026-10-23):
    intervals are deduplicated by their identity, the `intervals10m` ring count, which rises by
    one per interval on a fresh core. Without that identity on both runs the check is invalid
    (numbers informational): value-change grouping merges consecutive equal intervals. Steady
    means the interval's own start bound is after the onset. The bound is the request start of
    the poll before the previous interval was first seen. At least 20 distinct steady intervals
    per run (40 s, about six over periods), else invalid.
  - Live audio starts 0.8-1.0 s after the fake's epoch, with pipeline spawn and JIT cold start.
    The first over is also the gate's first open.
  - The startup intervals are reported only. They read 95-135 ms on auto and 97-1 684 ms on
    manual at 2.048 Msps csdr; the first is the largest in every run.
  - Criterion: median steady p99 of auto − median steady p99 of manual ≤ 2 ms. Steady p90 and
    max of both runs are reported only.
  - Why the median: am-voice is ungated and so runs identical code in both modes, yet its steady
    maxima differ by 7.7 ms (21.9 vs 14.2). Single 2 s intervals carry host noise. The median
    measures the gate's added steady delay.
  - Amendment (2026-10-23, follow-up round 2): the fake-link check is a regression smoke test,
    named `p99Smoke` in the driver's output. It is not the proof of 6.1.
    - 6.1 is established by the deterministic per-chunk bench (PR.3: largest synchronous step
      per chunk and core fraction).
    - The PR.3 bench numbers and the restated step budget are in the next amendment.
    - Detection limits of the smoke test: a steady median shift of more than 2 ms, and intervals
      more than 10 ms above manual p90 in more than 10 % of the intervals. Smaller or rarer stalls
      are not detected (9 % of the intervals 20 ms above manual p90 pass).
  - Tail (follow-up, 2026-10-23): at most max(1, 10 %) of the steady auto intervals may exceed
    manual p90 + 10 ms, so a recurring stall fails where the median alone passes. The manual
    count against auto p90 is a control, reported only. Measured on the 2.048 Msps csdr replay:
    60-63 distinct steady intervals per run, auto above the threshold 0-2 of 6 allowed (the
    threshold 23.2-25.0 ms), the manual control 0-1.
  - Measured steady state: medians 12.5-12.8 ms with auto − manual within 0.4 ms. p90 13.2-13.8
    ms on six fixtures; ctcss-1000 reads 19.1 vs 15.1. Maxima 14.2-106.6 ms.
    The stage-1 comparison of 8.2 ("transmission events identical to a manual-mode run", design
    "within one block") checks requirement 1.6. Open and close times are as today, so auto may not
    delay them. Event `startedAt` is the core's wall clock when Node handles the edge.
  - The fake's chunk phase (-55 to +6 ms per over) is the same in both runs and cancels.
  - Per over, |auto − manual| ≤ one 10 ms block (the two thresholds may cross in adjacent blocks)
    plus both runs' median steady interval p99, about 35 ms. The median auto − manual over the
    overs must be within 5 ms, for opens and closes, so a gate delaying stage-1 events by 8 ms
    fails.
  - Measured: worst per over 6.1-25.9 ms. Biases -2.5 to +2.3 ms on opens and -1.3 to +1.8 ms on
    closes.
    Known limitations (2026-10-23):
  - The AM divergence decay rule can be fooled by an engineered slowly decaying mute behind an
    in-window peak. The fake-link AM check is a smoke test; the authoritative AM identity proof
    is the unit-level frozen-code hash regression (property 12).
  - The per-over edge limit is empirical, not a validated timing-error bound.
  - A systematic stage-1 delay under 5 ms passes. Requirement 1.6 rests on the deterministic
    unit goldens.

**Amendment (2026-10-23): requirement 6.1 step budget, measured by PR.3.** The Budgets table's
"≤ 1 ms per 64 KiB" step is restated, because it contradicts the core budget. A 64 KiB chunk
holds 1.31 s of s16 25 kHz audio. 1 ms per chunk is 0.00076 core, eight times stricter than the
0.006 core budget, which allows 0.006 × 1.31 s = 7.9 ms for that chunk. `scripts/bench/evidence-squelch.ts`
measured EvidenceGate + PreRoll after the voice-meter and CTCSS speed-up (85b49943), on the
x86_64 integration host at load about 10:

| Format     | Core fraction | Largest step per 64 KiB |
| ---------- | ------------- | ----------------------- |
| 25 kHz s16 | 0.0022-0.0029 | 3.56-4.56 ms            |
| 25 kHz f32 | 0.0018-0.0023 | 1.69-1.92 ms            |
| 50 kHz s16 | 0.0021-0.0022 | 2.04-2.09 ms            |
| 50 kHz f32 | 0.0021-0.0025 | 1.14-1.43 ms            |

Before the speed-up: 0.0044-0.0049 core and 2.4-7.3 ms per 64 KiB.

6.1 is met by:

- **Core fraction.** At most 0.006 core.
- **Linear step.** A per-chunk step linear in chunk size, about core fraction × chunk audio
  duration: 0.0022-0.0029 × duration at 25 kHz s16.
  - Worked number: the live stream is s16 at 24 975 Hz. The client-side reads seen in the
    fake-link runs were at most 3.5 KB, which is 1 792 samples or 71.7 ms of audio.
  - Such a chunk costs 0.16-0.21 ms by core fraction, or 0.19-0.25 ms scaled from the measured
    64 KiB step. These are client-side reads, not the core's PCM chunk size.
- **Backlog bound.** A 64 KiB backlog chunk costs 3.6-4.6 ms at 25 kHz s16. That is a known bound
  above 2 ms, reached only on a backlog burst (for example after a front stall), not in steady
  state.

**Finding (2026-10-23): Rust-engine onset defect in the evidence path, fake-link es-c
2.048 Msps.** All six NFM fixtures fail "first played sample off the over onset". The tolerance
is not changed, because this is a defect, not physics.

**Status (2026-10-23, amendment A12): closed by scope, not fixed.** The evidence gate no longer
runs on Rust, so Rust NFM auto is the stage-1 auto squelch and has no evidence-path onset to miss.
The defect below still describes what would happen if the gate ran on Rust today. An attempt to
align the stdout gate events with the socket audio in TypeScript was not merged: early or late
close events, native audio drops that shift indices, and input-gap resets with no gate event
leave races it cannot close. The fix is in-band stage-1 gate markers on the Rust audio socket.

- **Measured on `nfm-ctcss-670-voice`.** The manual (stage-1 only) Rust stream starts every over
  0.4 ms from the reference onset. Auto loses 31.9-35.9 ms on even overs and 4.1-6.4 ms on odd
  overs. The other fixtures show the same alternation, 4-8 ms and 26-48 ms.
- **Stage 1 is not the cause.** Auto's stage-1 threshold is lower than manual's, so stage 1
  opened in time. The audio is dropped in the TypeScript evidence path.
- **Cause.** Rust reports gate changes as stdout events carrying `atOutputSample`. The audio
  arrives on a separate socket. `rust-engine.ts` forwards only `open` (`onGate(open)`), and
  `processEvidence` samples stage 1 at chunk arrival (A4). So audio of an already open Rust gate
  that arrives before the gate event is tagged closed and dropped from the pre-roll. Requirement
  2.1 (play from the first sample after stage 1 opens) is not met on Rust.
- **Edge stamps.** Rust edge stamps also show 33-66 ms outliers in both directions on opens and
  closes; per-over medians stay small. They come from the same stdout timing, so they are not
  loosened either.
- **AM.** AM sample identity is not checkable on Rust, because the resampler phase differs per
  run. The driver marks that check INVALID per fixture.

## Live acceptance plan (requirement 8.3, Main with the user)

On the user's receiver with the default csdr engine, an NFM channel in the PMR446 band and a
handheld a few metres away:

1. Overs with a CTCSS tone, with a DCS code, and with no tone, each starting with a counted word
   ("one, two, three"): the first word is heard each time.
2. A key-up shorter than one second with no speech and no tone, and a silent carrier held for five
   seconds: nothing is heard; `autoSquelch.state` stays `waiting`; transmissions are recorded as
   today.
3. The channel's ordinary interference and any digital burst seen during the session: nothing
   heard.
4. Two overs a second apart: the second plays after the first without growing delay; the stream
   is back to zero delay after the last.
5. `squelchMode: manual` and `noise`, and a configured tone squelch, still behave as before.
6. Desktop CPU of the core and event-loop p99 recorded with the gate busy; Pi 4-class figures stay
   marked as estimates.

The record is added to the acceptance document above; failures become amendments here.

## Calls made in this design (review these)

- Close guard of 200 ms on both engines, to protect the over's tail still in the back chain;
  the fake-link run measures the drain and may amend the constant.
- Pre-roll capacity 1 500 ms (not exactly the 1 s window), so speech starting up to half a second
  after key-up still plays from key-up.
- Overs shorter than one second with no tone are never heard. That is the price of not opening on
  clicks and kerchunks.
- Quieting for voice uses the existing WG10 carrier evidence (6 dB observer), not the analyzer's
  8 dB `hfNoiseDb` test, so both engines share one per-block signal.
- The cluster score uses the 2.4 kHz view and the received audio in place of the analyzer's
  4.8 kHz view, with discriminator scaling; equivalence is a tolerance (5.1).
- The judge is reused through exports of `analog-trial.ts` and runs only while waiting; its small
  median arrays are accepted outside steady state.
- Leaving the evidence gate, a retune and an offset swap drop queued audio (up to 1.5 s) rather
  than play the old state's tail.
- A tone squelch gets no pre-roll in this spec.
- A different tone on a reopen within the hang renews the evidence label; it never mutes.
- AM keeps evidence gating only if the AM fixture opens through the default fast-AGC chain (8.4).
  Amendment A8 (2026-10-23): resolved as NFM only; a bare AM carrier opened the gate as voice, so
  AM keeps the stage-1 auto squelch. The gate and pre-roll still support `am` but do not govern it.
