# Wideband IQ Channelizer - Future Feature Handoff

<!-- AI Agent Handoff Document - Future Feature Planning -->

## Quick Summary

**Objective**: Implement a wideband IQ channelizer that captures a wide bandwidth (e.g., 2-10 MHz) from a single SDR dongle and extracts multiple narrowband channels for different decoders, eliminating the need for multiple physical SDR dongles.

**Status**: Future feature — requires high-performance hardware, significant transport bandwidth, and completion of prerequisites.

**Estimated Effort**: ~15 days

> [!IMPORTANT]
> This feature is **client-side channelization** — the full wideband IQ stream must be transported from the SDR source to WaveKit before channelization. For bandwidth-constrained links (WiFi, remote SDR hosts), see the **Bandwidth Constraint Warning** section below.

---

## Problem Statement

Currently, decoders with incompatible requirements need separate SDR sources:

| Protocol         | Frequency           | Sample Rate | Modulation     |
| ---------------- | ------------------- | ----------- | -------------- |
| Pagers (POCSAG)  | 152-158 MHz         | 2.048 Msps  | Narrow FM      |
| ADS-B (aircraft) | 1090 MHz            | 2.0 Msps    | Pulse position |
| AIS (ships)      | 161.975/162.025 MHz | 288 kHz     | GMSK           |
| ACARS            | 129-136 MHz         | Various     | AM             |

These cannot share a single SDR stream because:

1. Different center frequencies
2. Different sample rate requirements
3. Different modulation schemes

---

## Bandwidth Constraint Warning

> [!CAUTION]
> **The wideband channelizer only works when you have sufficient transport bandwidth from the SDR source to WaveKit.**

### Bandwidth Requirements

| Sample Rate | IQ Format     | Bandwidth Required |
| ----------- | ------------- | ------------------ |
| 2.4 MHz     | U8_IQ (8-bit) | ~38 Mbps           |
| 3.2 MHz     | U8_IQ (8-bit) | ~51 Mbps           |
| 8.0 MHz     | U8_IQ (8-bit) | ~128 Mbps          |
| 10 MHz      | U8_IQ (8-bit) | ~160 Mbps          |

### When This Feature Works

✅ **Local USB connection** — SDR dongle connected directly to WaveKit host  
✅ **Gigabit Ethernet** — Wired connection to remote SDR host  
✅ **USB 3.0 over long cable** — Active extension to local dongle

### When This Feature Does NOT Work

❌ **WiFi to remote SDR host** — Typical sustained WiFi is 20-50 Mbps  
❌ **Raspberry Pi Zero W rtl_tcp** — Limited to ~1.92 Msps max  
❌ **Internet-connected SDR** — Latency and bandwidth constraints

### Recommended Alternative for Bandwidth-Constrained Setups

For bandwidth-limited scenarios, use the **server-side channelization** approach (see `SERVER_SIDE_CHANNELIZER_HANDOFF.md`) or the **multi-dongle configuration**:

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

  - id: "ais-dongle"
    type: "rtl_tcp"
    host: "192.168.1.101"
    port: 1234
    caps:
      kind: "iq"
      sampleRate: 288000
      format: "U8_IQ"
      centerFreq: 162000000
```

---

## Proposed Solution: Wideband Channelizer

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      WIDEBAND CHANNELIZER ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  [SDR Dongle] ───► HIGH BANDWIDTH LINK REQUIRED                                 │
│       │                                                                         │
│       │ Wideband IQ capture (e.g., 8 MHz @ 155 MHz center)                     │
│       ▼                                                                         │
│  [SourceManager] ─► Single high-bandwidth IQ stream                            │
│       │                                                                         │
│       ▼                                                                         │
│  [Channelizer] ◄── NEW COMPONENT                                                │
│       │                                                                         │
│       │ csdr shift + firdecimate per channel (see Technical Approach)          │
│       │                                                                         │
│       ├─────────────────────────────────────┬──────────────────────┐            │
│       │                                     │                      │            │
│       ▼                                     ▼                      ▼            │
│  [VirtualSource: 152.5 MHz]          [VirtualSource: 156 MHz]  [VirtualSource]  │
│       │ 25 kHz FM                          │ 25 kHz FM         │ 50 kHz        │
│       ▼                                     ▼                      ▼            │
│  multimon-ng                          dsd-fme              AIS-catcher          │
│  (POCSAG)                             (DMR/P25)            (AIS)                │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Technical Approach

### Option A: Per-Channel DDC (Recommended for WaveKit)

Use `csdr shift` + `csdr firdecimate` for each channel. This is the simpler approach and matches how OpenWebRX handles per-user channels.

```bash
# Example: Extract channel at +2.5 MHz offset, decimate to 48 kHz
csdr shift -r -0.3125 < wideband.iq \
  | csdr firdecimate 50 0.05 \
  | csdr fmdemod \
  > channel_audio.raw
