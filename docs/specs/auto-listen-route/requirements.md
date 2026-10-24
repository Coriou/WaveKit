# Auto listen route requirements

Status: design, not implemented (2026-10-24). See [design](design.md) and [tasks](tasks.md).

## What changes for the user

- **One stream that plays whatever is on the channel.** The live-audio HTTP server gains
  `GET /auto` (and `/auto.wav`): analog audio while the analog squelch lets the over through,
  decoded digital voice while a digital voice decoder covering the tuned channel produces voice
  frames, and exact silence otherwise. An analog over followed by a DMR over on one channel plays
  both, each from its start.
- **One fixed format.** `/auto` is always 48 000 Hz, s16le, mono. It never changes rate when the
  analog pipeline restarts, the modulation changes or the source rate changes, so clients are
  never disconnected for a format change.
- **Status says what is playing.** Live-audio status gains an optional `autoRoute` object with
  the active source (`analog`, `digital` or `none`) and, for digital, the protocol, decoder and
  slot, plus the stream URLs.
- **Nothing else moves.** `/stream`, `/stream.wav`, the digital voice server and all their
  formats, defaults, latencies and bytes are unchanged. Transmissions, Activity, recordings,
  identify and decoders are untouched. With no `/auto` client, the route costs nothing.

## Scope

The live demodulator's HTTP stream server (`src/core/live-demodulator.ts`,
`src/core/audio-stream-server.ts` used as is), the digital voice service
(`src/core/digital-voice.ts`), the live-audio REST status (`src/api/routes/live-audio.ts`), the
shared DTOs (`packages/api-types/src/live-audio.ts`), the evidence squelch's client-audio
semantics ([evidence-squelch](../evidence-squelch/requirements.md), read only) and the
[performance rules](../../PERFORMANCE.md).

Out of scope: any change to the evidence squelch, its pre-roll or constants; the analog
transmission tracker; a WebSocket audio transport (the web player consumes HTTP PCM through
`fetch` with `X-Audio-Format` and `X-Sample-Rate`, so HTTP is what it expects); new config keys;
mixing two sources at once; the web UI and the CLI (coordination note only); new dependencies.

Hard gates for implementation: no RF, tuning, receiver or Raspberry Pi work, no Docker. Unit
and acceptance tests are in-process with synthetic PCM, fake decoders and injected clocks. Live
acceptance is run by the maintainer.

## 1. Transport

1.1 **Route.** The live demodulator's audio HTTP server serves `GET /auto` (raw PCM) and
`GET /auto.wav` (streaming WAV header, then the same PCM) next to `/stream`. Any other path keeps
today's 404.

1.2 **Same access model.** `/auto` is admitted by the same `AudioHttpServer` and access adapter
as `/stream`: protected mode requires the same session and stream lease and applies the same
CORS and credentials rules; legacy mode answers the same credential-free wildcard CORS and
`OPTIONS` preflight. No new port, listener or policy.

1.3 **Headers.** Responses carry `X-Audio-Format: s16le`, `X-Sample-Rate: 48000`,
`X-Channels: 1` via the existing `streamHeaders`.

1.4 **Lifetime.** `/auto` is available while the live-audio HTTP server listens, whether or not
the analog pipeline runs. A client stays connected across pipeline restarts, retunes, modulation
and squelch changes, source rate changes and digital voice decoder starts and stops; it is
closed only by the existing stall timeout, server stop or shutdown admission.

1.5 **Slow clients.** The existing per-client queue bound and stall disconnect apply unchanged.

## 2. Output format

2.1 The output is 48 000 Hz, s16le, mono, fixed (`LIVE_AUDIO_AUTO_ROUTE_RATE`,
`LIVE_AUDIO_AUTO_ROUTE_FORMAT`), independent of `audioFormat` and of the analog rate.

2.2 Analog audio (s16le or f32le at the pipeline rate, any rate from 8 000 to 200 000 Hz) and
decoded voice (8 000 Hz s16le mono) are resampled to 48 000 Hz. f32le is clamped to [-1, 1] and
scaled by 32 767 with round-half-away-from-zero.

2.3 Resampling has a passband to at least 0.4 × min(input, output) rate with ripple within
±0.5 dB, and attenuates images and aliases above 0.5 × min(input, output) by at least 50 dB.

2.4 No per-chunk allocation in steady state: resampler state, filter tables, FIFOs and
qualification runs are preallocated when the route is created or the input rate changes;
chunk-split remainders are carried in fixed scratch buffers. The only steady-state allocation is
the output block of 2.8.

2.5 Resampled output is chunk-split invariant: for any split of one input into chunks, the
emitted samples are identical.

2.6 Output is paced at 48 000 samples per second of monotonic time in 20 ms blocks
(960 samples), tracked against the start time, so it never drifts while ticks are late by at
most `LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS` blocks (100 ms); while no source is selected the
blocks are exact zeros.

