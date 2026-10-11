# Tasks — LoRa/Meshtastic Decoder

_Requirements: see `requirements.md`. Design: see `design.md`._

Tasks are dependency-sequenced. Stop at the **checkpoint** after task 9 and verify all unit + integration tests pass before proceeding to the smoke test.

## TypeScript-side wiring

- [x] **1. Extend `DecoderOutputType` union.** Add `"meshtastic"` to the union in `src/decoders/types.ts` (around lines 186-200). Do **not** add `"lora"`.
  _Requirements: 5.1, 5.2, 5.3._

- [x] **2. Implement option parsing and validation.** Add `LoraMeshtasticOptions` interface, `parseLoraMeshtasticOptions()` function, and a Zod schema for the options bag in `src/decoders/builtin/lora-meshtastic.ts`. The function MUST:
  - Validate `region` against the documented enum (Requirements 1.3).
  - Validate `preset` against the documented enum (Requirements 1.4).
  - Validate `frequency` is a positive integer (Hz).
  - Validate `channelKey` is a non-empty base64 string (regex check).
  - Resolve preset → `(bw, sf, cr)` from the canonical table in `design.md` §4.
  - Apply raw overrides (`bandwidth`, `spreadingFactor`, `codingRate`) per field.
  - Compute and return `effectiveTargetRate` per `design.md` §3.
  - Throw `ConfigValidationError` on any validation failure.
  - Mirror the function signature and style of `parseAisCatcherOptions` in `src/decoders/builtin/ais-catcher.ts`.
  _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 2.3, 4.6._

- [x] **3. Implement `MeshtasticPacket` interface and `parseMeshtasticPacket()`.** In `src/decoders/builtin/lora-meshtastic.ts`:
  - Define `MeshtasticPacket` as a real exported `interface` with all camelCase fields documented in `design.md` §5.2. Mirror `ShipData` from `ais-catcher.ts:61-94`.
  - Implement `parseMeshtasticPacket(json: unknown): MeshtasticPacket | null`. The function MUST validate every required field (type + presence), validate base64 shape on `payload_b64`, validate ISO-8601 on `rx_time`, remap snake_case to camelCase, and return `null` (never throw) on any failure. Mirror `parseJsonShip` from `ais-catcher.ts:419-458`.
  _Requirements: 4.1, 4.2, 4.3, 4.6._

- [x] **4. Implement `LoraMeshtasticDecoder` class.** Subclass `IqDecimateDecoder`:
  - Constructor: call `super(...)`, then `this.options = parseLoraMeshtasticOptions(config.options)`. Compute and store `this.effectiveTargetRate` per `design.md` §3.
  - `getIqDecimationConfig()`: return `{inputSampleRate, targetSampleRate: bw × oversampling, filterTransition: 0.05}`.
  - `getDecoderCommand()`: return `"python3"`.
  - `getDecoderArgs()`: return the full arg list per `design.md` §1 (with `--samp-rate` set to `this.effectiveTargetRate`).
  - `getCaps()`: return `LORA_MESHTASTIC_CAPS`.
  - `parseOutput(line)`: trim, return `null` if empty or not a `{`-prefixed JSON object; otherwise `JSON.parse` inside a `try` and call `parseMeshtasticPacket`. On `null`, debug-log and return `null`. On a `MeshtasticPacket`, return `{timestamp: new Date(), decoder: this.id, type: "meshtastic", data: <packet>}`.
  - Component logger created via `createComponentLogger(parentLogger, "LoraMeshtasticDecoder")`. NO `console.log`.
  - Errors thrown from feature paths MUST be from `src/utils/errors.ts`. NO bare `Error`.
  - Imports MUST use `.js` relative extensions, `import type` for type-only imports, and NO `any`.
  Mirror the file layout of `src/decoders/builtin/rtl433.ts`.
  _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 4.4, 4.5, 4.6._

- [x] **5. Export `createLoraMeshtasticDecoder` factory and `LORA_MESHTASTIC_CAPS`.** Match the shape of `createRtl433Decoder` / `RTL433_CAPS` at the bottom of `rtl433.ts`.
  _Requirements: 1.1, 2.1._

- [x] **6. Register the decoder.** Edit `src/index.ts` around lines 377-388 to add `decoderRegistry.register("lora-meshtastic", createLoraMeshtasticDecoder, LORA_MESHTASTIC_CAPS)` alongside the existing eight decoders. Update the surrounding log line if it counts decoders.
  _Requirements: 6.1, 6.2, 6.3._

## Python wrapper + protobuf vendoring

