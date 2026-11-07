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

9. **Logging on hot paths.** No info or warn line per message, frame, chunk or line.
   Each line is a synchronous stdout write on the main thread, and one `Decoded Message`
   line with its payload was 442 B, so 1,000 outputs/s (SBS at 150 aircraft) would have
   been 38 GB of logs a day. A per-message line is debug or trace. A warning that can
   repeat per message goes through `LogRateLimiter` (`src/utils/logger.ts`): one line per
   key per minute with a `suppressed` count. Volume is reported by one `CountSummary`
   info line per minute (`Decoder outputs in the last minute`, counts per decoder). State
   changes stay at info: start, stop, connect, retune, prune summaries.
10. **WebSocket budget.** A broadcast is serialised once, on the first subscribed
    client, and not at all when nobody subscribes to the channel. Entity updates are
    throttled per entity (aircraft 1 s; vessels, APRS and mesh 2 s), and a message carries
    what changed rather than repeating history: the aircraft trail goes as `trackAppend`
    deltas, the full trail only with the snapshot, `aircraft:new`, `aircraft:lost` and a
    staggered resync every 300 updates. Aim for at most about 100 KB/s per client for the
    aircraft channel at 150 aircraft.

Internal, transferred worker messages on a hot path may use a cheap structural guard
instead of a Zod parse; validate external data and configuration with Zod as
everywhere else.

### Aircraft WebSocket channel (2026-11-01)

`scripts/longevity/ws-payloads.ts`, 150 aircraft with full 100-point trails
through the real tracker, publisher and broadcaster to one counting client, 10 s
real time. "Before" is the pre-change wiring (every tracker update with the whole
state) on the same updates.

| Messages per aircraft per second | Before, bytes/s per client | After, bytes/s per client      | Change  | Load average |
| -------------------------------- | -------------------------- | ------------------------------ | ------- | ------------ |
| 6 (SBS-like)                     | 6,843,001 (809 msg/s)      | 82,120 (148 msg/s, 554 B mean) | −98.8 % | 17.8 → 16.0  |
| 1                                | 1,085,039 (135 msg/s)      | 55,909 (135 msg/s, 415 B mean) | −94.9 % | 15.0 → 14.4  |

The resync adds about 7,300 B / 300 ≈ 24 B/s per aircraft (3.6 KB/s at 150), mostly
outside a 10 s run. Measured on a busy Mac (load averages as shown); compare the
before and after columns, not absolute rates.

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

- `LIVE_DEMOD_BLOCK_SAMPLES` = 16 384, the channelizer's size. The reader waits once
  after a short read (`input.rs`): up to min(block, 32 768) bytes' time at the input
  rate, capped at 20 ms, plus scheduling. The DSP is a
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

