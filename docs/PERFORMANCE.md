# Performance rules for contributors

WaveKit runs on modest hosts as well as on a desktop. A full-rate IQ stream at
2.048 Msps is about 4 MB/s of CU8 per source, so a small per-sample cost quickly
becomes a whole core. These rules apply to every change on a hot path: IQ ingest,
fanout, channelizing, spectrum, demodulation, audio output and the scanner's
signal processing. The plan that follows from them is in
[ROADMAP.md, "Performance and native DSP plan"](ROADMAP.md#performance-and-native-dsp-plan-2026-10-17).

1. **Where hot code may live.** Per-sample work over IQ at or above the channel rate
   belongs in Rust under `native/`, behind the per-source engine (`wavekit-chan`).
   TypeScript may do per-block work, and per-sample work only at audio rate
   (48 kHz or less), in a worker or with a measured budget. Do not add new csdr or
   `sh -c` DSP chains.
2. **Main-thread budget.** A feature may add at most 2 ms to the event-loop delay
   p99 at 2.048 Msps. Never run a transform larger than N 16 384 on the main
   thread.
3. **CPU budgets in the spec.** Every hot-path spec states its expected core
   fraction on a desktop reference host and on a Pi 4-class core host, at 2.048
   and 2.4 Msps. Treat differences below about 0.3 core as measurement noise
   ([channelizer capacity report](CAPACITY-2026-10-10-CHANNELIZER.md)).
4. **No per-chunk allocation in steady state.** Preallocate and reuse buffers. Use
   typed-array views instead of `readFloatLE`/`writeInt16LE` loops. `Buffer.concat`
   is for carrying a remainder between chunks, never once per sample block.
5. **Reconfigure without a restart.** Offset, bandwidth, mode and squelch changes
   are in-place state updates: a phase-continuous NCO, and new filter taps that
   keep the delay line. A restart is acceptable only when the sample rate or the
   sample format changes.
6. **Read IQ once per source.** A new consumer asks the per-source engine for a
   channel or an output. It does not add another full-rate fanout branch.
   Exception: the catalogue rtl_433 at capture rates up to 2.4 Msps takes one
   full-rate raw branch. Measured on a Mac (load average 9 to 12), the branch adds
   about 1.5 to 1.8 points of Node CPU and about 0.6 ms event-loop p99 at 1.024 and
   2.4 Msps, with no drops; rtl_433 itself takes 2.6 % of a core at 1.024 Msps. The
   channelizer path it replaces took 13 to 19 % of a core plus 3 to 5 points of
   Node CPU. Raspberry Pi figures are still to be measured.
7. **Measure, then claim.** Each optimisation lands with a bench (`scripts/bench/`
   or `native/*/examples/`), a before/after table in its pull request, and tests
   for chunk-split invariance and equivalence with the implementation it
   replaces.
8. **Licences.** Ideas may come from GPL projects such as SDR++ and csdr, but no
   code is copied or ported line by line; cite the published, textbook algorithm
   in the implementation instead. New Rust dependencies must be MIT or Apache
   licensed (for example `rustfft`). Avoid C DSP libraries with GPL or LGPL terms,
   such as FFTW and VOLK.

Internal, transferred worker messages on a hot path may use a cheap structural
guard instead of a Zod parse; validate external data and configuration with Zod as
everywhere else.

## Branch marks in signal time (2026-10-30)

At 2.4 Msps CU8 (4.8 MB/s) the core logged frequent "Branch congested" warnings,
mostly on the channelizer input branch, with no source loss. Every fanout branch
then had a fixed 256 KiB mark: 128 ms of signal at 1.024 Msps but only 54.6 ms at
2.4 Msps. A branch congests once both sides of its PassThrough and the consumer's
pipe are full: 2 × 262 144 + 65 536 = 589 824 bytes, 122.9 ms of signal. After a
hold, the burst absorber released into a branch only at Node's `drain` (writable
side empty), so each catch-up cycle moved about one mark. That kept pace with the
source only if the consumer woke within `mark / rate − mark / consumer rate`:
54.6 − 18.2 ≈ 36 ms for a consumer at 3× real time. On a loaded host, wake-ups
take longer, catch-up falls below real time, and the 2 s absorber ring overflows,
which loses samples on every branch.

Now:

- A branch without an explicit mark holds `DEFAULT_BRANCH_BUFFER_MS` = 250 ms per
  side at the fanout's byte rate (`FanoutManager.setByteRate`), clamped to
  [256 KiB, 16 MiB]. That is 1 200 000 bytes at 2.4 Msps and 512 000 at 1.024 Msps.
  A branch congests after 2 × 1 200 000 + 65 536 bytes, 513.7 ms of signal.
