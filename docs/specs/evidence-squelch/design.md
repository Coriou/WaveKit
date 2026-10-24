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
Superseded by A18 (2026-10-24) for framed Rust runs (Rust in-band gate markers, A18); it stands for
unframed runs.

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

| Constant                                      | Value     | Basis                                                                                   |
| --------------------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS`         | `["nfm"]` | requirement 1.1 (amendment A8, 2026-10-23: AM removed)                                  |
| `LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS`    | `["nfm"]` | requirement 1.2 (AM: voice only)                                                        |
| `LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS`            | 50        | `ANALOG_TRIAL_FRAME_MS`                                                                 |
| `LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES`        | 20        | `SYLLABIC_WINDOW` in `analyze.rs`: 1 s                                                  |
| `LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS` | 100       | 10 ms IQ blocks in the 1 s voice window                                                 |
| `LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS`         | 750       | `DCS_MIN_AUDIO_SECONDS` × 1 000                                                         |
| `LIVE_AUDIO_AUTO_SQUELCH_HANG_MS`             | 1 500     | `ANALOG_TRANSMISSION_MERGE_GAP_MS`                                                      |
| `LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS`      | 1 500     | voice window 1 000 ms + up to 500 ms late speech after key-up                           |
| `LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS`      | 10        | one 10 ms block, plus the back chain's computed lag (A16 revision, 2026-10-24; was 200) |

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
latched tone or code is sighted (revised below), on a renewal and at the latch. The latch ends
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
noise (about -3 dBFS RMS).

**Amendment (2026-10-24, A14 revised): tone continuity.** The continuous "latched tone
current" refresh is replaced by sightings: `ToneEvidence` counts every completed CTCSS block with
a winner and every new DCS word hit (`sightingCount`, `sightingKey` in the gate's tone-key form);
the gate resets `sinceCarrier` when a new sighting has the latched key. On a re-open within the
hang a tone latch keeps its tone stage (only the decimator and the audio clock restart), so the
next block (at most 250 ms of audio away; blocks are 500 ms every 250 ms) sights the returning
tone. While stage 1 is open a tone latch expires at `HANG_MS + EVIDENCE_TONE_HANG_GRACE_MS`
(250 ms), in `closed()` at `HANG_MS`. Regressions: the repro (2 s unquieted 79.7 Hz, 1.2 s
closed, tone back: open throughout), repeated 10 ms closes between 600 ms stretches, CTCSS and DCS
overs with no quieted block, a different tone after a fade (latch ends, the new tone latches on
its own), and flicker after an unquieted tone over (expires within hang + grace + one block).
Property 16 checks the open-side limit `HANG_MS + grace` for a tone latch.

**Amendment (2026-10-24, A14 revision 2): dated sightings.** The re-open path resets the tone
stage again for every latch (the retained stage dated pre-close tone as fresh), so a sighting's
block lies inside one stage-1-open stretch. `EVIDENCE_TONE_HANG_GRACE_MS` is 500 ms (the reset
stage's first block). `ToneEvidence` counts a DCS sighting only for a word chain of at least
`LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT` (2) hits. Regressions: the repro at eight tone lengths
(2 100 to 2 359 ms, block phases) and noise at 100 to 3 000 (latch ends 175 to 196 blocks after
the close, at most 200), a DCS fade, a seeded sighting-rate test (none in 10 min of white noise
at 0.5 and 5 min of voice), and Property 16 with bare tones of random length (1.5 to 2.6 s),
tone + voice, quieted or not, and noise at 100 to 20 000, plus the repro as explicit examples
(it fails on the retained-stage gate). The different-tone regression uses a 1.3 s fade, so the
latch ends before the other tone can qualify.

**Amendment (2026-10-24, live retest run4): diagnostic status.** `EvidenceGatePort` gains an
optional `diagnostics()` (`EvidenceGate` implements it): medians of the current frame window,
quiet and noted counts, `windowResets` (counted in `noteBlock`, cleared by `reset()`), audio
time, deviation, and the verdict in `judgeEvidence`'s order (`window-filling`, `non-finite`,
`data-like`, `not-quiet`, `low-audio`, `low-syllabic`, `voice`, or `latched`). It allocates its
medians when called; `LiveDemodulator.getStatus({ diagnostics: true })` calls it, the REST route
passes `?diagnostics=true`, level events never do. Type `LiveAudioAutoSquelchDiagnostics` in
`packages/api-types`, documented as diagnostic and unstable. Findings and the pending sparse-speech
decision: requirements, amendment after 1.5.

**Amendment (2026-10-24, A15): sparse-syllable path.** `VoiceFrame` gains `sustained` (5 ms
sub-blocks of the frame, 0-10, whose band mean square is at least the -30 dB level; scalar
accumulators, no allocation). The gate keeps a 40-entry `Uint8Array` ring of syllable-frame flags
(`isSyllableFrame`: finite audioDb ≥ -30 and sustained ≥ 5), cleared with the voice window and on
`reset()`, and counts runs of at least 3 flags oldest first (at most 40 steps per judged frame).
`judgeEvidence` takes `syllableRuns` and step 5 becomes `voicePath(stats, runs) !== null`:
`median` (`isVoice`) or `runs` (median syllabic ≥ 0.3 and runs ≥ 2). Frames without `sustained`
(any caller other than the gate's meter) never form runs, so Property 2's agreement with
`classifyAnalogTrial` holds whenever `syllableRuns` is absent or under 2. The diagnostic verdict
order is now `window-filling`, `non-finite`, `data-like`, `not-quiet`, `low-syllabic`, then
`voice-median`, `voice-runs` or `low-audio` (neither path); it reports `syllableRuns` and, while
latched, `path` (`median`, `runs` or `tone`). Property 17 pins that loud frames only in stretches
of at most 2 never qualify through the run path.

**Amendment (2026-10-24, A16): tail mute.** `EvidenceGatePort` gains an optional `passing`
(absent: the pre-A16 pass). `EvidenceGate.passing` is true while open and either `carrierNow`,
`tailGuardLeft > 0` (set to `guardSamples` on each quieted note and at the latch, counted down per
pushed PCM sample while the last note was unquieted, cleared by `closed()`), or, on a tone latch,
`sinceSighting < msToSamples(EVIDENCE_TONE_PASS_MS)` (reset on each sighting of the latched key, at
a renewal and at the latch, ended by `closed()`). The wiring tags an open slice of a latched gate
`pass` when `passing`, else `drop` (`evidenceSpan`); a latching slice is still `pass` from the
latch sample. Tags attach to input samples, so the mute follows the over through the pre-roll
delay, and `drop` samples behind the queued `pass` audio are skipped by catch-up (the stream
catches up during the tail instead of playing it). Property 18 pins the pass rule against a
model for any pattern of quieted, unquieted and closed blocks after a voice latch.

**Amendment (2026-10-24, A16 revision): sample-accurate guard and fade.** Live run6 (image with
A13-A16) still played a loud burst about half a second after each unkey. Each over ended with
speech, about 0.4 s of a steady tone (the radio's STE tone, A17), then 20-21 blocks of 10 ms at
RMS 16 000-26 000 (full-scale FM noise, the old 200 ms tail guard plus the block in which the
carrier dropped), then the exponential decay of the back chain on zeroed IQ (the old 200 ms close
guard). The noise began within one 10 ms block of the carrier drop, so the IQ-to-PCM lag is about
zero. Computed lag of the back chain (`backChainDrainSamples`, `live-demod-pipeline.ts`; the NFM
back chain runs at the channel rate, no decimation): `fmdemod` 1 sample; `dcblock`, `gain`,
`limit`, `convert` 0; a `lowpass` or NFM `deemphasis` FIR 120 (an 81-tap window, estimated); WFM
`deemphasis` 1; `sox` 4 096 (estimated). The default live chain lags 1 sample. The guard is now
`CLOSE_GUARD_MS` (10 ms, one block) plus that lag (`drainLagSamples`), followed by a 10 ms linear
fade to zero (`EVIDENCE_FADE_OUT_MS`, gain `k / (F + 1)` for the `k`-th last fade sample), so the
noise heard after an unkey is at most guard + fade = 20 ms + lag (measured end to end: 751
samples = 30 ms at 25 kHz including the harness's one-block note lag, against 5 250 samples
before). The gate decides per sample: `audibleEnd` is the byte offset of the last audible sample
of the push, muted samples are zeroed in place and fade samples scaled in place before the
pre-roll copies them, and the wiring tags `[start, audibleEnd)` `pass` and the rest `drop`, so
the expiry no longer drops the slice that holds it. A stage-1 close carries what
is left of the guard and fade (`guardBytesLeft` from the counters, full only when the close
follows carrier evidence) and fades in place; it never restarts the guard (the old
close returned a fresh 200 ms guard after a muted tail). Property 18 now checks the samples each
pushed and closed block delivers against a guard-and-fade model, and that muted pushed samples
are zeros.

**Amendment (2026-10-24, A17): squelch-tail elimination (STE).** `SteDetector`
(`ste-detector.ts`) runs on the gate's 8 kHz samples while stage 1 is open: 100 ms blocks in four
phases 25 ms apart; a block qualifies when the 55 Hz Goertzel bin holds at least 0.65 of the
block's AC energy, at least 3x the 45 Hz and the 67.0 Hz bins, and the four 25 ms quarters'
energies agree within 0.8 (the tone fills the block, about 95 ms or more). On a qualifying block
the gate ends the latch (`reset()`, then `waiting` with `steHold`), reports the onset through
`takeSteBack()` as one block of input samples back (the block starts at most 25 ms after the
tone), and holds everything muted until stage 1 closes (`closed()` then returns 0 and resets).
The wiring drops the slice, abandons any pending audio and calls `PreRoll.muteTail(back, fade)`,
which retags the newest queued samples `drop` and fades the 10 ms of playable samples before them
in place. The pre-roll delay (about 1 s after a voice latch, 0.75 s after a tone latch) exceeds the
100-125 ms detection latency, so the tone and the noise after it never play. Diagnostics report
`ste: true` while held. Note for lane TB (transmission boundaries, another branch): the STE onset
is a reliable transmission end on radios that send it; `analog-transmission.ts` is unchanged here.

**Amendment (2026-10-24, A17 revision).** `SteDetector` blocks qualify on: 55 Hz power
≥ 0.65 of the block's AC energy; ≥ 3x the 45 and 67 Hz bins; the 110 and 165 Hz bins ≤ 0.02 of it;
the 300-3 000 Hz energy (RBJ high-pass 300 Hz, low-pass 3 kHz, shared by the phases) ≤ -15 dB of
the tone's energy; and the four quarters' 55 Hz phasor magnitudes (correlation with a shared
800-entry cos/sin table) within 0.6. Each phase records the gate's input-sample index of its
block's first sample (`push(x, index)`; the gate passes the index where the decimation group
began), so `onsetIndex` is exact and `takeSteBack()` returns `inputCount - onset` whatever the
chunking. After an STE the gate keeps judging (window reset, tone stage reset) and `latch()`
clears `steHold`; the wiring tags held audio `pending` (abandoned on the close, replayed on a
latch). Split samples get the fade on their bytes in reach (`writeSplit`, in `push` and in
`closed()`, which now keeps a straddling sample's first bytes when it is given the buffer), and a
split sample's first bytes are tagged as its sample will be decided (`audibleEnd` extends to the
end of the range while the gate still passes). The wiring is now `processEvidenceChunk`
(`evidence-squelch/wiring.ts`), shared by the demodulator and the tests, with no per-slice
closure. Properties 18 and 19 run that wiring with the real pre-roll and compare the complete
client output; Property 6 (chunk-split invariance) is now byte identity of the client output
under random sample-aligned splits, on the wiring directly (about 5 s for 100 cases on a loaded
machine, from 250 s through the harness; one end-to-end run through the demodulator stays).

**Note (2026-10-24, A17 revision 2): recorded STE evidence.** Detector runs over the live
recordings (25 kHz client streams: runs 2, 4 and 6 gated, run3 ungated; read locally, not in the repository), STE onsets in seconds of each stream: run2 40.58, 60.88, 80.68 and 87.80 (all four
over ends, 50 qualifying blocks); run3 31.95 and 43.10 (both over ends, 25 blocks); run4 897.30
(its one STE over end, 13 blocks); run6 36.95, 48.28, 81.85 and 88.40 (all four over ends, 44
blocks); run5 none; no detection inside any over's speech. Per block on those segments:
110 Hz at most 0.006 and 165 Hz at most 0.0016 of the 55 Hz power, voice band -18.5 to -28.7 dB in
steady blocks (edge blocks up to -9.9 dB, rejected without losing an over end), quarter agreement
0.86-0.89. No detection in any repository fixture, synthetic voice or the private live clips.
Properties 18 and 19 now compare the complete client sample sequence, zeros and positions
included, against the gate model fed through a reference pre-roll (the design's output rule,
`referencePreRoll` in the test harness).

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
  csdr engine (amendment A12: `run.rust` unset; A18: or a framed Rust run) and the run has a pre-roll (allocated at run start
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
every other modulation allocate none; amendment A12: Rust runs allocate none; A18: framed Rust runs allocate them). On the csdr engine a modulation change restarts the pipeline (rule 5 allows a restart
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
    until `HANG_MS` of PCM has passed (`HANG_MS` + 500 ms when the block is open on a tone latch;
    an unquieted over's last sighting may precede the close by one 250 ms CTCSS hop)
    and is waiting from then on. _Validates 1.5._
17. **Short loud stretches are not syllables (A15, 2026-10-24).** For any frame sequence whose
    syllable-level frames come only in stretches of at most 2, `syllableRuns` is 0, `voicePath`
    never returns `runs`, and the judge says voice exactly when the pinned median rule does.
    _Validates 1.3, 1.4._
18. **Tail mute (A16, 2026-10-24).** After a voice latch, for any pattern of
    quieted, unquieted and closed blocks, with whole-sample or odd byte chunking, the complete
    client output (real wiring and pre-roll) is the over and then exactly the model's samples: all
    of a quieted block; otherwise what is left of the guard (`CLOSE_GUARD_MS` + lag) and then the
    10 ms fade, counted across closes and never restarted by one, until the hang ends the latch
    (split samples within 255 LSB). _Validates 1.5._
19. **Nothing after an STE tone (A17, 2026-10-24).** For any over followed by an
    STE tone of 0.13-0.4 s, then noise, and any chunking (an odd first chunk and 0-3 random cuts per
    block), the complete client output (zeros and positions included) equals the reference
    pre-roll fed the over's samples before the STE onset, the last 10 ms faded by `j / (F + 1)`,
    and nothing that plays after it; the onset lies within 25 ms after the tone's.
    _Validates 1.5._

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
  A 2026-10-23 revision tightened the AM check:
  - The content shift must match the arrival-time shift. Tolerance 7.9 ms on that run, cap 20 ms;
    measured miss 1.3 ms. This catches a playback delay that content alignment would hide.
  - Each difference cluster must start within 84 ms of a stage-1 gate edge of either run, placed
    per over from the manual stream's open step, with at most one cluster per over edge. The one
    cluster on that run started 30 ms from its close edge.
    2026-10-23 revision: a cluster's divergence (its start and its largest difference) must
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

**Status (2026-10-24, amendment A18): fix specified.** Rust in-band gate markers (A18) give the
gate stage-1 state at each sample; the defect is fixed for framed runs when the differential test
and the fake-link Rust leg pass (requirements 9.8 and 9.11).

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

## Rust in-band gate markers (A18, 2026-10-24)

**Amendment (2026-10-24, A18).** Requirements section 9. The Rust demod channel writes stage-1
markers into its audio socket stream, between the PCM samples they apply to, and a TypeScript
consumer splits the stream back into PCM and markers. The evidence gate and pre-roll then run on
framed Rust NFM runs with the csdr verdicts. Unframed runs keep A12.

### Why a framed stream, negotiated on `open`

Today the demod socket is raw PCM (`encode` in `native/wavekit-chan/src/demod_channel.rs`, s16le
or f32le at 48 kHz, no header), written by one writer thread from a byte `ChannelQueue` that drops
the tail of a push on overflow (`queue.rs`). Stage-1 changes are stdout `gate` events with
`atOutputSample`, read in `rust-engine.ts` on a different stream. Options weighed:

- **Out-of-band index alignment in TypeScript** (A12's rejected attempt): races on early and late
  close events, queue drops that shift indices, and input-gap resets with no gate event.
- **In-band escape bytes inside raw PCM**: every PCM value is legal, so any escape needs byte
  stuffing over the whole stream and a per-byte scan in TypeScript. Rejected (performance rule 1).
- **Typed frames for the whole socket stream** (chosen): one length-prefixed record per PCM run or
  marker. The parser touches only headers; PCM is forwarded as views. The decision is made once,
  on `open`, through the existing control protocol, which already carries a version (`v: 1`) and
  a binary protocol number (`--version`, `args.rs` `VERSION_LINE`, `DEMOD_PROTOCOL` in
  `select-engine.ts`). A stream preamble then checks that both ends agree before any PCM.

### Negotiation

- `args.rs` `VERSION_LINE` reports `protocol 3`. `DEMOD_PROTOCOL` stays 2 (the minimum for
  the Rust engine); a new `DEMOD_FRAMING_PROTOCOL = 3` decides the request.
- With a probe of protocol 3 or later, `encodeDemodOpen` adds `audioFraming: "wkaf1"` to every
  Rust `open` (any modulation and squelch mode, so a later in-place switch into `auto` keeps the
  run). With protocol 2 the `open` is byte-identical to today's (a strict protocol-2 parser would
  reject the unknown key).
- Rust accepts `audioFraming` only with the value `"wkaf1"` (other values: `open` rejected as
  `channel-request-invalid`, so the existing `open-rejected` fallback applies) and echoes it in
  `opened`. The `OpenedDemodEvent` schema gains optional `audioFraming: "wkaf1"`.
- TypeScript sets `run.rust.framing` to `"active"` only when it requested framing and `opened`
  echoed it; otherwise `"none"` and the socket is read as raw PCM, as today. A request without an
  echo is logged once at `debug` (no fallback: an unframed run is the A12 path).
- Revision (2026-10-24): Rust frames a channel only when it accepted the request and wrote the
  echo in `opened`; without that it writes raw PCM, as today. With the echo, TypeScript parses the
  socket as framed for the whole run. An invalid preamble after a valid echo is a framing error
  (requirement 9.6 (b)), never a cue to read the bytes as raw PCM.

### Byte layout (little-endian, framing version 1)

Preamble, once, the first 16 bytes on the socket:

| Offset | Size | Field        | Value                                                 |
| ------ | ---- | ------------ | ----------------------------------------------------- |
| 0      | 4    | magic        | `57 4B 41 46` ("WKAF")                                |
| 4      | 2    | version      | 1                                                     |
| 6      | 2    | preambleLen  | 16                                                    |
| 8      | 4    | sampleRateHz | 48 000 (`DEMOD_OUTPUT_RATE_HZ`)                       |
| 12     | 1    | format       | 1 = s16le, 2 = f32le; must match `opened.format`      |
| 13     | 1    | flags        | bit 0: stage-1 gate open at sample 0; other bits zero |
| 14     | 2    | reserved     | 0                                                     |

Frame header, 8 bytes, then `payloadLen` bytes of payload:

| Offset | Size | Field      | Value                                                                                |
| ------ | ---- | ---------- | ------------------------------------------------------------------------------------ |
| 0      | 2    | type       | below; 0x8000 and above are ignorable                                                |
| 2      | 2    | reserved   | 0                                                                                    |
| 4      | 4    | payloadLen | PCM: 1..65 536 and a multiple of the sample size; marker: exact per type, at most 64 |

Frame types (`atSample` is u64, the absolute output-sample index since `open`, counting
delivered and queue-dropped samples, equal to Rust's `out_samples` and `audio_emitted`):

| Type | Name       | Payload (bytes)                                                                                                                                                                                               |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | PCM        | samples in the run's format, exactly the bytes the unframed run writes                                                                                                                                        |
| 2    | GATE_OPEN  | 8: `atSample`                                                                                                                                                                                                 |
| 3    | GATE_CLOSE | 8: `atSample`                                                                                                                                                                                                 |
| 4    | RESET      | 24: `atSample`, u64 `droppedInputSamples` (as the `input-gap` event), u8 flags (bit 0 gate open after, bit 1 burst start, see Rust emission), 7 zero                                                          |
| 5    | DROP       | 24: `atSample` (first dropped sample), u64 `droppedSamples`, u8 flags (bit 0 gate open at the end, bit 1 burst start, bit 2 a reset inside the run), 7 zero                                                   |
| 6    | BLOCK      | 16: `atSample` (the block's end, the boundary it is written at; the block is the 480 samples before it), f32 `powerDbfs`, f32 `quietingDb` (NaN unusable, +∞ silent discriminator, as `QUIETING_DB_INFINITE`) |

Type 0 and types 7 to 0x7FFF are unknown and not ignorable. Alignment rule: a marker applies at
the boundary between the PCM before and after it; its `atSample` must equal the consumer's
running sample position (delivered PCM samples plus the `droppedSamples` of earlier DROP frames).
A RESET does not advance the position (`out_samples` is kept over `DemodChannel::reset`); a DROP
advances it by `droppedSamples`. A BLOCK marker is written when its block completes and describes the 480 samples before it; a
gate marker for the decision at the end of that block follows it at the same boundary. A run
that starts mid-block (after a RESET) has its first BLOCK after the first full block.

### Rust emission

Revision (2026-10-24): supersedes the first form of this subsection.

- **Staging.** In framed mode `DemodChannel` keeps one open PCM record per channel in a staging
  buffer that survives across `feed` calls. Samples are appended to it as `encode` writes them
  (`encode` and the zeroing of closed-gate samples are unchanged). The record is flushed (its
  header written with the final length, then pushed to the queue) only: before any marker, at
  every 10 ms block end, at 65 536 bytes (never reached: a block is 960 or 1 920 bytes), and at
  close and EOF. So a 1-sample feed schedule writes the same records as one large feed, and the
  staging adds at most 10 ms of latency over today's per-feed push.
- **Gate markers.** At most one per block boundary. Every source of a `gate_open` change
  (`finish_block`, `apply_pending_squelch`, `retune_gate`, the mode change) acts at the boundary
  where `fill == 0`; all changes at one boundary are coalesced to the net state, and no marker is
  written when the net state equals the state before the boundary. `atSample = audio_emitted`.
  The BLOCK record for the block that just ended precedes the gate marker at the same boundary.
- **RESET.** `Runtime::input_gap` flushes the staged record, then writes a RESET after
  `dsp.reset()` with the fresh gate state. The stdout `discontinuity` event is unchanged.
- **DROP.** `ChannelQueue` gains a record-aware push for framed channels: it accepts whole records
  and the longest whole-sample prefix of a PCM record (its length rewritten), and never splits a
  header. What does not fit (PCM tail and any markers after it) is folded into one pending DROP
  held by the channel (first sample, count, last gate state, reset seen), written ahead of the next
  accepted record. The queue keeps 32 bytes of its capacity for that DROP, so it can always be
  written once the writer frees room. The stdout `queue-overflow` discontinuity is unchanged.
- **Discontinuity bursts.** RESET and DROP records together are at most two in any 480 output
  samples. When a reset or a drop would be the second discontinuity within 480 samples of the
  last one written, Rust writes it with flags bit 1 (burst start) and then writes no gate markers
  and no further RESET or DROP until a block end at least 480 samples after the last
  discontinuity, where it writes one closing RESET (bit 1 clear, `droppedInputSamples` summed,
  bit 0 the gate state then). DROP counts inside a burst are carried by the next DROP or folded
  into the closing record's position (samples dropped inside a burst still advance `atSample`;
  the closing record is a DROP when any were dropped). The consumer treats stage 1 as closed from
  a burst start to its closing record.
- The preamble is the first record queued at `open`, and only when the echo was written.

### TypeScript consumer (`src/core/live-demod/rust-audio-framing.ts`)

- A push parser: `push(chunk)` calls `onPcm(view, atSample)` and `onMarker(marker)` in stream
  order. State: one fixed 64-byte scratch (the largest marker payload; it also
  holds a split preamble or header, one at a time), the bytes still
  owed to the current PCM payload, the running sample position and the gate state. PCM payloads are
  forwarded as `chunk.subarray` views, split wherever the chunk splits them (including inside a
  sample, which the client path already handles, A17 revision (5)). No per-byte work, no copy of
  PCM, no allocation besides the views and one small marker object per marker (at most about 600 per second, Budget (A18)).
- Hot-path rules (`docs/PERFORMANCE.md` rules 1 and 2): constant work per frame; one pass per
  chunk; the views are consumed synchronously in `handleAudioData` and never retained beyond the
  pre-roll's own copy.
- Errors: the parser returns an enumerated reason (`preamble`, `header-bound`, `pcm-partial`,
  `reserved`, `unknown-critical`, `index-mismatch`, `gate-repeat`, `payload-length`) with the
  stream offset and the type number. Framing reasons stop the parser (requirement 9.6 (b)); marker
  reasons (`unknown-critical`, `index-mismatch`, `gate-repeat`) mark the run failed safe and keep
  parsing for PCM (9.6 (a)). One `warn` per run, fields `{ reason, frameType, offset }`.

### Gate and pre-roll on framed runs

- `evidenceAppliesTo(run)` becomes `(run.rust === undefined || run.rust.framing === "active") &&
run.tone === null && evidenceGateApplies(this.config)`, and `buildEvidence` builds for framed
  Rust runs too, at 48 kHz in the run's format. A failed-safe run sets `framing` to `"failed"`,
  which flips the predicate and so resets the gate and clears the pre-roll (existing flip path).
- The drain lag for the A16 guard on Rust is `opened.groupDelaySamples` (the Rust chain's own lag in output
  samples), in place of `backChainDrainSamples(run.backCommand)`.
- `processEvidence` on a framed run takes stage-1 state per slice from the parser (the state
  after the last marker before the slice) instead of `runGateOpen(run)` at chunk arrival, and
  slices are cut at every marker as well as every 10 ms. GATE_OPEN and GATE_CLOSE drive the same
  gate calls as the csdr stage-1 edges (`publishSquelchChange`: close without a latch resets and
  abandons; with a latch starts the guard and hang). BLOCK calls `gate.noteBlock(carrier)` with
  `carrier = metricsQuieted(config, quietingDb)` while stage 1 is open, so for framed runs
  `measureRun` no longer calls `noteBlock` from the stdout metrics. Revision (2026-10-24): RESET
  and DROP call `resetEvidence(run)` (gate reset, `preRoll.clear()`, `shadow.clear()`, tail tag
  `drop`, `aligned` false), exactly as the retune path, not `abandon()`; then the flagged state
  applies and an over still open starts waiting afresh. A burst start holds stage 1 closed for the
  gate until the closing record. This is fail-safe (it can only mute).
- Revision (2026-10-24): stdout `gate` events on a framed run do not touch evidence state.
  `publishSquelchChange` (reached from `rust-run.ts` on each stdout gate event) today resets a
  waiting gate and abandons the pre-roll on a close; on a framed run that branch is skipped, and
  the event only updates `squelchOpen`, transmissions, Activity and the stage-1 floor. The
  markers are the only writer of evidence state, so the arrival order of stdout and socket bytes
  cannot change a verdict.
- Everything else keeps the stdout events: `squelchOpen`, transmissions, Activity, the stage-1
  floor and margin, tone results and recordings (requirement 1.6).
- Status: `autoSquelch` follows the gate as on csdr; `off` for unframed and failed-safe runs. No
  contract field changes; `docs/API.md` and a `docs/CLI-COORDINATION.md` note say that Rust NFM
  `auto` now reports `waiting` and `open` with a protocol-3 binary.

### Ordered reference and csdr skew

Revision (2026-10-24): supersedes the first "why verdicts equal" paragraph. The reference is a
test driver that takes one PCM sequence and a timeline of events at sample positions (stage-1
open and close, per-block carrier evidence at block ends, RESET and DROP) and feeds the gate and
pre-roll in sample order: PCM up to each event's position, then the event. Its output (tags,
verdicts, client bytes) is the definition of correct behaviour.

- **Framed Rust meets it exactly.** The markers carry exactly that timeline at exact positions,
  in stream order, and stdout events no longer write evidence state, so the production consumer
  path feeds the gate the same sequence for any chunking (the gate dates by its own input-sample
  count, A17 revision (4)).
- **csdr meets it approximately (known limitation, not changed by A18).** `measureRun` receives
  block callbacks from the front of the csdr chain, upstream of the demodulator, while
  `processEvidence` gates each PCM chunk by `runGateOpen(run)` at the chunk's arrival. Stage-1
  edges and carrier notes are therefore placed at chunk granularity against the PCM: skew up to
  one PCM chunk plus the back chain's lag (`backChainDrainSamples`). The existing csdr tests and
  fake-link tolerances cover it.

### Budget (A18)

Revision (2026-10-24): supersedes the first budget; overhead now follows the block cadence, not the
input read size.

- PCM at 48 kHz: s16 96 000 B/s, f32 192 000 B/s. A block is 480 samples (960 or 1 920 bytes).
- BLOCK: 100 per second × 24 bytes = 2 400 B/s, always.
- Gate markers: at most one per block boundary = 100/s × 16 bytes = 1 600 B/s hard bound. In
  practice the 250 ms hang allows at most one open-close pair per 260 ms, about 7.7 markers/s =
  123 B/s.
- PCM headers without discontinuities: records flush at block ends, and every marker sits on a
  block end, so at most 100 records/s × 8 = 800 B/s, for any feed schedule (1-sample feeds
  included).
- Worst case without discontinuities: 2 400 + 1 600 + 800 = 4 800 B/s, 5.0 % of s16 and 2.5 % of
  f32. Typical: 2 400 + 800 + 123 = 3 323 B/s, 3.5 % of s16.
- Discontinuity storm (input gaps and queue drops at every opportunity): at most two RESET or DROP
  records per 480 samples = 200/s × 32 = 6 400 B/s, each splitting a PCM record: 200 × 8 =
  1 600 B/s. Worst case 4 800 + 6 400 + 1 600 = 12 800 B/s, 13.3 % of s16 (bound 15 %).
- The 96 000-byte demod queue holds about 0.95 s of s16 audio in steady state instead of 1 s.
- Parser: at most 100 BLOCK + 100 gate + 100 PCM + 400 storm frames = 700 frames/s, constant work
  each, estimated 0.1 to 0.2 ms per second of audio on the desktop (under 0.001 core; Pi 4-class
  estimate 4×). PCM bytes are never read by the parser.
- Frame bounds: largest frame 8 + 65 536 bytes (Rust writes at most 8 + 1 920); largest marker
  8 + 24 bytes (64 allowed); parser scratch 64 bytes, so a malformed length can never make the
  core buffer more than one socket chunk.
- Rust: one staging buffer per channel, sized once at open (65 536 + 8 bytes); no allocation per
  sample or per feed.

### Tests (A18)

- Revision (2026-10-24) additions: Rust feed schedules of 1 sample, 7 samples, a prime number of
  samples and random sizes write the same records as one large feed (at most one PCM record per
  block plus marker flushes); a `squelch` request and a mode change landing on the same boundary
  as a block decision give one net marker or none; a reset burst and a drop burst give at most two
  records per 480 samples and a closing record with the right sums and gate state; a channel
  opened without the echo writes raw PCM; TypeScript: a RESET and a DROP split after every payload
  byte (including after byte 16) parse as one marker; the 64-byte scratch at and past its bound;
  stdout close before and after the socket audio up to the close marker (and the same for open)
  give the reference verdicts; a RESET and a DROP after a latch (while the pre-roll plays and in
  the close guard) play no earlier held byte; a valid echo followed by raw PCM or a corrupted
  preamble ends the run with no client byte from the socket; a framing error followed by a socket
  close and a child exit gives exactly one failure notification and one crash-latch count.
- Rust, `demod_channel.rs` and `runtime.rs`: markers at the exact `atSample` of each stage-1
  change for changes at a block's first and last sample, across input buffers split at every
  offset of a block, with one-sample `process` calls, after `squelch`, retune and reset; RESET
  after `mark-gap` at the A2 seam; DROP folding under a full queue (count, first sample, last gate
  state) and its write once room returns; PCM split at 65 536 bytes; property: stripping frames
  equals the unframed stream minus dropped samples, and marker replay equals the stdout gate
  history (`proptest`, as the existing runtime properties).
- TypeScript parser: fast-check property (`numRuns` at least 100) over random framed streams and
  random chunk splits, including 1-byte chunks and splits inside the preamble, a header, a marker
  payload and a sample, against a one-chunk parse; bounds at and one past each limit (PCM 65 536 /
  65 538 bytes, 0 bytes, partial sample; marker 64 / 65 bytes; known types at length ± 1);
  ignorable unknown types skipped; each error reason classified, logged once with only the safe
  fields (the log record contains no received byte).
- Differential (revised 2026-10-24): one synthetic over timeline (PCM, stage-1 edges, block
  carrier evidence, discontinuities) is fed to the ordered reference and, framed by a test encoder
  that mirrors Rust's layout, through the production framed-Rust consumer path (parser, wiring,
  gate, pre-roll) under random chunkings and random stdout orderings: latch sample and evidence,
  first played sample (the over's onset), pre-roll start, tail end, STE mute start and the tagged
  client bytes are equal. The csdr path on the same overs matches the reference within the
  documented skew.
  Overs: CTCSS voice, DCS voice, plain voice, bare carrier, data-like, STE tail, two overs inside
  the hang, a DROP and a RESET inside an over.
- Fail safe: a marker error mid-over drops the held pre-roll and continues with Rust PCM and
  `autoSquelch` `off`; a framing error writes no client byte after its offset and ends the run
  through the existing failure path, counted once toward the crash latch.
- Negotiation: protocol-2 fake gets today's `open`; protocol-3 fake with and without the echo.
- Fake-link (8.2): the Rust leg with a protocol-3 binary asserts the csdr verdicts; one leg with a
  protocol-2 binary asserts the A12 path.

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

## Amendment A19 (2026-10-24): AM closed-squelch hum, and the AM voice test study

### Root cause of the closed-squelch hum (requirement A19 finding)

Measured in process: the real `ChannelSquelch` (power mode, threshold -45 dBFS) fed a -30 dBFS
carrier with -60 dBFS channel noise for 2 s, then noise only, at 24 975.6 Hz (2.048 Msps / 82,
the 12.5 kHz AM channel), and its output run through a float32 port of the default csdr AM back
chain at the pinned csdr revision (`amdemod | agc -f float -p fast -r 0.4 | dcblock | gain 2 |
limit | convert -o s16`; csdr is not installed on the host and Docker was not used).

| Input to the back chain                         | Output RMS (steady) | Spectrum                            |
| ----------------------------------------------- | ------------------- | ----------------------------------- |
| Closed gate after an over (hold vector, today)  | -29.3 dBFS          | 81 Hz 48 %, 162 Hz 16 %, 243 Hz 2 % |
| Closed gate, never opened                       | -29.3 dBFS          | same; AGC gain settles near 3 600   |
| Constant 1e-4 envelope, no squelch              | -29.3 dBFS          | same                                |
| Constant -30 dBFS carrier, no noise, no squelch | -29.3 dBFS          | same                                |
| Closed gate with exact-zero IQ (A19.1)          | exact zero          | none                                |

DC of the hum is -5e-6 (no DC step); the upward zero-crossing rate is 81.0 per second. The level
is independent of the envelope's level, so the AGC, not the residue's size, is the cause:

- `src/core/channel-squelch.ts:122` (`MUTED_MAGNITUDE = 1e-4`) and `:478-481` at base f2f3d2f2
  (`emitBlock` writes the hold vector into every closed block): the closed gate hands the back chain a constant,
  non-zero envelope.
- `src/core/live-demod-pipeline.ts:189-190` (`csdr amdemod`, then the AGC from `agcStage`,
  `:50-54`, fast by default for AM): csdr's AGC raises the gain by `decay` = 0.1 % per sample while
  `|x| * gain < 0.4`, cuts it by `attack` = 10 % once above, then holds for `hang` = 200 samples;
  its alpha-beta gain smoother (alpha 1.5) overshoots each step. One cycle is the hold plus the
  climb back: `200 + ln(1 / 0.9) / ln(1.001) = 200 + 105.4 ≈ 305` samples, plus the smoother's
  lag, about 308 samples, so `24 975.6 / 308 = 81.1 Hz`. The output swings about ±10 % around the
  0.4 reference, `x 2` after `csdr gain 2`: peak 0.090 full scale, RMS -29.3 dBFS once the DC
  block removes the mean.
- A csdr AGC skips exact-zero samples (`isZero`: the gain neither rises nor falls), so exact zeros
  freeze it and the chain outputs zeros: `amdemod(0) = 0`, `0 x gain = 0`, and the DC block decays
  to zero (`R = 0.998`, 20 ms time constant).

The live recording of the A8 driver note (about -29 dBFS of low-frequency residue on both the
auto and the manual AM run) matches this figure.

### Fix (A19.1-A19.4), revised 2026-10-24

Two parts, both on WaveKit's side of the pipes:

1. **IQ zeros.** `ChannelSquelchOptions.muteZeros` (default false). When true, a closed block is
   `Buffer.alloc(block.length)` (no hold-vector loop) and a reopen applies no rotation (envelope
   detection ignores phase). Exact zeros freeze csdr's AGC: `Agc<T>::process` skips the gain
   update for a zero sample (`if (!isZero(input[i]))`, `src/lib/agc.cpp:44` at the pinned
   `CSDR_REF` 1f15b8c5) and `Agc<float>::isZero` is `in == 0.0f` (`:124`), so no limit cycle runs
   and the gain is held for the reopen.
2. **PCM mute, counted in samples.** With `muteZeros` the squelch logs each closed output span
   `[start, end)` in output-sample units in a ring of `CLOSED_SPANS_MAX` = 1 024 entries
   (`Float64Array`, a head index, no `shift`/`splice`; allocated only for a muting squelch,
   16 KB). Adjacent closed blocks extend one span; spans wholly consumed are dropped.
   `ChannelSquelch.muteClosedPcm(chunk, startByte, width)` zeroes the chunk bytes of every PCM
   sample inside a span, byte-wise, so a sample split across chunks is muted in both. The live
   demodulator calls it first thing in `handleAudioData` for a run whose squelch
   `mutesClosedPcm`, with `run.pcmBytes` (bytes received this run) and the stream's sample width
   (2 for s16le, 4 for f32le), before `pcm` listeners and clients see the chunk.

   Cap policy (diff review r1): at the cap the two oldest spans merge into one, so the open gap
   between them is muted too; a closed sample is never left unmuted, at worst some open audio is.
   Arithmetic: the gate decides per 10 ms block, so at most 50 closes per second (alternating
   blocks); the PCM backlog is the pipes and csdr buffers between the squelch and the PCM reader,
   well under a few seconds (two 64 KiB pipes hold 8 192 complex samples and 32 768 s16 samples,
   0.3 s and 1.3 s at 25 kHz; 1.0 s and 4.1 s at 8 kHz). 50 x 5 s = 250 spans worst case, so 1 024
   covers about 20 s of backlog at the worst toggle rate, and merging should never happen in
   practice.

The live demodulator passes `muteZeros: true` when it builds the csdr run's squelch for `am`,
`dsb` and `cw` (`ENVELOPE_MUTE_MODULATIONS`), the modulations whose back chain starts with
`csdr amdemod`. A modulation change restarts the pipeline and builds a new squelch, so no
runtime toggle is needed. Rust runs build their own squelch (`src/core/live-demod/rust-run.ts`)
without the option and are unchanged; FM and SSB keep the hold vector (the discriminator needs
it, design header of `channel-squelch.ts`). SSB (`realpart | agc`) may show the same limit cycle
and is to be measured separately.

Sample mapping: every stage of the default AM back chain (`amdemod`, `agc`, `dcblock`, `gain`,
`limit`, `convert`) emits one sample per input sample and retains none, so PCM sample `p` is
channel sample `p` exactly. A `csdr lowpass` (set by `lowPass`) is an FIR that keeps its tap
window back. Its length, verified at the pinned `CSDR_REF` 1f15b8c5 (round 2 review):
`LowpassCommand` declares `float transitionBandwidth = 0.05` (`src/apps/csdr/commands.hpp`) and
passes it to `LowPassFilter(cutoff, float transition, ...)`, which sizes the filter with
`FirFilter::filterLength(float transition)` (`src/lib/fir.cpp`): `size_t result = 4.0 /
transition`, a double division by the float widened to double, then made odd if even. 0.05f is
0.0500000007450580596923828125, so `4.0 / 0.05f = 79.9999988...`, truncated to 79, already odd:
79 taps (an earlier revision of this section said 81, from `4 / 0.05 = 80` in exact arithmetic).
`FilterModule` holds `taps_length` input samples back and computes output `k` from inputs `k` to
`k + 78`, so output `k` is centred on input `k + 39` and the PCM count trails the channel count
by 79. `backChainPcmLeadSamples(backCommand)` (`src/core/live-demod-pipeline.ts`, next to
`backChainDrainSamples`) returns `(CSDR_LOWPASS_DEFAULT_TAPS - 1) / 2 = 39` per `csdr lowpass`,
0 otherwise, and the run's squelch gets it as `pcmLeadSamples`: PCM sample `p` is muted when
channel sample `p + 39` was closed, so the mute boundary sits on the FIR's centre on close and on
reopen alike (tested at 8 kHz, closed, carrier, closed, with an independent window-back FIR
model; uncompensated, both boundaries would be 39 samples, 4.9 ms at 8 kHz, late). A test pins
`trunc(4 / fround(0.05)) = 79`. The count is read from source, not measured on a csdr binary
(none on this host). Should a build differ by one tap, the boundary moves by one sample
(125 µs at 8 kHz, 40 µs at 25 kHz). That is harmless: every close is preceded by the stage-1
hang (250 ms of sub-threshold noise, 2 000 samples at 8 kHz), so the samples around the close
boundary are hang noise, not the over; and a reopen boundary one sample early or late mutes or
passes one sample of the carrier's onset. The ±39-sample smear of the FIR itself remains on both
sides of each boundary, as for any filtered edge. `sox` (a `highPass`) is IIR and keeps the
count; its phase delay is not compensated (a few samples in the voice band). Note: the A16
`backChainDrainSamples` estimate for `csdr lowpass` (120, "an 81-tap window") assumes 81 taps;
by the arithmetic above it is 79 + 39 = 118. It is an estimate for the NFM guard and is not
changed here.

Why both parts. The IQ zeros alone leave the DC block's step, which decays by `R = 0.998` per
sample, so its length is fixed in samples, not time: from the AGC reference 0.4 x `gain` (worst
case 1.0 after `limit`) to below one s16 LSB (1 / 32 768) takes `ln(0.8 x 32 768) / -ln(0.998)
= 10.174 / 0.002002 ≈ 5 082` samples at gain 2 (203.5 ms at 24 975.6 Hz, 635 ms at 8 kHz) and
`ln(32 768) / 0.002002 ≈ 5 194` samples at full scale. Falling below one LSB is exact zero only
for s16le (it rounds to 0); in f32le the IIR tail stays a non-zero float far longer
(`0.998^n` reaches the float32 subnormal range only after tens of thousands of samples). The PCM
mute makes the guarantee independent of rate, gain and format.

Measured with the behavioural model of the tests (an envelope, an AGC that skips exact zeros with
a 10 % attack, 0.1 % decay and 200-sample hang, a 0.998 DC block, gain and limit; not a csdr
port), after a 1 s -30 dBFS over and the 250 ms hang, s16le RMS from the close (the model's hum
is -32.7 dBFS rather than csdr's -29.3, as it lacks csdr's gain smoother):

| Channel rate | Gain | Hold vector (today) 0-100 / 200-300 ms / 1-2 s | IQ zeros only         | IQ zeros + PCM mute |
| ------------ | ---- | ---------------------------------------------- | --------------------- | ------------------- |
| 6 000 Hz     | 2    | -30.1 / -39.5 / -32.6                          | -28.4 / -49.2 / zero  | zero throughout     |
| 8 000 Hz     | 0.1  | -60.3 / -53.7 / -58.7                          | -56.1 / -83.8 / zero  | zero throughout     |
| 8 000 Hz     | 2    | -34.3 / -27.6 / -32.7                          | -30.1 / -57.9 / zero  | zero throughout     |
| 8 000 Hz     | 100  | -3.1 / -0.0 / -2.5                             | -0.6 / -23.9 / zero   | zero throughout     |
| 12 000 Hz    | 2    | -30.1 / -15.7 / -32.7                          | -25.5 / -67.3 / zero  | zero throughout     |
| 24 975.6 Hz  | 2    | -17.0 / -32.6 / -32.7                          | -17.5 / -103.8 / zero | zero throughout     |
| 24 975.6 Hz  | 100  | -0.2 / -2.5 / -2.5                             | -1.5 / -70.4 / zero   | zero throughout     |
| 48 000 Hz    | 2    | -19.2 / -32.6 / -32.7                          | -19.9 / zero / zero   | zero throughout     |

Every rate in {6 000, 8 000, 12 000, 24 975.6, 25 000, 48 000} Hz at every gain in {0.1, 1, 2,
10, 100}, s16le and f32le: zero throughout with the PCM mute (test 4).

Closing transient (A19.3): in the csdr study, IQ zeros alone gave a first-20 ms peak of
-10.3 dBFS against -11.5 dBFS with the hold vector (+1.2 dB: the AGC output steps from its
reference instead of from a hum trough). The PCM mute removes it. Tolerance for an IQ-only
variant: +1.5 dB (the measured 1.2 dB plus 0.3 dB for float32 rounding and seed spread); the
shipped design does not rely on it.

Budget (diff review r1, round 2). Reproducible, opt-in bench:
`scripts/bench/am-closed-mute.ts` (repository convention: bundle with esbuild to
`output/bench/`, run with node; informational, no pass/fail, not a test). It runs 25 kHz, 10 ms
blocks alternating open and closed (the worst toggle rate, 50 closes per second), a 4 096-byte
s16le PCM chunk (8.2 blocks) per step, and times each step (its `process` calls plus one
`muteClosedPcm`) and the mute call alone, with the PCM 0, 244 (about 1 000 spans in flight) or
300 (past the 1 024 cap, merging) steps behind the IQ.

Measured per-call latency (desktop, three repetitions of 4 000 steps, 2026-10-24; the host was
under extreme unrelated load, `os.loadavg()` 227-240 / 153-154 / 99-100, so only the p50 is
meaningful and the p99 is scheduler noise):

| Variant                             | Step p50 (µs) | `muteClosedPcm` p50 / p99 (µs) |
| ----------------------------------- | ------------- | ------------------------------ |
| Hold vector, no mute (as f2f3d2f2)  | 96.5-114.5    | -                              |
| `muteZeros`                         | 67.3-72.4     | 1.38-2.43 / 7.4-26.5           |
| `muteZeros`, about 1 000 spans      | 67.9-68.7     | 1.36-1.46 / 6.7-8.6            |
| `muteZeros`, past the cap (merging) | 66.7-67.6     | 0.92-1.01 / 6.1-8.0            |

An earlier scratch run (load 24-33) gave the same picture: base step p50 87-102 µs, the
first array-based cut's mute call 1.2-3.0 µs p50 (13.7-19.3 µs p99 at a 1 000-span backlog),
the ring's 0.6-1.2 µs p50; the ring replaced `shift`/`splice` for that reason.

Inferred budget (arithmetic on the measured p50, not measured itself): the closed path is
cheaper than the hold vector (one zeroed allocation instead of a 250-sample `writeFloatLE`
loop), so the squelch's own cost goes down. The mute adds about 1.5 µs per PCM chunk; at about
12 chunks per second (4 096-byte s16le chunks at 25 kHz; larger chunks mean fewer calls) that is
about 20 µs/s ≈ 0.00002 core on the desktop, and an estimated 0.0001 core on a Pi 4-class core
(4 x the desktop cost, not measured), at 2.048 and 2.4 Msps alike (same channel rate). Event
loop: the largest synchronous addition is one mute call, a few µs at p50 and under 30 µs even at
the loaded p99 above, far under the 2 ms p99 cap of performance rule 2; the event-loop p99 itself
was not measured here.

### AM voice test study (A19.5, A19.6; prototype only, not built)

Where the tap would live: on the channel IQ that `ChannelSquelch.process` already walks per
10 ms block, before the back chain and so before the AGC. The envelope `|z|` is formed there per
sample (25 k complex samples per second, audio rate, allowed in TypeScript by performance rule 1
with a typed-array view instead of `readFloatLE`).

Algorithm (per 10 ms block of `B = 250` channel samples):

1. `e = |z|`; `mu` = block mean of `e`.
2. Voice band: `e` through a 300 Hz high-pass and a 3 000 Hz low-pass biquad (Butterworth, Q
   0.707); `Pv` = block mean square. Noise reference: `e` through a 4 000 Hz high-pass biquad;
   `Ph` = block mean square. Both are normalised by `mu²`, which cancels fades and flutter.
3. Noise in the voice band: `N = K x mean(Ph / mu²)` over the last 5 blocks, with `K = 1.38`, the
   median of `Pv / Ph` measured on carrier plus channel-filtered noise (p95 1.99), roughly the
   bandwidth ratio of the two bands in the envelope's 0-6.25 kHz noise.
4. Excess `x = max(0, Pv / mu² - N)`; ratio `q = (Pv / mu²) / N`.
5. Over the last 100 blocks (1 s; the first decision after 50 blocks, then every 5 blocks):
   `H` = share of blocks with `q ≥ 2` (voice band 3 dB over its noise); `G` = share of blocks with
   `x ≤ 0.25 x p90(x)` (syllabic dips of 6 dB or more). Voice when `H ≥ 0.20` and `G ≥ 0.15`.
   A heterodyne whistle is steady (`G = 0`); a carrier, noise and fades have no voice-band excess
   (`H` near 0).

Cost, had it been built (estimates, not measured): per channel sample one `sqrt`, three biquads
(15 multiply-adds) and three accumulations, about 25 operations x 25 000 samples/s ≈ 0.6 M
operations/s. Assuming about 1 ns per operation for JIT-compiled typed-array code on the desktop
reference host and 4 x that on a Pi 4-class core (the rule used elsewhere in this spec until
measured), with a 3 x margin for loop and call overhead: ≤ 0.002 core desktop and ≤ 0.008 core
Pi 4-class, equal at 2.048 and 2.4 Msps (channel rate 24 975.6 and 25 000 Hz). Decisions: three quantiles of 100 values at 20 per
second, negligible. Memory: three 100-entry `Float64Array` rings, 2.4 KB.

Synthetic study: 20 seeds per case, 4 s each, channel-filtered complex Gaussian noise, a
speech-like modulator (harmonics of a 100-220 Hz fundamental up to 3 kHz with three random
formants, 120-300 ms syllables with 50-250 ms gaps, peak-normalised), heterodyne beat 500-2000 Hz
at 0.1-0.7 of the carrier, fades 0.15-1.0 of the carrier at 0.2-1.5 Hz, flutter ±30 % at 10 Hz.
Columns: for voice the minimum of `H` and `G` over all decisions (range over seeds), for the rest
the maximum; opened = seeds with any voice decision in the 4 s.

| Case (C/N = carrier to channel noise)    | H (`q ≥ 2`) | G         | Opened | First open |
| ---------------------------------------- | ----------- | --------- | ------ | ---------- |
| Voice, depth 30-90 %, C/N 30 dB          | 0.28-0.38   | 0.53-0.67 | 20/20  | 0.5 s      |
| Voice, depth 30-90 %, C/N 30 dB, fades   | 0.14-0.35   | 0.53-0.67 | 20/20  | 0.5 s      |
| Voice, depth 30-90 %, C/N 30 dB, flutter | 0.30-0.42   | 0.52-0.67 | 20/20  | 0.5 s      |
| Voice, depth 30-50 %, C/N 15 dB          | 0.03-0.18   | 0.52-0.64 | 13/20  | 0.5-0.6 s  |
| Voice, depth 30-90 %, C/N 10 dB          | 0.00-0.18   | 0.44-0.63 | 8/20   | 0.5-1.4 s  |
| Voice, depth 30 %, C/N 6 dB              | 0.00        | 0.51-0.64 | 0/20   |            |
| Carrier, C/N 30 dB                       | 0.02        | 0.70-0.80 | 0/20   |            |
| Carrier, C/N 6 dB / 3 dB                 | 0.00        | 0.73-0.90 | 0/20   |            |
| Noise only                               | 0.00        | 1.00      | 0/20   |            |
| Carrier with fades, C/N 30 dB            | 0.02-0.03   | 0.81-0.89 | 0/20   |            |
| Carrier with fades, C/N 10 dB            | 0.00-0.02   | 0.82-0.97 | 0/20   |            |
| Carrier with 10 Hz flutter               | 0.03-0.10   | 0.67-0.71 | 0/20   |            |
| Heterodyne, C/N 30 dB, steady or fading  | 1.00        | 0.00      | 0/20   |            |
| Heterodyne, C/N 10 dB                    | 0.05-1.00   | 0.00-0.32 | 0/20   |            |

With `q ≥ 1.5` instead of 2, weak voice improves (C/N 15 dB 20/20, C/N 10 dB 16/20) but a carrier
with 10 Hz flutter opens 20/20 and a weak heterodyne 3/20. Earlier variants were worse: a
post-correction depth and spread rule opened on weak carriers (C/N 3-10 dB, 20/20); a
window-median noise reference opened on fades (20/20).

Decision: strong voice separates cleanly (H ≥ 0.14 against ≤ 0.10, first decision at 0.5 s,
inside the 1.5 s pre-roll), but no single threshold covers weak voice without opening on
flutter, and the corpus is synthetic only (peak-normalised speech is weaker on average than
compressed airband audio, so the weak-voice figures may be pessimistic). Gating AM would mute
weak overs that stage 1 plays today. Ship the hum fix only; AM evidence gating stays off.
Eligibility is `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS` (`packages/api-types/src/live-audio.ts:58`,
`["nfm"]`), not `src/core/evidence-squelch/wiring.ts`, which has no modulation check; enabling AM
later is adding `"am"` there plus the AM branch of `buildEvidence` (A19.6).

### Tests (A19.1-A19.4), revised 2026-10-24

Deterministic, synthetic IQ, sample counts only (no wall-clock assertions). No test ports csdr
(performance rule 8): tests assert on WaveKit's side, and where a back chain is needed they use
the behavioural envelope-chain model described above, written for the tests. Argv goldens keep
pinning the real csdr command.

1. `tests/unit/core/channel-squelch-am-mute.test.ts`: with `muteZeros`, every closed block is
   all zero bytes, open blocks are byte-identical to the input (no rotation after a reopen), and
   the output length equals the input length.
2. Same file: without `muteZeros` the closed output keeps the 1e-4 hold vector, `mutesClosedPcm`
   is false and `muteClosedPcm` leaves the PCM untouched.
3. Same file, Property 20 (fast-check, `numRuns: 100`), `// Feature: evidence-squelch, Property
20: closed AM is zero` / `// Validates: Requirements A19.1, A19.4`: for any open/closed block
   pattern, sample width (2 or 4) and chunking (1-977-byte cuts, odd included), a PCM byte is
   zeroed exactly when its sample's channel sample was emitted closed.
