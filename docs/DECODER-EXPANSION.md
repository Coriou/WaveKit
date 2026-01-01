# WaveKit Decoder Expansion Roadmap

> **Document Type**: Research & Architecture Guidelines (CTO Reviewed)
> **Audience**: Software Architects, Developers
> **Status**: Ready for implementation planning
> **Last Updated**: 2026-01-01

## Executive Summary

Your roadmap is directionally solid, but it needed several important updates to be truly “modern, efficient, and shippable”:

### What was already strong

- Correct identification that **audio vs IQ** drives pipeline design.
- Good decoder domain coverage (aviation, maritime, ham, satellites).
- Correct focus on **real-time event streaming**, extensibility, and observability.

### Critical corrections (applied in this revision)

1. **ADS-B**: “dump1090” is no longer the best default. Use **`readsb`** as the primary modern Mode-S/ADS-B decoder, with `dump1090-fa` as fallback. `readsb` is used in major open-source ADS-B stacks. ([ADS-B Exchange][1])
2. **ACARS**: The original `TLeconte/acarsdec` repo is **archived (Jul 31, 2025)**; you must target the maintained continuation (e.g. `f00b4r0/acarsdec`) as canonical. ([GitHub][2])
3. **SDR++ RAW mode**: Do **not** plan on it for IQ. Network sink is effectively **PCM/audio**, not a reliable IQ transport. Keep SDR++ as an **audio demod source only** unless you prove otherwise. ([sdrpp.org][3])
4. **Multi-SDR must move earlier**: Many “new” domains (ADS-B 1090, AIS 162, VHF ACARS/VDL2 136, HF HFDL, etc.) cannot share a single tuner. Multi-source support is a prerequisite to a good UX.
5. **Satellite plan must be updated**: NOAA APT via NOAA-15/18/19 is effectively **end-of-era**—NOAA-18 was decommissioned Jun 6, 2025; NOAA-15 & NOAA-19 were decommissioned Aug 2025. Satellite expansion should focus on **modern targets** (Meteor, GOES HRIT, etc.) via SatDump rather than “NOAA APT first”. ([NOAA OSPO][4])
6. **Security & maintenance**: At least one key decoder (Direwolf) has a published 2025 security issue; we must add version pinning + update discipline into the plan. ([nvd.nist.gov][5])

---

## Table of Contents

