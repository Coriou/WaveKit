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
fully cover. Same count, at least one per over on carrier-bearing fixtures, at least 3 shared
overs, and edges per over within one 10 ms block plus both runs' median steady interval p99 (event
stamps are Node wall-clock times; the fake's chunk phase cancels between runs). The median
auto − manual is within 5 ms for opens and for closes, so a systematic stage-1 delay of 5 ms or
more fails (see the limitations below). Event-loop p99 is compared at steady state, over distinct
loop-meter intervals:
- **Identity.** The core exposes the latest interval and `intervals10m`, its 10 min ring count.
  That count rises by one per 2 s interval on a fresh core, so it identifies the interval. Repeated
  polls of one interval count once. Recordings without it fall back to value change, which can
  only undercount.
- **Steady.** An interval is steady when its own start is after the first over onset. The start
  is bounded by the poll before the previous interval was first seen.
- **Minimum.** At least 20 distinct steady intervals per run, else invalid: 40 s, about six over
  periods. A 130 s run gives about 60.
- **Median.** Median steady auto − median steady manual ≤ 2 ms. Single 2 s intervals carry host
  noise: the ungated am-voice, identical code in both modes, showed a 7.7 ms gap in the maxima.
- **Tail.** At most max(1, 10 %) of the steady auto intervals may exceed manual p90 + 10 ms, so a
  recurring stall fails. The same count of manual intervals against auto p90 is a control,
  reported only.
- The startup intervals and the steady p90 and max are reported only.

Then the back-chain drain of the manual run per
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

Evidence squelch is NFM only (amendment A8; the driver's gated set is checked against
`LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS` by the self-test). `autoSquelch.state` must be `off` on AM
runs and manual runs and `waiting`/`open` on NFM auto runs (reaching `open` exactly on
expected-open fixtures).

On NFM auto runs, audio played before the first over's onset (the gate opened on pre-over
noise) fails as "never opens without evidence"; it is not an invalid run.

AM auto runs keep today's stage-1 auto squelch, so they are not split into overs: a closed AM
stage 1 is not exact zeros. The -80 dBFS hold sample goes through the fast AGC and DC block and
comes out as a low-frequency residue of about -29 dBFS RMS (peak about -21 dBFS, about 80 Hz) on
the manual run too. Instead the AM auto stream must be the manual stage-1 stream, at the same
time:

- **Content.** The driver finds the auto stream in the manual one with an exact 50 ms probe, or a
  short probe within 1 LSB, searched within ±0.2 s of the arrival-time estimate, and keeps the
  best-agreeing shift. Every sample must then agree within 1 LSB.
- **Timing.** Content alignment alone would absorb a playback delay. So the content shift must
  match the shift from arrival times alone. Each run's anchor is the minimum over reads of
  (read time minus samples received / rate), mapped by the low round-trip clock probe nearest the
  fake's pacing epoch, so later wall-clock drift does not move it. The tolerance is 5 ms of
  latency-floor jitter between runs (3.5 and 4.0 ms measured), plus both probes' half round trips,
  plus both epoch brackets. It came to 7.9 ms on the 2.048 Msps csdr am-voice run, which missed by
  1.3 ms. A tolerance over 20 ms is invalid. A 50 ms or 100 ms delay fails.
- **Edges.** Larger differences are allowed only in clusters (merged across 0.1 s), at most one
  per over edge. A cluster's start and its largest difference must lie inside the window from the
  earlier to the later of the two runs' edge stamps, widened by the edge slack. Edge stamps are the
  open at `startedAt` and the close at `startedAt` + `durationMs` + hang. Past the window the
  difference may only decay through the back chain's memory: each 10 ms block stays under the
  in-window peak × 0.7ⁿ⁺¹. The measured decay was 0.607 per block (τ 20 ms) on am-voice, whose one
  cluster is 165 ms long with a 6-block tail.
  - Edges are placed per over from that over's open step in the manual stream: the residue, then
    a clip to full scale as the first open block meets the AGC at full gain. A rise of up to 5 ms
    is allowed. On the tiled am-carrier golden the locator finds every over within 10 ms. The AM
    golden does not correlate with the live chain.
  - The slack is 10 ms squelch block + one fake send chunk (event stamps move against stream
    samples by the chunk phase) + 10 ms: 84 ms at 2.048 Msps. The am-voice cluster started 30 ms
    from its close edge.

Evidence gating (which mutes at least the 1 s voice window of every over), a pre-roll delay or an
interior mute fails. AM runs have no onset, playback or delay verdict and no drain measurement,
because the close guard belongs to the NFM evidence gate. Byte rate, transmission events and p99
are judged as on NFM. A missing or empty AM stream, missing open steps, or an epoch with no probe
within 5 s is invalid.

`--replay` judges every fixture directory, even when an earlier one is invalid or unreadable (a
missing `stream.s16le`, observations that are not a JSON object, or malformed fields). Each fixture
prints PASS, FAIL or INVALID, and `verdicts.json` records it.

Known limitations of the fake-link check:

- **AM decay rule.** It can be fooled by an engineered, slowly decaying mute behind an in-window
  peak. The fake-link AM check is a smoke test. The authoritative AM identity proof is the
  unit-level frozen-code hash regression (design, property 12).
- **Stage-1 edge limit.** The per-over limit (one block plus both runs' median steady p99) is
  empirical, not a validated timing-error bound.
- **Small stage-1 delays.** A systematic stage-1 delay under 5 ms passes the bias check.
  Requirement 1.6 (stage-1 open and close times as today) rests on the deterministic unit goldens.

Missing timing evidence (no source clock, sidecar onset, clock probe, WebSocket span, status
state, stage-1 transmission for played audio, a closed over without a played tail) and a stream or WebSocket that ends before the
run are invalid. Exit codes: 0 pass, 1 fail, 2 invalid.
