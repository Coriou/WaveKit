# Research: IQ transport over Wi-Fi from the Pi SDR host

Exploratory evidence: read [the subsequent technical review](REVIEW-2026-10-08-CHANNELIZER.md)
before implementing these proposals. It corrects assumptions about rates,
bandwidth, fixtures and the current CSDR baseline.

Status: research note, 2026-10-08. No code changes. Companion note:
`docs/RESEARCH-2026-10-08-PI-CHANNELIZER.md` (on-Pi channelization). Roadmap section 2
links here.

## Question

The Pi 3 Model B streams 2.048 Msps of 8-bit IQ to the laptop over 2.4 GHz
Wi-Fi and the stream is "laggy" or lossy. Would IQ compression help, and what
else helps when the network is constrained? Ethernet is out of scope here (it is
expected to work and is a separate roadmap item).

## Test setup

- Pi 3 Model B Rev 1.2, Pi OS Trixie, RTL-SDR Blog V4, `wavekit-sdr-host`
  container (rtl_tcp → rtlmux :5555), 2.048 Msps, 446.524920 MHz.
- Pi on 2.4 GHz channel 6 (2437 MHz), signal −46 to −51 dBm, PHY rate reported
  72.2 Mbit/s both ways. Laptop on the same AP over 5 GHz (780 Mbit/s), so the
  laptop side is not a factor.
- Power: unstable. Kernel logged undervoltage/normalised cycles every ~30 s and
  `vcgencmd get_throttled` moved between `0x50000` (historical) and `0x50005`
  (active undervoltage + throttling, ARM clock capped at 600 MHz).
- Later in the session the Pi brown-out rebooted twice under extra load (a
  csdr compile, then a loopback IQ capture), which caps what can be measured
  on this supply.
- Tests were short (15–25 s). No core/decoders were running; the only rtlmux
  client was the measurement script. Scripts: a Python client that connects to
  rtlmux :5555 and counts bytes per second, and a raw TCP sender/receiver pair
  (Python) for link capacity independent of the dongle.

## Measurements

| Test | Result |
|---|---|
| Needed for 2.048 Msps U8 IQ | 4.10 MB/s = 32.8 Mbit/s payload |
| rtlmux pull, power save on, throttled `0x50000` (start of session) | 4.09 MB/s sustained 25 s, worst gap 75 ms, 0 drops |
| rtlmux pull, ~10 min later, throttled `0x50005` | 1.92 MB/s, rtlmux dropped 4.2 MB in 15 s |
| rtlmux pull, power save **off**, still `0x50005` | 1.47 MB/s |
| Raw TCP Pi → laptop, `0x50005` | 12.2 Mbit/s |
| Raw TCP laptop → Pi, same minute | 36.4 Mbit/s |
| `iw station dump` after tests | tx failed 154, no beacon loss, PHY rate unchanged |

Findings:

1. **The link can carry the stream, with no margin.** At its best the 2.4 GHz
   link delivered the full 32.8 Mbit/s. Published figures for the Pi 3B's
   onboard radio (1×1 802.11n, 2.4 GHz only) are 35–45 Mbit/s in ideal
   conditions, so the stream sits at 75–95% of capacity. Any degradation turns
   directly into loss.
2. **The degradation is on the Pi's transmit side and tracks power.** Within the
   same minute the Pi received at 36 Mbit/s but sent at 12 Mbit/s, while
   reporting active undervoltage and a 600 MHz ARM clock. Reported PHY rate and
   signal did not change, so `iw link` does not reveal this state; throughput
   tests do.
3. **Wi-Fi power save made no measurable difference while throttled.** It should
   still be disabled persistently in the image (latency and idle-to-burst
   behaviour), but it is not the cause of today's loss.
4. **Lag versus loss is an rtlmux policy.** rtlmux queues up to 4 MiB per client
   before dropping (≈1 s at this rate), then drops whole blocks and counts them
   in `dropped.size`/`dropped.count`. So a slow link first shows as ~1 s of
   latency, then as gaps. It sets no socket buffer options.