4. Same file: through the behavioural chain, at every rate in {6 000, 8 000, 12 000, 24 975.6,
   25 000, 48 000} Hz and every gain in {0.1, 1, 2, 10, 100}, s16le and f32le, every 100 ms window
   from the first closed sample is exact zero (RMS -∞).
5. Same file: with the IQ zeros alone (no PCM mute) at 8 kHz, gain 2, the 200-300 ms window
   after the close is above -70 dBFS (pins why A19.1(b) exists).
6. Same file, reopen (A19.3): after a 50 ms and a 10 s closure, the model's AGC gain at reopen
   equals its gain at the close; a 20 dB stronger reopen clips at the limit and is back under
   full scale within 40 samples; a 20 dB weaker reopen never clips; with the hold vector instead,
   a 10 s closure winds the gain above 1 000.
7. Same file, span cap: with 1 024 spans in flight every closed sample is muted and every open
   sample kept; with 1 025 the two oldest merge and the only extra muted samples are the open gap
   between them.
8. Same file, FIR alignment at 8 kHz: `backChainPcmLeadSamples` is 0 for the default AM chain and
   39 with `lowPass` (and `trunc(4 / fround(0.05)) = 79` taps is pinned); through an independent
   79-tap window-back FIR model, closed -> carrier ->
   closed, the muted PCM samples are exactly those centred on closed channel samples (close and
   reopen boundaries); without the lead both boundaries are 39 samples late.
