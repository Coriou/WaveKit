# LoRa/Meshtastic fixtures

These synthetic captures are made by `scripts/fixtures/gen_lora.py` (see
`scripts/fixtures/README.md`). They are fictional and safe to commit. `SHA256SUMS` holds
their checksums.

| File                         | Content                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `meshtastic_onair_frame.bin` | The 33 on-air bytes: a 16-byte header, then the encrypted `Data`                   |
| `lora_longfast_dc_snr10.cu8` | 0.91 s of cu8 at 1.024 Msps, centre = channel (869.525 MHz), SNR +10 dB in 250 kHz |
| `lora_longfast_dc_snrm5.cu8` | The same frame at SNR −5 dB                                                        |

Expected decode (LongFast, `EU_868`, channel key `AQ==`): one packet with from
`169552957`, to `4294967295` (broadcast), id `305419896`, hop limit 3, hop start 3,
channel hash 8, portnum 1, and payload `hello wavekit` (`payload_b64`
`aGVsbG8gd2F2ZWtpdA==`).

Tests:

- `tests/unit/decoders/lora-meshtastic-wrapper.test.ts` (runs in CI) checks the
  checksums and decrypts the frame with Node's crypto. It also runs the wrapper's
  Python self-test, `tests/unit/decoders/test_lora_meshtastic_decode.py`. The decrypt
  cases need the `cryptography` and `protobuf` Python modules and skip without them.
- `tests/integration/lora-meshtastic.test.ts` is the opt-in full chain. It runs both
  captures through the exact `LoraMeshtasticDecoder.getArgs()` pipeline, sox and then
  gr-lora_sdr. Run it in the core image:

  ```bash
  WAVEKIT_LORA_CHAIN=1 pnpm exec vitest run tests/integration/lora-meshtastic.test.ts
  ```

With the signal 200 kHz off centre, the same frame does not decode: the decoder demodulates
only the capture centre.
