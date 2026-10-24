# Evidence squelch requirements

Status: design, not implemented (2026-10-23). See [design](design.md) and [tasks](tasks.md).

## What changes for the user

- **Auto squelch opens on a voice or a tone, not on every burst.** In `squelchMode: "auto"` on
  NFM (AM removed by amendment A8, 2026-10-23; csdr engine only, amendment A12; framed Rust runs too, superseded by A18), live audio passes only once the over shows analog voice, or any standard
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
kernel (it keeps only stage 1; A18 adds in-band stage-1 markers); new config keys (the evidence constants are pinned); pre-roll for
the manual, noise or tone squelch; the digital voice stream; the web UI and the CLI (coordination
note only); the transmission tracker, Activity, identify, recording and decoder paths; new npm or
Rust dependencies.

Hard gates for implementation lanes: no RF, tuning, receiver or Raspberry Pi work, no deploys, no
Docker builds from the shared checkout. Unit tests use synthetic PCM and IQ, fake child processes
and injected clocks; the fake-link scenario uses a fake `rtl_tcp` inside a scratch Compose project
and never a live receiver or its ports. Live acceptance is run by Main with the user.

Defaults stay byte-identical except where a requirement here changes them on purpose (1.1 to 1.5
and 2.x evidence gating and pre-roll in auto on NFM (NFM only, amendment A8; csdr engine only, amendment A12, superseded by A18 for framed Rust runs), 3.1 the default flip, 4.1 the
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

**Amendment (2026-10-23, A12): csdr engine only.** Evidence gating (1.1 to 1.5, 2.x) and the
pre-roll apply only to runs on the csdr engine, which is the default. On the Rust engine,
`squelchMode: "auto"` on `nfm` keeps today's stage-1 auto squelch (the Rust power gate with the
TypeScript floor and margin), with client audio and `pcm` event bytes byte-identical to the
stage-1-only path and `autoSquelch` state `off`, exactly as `am` under A8. A Rust run allocates no
gate or pre-roll. A run that moves onto csdr (a Rust fallback, a crash latch, or an engine change)
starts with a fresh gate and an empty pre-roll; a run that moves onto Rust drops both. Reason: Rust
reports stage-1 gate changes as stdout events and sends audio on a separate socket, so stage 1
cannot be sampled at the audio's own sample position (design, Finding: Rust-engine onset defect).
Aligning the two in TypeScript has races that cannot be closed there: a close event that arrives
early or late against the audio, native audio drops that shift the event's output-sample index,
and input-gap resets that produce no gate event. Follow-up: in-band stage-1 gate markers on the
Rust audio socket, after which this amendment can be lifted.
Superseded by A18 (2026-10-24) for framed Rust runs; it stands for unframed runs (section 9).

1.3 **Voice evidence** uses the scanner's pinned judgement over the last
`LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES` (20) frames of `LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS` (50 ms)
of audio heard while stage 1 has been open: not data-like (median cluster score below
`ANALOG_TRIAL_DATA_SCORE`, 0.6); quiet enough (at least `ANALOG_TRIAL_MIN_QUIET_FRACTION` of the
10 ms IQ blocks in the window carried a carrier: FM quieting from the existing carrier evidence on
`nfm`, channel power at least `ANALOG_TRIAL_AM_CARRIER_DB` above the noise floor on `am`); and
voice-like by `isVoice` (median syllabic index at least `ANALOG_TRIAL_VOICE_INDEX`, 0.3, and
median audio power at least `ANALOG_TRIAL_AUDIO_MIN_DB`, -30 dB). Judging starts once the window
is full and repeats on every new frame until the gate opens or stage 1 closes.