A SIMD FIR does not pay much for this narrow channel (it pays for a wide one; see
[Wide channels](#wide-channels-2026-11-06)). The long filter is already cheap. The short
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

## Channelizer input reads and restarts (2026-11-06)

A read returns what stdin holds, and each read woke the reader, the main thread, the DSP
helpers and every channel's writer. The cost followed the source's chunk size rather than the
work. Now:

- **The reader waits once after a short read** (`native/wavekit-chan/src/input.rs`), so stdin
  collects the rest of the block with nothing running. The target is `min(block, 32 768)` bytes. Node
  gives the child a Unix socket (libuv's `"pipe"` stdio is a socketpair), so no pipe size sets it: a
  kernel buffer smaller than the target only holds the writer back in the parent's branch during the
  wait, which loses nothing. Linux is not measured here. The wait is the target's time at the input rate, capped at
  20 ms (`MAX_INPUT_HOLD`): 16 ms at 1.024 Msps, 8 ms at 2.048 Msps, 6.83 ms at 2.4 Msps. That is
  the added latency bound for a sample, plus however late the host wakes the thread. A read that
  already holds the target does not wait, so a backlog drains at full speed, and an idle source
  blocks in `read` as before. After the wait the reader never blocks, so a stalled source cannot
  hold bytes longer than one wait. Output does not depend on the split (chunk-split properties in
  `input.rs`, `tests/process.rs`, and the existing serial/pool equivalence).
- **An IQ channel keeps its buffers between blocks.** `ChannelDsp::run_chain` allocated about
  400 KB per channel per 16 384-sample block (a working pair per stage, halving down the chain).
  `tests/channel_allocations.rs` now holds that at zero allocations once warm. On the Mac below the
  gain at whole-block chunks is within noise. On Linux, glibc may return and refault that memory per
  block; that has not been measured.
- **The live demodulator waits too.** It runs the same reader at the same 16 384-sample block, so
  its target is 32 768 bytes and the hold above applies to it: 6.83 ms at 2.4 Msps, 8 ms at
  2.048 Msps, 16 ms at 1.024 Msps and 20 ms below 819.2 ksps, plus however late the host wakes the
  thread. This is arithmetic from the target and the rate, not a measurement of audio latency.
- **A capture-centre move no longer restarts the process.** Centre was part of `capsDiffer`, so
  every retune ended the generation, even with no channels open. Now only a rate or format change
  does (rule 5). A centre move sends one `recenter` control line. Open channels are still
  invalidated and re-requested, because a decoder's request may follow the centre and only the
  decoder can recompute it. A request still in flight is answered the same way, so it is computed
  again rather than granted for the old centre. A process left with no channels waits 6 s after the
  latest move for its decoders to come back, and at most 12 s after the first move since its last
  grant: a sweep with no grants retires it there rather than feeding it the whole byte rate for as
  long as it sweeps. The next request then costs one respawn, as every move did before.
- **`recenter` carries its position in the input.** Control and stdin are read independently, and
  old-centre IQ can sit in a burst absorber, the branch, the stdin socket and the reader when the line
  arrives. `atInputBytes` is the fanout's count of bytes it delivered to the branch (accepted minus
  dropped, the same count `mark-gap` uses) plus what the source's absorber holds, read once the
  synchronous distribution a move may have landed in has finished, since until then the chunk in hand
  is in neither count. So the line goes out in a microtask, and an `open` waits for it. It is the stdin
  position of the first byte after the move, except when the absorber's release drops held bytes
  for a lagging channelizer branch: then it is late by those bytes, at most the absorber's capacity,
  and a reopened channel starts that far into the new centre. It errs late and never early. The
  process applies the move when its input reaches that byte, splitting the block there, and a
  channel opened after the line receives no sample before it. A position already passed applies at
  once. Moves apply in order; 512 may wait, 24 bytes each. That is a safety cap, not a proved limit.
  At 2.048 Msps with the defaults the position can be ahead of the input by the absorber's
  8 192 000 B, the branch's 2 × 1 024 000 B, the stdin socket's 212 992 B (Node's `"pipe"` stdio is a
  socket; Linux's default `wmem_default`, not measured here), the reader's 32 768 B and the settle
  margin below, 143 360 B, in all 2 595 ms: 519 moves at 5 ms apart, past the cap, and 15 at a real
  185 ms hop. A larger absorber or input mark, a shorter settle or unpaced retunes can pass it, and
  the silence watchdog does not stop that, because a lagging reader that progresses stays alive.
  Past the cap, or on a process with a demod channel, the process answers `recenter-refused` and the
  parent retires the generation. So does a position the parent cannot trust.
- **A reopened channel skips 35 ms of input after a move (`RECENTER_SETTLE_MS`).** The caps change
  only once the frequency command is written (`writeFrequency`), so IQ from before the tuner moved
  arrives after the position the parent counts, and a restart's spawn time no longer hides it. The
  line's position is 35 ms of input later, so the process discards that IQ by stream position and no time is
  spent waiting. 35 ms is a heuristic, the assumed 30 ms marker counter run plus the default 5 ms
  `pllSettleMs`; no real tuner's command-to-clean-IQ latency was measured. A channel opened at least 35 ms of input after the move loses nothing, and no production consumer opens
  sooner: decoders reopen after a 300 ms debounce, and a scanner channel tap only after a track
  passes. So a larger margin would cost nothing today either; 35 ms stays until a real latency is
  measured, because any other figure would be just as assumed. What arrives later than the margin
  still reaches a channel opened at the move, as noise at its start: old-centre output is the lateness
  minus 35 ms (one synthetic stream at 2.048 Msps, real binary, paced):

  | IQ late by, ms | Opened at the move, ms | Older restart on every move, ms | Opened 135 ms later, ms | Older restart, 135 ms later, ms |
  | -------------- | ---------------------- | ------------------------------- | ----------------------- | ------------------------------- |
  | 35             | 0                      | 19–21                           | 0                       | 0                               |
  | 50             | 13                     | 36                              | 0                       | 0                               |
  | 100            | 63                     | 84–88                           | 0                       | 0                               |
  | 150            | 113                    | 135                             | 15–23                   | 4                               |
  | 300            | 263                    | 284–287                         | 164–167                 | 152–155                         |

  A process lagging behind its input keeps the old IQ it has not read, and a channel starts at the later
  of the line's position and its input position, so with a lag a channel opened after the move can get
  a head that it would not otherwise: 27 ms in one of 18 runs for IQ 64 ms late and a process stopped
  until 155 ms after the move. A link slower than that, which the 300 ms and 1000 ms timer settles exist
  for, is not covered, and neither is a real tuner: what it does to scanner channel-tier evidence is
  not tested.

- **IQ held at a generation's start is skipped too.** A restart does not discard what an absorber
  holds: it goes to the new branch. So when the count is above zero, a `recenter` on the unchanged
  centre precedes the first `open`, and the channel starts after those bytes. No margin is added
  there, because no move is known and a spawn takes the time anyway.
- **A binary without `recenter` is restarted, never sent the line.** It would ignore it and mix
  against the old centre: a healthy decoder on the wrong frequency. `ready` carries `"recenter":
true`; a process whose `ready` does not gets the old restart on each move, with one warning per
  source. A move before `ready` is not sent either: it finds no active process, and the request
  that spawned it compares the centre once `ready` has told it which kind it has. A process that
  offered it answers each move with `recentered`, in order, with the line's values. A line it could
  not parse (`rejected` with no id) or an answer out of order retires it at once. So does input
  acknowledged past a move's position by the larger of 1 s of input and 4 blocks with no answer:
  4 096 000 B at 2.048 Msps. These are bytes, so a stalled host or source spends none of them. The
  position already includes the 35 ms margin, which such a process does not discard, so the most wrong
  IQ it can give is those bytes plus 35 ms of input, plus the 100 ms a `progress` line can wait.
  More than 1024 unanswered moves retire it as well. The image build rebuilds the crate whatever the
  mtimes and fails if the installed binary's `ready` lacks the capability.
- **`tests/integration/channelizer-recenter-real-binary.test.ts` runs the real binary under the real
  manager**, with tones naming each centre. It skips when `WAVEKIT_CHAN_BIN` is unset and fails when it names a missing file; its
  header has the commands.

`native/wavekit-chan/examples/paced_load.py`, a real binary with paced noise on stdin and a separate
consumer process, 12 s per run; ranges are repeated runs, with the 1 448 B, 4 096 B and 512 kHz rows
alternated between builds. One-minute load average 6 to 19 on a Mac i5 with 8 threads. Child CPU in ms
per second of IQ (user + system). This host cannot show a Linux page-fault effect: minor faults stayed
at about 120 to 480/s in both builds.

| Rate, channels                  | Chunk, bytes | Before, user + sys | After, user + sys | Voluntary switches/s, before → after |
| ------------------------------- | ------------ | ------------------ | ----------------- | ------------------------------------ |
| 1.024 Msps, 12 × 48 kHz         | 65 536       | 382 + 28           | 361 + 25          | 33 → 33                              |
| 1.024 Msps, 12 × 48 kHz         | 8 192        | 423 + 87           | 369 + 28          | 251 → 18                             |
| 1.024 Msps, 12 × 48 kHz         | 4 096        | 449–474 + 139–158  | 366–375 + 26      | 500 → 10                             |
| 1.024 Msps, 12 × 48 kHz         | 1 448        | 508–523 + 229–268  | 369–372 + 26–28   | 1 390 → 2                            |
| 1.024 Msps, 4 × 48 kHz          | 4 096        | 186 + 89           | 128 + 15          | 497 → 8                              |
| 2.4 Msps, 12 × 48 kHz           | 65 536       | 831 + 64           | 846 + 56          | 73 → 75                              |
| 2.4 Msps, 12 × 48 kHz           | 4 096        | 1 032 + 307        | 835 + 59          | 1 159 → 17                           |
| 1.024 Msps, 4 × 512 kHz         | 4 096        | 1 043–1 075 + 86   | 975–1 047 + 24    | 500 → 260                            |
| 1.024 Msps, 4 × 512 kHz         | 65 536       | 1 008–1 010 + 22   | 974–1 040 + 22    | 284 → 285                            |
| 1.024 Msps, 8 × 48 kHz, 4 idle¹ | 4 096        | 471 + 128          | 368 + 24          | 502 → 10                             |
| 1.024 Msps, 12 stalled²         | 4 096        | 464 + 57           | 358 + 13          | 502 → 12                             |

¹ Four more channels that no client ever connects to; a slow consumer on the rest. ² Connected,
never reads, so every queue overflows.

CPU no longer depends on the chunk size. 64 KiB chunks are within noise, as expected: they were
already whole blocks. The 4 × 512 kHz rows show what was left: a wide channel was about 0.25 core of
DSP user time at 1.024 Msps here (300 kHz wide, 5 kHz transition), so channel width, not wake-ups,
set the floor for such a layout. [Wide channels](#wide-channels-2026-11-06) explains and cuts it.

## Wide channels (2026-11-06)

**The last stage's filter sets the cost, and it scales with output rate × stage input rate ÷
transition.** Kaiser's length at 66 dB is 4.04 × r / tr taps per phase for a stage with input rate r
and transition tr, and each output takes two dots of that length (I and Q), so a stage costs about
`2 × out × 4.04 × r / tr` multiplies per second. Check: 1.024 Msps to 512 kHz at 5 kHz is 847 M (829
taps, 849 M); 64 kHz to 48 kHz at 2.5 kHz is 10 M. A decoder's 5 % rule, tr = out / 40, makes that
323 × r: a narrow channel reaches its last stage at about 64 kHz, a wide one at 1 MHz or more. Chunk
size and wake-ups do not enter it.

**The 5 kHz transition was the bench's, not production's.** Decoders derive the request from their
output rate. The wide requests come from dumpvdl2, `rtl_433` and AIS-catcher, one channel per decoder
instance, and none asks for 5 kHz: dumpvdl2 at 1.024 Msps asks for 512 kHz with a 12.8 kHz transition
(325 taps, not 829). LoRa and readsb do not use the channelizer. The catalogue `rtl_433` takes the raw capture
up to 2.4 Msps (rule 6) and opens no channel, so its row below applies only to an operator's
`useChannelizer: true` decoder. A 1 MHz request from 1.024 Msps has no plan and is refused earlier, as
outside the capture.

**The FIR now runs I and Q and two consecutive outputs side by side, on AVX** (`dots_avx` in
`native/wavekit-chan/src/stages.rs`). One accumulator is limited by its add's latency, about 4 cycles
per 8 taps, whatever the vector width; each lane's sum must stay in order to keep its bits, but
separate outputs do not depend on one another. Per tap, on one 829-tap dot pattern (best of 9, load
average about 8): 0.165 ns for the previous `dot`, 0.118 for one AVX accumulator, 0.077 for I and Q
together, 0.047 with two outputs. Two outputs need at least 128 taps per phase: at 53 taps they cost
more than one, at 185 less.

The output is bit-identical for finite input. `wavekit-chan` takes `cu8` only, and each byte converts to a finite value. `wavekit-iqcap replay` can read non-finite floats from a damaged file, and there only a NaN's payload can differ, between kernels and between block splits. Same 8 lanes, same order, IEEE add and multiply, and no fused
multiply-add, which would round once where `dot` rounds twice. The kernel is picked once per block
from the CPU, so a host's CPU changes the cost and never the output. Tests: the kernels against `dot`
on random lengths up to 69 with far-apart magnitudes, a pair of values that separates fused from unfused
rounding (substituting FMA fails three tests), stages against the reference loop on both sides of 128
taps, and the pinned output hashes in `channel.rs` and `dsp_pool_output_and_events_match_the_serial_loop`
unchanged. Without AVX, and on arm64, stages run the previous `dot`; arm64 has not been measured.

`chan_bench` per request (`-- FS OUT BW TR [SECONDS]`), one thread, 3 s of noise, previous and this
build alternated 3 times. The output hash matched in every run. Share of a core at the capture rate:
the sum of each stage's fastest block ("fastest" below, not one observed block), which preemption does not inflate, and the median of the mean. One-minute load
average 26 to 21.

| Decoder request                  | Capture, Msps | Out, bandwidth, transition (Hz) | Per-phase taps, longest stage | M multiplies/s | Before: fastest, mean | After: fastest, mean |
| -------------------------------- | ------------- | ------------------------------- | ----------------------------- | -------------- | --------------------- | -------------------- |
| The earlier bench, not a decoder | 1.024         | 512 000, 300 000, 5 000         | 829                           | 849            | 0.148, 0.194          | 0.047, 0.062         |
| dumpvdl2                         | 1.024         | 512 000, 300 000, 12 800        | 325                           | 333            | 0.065, 0.088          | 0.025, 0.034         |
| AIS-catcher                      | 1.024         | 384 000, 364 800, 9 600         | 217                           | 201            | 0.049, 0.063          | 0.021, 0.027         |
| direwolf                         | 1.024         | 48 000, 47 424, 288             | 899                           | 111            | 0.034, 0.043          | 0.020, 0.026         |
| multimon-ng                      | 1.024         | 48 000, 12 000, 2 500           | 105                           | 32             | 0.021, 0.026          | 0.016, 0.021         |
| dsd-fme                          | 1.024         | 48 000, 12 500, 6 250           | 43                            | 26             | 0.020, 0.026          | 0.016, 0.021         |
| acarsdec                         | 1.024         | 24 000, 12 000, 6 000           | 23                            | 24             | 0.020, 0.026          | 0.016, 0.021         |
| rtl_433, `useChannelizer` only   | 2.4           | 1 000 000, 950 000, 25 000      | 195                           | 498            | 0.118, 0.147          | 0.056, 0.074         |
| dumpvdl2                         | 2.4           | 1 050 000, 300 000, 26 250      | 185                           | 424            | 0.102, 0.132          | 0.053, 0.069         |
| AIS-catcher                      | 2.4           | 384 000, 364 800, 9 600         | 253                           | 258            | 0.084, 0.101          | 0.046, 0.060         |
| direwolf                         | 2.4           | 48 000, 47 424, 288             | 843                           | 138            | 0.060, 0.074          | 0.041, 0.049         |
| multimon-ng                      | 2.4           | 48 000, 12 000, 2 500           | 122                           | 63             | 0.047, 0.056          | 0.037, 0.049         |
| dsd-fme                          | 2.4           | 48 000, 12 500, 6 250           | 49                            | 56             | 0.046, 0.054          | 0.037, 0.044         |
| acarsdec                         | 2.4           | 24 000, 12 000, 6 000           | 26                            | 53             | 0.043, 0.055          | 0.037, 0.045         |

Narrow channels gain about 20 %: what is left there is 4.9 ns per input sample in the NCO, a serial
recursion, and the first short half-bands, per channel, because each channel mixes first. Summing the
means, the 6 default-path requests at 2.4 Msps go from 0.47 to 0.32 core (0.62 to 0.39 with the operator `rtl_433` row), and the 6 at 1.024 Msps from 0.27 to 0.15. This is one channel per request, not a live total: a decoder can hold several narrow channels, up to 33 for paging.

`paced_load.py`, the whole process with a consumer, 15 s per run, previous and this build alternated:

| Channels at 1.024 Msps, chunk 65 536 B | Previous, user + sys ms per s of IQ | This build, user + sys | Load average (1 min) |
| -------------------------------------- | ----------------------------------- | ---------------------- | -------------------- |
| 4 × 512 kHz, 300 kHz, 5 kHz, two pairs | 938 + 19, 976 + 22                  | 351 + 17, 360 + 18     | 15 to 10             |
| 1 × 512 kHz, 300 kHz, 12.8 kHz         | 89 + 5                              | 37 + 5                 | 12 to 9              |

Tried and not adopted, for the 1.024 Msps to 512 kHz channel, sum of stage minima in ns per input sample
(this build direct: 41.4 at 5 kHz, 19.5 at 12.8 kHz; load average about 7):

- **Decimate by 2 first, then a same-rate shaping filter.** 21 + 415 taps instead of 829: 31.4 at
  5 kHz, and 19.45 at 12.8 kHz, where production is, so nothing there. It changes the output and the
  planner.
- **Symmetric taps.** With one accumulator on AVX: 214 ns per dot against 98 for plain AVX with one
  accumulator, because of the reversed loads. It also changes the output. Several accumulators were
  not tried.
- **FFT overlap-save** (rustfft, one channel, before the output copy): 3.9 to 4.3 at 5 kHz and 3.2 to
  3.7 at 12.8 kHz, so 5 to 10 times cheaper. It only does integer decimation, and the wide stages at
  2.4 Msps are 5/6, 7/8 and 16/25. It would also put an FFT crate in the shipped binary, change the
  output, and hold outputs until a frame is complete, which breaks the per-block schedule (plan A12).
  Worth reopening only if several wide channels at 1.024 Msps become common.
- **No filter.** An output rate equal to the input already has no stage; below it, the anti-alias
  filter is needed.

**A wider request would cut dumpvdl2 further, and is not made here.** dumpvdl2 channelises for itself,
so its front filter only has to keep images out. At 1.024 Msps a transition of 106 kHz, the most
`bw/2 + tr <= out/2` allows, gives 41 taps. Measured response: 0.0056 dB ripple across ±150 kHz,
−5.1 dB at 200 kHz, −100 dB at 256 kHz, and −76.9 dB or better for anything folding back onto the
150 kHz edge. Cost: 0.025 to 0.011 core at 1.024 Msps, 0.053 to 0.041 at 2.4 Msps (375 kHz transition),
sum of stage minima. Signals between 150 and 256 kHz would reach dumpvdl2's input at unity gain; no
target sits there, and no real signal has been tried through it.

## Spectrum frame path (2026-11-01)

The spectrum worker runs about 1,172 frames/s at 2.4 Msps with FFT 2048 (19.8 blocks/s).
**Stages that run once per frame work in linear power.** A dB threshold that changes once
per block is converted to linear power once per block, frames are compared in linear power,
and peaks are kept linear and converted to dB at block end. Do not add a full-spectrum dB
pass per frame: `Math.log10` over 2,048 bins costs about 50 to 110 ms per second of IQ.

The short-burst path (`shortFrame` in `src/core/spectrum/pipeline.ts`) follows this rule.
`dbThresholdBracket` (`src/core/spectrum/fft.ts`) brackets each threshold in accumulator
units with a stated margin. A sum outside the bracket is decided by one comparison, and a sum
inside it (about 2e-4 relative wide at −100 dB) or a NaN is decided in dB, so detections are
identical to the dB path. Tests: pre-change event goldens on seeded scenes, a Detector
equivalence property, and a `Math.log10` call-count guard
(`tests/unit/core/spectrum/short-linear-threshold.test.ts`). `Tracker.frame` now reads linear power
too, so no stage converts a whole frame to dB; see [below](#frame-tracks-and-main-thread-reads-2026-11-06).

`scripts/profile-spectrum.ts`, 30 s of synthetic IQ (noise, CW, NFM, Mode-S-like pulses), on a
busy Mac. These rows are wall clock, taken before the tool read thread CPU. Compare before and after
in the same row, not absolute rates.

| Mode, wall ms per s of IQ         | Before | After | Load average |
| --------------------------------- | ------ | ----- | ------------ |
| `stages`, short path (self)       | 137.9  | 48.8  | 15.6 → 17.8  |
| `stages`, built-in `tracker` span | 313.3  | 173.3 | 15.6 → 17.8  |
| `stages`, worker total            | 846.4  | 644.7 | 15.6 → 17.8  |
| `bare`, `handle()` total          | 1113.2 | 634.0 | 52.6 → 56.8  |

A first build that sent `powerToDb` through the one-bin helper `binPowerDb` was slower in
`bare` mode (565 to 602 against 522 to 540, load 12 to 16): the bundled worker did not inline
that call, and the remaining frame dB pass doubled in cost. `powerToDb` keeps its inline loop.
The spectrum feed stays on without display clients: the scanner, occupancy, backfill and
status read every block summary.

### Frame path cost on thread CPU (2026-11-06)

Measured to judge moving the frame path out of JS; nothing here is built into the product.
`scripts/profile-spectrum.ts` now reads `process.threadCpuUsage()`, the same kind of figure the passive
guard reads through `worker.cpuUsage()`. `scripts/profile-frame-path-wasm.ts` runs the Rust path natively
and as wasm32 with SIMD on the same synthetic scene, alternated. Figures are core fraction per second of
IQ, f64 FFT, FFT 2048 at 2.4 Msps and 1024 at 1.024 Msps, overlap 0, on a Mac i5 with other work running.
SMT and cache sharing inflate thread CPU on a loaded host, so a quiet host reads lower.

| Measure                                     | 2.4 Msps      | Load     | 1.024 Msps    | Load     |
| ------------------------------------------- | ------------- | -------- | ------------- | -------- |
| JS `handle()` plus wire, whole worker path  | 0.346 - 0.376 | 14 to 19 | 0.142 - 0.156 | 20 to 28 |
| JS frame path share (self CPU, `stages`)    | 83 %          | 24 to 30 | 80 %          | 15 to 19 |
| Rust frame path, native                     | 0.044 - 0.053 | 15 to 35 | 0.020 - 0.021 | 21 to 27 |
| Rust frame path, wasm32 SIMD, with boundary | 0.089 - 0.095 | 15 to 28 | 0.040 - 0.042 | 21 to 27 |

The boundary is one call per chunk with the chunk copied into linear memory and flat block results
copied out: about 1.4 ms of CPU per second of IQ at 2.4 Msps. rustfft's wasm SIMD kernels need its
`wasm_simd` feature and `+simd128`: the FFT stage reads 0.029 core with them and 0.044 without. Rust power bins
differ from the JS ones by up to 0.011 dB over 2000 frames (0.0032 dB above -100 dB); the JS transform
stores Float32 at every stage, the likely cause. The native and wasm32 f64 builds agree within 1e-10 dB.

## Spectrum frame path in wasm (2026-11-07)

The spectrum worker runs its per-frame path in a wasm32 kernel, `native/wavekit-frame`, when the
artefact `dist/spectrum-frame.wasm` validates and instantiates; otherwise it runs the JS path. The
JS path stays the reference and the fallback. One info line per worker names the path and the reason.

**Scope.** One `fp_run` call per batch: the frames of an input chunk, cut where a block ends or a
block is discarded. Per frame the kernel converts and windows the raw IQ (U8, S16 or FLOAT32), runs
the FFT, the shifted power, the blanker's raw sum and rise test (or holds the frame as pending), the
block sum, the 5 ms short path with its bracketed threshold compare, and the per-track power sums of
`Tracker.frame`. Block stages, `ImpulseBlanker.endBlock`, the threshold brackets and the envelope
buckets stay JS and read the kernel's arrays through typed-array views of its memory. Framing, seams,
counter runs and hold-back stay in `FrameSource` (raw mode copies each frame's bytes; the counter
scan remains a per-byte JS loop). Kernel execution makes no JS object per frame; `FrameSource` still
hands the pipeline one small frame record per frame, as on the JS path.

**Equivalence is bit for bit.** The kernel takes every table JS computes (window, twiddles, bit
reversal, U8 lookup, rise factor, track floor) from JS, keeps the JS operand order in f64, stores
Float32 after each FFT stage as `fft.ts` does, and uses no fused multiply-add. SIMD lanes run the same
IEEE operations as scalar code. A short sum inside its bracket calls back into the JS `shortOnInDb`,
so even the `Math.log10` comparison is the JS one. `tests/unit/core/spectrum/frame-wasm-lockstep.ts`
feeds both paths the same inputs and compares the events and every piece of frame-path state after
each input (SameValue: NaN equal, −0 apart): noise, carriers with a QSO and a Morse ID, bursts at the
short threshold (U8 and FLOAT32), Mode S at 2.4 Msps, zeros, non-finite samples, clipping, S16,
50 % overlap, broadband impulses (blanked on offer and as pending frames), seams, gaps, a marker epoch
with its counter run, a new stream, 1-sample to 64 Ki chunks, batch cuts of 1 and 7 frames, a timer
epoch, and a carrier on a learned spur line with a voice across it. A one-ulp change to one window
coefficient fails it. Both linear goldens run on both paths, and the built worker matches the inline
JS host. Deterministic block decisions follow: detections, tracks, duty, `isDataBurst` and short-path
verdicts are the JS ones at every threshold, not only on these scenes.

Why not rustfft: its mixed-radix kernels round differently. The earlier 0.011 dB gap between Rust
and JS power bins is the Float32 storage of the JS transform: the same radix-2 code with Float64
storage differs from it by up to 5.3e-3 dB over 2000 frames of the profiler scene (1.3e-3 dB above
−100 dB; the Float32 input rounding alone 1.3e-3 dB), while f64 implementations agree to about
1e-10 dB. Reproducing that rounding exactly was preferred over bounding it, since a bound cannot
rule out flips at the thresholds.

**Memory is fixed.** The module imports a `WebAssembly.Memory` with `initial = maximum`, sized by
`frameKernelLayout` from the pipeline config; it cannot grow and nothing is allocated per chunk.
Bytes: 256 KiB reserved for the kernel's 64 KiB stack and static data, a 384-byte control block, then
ten f64 arrays of N plus two twiddle tables (12·8·N), cos/sin (8·N), window, re, im and bit reversal
(16·N), the 2 KiB U8 table, pending frames 8·N·P with P = frames per block, the short ring
8·N·max(1, F), three u8 arrays of N, staging (frame bytes · P), 8·P starts, P verdicts, 8·T track bins
and 8·P·T sums with T = maxTracks − 1, each region 16-byte aligned. At 2.4 Msps, FFT 2048, P 59,
F 6, T 511: 1 806 387 bytes of regions, 32 pages (2 MiB). A layout over 256 MiB runs JS. Pending
frames past P (only possible with sample indices replayed into one block) are a kernel error.

**Faults.** A trap or a kernel error never leaves the worker: the open block is discarded, the
short window restarts (as after a seam), and a fresh instance on the same memory takes over, at most
`FRAME_KERNEL_MAX_RESTARTS` (2) times; the next fault keeps the JS path for that worker. One warn
line for the first fault and one for the switch, fields `fault`, `restarts`, `path` only. When the
fault comes from finishing a block as the next block's first frame arrives, that frame was already
handed over raw; after the switch to JS it is converted then, so it runs on the JS path and only the
discarded block's frames are lost. The lockstep comparison covers faults at a batch cut, at a block
change after a counter run, at a seam, in an epoch's first block, at a held-back frame and with 50 %
overlap: the JS side drops the same frames and discards the same block, and both then match.

**Selection** (no config key): `WAVEKIT_SPECTRUM_FRAME_PATH=js` forces JS, `=wasm` logs a warning
when the kernel is unavailable, unset means auto; `WAVEKIT_SPECTRUM_FRAME_WASM` names another
artefact. Neither variable has a `__`, so the config loader ignores them.

**Build.** One artefact for amd64 and arm64. Locally, with Rust 1.98.1 and the
`wasm32-unknown-unknown` target: `native/wavekit-frame/build.sh` writes `dist/spectrum-frame.wasm`
next to `dist/spectrum-worker.js` (`pnpm run build` leaves it there). Without it, `pnpm run build`
and `make dev-local` run the JS path and log why. The Dockerfile's `frame-wasm` stage runs the same
script on the build platform and copies the file into `/app/dist`.

`scripts/profile-spectrum.ts`, `bare --wire`, synthetic scene, FFT 2048 at 2.4 Msps and 1024 at
1.024 Msps, overlap 0, thread CPU of `handle()` plus the worker's encode and postMessage copy, Mac i5,
runs alternated, load average at start of each run:

| Frame path, core fraction | 2.4 Msps      | Load     | 1.024 Msps    | Load     |
| ------------------------- | ------------- | -------- | ------------- | -------- |
| JS                        | 0.285 - 0.358 | 17 to 36 | 0.113 - 0.168 | 24 to 40 |
| wasm kernel               | 0.171 - 0.220 | 15 to 28 | 0.076 - 0.099 | 23 to 44 |

The kernel call itself takes 63 to 79 µs per 2048-point frame (0.074 to 0.093 core at 2.4 Msps,
load 15 to 55); the exact FFT is most of it. The rest of the worker (block stages, the counter scan,
the frame copy and the envelope replay) is unchanged JS. Two code-generation facts matter here:
LLVM scalarises `f32x4.demote_f64x2_zero` when it can see that only some result lanes are used (a
constant shuffle or a 64-bit lane store after it), so the FFT packs two demotes with a swizzle whose
index vector is read from memory; that took the kernel from about 107 to 71 µs per frame. V8 runs
the kernel optimised (`--no-liftoff` changes nothing).

```bash
native/wavekit-frame/build.sh                       # dist/spectrum-frame.wasm
node scripts/profile-spectrum-build.mjs
nice -n 10 node output/bench/profile-spectrum.mjs --mode bare --wire --seconds 20 --rate 2400000 --path js
nice -n 10 node output/bench/profile-spectrum.mjs --mode bare --wire --seconds 20 --rate 2400000 --path wasm
nice -n 10 node output/bench/profile-spectrum.mjs --mode bare --wire --seconds 20 --rate 1024000 --path js
nice -n 10 node output/bench/profile-spectrum.mjs --mode bare --wire --seconds 20 --rate 1024000 --path wasm
```

Live, the worker's line `spectrum frame path` says which path runs; `worker.cpuUsage()` (the passive
guard's figure) compares them with `WAVEKIT_SPECTRUM_FRAME_PATH=js` and unset. With `--mode stages`
or the pipeline's opt-in profile on the wasm path, the `fft` stage holds the whole kernel call.

## Frame tracks and main-thread reads (2026-11-06)

**`Tracker.frame` sums linear power.** It used to read a per-frame dB array and take `10 ** (dB/10)`
per open-track bin, so one pass of `Math.log10` over 2,048 bins ran on every frame while any track
was open. Logs per block with an open track went from at least 50·N to at most 4·N (guarded in
`short-linear-threshold.test.ts`). NaN, zero and sums under the −200 dB floor still read the floor.

This one is not byte-identical. The old path rounded each bin through a Float32 dB value, up to half
an ulp at |dB| < 256: 7.63e-6 dB, 1.76e-6 relative in power. That bound on the envelope sum is a
property test. On seeded scenes only `acf30` and `acf60` changed: every other event field stays
byte-identical (`pipeline-frame-linear-golden.test.ts`, recorded from the dB path), and the two moved
by at most about 2e-6 on noisy scenes (`ACF_BOUND`; 1.08e-6 for a 50 dB carrier in that test). A
TDMA-like envelope moved them by about 3e-8, far from mattering at the classifier's −0.5 and 0.5. A
quantised noiseless cu8 tone moved them by 6.6e-4. On a noiseless float tone the envelope is flat to
rounding and the ACF of that rounding is numeric noise on either path (it moved by up to 0.45, without
crossing the TDMA rule in that scene).

Those scenes do not cover a comparison landing exactly on its boundary, which can resolve differently
because per-bin power differs from the old round trip by up to that 1.76e-6. The duty rule's
`p95 <= 4 * p5` is the one found: a track alternating exactly 0.01 and 0.04 per bin read duty 0.5 on
the old path and reads 1 now, which flips `isDataBurst` in the scanner's replay plan. The tolerance is
relative: a ratio r with |r / 4 − 1| > 3.64e-6, which is |r − 4| > 1.456e-5, gives the same duty and
the same `isDataBurst` on both paths at any per-bin power from the −200 dB floor up
(`tracker-duty-boundary.test.ts`, on the real `Tracker` and as a property). Both levels can move by
1.757e-6, 3.513e-6 in the ratio, and each path's Float32 envelope adds 1.19e-7. Inside the tolerance
the paths may part, and more readily at low power, because half a Float32 ulp is a fixed step in dB
that doubles with each binade of |dB|: it is 7.63e-6 dB for |dB| from 128 to 256 and 8 times less at
−20 dB. So 4.000005, 1.25e-6 relative, agrees at 0.01 per bin and parts at 1e-15, duty 0.5 now and 1
on the old path.

**Main thread.**

- `BandPlanService.view()` and `resolved()` return one deep-frozen snapshot per store state instead
  of a `structuredClone` per call. A mutation attempt throws. The key: a commit replaces the state
  object; an unavailable or closed store is its own key; everything else is fixed at construction.
- The channel lookup keeps its answer per frozen snapshot, plan objects, window and protocols (at
  most 256, then it starts over). An unfrozen view is never remembered.
- `createDecodeEnvelope` and `withPresentation` use structural guards. A guard returns what the
  schema would, members in schema order, or passes the input to Zod, so accessors, Proxies, unknown
  members and `-0` still take the schema path. Tested byte for byte against the schema path
  (`envelope-guard.test.ts`).
- The per-block worker messages (`events`, `buffer`) use a structural guard; every other message and
  every malformed one goes to `WorkerToMainSchema`.
- The ambient probe's per-line eligibility check reads `DecoderManager.probeEligibility` instead of
  a whole `getStatus`.

A placement pass is not skipped when its inputs look unchanged. They include the activity clock,
probation, every decoder's lifecycle, suspension and mode, source caps, the VFO and tuned holds, and
the pass also has its own effects. What is left costs 4.5 % of busy, 1.6 % of a core here.

**The passive guard judges CPU time.** `eluSample()` now reports the worker's event-loop counters
with `active` reduced to the thread's CPU time (`WorkerCostMeter`), because ELU counts a thread
preempted mid-frame as busy. Where Node has no `worker.cpuUsage()` (it came with 24.6.0), it reports
plain ELU and logs that once per worker. After 10
ticks without an answer, whether the requests hang or reject, `active` advances by ELU's advance per
tick instead, logged once as well. Those 10 ticks keep the last CPU figure and read as idle, so a worker that never answers
again at 90 % ELU reads about 75 % in the window they fall in and 90 % after it. An answer is a
cumulative figure, so it credits all the CPU time since the previous one, less what ELU already
credited for those ticks; neither counter moves back. When ELU credited more than the CPU time, the
excess stays, because paying it back would hold `active` still and hide a later overrun. With each
tick's CPU time at most its ELU, for any pattern of answers, rejections and hangs: `active` never
exceeds ELU's and is at most 10 ticks of CPU time below the CPU time. Over a window its advance is at
least the window's CPU time less those 10 ticks, and at most the window's ELU plus 10 ticks. These
bounds assume an answer's counter is read when it arrives: an answer delivered late with an older
counter adds its age to the shortfall until the next answer, which credits it in full. It reads
above CPU time only by what ELU credited, which takes 10 ticks in a row without an answer: on a
preempted worker at 90 % ELU and 10 % CPU, one answer in 12 ticks reads 15 %, and one in 30 reads about
60 %, so the guard can disable passive there. The limit is unchanged. A shared engine disabled with a
baseline showing the cost is passive's own no longer comes back after one cheap window without passive; it
waits for the next trial, which restores the 61 s per 900 s bound.

Offline, `scripts/profile-spectrum.ts`, 30 s of synthetic IQ at 2.4 Msps, head and this build
alternated. The `stages` and `handle()` figures are wall clock around the work and swing widely on a
loaded host: `bare` ranged over 350 to 817 ms/s at head and 263 to 869 here. So the `bare` row is
process CPU (user + system) of the whole 30 s run, which includes the same IQ synthesis in both.

| Measure                                        | Head                       | This build                 | Load average (1 min) |
| ---------------------------------------------- | -------------------------- | -------------------------- | -------------------- |
| `bare`, process CPU s, four pairs              | 33.37, 29.17, 23.31, 22.12 | 30.38, 24.37, 19.90, 19.30 | 11 to 38             |
| `stages`, per-frame dB span, ms per s of IQ    | 90.6, 115.6                | 0, 0                       | 10 to 13             |
| `stages`, `Tracker.frame` self, ms per s of IQ | 41.6, 59.5                 | 29.5, 48.8                 | 10 to 13             |
| `stages`, `handle()` total, ms per s of IQ     | 493.7, 656.8               | 438.7, 588.3               | 10 to 13             |

The four pairs save 2.8 to 4.8 s of CPU per 30 s of IQ, 95 to 160 ms per second of IQ, 10 to 16 % of
the run.

Scratch core (`scripts/profile-spectrum-main.ts --load`, stubs, 45 s after 15 s of warm-up, 2.4 Msps,
one web-like client), head against this build, load average 8 to 13. Function shares are of the main
thread's busy time.

| Main thread                  | Head  | This build |
| ---------------------------- | ----- | ---------- |
| `structuredClone`, inclusive | 4.9 % | 0.4 %      |
| Zod `safeParse`, inclusive   | 5.5 % | 1.8 %      |
| `reconcilePlacementsPass`    | 7.8 % | 4.5 %      |
| ELU, this pair               | 28.5  | 32.8       |
| Process CPU, % of a core     | 80.3  | 77.8       |
| Event-loop delay p99, ms     | 3.84  | 4.13       |

The function shares are stable across runs. The ELU, process CPU and delay rows are not: an earlier
pair at load 10 to 13, with only `Tracker.frame` changed on the "before" side, read ELU 41.6 and
23.3, process CPU 96.1 and 72.2, p99 7.28 and 2.70 ms. Two pairs do not settle those three, and
neither ELU nor delay is claimed as a gain here.

## Activity reads (2026-11-01)

Every Activity read (search, detail, facets, trails, band map, timeline) runs on one
reader worker, one at a time. Budget: **250 ms** for search, detail and facets, **1 s**
for trails, band map and timeline, on a store at its row cap (250,000 rows). A read that
cannot meet that on a cap-size store needs an index or a bounded walk, not a longer
deadline. Measure with `scripts/longevity/activity-queries.ts` (plans and timings on a
store copy) and `scripts/longevity/facets-index.ts` (a synthetic cap-size store).

- **The deadline covers the read only.** It starts after admission and after the reader
  is ready (`perform` in `src/core/activity/query/service.ts`), so time in the queue
  never counts against it (tested with fake timers in
  `tests/unit/core/activity/query/deadline.test.ts`). The queue has its own bounds:
  8 waiting reads, 4 per caller, a refusal past them (429 `ACTIVITY_QUERY_BUSY`), so a
  read waits at most 8 turns of at most 1 s each.
- **A blocked main thread does not time out a fast read.** The deadline timer runs on
  the main thread and the reader's reply arrives in the event loop's poll phase, after
  timers. When the main thread was blocked past the deadline inside an I/O callback (for
  example a burst of decoder output parsed in one socket read), the next turn ran the
  timer first, threw the waiting reply away and killed the reader. An expired deadline
  now grants one more loop turn (`setImmediate`, which runs after poll) before it fails
  the read (`src/core/activity/query/deadline.ts`). `scripts/longevity/reader-stall.ts
--phase poll` (a 400 ms stall in a Unix-socket `data` callback, four searches in
  flight, Mac at load average 83 to 91): before, one search of the four failed with
  `ActivityQueryTimeoutError` in each of 2 runs; after, 0 of 2. A stall inside a timer
  callback (`--phase timers`, the round-1 repro) never failed, because the reply is read
  in that turn's poll phase. Several such stalls in a row while a decoder resumes, each
  failing the read it overlaps and restarting the reader, can explain a cluster of
  timeouts at one moment (inferred from the code and this repro, not caught live); a
  slow facets read on a full store is the other source.
- **Facets count in SQLite over a covering index.** The facets read takes the newest
  50,000 matching rows. It used to fetch each one into JavaScript. Now one statement
  groups and counts them, and only the distinct values come back. The
  `activity_facets` index (`seq, category, protocol, decoder_id, source_id, kind,
produced_at_ms`) lets that scan read index entries instead of row pages, with or
  without a time range. A new store gets the index with its schema. An existing store
  builds it on the writer thread after the retention seed, so the open is not delayed.
  Until it exists, reads use the row scan and are still correct.

Measured on a Mac, a synthetic store of 250,000 rows (376 MiB, about 1.5 KB a row on
disk, like live), median of five reads through `runRead` on a fresh read-only connection as
the reader worker opens one, wall / process CPU ms. The quiet run was at load average 16
to 18. The busy run, at 150 to 200 from other work, shows how far the same reads stretch.

| Facets read                 | No index, old code | No index, new code | Index, old code | Index, new code |
| --------------------------- | ------------------ | ------------------ | --------------- | --------------- |
| `category` (the web), quiet | 123 / 114          | 77 / 70            | 64 / 56         | 36 / 33         |
| five dimensions, quiet      | 258 / 220          | 196 / 173          | 129 / 125       | 158 / 134       |
| `category` (the web), busy  | 329 / 163          | 165 / 98           | 202 / 70        | 126 / 40        |
| five dimensions, busy       | 900 / 259          | 593 / 227          | 442 / 166       | 560 / 168       |

The web app's one-dimension count went from 123 ms to 36 ms on a quiet host. Five
dimensions gain from the index but not from counting in SQLite: grouping 50,000 rows by
five columns costs about as much as fetching them, and per-dimension grouping and
array-mode fetches measured no better. With the index, five dimensions were 9 to 11 ms on a
120,000-row live copy in the sqlite3 CLI, which does not build JavaScript
objects.

The index build (`ensureFacetsIndex`) took 1.1 s at load average 17, 2.7 s at 68, and
1.3, 1.6 and 6.4 s at 164 to 179. It adds 15.3 MiB (about 64 B a row, 4 % of the file) and
writes about as much to the WAL, under the 16 MiB passive checkpoint threshold. Writes
queue behind it once, as they do behind the retention seed (write timeout 30 s). The
reader, the startup path and the open reply do not wait. Plans checked after the build
(`facets-index.ts`): searches keep the rowid or their equality index, the writer's
row count and retention reads keep `activity_received`, `activity_decoder` and
`activity_kind`, and the timeline and band map walks keep `activity_produced`.

The web app's chip counts (`liveCountsDelayMs` in
`web/src/features/activity/controller.ts`) follow live rows every 4 s while a count
takes under 80 ms. A slower count stretches the interval to 50 times its duration, so
counting uses at most 2 % of the reader. Each failed count doubles the 4 s floor, and
the interval never exceeds 60 s. A server-side cache was not added: the page recounts
only after new rows commit, so a cache keyed by the snapshot would almost never hit.
