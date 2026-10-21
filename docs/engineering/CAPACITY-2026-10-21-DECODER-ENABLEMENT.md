# Decoder enablement capacity acceptance, 2026-10-21

This is the capacity record that requirement 5.4 of the decoder enablement spec
([requirements](../specs/decoder-enablement/requirements.md)) asks for before the
channelizer is composed automatically. It covers the desktop (x86-64) half. The Pi 4-class
(arm64) half was not run.

## Verdict

- **x86-64, default budget: accepted.** Windows A and C pass at 2.048 and 2.4 Msps. The
  channelizer is composed automatically on x86-64 hosts (`channelizerAutoAccepted("x64")`).
- **arm64: pending.** Automatic composition stays off until a Pi 4-class host is measured.
- **C+ clause: open.** With the budget raised to admit seven channels, the channelizer input
  branch dropped 0.04 % (2.048 Msps) and 0.07 % (2.4 Msps) after every placement had
  graduated, and the gate suspended nothing. This late-drop case is deferred to a later design
  for attributing link and host bursts; the gate is not changed for it now.

## Method

- **Host:** a desktop with an Intel i5-1038NG7 (4 cores, 8 threads), running the core in a
  Linux VM with 6 vCPUs. The core container had no CPU quota and was never throttled.
- **Host load caveat:** the host was not quiet. Other development work (test workers and a
  browser helper process at up to several cores) ran during the afternoon. Each run waited
  until the 1-minute load average was at most 8 before starting, and every drop burst in a
  channel-only window coincided with a CPU burst from another process on the host.
- **IQ source:** `scripts/capacity/fake_rtl_tcp.py` in a separate scratch container on a
  private network, replaying synthetic CU8 (seeded noise, an NFM carrier at +100 kHz and a CW
  tone at −300 kHz), paced at the run's sample rate and looped. Each run had exactly one
  connection, and the source never lagged its schedule by more than 0.084 s.
- **Core:** a scratch core container with the catalogue on (shipped defaults, region per
  window), `channelizer.enabled: true`, and catalogue placements admitted through the real
  efficiency gate. No ports were published; the API was queried from inside the container.
- **Sampling:** after admissions settled (all expected placements admitted, none on
  probation, then 30 s more), every 10 s for 10 minutes: the efficiency view, per-branch fanout
  telemetry (bytes written and dropped), the decoder list, cgroup CPU, per-process CPU time
  and the host load average. Drop % is dropped / (written + dropped) per branch over the window.

### Windows as realised

- **A, centre 162.000 MHz:** AIS (one channel at 162.000 MHz), dsd-fme at the VFO, and
  multimon-ng at the VFO (162.000 MHz lies in the built-in VHF pager scan range). As designed.
- **C, centre 869.525 MHz, region EU:** rtl433 (band channel at 869.3529 MHz at 2.048 Msps and
  869.2825 MHz at 2.4 Msps), dsd-fme at the VFO, and LoRa on its raw branch (centre reach). No
  multimon-ng VFO channel: the design counts one only when a band plan lists pager channels
  there, and no built-in EU scan range near 869 MHz does. The default budget admits all of it.
- **C+ (7 channels, budget 3.0):** not buildable at 869.525 MHz in EU, because no built-in scan
  range there lists a dsd-fme protocol. It was run at 162.000 MHz instead, with an operator band
  plan (161.7–162.3 MHz, channels at 161.8125, 161.875, 162.125 and 162.1875 MHz) and
  `maxBandplanChannels: 2`: AIS, dsd-fme and multimon-ng at the VFO, plus dsd-fme and
  multimon-ng at 161.875 and 162.125 MHz. C+ therefore has no LoRa raw branch.

## Results

Admissions were sequential (one probationer per source); each placement was admitted about
30 s after the previous one graduated, and the first admission came 71–73 s after the core
reported healthy.