9. `tests/unit/core/live-demod-am-closed-mute.test.ts`: on the default (csdr) engine the run's
   squelch has `mutesClosedPcm` for `am`, `dsb` and `cw` and not for `nfm`, `wfm`, `usb`, `lsb`,
   `raw`; the parsed default config has no `engine` (csdr); a Rust AM run's squelch does not mute
   (A19.2).
10. Same file: a closed then an open block through the run's squelch, and their PCM delivered in
    two chunks split at an odd byte: `pcm` listeners and the client receive zeros for the closed
    block and the original bytes for the open one.
11. AM replay regression (`am-carrier`, existing): `autoSquelch` stays `off` (A19.5).

## Amendment A20 (2026-10-24): reverse-burst squelch-tail elimination

Revised 2026-10-24 after review (mixed-block onset, retained-latch drain, restart on reopen,
enforceable corpus, bounded properties, history arithmetic, measured CPU).

### Signal models (requirement A20.6, A20.7)

All synthetic and seeded; no recording, no receiver. Two models, both in
`tests/unit/core/evidence-squelch/reverse-burst-signals.ts`:

- `directTone`: an 8 kHz tone, optionally reversed at a sample, with an amplitude envelope, an
  extra phase path and Gaussian noise. Used for the alignment sweep, the unit tests and
  Property 22.