**Amendment (2026-10-24, A13): the voice meter follows the channel plan.** Live acceptance on a
PMR446 handheld (12.5 kHz channel, channel power about +1 dBFS) left a normal voice over
`waiting` for its whole 6.4 s. The analog trial's thresholds are calibrated on the 25 kHz plan
(0 dB = a ±5 kHz full-deviation sine), but 12.5 kHz channels deviate at most ±2.5 kHz, so the same
speech reads 6.02 dB lower. Ungated live overs measured median `audioDb` -29.6 to -32.9 dB (over 1)
and -20.8 to -25.2 dB (over 2) per 1 s window against the -30 dB threshold; syllabic 0.28 to 0.76,
cluster 0.00 (not data-like), FM quieting 39 to 54 dB on every block (carrier evidence was never
the problem) and one window reset per over. RF saturation does not change FM audio: the limiter
and discriminator make the audio level a function of deviation only. Requirement: on `nfm`, the
meter normalises the channel's nominal peak deviation onto the 5 kHz reference, exactly as it
normalises `gain` (5.2): samples × 5 000 / deviation. The nominal deviation is 2 500 Hz for a
configured bandwidth of at most 12 500 Hz and 5 000 Hz otherwise. Thresholds are unchanged; the
analyzer comparison (5.1) is unchanged at the 5 kHz reference. With the narrow plan both live
overs latch voice within 1.5 s of onset at ×1, ×2 and ×4 (clipped) level; every never-open NFM
fixture stays closed with an ideal onset, a 250 ms noisy onset, every 0-500 ms noise lead-in and
quieted flickers in it. The residual cases of 1.4 grow at the narrow plan only for `nfm-clicks`
(cases (a) and (b) with 3 blocks, case (c) at 30 and 80 ms as well as 10 and 60 ms): a click is a
2π phase step whatever the channel, so it is twice as large relative to a ±2.5 kHz channel.

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

**Known limitation (2026-10-23): residual openings on the never-open NFM fixtures.** The window
reset on carrier onset (design, EvidenceGate) closes the noisy-onset openings of
`nfm-dmr-4fsk-continuous` and `nfm-clicks`; three residual cases remain, pinned by tests in
`tests/unit/core/evidence-squelch/meter-equivalence.test.ts`:

- (a) 10-40 ms of noise flagged quieted touching the onset (the last 1-4 blocks of a 250 ms noise
  lead-in quieted, no unquieted block before the over): `nfm-dmr-4fsk-continuous` latches voice
  with 2-4 such blocks, `nfm-clicks` with 1.
- (b) a 50 ms quieted stretch of noise, then under 50 ms of unquieted noise right before the over
  (20 noise blocks, 5 quieted, then 1-4 noise blocks): `nfm-dmr-4fsk-continuous` latches voice
  with 1-4 blocks, `nfm-clicks` with 1.
- (c) clicks on a quieted carrier: `nfm-clicks` latches voice when only 10 or 60 ms of quiet
  carrier precede it, with no noise at all. Clicks on a quieted carrier can latch from the pinned
  judge alone; this was already so before the window reset existed (verified on gate versions
  before the reset). The moved 50 ms frame edges are enough for the judge to call the first
  window voice.

Every other never-open NFM fixture stays closed in all three cases. Documented consequence of
the reset: a noise lead-in of 10-40 ms (under the 5-block discard threshold) is not discarded and
may play before the over. If live acceptance (M.4) shows real interference opening the gate, a
stage-2 data test becomes the next squelch task, not a backlog item.

1.5 **Latch and close.** Once open, stage 2 stays open for as long as stage 1 is open; pauses
between syllables never close it. It closes once stage 1 has been closed for
`LIVE_AUDIO_AUTO_SQUELCH_HANG_MS` (1 500 ms, equal to `ANALOG_TRANSMISSION_MERGE_GAP_MS`) of
stream time. If stage 1 reopens within that hang, the latch carries over and audio passes at
once. If, during a reopened over, a standard CTCSS tone or DCS code qualifies that differs from
the latched one, the latch is renewed with the new evidence (a new over; audio is not
interrupted). When stage 1 closes before any evidence, the evidence collected so far is
discarded.

**Amendment (2026-10-24, A14): the latch needs carrier evidence to survive.** Live acceptance
showed a CTCSS latch that never released: weak interference about 10 dB over the floor re-opened
stage 1 every 0.5 to 1 s, so every stage-1 close was shorter than the 1.5 s hang (the longest
muted stretch of the client stream in the 93.8 s after the latch is 0.74 s, behind a 200 ms close
guard), so the latch carried from 09:25:48 through the DCS over, the quiet over and the bare
key-up, and the client heard the interference as full-scale noise (about -3 dBFS RMS, up to 34 %
clipped samples) after every over. Revised rule: the hang counts PCM samples, stage 1 open or
closed, since the latched transmission last showed carrier evidence: the PCM after a quieted
block (the existing carrier evidence of 1.3) or its latched tone or code still current. The latch
ends when the hang runs out, also while stage 1 is open; that audio then waits for its own
evidence. A pause inside an over (carrier held, quieted) or a fade of under 1.5 s keeps the latch;
a re-open without carrier evidence does not restart the hang. Without a stage-1 close the tone
stage can keep the last 500 ms CTCSS block current after the tone ends, so the bound is the hang
plus one CTCSS block. A different standard tone or code is new evidence: within the hang it
renews the label (as above); after the hang the over starts from waiting and its label is its
own, never the previous over's.

