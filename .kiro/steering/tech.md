# WaveKit Tech Stack

## Runtime & Language

- Node.js 20+ (see `.nvmrc`)
- TypeScript 5.x with strict mode
- ESM modules (`"type": "module"`)

## Build System

- **Bundler**: esbuild (fast bundling, no transpilation step)
- **Type checking**: tsc (separate from build)
- **Output**: `dist/` directory

## Core Dependencies

| Package            | Purpose                 |
| ------------------ | ----------------------- |
| fastify            | REST API server         |
| @fastify/websocket | Real-time events        |
| @fastify/swagger   | OpenAPI documentation   |
| pino / pino-pretty | Structured JSON logging |
| zod                | Schema validation       |
| yaml               | Config file parsing     |
| dotenv             | Environment variables   |

## Dev Dependencies

| Package             | Purpose                |
| ------------------- | ---------------------- |
| vitest              | Test runner            |
| @vitest/coverage-v8 | Code coverage          |
| fast-check          | Property-based testing |
| eslint              | Linting                |
| prettier            | Code formatting        |

## CLI Dashboard (Ink/React)

The CLI dashboard is a separate package in `cli/`:

| Package | Purpose                |
| ------- | ---------------------- |
| ink     | React for terminal UIs |
| react   | Component framework    |
| meow    | CLI argument parsing   |
| ws      | WebSocket client       |

## Development Workflow

### Default Pipeline (make dev-up)

```bash
make dev-up          # Build core image + start container
make dev-dashboard   # Interactive CLI dashboard
make dev-logs        # Tail logs (pretty JSON)
make dev-stop        # Stop container
```

### Common Commands

```bash
# Development
npm run dev              # Hot reload (local, no Docker)
make dev-up              # Docker: build + start
make dev-dashboard       # Interactive CLI dashboard

# Testing
npm test                 # Single run
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage

# Type checking & linting
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run format           # Prettier

# Building
npm run build-file ./src/index.ts   # Build single file
make docker-build-core              # Build core Docker image
```

### Demod-Test Container (IQ/Audio Debugging)

For debugging IQ samples and audio manipulation:

```bash
# Build and run interactive shell
docker compose -f docker-compose.demod-test.yml build
docker compose -f docker-compose.demod-test.yml run --rm demod-test bash

# Volumes mounted:
#   ./debug_audio:/data/debug_audio   - Raw audio recordings
#   ./scripts:/scripts                 - Conversion scripts
#   ./output:/output                   - Processed output
```

## Code Style

- Tabs for indentation (see `.editorconfig`, `.prettierrc`)
- No semicolons
- Arrow functions without parens for single params
- Type imports: `import type { Foo } from 'bar'`

## TypeScript Configuration

Key strict settings enabled:

- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `useUnknownInCatchVariables`
- `verbatimModuleSyntax`

ESLint enforces:

- `@typescript-eslint/consistent-type-imports`
- `@typescript-eslint/no-floating-promises`
- `@typescript-eslint/no-misused-promises`

## Logging Pattern

Use component loggers via Pino:

```typescript
import { createComponentLogger } from "./utils/logger.js"
const log = createComponentLogger(parentLogger, "ComponentName")

log.info({ data }, "message")
log.error({ err }, "error message")
```

## Error Handling Pattern

Custom error classes in `src/utils/errors.ts`:

```typescript
import { WaveKitError, SourceConnectionError } from "./utils/errors.js"

throw new SourceConnectionError("Connection failed", { host, port })
```

## Configuration Pattern

YAML files validated with Zod schemas:

```typescript
import { configSchema } from "./config.js"

const config = configSchema.parse(rawConfig)
```

Environment overrides with `WAVEKIT_` prefix:

- `WAVEKIT_API_PORT=9000`
- `WAVEKIT_LOG_LEVEL=debug`
- Nested: `WAVEKIT_SOURCES_0_HOST=192.168.1.100`