- `fmLink`: the message (the CTCSS tone at 0.15 of deviation unless stated, plus, where stated,
  speech-shaped audio: voiced harmonics of a 100-220 Hz fundamental to 3 kHz under a 3-5 Hz
  syllable envelope, an unvoiced part and first-order pre-emphasis, at 0.4 RMS of deviation) is
  frequency-modulated at 5 kHz deviation on 24 kHz complex baseband, multiplied by the fading
  (Rayleigh: 16-path sum of sinusoids, 10 Hz Doppler, amplitude and phase; slow fades: dips to
  -20 dB), given complex Gaussian noise at the carrier-to-noise in 12.5 kHz, filtered by a
  31-tap 6 kHz low-pass, discriminated (`atan2` of `x[n] conj(x[n-1])`) and block-averaged by 3 to
  8 kHz (the gate's decimator). Tone flutter modulates the tone with 10 Hz low-pass phase noise
  (15° RMS) and amplitude (30 %). A reversal run reverses the tone at `2 + ((seed x 2 654 435 761)
mod 3 400) / 1 000` s, stops the voice there (PTT released) and ends 180 ms later.

The first prototype (a numpy model at 32 kHz with a 129-tap channel filter) gave the same picture;
the figures below are from the TypeScript tracker on the `fmLink` model.

### Alignment sweep (requirement A20.3a)

`directTone`, noise RMS 0.0015 (-37 dB below the 0.15 tone), reversal at block 12 plus every
offset 0-319, all 50 tones, 120° and 180°, errors -0.5, 0, +0.5 Hz: 96 000 cases.

| Measure                                    | Result                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Detected                                   | 96 000 / 96 000                                                                 |
| Onset - reversal (8 kHz samples)           | -121 to -41 (120°: -121 / -79 / -41 min / median / max; 180°: -114 / -79 / -43) |
| Decision + 1 - reversal (8 kHz samples)    | 520 to 892 (65 to 111.5 ms)                                                     |
| Review case: 127.3 Hz, 120°, 10 x 320 + 80 | decision 560 (70 ms), onset -79                                                 |

Why the literal first rule failed: with the reversal at offset 80 of block 10, the earliest
evaluation that passes is `k = 9` (block 10, three quarters reversed, already passes (c)-(e)),
and the old onset, the start of block `k`, was 400 samples (50 ms) early. The mixed-block
estimate fixes it: a block holding `o` pre-reversal samples has the phasor
`(o P + (N - o) Q) / N` for pre and post phasors `P` and `Q` (rectangular window, oscillator at
the tone), so the projection `Re((X - Q) conj(P - Q)) / |P - Q|^2` is `o / N`. Summing the
fractions of blocks `k` and `k + 1` gives the position whichever of them is mixed; noise and the
oscillator's drift spread it by about ±40 samples, hence the 80-sample margin (onset always
before the reversal in the sweep).