**Amendment (2026-10-24, A14 revised): tone continuity.** Live testing found that a tone
over with weak quieting lost its latch after a short fade: the re-open reset the tone stage, the
returning tone needed 750 ms to qualify again, and the hang ran out first (2 s of 79.7 Hz
unquieted, 1.2 s closed, the same tone back: `waiting` after 300 ms; also with repeated 10 ms
closes between 600 ms stretches). Revised rule for a latch on a tone or code: (1) a re-open within
the hang keeps the tone stage (a voice latch still resets it); (2) a single sighting of the
latched tone or code is carrier evidence: one completed 500 ms CTCSS block won by the latched
tone, or one DCS word hit with the latched reading; qualification (two blocks, two words, 750 ms
of audio) is still required to latch or renew; (3) while stage 1 is open the hang of a tone latch
runs 250 ms longer (`EVIDENCE_TONE_HANG_GRACE_MS`, one CTCSS hop, longer than one 171 ms DCS word),
so the tone stage gets one more decision before the latch ends; while stage 1 is closed the hang
is unchanged. Bound: a latch outlives its tone by at most the hang + 250 ms + one block straddling
the tone's end. A different tone or code never refreshes the latch (its sightings have another
key): it ends the latch at the hang unless it qualifies first, which renews the label as before.
Bare interference refreshes nothing (a CTCSS block must give the latched tone 0.65 of the band and
3× the next tone; a DCS hit must match a 23-bit word of the latched code).

**Amendment (2026-10-24, A14 revision 2): dated sightings.** Supersedes (1) and the 250 ms of
(3) above. Live testing found that the retained tone stage finished a block holding pre-close tone after
the re-open and counted it as fresh: 2 100 ms of 79.7 Hz, 1 200 ms closed, then noise at amplitude
1 000 ended the latch 3 100 ms after the tone, past the stated bound. Rule now: (1) every re-open
resets the tone stage, so no CTCSS block or DCS word ever spans a stage-1 close and a sighting is
dated by its own block: its tone content is at most one block (500 ms of open audio) old when it
completes; (2) a DCS sighting is a word pair (two matching words 23 bits apart, within 342 ms), not
one word (single words occurred in white noise at amplitude 0.5 about 68 times per hour, 2 of them
023N, and in synthetic voice about 7 times per hour; with pairs, none in 10 min of noise and 5 min
of voice); (3) the open-side grace is 500 ms, one CTCSS block, the time the reset stage needs for
its first block after a re-open. Fade continuity: a same-tone fade survives while (time since the
last sighting at the close, at most 250 ms) + closed time + 500 ms stays under 2.0 s, so fades up
to 1.25 s hold. Bound: a tone latch ends at most `HANG_MS` + 500 ms after its last sighting, so at
most 2.5 s after the tone's last sample while stage 1 stays open, and at most 2.0 s after a close
that ended the tone (measured on the repro across eight block phases and noise at 100 to
3 000: 1.75 to 1.96 s).

**Amendment (2026-10-24, live retest run4): sparse speech; diagnostic status.** On an image with
A13 and A14, two strong plain-voice overs (+1 dBFS, about 5 s) stayed `waiting`; a CTCSS over
latched and released and interference stayed muted. Findings: (1) carrier evidence is not the
cause: the FM quieting of the live saturated CTCSS over, measured on its played PCM, is 30 to 58 dB
per 10 ms block (median 50, none under the observer's 6 dB), and run3's ungated overs replayed
through the real `LiveDemodulator` csdr path (real `ChannelSquelch` power gate and carrier observer
on IQ rebuilt from the PCM phase at +1 dBFS, weak interference re-opens before the over, PCM lag
0 to 500 ms, PCM chunks of 500 to 65 536 bytes) latch voice 1.0 to 2.0 s after onset; (2) the only
live voice in run4 (in the CTCSS over) is sparse: 4 to 5 frames (200 to 250 ms) at -7 to -16 dB
about once a second over a -33 dB floor (speech in about 17 % of frames), so the median audioDb of
every 1 s window is -33 dB at the 2.5 kHz reference and 0 of 109 windows pass the -30 dB audio rule
(syllabic and cluster pass in 86). The voice rule needs speech in at least half of the frames of a
1 s window. The plain overs' audio is not recorded (muted), so this is the leading explanation, not
a confirmation. A 75th-percentile audio rule would pass that speech (36 of 109 windows) but opens
`nfm-clicks` (59 of 61) and bare-carrier windows, so it is rejected; a stage-2 rule for sparse
syllables (for example sustained voice-level runs of at least 150 ms) is the pending decision.
Pinned as a known limitation: 250 ms syllables once a second on a quieted carrier never latch.
Diagnostic (unstable, additive): `GET /api/live-audio/status?diagnostics=true` adds
`autoSquelch.diagnostics` with the verdict in the judge's order, the window medians, the quiet
and noted block counts, the window-reset count, the audio time and the meter's deviation; it is
computed per request from the gate's state (no per-sample or per-chunk work, never on level
events), so the next live test shows which criterion fails.

