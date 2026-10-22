# Scanner redesign requirements (WG12)

Status: implemented; live acceptance pending. See [design](design.md) and
[tasks](tasks.md).

## Scope

The scanner finds, identifies and decodes what the user hears, and says nothing it cannot
prove. Driven by a live PMR446 watch on the WG11 base and by the founding use case (a signal
seen on the waterfall is named by every decoder that can name it). This spec covers:

- a window that fits the scope stays tuned (no periodic retune, stable track ids, no tuned-card
  flicker);
- a channel-matched detector with a minimum duration and an SNR margin, so noise never becomes
  a discovery;
- labels taken only from trial evidence, with a per-transmission proof and a weak-activity
  filter;
- in scans, confirmation through IQ capture and replay first (live probes for transmissions
  still on air and for identity follow-up);
- an analog replay trial (FM voice heard, CTCSS/DCS, data-like, carrier only) through a Rust
  NFM/AM demodulator kernel;
- identify until a transmission arrives, "Decode here", automatic evidence from the live-audio
  channel, the tone on the live-audio status, and a missing decoder reported as unavailable;
- a scan UX contract for the web (what the scan is doing, what it found, the evidence);
- IQ capture and replay on by default in protected mode once live acceptance passes;
- a profiling task that decides, by a stated gate, whether a Rust detector frame engine joins
  this batch.

It supersedes these sections of the frozen master design
([2026-10-09 scanner design](../../superpowers/specs/2026-10-09-signal-discovery-scanner-design.md)):
§ 4.5 (the per-bin detector as the surfacing test, and the surfacing rules: two blocks, 6 dB in
sweeps, three repeated single blocks), § 10.2 (a single-hop sweep that re-tunes its only hop
each pass), § 6.2 (the spectral tier naming a displayed protocol) and § 7.3 (a prior-only
hypothesis raising a discovery to `candidate`). Everything else in the master design and in
WG7 to WG11 stands.

Out of scope: web UI and CLI features (contract, coordination note text and the CLI guard
widening only); "Decode as" (forcing a decoder at a frequency) and the S2/S3 listen-scan
(WG13); the channelizer (stays off); drag retune, zoom and a wide panorama (WG13); the Rust
NFM/AM demodulator itself (its own spec, [rust-demod-a](../rust-demod-a/requirements.md), this
spec consumes its kernel); a new npm dependency; the access default (`legacy`); the files pinned
by the band-plans spec (`src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`,
`src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`); decryption or
key handling of any kind.

Preserved (no lane changes them): every REST route and WebSocket event type; the job
lifecycle, states and pause reasons; takeover, impact, lease and tuner restore; every
`ScanJobSpec` field (stored and posted bodies stay valid); per-range settings and the range
lock rules; `signalsOnly`; lockouts skipping sweeps; hit statistics; the identify contract
(outcomes including `heard`, the `replay` transport, artefact answers, known protocol first with
its two-miss decay, `decodersUnavailable`); the WG11 capture flow
(capture → queue → replay trials → result → discard) and every WG11 capture security bound;
(`sourceId`, `trackId`) keying and the `spectrum:frame` format; one discovery per emitter; the
scanner store CPU budgets; the passive guard semantics; the burst `capture` fixtures option;
identifiers stay on the host.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access or data research. Tests use fake decoders, fake child processes
or local stand-in processes, a fake rtl_tcp server on an ephemeral 127.0.0.1 port (port 0),
temporary directories, synthetic IQ and audio, and injected clocks; no test opens a socket to
anything but 127.0.0.1 and none uses ports 9000, 5173, 15555, 15556 or 18080. Only Main runs
the live acceptance (section 11).

**Defaults.** With the shipped config and no new key set, every route, frame, log line, argv
and receiver write is byte-identical to the WG11 base except these deliberate changes:

