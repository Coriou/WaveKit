# ADS-B Aircraft Tracking

WaveKit includes a comprehensive ADS-B (Automatic Dependent Surveillance–Broadcast) aircraft tracking system that receives, decodes, aggregates, and enriches aircraft data in real-time.

## Overview

ADS-B is a surveillance technology where aircraft automatically broadcast their GPS position, altitude, speed, and identity on **1090 MHz**. WaveKit decodes these signals using **readsb** and presents enriched aircraft data through the REST API, WebSocket, and CLI dashboard.

> **Note**: ADS-B tracking is just one of WaveKit's many decoder capabilities. See the main README for the full list of supported protocols (AIS, ACARS, DMR, P25, APRS, etc.).

## Architecture

```
1090 MHz RF Signal (RTL-SDR @ 2.4 Msps)
        │
        ▼
   ┌─────────┐
   │ readsb  │  ← Decodes Mode S / ADS-B messages
   └────┬────┘
        │ JSON output (per-message)
        ▼
   ┌─────────────────┐
   │ AircraftTracker │  ← Aggregates messages into complete aircraft state
   └────────┬────────┘
            │
            ▼
   ┌────────────────────────┐
   │ AircraftEnrichmentSvc  │  ← Enriches with registration, type, photos from hexdb.io
   └────────────────────────┘
            │
            ▼
     REST API + WebSocket + CLI Display
```

## Why Different Rows Show Different Data

When viewing the CLI output, you'll notice that **not all aircraft rows contain the same fields**. This is normal and expected:

### ADS-B Message Types

Aircraft don't broadcast all data in every message. ADS-B uses multiple message types:

| Message Type | Contains                                      |
| ------------ | --------------------------------------------- |
| DF17/18 (0)  | Aircraft identification (callsign)            |
| DF17/18 (1)  | Surface position (when on ground)             |
| DF17/18 (2)  | Airborne position (lat/lon + altitude)        |
| DF17/18 (3)  | Airborne velocity (speed, heading, vert rate) |
| DF17/18 (4)  | Aircraft status (squawk, emergency codes)     |
| DF4/5/20/21  | Altitude only (Mode S surveillance reply)     |

A single aircraft may send **different message types** at different intervals:

- **Position**: Every 0.5 seconds (when maneuvering) to 2 seconds (cruise)
- **Velocity**: Every 1-2 seconds
- **Identity**: Every 5-10 seconds
- **Status**: When changed or every 5 seconds

### Why Some Fields Are Missing

| Observation in CLI               | Explanation                                            |
| -------------------------------- | ------------------------------------------------------ |
| No registration (yellow)         | hexdb.io lookup pending or aircraft not in database    |
| No callsign (white)              | Aircraft hasn't broadcast DF17/18 identification yet   |
| No type code (magenta)           | hexdb.io doesn't have this aircraft's type information |
| No speed                         | No velocity message received recently                  |
| No position                      | No position message received recently                  |
| No squawk                        | Aircraft hasn't broadcast status message yet           |
| No 📷 camera icon                | hexdb.io doesn't have a photo for this aircraft        |
| Different altitudes at same time | Different aircraft, or different altitude sources      |

### Data Accumulation

The AircraftTracker **accumulates data over time**. A newly-seen aircraft will initially show minimal data, then fill in as more message types are received. After 10-30 seconds, most fields should be populated (if the aircraft broadcasts them).

## CLI Display Format

The CLI displays aircraft in a compact, information-dense format:

```
16:22:45 adsb   ADS  4B1808 │ D-AMAB │ SWR8YB │ B38M │ FL380 │ 481kt │ 43.51,1.07 │ NE │ 2244 │ 📷
```

### Field Reference

