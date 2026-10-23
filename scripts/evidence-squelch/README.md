# Evidence squelch fixtures

Synthetic fixtures for the evidence squelch (`docs/specs/evidence-squelch/`, design section
Meter equivalence; requirements 5.1 and 8.1). They are not RF recordings. Every fixture is
generated from a fixed seed with the Python standard library; the two POCSAG fixtures reuse
the bit layer of `fixtures/generators/pocsag.py`, which needs numpy.

## Files

- `fixtures.py`: the generator. `FIXTURES` holds the manifest (mode, expected squelch result,
  analyzer verdict, seed). Each fixture is one over that starts `OVER_ONSET_S` (0.25 s) into a
  4 s file, on a noise floor of 0.003 (per component) under a 0.5 carrier.
- `goldens.py`: runs `wavekit-iqcap analyze` on each 48 kHz input and writes the goldens.
- `tests/mocks/fixtures/evidence-squelch/`: committed goldens. Per fixture, the analyzer's
  8 kHz s16le audio (`<name>.audio.s16le`, 64 000 bytes, 4 s) and its JSON line
  (`<name>.stats.json`, about 9 KB, 80 frames), plus `manifest.json`. About 1.17 MB in total.

CU8 files for the fake `rtl_tcp` are generated on demand into `output/evidence-squelch/`
(git-ignored) and never committed.

## Commands

```bash
python3 -I scripts/evidence-squelch/fixtures.py --self-test        # prints ok (about 2 min)
make chan-build                                                     # builds wavekit-iqcap
python3 -I scripts/evidence-squelch/goldens.py --out tests/mocks/fixtures/evidence-squelch
python3 -I scripts/evidence-squelch/fixtures.py --format cf32 --rate 48000 --out <dir>
python3 -I scripts/evidence-squelch/fixtures.py --format cu8 --rate 2048000 \
	--out output/evidence-squelch/cu8 --gap-s 3 [--fixture <name>]
```

A CU8 file is `--gap-s` of noise followed by the 3.75 s over (linear interpolation from
48 kHz), so a looped file has `--gap-s` of silence between overs. The sidecar
`<name>.<rate>.cu8.json` records the over onset in the file. Generation takes about one
minute per fixture and rate.

`goldens.py` exits non-zero on an analyzer reject, a golden over 64 KiB, or a fixture whose
medians do not give its manifest verdict. That check mirrors `isVoice` (median syllabic
≥ 0.3 and median audio ≥ −30 dB) and the data-like rule (median cluster ≥ 0.6) of
`src/core/scanner/analog-trial.ts`; the meter equivalence test is the authority.

## Analyzer verdicts

Medians over the 80 frames of each golden, as produced by `goldens.py`:

| Fixture                 | Mode | Expect | Verdict   | audioDb | syllabic | cluster |
| ----------------------- | ---- | ------ | --------- | ------: | -------: | ------: |
| nfm-ctcss-670-voice     | nfm  | ctcss  | voice     |   −14.4 |      0.6 |     0.3 |
| nfm-ctcss-1000-voice    | nfm  | ctcss  | voice     |   −15.0 |      0.6 |     0.3 |
| nfm-ctcss-2503-voice    | nfm  | ctcss  | voice     |   −16.0 |      0.6 |     0.3 |
| nfm-dcs-023n-voice      | nfm  | dcs    | voice     |   −15.2 |      0.6 |     0.3 |
| nfm-dcs-754i-voice      | nfm  | dcs    | voice     |   −15.7 |     0.65 |     0.3 |
| nfm-voice               | nfm  | voice  | voice     |   −14.9 |      0.6 |     0.2 |
| am-voice                | am   | voice  | voice     |   −15.7 |      0.7 |     0.0 |
| nfm-carrier             | nfm  | none   | neither   |   −59.8 |      0.0 |     0.0 |
| am-carrier              | am   | none   | neither   |   −19.3 |      0.1 |     0.0 |
| nfm-dmr-4fsk            | nfm  | none   | data-like |    −9.7 |      0.0 |     0.8 |
| nfm-pocsag-512          | nfm  | none   | data-like |    −1.7 |      0.1 |     1.0 |
| nfm-pocsag-1200         | nfm  | none   | data-like |    −0.2 |      0.1 |     1.0 |
| nfm-clicks              | nfm  | none   | neither   |   −59.1 |      0.8 |     0.0 |
| nfm-impulse             | nfm  | none   | neither   |    −0.5 |      0.0 |     0.3 |
| nfm-noise               | nfm  | none   | neither   |   −0.45 |      0.0 |     0.3 |
| nfm-fsk-syllabic-bursts | nfm  | voice  | voice     |    −5.6 |      0.7 |     0.3 |

Synthesis parameters adjusted during generation (thresholds unchanged): voice is scaled to
an RMS of 0.35 over its syllables and soft-limited, with shorter pauses; DCS deviation is
400 Hz (at 600 Hz the DCS fixtures' median cluster reached 0.6, data-like); DMR uses
rectangular symbols with both TDMA slots keyed (with a one-symbol moving-average pulse and
only one slot keyed the median cluster was 0.3 to 0.4). The clicks fixture is `neither`
because most 50 ms frames hold no click, so the median audio power stays at the floor.

`nfm-fsk-syllabic-bursts` is a known limitation, marked `"knownLimitation": true` in the
manifest: 1 200 baud Bell 202 AFSK keyed 100 ms on, 100 ms off on a quiet NFM carrier. The
audio-frequency tones do not cluster in the discriminator and the 5 Hz keying reads as
syllables, so the pinned scanner judge calls it voice and the evidence gate opens on it.
Its manifest `expect` and `verdict` are therefore `voice`.
