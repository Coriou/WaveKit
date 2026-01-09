# WaveKit Project Structure

## Directory Layout

```
wavekit/
├── src/                      # TypeScript source
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Zod schemas + config loading
│   ├── bootstrap.ts             # Environment setup
│   │
│   ├── core/                    # Stream infrastructure
│   │   ├── source-manager.ts       # TCP client for SDR sources
│   │   ├── fanout-manager.ts       # Stream multiplexer
│   │   ├── format-converter.ts     # Audio format transforms
│   │   └── audio-output.ts         # TCP server for audio
│   │
│   ├── decoders/                # Decoder plugin system
│   │   ├── types.ts                # Interfaces
│   │   ├── base-decoder.ts         # Pure consumer base class
│   │   ├── network-producer-decoder.ts
│   │   ├── external-sdr-decoder.ts
│   │   ├── manager.ts              # Lifecycle orchestration
│   │   ├── registry.ts             # Plugin registration
│   │   └── builtin/                # 8 decoder adapters
│   │
│   ├── api/                     # Fastify REST/WebSocket
│   │   ├── server.ts
│   │   ├── routes/
│   │   └── websocket/
│   │
│   └── utils/                   # Shared utilities
│       ├── logger.ts
│       ├── errors.ts
│       └── graceful-shutdown.ts
│
├── cli/                      # CLI Dashboard (Ink/React)
│   └── source/
│       ├── app.tsx              # Main app
│       ├── components/          # UI components
│       └── hooks/               # WebSocket, terminal size
│
├── config/                   # Runtime configuration
│   └── default.yaml
│
├── docker/                   # Docker resources
│   ├── overlay/                 # s6-overlay services
│   └── scripts/
│
├── tests/                    # Test suites
│   ├── unit/
│   ├── integration/
│   └── mocks/fixtures/
│
└── docs/                     # Documentation
```

## Key Patterns

### Decoder Integration

Three patterns for decoder integration:

1. **Pure Consumer** - Receives audio via stdin (dsd-fme, multimon-ng)
2. **Network Producer** - Runs as service with network output (readsb, AIS-catcher)
3. **External SDR** - Controls own SDR hardware (acarsdec, dumpvdl2)

### Stream Flow

```
SourceManager → FanoutManager → [Decoders] → DecoderManager → WebSocket
                                          → AudioOutput
```

### Error Handling

Custom error classes in `src/utils/errors.ts`:

- `WaveKitError` - Base class
- `SourceConnectionError` - TCP failures
- `DecoderSpawnError` - Process spawn failures
- `ConfigValidationError` - Zod validation errors

### Logging

Component loggers via Pino:

```typescript
import { createComponentLogger } from "./utils/logger.js"
const log = createComponentLogger(parentLogger, "ComponentName")
```

### Configuration

- YAML files in `config/` directory
- Environment variables with `WAVEKIT_` prefix override config
- Nested keys: `WAVEKIT_API__PORT` → `api.port`
- Validated with Zod schemas at startup