**Amendment (2026-10-24, A15): sparse-syllable voice.** Decision after the run4 finding above. On
`nfm`, a window is voice when it is not data-like and quiet enough (both unchanged) and either the
pinned median rule passes (median syllabic ≥ 0.3 and median audioDb ≥ -30 dB, the scanner's
`isVoice`, unchanged) or the syllable-run path does: median syllabic ≥ 0.3 and at least two
syllable runs in the last 2 s. A syllable run is at least 3 consecutive 50 ms frames (150 ms), each
at audioDb ≥ -30 dB at the channel's deviation reference (A13) and with sustained energy: at least
5 of its ten 5 ms sub-blocks at that level. The scanner's analog-trial judge is unchanged.
Physics: a syllable nucleus lasts 100 to 300 ms of sustained voiced energy; a click or impulse
lasts a few ms and fills one or two sub-blocks, so it never makes a syllable frame even when it
lifts the frame's mean power (without the sub-block test, `nfm-clicks` at 8 clicks per second
made runs of three adjacent click frames and widened every clicks pin, measured with runs over
the 1 s window: the clicks alignment case went from 10 and 60 ms to 10, 20, 30, 60, 70 and 80 ms); data is rejected by the cluster rule; a
bare carrier has no audio level; a CTCSS leak sits near -33 dB under the 300 Hz high-pass and never
reaches -30 dB. Two deviations from the decision as first written, both measured: (1) the runs
are counted over 2 s (40 frames), not the 1 s window: syllables once a second (run4: 4-5 frame
syllables 19 to 23 frames apart) never put two runs in 20 frames; (2) the sub-block test above.
Results: synthetic run4-pattern speech (225 and 250 ms syllables once a second from the onset over
a -33 dB floor) latches 1.15 s after onset on the run path; 150 ms syllables every 0.8 s latch at
1.0 s; run4's live voice (the CTCSS over's audio) passes the run path in 40 of 112 windows and
first at 2.45 s after onset, at the end of its second syllable (its first syllable, 1.3 s after
onset, is inside the 1.5 s pre-roll at that point), against 0 windows on the median rule. Every
never-open fixture stays closed with an ideal and a noisy onset, over the 0-500 ms lead-in sweep
and under the flicker properties, and no pin of the residual cases moves at either deviation
reference. The `nfm-fsk-syllabic-bursts` fixture still latches at 1.25 s on the median path, but
the FSK-burst limitation widens: on a quieted carrier at the 2.5 kHz reference, 56 of 240
synthetic 2- and 4-level keyings (512 to 4 800 baud) that the median rule left closed now latch on
the run path, all with bursts of 150 to 500 ms and gaps of 250 to 800 ms (a sparse burst train's
median cluster is diluted by its silent frames, and audio-frequency FSK tones are not discrete in
the discriminator). A one-syllable-per-2 s pattern stays closed (one run). This supersedes the known limitation
pinned in the run4 amendment (250 ms syllables once a second now latch).

**Note (2026-10-24, A15 revision, accepted limitation).** Periodic 150 ms audio bursts on a fully
quieted carrier latch through the run path: on a 12.5 kHz channel (gain 2, every block quieted,
a 0.12-amplitude 75.5 Hz floor), 150 ms of 100 Hz click trains (1 ms exponential pulses peaking at
0.8), of seeded ±0.3 white noise, or of a 0.3-amplitude 1 kHz beep once a second all latch at
1.15 s via runs (pinned in `tests/unit/core/evidence-squelch/evidence-gate-live.test.ts`). A
quieted carrier carrying periodic audio is a real transmission, not the weak interference this
feature targets. The run history is bounded: runs more than 2 s apart never add up (pinned with
one syllable every 2.1 s for 10 s).