### Study and corpus (requirement A20.6, A20.7)

Study: 100 seeds per condition, 6 s false-alarm runs (600 s), 100 reversal runs each at 120° and
180°; tones rotate 67.0, 127.3, 254.1 Hz. Every detection counts (re-armed after each). Onset and
latency in 8 kHz samples, over detected runs.

| Condition                                  | False alarms        | Detected 120° | Detected 180° | Onset - reversal | Decision - reversal |
| ------------------------------------------ | ------------------- | ------------- | ------------- | ---------------- | ------------------- |
| Clean, CNR 30 dB                           | 0 in 600 s          | 100/100       | 100/100       | -106 to -51      | 536 to 880          |
| Tone error +0.5 Hz                         | 0 in 600 s          | 100/100       | 100/100       | -97 to -54       | 528 to 880          |
| Tone error -0.5 Hz                         | 0 in 600 s          | 100/100       | 100/100       | -99 to -55       | 552 to 880          |
| Rayleigh 10 Hz, CNR 20 dB                  | 0 in 600 s          | 100/100       | 100/100       | -111 to -27      | 536 to 880          |
| Rayleigh 10 Hz, CNR 12 dB                  | 0 in 600 s          | 93/100        | 95/100        | -182 to +161     | 536 to 1 088        |
| Slow fades to -20 dB, CNR 25 dB            | 0 in 600 s          | 100/100       | 100/100       | -106 to -51      | 536 to 880          |
| Tone flutter 10 Hz, 15° RMS + 30 % AM      | 0 in 600 s          | 69/100        | 76/100        | -153 to +231     | 552 to 1 008        |
| Weak carrier, CNR 8 dB                     | 0 in 600 s          | 100/100       | 100/100       | -106 to -52      | 552 to 880          |
| Weak tone -30 dB of deviation, CNR 20 dB   | 0 in 600 s          | 100/100       | 100/100       | -105 to -51      | 536 to 880          |
| Voice 0.4 RMS over the tone                | 0 in 600 s          | 95/100        | 95/100        | -122 to +1       | 544 to 952          |
| Voice + Rayleigh, CNR 15 dB, +0.5 Hz       | 0 in 600 s          | 92/100        | 95/100        | -145 to +76      | 528 to 1 024        |
| Weak tone -30 dB + voice 0.4 (known limit) | 3 in 600 s (3 runs) | 58/100        | 55/100        | -258 to +12      | 552 to 1 040        |

