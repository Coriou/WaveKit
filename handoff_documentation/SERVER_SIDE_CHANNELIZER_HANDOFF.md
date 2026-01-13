# Server-Side Channelizer (sdr-host) - Future Feature Handoff

<!-- AI Agent Handoff Document - Future Feature Planning -->

## Quick Summary

**Objective**: Implement server-side channelization in `wavekit-sdr-host` so that a Raspberry Pi (or similar edge device) can perform channel extraction locally, then stream only the narrowband channels over limited-bandwidth links (WiFi, Internet).

**Status**: Future feature — exploratory research phase

**Estimated Effort**: ~20-25 days (including sdr-host integration)

> [!NOTE]
> This is the bandwidth-constrained alternative to client-side wideband channelization. Instead of streaming raw wideband IQ to WaveKit, the edge device extracts channels and streams only what's needed.

---

## Problem Statement

The client-side wideband channelizer (see `WIDEBAND_CHANNELIZER_HANDOFF.md`) requires high transport bandwidth:

| Sample Rate | Bandwidth Required |
| ----------- | ------------------ |
| 2.4 MHz     | ~38 Mbps           |
| 8.0 MHz     | ~128 Mbps          |

This doesn't work over WiFi or Internet connections. But what if we could do the DSP **on the edge device** (e.g., Raspberry Pi) and stream only the extracted channels?

### Bandwidth Savings

| Approach                 | Channels | Per-Channel Rate | Total Bandwidth |
| ------------------------ | -------- | ---------------- | --------------- |
| Raw wideband (2.4 MHz)   | N/A      | N/A              | 38 Mbps         |
| Server-side (4 channels) | 4        | 48 kHz audio     | **0.6 Mbps**    |
| Server-side (8 channels) | 8        | 48 kHz audio     | **1.2 Mbps**    |

That's a **30-60x bandwidth reduction** — easily achievable over WiFi or even 4G/LTE.

---

## Can a Raspberry Pi Handle This?

### Research Summary

Based on research into csdr performance, ARM NEON optimizations, and real-world OpenWebRX deployments:

| Device          | CPU           | NEON | Max Sample Rate | Channels (estimate) | Verdict      |
| --------------- | ------------- | ---- | --------------- | ------------------- | ------------ |
| **Pi Zero W**   | 1× Cortex-A53 | Yes  | ~1.0 Msps       | 1-2                 | ❌ Too weak  |
| **Pi Zero 2 W** | 4× Cortex-A53 | Yes  | ~1.9 Msps       | 2-3                 | ⚠️ Marginal  |
| **Pi 3B+**      | 4× Cortex-A53 | Yes  | ~2.0 Msps       | 2-4                 | ⚠️ Marginal  |
| **Pi 4 (2GB+)** | 4× Cortex-A72 | Yes  | ~2.4 Msps       | 4-6                 | ✅ Good      |
| **Pi 5**        | 4× Cortex-A76 | Yes  | ~3.2+ Msps      | 6-10                | ✅ Excellent |
| **x86 mini-PC** | 4+ cores      | AVX2 | 10+ Msps        | 10+                 | ✅ Excellent |

### Key Findings

1. **NEON helps but isn't magic**: ARM NEON provides ~26% speedup for DSP operations, not 4x. Memory bandwidth is often the bottleneck.

2. **OpenWebRX proves it works**: OpenWebRX runs server-side csdr channelization on Raspberry Pi 4 successfully, handling multiple simultaneous web users.

3. **Single-core bottleneck**: csdr pipelines are single-threaded per channel. Multi-core CPUs can run multiple channels in parallel.

4. **Ring buffer optimizations matter**: The rtl_tcp ring buffer patch improved Pi Zero W from 0.92 → 1.92 Msps.

5. **Thermal throttling is real**: Continuous DSP can cause thermal throttling on Pi without heatsink/fan.

### Pi 4 Benchmark Expectations

For a Raspberry Pi 4 with heatsink, running Raspberry Pi OS 64-bit with NEON-optimized csdr:

| Configuration                  | CPU Usage | Feasibility             |
| ------------------------------ | --------- | ----------------------- |
| 1 channel @ 2.4 Msps, FM demod | ~15-20%   | ✅ Easy                 |
| 2 channels @ 2.4 Msps          | ~30-40%   | ✅ Good                 |
| 4 channels @ 2.4 Msps          | ~60-80%   | ✅ Feasible             |
| 6 channels @ 2.4 Msps          | ~90%+     | ⚠️ Pushing limits       |
| 8 channels @ 2.4 Msps          | >100%     | ❌ Need faster hardware |

---

## Architecture Options

### Option A: Multi-rtl_tcp Instances (Simplest)

Run separate rtl_tcp instances on different ports, each tuned to a different frequency. Requires multiple SDR dongles.

```
[Pi 4 + 3 RTL-SDRs]
├── rtl_tcp :1234 → 152.5 MHz (pagers)
├── rtl_tcp :1235 → 162.0 MHz (AIS)
└── rtl_tcp :1236 → 144.8 MHz (APRS)
```

