# ADS-B Aircraft Tracking

WaveKit includes a full ADS-B (Automatic Dependent Surveillance–Broadcast) aircraft tracking system that receives, decodes, aggregates, and enriches aircraft data.

## Overview

ADS-B is a surveillance technology where aircraft broadcast their GPS position, altitude, speed, and identity. WaveKit decodes these signals using **readsb** and presents enriched aircraft data through both the API and CLI.

## Architecture

```
1090 MHz RF Signal
        │
        ▼
   ┌─────────┐
   │ readsb  │  ← Decodes Mode S / ADS-B messages
   └────┬────┘
        │ JSON / SBS output
        ▼
   ┌─────────────────┐
   │ AircraftTracker │  ← Aggregates messages into aircraft state
   └────────┬────────┘
            │
            ▼
   ┌────────────────────────┐
   │ AircraftEnrichmentSvc  │  ← Looks up registration from hexdb.io
   └────────────────────────┘
            │
            ▼
     REST API + WebSocket + CLI Display
```

## Parsed Fields

### Core Identity

| Field      | Example  | Description                                        |
| ---------- | -------- | -------------------------------------------------- |
| `icao`     | `A12345` | 24-bit ICAO address (Mode S transponder code, hex) |
| `callsign` | `UAL123` | Flight identifier broadcast by aircraft            |
| `squawk`   | `1200`   | Transponder code set by pilot (4-digit octal, 0-7) |

### Position

| Field | Example  | Description                                                  |
| ----- | -------- | ------------------------------------------------------------ |
| `lat` | `40.71`  | Latitude in decimal degrees (-90 to +90)                     |
| `lon` | `-74.01` | Longitude in decimal degrees (-180 to +180)                  |
| `nic` | `8`      | Navigation Integrity Category (0-11, higher = more accurate) |

### Altitude

| Field      | Example | Description                                                |
| ---------- | ------- | ---------------------------------------------------------- |
| `baro`     | `35000` | Barometric altitude in feet (pressure-corrected)           |
| `geom`     | `35200` | Geometric/GNSS altitude in feet (GPS-based, more accurate) |
| `baroRate` | `1500`  | Vertical rate from barometer (ft/min, positive = climbing) |
| `geomRate` | `1480`  | Vertical rate from GPS (ft/min)                            |
| `onGround` | `false` | True if aircraft is on the ground                          |

### Velocity

| Field        | Example | Description                                            |
| ------------ | ------- | ------------------------------------------------------ |
| `gs`         | `450`   | Ground speed in knots (nautical miles per hour)        |
| `tas`        | `480`   | True airspeed in knots                                 |
| `ias`        | `280`   | Indicated airspeed in knots                            |
| `mach`       | `0.78`  | Mach number                                            |
| `track`      | `270`   | Track over ground in degrees (0-359, clockwise from N) |
| `trackRate`  | `0.5`   | Rate of track change (deg/sec, positive = right turn)  |
| `magHeading` | `268`   | Magnetic heading in degrees                            |

### Enrichment (from hexdb.io)

| Field             | Example           | Description                         |
| ----------------- | ----------------- | ----------------------------------- |
| `registration`    | `N12345`          | Aircraft tail number / registration |
| `typeCode`        | `B738`            | ICAO aircraft type designator       |
| `typeDescription` | `Boeing 737-800`  | Full aircraft type name             |
| `manufacturer`    | `Boeing`          | Aircraft manufacturer               |
| `operator`        | `United Airlines` | Airline/operator name               |
| `operatorCode`    | `UAL`             | Airline ICAO code                   |

### Navigation (Autopilot Intent)

| Field         | Example                 | Description                         |
| ------------- | ----------------------- | ----------------------------------- |
| `altitudeMcp` | `36000`                 | Selected altitude on MCP/FCU (feet) |
| `heading`     | `270`                   | Selected heading (degrees)          |
| `qnh`         | `1013.2`                | Altimeter setting (hPa/millibars)   |
| `modes`       | `["autopilot", "lnav"]` | Active navigation modes             |

### Signal Quality

| Field      | Example | Description                                         |
| ---------- | ------- | --------------------------------------------------- |
| `rssi`     | `-25.3` | Signal strength in dBFS (-50 to 0, higher = better) |
| `messages` | `1523`  | Total message count from this aircraft              |
| `seen`     | `0.2`   | Seconds since last message                          |
| `seenPos`  | `1.5`   | Seconds since last position update                  |

