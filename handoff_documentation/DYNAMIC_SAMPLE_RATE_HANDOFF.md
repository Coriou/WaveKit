# Dynamic Sample Rate Handling - Implementation Handoff

<!-- AI Agent Handoff Document - Optimized for Implementation -->

## Quick Summary

**Objective**: Implement best-effort auto-handling of IQ sample rate changes via the TunerRelay. When a user changes sample rate in SDR++ (or any RTL-TCP client connected to WaveKit's tuner relay), the pipeline should automatically adapt.

**Key Constraint**: This feature only works for sources connected via the TunerRelay — document this clearly.

**Estimated Effort**: ~4 days

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    DYNAMIC SAMPLE RATE EVENT FLOW                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  [SDR++] ─────► [TunerRelay] ─────► [SourceManager] ─────► [Consumers]           │
│                      │                    │                     │                │
│              1. Intercept                2. Update        3. React to change     │
│                 cmd 0x02              caps.sampleRate                            │
│              emit event                emit event          - LiveDemodulator     │
│                                                            - DecoderManager      │
│                                                            - WebSocket broadcast │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Files to Study Before Implementation

```
src/core/tuner-relay.ts        # updateCommandState() method, COMMAND_NAMES map
src/core/source-manager.ts     # getCaps(), sources Map, event emission pattern
src/core/live-demodulator.ts   # calculateRates(), reconfigure(), startPipeline()
src/decoders/manager.ts        # restartDecoder(), health system
src/api/websocket/events.ts    # WebSocket broadcast pattern
src/index.ts                   # Event wiring between components
```

---

## Implementation Steps

### Step 1: TunerRelay Event Emission

**File**: `src/core/tuner-relay.ts`

Add a new event to the `TunerRelayEvents` interface and emit it when sample rate command (0x02) is received:

```typescript
// Add to TunerRelayEvents interface (around line 84)
export interface TunerRelayEvents {
  'client-connected': (clientId: string) => void
  'client-disconnected': (clientId: string) => void
  'control-changed': (clientId: string | null) => void
  'sample-rate-changed': (sourceId: string, sampleRate: number) => void  // NEW
  started: (port: number) => void
  stopped: () => void
  error: (error: Error) => void
}

// Modify updateCommandState() method (around line 496)
private updateCommandState(
  cmd: number,
  value: number,
  client: ClientState,
): void {
  const name = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
  const now = new Date().toISOString()
  this.lastCommand = name
  this.lastCommandAt = now
  this.lastCommandValue = value
  this.recordCommandStats(cmd, name, value, now)
  this.recordCommandHistory(cmd, name, value, now, client)

  switch (cmd) {
    case 0x01:
      this.lastFrequency = value
      break
    case 0x02:
      this.lastSampleRate = value
      // NEW: Emit sample rate changed event
      if (this.config.sourceId) {
        this.emit('sample-rate-changed', this.config.sourceId, value)
        this.log.info(
          { sourceId: this.config.sourceId, sampleRate: value },
          'Sample rate changed via tuner relay'
        )
      }
      break
    case 0x04:
      this.lastGain = value
      break
    case 0x05:
      this.lastPpm = value
      break
    default:
      break
  }
}
```

---

### Step 2: SourceManager Caps Update Method and Event

**File**: `src/core/source-manager.ts`

Add a new method to update source capabilities and emit an event:

```typescript
// Add to SourceManagerEvents interface (around line 95)
export interface SourceManagerEvents {
  connected: (sourceId: string) => void
  disconnected: (sourceId: string, error?: Error) => void
  error: (sourceId: string, error: Error) => void
  data: (sourceId: string, chunk: Buffer) => void
  metrics: (
    sourceId: string,
    metrics: { bytesReceived: number; dataRate: number },
  ) => void
  bytesReceived: number
  dataRate: number
  ended: (sourceId: string) => void
  'caps-changed': (sourceId: string, caps: SourceCaps) => void  // NEW
}

// Add new public method to SourceManager class
/**
 * Updates the capabilities of a source dynamically.
 * Used when external events (e.g., TunerRelay commands) change source parameters.
 *
 * @param id - Source ID to update
 * @param updates - Partial caps to merge with existing
 */
updateSourceCaps(id: string, updates: Partial<SourceCaps>): void {
  const state = this.sources.get(id)
  if (!state) {
    this.log.warn({ sourceId: id }, 'Cannot update caps: source not found')
    return
  }

  const oldCaps = { ...state.config.caps }
  state.config.caps = { ...state.config.caps, ...updates }

  this.log.info(
    {
      sourceId: id,
      oldSampleRate: oldCaps.sampleRate,
      newSampleRate: state.config.caps.sampleRate
    },
    'Source caps updated'
  )

  this.emit('caps-changed', id, state.config.caps)
}
```

---

### Step 3: Wire Events in Main Entry Point

**File**: `src/index.ts`

Wire the TunerRelay sample-rate-changed event to SourceManager:

```typescript
// Add after tunerRelay initialization (around where tunerRelay is created)
// Wire sample rate changes from tuner relay to source manager
if (tunerRelay) {
	tunerRelay.on("sample-rate-changed", (sourceId, sampleRate) => {
		log.info(
			{ sourceId, sampleRate },
			"Propagating sample rate change from tuner relay",
		)
		sourceManager.updateSourceCaps(sourceId, { sampleRate })
	})
}
```

---

### Step 4: LiveDemodulator Listener

**File**: `src/core/live-demodulator.ts`

Add a listener for caps-changed events and restart the pipeline when sample rate changes:

```typescript
// Add new private field and method to LiveDemodulator class
private capsChangedHandler: ((sourceId: string, caps: SourceCaps) => void) | null = null

/**
 * Subscribes to source caps changes and restarts pipeline when needed.
 * Call this after the demodulator is started.
 */
subscribeToSourceCapsChanges(): void {
  if (this.capsChangedHandler) return  // Already subscribed

  this.capsChangedHandler = async (sourceId: string, caps: SourceCaps) => {
    // Only react if this is our active source
    if (sourceId !== this.activeSourceId) return

    this.log.info(
      { sourceId, newSampleRate: caps.sampleRate },
      'Source caps changed, restarting pipeline with new sample rate'
    )

    try {
      // Reconfigure triggers stop + start of pipeline with new rates
      await this.reconfigure({})
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.log.error({ err: error }, 'Failed to restart pipeline after sample rate change')
      this.lastError = error.message
      this.pipelineHealth = 'error'
      this.emit('error', error)
    }
  }

  this.sourceManager.on('caps-changed', this.capsChangedHandler)
}

/**
 * Unsubscribes from source caps changes.
 * Call this when stopping the demodulator.
 */
unsubscribeFromSourceCapsChanges(): void {
  if (this.capsChangedHandler) {
    this.sourceManager.off('caps-changed', this.capsChangedHandler)
    this.capsChangedHandler = null
  }
}

// Modify start() method to subscribe to caps changes
async start(): Promise<void> {
  // ... existing start logic ...

  // At the end, after emit('started'):
  this.subscribeToSourceCapsChanges()
}

// Modify stop() method to unsubscribe
async stop(): Promise<void> {
  this.unsubscribeFromSourceCapsChanges()
  // ... existing stop logic ...
}
```

---

### Step 5: DecoderManager Integration

**File**: `src/decoders/manager.ts`

Add listener for caps changes to restart affected decoders:

```typescript
// Add new private field
private capsChangedHandler: ((sourceId: string, caps: SourceCaps) => void) | null = null
private sourceManager: SourceManager | null = null

// Add method to initialize source manager reference
setSourceManager(sourceManager: SourceManager): void {
  this.sourceManager = sourceManager
  this.subscribeToSourceCapsChanges()
}

/**
 * Subscribes to source caps changes and restarts affected decoders.
 */
private subscribeToSourceCapsChanges(): void {
  if (!this.sourceManager || this.capsChangedHandler) return

  this.capsChangedHandler = async (sourceId: string, caps: SourceCaps) => {
    const affectedDecoders: string[] = []

    // Find all decoders using this source
    for (const [decoderId, state] of this.decoders) {
      if (state.config.sourceId === sourceId && state.decoder.getStatus() === 'running') {
        affectedDecoders.push(decoderId)
      }
    }

    if (affectedDecoders.length === 0) return

    this.log.info(
      {
        sourceId,
        newSampleRate: caps.sampleRate,
        affectedDecoders
      },
      'Source caps changed, restarting affected decoders'
    )

    // Restart each affected decoder
    for (const decoderId of affectedDecoders) {
      try {
        await this.restartDecoder(decoderId)
      } catch (err) {
        this.log.error(
          { decoderId, err },
          'Failed to restart decoder after sample rate change'
        )
      }
    }

    // Add health warnings for suboptimal sample rates
    for (const decoderId of affectedDecoders) {
      const state = this.decoders.get(decoderId)
      if (!state) continue

      const decoderCaps = state.decoder.getCaps?.()
      if (decoderCaps?.preferredSampleRates?.length) {
        const preferred = decoderCaps.preferredSampleRates
        const current = caps.sampleRate
        if (!preferred.includes(current)) {
          this.log.warn(
            {
              decoderId,
              currentSampleRate: current,
              preferredRates: preferred
            },
            'Decoder running with suboptimal sample rate'
          )
          // Could emit a health warning event here
        }
      }
    }
  }

  this.sourceManager.on('caps-changed', this.capsChangedHandler)
}

// Add cleanup in shutdown
private unsubscribeFromSourceCapsChanges(): void {
  if (this.capsChangedHandler && this.sourceManager) {
    this.sourceManager.off('caps-changed', this.capsChangedHandler)
    this.capsChangedHandler = null
  }
}
```

---

### Step 6: WebSocket Broadcast

**File**: `src/api/websocket/events.ts`

Add WebSocket event for caps changes (wire in `src/index.ts`):

```typescript
// In src/index.ts, wire up WebSocket broadcast
sourceManager.on("caps-changed", (sourceId, caps) => {
	wsBroadcaster.broadcast("source", {
		type: "source:caps-changed",
		data: { sourceId, caps },
	})
})
```

---

### Step 7: Update Shared Types (Optional but recommended)

**File**: `packages/api-types/src/index.ts`

Export types for the new events:

```typescript
export interface SourceCapsChangedEvent {
	type: "source:caps-changed"
	data: {
		sourceId: string
		caps: SourceCaps
	}
}
```

---

## Key Design Decisions

| Decision              | Rationale                                                                   |
| --------------------- | --------------------------------------------------------------------------- |
| **No blocking**       | Never prevent sample rate changes — user experience in SDR++ takes priority |
| **Best effort**       | Decoders continue trying even with suboptimal rates                         |
| **Warnings only**     | Add health warnings for suboptimal rates, don't fail                        |
| **Brief restart gap** | Acceptable audio glitch during pipeline restart (~100-500ms)                |
| **Event-driven**      | Use existing event pattern, not polling                                     |

---

## Existing Infrastructure to Use

| Component         | Existing Method                    | Purpose                                    |
| ----------------- | ---------------------------------- | ------------------------------------------ |
| `DecoderManager`  | `restartDecoder(id)`               | Graceful decoder restart with backoff      |
| `DecoderManager`  | `decoder:restarting` event         | UI feedback during restart                 |
| `DecoderManager`  | Health system                      | Warning states for degraded operation      |
| `LiveDemodulator` | `reconfigure(config)`              | Restart pipeline with new config           |
| `LiveDemodulator` | `calculateRates(sourceId, config)` | Math already handles variable sample rates |

---

## Files Summary

### Files to Modify

| File                           | Changes                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `src/core/tuner-relay.ts`      | Emit `sample-rate-changed` event in `updateCommandState()` |
| `src/core/source-manager.ts`   | Add `updateSourceCaps()` method, add `caps-changed` event  |
| `src/core/live-demodulator.ts` | Subscribe to `caps-changed`, restart pipeline on change    |
| `src/decoders/manager.ts`      | Subscribe to `caps-changed`, restart affected decoders     |
| `src/index.ts`                 | Wire TunerRelay → SourceManager event, WebSocket broadcast |
| `src/api/websocket/events.ts`  | Document new `source:caps-changed` event type              |

### Files to Create (Optional)

| File                                          | Purpose                          |
| --------------------------------------------- | -------------------------------- |
| `tests/unit/core/dynamic-sample-rate.test.ts` | Unit tests for event propagation |

---

## Testing Plan

### Unit Tests

Create `tests/unit/core/dynamic-sample-rate.test.ts`:

```typescript
describe("Dynamic Sample Rate", () => {
	describe("TunerRelay", () => {
		it("emits sample-rate-changed when cmd 0x02 received", async () => {
			// Mock setup, send command, verify event emission
		})

		it("includes sourceId in event", async () => {
			// Verify sourceId is passed correctly
		})
	})

	describe("SourceManager", () => {
		it("updates caps when updateSourceCaps called", () => {
			// Verify caps are merged correctly
		})

		it("emits caps-changed event", () => {
			// Verify event is emitted with correct payload
		})
	})

	describe("LiveDemodulator integration", () => {
		it("restarts pipeline when source caps change", async () => {
			// Mock sourceManager, emit caps-changed, verify restart
		})
	})
})
```

### Integration Testing (Manual)

1. Start WaveKit with a tuner relay source
2. Connect SDR++ to tuner relay port
3. Start multimon-ng decoder on the tuner relay source
4. Change sample rate in SDR++ device settings
5. Verify:
   - [ ] Decoder restarts automatically (check logs)
   - [ ] Live demodulator restarts (check `/api/live-audio` status)
   - [ ] WebSocket clients receive `source:caps-changed` event
   - [ ] Brief audio glitch (<1s) is acceptable

### CLI Dashboard Testing

If using the CLI dashboard:

- Verify source status updates reflect new sample rate
- Verify decoder status shows restart/restarting state

---

## Documentation Updates

After implementation, update these files:

1. **`docs/ARCHITECTURE.md`** — Add sample rate propagation flow diagram
2. **`readme.md`** — Note that dynamic sample rate only works with tuner relay sources
3. **API documentation** — Document the new `source:caps-changed` WebSocket event

---

## Edge Cases to Handle

| Edge Case                                 | Handling                                                 |
| ----------------------------------------- | -------------------------------------------------------- |
| Sample rate change during decoder restart | Debounce: ignore if already restarting                   |
| No sourceId configured on TunerRelay      | Skip event emission, log warning                         |
| Source disconnected during rate change    | Event still emits; consumers should check source status  |
| Very rapid rate changes                   | LiveDemodulator.reconfigure() should debounce internally |
| Invalid sample rate value                 | Log warning, let RTL-TCP reject upstream                 |

---

## Integration with TunerController (Future)

> [!NOTE]
> If implementing after `TUNER_INTERFACE_HANDOFF.md`, the TunerController should also call `sourceManager.updateSourceCaps()` when `POST /api/tuner/:sourceId/sample-rate` is called. This ensures the same event flow works regardless of whether the rate was changed via SDR++ or the API.

```typescript
// In TunerController.setSampleRate()
async setSampleRate(sourceId: string, hz: number): Promise<void> {
  // ... send command to rtl_tcp ...

  // Update source caps so consumers can react
  this.sourceManager.updateSourceCaps(sourceId, { sampleRate: hz })
}
```

---

## Success Criteria

- [ ] TunerRelay emits `sample-rate-changed` on cmd 0x02
- [ ] SourceManager has `updateSourceCaps()` method
- [ ] SourceManager emits `caps-changed` event
- [ ] LiveDemodulator restarts pipeline on caps change
- [ ] DecoderManager restarts affected decoders on caps change
- [ ] WebSocket broadcasts `source:caps-changed`
- [ ] Unit tests pass
- [ ] Manual integration test passes
- [ ] Documentation updated
