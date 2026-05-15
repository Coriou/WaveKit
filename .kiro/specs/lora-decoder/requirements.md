# Requirements — LoRa/Meshtastic Decoder

## Overview

Add a new pure-consumer decoder, `lora-meshtastic`, that demodulates LoRa frames from a shared `iq` source and emits decoded Meshtastic packet events as JSONL on stdout. The decoder is a twin of the existing `rtl_433` decoder: it extends `IqDecimateDecoder`, decimates `cu8` IQ to a LoRa-appropriate rate via `csdr`, and delegates the demod + Meshtastic decryption + protobuf parsing to a small Python wrapper that uses the gr-lora_sdr OOT module.

v1 is scoped to **Meshtastic packets only**. Raw-LoRa-PHY and LoRaWAN are explicitly out-of-scope for v1. Per-portnum payload decoding is also out-of-scope for v1; the wrapper passes the decrypted `Data` payload through as `payload_b64` + `portnum`, and the TypeScript side does no per-app sub-protobuf parsing.

## User Stories

### Requirement 1: Operator can configure a LoRa/Meshtastic decoder via YAML

**User story.** As a WaveKit operator, I want to add a `lora-meshtastic` decoder to my YAML config, attaching it to an existing `iq` source, so that I can receive decoded Meshtastic packets on the WebSocket without writing code.

**Acceptance criteria.**

- 1.1: WHEN the operator adds a decoder with `type: "lora-meshtastic"` to `config.decoders`, THE `DecoderRegistry` SHALL produce a `LoraMeshtasticDecoder` instance via the registered factory.
- 1.2: WHEN the decoder is created, THE decoder SHALL parse its options bag with `parseLoraMeshtasticOptions()` and SHALL throw `ConfigValidationError` if any required field (`region`, `preset`, `frequency`, `channelKey`) is missing or has a wrong type.
- 1.3: WHEN `region` is set to a value not in the enum `US | EU_868 | EU_433 | CN | JP | ANZ | KR | TW | RU | IN | NZ_865 | TH | UA_433 | UA_868 | MY_433 | MY_919 | SG_923`, THE decoder SHALL throw `ConfigValidationError`.
- 1.4: WHEN `preset` is set to a value not in the enum `LongFast | LongModerate | LongSlow | MediumFast | MediumSlow | ShortFast | ShortSlow | VeryLongSlow`, THE decoder SHALL throw `ConfigValidationError`.
- 1.5: WHEN the operator provides any of the raw overrides (`bandwidth`, `spreadingFactor`, `codingRate`), THE decoder SHALL use the override values in place of the preset-derived values for those fields.
- 1.6: WHEN the decoder configuration is loaded, THE top-level `DecoderConfigSchema` SHALL be unchanged — all Meshtastic-specific fields live in the per-decoder `options` record.

### Requirement 2: Decoder attaches to a shared iq source and decimates with csdr

**User story.** As a WaveKit operator, I want the LoRa decoder to share an existing `iq` source (typically the same 868/915 MHz dongle that feeds `rtl_433`) so that I don't need a dedicated dongle for Meshtastic.

**Acceptance criteria.**

- 2.1: THE `LoraMeshtasticDecoder` SHALL declare capabilities `{input: "iq", wantsExclusiveSource: false, output: "jsonl", integrationPattern: "pure_consumer"}`.
- 2.2: WHEN the decoder starts, THE base class `IqDecimateDecoder` SHALL build a `csdr` decimation pipeline from `inputSampleRate` (default 2 048 000 Hz, configurable) to a nominal target rate equal to `bandwidth × oversampling` (oversampling default 8, configurable).
- 2.3: WHEN the csdr decimation factor is computed as `Math.round(inputSampleRate / nominalTargetRate)`, THE decoder SHALL compute and store the **effective** output rate as `inputSampleRate / decimation` and SHALL pass that effective rate (not the nominal target) to the Python wrapper via `--samp-rate`.
- 2.4: WHEN the decimation factor would be less than 1, THE decoder SHALL clamp it to 1 (pass-through) — inherited unchanged from `IqDecimateDecoder`.
- 2.5: THE decoder SHALL NOT modify `IqDecimateDecoder`. The csdr pipeline is built unchanged by the base class.