**Pros:** Zero DSP overhead, proven approach  
**Cons:** Requires multiple dongles, more USB power draw

---

### Option B: Single SDR + Server-Side csdr Pipelines

Capture wideband from one SDR, run csdr pipelines on Pi, expose extracted channels via custom protocol.

```
┌───────────────────────────────────────────────────────────────┐
│                     sdr-host on Raspberry Pi 4                │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  [RTL-SDR] ──► rtl_sdr -s 2.4M -f 155M                       │
│       │                                                       │
│       ▼                                                       │
│  [IQ Fanout] ──────────────────────────────────────────┐     │
│       │                                                │     │
│       ├──► csdr shift -0.01 | firdecimate 50 ──► :8001 │     │
│       │    (152.5 MHz → 48 kHz audio)                  │     │
│       │                                                │     │
│       ├──► csdr shift +0.03 | firdecimate 50 ──► :8002 │     │
│       │    (162 MHz → 48 kHz audio)                    │     │
│       │                                                │     │
│       └──► Raw IQ passthrough ──► :1234 (rtl_tcp compat)     │
│                                                               │
└───────────────────────────────────────────────────────────────┘
         │         │         │
         ▼         ▼         ▼
    [WaveKit connects to :8001, :8002 as audio sources]
```

**Pros:** Single dongle, bandwidth-efficient  
**Cons:** More complex, custom protocol needed, CPU load

---

### Option C: Leverage OpenWebRX (Existing Solution)

OpenWebRX already does exactly this. WaveKit could connect to an OpenWebRX instance's WebSocket API to receive demodulated audio.

**Pros:** Already exists and works  
**Cons:** Different ecosystem, dependency on OpenWebRX

---

## Recommended Approach

> [!TIP]
> Start with **Option A** (multi-dongle) for immediate value, then explore **Option B** (server-side csdr) as an optimization.

### Phase 1: Multi-Dongle Support in sdr-host

The current sdr-host already supports managing multiple RTL-SDR dongles. Ensure each can be tuned independently and exposed via rtl_tcp.

### Phase 2: Server-Side Channelizer (Future)

If CPU benchmarks show feasibility, implement csdr-based channel extraction in sdr-host.

---

## Proposed sdr-host Architecture

### Configuration Schema

```yaml
# sdr-host config for server-side channelization
channelizer:
  enabled: true
  sourceDongle: 0 # RTL-SDR device index
  centerFrequency: 155000000 # 155 MHz
  sampleRate: 2400000 # 2.4 Msps

  channels:
    - id: "pager-152"
      offset: -2500000 # 152.5 MHz
      bandwidth: 25000
      demodulation: "nfm" # Output demodulated audio
      outputPort: 8001 # TCP port for audio stream

    - id: "ais"
      offset: 7000000 # 162 MHz
      bandwidth: 50000
      demodulation: "none" # Keep as IQ
      outputPort: 8002

  rawIqPassthrough:
    enabled: true
    port: 1234 # rtl_tcp compatible for SDR++
```

### Process Architecture

```typescript
// sdr-host/src/channelizer/index.ts

interface ChannelizerConfig {
	enabled: boolean
	sourceDongle: number
	centerFrequency: number
	sampleRate: number
	channels: ChannelConfig[]
	rawIqPassthrough?: { enabled: boolean; port: number }
}

class SdrHostChannelizer {
	private rtlProcess: ChildProcess // rtl_sdr capture
	private channelPipelines: Map<string, ChannelPipeline>

	async start(): Promise<void> {
		// 1. Start rtl_sdr with raw output to stdout
		// 2. Pipe to fanout process (tee -a or custom)
		// 3. Each channel gets its csdr pipeline
		// 4. Each pipeline output served via TCP
	}

	getStatus(): ChannelizerStatus {
		return {
			running: true,
			cpuUsage: this.getCpuUsage(),
			channels: Array.from(this.channelPipelines.values()).map(p =>
				p.getStatus(),
			),
		}
	}
}
```

### CPU Monitoring

```typescript
// Crucial for edge devices with limited CPU
class CpuMonitor {
	private readonly maxCpuPercent: number

	async checkBudget(): Promise<boolean> {
		const usage = await this.getCurrentUsage()
		return usage < this.maxCpuPercent
	}

	async getCurrentUsage(): Promise<number> {
		// Read /proc/stat or use os.loadavg()
	}
}
```

---

## WaveKit Integration

### New Source Type: `sdr-host-channel`

```yaml
# WaveKit config connecting to sdr-host channels
sources:
  - id: "pager-remote"
    type: "sdr-host-channel"
    host: "192.168.1.50"
    port: 8001
    caps:
      kind: "audio_pcm"
      sampleRate: 48000
      format: "S16LE"

  - id: "ais-remote"
    type: "sdr-host-channel"
    host: "192.168.1.50"
    port: 8002
    caps:
      kind: "iq"
      sampleRate: 50000 # Decimated from 2.4M
      format: "S16_IQ"
```