| Position | Example      | Color   | Meaning                               | Source          |
| -------- | ------------ | ------- | ------------------------------------- | --------------- |
| 1        | `16:22:45`   | dim     | Local time of update                  | System          |
| 2        | `adsb`       | blue    | Decoder name                          | Config          |
| 3        | `ADS`        | cyan    | Message type badge                    | -               |
| 4        | `4B1808`     | cyan    | ICAO hex address (Mode S transponder) | ADS-B broadcast |
| 5        | `D-AMAB`     | yellow  | Registration (tail number)            | hexdb.io        |
| 6        | `SWR8YB`     | white   | Callsign / flight number              | ADS-B broadcast |
| 7        | `B38M`       | magenta | ICAO type code                        | hexdb.io        |
| 8        | `FL380`      | white   | Flight level (altitude ÷ 100)         | ADS-B broadcast |
| 9        | `↑` or `↓`   | cyan    | Vertical trend (climbing/descending)  | ADS-B broadcast |
| 10       | `481kt`      | white   | Ground speed in knots                 | ADS-B broadcast |
| 11       | `43.51,1.07` | dim     | Position (lat, lon)                   | ADS-B broadcast |
| 12       | `NE`         | dim     | Track direction (compass)             | ADS-B broadcast |
| 13       | `2244`       | dim     | Squawk code                           | ADS-B broadcast |
| 14       | `📷`         | dim     | Photo available (clickable link)      | hexdb.io        |

### Why No Speed Trend Arrows?

Unlike altitude (which has a vertical rate field ↑/↓), **ADS-B does not broadcast acceleration data**. Speed is a snapshot, not a rate of change. Therefore, we cannot show speed trend arrows—there's no data to derive them from.

| Field    | Has Trend? | Why                                     |
| -------- | ---------- | --------------------------------------- |
| Altitude | ✅ Yes     | `baroRate`/`geomRate` fields (ft/min)   |
| Speed    | ❌ No      | No acceleration field in ADS-B          |
| Track    | (future)   | `trackRate` exists but rarely broadcast |

## Transponder Squawk Codes

Squawk codes are 4-digit **octal** transponder codes (digits 0-7 only). They are assigned by ATC for tracking purposes.

### Standard Squawk Codes

| Code   | Region | Meaning                                            |
| ------ | ------ | -------------------------------------------------- |
| `1200` | USA    | Standard VFR (Visual Flight Rules)                 |
| `1201` | USA    | VFR near TFR (Temporary Flight Restriction)        |
| `1202` | USA    | VFR glider operations                              |
| `1205` | USA    | VFR helicopter                                     |
| `1255` | USA    | Firefighting operations                            |
| `1276` | USA    | ADIZ (Air Defense Identification Zone) penetration |
| `1277` | USA    | Search and rescue                                  |
| `7000` | Europe | Standard VFR                                       |
| `7001` | UK     | VFR aerobatic display                              |
| `7004` | Europe | Aerobatic display                                  |
| `7010` | UK     | IFR below FL100                                    |
| `2000` | ICAO   | Secondary Surveillance Radar (SSR) default         |
| `2200` | USA    | Non-radar environment / cleared above FL600        |

### Emergency Squawk Codes 🚨

These codes indicate serious situations and are highlighted with 🚨 in the CLI:

| Code   | Meaning                            | Pilot Action                    |
| ------ | ---------------------------------- | ------------------------------- |
| `7500` | **Hijack / Unlawful Interference** | Aircraft under unlawful control |
| `7600` | **Radio Failure (NORDO)**          | Cannot communicate via radio    |
| `7700` | **General Emergency (Mayday)**     | Life-threatening emergency      |

> **Memory trick**: "75 = taken alive, 76 = radio fix, 77 = going to heaven"

### Discrete Codes

Most 4-digit codes (e.g., `2244`, `4521`, `6702`) are **discrete codes** assigned by ATC to individual flights for radar identification. They have no special meaning.

## Flight Levels Explained

Above the **transition altitude** (typically 18,000 ft in the US, varies by country), altitude is expressed as **Flight Levels** rather than feet:

| Flight Level | Altitude (feet) | Notes                               |
| ------------ | --------------- | ----------------------------------- |
| `FL100`      | 10,000 ft       | US Class A airspace begins at FL180 |
| `FL180`      | 18,000 ft       | Transition altitude in US           |
| `FL350`      | 35,000 ft       | Typical cruising altitude           |
| `FL410`      | 41,000 ft       | Near service ceiling for most jets  |
| `FL450`      | 45,000 ft       | High-altitude jets, military        |
| `GND`        | On ground       | Aircraft on the ground              |

