# WaveKit Architecture

This document describes WaveKit's internal architecture, component design, and data flow.

## System Overview

WaveKit is a TypeScript-based SDR stream processing framework that:

1. Connects to SDR sources over TCP (rtl_tcp, SDR++ network sink)
2. Multiplexes audio streams to multiple decoders in parallel
3. Manages decoder process lifecycles with auto-restart
4. Exposes decoded data via REST API and WebSocket
5. Streams decoded audio over TCP

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WaveKit Container                               │
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────────┐ │
│  │   Source    │    │   Fanout    │    │        Decoder Manager          │ │
│  │   Manager   │───▶│   Manager   │───▶│                                 │ │
│  │             │    │             │    │  ┌─────┐ ┌─────┐ ┌─────┐       │ │
│  │ TCP Client  │    │ Multiplexer │    │  │dsd  │ │multi│ │readsb│ ...  │ │
│  │ Auto-reconn │    │ Backpressure│    │  └─────┘ └─────┘ └─────┘       │ │
│  └─────────────┘    └─────────────┘    └─────────────────────────────────┘ │
│         │                                           │                       │
│         │                                           ▼                       │
│         │                              ┌─────────────────────────────────┐ │
│         │                              │         API Server              │ │
│         │                              │                                 │ │
│         │                              │  REST /api/*    WebSocket /ws   │ │
│         │                              └─────────────────────────────────┘ │
│         │                                           │                       │
│         ▼                                           ▼                       │
│  ┌─────────────┐                       ┌─────────────────────────────────┐ │
│  │   Audio     │                       │        External Clients         │ │
│  │   Output    │                       │                                 │ │
│  │  TCP :8080  │                       │  CLI Dashboard, Web UI, etc.   │ │
│  └─────────────┘                       └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### SourceManager

Manages TCP connections to SDR sources with automatic reconnection.

**Location**: `src/core/source-manager.ts`

**Responsibilities**:

- Establish TCP connections to rtl_tcp, SDR++ network sink, or recording files
- Auto-reconnect with exponential backoff (2s → 4s → 8s → max 30s)
- Emit connection events and data rate metrics
- Track source capabilities (sample rate, format, exclusivity)

**Key interfaces**:

```typescript
interface SourceConfig {
	id: string
	type: "rtl_tcp" | "sdrpp-network" | "recording"
	host?: string
	port?: number
	filePath?: string // For recording sources
	caps: SourceCaps
}

interface SourceCaps {
	kind: "audio_pcm" | "iq" | "recording"
	sampleRate: number
	format: "S16LE" | "FLOAT32LE" | "U8_IQ" | "S16_IQ"
	exclusive: boolean
}
```

**Events emitted**:

- `connected` — Source connected successfully
- `disconnected` — Source disconnected (with error if applicable)
- `data` — Raw data received
- `metrics` — Data rate metrics (every 5s)

### FanoutManager

Multiplexes a single audio stream to multiple decoder consumers.

**Location**: `src/core/fanout-manager.ts`

**Responsibilities**:

- Accept source stream as input
- Create independent buffered branches for each decoder
- Handle backpressure without blocking the source
- Emit backpressure warnings when buffers fill

**Key design decisions**:

- Each branch has independent buffering (default 256KB highWaterMark)
- Real-time priority: prefer dropping data over blocking source
- Data is copied to each branch (no shared buffers)

**Events emitted**:

- `backpressure` — Branch buffer is full
- `branch-added` — New branch created
- `branch-removed` — Branch removed

### DecoderManager

Orchestrates decoder process lifecycles.

**Location**: `src/decoders/manager.ts`

**Responsibilities**:

- Create decoder instances from registry
- Start/stop/restart decoder processes
- Handle auto-restart with exponential backoff
- Track decoder health (running/degraded/faulted)
- Assign decoders to sources

**Health states**:

- `running` — Decoder is running and producing output
- `degraded` — Running but no output for configured timeout (default 30s)
- `faulted` — Crashed and exceeded restart limits

### DecoderRegistry

Plugin system for registering decoder types.

**Location**: `src/decoders/registry.ts`

**Responsibilities**:

- Store decoder factory functions
- Store decoder capabilities
- Create decoder instances on demand
- Query decoders by capability

### BaseDecoder

Abstract base class for "pure consumer" decoders that receive audio via stdin.

**Location**: `src/decoders/base-decoder.ts`

**Template methods**:

```typescript
abstract class BaseDecoder {
	protected abstract getCommand(): string
	protected abstract getArgs(): string[]
	protected abstract parseOutput(line: string): DecoderOutput | null
}
```

**Built-in decoders extending BaseDecoder**:

- `DsdFmeDecoder` — Digital voice (DMR, P25, YSF, etc.)
- `MultimonDecoder` — Pager protocols (POCSAG, FLEX, etc.)
- `Rtl433Decoder` — ISM band sensors

### NetworkProducerDecoder

Base class for decoders that run as network services.

**Location**: `src/decoders/network-producer-decoder.ts`

**Pattern**: Decoder spawns as a process, WaveKit connects to its output port.

**Built-in decoders**:

- `ReadsbDecoder` — ADS-B (connects to SBS/Beast/JSON output)
- `AisCatcherDecoder` — AIS (connects to NMEA/JSON output)
- `DirewolfDecoder` — APRS (connects to KISS TCP port)

### ExternalSdrDecoder

Base class for decoders that manage their own SDR hardware.

**Location**: `src/decoders/external-sdr-decoder.ts`

**Pattern**: Decoder controls its own RTL-SDR dongle, WaveKit only parses output.

**Built-in decoders**:

- `AcarsdecDecoder` — ACARS
- `Dumpvdl2Decoder` — VDL2

### API Server

Fastify-based REST and WebSocket server.

**Location**: `src/api/server.ts`

**Responsibilities**:

- Expose REST endpoints for control and status
- Handle WebSocket connections for real-time events
- Broadcast decoder output to subscribed clients

### AudioOutput

TCP server for streaming decoded audio.

**Location**: `src/core/audio-output.ts`

**Responsibilities**:

- Listen on configured TCP port (default 8080)
- Stream audio to all connected clients
- Handle client connect/disconnect gracefully

## Data Flow

### Audio Pipeline

```
SDR Source (rtl_tcp)
       │
       │ TCP connection
       ▼
SourceManager
       │
       │ Node.js Readable stream
       ▼
FanoutManager
       │
       ├──────────────────┬──────────────────┐
       │                  │                  │
       ▼                  ▼                  ▼
   Branch 1           Branch 2           Branch N
   (PassThrough)      (PassThrough)      (PassThrough)
       │                  │                  │
       │                  │                  │
       ▼                  ▼                  ▼
   dsd-fme            multimon-ng        rtl_433
   (stdin)            (stdin)            (stdin)
       │                  │                  │
       │ stdout           │ stdout           │ stdout
       ▼                  ▼                  ▼
   Output Parser      Output Parser      Output Parser
       │                  │                  │
       └──────────────────┴──────────────────┘
                          │
                          ▼
                   DecoderManager
                          │
                          │ DecoderOutput events
                          ▼
                   WebSocket Broadcaster
                          │
                          ▼
                   Connected Clients
```

### Event Flow

```
Decoder Process
       │
       │ stdout line
       ▼
BaseDecoder.parseOutput()
       │
       │ DecoderOutput object
       ▼
DecoderManager
       │
       │ 'decoder:output' event
       ▼
WebSocketEventBroadcaster
       │
       │ JSON message
       ▼
Subscribed WebSocket Clients
```

## Decoder Integration Patterns

WaveKit supports three decoder integration patterns:

### Pattern 1: Pure Consumer

Decoder receives audio via stdin, outputs to stdout.

```
FanoutManager → stdin → [Decoder Process] → stdout → Parser
```

**Examples**: dsd-fme, multimon-ng, rtl_433

**Pros**: Simple, standard Unix pattern
**Cons**: Requires audio format conversion

### Pattern 2: Network Producer

Decoder runs as a service, exposes network output.

```
[Decoder Process] ← WaveKit connects to output port
        ↓
   TCP/UDP output
        ↓
   Parser
```

**Examples**: readsb (SBS/Beast), AIS-catcher (NMEA), direwolf (KISS)

**Pros**: Decoder manages its own input, standard output formats
**Cons**: More complex lifecycle management

### Pattern 3: External SDR Owner

Decoder controls its own SDR hardware.

```
[Decoder Process] ← controls → [RTL-SDR dongle]
        ↓
   stdout/file output
        ↓
   Parser
```

**Examples**: acarsdec, dumpvdl2

**Pros**: Decoder has full tuner control
**Cons**: Requires dedicated SDR dongle per decoder

## Configuration System

Configuration is loaded from YAML files with environment variable overrides.

**Location**: `src/config.ts`

**Loading order**:

1. `config/default.yaml` — Built-in defaults
2. `config/custom.yaml` — User overrides (optional)
3. Environment variables — `WAVEKIT_*` prefix

**Environment variable mapping**:

```
WAVEKIT_API_PORT=9000           → api.port = 9000
WAVEKIT_LOG_LEVEL=debug         → logging.level = "debug"
WAVEKIT_SOURCES_0_HOST=1.2.3.4  → sources[0].host = "1.2.3.4"
```

**Validation**: All configuration is validated with Zod schemas at startup.

## Error Handling

### Custom Error Classes

**Location**: `src/utils/errors.ts`

```typescript
class WaveKitError extends Error {
  constructor(message: string, public code: string, public cause?: Error)
}

class SourceConnectionError extends WaveKitError { }
class DecoderSpawnError extends WaveKitError { }
class ConfigValidationError extends WaveKitError { }
```

### Error Recovery

| Error Type               | Recovery Strategy              |
| ------------------------ | ------------------------------ |
| Source connection failed | Retry with exponential backoff |
| Source connection lost   | Auto-reconnect                 |
| Decoder process crashed  | Auto-restart with backoff      |
| Decoder parse error      | Log warning, skip line         |
| Config validation error  | Fail fast, exit                |

## Logging

Structured JSON logging with Pino.

**Location**: `src/utils/logger.ts`

**Log levels**: trace, debug, info, warn, error

**Component loggers**:

```typescript
const log = createComponentLogger(parentLogger, "SourceManager")
log.info({ sourceId: "rtl-pi" }, "Connected to source")
```

**Output format**:

```json
{
	"level": 30,
	"time": 1704816225123,
	"pid": 1234,
	"hostname": "wavekit",
	"component": "SourceManager",
	"sourceId": "rtl-pi",
	"msg": "Connected to source"
}
```

## Graceful Shutdown

**Location**: `src/utils/graceful-shutdown.ts`

On SIGTERM/SIGINT:

1. Stop accepting new connections
2. Stop all decoders (SIGTERM → wait 5s → SIGKILL)
3. Close all source connections
4. Destroy all streams
5. Exit

Timeout: 10 seconds, then force exit.

## Docker Architecture

### s6-overlay

WaveKit uses s6-overlay as PID 1 for proper process supervision.

**Service dependency graph**:

```
wavekit-init (oneshot)
       │
       ├── sdrpp-server (longrun) ─────┐
       │                               │
       └── wavekit-api (longrun) ──────┤
                                       │
                                       ▼
                                   services (bundle)
```

### Build Targets

| Target        | Contents               | Image Size |
| ------------- | ---------------------- | ---------- |
| `final`       | SDR++ + API + Decoders | ~1.5 GB    |
| `final-core`  | API + Decoders         | ~800 MB    |
| `final-sdrpp` | SDR++ only             | ~450 MB    |

## Testing Strategy

### Unit Tests

- Mock child processes and network sockets
- Test individual components in isolation
- Located in `tests/unit/`

### Property-Based Tests

- Use fast-check for property-based testing
- Verify invariants across random inputs
- Located alongside unit tests

### Integration Tests

- Real processes, mock network
- Test component interactions
- Located in `tests/integration/`

### Test Fixtures

- Sample decoder output for parsing tests
- Located in `tests/mocks/fixtures/`
