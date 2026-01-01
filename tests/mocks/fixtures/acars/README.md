# ACARS Test Fixtures

This directory contains sample ACARS (Aircraft Communications Addressing and Reporting System) data files for testing the Acarsdec decoder.

## File Formats

### JSON Format

- `json-sample.jsonl` - Sample JSON Lines format from acarsdec -j output
- Format: One JSON object per line
- Used by: acarsdec with -j flag

## Data Fields

ACARS messages contain the following key fields:

| Field     | Description                         |
| --------- | ----------------------------------- |
| timestamp | Unix timestamp of message reception |
| freq      | Frequency in MHz (e.g., 131.55)     |
| channel   | Channel number (0-7)                |
| level     | Signal level in dB                  |
| error     | Number of bit errors                |
| mode      | ACARS mode character (2, X, H, Q)   |
| label     | Message label (2 characters)        |
| block_id  | Block identifier                    |
| ack       | Acknowledgement character           |
| tail      | Aircraft registration/tail number   |
| flight    | Flight number                       |
| msgno     | Message number                      |
| text      | Message text content                |

## Common ACARS Frequencies

| Frequency (MHz) | Region              |
| --------------- | ------------------- |
| 131.550         | Primary worldwide   |
| 131.725         | Secondary worldwide |
| 131.850         | Additional          |
| 129.125         | USA additional      |
| 130.025         | USA/Canada          |
| 130.450         | USA additional      |
| 136.900         | Europe              |

## Usage in Tests

These fixtures can be used for deterministic CI testing:

```typescript
import { loadJsonSample, SAMPLE_ACARS_MESSAGES } from "../mocks/fixtures/acars"

const messages = loadJsonSample()
// Parse and verify decoder output
```

## Data Sources

The sample data represents realistic ACARS messages with:

- Various aircraft registrations
- Different message labels (H1, Q0, SA, etc.)
- Mix of operational and position reports
- Various signal levels and error counts
