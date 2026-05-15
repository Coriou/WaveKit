# Design — LoRa/Meshtastic Decoder

_Requirements: see `requirements.md`_

## 1. Architecture

The `lora-meshtastic` decoder is a **pure-consumer** decoder that extends `IqDecimateDecoder`. It is a structural twin of `Rtl433Decoder` — same shape (`cu8` IQ via csdr decimation pipeline, JSONL-on-stdout parsing, options-bag config), differing only in the decoder binary (a Python wrapper around gr-lora_sdr) and the output schema.

A single shell pipeline is spawned per decoder instance:

```
csdr convert -i char -o float
  | csdr firdecimate <N> 0.05
  | csdr convert -i float -o char
  | python3 /usr/local/bin/lora_meshtastic_decode.py
        --bw <Hz>              # bandwidth (preset-derived or override)
        --sf <int>             # spreading factor (preset-derived or override)
        --cr <int>             # coding rate, 5..8 = 4/5..4/8
        --samp-rate <Hz>       # *effective* output rate from csdr (see §3)
        --frequency <Hz>       # tuned frequency, for event metadata only
        --channel-key <base64> # Meshtastic PSK ("AQ==" = default channel)
        --region <enum>        # for event metadata + future use
```

The base class `IqDecimateDecoder` owns the csdr stage and is **not modified**. The subclass overrides only the four template methods (`getIqDecimationConfig`, `getDecoderCommand`, `getDecoderArgs`, `parseOutput`).

```
iq source (cu8 @ inputSampleRate)
  → FanoutManager
  → decoder stdin
  → csdr decimation (base class, integer factor)
  → python3 wrapper (cu8 → cf32 → gr-lora_sdr flowgraph → MeshPacket → AES-CTR decrypt → Data → JSONL)
  → BaseDecoder.parseOutput (TS-side JSON validation + remap)
  → DecoderOutput{type:"meshtastic", data:MeshtasticPacket}
  → DecoderManager
  → WebSocket /ws (decoders channel)
```

## 2. Components

| Component | Path | Purpose |
|---|---|---|
| `LoraMeshtasticDecoder` (class) | `src/decoders/builtin/lora-meshtastic.ts` | Extends `IqDecimateDecoder`. Builds csdr config + wrapper args. Parses JSONL. |
| `parseLoraMeshtasticOptions` (fn) | `src/decoders/builtin/lora-meshtastic.ts` | Validates the options bag, applies preset → (bw, sf, cr) mapping, applies raw overrides. Mirrors `parseAisCatcherOptions`. |
| `parseMeshtasticPacket` (fn) | `src/decoders/builtin/lora-meshtastic.ts` | JSON-boundary validator. Validates shape and types of one wrapper-emitted JSON object; returns `MeshtasticPacket | null`. Mirrors `parseJsonShip` from `ais-catcher.ts`. |
| `MeshtasticPacket` (interface) | `src/decoders/builtin/lora-meshtastic.ts` | TypeScript interface for one decoded packet event. Real `interface`, not a `Record` alias. Mirrors `ShipData`. |
| `createLoraMeshtasticDecoder` (fn) | `src/decoders/builtin/lora-meshtastic.ts` | Factory used by `DecoderRegistry`. |
| `LORA_MESHTASTIC_CAPS` (const) | `src/decoders/builtin/lora-meshtastic.ts` | Capabilities for registry. |
| `DecoderOutputType` (union) | `src/decoders/types.ts` | Extended with `"meshtastic"`. |
| Registration | `src/index.ts` (~line 388) | `decoderRegistry.register("lora-meshtastic", createLoraMeshtasticDecoder, LORA_MESHTASTIC_CAPS)` |
| Python wrapper | `docker/scripts/lora_meshtastic_decode.py` | gr-lora_sdr flowgraph + AES-CTR decryption + protobuf parse + JSONL emission. |
| Vendored protobuf | `docker/scripts/meshtastic_proto/mesh_pb2.py` | Compiled `mesh.proto`. Header comment records the upstream SHA. MeshPacket + Data only. |
| `lora-build` Dockerfile stage | `Dockerfile` | Clones tapparelj/gr-lora_sdr, builds against GNU Radio, installs to /usr/local. |
| Example config | `config/default.yaml` | Commented-out decoder block under "EXAMPLE: Multi-Source Setup". |
| Unit tests | `tests/unit/decoders/lora-meshtastic.test.ts` | Property tests for all eight properties (§7). |
| Integration test | `tests/integration/lora-meshtastic.test.ts` | Fixture replay via `recording` source. |
| Fixture | `fixtures/lora/meshtastic-sample.cu8` + `.expected.jsonl` | Small (< 5 MB) deterministic capture + expected events. |

