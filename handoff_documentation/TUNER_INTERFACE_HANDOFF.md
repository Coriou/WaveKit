# TUNER_INTERFACE_HANDOFF.md

<!-- AI Agent Handoff Document - Optimized for Implementation -->

## Quick Start

**Objective:** Implement a state-of-the-art tuner interface for WaveKit that provides direct RTL-SDR control via RTL-TCP protocol.

**Scope:**

- `TunerController` class in `src/core/`
- REST API endpoints in `src/api/routes/tuner.ts`
- WebSocket events for real-time updates
- CLI dashboard tab (Ink/React) in `cli/source/components/`
- Shared types in `packages/api-types/`

**NOT in scope:** sdr-host integration, SoapySDR, direct USB control, frequency presets (plan architecture only)

---

## Architecture Decision

**Chosen:** Option A2 — `TunerController` in core WaveKit sends RTL-TCP binary commands through `SourceManager.writeToSource()`.

**Rationale:**

- Works with any rtl_tcp/rtlmux source
- Non-invasive (commands override defaults, just like SDR++)
- Follows existing patterns in codebase

---

## Key Files to Study Before Implementation

```
src/core/tuner-relay.ts        # RTL-TCP command parsing (COMMAND_NAMES map, encodeCommand pattern)
src/core/source-manager.ts     # writeToSource() method, multi-source Map pattern
src/core/fanout-manager.ts     # BranchConfig.sourceId pattern for multi-source
src/decoders/manager.ts        # Map-based state management pattern
src/api/routes/live-audio.ts   # Route pattern with Zod validation
src/api/websocket/events.ts    # WebSocket broadcast pattern
cli/source/app.tsx             # Tab navigation, keyboard handling, API calls
cli/source/components/live-audio-panel.tsx  # Component pattern
packages/api-types/src/index.ts # Shared type exports
```

---

## RTL-TCP Command Reference

All commands are 5 bytes: `[cmd: u8][value: u32be]`

```typescript
const RTL_TCP_COMMANDS = {
	SET_FREQUENCY: 0x01, // Hz (24MHz - 1.9GHz)
	SET_SAMPLE_RATE: 0x02, // Hz
	SET_GAIN_MODE: 0x03, // 0=AGC, 1=manual
	SET_GAIN: 0x04, // 0.1 dB units (400 = 40.0 dB)
	SET_FREQ_CORRECTION: 0x05, // PPM
	SET_IF_GAIN: 0x06, // IF stage gain
	SET_TEST_MODE: 0x07, // Test mode
	SET_AGC_MODE: 0x08, // RTL2832 AGC
	SET_DIRECT_SAMPLING: 0x09, // 0=off, 1=I, 2=Q
	SET_OFFSET_TUNING: 0x0a, // Offset tuning
	SET_RTL_XTAL: 0x0b, // RTL XTAL freq
	SET_TUNER_XTAL: 0x0c, // Tuner XTAL freq
	SET_TUNER_GAIN_INDEX: 0x0d, // Gain by index
	SET_BIAS_TEE: 0x0e, // 0=off, 1=on
	SET_TUNER_IF_GAIN: 0x0f, // stage<<16 | gain
} as const
```

**Encoding:**

```typescript
function encodeCommand(cmd: number, value: number): Buffer {
	const buf = Buffer.alloc(5)
	buf.writeUInt8(cmd, 0)
	buf.writeUInt32BE(value >>> 0, 1)
	return buf
}
```

---

## Implementation Phases

### Phase 1: TunerController Core

**Create:** `src/core/tuner-controller.ts`

```typescript
interface TunerState {
	sourceId: string
	frequency: number // Hz
	sampleRate: number // Hz
	gainMode: "manual" | "agc"
	gain: number // 0.1 dB
	ppm: number
	agcMode: boolean
	biasTee: boolean
	directSampling: "off" | "i" | "q"
	offsetTuning: boolean
	ifGain: number
	tunerIfGain: { stage: number; gain: number } | null
	lastCommandAt?: string
	lastError?: string
	commandCount: number
}

class TunerController extends EventEmitter {
	private tunerStates: Map<string, TunerState> = new Map()

	// Per-source methods following existing patterns
	async setFrequency(sourceId: string, hz: number): Promise<void>
	async setGain(sourceId: string, tenthsDb: number): Promise<void>
	// ... all commands

	getState(sourceId: string): TunerState | undefined
	getAllStates(): Map<string, TunerState>
}
```

**Events:**

- `'state-changed'` — `(sourceId, state)`
- `'command-sent'` — `(sourceId, command, value)`
- `'error'` — `(sourceId, error)`

**Modify:** `src/config.ts` — Add `TunerConfigSchema`

---

### Phase 2: API Routes

**Create:** `src/api/routes/tuner.ts`

| Method | Endpoint                               | Body                            |
| ------ | -------------------------------------- | ------------------------------- |
| GET    | `/api/tuner`                           | —                               |
| GET    | `/api/tuner/:sourceId`                 | —                               |
| POST   | `/api/tuner/:sourceId/frequency`       | `{ hz: number }`                |
| POST   | `/api/tuner/:sourceId/gain`            | `{ tenthsDb: number }`          |
| POST   | `/api/tuner/:sourceId/gain-mode`       | `{ mode: 'manual' \| 'agc' }`   |
| POST   | `/api/tuner/:sourceId/ppm`             | `{ ppm: number }`               |
| POST   | `/api/tuner/:sourceId/agc`             | `{ enabled: boolean }`          |
| POST   | `/api/tuner/:sourceId/bias-tee`        | `{ enabled: boolean }`          |
| POST   | `/api/tuner/:sourceId/sample-rate`     | `{ hz: number }`                |
| POST   | `/api/tuner/:sourceId/direct-sampling` | `{ mode: 'off' \| 'i' \| 'q' }` |
| PATCH  | `/api/tuner/:sourceId/config`          | `Partial<TunerState>`           |

