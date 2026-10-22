# Fake-link acceptance

This scratch project uses only `fake:1234` on an internal Compose network.
Only the API is published, on an ephemeral loopback port. It requires local
`wavekit:latest` and `python:3.13-slim` images; it never builds or pulls images.
Set `LINK_BURST_IMAGE` to select another locally built core image. The core image
must include Python 3 for the shim and `stress-ng` for the host scenario. The
repository runtime includes Python 3 but does not currently install `stress-ng`;
use a prepared local image for that scenario.

```sh
python3 scripts/link-burst/run_acceptance.py --rate 2048000 --scenario lossless --minutes 10 --out output/link-burst/lossless-2048000
```

Run each scenario at both 2048000 and 2400000 samples/s. Scenarios are `lossless`,
`overflow`, `consumer`, `host`, `upstream`, and `late-shed`. The driver uses a unique
`wkburst-<pid>` project, discovers its API port, polls every two seconds, and removes
its containers, network and volumes on completion. Exit codes: 0 pass, 1 failed
acceptance, 2 invalid experiment. Raw observations are in `samples.jsonl` and
aggregates, verdicts and invalid reasons are in `summary.json`.
`run_acceptance.py --replay <out>` recomputes the verdicts from the kept samples,
keeping the first summary as `summary.original.json`; invalid results decided by
the live loop stay invalid.

The repeating start-to-start intervals are 9, 1, 130, 50, 40, 71 and 161 seconds.
Lossless stall lengths cycle through 150, 500, 1000 and 1800 ms; overflow and
upstream lengths cycle through 2500 and 4000 ms. Upstream uses drop mode and its
private statistics endpoint; other stall scenarios use catch-up mode. The upstream
counter must increase; core overflow is not required. If core branches drop,
`unknown` attribution must also be observed.

The current link-quality API exposes live absorber totals and the latest monitor
attribution, without a shared completed-interval identity. Its `at` field is the
report read time. Overflow attribution cannot be correlated exactly through this
API. The summary labels the check `attributionCheck: "aggregate"` and records
`attributionIncreases`: positive changes between successive monitor `counts10m`
observations, excluding the first observation as a baseline. Overflow must rise
during the run, link classifications must increase, and consumer/host
classifications must not increase. Upstream runs with core overflow use the same
aggregate check. This cannot verify per-interval pairing; rolling-window expiry
can also mask increases between polls. Keep raw samples for that limitation.

The marked YAML `rtl433` instance uses the raw fanout path and is gate exempt.
The shim delegates every unmarked invocation to `/usr/local/bin/rtl_433`. It reads
at full speed without `/tmp/link-burst-slow`; an integer in that file sets bytes/s,
invalid or unreadable content selects 131072 B/s, and zero pauses reads. Consumer
runs enable throttling after 60 seconds, switch to pause after 120 seconds without
sink drops, and become invalid after a further 120 seconds without drops. The
measurement interval starts with the first sink drop. Any sink restart invalidates
the run. No output marks a decoder idle; it does not itself trigger a restart.

Late-shed reserves an initial 600-second smooth interval for graduation and
invalidates the run if overflow begins before the admitted catalogue leaves
probation. It then measures three minutes of overflow stalls before enabling the
slow sink. Before enabling it, the driver clears `LINK_BURST_SCHEDULE` and
recreates only `fake` in the same Compose project, leaving core running. It waits
for the source to be connected with increasing received bytes before establishing
consumer drop baselines and enabling the slow sink. Phase timestamps are monotonic. Admission order in the summary is first-observed order (two-second
resolution). A shed involving simultaneous first observations invalidates the
run because exact admission order is not exposed by the API. The driver checks
observed newest eligible automatic placement, reverse order and cooldown spacing; it cannot prove unexposed gate-window
history or the one-warning-per-minute rule. Keep core logs for those checks.

Summary latency proxies are the maxima of `peakHeldBytes10m`, `peakHeldMs10m` and
`laggardExcludeMsMax10m`. The largest occupied chunk bucket gives one chunk's
milliseconds at twice the configured sample rate. Consumer sibling latency is
checked in two parts. Exclusion latency (`laggardExcludeMsMax10m`) must not exceed
`ABSORBER_LAGGARD_MS`, read directly from the source contract, plus that chunk
allowance plus the loop delay of the interval in which it occurred (or the one
before), rounded up to the 10 ms meter resolution. Post-exclusion drain latency
(`peakHeldMs10m`) must not exceed that bound plus the held backlog divided by an
assumed sibling excess drain rate (`SIBLING_EXCESS`, one source byte rate: a
sibling consuming at twice real time). Two-second polls cannot measure that rate,
so the summary reports the implied excess and fails the run if it is below the
assumption. Any sibling drop fails the run. Sibling drop checks use a baseline at the consumer phase
transition. In late-shed runs, latency checks start after ten minutes in the
consumer phase so the rolling maxima exclude the preceding link-only phase;
shorter runs are invalid. `consumerPeakHeldMs` records the checked maximum.
Link-only shedding remains a failure. SIGINT and SIGTERM trigger teardown and an
invalid result. Missing reports, histograms, branches or required fields
invalidate the experiment. Keep raw samples to inspect attribution windows and
placement changes beyond the automated checks.

The relay, analog and digital voice outputs are disabled. The current open-mode
core always starts its audio TCP listener: `audio.monitoring: false` disables the
raw input, but there is no configuration switch to disable the listener. That
port remains private and unpublished. No scratch port is fixed on the host.
