# Test Fixtures

This directory contains IQ/audio recordings for validating WaveKit decoders.

## Structure

```
fixtures/
├── manifest.yaml      # Fixture definitions and expected outputs
├── download.sh        # Download script
├── convert.sh         # Format conversion script
├── compose.py         # Wideband composer for generated fixtures
├── generators/        # Synthetic POCSAG / ACARS baseband generators
├── recipes/           # Composer recipes (committed; the outputs are not)
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

## Generated fixtures (composer)

No licensed public recording at 2.048 or 2.4 Msps carries confirmed traffic for the
channelizer's migrating decoders, so the `composed_*` channelizer goldens are built
from narrowband sources (channelizer T7a). A fixture with
`fetch: { kind: generated, recipe: recipes/<id>.json }` is never downloaded as a
file: `download.sh` fetches each source the recipe lists from its origin URL into
`raw/.sources/` (sha256-checked), runs `compose.py` (python3 + numpy) and checks the
output's sha256 against the manifest. A `raw/<id>.cu8.json` sidecar records the rates,
centre, each component's absolute frequency and source license, the decodes it should
carry and the clip count.

```bash
./fixtures/download.sh composed_ais_162m_2048k          # fetch sources, compose, verify
python3 -I fixtures/compose.py fixtures/recipes/composed_ais_162m_2048k.json \
  --out /tmp/ais.cu8 --sidecar /tmp/ais.json          # sources from fixtures/raw/.sources
python3 -I fixtures/compose.py RECIPE --list-sources    # id|url|sha256|file
```

A recipe gives the output `sampleRate`, `centerHz`, `durationS` and `seed`, then
components. Each component has one source (a cu8 / cs8 / cs16 / cf32 file or a
2-channel WAV IQ file at a stated rate) or a built-in generator (`pocsag`,
`acars`), an `offsetHz` from the centre and a `levelDb` (dBFS of the component's
99.9th-percentile envelope). The composer resamples each component to the output rate
(rational polyphase, Kaiser window, 90 dB stopband), mixes it to its offset, sums,
adds seeded complex Gaussian noise (`noiseDbfs`), an optional IQ image
(`iqImage.rejectionDb`) and DC spike (`dcSpikeDbfs`), and quantises to cu8 as
`floor(127.5 x + 128)` saturated to 0..255 (the addendum §3 mapping). It refuses to
write a file where more than 0.01 % of I/Q values saturate. Keep components clear of
the DC spike and inside the channelizer's usable fraction (0.8 of the span).

Determinism: the same recipe, seed and numpy major version give the same bytes on one
platform. A different libm or numpy can change the last bit of a float and so the
sha256; if `download.sh` reports a mismatch after an upgrade, regenerate, check the
local decodes, and update the manifest sha256. Recorded shas come from numpy 2.5.3 on
macOS.

Generators keep FM transmitters keyed for the whole file (`continuous`) where the
decoder invents messages from noise (multimon-ng POCSAG), so the raw and channelizer
paths see the same decodes. The ACARS generator differentially codes its MSK tones
(2400 Hz for a repeated bit), the form acarsdec's coherent demodulator expects.

## License rules for fixtures

- Synthetic IQ (WaveKit generators) is allowed for AIS, POCSAG, APRS and ACARS
  (user decision 2026-10-09; relaxes addendum D2). DMR, analog voice, rtl_433 sensors
  and aircraft (VDL2 / ACARS / ADS-B) stay real captures.
- A public recording without a stated license may be used only when fetched from its
  origin at test time and never committed or redistributed. Its `license` reads
  `"unstated (fetched from origin; not redistributed; local test use only)"`.
- A composed fixture's `license` lists every component's license, e.g.
  `"composed: CC-BY-4.0 (IQEngine AIS recordings, Gary Schafer) + synthetic noise (WaveKit, AGPL-3.0-or-later)"`.
  CC BY sources keep their attribution in the recipe (`attribution`) and sidecar.
- Nothing under `raw/` is ever committed (it is gitignored), composed or not.
