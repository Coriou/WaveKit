# Dynamic Sample Rate Handling - Implementation Handoff

## Quick Summary

**Objective**: Implement best-effort auto-handling of IQ sample rate changes via the TunerRelay. When a user changes sample rate in SDR++ (or any RTL-TCP client connected to WaveKit's tuner relay), the pipeline should automatically adapt.

**Key Constraint**: This only works for sources connected via the TunerRelay - document this clearly.

---

## Architecture

```
SDR++ ──► TunerRelay ──► SourceManager ──► LiveDemodulator (restart)
                                      └──► DecoderManager (restart decoders)
```

---

## Implementation Steps

### Step 1: TunerRelay Event Emission

**File**: `src/core/tuner-relay.ts`

```typescript
// Add to TunerRelayEvents interface
'sample-rate-changed': (sourceId: string, sampleRate: number) => void

// In updateCommandState(), case 0x02:
case 0x02:
  this.lastSampleRate = value
  if (this.config.sourceId) {
    this.emit('sample-rate-changed', this.config.sourceId, value)
  }
  break
```

---

### Step 2: SourceManager Caps Update

**File**: `src/core/source-manager.ts`

```typescript
// Add to SourceManagerEvents interface
'caps-changed': (sourceId: string, caps: SourceCaps) => void

// New method
updateSourceCaps(id: string, updates: Partial<SourceCaps>): void {
  const state = this.sources.get(id)
  if (!state) return
  
  state.config.caps = { ...state.config.caps, ...updates }
  this.emit('caps-changed', id, state.config.caps)
}
```

---

### Step 3: Wire Events in Main

**File**: `src/index.ts`

```typescript
tunerRelay.on('sample-rate-changed', (sourceId, sampleRate) => {
  sourceManager.updateSourceCaps(sourceId, { sampleRate })
})
```

---

### Step 4: LiveDemodulator Listener

**File**: `src/core/live-demodulator.ts`

Listen for caps changes and restart pipeline with new decimation math.

---

### Step 5: DecoderManager Integration

**File**: `src/decoders/manager.ts`

- Listen for caps changes
- For affected decoders: call `restartDecoder(id)` (already exists!)
- Add health warning if sample rate is suboptimal for decoder

---

## Key Design Decisions

1. **No blocking** - Never prevent sample rate changes
2. **Best effort** - Decoders continue trying even with wrong rates
3. **Warnings only** - Add health warnings for suboptimal rates
4. **Brief restart gap** - Acceptable, uses existing restart infrastructure

---

## Existing Infrastructure to Use

- `DecoderManager.restartDecoder(id)` - Already handles graceful restart
- `decoder:restarting` event - For UI feedback
- Health system - For warnings

---

## Files to Modify

| File | Change |
|------|--------|
| `src/core/tuner-relay.ts` | Emit `sample-rate-changed` |
| `src/core/source-manager.ts` | Add `updateSourceCaps()`, emit `caps-changed` |
| `src/index.ts` | Wire events |
| `src/core/live-demodulator.ts` | Listen for caps-changed, restart pipeline |
| `src/decoders/manager.ts` | Listen for caps-changed, restart decoders |

---

## Testing

1. Start with multimon-ng decoder on tuner relay source
2. Connect SDR++ to tuner relay
3. Change sample rate in SDR++ device settings
4. Verify decoder restarts with new rate

---

## Documentation Required

- Update README: Note that dynamic sample rate only works with tuner relay
- Update ARCHITECTURE.md: Add sample rate propagation flow

---

## Estimated Effort: ~4 days
