# ADS-B Test Fixtures

This directory contains sample ADS-B data files for testing the Readsb decoder.

## File Formats

### SBS (BaseStation) Format

- `sbs-sample.txt` - Sample SBS format messages
- Format: CSV with 22 fields per line
- Used by: dump1090, readsb in SBS mode

### Beast Binary Format

- `beast-sample.bin` - Sample Beast binary messages
- Format: Binary with escape sequences (0x1a)
- Used by: readsb, dump1090 in Beast mode

### JSON Format

- `json-sample.jsonl` - Sample JSON Lines format
- Format: One JSON object per line
- Used by: readsb in JSON mode

## Recording Source Files

### IQ Recordings

- `adsb-recording.raw` - Raw IQ recording (placeholder)
- Format: 8-bit unsigned IQ samples
- Sample rate: 2.4 MSPS
- Center frequency: 1090 MHz

## Usage in Tests

These fixtures can be used with the Recording Source feature for deterministic CI testing:

```typescript
const config = {
	id: "test-source",
	type: "recording",
	filePath: "tests/mocks/fixtures/adsb/sbs-sample.txt",
	loop: false,
	playbackSpeed: 1.0,
	caps: {
		kind: "recording",
		sampleRate: 48000,
		format: "S16LE",
		exclusive: false,
	},
}
```

## Data Sources

The sample data in these files represents realistic ADS-B messages with:

- Various aircraft ICAO addresses
- Different message types (identification, position, velocity)
- Mix of commercial and general aviation traffic
- Both airborne and ground positions
