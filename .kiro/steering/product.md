# WaveKit Product Overview

WaveKit is a TypeScript-based SDR (Software Defined Radio) stream processing framework.

## What It Does

- Connects to SDR sources (rtl_tcp, SDR++ network sink, recording files)
- Fans out audio streams to multiple signal decoders in parallel
- Provides a Fastify REST/WebSocket API for control and monitoring
- Runs in Docker with optional SDR++ Server integration
- Outputs decoded audio over TCP for host-side playback

## Target Hardware Setup

```
Raspberry Pi 3          Mac (Docker)           Mac (Host)
RTL-SDR dongle    →     WaveKit Container  →   Audio Player
+ Antenna               SDR++ Server           (sox/ffplay)
rtl_tcp :1234           + Decoders             Browser UI
```

## Supported Decoders

- **dsd-fme**: Digital voice (DMR, P25, YSF, D-Star, NXDN, ProVoice)
- **multimon-ng**: Pager protocols (POCSAG, FLEX, EAS, DTMF)
- **rtl_433**: ISM band signal classifier

## Key Features

- Auto-reconnect to SDR sources with exponential backoff
- Stream multiplexing with independent buffering per decoder
- Real-time WebSocket events for decoder output
- Extensible decoder plugin system
- Health monitoring with degraded/faulted states
- Structured JSON logging with Pino
- Recording source playback with loop and speed control
