# VDL2 Test Fixtures

This directory contains sample VDL Mode 2 (VDL2) data files for testing the Dumpvdl2 decoder.

## File Formats

### JSON Format

- `json-sample.jsonl` - Sample JSON Lines format from dumpvdl2 --output decoded:json:file:-
- Format: One JSON object per line with nested vdl2 structure
- Used by: dumpvdl2 with JSON output option

## Data Structure

VDL2 messages have a nested structure:

```json
{
  "vdl2": {
    "t": { "sec": 1704067200, "usec": 500000 },
    "freq": 136650000,
    "sig_level": -25.5,
    "noise_level": -45.0,
    "station": "GROUND1",
    "avlc": {
      "src": { "addr": "ABC123", "type": "aircraft" },
      "dst": { "addr": "GROUND1", "type": "ground" },
      "frame_type": "I",
      "acars": { ... }
    }
  }
}
```

## Key Fields

| Field                | Description                         |
| -------------------- | ----------------------------------- |
| vdl2.t.sec           | Unix timestamp seconds              |
| vdl2.t.usec          | Microseconds                        |
| vdl2.freq            | Frequency in Hz                     |
| vdl2.sig_level       | Signal level in dB                  |
| vdl2.noise_level     | Noise floor in dB                   |
| vdl2.station         | Ground station identifier           |
| vdl2.avlc.src.addr   | Source ICAO address                 |
| vdl2.avlc.dst.addr   | Destination address                 |
| vdl2.avlc.frame_type | Frame type (I, S, U, XID, etc.)     |
| vdl2.avlc.acars      | Embedded ACARS message (if present) |
| vdl2.avlc.xid        | XID frame data (if present)         |

## Common VDL2 Frequencies

| Frequency (Hz) | Region         |
| -------------- | -------------- |
| 136,650,000    | Europe primary |
| 136,700,000    | Europe         |
| 136,725,000    | Europe         |
| 136,775,000    | Europe         |
| 136,800,000    | Europe         |
| 136,825,000    | Europe         |
| 136,875,000    | Europe         |
| 136,900,000    | Europe         |
| 136,975,000    | Europe         |

## Message Types

VDL2 supports several message types:

- **ACARS**: Embedded ACARS messages (most common)
- **XID**: Exchange Identification frames (link management)
- **I-frames**: Information frames
- **S-frames**: Supervisory frames
- **U-frames**: Unnumbered frames

## Usage in Tests

These fixtures can be used for deterministic CI testing:

```typescript
import { loadJsonSample, SAMPLE_VDL2_MESSAGES } from "../mocks/fixtures/vdl2"

const messages = loadJsonSample()
// Parse and verify decoder output
```

## Data Sources

The sample data represents realistic VDL2 messages with:

- Various aircraft ICAO addresses
- Different frame types (I, XID, UI)
- Embedded ACARS messages
- Ground station information frames
- Various signal and noise levels