- 1.1, 1.2: a job whose hop plan has one hop tunes once and parks: no periodic retune, no new
  epoch, no `retune` close of open observations; `sweepPeriodMs` is null while parked; a
  same-centre retune by the lease holder writes nothing.
- 1.4: a multi-hop sweep never re-tunes the hop it is on (a revisit of the current hop
  continues the visit).
- 2.1–2.6: discoveries are created only from tracks that passed the channel gate (the old
  surfacing rules are gone); `spectrum:frame` `surfaced` means "passed the channel gate" and
  frame tracks carry the new optional `gate` and `channelSnrDb` fields.
- 3.1–3.3: a new discovery's `protocol` is `unknown` until trial evidence names something; a
  prior-weighted hypothesis no longer sets `protocol` or raises the ladder; the "Maybe X" labels
  and the alphabetical tie are gone. Stored records are not migrated.
- 3.5, 3.6: `Discovery` and `Observation` carry the optional derived `proof` and
  `evidenceLevel` fields.
- 4.1–4.3: live confirm holds and offset probes run only for gated tracks; with capture enabled
  a scan or passive job confirms through replay first.
- 4.5: a probe decoder whose program is missing is reported as unavailable on the probe path
  (was `no-sync`).
- 7.1–7.5: `ScanJobProgress` and `scanner:progress` carry the optional `phase`, `parked`,
  `holding`, `trial` and `replayQueueDepth` fields; `scanner:discovery` `merged` events carry
  `mergedIds`.
- 8.1 (final task, only after live acceptance passes): `scanner.iqCapture` absent or without
  `enabled` means capture and replay **on** in protected mode; legacy mode needs the explicit
  `scanner.iqCapture.allowLegacy: true`. Until that task lands, capture stays off by default
  exactly as in WG11, and the analog replay trial (section 5) runs only where capture is
  enabled.

New request and query fields (`waitUntilSignal`, `waitMs`, `evidence`, `nearHz`,
`toleranceHz`) are optional; absent, the answer is today's. Each lane proves the rest against
goldens recorded from the frozen code and lists every golden it changes with the requirement
that changes it. Every hot-path item states its pipeline position and CPU budget in the design;
every new bound states its arithmetic and has a test at the bound and one past it.

Background (generic): on a live watch of a narrow UHF band that fits one window, the scanner
re-tuned its only hop every few seconds, so every open track closed and reopened with a new id
(the tuned card flickered) and each pass lost a settle second. The detector tested 1 kHz bins
one at a time against a threshold a few dB over the floor, so short noise blips just at the
threshold became discoveries; their labels came from band-plan priors through a spectral class
(several protocols tied on the prior and the first by name won), which showed as "Maybe dPMR"
or ISM. The single confirm probe was spent serially on those noise tracks. Analog FM could not
be identified in a scan at all (the analog evidence came only from live audio in identify), and
IQ capture was off. Nothing heard was named; the only decode came from a manual identify.

## 1. A window that fits stays tuned

As a web user watching a band that fits the receiver's window I want the scanner to stay put,
so a transmission keeps one card from key-up to key-down.

