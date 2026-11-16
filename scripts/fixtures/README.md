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

`bench_lora_chain.py` is not a generator: it runs both committed LoRa captures through
the decoder's sox and wrapper stages for several oversampling factors and sox settings,
and prints decodes and per-stage CPU per second of signal. It needs the core image too.

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

## Bit-level frame generators (JavaScript)

These modules write no files; the chain tests call them. Each builds one valid
transmission at the bit level (sync, framing, CRC/FEC, interleaving, scrambling)
with made-up identities, and `fsk-iq.mjs` turns its symbols into FM deviation and
cu8 IQ at any rate and offset, with seeded noise (or noise at a given CNR in
12.5 kHz). Voice payloads are seeded noise. `fsk-iq.mjs` `AIR_SHAPES` holds each air
interface's own transmit filter (P25 raised cosine 0.2 times x / sin x, DMR, dPMR and
YSF root raised cosine 0.2, NXDN root raised cosine 0.2 times x / sin x, and the
MMDVM P25 raised cosine 0.2); the generators take it as `shape`, and default to an
easier raised cosine 0.5.

| Module           | Transmission                                                                                          | Checked against                    |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `aprs-afsk.mjs`  | AX.25 UI frame, Bell 202 AFSK                                                                         | multimon-ng AFSK1200, direwolf     |
| `flex-fsk.mjs`   | FLEX 1600/2 frame, one alphanumeric page                                                              | multimon-ng `demod_flex.c`         |
| `dstar-gmsk.mjs` | D-STAR radio header and voice superframes with slow-data header                                       | dsd-fme `dstar*.c`                 |
| `p25-c4fm.mjs`   | P25 phase 1 LDU1 frames (group voice LC) and TDU                                                      | dsd-fme `p25p1_*.c`                |
| `ysf-c4fm.mjs`   | YSF header, V/D type 2 frames and terminator                                                          | dsd-fme `ysf.c`                    |
| `nxdn-4fsk.mjs`  | NXDN48/96 FACCH1 VCALL frames and voice SACCH superframes                                             | dsd-fme `nxdn_*.c`                 |
| `dpmr-4fsk.mjs`  | dPMR voice superframes (IDs, channel code)                                                            | dsd-fme `dpmr_voice.c`             |
| `dmr-4fsk.mjs`   | DMR repeater downlink: Voice LC headers, voice superframes with embedded LC, terminators, Idle slot 2 | dsd-fme `dmr_bs.c`, `dmr_dburst.c` |
| `dmr-4fsk.mjs`   | DMR direct mode (`dmrDirect*`): the same call with MS syncs, one keyed 27.5 ms burst per 60 ms        | dsd-fme `dmr_ms.c`                 |

`tests/integration/synthetic-frames.test.ts` runs them through wavekit-chan and the
adapters' production command lines, and `tests/integration/dsd-fme-margin.test.ts`
measures dsd-fme's frame and symbol error rates against CNR and carrier frequency error with them (`fmCu8` keys the carrier with an `envelope` for TDMA bursts); `tests/mocks/fixtures/synthetic/` holds the
decoder output they produced, replayed by `tests/unit/decoders/synthetic-decoder-lines.test.ts`.

## Transmission plans (digital voice capture)

The generators above are kind to the decoder: settle bursts, duplicate headers and a
0.1 s lead before each transmission. `dv-plan.mjs` is not. `transmissionPlan(overs,
{ protocol })` lays out overs `{ startMs, durationMs, slot?, ids? }` with a true key-up
and key-down, carrier off (noise only) between them, for DMR, D-STAR, YSF, P25, NXDN48
and dPMR. DMR runs direct (one keyed burst per 60 ms) or through a repeater (CACH, idle
slot, `hangMs` of idles after an over). A DMR over can start mid-superframe
(`lateEntry`) or lose its terminator (`terminator: false`). The other generators take
`coldKeyUp: true` for the same key-up, and their defaults are unchanged. The plan is the
truth: it returns each over as sent (start, end, slot, identities, checked frames), and
`DV_SCENES` lists the scenes of the capture grid.

`tests/integration/dv-capture.test.ts` feeds the scenes through wavekit-chan, sox and
dsd-fme at real time and scores the adapter's calls per over (`WAVEKIT_DVCAP=1`, in the
core image). `dv-latency-seeds.mjs` writes the line timings the truth scorecard's
digital voice scenes replay (`tests/mocks/fixtures/synthetic/dv-latency-*.json`). They
are provisional: they model the current adapter's inputs, not a recorded run. A capture
run with `WAVEKIT_DVCAP_LINES=<dir>` writes recorded ones in the same format. Each over
carries `nominalMs`, the length the plan asked, so the scorecard's `dvMissedLong` counts
missed overs asked for 1 s or more (gated at 0). One more seed, `noise-sync`, has no over,
only stray DMR, D-STAR and P25 syncs (`noiseSeed`): `dvFalse` counts the identity-less
calls that hold no over (gated at 0). A grid run stops after three
consecutive points fail with the same error, and its summary rows count the points
whose decoder was killed by a signal.

When the recorded baseline is committed, delete the provisional
`dv-latency-*.json` seeds in the same commit (a provisional seed left beside
the recorded ones is still scored, so modelled timings would mix with measured
ones), drop them from `DV_SEED_SCENES`, and recalibrate the `dv*`
limits in `scripts/bench/scanner-quality/truth-thresholds.json` to what the
recorded seeds score: the current limits are the modelled seeds' numbers.
