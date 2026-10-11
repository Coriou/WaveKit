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
# Lowest latency (verified 2026-10-09: near-instant vs ~5 s with ffplay)
curl -sN http://localhost:8082/stream | play -q --buffer 512 -t raw -r 8000 -e signed -b 16 -c 1 -
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
  jitterBufferMs: 400 # voice buffered (or waited for) before a burst plays
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
| `extraArgs`                                                             | Passed through, except `-f*` (mode), `-o` (output) and `-y` (float audio), which are dropped with a warning: they would desync the stream format           |

Relative recording directories are resolved to absolute paths. Retention only
deletes files dsd-fme named (`dsd_file.c` in the pinned build):
`<YYYYMMDD>_<HHMMSS>_<5 digits>_<sysid>_<GROUP|PRIVATE>_TGT_<tgt>_SRC_<src>.wav`
and the in-progress `TEMP_<YYYYMMDD>_<HHMMSS>_<4 hex>.wav` that a crash leaves
behind. Other WAV files in the directory are never touched.

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
  oldest voice is dropped (`droppedSamples`). `underruns` counts the times the
  buffer ran dry inside a tick during an active call: gaps in a call's audio.
  The clock is monotonic (`performance.now()`), so a wall-clock step such as an
  NTP correction cannot stall or burst the output.
- **Mixing**: in auto and DMR modes datagrams are stereo, slot 1 left and
  slot 2 right. dsd-fme copies a lone active slot to both channels and
  zero-fills a muted one. Per datagram, identical channels pass through once;
  otherwise the channels are summed and clamped. Each slot therefore keeps its
  own level when the other slot joins or leaves (averaging would drop it 6 dB);
  the cost is that two loud simultaneous calls can clip. Per-slot streams are
  deferred; use `voiceSlot` to pick one. A frame-aligned datagram of an
  unexpected size (not a multiple of 640 bytes in stereo, 320 in mono) is
  played but logged once: it means the mode or output format was overridden.
- **Call state**: the decoder's `call_start` / `call_end` stay authoritative.
  dsd-fme publishes a `voice-call` event in the same tick as each of them
  (`emitOutput`), plus one when a running call turns out encrypted. The stream
  maps these to `digital-voice:call` (`decoderId`, `callId`, `protocol`,
  `talkgroup`, `source`, `slot`, `encrypted`, `active`, `startedAt`, `endedAt`).
- **Encryption**: DMR from the voice link control line, where `dmr_flco.c`
  appends `Encrypted ` after `TGT=… SRC=…` (only on a line with TGT/SRC, so
  `Slot N - Encrypted PDU` data bursts do not count), or from a non-zero
  `ALG ID: %02X;` in the PI header or late entry (`dmr_pi.c`, `dmr_le.c`; no
  `0x`). `SVC=0x..` is also parsed but only appears with `-Z`, which is not
  passed. P25 from `ALG ID` (0x80 means clear). While the current call is
  encrypted, queued voice is cleared; in stereo only that call's slot channel is
  silenced, so a clear call on the other slot keeps playing (a datagram whose
  channels are identical is silenced whole), and in mono or with the slot
  unknown whole datagrams are discarded. dsd-fme also mutes encrypted voice by
  default (it zero-fills the encrypted slot).

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

**End to end** (same container, real dsd-fme with the arguments the decoder
builds, `-i /dev/stdin -fa -o udp:127.0.0.1:<port> -V 3`, into
`DigitalVoiceService`, read back from `/stream.wav`): 22.6 s of stream at exactly
16 000 B/s, 355 datagrams received, 0 rejected, 0 dropped, and all 7.1 s of
decoded voice played. Whether the voice played without gaps depended on the
jitter target (the stream compared byte for byte with the received datagrams):