**Amendment (2026-10-24, A16): tail mute.** Live retest on A13-A15: voice and tones open and
interference and a bare key-up stay quiet, but after each unkey the client heard FM noise until
the latch ended (1.5 s of hang, plus the 500 ms tone grace). Latch memory and audio pass are now
separate. While latched, audio passes only while it carries current carrier evidence: the last
noted block was quieted, for the 200 ms close guard of PCM after it (the back-chain drain, the
same `LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS` that already protects the end of the last syllable
when stage 1 closes), or, on a tone latch, for 300 ms of PCM after a sighting of the latched tone
or code (`EVIDENCE_TONE_PASS_MS`: one 250 ms CTCSS hop plus 50 ms; DCS pairs come every 171 ms;
a stage-1 close ends it). Other latched audio is dropped, not delayed: it is tagged `drop` on its
input samples, so the mute lands on the right samples whatever the pre-roll delay, and the
pre-roll's catch-up removes it. The latch memory (A14) is unchanged, so a re-open with evidence
within the hang resumes without re-qualifying. Arithmetic, with a back-chain lag `L` under the
guard: an unkey passes the over's last `L` and then `200 ms - L` of noise, so the tail is at most
the guard (tested end to end: at most 200 ms + one 10 ms block, the harness noting each block after
its PCM); a speech pause on a quieted carrier keeps passing; an unquieted fade of `F` ms inside an
over loses about `F - 200 ms` of audio when `F > 200 ms` (fades up to 200 ms pass whole; on a tone
latch, audio up to 300 ms after the last sighting passes too).

**Amendment (2026-10-24, A16 revision): the guard follows the computed back-chain lag.** Live run6
showed the 200 ms guard passing 200-210 ms of full-scale FM noise (RMS 16 000-26 000 in 10 ms
blocks) after each over's tail, starting within one block of the carrier drop, plus the back
chain's decay through a fresh 200 ms close guard. `LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS` is now
10 ms (one block) and the core adds the back chain's computed lag (1 sample on the default NFM
chain; filter stages add their delay, design A16 revision); a 10 ms linear fade-out follows the
guard at the sample-accurate mute boundary. The A16 arithmetic becomes: an unkey passes the over's
last `L` (the lag) and then at most `10 ms + 10 ms` of noise, faded; an unquieted fade of `F` ms
inside an over loses about `F - 20 ms` of audio when `F > 20 ms`. A stage-1 close continues the
guard and fade that are left and never starts a new one. Speech ending exactly at the carrier drop
is not clipped: its last `L` samples arrive inside the guard.

**Amendment (2026-10-24, A17): squelch-tail elimination.** The steady tone before the noise in
run6 is a 55 Hz STE tone (Goertzel: about 99 % of the energy at 55 Hz, 0.38-0.40 s, at the end of
every over, toned or not, carrier still up; the user has no roger beep). On `nfm`, while stage 1
is open, a 55 Hz tone that fills a 100 ms block (at least 0.65 of its energy, 3x the 45 and 67 Hz
bins, steady across the block) ends the over: client audio is muted from the tone's onset (at most
25 ms late; retroactively, because the pre-roll still holds those samples) with the 10 ms fade,
the latch ends at once (a later reopen needs fresh evidence), everything after it is muted until
stage 1 closes, and no close guard follows. False alarms: no detection in any evidence-squelch
fixture (voice, CTCSS and DCS voice, data, noise, clicks, impulse), in synthetic voice, or inside
the speech of the recorded live overs (runs 2-4 and 6: detections only at each over's end, never in
run5); 50 and 60 Hz hum, 45 and 67 Hz tones and 55 Hz tones under 100 ms are not detected. Speech
and CTCSS put almost no energy at 55 Hz (voice above 100 Hz, CTCSS 67-254 Hz), and the meter's
300 Hz high-pass is not needed for this (the detector reads the 8 kHz samples before it). The
other common STE form, a CTCSS phase reversal (reverse burst), is a ROADMAP follow-up. Note for
lane TB: the STE onset can serve as the transmission end on radios that send it.

