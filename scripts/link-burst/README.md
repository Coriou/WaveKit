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

The repeating start-to-start intervals are 9, 1, 130, 50, 40, 71 and 161 seconds.
Lossless stall lengths cycle through 150, 500, 1000 and 1800 ms; overflow and
upstream lengths cycle through 2500 and 4000 ms. Upstream uses drop mode and its
private statistics endpoint; other stall scenarios use catch-up mode.

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
slow sink. The fake service stays running throughout; phase timestamps are
monotonic. Admission order in the summary is first-observed order (two-second
resolution). A shed involving simultaneous first observations invalidates the
run because exact admission order is not exposed by the API. The driver checks
observed newest eligible automatic placement, reverse order and cooldown spacing; it cannot prove unexposed gate-window
history or the one-warning-per-minute rule. Keep core logs for those checks.

Summary latency proxies are the maxima of `peakHeldBytes10m`, `peakHeldMs10m` and
`laggardExcludeMsMax10m`. The largest occupied chunk bucket gives one chunk's
milliseconds at twice the configured sample rate. Consumer sibling latency is
checked against `ABSORBER_LAGGARD_MS` read directly from the source contract plus
that chunk allowance. Missing reports, histograms, branches or required fields
invalidate the experiment. Keep raw samples to inspect attribution windows and
placement changes beyond the automated checks.

The relay, analog and digital voice outputs are disabled. The current open-mode
core always starts its audio TCP listener: `audio.monitoring: false` disables the
raw input, but there is no configuration switch to disable the listener. That
port remains private and unpublished. No scratch port is fixed on the host.