2.7 **Bounded catch-up.** One tick emits at most `CATCHUP_MAX_BLOCKS` blocks. When the pacer
is further behind (an event-loop stall), it emits that many and rebases its start time so it is
no longer behind, counting `autoRoute.clockRebases`. A rebase is a timing discontinuity only: no
queued source sample is dropped or repeated, the backlog grows by the stall and is removed by
4.7. Backlog is bounded by the per-source FIFO cap.

2.8 **Output buffer ownership.** Every buffer handed to the `/auto` client registry is owned by
the registry from then on and is never written again by the router (the registry queues the
reference and the socket may retain it until it drains or the client is closed). Each 20 ms
output block is a fresh 1 920-byte buffer.

## 3. Sources and qualification

3.1 **Analog qualifies** sample by sample while the bytes the live demodulator writes to `/stream` clients are
audible by the squelch that governs them:
(a) evidence path active (`autoSquelch.state` not `off`): exactly the output samples the
pre-roll plays (its `pass` and `guard` output, including the final drain after a close);
delayed samples still `pending` or tagged `drop` do not qualify;
(b) a configured tone squelch: per tone slice, while that slice is not muted;
(c) `manual` or `noise` mode, and auto mode outside the evidence path: while the squelch gate is
open (`squelchOpen`, the external gate on Rust runs).
The router receives the exact client bytes, already muted where the governing squelch mutes, so
the analog audio heard on `/auto` equals `/stream` resampled.

3.2 **Digital admission.** A decoder's voice frame is admitted when, at its arrival, the
decoder covers the tuned channel (3.4) and has an active call that is not wholly muted for
encryption. A decoder qualifies while it has admitted a frame within
`LIVE_AUDIO_AUTO_ROUTE_DIGITAL_HOLD_MS` (300 ms). Datagrams are taken after the service's
encryption muting, so encrypted audio is never routed.

3.3 **Voice frames reach the router without a digital voice client.** The digital voice service
delivers voice to the router while `/auto` has a client, even when its own `/stream` has none. Its
own streams, pacing and counters are unchanged.

3.4 **Coverage.** A decoder covers the channel only when a coverage port injected by the
application answers `yes`: the live tuned frequency and the settled VFO agree (no retune
pending), and a running placement on the live source has its channel within half the channel
bandwidth of it, or, without placements, a configured target is within it and the decoder's
source is the live source. `unknown` (missing data, pending retune, error) is treated as not
covered. Without a coverage port or a digital voice service, `/auto` routes analog only and
`autoRoute.digitalAvailable` is `false`.

3.5 **Several decoders and slots.** dsd-fme's stereo slots are already mixed to one mono
stream per decoder (encrypted slots muted). When several covering decoders qualify, the one
selected first stays selected until it releases (stickiness); otherwise the one whose queued
voice is oldest wins, ties by decoder id in code-unit order. Only one source is heard at a time;
sources are never mixed.

3.6 **Sample-aligned spans.** Analog qualification is delivered to the router in sample-aligned
spans, one per decision of the governing squelch, so a chunk spanning an open, a close, a tone
slice change or the final pre-roll drain qualifies exactly its playing samples. This is derived
without changing `src/core/evidence-squelch/**`.

## 4. Switching rules

4.1 **Priority.** Digital beats analog beats none: while a digital source qualifies, it is the
next source to play.

4.2 **No doubled audio.** Every input sample of every source is emitted at most once.

4.3 **No dropped audio inside an over.** Each source has a bounded FIFO
(`LIVE_AUDIO_AUTO_ROUTE_FIFO_MS`, 3 000 ms) of resampled audio. A source's audible samples queue
whether or not it is selected; its inaudible samples are discarded while it is not selected. A
switch starts the new source at its oldest queued audible sample. Audible samples are dropped
only on FIFO overflow (oldest first, counted in `autoRoute.droppedMs`) or on a reset (5.1).

4.4 **Release before handover.** The selected source keeps playing until it releases:
analog releases after it has been inaudible for `LIVE_AUDIO_AUTO_ROUTE_ANALOG_RELEASE_MS` (300 ms)
and its FIFO holds no audible sample; digital releases after it has stopped qualifying for
`LIVE_AUDIO_AUTO_ROUTE_DIGITAL_RELEASE_MS` (300 ms) and its FIFO is empty.

4.5 **Preemption bound.** When digital qualifies while analog is selected and analog has not
released within `LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS` (1 500 ms, equal to
`LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS`) from the digital source's first queued sample, digital
preempts: analog's remaining queued audio is dropped and counted. Digital is never preempted
by analog.

4.6 **Digital start buffer.** A digital source starts playing when
`LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS` (200 ms) of voice is queued or its first sample has
waited that long, so datagram bursts do not underrun at the start of a call.

