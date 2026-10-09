# Digital Voice Audio

WaveKit turns the voice that dsd-fme decodes (AMBE+2 / IMBE through mbelib) into
a continuous audio stream with per-call metadata, the same way live analog audio
works ([ROADMAP §5b](ROADMAP.md#5b-digital-voice-audio)).

| Protocol                            | dsd-fme mode                       | Status                                                                                                       |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| DMR (MS/direct and BS/repeater)     | `auto`, `dmr`                      | Target protocol. Call metadata verified over the air on 2026-10-09; voice audio over the air still to verify |
| YSF                                 | `auto`, `ysf`                      | Voice datagrams verified on the SDRangel fixture (format spike below)                                        |
| P25 phase 1, D-STAR, NXDN, ProVoice | `p25`, `dstar`, `nxdn`, `provoice` | Unverified until fixture or over-the-air proof                                                               |
| dPMR                                | (not mapped; dsd-fme `-fm`)        | Not supported                                                                                                |

Encrypted calls are never decrypted: WaveKit passes no key options (`-1`, `-2`,
`-H`, `-S`, and so on). They give silence plus `encrypted: true`.

## Using it

Digital voice is on by default (`digitalVoice.enabled: true`, the single
constant `DIGITAL_VOICE_ENABLED_DEFAULT` in `src/config.ts`). Every dsd-fme
decoder whose options leave `output` unset streams voice:

```bash
ffplay -nodisp -fflags nobuffer -flags low_delay http://localhost:8082/stream.wav
# or raw PCM
curl -s http://localhost:8082/stream | ffplay -f s16le -ar 8000 -ch_layout mono -i -
```

| Endpoint (port `digitalVoice.httpPort`, default 8082) | Serves                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| `/stream`, `/stream.wav`                              | the first dsd-fme decoder in config order           |
| `/decoders/<id>/stream`, `/decoders/<id>/stream.wav`  | one dsd-fme decoder (URL-encoded id)                |
| `GET /api/digital-voice/status` (API port)            | format, per-decoder counters, current and last call |
| `POST /api/digital-voice/start` / `stop` (API port)   | stream server control                               |
| WebSocket channel `digital-voice`                     | `digital-voice:call`, `digital-voice:status`        |

The stream format is mono s16le at 8000 Hz for the stream's whole life, so
clients are never disconnected between calls. Static facts travel in the HTTP
headers (`X-Audio-Format`, `X-Sample-Rate`, `X-Channels`); call metadata travels
on REST and WebSocket only, with no in-band framing.

Why a separate port with per-decoder paths: the live analog server is tied to one
CSDR pipeline and disconnects clients when its rate changes. The digital voice
rate never changes, and there can be several dsd-fme decoders (one per channel
offset), so each gets its own path, and `/stream` stays the short name for the
usual single-decoder setup. Both servers share `src/core/audio-stream-server.ts`
(client registry, about one second of drop-oldest queue per client, 30 s stall
disconnect, stream and WAV headers).

### Configuration

```yaml
digitalVoice:
  enabled: true # DIGITAL_VOICE_ENABLED_DEFAULT
  httpPort: 8082
  voiceSlot: "both" # 1 | 2 | "both" -> dsd-fme -V 1|2|3
  jitterBufferMs: 250 # voice buffered (or waited for) before a burst plays
  maxBufferMs: 1000 # bound per stream; the oldest voice is dropped beyond it
```

Environment overrides follow the usual convention:
`WAVEKIT_DIGITAL_VOICE__ENABLED=false`, `WAVEKIT_DIGITAL_VOICE__HTTP_PORT=8082`,
`WAVEKIT_DIGITAL_VOICE__VOICE_SLOT=1`.

Per-decoder dsd-fme options:

| Option                                                                  | Effect                                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output` unset                                                          | Stream to the digital voice stream (dsd-fme `-o udp:127.0.0.1:<ephemeral port>`)                                                                           |
| `output: "null"`                                                        | Call metadata only (opt out)                                                                                                                               |
| `output: "udp"` + `udpHost` + `udpPort`                                 | Send voice to your own listener (not the stream)                                                                                                           |
| `output: "wav"` + `wavDir`                                              | Per-call WAV files, no live audio (now `-7 <dir> -P`; it used to pass the single-file `-w`)                                                                |
| `voiceSlot`                                                             | Overrides `digitalVoice.voiceSlot` for this decoder                                                                                                        |
| `enablePerCallRecording`, `perCallRecordingDir`                         | Per-call WAVs alongside the stream (`-7 <dir> -P`), default off                                                                                            |
| `perCallRecordingMaxTotalMb` (512), `perCallRecordingMaxAgeHours` (168) | Retention: expired files are deleted, then the oldest until the total fits; files written in the last 10 s are kept. Runs at start and 2 s after each call |

Only decoders configured at startup are routed (the API cannot create decoders).
`digitalVoice.enabled: false` keeps dsd-fme on `-o null`, and `POST
/api/digital-voice/start` then answers 409.

## How it works

```
dsd-fme -o udp:127.0.0.1:P  --UDP (bursty, 20 ms datagrams)-->  socket (SO_RCVBUF 32 KiB)
   --> validate + mix to mono --> PacedPcmStream (jitter buffer, bounded)
   --> 20 ms timer: exact 8000 samples/s, silence when empty --> HTTP clients
dsd-fme stderr --> call_start / call_end + "voice-call" event --> call state
```

- **Pacing**: a 20 ms timer emits exactly `8000 * elapsed` samples, tracked
  against its start time so it never drifts. After an event-loop stall of more
  than 1 s it resynchronises instead of bursting. The timer runs only while the
  stream has a client; with no client, datagrams are counted and discarded.
- **Jitter buffer**: after silence, a burst plays once `jitterBufferMs` of voice
  is queued or the first datagram has waited that long. Beyond `maxBufferMs` the
  oldest voice is dropped (`droppedSamples`).
- **Mixing**: in auto and DMR modes datagrams are stereo, slot 1 left and
  slot 2 right. Identical channels (one slot active, or a non-TDMA call) pass
  through, a zero channel (a muted slot) is ignored, and two active slots are
  averaged so they cannot clip. Per-slot streams are deferred; use `voiceSlot` to
  pick one.
- **Call state**: the decoder's `call_start` / `call_end` stay authoritative.
  dsd-fme publishes a `voice-call` event in the same tick as each of them
  (`emitOutput`), plus one when a running call turns out encrypted. The stream
  maps these to `digital-voice:call` (`decoderId`, `callId`, `protocol`,
  `talkgroup`, `source`, `slot`, `encrypted`, `active`, `startedAt`, `endedAt`).
- **Encryption**: DMR from the link control (`Encrypted`, service option bit
  0x40, or a non-zero `ALG ID`), P25 from `ALG ID` (0x80 means clear). While the
  current call is encrypted, its datagrams are discarded and queued voice is
  cleared. dsd-fme also mutes encrypted voice by default.

## Spike: dsd-fme UDP format (2026-10-09)

The `-o udp` payload is undocumented, so it was measured on the pinned build
(dsd-fme `ed1d1d6`, mbelib 1.3.0) in a throwaway
`docker run --rm --network none wavekit:local-core` container.

**Method.** The SDRangel YSF fixture (`fixtures/raw/sdrangel_dsd`, s16le IQ at
75 kHz, about 16 s) was fed in real time by a throttled reader (300 000 B/s in
20 ms ticks), through the same stages the core uses: `csdr convert -i s16 -o float
| csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox ...
-t wav -r 48000 - | dsd-fme -i /dev/stdin -o udp:127.0.0.1:23456`. A Node UDP
listener in the same container recorded each datagram's arrival time and payload.

**Results.**

|               | `-fa` (auto)                                                                                                   | `-fy` (YSF only)        |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Datagram size | 640 bytes, always                                                                                              | 320 bytes, always       |
| Payload       | s16le stereo, 160 frames, L == R                                                                               | s16le mono, 160 samples |
| Rate          | 8000 Hz: 355 datagrams x 20 ms = 7.10 s of audio over a 7.20 s burst span (31 549 B/s stereo, 15 785 B/s mono) | same                    |
| Cadence       | bursts: median gap 1.1 ms inside a burst, p99 209 ms, max 211 ms between bursts                                | p50 1.3 ms, p99 210 ms  |
| Between calls | nothing is sent                                                                                                | nothing is sent         |

The first 5 datagrams of a call were all zero. Trimmed captures are in
`tests/mocks/fixtures/dsd-fme/udp-ysf-auto-stereo.{bin,txt}` (75 datagrams) and
`udp-ysf-mono.{bin,txt}` (50 datagrams).

**Slot behaviour** (from the pinned source, `dsd_audio2.c` and `dsd_main.c`;
there is no DMR IQ fixture yet): `-fa`, `-fs` (DMR) and `-ft` set 2 output
channels at 8000 Hz, and `-f1`, `-fy`, `-fd`, `-fn`, `-fi`, `-fm`, `-fp` set 1.
The UDP option changes neither. DMR audio goes through `playSynthesizedVoiceSS3`:
three 640-byte stereo writes per 60 ms burst, slot 1 left and slot 2 right. When
only one slot is enabled the active slot is copied to both channels; a muted slot
is zero-filled, and nothing is sent when both slots are muted. `-V` sets
`slot1_on` / `slot2_on` (default both). If dsd-fme cannot open the UDP socket it
falls back to PulseAudio; on loopback that cannot happen in practice.

### CPU cost

dsd-fme CPU was measured in the same container: utime + stime from
`/proc/<pid>/stat` between t = 2 s and the end of a 64 s real-time loop of the
fixture (about 27 s of decoded voice per run), alternating runs on the shared,
loaded Mac (load average about 6 on 8 cores).

| Run         | `-o null`          | `-o udp`      |
| ----------- | ------------------ | ------------- |
| `-fa` run 1 | 4.03 % of one core | 4.21 %        |
| `-fa` run 2 | 3.80 %             | 4.01 %        |
| `-fy`       | 4.26 %             | 4.17 %        |
| Peak RSS    | 17.6-17.9 MiB      | 17.7-18.2 MiB |

`-o udp` costs about +0.2 percentage points of one core in auto mode, within run
to run noise for YSF: the equal cost shows dsd-fme synthesises voice with `-o null` too, so the extra
work is one `sendto` per 20 ms.

On the Node side (in-process benchmark, 10 s per phase, same loaded Mac; the
figures include the benchmark's own UDP sender and HTTP reader): about 2.7 % of
one core for one listener and silence, 4.5 % for one listener and continuous
voice, and 1.9 % with continuous voice and no listener (mostly the sender: with
no listener the stream runs no timer). These are upper bounds; on an idle host
they will be lower.

## Call duration vs event timing (2026-10-09 anomaly)

Over the air (run 5), a DMR call reported `duration` 7252 ms although its
`call_start` and `call_end` events arrived about 11.0 s apart. That call ended by
the fallback timeout (`flags.timeout: true` in the captured event; the acceptance
note said otherwise). The parser was behaving as designed: `duration` runs from
the call's first decoded line to its last, and the end is only known
`callTimeoutMs` (4 s) after the last line. Separately, `call_start` is published
100-600 ms after the first line, once metadata has accumulated: 7.25 s - ~0.3 s + ~4.06 s
≈ 11.0 s.

To make this checkable, both events now carry `startedAt` (and `call_end`
carries `endedAt`) with `duration == endedAt - startedAt` exactly. The digital
voice call state uses the same values. The open question is why the terminator
was missed on that call (signal at the end of the PTT); it is a decode issue,
not a parser one.

## Limits and follow-ups

- DMR voice audio has not yet been heard over the air: acceptance with the lab
  handheld is next (intelligible voice, call not split while PTT is held).
- No DMR IQ fixture: slot interleaving comes from the dsd-fme source, not from a
  capture. A two-slot repeater capture would verify the mixing.
- One mixed mono stream per decoder; per-slot and per-talkgroup selection beyond
  `voiceSlot` is deferred.
- Latency: `jitterBufferMs` (250 ms) adds to the existing pipeline latency (see
  the live audio latency item in the roadmap).
- The core channelizer plan rewrites dsd-fme's input stages; this feature only
  touched dsd-fme's output arguments, call state and the new audio path.
