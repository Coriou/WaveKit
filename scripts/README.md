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

### `demod-test.sh`

A shell script to test the manual demodulation pipeline on recorded IQ files. Useful for replicating the production `csdr` pipeline and verifying decodability with `multimon-ng`.

**Usage:**

```bash
# Inside wavekit-dev or demod-test container:
/scripts/demod-test.sh /data/debug_audio/iq_capture_2026xxxx.u8
```

## Python Analysis Tools

- **`auto-capture.py`**: Core capture logic. Connects to `rtlmux` TCP stream, detects signals based on standard deviation threshold block-by-block, and saves IQ data.
- **`dmr-sweep.py`**: Sweeps through gain stages and decimation filters to find optimal parameters for DMR decoding.
- **`analyze-spectrum.py`**: Generates spectrum plots from captured IQ files.
- **`compare-dynamic-range.py`**: Comparative analysis of signal dynamic range.

## Directories

- **`debug_audio/`**: Local storage for captured IQ files and demodulated WAVs. (Gitignored)
