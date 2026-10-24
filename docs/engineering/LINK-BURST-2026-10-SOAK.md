# Link-burst live soak, October 2026 (requirement 9.5)

Result: **pass** at both rates.

## Setup

- Core image built from this branch's link-burst code (absorber on, default 2 s capacity on network
  sources), running as the live protected core on the development Mac.
- Receiver: the Raspberry Pi dongle host on Ethernet; the Mac's hop to it is Wi-Fi (the path the
  absorber exists for). Tuner 446.62 MHz, manual gain 49.6 dB, AGC off; default catalogue and the
  configured channel decoders running.
- 2 h at 2.048 Msps (2026-10-23 18:42–20:42 UTC), then 2 h at 2.4 Msps (20:42–22:42 UTC).
- A recorder polled `/api/resources/link-quality`, `/api/resources/backpressure`,
  `/api/decoders/efficiency`, `/api/resources` and `/api/status` every 15 s (453 polls per rate).
  Attribution counts are summed as positive changes of the monitor's rolling `counts10m` between
  polls, so they undercount when the ten-minute window is saturated.

## Results

| Measure                                        | 2.048 Msps | 2.4 Msps  |
| ---------------------------------------------- | ---------- | --------- |
| Absorber overflow                              | 0 B        | 0 B       |
| Core branch drops (max drop rate)              | 0 B/s      | 0 B/s     |
| Worst arrival stall                            | 1 621 ms   | 726 ms    |
| Peak held in the absorber (10 min window)      | 436 ms     | 142 ms    |
| Attribution increases `link`/`host`/`consumer` | 0 / 0 / 0  | 0 / 0 / 0 |
| Attribution increases `unknown`                | 8          | 7         |
| Upstream (receiver-side) drops                 | 88.0 MB    | 0.7 MB    |
| Late-drop sheds, blocked or suspended decoders | none       | none      |
| Source CPU, maximum                            | 31.7 %     | 31.9 %    |

Every burst stayed within absorber capacity (the worst stall, 1.62 s, is below the 2 s capacity),
so the requirement's 0.00 % branch-drop criterion applies throughout and was met. No overflow
occurred, so no overflow needed a `link` attribution, and no probationer was suspended. The
`unknown` intervals are consistent with the receiver-side drops the dongle host reported (`unknown`
is the designed attribution while upstream loss is present); they were not paired per interval.

## Open

- Pi 4-class core measurement (9.4) remains open: no such host was available.