5. **A previous client left the tuner at a low gain.** `rtl_tcp` keeps the last
   commanded gain; the log showed a client stepping gain index 28 → 11 and
   disconnecting, leaving samples spanning only 124–131 (≈3 effective bits).
   This is the "stale tuner state" problem from the roadmap seen from the Pi
   side; the SDR host should re-assert its configured gain/rate when the last
   client disconnects, or the core should re-assert on connect.

## Compression: measured on this dongle

zstd level 1 on 4 s captures at each tuner gain (manual mode; `-1` = tuner AGC):

| Gain (dB) | Sample range | Std (LSB) | Entropy (bits/sample) | zstd −1 ratio | Resulting rate |
|---|---|---|---|---|---|
| 0 | 125–130 | 0.52 | 1.09 | 0.21 | 7.0 Mbit/s |
| 20 | 120–134 | 1.09 | 2.13 | 0.30 | 9.8 Mbit/s |
| 30 | 106–150 | 4.76 | 4.14 | 0.48 | 15.7 Mbit/s |
| 40 | 55–202 | 14.67 | 5.76 | 0.68 | 22.3 Mbit/s |
| 49.6 | 0–255 | 35.43 | 7.10 | 0.86 | 28.3 Mbit/s |
| AGC | 0–255 (5% clipped) | 57.66 | 7.60 | 0.94 | 30.9 Mbit/s |

zstd −1 ran at 26 MB/s on the Pi (one core, while throttled), so CPU cost is
not the issue. FLAC and zstd −3 gave the same ratios within a few percent. A
4-bit lossy repack plus zstd gave 0.15–0.30.

Conclusion: at the gains you actually run (40–49.6 dB) lossless compression
saves 14–32%, which does not create margin on a link that fluctuates by 3×.
Compression ratios that look good come from an under-driven ADC, which is a
receiver problem, not a transport win. Lossless compression is worth adding only
as a cheap companion to a transport that already fits (channelized streams),
never as the fix.

## Options and decisions (this session)

| Option | Effect on the 33 Mbit/s stream | Decision |
|---|---|---|
| Stable power, then re-measure | Unknown until measured; today's loss correlates with throttling | **Do first.** New supply expected 2026-10-09. |
| Persistent Wi-Fi power save off in the Pi image | Latency/burst behaviour; not today's cause | **Do** (image/firstboot item). |
| Lower sample rate (1.024 Msps = 16.4 Mbit/s) | Halves load; readsb needs ≥2 Msps | **Do, as a WaveKit-wide policy** (below). |
| On-Pi channelization | 10–100× less traffic for narrowband decoders; ADS-B/VDL2 excluded | **Research separately**: `docs/RESEARCH-2026-10-08-PI-CHANNELIZER.md`. |
| Run readsb/dumpvdl2 on the Pi | Kilobits instead of megabits | **Not now.** Breaks the "Pi hosts the dongle, core decodes" model; ADS-B over Pi 3 Wi-Fi is honestly an Ethernet case. Revisit only as an explicit opt-in edge tier. |
| Lossy bit reduction (SpyServer style) | 2–3× with 24 dB dynamic range loss | **Skip for now.** |
| Lossless compression only | 1.15–1.5× | **Skip on its own.** |

## Sample-rate policy, WaveKit-wide (design direction)

What exists today:

- The core already controls the upstream rate: `POST /api/tuner/:sourceId/sample-rate`
  (`src/api/routes/tuner.ts`) calls `TunerController.setSampleRate`, which sends
  rtl_tcp command `0x02` upstream and updates the source caps. SDR++ through the
  tuner relay does the same, and the relay emits `sample-rate-changed`.
- `DecoderManager` reacts to caps changes by updating `inputSampleRate` and
  restarting affected pipelines, and warns when the rate is not in a decoder's
  `preferredSampleRates` (`src/decoders/manager.ts`, caps-changed handler).
