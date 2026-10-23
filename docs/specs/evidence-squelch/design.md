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

| Constant                                      | Value           | Basis                                                         |
| --------------------------------------------- | --------------- | ------------------------------------------------------------- |
| `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS`         | `["nfm", "am"]` | requirement 1.1                                               |
| `LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS`    | `["nfm"]`       | requirement 1.2 (AM: voice only)                              |
| `LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS`            | 50              | `ANALOG_TRIAL_FRAME_MS`                                       |
| `LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES`        | 20              | `SYLLABIC_WINDOW` in `analyze.rs`: 1 s                        |
| `LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS` | 100             | 10 ms IQ blocks in the 1 s voice window                       |
| `LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS`         | 750             | `DCS_MIN_AUDIO_SECONDS` × 1 000                               |
| `LIVE_AUDIO_AUTO_SQUELCH_HANG_MS`             | 1 500           | `ANALOG_TRANSMISSION_MERGE_GAP_MS`                            |
| `LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS`      | 1 500           | voice window 1 000 ms + up to 500 ms late speech after key-up |
| `LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS`      | 200             | back-chain drain after stage 1 closes (measured in 8.2)       |

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
`classifyAnalogTrial` (Property 2).

### EvidenceGate (`src/core/evidence-squelch/evidence-gate.ts`)

Per run, built for an NFM or AM stream (rate and format known). Interface:

```ts
interface EvidenceGatePort {
	readonly state: "waiting" | "open"
	readonly evidence: "voice" | "ctcss" | "dcs" | null
	/** One 10 ms IQ block while stage 1 is open: carrier evidence of that block. */
	noteBlock(carrier: boolean): void
	/** PCM bytes [start, end) received while stage 1 is open. Returns the byte offset in
	 *  [start, end] of the first sample after the gate latched in this call, or -1. */
	push(
		pcm: Buffer,
		format: "s16le" | "f32le",
		start: number,
		end: number,
	): number
	/** PCM bytes received while stage 1 is closed: advance the hang, keep sample framing. */
	closed(byteCount: number, format: "s16le" | "f32le"): void
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

| Case                                 | Rate (Hz) | Samples | s16le bytes | f32le bytes |
| ------------------------------------ | --------- | ------- | ----------- | ----------- |
| NFM 12.5 kHz at 2.048 Msps (default) | 24 975.6  | 37 464  | 74 930      | 149 860     |
| NFM 12.5 kHz at 2.4 Msps             | 25 000    | 37 500  | 75 002      | 150 004     |
| NFM 25 kHz channel at 2.4 Msps       | 50 000    | 75 000  | 150 002     | 300 004     |
| AM 10 kHz at 2.048 Msps              | 20 078.4  | 30 118  | 60 238      | 120 476     |

Tag ring: tags change at most once per stage-1 transition, latch, guard expiry or overflow. Stage
1 decisions are 10 ms blocks, so a full FIFO holds at most `ceil(1 500 / 10) + 3` = 153 runs;
`Int32Array(2 × 160)` (run length, tag). Allocated once per run with the FIFO; a run of another
modulation allocates nothing. Maximum delay: 1 500 ms of stream time, reached only when evidence
comes 1.5 s or later after key-up. Expected delay: about 750 to 800 ms for a toned over (CTCSS
second block, DCS 750 ms floor), about 1 000 to 1 100 ms for voice (20 frames plus frame
alignment), plus the back chain's own latency as today.

### Wiring (`src/core/live-demodulator.ts`)

- **Applies when** `squelchMode === "auto"`, the modulation is in
  `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS`, `configuredTone(config) === null` and the run has a
  pre-roll (allocated at run start for NFM and AM streams). Otherwise `handleAudioData` takes its
  frozen path unchanged (requirements 1.7 to 1.9).
- **Per chunk:** emit `pcm` first (unchanged); then walk the chunk in slices of at most
  `TONE_SLICE_MS` (10 ms) on sample boundaries. For each slice: stage 1 open
  (`runGateOpen(run)` at chunk arrival, as the tone gate does) → `gate.push`; if it latched at
  offset `k`, process `[start, k)` as `pending`, call `preRoll.latch()`, process `[k, end)` as
  `pass`; else process as `pass` or `pending` by gate state. Stage 1 closed → `gate.closed`; tag
  `guard` while latched within the guard, else `drop`. Then `audio.write(chunk)` once.
- **Stage 1 transitions:** `publishSquelchChange` on close without a latch calls `gate.reset()` and
  `preRoll.abandon()`; with a latch it only starts the guard and hang clocks (inside the gate).
- **Blocks:** `measureRun` (both engines) calls `gate.noteBlock(carrier)` for each measured block
  while stage 1 is open, after the floor update.
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

Only `nfm` and `am` runs allocate a pre-roll. A modulation change restarts the pipeline (rule 5
allows a restart because the stream changes), so the old run's FIFO and gate are dropped with the
run and nothing queued is played; the new run allocates its own FIFO if its modulation is `nfm`
or `am` and at its own rate and format. Between NFM and AM the gate also switches tone evidence
off (AM) or on (NFM).

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
| Memory                         | per NFM or AM run              | 75–300 KB FIFO; < 8 KB other | same                               | Pre-roll sizing                               |

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
12. **Byte-identical elsewhere.** For any PCM stream and config with modulation outside
    `nfm`/`am`, mode `manual` or `noise`, or a configured tone squelch, the bytes written to the
    registry and the `pcm` event bytes equal those of the frozen `handleAudioData`; for every
    config the `pcm` event bytes are unchanged. _Validates 1.6 to 1.9._
13. **Lifecycle.** After `clear()` the delay is zero and no sample queued before it is ever
    emitted. _Validates 2.9._
14. **Default.** Parsing a runtime config without `squelchMode` gives `auto`; an explicit value is
    kept. _Validates 3.1._

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
