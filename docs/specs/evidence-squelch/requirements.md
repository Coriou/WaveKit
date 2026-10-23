# Evidence squelch requirements

Status: design, not implemented (2026-10-23). See [design](design.md) and [tasks](tasks.md).

## What changes for the user

- **Auto squelch opens on a voice or a tone, not on every burst.** In `squelchMode: "auto"` on
  NFM (AM removed by amendment A8, 2026-10-23), live audio passes only once the over shows analog voice, or any standard
  CTCSS tone or DCS code. A bare carrier, interference, clicks, impulse noise, data-like audio
  (POCSAG, APRS-like FSK) and digital bursts (DMR and similar) stay silent.
- **Each over plays from its start.** The core keeps the last moments of audio while it waits
  for evidence, then plays the over from the instant the carrier came up. While an over plays,
  the stream runs about one second behind; after the over it catches up by dropping the silence
  that follows it. The stream never speeds up, slows down or skips audio inside an over.
- **Auto is the default.** A live-audio config without `squelchMode` now runs the evidence auto
  squelch. An explicit `manual` or `noise` keeps today's behaviour exactly; those modes remain
  the way to hear "any carrier".
- **Nothing else moves.** Transmission events, Activity rows, tone results, identify,
  recordings and decoders follow the carrier exactly as today and are never delayed; the
  evidence gate only mutes what listeners hear. `squelchOpen` keeps meaning "carrier present".
- **Status says what the gate is doing.** Live status and the level event gain an optional
  `autoSquelch: { state, evidence? }`: `waiting` (muted, no evidence yet) or `open` with
  `voice`, `ctcss` or `dcs`.
- **Other modulations are unchanged.** WFM, USB, LSB, DSB, CW and raw in auto mode keep today's
  floor-and-margin auto squelch byte for byte. A configured tone squelch keeps governing as today.

## Scope

The live demodulator's squelch (`src/core/live-demodulator.ts`, `src/core/channel-squelch.ts`,
`src/core/noise-squelch.ts`, the WG7 tone squelch gate `src/core/audio-tones/tone-squelch.ts`),
the analog trial judge of [scanner-redesign](../scanner-redesign/requirements.md)
(`src/core/scanner/analog-trial.ts`, thresholds in `src/core/scanner/scanner-redesign-contract.ts`),
its frame statistics in `native/wavekit-chan/src/iqcap/analyze.rs`, the CTCSS and DCS detectors
(`src/core/audio-tones/ctcss.ts`, `src/core/audio-tones/dcs.ts`), both demodulator engines
([rust-demod-a](../rust-demod-a/requirements.md) requirement 4) and the
[performance rules](../../PERFORMANCE.md). Earlier squelch work: [web-gaps-7](../web-gaps-7/requirements.md)
(noise and tone squelch, noise-tail rule) and [web-gaps-10](../web-gaps-10/requirements.md)
(2.6, carrier-aware auto floor).

Background (generic): on a live NFM channel the WG10 auto squelch opened on nearly every burst
in the channel, interference included, so users either heard constant chatter or fell back to a
manual threshold that missed weak voice. The scanner's analog replay trial already tells voice
from bare carrier and data from captured IQ; this spec applies the same judgement to the live
audio.

Out of scope: any change to stage 1 (the floor-and-margin power gate, its 250 ms hang, the WG7
noise-tail rule, the WG10 carrier observer); the tone squelch gate's behaviour; the Rust demod
kernel (it keeps only stage 1); new config keys (the evidence constants are pinned); pre-roll for
the manual, noise or tone squelch; the digital voice stream; the web UI and the CLI (coordination
note only); the transmission tracker, Activity, identify, recording and decoder paths; new npm or
Rust dependencies.

Hard gates for implementation lanes: no RF, tuning, receiver or Raspberry Pi work, no deploys, no
Docker builds from the shared checkout. Unit tests use synthetic PCM and IQ, fake child processes
and injected clocks; the fake-link scenario uses a fake `rtl_tcp` inside a scratch Compose project
and never a live receiver or its ports. Live acceptance is run by Main with the user.

Defaults stay byte-identical except where a requirement here changes them on purpose (1.1 to 1.5
and 2.x evidence gating and pre-roll in auto on NFM (NFM only, amendment A8), 3.1 the default flip, 4.1 the
additive status field). Lanes prove the rest against goldens recorded from the frozen code and
list every golden they change with the requirement that changes it.

## 1. Evidence gate