```

**Pros:**

- Uses existing csdr commands
- Flexible channel placement (non-uniform spacing)
- Each channel can have different bandwidth

**Cons:**

- CPU usage scales linearly with channel count
- Not as efficient as polyphase for many uniform channels

### Option B: Polyphase Channelizer (Future optimization)

For 8+ uniformly-spaced channels, a polyphase filter bank would be more efficient. However, csdr doesn't have a ready-to-use polyphase channelizer command.

**Research findings:**

- GPU implementations are 4-10x faster than CPU
- ARM NEON provides modest speedups (26% typical on Pi 4)
- FPGAs are needed for GSPS rates
- For WaveKit's use case (2-8 channels), per-channel DDC is sufficient

---

## Technical Requirements

### Hardware Requirements

| Component           | Minimum          | Recommended             |
| ------------------- | ---------------- | ----------------------- |
| SDR                 | RTL-SDR v3/v4    | Airspy HF+ / SDRplay    |
| Sample rate         | 2.4 Msps         | 8-10 Msps               |
| USB                 | USB 2.0          | USB 3.0                 |
| CPU                 | 4-core x86_64    | 8-core or ARM with NEON |
| RAM                 | 4 GB             | 8+ GB                   |
| Network (if remote) | Gigabit Ethernet | Gigabit Ethernet        |

### Software Requirements

- **csdr 0.18+** (jketterl/csdr fork) with NEON optimizations
- Node.js with worker threads for CPU parallelism
- Buffer management for multiple output streams

---

## Proposed Configuration Schema

```yaml
channelizer:
  enabled: true
  sourceId: "wideband-dongle"
  centerFrequency: 155000000 # 155 MHz center
  bandwidth: 8000000 # 8 MHz capture
  cpuLimit: 80 # Max CPU % before throttling
  channels:
    - id: "pager-ch1"
      offset: -2500000 # 152.5 MHz
      bandwidth: 25000
      outputFormat: "audio_pcm"
      decimation: "auto" # Let channelizer calculate

    - id: "pager-ch2"
      offset: 0 # 155 MHz
      bandwidth: 25000
      outputFormat: "audio_pcm"

    - id: "ais-ch"
      offset: 7000000 # 162 MHz
      bandwidth: 50000
      outputFormat: "iq" # Keep as IQ for AIS-catcher
```

### Virtual Source API

Each channel exposed as a virtual source to SourceManager:

```typescript
sourceManager.getStatus("pager-ch1")
// {
//   id: 'pager-ch1',
//   type: 'channelizer-channel',
//   parentSourceId: 'wideband-dongle',
//   parentOffset: -2500000,
//   caps: {
//     kind: 'audio_pcm',
//     sampleRate: 48000,
//     format: 'S16LE'
//   },
//   connected: true
// }
```

---

## Implementation Phases

### Phase 1: Research & Prototyping (2 days)

- [ ] Benchmark csdr shift + firdecimate on target hardware
- [ ] Test with 4 simultaneous channels at 8 MHz
- [ ] Measure CPU usage per channel
- [ ] Validate audio quality at different decimation factors

### Phase 2: Channelizer Core (5 days)

**Create:** `src/core/channelizer.ts`

```typescript
interface ChannelizerConfig {
	enabled: boolean
	sourceId: string
	centerFrequency: number
	bandwidth: number
	cpuLimit?: number
	channels: ChannelConfig[]
}

interface ChannelConfig {
	id: string
	offset: number // Hz from center
	bandwidth: number // Hz
	outputFormat: "audio_pcm" | "iq"
	decimation?: number // Optional, auto-calculated if omitted
}

class Channelizer extends EventEmitter {
	private channels: Map<string, ChannelPipeline> = new Map()

	async start(): Promise<void>
	async stop(): Promise<void>

	addChannel(config: ChannelConfig): void
	removeChannel(id: string): void

	getChannelStream(id: string): Readable | null
	getStatus(): ChannelizerStatus
}
```

### Phase 3: Virtual Source Integration (3 days)

**Create:** `src/core/channelizer-channel.ts`

```typescript
class ChannelizerChannel implements VirtualSource {
	readonly id: string
	readonly parentSourceId: string
	readonly offset: number

