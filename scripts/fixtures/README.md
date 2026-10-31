# Synthetic fixture generators

These scripts made the committed synthetic LoRa/Meshtastic and APRS fixtures in
`fixtures/lora/` and `fixtures/aprs/`. Every identifier is fictional (callsign
`N0CALL`, made-up node and packet ids, the public default Meshtastic key), and the
noise uses fixed seeds, so a rerun reproduces the files.

| Script                            | Writes                                                            | Needs                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `gen_lora.py OUTDIR`              | `meshtastic_onair_frame.bin`, six `lora_longfast_*.cu8`           | gnuradio + gr-lora_sdr TX blocks, numpy, scipy, python3-cryptography, the vendored `mesh_pb2` (the core image) |
| `gen_aprs.py OUTDIR`              | `aprs_msg.txt`, `aprs_afsk1200_48k.wav`, four `aprs_144800_*.cu8` | direwolf's `gen_packets`, numpy, scipy                                                                         |
| `chan_emul.py FILE.cu8 OFFSET_HZ` | cf32 48 kHz channel IQ on stdout                                  | numpy, scipy                                                                                                   |

Run them inside the core image with an output directory mounted, never against a live
receiver. Only part of the output is committed; the rest is small to regenerate:

- `fixtures/lora/`: `lora_longfast_dc_snr10.cu8`, `lora_longfast_dc_snrm5.cu8`,
  `meshtastic_onair_frame.bin`
- `fixtures/aprs/`: `aprs_144800_c144600_cnr20.cu8`, `aprs_afsk1200_48k.wav`,
  `aprs_msg.txt`

Each directory's `SHA256SUMS` records the committed files, and
`tests/unit/decoders/lora-meshtastic-wrapper.test.ts` checks them. A different numpy,
scipy or gr-lora_sdr build can change the last bits of a float and so a checksum. If
that happens, regenerate, check that the decodes still pass, and update `SHA256SUMS`.

## How the LoRa capture is built

`gen_lora.py` encrypts `Data{portnum: 1, payload: "hello wavekit"}` with AES-128-CTR. The
key is the expanded `AQ==` channel PSK and the nonce is the packet id (u64 LE), then the
sender (u32 LE), then four zero bytes. The 16-byte on-air header `<IIIBBBB>` goes in
front: to `0xFFFFFFFF`, from `0x0A1B2C3D`, id `0x12345678`, flags `0x63` (hop limit 3,
hop start 3), channel hash `0x08`. The script modulates the frame with the gr-lora_sdr
TX chain (whitening with hex input, explicit header with CRC, CR 4/5, SF11, BW 250 kHz,
sync word `0x2B`, 8-symbol preamble) at 2 Msps. It then resamples 64/125 to 1.024 Msps,
pads 0.25 s of silence on each side and scales the signal to 0.35 of full scale. Last,
it adds complex Gaussian noise at the stated SNR, measured in the 250 kHz LoRa
bandwidth.

## How the APRS capture is built

`gen_aprs.py` renders `N0CALL-1>APRS,WIDE1-1:!4903.50N/07201.75W-WaveKit synthetic test` with
`gen_packets -r 48000 -a 100`. It pads the audio with 0.1 s on each side and normalises
it. It then FM-modulates the audio at 3 kHz peak deviation into 1.024 Msps, at +200 kHz
(centre 144.6 MHz, channel 144.8 MHz) or at 0 Hz. Last, it adds noise at the stated
CNR, measured in 12.5 kHz.
