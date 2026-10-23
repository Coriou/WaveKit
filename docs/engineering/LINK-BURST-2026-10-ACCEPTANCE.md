# Link-burst resilience: fake-link acceptance (October 2026)

Requirements: [link-burst-resilience](../specs/link-burst-resilience/requirements.md) 9.1–9.4.
Budgets: [design, Budgets](../specs/link-burst-resilience/design.md#budgets-performance-rule-3).

## Summary

| Requirement | Status                   | Basis                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9.1         | Met                      | Lossless and overflow pass at both rates; every overflow interval is attributed `link`; overflow is below withheld − capacity by the downstream branch buffering (amendment open, see Open items)                                                                                                      |
| 9.2         | Met, with two open items | `consumer` passes at both rates under the amended two-part latency criterion (amendment open); `host` is attributed at both rates under a CPU-quota fixture, with a share of `consumer` (open item I); `unknown` for upstream drops is exercised only vacuously                                        |
| 9.3         | Met for one shed         | At both rates the newest eligible graduated catalogue placement is shed 30–41 s after the slow consumer starts (consistent with two of three 10 s windows), nothing else is shed, and the link-only phase sheds nothing; repeated sheds in reverse order were not exercisable (one eligible placement) |
| 9.4         | Partially met            | Desktop measured at both rates; event-loop p99 added 0 ms at 2.048 Msps; Pi 4-class column is an estimate pending measurement (task M.5)                                                                                                                                                               |

The final acceptance runs used builds B4 and B3 of the batch, defined below. Defects found on the
way (A–I) and the runs that found them are in the appendices.

## Method

- Driver `scripts/link-burst/run_acceptance.py`, Compose project `scripts/link-burst/compose.yaml`,
  README `scripts/link-burst/README.md`. Each run is a unique `wkburst-<pid>` project. The fake
  `rtl_tcp` (`scripts/capacity/fake_rtl_tcp.py`, its statistics served in the sdr-host status
  shape) and the core share a private `internal: true` network. A loopback forwarder publishes
  only the API, on an ephemeral `127.0.0.1` port. Every run's containers, network and volumes
  were removed at the end. No `wkburst` container or network remained after any run.
- `burstAbsorber.seconds: 2` is forced by environment. Stall intervals are 9, 1, 130, 50, 40, 71
  and 161 s. Lossless stalls cycle 150/500/1000/1800 ms; overflow, upstream and late-shed stalls
  cycle 2500/4000 ms. Upstream uses the fake's drop mode; the other stall scenarios use catch-up.
- Fanout branches on the source: the slow sink (`link-burst-slow-sink`, a gate-exempt YAML
  `rtl433` behind a throttling shim), an always-on YAML sibling (`link-burst-sibling`, the real
  `rtl_433`), the scanner branch while passive scanning runs, and the channelizer branch while the
  in-band catalogue placement (dsd-fme at 433.92 MHz) is admitted. The driver marks a run invalid
  if the sibling branch is missing from any sample.
- Host scenario: stress-ng runs inside the core container. The core is pinned to CPUs 0–1 under a
  0.75-CPU quota with four stress-ng workers, and the fake is pinned to the last Docker CPU. A
  quota-throttled core also stands in for a weak (Pi-class) core host.
- The driver samples link quality, efficiency, fanout, decoders and backpressure every 2 s
  (`samples.jsonl`) and writes aggregates and verdicts to `summary.json`. A sidecar recorded
  `docker logs` of the core and, every 10 s, `docker stats` of the core container plus the host's
  1-minute load average.
- Runs were sequential, one project at a time, with other heavy work on the host held off. The
  measurement interval is `--minutes 10`, except late-shed with `--minutes 12`: its latency check
  needs ten minutes in the consumer phase after the first sink drop, after up to 600 s of
  graduation, at least 180 s of link-only bursts and a source reconnect. A run the driver marks
  invalid is repeated once.
- Verdicts for consumer and late-shed use the amended latency criterion below. The driver
  implements it, and `run_acceptance.py --replay` recomputed every kept run from its samples,
  keeping the first summary as `summary.original.json`.

### Amended sibling latency criterion (9.2)

Laggard exclusion is evaluated on ingest and drain events. Its timing therefore carries the
event-loop delay of the moment. A non-excluded sibling also has to drain the held backlog after
the exclusion. The check is split in two:

1. Exclusion latency (pass/fail): `laggardExcludeMsMax10m` ≤ `ABSORBER_LAGGARD_MS` (500 ms) + one
   chunk (16.0 ms at 2.048 Msps, 13.65 ms at 2.4 Msps) + the loop delay of the interval in which it
   occurred or the one before, rounded up to the 10 ms loop-meter resolution.
2. Post-exclusion drain latency (`peakHeldMs10m`): ≤ bound 1 + held backlog ÷ the sibling's excess
   drain rate. The 2 s polls cannot measure that rate. The criterion therefore assumes one source
   byte rate (a sibling consuming at twice real time), reports the implied excess, and fails the
   run if the implied excess is below the assumption.

Any sibling drop fails the run.

In late-shed the driver applies the check only from ten minutes after the throttle start, because
until then the rolling maxima include the link-only phase. The exclusion latency at the throttle
start is reported from the samples instead.

## Environment

- Desktop reference host: Intel Core i5-1038NG7 (4 cores, 8 threads), 32 GiB, macOS. Docker ran in
  a Linux VM (OrbStack) with 6 CPUs and 7.8 GiB. Node 24.20.0 for the bench.
- Builds of the batch used by the runs:

| Build | Commit     | Contents                                             |
| ----- | ---------- | ---------------------------------------------------- |
| B0    | `476a85cf` | batch before the acceptance fixes (pre-fix baseline) |
| B1    | `4e690f29` | fixes A–D                                            |
| B2    | `347e9839` | fixes A–E                                            |
| B3    | `97f87f95` | fixes A–F                                            |
| B4    | `25b822f2` | fixes A–H                                            |

- Fixture commits (scratch project and driver only): `3669ddd9`, `5510e2e0`, `ec3058cf`,
  `321fc4e4`, `e5479ead`, `7cb3369c`, `8b84e942`, `69257f0a`. The B3 runs used the fixture as of
  `ec3058cf`, with verdicts recomputed by `321fc4e4`. The B4 runs used the fixture as of
  `e5479ead` or later; host runs used `69257f0a`.

## Results

Load is the host's 1-minute load average during the run (median / maximum). Core CPU is
`docker stats` of the core container, where 100 % is one CPU; it includes the decoders and
stress-ng (median / p90 / maximum). "Increases" are positive changes of the monitor's rolling
attribution counts between polls. Every run also has 2–10 `unknown` increases in its first
seconds and around 60 s, when passive scanning disables itself on this host. Those intervals
carry no drops; other `unknown` increases are listed per row.

### 2.048 Msps

| Scenario  | Build | Verdict | Key numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Load        | Core CPU, memory                       |
| --------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | -------------------------------------- |
| lossless  | B3    | PASS    | 4 branches 0.00 %; absorber overflow 0; increases none 294, unknown 4                                                                                                                                                                                                                                                                                                                                                                                              | 5.7 / 7.3   | 58 / 74 / 117 %, ≤ 358 MiB             |
| overflow  | B4    | PASS    | overflow 38 668 120 B; all 7 overflow intervals `link` (increases link 7, consumer 0, host 0); no suspension; 4 branches 0.00 %; overflow below withheld − capacity by 0.41–1.05 MB per event (see below)                                                                                                                                                                                                                                                          | 4.8 / 7.3   | 61 / 79 / 148 %, ≤ 328 MiB             |
| consumer  | B3    | PASS    | sink 84.89 %; sibling and scanner 0.00 %; consumer phase: consumer 300, unknown 1; exclusion 501.2 ms ≤ 546.0; drain 531.8 ms ≤ 1026.0 (backlog 1 966 080 B, implied excess 15.7×)                                                                                                                                                                                                                                                                                 | 4.2 / 5.5   | 26 / 42 / 133 %, ≤ 327 MiB             |
| host      | B4    | PASS    | quota fixture; absorber overflow 120 193 024 B; sibling 5.66 %, sink and scanner 0.00 %; increases host 92, consumer 143, none 62, unknown 1; no reconnect after start-up                                                                                                                                                                                                                                                                                          | 4.9 / 6.9   | 74 / 75 / 77 % (quota 0.75), ≤ 376 MiB |
| upstream  | B3    | PASS    | fake upstream drops 100 139 008 B; no core drops or overflow; every interval with upstream loss `none`                                                                                                                                                                                                                                                                                                                                                             | 22.5 / 33.7 | 49 / 81 / 144 %, ≤ 312 MiB             |
| late-shed | B3    | PASS    | link-only phase (607–808 s): link 3, none 5, no shed or suspension; reconnect condemned nothing; 41 s after throttling, dsd-fme (newest eligible) shed `late-drops` (gate state at the end: 3 of 3 windows condemned); consumer phase: consumer 300, unknown 8; nothing else shed in the remaining 680 s; YAML sink and sibling stayed admitted; siblings 0.00 %; exclusion at the throttle start 500.9 ms ≤ 536.0; no hold in the driver's window 10 min after it | 5.2 / 29.7  | 43 / 67 / 218 %, ≤ 336 MiB             |

### 2.4 Msps

| Scenario  | Build | Verdict | Key numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Load       | Core CPU, memory                       |
| --------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------- |
| lossless  | B4    | PASS    | 4 branches 0.00 %; absorber overflow 0; increases none 291, unknown 5                                                                                                                                                                                                                                                                                                                                                                                              | 5.7 / 7.3  | 70 / 95 / 123 %, ≤ 315 MiB             |
| overflow  | B4    | PASS    | overflow 45 507 816 B; all 7 overflow intervals `link` (one 4 s event straddled two polls); no suspension; 4 branches 0.00 %; overflow below withheld − capacity by 0.26–1.00 MB per event                                                                                                                                                                                                                                                                         | 5.1 / 6.9  | 72 / 95 / 136 %, ≤ 353 MiB             |
| consumer  | B4    | PASS    | sink 85.60 %; sibling and scanner 0.00 %; consumer phase: consumer 300, none 1; exclusion 500.6 ms ≤ 533.7; drain 535.9 ms ≤ 1052.5 (backlog 2 490 368 B, implied excess 14.7×)                                                                                                                                                                                                                                                                                    | 4.9 / 8.1  | 29 / 57 / 138 %, ≤ 332 MiB             |
| host      | B4    | PASS    | quota fixture; absorber overflow 673 416 192 B; sink 4.57 %, sibling and scanner 0.00 %; increases host 271, consumer 9, none 15, unknown 3; no reconnect after start-up                                                                                                                                                                                                                                                                                           | 4.8 / 7.5  | 74 / 75 / 75 % (quota 0.75), ≤ 374 MiB |
| upstream  | B4    | PASS    | fake upstream drops 137 101 312 B; no core drops or overflow; every interval with upstream loss `none`                                                                                                                                                                                                                                                                                                                                                             | 5.3 / 7.2  | 71 / 95 / 164 %, ≤ 318 MiB             |
| late-shed | B4    | PASS    | link-only phase (607–807 s): link 3, none 5, no shed or suspension; reconnect condemned nothing; 30 s after throttling, dsd-fme (newest eligible) shed `late-drops` (gate state at the end: 3 of 3 windows condemned); consumer phase: consumer 300, unknown 7; nothing else shed in the remaining 690 s; YAML sink and sibling stayed admitted; siblings 0.00 %; exclusion at the throttle start 502.4 ms ≤ 533.7; no hold in the driver's window 10 min after it | 5.1 / 10.1 | 49 / 81 / 161 %, ≤ 305 MiB             |

Rows from B3 are valid for the final record. The only change from B3 to B4 (fix H) gives host
evidence precedence over link evidence, which alters only intervals that carry host evidence
(loop delay ≥ `HOST_LOOP_DELAY_MS` or CPU at the guard) and that would otherwise have been
attributed `link`. In the B3 lossless, consumer, upstream and late-shed runs, only one polled
interval carried loss together with host evidence (late-shed, 964 s, loop delay 54 ms). It was
attributed `consumer`, which precedes both rules and is unchanged by H.

### Host contention without a quota

Before the quota fixture, B4 ran the host scenario at 2.4 Msps in two configurations. Neither
produced any loss, so the driver failed both with "host drops were not exercised":

| Configuration                                     | Core CPU (median / max) | Result                                                          |
| ------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| core on 5 CPUs, `stress-ng --cpu 0` (one per CPU) | 484 / 526 %             | every branch 0.00 %, no overflow, increases none 293, unknown 6 |
| core on 2 CPUs, `stress-ng --cpu 8`               | 198 / 218 %             | every branch 0.00 %, no overflow, increases none 296, unknown 2 |

The core kept up at 2.4 Msps with all of its CPUs saturated by competing workers. Host-caused
loss needed the core's whole cgroup throttled by a CPU quota.

### Overflow against withheld bytes

The withheld bytes beyond capacity are (stall − 2 s) × rate × 2 B. For a 2.5 s stall that is
2 048 000 B at 2.048 Msps and 2 400 000 B at 2.4 Msps; for a 4 s stall, 8 192 000 B and
9 600 000 B. Observed overflow per event is lower:

| Rate    | 2.5 s stalls: observed (expected − observed)                  | 4 s stalls: observed (expected − observed)                                   | merged start-up stall (≈ 5.04 s) |
| ------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| 2048000 | 1 573 992 (474 008); 1 638 400 (409 600); 1 573 616 (474 384) | 7 667 712 (524 288); 7 405 568 (786 432); 7 405 568 (786 432)                | 11 403 264 (1 048 576)           |
| 2400000 | 1 541 120 (858 880); 1 803 264 (596 736); 1 803 264 (596 736) | 9 339 904 (260 096); 8 815 992 (784 008); 8 604 528 over two polls (995 472) | 13 599 744 (992 256)             |

The difference, 0.26–1.05 MB, is bytes taken up downstream during the catch-up. Four branch
high-water marks (4 × 256 KiB = 1 MiB) plus the decoder pipe buffers account for it. Every branch
stayed at 0.00 %, so the lower overflow means fewer bytes lost, not hidden loss. The criterion "overflow equals withheld bytes beyond capacity within one release block" is therefore
met with downstream buffering, not within one 64 KiB block (Open items).

## Budgets (requirement 9.4)

Bench: `scripts/bench/burst-absorber.ts`, bundled as in its header and run with `--seconds 30` at
each rate on the batch head (`69257f0a`, product code as B4), host load 5.1–5.9. The measured
chunk rates come from the lossless runs: 62.6 chunks/s at 2.048 Msps and 72.6 chunks/s at
2.4 Msps, almost all 64 KiB.

| Item                  | Design budget, desktop 2.048 / 2.4 Msps                  | Measured desktop 2.048 / 2.4 Msps                                                                                                | Pi 4-class 2.048 / 2.4 Msps                                                                                 |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Recorder              | ≤ 0.002 / 0.002 core                                     | 396 / 370 ns per chunk: 0.000025 / 0.000027 core at the measured chunk rates; 0.0012 / 0.0011 core at 3 000 chunks/s             | estimate: 4× the desktop figure (design budget table), pending measurement (task M.5): 0.0001 / 0.0001 core |
| Absorber pass-through | < 0.001 / 0.001 core                                     | 614 / 599 ns per chunk: 0.00004 / 0.00004 core at the measured chunk rates; 0.0018 / 0.0018 core at 3 000 chunks/s (over budget) | estimate: 4× the desktop figure (design budget table), pending measurement (task M.5): 0.0002 / 0.0002 core |
| Absorber hold         | ≈ 0.005 core active; ≈ 0.0003 averaged                   | 0.0038 / 0.0045 core active; 0.00023 / 0.00027 averaged                                                                          | estimate: 4× the desktop figure (design budget table), pending measurement (task M.5): 0.015 / 0.018 active |
| Absorber release      | ≈ 0.003 core during catch-up                             | 0.00002 / 0.00002 core; largest synchronous drain 0.03 / 0.13 ms                                                                 | estimate: 4× the desktop figure (design budget table), pending measurement (task M.5): 0.0001 / 0.0001 core |
| Total steady state    | < 0.01 core                                              | < 0.0001 core at the measured chunk rates                                                                                        | estimate: 4× the desktop figure (design budget table), pending measurement (task M.5): < 0.0004 core        |
| Event-loop p99 added  | ≤ 2 ms at 2.048 Msps (rule 2); release step ≈ 0.2–0.6 ms | 0 / 0 ms p99 added against a paced direct-fanout baseline (10 ms histogram resolution); max added 0 / 2.85 ms                    | estimate: 4× the desktop figure (design budget table), pending measurement (task M.5)                       |
| Memory                | ring 8.2 / 9.6 MB; recorder < 64 KB                      | ring 8 192 000 / 9 600 000 B, preallocated; whole core container ≤ 358 / 353 MiB in the lossless and overflow runs               | same (preallocated)                                                                                         |

Whole-container CPU in the acceptance runs is in the result tables. It includes the decoders,
the channelizer and the scanner, so it is not comparable with the per-component budget lines.

## Attribution check limitation

The link-quality API exposes rolling `counts10m` and the latest attribution, without completed
interval identities. The driver checks attribution in aggregate
(`attributionCheck: "aggregate"`). For the tables above, each overflow increase was paired with
the attribution increases seen in that poll and the next three; deferred intervals resolve up to
two polls later. That pairing is approximate at 2 s resolution. The core's own
"Drop interval attributed" log lines are rate-limited to one per minute per class and were used as
a cross-check.

## Open items

1. Spec amendment, 9.1: replace "overflow equals withheld bytes beyond capacity within one
   release block" with "overflow ≤ withheld − capacity and ≥ that minus the sum of downstream
   branch buffers".
2. Spec amendment, 9.2: the sibling latency criterion becomes the two-part check above. Exclusion
   latency includes the measured loop delay; post-exclusion drain is bounded by the backlog at the
   sibling's excess drain rate.
3. Attribution accuracy under host overload (I): when a light branch (here the scanner) survives
   host overload, intervals in which only a subset of branches drops are attributed `consumer`.
   That was 143 of 235 at 2.048 Msps and 9 of 280 at 2.4 Msps. Gate behaviour is unaffected, since
   both classes condemn. Candidate follow-up: when host evidence holds, prefer `host` over
   `consumer` unless the dropping subset is a single branch already excluded as a laggard.
4. Upstream `unknown`: core loss never coincided with upstream loss, so every interval with
   upstream loss was `none`. The `unknown` classification of core drops in the presence of upstream
   loss was not exercised.
5. Late shed: only one catalogue placement was in band and eligible, so "later sheds one per
   cooldown in reverse admission order" was not exercised. The one-warning-per-minute rule was
   seen only as a single warning per run.
6. Absorber pass-through cost exceeds its desktop budget only at the design's upper chunk rate
   (3 000 chunks/s, 0.0018 core); at the measured rates it is 0.00004 core.
7. Pi 4-class CPU and memory: pending measurement (task M.5); requirement 9.4 stays partially met
   until then.

## Appendix A: pre-fix baseline (B0)

Runs on B0 with the first two fixture commits. The host was loaded by other work for several
runs (load in the table). The remaining 2.4 Msps scenarios were not run on B0.

| Rate    | Scenario     | Driver  | Key numbers                                                                                                                                                                                           | Load                   |
| ------- | ------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 2048000 | lossless     | FAIL    | host-loaded: slow sink 0.056 % (1 376 256 B) and absorber overflow 851 968 B in one event as the load peaked                                                                                          | 11.8 / 88.6            |
| 2048000 | overflow     | PASS    | overflow 39 190 528 B; 6 of 7 overflow events `link`, the first `unknown`                                                                                                                             | 27.6 / 73.3            |
| 2048000 | consumer, ×2 | INVALID | "slow sink never dropped in pause mode": with the scanner branch gone and no other sibling, the absorber stayed full and discarded about 949 MB as overflow, hold age 241 s, all `unknown` (defect C) | 6.4 / 8.2; 17.6 / 23.2 |
| 2048000 | host         | FAIL    | `host` on every lossy interval (9 increases), but the loss was absorber overflow (16 646 144 B), which the driver's drop check then ignored (fixed in `ec3058cf`)                                     | 56.9 / 106.8           |
| 2048000 | upstream     | PASS    | upstream drops 100 139 008 B; no core loss                                                                                                                                                            | 10.2 / 45.1            |
| 2048000 | late-shed    | FAIL    | the source reconnect suspended the only graduated placement, so nothing was sheddable (defect D); consumer phase mostly `unknown`                                                                     | 7.1 / 21.6             |
| 2400000 | upstream     | PASS    | upstream drops 117 702 656 B; no core loss                                                                                                                                                            | 11.5 / 33.8            |

Before the second fixture commit, every interval was attributed `unknown`, because the fake's
statistics were not in the shape the core reads.

## Appendix B: defects found and fixed

| Id  | Found on | Defect                                                                                                                                                                                   | Fixed in  |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| A   | B0       | Attribution evidence required an upstream counter: a source without sdr-host status got permanent `unknown`                                                                              | B1        |
| B   | B0       | Shortfall evidence came from the 5 s byte-rate metric; at the tick that saw an overflow it still covered the stall, so overflow intervals were `unknown` and could condemn a probationer | B1        |
| C   | B0       | A lone congested branch was never excluded; the absorber held at capacity indefinitely                                                                                                   | B1        |
| D   | B0       | A source reconnect suspended a graduated placement with `drops`                                                                                                                          | B1        |
| E   | B1       | The laggard hold delayed siblings and the release overfilled them (sibling 0.99 % in consumer and late-shed); the hold/exclude cycle repeated                                            | B2        |
| F   | B2       | With E's paced release, a drop interval after an ingest gap was classified before recovery was proven: 2.5 s overflow intervals were `unknown`, the following interval `link`            | B3        |
| G   | B2       | Not a defect: post-exclusion drain at the sibling's pace exceeds the original single latency bound (585.5 ms at 2.4 Msps); resolved by the amended two-part criterion                    | criterion |
| H   | B3       | Link took precedence over host: under stress-ng the starved fake produced a real ingest gap and host overload was attributed `link`                                                      | B4        |
| I   | B4       | Open: host overload with a surviving light branch is partly attributed `consumer` (Open items)                                                                                           | open      |

## Appendix C: superseded runs

| Build | Rate    | Scenario  | Driver (amended criterion) | Key numbers                                                                                                                                                                |
| ----- | ------- | --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | 2048000 | lossless  | PASS                       | 4 branches 0.00 %                                                                                                                                                          |
| B1    | 2048000 | overflow  | PASS                       | overflow 38 076 416 B; overflow intervals after start-up `link`; the first (t ≈ 14 s) overlaps a start-up `unknown`                                                        |
| B1    | 2048000 | consumer  | FAIL                       | sibling 27 001 208 B (0.99 %) on hold releases (E); exclusion 529.9 ms ≤ 546.0                                                                                             |
| B1    | 2048000 | host      | PASS                       | host 62, link 7, consumer 6; sibling 7.18 %, sink 6.62 %; stress on every CPU, fake not isolated                                                                           |
| B1    | 2048000 | upstream  | PASS                       | upstream drops 100 139 008 B; no core loss                                                                                                                                 |
| B1    | 2048000 | late-shed | FAIL                       | correct single shed of dsd-fme (D fixed), but sibling 61 341 696 B (0.99 %) (E); exclusion 541.8 ms > 536.0                                                                |
| B2    | 2048000 | overflow  | PASS (aggregate)           | the three 2.5 s overflow intervals `unknown`, next interval `link` (F)                                                                                                     |
| B2    | 2048000 | consumer  | PASS                       | sibling 0.00 %; exclusion 500.1 ms ≤ 546.0; drain 531.0 ms ≤ 1026.0                                                                                                        |
| B2    | 2048000 | late-shed | PASS                       | single correct shed; siblings 0.00 %                                                                                                                                       |
| B2    | 2400000 | lossless  | PASS                       | 4 branches 0.00 %                                                                                                                                                          |
| B2    | 2400000 | overflow  | PASS (aggregate)           | one 4 s overflow interval `unknown` before `link` (F)                                                                                                                      |
| B2    | 2400000 | consumer  | PASS                       | sibling 0.00 %; exclusion 501.6 ms ≤ 543.7; drain 585.5 ms ≤ 1062.5 (G)                                                                                                    |
| B3    | 2048000 | host      | FAIL                       | stress on every CPU starved the fake: one loss event attributed `link` (gap 337 ms, loop 216 ms, CPU 100 %) and `consumer`, no `host` (H)                                  |
| B3    | 2048000 | overflow  | PASS                       | all 7 overflow intervals `link`                                                                                                                                            |
| B4    | 2400000 | upstream  | INVALID ×2                 | "upstream statistics are unavailable": the first sample preceded the sdr-host poller's first successful read (6.4 s after start); the driver now waits for it (`7cb3369c`) |

## Follow-ups (2026-10-23)

Code follow-ups to open items 3–6. The recorded results above are unchanged; the fake-link
matrix has not been rerun.

1. **Host versus consumer (item 3).** A strict subset of dropping branches with no overflow is
   `consumer` only when the interval has no host evidence (loop delay below
   `HOST_LOOP_DELAY_MS` and CPU below the guard). With host evidence it falls through to the
   upstream rule (`unknown`) and then `host`. The candidate exception, "unless the dropping
   subset is a single branch already excluded as a laggard", was not adopted: with an absorber
   attached, chunks reach the fanout only once every congested active branch is excluded, and a
   branch drops only while congested, so every branch drop lands on a laggard. The exception
   would have kept a single-branch host-overload subset `consumer`. A slow sink on a healthy
   host stays `consumer`. Both classes condemn on probation and in late windows, so gate
   behaviour is unchanged. One change: a subset with host evidence and upstream loss is now
   `unknown` instead of `consumer`, so it no longer counts toward a late shed. Spec amendment
   needed: requirement 3.3, design rule 3 and property 7 gain "and no host evidence".
2. **Upstream `unknown` (item 4).** Deterministic tests with an injected clock and a fake
   upstream counter cover these cases: an all-branch link burst is `link` with flat upstream and
   `unknown` with an upstream rise; upstream loss outranks host evidence; upstream loss alone is
   `none`; a held gap loss that resolves after an upstream rise is `unknown`. No code change was
   needed.
3. **Repeated late shed (item 5).** A gate-level test with four eligible placements, interleaved
   with YAML, `always` and operator placements, sheds in reverse admission order. Each shed
   lands exactly at the cooldown bound, never at bound − 1, even when fresh condemning windows
   arrive inside the cooldown. Protected placements are never shed. A property test covers
   random mixes (100 runs). No code change was needed.
4. **Absorber pass-through (item 6).** `gated()` now reads only the congested set while no
   branch is congested and no per-branch state is held. In that case the full pass prunes
   nothing and returns false. The ingest path also skips `rotate()` within the current slot
   while nothing is held. A tight-loop microbenchmark (65 536 B chunks, three branches, load
   about 4.4) measured about 190 ns per chunk before and about 74 ns after. At 3 000 chunks/s
   that is about 0.0002 core, within the < 0.001 budget. The repository bench timer uses one
   `performance.now()` pair per chunk (about 114 ns per pair on this host). At load 3.4–5.1 it
   gave 513–854 ns before and 495–1 011 ns after, so it cannot resolve this change. A
   batch-timed variant is needed to confirm.
5. **Driver.** The host scenario fails when consumer is more than 10 % of the aggregate
   host-or-consumer increases. A new `upstream-host` scenario combines upstream drop-mode
   stalls with the host CPU quota and stress. It requires a poll in which both core loss and
   upstream loss rose, an `unknown` increase within three polls of it, and no `link` increase.
6. **Batch-timed pass-through (item 6 confirmation).** The bench now reports
   `passThroughBatchedNsPerChunk`: steady-state pass-through with no branch congested, timed in
   batches of 1 000 chunks (4 096, 16 384 and 65 536 B in rotation, three branches) per
   `performance.now()` pair, minus a batched direct-fanout baseline, median of 50 batch pairs
   after 5 discarded. "Before" is the parent of the host-evidence commit with the new bench
   harness copied in (absorber unchanged); "after" is this branch. Runs alternated
   before/after, `--seconds 30`, on a heavily loaded host (1-minute load averages 10–22):

   | Rate (sps) | Build  | Load avg (1/5/15 min) | ns/chunk | Core at 3 000 chunks/s |
   | ---------- | ------ | --------------------- | -------- | ---------------------- |
   | 2 048 000  | before | 22.49 / 12.53 / 9.20  | 565      | 0.0017                 |
   | 2 048 000  | after  | 22.12 / 14.95 / 10.38 | 367      | 0.0011                 |
   | 2 048 000  | before | 12.76 / 13.56 / 10.17 | 828      | 0.0025                 |
   | 2 048 000  | after  | 17.72 / 15.02 / 10.97 | 184      | 0.0006                 |
   | 2 400 000  | before | 10.26 / 13.41 / 10.65 | 557      | 0.0017                 |
   | 2 400 000  | after  | 15.56 / 13.92 / 11.00 | 262      | 0.0008                 |
   | 2 400 000  | before | 15.80 / 14.58 / 11.46 | 809      | 0.0024                 |
   | 2 400 000  | after  | 14.00 / 14.51 / 11.66 | 164      | 0.0005                 |

   The fast path cuts batched pass-through cost by roughly 2–5x. Before exceeds the < 0.001
   budget in every run; after is within it in three of four runs and at 0.0011 in the run with
   the highest load. These numbers include scheduler contention from the loaded host; a quiet
   host rerun is still needed for a clean budget figure.