## 3. Effective sample-rate math

The csdr pipeline performs **integer** decimation, so the actual output rate is rarely exactly equal to the requested nominal target. The decoder must compute and forward the *effective* rate so gr-lora_sdr can derive samples-per-symbol correctly.

```
nominalTarget = bw × oversampling     // e.g. 250_000 × 8 = 2_000_000
decimation    = Math.max(1, Math.round(inputSampleRate / nominalTarget))
effectiveRate = inputSampleRate / decimation
```

**Worked examples** at `inputSampleRate = 2_048_000` Hz:

| Preset | bw (Hz) | nominalTarget (Hz) | decimation | effectiveRate (Hz) | samples-per-symbol (effective/bw) |
|---|---|---|---|---|---|
| ShortFast..LongFast | 250 000 | 2 000 000 | 1 | 2 048 000 | 8.192 |
| LongModerate, LongSlow | 125 000 | 1 000 000 | 2 | 1 024 000 | 8.192 |
| VeryLongSlow | 62 500 | 500 000 | 4 | 512 000 | 8.192 |

`gr-lora_sdr`'s `frame_sync` block accepts non-integer samples-per-symbol via its built-in fractional resampling — strict integerness is **not** required, but the wrapper must be told the actual rate. The decoder stores `effectiveTargetRate` on the instance (mirroring `Rtl433Decoder.effectiveTargetRate`) and passes it as `--samp-rate` to the Python wrapper.

Operators tuning `inputSampleRate` or `oversampling` can override either field via the options bag.

## 4. Preset mapping

Resolved in `parseLoraMeshtasticOptions()` after option validation. Raw overrides (`bandwidth`, `spreadingFactor`, `codingRate`) take precedence **per field** — operators can override only the parameter they care about.

| Preset | BW (kHz) | SF | CR (4/n) |
|---|---|---|---|
| ShortFast    | 250  | 7  | 4/5 |
| ShortSlow    | 250  | 8  | 4/5 |
| MediumFast   | 250  | 9  | 4/5 |
| MediumSlow   | 250  | 10 | 4/5 |
| LongFast     | 250  | 11 | 4/5 |
| LongModerate | 125  | 11 | 4/8 |
| LongSlow     | 125  | 12 | 4/8 |
| VeryLongSlow | 62.5 | 12 | 4/8 |

This table is canonical and matches the Meshtastic firmware's preset definitions. Correctness property 8 (§7) tests the table as a fixed-point against the resolution function.

## 5. JSONL schema (wrapper stdout) and TS interface