**Amendment (2026-10-24, A17 revision).** Supersedes the detection rule and the hold of
A17 above. (1) A voiced fundamental is not an STE: the STE tone is pure and sent with the
microphone muted, so a block also needs the 110 and 165 Hz bins each at most 0.02 of the 55 Hz
bin (-17 dB in power, 0.14 in amplitude) and the 300-3 000 Hz energy at most -15 dB relative to
the 55 Hz tone's energy. Measured on the live STE segments (runs 2, 3, 4 and 6): harmonics at most
0.006 and 0.0016, voice band -18.5 to -28.7 dB in steady blocks (edge blocks up to -9.9 dB are
rejected, and every over end is still detected: run2 4 of 4, run3 2 of 2, run4 1 of 1, run6 4 of
4); the voiced repro (0.12 (sin 55 + 0.3 sin 110 + 0.2 sin 165)) has 0.143 and is
rejected; no detection in any fixture, in synthetic voice, or in the private live clips. (2) A
false STE is not terminal: after an STE, client audio is held (pending) until stage 1 closes or
fresh evidence qualifies (voice on either path, or a tone), whichever comes first; on fresh
evidence the latch resumes and the held audio plays. (3) The tone must fill the block, measured
on the 55 Hz bin itself: the 55 Hz phasor magnitudes of the four 25 ms quarters agree within 0.6.
A CTCSS tone continuing through the STE at 0.2 of its amplitude leaves them within 0.64 (67 Hz),
0.70 (71.9 Hz) and 0.74 (79.7 Hz) and is detected; 0.3 of its amplitude is detected too. The
guarantee is revised: a 55 Hz tone under 90 ms never qualifies, whatever follows it (silence or
noise; 85 ms padded: no detection), and one of 125 ms or more always does. (4) The retroactive
mute starts at the exact input sample of the qualifying block's start (the gate dates it by its
own input-sample count), whatever the chunking. (5) Split samples are faded too: the bytes of a
sample that arrive in a later chunk carry the scaled value (s16: its first byte keeps its value,
at most 255 LSB).

**Note (2026-10-24, A17 revision 2).** (1) Known limitation, accepted: a near-pure low voiced
sound can pass the STE rule, for example 58 Hz with its 2nd and 3rd harmonics at 0.14 amplitude
(0.02 power, the bound) and a 0.05 8th harmonic, or a 55 Hz tone under speech at level 0.01. The
thresholds stay as measured (live STE harmonics reach 0.006 power). The cost is bounded and not
terminal: the audio from the detected onset to the detecting sample is dropped (one STE block,
100 ms, plus at most one 10 ms slice, with a 10 ms fade before it), the rest is held, and fresh
evidence resumes the over. Both repros are pinned as tests. (2) The detection bound of the
revision above is corrected: for a tone starting at zero phase, swept over every block
alignment in 1-sample steps with silence or noise padding, a 55 Hz tone of 623 samples at 8 kHz
(77.9 ms) or less never qualifies and 847 samples (105.9 ms) or more always qualifies. These are
not hard guarantees: the starting phase shifts both (a 623-sample tone at phase π/16 can qualify,
an 847-sample tone at phase 6π/16 can miss), so the detection boundary is a band of roughly
75-110 ms rather than an exact duration. Real STE tails (about 0.4 s) are far above it.

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
Amendment A12 (2026-10-23): superseded. The evidence gate and pre-roll run on csdr runs only;
Rust runs in `auto` keep the stage-1 auto squelch, byte-identical (see the amendment after 1.2).
Amendment A18 (2026-10-24): superseded for framed Rust runs, which run the gate and pre-roll (9.8).

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
Amendment A13 (2026-10-24): on a 12.5 kHz channel (the default bandwidth) the meter normalises
the ±2.5 kHz plan, and the synthetic marginal voice latches with its first window (1.0 s) and
plays from its first sample. The limitation stands for channels wider than 12.5 kHz.

8.2 **Fake-link scenario (early).** The same fixtures as IQ through a scratch core fed by the fake
`rtl_tcp`, on the default csdr engine and on Rust: open and no-open verdicts as 8.1, played audio
aligned with the over's onset, delay at most 1.5 s, stream byte rate nominal, transmission events
identical to a manual-mode run, event-loop p99 within 6.1.
Amendment A12 (2026-10-23): on Rust, the NFM auto runs assert the stage-1 auto path (as AM
under A8): `autoSquelch` `off` and an auto stream equal to the stage-1 stream. The open, no-open,
onset and delay verdicts apply on csdr only until the Rust audio carries in-band gate markers.
Amendment A18 (2026-10-24): superseded for framed Rust runs (9.11).