- [x] **7. Vendor the Meshtastic `mesh.proto` compiled module.** Generate `mesh_pb2.py` from a specific upstream SHA of `https://github.com/meshtastic/protobufs`. Commit only `MeshPacket` + `Data` definitions (the `mesh.proto` output). Place at `docker/scripts/meshtastic_proto/mesh_pb2.py` (plus `__init__.py`). The file MUST carry a header comment of the form:
  ```
  # Generated from https://github.com/meshtastic/protobufs at SHA <40-char>, mesh.proto only. Do not edit by hand.
  # To regenerate: protoc --python_out=docker/scripts/meshtastic_proto mesh.proto
  ```
  Pick a current upstream commit at implementation time and pin its 40-char SHA in the header.
  _Requirements: 3.8, 10.1, 10.2, 10.3._

- [x] **8. Write the Python wrapper.** Create `docker/scripts/lora_meshtastic_decode.py`:
  - Parse argv flags: `--bw`, `--sf`, `--cr`, `--samp-rate`, `--frequency`, `--channel-key`, `--region`.
  - On startup, validate `--channel-key`: base64-decode it. If the result is a single 0x01 byte (shorthand `AQ==`), expand to the Meshtastic 16-byte default PSK (per `design.md` §6). Otherwise require exactly 16 bytes; on mismatch, write a structured error to stderr and exit non-zero.
  - Add `docker/scripts/meshtastic_proto/` to `sys.path` and `import mesh_pb2`.
  - Build a `gnuradio.lora_sdr` flowgraph (rx chain per `design.md` §1) with a custom source block that reads stdin (`sys.stdin.buffer`) in ~64 KB chunks, converts `cu8` → `cf32` inline (`(b − 127.5) / 127.5`), and feeds the chain.
  - Use `cryptography` (`from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes`) for AES-128-CTR. Build the Meshtastic nonce from `packet_id` + `from` per the Meshtastic firmware convention. Decrypt `MeshPacket.encrypted` (when present) into a `Data` proto.
  - For each successfully decoded packet, emit one JSON line on stdout matching the schema in `design.md` §5.1. Always `sys.stdout.flush()` after each line.
  - Write all diagnostic / log output to stderr only.
  - Wrap per-frame work in `try` / `except Exception`. On exception: write a structured stderr line, drop the frame, continue. Do NOT exit on per-frame errors.
  - Handle `SIGTERM` cleanly by stopping the flowgraph and flushing stderr.
  _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8._

## Docker image

- [x] **9. Add `lora-build` Dockerfile stage.** In `Dockerfile`, after the `ais-catcher-build` stage (~line 274):
  ```
  FROM base-deps AS lora-build
  WORKDIR /build
  RUN apt-get update && apt-get install -y --no-install-recommends \
        gnuradio gnuradio-dev python3-dev pybind11-dev && rm -rf /var/lib/apt/lists/*
  RUN git clone --depth 1 https://github.com/tapparelj/gr-lora_sdr.git && \
        cd gr-lora_sdr && mkdir build && cd build && \
        cmake -DCMAKE_BUILD_TYPE=Release .. && \
        make -j$(nproc) && make install && ldconfig
  ```
  Pin a known-good commit / tag rather than `HEAD` if tapparelj has tagged releases.
  _Requirements: 9.1._

  **9a. Update final + final-core stages.** Both stages MUST:
  - `apt install python3 python3-gnuradio python3-protobuf python3-cryptography`.
  - `COPY --from=lora-build /usr/local/lib/python3*/dist-packages/gnuradio/lora_sdr /usr/local/lib/python3*/dist-packages/gnuradio/lora_sdr` (or the equivalent install path).
  - `COPY --from=lora-build /usr/local/lib/libgnuradio-lora_sdr* /usr/local/lib/` (any compiled shared libraries).
  - `COPY docker/scripts/lora_meshtastic_decode.py /usr/local/bin/`.
  - `COPY docker/scripts/meshtastic_proto /usr/local/lib/wavekit/meshtastic_proto`.
  - `RUN chmod 755 /usr/local/bin/lora_meshtastic_decode.py && ldconfig`.
  - Add to the verification block: `python3 -c "from gnuradio import lora_sdr; print(lora_sdr.__file__)" && python3 /usr/local/bin/lora_meshtastic_decode.py --help`.
  - The wrapper's `import mesh_pb2` MUST work — either by adjusting `sys.path` in the wrapper or by copying the proto folder into a path on the default Python path.
  _Requirements: 9.2, 9.3, 9.4, 9.5._

## Tests (checkpoint)

- [x] **10. Unit tests — property-based.** Create `tests/unit/decoders/lora-meshtastic.test.ts`. Use `fast-check` with `numRuns: 100` minimum. Mirror the layout of `tests/unit/decoders/rtl433.test.ts`. One `describe` block per property; each `it` carries a reference comment:
  ```ts
  // Feature: lora-meshtastic, Property N: <name>
  // Validates: Requirements X.Y, X.Z
  ```
  Cover all eight properties from `design.md` §7:
  - Property 1 — options round-trip.
  - Property 2 — args determinism.
  - Property 3 — JSONL round-trip (snake_case wire shape → camelCase `MeshtasticPacket`).
  - Property 4 — non-JSON tolerance.
  - Property 5 — effective sample-rate derivation matches the documented formula.
  - Property 6 — required-field rejection (one sub-test per missing field).
  - Property 7 — region & preset enum exhaustiveness.
  - Property 8 — preset → `(bw, sf, cr)` mapping fixed-point.
  _Requirements: 8.3._

