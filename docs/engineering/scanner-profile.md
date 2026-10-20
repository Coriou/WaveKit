# Spectrum profiling

Build fresh dist workers before profiling; the benchmark bundles its main entry
but loads workers from dist. From the repository root:

```bash
pnpm run build-file ./src/core/spectrum/spectrum-worker.ts ./src/core/scanner/store/snapshot-worker.ts
pnpm exec esbuild scripts/bench/spectrum-profile.ts --bundle --platform=node --format=esm --packages=external --outfile=output/bench/spectrum-profile.mjs
node output/bench/spectrum-profile.mjs --seconds 120
```

The bench uses an in-process fake rtl_tcp server on an ephemeral loopback port,
at 2.048 and 2.4 Msps, with synthetic noise, NFM and 4FSK. It reports worker stage
costs, engine utilization, main-thread event-loop utilization and delay, listener
spans and host load. Run on an idle host and retain the JSON with the tested revision.

`hotOverBusy` is (window + FFT + power + summary wire time) / worker busy time.
`hotOverBusyWithFrameDb` adds per-frame dB conversion to that numerator, treating
it as front-end power work. `stageFractionOfBusy.frameDb` gives that conversion's
own share. Missing or non-finite measurements are reported as null. Compare both
shares with utilization for requirement 9.3; these instructions give no verdict.

The opt-in channel gate bench is separate:

```bash
WAVEKIT_GATE_BENCH=1 pnpm exec vitest run tests/unit/core/spectrum/pipeline-gate.test.ts
```

Without `WAVEKIT_GATE_BENCH=1`, the measurement case is skipped.
