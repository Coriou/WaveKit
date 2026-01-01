# APRS Test Fixtures

This directory contains sample APRS (Automatic Packet Reporting System) data files for testing the Direwolf decoder.

## File Formats

### KISS Binary Format

- `kiss-sample.bin` - Sample KISS frames in binary format
- Format: KISS TNC protocol with FEND (0xC0) delimiters
- Used by: Direwolf KISS TCP output (port 8001)

### Text Format

- `packets-sample.txt` - Sample decoded APRS packets in human-readable format
- Format: One packet per line with source, destination, path, and data
- Used by: Reference data for verifying parser output

## KISS Protocol

KISS (Keep It Simple, Stupid) is a protocol for communicating with TNCs (Terminal Node Controllers).

### Frame Structure

```
FEND | CMD | DATA... | FEND
0xC0 | 0x00| AX.25   | 0xC0
```

### Special Bytes

| Byte | Name  | Description                  |
| ---- | ----- | ---------------------------- |
| 0xC0 | FEND  | Frame End delimiter          |
| 0xDB | FESC  | Frame Escape                 |
| 0xDC | TFEND | Transposed FEND (after FESC) |
| 0xDD | TFESC | Transposed FESC (after FESC) |

### Escape Sequences

- `0xC0` in data → `0xDB 0xDC`
- `0xDB` in data → `0xDB 0xDD`

## AX.25 Frame Structure

```
DEST (7) | SRC (7) | DIGI (0-56) | CTRL (1) | PID (1) | INFO (var)
```

### Address Format (7 bytes each)

- Bytes 0-5: Callsign (ASCII shifted left by 1, space padded)
- Byte 6: SSID byte (bits 1-4 = SSID, bit 0 = end-of-address flag)

## APRS Data Types

| Char | Type                          |
| ---- | ----------------------------- |
| !    | Position (no messaging)       |
| =    | Position (with messaging)     |
| /    | Position with timestamp       |
| @    | Position with timestamp + msg |
| ;    | Object                        |
| )    | Item                          |
| `    | Mic-E current                 |
| '    | Mic-E old                     |
| :    | Message                       |
| >    | Status                        |
| <    | Capabilities                  |
| ?    | Query                         |
| T    | Telemetry                     |
| \_   | Positionless weather          |
| $    | Raw GPS/NMEA                  |

## Sample Data

The fixtures include various APRS packet types:

- Position reports (compressed and uncompressed)
- Status messages
- APRS messages with acknowledgments
- Weather reports
- Mic-E encoded positions
- Digipeated packets with paths

## Usage in Tests

```typescript
import {
	loadKissSample,
	loadPacketsSample,
	SAMPLE_CALLSIGNS,
	SAMPLE_PACKETS,
} from "../mocks/fixtures/aprs"

const kissFrames = loadKissSample()
const packets = loadPacketsSample()
```

## Recording Source Configuration

```typescript
const config = {
	id: "test-aprs-source",
	type: "recording",
	filePath: "tests/mocks/fixtures/aprs/kiss-sample.bin",
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

The sample data represents realistic APRS packets with:

- Various amateur radio callsigns (US, EU, JA formats)
- Different SSID values (0-15)
- Multiple digipeater paths (WIDE1-1, WIDE2-2)
- Mix of position, status, and message packets
- Both compressed and uncompressed position formats
