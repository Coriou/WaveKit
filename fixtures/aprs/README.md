# APRS fixtures

These synthetic APRS fixtures are made by `scripts/fixtures/gen_aprs.py` (see
`scripts/fixtures/README.md`). They are fictional (callsign `N0CALL`) and safe to commit.
`SHA256SUMS` holds their checksums.

| File                            | Content                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `aprs_msg.txt`                  | The TNC2 packet text                                                                               |
| `aprs_afsk1200_48k.wav`         | `gen_packets` AFSK1200 audio, 48 kHz mono s16                                                      |
| `aprs_144800_c144600_cnr20.cu8` | 0.92 s of cu8 at 1.024 Msps, centre 144.6 MHz, APRS at 144.8 MHz (+200 kHz), CNR 20 dB in 12.5 kHz |

Expected decode: one frame, `N0CALL-1>APRS,WIDE1-1:!4903.50N/07201.75W-WaveKit synthetic test`.
Use `offsetHz: 200000` for the cu8 capture. On the channelizer path, `chan_emul.py` gives
an approximate channel tail. In an image bench, direwolf decoded every clean case (the
WAV, the shifted cu8 at CNR 20 dB and the channel tail). Both paths start decoding at
about 10–12 dB CNR.
