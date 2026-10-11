# Channelizer capacity: 1/4/8 AIS channels at 2.048 and 2.4 Msps vs bounded CSDR

Recorded 2026-10-10, 13:17–16:20 CEST (plan Task 36, addendum §9). This covers
software CPU, memory and delivery for the opt-in channelizer (`wavekit-chan`)
against the raw path with bounded CSDR rings, replaying composed AIS fixtures.
It is not RF acceptance and not a Pi-class measurement. Raw artifacts are in
`output/capacity/t36-*` (gitignored). Older `docs/CAPACITY-*.md` figures predate
band suspension and digital voice, so they are context only, never the
baseline (delta E13).

## Verdict

| Criterion (addendum §9, plan T36 step 3)                                        | Result                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every run exits 0; all N instances running, none suspended, at window start/end | **PASS**: 48/48 cells exit 0, no exit 5, no restarts, no source disconnects, no aborts, no OOM kills                                                                                                                                                 |
| Zero `queue-overflow` discontinuities at target load (paced)                    | **PASS**: 0 in all 24 channelizer cells, paced and unpaced; 0 dropped and 0 saturated channel samples                                                                                                                                                |
| RSS/PSS bounded, no monotonic growth                                            | **PASS**: no cell grows monotonically; worst window growth +5 MiB cgroup, PSS flat or shrinking; `wavekit-chan` PSS ≤ 5 MiB                                                                                                                          |
| Decoded set on the signal channel equals the bounded-CSDR run, covers payloads  | **Strict: 4/12 paced cells equal. Under QH-11/QH-14: 12/12 PASS**: every paced cell covers the three expected payloads, count ≥ `min_count`, and every raw-only key is in `expected.marginal_keys`; channelizer-only keys are CRC-checked AIS frames |
| Unpaced runs complete without unbounded memory                                  | **PASS**: 24/24 complete; cgroup max ≤ 967 MiB under the 1 GiB cap at N = 8                                                                                                                                                                          |

Orchestrator rulings (2026-10-10):

- **QH-15:** the paced decoded-set criterion is read under QH-11/QH-14 → 12/12 PASS (strict equal still reported per cell).
- **QH-16:** N=1 and N=4 PASS; N=8 "passes §9, conditional" — not recommended on a ≤4-core host or under a CPU quota until a follow-up raises the default inputHighWaterMark and/or adds the AVX2/FMA path or per-channel DSP threads, then re-measure N=8 on a dedicated host.

Two findings need a reader's attention:

1. **Input-branch drops at N = 8 under the 4-CPU quota.** The channelizer's
   single input branch dropped 1.39–2.04 % of bytes in the four paced N = 8
   cells (and 0.26 % at 2.4 Msps N = 4 spread). These are `input-gap`
   discontinuities, not `queue-overflow`, so the §9 criterion holds, but every
   channel loses those samples together. The raw path dropped 0–0.15 % in the
   same cells. A diagnostic rerun of the worst cell with `--cpus 6`
   (2.4 Msps, N = 8, clustered, paced) dropped **0.00 %** with 0 s throttled
   and the same `wavekit-chan` CPU (0.885 cores): the drops come from CFS
   quota throttling (13–15 s throttled per 180 s window, most likely from
   AIS-catcher's bursty threads) stalling `wavekit-chan`'s one DSP thread
   while the input branch holds only `channelizer.inputHighWaterMark`
   (262 144 bytes, about 55–64 ms of IQ). The raw path, with one branch per
   decoder, saw 16–18 s of throttling in the same cells with at most 0.15 %
   drops.
2. **`wavekit-chan` has little single-core headroom at N = 8 on this CPU.**
   Paced, it uses 0.78–0.88 of one core at N = 8 (0.49–0.62 at N = 4,
   0.21–0.26 at N = 1). Unpaced at N = 4 and 8 it pins at 0.98–0.99 cores and moves only
   0.97–1.13 × real time at N = 8 (1.98–2.34 × at N = 4, 6.5–8.0 × at N = 1).
   A slower or busier host would turn the N = 8 case into sustained input
   drops. Research [3]'s AVX2/FMA `target_feature` path (or moving channel
   DSP off the single input thread) is the next step; not implemented here.