Gates weighed and dropped in the first prototype: without the magnitude-variation gate (b), or
with a 35° steadiness bound, the known-limit condition gave 4-6 false runs in 60; a 6-block
history halved those but cost 5-10 points of detection; a tone-fraction-of-block gate and a
300-3 000 Hz quiet-band gate (A17 style) do not separate, because the discriminator noise fills
the band in both classes.

Corpus test (`reverse-burst-corpus.test.ts`): the first 4 seeds of the study per condition
(false alarms: seeds 1000-1003, 24 s per condition; reversals: seeds 5120-5123 and 5180-5183).
Ceilings: 0 detections per condition, at most 1 in the known limit; every reversal detected, with
the onset 0 to 121 samples before it and the decision at most 892 after it, in the clean, ±0.5 Hz,
Rayleigh 20 dB, slow-fade, weak-carrier and weak-tone conditions. About 11 s of test time.

### Constants (requirement A20.3)

| Constant                        | Value | Arithmetic                                                                                                                       |
| ------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `REVERSE_BURST_BLOCK_SAMPLES`   | 320   | 40 ms at 8 kHz; decision 65-111.5 ms after the reversal (sweep), inside the shortest 150 ms burst; 2.7 cycles of 67 Hz per block |
| `REVERSE_BURST_HISTORY_BLOCKS`  | 4     | increments `k-5 -> k-4` to `k-2 -> k-1`, over 5 history blocks (200 ms of steady tone)                                           |
| `REVERSE_BURST_RING_BLOCKS`     | 8     | 5 history blocks, `k`, `k + 1`, `k + 2`; first evaluation after 8 blocks = 320 ms, under the 750 ms tone-latch floor             |
| `REVERSE_BURST_STEADY_DEG`      | 25    | ±0.5 Hz is 7.2° per block and is removed as drift; a 120° step clears the 90° bar by 30°                                         |
| `REVERSE_BURST_STEP_DEG`        | 90    | midway between no step and 180°; 30° under a 120° reversal                                                                       |
| `REVERSE_BURST_MAGNITUDE_RATIO` | 0.5   | -6 dB: a fade, a null or a carrier drop fails it; a reversal does not (outside the mixed block)                                  |
| `REVERSE_BURST_MAGNITUDE_CV`    | 0.3   | history magnitudes vary little on a tone-dominated bin; voice-dominated phasors vary more                                        |
| `REVERSE_BURST_ONSET_MARGIN`    | 80    | 10 ms: twice the ±40-sample spread of the position estimate in the sweep                                                         |