### Trend Indicators

| Symbol | Meaning                                  |
| ------ | ---------------------------------------- |
| `↑`    | Climbing (vertical rate > 300 ft/min)    |
| `↓`    | Descending (vertical rate < -300 ft/min) |
| (none) | Level flight (within ±300 ft/min)        |

## Common ICAO Aircraft Type Codes

The type code (shown in magenta) is the ICAO aircraft type designator:

### Airbus

| Code | Aircraft           | Notes                    |
| ---- | ------------------ | ------------------------ |
| A20N | Airbus A320neo     | New engine option        |
| A21N | Airbus A321neo     |                          |
| A319 | Airbus A319        | Shortened A320           |
| A320 | Airbus A320        | Most common narrow-body  |
| A321 | Airbus A321        | Stretched A320           |
| A332 | Airbus A330-200    | Wide-body twin           |
| A333 | Airbus A330-300    | Stretched A330           |
| A339 | Airbus A330-900neo |                          |
| A343 | Airbus A340-300    | Quad-engine long-haul    |
| A359 | Airbus A350-900    | Modern wide-body         |
| A35K | Airbus A350-1000   | Stretched A350           |
| A388 | Airbus A380-800    | Double-decker superjumbo |

### Boeing

| Code | Aircraft         | Notes                   |
| ---- | ---------------- | ----------------------- |
| B37M | Boeing 737 MAX 7 |                         |
| B38M | Boeing 737 MAX 8 | Most common MAX variant |
| B39M | Boeing 737 MAX 9 |                         |
| B734 | Boeing 737-400   | Classic series          |
| B738 | Boeing 737-800   | Most common 737 variant |
| B739 | Boeing 737-900   |                         |
| B744 | Boeing 747-400   | Classic jumbo           |
| B748 | Boeing 747-8     | Latest 747              |
| B752 | Boeing 757-200   |                         |
| B763 | Boeing 767-300   |                         |
| B772 | Boeing 777-200   |                         |
| B77L | Boeing 777-200LR | Long-range variant      |
| B77W | Boeing 777-300ER | Most common 777         |
| B788 | Boeing 787-8     | Dreamliner              |
| B789 | Boeing 787-9     | Most common 787         |
| B78X | Boeing 787-10    | Stretched Dreamliner    |

### Regional / Other

| Code | Aircraft                 | Notes                   |
| ---- | ------------------------ | ----------------------- |
| E75L | Embraer E175 (long wing) | Regional jet            |
| E190 | Embraer E190             |                         |
| E195 | Embraer E195             |                         |
| E290 | Embraer E190-E2          | New generation          |
| CRJ2 | Bombardier CRJ-200       | 50-seat regional        |
| CRJ7 | Bombardier CRJ-700       |                         |
| CRJ9 | Bombardier CRJ-900       |                         |
| C172 | Cessna 172 Skyhawk       | Most common GA aircraft |
| C208 | Cessna 208 Caravan       | Turboprop               |
| PC12 | Pilatus PC-12            | Executive turboprop     |
| GLF6 | Gulfstream G650          | Business jet            |
| BCS1 | Airbus A220-100          | Formerly Bombardier CS  |
| BCS3 | Airbus A220-300          |                         |

## Aircraft Enrichment

WaveKit enriches aircraft data using **hexdb.io**, a free and open ICAO database:

### Enriched Fields

| Field             | Example                | Source   |
| ----------------- | ---------------------- | -------- |
| `registration`    | `N12345`, `D-AMAB`     | hexdb.io |
| `typeCode`        | `B738`                 | hexdb.io |
| `typeDescription` | `Boeing 737-800`       | hexdb.io |
| `manufacturer`    | `Boeing`               | hexdb.io |
| `operator`        | `United Airlines`      | hexdb.io |
| `operatorCode`    | `UAL`                  | hexdb.io |
| `imageUrl`        | `https://hexdb.io/...` | hexdb.io |

### Aircraft Photos

