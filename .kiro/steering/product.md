# WaveKit Product Context

WaveKit is a TypeScript-based SDR stream processing framework that decodes multiple signal types in parallel.

## What It Does

- Connects to SDR sources (rtl_tcp, SDR++ network sink) over TCP
- Fans out audio streams to 8 signal decoders running in parallel
- Provides REST API and WebSocket for control and real-time events
- Streams decoded audio over TCP for host-side playback
- Runs in Docker with s6-overlay process supervision

## Target Setup

```
Raspberry Pi          Docker Container        Host Machine
RTL-SDR dongle   →    WaveKit                →  CLI Dashboard
rtl_tcp :1234         8 Decoders                Audio Player
                      REST API :9000
                      WebSocket :9000/ws
                      Audio TCP :8080
```

## Supported Decoders

| Decoder     | Signals        | Pattern          |
| ----------- | -------------- | ---------------- |
| readsb      | ADS-B aircraft | Network producer |
| AIS-catcher | AIS ships      | Network producer |
| acarsdec    | ACARS aviation | External SDR     |
| dumpvdl2    | VDL2 aviation  | External SDR     |
| dsd-fme     | DMR, P25, YSF  | Pure consumer    |
| multimon-ng | POCSAG, FLEX   | Pure consumer    |
| direwolf    | APRS           | Network producer |
| rtl_433     | ISM sensors    | Pure consumer    |

## Key Features

- Auto-reconnect to SDR sources with exponential backoff
- Stream multiplexing with backpressure handling
- Decoder health monitoring (running/degraded/faulted)
- Structured JSON logging with Pino
- CLI dashboard for real-time monitoring

## User Interfaces

1. **CLI Dashboard** (`make dev-dashboard`) - Primary interface, Ink/React terminal UI
2. **REST API** (`/api/*`) - Programmatic control
3. **WebSocket** (`/ws`) - Real-time event streaming
4. **Audio TCP** (`:8080`) - Decoded audio streaming