1.1 **Two stages.** In `squelchMode: "auto"` on a modulation in
`LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS` (`nfm`, `am`) with no configured tone squelch, the squelch
has two stages. Stage 1 is today's auto squelch (noise-floor estimate plus `autoMarginDb`, WG10
carrier observer, 250 ms hang, WG7 noise-tail rule; `ChannelSquelch` on csdr, the Rust power gate
on Rust) and still delimits transmissions. Stage 2, the evidence gate, runs on the demodulated
PCM and decides only whether listeners hear the audio. `autoMarginDb` tunes stage 1 only.

1.2 **What opens it.** Stage 2 opens only while stage 1 is open and only on:
(a) voice evidence (1.3), or
(b) on `nfm` only, tone evidence: any of the 50 standard CTCSS tones, or any code in
`DCS_STANDARD_CODES` in either polarity, qualified by the existing detectors and heard for at
least `LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS` (750 ms, equal to `DCS_MIN_AUDIO_SECONDS`) of audio
since stage 1 opened.
On `am` only voice evidence counts.

**Amendment (2026-10-23, A8): NFM only.** `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS` is `["nfm"]`.
Evidence gating (1.1 to 1.5, 2.x) applies to `nfm` only; `am` in `auto` keeps today's stage-1 auto
squelch, like `wfm` and the other modulations, with byte-identical client audio and `autoSquelch`
state `off`. The AM text in this document is kept for the gate class (which still supports `am`)
but is not wired. A bare AM carrier key-up opened the real gate as voice. Replay evidence: gate replay of the `am-carrier` fixture latched voice 1.65 s after onset (the AM chain's envelope, DC removal and fast AGC raise the carrier noise envelope over about 1.5 s; rolling 20-frame windows 13-22 medians `audioDb` -29.0 to -20.1 dB, `syllabic` 1.9 to 0.3, `cluster` 0.0). Checkpoint line: `EVIDENCE-SQUELCH 8.4: am-voice agc=voice audioDb=-14.52 syllabic=0.45 cluster=0.21; am-carrier agc=neither audioDb=-12.94 syllabic=0.11 cluster=0.29`.

1.3 **Voice evidence** uses the scanner's pinned judgement over the last
`LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES` (20) frames of `LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS` (50 ms)
of audio heard while stage 1 has been open: not data-like (median cluster score below
`ANALOG_TRIAL_DATA_SCORE`, 0.6); quiet enough (at least `ANALOG_TRIAL_MIN_QUIET_FRACTION` of the
10 ms IQ blocks in the window carried a carrier: FM quieting from the existing carrier evidence on
`nfm`, channel power at least `ANALOG_TRIAL_AM_CARRIER_DB` above the noise floor on `am`); and
voice-like by `isVoice` (median syllabic index at least `ANALOG_TRIAL_VOICE_INDEX`, 0.3, and
median audio power at least `ANALOG_TRIAL_AUDIO_MIN_DB`, -30 dB). Judging starts once the window
is full and repeats on every new frame until the gate opens or stage 1 closes.

1.4 **What never opens it.** A bare carrier, unquieted noise, clicks, impulse noise, data-like
audio and digital bursts never open stage 2 on their own, whatever their power. A non-finite
statistic fails that judgement closed.

**Known limitation (2026-10-23).** Syllable-timed audio-frequency FSK bursts on a quiet `nfm`
carrier (2- or 4-level, 512 to 4 800 baud, keyed about 100 ms on and 100 ms off, or 500 ms on and
250 ms off) pass the pinned judgement of 1.3 as voice (median syllabic index about 0.59, at least
0.3; median audio power about -22 dB, at least -30 dB; median cluster score about 0.34, below the
0.6 data threshold), so stage 2 latches on `voice`. This is accepted: the gate deliberately equals
the scanner's pinned judge, and 1.4 is read with that judge's definition of data-like audio.
Continuous FSK and short TDMA-like bursts (for example 30 ms on, 30 ms off) are rejected; real
POCSAG, APRS/AFSK packets and DMR reject as continuous or TDMA-like.

1.5 **Latch and close.** Once open, stage 2 stays open for as long as stage 1 is open; pauses
between syllables never close it. It closes once stage 1 has been closed for
`LIVE_AUDIO_AUTO_SQUELCH_HANG_MS` (1 500 ms, equal to `ANALOG_TRANSMISSION_MERGE_GAP_MS`) of
stream time. If stage 1 reopens within that hang, the latch carries over and audio passes at
once. If, during a reopened over, a standard CTCSS tone or DCS code qualifies that differs from
the latched one, the latch is renewed with the new evidence (a new over; audio is not
interrupted). When stage 1 closes before any evidence, the evidence collected so far is
discarded.

1.6 **Audio only.** Stage 2 mutes client audio only. The `pcm` event (transmission tracking,
tone results, recordings), transmission open and close times, Activity rows, identify and
decoders see exactly what they see today.

1.7 **Other modulations.** In auto mode on `wfm`, `usb`, `lsb`, `dsb`, `cw` and `raw`, client
audio, status and events are byte-identical to the frozen auto squelch.

1.8 **Other modes.** `manual` and `noise` are byte-identical to the frozen code in every
modulation.

1.9 **Configured tone squelch.** When `toneSquelch` is set (not `none`), it governs exactly as
in WG7, in every squelch mode: no evidence gate and no pre-roll run, and client audio is
byte-identical to the frozen code.

1.10 **Both engines.** The evidence gate and pre-roll run in TypeScript on PCM decimated to 8 kHz
for both the csdr (default) and the Rust engine; the Rust engine keeps stage 1 only (rust-demod-a
4.5 unchanged).

1.11 **In-place changes.** Switching `squelchMode` to or from `auto`, setting or clearing
`toneSquelch`, and changing `autoMarginDb` apply without a pipeline restart; only a modulation
change restarts, as today.

## 2. Pre-roll

2.1 **From the start.** When stage 2 opens no later than `LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS`
(1 500 ms) of stream time after stage 1 opened, the first sample listeners hear of that over is
the first PCM sample received after stage 1 opened. When evidence comes later, playback starts
`LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS` before the moment of evidence.

2.2 **Bounded delay.** The delay between PCM received and PCM sent to listeners never exceeds
`LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS` of stream time.

2.3 **Nominal rate.** For every PCM byte the demodulator delivers, exactly one byte goes to the
client registry, in the same call; the HTTP raw PCM stream and the WAV stream carry the same
bytes as today's framing. Listeners never see a gap, a burst or a rate change.

2.4 **No loss inside an over.** While stage 2 is open and stage 1 is open, the audio sent equals
the audio received, delayed by a constant amount; no sample is dropped, repeated or reordered.

2.5 **Catch-up drops only silence.** The delay shrinks only by discarding samples received while
stage 1 was closed (the gate's silence), outside the close guard of 2.6, or samples of an over
that never produced evidence. Once the tail of an over has been played, the delay returns to zero
at once.

2.6 **Close guard.** While stage 2 is latched, the first `LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS`
(200 ms) of PCM after stage 1 closes are played, never discarded, so the over's tail still in the
demodulator's back chain is heard.

2.7 **Status is not delayed.** `squelchOpen`, `autoSquelch`, `live-audio:level`,
`live-audio:status`, transmission events and Activity reflect the PCM as received, not as played.

2.8 **Bounded memory.** The pre-roll buffer is allocated once per pipeline run of an NFM or AM
stream, sized from the run's audio rate and sample format (design, Pre-roll sizing), and nothing
is allocated per chunk.

2.9 **Lifecycle.** Leaving the evidence gate (mode change away from `auto`, a tone squelch set),
an offset swap, a retune, a pipeline restart and a stop each clear the buffer: the delay becomes
zero at once and queued audio of the old state is not played. A modulation change restarts the
pipeline and the new run gets its own buffer (or none). The WG10 silence fill during a restart
writes to listeners directly and never passes through the buffer.

## 3. Default on

3.1 The runtime default of `squelchMode` becomes `auto` (`LiveDemodRuntimeConfigSchema` and the
route's startup fallback). An explicitly configured `squelchMode` is respected. The
`LiveAudioConfig.squelchMode` doc comment, `config/default.yaml` comments and `docs/API.md` say
so.

3.2 The web "Auto" control (`{ squelchMode: "auto", autoMarginDb: 6 }`) needs no change.

## 4. Status contract

4.1 `LiveAudioStatus` and the `live-audio:level` payload gain the optional field
`autoSquelch?: { state: "off" | "waiting" | "open"; evidence?: "voice" | "ctcss" | "dcs" }`,
present while the pipeline runs. `off`: the evidence gate is not in effect (mode, modulation or
tone squelch). `waiting`: in effect and not open (client audio muted). `open`: latched, with the
evidence that opened it (or renewed it, 1.5).

4.2 `squelchOpen` keeps reporting stage 1.

4.3 The evidence constants (`LIVE_AUDIO_AUTO_SQUELCH_*`) are pinned in
`packages/api-types/src/live-audio.ts` beside `LIVE_AUDIO_TONE_SQUELCH_*`; contract tests pin
their values and their equalities with `DCS_MIN_AUDIO_SECONDS`,
`ANALOG_TRANSMISSION_MERGE_GAP_MS` and `ANALOG_TRIAL_FRAME_MS`.

## 5. Meter equivalence

5.1 The TypeScript frame meter on 8 kHz PCM agrees with `analyze.rs` on the shared fixtures
(design, Meter equivalence): per fixture, medians of audio power within 1.5 dB, of syllabic index
within 0.1, of cluster score within 0.15 and on the same side of 0.6, and the same verdict (voice,
data-like or neither) on every fixture.

**Amendment (2026-10-23, accepted): 5.1 revised.** The analyzer's 48 kHz statistics and the
meter's 8 kHz statistics measure different signal paths, so 5.1 is checked as (design, Meter
equivalence):

- Same-path equivalence (asserted): the meter matches an adapted reference of the analyzer's
  statistic definitions applied to the same 8 kHz PCM
  (`scripts/evidence-squelch/pcm_reference.py`, float64 arithmetic with binary32 views, not an
  exact oracle) per frame within 1e-12 for audio power, syllabic index and cluster score, with
  identical verdicts on every fixture.
- Cross-path verdicts (asserted): on every NFM fixture the meter's verdict equals the
  analyzer's, except continuous 4FSK (`nfm-dmr-4fsk-continuous`: analyzer data-like, 8 kHz PCM
  neither), on the condition that continuous 4FSK never opening is asserted at gate level with an
  ideal and with a noisy stage-1 onset.
- Cross-path numeric deltas (informational): recorded, not bounded; no bound follows from first
  principles for two different paths.
- AM rows are informational (A8).

  5.2 With non-default `gain`, the meter normalises audio power to the analyzer's deviation scale;
  with AGC or de-emphasis on, the verdicts on the fixtures are measured and recorded, not gated.

## 6. Performance

6.1 Per performance rules 1 to 5 and 7: per-sample work only at audio rate; no per-chunk
allocation; analysis runs only while stage 1 is open; at most 2 ms added to event-loop delay p99
at 2.048 Msps; the CPU table of the design is stated for a desktop host and a Pi 4-class host at
2.048 and 2.4 Msps (Pi 4-class figures are estimates until measured).

6.2 A bench (`scripts/bench/evidence-squelch.ts`) reports per-second and per-largest-chunk cost of
the gate and pre-roll, before and after, and the before/after table lands with the change.

## 7. Documentation and coordination

7.1 `docs/API.md` describes the new auto semantics, the default, `autoSquelch` and the stream
delay; `docs/ROADMAP.md` updates the live-audio squelch item and adds a Landed paragraph.

7.2 A dated note appended to `docs/CLI-COORDINATION.md` (append only, hand-formatted) states the
auto semantics, the default flip, the `autoSquelch` field, that `squelchOpen` is unchanged and
that `autoMarginDb` tunes stage 1. Before landing, the CLI source is checked for `squelchMode`
assumptions.

## 8. Acceptance

8.1 **Synthetic fixtures (unit).** NFM with a CTCSS tone and voice, NFM with a DCS code and voice,
NFM voice with no tone, AM voice, bare NFM and AM carrier, DMR-like 4FSK bursts, POCSAG bursts,
clicks, impulse noise and unquieted noise: the gate opens on the first four within
`LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS` of stage 1 opening and never on the rest; the pre-roll
plays each opened over from its first sample.

**Known limitation (2026-10-23).** Voice whose medians sit within about 1 dB of the -30 dB audio
threshold (`ANALOG_TRIAL_AUDIO_MIN_DB`) may latch after the pre-roll limit; the start of the over
is then clipped (measured: synthetic voice at medians about -31 dB latched 1.85 s after stage 1
opened, losing about 350 ms of speech). To be revisited with live measurements (M.4).
Amendment A8 (2026-10-23): the AM half of this limitation no longer applies (AM is not evidence
gated); it stands for NFM. Under A8 the AM voice and bare AM carrier cases of 8.1 assert the frozen
stage-1 auto path instead, and an `am-carrier` replay regression pins that AM stays ungated.

8.2 **Fake-link scenario (early).** The same fixtures as IQ through a scratch core fed by the fake
`rtl_tcp`, on the default csdr engine and on Rust: open and no-open verdicts as 8.1, played audio
aligned with the over's onset, delay at most 1.5 s, stream byte rate nominal, transmission events
identical to a manual-mode run, event-loop p99 within 6.1.

8.3 **Live (Main with the user).** On a real PMR handheld: overs with CTCSS, DCS and no tone are
heard from their first syllable; a short key-up with no speech and no tone, a silent held carrier
and the channel's interference stay muted; the stream catches up after each over; transmissions
and Activity unchanged; desktop CPU and event-loop p99 recorded.

8.4 The AM voice fixture opens with the AM default chain (fast AGC). If it cannot at the pinned
thresholds, the lane reports the measured statistics and Main decides between a measured AM
threshold and leaving AM on stage 1 only; the decision is recorded here as an amendment.

**Resolved (2026-10-23, A8): AM stays on stage 1 only.** See the amendment after 1.2.