| `jitterBufferMs` | Voice contiguous                      | Underruns (1 = the call's end) |
| ---------------- | ------------------------------------- | ------------------------------ |
| 100              | no                                    | 6                              |
| 250 (two runs)   | no: one 40 ms gap 0.5 s into the call | 2, 2                           |
| 400              | yes                                   | 1                              |
| 500              | yes                                   | 1                              |

The default is therefore 400 ms. DMR sends a 60 ms burst per voice frame and
may tolerate less; tune it with the `underruns` status counter once DMR voice
has been measured over the air. The 250 ms capture is in
`output/voice-test-20261009/digital-voice-e2e-ysf.wav` (not in git).

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

## Chopped DMR voice: no DC blocker before dsd-fme (2026-10-09)

Over the air (runs 8 and 9) the decoded DMR voice was "robotic": about 20 % of
it was exact silence, as runs of 25-30 ms about six times a second (muted
AMBE frames). Call metadata still decoded, so it went unnoticed.

**Cause.** dsd-fme's input chain ran `csdr fmdemod | csdr dcblock | csdr gain 2
| csdr limit`. A DMR handheld (MS/direct mode) transmits in TDMA bursts: 30 ms
on, 30 ms off. Between bursts the discriminator follows the receiver's own DC
spike, which `offsetHz` moves to -6 kHz, still inside the channel filter. On
run 8 the idle level is -5997 Hz and the burst level -463 Hz, so every burst
starts with a step of about 5.5 kHz. `csdr dcblock` (R = 0.998, time constant
about 10 ms at 47.6 kHz) turns that step into a transient. Over the first 10 ms
of each burst the baseline is off by a median 2.42 times the 4FSK decision
half-spacing (648 Hz); without the DC blocker it is off by 0.27 times. The eye
was closed at the start of all 373 bursts with the blocker and open at the
start of 99 % without it. dsd-fme already tracks the symbol levels per burst,
so the blocker only did harm. The pre-34f56e1 decimation filter
(`firdecimate 43 0.05`) shows the same failure (2.27 times the half-spacing),
so the channel-matched filter was not the cause. Varying `gain` (0.5-5) or
removing `limit` made no difference.

**Fix.** The dsd-fme chain no longer has `csdr dcblock`
(`skipDcBlock: true`).

| run 8, two PTTs, exact core chain          | before (dcblock) | after |
| ------------------------------------------ | ---------------- | ----- |
| Muted voice (exact zeros)                  | 20.5 %           | 1.1 % |
| Gaps of 15 ms or more                      | 134              | 4     |
| dsd-fme AMBE errors ("Total audio errors") | 2460             | 86    |
| FEC ERR lines                              | 56               | 6     |
| Link control lines decoded (TGT/SRC)       | 35               | 62    |
| CRC errors                                 | 0                | 0     |

The decoded voice is in `output/voice-test-20261009/run8-decoded-before.wav`
and `run8-decoded-fixed.wav` (not in git). The run 9 taps were recorded after
the DC blocker, so their damage cannot be undone: decoding them at other gains
does not help (0.5x: 21.0 % muted; 4x: worse).

**Regression check.** `scripts/dsd-fme-voice-ab.mjs` runs the real dsd-fme in
the core image on a committed 13 s discriminator capture of one run 8 PTT
(`tests/mocks/fixtures/dsd-fme/run8-dmr-tx2-fmdemod.s16`, 1.2 MB). It applies
the rest of the chain and requires: an identical decode with `-o null`,
`-o udp -V 3` and `-o udp`; less than 5 % muted voice; fewer than 300 AMBE
errors. Current chain: 0.7 % muted, 6 AMBE errors. The old chain fails it
(20.3 %, 1262). A unit test keeps the script's chain equal to the decoder's.

```bash
docker run --rm --network none --entrypoint node -v "$PWD:/w:ro" \
  wavekit:local-core /w/scripts/dsd-fme-voice-ab.mjs
```

**IQ mode (core channelizer).** With `--iq` the same check is fed from a cu8
capture instead of the discriminator output (`scripts/dsd-fme-voice-iq.mjs`):

```bash
docker run --rm --network none --entrypoint node -v "$PWD:/w:ro" \
  wavekit:local-core /w/scripts/dsd-fme-voice-ab.mjs \
  --iq <capture.cu8> --rate <fs> --offset <hz> --front csdr|chan \
  [--chan-bin wavekit-chan] [--unpaced]
```

`--offset` is the signal's offset from the capture centre (run 8: 6000).
`--front csdr` runs the decoder's raw front (convert, shift, matched
firdecimate, fmdemod, then the back chain). `--front chan` runs the csdr front
first as the reference, then `wavekit-chan` (one 48 kHz cf32 channel at
capture centre + offset, 12 500 / 6 250 Hz, as the channelised decoder
requests it) into fmdemod and the back chain. Both fronts run the three-way
check above. The chan front must also decode the same TGT/SRC lines as the
csdr front, and its AMBE errors must not exceed max(1.25 x csdr, csdr + 20).
That tolerance is provisional until the user confirms it. The chan front feeds
the capture at real time (2 bytes per sample, `--unpaced` to disable) and fails
on any discontinuity, on a channel closed before `input-eof`, or on an
`input-eof` that does not count every fed byte.

The `-o udp` A/B regression suspected on 2026-10-09 (runs 6 and 7) was ruled
out: offline, every input path decoded identically with voice on and off, and
the run 9 live A/B on a clean channel matched exactly. Run 7 had co-channel
analog interference.

## Limits and follow-ups

- DMR voice audio has not yet been heard over the air: acceptance with the lab
  handheld is next (intelligible voice, call not split while PTT is held).
- No DMR IQ fixture: slot interleaving comes from the dsd-fme source, not from a
  capture. A two-slot repeater capture would verify the mixing.
- One mixed mono stream per decoder; per-slot and per-talkgroup selection beyond
  `voiceSlot` is deferred.
- Latency: `jitterBufferMs` (400 ms) adds to the existing pipeline latency (see
  the live audio latency item in the roadmap).
- The core channelizer plan rewrites dsd-fme's input stages; this feature only
  touched dsd-fme's output arguments, call state and the new audio path.