- [ ] **11. Capture / generate the fixture.** Produce a small (< 5 MB) `cu8` IQ recording at `fixtures/lora/meshtastic-sample.cu8` containing at least one Meshtastic packet on a known channel + key. Acceptable origins (any one):
  - On-air capture with a known Meshtastic node + default channel.
  - Synthesized recording: generate a Meshtastic packet with a known node, encrypt with default key, modulate via `gr-lora_sdr`'s TX chain, quantize to `cu8`. Document the generation command in a sibling `README.md` under `fixtures/lora/` so the capture is reproducible.

  Write the expected events to `fixtures/lora/meshtastic-sample.expected.jsonl` (one JSON object per expected packet, matching the wire shape in `design.md` §5.1). Both files committed.
  _Requirements: 8.1._

  _Status: placeholder paths and regeneration docs are committed, but the real RF/synthesized capture remains required before this task is complete._

- [ ] **12. Integration test — fixture replay.** Create `tests/integration/lora-meshtastic.test.ts`:
  - Spin up a `recording` source pointing at `fixtures/lora/meshtastic-sample.cu8` with the correct sample rate / format caps.
  - Instantiate a `LoraMeshtasticDecoder` via the standard registry / manager path with the channel key matching the fixture.
  - Collect emitted `DecoderOutput` events for a deterministic duration (e.g., 10 s with the recording loop disabled).
  - Assert at least one event has `type === "meshtastic"` and that one event matches the expected packet from the sidecar JSONL on (`from`, `id`, `portnum`, `payload_b64`).
  - The test is skippable in CI environments without `gnuradio` / `gr-lora_sdr` installed — use a `describe.skipIf(...)` guard checking for the presence of the wrapper script at the canonical path.
  _Requirements: 8.2._

  _Status: test scaffold is committed and skipped until the real fixture marker is present._

> **Checkpoint**: at this point all unit + integration tests must pass under `pnpm test`. Do NOT proceed before this passes.

## Config + docs

- [x] **13. Add example config block.** Append a commented-out `lora-meshtastic` decoder example to `config/default.yaml` inside the "EXAMPLE: Multi-Source Setup" section (around line 374). Show:
  - `region: "EU_868"`, `preset: "LongFast"`, `frequency: 869525000`, `channelKey: "AQ=="`.
  - A comment noting that the decoder can share an `iq` source with `rtl_433` on the same 868 / 915 MHz dongle.
  - A comment recommending a TCXO RTL-SDR for frequency stability.
  _Requirements: 11.1, 11.2, 11.3._

- [x] **14. Update `docs/DECODER-GUIDE.md` output-types table.** Add a row for `meshtastic` (description: "Meshtastic LoRa packet", used by: `lora-meshtastic`).
  _Requirements: 5.1._

## Manual smoke test (post-merge)

- [ ] **15. Live smoke test.** On a Raspberry Pi 4 with a TCXO RTL-SDR connected:
  - Configure a `lora-meshtastic` decoder for the local region (`EU_868` LongFast in EU, `US` LongFast in US), `frequency` set to the regional Meshtastic primary frequency, `channelKey: "AQ=="`.
  - Start WaveKit. Subscribe to the `decoders` WebSocket channel.
  - Verify ≥1 packet event with `type: "meshtastic"` is emitted within 5 minutes on a known-busy preset.
  - Verify the decoder transitions to `running` health state.
  - Verify CPU usage stays within comfortable headroom alongside any other configured decoders. Record approximate usage in the PR description.
  _Requirements: 8.4._

## Non-negotiables (verify before raising the PR)

- [x] No raw-LoRa or LoRaWAN code paths.
- [x] `IqDecimateDecoder` is **not** modified.
- [x] No Meshtastic decryption or protobuf parsing in TypeScript.
- [x] All Meshtastic config lives in the per-decoder options bag; top-level `DecoderConfigSchema` is unchanged.
- [x] `type: "meshtastic"` is the emitted value for every event.
- [x] No new network port; JSONL on stdout only.
- [x] No `console.log` in production code.
- [x] No bare `Error` thrown from feature code.
- [x] No `any`; strict TS settings respected.
- [x] No floating promises (`void` used to explicitly discard).
- [x] Relative imports end in `.js`; `import type` for type-only imports.
- [x] Tabs, no semicolons, single-arg arrows without parens.
- [x] Pino logger via `createComponentLogger(...)`.
- [x] All external data validated with Zod at the boundary.
- [x] `parseOutput` does not throw.
