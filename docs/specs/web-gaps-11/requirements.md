# Web gaps 11 requirements (WG11)

Status: implemented (all lane and Main wiring tasks done; checkpoint and live acceptance open,
see [tasks](tasks.md)). See [design](design.md) and [tasks](tasks.md).

## Scope

The eleventh batch of core work the web dashboard needs, driven by a live session on the WG10
base and by the founding use case (a signal seen on the waterfall is identified by every decoder
that can name it): identify and scan quality (an analog squelch opening is reported as heard, not
decoded; analog evidence no longer stops digital trials; narrow digital modes are tried on
6.25 kHz rasters; the band-scan DMR classification gap is root-caused; the passive CPU guard
re-checks; a stop of an ended scan is clean); scanner store CPU in wide sweeps; configured gain
and AGC written on connect; stable signal tracks on spectrum frames; and a bounded narrowband IQ
capture on detection, replayed into the probe decoders after the transmission ended, whose
result is remembered per discovery so the next transmission tries the known decoder first.

Out of scope: web UI and CLI features (coordination note and the CLI guard widening only); drag
retune and a wide panorama (later, with a native zoom); the native live demodulation engine
(later, behind a flag); IQ capture in legacy access mode; persisting captures across a restart; a new npm dependency or a new Rust crate; the channelizer (stays off) and S2
(stays disabled); scanner defaults, the Activity caps and admission limits, the access default
(`legacy`); the files pinned by the band-plans spec (`src/decoders/band-region.ts`,
`src/decoders/band-defaults.ts`, `src/core/scanner/bandplan/index.ts`,
`src/core/scanner/bandplan/builtin.ts`).

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access or data research. Tests use fake decoders, fake child processes or
local stand-in processes, a fake rtl_tcp server on an ephemeral 127.0.0.1 port, temporary
directories, synthetic IQ and injected clocks; no test opens a socket to anything but 127.0.0.1.

**Defaults.** With the shipped config and no new key set, every route, frame, log line, argv and
receiver write is byte-identical to the WG11 base except these deliberate changes:

- 1.1: an analog live-audio identify trial whose matching transmission carried no CTCSS or DCS
  code ends `heard` (was `decoded`); the trial outcome list gains `heard`.
- 1.2: analog evidence no longer ends other running trials (`not-needed`); identify jobs with
  analog evidence may run until their digital trials end.
- 1.3: identify plans `nxdn48`, `dpmr` and `dstar` trials for a target on a 6.25 kHz raster even
  when the track's width does not suggest them.
- 1.4: whatever the band-scan root cause fix changes (listed by the lane with its goldens).
- 1.6: a cancel of an ended job answers 200 with the unchanged job (was: a `completed` or
  `failed` job turned `cancelled` and its end actions ran again).
- 2.2: the passive CPU guard re-checks every 5 minutes; a disabled passive job can come back,
  with one info log line.
- 1.7: an identify target whose discovery has a known decoded protocol plans that protocol's run
  first (order only; every other trial still runs unless it decodes).
- 5.1: `spectrum:frame` tracks carry the new optional fields (frame bytes grow, design § budgets).
- 6.x and 4.x are off by default (no key, no write, no process, no file).

Each lane proves the rest against goldens recorded from the frozen code and lists every golden it
changes with the requirement that changes it. Every hot-path item states its CPU budget and
pipeline position in the design; every new bound states its arithmetic and has a test at the
bound and one past it.

Background (generic): the web showed "FM voice: Decoded" for every squelch opening; a
digital-sounding signal on a 6.25 kHz UHF channel was not identified (no narrow digital trial ran);
a DMR band scan produced only unclassified "Heard" discoveries; passive scanning was disabled by
the CPU guard in a container and never came back; a wide sweep saturated the core main thread in
the discovery store (structured clones, full scans per observation, full-store serialisation);
the receiver came up with its own gain after a reboot and the core never wrote the configured
gain; the web cannot keep a label on one emission across frames.

## 1. Identify and scan quality

As a web user identifying what I see on the waterfall I want honest outcomes, every plausible
decoder tried, and a scan stop that never errors.

