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
