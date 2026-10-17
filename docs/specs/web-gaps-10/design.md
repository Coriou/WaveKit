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