## CLI Display Format

The CLI displays aircraft in a compact format:

```
12:34:56 readsb  ADS  A12345 │ N12345 │ UAL123 │ B738 │ FL350↑ │ 450kt │ 40.71,-74.01 │ NE │ 2623
```

| Part           | Meaning                                                |
| -------------- | ------------------------------------------------------ |
| `12:34:56`     | Local time of update                                   |
| `readsb`       | Decoder name                                           |
| `ADS`          | Message type badge                                     |
| `A12345`       | ICAO hex address (24-bit Mode S identifier)            |
| `N12345`       | Registration (tail number) from hexdb.io enrichment    |
| `UAL123`       | Callsign (flight number)                               |
| `B738`         | ICAO type code (B738 = Boeing 737-800)                 |
| `FL350↑`       | Flight Level 350 (35,000 ft), climbing (↑)             |
| `450kt`        | Ground speed in knots                                  |
| `40.71,-74.01` | Position (latitude, longitude)                         |
| `NE`           | Track direction (compass heading: N/NE/E/SE/S/SW/W/NW) |
| `2623`         | Squawk code (ATC-assigned transponder code, dimmed)    |

### Squawk Codes

Squawk codes are 4-digit octal transponder codes (digits 0-7 only):

| Code   | Meaning                                  |
| ------ | ---------------------------------------- |
| `1200` | Standard VFR (Visual Flight Rules) in US |
| `7000` | Standard VFR in Europe                   |
| `2000` | Entering controlled airspace (Europe)    |
| `xxxx` | ATC-assigned code for tracking           |

Normal squawk codes are shown dimmed in the CLI.

### Flight Levels

Flight levels are the standard way to express altitude above 18,000 feet:

- **FL350** = 35,000 feet (altitude ÷ 100)
- **FL280** = 28,000 feet
- **GND** = Aircraft is on the ground

### Trend Indicators

- **↑** = Climbing (vertical rate > 300 ft/min)
- **↓** = Descending (vertical rate < -300 ft/min)
- (none) = Level flight

### Emergency Squawks

Special transponder codes indicate emergencies:

| Code   | Meaning                           |
| ------ | --------------------------------- |
| `7500` | 🚨 Hijack / unlawful interference |
| `7600` | 🚨 Radio failure (NORDO)          |
| `7700` | 🚨 General emergency (mayday)     |

When detected, these show with a red 🚨 indicator in the CLI.

## API Endpoints

### GET /api/aircraft

Returns all currently tracked aircraft as an array of `AircraftState` objects.

### GET /api/aircraft/:icao

Returns a single aircraft by ICAO hex address.

### WebSocket

Subscribe to real-time updates via WebSocket at `/ws`. Aircraft events include:

- `aircraft:new` - New aircraft detected
- `aircraft:update` - Aircraft state changed
- `aircraft:lost` - Aircraft timed out (no messages for 60s)

## Configuration

ADS-B decoding is enabled by configuring the `readsb` decoder:

```yaml
decoders:
  - id: adsb
    type: readsb
    enabled: true
    deviceSerial: "00000001" # RTL-SDR serial
    options:
      gain: 49.6
      ppm: 0
      outputFormat: json
```

### Enrichment Service

Aircraft enrichment (registration lookup) is enabled by default and uses hexdb.io:

- **Cache TTL**: 24 hours
- **Cache Size**: 10,000 entries
- **Rate Limit**: 100ms between API calls

## Common ICAO Type Codes

| Code | Aircraft                 |
| ---- | ------------------------ |
| A320 | Airbus A320              |
| A321 | Airbus A321              |
| A332 | Airbus A330-200          |
| A388 | Airbus A380-800          |
| B738 | Boeing 737-800           |
| B739 | Boeing 737-900           |
| B744 | Boeing 747-400           |
| B772 | Boeing 777-200           |
| B77W | Boeing 777-300ER         |
| B788 | Boeing 787-8 Dreamliner  |
| E75L | Embraer E175 (long wing) |
| CRJ9 | Bombardier CRJ-900       |
| C172 | Cessna 172 Skyhawk       |
