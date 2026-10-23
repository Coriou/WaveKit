# Evidence squelch fixtures

Synthetic fixtures for the evidence squelch (`docs/specs/evidence-squelch/`, design section
Meter equivalence; requirements 5.1 and 8.1). They are not RF recordings. Every fixture is
generated from a fixed seed with the Python standard library; the POCSAG bit layer is a
standard-library port of `fixtures/generators/pocsag.py` (the self-test compares the two
when numpy is importable).

## Files

- `fixtures.py`: the generator. `FIXTURES` holds the manifest (mode, expected squelch result,
  analyzer verdict, seed). Each fixture is one over that starts `OVER_ONSET_S` (0.25 s) into a
  4 s file, on a noise floor of 0.003 (per component) under a 0.5 carrier.
- `goldens.py`: runs `wavekit-iqcap analyze` on each 48 kHz input and writes the goldens.
- `tests/mocks/fixtures/evidence-squelch/`: committed goldens. Per fixture, the analyzer's
  8 kHz s16le audio (`<name>.audio.s16le`, 64 000 bytes, 4 s) and its JSON line
  (`<name>.stats.json`, about 9 KB, 80 frames), plus `manifest.json`. About 1.25 MB in total (17 fixtures).

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

Whole-file medians (80 frames) and the verdicts of the 61 rolling 20-frame windows
(requirement 1.3 judges 1 s), as printed by `goldens.py`. Frames 0 to 4 precede the over.

| Fixture                 | Expect | File      | audioDb | syllabic | cluster | Windows voice / data-like / neither |
| ----------------------- | ------ | --------- | ------: | -------: | ------: | ----------------------------------- |
| nfm-ctcss-670-voice     | ctcss  | voice     |  −14.35 |      0.6 |     0.3 | 61 / 0 / 0                          |
| nfm-ctcss-1000-voice    | ctcss  | voice     |   −15.0 |      0.6 |     0.3 | 61 / 0 / 0                          |
| nfm-ctcss-2503-voice    | ctcss  | voice     |  −15.95 |      0.6 |     0.3 | 61 / 0 / 0                          |
| nfm-dcs-023n-voice      | dcs    | voice     |   −15.2 |      0.6 |     0.3 | 61 / 0 / 0                          |
| nfm-dcs-754i-voice      | dcs    | voice     |  −15.65 |     0.65 |     0.3 | 61 / 0 / 0                          |
| nfm-voice               | voice  | voice     |  −14.85 |      0.6 |     0.2 | 61 / 0 / 0                          |
| am-voice                | voice  | voice     |   −15.7 |      0.7 |     0.0 | 61 / 0 / 0                          |
| nfm-carrier             | none   | neither   |   −59.8 |      0.0 |     0.0 | 0 / 0 / 61                          |
| am-carrier              | none   | neither   |   −19.3 |      0.1 |     0.0 | 10 / 0 / 51 (risk, windows 13-22)   |
| nfm-dmr-4fsk            | none   | neither   |   −2.85 |      0.1 |     0.3 | 0 / 0 / 61                          |
| nfm-dmr-4fsk-continuous | none   | data-like |    −9.8 |      0.0 |     0.8 | 0 / 61 / 0                          |
| nfm-pocsag-512          | none   | data-like |    −1.7 |      0.1 |     1.0 | 0 / 61 / 0                          |
| nfm-pocsag-1200         | none   | data-like |    −0.2 |      0.1 |     1.0 | 0 / 61 / 0                          |
| nfm-clicks              | none   | neither   |   −59.1 |      0.8 |     0.0 | 3 / 2 / 56 (risk, windows 0-2)      |
| nfm-impulse             | none   | neither   |    −0.5 |      0.0 |     0.3 | 0 / 0 / 61                          |
| nfm-noise               | none   | neither   |   −0.45 |      0.0 |     0.3 | 0 / 0 / 61                          |
| nfm-fsk-syllabic-bursts | voice  | voice     |    −5.6 |      0.7 |     0.3 | 44 / 0 / 17 (known limitation)      |

`rollingWindowRisk` in `manifest.json` lists every voice-positive window of a never-open
fixture with its medians. These are findings, not tuned away:

- `am-carrier`: the AM chain is `|x|`, DC block, then the fast AGC (reference 0.4). After
  the DC block only the carrier's noise envelope is left, and the AGC raises its gain over
  about 1.5 s after key-up: audio power climbs from −52 dB (frame 6) to its −19 dB steady
  state (frame 33). The windows over that ramp see a rising envelope (syllabic 0.3 to 1.9)
  with median audio above −30 dB, so they judge voice. Steady state is `neither`.
- `nfm-clicks`: windows 0 to 2 contain the five unquieted noise frames before the over
  (audio about −0.5 dB) and the key-up step, which lift both medians over the voice
  thresholds.

`nfm-dmr-4fsk` is the design's shaped burst case (root-raised-cosine, alpha 0.2, 30 ms
bursts every 60 ms). The design expects data-like; the analyzer measures `neither`, because
the noise-only gaps keep most 50 ms frames from clustering. The manifest records the
measured verdict. `nfm-dmr-4fsk-continuous` (rectangular symbols, both slots keyed) is
data-like.