## Host, image and settings

| Item               | Value                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host               | Mac, Intel Core i5-1038NG7 @ 2.00 GHz (4 cores / 8 threads), 32 GiB, macOS 15.7.9                                                                                                                               |
| Docker             | OrbStack 2.2.3, engine 29.4.0, kernel 7.0.14-orbstack, VM 6 vCPUs / 7.8 GiB, VM MemAvailable ≈ 7.0 GiB at preflight                                                                                             |
| Image              | `wavekit:chan-46fbe76`, `sha256:018a28881091d11de5f7483690c9ba704802439f536a12a3b9fe478ccd92ff31` (amd64, bake `final-core`, built from clean `46fbe76`; ruling QH-2)                                           |
| `wavekit-chan`     | `wavekit-chan 0.1.0 protocol 1`                                                                                                                                                                                 |
| Shipped code       | main `1415743` (channelizer merge). `git diff --stat 46fbe76 1415743 -- src native Dockerfile docker packages config` is empty, so the image is the shipped code                                                |
| Driver HEAD        | `e7fbc1b` (16 cells) then `3b470f8` (32 cells; another session's docs-only `AGENTS.md` commit). Both include the `summarize.py` fix `e7fbc1b` (ruling FINAL-residual-1); no capacity-script change between them |
| Fixtures           | `composed_ais_162m_2048k` sha256 `9a2c4432…df0c63166`; `composed_ais_162m_2400k` sha256 `1e137e2d…18a1d3470` (`download.sh` exit 0, sha verified)                                                               |
| Cell               | `--buffers on` (bounded CSDR), warm-up 30 s, window 180 s, sampler 5 s, `--cpus 4`; `--memory 640m` for N = 1/4, **`1g` for every N = 8 cell** (both paths)                                                     |
| Pinned (delta E12) | `health.bandSuspension: false`, `digitalVoice.enabled: false`, `liveDemod.enabled: false`, `stateDir: /tmp/wkcap-state`                                                                                         |
| Rate truth         | Paced: no warning. Unpaced: every cell logs `Source delivers a different sample rate than its caps declare; caps left unchanged` (expected: the fake source delivers ~1 GS/s). It only warns                    |
| `wavekit-app`      | stopped for the whole run (preflight protect stats 0 %); the Pi was not touched                                                                                                                                 |

**The host was not dedicated.** macOS 1-minute load before each cell was
2.4–7.5 for most cells, with peaks of 8.8–15.6 before four 2.048 Msps
N = 8 cells (other sessions, `mediaanalysisd` at about 50 % of a core,
`fseventsd`/`mds_stores` bursts). The raw path's spread and clustered cells
are the same configuration (raw AIS-catcher ignores `channelHz`), so their
spread measures run-to-run noise: up to ±0.3 cores (for example 0.80 vs 0.54
at 2.048 Msps N = 4). Treat CPU differences below about 0.3 cores as noise.
Per-cell load is in `output/capacity/t36-batch.log`.

## Method

```bash
./fixtures/download.sh composed_ais_162m_2048k composed_ais_162m_2400k   # exit 0
for rate in 2048000 2400000; do for n in 1 4 8; do for p in spread clustered; do
  for pb in paced unpaced; do for chan in off on; do
    python3 scripts/capacity/run_capacity.py --image wavekit:chan-46fbe76 --rate $rate \
      --buffers on --channelizer $chan --channels $n --placement $p --playback $pb \
      --fixture composed_ais_162m_${rate%000}k --memory $([ $n = 8 ] && echo 1g || echo 640m) \
      --out output/capacity/t36-chan-$chan-$rate-$n-$p-$pb
done; done; done; done; done
python3 scripts/capacity/summarize.py output/capacity/t36-chan-*/
```

Cells ran strictly one at a time, off then on for each cell, in the order of
the loop. Each instance is one AIS-catcher at an admissible placement
(plan A10); the raw path runs N full-rate AIS-catchers on the capture (it
ignores `channelHz`), and the channelizer path runs N AIS-catchers on 384 kHz
channels from one `wavekit-chan`. The instance on the signal channel
(162.000 MHz, the A/B pair centre) has its outputs collected over the window
and reduced to the `["mmsi","messageType"]` key set. Each window replays the
fixture about ten times (17.0 s loop), so `min_count` (one pass) is a floor.
CPU is cgroup `usage_usec` over the window minus the sampler;
`wavekit-chan` is `cpuCores.wavekitChan`. Every channelizer cell had 36
stats lines in the window, the first within 3.6 s of the start and the last
within 2.1 s of the end, and no `warnings`.

### Placements (`placements()` dry run, offsets from 162 MHz)

All admissible, the signal channel at offset 0 in every case. AIS needs
`h = out/2 = 192 kHz`, so the admissible centre range is ±627.2 kHz at
2.048 Msps and ±768 kHz at 2.4 Msps.

| Rate  | N   | Spread (kHz)                                         | Clustered (kHz)                                       |
| ----- | --- | ---------------------------------------------------- | ----------------------------------------------------- |
| 2.048 | 1   | 0                                                    | 0                                                     |
| 2.048 | 4   | −470.4, 0, +156.8, +470.4                            | −627.2, −209.1, 0, +627.2                             |
| 2.048 | 8   | −548.8, −392, −235.2, 0, +78.4, +235.2, +392, +548.8 | −627.2, −448, −268.8, 0, +89.6, +268.8, +448, +627.2  |
| 2.4   | 1   | 0                                                    | 0                                                     |
| 2.4   | 4   | −576, 0, +192, +576                                  | −720, 0, +240, +720                                   |
| 2.4   | 8   | −672, −480, −288, 0, +96, +288, +480, +672           | −768, −548.6, −329.1, 0, +109.7, +329.1, +548.6, +768 |

**Clustered is wider than spread for AIS.** Clustered spacing is
`min(1.25 × out, ⌊2L/(N − 1)⌋)`; with 384 kHz channels, 1.25 × out = 480 kHz
always exceeds `2L/(N − 1)`, so the cluster spans the whole admissible range
(±L), while spread stops half a step inside each edge. For AIS the two modes
do not test "near" versus "far" channels; a narrow decoder type would. The
CPU cost does not depend on the offsets anyway (one NCO per channel).

## Paced CPU, raw vs channelizer (cores, 4-CPU quota)

| Rate (Msps) | N   | Placement | Raw  | Channelizer (of which `wavekit-chan`) | Δ     | Branch drop % raw / chan |
| ----------- | --- | --------- | ---- | ------------------------------------- | ----- | ------------------------ |
| 2.048       | 1   | spread    | 0.24 | 0.32 (0.22)                           | +0.09 | 0.00 / 0.00              |
| 2.048       | 1   | clustered | 0.19 | 0.30 (0.21)                           | +0.11 | 0.00 / 0.00              |
| 2.048       | 4   | spread    | 0.80 | 0.75 (0.56)                           | −0.05 | 0.00 / 0.00              |
| 2.048       | 4   | clustered | 0.54 | 0.69 (0.49)                           | +0.15 | 0.00 / 0.00              |
| 2.048       | 8   | spread    | 1.69 | 1.10 (0.78)                           | −0.59 | 0.00 / 1.39              |
| 2.048       | 8   | clustered | 1.38 | 1.23 (0.85)                           | −0.16 | 0.15 / 1.62              |
| 2.4         | 1   | spread    | 0.23 | 0.37 (0.26)                           | +0.14 | 0.00 / 0.00              |
| 2.4         | 1   | clustered | 0.23 | 0.38 (0.26)                           | +0.14 | 0.00 / 0.00              |
| 2.4         | 4   | spread    | 0.79 | 0.74 (0.55)                           | −0.05 | 0.00 / 0.26              |
| 2.4         | 4   | clustered | 0.83 | 0.82 (0.62)                           | −0.01 | 0.01 / 0.00              |
| 2.4         | 8   | spread    | 1.90 | 1.19 (0.86)                           | −0.71 | 0.00 / 1.59              |
| 2.4         | 8   | clustered | 1.71 | 1.21 (0.88)                           | −0.50 | 0.00 / 2.04              |

At N = 1 the channelizer costs about +0.1 core: `wavekit-chan`'s
0.21–0.26 cores exceed the downconversion it saves AIS-catcher. At
N = 4 the two paths are within noise. At N = 8 the channelizer path uses
0.16–0.71 cores less, because eight AIS-catchers on 384 kHz channels are
cheaper than eight on the full capture, but its work sits on one thread
(see the verdict). Memory is dominated by AIS-catcher (≈ 90 MiB PSS per
instance) on both paths; `wavekit-chan` adds 2–5 MiB.

## Full results

Columns: CPU is cores over the 180 s window (user/system); throttled is CFS
throttled seconds in the window; cgroup max is the largest `memory.current`
sample; PSS is the sum over all processes at the last sample; branch drop is
dropped / offered bytes over all fanout branches; decodes and keys are the
signal instance's outputs and distinct `[mmsi, messageType]` keys; q-ovf is
`queue-overflow` discontinuities, chan drop/sat the channel queue drops and
saturated samples, queue HW the largest channel queue high-water mark (all
channelizer only). Decoded set compares the channelizer cell with the raw
cell of the same rate, N, placement and playback: − keys only raw decoded,

- keys only the channelizer decoded.

### 2.048 Msps (`composed_ais_162m_2048k`)

| N   | placement | playback | path | CPU total (user/sys) | wavekit-chan | throttled s | cgroup max MiB | PSS MiB | branch drop % | decodes | keys | q-ovf | chan drop/sat | queue HW B | decoded set vs raw                                              |
| --- | --------- | -------- | ---- | -------------------- | ------------ | ----------- | -------------- | ------- | ------------- | ------- | ---- | ----- | ------------- | ---------- | --------------------------------------------------------------- |
| 1   | spread    | paced    | off  | 0.24 (0.22/0.02)     | 0.00         | 0.0         | 311            | 180     | 0.00          | 630     | 31   | –     | –             | –          |                                                                 |
| 1   | spread    | paced    | on   | 0.32 (0.30/0.03)     | 0.22         | 0.0         | 246            | 182     | 0.00          | 640     | 32   | 0     | 0/0           | 24576      | ≠ −[203245890,24] +[993672090,21],[993672721,21]                |
| 1   | spread    | unpaced  | off  | 2.95 (2.45/0.50)     | 0.00         | 0.0         | 284            | 217     | 98.44         | 3184    | 33   | –     | –             | –          |                                                                 |
| 1   | spread    | unpaced  | on   | 3.22 (2.65/0.57)     | 0.86         | 0.2         | 301            | 224     | 98.35         | 3698    | 32   | 0     | 0/0           | 86016      | ≠ −[993672090,21]                                               |
| 1   | clustered | paced    | off  | 0.19 (0.18/0.01)     | 0.00         | 0.0         | 244            | 178     | 0.00          | 630     | 31   | –     | –             | –          |                                                                 |
| 1   | clustered | paced    | on   | 0.30 (0.27/0.03)     | 0.21         | 0.0         | 247            | 185     | 0.00          | 640     | 32   | 0     | 0/0           | 18432      | ≠ −[203245890,24] +[993672090,21],[993672721,21]                |
| 1   | clustered | unpaced  | off  | 2.99 (2.45/0.54)     | 0.00         | 0.0         | 293            | 205     | 98.56         | 3156    | 33   | –     | –             | –          |                                                                 |
| 1   | clustered | unpaced  | on   | 3.20 (2.67/0.53)     | 0.84         | 0.1         | 297            | 220     | 98.32         | 3463    | 33   | 0     | 0/0           | 73728      | equal                                                           |
| 4   | spread    | paced    | off  | 0.80 (0.75/0.05)     | 0.00         | 0.4         | 524            | 453     | 0.00          | 630     | 31   | –     | –             | –          |                                                                 |
| 4   | spread    | paced    | on   | 0.75 (0.71/0.04)     | 0.56         | 1.4         | 524            | 465     | 0.00          | 639     | 31   | 0     | 0/0           | 18432      | equal                                                           |
| 4   | spread    | unpaced  | off  | 3.95 (3.47/0.48)     | 0.00         | 45.5        | 572            | 510     | 98.63         | 2030    | 34   | –     | –             | –          |                                                                 |
| 4   | spread    | unpaced  | on   | 3.37 (2.88/0.49)     | 0.99         | 18.6        | 594            | 498     | 99.49         | 953     | 32   | 0     | 0/0           | 30720      | ≠ −[368161520,18],[687290789,8],[993672090,21] +[203245890,24]  |
| 4   | clustered | paced    | off  | 0.54 (0.51/0.03)     | 0.00         | 0.6         | 522            | 457     | 0.00          | 630     | 31   | –     | –             | –          |                                                                 |
| 4   | clustered | paced    | on   | 0.69 (0.65/0.04)     | 0.49         | 1.2         | 530            | 468     | 0.00          | 639     | 31   | 0     | 0/0           | 12288      | equal                                                           |
| 4   | clustered | unpaced  | off  | 3.91 (3.44/0.47)     | 0.00         | 38.3        | 568            | 493     | 98.44         | 2183    | 34   | –     | –             | –          |                                                                 |
| 4   | clustered | unpaced  | on   | 3.31 (2.82/0.49)     | 0.99         | 19.2        | 579            | 502     | 99.44         | 939     | 31   | 0     | 0/0           | 43008      | ≠ −[368161520,18],[993672090,21],[993672721,21]                 |
| 8   | spread    | paced    | off  | 1.69 (1.60/0.09)     | 0.00         | 17.8        | 909            | 822     | 0.00          | 630     | 31   | –     | –             | –          |                                                                 |
| 8   | spread    | paced    | on   | 1.10 (1.05/0.05)     | 0.78         | 14.6        | 912            | 833     | 1.39          | 644     | 31   | 0     | 0/0           | 12288      | equal                                                           |
| 8   | spread    | unpaced  | off  | 3.99 (3.59/0.40)     | 0.00         | 157.7       | 935            | 855     | 98.46         | 1228    | 33   | –     | –             | –          |                                                                 |
| 8   | spread    | unpaced  | on   | 3.25 (2.78/0.48)     | 0.99         | 21.0        | 952            | 858     | 99.69         | 409     | 31   | 0     | 0/0           | 30720      | ≠ −[203245890,24],[368161520,18],[993672721,21] +[367564350,18] |
| 8   | clustered | paced    | off  | 1.38 (1.30/0.08)     | 0.00         | 18.0        | 925            | 852     | 0.15          | 630     | 31   | –     | –             | –          |                                                                 |
| 8   | clustered | paced    | on   | 1.23 (1.15/0.07)     | 0.85         | 15.1        | 950            | 835     | 1.62          | 637     | 31   | 0     | 0/0           | 12288      | equal                                                           |
| 8   | clustered | unpaced  | off  | 3.99 (3.61/0.38)     | 0.00         | 144.9       | 948            | 864     | 98.56         | 1190    | 33   | –     | –             | –          |                                                                 |
| 8   | clustered | unpaced  | on   | 3.32 (2.84/0.48)     | 0.98         | 19.5        | 937            | 863     | 99.73         | 497     | 32   | 0     | 0/0           | 46656      | ≠ −[993672090,21],[993672721,21] +[368161520,18]                |

### 2.4 Msps (`composed_ais_162m_2400k`)

| N   | placement | playback | path | CPU total (user/sys) | wavekit-chan | throttled s | cgroup max MiB | PSS MiB | branch drop % | decodes | keys | q-ovf | chan drop/sat | queue HW B | decoded set vs raw                               |
| --- | --------- | -------- | ---- | -------------------- | ------------ | ----------- | -------------- | ------- | ------------- | ------- | ---- | ----- | ------------- | ---------- | ------------------------------------------------ |
| 1   | spread    | paced    | off  | 0.23 (0.21/0.02)     | 0.00         | 0.0         | 252            | 211     | 0.00          | 641     | 32   | –     | –             | –          |                                                  |
| 1   | spread    | paced    | on   | 0.37 (0.34/0.03)     | 0.26         | 0.0         | 258            | 201     | 0.00          | 642     | 33   | 0     | 0/0           | 26214      | ≠ −[993672078,21] +[203245890,24],[367564350,18] |
| 1   | spread    | unpaced  | off  | 2.88 (2.37/0.51)     | 0.00         | 0.0         | 306            | 214     | 98.41         | 2534    | 35   | –     | –             | –          |                                                  |
| 1   | spread    | unpaced  | on   | 3.14 (2.63/0.51)     | 0.85         | 0.4         | 296            | 219     | 98.12         | 2970    | 34   | 0     | 0/0           | 68156      | ≠ −[368161520,18]                                |
| 1   | clustered | paced    | off  | 0.23 (0.21/0.02)     | 0.00         | 0.0         | 252            | 183     | 0.00          | 641     | 32   | –     | –             | –          |                                                  |
| 1   | clustered | paced    | on   | 0.38 (0.34/0.04)     | 0.26         | 0.0         | 246            | 183     | 0.00          | 642     | 33   | 0     | 0/0           | 26214      | ≠ −[993672078,21] +[203245890,24],[367564350,18] |
| 1   | clustered | unpaced  | off  | 2.92 (2.39/0.54)     | 0.00         | 0.2         | 313            | 208     | 98.55         | 2330    | 35   | –     | –             | –          |                                                  |
| 1   | clustered | unpaced  | on   | 3.19 (2.65/0.54)     | 0.85         | 0.9         | 336            | 231     | 98.29         | 2771    | 35   | 0     | 0/0           | 62474      | equal                                            |
| 4   | spread    | paced    | off  | 0.79 (0.74/0.05)     | 0.00         | 1.2         | 528            | 483     | 0.00          | 641     | 32   | –     | –             | –          |                                                  |
| 4   | spread    | paced    | on   | 0.74 (0.70/0.04)     | 0.55         | 1.3         | 541            | 473     | 0.26          | 657     | 33   | 0     | 0/0           | 15730      | ≠ +[203245890,24]                                |
| 4   | spread    | unpaced  | off  | 3.91 (3.43/0.49)     | 0.00         | 36.6        | 577            | 509     | 98.51         | 1864    | 36   | –     | –             | –          |                                                  |
| 4   | spread    | unpaced  | on   | 3.33 (2.85/0.48)     | 0.99         | 16.9        | 562            | 480     | 99.45         | 753     | 34   | 0     | 0/0           | 26214      | ≠ −[909377734,17],[993672078,21]                 |
| 4   | clustered | paced    | off  | 0.83 (0.78/0.05)     | 0.00         | 0.8         | 520            | 470     | 0.01          | 641     | 32   | –     | –             | –          |                                                  |
| 4   | clustered | paced    | on   | 0.82 (0.77/0.05)     | 0.62         | 0.8         | 530            | 478     | 0.00          | 651     | 33   | 0     | 0/0           | 15728      | ≠ +[203245890,24]                                |
| 4   | clustered | unpaced  | off  | 3.89 (3.42/0.47)     | 0.00         | 33.5        | 582            | 492     | 98.42         | 1839    | 35   | –     | –             | –          |                                                  |
| 4   | clustered | unpaced  | on   | 3.37 (2.90/0.47)     | 0.99         | 17.3        | 559            | 487     | 99.45         | 780     | 35   | 0     | 0/0           | 31018      | ≠ −[368161520,18] +[368217690,24]                |
| 8   | spread    | paced    | off  | 1.90 (1.80/0.10)     | 0.00         | 17.9        | 894            | 846     | 0.00          | 641     | 32   | –     | –             | –          |                                                  |
| 8   | spread    | paced    | on   | 1.19 (1.14/0.05)     | 0.86         | 13.3        | 881            | 836     | 1.59          | 644     | 33   | 0     | 0/0           | 11238      | ≠ −[993672078,21] +[203245890,24],[367564350,18] |
| 8   | spread    | unpaced  | off  | 4.00 (3.60/0.40)     | 0.00         | 148.9       | 940            | 863     | 98.37         | 1101    | 34   | –     | –             | –          |                                                  |
| 8   | spread    | unpaced  | on   | 3.29 (2.81/0.49)     | 0.99         | 20.2        | 967            | 876     | 99.72         | 372     | 31   | 0     | 0/0           | 31456      | ≠ −[025297732,19],[367557690,5],[368161520,18]   |
| 8   | clustered | paced    | off  | 1.71 (1.61/0.10)     | 0.00         | 16.4        | 915            | 823     | 0.00          | 641     | 32   | –     | –             | –          |                                                  |
| 8   | clustered | paced    | on   | 1.21 (1.14/0.07)     | 0.88         | 13.4        | 892            | 831     | 2.04          | 642     | 35   | 0     | 0/0           | 15728      | ≠ +[203245890,24],[367564350,18],[368161520,18]  |
| 8   | clustered | unpaced  | off  | 3.99 (3.60/0.40)     | 0.00         | 153.4       | 941            | 876     | 98.46         | 1134    | 34   | –     | –             | –          |                                                  |
| 8   | clustered | unpaced  | on   | 3.38 (2.88/0.50)     | 0.98         | 20.8        | 935            | 861     | 99.76         | 366     | 31   | 0     | 0/0           | 26214      | ≠ −[203245890,24],[367564350,18],[993672090,21]  |

### Diagnostic cell (not part of the matrix)

`t36-diag-cpus6-on-2400000-8-clustered-paced`: the worst paced cell rerun
with `--cpus 6` (all VM vCPUs), everything else equal. CPU 1.21 cores, of
which `wavekit-chan` 0.885; throttled 0.0 s; branch drop **0.00 %**; 0
`queue-overflow`; 641 decodes, 32 keys. Same `wavekit-chan` CPU as under the
4-CPU quota, no drops: the N = 8 input drops are quota-throttling stalls, not
`wavekit-chan` falling behind on average.

## Decoded sets

Raw is deterministic across cells: 630 decodes / 31 keys at 2.048 Msps and
641 / 32 at 2.4 Msps in every paced raw cell. Paced channelizer cells decode
637–657 (2.048: 637–644, 2.4: 642–657) and always include the three expected
payloads (`338155151/18`, `367165450/1`, `368007230/24`).

- **Strictly equal:** 2.048 Msps N = 4 and N = 8, both placements (4 of 12
  paced cells).
- **Raw-only keys (paced):** only `203245890/24` (2.048, N = 1) and
  `993672078/21` (2.4, N = 1 and N = 8 spread). Both are in the fixtures'
  `expected.marginal_keys` (ruling QH-14) and are the same marginal frames
  the T28 golden gate found (QH-11). No non-marginal raw key is ever lost.
- **Channelizer-only keys (paced):** `993672090/21` and `993672721/21`
  (AtoN, 2.048 N = 1), `203245890/24` and `367564350/18`, `368161520/18`
  (2.4). AIS-catcher emits only CRC-valid frames, so these are
  integrity-checked extras, as in QH-11.
- **Unpaced** key sets differ in both directions (`summarize.py`
  `outsideMarginal` lists them) because 98–99.8 % of the replayed bytes are
  dropped at the branches by design, and each path drops different stretches.
  They are not a decoded-set criterion; the counts there measure throughput.

`summarize.py` (`e7fbc1b`) reports `equal: false` with an `error` whenever a
side decodes nothing or fewer than `min_count`, and emits an error row for a
channelizer cell without a partner or decoded set; none of the 24
comparisons carried an error.

## Follow-ups

- **Rulings:** QH-15 and QH-16 (see the verdict).
- **N = 8 headroom:** consider a larger default
  `channelizer.inputHighWaterMark` (about 64 ms today) to ride out
  throttling stalls, and research [3]'s AVX2/FMA `target_feature` path or
  per-channel DSP threads before recommending 8 channels at 2.4 Msps on
  a 4-core host. Pi-class hosts remain parked (ruling FINAL-R1).
- Repeat the N = 8 paced cells on a dedicated host; this run's host noise is
  about ±0.3 cores.
