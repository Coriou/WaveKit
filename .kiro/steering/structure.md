# WaveKit Project Structure

```
wavekit/
├── src/
│   ├── index.ts              # Entry point - wires all components
│   ├── bootstrap.ts          # Environment setup (dotenv)
│   ├── config.ts             # Zod schemas + YAML config loading
│   │
│   ├── core/                 # Core streaming infrastructure
│   │   ├── source-manager.ts    # TCP client for SDR sources
│   │   ├── fanout-manager.ts    # Stream multiplexer
│   │   ├── format-converter.ts  # Audio format transforms (F32↔S16)
│   │   └── audio-output.ts      # TCP server for audio out
│   │
│   ├── decoders/             # Decoder plugin system
│   │   ├── types.ts             # Decoder interfaces
│   │   ├── base-decoder.ts      # Abstract base class
│   │   ├── manager.ts           # Lifecycle orchestration
│   │   ├── registry.ts          # Plugin registration
│   │   └── builtin/             # Built-in decoder adapters
│   │       ├── dsd-fme.ts
│   │       ├── multimon-ng.ts
│   │       └── rtl433.ts
│   │
│   ├── api/                  # Fastify REST/WebSocket API
│   │   ├── server.ts            # Fastify setup
│   │   ├── routes/              # Route handlers
│   │   └── websocket/
│   │       └── events.ts        # Real-time event broadcasting
│   │
│   └── utils/                # Shared utilities
│       ├── logger.ts            # Pino structured logging
│       ├── errors.ts            # Custom error classes
│       ├── health-check.ts      # Health monitoring
│       ├── version.ts           # Decoder version validation
│       └── graceful-shutdown.ts # SIGTERM handling
│
├── config/                   # Runtime configuration files
│   ├── default.yaml             # Base configuration
│   └── custom.yaml              # User overrides (optional)
│
├── tests/
│   ├── unit/                 # Unit tests (mirrors src/ structure)
│   ├── integration/          # Integration tests
│   └── mocks/fixtures/       # Test fixtures
│
├── docker/                   # Docker build resources
│   ├── overlay/                 # s6-overlay service definitions
│   └── scripts/                 # Container scripts
│
└── dist/                     # Build output (gitignored)
```

## Architecture Patterns

### Decoder Plugin System

1. All decoders implement the `Decoder` interface from `types.ts`
2. Extend `BaseDecoder` for common functionality (process spawning, output parsing)
3. Register in `DecoderRegistry` with a factory function and capabilities
4. `DecoderManager` handles lifecycle (start/stop/restart with exponential backoff)

### Stream Flow

```
SourceManager → FanoutManager → [Decoder1, Decoder2, ...] → API/WebSocket
                                                         → AudioOutput
```

### Error Handling

Custom error classes in `src/utils/errors.ts`:

- `WaveKitError` - Base class with error codes
- `SourceConnectionError` - TCP connection failures
- `DecoderSpawnError` - Process spawn failures
- `ConfigValidationError` - Zod validation errors
- `DecoderVersionError` - Version constraint failures

### Logging Convention

Use component loggers:

```typescript
import { createComponentLogger } from "./utils/logger.js"
const log = createComponentLogger(parentLogger, "ComponentName")
```

### Configuration

- YAML files in `config/` directory (default.yaml, custom.yaml)
- Environment variables with `WAVEKIT_` prefix override config
- Nested keys use double underscore: `WAVEKIT_API__PORT`
- Validated with Zod schemas at startup