1.1 **Heard is not decoded.** A `live-audio` identify trial whose matching closed transmission
(WG10 3.1) carried a CTCSS tone or a DCS code ends `decoded`; one whose matching transmissions
carried neither ends `heard` (new `ScannerTrialOutcome` value). The verdict rules of WG10 3.4 are
unchanged (`identified` still needs a reported tone or code on a `commanded` or `relay`
frequency; otherwise at most `candidate`). `heard` is never used by any other trial.
1.2 **Analog evidence does not stop digital trials.** A matching analog trial ends only the
waiting analog trials of its target; probe runs, pending runs and ambient trials of other
decoders keep running to their own end, and a digital decode still wins (WG10 3.3 amended). The
target finishes when every trial ended. `exhaustive` keeps its meaning (nothing stops early).
1.3 **Narrow digital modes on 6.25 kHz rasters.** When the identify target lies inside a band
plan range (of the active region) that lists a raster with a spacing of at most 6 250 Hz, the
plan includes `nxdn48`, `dpmr` and `dstar` (unless the request's protocol list excludes them),
each scored at least `IDENTIFY_NARROW_DIGITAL_MIN_SCORE` (0.3) before priors are applied, so
their runs are ordered before any lower-scored run. The lane states the run-time arithmetic of
the resulting plan against the default 15 s timeout and orders the plan so these runs start
within it. A prior of 0 still removes a protocol.
1.4 **Band-scan DMR root cause.** The lane determines from code and synthetic or fixture
evidence (no RF) why a sweep job over a DMR band produced only `activity`/`candidate`
discoveries without a DMR probe decode: at least probe admission (CPU guard, budget,
`maxProbes`, deferral reasons), hop dwell against the DMR probe hold and start latency, the
protocol plan for the sweep ranges, the spectral class of a DMR burst train at the sweep's
resolution, and the ladder (`ladderOf`). Every in-core cause found is fixed with a regression
test; a cause outside the lane's files is delivered as an exact diff. The finding is written up
in the report and summarised (generically) in the docs.
1.5 **CLI guard first.** The CLI identify guard accepts `heard` and the `replay` transport (trial
and probe) in the contract commit, before any lane emits them; a payload with every new value
parses.
1.6 **Clean scan stop.** `POST /api/scanner/jobs/:id/cancel` on a job that already ended
(`completed`, `cancelled`, `failed`) answers 200 with the job unchanged: no state change, no
end action, no event, no persistence write. An unknown id stays 404. Pause and resume of an
ended job keep today's 409 (`SCANNER_INVALID_TRANSITION`). A cancel racing a natural completion
ends in exactly one terminal state. Identify jobs follow the same rule. Documented in docs/API.md.
1.7 **Known protocol first.** A discovery's known protocol is its `protocol` while its
confidence is `decoded` and its known-protocol miss count is below `KNOWN_PROTOCOL_MAX_MISSES`
(2). The scanner reuses the discovery store's existing fields (`protocol`, `confidence`,
`identity`, the observations' accepted decode evidence) as this memory; no new persisted field.
Identify and replay planning order the known protocol's probe mode first (`planReplayTrials`,
identify plan); the other plausible trials follow in today's order and still run when the known
one does not decode (order only, never a removal).
1.8 **Memory decays safely.** A known-protocol trial (live probe, identify run or replay) that
ran its full hold on a transmission of the discovery and did not decode counts one miss for that
discovery (in memory, per process); a decode of any protocol resets the count to zero. At
`KNOWN_PROTOCOL_MAX_MISSES` consecutive misses the discovery has no known protocol for planning
(full trials, capture as for an undecoded signal) until a decode. A miss never changes the
discovery's stored protocol or confidence (the ladder's own rules do). A decode of another
protocol on the discovery follows the store's existing rules (protocol change, merge).

## 2. Passive CPU guard

As an operator I want passive discovery back once the host has headroom, with a limit I can set.