1. [Current State](#current-state)
2. [Decoder Portfolio (2026, state-of-the-art)](#decoder-portfolio-2026-state-of-the-art)
3. [Architecture: Source/Stream/Decoder Model](#architecture-sourcestreamdecoder-model)
4. [SDR++ Integration Positioning](#sdr-integration-positioning)
5. [Band Plans & Frequency Intelligence](#band-plans--frequency-intelligence)
6. [Implementation Phases (Optimized)](#implementation-phases-optimized)
7. [Engineering Standards (Definition of Done)](#engineering-standards-definition-of-done)
8. [Open Questions (Reduced + Actionable)](#open-questions-reduced--actionable)
9. [References](#references)

---

## Current State

WaveKit currently supports:

| Decoder     | Domain         | Input                | Output      |
| ----------- | -------------- | -------------------- | ----------- |
| dsd-fme     | Digital voice  | Audio PCM            | Text events |
| multimon-ng | Paging / tones | Audio PCM            | Text events |
| rtl_433     | ISM sensors    | IQ or Audio (varies) | JSON        |

Existing flow:

```
rtl_tcp (Pi) → SDR++ Server → Audio PCM → WaveKit fanout → decoders → WS events
```

**Keep this**, but don’t overfit the next wave of features to SDR++ audio-only assumptions.

---

## Decoder Portfolio (2026, state-of-the-art)

### Portfolio Principles

WaveKit should standardize decoder selection using:

- **Maintenance status** (active releases / commits, non-archived)
- **Output friendliness** (JSON/NMEA/SBS/Beast; stable formats)
- **Operational footprint** (docker-friendly, multiarch possibilities)
- **Ecosystem adoption** (“what most serious users run today”)

### Aviation (Recommended)

| Capability          | Primary Choice                                                            | Why                                                                                                 | Output                            | Priority          |
| ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------- |
| ADS-B 1090          | **readsb**                                                                | Modern, widely used in open-source ADS-B stacks; strong networking ecosystem. ([ADS-B Exchange][1]) | SBS/Beast/JSON (varies by config) | **HIGH**          |
| ADS-B 1090 fallback | dump1090-fa                                                               | Still common; good fallback                                                                         | SBS/Beast                         | MED               |
| UAT 978 (US)        | dump978-fa (+ readsb uat2esnt integration common in stacks) ([GitHub][6]) | Best practical option                                                                               | UAT messages → feeders            | MED (US only)     |
| ACARS (VHF)         | **acarsdec (maintained fork)**                                            | Original repo archived; use maintained continuation. ([GitHub][2])                                  | JSON/UDP/MQTT                     | **HIGH**          |
| VDL Mode 2          | **dumpvdl2**                                                              | Actively maintained; stable v2.5.0 released Nov 2, 2025. ([GitHub][7])                              | JSON                              | **HIGH**          |
| HFDL (HF)           | dumphfdl                                                                  | Valuable long-range aero data; docker ecosystem exists                                              | JSON/other outputs                | MED ([GitHub][8]) |

**Key CTO note:** ACARS/VDL2/HFDL should be treated as _“data link stack”_ (one dashboard experience), not three random decoders.

---

### Maritime (Recommended)

| Capability   | Primary Choice  | Why                                                                                                  | Output              | Priority           |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------- | ------------------- | ------------------ |
| AIS          | **AIS-catcher** | Versatile, modern, supports many SDRs + RTL-TCP + SpyServer + Soapy; multiple outputs. ([GitHub][9]) | NMEA + JSON options | **HIGH**           |
| AIS fallback | rtl-ais         | Simple, works, fewer features                                                                        | NMEA                | MED ([GitHub][10]) |

---

### Amateur Radio (Recommended)

| Capability        | Primary Choice   | Notes                                                                                                  | Output              | Priority |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------- | -------- |
| APRS              | **direwolf**     | Still the de-facto software TNC; but version pinning + security updates required. ([GitHub][11])       | KISS / AGWPE / text | **HIGH** |
| Weak signal modes | WSJT-X / JS8Call | Heavy + timing-sensitive; integrate later via their existing UDP/log outputs instead of “audio piping” | UDP/logs            | LOW      |

---

### ISM / Sensors

Keep `rtl_433` as core; it remains actively maintained with frequent releases/nightlies. ([GitHub][12])

---

### Satellite (Corrected for 2026 reality)

| Capability                 | Primary Choice   | Why                                                                                                                         | Priority |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| Multi-satellite processing | **SatDump**      | Best “all-in-one” modern open-source approach; supports many pipelines and has active distribution channels. ([GitHub][13]) | MED      |
| NOAA APT (“noaa-apt”)      | **Deprioritize** | NOAA-18 decommissioned Jun 2025; NOAA-15/19 decommissioned Aug 2025 → legacy hobby path. ([NOAA OSPO][4])                   | LOW      |

---

### Trunking / “Sensitive domains” (handle carefully)

- TETRA and trunked public-safety monitoring is often encrypted and/or legally sensitive.
- As a product posture: keep this **LOW priority** and ship guardrails (documentation + user responsibility) if ever supported.

---

## Architecture: Source/Stream/Decoder Model

Your original “dual pipeline: Audio vs IQ” is right, but it needs one more concept:

### The missing concept: **Tuner affinity + exclusivity**

Many decoders are not “pure stream consumers”:

- Some need **full control of a tuner** (center frequency, sample rate, gain).
- Some can share only if they’re on the **same center frequency** and sample rate (rare across domains).

### Proposed model (WaveKit 2.0)

#### 1) Sources

A `Source` is a _hardware or upstream provider_:

- `AudioSource` (PCM): SDR++ network sink (demod already done)
- `IQSource` (baseband): rtl_tcp / SoapyRemote / SpyServer / file replay
- `RecordingSource`: deterministic CI testing

Each source declares:

```ts
interface SourceCaps {
  kind: 'audio_pcm' | 'iq'
  sampleRate: number
  format: 's16le' | 'f32le' | 'u8_iq' | 's16_iq' | ...
  channels?: number
  centerFreq?: number
  exclusive: boolean   // can multiple clients attach?
}
```

#### 2) Streams (WaveKit internal bus)

A `Stream` is a routed instance coming out of a Source:

- `PCMStream` (fanout supported well)
- `IQStream` (fanout possible but expensive; use sparingly)

#### 3) Decoders (plugins)

Each decoder declares:

- what it needs (`audio_pcm` or `iq`)
- whether it can share a source
- whether it needs retuning control

```ts
interface DecoderCaps {
	input: "audio_pcm" | "iq" | "external" // external = decoder manages its own SDR
	wantsExclusiveSource?: boolean
	preferredSampleRates?: number[]
	output: "jsonl" | "nmea" | "beast" | "text"
}
```

### Decoder integration patterns (production-ready)

**Pattern 1 — “Pure consumer” (stdin audio → stdout events)**
Great for: multimon-ng, dsd-fme (current), some APRS setups.

**Pattern 2 — “Network producer” (decoder runs + you subscribe)**
Great for: readsb (TCP outputs), AIS-catcher (UDP/TCP), direwolf (KISS over TCP).

**Pattern 3 — “External SDR owner” (decoder controls tuner)**
Great for: acarsdec / dumpvdl2 / dumphfdl (they often assume tuner control).
This is the pragmatic way to ship aviation data links without inventing a full DSP engine.

### Why this architecture is “super efficient”

- You don’t force everything through SDR++ audio.
- You avoid building a full IQ DSP tuning engine prematurely.
- You can ship high-value aviation/maritime quickly with dedicated dongles.
- You keep the option open to later build true IQ fanout / VFO slicing.

---

## SDR++ Integration Positioning

**Treat SDR++ as:**

- A great UX demodulator/visualizer for _audio decoders_
- Not your foundation for IQ distribution

Your own plan correctly flags “RAW mode unknown.” In practice, SDR++ network sink discussions indicate it’s PCM/audio, not a robust IQ transport. ([sdrpp.org][3])

**Product decision:**

- Keep SDR++ audio pipeline as **first-class** for voice/pagers.
- Build **parallel IQ sourcing** via rtl_tcp / SoapyRemote for ADS-B/AIS/etc.

---

## Band Plans & Frequency Intelligence

Keep your approach, but tighten it:

### What to ship

1. Vendor SDR band plans (as seed data)
2. Normalize into a WaveKit `BandDB` format
3. Add a **region profile** (EU/NA/etc) that picks sane defaults

### What _not_ to do yet

- Don’t attempt to scrape or unify regulator databases in v1 (too high entropy)

### WaveKit `BandDB` format (recommended)

```ts
interface Band {
	id: string
	name: string
	domain: "aviation" | "maritime" | "ham" | "ism" | "satellite" | "other"
	startHz: number
	endHz: number
	modeHints?: Array<"AM" | "NFM" | "WFM" | "USB" | "LSB" | "RAW_IQ">
	defaults?: {
		eu?: number[]
		na?: number[]
	}
}
```

---

## Implementation Phases (Optimized)

### Phase 0 — Foundation (Required)

**Deliverable:** Multi-source + decoder supervisor improvements

- Multiple sources in config (at least 2 dongles / endpoints)
- Assign decoders → sources
- Health checks + restart/backoff per decoder
- Add `RecordingSource` (IQ/audio file replay) for CI & debugging

✅ This unlocks everything else.

---

### Phase 1 — ADS-B (Aviation “instant wow”)

**Primary:** `readsb` integration ([ADS-B Exchange][1])

- Run readsb as a managed decoder (Pattern 2)
- Parse output into `DecoderOutput` (`AircraftData`)
- Provide a minimal map layer + stats endpoint

**Acceptance criteria**

- Stable aircraft feed for >24h
- WS event throughput handled cleanly (rate limiting + batching in UI)

---

### Phase 2 — Aviation Data Links (ACARS + VDL2 + optional HFDL)

**Use modern maintained components:**

- `acarsdec` maintained continuation ([GitHub][2])
- `dumpvdl2` stable v2.5.0+ ([GitHub][7])
- `dumphfdl` optional ([GitHub][8])

**Acceptance criteria**

- Unified “Aviation Messages” dashboard:
  - filter by aircraft, label/type, frequency, time

- All message types normalized into:
  - `type: 'message' | 'position' | 'telemetry'`

- Document “legal + ethical use” clearly

---

### Phase 3 — AIS (Maritime)

**Primary:** AIS-catcher ([GitHub][9])

- Prefer JSON output mode when available; otherwise parse NMEA.
- Normalize into `ShipData`.

**Acceptance criteria**

- Live AIS ship positions with dedupe + track smoothing
- Basic vessel list + map view

---

### Phase 4 — APRS (Ham)

**Primary:** Direwolf ([GitHub][11])

- Run direwolf as Pattern 2 (KISS TCP) if possible
- Normalize APRS packets into `APRSData`

**Security note**

- Add version pinning + update doc; track published advisories. ([nvd.nist.gov][5])

---

### Phase 5 — Satellite (Separate subsystem, modernized)

**Primary:** SatDump ([GitHub][13])

- Treat as orchestration-heavy (configs, file outputs, scheduling)
- Focus on modern/weather satellite targets (not NOAA APT first, since NOAA-15/18/19 are decommissioned). ([NOAA OSPO][4])

---

### Phase 6 — IQ fanout / advanced DSP (optional “WaveKit Pro”)

Only after shipping the above:

- rtl_tcp multiplexer / WaveKit IQ bus
- VFO slicing (multiple narrow demods from a wide IQ stream)
- True scanning + multi-frequency audio decoders from one IQ feed

---

## Engineering Standards (Definition of Done)

### For every decoder plugin

Must include:

- `DecoderCaps` + `SourceCaps` compatibility tests
- Structured logging (startup args redacted safely)
- Health model:
  - “running”
  - “degraded” (no data)
  - “faulted” (crash loop)

- Sample data replay test in CI (audio/IQ capture)
- Output normalization contract tests (zod schemas)

### Operational guardrails

- Rate limiting for WS events
- Per-decoder ring buffer with drop policy (never let a slow consumer OOM the system)
- Metrics:
  - bytes/sec in/out
  - events/sec
  - decode success ratios (when possible)
  - restart counts

---

## Open Questions (Reduced + Actionable)

1. **SDR++ RAW mode**: keep as non-blocking experiment; don’t architect around it. ([sdrpp.org][3])
2. **IQ formats**: standardize internally on 1–2 formats (e.g., `u8_iq` and `s16_iq`) and convert at edges only.
3. **Output normalization strategy**:
   - Keep a common envelope (`DecoderOutput`)
   - Use domain-discriminated unions for `data` (zod + TS inference)

4. **Device assignment**:
   - Require serial-based config for multi-dongle setups
   - Validate at boot and fail fast with actionable errors

5. **Security updates**:
   - Version pin all decoders
   - Monthly dependency refresh cadence (or automated CVE watch)

---

## References (Updated)

- readsb (ADS-B decoder ecosystem) ([ADS-B Exchange][1])
- dump978 container notes (dump978-fa + readsb uat2esnt) ([GitHub][6])
- Original acarsdec archived + pointer to newer fork ([GitHub][2])
- dumpvdl2 stable version 2.5.0 (Nov 2, 2025) ([GitHub][7])
- AIS-catcher capabilities (multi SDR inputs + outputs) ([GitHub][9])
- Direwolf overview + 2025 advisory ([GitHub][11])
- NOAA POES decommission status (NOAA-15/19) + NOAA-18 decommission notice ([NOAA OSPO][4])

---

[1]: https://www.adsbexchange.com/open-source-software/?utm_source=chatgpt.com "Open Source Software"
[2]: https://github.com/TLeconte/acarsdec "GitHub - TLeconte/acarsdec: ACARS SDR decoder"
[3]: https://www.sdrpp.org/manual.pdf "SDR++ User Guide"
[4]: https://www.ospo.noaa.gov/operations/poes/status.html?utm_source=chatgpt.com "POES Performance Status"
[5]: https://nvd.nist.gov/vuln/detail/CVE-2025-34458?utm_source=chatgpt.com "CVE-2025-34458 Detail - NVD"
[6]: https://github.com/sdr-enthusiasts/docker-dump978?utm_source=chatgpt.com "sdr-enthusiasts/docker-dump978"
[7]: https://github.com/szpajder/dumpvdl2?utm_source=chatgpt.com "VDL Mode 2 Decoder & Protocol Analyzer"
[8]: https://github.com/sdr-enthusiasts/docker-dumphfdl?utm_source=chatgpt.com "sdr-enthusiasts/docker-dumphfdl"
[9]: https://github.com/jvde-github/AIS-catcher?utm_source=chatgpt.com "jvde-github/AIS-catcher: AIS receiver for RTL SDR dongles ..."
[10]: https://github.com/dgiardini/rtl-ais?utm_source=chatgpt.com "dgiardini/rtl-ais: A simple AIS tuner and generic dual- ..."
[11]: https://github.com/wb2osz/direwolf?utm_source=chatgpt.com "GitHub - wb2osz/direwolf: Dire Wolf is a software ..."
[12]: https://github.com/merbanan/rtl_433/releases?utm_source=chatgpt.com "Releases · merbanan/rtl_433"
[13]: https://github.com/SatDump/SatDump?utm_source=chatgpt.com "SatDump/SatDump: A generic satellite data processing ..."