### Component: `ReverseBurstTracker` (`src/core/evidence-squelch/reverse-burst.ts`)

`arm(hz)`, `restart()`, `disarm()`, `push(x, index): boolean`, `onsetIndex`, `armed`, `toneHz`.
State: an oscillator phasor stepped by a fixed rotation and re-seeded at each block start from an
exact fractional cycle count (no drift in phase or magnitude); the block accumulators; a ring of
8 slots (real, imaginary, phase, magnitude, start index), oldest first. Order per completed
block: store into the ring (overwriting the oldest once full), re-seed, then, if 8 blocks have
completed since the arm or restart, evaluate with the newest as `k + 2`. A true return disarms
the tracker. Allocation free after construction (seven `Float64Array`s of 8 or 5 entries).
Rectangular window.

### Wiring in `EvidenceGate`

- Construction: a tracker on `nfm` unless `reverseBurst: false` (`EvidenceGateBuildOptions`,
  tests and the bench only).
- `latch(evidence, key, after)` and the renewal branch of `observeTone` call `armReverse(key)`:
  a CTCSS table index arms at `CTCSS_HZ[key]` (unless already armed there); any other key
  disarms. `reset()` disarms.
- The reopen path of `push` (open and closing: the latch is retained) calls `restart()` next to
  the tone and STE resets (A20.1).