2.1 The guard's limit is `scanner.passive.maxEngineUtilization` (optional config key, 0.05 to 1;
absent means 0.25, today's value). Config only (not a runtime settings PATCH key).
2.2 The first check stays at the engine's open + 60 s. After it, every
`PASSIVE_COST_RECHECK_MS` (300 000 ms) the guard re-reads the running engine's utilization: a
disabled source whose utilization is at most `limit × PASSIVE_COST_CLEAR_RATIO` (0.8) is enabled
again (info log, passive job rebuilt); an enabled source above the limit is disabled (warn, as
today). No engine or a null utilization changes nothing. The status `disabledReason` follows.
2.3 The decision is a pure function (`passiveCostDecision`) with tests at the limit, the clear
threshold and one past each.

## 3. Scanner store CPU

As a user running a wide sweep I want a responsive core: the discovery store must not saturate
the main thread.

3.1 **Per-source frequency index.** Sticky association (`stickyMatch`) finds candidates through
a per-source, per-family index ordered by the cached median centre (binary search on the
tolerance window) instead of scanning every discovery of the source. Results identical to
today (same discovery, same tie-break).
3.2 **Cached medians.** A discovery's median centre over its last 64 observations is cached and
recomputed only when that discovery's observation list changes.
3.3 **Incremental counts.** The per-job discovery counts by confidence (progress `counts`) are
maintained incrementally by the store (`countsByJob(jobId)`), O(1) per progress build, equal to
today's full recount at every point (property).
3.4 **No clones or full stringify in the ingest hot path.** `ingest`, `applyEvidence`,
`applyClassification` and `appendObservationEvidence` detect "no change" without
`JSON.stringify` of whole records and without `structuredClone`; journal entries are serialised
once (the journal line). Reads that leave the store (`get`, `list`, events, DTOs) still return
copies.
3.5 **Snapshot off the main thread.** The snapshot text is built and written by a worker thread
from a mirror of the store's records kept current by the journal entries; the main thread's
cost per snapshot is a bounded message. The written file is byte-identical to today's for the
same store state (with an injected `savedAt`). A worker failure falls back to today's
main-thread path for that snapshot (one warn per hour at most, counted), then restarts the
worker once; journal hole and backlog semantics (WG10 leak fix) are unchanged.
3.6 **Measured.** A bench (`scripts/bench/scanner-store.ts`) replays a synthetic wide sweep
(10 000 discoveries on one source, 50 000 observations) and reports per-ingest µs, progress build
µs, snapshot main-thread ms and event-loop delay p99 before and after, with the load average.
Budgets in the design.

## 4. Gain and AGC on connect

As an operator I want the receiver to come up with the gain I configured, after every reconnect,
without fighting what I set at runtime.

4.1 **Config.** A source of type `rtl_tcp` may carry `tuner: { gainMode, gainDb?, agcMode? }`:
`gainMode` `manual` (then `gainDb` is required, 0 to 50 dB in 0.1 dB steps) or `agc` (then
`gainDb` is refused); `agcMode` is the RTL2832 digital AGC flag, optional. Absent `tuner`: nothing
changes. On another source type the key is ignored with one warn at startup.
4.2 **Written on connect.** On every new connection (the session's first payload, where the
reconnect restore runs today), the configured fields are written before the restore of accepted
fields, in the order gain mode, gain, AGC, as commands of origin `config` (new
`TunerCommandOrigin`), once per connection. They are also the source's baseline (status shows
them once written; the `reset` policy returns to them).
4.3 **Precedence.** A gain, gain mode or AGC value accepted in this process from the REST API or
the relay replaces the configured value for the rest of the process (the restore writes the
accepted value, not the config), until a `reconnectPolicy: reset` discards it. Under external
control (relay owns the tuner) nothing is written. Never written periodically, never on a
non-`rtl_tcp` source.
4.4 **Trust.** The values come only from the validated config; an invalid config fails startup
with `ConfigValidationError`. A failed write is today's restore failure (warn, retried on the
next connection). Logs name commands, never values from elsewhere.
4.5 Gain fields' `unknownFields` / `declaredOnlyFields` follow the WG9 rules (written on this
connection → known).
4.6 Without `tuner` on any source: every connect writes exactly what it writes today (golden).

