# Web gaps 10 design (WG10)

Status: frozen for implementation. Requirements in [requirements](requirements.md), tasks in
[tasks](tasks.md). Background: the WG9 recording Keep coordinator, protection port and scanner
deleter hooks; the WG1 live demodulator, WG2/WG6 tone and DCS detection and WG7 noise squelch;
WG5/WG9 strict tuning trust; the spectrum engine § 4.7 discontinuity alarm; WG7/WG9 identify
(ambient trials, `decoder-unavailable`).

## Contract (frozen)

| File                                                 | Addition                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/scanner.ts`                  | trial `decoder` gains `"live-audio"`; trial `reason` gains `"no-live-audio"`; `ScannerIdentifyAnalog`; `ScannerIdentifyResult.analog?`, `ScannerIdentifyResult.decodersUnavailable?` (`ScannerProbeDecoderType[]`); `IDENTIFY_ANALOG_MAX_TRANSMISSIONS` (32), `IDENTIFY_ANALOG_LOOKBACK_MS` (30 000), `PROBE_UNAVAILABLE_MEMO_MS` (300 000), `ScannerProbeDecoderType`. Outcome and state lists unchanged. |
| `packages/api-types/src/spectrum.ts`                 | `SpectrumWarning.suspected?` (`SpectrumWarningSuspect`: `iq-byte-slip`, `signal-change`, `external-control`), `SpectrumWarning.lastCommandAgeMs?`, `SPECTRUM_WARNING_LOG_INTERVAL_MS` (60 000)                                                                                                                                                                                                             |
| `packages/api-types/src/storage.ts`                  | `StorageReport.kept: StorageKeptSummary \| null` (was `null`); `StorageKeptSummary`                                                                                                                                                                                                                                                                                                                        |
| `packages/api-types/src/live-audio.ts`               | `LIVE_AUDIO_SILENCE_CHUNK_MS` (20), `LIVE_AUDIO_SILENCE_FILL_MAX_MS` (5 000), `LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS` (2 000)                                                                                                                                                                                                                                                                                   |
| `src/core/recordings/contract.ts`                    | `RECORDING_DELETE_PRIVATE_DIR`, `RECORDING_DELETE_VERIFIED_NAME` (`verified`), `RECORDING_DELETE_SWEEP_MAX_DIRS` (64), `DISCOVERY_RECORDING_ALIASES_MAX` (64), `RecordingKeepTotals`, `RecordingKeepTotalsSource`, `ScannerRecordingDeleter`, `RecordingDeleteSweepResult`                                                                                                                                 |
| `src/core/scanner/identify-analog-contract.ts` (new) | `AnalogEvidenceTransmission`, `IdentifyAnalogEvidence` (types only)                                                                                                                                                                                                                                                                                                                                        |

`tests/unit/core/wg10-contract.test.ts` pins every constant with its arithmetic, the identify
trial `decoder` and `reason` unions with the outcome and state lists unchanged, the result
fields, the CLI guard acceptance of a payload carrying every new field, the warning suspects,
the storage `kept` shapes, the private directory grammar (accepted and refused names), the port
shapes, and the unchanged trust vocabulary and WG9 recording codes.

Names a lane creates and Main consumes at merge (frozen here by name):

- RK2: `openRecordingKeepService` options gain `scannerDeleter?: ScannerRecordingDeleter`
  (absent: `scan:` delete 409 `RECORDING_DELETE_UNSUPPORTED`, today) and its result also
  implements `RecordingKeepTotalsSource`; `createScannerRecordingDeleter(deps)` in new
  `src/core/scanner/recording-delete.ts` (deps: the evidence and discovery store methods the
  lane's Main diffs add, a logger); `sweepRecordingDeleteLeftovers(options: { dsdFmeDirs:
readonly string[]; scannerRecordingsDir: string | null; protection: RecordingProtection;
logger: Logger }): Promise<RecordingDeleteSweepResult>` in new
  `src/core/recordings/delete-sweep.ts` (never rejects; on any error counts and returns);
  `keptSummaryOf(source: RecordingKeepTotalsSource | null): StorageKeptSummary | null` in new
  `src/core/recordings/kept-summary.ts` (pure, for the reporter diff).
- SM: none beyond its own files; the `PUT` and `POST` frequency rate write lives in
  `src/core/tuner-controller.ts` and `src/api/routes/tuner.ts`.
- ID: `createAnalogEvidenceLog(options: { now?: () => number; monitoring: (sourceId, hz,
toleranceHz) => boolean }): AnalogEvidenceLog` in new `src/core/scanner/analog-evidence.ts`,
  where `AnalogEvidenceLog extends IdentifyAnalogEvidence` adds `record(event:
AnalogTransmissionEventData): void`; `IdentifyDeps.analogEvidence?: IdentifyAnalogEvidence`;
  `liveAudioMonitoring(status: LiveDemodStatus, tunerHz: number | null, hz, toleranceHz):
boolean` (pure, same module) for Main's `monitoring` callback.

Every DTO addition is optional or a widening the CLI guards accept; no WebSocket event type is
added; no config key or default changes.

## Pipeline positions

```
DELETE /api/recordings/scan:<d>~<f> → authorizeMutation → id check → keep service (mutex, kept 409,
  mark deleting) → ScannerRecordingDeleter.deleteRecording → evidence store (serialise d, admits d
  or an alias owner, verified open, private dir, identity check, stillDeletable() + unlink in one
  turn) → discovery store forgetRecording (journal) → discovery event → inventory.invalidate
