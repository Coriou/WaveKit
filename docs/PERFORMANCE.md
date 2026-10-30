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
- The live-demod branch asks for the derived 250 ms mark (`highWaterMarkMs`), so
  `setByteRate` resizes it like a decoder branch; it is still replaced when the
  live demodulator restarts on a rate change, so the new run never reads samples
  at the old rate. The channelizer input sizes itself from the source caps.
  `channelizer.inputHighWaterMark` is now a floor.
- The source router calls `setByteRate` with the sample rate × IQ frame bytes
  whenever it learns a source's caps (connect, `caps-changed`, a new per-source
  fanout), so decoder, relay and audio-monitor branches get 250 ms too. Audio caps
  have no IQ frame and keep the 256 KiB floor.
- A rate change resizes existing derived marks (512 000 ↔ 1 200 000 bytes between
  1.024 and 2.4 Msps); explicit byte marks never change. A `PassThrough`'s own mark
  is fixed at construction, so the resized mark is a soft mark: the fanout's
  congestion check compares the writable backlog with it instead of trusting
  `write()`, and the episode's low-water poll ends drop-mode when no `'drain'` is
  pending. Recreating the streams instead would have meant re-attaching every
  consumer (decoder stdin pipes among them) on each retune. The readable side keeps
  its construction mark, so until the consumer restarts a branch resized from
  1.024 to 2.4 Msps congests after 512 000 + 1 200 000 + 65 536 bytes (370.3 ms),
  and one resized down after 1 200 000 + 512 000 + 65 536 (868 ms at 1.024 Msps).
- A drop-mode episode ends at half the mark (polled every 10 ms while it lasts,
  and stopped when the branch is removed or its stream closes), not only at an
  empty writable side. Waiting for empty meant consuming about two
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
| channelizer, DSP pool      | 60–250       | 0.13–0.15         | 0.32–0.35        | 3.1× to 5.5×      | 2.3× to 3.3×     |
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
  `wavekit-chan`'s single DSP thread got about 0.32 core, and 4 channels at
  2.4 Msps need 0.31. Sustained load at that level turned into input loss whatever
  the buffer. The DSP pool below fixes this for the channelizer.
- The csdr live-demod chain (the default engine, and the fallback for a mode or
  format Rust does not take) was not measured here because csdr is not on the bench host. It runs three
  processes and moves 19.2 MB/s of complex float between them at 2.4 Msps; the Rust
  engine needs 0.18 core.

## Live demod input reads (2026-10-30)

The Rust live engine is one `wavekit-chan` process with a demod channel. It read
stdin in 1 024-sample blocks (2 048 bytes), about 2 340 reads a second at 2.4 Msps,
each a fresh buffer handed to the main thread, which then built two fresh sample
vectors: about 4 700 wake-ups and 7 000 allocations a second. Now:

- `LIVE_DEMOD_BLOCK_SAMPLES` = 16 384, the channelizer's size. A read returns what
  the pipe holds, so this caps a block rather than waiting to fill one: at most
  16 384 / 2.4e6 ≈ 6.8 ms of input at 2.4 Msps and 16 384 / 1.024e6 ≈ 16 ms at
  1.024 Msps. A 64 KiB source chunk takes 2 reads instead of 32. The DSP is a
  stream, so the audio does not depend on the split (the A/B and the chunk-split
  properties pass unchanged); a retune or squelch change applies between reads, so
  it can land up to one block later in the input.
- The stdin reader takes its buffers back from the main thread through a bounded
  return channel (`INPUT_BUFFERS` = 3: one being converted, one queued, one being
  read into), and the converted I/Q vectors are kept between blocks.

Paced bench, live demod alone (`fanout-headroom.ts --channels 0 --readsb-core 0
--seconds 15`), NFM, Mac i5 with 8 threads shared with other work. "before" is the
previous build at 1 024 samples, "after-1024" this build forced to 1 024
(`--live-block 1024`), "after" this build at the new default. Three runs each,
alternated; one-minute load average after each run:

| Rate       | Build      | Cores (per run)     | CPU s per Msample | Load average (1 min) |
| ---------- | ---------- | ------------------- | ----------------- | -------------------- |
| 1.024 Msps | before     | 0.073, 0.080, 0.080 | 0.074–0.081       | 34, 14, 15           |
| 1.024 Msps | after-1024 | 0.075, 0.083, 0.078 | 0.076–0.084       | 31, 16, 14           |
| 1.024 Msps | after      | 0.043, 0.054, 0.047 | 0.044–0.055       | 24, 17, 14           |
| 2.4 Msps   | before     | 0.160, 0.170, 0.181 | 0.069–0.078       | 21, 15, 12           |
| 2.4 Msps   | after-1024 | 0.159, 0.157, 0.163 | 0.067–0.070       | 17, 12, 9            |
| 2.4 Msps   | after      | 0.095, 0.091, 0.097 | 0.039–0.042       | 14, 17, 15           |

No run dropped bytes. The block size is the win, about 40 % less CPU at both
rates; buffer reuse alone is within the noise, so the cost was per read, not per
allocation. csdr is not on
the bench host, so it is not in the table.