	getStream(): Readable
	getCaps(): SourceCaps
	getStatus(): SourceStatus
}
```

**Modify:** `src/core/source-manager.ts`

- Register virtual sources from channelizer
- Route decoder assignments to virtual sources

### Phase 4: Configuration & API (1 day)

**Create:** `config/channelizer.schema.ts` — Zod schema  
**Modify:** `src/config.ts` — Add channelizer config section  
**Modify:** `src/api/routes/` — Add channelizer status endpoint

### Phase 5: Testing & Documentation (3 days)

**Create:**

- `tests/unit/core/channelizer.test.ts`
- `docs/CHANNELIZER.md`

---

## Files Summary

### Files to Create

| File                                  | Purpose                    | Est. Lines |
| ------------------------------------- | -------------------------- | ---------- |
| `src/core/channelizer.ts`             | Main channelizer component | ~400       |
| `src/core/channelizer-channel.ts`     | Virtual channel source     | ~150       |
| `src/core/channel-pipeline.ts`        | Per-channel csdr process   | ~200       |
| `config/channelizer.schema.ts`        | Zod validation schema      | ~50        |
| `tests/unit/core/channelizer.test.ts` | Unit tests                 | ~300       |
| `docs/CHANNELIZER.md`                 | User documentation         | ~200       |

### Files to Modify

| File                         | Changes                        |
| ---------------------------- | ------------------------------ |
| `src/config.ts`              | Add `ChannelizerConfigSchema`  |
| `src/core/source-manager.ts` | Support virtual sources        |
| `src/index.ts`               | Wire channelizer component     |
| `src/api/routes/sources.ts`  | Include virtual sources in API |

---

## Prerequisites Before Implementation

| Prerequisite                 | Status         | Notes                                      |
| ---------------------------- | -------------- | ------------------------------------------ |
| Dynamic sample rate handling | ⬜ Required    | See `DYNAMIC_SAMPLE_RATE_HANDOFF.md`       |
| Multi-source support tested  | ⬜ Required    | Verify decoders work with multiple sources |
| Performance benchmarking     | ⬜ Recommended | Establish baseline CPU metrics             |
| User demand validation       | ⬜ Recommended | Confirm use cases                          |

---

## CPU Budget and Monitoring

> [!WARNING]
> Running multiple csdr pipelines can saturate CPU. Implement monitoring and graceful degradation.

### Recommended Approach

```typescript
class Channelizer {
	private cpuMonitor: CpuMonitor

	private async checkCpuBudget(): Promise<boolean> {
		const usage = await this.cpuMonitor.getUsage()
		if (usage > this.config.cpuLimit) {
			this.log.warn(
				{ usage, limit: this.config.cpuLimit },
				"CPU limit exceeded",
			)
			return false
		}
		return true
	}

	addChannel(config: ChannelConfig): void {
		if (!this.checkCpuBudget()) {
			throw new Error("CPU budget exceeded, cannot add channel")
		}
		// ... create channel pipeline
	}
}
```

### Graceful Degradation Options

1. **Refuse new channels** when CPU budget exceeded
2. **Reduce channel quality** (lower filter taps)
3. **Drop least-priority channels** (requires priority config)

---

## Advantages and Challenges

### Advantages

| Advantage             | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| Single dongle         | One RTL-SDR can feed multiple decoders on nearby frequencies |
| Reduced hardware cost | No need for multiple dongles + USB hub                       |
| Atomic tuning         | All channels move together if center frequency changes       |
| Simplified setup      | One source config instead of many                            |

### Challenges

| Challenge                | Mitigation                                   |
| ------------------------ | -------------------------------------------- |
| High CPU usage           | CPU monitoring + limits                      |
| Limited frequency span   | RTL-SDR max ~2.4 MHz stable, Airspy ~10 MHz  |
| Incompatible frequencies | Can't combine 150 MHz with 1090 MHz          |
| Complex configuration    | Provide sensible defaults + validation       |
| Bandwidth requirements   | Clear documentation, server-side alternative |

---

## References

- [csdr (jketterl fork)](https://github.com/jketterl/csdr) — Modern csdr with NEON support
- [OpenWebRX channelization](https://github.com/jketterl/openwebrx) — Reference implementation
- [GNU Radio polyphase channelizer](https://wiki.gnuradio.org/index.php/Polyphase_Channelizer) — Theory reference
- [RTL-SDR wideband](https://www.rtl-sdr.com/tag/wideband/) — Community examples

---

## Decision Log

| Date       | Decision                           | Rationale                                                  |
| ---------- | ---------------------------------- | ---------------------------------------------------------- |
| 2026-01-13 | Document as future feature         | Requires significant bandwidth; simpler alternatives exist |
| 2026-01-13 | Recommend multi-dongle first       | Lower complexity, works with existing hardware             |
| 2026-01-13 | Use per-channel DDC over polyphase | csdr has shift+firdecimate; polyphase not available        |
| 2026-01-13 | Add bandwidth constraint warnings  | WiFi users need clear expectations                         |
| 2026-01-13 | Require dynamic sample rate first  | Prerequisite for proper caps propagation                   |

---

## Success Criteria

- [ ] Channelizer can extract 4+ channels from 8 MHz capture
- [ ] Virtual sources appear in SourceManager
- [ ] Decoders can be assigned to virtual sources
- [ ] CPU monitoring prevents overload
- [ ] Documentation clearly explains bandwidth requirements
- [ ] Unit tests cover channel math and pipeline management