8.3 **Live (Main with the user).** On a real PMR handheld: overs with CTCSS, DCS and no tone are
heard from their first syllable; a short key-up with no speech and no tone, a silent held carrier
and the channel's interference stay muted; the stream catches up after each over; transmissions
and Activity unchanged; desktop CPU and event-loop p99 recorded.

8.4 The AM voice fixture opens with the AM default chain (fast AGC). If it cannot at the pinned
thresholds, the lane reports the measured statistics and Main decides between a measured AM
threshold and leaving AM on stage 1 only; the decision is recorded here as an amendment.

**Resolved (2026-10-23, A8): AM stays on stage 1 only.** See the amendment after 1.2.

## 9. Rust in-band gate markers (amendment A18, 2026-10-24)

**Amendment (2026-10-24, A18): the evidence gate and pre-roll run on framed Rust runs.** A12 kept
Rust NFM `auto` on the stage-1 auto squelch because the Rust audio socket carries raw PCM and the
stage-1 gate changes arrive on stdout, out of step with it. A18 adds in-band stage-1 markers to
the Rust audio socket, negotiated per run, so that the evidence gate and pre-roll see stage 1 at
the audio's own sample position. A framed Rust NFM run in `auto` then gives the same verdicts as
csdr for the same audio and the same stage-1 timeline. An unframed run (an older binary, or a run
whose framing failed safe) keeps the A12 behaviour exactly. The wire format and the TypeScript
consumer are in the design (Rust in-band gate markers, A18). This amendment supersedes, for
framed runs only: the A12 amendment after 1.2, the A12 amendment under 1.10, the A12 amendment
under 8.2, the "csdr engine only" qualifiers in "What changes for the user" and Scope, and the
Scope's "the Rust demod kernel (it keeps only stage 1)" (the kernel still has stage 1 only; it
gains marker emission). For unframed runs every A12 statement stands.

9.1 **Negotiation.** A binary that supports markers reports `protocol 3` on `--version`. The core
requests framing (`audioFraming: "wkaf1"` on the demod `open`) only when the probe reported
protocol 3 or later, and on every such Rust run regardless of modulation and squelch mode, so a
later in-place switch into `auto` (1.11) needs no restart. The run is framed only when the
`opened` event echoes `audioFraming: "wkaf1"`. A binary reporting protocol 2 gets the
protocol-2 `open`, byte for byte, and the run is unframed.
Acceptance: a protocol-2 fake binary receives an `open` byte-identical to today's and its run
reports `autoSquelch` `off`; a protocol-3 fake that omits the echo gives an unframed run that
parses the socket as raw PCM; a protocol-3 fake that echoes gives a framed run.

9.2 **Wire format.** A framed socket starts with a 16-byte preamble and then carries only frames
(8-byte header, then payload), little-endian, as specified in the design. Frame types: PCM, gate
open, gate close, input-gap reset, queue drop, block metrics; type values 0x8000 and above are
ignorable. Every marker carries the absolute output-sample index it applies at. A marker applies
at the sample boundary between the PCM before it and the PCM after it in the stream; its index
equals the number of output samples (delivered plus dropped) before that boundary.
Acceptance: Rust unit tests decode emitted streams and find each marker at the exact sample index
of its stage-1 change, for changes at the first and last sample of a block, at an input-buffer
boundary, inside a single-sample `process` call, after a `squelch` request, after a retune and
after a reset.

9.3 **Completeness.** In a framed run every change of the Rust stage-1 gate state, from any
cause (block decision, `squelch` request, retune, reset, mode change), is marked; every input-gap
reset is marked with the gate state after it; every queue-overflow drop run is marked with its
first sample, its length and the gate state at its end; every completed 10 ms block is marked with
its power and quieting figures. PCM payload bytes are those the unframed run would write, byte for
byte, for every accepted sample.
Acceptance: for random input, squelch and drop schedules (Rust property test), stripping the
frames gives the unframed run's bytes with dropped samples removed, and replaying the markers
gives the gate history of the stdout `gate` events.