- The live-demod branch and the channelizer input size themselves the same way
  from the source caps. `channelizer.inputHighWaterMark` is now a floor.
- A drop-mode episode ends at half the mark (polled every 10 ms while it lasts),
  not only at an empty writable side. Waiting for empty meant consuming about two
  marks after a stall, 500 ms of signal at 2.4 Msps, which tripped the absorber's
  500 ms laggard exclusion.
- Entering drop-mode logs at debug, because with an absorber it loses nothing.
  The warning "Branch congested, dropping input" fires on the first chunk
  actually dropped in an episode.

Bench: `scripts/bench/fanout-headroom.ts`. It paces synthetic CU8 through the real
fanout and absorber into a `wavekit-chan` channelizer (4 narrowband channels), a
`wavekit-chan` NFM demod (the Rust live engine) and an emulated readsb IQ consumer
(0.35 core at the rate). `--hogs N` adds busy-loop processes, `--stall-ms` adds
SIGSTOP stalls, and `--marks legacy` restores the fixed marks.
The deterministic counterpart is `tests/unit/core/fanout-branch-headroom.test.ts`.

Throughput ceiling (unpaced, 2.4 Msps; Mac i5, 8 threads, shared with other work):

| Consumer                   | Load average | CPU s per Msample | Core at 2.4 Msps | Headroom, no hogs | Headroom, 8 hogs |
| -------------------------- | ------------ | ----------------- | ---------------- | ----------------- | ---------------- |
| channelizer, 4 channels    | 20 / 65 / 48 | 0.13              | 0.31             | 3.0× / 2.8×       | 0.97×            |
| Rust live demod (NFM)      | 20 / 65 / 48 | 0.076             | 0.18             | 5.9× / 5.1×       | 2.7×             |
| readsb IQ (emulated, 0.35) | 65 / 48      | n/a               | 0.31             | 2.5×              | 1.3×             |

Paced 2.4 Msps, 15 to 20 s per run, legacy and new marks alternated (one-minute
load average at the end of each run):

| Case                     | Marks             | Runs | Load average | Drop-mode entries (channelizer / live / readsb) | Longest hold | Bytes lost                       |
| ------------------------ | ----------------- | ---- | ------------ | ----------------------------------------------- | ------------ | -------------------------------- |
| 8 hogs                   | 256 KiB           | 5    | 62–107       | 462 / 0 / 1                                     | 19.9 s       | 26.5 MB absorber overflow, 1 run |
| 8 hogs                   | 250 ms            | 5    | 85–131       | 93 / 0 / 0                                      | 15.9 s       | 0                                |
| SIGSTOP 150 ms every 1 s | 256 KiB           | 1    | 118          | 52 / 28 / 15                                    | 1.6 s        | 0                                |
| SIGSTOP 150 ms every 1 s | 250 ms            | 1    | 99           | 0 / 0 / 0                                       | 0            | 0                                |
| SIGSTOP 300 ms every 1 s | 256 KiB           | 2    | 175–187      | 705 / 31 / 4                                    | 13.3 s       | 16.1 MB absorber overflow, 1 run |
| SIGSTOP 300 ms every 1 s | 250 ms, low water | 2    | 171–212      | 80 / 1 / 58                                     | 8.5 s        | 12.6 MB, channelizer branch only |
| no hogs, no stalls       | either            | 2    | 64–80        | 0 / 0 / 0                                       | 0            | 0                                |
| 8 hogs, 1.024 Msps       | 256 KiB           | 1    | 129          | 0 / 0 / 2                                       | 0.1 s        | 0                                |
| 8 hogs, 1.024 Msps       | 250 ms            | 1    | 155          | 0 / 0 / 0                                       | 0            | 0                                |

The channelizer branch congests first in every run. The paced figures are noisy:
other processes on the host kept the load average between 60 and 210 on 8
threads. Read them for the direction and the mechanism, not for exact counts.

Two limits remain:

- Above about 1.0× headroom the larger marks only absorb stalls. Under 8 hogs,
  `wavekit-chan`'s single DSP thread gets about 0.32 core, and 4 channels at
  2.4 Msps need 0.31. Sustained load at that level turns into input loss whatever
  the buffer. The fixes are the AVX2/FMA path or per-channel DSP threads already
  named in the [channelizer capacity report](CAPACITY-2026-10-10-CHANNELIZER.md).
- The csdr live-demod chain (`engine` absent) was not measured here because csdr
  is not on the bench host. It runs three processes and moves 19.2 MB/s of
  complex float between them at 2.4 Msps; the Rust engine needs 0.18 core.
