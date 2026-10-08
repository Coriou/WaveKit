# CSDR ring activation: evidence and pending capacity runs

Recorded 2026-10-08. This note covers software memory and delivery only. It is
not RF decode correctness, Pi streaming stability or hardware acceptance. Raw
artifacts stay in `output/capacity/`, which is gitignored.

## What changed

`csdr.boundedBuffers` defaults to `false` (env `WAVEKIT_CSDR__BOUNDED_BUFFERS`).
`csdr.bufferElements` defaults to 65536 and accepts 2048..10485760, the same
range as the native validation. When the flag is on, the IQ-decimate,
audio-demod, dsd-fme and live-demod builders prefix only validated stages with
`WAVEKIT_CSDR_BUFFER_ELEMENTS=<n>` (`src/decoders/csdr-buffers.ts`).

| Bounded (harness-validated)                                         | Upstream ring kept                       | Why kept                                                |
| ------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `convert` (char/s16→float, float→char/s16)                          | `lowpass`                                | FIR FilterModule; the patch does not size its lookahead |
| `firdecimate` when ring ≥ ceil(4/float(tbw))+1+M+1024               | `deemphasis` (nfm and wfm)               | NFM is a FIR FilterModule; one rule per command         |
| `fmdemod`, `amdemod`, `agc`, `dcblock`, `gain`, `limit`, `realpart` | `bandpass --fft`, `fft`, `shift`, others | Window not sized, or not covered by the harness         |
|                                                                     | any `--async` stage                      | The patch rejects asynchronous mode                     |

The bounded commands other than `firdecimate` are CSDR `AnyLengthModule`s,
which keep no input window. The Dockerfile and s6 overlay build no CSDR
pipelines; only the Node app spawns them.

Operational notes:

- **Inherited env is scrubbed.** Earlier, an operator could set the native
  `WAVEKIT_CSDR_BUFFER_ELEMENTS` on the container and it would reach every
  csdr process. Now it is removed from decoder and live-demod shells, and
  startup logs a warning. Use `csdr.boundedBuffers` /
  `WAVEKIT_CSDR__BOUNDED_BUFFERS` instead. This keeps unvalidated stages
  (`lowpass`, `deemphasis`, …) on upstream rings.
- **FIR fallback is logged, not silent.** If `bufferElements` is below a
  filter's native minimum, that `firdecimate` keeps its 800 MiB upstream ring
  instead of failing at start. The builder logs `csdr firdecimate keeps the
upstream ring` at info, with the stage, the minimum and the configured size.
- **Ordering.** The policy is process-wide module state that `src/index.ts`
  sets right after `loadConfig()`. That happens before any decoder or live-demod
  pipeline is built. Builders read it whenever they build a command, so a new
  entry point must call `configureCsdrBuffers()` before creating decoders.
  Otherwise the default (off) applies.

## Native harness against the app image

Sanitized report, with image IDs and binary SHA-256 values for candidate and
baseline, case list and results:
[`scripts/native-patches/results/2026-10-08-csdr-activate-test.json`](../scripts/native-patches/results/2026-10-08-csdr-activate-test.json).

Image `wavekit:csdr-activate-test` (`docker build --target final-core`, image
`sha256:5c488b47…`). The candidate is its `/usr/local/bin/csdr`; the baseline is
the unpatched csdr copied from the previous core image (`sha256:2bc9bc14…`):

- 4 FIR equivalence cases, the CU8 convert→FIR→convert chain, the default FFT
  case, 16 invalid settings and the blocked-consumer case all pass.
- 33 bounded-stage cases pass byte-identical with odd-sized writes
  (17/1023/8191 bytes) at 2048 and 65536 elements. These include every app
  stage form and the FIR factors 2–100 at transitions 0.05 and 0.012.
- `firdecimate 43 0.012` on 64 MiB of input: sampled native peak RSS 69.0 → 5.8
  MiB, system CPU 0.41 → 0.07 s. A blocked consumer stays at 5.4 MiB.

## Live app shmem (read-only measurement; a hypothesis, not a diagnosis)

These numbers come from `/proc/<pid>/smaps_rollup` and the cgroup
`memory.stat` of the running core container: 9 decoders on an rtl_tcp source,
upstream rings, source disconnected at the time.

- 31 `csdr` processes hold **5090 MiB `Pss_Shmem`**, which equals the
  container's cgroup `shmem` (5090 MiB) out of about 5.25 GiB total. The rings
  are shared `/dev/zero` mappings, not memfd.