## 5. Stable tracks on spectrum frames

As a web user I want a label to stay on one emission from frame to frame and to filter noise by
the core's own judgement.

5.1 Each `spectrum:frame` track (segment) that the tracker associated with an open track carries
optional fields: `trackId` (the tracker's id, stable for the emission's life including burst gaps
within the tracker's hang), `snrDb` and `peakDbfs` (the track's, against the core's floor and
threshold, rounded to 0.5 dB), `blocks` (on-blocks so far), `ageMs` (since the track opened, from
sample counts), `surfaced` (the display surfacing rule: not a spur or an image, and a burst
track at threshold + 3 dB, or at least `detection.minSurfaceBlocks` blocks), `flags.spur`, and,
when the scanner holds a discovery for the track, `scanner: { discoveryId, protocol, confidence }`.
A segment without a track carries none of them.
5.2 Fields are taken from the same block as the segment (no look-ahead); backfill and averaged
frames carry the fields recorded with their block and the scanner identity looked up when sent.
5.3 The scanner identity is read through a lookup port (`SpectrumTrackIdentityLookup`) that Main
wires from the scanner; a throwing or absent lookup gives no `scanner` field; no identity is
attached to a track of another source or epoch.
5.4 The CLI frame guard keeps parsing frames (unknown fields stripped; the track bound of 256 is
unchanged); pinned by the contract test.
5.5 Budget: frame JSON grows by at most 260 bytes per track; the frame build adds O(tracks)
work; measured.
5.6 Tracks per frame, the frame cadence and every other frame field are unchanged.

## 6. IQ capture on detection, replay and result

As a web user I want a transmission identified even when it ended before a decoder could run:
the core keeps a few seconds of its narrowband IQ, replays it into the digital decoders off-air,
remembers the answer and throws the IQ away.

