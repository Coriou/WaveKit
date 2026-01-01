# WaveKit Decoder Expansion Roadmap

> **Document Type**: Research & Architecture Guidelines  
> **Audience**: Software Architects, Developers  
> **Status**: Draft for Review  
> **Last Updated**: 2026-01-01

This document captures research and architectural considerations for expanding WaveKit's signal decoding capabilities beyond the initial three decoders (dsd-fme, multimon-ng, rtl_433).

---

## Table of Contents

1. [Current State](#current-state)
2. [Decoder Candidates by Domain](#decoder-candidates-by-domain)
3. [Architecture Considerations](#architecture-considerations)
4. [SDR++ Network Sink Analysis](#sdr-network-sink-analysis)
5. [Band Plan & Frequency Data Sources](#band-plan--frequency-data-sources)
6. [Implementation Phases](#implementation-phases)
7. [Open Questions](#open-questions)
8. [References](#references)

---

## Current State

WaveKit's initial design includes three decoders:

| Decoder | Domain | Input | Output |
|---------|--------|-------|--------|
| **dsd-fme** | Digital voice (DMR, P25, YSF, D-Star, NXDN) | Audio PCM | Text events |
| **multimon-ng** | Pagers (POCSAG, FLEX, EAS, DTMF) | Audio PCM | Text events |
| **rtl_433** | ISM sensors (433 MHz devices) | IQ or Audio | JSON events |

**Current Architecture Flow**:
```
Raspberry Pi (rtl_tcp) → SDR++ Server → Audio PCM → Fanout → Decoders
```

---

## Decoder Candidates by Domain

### Aviation

| Decoder | Description | Input Type | Output | Priority | Notes |
|---------|-------------|------------|--------|----------|-------|
| **dump1090** | ADS-B aircraft tracking (1090 MHz) | IQ (2.4 MHz) | JSON | HIGH | Outputs position, altitude, callsign |
| **dump978** | UAT (978 MHz, US only) | IQ (2.0 MHz) | JSON | MEDIUM | Includes FIS-B weather, TIS-B traffic |
| **acarsdec** | ACARS text messages (129-136 MHz) | Audio (AM) | Text/JSON | HIGH | Flight reports, maintenance, free-text |
| **dumpvdl2** | VDL Mode 2 data link | IQ | JSON | LOW | More complex setup |

**Why Aviation Matters**: ADS-B is globally active, highly visual, and gives immediate feedback that the system is working.

### Maritime

| Decoder | Description | Input Type | Output | Priority | Notes |
|---------|-------------|------------|--------|----------|-------|
| **AIS-catcher** | Ship tracking (VHF 161.975/162.025 MHz) | IQ | JSON/NMEA | HIGH | Modern, actively maintained |
| **rtl-ais** | Alternative AIS decoder | IQ | NMEA | MEDIUM | Simpler, fewer features |

**Why Maritime Matters**: Coastal and river areas have constant activity. NMEA output is standardized.

### Amateur Radio

| Decoder | Description | Input Type | Output | Priority | Notes |
|---------|-------------|------------|--------|----------|-------|
| **direwolf** | APRS (144.39 MHz NA, 144.80 MHz EU) | Audio (FM) | APRS/KISS | HIGH | Position + messaging network |
| **fldigi** | Multi-mode digital (PSK31, RTTY, Olivia) | Audio (SSB) | Text | LOW | Complex audio routing |
| **WSJT-X** | Weak signal (FT8, FT4, JT65) | Audio (SSB) | QSO logs | LOW | Requires sub-second timing |
| **JS8Call** | Keyboard messaging | Audio (SSB) | Messages | LOW | FT8-based conversational |

**Why APRS Matters**: Always active, position data is highly visual, fits audio pipeline.

### Satellite

| Decoder | Description | Input Type | Output | Priority | Notes |
|---------|-------------|------------|--------|----------|-------|
| **SatDump** | Multi-satellite processor | IQ/Audio | Images, telemetry | MEDIUM | All-in-one solution |
| **noaa-apt** | NOAA APT imagery (137 MHz) | Audio (FM) | Images | LOW | Legacy, satellites aging out |
| **gr-satellites** | Amateur satellite telemetry | IQ | Frames | LOW | GNU Radio based |

**Satellite Complexity**: Requires pass prediction, Doppler correction, and antenna tracking. Consider as separate subsystem.

### Trunking (European Focus)

| Decoder | Description | Input Type | Output | Priority | Notes |
|---------|-------------|------------|--------|----------|-------|
| **tetra-rx** | TETRA trunking | Audio | Voice/Data | LOW | European emergency services |

---

## Architecture Considerations

### Input Type Split: Audio vs IQ

**Critical Discovery**: Decoders divide into two categories with different pipeline requirements.

#### Audio-Based Decoders (Current Architecture Supports)
- dsd-fme, multimon-ng, acarsdec, direwolf, fldigi, WSJT-X
- Input: Demodulated audio PCM (S16LE/F32, 48 kHz)
- Source: SDR++ NFM/WFM/AM network sink

#### IQ-Based Decoders (New Pipeline Needed)
- dump1090, dump978, AIS-catcher, rtl_433, SatDump
- Input: Raw IQ samples (complex I/Q at 1.6-2.4 MHz)
- Source: Direct rtl_tcp or SDR++ raw mode (if supported)

### Proposed Dual-Pipeline Architecture

```
                                    ┌─────────────────┐
                                    │   dsd-fme       │
┌──────────────┐   NFM/AM Audio     │   multimon-ng   │
│   SDR++      ├───────────────────►│   acarsdec      │
│   Server     │   (PCM S16LE)      │   direwolf      │
└──────┬───────┘                    └─────────────────┘
       │
       │  OR (need to verify SDR++ raw mode)
       │
┌──────┴───────┐                    ┌─────────────────┐
│   rtl_tcp    │   Raw IQ           │   dump1090      │
│   (direct)   ├───────────────────►│   dump978       │
│              │   (Complex)        │   AIS-catcher   │
└──────────────┘                    │   rtl_433       │
                                    └─────────────────┘
```

### Decoder Integration Patterns

**Pattern A: Stdin Audio → Stdout Lines** (acarsdec, direwolf)
```typescript
spawn('acarsdec', ['-r', '0', '-v', '-o', '4', '-j', 'localhost:5555'])
// Reads audio from SDR, outputs JSON to network
```

**Pattern B: IQ via Network Port** (dump1090)
```typescript
spawn('dump1090', ['--net', '--net-ri-port', '30001'])
// Connects to rtl_tcp or receives IQ via network
```

**Pattern C: IQ via Stdin** (rtl_433, AIS-catcher)
```typescript
spawn('rtl_433', ['-r', '-', '-F', 'json'])
// Reads IQ from stdin, outputs JSON to stdout
```

**Pattern D: Complex Orchestration** (SatDump)
```typescript
// Needs config files, output directories, pass scheduling
spawn('satdump', ['live', 'noaa_apt', '--source', 'rtltcp', ...])
```

### Multi-SDR Support (Future)

For multi-dongle setups, consider:
- Device assignment by serial number
- Dedicated frequency ranges per dongle (e.g., one for 1090 MHz, one for VHF)
- USB contention management

---

## SDR++ Network Sink Analysis

### Current Understanding

The existing WaveKit setup uses:
```
Raspberry Pi (rtl_tcp :1234) → SDR++ Server → Network Sink → WaveKit
```

SDR++ network sink modes:
- **NFM/WFM/AM/USB/LSB**: Outputs demodulated audio PCM (confirmed working)
- **RAW**: Outputs... **unconfirmed format** (likely undemodulated PCM, not IQ)

### Required Investigation

> **ACTION ITEM**: Test SDR++ "RAW" network sink mode to determine:
> 1. What format it actually outputs (IQ complex samples or PCM?)
> 2. Sample rate and data format (I16, F32, etc.)
> 3. Whether it's suitable for IQ-based decoders

### Potential Solutions for IQ Pipeline

If SDR++ RAW mode doesn't provide true IQ:

1. **Direct rtl_tcp Passthrough**: Route rtl_tcp directly to IQ decoders
   - Pro: Simple, proven
   - Con: Can't use SDR++ visualizer simultaneously

2. **rtl_tcp Multiplexer**: Build a TCP proxy that fans out rtl_tcp to multiple consumers
   - Pro: Single dongle serves both SDR++ and IQ decoders
   - Con: Additional component to build

3. **SoapyRemote**: Alternative to rtl_tcp with more flexibility
   - Pro: Supports more SDR hardware
   - Con: Additional dependency

---

## Band Plan & Frequency Data Sources

For a portable, global toolset, we need region-aware frequency information.

### SDR++ Band Plan Format

SDR++ uses JSON band plans located in `res/bandplans/`. Format:
```json
{
  "name": "USA KN1E",
  "country_name": "United States",
  "country_code": "US",
  "bands": [
    {
      "name": "2m Amateur",
      "type": "amateur",
      "start": 144000000,
      "end": 148000000
    }
  ]
}
```

### Available Data Sources

| Source | Format | Coverage | Notes |
|--------|--------|----------|-------|
| **SDR-Band-Plans** (GitHub) | JSON/XML/CSV | US, International | Community maintained, SDR++/SDR#/Gqrx compatible |
| **ITU Radio Regulations** | PDF | Global (3 regions) | Official but not machine-readable |
| **National regulators** | Varies | Per-country | FCC, Ofcom, ACMA, etc. have databases |
| **RadioReference.com** | Proprietary | US-focused | Subscription required |
| **SigIdWiki** | Wiki | Global | Signal identification reference |

**Recommended Approach**:
1. Use SDR-Band-Plans as primary source (already JSON, proven with SDR++)
2. Document regional frequency differences for key decoders
3. Consider building a merged/normalized band plan for WaveKit's dashboard

### Key Regional Frequency Differences

| Signal | NA/ITU Region 2 | Europe/ITU Region 1 | Notes |
|--------|-----------------|---------------------|-------|
| APRS | 144.390 MHz | 144.800 MHz | Different packet frequencies |
| ADS-B | 1090 MHz | 1090 MHz | Global standard |
| UAT | 978 MHz | N/A | US only |
| AIS | 161.975/162.025 MHz | Same | Global standard |
| NOAA APT | 137.x MHz | Same | Satellites are being retired |
| ISM Band | 433.92 MHz | 433.92 MHz (lower power in EU) | rtl_433 territory |

**Reference**: [SDR-Band-Plans GitHub](https://github.com/Arrin-KN1E/SDR-Band-Plans)

---

## Implementation Phases

### Phase 1: Audio-Based Expansion (Fits Current Architecture)

Decoders that work with the existing SDR++ → Audio PCM → Fanout pipeline:

- [ ] **acarsdec** - Aviation messaging (AM audio)
- [ ] **direwolf** - APRS network (FM audio)

**Effort**: Low - follows existing `BaseDecoder` pattern

### Phase 2: IQ Pipeline Foundation

Build infrastructure for IQ-based decoders:

- [ ] Investigate SDR++ RAW mode capabilities
- [ ] Design IQ fanout mechanism (rtl_tcp proxy or alternative)
- [ ] Add IQ source type to `SourceManager`

### Phase 3: IQ Decoder Integration

Add high-value IQ decoders:

- [ ] **dump1090** - ADS-B aircraft tracking
- [ ] **dump978** - UAT (if targeting US users)
- [ ] **AIS-catcher** - Maritime tracking
- [ ] **rtl_433** - (upgrade from audio to IQ input for better performance)

### Phase 4: Multi-SDR Support

Enable multiple dongles for simultaneous monitoring:

- [ ] Multiple source configuration in config.yaml
- [ ] Device identification by serial number
- [ ] Per-decoder source assignment

### Phase 5: Satellite Subsystem (Separate Effort)

Satellite reception is complex enough to be its own project:

- [ ] SatDump integration
- [ ] Pass prediction (TLE/orbital data)
- [ ] Doppler correction
- [ ] Antenna rotor control (optional)

---

## Open Questions

### Architecture

1. **SDR++ RAW Mode**: What does it actually output? Need hands-on testing.
2. **rtl_tcp Passthrough**: Should WaveKit include an rtl_tcp proxy for IQ fanout?
3. **Sample Rate Flexibility**: IQ decoders need different rates (ADS-B: 2.4 MHz, AIS: 1.6 MHz). How to handle?

### Design

4. **Output Normalization**: Should all decoders emit a unified `DecoderOutput` schema, or domain-specific types?
5. **Band Plan Integration**: Ship band plans with WaveKit, or download on demand?
6. **Geographic Context**: Auto-detect region for frequency defaults, or manual config?

### Operational

7. **USB Contention**: When supporting multiple dongles, how to reliably assign devices?
8. **Resource Limits**: How many decoders can run simultaneously on target hardware?

---

## References

### Decoder Projects

- [dump1090](https://github.com/antirez/dump1090) - Original ADS-B decoder
- [dump1090-fa](https://github.com/flightaware/dump1090) - FlightAware maintained fork
- [dump978](https://github.com/flightaware/dump978) - UAT decoder
- [acarsdec](https://github.com/TLeconte/acarsdec) - Multi-channel ACARS decoder
- [AIS-catcher](https://github.com/jvde-github/AIS-catcher) - High-performance AIS decoder
- [direwolf](https://github.com/wb2osz/direwolf) - APRS software TNC
- [SatDump](https://github.com/SatDump/SatDump) - Multi-satellite decoder
- [rtl_433](https://github.com/merbanan/rtl_433) - ISM band decoder
- [dsd-fme](https://github.com/lwvmobile/dsd-fme) - Digital Speech Decoder
- [multimon-ng](https://github.com/EliasOeworker/multimon-ng) - Multi-protocol decoder

### Band Plans & Frequency Data

- [SDR-Band-Plans](https://github.com/Arrin-KN1E/SDR-Band-Plans) - Community band plans (JSON/XML/CSV)
- [SigIdWiki](https://sigidwiki.com/) - Signal identification database
- [ITU Radio Regulations](https://www.itu.int/pub/R-REG-RR) - Official frequency allocations

### SDR Software

- [SDR++](https://github.com/AlexandreRouworker/SDRPlusPlus) - Cross-platform SDR receiver
- [rtl_tcp](https://osmocom.org/projects/rtl-sdr/wiki/Rtl-sdr) - RTL-SDR network server

---

## Appendix: Decoder Output Normalization

Proposed unified output schema for dashboard/API consistency:

```typescript
interface DecoderOutput {
  timestamp: Date
  decoder: string              // 'dump1090', 'acarsdec', etc.
  type: DecoderOutputType      // 'aircraft' | 'ship' | 'message' | 'position' | 'sensor'
  data: unknown                // Type-specific payload
}

// Domain-specific data types
interface AircraftData {
  icao: string                 // 24-bit Mode S address
  callsign?: string
  altitude?: number            // feet
  lat?: number
  lon?: number
  velocity?: number            // knots
  heading?: number             // degrees
  squawk?: string
}

interface ShipData {
  mmsi: string                 // Maritime Mobile Service Identity
  name?: string
  type?: string
  lat: number
  lon: number
  speed?: number               // knots
  heading?: number
  destination?: string
}

interface APRSData {
  callsign: string
  lat?: number
  lon?: number
  altitude?: number
  comment?: string
  path?: string[]
}
```
