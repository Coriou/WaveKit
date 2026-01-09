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

## Adding Fixtures

Edit `manifest.yaml` to add new fixtures. Required fields:

- `id`: Unique identifier
- `decoder`: Target decoder name
- `source_url`: Download URL
- `expected_output`: Pattern or count to validate