6.1 **Off by default, protected only.** `scanner.iqCapture` (optional config object; `enabled`
default false) starts the capture only in protected access mode; in legacy mode it is not
started and one info line says so. Absent or disabled: no process, no file, no branch, no byte
change.
6.2 **Native capture.** A native tool (`wavekit-iqcap`, a second binary of the `wavekit-chan`
crate, no new crate dependency) receives the source's CU8 IQ from the spectrum engine tap (no new
fanout branch) and keeps a full-rate ring of at most `IQ_CAPTURE_PREROLL_MAX_MS` (2 000 ms). On a
capture request it shifts and decimates the requested RF channel to `IQ_CAPTURE_RATE_HZ`
(48 000 Hz) complex float32 (cf32) with the widest probe passband, from the requested pre-roll
up to `IQ_CAPTURE_MAX_MS` (4 000 ms) in total, and writes one file. Gaps are reported, never
filled silently.
6.3 **On detection.** For a source with capture enabled, the scanner requests a capture when a
transmission's track surfaces and its discovery has no confirmed result for this transmission
yet (below `decoded`, or `decoded` with a known protocol that a live probe has not confirmed on
this observation), it is not a spur or an image, it lies in the usable span, at most
`IQ_CAPTURE_PER_SOURCE_PER_MINUTE` (6) per source per minute and `IQ_CAPTURE_MAX_CONCURRENT` (2)
at once; the capture ends at the track's close (plus the tracker hang) or the bound. An identify
job also requests a capture of its resolved track when none exists for it.
6.4 **Queue order (binding).** capture → queue → replay trials → result → discard. A finished
capture enters a FIFO replay queue (one per core, bounded by the store cap). Its trials come from
`planReplayTrials` (known protocol first, requirement 1.7; then the probe modes `identifyScores`
gives the captured track, narrow digital included per 1.3) and run one at a time through the
`replay` transport. The first accepted decode (H2) is the result and ends the remaining trials;
otherwise the result is "no decode" once every trial ended. The result is delivered to the
scanner (decode evidence on the capture's observation in the capture's epoch, the undecoded
reason otherwise, miss counting per 1.8) and the capture is discarded at once.
6.5 **Live confirmation skips the replay.** When a live probe or an identify run decodes the
transmission's observation before its capture's replay started, the capture is discarded
unreplayed (counted). A capture whose replay started finishes it.
6.6 **Bounded store, short life.** Captures live in `<scanner storage>/iq-captures` (directory
mode 0700, files 0600, names `<uuid v4>.cf32`, regular files only, no symbolic link on the way).
Each file is at most `IQ_CAPTURE_MAX_BYTES` (1 536 000); the total at most
`scanner.iqCapture.maxTotalMb` (default and maximum 256 MiB, `IQ_CAPTURE_TOTAL_MAX_BYTES`). A
capture is discarded as soon as its result exists (6.4) or a live confirmation made it moot
(6.5). A capture that never got a result (queue backlog, decoders unavailable, replay never
started) is discarded `IQ_CAPTURE_ORPHAN_TTL_MS` (600 000 ms) after it finished. At the cap a
new capture request is refused (counted; the queue drains first). Captures do not survive a
restart: the startup sweep removes only files matching the name grammar (regular files, owned by
this uid) and leaves anything else (counted).
6.7 **Replay transport.** A probe transport `replay` feeds a probe decoder (`dsd-fme`,
`multimon-ng`, `direwolf`; never `rtl433`) the capture filtered to that decoder type's probe
channel shape (bandwidth, transition, rate and format of `PROBE_CHANNEL_REQUESTS`), faster than
real time, then ends the input. At most `IQ_REPLAY_MAX_PROBES` (1) replay probe runs at once;
it counts against the CPU budget and guard like any probe, at a priority below identify and
above passive.
6.8 **Identify uses captures.** An identify target with a queued capture near it (same source,
frequency within the tolerance, trust `commanded` or `relay`, or the same observation id), at
most `IDENTIFY_REPLAY_MAX_CAPTURES` (2) newest first, takes them over from the queue: the
identify job runs their replay trials (transport `replay`) after its live runs for the probe
protocols not decoded live, and the capture is discarded when the identify target reaches its
result. A replay decode counts like a live one (H2 acceptance, epoch of the capture). The trial
list may then hold a live and a replay trial for one protocol.
6.9 **Fail closed.** A capture whose source epoch changed during it, whose file is missing,
oversized, not a regular file or not ours, or whose process failed is never replayed: it is
discarded (counted) and no replay trial is planned for it (a replay found bad after planning ends
`cancelled`, no verdict, no miss). A missing binary disables capture with one warn; identify and
the scanner work as before.
6.10 **No leaks.** Logs and bodies name no path, file name, capture id or frequency from a
file; counts, codes and fixed text only. Control messages to the native tool are bounded
(4 KiB per line) and validated on both sides; the tool refuses anything else.
6.11 **Measured.** The lane reports the native tool's CPU at 2.048 and 2.4 Msps idle (ring only)
and with 2 captures active, its resident memory, the main-thread cost of the tap feed, the
replay wall time per decoder, and the queue drain rate (captures per minute at one replay probe),
with the load average.

## 7. Main items

7.1 Main wires: the lanes' scanner-service diffs (narrow raster dep, cancel if needed, counts,
snapshot worker, passive cost, track identity getter, capture triggers), the identify and
probe-pool wiring of the replay transport (after lane ID merges), the gain config into the tuner
controller, the track identity lookup into the spectrum service, the snapshot worker and the
capture tool into the build and the Docker image, the replay queue (planner from lane ID, result
sink and live-confirmation discard into the scanner) and the known-protocol memory.
7.2 docs/API.md, ROADMAP, SCANNER and the coordination note (for the CLI and the web session)
describe every new value, field, bound and rule; the CLI guards are checked.
7.3 docs/ROADMAP.md folds the performance and native-code audit (now: zoom through the native
channelizer; next: a native NFM/AM demodulator behind a flag; quick wins), and a contributor
page states the performance rules.

## 8. Verification

8.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
8.2 The root suite, typecheck, lint and the native crate tests pass at every merge.
