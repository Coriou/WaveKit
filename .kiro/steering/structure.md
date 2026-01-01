# WaveKit Project Structure

```
wavekit/
├── src/
│   ├── index.ts              # Entry point
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
│       └── graceful-shutdown.ts # SIGTERM handling
│
├── config/                   # Runtime configuration files
├── tests/
│   ├── unit/                 # Unit tests (mirrors src/ structure)
│   ├── integration/          # Integration tests
│   └── mocks/fixtures/       # Test fixtures
│
├── docs/
│   ├── SPECIFICATION.md      # Full system specification
│   └── DOCKER.md             # Docker deployment docs
│
└── dist/                     # Build output (gitignored)
```

## Architecture Patterns

### Decoder Plugin System

1. All decoders implement the `Decoder` interface from `types.ts`
2. Extend `BaseDecoder` for common functionality
3. Register in `DecoderRegistry` with a factory function
4. `DecoderManager` handles lifecycle (start/stop/restart)

### Stream Flow

```
SourceManager → FanoutManager → [Decoder1, Decoder2, ...] → API/WebSocket
```

### Error Handling

Custom error classes in `src/utils/errors.ts`:

- `WaveKitError` - Base class with error codes
- `SourceConnectionError` - TCP connection failures
- `DecoderSpawnError` - Process spawn failures
- `ConfigValidationError` - Zod validation errors

### Logging Convention

Use component loggers:

```typescript
import { createComponentLogger } from "./utils/logger"
const log = createComponentLogger(parentLogger, "ComponentName")
```
