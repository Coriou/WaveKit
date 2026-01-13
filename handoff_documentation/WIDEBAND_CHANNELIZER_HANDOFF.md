# Wideband IQ Channelizer - Future Feature Handoff

## Overview

This document captures the vision and technical approach for a future **wideband IQ channelizer** feature. This would allow WaveKit to capture a wide bandwidth (e.g., 10 MHz) from a single SDR dongle and extract multiple narrowband channels for different decoders, eliminating the need for multiple physical SDR dongles.

> [!NOTE]
> This is a **future feature** for planning purposes. It requires high-performance hardware and significant bandwidth, so an alternative simpler approach should also be available.

---

## Problem Statement

Currently, decoders with incompatible requirements need separate SDR sources:

| Protocol         | Frequency           | Sample Rate | Notes                     |
| ---------------- | ------------------- | ----------- | ------------------------- |
| Pagers (POCSAG)  | 152-158 MHz         | 2.048 Msps  | Narrow FM                 |
| ADS-B (aircraft) | 1090 MHz            | 2.0 Msps    | Pulse position modulation |
| AIS (ships)      | 161.975/162.025 MHz | 288 kHz     | GMSK                      |
| ACARS            | 129-136 MHz         | Various     | AM                        |

These cannot share a single SDR stream because:

1. Different center frequencies
2. Different sample rate requirements
3. Different modulation schemes

---

## Proposed Solution: Wideband Channelizer

### Concept

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         WIDEBAND CHANNELIZER ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  [SDR Dongle]                                                                   │
│       │                                                                         │
│       │ Wideband IQ capture (e.g., 10 MHz @ 150 MHz center)                    │
│       ▼                                                                         │
│  [SourceManager] ─► Single high-bandwidth IQ stream                            │
│       │                                                                         │
│       ▼                                                                         │
│  [Channelizer] ◄── NEW COMPONENT                                                │
│       │                                                                         │
│       │ csdr polyphase or FFT-based channelization                             │
│       │                                                                         │
│       ├─────────────────────────────────────────┬──────────────────────┐        │
│       │                                         │                      │        │
│       ▼                                         ▼                      ▼        │
│  [Channel: 152.5 MHz]                    [Channel: 156 MHz]    [Channel: 162 MHz]│
│       │ 25 kHz FM                              │ 25 kHz FM          │ 25 kHz    │
│       ▼                                         ▼                      ▼        │
│  multimon-ng                              dsd-fme              AIS-catcher      │
│  (POCSAG)                                 (DMR/P25)            (AIS)            │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Key Technologies

1. **csdr polyphase channelizer** - Efficient FFT-based multi-channel extraction
2. **csdr firdecimate** - Per-channel decimation after extraction
3. **Virtual sources** - Present each channel as a separate "source" to FanoutManager

---

## Technical Requirements

### Hardware

- **RTL-SDR v4** or **Airspy HF+** for stable high sample rates
- Minimum **8 Msps** capture for useful wideband coverage
- USB 3.0 or better for sustained throughput
- Adequate CPU for FFT channelization (multi-core recommended)

### Software

- **csdr 0.18+** with polyphase channelizer support
- OR custom channelizer implementation using FFTW
- Buffer management for multiple output streams

---

## Implementation Considerations

### Advantages

1. **Single dongle** can feed multiple decoders on nearby frequencies
2. **Reduced hardware cost** for multi-protocol monitoring
3. **Atomic tuning** - all channels move together if center frequency changes

### Challenges

1. **High CPU usage** - FFT-based channelization is computationally expensive
2. **Limited frequency span** - RTL-SDR max ~2.4 MHz, Airspy ~10 MHz
3. **Incompatible frequencies** - Can't combine 150 MHz pagers with 1090 MHz ADS-B
4. **Complex configuration** - Users need to understand center frequency + offsets

### Alternative Approach (Recommended First)

For simpler setups, the **per-decoder source configuration** is recommended:

```yaml
sources:
  - id: "pager-dongle"
    type: "rtl_tcp"
    host: "192.168.1.100"
    port: 1234
    caps:
      kind: "iq"
      sampleRate: 2048000
      format: "U8_IQ"
      centerFreq: 152500000

  - id: "ads-b-dongle"
    type: "rtl_tcp"
    host: "192.168.1.101"
    port: 1234
    caps:
      kind: "iq"
      sampleRate: 2000000
      format: "U8_IQ"
      centerFreq: 1090000000
```

---

## Proposed API (Future)

### Configuration

```yaml
channelizer:
  enabled: true
  sourceId: "wideband-dongle"
  centerFrequency: 155000000 # 155 MHz center
  bandwidth: 8000000 # 8 MHz capture
  channels:
    - id: "pager-ch1"
      offset: -2500000 # 152.5 MHz
      bandwidth: 25000
      outputFormat: "audio_pcm"
    - id: "pager-ch2"
      offset: 0 # 155 MHz
      bandwidth: 25000
      outputFormat: "audio_pcm"
    - id: "ais-ch"
      offset: 7000000 # 162 MHz
      bandwidth: 50000
      outputFormat: "iq"
```

### Virtual Sources

Each channel would be exposed as a virtual source:

```typescript
sourceManager.getStatus("pager-ch1")
// {
//   id: 'pager-ch1',
//   type: 'channelizer-channel',
//   parentSourceId: 'wideband-dongle',
//   caps: { kind: 'audio_pcm', sampleRate: 48000, ... }
// }
```

---

## Files That Would Be Created

| File                                  | Purpose                    |
| ------------------------------------- | -------------------------- |
| `src/core/channelizer.ts`             | Main channelizer component |
| `src/core/channelizer-channel.ts`     | Virtual channel source     |
| `config/channelizer.schema.ts`        | Zod schema for config      |
| `tests/unit/core/channelizer.test.ts` | Unit tests                 |
| `docs/CHANNELIZER.md`                 | User documentation         |

---

## Estimated Effort

| Task                            | Effort       |
| ------------------------------- | ------------ |
| Research csdr polyphase API     | 2 days       |
| Channelizer core implementation | 5 days       |
| Virtual source integration      | 3 days       |
| Configuration system            | 1 day        |
| Testing                         | 3 days       |
| Documentation                   | 1 day        |
| **Total**                       | **~15 days** |

---

## Prerequisites Before Implementation

1. ✅ Dynamic sample rate handling (in progress)
2. ⬜ Multi-source support fully tested
3. ⬜ Performance benchmarking infrastructure
4. ⬜ User demand / use case validation

---

## References

- [csdr polyphase_filter](https://github.com/jketterl/csdr) - Modern csdr fork
- [GNU Radio polyphase channelizer](https://wiki.gnuradio.org/index.php/Polyphase_Channelizer) - Concept reference
- [Wideband SDR techniques](https://www.rtl-sdr.com/tag/wideband/) - Community examples

---

## Decision Log

| Date       | Decision                     | Rationale                                                  |
| ---------- | ---------------------------- | ---------------------------------------------------------- |
| 2026-01-13 | Document as future feature   | Requires significant bandwidth; simpler alternatives exist |
| 2026-01-13 | Recommend multi-dongle first | Lower complexity, works with existing hardware             |