When available, a clickable 📷 icon appears at the end of the aircraft row. Click it (in supported terminals like iTerm2, Terminal.app, VS Code) to open the aircraft photo from hexdb.io.

### Enrichment Settings

| Setting        | Default  | Description                       |
| -------------- | -------- | --------------------------------- |
| Cache TTL      | 24 hours | How long to cache enrichment data |
| Cache Size     | 10,000   | Maximum cached aircraft entries   |
| Rate Limit     | 1 req/s  | Maximum requests to hexdb.io      |
| Image Fetching | Enabled  | Also fetch aircraft photo URLs    |

## API Reference

### REST Endpoints

#### GET /api/aircraft

Returns all currently tracked aircraft.

```bash
curl http://localhost:9000/api/aircraft
```

Response: Array of `AircraftState` objects.

#### GET /api/aircraft/:icao

Returns a single aircraft by ICAO hex address.

```bash
curl http://localhost:9000/api/aircraft/4B1808
```

### WebSocket Events

Subscribe to the `aircraft` channel for real-time updates:

```javascript
ws.send(JSON.stringify({ type: "subscribe", channels: ["aircraft"] }))
```

#### Event Types

| Event             | Payload                | Description                      |
| ----------------- | ---------------------- | -------------------------------- |
| `aircraft:new`    | `AircraftState`        | New aircraft first detected      |
| `aircraft:update` | `AircraftState`        | Aircraft data changed            |
| `aircraft:lost`   | `{ icao: string }`     | Aircraft timed out (60s no data) |
| `aircraft:stats`  | `AircraftTrackerStats` | Periodic statistics (every 10s)  |

## Configuration

### readsb Decoder

Configure ADS-B decoding in your config file:

```yaml
decoders:
  - id: adsb
    type: readsb
    enabled: true
    options:
      gain: 49.6 # RTL-SDR gain (0-49.6)
      ppm: 0 # Frequency correction
      outputFormat: json # json, sbs, or beast
```

### Sample Rate Requirements

ADS-B decoding requires adequate sample rate:

| Sample Rate | Status         | Notes                               |
| ----------- | -------------- | ----------------------------------- |
| 2.4 Msps    | ✅ Recommended | Tested, reliable                    |
| 2.0 Msps    | ⚠️ May work    | Minimum for decoder timing          |
| < 2.0 Msps  | ❌ Fails       | Insufficient for ADS-B pulse timing |

### Frequency

ADS-B operates on **1090 MHz**. Tune your SDR to this frequency:

```bash
# Via tuner interface
Set frequency: 1090000000 Hz
Set sample rate: 2400000 Hz
```

## Signal Quality

The CLI shows signal quality indicators when available:

| Indicator | RSSI (dBFS) | Meaning |
| --------- | ----------- | ------- |
| `▓▓▓`     | > -10       | Strong  |
| `▓▓░`     | -10 to -20  | Good    |
| `▓░░`     | -20 to -30  | Fair    |
| `░░░`     | < -30       | Weak    |

## Parsed Fields Reference

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

## Troubleshooting

### No Aircraft Detected

1. **Check frequency**: Must be tuned to 1090 MHz
2. **Check sample rate**: Must be ≥ 2.0 Msps (2.4 Msps recommended)
3. **Check antenna**: Use an appropriate 1090 MHz antenna (not a random wire)
4. **Check location**: Need clear sky view; buildings block signals
5. **Check decoder status**: `curl http://localhost:9000/api/decoders`

### Enrichment Not Working

1. **Check network**: hexdb.io must be reachable
2. **Check cache**: First lookup takes 1+ seconds (rate limited)
3. **Not all aircraft**: Some aircraft (especially GA) may not be in hexdb.io

### Missing Fields

This is **normal behavior**—see "Why Different Rows Show Different Data" above. Aircraft don't broadcast all fields in every message. Wait a few seconds for data to accumulate.

## References

- **ADS-B Specification**: DO-260B (RTCA)
- **Mode S**: ICAO Annex 10, Volume IV
- **hexdb.io**: https://hexdb.io/
- **readsb**: https://github.com/wiedehopf/readsb
- **Squawk Codes**: FAA JO 7110.66 (NATA/NATCA)