- The breakdown matches the arithmetic exactly. 5 × `firdecimate` at 800 MiB
  is 4000 MiB. 5 complex-input stages (`fmdemod`/`amdemod`/`agc -f complex`)
  at 80 MiB are 400 MiB. 16 float-input stages at 40 MiB are 640 MiB. 5
  char→float converts at 10 MiB are 50 MiB.
- VM MemAvailable was about 1.9 GiB of 7.8 GiB.
- The same container reports cumulative fanout drops of about 1.3–2.8% of
  bytes written on its CSDR decoder branches.

Hypothesis: page-touch faults and memory pressure from these rings contribute
to the decoder-branch loss. This has not been shown. The matched runs below
are the test. With the policy on, the expected ring footprint for the same
31 stages is about 9 MiB. A short bounded smoke run measured 9 MiB of CSDR
shmem, but its CPU and drop figures are void because it overlapped live
streaming.

Command forms that the builder generated in that run, at 2.048 Msps:

```
WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr convert -i char -o float | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr firdecimate 2 0.05 | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr convert -i float -o char | rtl_433 -r cu8:- -s 1024000 -F json
WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr convert -i char -o float | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr firdecimate 85 0.05 | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr amdemod | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr agc -f float -p fast -r 0.8 | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr dcblock | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr gain 1 | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr limit | WAVEKIT_CSDR_BUFFER_ELEMENTS=65536 csdr convert -i float -o s16 | sox ... | acarsdec ...
```

The sox-resampled decoders (readsb, AIS-catcher, dumpvdl2, LoRa) have no
CSDR stages.

## Pending capacity runs (quiet window only)

Tooling is in `scripts/capacity/`. `fake_rtl_tcp.py` is a **synthetic**
deterministic CU8 source paced in real time. `sampler.py` runs inside the
container and records cgroup CPU/memory, smaps per process, decoder restarts
and fanout branch counters. `run_capacity.py` is the driver. It uses private
`wkcap-*` containers and the `wkcap-net` network, publishes no ports, sets a
hard memory cap with no swap and a 4-CPU quota, and aborts if VM
MemAvailable drops below 1 GiB. Preflight refuses to start while
`wavekit-app` is above 5% CPU, which usually means live streaming, unless
`--allow-live` is given. It also refuses when VM MemAvailable is below the
cap + 128 MiB + 1 GiB. The synthetic source accepts reconnects, and a client
disconnect inside the measurement window marks the run aborted rather than
leaving a clean-looking empty run. `summarize.py` reduces the output. Each
run lasts at most 5 minutes.

```bash
IMG=wavekit:csdr-activate-test; R=scripts/capacity/run_capacity.py; O=output/capacity
# 1. All nine decoders, bounded: CPU / RSS / PSS / drops / restarts (comparable)
python3 $R --image $IMG --rate 2048000 --buffers on --out $O/all9-on-2048
python3 $R --image $IMG --rate 2400000 --buffers on --out $O/all9-on-2400
# 2. All nine, upstream rings: memory trajectory and time to OOM only. These
#    are expected to OOM at the cap, so their CPU and drop figures are not comparable.
python3 $R --image $IMG --rate 2048000 --buffers off --warmup 0 --window 90 --interval 2 --out $O/all9-off-2048
python3 $R --image $IMG --rate 2400000 --buffers off --warmup 0 --window 90 --interval 2 --out $O/all9-off-2400
# 3. Matched subset (labelled SUBSET): one CSDR decoder, steady state after the
#    800 MiB FIR ring is fully touched (~51 s at 2.048 Msps). Upstream needs about 970 MiB (800+40+10 rings plus Node). Needs about 2.3 GiB
#    of VM MemAvailable; the driver refuses to start below cap + 128 MiB + 1 GiB.
for rate in 2048000 2400000; do for b in on off; do
  python3 $R --image $IMG --rate $rate --buffers $b --decoders rtl433 \
    --memory 1152m --warmup 75 --window 150 --out $O/subset-rtl433-$b-$rate
done; done
python3 scripts/capacity/summarize.py $O/all9-* $O/subset-*
```

A subset of two or three CSDR decoders on upstream rings needs about 0.9 GiB
per FIR chain at steady state. That cannot fit under a safe cap while the
core container holds about 5 GiB of ring shmem, so only the one-decoder pair
is planned.