9.4 **Bounds.** The preamble is 16 bytes. A PCM payload is 1 to 65 536 bytes and a whole number of
samples. A marker payload is at most 64 bytes, and a known marker type has exactly its specified
length. Rust never writes a frame past a bound; the consumer holds at most 16 bytes of header or
marker state across chunks and never allocates per byte.
Acceptance: tests at each bound and one past it (PCM 65 536 and 65 538 bytes, PCM 0 bytes, PCM of a
partial sample, marker payload 64 and 65 bytes, a known type at its length plus and minus one).

9.5 **Unknown types.** A well-formed frame of an unknown type with a payload of at most 64 bytes
is skipped. If the type is ignorable (0x8000 or above) nothing else happens. If it is below
0x8000 the run fails safe (9.6, marker error) because the marker may change the gate.
Acceptance: an ignorable unknown frame between PCM frames leaves the client bytes and verdicts
unchanged; an unknown type below 0x8000 fails safe at its position.

9.6 **Fail safe.** Two classes of error, each logged once per run at `warn` with safe fields only
(an enumerated reason, the numeric frame type when known, and the stream byte offset), never any
received bytes:
(a) Marker error: framing intact but a marker cannot be trusted (index not equal to the stream
position, a gate open while open or close while closed, an unknown type below 0x8000). From that
position the gate counts as closed: the evidence gate is reset, the pre-roll is cleared (held
audio is dropped, never played), and the rest of the run is the A12 stage-1 auto path (the Rust
PCM as delivered), with `autoSquelch` `off`. Later markers are parsed for framing only.
(b) Framing error: the preamble is wrong (magic, version, length, rate, format or reserved
bytes), or a header breaks 9.4, or a reserved field is not zero. No later byte is trusted: the
run writes no further Rust bytes to clients (the silence fill runs as for a stalled source), the
evidence state is reset and cleared as in (a), and the run ends through the existing Rust failure
path, as a closed socket does today.
Acceptance: each listed malformation, injected at a random position and chunking, produces the
class above, at most one log line with only the safe fields, no played byte from the pre-roll
after the error, and (b) no client byte after the error offset.

9.7 **Chunk independence.** The consumer gives the same PCM bytes, markers and marker positions
for any split of the socket stream into chunks, including splits inside the preamble, a header, a
marker payload and a sample.
Acceptance: fast-check property, `numRuns` at least 100, over random framed streams and random
chunk splits (including 1-byte chunks), compared with a one-chunk parse.

9.8 **Same verdicts as csdr.** On a framed Rust NFM run in `auto` with no tone squelch, the
evidence gate and pre-roll take stage-1 state per sample from the markers, block carrier evidence
from the block markers, and stage-1 edges from the gate markers, in stream order. For the same
PCM, the same stage-1 open and close samples and the same per-block carrier evidence, the
framed-Rust path and the csdr path give the same verdicts: latch sample and evidence, first played
sample (the over's onset, requirement 2.1), pre-roll start, tail end (guard and fade, A16), STE
detection and mute start (A17), and the same tagged output bytes.
Acceptance: a differential test feeds synthetic overs (CTCSS voice, DCS voice, plain voice, bare
carrier, data-like, an STE tail, two overs inside the hang, a drop and a reset inside an over)
through both paths and asserts equal verdicts and equal client bytes.

9.9 **Status and contract.** `autoSquelch` on a framed Rust NFM `auto` run reports `waiting` and
`open` as on csdr; on an unframed or failed-safe run it reports `off`. No field is added or
renamed in the status, the level event, `packages/api-types`, the web UI or the CLI.
`squelchOpen`, transmissions, Activity, tone results, recordings and decoders keep following the
stdout events exactly as today (1.6).
Acceptance: status tests for framed, unframed and failed-safe runs; the existing contract tests
pass unchanged.

9.10 **Performance.** Marker overhead stays within the design's A18 budget: at most 9 % of the
PCM byte rate at s16 (worst case) and under 0.001 core for parsing on the desktop; the PCM payload
is forwarded as views, never copied by the parser.
Acceptance: the bench of 6.2 reports parse cost per second of audio and the framing overhead
bytes per second on a framed run.

9.11 **Acceptance updates.** 8.2's open, no-open, onset and delay verdicts apply on Rust for
framed runs (superseding the A12 amendment under 8.2 for them), and the fake-link scenario runs
the Rust leg with a protocol-3 binary; one Rust leg with a protocol-2 binary asserts the A12 path.
The Rust-engine onset finding (design) is fixed for framed runs when 9.8 passes.
