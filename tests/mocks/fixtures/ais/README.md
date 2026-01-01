# AIS Test Fixtures

This directory contains sample AIS (Automatic Identification System) data files for testing the AIS-catcher decoder.

## File Formats

### NMEA Format

- `nmea-sample.txt` - Sample NMEA 0183 AIS sentences
- Format: !AIVDM/!AIVDO sentences with checksum
- Used by: AIS-catcher in NMEA mode

### JSON Format

- `json-sample.jsonl` - Sample JSON Lines format
- Format: One JSON object per line
- Used by: AIS-catcher with JSON output flag

## Data Fields

AIS messages contain the following key fields:

| Field       | Description                                 |
| ----------- | ------------------------------------------- |
| mmsi        | Maritime Mobile Service Identity (9 digits) |
| name        | Vessel name                                 |
| callsign    | Radio callsign                              |
| imo         | IMO number                                  |
| shiptype    | Ship type code                              |
| lat         | Latitude                                    |
| lon         | Longitude                                   |
| cog         | Course over ground (degrees)                |
| sog         | Speed over ground (knots)                   |
| heading     | True heading (degrees)                      |
| status      | Navigation status code                      |
| destination | Destination port                            |
| eta         | Estimated time of arrival                   |
| draught     | Ship draught (meters)                       |

## AIS Message Types

| Type | Description                   |
| ---- | ----------------------------- |
| 1    | Position Report Class A       |
| 2    | Position Report Class A       |
| 3    | Position Report Class A       |
| 5    | Static and Voyage Data        |
| 18   | Position Report Class B       |
| 19   | Extended Position Report B    |
| 21   | Aid-to-Navigation Report      |
| 24   | Class B CS Static Data Report |

## Navigation Status Codes

| Code | Description                |
| ---- | -------------------------- |
| 0    | Under way using engine     |
| 1    | At anchor                  |
| 2    | Not under command          |
| 3    | Restricted manoeuvrability |
| 4    | Constrained by draught     |
| 5    | Moored                     |
| 6    | Aground                    |
| 7    | Engaged in fishing         |
| 8    | Under way sailing          |

## Usage in Tests

These fixtures can be used for deterministic CI testing:

```typescript
import {
	loadJsonSample,
	loadNmeaSample,
	SAMPLE_SHIPS,
} from "../mocks/fixtures/ais"

const jsonMessages = loadJsonSample()
const nmeaSentences = loadNmeaSample()
// Parse and verify decoder output
```

## Recording Source Configuration

```typescript
const config = {
	id: "test-ais-source",
	type: "recording",
	filePath: "tests/mocks/fixtures/ais/nmea-sample.txt",
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

The sample data represents realistic AIS messages with:

- Various vessel types (cargo, tanker, passenger, fishing)
- Different MMSI formats (ship stations, coast stations)
- Mix of position reports and static data
- Various navigation statuses
- Both Class A and Class B transponders