discovery merge (store absorb) → survivor.aliases += drop (persisted) → retention / recordingPath /
  holdsKept / removeDiscovery read aliases
capacity eviction (store makeRoom) → evicted ids → scanner service → evidence.removeDiscovery (per
  file decision)
startup → keep service ready → sweepRecordingDeleteLeftovers → decoders, scanner start
live audio PATCH offsetHz → reconfigure → front swap (new front, branch feeds both, switch at a
  whole sample on first output, stop old) | else full restart (clients kept, silence fill)
channel IQ block (10 ms) → ChannelSquelch (power, + quieting observer in auto nfm/wfm) → floor
  update (quieted blocks never seed or raise) → threshold
POST /api/tuner/:id/frequency → [rate unproven, internal, known → setSampleRate(same value)] →
  setFrequency → command-sent → spectrum epoch
spectrum block → § 4.7 alarm (+ mirror test, + transmission-end test) → untracked-retune epoch →
  engine warning (suspected, lastCommandAgeMs; log rate-limited)
transmission tracker "transmission" → AnalogEvidenceLog.record → identify analog trial
probe pool decoder-unavailable → memo (type, 300 s) → identify planning + decodersUnavailable
```

## CPU and IO budgets

| Item                 | Position                                | Budget                                                                                                      | How measured                                    |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| RK2 scanner delete   | per operator delete                     | one verified open, ≤ 6 lstat, one rename pair, one unlink, one journal write                                | by construction; counted fs calls in tests      |
| RK2 alias lookup     | per retention candidate / recordingPath | O(1) map lookup                                                                                             | by construction                                 |
| RK2 sweep            | once at startup                         | ≤ 2 000 discovery folders + dsd dirs listed, ≤ 4 096 entries read per directory, ≤ 64 private dirs acted on | bounds tests                                    |
| RK2 kept summary     | per storage report (cached)             | O(1)                                                                                                        | by construction                                 |
| SM silence fill      | per 20 ms while a restart is filling    | one zero buffer of 20 ms reused per format, written to each client; ≤ 250 writes per restart                | counted writes, injected clock                  |
| SM front swap        | per offset change                       | one extra front process for ≤ swap time; branch bytes written twice meanwhile                               | stand-in harness: gap p50/p90/max, load average |
| SM quieting observer | per 10 ms block, auto nfm/wfm only      | ≤ 2 % of one core at a 25 kHz channel rate; zero in other modes                                             | micro-benchmark of the block step, reported     |
| MA hygiene meter     | per 10 ms block, manual nfm/wfm only    | ≤ 2 % of one core at the nfm and wfm channel rates (R2: 1.9 µs at 25 kHz, 8.3 µs at 293 kHz per block)      | `scripts/bench/carrier-meter.ts`, load avg 5.0  |
| MA hygiene tracker   | per squelch edge, PCM chunk, level      | O(1); a second tone detector only in a resumed segment after a toned one                                    | by construction                                 |
| SM alarm extras      | per alarm candidate block only          | O(features × segments), as the alarm                                                                        | by construction                                 |
| SM rate write        | first operator frequency per connection | one extra rtl_tcp command                                                                                   | counted commands in tests                       |
| ID evidence log      | per transmission event                  | O(1) append, ring of 32                                                                                     | by construction                                 |
| ID lookup            | per identify tick                       | O(32)                                                                                                       | by construction                                 |
| ID memo              | per probe start / plan                  | O(decoder types)                                                                                            | by construction                                 |

## Recording follow-ups (lane RK2)

**Scanner delete.** `keep-service.remove` accepts a `scan:` id when `scannerDeleter` is given:
same order as the dsd-fme delete (ready, id grammar, kept 409, mark deleting, mutex, kept again),
then `scannerDeleter.deleteRecording(recordingId, () => ready() && !protecting.has(key))`;
`not-found` → 404; `deleted` → 200 `{ id, deleted: true }`; invalidate in `finally`. The scanner
deleter (`recording-delete.ts`, lane file) calls two methods the lane adds by exact Main diff:
`EvidenceStore.deleteRecording(recordingId, stillDeletable)` (under `serialise(discovery)`;
refuses an `analog-<uuid>.wav` name and a discovery in `removals` (busy); resolves the path for
the discovery or its alias owner like `recordingPath`, refuses a symlink anywhere in the chain
from the pinned root (the `chainIntact` / `rootIntact` helpers); the delete itself is the WG9
verified unlink, extracted by the lane into a shared helper in `src/core/recordings/` with the
WG10 progress names (moved entry keeps its basename; renamed to `verified` after the identity
check; `stillDeletable()` and the unlink in one turn) and reused by the dsd-fme delete) and
`DiscoveryStore.forgetRecording(recordingId)` (journaled op: removes the id from the observation
holding it, `evidence.recordings` minus one, floor zero, `updated` change). Scanner service
diff: constructs the deleter and exposes it (`scannerRecordingDeleter()` getter) for Main to
pass into the keep service.

**Merge aliases.** `DiscoveryStore` absorb appends the dropped id (and the dropped discovery's
own aliases) to the survivor's alias list (persisted in the store state and journal entry,
bounded by `DISCOVERY_RECORDING_ALIASES_MAX`, oldest released with a counted warn). The store
exposes `aliasOwner(discoveryId): string | undefined` and `aliasesOf(discoveryId)`. Evidence
store: `admits(id)` also admits an alias whose owner is live; `retention(keep)` treats a file in
an alias folder as its owner's (`keep.has(owner)`); `removeDiscovery(S)` removes S's alias folders
in the same serialised removal (each through the per-file decision); `holdsKept(S)` is true when
S or any alias holds a kept key. The keep service is unchanged (keys still name the folder's own
id). The API `Discovery` DTO is unchanged (aliases are internal).

**Eviction.** `makeRoom` reports the evicted ids (op `deleted` of the `evict` entry); the scanner
service removes their evidence like `pruneInactive` ids (emit `deleted`, `removeDiscovery`, warn
on failure with a count). Exact diff.

**Kept totals.** `keep-service` keeps a running count and byte sum of committed keeps
(`totals()`); `keptSummaryOf` maps state and totals to `StorageKeptSummary`; the reporter diff
(Main-only `src/core/storage-report/reporter.ts` and `contract.ts`: option `kept?: () =>
StorageKeptSummary | null`, default null) is exact in the report.

**Sweep.** `delete-sweep.ts` lists, bounded, each configured dsd-fme directory and its `WAV`
folder and each `recordings/dv/<discovery>` folder (≤ 2 000 folders, the inventory bound) for
names matching `RECORDING_DELETE_PRIVATE_DIR`; for each (≤ 64): lstat chain from the configured
root with no symlink, a directory, `uid === process.getuid()`, `(mode & 0o7777) === 0o700`;
`readdir` (≤ 4 entries considered); act per requirement 1.9 (restore uses `link` then `unlink`,
never `rename` over a name; `verified` is unlinked only while the keep store is `ready`; a
not-ready store restores nothing and deletes nothing: everything is left). Runs before decoders and the scanner start. The existing delete in `keep-service.ts`
adopts the progress names.

**Capture store.** `init()` lstats `captures/.tmp` (not a symlink, a directory, else warn and skip
the sweep), unlinks only regular files inside it, and the torn-file loop skips anything that is
not a regular file (the `.tmp` directory included).

Fail closed: every new path answers "protected" or "leave in place" on an unknown, throwing or
malformed input; no path, name, id or key in a log or body.

## Live audio, squelch and tuning trust (lane SM)

**Clients survive** (2.1): `restartPipeline` already closes only clients whose rate or format
changed; the lane pins it with goldens and keeps it through the new paths. The web's
"Connecting…" was the player's ring running dry during the restart gap (the HTTP response stays
open), so the fix is continuity, not reconnection.

**Silence fill** (2.2): a `SilenceFill` helper (lane file) owned by the demodulator: armed when a
restart (full or fallback) stops the old run while clients are attached and the planned stream
format equals the old one; every `LIVE_AUDIO_SILENCE_CHUNK_MS` it writes one reused zero buffer
of whole samples to the registry (not `emitPcm`), driven by stream time from an injected clock;
disarmed at the first `handleAudioData` of the new run, on stop, on failure, at
`LIVE_AUDIO_SILENCE_FILL_MAX_MS`. The registry's partial-sample remainder is cleared at arm and
disarm.

**Front swap** (2.3): `reconfigure` computes the changed pipeline keys; when they are exactly
`{offsetHz}` and the new plan's `channelSampleRate` and `back` string equal the running ones, it
calls `swapFront(run, plan)`: spawn the new front (same `spawnStage`), pipe the branch into it
too, wait for its first stdout chunk (or the timeout / an exit / an error), then unpipe the old
front stdout from the squelch stream, discard the squelch stream's partial complex sample (an
explicit `resetAlignment()` on the measured transform), pipe the new stdout into it, apply the
retune floor handling, and stop the old front's process group (`killGroup`). `PipelineRun.front`
becomes the new process; exit handlers of the old front are detached before its kill so its
exit is not a run failure. The transmission close override stays as today for an offset change
(`liveDemodTransmissionConfigChanged` decides).

**Auto floor** (2.6): in auto mode on nfm/wfm the demodulator asks `ChannelSquelch` for the
block's quieting (a `NoiseSquelch` observer built only in that case; `lastQuietingDb` per block).
`measureRun`: a quieted block skips the seed and the rise (falls below the floor still apply);
while `noiseFloorDbfs === null` the gate is driven by the observer's open/closed decision (the
power threshold is not used until a floor exists). Manual and noise modes and the other
modulations take today's code path unchanged (goldens).

**Operator rate write** (2.8): `tuner-controller.ts` gains `proveSampleRateForFrequency(sourceId,
opts)` (lane name, internal): when control mode is internal, the rate is neither unknown nor
ignored, and (`declaredOnlyFields` has `sampleRate` or `tuningWrittenOnConnection` is false),
it calls `setSampleRate(sourceId, state.sampleRate, opts)` once per connection epoch (a
per-source flag reset where `connectionTuningWrites` resets). The frequency route and
`configure` (frequency set, sample rate absent) call it before `setFrequency`. External or relay
control: never called (the existing control-mode check refuses the command anyway; the helper
returns before it).

**Untracked-retune** (2.9). Candidate causes to confirm or rule out, each with a synthetic test:
(1) byte slip: the engine's `applyGap` re-aligns by `skipBytes` from fanout drop telemetry; check
the mark position (`queueStreamBoundary`, `bpMark`) against the bytes actually delivered, the
`SourceManager` rtl_tcp header strip on reconnect, and any path that forwards an odd byte count
(Δ = -2 × offset of the dominant features is the signature: a strong carrier at +136.5 kHz shows
as -273 kHz); (2) a strong transmitter with images and intermodulation lines learnt as persistent
features (10 s tracks, `spurs.rfCarriers()`) vanishing together when it unkeys (Δ null); (3) a
core command whose epoch boundary lands one block late, so the alarm compares across the retune
(live audio does not retune; scanner hop rate write; relay replay; 2.8); (4) reconnect. The
alarm gains two classifiers run only when it fires: mirror (most vanished features reappear at
`2·centre − f` within tolerance → `iq-byte-slip`; as landed (R1) this is a `suspected` label
only: the engine no longer re-aligns a U8 stream on a mirror) and transmission end (as landed:
a closed strong track, and width-matched survivors of the old scene, at least 2: centre within
`max(1 bin, width/4)`, width in `[width/2 - 2 bins, 2*width + 2 bins]` → `signal-change`, no new
epoch: the features are dropped from `prevPersistent` and the epoch keeps its label; the
decision can wait up to the track hang plus 2 blocks). `external-control` otherwise. `lastCommandAgeMs` from the engine's last `command-sent` time.

Discontinuity evidence (scanner amendment A16): only persistent features at least 10 dB
above their recent local detection threshold count toward the § 4.7 alarm or its
classification. Weak disappearances are not retune evidence; three strong features are
required before arming. Strength must stay at least 10 dB above threshold for
1 s of consecutive present blocks (the window minimum, never a one-block maximum).
A weak or absent block resets qualification; epoch changes, gaps, overload and stale
discards clear it. Measure only the current segment's half-open bin span, skipping
detector masks (including DC and exclusions) and spur-line bins. RF carriers require
a current matching segment. The 1 s window rejects brief spikes while retaining
sustained scene-loss evidence once features qualify.
After an epoch start or a reset, a real retune before features qualify is not
detected by this alarm: RF carriers need 1 s of sustained strength, and ordinary
tracks additionally need the existing 10 s age. A vanished scene cannot qualify
retrospectively. This is the accepted trade-off against false alarms.

## Identify for analog voice (lane ID)

**Evidence log** (`analog-evidence.ts`): a ring of the latest 32 transmission events by id
(an open event inserts, its closed event replaces it), sourced from the tracker's
`transmission` events, with `hz`, trust, modulation, tone and DCS copied from the event (a closed
event without `tone` gives `ctcssHz: null`, `dcs: null`). `transmissionsNear` filters by source,
`|hz − target| ≤ tolerance`, open or `endedAtMs ≥ sinceMs`. `monitoring` delegates to the
callback Main builds from `liveAudioMonitoring(liveDemod.getStatus(), tunerHz, hz, tol)`
(running, source matches, tuner frequency known, `|tunerHz + offsetHz − hz| ≤ tol`).

**Identify** (`identify.ts`): with `analogEvidence`, `planIdentifyTrials` plans `analog-fm` and
`analog-am` as `transport: "ambient"`, `decoder: "live-audio"`, mode the live-audio modulation
or `null` until known, `run: null`; each tick re-reads the evidence with `sinceMs = job start −
IDENTIFY_ANALOG_LOOKBACK_MS` and tracks whether `monitoring` was ever true; outcomes and verdict
per requirements 3.2 to 3.4. `identifyVerdict` gains an optional `analog` input (pure) so the
verdict stays one function: digital decode first, then analog-with-tone-and-trust =
`identified`, analog otherwise = at least `candidate`. Without the port: byte-identical
(goldens). As landed (R1): a classified digital discovery keeps its protocol; analog evidence is
supplementary (`result.analog`). `planAnalogTrials` plans both analog protocols when either is
scored and the request has no protocol list; with a list it plans only the analog protocols
named. The evidence log reads the tracker's published transmissions, so the activity hygiene
rules (requirement 3.7) apply to identify too.

**Activity hygiene (Main, requirement 3.7; R2 as landed)** (`analog-transmission.ts`). One held
transmission of squelch segments. A segment's audio is `max(start, close − hang) − start`; the
transmission's audio is the sum (gaps excluded), its `durationMs` the span. Carrier evidence is the
source's monotonic `carrierBlocks()` count taken per segment (base at the segment open, a null
count on resume keeps the last base); the rule takes the best single segment, not a share or a sum.
At each segment end the tracker snapshots the transmission's gated tone; a resumed segment after a
toned snapshot gets a second detector and its own power and audio counters, and when that detector
confirms a CTCSS/DCS identity disjoint from the snapshot's, the held part is finalised at its gap
end (snapshot tone, held counters) and the segment is promoted to a new transmission (new id, its
own start, the second detector). `pending()` exposes an unannounced open segment still under the
minimum audio; Main binds it into the evidence log (`setPending`, `pendingNear`, an optional port
method) so identify's `analogStep` treats it like an open match at the deadline. Identify keeps a
live-audio trial with an open or pending match running until `deadline + IDENTIFY_ANALOG_SETTLE_MS`
(other ambient trials still end at the deadline), then `timeout`. Manual nfm/wfm keeps the passive
meter for both modulations: measured well inside the budget (table above), so wfm is not restricted.

**Unavailable memo** (`probe-pool.ts`): `unavailableTypes()` (types seen `decoder-unavailable`
within 300 s, cleared by a successful start of the type), checked by identify at planning;
identify collects `decodersUnavailable` from the memo and the job's own events.

**Startup minors** (requirement 4.2; ID owns `src/core/spectrum/spectrum-service.ts` for this
only): the subscriber path logs the pre-connect engine start failure at debug when the source
has no caps; the passive job attempt in `scanner-service.ts` is skipped (debug) while the source
has no caps, via an exact Main diff; a test shows the `connected` retry builds it.

## Main wiring

- RK2: `src/index.ts`: pass `scannerDeleter: scanner.scannerRecordingDeleter()` (late-bound like
  the WG9 protection, fail closed until set: `RECORDING_DELETE_UNSUPPORTED`), run
  `sweepRecordingDeleteLeftovers` after the keep service resolves and before decoders and the
  scanner start, pass `kept: () => keptSummaryOf(recordingKeeps)` to the storage reporter (in
  protected mode; legacy null); apply the store, evidence, scanner-service and reporter diffs and
  their tests.
- SM: nothing outside its files (rate write is inside the tuner controller and route).
- ID: `src/index.ts`: `const analogEvidence = createAnalogEvidenceLog({ monitoring })`,
  `transmissions.on("transmission", e => analogEvidence.record(e))`, pass it to the scanner
  service (diff adds `ScannerServiceDeps.analogEvidence?` and passes it into `IdentifyRunner`);
  the passive pre-connect diff.
- Docs, coordination note, CLI grep, contract test updates after merges.

## Correctness properties

1. **No scanner delete of a kept or unverified file.** For random keeps, files, swaps (file,
   folder, symlinked ancestor) and interleavings of Keep, unkeep, delete and retention (fake fs,
   injected scheduler), no kept key's file is unlinked, every unlink targets the verified file,
   and `recordingIds` / `evidence.recordings` lose exactly the deleted id. _Validates 1.1–1.3._
2. **Aliases keep meaning.** For random merge sequences (≤ 70 merges into one survivor) with
   operator keeps and recording keeps, retention never deletes a file in an alias folder of a
   kept survivor, `holdsKept(survivor)` is true whenever an alias folder holds a kept key, and
   removing the survivor removes exactly its own and its alias folders (none when one is kept).
   _Validates 1.5, 1.6._
3. **Sweep touches only provable leftovers.** For random directory trees (names, modes, owners,
   symlinks at any level, entry sets), the sweep unlinks only a `verified` regular file in a
   provably ours directory while the store is ready, restores only
   without replacing, and leaves everything else byte-identical. _Validates 1.9._
4. **Clients stay, time stays filled.** For random sequences of reconfigures (offset, modulation,
   squelch, bandwidth) and pipeline failures with fake processes and an injected clock, no client
   is closed unless the stream format changed, and while a fill is armed every 20 ms of stream
   time delivers one silence chunk until real audio or the bound. _Validates 2.1, 2.2._
5. **Offset swap keeps the back.** For random offset changes with fake processes, the back
   process is never respawned, exactly one new front is spawned per change, the old front is
   always stopped, and the squelch input stays complex-sample aligned. _Validates 2.3._
6. **A carrier never seeds the floor.** For random block sequences (quieted or not, powers,
   retunes) in auto nfm/wfm, no quieted block's power is ever the seed or raises the floor, and in
   manual and noise modes the floor and gate trace equal the frozen code's. _Validates 2.6._
7. **Rate written once, only when unproven.** For random tuner states (control mode, unknown,
   declared-only and written fields, connection epochs) and frequency requests, the rate is
   written iff internal control, the rate known and unproven, at most once per connection, with
   the value unchanged. _Validates 2.8._
8. **Alarm classification.** For random feature sets and segment sets (mirrored, shifted,
   vanished on a transmission end, genuine retune), a mirrored set is `iq-byte-slip`, a genuine
   common shift still raises the alarm with that Δ, and a transmission end raises no new epoch.
   _Validates 2.9._
9. **Analog evidence fails closed.** For random transmissions (frequency, trust, tone, timing,
   modulation) and targets, identify names analog only from a transmission within the tolerance
   and the window, says `identified` only with a reported tone and a trusted frequency, and never
   reports a tone the tracker did not. _Validates 3.1–3.4._
10. **Memo is honest.** For random probe event sequences, a trial is `decoder-unavailable` only
    for a type observed unavailable within the memo window (or in this job) and never after a
    successful start of that type. _Validates 3.5._
11. **Hygiene output is sound.** For random squelch, carrier, level and clock sequences, published
    rows never overlap, never exceed the openings, each opens once then closes once on WS, and
    every row lasts at least the minimum with carrier evidence on nfm/wfm. _Validates 3.7._
12. **A qualifying opening is exactly one row.** For random segment sequences (open time, quieted
    blocks while open and while closed, gaps inside and past the merge gap), the published rows are
    exactly the oracle's merge groups with summed audio ≥ 500 ms and (nfm/wfm) one segment with ≥ 3
    quieted blocks, in order and by start; every other group is counted suppressed. _Validates 3.7._

## Amendment 2026-10-24: carrier-bounded transmissions (requirement 3.8)

Additive to "Identify for analog voice" and Properties 11 and 12; the 3.7 text records what
landed and stays. Pipeline position unchanged: the tracker listens to the live demodulator's
`squelch-changed`, `level`, `config-changed`, `stopped` and `pcm` events and now also reads a
block log the demodulator fills.

### Why

3.7 qualifies a transmission by carrier but delimits it by power: any squelch re-open within
1500 ms of the previous segment's audio end resumes it and re-arms the gap timer. Live timeline
(status samples about every 0.55 s, nfm, auto squelch, floor about -55 dBFS, threshold about
-49 dBFS): interference near -45 dBFS opened the squelch every 0.52 to 1.1 s for 214 s; overs
near 0 dBFS ran at about 19.1-26.0, 33.7-41.0, 54.9-61.6, 75.9-81.0 and 84.4-88.8 s, and after
each over the interference held the power squelch open. Every gap was under 1500 ms, so the
chain never ended; the only tone report (at 214.5 s) was null.

### Why a block log, not a snapshot

PCM reaches the tracker asynchronously (`handleAudioData`), several measured blocks can pass
between two tracker observations, and the Rust engine reports metrics in batches of ten 10 ms
blocks, possibly after the matching audio. A latest-value snapshot would lose runs (10 carrier
blocks followed by one noise block before the next observation reads as run 0) and would accept
a whole chunk that mixes noise and carrier blocks. So the demodulator logs every block, the
tracker consumes the log in order, and PCM is matched to blocks by output-sample position.

### Hook (live demodulator, three lines)

`CarrierBlockLog` lives in `src/core/analog-transmission.ts`: a fixed `Uint8Array` ring of
`CARRIER_LOG_CAPACITY` (2048 blocks, 20.48 s) flags (bit 0 squelch open, bit 1 carried), the
run's block count, its PCM byte count, the block length `B = max(1, round(rate × 10 / 1000))`
samples (the same rounding as `ChannelSquelch`), `blockMs = B / rate × 1000` and an epoch that
increments when the run object changes. `LiveDemodulator` holds one instance and calls
`note(run, run.stream.rate, reportedOpen, carried)` where it already counts `carrierBlockCount`,
`notePcm(run, run.stream.rate, chunk.length)` first in `handleAudioData`, and exposes
`carrierBlockLog()` (null exactly when `carrierBlocks()` is null). After each noted block the log calls its
`onBlock` listener (set by the tracker), so the tracker consumes blocks as they are measured and
samples config and frequency at block time; a batch is consumed in order. The block-time anchor
is `clock - blocks × blockMs` at first sight, lowered to the least such estimate while no run,
span or transmission is held (a logged block is never earlier than its stream time). Both engines emit output PCM
at the squelch rate (csdr: channel rate; Rust: 48 kHz with 480-sample blocks), so block `k`
covers output samples `[k × B, (k + 1) × B)`. Known offsets, not compensated: the csdr back
chain's filter delay (a few samples) and Rust startup metrics dropped beyond the handshake
buffer (the log then lags; a resync at the next run). No `src/core/live-demod/**` change.

### Rust event order (amendment 2026-10-24, review fixes)

Native sends a `gate` change at once with `atOutputSample` at the end of the block that decided
it, and `metrics` in batches of ten blocks later. Gate notifications are not delayed:
`squelch-changed`, the tone squelch and every other listener see a change when it arrives, as
before 3.8. Instead `RustEngine` keeps a position-indexed gate history (`GATE_HISTORY_MAX`, 256
changes; native sends at most one per block, so it covers at least 2.56 s, more than the 8-batch
startup buffer's 80 blocks plus one batch of lag; an evicted change becomes the window's base
state, native starting closed) and hands each metrics batch its `atOutputSample` and the gate
state of every block (the latest change at or before the block's end). `rust-run.ts` passes both
to `measureRun` as `blockIndex` (`atOutputSample / 480 + i`) and `gateOpen`, and the block log
notes block `blockIndex`: blocks never reported (startup batches beyond the buffer's 8, dropped
lines) are filled closed and uncarried, so block `k` of the log is always output samples
`[480 k, 480 (k + 1))`. The startup buffer is unchanged (last gate, newest 8 batches); no
position is lost because every batch carries its own. Audio alignment (checked in
`native/wavekit-chan`): the channel counts `atOutputSample` from its first output sample, and the
runtime queues output from that sample until the client connects, so socket byte `n` is output
sample `n / width`. The exception is a full queue: native then drops samples and reports a
`discontinuity` event (`sampleIndex`, `droppedSamples`, `queue-overflow`), which the TypeScript
protocol does not parse today; after one, the mapping is off by the dropped count until the next
run (open item). No existing Rust test changed.

### Tracker carrier path

`drainCarrier()` processes every new block `k` once, in order (block time
`t(k) = anchor + k × blockMs`, anchor set when an epoch is first seen):

- `open && carried`: the run grows (start remembered). In a span the block is fed and the
  span's carrier end becomes `t(k + 1)`. Outside a span, the run's blocks stay undecided until
  it reaches 10 blocks (span start = run start: merge or open, the 10 blocks fed) or breaks
  (the blocks are dropped and counted in `discardedRuns()`).
- otherwise: the run breaks; the block is dropped; in a span, a closed block or the 25th
  uncarried block in a row ends the span at its carrier end (audio += carrier end - span start).
- finalisation, outside a span: once `t(k + 1) - carrierEnd > 1500 ms` and no run that started
  at most 1500 ms after the carrier end is pending, close with reason `squelch` at the carrier
  end. A run that starts at 1490 ms and qualifies at 1590 ms therefore merges; the 3.7 gap timer
  is not used on this path, so a timer firing early cannot finalise.

Merge test: `t(spanStart) - carrierEnd ≤ 1500 ms` plus the 3.7 identity checks. Retune and
max-duration closes inside a span reopen at once (max-duration as an exempt continuation);
stop and config close at the event time. A new epoch ends an open span at its carrier end.

### Tone input

Span end and delayed PCM: the segment stays open for a tone split, and the span-end tone snapshot
(the split reference) and the split detector wait, until the PCM up to the span's carrier end has been consumed, at most
`CARRIER_SNAPSHOT_WAIT_BLOCKS` (50 blocks, 500 ms), and are settled at once when a new span
merges. Late PCM of an ended span is still fed to its transmission until finalisation (1500 ms
later); later PCM is dropped. A closing config change or teardown edge also clears the run and
span, so blocks after it need a new 10-block run. PCM ring overflow evicts whole samples only
(the head stays on a sample boundary; dropped bytes count in `droppedPcm()`); dropped audio is
treated like a fade (removed, never misframed).

Feed decisions are a per-block ring (undecided, feed, drop). PCM is copied into a ring sized
once per PCM format (`CARRIER_PCM_RING_MS` 2000 ms: at most 48 kHz × 4 B × 2 s = 384 kB) and
drained while the oldest buffered sample's block is decided; each piece ends at a block boundary,
so a mixed chunk is cut there. Fed pieces go to the transmission's detector (and the split
detector) if the block is at or after its start. PCM older than the decision ring, or beyond the
PCM ring, is dropped unfed. Considered and rejected: per-segment detectors (run the banks on
every interference segment, cannot join continuity across segments of one over, still need a
carrier gate since interference holds the squelch open after the over).

Fades: uncarried blocks inside a span are removed, not replaced, so they lower no vote by
noise; the cost is a phase splice per fade. A CTCSS analysis block (500 ms, hop 250 ms) holding a
splice may lose its vote, so one splice can cost 2 of the 4 votes per second; 60 % continuity
then survives at most one splice per 1.25 s of fed audio. The requirement states the weaker
"one fade per 2 s" and the tests check CTCSS and D031N with a 50 ms fade every 2 s; no guarantee
is claimed beyond it.

Cost: per block one byte write in the demodulator and a few integer operations in the tracker
(100 blocks/s); per chunk one `Buffer.copy` into the ring and at most two `subarray` views per
fed piece (no buffer allocation). Interference audio runs no detector (3.7 fed it all).

### Squelch tail elimination (3.8.12)

An over on the user's PMR446 radios is speech with CTCSS, then about 0.4 s of 55 Hz STE with the
carrier still up, then the carrier drop. The STE blocks are carried, so the span, and the
transmission, end at the carrier drop. CTCSS safety: the bank holds only the 50 standard tones,
67.0-254.1 Hz (no lower entry). A 500 ms Goertzel block has its first null at 1 / 0.5 s = 2 Hz,
so 55 Hz lies 12 Hz = 6 bins below the lowest tone, where a rectangular window leaks about
1 / (π × 6)² ≈ -35 dB; 55 Hz is inside the 50-300 Hz reference band, so a 55 Hz-only block puts
under 0.1 % of the band in any tone bin, far under the 0.65 vote fraction. Continuity: blocks hop
250 ms, so a 0.4 s tail touches at most ceil(0.4 / 0.25) + 1 = 3 blocks; with N completed blocks
the tone keeps 60 % if (N - 3) / N ≥ 0.6, so N ≥ 8, i.e. at least 0.5 + 7 × 0.25 - 0.4 = 1.85 s
of CTCSS before the tail. Shorter overs may lose their tone (stated, not guaranteed). A phase
reversal (120° or 180°) instead of a tone lowers the magnitude of the blocks that straddle it
(at most 2, plus the reversed tail if it is longer than one hop); the same bound applies and the
transmission still ends at the carrier drop. Tests: 5 s CTCSS 79.7 + 0.4 s 55 Hz is one
transmission ending at the drop with 79.7; 55 Hz alone for 0.6 s and 3 s reports no CTCSS; a
180° reversal for the last 0.2 s keeps 79.7.

### Consumers

No contract change (REST, WS `transmission`/`closed` events, Activity rows, identify
`result.analog`). Activity: fewer rows, one per over, `startedAt` at the carrier, `endedAt` at
the last carrier, tone filled; aggregates follow. Identify: evidence from carrier transmissions
only; `pending()` is non-null only with a qualified span, so interference no longer triggers the
1750 ms settle wait (`no-sync` instead of `timeout`). Scanner hits (WG12 6.3 live-audio
evidence): same stream. Recordings: unaffected.

### Deliberate test changes

Existing tracker suites use fakes without `carrierBlockLog`, so they take the fallback and stay
as they are. Changed deliberately in `live-demodulator-wg7.test.ts`: the noise-mode transmission
and mode-switch tests feed 60 carrier blocks (600 ms) instead of 20 and 10, because span audio
now counts blocks, not the test clock; the tone-gate integration test feeds one carrier block per
10 ms of PCM, because PCM is matched to blocks by position. A teardown squelch edge (stop or a
transmission-closing reconfigure) still closes at once on the carrier path. Suites with a real `LiveDemodulator` and a tracker (`live-demodulator-wg7`) and the
identify and Activity consumers (`scanner/identify-analog`, `scanner/live-audio-evidence`,
`activity/runtime-transmission`) are run unchanged; any change is listed with 3.8.

### Synthetic boundary regression (shaped on the live timeline)

The live status log has about one sample per 0.55 s and no per-block quieting, so it fixes the
shape, not the evidence. The test script, at 10 ms blocks: floor closed; interference opens of
500 ms every 1000 ms with carried blocks only in runs of at most 3; five overs of 6.9, 7.3, 6.7,
5.1 and 4.4 s from 19.1, 33.7, 54.9, 75.9 and 84.4 s, every block carried, each opened by an
interference open 300 ms earlier and followed by 1 s of interference holding the squelch open;
PCM is CTCSS 79.7 Hz during overs and noise otherwise. Expected: five transmissions at the
over bounds (± 10 ms), CTCSS 79.7 each. It proves the boundary logic only.

### Live acceptance plan (Main)

On the live receiver, PMR446 ch5 with the interference present: (1) log, for a test build or a
debug probe, the longest carried run in each interference opening for 10 minutes and confirm none
reaches 10 blocks (if any does, raise the bound or add a power or deviation condition by a new
amendment); (2) key five 5 s overs with CTCSS 79.7 and five with D031N and confirm ten Activity
rows of about 5 s with the tones; (3) confirm no Activity row during 10 minutes of interference
alone.

### Properties

13. **Spans bound transmissions.** For random block scripts (squelch, carrier, fades, gaps)
    delivered in random batches, published transmissions are exactly the oracle's span groups
    (runs of ≥ 10 open carried blocks, merged within 1500 ms of the last carrier end, ≥ 500 ms of
    span audio), start at the first span start and end at the last carrier end; a script without
    a 10-block run publishes nothing. _Validates 3.8.2-3.8.6._
14. **Tone hears only carrier.** For the same scripts with PCM split at random byte offsets, the
    samples pushed to the detector are exactly those of fed blocks, in order. _Validates 3.8.7._

### Follow-up 2026-10-24: retune hold, pending snapshots, discontinuities, STE

- **Retune hold.** `measureRun` logs `gateOpen && !run.gateHeld && !run.stopping`: per-block
  native gate state cannot open a block the host holds closed (a retune before its `retuned`).
- **Pending snapshot across a merge.** `startSpan` no longer forces the previous span's snapshot:
  it closes only that span's gap books, resumes with a split detector whose reference tone is
  pending, and `drainPcm` settles the snapshot exactly when the PCM through the previous span's
  last carrier block is consumed, before any later block reaches the main detector (cap 50
  blocks).
- **Discontinuities.** `rust-protocol.ts` parses `discontinuity` (`sampleIndex`, `droppedSamples`
  positive safe integers, `cause` a short lower-case token; anything else is dropped as a bad
  line and never logged). The engine forwards it, `rust-run.ts` (startup: at most 16 buffered)
  passes it to the host, and `CarrierBlockLog.noteDiscontinuity` advances `pcmBytes` by the
  dropped samples and masks blocks `[sampleIndex / 480, (current position + dropped) / 480)`
  (at most 8 masks). The tracker fills the position gap with silence that is never fed. Residual:
  blocks the tracker already decided before the event arrives keep their decision.
- **STE (3.8.13).** Chosen: end the tone window at STE onset by a one-window hold-back, rather
  than excluding STE blocks from the CTCSS continuity denominator, which would need a change
  inside the shared CTCSS bank. The tracker runs one 55 Hz Goertzel over each 200 ms window of
  transmission-detector audio (`CARRIER_STE_WINDOW_MS`; 200 ms is 11 whole cycles of 55 Hz, so
  DC and the bin are orthogonal; 67 Hz lies 2.4 bins away and leaks about
  (sin(2.4 π) / (2.4 π))² ≈ 1.6 % of its power, far under `CARRIER_STE_FRACTION` 0.5). A window
  is STE when `2 |X|² / (N E) ≥ 0.5`; it and the rest of the span are not fed. A partial window
  under half a window is never judged STE. Minimum: CTCSS needs 0.75 s of fed tone (two agreeing
  500 ms blocks); at worst the onset window, up to 200 ms of tone, is dropped with the tail, so
  0.75 + 0.2 = 0.95 s of CTCSS before the tail is guaranteed. Tests: 1.2 s and 0.95 s report
  79.7 Hz with a tail six times the CTCSS amplitude (0.95 s fails without the hold-back), 0.7 s
  reports none; 55 Hz alone for 0.6 s and 3 s reports none; 67.0 Hz for 3 s and 1.2 s plus a tail
  reports 67.0. Measured: with a moderate tail (twice the CTCSS amplitude) 1.2 s already reported
  the tone before this change; the earlier 1.85 s bound was pessimistic. Cost: per fed sample one
  Goertzel step, one square and one copy into the preallocated window (allocated once per PCM
  format); the tone results arrive up to 200 ms later.
