# Development & Debugging Scripts

This directory contains scripts for capturing IQ data, testing demodulation pipelines, and analyzing signals.

## Interactive Tools

### `auto-capture.mjs`

An interactive Node.js wrapper for acquiring IQ samples from the live `rtlmux` source. It runs the underlying python capture script inside the `demod-test` Docker container.

**Usage:**

```bash
node scripts/auto-capture.mjs
```

**Features:**

- Interactive prompts for all configuration
- Automatic container lifecycle management
- writes captures to `./debug_audio` (mapped to `/data/debug_audio` in container)
- Supports thresholds, pre/post buffers, and multiple captures

### `bench/zoom-workload.ts`

Zoom sustained workload benchmark (measurement only, web-gaps-9 §4). It runs a
separate long FFT over contiguous seeded CU8 for one to eight viewed slices, on
top of a 2048-point detector proxy, fed in real-time paced 50 ms chunks. Each
cell is checked against the viewed-slice-spectrum budgets (incremental core
0.10 per source and 0.20 total, event-loop p99 increase 2 ms, no missed 250 ms
deadlines, bounded RSS). Output: `samples.jsonl`, `summary.json`, `meta.json`
under `--out` (default `output/bench/zoom-<ISO>/`) and a table on stdout.

**Usage:**

```bash
node scripts/bench/build-zoom-workload.mjs   # bundles to output/bench/zoom-workload.mjs
node output/bench/zoom-workload.mjs --smoke
node output/bench/zoom-workload.mjs --fs 2048000 --fft 8192..262144 --rate 5,10 --slices 1,2,4 --duration 60
```

Other flags: `--variant fft,ddc` (shift and decimate before the FFT),
`--no-detector`, `--span-hz`, `--gap`, `--seed`.

### `demod-test.sh`

A shell script to test the manual demodulation pipeline on recorded IQ files. Useful for replicating the production `csdr` pipeline and verifying decodability with `multimon-ng`.

**Usage:**

```bash
# Inside wavekit-dev or demod-test container:
/scripts/demod-test.sh /data/debug_audio/iq_capture_2026xxxx.u8
```

### `dsd-fme-voice-ab.mjs`

Real-binary regression check for digital voice. It runs in the core image on a
recorded DMR discriminator capture. The decode must be identical with voice
output on (`-o udp`) and off (`-o null`), and the decoded voice must not be
chopped. See `docs/DIGITAL-VOICE.md`.

```bash
docker run --rm --network none --entrypoint node -v "$PWD:/w:ro" \
  wavekit:local-core /w/scripts/dsd-fme-voice-ab.mjs [--chain "..."] [--decoded-wav /out/x.wav]
```

### `rf-window/`

Measurements for a supervised session on a live receiver (WG7): squelch noise tail per
squelch mode, tone squelch gate, CTCSS/DCS detection and REST retune latency. Each script
needs `--host` (API host, port 9000 by default) and prints its plan without sending
anything unless given `--run` (read-only: GET requests, `/ws`, the audio stream) or
`--apply` (also writes, and puts back the previous live audio config or tuner frequency at
the end or on Ctrl-C). Output is one JSON object per line. Pure helpers are in `lib.mjs`
(tested in `tests/unit/scripts/rf-window.test.ts`).

```bash
node scripts/rf-window/squelch-tail.mjs --host HOST --apply --modes manual,auto,noise --seconds 120
node scripts/rf-window/tone-squelch.mjs --host HOST --apply --tone ctcss:100.0
node scripts/rf-window/dcs-ctcss-capture.mjs --host HOST --run --expect dcs:023N
node scripts/rf-window/tune-latency.mjs --host HOST --apply --count 20 --step-hz 100000
```

In protected mode set `WAVEKIT_RF_BEARER_ENV` to the name of an environment variable
that holds a machine bearer.

## Python Analysis Tools

- **`auto-capture.py`**: Core capture logic. Connects to `rtlmux` TCP stream, detects signals based on standard deviation threshold block-by-block, and saves IQ data.
- **`dmr-sweep.py`**: Sweeps through gain stages and decimation filters to find optimal parameters for DMR decoding.
- **`analyze-spectrum.py`**: Generates spectrum plots from captured IQ files.
- **`compare-dynamic-range.py`**: Comparative analysis of signal dynamic range.

## Directories

- **`debug_audio/`**: Local storage for captured IQ files and demodulated WAVs. (Gitignored)