`nfm-fsk-syllabic-bursts` is a known limitation, marked `"knownLimitation": true` in the
manifest: 1 200 baud Bell 202 AFSK keyed 100 ms on, 100 ms off on a quiet NFM carrier. The
audio-frequency tones do not cluster in the discriminator and the 5 Hz keying reads as
syllables, so the pinned scanner judge calls it voice. Its `expect` and `verdict` are `voice`.

Synthesis choices made while generating (thresholds unchanged): voice is scaled to an RMS of
0.35 over its syllables and soft-limited, with short pauses; DCS deviation is 400 Hz. The
clicks fixture is `neither` over the whole file because most 50 ms frames hold no click.

## Fake-link acceptance

`run_acceptance.py` runs each fixture twice, `squelchMode: auto` and a `manual` baseline
(−40 dBFS), on the same looped CU8 file (generated into `<out>/cu8` with a 3 s gap when
missing). Every run is its own scratch Compose project `wkevs-<pid>` (`compose.yaml`): an
internal network, the fake `rtl_tcp` at `fake:1234` replaying the file
(`scripts/capacity/fake_rtl_tcp.py --file <cu8> --loop`), the core image from
`EVIDENCE_SQUELCH_IMAGE` (default `wavekit:latest`; the script never builds or pulls it) and a
forwarder that publishes the API and the audio stream on two `127.0.0.1` ports the driver picks
from 47100-47999 (a range that excludes every port of the live setup). Both published endpoints
are checked (host `127.0.0.1`, the requested port, inside the range) before any client starts;
anything else is an invalid run.
`config.yaml` is copied per run; only the lines marked `driver:` change (rate, modulation,
squelch mode, engine). Containers, networks and volumes are removed in a `finally`.

```bash
python3 -I scripts/evidence-squelch/run_acceptance.py --self-test   # verdicts on synthetic observations, no Docker
python3 -I scripts/evidence-squelch/run_acceptance.py --rate 2048000 --engine csdr --fixture all \
	--out output/evidence-squelch/2048000-csdr [--cpu-quota 0.75]
python3 -I scripts/evidence-squelch/run_acceptance.py --replay output/evidence-squelch/2048000-csdr
```

Recorded per run (`<out>/<fixture>/<mode>/`): `/stream.wav` bytes with arrival times,
`live-audio:level` and `live-audio:transmission` events with the WebSocket recording span, status
samples, the event-loop p99 of the link-quality report, the fake source's pacing epoch (`epochTs`) from
its log, and wall-clock probes of the forwarder (a third published port). Timing is measured on
the source clock: over k starts at the fake's pacing epoch (`epochTs`) plus the sidecar over onset plus k file
periods. Host times are mapped onto the containers' wall clock by the probe with the smallest
round trip (at most 20 ms; error at most half of it). Event `startedAt` gives a transmission's
start; its announcement is late on purpose (qualification and hang) and is never used for
timing.

Verdicts: opened or not per expectation; on NFM, first played sample within 20 ms of the over
onset (normalised cross-correlation with the analyzer golden, after windowed-sinc resampling of
the stream to 8 kHz from the exact status rate, e.g. 24 975.61 Hz at 2.048 Msps; the kernel is
symmetric, so it adds no delay); every complete over of the stream recording played exactly
once, each on a stage-1 transmission of that over; per played over, the delay of its first and
last sample behind the source ≤ 1.5 s; byte rate within 0.5 % of nominal per minute;
transmission events equal to the manual run per over over the overs both WebSocket recordings
fully cover (open and close within 10 ms, same count, at least one per over on carrier-bearing
fixtures, at least 3 shared overs); p99 within 2 ms of manual; the back-chain drain of the manual run per
over as an interval that holds the true drain (arrival of the last audible sample minus the
stage-1 close). Upper bound: the close is at least carrier-off (sidecar, source clock) + hang −
one 10 ms squelch block − one fake send chunk (262 144 bytes: 64.0 ms at 2.048 Msps, 54.6 ms at
2.4 Msps) − the bracket of the fake's logged pacing epoch (`epochTs ± epochErrS` on its `connected`
line; missing or wider than 5 ms is invalid) − the largest wall-clock movement seen over the
run (clock probes at least every 5 s and the fake's `progress` wall ts against its paced
elapsed time; more than 25 ms beyond their uncertainty, such as a clock step, is invalid), plus the probe's half round trip. Lower bound: the
close is at most the first `live-audio:level` receipt with `squelchOpen` false (host clock on
both sides). The close event's `endedAt` and its announcement are reported only. Max and median
of both bounds are reported against `CLOSE_GUARD_MS`, flagged `EXCEEDS GUARD` on the upper max.
A non-squelch close reason, two closes in one over, or no observed open-then-closed level is
invalid.

Evidence squelch is NFM only. `autoSquelch.state` must be `off` on AM runs and manual runs and
`waiting`/`open` on NFM auto runs (reaching `open` exactly on expected-open fixtures). AM auto
runs use today's stage-1 auto squelch: `am-voice` and `am-carrier` both open on the carrier and
play every over, with no onset (pre-roll) check.

Missing timing evidence (no source clock, sidecar onset, clock probe, WebSocket span, status
state, stage-1 transmission for played audio, a closed over without a played tail) and a stream or WebSocket that ends before the
run are invalid. Exit codes: 0 pass, 1 fail, 2 invalid.