- Valid rtl_tcp rates: 225 001–300 000 and 900 001–3 200 000 Hz.

What is missing, and should be one feature rather than per-decoder hacks:

1. **Declared requirements, not just preferences.** Extend `DecoderCaps`
   (today only `preferredSampleRates`) so every decoder, including future ones,
   states the rate it works best at, the rates it accepts and the minimum below
   which it cannot work, e.g. readsb best 2.4 Msps, ≥ 2.0 Msps; dumpvdl2
   ≥ 1.05 Msps; AIS exactly 384 kHz after decimation; narrowband audio decoders
   ≥ 250 kHz. "Which rate is best for which decoder" is then a fact the system
   knows and can show, not folklore. With a channelizer
   (`docs/RESEARCH-2026-10-08-CHANNELIZER.md`) each decoder receives its exact
   preferred rate, and the source rate only decides how wide the capture is
   (how many channels fit at once) and the link load.
2. **Policy in the manager, not the decoder.** On every caps change the manager
   evaluates each assigned decoder: run, or suspend with a machine-readable
   reason (`insufficient-sample-rate`, with required vs current). Suspension is
   reversible: raising the rate resumes the decoder automatically.
3. **Visible everywhere.** The reason travels in the REST decoder DTO, the
   `decoders` WebSocket channel and `@wavekit/api-types`, so the CLI dashboard
   shows "ADS-B paused: needs 2.0 Msps, source at 1.024 Msps" and a future web
   UI gets the same contract.
4. **Source presets.** Expose the current rate and the valid rate set per source
   so a client can offer a picker (and show the resulting Mbit/s on the wire).
5. **Shared control stays shared.** SDR++ via the relay and the WaveKit API both
   change the same state; the existing `controlPolicy` governs conflicts. On
   reconnection the core re-asserts the last accepted rate/gain (ties into the
   roadmap's tuner-synchronization item and finding 5 above).

## Pi image items

- Disable Wi-Fi power save persistently (Pi OS uses NetworkManager: a
  `/etc/NetworkManager/conf.d/*.conf` with `[connection] wifi.powersave = 2`
  written by first boot; verify with `iw dev wlan0 get power_save` after
  reboot). Today's manual `iw ... set power_save off` is not persistent.
- Report undervoltage/throttling next to delivery rate on the operator page
  (already partly done) so a slow link is attributed to power when that is the
  cause.
- Consider having the SDR host re-apply its configured gain/sample rate when the
  last rtlmux client disconnects.

## Repeating the measurements

Raw TCP capacity (on the Pi, then connect from the laptop and count bytes):

```sh
# Pi
head -c 2000000000 /dev/zero | nc -l 5001
# laptop: any TCP client that reports bytes/s, e.g. nc <receiver-host> 5001 | pv > /dev/null
```

rtlmux pull: connect to `<pi>:5555`, discard the 12-byte `RTL0` header, count
bytes per second, then read `http://<pi>:5556/stats.json` for `dropped`.

Compressibility: capture on the Pi with
`nc -w 15 localhost 5555 | head -c 41000000 | tail -c +13 > /tmp/iq.cu8`, then
`zstd -b1 -e3 /tmp/iq.cu8`. Check the sample range first; a span narrower than
about 50 values means the ADC is under-driven and the ratio is meaningless.

## External references

- SDR++ server: optional zstd level 1 on int8/int16 samples
  (`core/src/server.cpp`); the author reported 1.1–2.5× in practice.
- SpyServer 2.0: streams FFT for the waterfall plus only the selected IF
  bandwidth (~120 kB/s narrowband); 8-bit "PCM" mode is lossy.
- sdr-server (open source, RTL only): per-client frequency-translating FIR,
  decimation to the requested bandwidth, optional gzip.
- ka9q-radio: overlap-save filter bank, multicast RTP output, raw IQ mode per
  channel; sized for a Pi 4.
- rtlmux source: 4 MiB per-client queue, then block drops.