1.1 **Park.** When the job's hop plan has exactly one hop (a `sweep` job whose scope fits the
usable span, or an `auto` job that resolved to sweep with one hop), the job takes the lease,
tunes once, settles once and then **parks**: from then on it behaves as in-window on its own
lease. No `TunerArbiter.retune`, no new epoch, no tracker `closeAll("retune")` and no settle
happens for the rest of the job's life except on a lease loss and regain, a source reconnect,
an operator or relay retune (handled as today), or a plan change that leaves one hop at a
different centre.
1.2 **Same-centre retune is a no-op.** `TunerArbiter.retune` by the current lease holder for
the centre, sample rate and gain already written and accepted on this connection, with a
verified current epoch, writes nothing, starts no settle and returns the current epoch. Any
other retune is today's.
1.3 **Parked accounting.** While parked, `sweepPeriodMs` is null (plan preview and progress),
`hopIndex` 0, `hopCount` 1, `coverage` 1. The job counts one sweep per elapsed hop dwell
(`dwellMs`) so `stop.afterSweeps` and hit statistics keep working; `sweep-complete` is emitted
on that count without a tune action.
1.4 **No same-hop retune in a sweep.** In a multi-hop plan, when the next hop the scheduler
picks (a revisit or the coarse order) is the hop being visited, the visit continues (dwell
extended, open tracks kept) and no tune action is emitted.
1.5 **Track ids stay stable.** While parked, a track keeps its id for the emission's life:
burst gaps within the tracker's hang and the 120 s rollover keep the id (WG11 5.1); a parked
job adds no epoch change, so no frame track loses its id because of the scanner.
1.6 `in-window` mode and the `auto` rule ("in-window when the scope fits the current window")
are unchanged. Multi-hop sweeps keep their hop plan, revisits and timing, and use the channel
gate (section 2) and the evidence-only labels (section 3).

## 2. Channel-matched detection

As a web user I want only real transmissions to appear: noise must never become a discovery.

