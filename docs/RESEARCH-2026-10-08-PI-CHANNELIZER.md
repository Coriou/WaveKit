# Research: should the channelizer run on the Pi?

Exploratory evidence: read [the subsequent technical review](REVIEW-2026-10-08-CHANNELIZER.md)
before implementing these proposals. It corrects assumptions about rates,
bandwidth, fixtures and the current CSDR baseline.

Status: research note, 2026-10-08. No code changes. Companion notes:
`docs/RESEARCH-2026-10-08-CHANNELIZER.md` (what a shared channelizer is, why it
beats per-decoder csdr pipelines, core-side measurements and a proposed shape)
and `docs/RESEARCH-2026-10-08-WIFI-IQ-TRANSPORT.md` (why the Wi-Fi link
cannot carry the raw stream reliably on a Pi 3). This note only answers the
placement question: is running that channelizer on the SDR host a good idea,
on what hardware, and does it keep WaveKit's goal intact.

WaveKit's goal, restated: decode anything, as efficiently as possible, from one
dongle (multiple dongles supported), including decoders not written yet.

## 1. What "on the Pi" would mean

Today the Pi runs `rtl_tcp → rtlmux` and ships the whole 2.048 Msps capture
(32.8 Mbit/s) to the core, which fans it out and runs one `csdr` chain per
decoder. On-Pi channelization adds one process beside rtlmux that takes the
same raw stream and serves, per request, a narrow stream at the decoder's
exact rate: `{offsetHz, bandwidthHz, outputRate, format}` in, bytes out. The
core connects one socket per channel instead of one raw stream.

Link load if the Pi preset's decoders got channels (centre at 446.5 MHz):

| Consumer | Channel rate (cu8) | On the wire |
|---|---|---|
| dsd-fme, multimon-ng, direwolf (NFM, 48 k each) | 96 kB/s each | 0.77 Mbit/s each |
| rtl_433 (250 k) | 500 kB/s | 4.0 Mbit/s |
| AIS-catcher (384 k) | 768 kB/s | 6.1 Mbit/s |
| dumpvdl2 (1.05 M) | 2.1 MB/s | 16.8 Mbit/s |
| readsb (needs the full 2.0–2.4 M) | 4.1 MB/s | 32.8 Mbit/s, unchanged |
| SDR++ through the tuner relay (full IQ) | 4.1 MB/s | unchanged |

So the win is large for narrowband decoders (the whole Pi preset's narrowband
set fits in ~3 Mbit/s), moderate for AIS, small for VDL2 and nil for ADS-B
and the SDR++ waterfall. The raw stream must stay available regardless.

## 2. Pi 3 Model B measurements

Conditions: Pi 3B, Pi OS Trixie, jketterl/csdr built from source
(`/usr/local/bin/csdr`), 4 s of real 2.048 Msps U8 IQ captured from rtlmux at
gain 49 dB. ARM clock **600–800 MHz throughout** (active undervoltage and
throttling; nominal is 1200 MHz, so expect roughly 1.5–2× better numbers on
stable power). Chains run at `nice 10`, one at a time except F and G. The Pi
brown-out rebooted twice during this session under compile and capture load,
which is why the run is short. "CPU" is user+sys; "share" is CPU divided by
the 4 s of signal, i.e. the fraction of one core needed for real time.