### Requirement 3: Python wrapper demodulates with gr-lora_sdr and emits JSONL

**User story.** As a downstream consumer (WebSocket client, dashboard), I want one well-formed JSON object per decoded Meshtastic packet on stdout so I can react to packets without parsing protobuf or doing crypto.

**Acceptance criteria.**

- 3.1: THE decoder SHALL spawn `python3 /usr/local/bin/lora_meshtastic_decode.py` (path canonical inside the Docker image) with arguments `--bw <Hz> --sf <int> --cr <int> --samp-rate <effective Hz> --frequency <Hz> --channel-key <base64> --region <enum>`.
- 3.2: WHEN the wrapper starts, it SHALL read `cu8` IQ bytes from stdin in chunks, convert each chunk to `cf32` complex floats in-process (`(uint8 − 127.5) / 127.5`), and feed the `cf32` stream into a `gnuradio.lora_sdr` flowgraph (frame_sync → fft_demod → gray_mapping → deinterleaver → hamming_dec → header_decoder → dewhitening → crc_verif).
- 3.3: WHEN a LoRa frame passes CRC, the wrapper SHALL interpret it as a Meshtastic `MeshPacket` protobuf, decrypt the inner ciphertext with AES-CTR using the channel PSK + nonce derived from `packet_id` and `from`, parse the plaintext as a `Data` protobuf, and emit one JSON line on stdout with the schema in Requirement 4.
- 3.4: WHEN the configured `channelKey` is the shorthand `"AQ=="` (single byte 0x01), the wrapper SHALL expand it to the Meshtastic-defined 16-byte default-channel PSK before deriving the AES key. Non-default channels SHALL use the provided base64 16-byte PSK as-is.
- 3.5: WHEN a frame fails CRC, fails AES-CTR (any exception), or fails protobuf parsing, the wrapper SHALL log the failure to stderr (one structured line) and SHALL NOT emit a stdout line for that frame. The wrapper SHALL NOT exit on per-frame errors.
- 3.6: THE wrapper SHALL write all diagnostic / log output to stderr only. stdout SHALL contain only JSONL packet events.
- 3.7: THE wrapper SHALL flush stdout after every emitted JSON line so the TypeScript side receives packets with minimal latency.
- 3.8: THE wrapper SHALL vendor only `mesh.proto`'s compiled Python module (MeshPacket + Data). Per-app protobuf files SHALL NOT be vendored in v1.

### Requirement 4: JSONL schema for Meshtastic packets

**User story.** As a downstream consumer, I want a stable, documented JSON shape for every emitted Meshtastic packet so I can write type-safe consumers without inspecting wire-level details.

**Acceptance criteria.**