2.1 **Channel plan.** For each source the scanner gives the spectrum engine a channel plan:
for each enabled range of the running jobs (and the passive job's band-plan view), a channel
width and raster. The width is the range's first `obwHz`, else its raster spacing, else
`CHANNEL_GATE_DEFAULT_WIDTH_HZ` (12 500), clamped to
[`CHANNEL_GATE_MIN_WIDTH_HZ` (6 250), `CHANNEL_GATE_MAX_WIDTH_HZ` (200 000)]. Spans not covered
by a range use the default width on a sliding grid at half-width steps. Band-plan files are
read only (pinned); priors never change the width.
2.2 **Channel power.** Per integration block, in the spectrum worker, over the existing FFT
power output (no new FFT): the power of each channel slot is the sum of the linear power of the
bins whose centres lie in the channel's passband; the channel floor is the sum of the per-bin
floors over the same bins; `channelSnrDb = 10·log10(power / floor)`. Masked bins (DC guard,
edges, exclusions, spurs, images) are applied first: they are left out of both sums, and a
channel with more than half of its bins masked is not tested.
2.3 **Channel threshold.** A channel is on when `channelSnrDb ≥ kCh` and off below
`kCh − CHANNEL_GATE_HYSTERESIS_DB` (1.5). `kCh` starts at `CHANNEL_GATE_K_DB` (3.0) and adapts
per range with the existing CFAR rules (raise 0.5 dB per 5 min above the false-alarm target, cap
+4 dB; lower per 30 min below a quarter of it, never below the start value), counting as a
false alarm a channel that turned on and never passed the gate (2.4). A pinned k pins `kCh` at
the same offset over `CHANNEL_GATE_K_DB`.
2.4 **Gate.** A track passes the gate when the channel at its centre has been on for at least
`CHANNEL_GATE_MIN_DURATION_MS` (300; at most one off block inside counts as on) and the
channel's best block SNR in that time reached `kCh + CHANNEL_GATE_MARGIN_DB` (3.0). In a range
whose band-plan entry is a burst allocation (pager, ISM/SRD, APRS packet), the minimum is
`CHANNEL_GATE_BURST_MIN_DURATION_MS` (100) with `CHANNEL_GATE_BURST_MARGIN_DB` (6.0). Gate state
per track: `pending`, `passed` (sticky for the track's life) or, at the track's close without a
pass, `below`.
2.5 **Only gated tracks surface.** The scanner creates or updates a discovery only from an
observation whose track passed the gate. A track that closes `below` is counted in
`counts.transients` and nothing else (no discovery, no capture, no probe, no activity event
beyond today's transient handling). The old surfacing rules (two blocks, 6 dB in sweeps, three
repeated single blocks, `detection.minSurfaceBlocks` for discoveries) are removed; the setting
stays accepted and keeps only its display role where 2.6 does not replace it.
2.6 **Frames say it.** A `spectrum:frame` track associated with an open track carries
`gate` (`pending` | `passed`) and `channelSnrDb` (rounded to 0.5 dB); `surfaced` equals
`gate === "passed"` and is not a spur or an image. Frame track bound (256), cadence and every
other field are unchanged; the extra JSON is at most 40 bytes per track.
2.7 **Masks first, measurements kept.** Spur, DC and image masks still apply before the gate.
The per-bin detector, segmenter and tracker still measure centre, OBW, class, duty cycle and
ACF of a track; the class (for example `fsk4-6k25`) stays a measurement field.
2.8 **Measured.** The lane reports the worker cost of the gate per block and the false-alarm
rate on synthetic noise (exponential bins at the reference FFT size and block length) at the
default `kCh`, and the detection probability for synthetic NFM, 4FSK, GMSK and OOK bursts at
channel SNRs from 3 to 12 dB.

## 3. Labels only from trial evidence

As a web user I want every label to say what the core proved, never what it guessed.

3.1 **Priors order, never label.** Band-plan priors and the spectral class may select and order
trials. They never set `Discovery.protocol`, `Discovery.family` or a label. A discovery's
`protocol` is `unknown` until an accepted decode or an analog-trial outcome names something;
then it is the decoded protocol, `analog-fm` / `analog-am` (voice heard or tone), `digital-unknown`
(data-like and every planned digital trial ran and failed) or `carrier` (carrier only).
`hypotheses` stay on the observation as measurements.
3.2 **Ladder.** The `ScannerConfidence` values and their order are kept. `activity`: a gated
detection without a naming outcome, or carrier only. `candidate`: analog voice heard, or
digital not decoded, or an analog tone on an `unverified` frequency. `classified`: an analog
tone or DCS code on a `commanded` or `relay` frequency (as the WG10 analog verdict). `decoded`:
the first accepted identity (DMR needs the same colour code on two CRC-clean link lines);
replay acceptance equals live. A prior-only hypothesis with score ≥ 0.5 no longer gives
`candidate`, and a spectral or channel-tier classification no longer raises the ladder by
itself.
3.3 **No migration.** Stored discoveries keep their fields. A record without proof is `weak`
(3.6); its `protocol` is shown only through its proof (none), so a client following 3.7 shows
no prior-derived label.
3.4 **Trial outcomes are the evidence.** "Digital, not decoded" means the analog trial found
no voice and no tone and its discriminator output was data-like, and the planned digital
trials ran and failed. "Carrier only" means FM-quieting carrier evidence without modulation.
The tried list names only trials that actually ran to an outcome other than `unsupported`,
`skipped-budget`, `cancelled` or `pending`; a decoder whose program is missing is listed as
unavailable, never as tried.
3.5 **Proof.** `Discovery.proof` and `Observation.proof` (optional, derived from stored
evidence on read and on change, never persisted as a new store field): `kind` (`decoded`,
`analog-tone`, `analog-voice`, `digital-undecoded`, `carrier-only`), `protocol`, `transport`
(`live`, `replay`, `ambient`), `at`, `observationId`, `identity?`, `talkgroup?`, `tone?`
(`ctcssHz`, `dcs`), `tried` (protocols, in run order, unique, at most 16), `unavailable`
(probe decoder types, sorted, unique), `encrypted`, and `summary` (fixed English text, design
§ Proof grammar, at most 160 characters), for example "DMR decoded (CC1, TG 9)",
"Analog FM voice, CTCSS 88.5", "Digital, not decoded (tried DMR, dPMR, NXDN)", "Carrier only".
A discovery's proof is its strongest observation proof (rank decoded > analog-tone >
analog-voice > digital-undecoded > carrier-only; ties: newest) among its retained observations.
3.6 **Evidence level.** `Discovery.evidenceLevel`: `proven` when it has a proof, else `weak`.
3.7 **Filter.** `GET /api/scanner/discoveries` accepts `evidence=proven|weak|all`; absent means
`all` and the answer is byte-identical to today's. The filter combines with every existing
query parameter and with 7.6. The web sends `proven` and offers "show weak activity" (`all`).
3.8 **Encrypted stays honest.** An encrypted decode is `decoded` with `encrypted: true` and its
summary says "encrypted"; no audio is kept; nothing is decrypted.
3.9 **Ambient evidence counts.** An ambient decode (WG7: AIS, ACARS, VDL2, LoRa, and decoders
already running) is a `decoded` proof with transport `ambient`.

## 4. Probes, capture and replay in scans

As a web user I want every real transmission tried against every plausible decoder, without
noise eating the decoders.

4.1 **Gate first.** Only a gated track (2.4) can trigger a capture, a confirm hold, an offset
probe or an identify follow-up. Today's confirm-candidate selection (`nextCandidate`) skips
tracks whose gate is not `passed`.
4.2 **Replay first.** On a source where capture runs, a scan or passive job confirms a gated
transmission through capture and replay (WG11 6.3, 6.4, with the analog trial of section 5).
A live offset probe or confirm hold is used only (a) when capture is not running on the source
(off, legacy without opt-in, binary missing, at a bound and refused), (b) for a gated
transmission still on air after its capture finished whose replay has not decoded yet, or (c)
for identity follow-up (talkgroup, metadata) on a discovery whose protocol is already decoded
and whose emitter is on air. Passive keeps `offsetProbes: false` and gains capture and replay.
4.3 **Capture trigger.** A capture is requested when a track passes the gate (not at the old
surfacing point) and its discovery has no result for this transmission (WG11 6.3 otherwise
unchanged, including the per-source and concurrency bounds).
4.4 **Limits stay.** `IQ_CAPTURE_PER_SOURCE_PER_MINUTE` (6), `IQ_CAPTURE_MAX_CONCURRENT` (2),
`IQ_REPLAY_MAX_PROBES` (1) and `IQ_REPLAY_MAX_TRIALS` (8, the analog trial counted) are
unchanged; the design states the arithmetic that the gate makes them sufficient. A raise needs
a measured amendment.
4.5 **Unavailable is not no-sync.** On the probe path (scan confirm, passive, replay and
identify runs), a probe whose decoder program is missing or not executable before any output
ends `unsupported` with reason `decoder-unavailable`, is recorded in the probe pool's
unavailable memo (WG10 3.5), never counts as a known-protocol miss, never yields an
`undecodedReason` of `no-sync`, and appears in `proof.unavailable`.
4.6 **Trial order.** Replay and live trials are ordered: known protocol first (WG11 1.7), then
the analog trial (replay only), then the digital probe modes by hypothesis score × prior
(narrow digital per WG11 1.3). After an analog `decoded` (tone or code) or `heard` outcome the
remaining digital trials of that capture are not run (`not-needed`), except the known protocol
already run first; after `data-like`, `carrier-only` (a carrier may precede data) or `no-sync`
they run.

## 5. Analog replay trial

As a web user I want analog FM named in a scan ("Analog FM voice, CTCSS 88.5") without anyone
listening live.

5.1 **Dependency.** The trial consumes the reusable Rust NFM/AM demodulator kernel of the
[rust-demod-a](../rust-demod-a/requirements.md) spec: a pure kernel in the `wavekit-chan` crate
that takes cf32 at the capture rate and produces audio (assumed API in design § Analog replay
trial). Sequencing: that kernel lands first; tasks RP.2 and RP.3 start after it. If its API
differs, the lane adapts its own module only.
5.2 **Native analysis.** `wavekit-iqcap` gains an `analyze` command: it reads one capture
(48 kHz cf32, the WG11 file rules), demodulates it with the kernel (`nfm`, or `am` where the
range's band plan lists AM), and returns, on its event channel, bounded per-50 ms statistics
(carrier power, discriminator noise above 3.5 kHz, audio power 300–3 000 Hz, syllabic
modulation index, discriminator level-clustering score) and the audio at
`AUDIO_TONE_RATE_HZ` (8 000) s16le on the replay output. No file is written; the capture's
file rules and discard are WG11's.
5.3 **Tones stay in TS.** The audio goes through the existing CTCSS and DCS detectors
(`src/core/audio-tones/`) at 8 kHz, with WG2/WG6 qualification rules (minimum audio seconds,
DCS minimum words). Tone detection is not ported to Rust.
5.4 **Outcome.** The trial ends with one of: `decoded` (a CTCSS tone or DCS code qualified;
protocol `analog-fm`/`analog-am`), `heard` (FM quieting and voice-like modulation, no tone),
`data-like` (quieting and a discrete-level discriminator: feeds "Digital"), `carrier-only`
(quieting without modulation), or `no-sync` (no FM quieting: not an FM signal at this
channel). The decision is a pure function of the statistics and the tone result with
thresholds pinned in the contract (design § Analog replay trial).
5.5 **Trial shape.** The trial appears in trial lists with `decoder: "analog-demod"`,
`mode: "nfm" | "am"`, `transport: "replay"`. It runs in the replay queue (one at a time with
the replay probes, not a probe decoder process), costs `ANALOG_TRIAL_CORES` (0.05) in the probe
budget, and counts one of the eight trials.
5.6 **Unconditional inside replay.** The analog trial runs for every replayed capture whose
plan includes `analog-fm` or `analog-am` (prior > 0, not excluded by the request), whatever the
live-audio configuration; the live-demodulator engine flag of rust-demod-a gates live audio
only.
5.7 **Measured.** Wall time and CPU per 4 s capture for `analyze` and for the TS tone pass, on
the reference host, with the event-loop delay p99 during a burst of 6 captures.

## 6. Identify and live audio

As a web user I want "Decode here" to wait for the next transmission, and the channel I listen
to identified without asking.

6.1 **Identify until a transmission.** `ScannerIdentifyRequest.waitUntilSignal?: boolean`
(default false) and `waitMs?` (1 000–600 000, default `IDENTIFY_WAIT_DEFAULT_MS` 300 000; refused
without `waitUntilSignal`). With it, the target stays `waiting-for-signal` until a gated
transmission (2.4) at the target begins; `timeoutMs` then counts from that start. When `waitMs`
elapses first, the target ends `unidentified` with `result.ended: "no-signal"` and every trial
`cancelled`. Without it: today's behaviour.
6.2 **Decode here.** "Decode here" is an identify at a point: `{ target: { frequencyHz,
bandwidthHz? }, waitUntilSignal: true }`. No route is added; docs/API.md documents the mapping.
6.3 **Live-audio channel evidence.** While live audio runs on a source with a `commanded` or
`relay` frequency, each closed analog transmission (WG1/WG10 tracker) within the tolerance of
a discovery attaches analog evidence to the matching observation (transport `live`, decoder
`live-audio`): `decoded` with its tone or code, `heard` otherwise. This needs no identify job
and takes no probe; a capture of the same transmission still replays its digital trials only if
the analog trial says `data-like` (4.6).
6.4 **Tone on live status.** `LiveAudioStatus.tone?` (while running): `{ ctcssHz, dcs, at }` of
the current or last closed transmission on the tuned channel, cleared on retune. Delivered as an
exact diff to `src/core/live-demodulator.ts`, applied by Main after the rust-demod-a lane merges
(that lane owns the file).
6.5 **Analog versus digital per transmission.** Each observation's `proof.kind` tells analog
(`analog-voice`, `analog-tone`), digital (`decoded` with a digital protocol,
`digital-undecoded`) or carrier for that transmission.
6.6 Identify's `trials` include the analog replay trial (5.5) when a claimed capture replays;
`ended: "window-moved"` and every WG7–WG11 identify rule are unchanged.
6.7 **Identify regardless of listening (A17-A19).** Analog FM, CTCSS and DCS are identified
with no live-audio client: each analog trial owns its demodulation, runs on every
narrow channel unless a user-explicit protocol list excludes it, and a standard tone outranks
any 4FSK class prior.
6.8 **Fair decoder slots (A20).** No trial holds a slot for minutes: a 6 s cap per turn, aging
across candidates, pre-emption by a fresh strong transmission, and identify always served.
6.9 **Evidence-bound labels (A21, A22).** Identify works on any signal anywhere; only a
user-explicit protocol list bounds trials, band plans and priors only order them; identify
names a protocol only from a decode or tone evidence; failed digital trials produce
"Digital, not decoded (tried ...)".

## 7. Scan UX contract

As a web user I want to see what the scan is doing, what it found and why it believes it.

7.1 **Phase.** `ScanJobProgress.phase?` and `ScannerProgressEventData.phase?`: `settling`
(tuned, before the first verified block), `holding` (a sweep hop held for a live probe),
`trialing` (a live probe of this job runs while parked or in-window), `replaying` (a replay or
analog trial of this job's capture runs), `capturing` (a capture of this job's track is being
written), `watching` (otherwise). When several hold, the first in that order wins.
7.2 **Parked.** `parked?: boolean` on both: true while the job is parked (1.1) or in-window.
7.3 **Holding.** `holding?: { discoveryId: string | null; frequencyHz: number; trackId: string }`
on both while `phase` is `holding` or `trialing`; `holdingOn` keeps its meaning.
7.4 **Current trial and queue.** `trial?: { protocol, decoder, transport, discoveryId }` (the
running trial of this job, live or replay) and `replayQueueDepth?: number` (captures of this
job waiting or replaying).
7.5 **Merged ids.** `ScannerDiscoveryEventData.mergedIds?: string[]` on `change: "merged"`:
the ids absorbed into `discovery` (sorted, at most 64).
7.6 **Near a frequency.** `GET /api/scanner/discoveries?nearHz=&toleranceHz=` returns
discoveries whose frequency lies within `toleranceHz` (default `DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ`
6 250, at most 1 000 000) of `nearHz`, ordered by distance then id; refused (400) with
`toleranceHz` and no `nearHz`.
7.7 Progress keeps its 2 Hz per job cadence and the WS budget; no event type is added.

## 8. Capture and replay on by default

As a user of a protected install I want capture and replay without configuring them, once they
are proven live.

8.1 **The flip (final task).** After the live acceptance of section 11 passes with capture
enabled, Main changes the config so `scanner.iqCapture` absent, or present without `enabled`,
means enabled in protected access mode; `enabled: false` turns it off. In legacy mode it starts
only with `scanner.iqCapture.allowLegacy: true` (default false; one info line otherwise, as
WG11). No capture file is exposed over REST in either mode. If acceptance fails, the flip does
not land and the reason is recorded in the spec status.
8.2 **Contract now, flip later.** The contract commit adds `allowLegacy` (default false) with
today's `enabled` default (false); only task MA.6 changes the `enabled` default and its goldens.
8.3 Every WG11 bound is kept: directory 0700, files 0600, the name grammar, fail closed, no
path or id in logs or bodies, nothing survives a restart, orphan TTL, the total cap.
8.4 `config/default.yaml` documents the key in a commented block; the shipped file sets
nothing.

## 9. Performance and the Rust detector gate

As an operator I want the scanner to cost no more than its budget, and native work where the
measurement says it pays.

9.1 **Budgets.** Every hot-path item in the design states its pipeline position, its core
fraction at 2.048 and 2.4 Msps on the reference desktop host and on a Pi 4-class host, adds at
most 2 ms to the event-loop delay p99 at 2.048 Msps, and allocates nothing per IQ chunk.
Differences under 0.3 core count as noise.
9.2 **Profiling first.** Task DT.0 profiles a core fed by an in-process fake rtl_tcp (port 0)
at 2.048 and 2.4 Msps with a parked job and a passive job: the spectrum worker's busy time
split into window, FFT, power, floor, detector, channel gate, segmenter and tracker, and summary
wire; and the main thread's event-loop utilization split into tap feed, summary decode, frame
build, scanner ingest and store. Results in `docs/engineering/scanner-profile.md` (Main
commits it).
9.3 **Gate criterion.** A Rust detector frame engine task is added to this batch (by a spec
amendment) only if, at 2.048 Msps on the reference host, window + FFT + power + summary wire
take at least 50 % of the worker's busy time **and** the engine's utilization is above
`PASSIVE_COST_LIMIT_DEFAULT` (0.25). Otherwise it is deferred to WG13 with the numbers recorded.
Any main-thread item over 1 ms of event-loop delay p99 gets a fix task in its lane.
9.4 New Rust code is MIT or Apache, no FFTW or VOLK, no line-by-line port from GPL code; no
new csdr or `sh -c` chain; no new full-rate fanout branch.

## 10. Main items

10.1 Main commits the frozen contract (design § Contract) with the CLI guard widening and the
contract test before any lane starts.
10.2 Main applies the lanes' exact diffs to the seams (`src/core/scanner/scanner-service.ts`,
`src/index.ts`, `src/config.ts`, `src/core/live-demodulator.ts` after rust-demod-a merges,
`Dockerfile`, `native/wavekit-chan/Cargo.toml`), in the order of tasks.md.
10.3 Docs: docs/API.md (every new value, field, bound and rule), docs/SCANNER.md (parking,
gate, evidence labels, analog trial, defaults), docs/ROADMAP.md, and the coordination note
(design § Coordination note text) appended by hand to docs/CLI-COORDINATION.md (no Prettier).
10.4 The capture default flip (8.1) and its docs, after live acceptance.

## 11. Live acceptance

As the user I want proof on my receiver, not only in tests. Only Main runs these, with the
receiver grant in force; lanes never do. Afterwards Main restores the receiver's configured
gain and AGC.

11.1 **Scheduled with the user (S).** The user keys a DMR radio and an analog PMR446 radio on
named channels while Main runs a job over the PMR446 band (446.0–446.2 MHz, one hop, parked):
scenarios S1–S6 in design § Live acceptance.
11.2 **Natural traffic (N), Main alone.** Pagers (POCSAG/FLEX), ISM/IoT at 433 and 868 MHz,
aviation (ADS-B alongside, ACARS, VDL2), AIS, APRS and random analog or digital voice:
scenarios N1–N6 in design § Live acceptance.
11.3 **Pass criteria per scenario.** (a) No noise discoveries over N minutes of empty band
(S: 30 min before the radios; N: 30 min on a band segment Main confirms empty on the
waterfall). (b) One track id per transmission across its whole length on `spectrum:frame`.
(c) No tuned-card flicker: while parked, no epoch change and no scanner tuner command after the
first tune. (d) The correct evidence label (proof summary) within T seconds of the
transmission's end (S: 10 s; N: 20 s). (e) Measured cost: event-loop delay p99 added at most
2 ms against a scanner-off baseline, and the core process CPU against its budget.
11.4 Capture off first (live probes on gated tracks), then capture on (protected mode); both
results recorded. The flip (8.1) needs S1–S6 passing with capture on.
11.5 Results are written to the spec status and docs generically: no frequencies of private
users, identifiers, addresses or job ids in tracked files.

## 12. Verification

12.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment (`// Feature: scanner-redesign, Property N: <name>` / `// Validates: Requirements X.Y`);
Rust properties use proptest.
12.2 The root suite, typecheck, lint and the native crate tests pass at every merge.
