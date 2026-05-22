# ADS-B Pipeline Enhancement - Implementation Handoff

<!-- AI Agent Handoff Document - Optimized for Implementation -->

## Quick Summary

**Objective**: Fix and optimize the ADS-B decoding pipeline to work correctly when users tune to 1090 MHz with an appropriate sample rate using WaveKit's tuner interface.

**Key Constraint**: This must NOT affect any other decoders - changes are scoped exclusively to the readsb/ADS-B pipeline.

**Tested Working Configuration**: 2.4 Msps sample rate at 1090 MHz - confirmed decoding aircraft.

**Estimated Effort**: ~2-3 hours

---

## Architecture Context

```
┌──────────────┐   ┌───────────────┐   ┌─────────────────┐   ┌────────────────┐
│  RTL-TCP     │──▶│ SourceManager │──▶│  FanoutManager  │──▶│    readsb      │
│ @ 2.4 Msps   │   │               │   │ decoder-adsb    │   │  --ifile -     │
└──────────────┘   └───────────────┘   │    branch       │   │  --iformat UC8 │
       ▲                               └─────────────────┘   │  --net         │
       │                                        ▲            └────────────────┘
┌──────┴───────┐                               │                    │
│ TunerRelay   │────── caps-changed ──────────▶│                    ▼
│ set-sample-  │  (triggers decoder restart)  │            TCP output port
│ rate 0x02    │                                           (SBS/Beast/JSON)
└──────────────┘
```

---

## Research Findings

### Sample Rate Requirements

> [!IMPORTANT]
> **Real-world testing shows 2.4 Msps works reliably, while 2.0/2.048 Msps may fail in stdin mode.** The default recommendation should be 2.4 Msps.

| Sample Rate               | WaveKit Stdin Mode | Notes                                           |
| ------------------------- | ------------------ | ----------------------------------------------- |
| 2,400,000 Hz (2.4 Msps)   | ✅ **Recommended** | Tested working, common RTL-SDR default          |
| 2,048,000 Hz (2.048 Msps) | ⚠️ May not work    | May fail in stdin pipeline                      |
| 2,000,000 Hz (2.0 Msps)   | ⚠️ May not work    | Theoretical minimum, may fail in stdin pipeline |
| < 2,000,000 Hz            | ❌ Fails           | Decoder timing/pulse resolution breaks          |

**Why < 2.0 Msps fails**: dump1090/readsb-style decoders have timing logic designed around specific sample rates. Lower rates cause the decoder to miss pulses because ADS-B uses PPM (Pulse Position Modulation) with 0.5µs bit timing. This is an operational constraint of the decoder, not strictly Nyquist.

**References**:

- [dump1090 issue #65](https://github.com/antirez/dump1090/issues/65) - lower rates break decoding
- [readsb issue #33](https://github.com/wiedehopf/readsb/issues/33) - 2.4 Msps IQ file works
- [ADS-B demodulation guide](https://blog.exploit.org/ads-b-guide-demodulation-and-decoding/) - 2.0-2.5 Msps common

### readsb Command-Line Options (ifile mode)

From official readsb `--help` and [Debian manpages](https://manpages.debian.org/testing/readsb/readsb.1):

```
ifile-specific options, use with --device-type ifile:
  --ifile=<path>       Read samples from given file ('-' for stdin)
  --iformat=<type>     Set sample format (UC8, SC16, SC16Q11)
  --throttle           Process samples at the original capture speed
```

**Current WaveKit implementation uses**: `--device-type ifile --ifile - --iformat UC8`

> [!NOTE]
> **In ifile/stdin mode, readsb receives raw IQ without metadata.** There is no way to specify sample rate to readsb - it assumes a working rate internally. The pipeline must ensure the sample rate and format match what readsb expects.

### IQ Format

RTL-TCP outputs **UC8** (unsigned 8-bit interleaved I/Q) - this is the standard RTL-SDR raw IQ format. See [RTL-SDR IQ format reference](https://k3xec.com/packrat-processing-iq/).

Our `--iformat UC8` is correct.

---

## Issues Identified

### Issue 1: Inconsistent READSB_CAPS Static Export

**File**: `src/decoders/builtin/readsb.ts`

The static `READSB_CAPS` export at line 562 declares `input: "external"`:

```typescript
export const READSB_CAPS: DecoderCaps = {
	input: "external", // ❌ Inconsistent with stdin mode
	wantsExclusiveSource: true,
	output: "jsonl",
	integrationPattern: "network_producer",
}
```

But the instance `getCaps()` at line 256 returns `input: "iq"`:

```typescript
return {
	input: "iq", // ✅ Correct for stdin mode
	// ...
}
```

**Impact**: The DecoderManager correctly uses `decoder.caps` (instance property), so wiring works. But this inconsistency is confusing and should be fixed.

### Issue 2: Incorrect Documentation Comments

**File**: `src/decoders/builtin/readsb.ts`

Lines 144-146 and 170-171 incorrectly claim that ONLY 2.0 Msps works and that 2.4 Msps will fail:

```typescript
// IMPORTANT: readsb requires 2.0 Msps sample rate for ADS-B decoding.
// ...
// NOTE: readsb expects 2.0 Msps for ADS-B. If the source is 2.4 Msps,
// decoding will likely fail.
```

**This is wrong.** Testing confirms 2.4 Msps works, and lower rates may actually fail.

### Issue 3: Missing Diagnostic Logging

When ADS-B decoding fails silently, there's no easy way to diagnose:

1. Is IQ data reaching readsb? (check `bytesIn`)
2. What sample rate is being used?
3. Is frequency tuned to 1090 MHz?

---

## Implementation Steps

### Step 1: Fix READSB_CAPS Static Export

**File**: `src/decoders/builtin/readsb.ts`

```diff
 export const READSB_CAPS: DecoderCaps = {
-  input: "external",
+  input: "iq",
   wantsExclusiveSource: true,
   output: "jsonl",
   integrationPattern: "network_producer",
 }
```

**Rationale**: When using stdin mode (no `rtlTcpHost`), readsb receives IQ via stdin from the fanout. The static caps should match this behavior.

---

### Step 2: Update Documentation Comments

**File**: `src/decoders/builtin/readsb.ts`

Update lines 144-146:

```diff
- * IMPORTANT: readsb requires 2.0 Msps sample rate for ADS-B decoding.
- * When using ifile mode (stdin), the data must already be at 2.0 Msps.
+ * IMPORTANT: ADS-B decoding works best at 2.4 Msps sample rate.
+ * The dump1090/readsb decoder timing is optimized for rates around 2.0-2.4 Msps.
+ * In practice, 2.4 Msps is the most reliable; lower rates may fail due to
+ * decoder timing assumptions and insufficient pulse resolution for PPM.
+ *
+ * In ifile/stdin mode, readsb receives raw IQ without metadata - the pipeline
+ * must ensure the sample rate matches what the decoder expects.
```

Update lines 170-171:

```diff
- // NOTE: readsb expects 2.0 Msps for ADS-B. If the source is 2.4 Msps,
- // decoding will likely fail. Use rtlTcpHost for proper sample rate control.
+ // NOTE: ADS-B works best at 2.4 Msps. Rates below 2.0 Msps will fail.
+ // The decoder timing assumes adequate sample rate for 0.5µs PPM pulses.
```

Update lines 233-240:

```diff
- * IMPORTANT: ADS-B decoding requires:
- * - Frequency: 1090 MHz
- * - Sample rate: 2.0 Msps (fixed, not configurable)
- *
- * When using stdin mode (no rtlTcpHost), readsb expects the IQ stream to be
- * at 2.0 Msps. Shared IQ sources at 2.4 Msps will NOT work correctly.
+ * IMPORTANT: ADS-B decoding requires:
+ * - Frequency: 1090 MHz
+ * - Sample rate: 2.4 Msps recommended (2.0+ Msps minimum)
+ *
+ * In stdin mode, readsb receives raw IQ without sample rate metadata.
+ * The pipeline must provide IQ at an appropriate rate. 2.4 Msps is tested
+ * and works reliably; lower rates may fail due to decoder timing constraints.
```

---

### Step 3: Add ADS-B Specific Health Logging (Debug Only)

**File**: `src/decoders/builtin/readsb.ts`

Add a debug log on start to help diagnose decoding issues:

```typescript
// Add after class constructor or in start() method override
protected override async start(): Promise<void> {
  // Log ADS-B specific diagnostic info (debug level only)
  this.logger.debug(
    {
      mode: this.options.rtlTcpHost ? 'network' : 'stdin',
      format: 'UC8',
      outputFormat: this.options.outputFormat,
      outputPort: this.options.outputPort ?? DEFAULT_PORTS[this.options.outputFormat],
    },
    'Starting ADS-B decoder'
  )

  return super.start()
}
```

> [!NOTE]
> This is optional and should use `debug` level. It will be removed once pipeline is stable.

---

### Step 4: Update Unit Test

**File**: `tests/unit/decoders/readsb.test.ts`

Update the test at lines 343-351:

```diff
 describe("READSB_CAPS", () => {
   it("should have correct default capabilities", () => {
     expect(READSB_CAPS).toEqual({
-      input: "external",
+      input: "iq",
       wantsExclusiveSource: true,
       output: "jsonl",
       integrationPattern: "network_producer",
     })
   })
 })
```

---

## Files Summary

| File                                 | Changes                                         | Breaking? |
| ------------------------------------ | ----------------------------------------------- | --------- |
| `src/decoders/builtin/readsb.ts`     | Fix READSB_CAPS, update comments, add debug log | No        |
| `tests/unit/decoders/readsb.test.ts` | Update READSB_CAPS test                         | No        |

---

## What NOT to Change

To ensure no breaking changes:

1. **Do NOT modify any other decoder files** - only readsb.ts
2. **Do NOT change the getArgs() method** - the command-line arguments are correct
3. **Do NOT change getCaps() instance method** - it's already correct
4. **Do NOT modify DecoderManager** - the wiring logic is correct
5. **Do NOT modify FanoutManager** - IQ routing is correct
6. **Do NOT add any new dependencies**

---

## Verification Plan

### Automated Tests

```bash
# Run readsb-specific tests
pnpm test -- tests/unit/decoders/readsb.test.ts

# Run full test suite to ensure no regressions
pnpm test
```

### Manual Testing Checklist

1. [ ] Build WaveKit successfully
2. [ ] Start with tuner relay enabled
3. [ ] Set frequency to 1,090,000,000 Hz via CLI tuner tab
4. [ ] **Set sample rate to 2,400,000 Hz** (recommended)
5. [ ] Check decoder status: `curl http://localhost:9000/api/decoders`
6. [ ] Verify `adsb` decoder shows:
   - `running: true`
   - `stats.bytesIn` incrementing (IQ data flowing)
7. [ ] If aircraft are nearby, verify messages appear in output

### Expected Behavior After Fix

With source at **2.4 Msps** and frequency at 1090 MHz:

- readsb receives IQ via stdin from fanout
- ADS-B messages are decoded when aircraft are in range
- Messages appear on configured output port (30003/30005/30047)
- WebSocket broadcasts decoded aircraft data

---

## Edge Cases

| Scenario                                        | Expected Behavior                           |
| ----------------------------------------------- | ------------------------------------------- |
| Sample rate < 2.0 Msps                          | Decoding fails (decoder timing), shows idle |
| Sample rate = 2.0/2.048 Msps                    | May work but not guaranteed in stdin mode   |
| Sample rate = 2.4 Msps                          | ✅ Works reliably                           |
| Frequency != 1090 MHz                           | No ADS-B messages (expected, not an error)  |
| No aircraft in range                            | Decoder stays idle (normal, not an error)   |
| Pipeline mismatch (wrong format, dropped bytes) | Decoding fails silently                     |

---

## Success Criteria

- [ ] `READSB_CAPS.input` equals `"iq"` (consistency fix)
- [ ] Unit tests pass
- [ ] No other decoders affected (run full test suite)
- [ ] Comments accurately reflect 2.4 Msps recommendation
- [ ] (Optional) Debug logging added for diagnostics
- [ ] Manual test: 2.4 Msps @ 1090 MHz decodes aircraft
