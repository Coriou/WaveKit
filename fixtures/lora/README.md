# LoRa/Meshtastic Fixture

This directory reserves the deterministic fixture path for the LoRa/Meshtastic decoder integration test.

The committed `meshtastic-sample.cu8` is a tiny placeholder, not a valid RF capture. The integration test is skipped unless all runtime dependencies exist and `meshtastic-sample.real-fixture` is present, so the placeholder never passes as a real decoder proof.

## Real Fixture Regeneration

Use a TCXO RTL-SDR and a known-busy Meshtastic default-channel node:

```bash
rtl_sdr -f 869525000 -s 2048000 -g 40 fixtures/lora/meshtastic-sample.cu8
head -c 5242880 fixtures/lora/meshtastic-sample.cu8 > /tmp/meshtastic-sample.cu8
mv /tmp/meshtastic-sample.cu8 fixtures/lora/meshtastic-sample.cu8
```

Then decode the capture inside an image with gr-lora_sdr and the wrapper installed, and write one expected wire-shape JSON object per decoded packet to `meshtastic-sample.expected.jsonl`. The integration test compares `from`, `id`, `portnum`, and `payload_b64`.

Create the marker only after replacing the placeholder with a real capture:

```bash
touch fixtures/lora/meshtastic-sample.real-fixture
```

Recommended default-channel EU_868 setup:

- Region: `EU_868`
- Preset: `LongFast`
- Frequency: `869525000`
- Channel key: `AQ==`
- Expected packet count: at least 1

## Manual Pi Smoke Test

Use a Raspberry Pi 4 with a TCXO RTL-SDR and a known-busy Meshtastic default channel.

1. Enable the commented `lora-meshtastic` decoder example in `config/default.yaml`.
2. Set the local region and primary frequency (`EU_868` at `869525000` Hz, or the matching regional primary frequency).
3. Keep `preset: "LongFast"` and `channelKey: "AQ=="` for the default channel.
4. Start WaveKit and subscribe to the `decoders` WebSocket channel.
5. Verify at least one `type: "meshtastic"` packet within 5 minutes.
6. Verify decoder health reaches `running` and record approximate CPU usage alongside any other enabled decoders.
