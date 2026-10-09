# Test Fixtures

This directory contains IQ/audio recordings for validating WaveKit decoders.

## Structure

```
fixtures/
├── manifest.yaml      # Fixture definitions and expected outputs
├── download.sh        # Download script
├── convert.sh         # Format conversion script
├── test-decoders.sh   # Manual test runner
├── raw/               # Downloaded original files
└── processed/         # Converted files ready for decoder input
```

## Usage

```bash
# Download fixtures
./fixtures/download.sh

# Convert to decoder-ready formats
./fixtures/convert.sh

# Run decoder tests
./fixtures/test-decoders.sh
```

## Manifest v2

`manifest.yaml` is validated by `tests/integration/fixtures/manifest.ts`
(`pnpm exec vitest run tests/unit/fixtures/manifest-v2.test.ts`). Each fixture
records `id`, `role` (`channelizer-golden` | `tail-golden` | `parser-transcript` |
`negative`), `decoder`, `license`, `provenance`, `fetch`, `file` (under `raw/`),
`sha256` of that file, `format`, `sample_rate`, `center_hz`, `duration_s` and
`expected` decodes (`min_count`, `payloads`, `key_fields`). Unverified sources stay
in `candidates` with `blockers`.

Privacy: own captures contain real identifiers (pager, ACARS, AIS, DMR, VDL2).
They use `license: private` and `fetch.kind: private`, are trimmed to the
shortest window holding the expected decodes, and are never committed.
`download.sh` copies them from `WAVEKIT_PRIVATE_FIXTURES_DIR` (a path or an
https base URL) and verifies sha256.

Goldens: `tests/integration/iq-fixture-goldens.test.ts` (env-gated; see its header).
`test-decoders.sh` stays a manual tool and is not a gate.