The wrapper emits one JSON object per Meshtastic packet on stdout. Keys are **snake_case** (matching Meshtastic's protobuf field names). The TypeScript `parseMeshtasticPacket()` function remaps to **camelCase** before constructing a `MeshtasticPacket`.

### 5.1 JSON wire shape (snake_case, as emitted by the Python wrapper)

```json
{
  "from": 3735928559,
  "to": 4294967295,
  "id": 1234567890,
  "channel": 8,
  "hop_limit": 3,
  "hop_start": 3,
  "want_ack": false,
  "via_mqtt": false,
  "priority": 70,
  "portnum": 1,
  "payload_b64": "SGVsbG8gV29ybGQ=",
  "payload_len": 11,
  "rx_rssi": -95,
  "rx_snr": 6.5,
  "rx_time": "2026-05-15T12:34:56.789Z",
  "frequency": 869525000,
  "bw": 250000,
  "sf": 11,
  "cr": 5
}
```

`via_mqtt` and `priority` are optional in the wire shape (the wrapper omits them when the originating node did not set them); all other fields are always present.

### 5.2 TypeScript `MeshtasticPacket` interface (camelCase)

```ts
export interface MeshtasticPacket {
  /** Originating node ID (uint32) */
  from: number
  /** Destination node ID (uint32; 0xFFFFFFFF = broadcast) */
  to: number
  /** Packet ID (uint32) */
  id: number
  /** Channel hash (int) */
  channel: number
  /** Remaining hops */
  hopLimit: number
  /** Initial hop count when first transmitted */
  hopStart: number
  /** Sender requested an ack */
  wantAck: boolean
  /** Forwarded via MQTT (optional — wrapper omits when not set) */
  viaMqtt?: boolean
  /** Meshtastic message priority (optional — wrapper omits when not set) */
  priority?: number
  /** Meshtastic PortNum enum value */
  portnum: number
  /** Base64-encoded decrypted Data.payload bytes */
  payloadB64: string
  /** Length of the raw decrypted payload bytes */
  payloadLen: number
  /** RX RSSI in dBm (0 if unavailable) */
  rxRssi: number
  /** RX SNR in dB (0 if unavailable) */
  rxSnr: number
  /** ISO-8601 UTC time the wrapper observed the frame */
  rxTime: string
  /** Decoder's tuned frequency in Hz (from config, not measured) */
  frequency: number
  /** LoRa bandwidth used (Hz) */
  bw: number
  /** LoRa spreading factor used */
  sf: number
  /** LoRa coding rate (5..8 representing 4/5..4/8) */
  cr: number
}
```

### 5.3 `parseMeshtasticPacket(json: unknown): MeshtasticPacket | null`

Mirrors `parseJsonShip` in `ais-catcher.ts`. Validates and remaps in one function:

- Returns `null` when:
  - input is `null`, `undefined`, an array, or not a plain object
  - any required field (every field except `viaMqtt` and `priority`) is missing
  - any field has the wrong type (e.g., `from` is not a number, `payload_b64` is not a string, `want_ack` is not a boolean)
  - `payload_b64` is non-empty but does not decode as base64 (the function checks the regex `/^[A-Za-z0-9+/]*={0,2}$/` and an even-modulo-4 padded length)
  - `rx_time` is non-empty but does not parse as an ISO-8601 string (`new Date(value)` is `Invalid Date`)
- Returns a `MeshtasticPacket` when all checks pass, with all keys remapped to camelCase. Optional fields (`viaMqtt`, `priority`) are included only when present and of the correct type.
- **Never throws.** Validation errors are signaled by returning `null`; `parseOutput()` then logs at debug level and skips the line.

### 5.4 Why a real interface, not a `Record` alias

`rtl_433` passes parsed JSON straight through (`data: parsed` typed `unknown`) because rtl_433's schema is protocol-specific and varies per device. Meshtastic's schema is fully specified — every emitted packet has the same fields. We therefore mirror `ShipData`/`APRSData`/`APRSWeather`/`APRSMessage`: a real `interface` enables type-safe downstream consumers (WebSocket subscribers, future dashboard components) and the `parseMeshtasticPacket()` boundary catches malformed wrapper output instead of letting bad shapes silently propagate.

## 6. Channel key handling

The `channelKey` option is a base64 string. Two cases are recognized:

1. **Default channel (shorthand `"AQ=="`)** — Meshtastic stores the default channel PSK in URLs / QR codes as the single byte `0x01`. The Python wrapper detects this shorthand (one-byte input value `0x01` after base64 decode) and expands it to the Meshtastic-defined 16-byte default-channel PSK (`0xd4 0xf1 0xbb 0x3a 0x20 0x29 0x07 0x59 0xf0 0xbc 0xff 0xab 0xcf 0x4e 0x69 0x01`). This matches the Meshtastic firmware's behavior.
2. **Custom channels** — Any other base64 string must decode to exactly 16 bytes (AES-128 key length). The wrapper rejects non-16-byte custom keys at startup with a stderr error and a non-zero exit, which causes `BaseDecoder` to mark the decoder `faulted`.

The expansion lives **inside the Python wrapper**, not in TypeScript. The TS-side `parseLoraMeshtasticOptions()` only validates that `channelKey` is a non-empty base64 string.

## 7. Correctness properties

These properties drive the property-based tests in `tests/unit/decoders/lora-meshtastic.test.ts`. Each test runs with `numRuns: 100` minimum and references the property + requirement numbers in a comment.

### Property 1: Options round-trip (preset + override resolution is idempotent)

For every valid options bag, two successive calls to `parseLoraMeshtasticOptions()` produce identical resolved `{bw, sf, cr, frequency, channelKey, region, samplingParameters}` records. Raw overrides override the preset-derived values per field; missing override fields retain the preset value.

_Validates: Requirements 1.2, 1.5, 4.6._

### Property 2: Args determinism

For identical resolved options, `getDecoderArgs()` returns identical argument arrays. No environment, time, or randomness leaks into the arg list.

_Validates: Requirements 3.1, 8.3._

### Property 3: JSONL round-trip

For every JSON object matching the wrapper schema (§5.1), `parseOutput(JSON.stringify(obj))` returns a `DecoderOutput` with `type: "meshtastic"`, `decoder` equal to the decoder's id, a `Date` `timestamp`, and a `data` value that field-by-field equals the input after snake_case → camelCase remap.

_Validates: Requirements 4.1, 4.2, 4.4, 5.3._

### Property 4: Non-JSON tolerance

For every line that is not parseable as JSON (random bytes, partial JSON, the empty string, log-style text), or that parses but fails `parseMeshtasticPacket()` validation, `parseOutput()` returns `null` and does not throw.

_Validates: Requirements 4.3, 4.5._

### Property 5: Effective sample-rate derivation matches the documented formula

For every (`inputSampleRate`, `bandwidth`, `oversampling`) triple drawn from realistic SDR ranges, the decoder's stored `effectiveTargetRate` satisfies `effectiveTargetRate === inputSampleRate / Math.max(1, Math.round(inputSampleRate / (bandwidth × oversampling)))`. The resulting samples-per-symbol ratio `effectiveTargetRate / bandwidth` falls within a tolerance that `gr-lora_sdr`'s frame_sync can resync (heuristic: between 2 and 32; not strict integerness). Inputs that produce a ratio outside that range cause `parseLoraMeshtasticOptions()` to throw `ConfigValidationError` with an actionable message.

_Validates: Requirements 2.2, 2.3, 2.4._

### Property 6: Required-field rejection

For every supported "missing required field" — `region`, `preset`, `frequency`, `channelKey` — an options bag that omits that field (with every other field valid) causes `parseLoraMeshtasticOptions()` to throw `ConfigValidationError`. Each field is exercised individually.

_Validates: Requirements 1.2, 1.6._

### Property 7: Region & preset enum exhaustiveness

For every region in the documented enum (US, EU_868, EU_433, CN, JP, ANZ, KR, TW, RU, IN, NZ_865, TH, UA_433, UA_868, MY_433, MY_919, SG_923), an options bag with that region (and otherwise-valid fields) is accepted. For any region string not in that enum, `parseLoraMeshtasticOptions()` throws `ConfigValidationError`. The same is asserted for the preset enum (LongFast, LongModerate, LongSlow, MediumFast, MediumSlow, ShortFast, ShortSlow, VeryLongSlow).

_Validates: Requirements 1.3, 1.4._

### Property 8: Preset → params mapping fixed-point

For each preset in the canonical table (§4), `parseLoraMeshtasticOptions()` with no raw overrides resolves the expected `(bw, sf, cr)` triple. This is a property test against the canonical table — it catches accidental edits in either direction (code-side or table-side) during code review.

_Validates: Requirements 1.5, 4.6._

## 8. Error handling

| Scenario | Layer | Handling |
|---|---|---|
| Missing / wrong-type / unknown-enum options field | TS (`parseLoraMeshtasticOptions`) | Throws `ConfigValidationError` with the underlying Zod issue list. |
| Decoder type not registered | TS (`DecoderRegistry`) | Throws `RegistryError` — inherited behavior. |
| `python3` or wrapper script not on PATH | TS (`BaseDecoder.start`) | Throws `DecoderSpawnError` — inherited behavior. |
| Wrapper crashes mid-stream | TS (`BaseDecoder`) | Standard restart-with-backoff loop. After max restarts, decoder enters `faulted`. |
| Wrapper rejects channel key (non-16-byte custom key) | Python wrapper | Logs stderr "invalid channel key", exits non-zero. TS treats as a crash → restart loop → eventually faulted. |
| Per-frame CRC fail, AES-CTR fail, protobuf parse fail | Python wrapper | Logs one structured stderr line, drops the frame, does **not** exit. |
| stdout line is not valid JSON | TS (`parseOutput`) | Logs at debug level with the offending line, returns `null`. Does not throw. |
| stdout JSON fails schema validation in `parseMeshtasticPacket()` | TS (`parseOutput`) | Same as above — debug log, `null`, no throw. |
| Source sample rate changes | `DecoderManager` | Stops the decoder, restarts with new rate. The decoder needs no special handling. |

All errors raised from feature code MUST be the custom classes from `src/utils/errors.ts` (`WaveKitError`, `DecoderSpawnError`, `ConfigValidationError`, `RegistryError`, etc.). No bare `Error`. No new error class is required for v1 — the existing classes cover the cases.

## 9. Health & lifecycle

Inherited unchanged from `BaseDecoder`:

- `running` — emitting output.
- `idle` — no output for `health.idleTimeout` (default 30 s). Normal during quiet bands or quiet presets. Operators using `VeryLongSlow` SHOULD bump `health.idleTimeout` to several minutes (see §10).
- `faulted` — crashed past `maxRestarts`.

Source-rate-change handling: when `TunerRelay` changes the source caps, `DecoderManager` stops and restarts the decoder; the new `inputSampleRate` is read from caps on the next start and the csdr pipeline is rebuilt. No decoder-side special handling.

## 10. Performance notes (advisory; not enforced)

- **Raspberry Pi 4 CPU**: gr-lora_sdr at BW 250 kHz, SF 11, on a Pi 4 typically runs at 30-50% of one core. Adding it alongside the existing eight decoders may push total CPU load above comfortable headroom on busy presets. Operators should monitor `/api/status` and decoder CPU usage. NOT enforced by a perf gate.
- **TCXO**: RTL-SDR's standard crystal (~30 ppm) drifts a few kHz once the dongle heats up. LoRa is narrow-band — at BW 125 kHz drift of several kHz can prevent frame sync. We strongly recommend a TCXO RTL-SDR (e.g., RTL-SDR Blog v3) for any Meshtastic reception. The example config in `config/default.yaml` includes a one-line comment to this effect.
- **VeryLongSlow idle timeout**: At SF 12 and BW 62.5 kHz, a single LoRa symbol is `(2^12) / 62500 ≈ 65.5 ms`. A typical Meshtastic packet of 16-200 bytes can take 2-10 seconds on the air. Combined with the low duty cycle of Meshtastic mesh traffic, a quiet `VeryLongSlow` channel can legitimately produce no decoded packets for several minutes. Operators running `VeryLongSlow` SHOULD bump `health.idleTimeout` to at least 5-10 minutes to avoid spurious "idle" health transitions. Default `health.idleTimeout` is fine for all other presets.
- **Wrapper buffering**: gr-lora_sdr's `frame_sync` block needs adequate input buffering for long-symbol presets. The wrapper reads stdin in fixed-size chunks (~64 KB) and passes them into the flowgraph's source block via a queue with adequate depth. No chunk-size sensitivity is exposed in the options bag; the wrapper picks a default that works across all presets.

## 11. Source attachment

The decoder uses `sourceId`-based attachment, identical to `rtl_433` and other pure-consumer decoders. Two recommended setups:

1. **Dedicated dongle (best signal quality)** — one RTL-SDR tuned to the LoRa frequency (e.g., 869.525 MHz EU_868 / 906.875 MHz US), one source in YAML, one decoder.
2. **Shared with rtl_433 (easy starter)** — one RTL-SDR tuned somewhere in the 868 or 915 MHz ISM band. Both `rtl_433` and `lora-meshtastic` attach to the same `iq` source via `sourceId`. The FanoutManager handles multiplexing; each decoder runs its own csdr decimation. Trade-off: tuning frequency is chosen between rtl_433 protocol coverage and Meshtastic's narrow channel, which can hurt one or the other.

The example in `config/default.yaml` shows the shared-with-rtl_433 starter; the design recommendation is the dedicated dongle if Meshtastic reception is the primary goal.

## 12. Future scope (documented; not implemented in v1)

These are deliberately deferred. The v1 design preserves the boundary so a follow-up can add them cleanly.

- **Raw LoRa PHY events** (`type: "lora"`). gr-lora_sdr already produces these — the wrapper just doesn't emit them. Adding `"lora"` to `DecoderOutputType` and a wrapper flag (`--emit-raw-lora`) is the future hook.
- **LoRaWAN metadata** — same wrapper, a new flag, a new output type.
- **Per-portnum payload decoding (Python wrapper)** — the per-app protobuf modules (`portnums.proto`, `position.proto`, `nodeinfo.proto`, `telemetry.proto`, etc.) are deliberately not vendored in v1. A future PR adds them to `docker/scripts/meshtastic_proto/` and extends the wrapper to populate optional structured fields. The v1 wire shape (`portnum` + `payload_b64`) is forward-compatible.
- **TypeScript-side enrichment** — a follow-up enrichment module could decode well-known portnums into typed events for the dashboard (mirroring the ADS-B aircraft enrichment pipeline). Lives **outside** the decoder, in a future enrichment module.
- **Automated CPU-budget perf gate** — no precedent in the codebase; documented as advisory in §10.
- **Mode-switching / multi-preset** — a single decoder instance runs a single preset. Operators wanting multiple presets simultaneously add multiple decoder instances, each on its own (or shared) iq source.

## 13. Anti-pattern checklist (for self-review before commit)

The implementation MUST NOT introduce any of the following:

- [ ] Raw-LoRa or LoRaWAN code paths in v1 (deferred to future scope).
- [ ] Modifications to `IqDecimateDecoder` (do not add cf32 output, do not add hooks). The Python wrapper does its own u8→f32 conversion.
- [ ] Meshtastic decryption or protobuf parsing in TypeScript (wrapper-only).
- [ ] Meshtastic-specific fields on the top-level `DecoderConfigSchema` (per-decoder options bag only).
- [ ] An automated CPU-budget perf gate (documented as advisory only).
- [ ] A root-level `meshtastic:` block or any other new top-level config section.
- [ ] A network port exposed by the decoder (JSONL on stdout is the only contract).
- [ ] A long-running Python service with an IPC layer (stdin→stdout child process per decoder instance).
- [ ] `console.log` / bare `Error` / floating promises / non-Zod external-data parsing / `.ts` extensions on relative imports / `any` / `var` / semicolons / spaces-for-indentation. (Project guardrails enforced by ESLint + Prettier.)