| Window | Rate       | Branch bytes written / dropped (%)                                                        | Container CPU median / p95 (cores) | Channelizer CPU (cores) | Host load median / max |
| ------ | ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------- | ---------------------- |
| A      | 2.048 Msps | channelizer input 2 423 521 280 / 0 (0.00 %)                                              | 0.45 / 0.52                        | 0.29                    | 4.75 / 6.35            |
| A      | 2.4 Msps   | channelizer input 2 830 368 768 / 131 072 (0.005 %, one burst during host CPU contention) | 0.46 / 0.53                        | 0.29                    | 4.28 / 5.83            |
| C      | 2.048 Msps | channelizer input 2 424 307 712 / 0; LoRa 2 424 307 712 / 0 (0.00 %)                      | 0.79 / 0.90                        | 0.29                    | 4.96 / 6.41            |
| C      | 2.4 Msps   | channelizer input 2 844 000 256 / 0; LoRa 2 844 000 256 / 0 (0.00 %)                      | 0.89 / 0.99                        | 0.32                    | 5.04 / 6.91            |
| C+     | 2.048 Msps | channelizer input 2 419 326 976 / 851 968 (0.04 %, 5 bursts after graduation)             | 0.93 / 1.33                        | 0.56                    | 6.14 / 10.63           |
| C+     | 2.4 Msps   | channelizer input 2 845 310 976 / 2 098 280 (0.07 %, 5 bursts after graduation)           | 0.96 / 1.08                        | 0.59                    | 4.80 / 5.86            |

- **Window A:** passes at both rates at two decimals. The single 131 072 B burst at 2.4 Msps
  coincided with a host CPU burst from another process.
- **Window C:** passes at both rates with 0 B dropped. LoRa was admitted about 163 s after the
  core reported healthy (after rtl433 and dsd-fme graduated) and graduated at about 193 s
  (2.048 Msps) and 195 s (2.4 Msps), so the start-up buffer on decoder branches works as
  intended.
- **C+:** during probation the gate acted correctly. At 2.048 Msps the AIS placement was
  suspended on a real channelizer input drop 7 s after it started, and it graduated on its retry.
  The failing drops all began after every placement had graduated; the monitor reported
  `dropping` and logged its once-a-minute warning, but with no placement on probation nothing
  was suspended. The single-threaded channelizer used 0.56–0.59 cores here, and this matches an
  earlier channelizer measurement on the same host, where input drops began at about eight
  channels.

### Reference: YAML decoders without the gate

For comparison, the design's window process sets were run as YAML decoders (`mode: always`,
`useChannelizer: true`, plus a YAML LoRa raw branch in C) before the gate fixes. Window A used the
same three decoders as the gated run. YAML window C also included a multimon-ng channel at the
VFO, which the gated window C did not have (no EU pager scan range near 869 MHz), so it carried
one channel more than the gated run. A had 0 B dropped at both rates. C dropped 0.58 % at 2.048 Msps (with host load
peaking at 28) and 0.03 % at 2.4 Msps, with the channelizer and LoRa branches dropping in the
same samples. A shared stall upstream of both consumers fits a host CPU burst better than a
slow channelizer. The YAML LoRa branch also lost about 0.4 MB at start-up, which the decoder
branch start-up buffer now absorbs.

## Defects found and fixed during the run

Earlier builds in this batch showed defects that are fixed in the build measured above:
LoRa was never placed (its centre reach had no slot); the placement that started the
channelizer was condemned by its own new branch; placements planned before the first clean
window waited 5 minutes; several placements were admitted in one pass and shared the blame for
one start-up; LoRa was condemned for its own start-up drops; and AIS was never placed at
162.000 MHz.

## Findings carried forward

- Automatic composition: x86-64 accepted at the default budget; arm64 needs a Pi 4-class run.
- C+ late drops after graduation are open and belong to the link-burst attribution design.
- Window C as designed cannot include a multimon-ng VFO channel in EU, and C+ cannot be built
  at 869.525 MHz in EU with the built-in scan ranges.
- On a busy shared host, the 512 KiB channelizer input buffer (about 110–130 ms at these rates)
  is thin against CPU bursts from other processes.