- 4.1: WHEN the wrapper emits a Meshtastic packet, the JSON object SHALL contain the following snake_case fields:
  - Header (always present): `from` (uint32), `to` (uint32), `id` (uint32), `channel` (int, channel-hash), `hop_limit` (int), `hop_start` (int), `want_ack` (bool)
  - Header (optional, present when set by the originating node): `via_mqtt` (bool), `priority` (int)
  - Payload (always present): `portnum` (int, Meshtastic PortNum enum value), `payload_b64` (string, base64 of the decrypted `Data.payload` bytes), `payload_len` (int)
  - RX metadata (always present): `rx_rssi` (int, dBm — `0` if unavailable), `rx_snr` (number, dB — `0` if unavailable), `rx_time` (string, ISO-8601 UTC), `frequency` (int, Hz, the decoder's tuned frequency from config)
  - Decoder metadata (always present): `bw` (int, Hz), `sf` (int, spreading factor), `cr` (int, 5..8 representing 4/5..4/8)
- 4.2: WHEN the TypeScript `parseOutput()` receives a stdout line, it SHALL call `parseMeshtasticPacket(JSON.parse(line))` which SHALL validate the schema (Requirement 4.3), remap snake_case keys to camelCase, and return a `MeshtasticPacket` value or `null`.
- 4.3: THE `parseMeshtasticPacket()` function SHALL return `null` (without throwing) when any required field is missing, has the wrong type, or `payload_b64` is not valid base64. When the input is `null`, an array, or a non-object, `parseMeshtasticPacket()` SHALL return `null`.
- 4.4: WHEN `parseMeshtasticPacket()` returns a non-null `MeshtasticPacket`, `parseOutput()` SHALL return a `DecoderOutput` with `type: "meshtastic"`, `decoder: this.id`, `timestamp: new Date()`, and `data: <the MeshtasticPacket>`.
- 4.5: WHEN `parseMeshtasticPacket()` returns `null` or `JSON.parse()` throws, `parseOutput()` SHALL log at debug level (with the offending line) and SHALL return `null`. `parseOutput()` SHALL NOT throw.
- 4.6: THE `MeshtasticPacket` interface SHALL be exported from `src/decoders/builtin/lora-meshtastic.ts` as a real TypeScript `interface` (not a `Record` alias), mirroring the export style of `ShipData` from `ais-catcher.ts`.

### Requirement 5: `meshtastic` is added to the DecoderOutputType union

**User story.** As a downstream TypeScript consumer, I want `DecoderOutput.type` to be a discriminator I can switch on, so I can route Meshtastic packets without runtime tag-shape inspection.

**Acceptance criteria.**

- 5.1: THE `DecoderOutputType` union in `src/decoders/types.ts` SHALL include `"meshtastic"` as a member.
- 5.2: THE union SHALL NOT include `"lora"` in v1 (raw LoRa frames are out-of-scope).
- 5.3: WHEN the decoder emits a packet, the `DecoderOutput.type` value SHALL be exactly `"meshtastic"` for every emission. No per-portnum type values are introduced in v1.

### Requirement 6: Decoder registration

**User story.** As a WaveKit operator, I want the `lora-meshtastic` type to be registered at startup so my YAML config can reference it.

**Acceptance criteria.**

- 6.1: WHEN the WaveKit process starts, `src/index.ts` SHALL register the type `"lora-meshtastic"` with factory `createLoraMeshtasticDecoder` and capabilities `LORA_MESHTASTIC_CAPS`, alongside the existing eight decoders (around lines 377-388).
- 6.2: THE registered capabilities SHALL match Requirement 2.1.
- 6.3: THE registry SHALL list `"lora-meshtastic"` in `getRegisteredTypes()` after startup.

### Requirement 7: Health & lifecycle

**User story.** As a WaveKit operator, I want the LoRa decoder to participate in the standard health, restart, and source-rate-change lifecycle so it behaves like every other decoder.

**Acceptance criteria.**

- 7.1: THE decoder SHALL inherit health transitions from `BaseDecoder`: `running` when emitting output, `idle` after `health.idleTimeout` of silence, `faulted` after exceeding restart limits.
- 7.2: WHEN the source sample rate changes (via `TunerRelay`), THE `DecoderManager` SHALL stop and restart the decoder with the new rate — the decoder SHALL NOT implement any special handling for this.
- 7.3: WHEN the decoder is stopped, the spawned `python3` process and its csdr ancestors SHALL be terminated via the standard `BaseDecoder.stop()` SIGTERM / SIGKILL escalation — inherited unchanged.

### Requirement 8: Fixture-replay test + manual smoke test

**User story.** As a WaveKit contributor, I want a deterministic test that proves the decoder end-to-end on a captured fixture, plus a documented manual smoke-test step, so I can confirm v1 works without an automated CPU gate.

**Acceptance criteria.**

- 8.1: THE repository SHALL contain a small `cu8` IQ recording at `fixtures/lora/meshtastic-sample.cu8` (target size < 5 MB) and a sidecar expected-output file at `fixtures/lora/meshtastic-sample.expected.jsonl`.
- 8.2: THE integration test at `tests/integration/lora-meshtastic.test.ts` SHALL configure a `recording` source pointing at the fixture, attach a `LoraMeshtasticDecoder` to it via the standard registry / manager, and assert that at least one emitted `DecoderOutput` matches the expected packet header from the sidecar (`from`, `id`, `portnum`, `payload_b64`).
- 8.3: THE unit tests at `tests/unit/decoders/lora-meshtastic.test.ts` SHALL cover the eight correctness properties in `design.md` using `fast-check` with `numRuns: 100` minimum. Each property test SHALL carry a reference comment in the form `// Feature: lora-meshtastic, Property N: <name>\n// Validates: Requirements X.Y, X.Z`.
- 8.4: THE `tasks.md` checklist SHALL include a manual smoke-test step: "Connect Pi to RTL-SDR with TCXO, configure region + preset, observe ≥1 Meshtastic packet decoded within 5 minutes on a known-busy preset (LongFast in EU_868 or US)." No automated CPU-budget gate is enforced.

### Requirement 9: Docker image delta

**User story.** As a WaveKit maintainer, I want the LoRa toolchain installed via a new Dockerfile stage so the image-build pattern matches the existing eight decoders.

**Acceptance criteria.**

- 9.1: THE `Dockerfile` SHALL define a new `lora-build` stage following the existing `dsd-fme-build` / `ais-catcher-build` pattern. The stage SHALL clone `tapparelj/gr-lora_sdr`, build against GNU Radio, and `make install` into `/usr/local`.
- 9.2: THE final and final-core stages SHALL `apt install python3 python3-gnuradio python3-protobuf python3-cryptography` for the gr-lora_sdr Python runtime and Meshtastic decryption/parsing.
- 9.3: THE final and final-core stages SHALL `COPY --from=lora-build` the gr-lora_sdr install artifacts and the wrapper script `docker/scripts/lora_meshtastic_decode.py` to `/usr/local/bin/lora_meshtastic_decode.py`.
- 9.4: THE final and final-core stages SHALL include the vendored Meshtastic protobuf module at a path importable by the wrapper (e.g., `/usr/local/lib/wavekit/meshtastic_proto/`), with the wrapper adding that path to `sys.path` at startup.
- 9.5: THE Dockerfile delta SHALL NOT exceed the accepted ~400-600 MB envelope. The image-verification step SHALL include `python3 -c "from gnuradio import lora_sdr; print(lora_sdr.__file__)"` to confirm install integrity.

### Requirement 10: Vendored protobuf module is reproducible

**User story.** As a WaveKit maintainer reviewing PRs, I want the committed Meshtastic protobuf Python module to be traceable to a known upstream commit, so it never silently diverges.

**Acceptance criteria.**

- 10.1: THE committed file at `docker/scripts/meshtastic_proto/mesh_pb2.py` SHALL carry a header comment of the form `# Generated from https://github.com/meshtastic/protobufs at SHA <40-char SHA>, mesh.proto only. Do not edit by hand.`
- 10.2: THE `tasks.md` checklist SHALL include a task that pins the SHA at the version current when the spec is implemented and records the regeneration command for future updates.
- 10.3: THE committed module SHALL contain only the compiled output of `mesh.proto` (the `MeshPacket` and `Data` message types). Per-app `.proto` files (`portnums.proto`, `position.proto`, `nodeinfo.proto`, etc.) SHALL NOT be vendored in v1.

### Requirement 11: Config example documentation

**User story.** As a new WaveKit operator, I want a commented-out example in `config/default.yaml` so I can see how to enable Meshtastic reception alongside an existing decoder setup.

**Acceptance criteria.**

- 11.1: `config/default.yaml` SHALL include a commented-out `lora-meshtastic` decoder block, located in the "EXAMPLE: Multi-Source Setup" section near the existing decoder examples.
- 11.2: THE example SHALL show the recommended `EU_868`-region `LongFast` setup with `channelKey: "AQ=="` (default channel) and SHALL note that the decoder can share an `iq` source with `rtl_433` on the same ISM-band dongle.
- 11.3: THE example SHALL include a one-line comment recommending TCXO for the RTL-SDR dongle (frequency stability for LoRa narrow-band).

## Out of Scope (v1)

The following are documented as **future scope** in `design.md` and SHALL NOT be implemented in v1:

- Raw LoRa PHY events (`type: "lora"`).
- LoRaWAN metadata events.
- Per-portnum payload decoding in the Python wrapper (TEXT_MESSAGE_APP, POSITION_APP, NODEINFO_APP, TELEMETRY_APP, ROUTING_APP, etc.).
- TypeScript-side enrichment of well-known portnums into typed events.
- Automated CPU-budget perf gate.
- Top-level config schema additions (a root-level `meshtastic:` block, new source kinds, etc.).
- Any network port exposed by the decoder. The contract is JSONL on stdout.
- A long-running Python service with an IPC layer. The wrapper is a stdin→stdout child process spawned per decoder instance.