- `takeSample`, after the decimator: the 55 Hz `ste.push` first, then, if open, not held and armed,
  `reverse.push(value, groupFirst)`. Either detection calls `endOver(onset, cause)`, which is the
  former `onSte()` with the onset and cause as arguments; `endCause` (tests only) reports the
  cause while held. No `@wavekit/api-types`, wiring, pre-roll or demodulator change.

Interaction with A16 and the pre-roll (A20.4a): during the A16 guard or fade the gate is still
latched and the tracker still runs; a detection mutes from the onset. After a retained-latch
close the pre-roll may have played out (a close longer than the queued delay) and the reopened
over plays at delay 0: then `muteTail` drops only what is queued, the reversed tone between the
onset and the decision may have played (at most about 122 ms), and nothing after the decision
plays. A stage 1 close before the decision leaves A16 in charge.

### CPU (requirement A20.8)

Estimate (operations, not measured): per armed 8 kHz sample 10 operations (rotation 4 multiplies
2 adds, accumulate 2 multiplies 2 adds), 80 000 per second; per block (25 per second) one `atan2`,
one `hypot`, one `cos`, one `sin` and the rule over the ring (about 40 operations, plus a 5-entry
sort for the median), about 2 000 per second; about 0.08 Mflop/s.

Measured with `scripts/bench/reverse-burst.ts` (opt-in; 30 s of a 100 Hz tone plus seeded
speech-shaped audio at 0.3, tone-latched; before and after passes interleaved, median of 7 after
a warmup; desktop host, load averages 11.61 12.57 17.41 before and 11.08 12.44 17.34 after):

| Path                             | Rate   | CPU core fraction |
| -------------------------------- | ------ | ----------------- |
| `EvidenceGate.push`, tracker off | 25 kHz | 0.002970          |
| `EvidenceGate.push`, tracker on  | 25 kHz | 0.003344          |
| `EvidenceGate.push`, tracker off | 50 kHz | 0.004041          |
| `EvidenceGate.push`, tracker on  | 50 kHz | 0.004557          |
| `ReverseBurstTracker.push` alone | 8 kHz  | 0.000200          |

The tracker costs about 0.0002 core on its own; the gate difference (+0.0004 to +0.0005) is of
the same order as the run-to-run noise on a host this loaded. Pi 4-class core: estimated 4-5x,
about 0.001-0.0025 core. Both at 2.048 and 2.4 Msps (8 kHz either way), far below 0.3 core.

### Correctness properties

21. **Reverse burst ends the over (A20, 2026-10-24).** For any of the 50 CTCSS tones, a tone
    error in [-0.5, 0.5] Hz, any starting phase, a reversal of 120° or 180° at 2.0 s plus 0-999
    input samples (25 kHz), a burst of 150-200 ms, uniform noise of peak 0.018 (RMS 0.0104, -20 dB
    under the 0.15 tone), then 0.3 s of open unquieted noise and a close, and any chunking (an
    odd first chunk and 0-3 random cuts per 10 ms block): the over is ended by the tracker before
    the burst ends, `muteTail` runs once, the onset lies within the sweep bounds (scaled to the
    input rate, plus one decimation group), and the complete client output equals the reference
    pre-roll fed the over until the onset (its last 10 ms faded by `j / (F + 1)`), held audio
    abandoned at the close, nothing after. _Validates A20.3, A20.4._
22. **No reverse burst without a step (A20, 2026-10-24).** On `directTone`, for any of the 50
    tones, error in [-0.5, 0.5] Hz, starting phase and seed, over 100 blocks (4 s): an amplitude
    path piecewise-linear per block in [0.2, 1] of the tone, changing by at most x2 per block; a
    phase path piecewise-linear with at most 20° per block; Gaussian noise of RMS 0.003 (0.1 of
    the smallest amplitude). The tracker, re-armed after any detection, never fires. Fades below
    0.2, carrier drops and flutter are deterministic tests and corpus conditions, not part of the
    property. _Validates A20.3, A20.6._
23. **One end per over (A20, 2026-10-24).** Within one uninterrupted hold (no fresh evidence
    and no stage-1 close between the two detections), for any order of a 55 Hz STE (with the
    CTCSS tone continuing at 0.2) and a 180° reversal, spaced 0-300 ms, at 67, 100 or 151.4 Hz:
    `muteTail` is called exactly once and `endCause` keeps the first detector's value from the
    first detection to the close. _Validates A20.5._

Each property runs with `numRuns: 100` and carries the trace comment, for example
`// Feature: evidence-squelch, Property 21: reverse burst ends the over` /
`// Validates: Requirements A20.3, A20.4`. No assertion reads a clock.

### Tests (A20.1-A20.9)

1. `tests/unit/core/evidence-squelch/reverse-burst.test.ts`: 120° and 180° at 67.0, 127.3 and
   254.1 Hz within the sweep bounds; every alignment 0-319 at 127.3 Hz for 120° and 180° at ±0.5
   Hz within the bounds; the review's mixed-block case pinned (decision 560 samples, onset within
   bounds and after `9 x 320 + 160`); 60° and 80° steps not detected; no detection on slow fades
   to -20 dB, a carrier drop to noise and 10 Hz phase flutter of 15° RMS (10 seeds x 3 tones x 6 s
   each); arming (8 blocks before the first evaluation, a step at block 3 ignored), `disarm`,
   `restart` (a step 2 blocks after a restart ignored); Property 22.
2. `tests/unit/core/evidence-squelch/reverse-burst-corpus.test.ts`: the seeded corpus and its
   ceilings (A20.6, A20.7).
3. `tests/unit/core/evidence-squelch/evidence-gate-reverse.test.ts`, through the real wiring and
   pre-roll:
   - arming on a CTCSS latch and renewal only, never on voice or DCS, disarmed when waiting or
     after a reset;
   - Property 21 and Property 23;
   - retained latch: closes of 20, 100, 300, 700 and 1 000 ms and reopen phases 0, 1.3, 3.14 and
     4.4 rad: no detection on the reopen phase jump, the tracker still armed on the tone, and a
     reversal 1.5 s after the reopen detected (M3);
   - drained pre-roll: latch, a 1 s close, reopen (the reopened over plays at delay 0, asserted),
     a reversal 1 s later: nothing plays after the decision, and what plays between the reversal
     and the decision is at most the decision span (A20.4a);
   - false detection mid-over (tone and voice continue): held, then resumed on fresh evidence,
     the held audio replayed; conditional cost: with stage 1 closing 0.4 s after the step, nothing
     from the onset on ever plays;
   - the CTCSS bank: reversal at every 25 ms across a 250 ms hop, a 200 ms burst then noise: the
     hold never ends before the close;
   - A16 interplay: carrier evidence lost 200 ms before the reversal (tone pass): still one
     `muteTail`, onset within bounds, nothing from the onset on plays;
   - fallback, pinned: reversal at stream sample 50 000 (2.0 s at 25 kHz), 10 ms blocks without
     cuts, a 50 ms burst and stage 1 closing at the carrier drop (under the 65 ms smallest
     decision latency): no `muteTail`, client output byte-identical to the gate with
     `reverseBurst: false`.
4. Regression: the existing evidence-squelch suites (including the A17 STE tests and fixtures)
   pass. One A14 test input was corrected: "repeated 10 ms closes between 600 ms unquieted tone
   stretches keep the latch" (`evidence-gate-live.test.ts`) joined a 2 s and a 0.6 s 79.7 Hz tone,
   each generated from phase 0, with no close between them (79.7 Hz x 2 s = 159.4 cycles: a real
   144° phase step on an open, tone-latched over, which the tracker ended at 2.07 s). The tone is
   now one phase-continuous signal sliced across the stretches; the repeated 10 ms closes, the
   test's purpose, are unchanged. A phase break in a test tone is a reverse burst under A20.
5. Bench: `scripts/bench/reverse-burst.ts` (opt-in, not in the suite), run before and after with
   the load average recorded.