Live CPU A/B against csdr (2026-10-30, one RTL-SDR receiver, NFM at 1.024 Msps): three
60 s windows per engine, process CPU (utime + stime) of the live-demod processes only,
host load average 5 to 13.

| Engine                                                                       | Cores (per window)  |
| ---------------------------------------------------------------------------- | ------------------- |
| Rust live demod, 16 384-sample reads                                         | 0.071, 0.077, 0.077 |
| csdr chain (convert, firdecimate 41, fmdemod, dcblock, gain, limit, convert) | 0.045, 0.044, 0.051 |

Rust still costs about 55 % more CPU than the csdr chain, so csdr is the default
engine and Rust is opt-in (`liveDemod.engine: rust`).

## Channelizer DSP threads (2026-10-30)

Profile first (`native/wavekit-chan/examples/chan_bench.rs`, one thread, 2.4 Msps,
the bench's 12.5 kHz channel at 48 kHz cu8): about 28 ns of DSP per input sample
per channel, 0.028 CPU s per Msample. The NCO takes 6.5 ns, the first
decimate-by-2 stage (11 taps at 2.4 Msps) 11 ns, the next two 5.4 and 2.6 ns,
the 16/25 stage (973 taps at 75 kHz) under 1 ns. The cu8 input conversion,
shared by all channels, took 3 ns per sample.

A SIMD FIR does not pay here. The long filter is already cheap. The short
half-band stages are dominated by per-output overhead rather than multiplies,
and the NCO is a serial phasor recursion that cannot be split without changing
its bits. The channels themselves are independent, so the channelizer now runs
them in parallel:

- `wavekit-chan` keeps a pool of `min(available_parallelism / 2, 3)` helper
  threads (`dsp_pool::dsp_helpers`): half the host at most. With the main thread
  that is at most 4 DSP threads on an 8-thread desktop. A 4-core Pi gets 2
  helpers (3 DSP threads, one core left for the live demodulator, decoders and the
  core), a 2-thread host 1, and a 1-core host none, which is the old serial loop.
  The helpers start on the first block worth splitting. There is no configuration
  key; `--dsp-helpers N` or the environment variable `WAVEKIT_CHAN_DSP_HELPERS=N`
  overrides the count (the argument wins). N is a non-negative integer, clamped to
  3; `0` is the serial loop. An invalid environment value is ignored with a line on
  stderr, an invalid argument fails startup. The core passes no argument, so on a
  container host set the variable in the core's environment: `wavekit-chan` inherits it.
- A block of at least 2 048 input samples (`PARALLEL_MIN_SAMPLES`) with two or
  more channels open is split: each channel's engine moves to whichever thread
  takes it, runs the whole block and moves back. The main thread takes jobs too,
  so a helper that is slow to wake is expected to cost little, and in the runs
  below every pooled run had more headroom than every serial run at the same
  hog count. That is measured, not guaranteed: a helper descheduled while it
  holds a claimed job delays the block until the host runs it again. Handing a
  job to a helper and back costs about 12 µs, against about 60 µs of DSP for
  2 048 samples on one narrowband channel. Smaller blocks stay on the main
  thread. The job list, result slots and each job's output and event buffers
  are kept between blocks, so a steady stream of pooled blocks does not
  allocate them again (`pooled_blocks_reuse_their_buffers_after_warm_up`).
- Output is byte-identical to the serial loop. A channel runs every block in
  order on one thread at a time, and queueing and events then follow the serial
  channel order. The equivalence property
  `dsp_pool_output_and_events_match_the_serial_loop` compares queue bytes,
  counters and events of a pooled and a serial runtime over random IQ and demod
  channel sets, random block splits and random queue drains between blocks,
  including the drop runs that shutdown closes. The pinned Intel macOS output
  hashes in `channel.rs` still match.
- The cu8 input conversion uses a 256-entry table built at compile time from the
  same expression, so it is bit-identical (tested for every byte).

Unpaced, 2.4 Msps, 4 channels, base (head before the pool) and pooled builds
alternated, 3 runs each, 12 s per run. The host was shared with other work, at a
one-minute load average of 60 to 250 on 8 threads:

| Build  | Hogs | Headroom per run    | CPU s per Msample | Load average (1 min, after) |
| ------ | ---- | ------------------- | ----------------- | --------------------------- |
| serial | 0    | 1.18×, 1.88×, 1.34× | 0.128–0.134       | 64, 221, 211                |
| pooled | 0    | 3.13×, 5.52×, 3.38× | 0.132–0.140       | 159, 167, 234               |
| serial | 8    | 0.95×, 1.06×, 1.07× | 0.129–0.132       | 219, 166, 231               |
| pooled | 8    | 2.56×, 3.28×, 2.29× | 0.132–0.146       | 237, 188, 251               |

The serial runs with no hogs fall below the 3.0× in the table above because the
host was far busier this time. The pool costs 3 to 10 % more CPU per Msample
(hand-off, and the threads contending for cache). Paced 2.4 Msps with 8 hogs for
15 s at a load average of about 280: the serial build entered drop-mode 62 times
and lost 12.2 MB to absorber overflow, the pooled build entered it 0 times and
lost nothing.
