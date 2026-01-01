# Agent Instructions

Guidelines for AI agents working in this repository.

## Spec-Driven Development

This project uses Kiro specs for feature development. Specs live in `.kiro/specs/<feature-name>/` with three files:

| File              | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `requirements.md` | User stories and acceptance criteria                          |
| `design.md`       | Architecture, interfaces, data models, correctness properties |
| `tasks.md`        | Implementation checklist with requirement traceability        |

### Working with Tasks

1. Read `tasks.md` to understand current progress (checked items are complete)
2. Work through tasks in order - they're sequenced for dependency management
3. After completing a task, mark it done: `- [x] Task description`
4. Stop at checkpoint tasks and verify tests pass before continuing
5. Reference requirement numbers in commits/comments for traceability

### Task Format

```markdown
- [ ] 4.5 Implement Source Manager
  - Create TCP client with auto-reconnect and exponential backoff
  - Implement status tracking and metrics emission
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
```

Tasks may include:

- Sub-bullets with implementation details
- `_Requirements: X.Y_` linking to acceptance criteria
- `**Property N: Name**` referencing design document properties

### Property-Based Tests

Design documents define correctness properties that must be validated:

```typescript
// Feature: wavekit-core, Property 7: Format Conversion Round-Trip
// Validates: Requirements 3.1, 3.2
it("should round-trip S16 values within ±1", () => {
	fc.assert(
		fc.property(fc.integer({ min: -32768, max: 32767 }), s16Value => {
			const f32 = s16ToF32(s16Value)
			const roundTrip = f32ToS16(f32)
			return Math.abs(roundTrip - s16Value) <= 1
		}),
		{ numRuns: 100 },
	)
})
```

Always include the property reference comment when implementing property tests.

## Code Standards

### TypeScript

- Strict mode enabled - no `any` types
- Use `import type` for type-only imports
- Handle all error cases explicitly
- Use Zod for runtime validation of external data

### Formatting

- Tabs for indentation
- No semicolons
- Single quotes for strings (via Prettier)

### Error Handling

Use custom error classes from `src/utils/errors.ts`:

```typescript
import { SourceConnectionError } from "./utils/errors"
throw new SourceConnectionError(host, port, cause)
```

### Logging

Use component loggers, never `console.log`:

```typescript
import { createComponentLogger } from "./utils/logger"
const log = createComponentLogger(parentLogger, "SourceManager")
log.info({ host, port }, "Connected to source")
```

### Streams

- Always attach error handlers to streams
- Use `pipeline()` from `stream/promises` for piping
- Clean up streams on shutdown with `.destroy()`

## Testing

- Run `npm test` before marking tasks complete
- Property tests require minimum 100 iterations
- Mock child processes and network for unit tests
- Use fixtures in `tests/mocks/fixtures/` for decoder output samples

## File References in Specs

Specs can reference other files using `#[[file:<path>]]` syntax. When you see this, read the referenced file for additional context.