| Chain (all `csdr`, pipes between processes) | real | user | sys | share of one core |
|---|---|---|---|---|
| A. convert → firdecimate 8 → convert (256 k, no shift; today's `IqDecimateDecoder` prefix) | 1.32 s | 0.88 | 1.58 | 0.61 |
| B. convert → shift → firdecimate 8 → convert (one 256 k channel) | 1.71 s | 1.35 | 2.62 | 0.99 |
| C. convert → shift → firdecimate 40 → convert (one 51.2 k channel, single stage) | 1.43 s | 0.90 | 2.33 | 0.81 |
| D. convert → shift → firdecimate 8 → firdecimate 5 → convert (51.2 k, two stages) | 1.84 s | 1.59 | 2.81 | 1.10 |
| E. convert → convert only (pipe + format cost, no DSP) | 0.65 s | 0.36 | 0.94 | 0.33 |
| F. four independent D chains concurrently | **7.68 s** | 6.61 | 14.87 | 5.37 (not real time) |
| G. one shared front end (convert → firdecimate 8) then `tee` into four shift → firdecimate 5 → convert | 3.36 s | 1.26 | 2.72 | 0.99 |

Reading:

- **Per-decoder chains do not scale on a Pi 3.** One channel costs about a
  core while throttled; four independent channels need 5.4 cores and run at
  half real time. This is the model the core uses today, so simply moving the
  existing pipelines to the Pi is not an option.
- **The cost is pipes and format conversion, not arithmetic.** E (no DSP) is
  a third of a core; sys time dominates every row. The DSP itself (user time)
  for a channel is 0.2–0.4 core throttled.
- **Sharing the front end works even on this hardware.** G does four 51.2 k
  channels in about one core with real time to spare, because the full-rate
  stream is converted and decimated once. An in-process channelizer (no pipes,
  one float conversion, per the companion note) removes most of the remaining
  sys time; four to eight narrowband channels on a Pi 3 at 1200 MHz is a
  reasonable expectation, to be measured. Fast convolution would make the
  count nearly free but is not required for this scale.
- **Wideband channels stay expensive.** A 1.05 M VDL2 channel is a decimation
  of only 2, so most of the full-rate work remains; budget it as a wideband
  consumer, not a channel.

Not measured yet (needs stable power): the same table at 1200 MHz, an
in-process prototype, and CPU/Wi-Fi interaction (the Wi-Fi driver needs CPU
too; on this Pi the transmit path collapsed while throttled).

## 3. Pros and cons, weighed

Pros:

1. **It attacks the real bottleneck.** Measured: the link carries 33 Mbit/s
   at best and 12 Mbit/s when the Pi is throttled; narrowband channels need
   under 1 Mbit/s each. No compression scheme gets close (lossless 0.68–0.86).
2. **It is the same component as the core-side channelizer.** One binary, one
   channel-request contract, two placements. Building it for the core first
   (the companion note's recommendation) is most of the Pi work.
3. **It enables, not restricts, "decode anything".** Today every decoder on a
   dongle decodes the capture centre. A channelizer is what lets POCSAG, DMR
   and APRS run at different offsets of the same 2 MHz capture at once, from
   one dongle. Placement on the Pi does not change that; it only changes where
   the bytes are cut.
4. **Exact rates for free.** AIS 384 k, VDL2 1.05 M and LoRa get their exact
   rate from the channelizer, removing the sox paired-IQ resample path.
5. **Graceful degradation.** A channel stream is small enough that the
   4 MiB rtlmux-style queue means seconds, not a second, of slack; drops hit
   one channel, not everything.

Cons:

1. **It does not solve the wideband cases.** readsb needs the full rate, the
   SDR++ relay needs full IQ (unless an FFT/waterfall stream is added, which
   is a new feature), recordings need the full rate. On a Pi 3 over Wi-Fi,
   ADS-B remains an Ethernet (or lower-rate, or edge-decoder) case; this note
   does not pretend otherwise.
2. **Two transports and a bigger host API.** The SDR host grows a channel
   request/control surface (frequencies, rates, formats, per-channel stats)
   next to the raw stream; the core needs per-source placement logic and a
   fallback. The companion note's "channel requests, rates, frequencies" row
   understates how much contract work this is.
3. **Tuner ownership gets harder.** A channel request outside the current
   capture needs a retune that invalidates other channels. The roadmap's
   tuner-ownership and scanning items must be designed together with this.
4. **Weak hardware and weak power.** On today's Pi 3 the budget is one to two
   channels with pipes, maybe four to eight in-process, and nothing while
   brown-outs reboot the host. It must be optional and self-limiting.
5. **Two code paths to test.** Every decoder must produce the same decodes
   from a channel stream and from the raw fanout. Golden-fixture tests per
   decoder (companion note, section 6) become mandatory.

## 4. Keeping it optional and honest

- **Capability, not assumption.** The SDR host advertises
  `channelizer: { available, maxChannels, formats }` in `/api/status` (shared
  `@wavekit/api-types`), derived from a startup self-benchmark or a static
  table per Pi model, and lowers `maxChannels` while throttled. Absent or
  zero means raw IQ only, exactly today's behaviour.
- **Per-source placement.** Source config gains
  `delivery: raw | channels | auto`. `auto` picks channels when the host
  offers them and the measured delivery shows drops; it falls back to raw
  when the host reports overload. The chosen mode and the reason are exposed
  on the source DTO so the CLI can show "channels (host CPU limited, 3 of 6
  decoders)".
- **Decoders stay unaware.** A decoder declares what it wants (offset, rate,
  format, demod) through the sample-rate model in the roadmap; the manager
  decides whether that request is served by the core channelizer, the host
  channelizer or a raw fanout branch. Future decoders inherit all three paths.
- **Hardware floor.** Pi 3: optional, limited. Pi 4/5: expected to be the
  default for narrowband decoders. Document measured numbers, not model names.

## 5. Recommendation

Yes, but second. Build the channelizer once, as a standalone process, on the
core first (companion note), with the channel-request contract designed from
day one to be served remotely. Then put the same binary behind the SDR host
with capability negotiation and `auto` placement. Prerequisites before the Pi
phase:

1. Stable power on the test Pi and a repeat of section 2 at 1200 MHz, plus an
   in-process prototype measurement (1, 4, 8 channels).
2. The WaveKit-wide sample-rate model (roadmap section 2), since channel
   requests are its natural output.
3. Tuner ownership rules for multi-channel captures (roadmap sections 3/5).
4. A decision on the SDR++/waterfall path over Wi-Fi: full IQ (no change), a
   reduced-rate IQ, or an FFT stream. Out of scope here.

ADS-B over Pi 3 Wi-Fi stays unsolved by design; say so in the UI through the
sample-rate model rather than hiding it.

## 6. Reproducing the Pi measurement

```sh
# on the Pi, csdr (jketterl) in PATH; 4 s of IQ from rtlmux
nc -w 8 localhost 5555 | head -c 16400000 | tail -c +13 > ~/iq.cu8
C2F="csdr convert -i char -o float"; F2C="csdr convert -i float -o char"
time (cat ~/iq.cu8 | $C2F | csdr shift 0.1 | csdr firdecimate 8 0.05 | csdr firdecimate 5 0.05 | $F2C > /dev/null)
# shared front end, four channels:
time (cat ~/iq.cu8 | $C2F | csdr firdecimate 8 0.05 | tee \
  >(csdr shift 0.1 | csdr firdecimate 5 0.05 | $F2C > /dev/null) \
  >(csdr shift 0.2 | csdr firdecimate 5 0.05 | $F2C > /dev/null) \
  >(csdr shift 0.3 | csdr firdecimate 5 0.05 | $F2C > /dev/null) \
  | csdr shift 0.4 | csdr firdecimate 5 0.05 | $F2C > /dev/null; wait)
vcgencmd measure_clock arm; vcgencmd get_throttled   # record the clock with the result
```

The test Pi currently has csdr installed under `/usr/local` and `~/iq.cu8`,
`~/bench2.sh`, `~/bench.out` left in place; the card is due to be reflashed.