**Modify:** `src/api/server.ts` — Add TunerController to deps, register routes
**Modify:** `src/api/websocket/events.ts` — Add `tuner` channel

---

### Phase 3: Shared Types

**Modify:** `packages/api-types/src/index.ts`

Export `TunerState`, `TunerStateResponse`, `TunerCommandRequest`

---

### Phase 4: CLI Dashboard

**Create:** `cli/source/components/tuner-panel.tsx`

```tsx
// Keyboard controls:
// ↑/↓ — Tune frequency by step
// +/- — Adjust gain ±1 dB
// [ / ] — Change step (1k, 10k, 100k, 1M)
// Tab — Cycle sources
// g — Toggle gain mode
// b — Toggle bias-tee
// a — Toggle AGC
```

**Modify:** `cli/source/app.tsx`

- Add tab 7: "Tuner"
- Subscribe to `tuner` WS channel
- Add `tunerStates` to AppState
- Handle keyboard input

---

### Phase 5: Integration

**Modify:** `src/index.ts`

```typescript
const tunerController = new TunerController(logger, sourceManager, config.tuner)

sourceManager.on("connected", sourceId => {
	if (sourceManager.isRtlTcpSource(sourceId)) {
		tunerController.initializeSource(sourceId)
	}
})

sourceManager.on("disconnected", sourceId => {
	tunerController.removeSource(sourceId)
})

tunerController.on("state-changed", (sourceId, state) => {
	wsBroadcaster.broadcast("tuner", {
		type: "tuner:state-changed",
		data: { sourceId, state },
	})
})
```

---

## Multi-Source Pattern

Follow existing Map-based state management:

```typescript
// Like SourceManager.sources, DecoderManager.decoders
private tunerStates: Map<string, TunerState> = new Map()

// Like DecoderConfig.sourceId
interface TunerCommand { sourceId: string; ... }

// Validation pattern
private validateSource(sourceId: string): void {
  if (!this.sourceManager.getStatus(sourceId)) {
    throw new Error(`Source not found: ${sourceId}`)
  }
  if (!this.sourceManager.isRtlTcpSource(sourceId)) {
    throw new Error(`Source ${sourceId} does not support RTL-TCP control`)
  }
}
```

---

## Validation Rules

| Parameter  | Min        | Max           | Notes                        |
| ---------- | ---------- | ------------- | ---------------------------- |
| frequency  | 24,000,000 | 1,900,000,000 | Hz                           |
| sampleRate | 225,001    | 3,200,000     | Hz, some tuners support less |
| gain       | 0          | 500           | 0.1 dB (0-50 dB)             |
| ppm        | -500       | 500           | Typical range                |

---

## Testing

**Unit tests:** `tests/unit/core/tuner-controller.test.ts`

- Command encoding for all 15 commands
- State management per source
- Validation (frequency range, gain values)
- Event emission

**Unit tests:** `tests/unit/api/tuner-routes.test.ts`

- All endpoints with valid/invalid inputs
- Error responses (400, 404, 409)

**Integration test:**

```bash
# Start rtl_tcp
rtl_tcp -a 127.0.0.1 -p 1234

# Test API
curl -X POST http://localhost:9000/api/tuner/rtl-pi/frequency \
  -H 'Content-Type: application/json' -d '{"hz": 144800000}'
```

---

## Quality Standards

1. **TypeScript strict mode** — No `any`, proper error types
2. **Zod validation** — All API inputs validated
3. **Event-driven** — Emit events for all state changes
4. **Error isolation** — Errors in one source don't affect others
5. **Logging** — Use `createComponentLogger` pattern
6. **Tests** — Unit tests for core + routes before merging

---

## Files to Create

```
src/core/tuner-controller.ts           # ~300 lines
src/api/routes/tuner.ts                # ~200 lines
cli/source/components/tuner-panel.tsx  # ~250 lines
tests/unit/core/tuner-controller.test.ts
tests/unit/api/tuner-routes.test.ts
```

## Files to Modify

```
src/config.ts                          # Add TunerConfigSchema
src/index.ts                           # Wire TunerController
src/api/server.ts                      # Register routes
src/api/websocket/events.ts            # Add tuner channel
src/core/source-manager.ts             # Add isRtlTcpSource()
cli/source/app.tsx                     # Add tab + state
cli/source/types.ts                    # Import TunerState
packages/api-types/src/index.ts        # Export types
```

---

## Estimated Effort

| Phase                    | Effort        |
| ------------------------ | ------------- |
| Phase 1: TunerController | 2-3 days      |
| Phase 2: API Routes      | 1-2 days      |
| Phase 3: Shared Types    | 0.5 days      |
| Phase 4: CLI Dashboard   | 2-3 days      |
| Phase 5: Integration     | 0.5 days      |
| Testing                  | 1-2 days      |
| **Total**                | **8-12 days** |

---

## Success Criteria

- [ ] All 15 RTL-TCP commands implemented and tested
- [ ] Per-source state management working
- [ ] API endpoints respond with correct status codes
- [ ] WebSocket broadcasts state changes
- [ ] CLI tuner tab with keyboard controls
- [ ] Works with rtl_tcp and rtlmux sources
- [ ] Passes `pnpm ws:typecheck` and `pnpm ws:lint`
- [ ] All new unit tests pass