### Protocol Options

| Protocol           | Complexity | Features                      |
| ------------------ | ---------- | ----------------------------- |
| Raw TCP stream     | Low        | Just audio bytes, no metadata |
| rtl_tcp compatible | Medium     | Reuse existing parsing        |
| Custom JSON+binary | High       | Metadata, reconfiguration     |
| WebSocket          | Medium     | Web-friendly, bidirectional   |

**Recommendation:** Start with raw TCP stream (like rtl_tcp audio mode), add metadata protocol later.

---

## Files to Create (in sdr-host package)

| File                                                    | Purpose                       |
| ------------------------------------------------------- | ----------------------------- |
| `packages/sdr-host/src/channelizer/index.ts`            | Main channelizer orchestrator |
| `packages/sdr-host/src/channelizer/channel-pipeline.ts` | Per-channel csdr process      |
| `packages/sdr-host/src/channelizer/cpu-monitor.ts`      | CPU usage tracking            |
| `packages/sdr-host/src/channelizer/stream-server.ts`    | TCP server for channel output |
| `packages/sdr-host/src/config/channelizer.schema.ts`    | Zod schema                    |

---

## Prerequisites

| Prerequisite                   | Status | Notes                                |
| ------------------------------ | ------ | ------------------------------------ |
| sdr-host package implemented   | ⬜     | See sdr-host handoff                 |
| Dynamic sample rate in WaveKit | ⬜     | For coordinated rate changes         |
| Multi-source tested in WaveKit | ⬜     | WaveKit must handle multiple sources |
| csdr on sdr-host Docker image  | ⬜     | Add to Dockerfile                    |

---

## Hardware Recommendations

### Minimum Viable (2-3 channels)

- Raspberry Pi 4 (2GB RAM)
- Heatsink + small fan recommended
- Quality USB power supply (3A)
- RTL-SDR v3 or v4

### Recommended (4-6 channels)

- Raspberry Pi 5 (4GB RAM)
- Active cooling
- RTL-SDR v4 or Airspy Mini
- USB 3.0 hub (powered)

### High Performance (10+ channels)

- x86 mini-PC (Intel N100 or better)
- 8GB+ RAM
- Airspy HF+ Discovery or SDRplay
- Gigabit Ethernet

---

## Thermal Considerations

> [!WARNING]
> Continuous DSP workloads will cause thermal throttling without adequate cooling.

| Device                  | Cooling Required | Sustained DSP OK? |
| ----------------------- | ---------------- | ----------------- |
| Pi 4 (no heatsink)      | ❌ Will throttle | 1-2 channels only |
| Pi 4 (passive heatsink) | ⚠️ Marginal      | 2-4 channels      |
| Pi 4 (heatsink + fan)   | ✅ Good          | 4-6 channels      |
| Pi 5 (active cooler)    | ✅ Excellent     | 6-10 channels     |

---

## Estimated Effort

| Task                            | Effort       |
| ------------------------------- | ------------ |
| Research & prototyping on Pi    | 3 days       |
| CPU monitoring infrastructure   | 2 days       |
| Channel pipeline implementation | 5 days       |
| Stream server (TCP)             | 2 days       |
| sdr-host API integration        | 3 days       |
| WaveKit source type integration | 3 days       |
| Testing on various Pi models    | 3 days       |
| Documentation                   | 2 days       |
| **Total**                       | **~23 days** |

---

## Success Criteria

- [ ] Server-side channelizer runs on Raspberry Pi 4
- [ ] 4 channels extracted from 2.4 Msps capture
- [ ] CPU usage stays under 80% with 4 channels
- [ ] WaveKit connects to channel streams over WiFi
- [ ] Decoders work with remotely-extracted channels
- [ ] Thermal monitoring prevents throttling
- [ ] Documentation covers hardware requirements

---

## Decision Log

| Date       | Decision                     | Rationale                                   |
| ---------- | ---------------------------- | ------------------------------------------- |
| 2026-01-13 | Document as future feature   | Requires sdr-host work first                |
| 2026-01-13 | Target Pi 4 as minimum       | Good balance of availability and capability |
| 2026-01-13 | Start with raw TCP streams   | Simple, proven, low overhead                |
| 2026-01-13 | Recommend multi-dongle first | Works today with no new code                |

---

## References

- [OpenWebRX](https://github.com/jketterl/openwebrx) — Proves server-side channelization works on Pi
- [csdr (jketterl)](https://github.com/jketterl/csdr) — ARM NEON optimized DSP library
- [rtl_tcp ring buffer patch](https://www.rtl-sdr.com/a-]ring-buffer-patch-for-rtl_tcp/) — Improves stability on Pi
- [Raspberry Pi thermal management](https://www.raspberrypi.org/documentation/computers/raspberry-pi.html#thermal-management) — Official docs
