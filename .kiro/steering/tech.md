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

## Common Commands

```bash
# Development (hot reload)
npm run dev

# Build
npm run build-file ./src/index.ts

# Run
npm start

# Type checking
npm run typecheck

# Linting
npm run lint

# Formatting
npm run format

# Tests
npm test              # Single run
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
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

Path alias: `@/*` maps to project root