4.7 **Catch-up.** Backlog accumulated by a handover is reduced only by discarding inaudible
samples of the selected source (silence between overs, or between datagram gaps that the
service already fills as silence) while its backlog exceeds
`LIVE_AUDIO_AUTO_ROUTE_TARGET_MS` (60 ms). The stream never speeds up, slows down or skips audible
samples to catch up.

4.8 **Underrun.** When the selected source's FIFO is empty, the block is filled with zeros and
`autoRoute.underruns` counts it; audio resumes from the next queued sample.

4.9 **Hysteresis.** After a handover the newly selected source plays for at least its release
time before another switch, except a preemption under 4.5.

4.10 **Admission versus drain.** Admitted digital audio stays eligible to play after its call
ends and its hold expires, until it is played or invalidated, so a short digital over that
starts and ends while the analog source is still releasing plays in full afterwards. Queued
digital audio of a decoder is invalidated (cleared, counted in `droppedMs`) when its call turns
encrypted (even with no further datagram), its voice channel detaches, the coverage epoch
changes (retune, offset or source change), coverage stops being `yes`, or it is older than
`FIFO_MS`. The digital voice service notifies the router of every call change and detach.

## 5. Resets

5.1 A retune, offset change, modulation change or pipeline stop clears the analog FIFO and the
analog resampler state; a decoder detaching or no longer covering clears its FIFO; when the
selected source is cleared, the route goes to `none` and re-selects on the next block.

5.2 An analog rate or format change rebuilds the analog resampler for the new rate without
affecting `/auto` clients or the digital FIFOs.

## 6. Status contract (additive)

6.1 `LiveDemodStatus` gains optional `autoRoute`, present whenever the HTTP server listens:
`{ active: "analog" | "digital" | "none"; protocol?: string; decoderId?: string;
slot?: number | null; since: string; httpUrl: string; wavUrl: string; clientCount: number;
digitalAvailable: boolean; underruns: number; droppedMs: number; clockRebases: number;
latencyMs: number }`.
`protocol`, `decoderId` and `slot` are present only when `active` is `digital` (`protocol`
omitted when the call reports none). `latencyMs` is the selected source's current backlog plus
one block. URLs follow the `/stream` URL rules (`publicOrigin`, legacy rewrite).

6.2 `LiveAudioLevel` gains optional `autoRoute: { active; protocol? }` while `/auto` has a
client, a fresh object per level.

6.3 The REST status response schema in `src/api/routes/live-audio.ts` declares `autoRoute` so
the field is not stripped. Existing fields keep their values and shapes.

6.4 A change of `active` (or of the selected digital decoder) emits one `auto-route-changed`
event on the live demodulator per switch, so any future status push stays bounded by switch
count.

## 7. Defaults and compatibility

7.1 Without an `/auto` client, the router's pacer is stopped, the analog tap is not called, no
voice tap is registered, and the CPU cost is a branch per chunk.

7.2 `/stream`, `/stream.wav`, the digital voice `/stream` and `/decoders/<id>/stream` bytes,
headers and timing are byte-identical with and without `/auto` clients (golden tests).

7.3 No config key is added; all constants live in `packages/api-types/src/live-audio.ts`.

## 8. Performance

8.1 Steady-state cost with one `/auto` client stays within the budget table in the design and
is proven by a bench under `scripts/bench/` before landing.

8.2 Router work runs on the event loop in at most one 20 ms block per timer tick plus per-chunk
resampling; no single call exceeds 1 ms at 200 kHz analog input on the desktop reference host.

## 9. Acceptance

9.1 **In-process fake-link fixture.** One test drives a fake analog pipeline and a fake digital
voice decoder on one channel: a 3 s analog over (evidence path, delayed by pre-roll), 0.5 s
gap, then a 3 s DMR call (8 kHz voice datagrams in 20 ms frames, slot 1), then 1 s silence. The
`/auto` output equals, sample for sample within resampler tolerance, the analog over from its
first audible sample, then the digital call from its first voice sample, with zero overlap, no
repeated sample and zeros elsewhere; status reports `analog`, then `digital` with
`protocol: "DMR"`, then `none`.

9.2 The fixture also covers: digital arriving while the analog tail drains (handover without
loss), a stuck-open manual squelch (preemption at 1.5 s, drop counted), an encrypted call (never
routed), two covering decoders (stickiness), and a pipeline restart with a connected client
(client kept, rate unchanged), a short (0.5 s) digital over wholly inside the analog handover
delay (played in full afterwards), clear then encrypted with audio queued and no further
datagram (nothing more routed), a retune with digital audio queued (dropped), chunks spanning
open, close and the final pre-roll drain (sample-exact), an event-loop stall (one rebase, no
sample lost or repeated) and a delayed client drain (blocks intact).

9.3 **Live plan.** The maintainer runs the live test plan in the design on the real receiver.
