# Web gaps 8 design (WG8)

Status: contract frozen; lanes in progress. Requirements in [requirements](requirements.md),
tasks in [tasks](tasks.md). Background: the WG4 station write layer (the store pattern), WG6
decoder option schemas and descriptors, WG7 bounded options and the safe error fields, the
access spec (protected mode, download leases), the dsd-fme call recordings and their pruner, the
scanner evidence store, the WG1 spectrum profiles and the viewed-slice spectrum service.

## Contract (frozen)

| File                                                             | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/decoder-settings.ts` (new)               | `DECODER_SETTINGS_REQUIRES_ACCESS` (true), `DECODER_SETTINGS_FILE_NAME`, `DECODER_SETTINGS_FILE_MAX_BYTES` (262 144), `DECODER_SETTINGS_MAX_DECODERS` (256), `DECODER_SETTINGS_MAX_KEYS` (64), `DECODER_SETTINGS_BODY_MAX_BYTES` (16 384), `DECODER_SETTINGS_PATCHABLE_TYPES`; `DecoderSettingValue`, `DecoderSettingSource`, `DecoderOptionSetting`, `DecoderSettingsView`, `DecoderSettingsUpdate`, `DecoderSettingsUpdateResult`, `DecoderSettingsErrorCode`, `DECODER_SETTINGS_ERROR_STATUS`, `DecoderSettingsErrorBody` |
| `packages/api-types/src/decoders.ts`                             | optional `DecoderOptionDescriptor.patchable` (absent = false); `effect` comment                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/api-types/src/recordings.ts` (new)                     | `RECORDINGS_REQUIRES_ACCESS` (true), `RECORDINGS_ROUTE`, `RECORDINGS_FILE_ROUTE`, page, cursor, scan, header and concurrency bounds, `RECORDINGS_IN_PROGRESS_MS` (= `RECORDING_IN_PROGRESS_MS`), `RECORDING_INVENTORY_ID`, `RecordingInventoryKind`, `RECORDING_INVENTORY_KINDS`, `RecordingCallType`, `RecordingInventoryItem`, `RecordingInventoryQuery`, `RecordingInventoryPage`, `RecordingInventoryErrorCode`, `RecordingInventoryErrorBody`                                                                           |
| `packages/api-types/src/spectrum.ts`                             | `SpectrumBinsCapSetting`, `SPECTRUM_BINS_CAP_SETTINGS`, `SPECTRUM_BINS_CAP_CHOICES`, `SPECTRUM_BINS_CAP_FLOOR` (2 048), `SPECTRUM_BINS_CAP_CEILING` (8 192), `SPECTRUM_SUMMARY_BINS_MAX` (8 192), `SPECTRUM_BINS_BUDGET`, `SpectrumBinsCapView`; optional `SpectrumLimits.binsCap`                                                                                                                                                                                                                                           |
| `packages/api-types/src/scanner.ts`, `src/core/scanner/types.ts` | identical optional `ws.spectrumBinsCap` on the settings values                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/api-types/src/index.ts`                                | barrel exports of the two new files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/config.ts`                                                  | optional `scanner.ws.spectrumBinsCap` (`"auto"`, 2 048, 4 096, 8 192; absent = `"auto"`, no default filled in). `spectrumSummaryBins` keeps max 2 048 until SB merges (Main raises it to `SPECTRUM_SUMMARY_BINS_MAX` then). No default changes                                                                                                                                                                                                                                                                               |
| `src/core/spectrum/subscribe-options.ts`                         | `PROFILE_BINS_CEILING`, `PROFILE_BINS_FLOOR`; `PROFILE_LIMITS` unchanged (its `bins.max` is the floor cap)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/decoders/settings/contract.ts` (new)                        | `DECODER_SETTINGS_SCHEMA_VERSION`, `DecoderOverride`, `DecoderSettingsFile`, `DecoderSettingsManagerPort`, `DecoderSettingsService`, `DecoderSettingsServiceOptions`, `DecoderSettingsError`                                                                                                                                                                                                                                                                                                                                 |

`tests/unit/core/wg8-contract.test.ts` pins the constants, the error statuses and bodies, the
patchable invariants by meaning (secret, type, closed set, never-patchable key meanings), the
inventory id pattern (accepted and refused examples, traversal included), the bins cap setting
and budgets, today's profile limits, the config defaults and refusals, the settings type
identity and the config export of the new key.

Names a lane creates and Main consumes at merge (frozen here by name):

- ST: `openDecoderSettingsService(options: DecoderSettingsServiceOptions):
Promise<DecoderSettingsService>` in `src/decoders/settings/service.ts`; `setManager(port)` on
  the returned object if the manager is created after the service (or `options.manager`);
  `isPatchableOption(type, key): boolean` in `src/decoders/settings/patch-policy.ts`;
  `effectiveDecoderConfig(config, override | undefined): DecoderConfig` in
  `src/decoders/settings/layers.ts`; `patchable: true` on the reviewed descriptors.
- DP: `DecoderManager.stageDecoderOptions(id, options)` and `DecoderManager.isRestartPending(id)`
  (the `DecoderSettingsManagerPort`); the rebuild at the next start, announced by
  `decoder:created`; `DecoderRoutesOptions.settings?: DecoderSettingsService` and
  `DecoderRoutesOptions.authorizeSettings?: (request) => DeniedAdmission | undefined` (absent
  settings: PATCH answers 501 as today and no GET settings route exists).
- RC: `createRecordingInventory(options): RecordingInventory` in
  `src/core/recordings/inventory.ts` with options `{ dsdFmeDirs: () => readonly { decoderId:
string; dir: string }[]; scannerRecordingsDir: () => string | null; discoveryCentreHz?:
(discoveryId: string) => number | null; now?: () => number; logger: Logger }` and methods
  `list(query: RecordingInventoryQuery): Promise<RecordingInventoryPage>` (throws
  `RecordingInventoryError` 400) and `resolve(id: string): Promise<string | null>` (an
  absolute path or null); `recordingRoutes` in `src/api/routes/recordings.ts` with options
  `{ inventory: RecordingInventory; authorize: (request) => DeniedAdmission | undefined;
access: Pick<FastifyAccessController, "leaseDownload"> }`.
- SB: `resolveSpectrumBinsCap(setting: SpectrumBinsCapSetting, options?: { measure?:
BinsCapMeasurer; now?: () => number }): SpectrumBinsCapResult` in
  `src/core/spectrum/bin-cap.ts` (synchronous, imports nothing but `@wavekit/api-types`), with
  `SpectrumBinsCapResult = SpectrumBinsCapView & { measurements: readonly BinsCostSample[];
wallMs: number }`; `SpectrumServiceDeps.binsCap?: () => SpectrumBinsCapView` (Main passes `resolveSpectrumBinsCap(ws.spectrumBinsCap ?? "auto")`; absent dep: floor
  2 048, today's behaviour).

Every DTO addition is optional or new; no WebSocket event type is added; no config default
changes; in legacy mode no route changes.

## Pipeline positions

```
PATCH /api/decoders/:id (protected) → authorizeSettings → probe 409 / unknown 404 → settings.update
  → ST patch policy (patchable by meaning, per-key schema, merged refinements) → store write (tmp+fsync+rename)
  → manager.stageDecoderOptions → result (view, revision, changed, pendingRestart)
decoder start (operator, automatic restart, boot) → DP: staged options? → registry.create(rebuilt config)
  → decoder:created(id) → listeners (provenance, ambient, coverage refresh, Main: digital voice, audio) → start
boot → ST service load (store) → Main: effectiveConfig(config) per decoder → digital voice prepare → createDecoder
GET /api/recordings (protected) → authorize → RC inventory.list → (cached scan ≤ 2 s old | scan: readdir, lstat,
  header read ≤ 4 KiB, cache by path+size+mtime) → filter, sort, page
GET /api/recordings/:id/file (protected) → lease → RECORDING_INVENTORY_ID → resolve (re-check) → createReadStream
startup → SB resolveSpectrumBinsCap (once, ≤ 200 ms) → log {setting, cap, source} → spectrum service binsCap
spectrum worker: pipeline summary (bins rounded to 0.5 dB) → SB int16 half-dB wire → pipeline-host decode → number[]
  → SpectrumService (profiles clamp to min(cap, summary budget)) → frames (u8 half-dB base64, unchanged)
```

## CPU and IO budgets

| Item           | Position                                                                              | Budget                                                                                                                            | How measured                                                                 |
| -------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ST store write | per PATCH (operator rate)                                                             | one file ≤ 256 KiB written and fsynced; validation O(keys)                                                                        | by construction + byte test at the bound                                     |
| ST load        | once at boot                                                                          | one read ≤ 256 KiB, one parse                                                                                                     | by construction                                                              |
| DP rebuild     | per start with staged options                                                         | one adapter construction (as at boot); no work on other starts                                                                    | by construction                                                              |
| RC scan        | per list request, at most once per 2 s (cached listing shared by concurrent requests) | ≤ 2 000 files, concurrency 8, ≤ 4 KiB read per uncached file, ≤ 500 ms on the Mac at the bound (cold), ≤ 50 ms warm               | benchmark over 2 000 synthetic files in a tmp dir, median of 3, load average |
| RC download    | per request                                                                           | one lstat + one stream (lease bounded)                                                                                            | by construction                                                              |
| SB wire        | every block summary in the worker (20/s per source at the default)                    | encode + decode O(bins), no per-summary allocation beyond the transfer buffer; ≤ 50 µs per 8 192-bin summary each side on the Mac | micro-benchmark over 10 000 summaries                                        |
| SB traffic     | worker → main                                                                         | ≤ 512 KiB/s per source at the cap (8 192 bins × 2 B × 20/s ≈ 320 KiB/s)                                                           | arithmetic + bench                                                           |
| SB bench       | once at startup                                                                       | ≤ 200 ms wall (`SPECTRUM_BINS_BUDGET.benchWallMs`), logged once                                                                   | the bench reports its own wall time                                          |
| SB clamp       | per subscribe                                                                         | constant                                                                                                                          | by construction                                                              |

Measured before WG8 (one Pi bench run, Pi 3B 1.2 GHz, live 2.048 Msps): `number[]` summaries cost
about 9 B per bin across the worker boundary, so 4 096 and 8 192 bins fail the 512 KiB/s budget
on both hosts; int16 half-dB brings 8 192 bins to about 263 KiB/s and a Pi clone to about 102 µs.
The per-profile work at 4 096 bins on the Pi 3 is about 6.9 ms/s, above the 5 ms/s budget, so
"auto" gives 2 048 there; the Mac reaches 8 192. Benchmarks are indicative under batch load;
Main re-measures a miss on a quiet box.

## Decoder settings (lane ST)

**Store** (`src/decoders/settings/store.ts`). Mirrors `src/core/station/store.ts`: the file
`DecoderSettingsFile` (`schemaVersion` 1, `revision`, `decoders` keyed by id); load with
quarantine (`decoder-settings.json.corrupt-<ms>`, one kept), seeded revision after a loss,
stale temporary file sweep (station bounds); writes serialised through one promise chain,
`tmp + fsync + rename`, the in-memory state replaced only after the rename. Zod at the
boundary: entries whose shape is wrong make the whole file corrupt (no partial trust). A file
over 256 KiB, more than 256 entries or more than 64 keys in an entry is corrupt. Option values
must be `DecoderSettingValue`s; the patch policy re-checks every stored key on load against the
current descriptors and drops (in memory, counted, logged as a count) a stored key that is no
longer patchable or no longer valid, so an older file can never apply a non-patchable value.

**Layers** (`layers.ts`). `effectiveDecoderConfig(config, override)` returns a new object:
`enabled` from the override when present, option keys from the override replacing the
configured ones; never mutates `config` or its `options`. The view builder takes the configured
entry, the override, the descriptors, the store revision and `pendingRestart` and produces
`DecoderSettingsView` (rules of requirement 2.7: `value` only for patchable non-secret keys;
`present` from the effective options; `source` override > config > default;
`undocumentedKeys` counts configured keys outside the descriptors).

**Patch policy** (`patch-policy.ts`). Shape: a plain object with only `enabled` and `options`;
`options` a plain object of at most 64 keys; anything else is `DECODER_OPTIONS_INVALID` (no
values echoed). Then, fail closed by meaning: a key is accepted only when the type has a schema,
the key has a descriptor with `patchable: true`, and the descriptor is consistent with
requirement 2.3 (checked again at runtime, not only by the contract test). Undocumented keys are
counted (`unknownKeys`), documented non-patchable keys are listed (`keys`), both in one
`DECODER_OPTION_NOT_PATCHABLE`. Values: each set key is parsed with its own entry of the type's
Zod object (`schema.shape[key]`, reaching through `ZodEffects` wrappers to the object), then the
merged effective options (configured options with the patch applied) are checked with the
type's object-level refinements only, filtering issues to the patched keys and to issues
without a path that the configured options alone do not raise; issues are reported as
`{ path: <documented key>, code: "invalid-value", message: <fixed text per rule> }`. Text values
in a patch are accepted only for `enum` and closed `string-list` keys and must be members.

**Allowlist by meaning** (`src/decoders/options/*.ts`). ST sets `patchable: true` per descriptor
and states each key's disposition with a one-line reason in its report. Starting table (ST
confirms each by reading the adapter): patchable candidates are receive tuning and decode
parameters whose value is a bounded number, boolean or closed set: `frequency`, `frequencies`,
`gain` (numeric only), `ppm`, `fmGain`, `verbosity`, `modes`, `protocols`, `analyze`,
`callStartDelayMs`, `callTimeoutMs`, `minCallDurationMs`, `emitDebugEvents` only if it writes
nothing to disk, and the LoRa `preset`, `region`, `bandwidth`, `spreadingFactor`, `codingRate`,
`frequency`. Never patchable (requirement 2.3): `extraArgs`, every `string` and `object` type
(`charset`, `filters`, `device*`, `*Host`, `callsign`, `channelKey`, dumpvdl2/readsb string
`gain`), every port, `output*`, `udp*`, `debugRecord*`, `enablePerCallRecording`,
`perCallRecording*`, `wavDir`, `lat`, `lon`, `enableMlat` (network output), `inputIqFormat`,
`voiceSlot` and any other key the digital-voice preparation rewrites (read
`src/core/digital-voice.ts` `prepareDecoderConfigs` and the helpers it calls), and the
rate-plan inputs `inputSampleRate`, `targetSampleRate`, `inputCenterFreq`, `followCenter`,
`sampleRate`, `channelHz`, `offsetHz` unless ST shows the rebuild re-derives everything they
feed (rate plan, channel, band assessment); when in doubt the answer is false.

**Service** (`service.ts`). `openDecoderSettingsService` loads the store, classifies entries as
applied, orphan or retyped against `options.configs` (counts logged once, no ids), keeps the
configured entries by id, and implements `DecoderSettingsService`. `update`: decoder unknown or
a probe (`port.getStatus(id)?.owner === "scanner"` or not configured) → the route has already
answered 404/409, the service throws `DECODER_SETTINGS_STORE_UNAVAILABLE` defensively; If-Match
check → policy → bounds (entries, keys, serialized size ≤ 256 KiB) → write → stage the
effective value of every key the patch touched (the override, else the configured value;
`null` only when neither sets it, so the key is removed) → result. A write failure throws 503 and leaves memory and staging
unchanged. `effectiveConfig` uses the loaded entry only when its type matches.

## Decoder PATCH and rebuild (lane DP)

**Manager** (`src/decoders/manager.ts`). `stageDecoderOptions(id, options)` records, per
decoder state, the staged option values (`null` = remove the key; the service always stages effective
values, so a revert stages the configured value); it returns whether the staged options differ
from the instance's current options. `isRestartPending(id)` is that comparison. In
`startDecoder` (which every operator start, restart, automatic restart and `startAll` reaches;
DP checks each path), when staged options differ, the manager builds the rebuilt configuration
as the instance's current configuration (the digital-voice prepared one) with only the staged
keys replaced, constructs a new instance with `registry.create`, moves the decoder state onto
it (event handlers, stats reset as on a fresh create, health, band and rate plan re-derived
with `refreshRatePlan`/`reevaluateBand`, channel and fanout re-wired as at create), disposes
the old instance (it is stopped), emits `decoder:created` for the same id, then starts. A
throwing constructor keeps the old instance and configuration, records `lastError` with the
error class only (`safeErrorFields`), leaves the decoder stopped and the options staged. A
staged option set equal to the current options clears the staging without a rebuild.

**Listeners.** DP lists every `decoder:created` listener in the repository (provenance
bindings, ambient evidence, the coverage refresh in the scanner service, any WebSocket or
activity listener) and shows with a test that each treats a known id as a replacement
(idempotent rebinding, no duplicate subscription, no leak). A listener that is not idempotent
and lives outside DP's files is reported as an exact Main diff. Main adds the index.ts listener
that re-attaches digital voice (`digitalVoice.attachDecoder` detaches the previous source) and
re-wires the combined audio (`pipedDecoders` holds the old instance).

**Routes** (`src/api/routes/decoders.ts`). `DecoderRoutesOptions.settings` and
`authorizeSettings` (both from Main in protected mode only). Without `settings`: PATCH exactly as
today (501). With it: `GET /api/decoders/:id/settings` (404 unknown, 409 probe, 200 view,
`Cache-Control: no-store`), and PATCH with `bodyLimit` 16 KiB (413 `DECODER_SETTINGS_LIMIT` in
the settings error shape), `authorizeSettings` before any lookup, 404 / 409 as today, then
`settings.update` with the parsed `If-Match` (station rules: `W/"n"`, `"n"` or `n`, safe
integer, else 400 `DECODER_OPTIONS_INVALID`), mapping `DecoderSettingsError` to its status and
body; any other throw is a 500 with a fixed message and a log line with `safeErrorFields` only.
The route JSON body schema for the protected PATCH accepts `enabled: boolean | null` and
`options: object` (values checked by the service). `GET /api/decoders/types` descriptor schema
gains optional `patchable`. `src/api/routes/decoder-status-schemas.ts` and
`src/api/serializers/decoder-status.ts` change only if a status field is added (none is frozen;
`pendingRestart` lives in the settings view).

## Recordings inventory (lane RC)

**Sources.** `dsdFmeDirs()` (Main builds it from `decoderManager.getConfiguredDecoderConfigs()`
and `dsdFmeRecordingDir`, sorted by decoder id; probes excluded) gives `{ decoderId, dir }`; the
index n of `dsd:<n>` is the position in that list after dropping directories whose real path
repeats an earlier one (the first decoder owns a shared directory). `scannerRecordingsDir()`
gives `<scanner storage>/recordings` or null; RC reads `dv/` and `analog/` below it, one level
of `d_<id>` folders (the scanner's `DISCOVERY_ID`), never `probe-*`, and names matching the
scanner's `RECORDING_ID` file part. Reuse the existing patterns (`DSD_FME_CALL_WAV`,
`DSD_FME_TEMP_WAV`, `RECORDING_ID`, `DISCOVERY_ID`); if importing the evidence store would pull
runtime modules into the startup bundle (see the protected-runtime-process test), keep a local
copy and pin it equal with a test.

**Scan.** `readdir` per directory, `lstat` per candidate (regular file, not a symbolic link, mtime
at least 10 s old), header read with `open` + one `read` of ≤ 4 KiB (`O_NOFOLLOW` where
available) parsing RIFF/WAVE `fmt ` (PCM format 1, channels, rate, bits, byte rate consistent)
and `data`: `durationMs = round(min(dataSize, fileSize − dataOffset) / byteRate × 1000)`, null on
anything else. ENOENT and ELOOP skip the file; other errors skip the directory and count it
(logged as a count with `safeErrorFields`). At most 2 000 files examined in total, at most 8
operations in flight; the listing is cached for 2 s and shared by concurrent requests; header
results are cached by path, size and mtime (bounded to 4 096 entries, oldest dropped).

**Items.** dsd-fme names give `startedAtLocal` (validated date and time), `callType` from
`GROUP`/`PRIVATE`/`UNIT`, `talkgroup`/`source` when all digits (≤ 10), `frequencyHz` null;
scanner items give `discoveryId`, `kind` from the folder (`dv` → `scanner-dv`, `analog` →
`scanner-analog`), `frequencyHz` from `discoveryCentreHz` when it returns a finite positive
number, else null.

**Paging.** Sort by `modifiedAt` descending then id ascending. Cursor: base64url of a JSON
`{ m: mtimeMs, i: id }` validated by Zod and the id pattern; the next page starts strictly after
it. `limit` integer 1–200. Filters are exact matches. Query problems → 400
`RECORDINGS_QUERY_INVALID` with fixed text.

**Routes** (`src/api/routes/recordings.ts`). List: `authorize(request)` first (deny → its
status and code, as the config export route), then `inventory.list`, `Cache-Control:
no-store`. File: lease first exactly as the scanner download (`leaseDownload`, 429/401/503
mapping, release on stream error, inactive lease → no body), then id check, `resolve` (lstat
again, same eligibility), `audio/wav`, `Content-Disposition: attachment;
filename="<basename>"`, `Accept-Ranges: none`; a request with a `Range` header gets the whole
file (200). Not found → 404 `RECORDING_NOT_FOUND`. Logs: fixed messages, `safeErrorFields`
only, no path, name or decoder option.

## Spectrum bins above 2 048 (lane SB)

**Wire.** In the worker (`spectrum-worker.ts`, `pipeline.ts` summary emission and
`worker-protocol.ts`), a summary's bins travel as an `Int16Array` of `bins × 2` (half-dB
integers) in the transfer list, flagged in the message; the host (`pipeline-host.ts`) decodes
to the same `number[]` (`v / 2`). Any value that is not finite or whose doubled value is not an
integer in −32 768..32 767 sends that summary as today's `number[]`. The inline host mode keeps
`number[]`. `worker-protocol.ts` raises `spectrumBins` to `SPECTRUM_SUMMARY_BINS_MAX`.

**Cap** (`bin-cap.ts`). `resolveSpectrumBinsCap(setting)`: a number → `{ cap: setting, source:
"config" }`. `"auto"` → for 8 192 then 4 096 (descending, stop at the first pass), the measurer
returns `{ bins, summaryBytesPerSecond, cloneMsPerSecond, profileMsPerSecond }` at the default
summary rate (20/s); the cap passes when each value × 1.5 is within `SPECTRUM_BINS_BUDGET`; none
passes → 2 048 `measured`; the measurer throws, returns a non-finite value or the bench passes
200 ms wall → 2 048 `fallback`. The default measurer times, over a fixed number of synthetic
summaries, the int16 encode, a `structuredClone` of the transfer buffer and the per-profile
service work (`reduceMaxHold` + `encodeBins` at the summary size), with the injected clock;
it allocates its buffers once. Index.ts calls it once and logs `{ setting, cap, source, wallMs }`.

**Service and engine.** `SpectrumServiceDeps.binsCap?` (absent → floor). The engine's summary
budget is `min(ws.spectrumSummaryBins, cap)` (`spectrum-engine.ts` `buildPipelineConfig`); the
client clamp (`spectrum-averaging.ts` `normaliseProfile`) and `limits.bins.max` use
`min(cap, ws.spectrumSummaryBins)`, never above `PROFILE_BINS_CEILING`; `limits.binsCap` reports
the view. With the default summary budget (2 048) the clamp bound stays 2 048, so every profile,
`adjusted` list, frame and limit except the new optional `binsCap` equals today's. The backfill
byte bound (`BACKFILL_LIMITS.maxBytes`) still holds for larger frames (fewer frames fit; SB
proves the bound, not the count).

**Other readers.** `scanner/identify.ts` (peak over a window) and the scanner service PSD
evidence slice (`scanner-service.ts`, Main) are window-bounded; SB shows both stay correct with
8 192-bin summaries (tests on identify; for the scanner service a proposed Main diff only if
needed). The default profile keeps 128–2 048 (CLI frame guard `binCount ≤ 2048`).

## Main wiring

- ST: `src/index.ts` opens the settings service before Step 7 (decoder creation) with
  `config.decoders` and `config.stateDir`; `decoderConfigs = config.decoders.map(c =>
settings.effectiveConfig(c))` before `digitalVoice.prepareDecoderConfigs`; the manager port
  set once the manager exists; closed in shutdown. The storage report's `decoder-overrides`
  area lists `DECODER_SETTINGS_FILE_NAME` too. `getConfig` (export) stays `config`.
- DP: `src/api/server.ts` passes `settings` and `authorizeSettings` (the access controller's
  `authorizeMetadataMutation`) to `decoderRoutes` only with the access controller while
  `DECODER_SETTINGS_REQUIRES_ACCESS`; `src/index.ts` adds the `decoder:created` listener that
  re-attaches digital voice and re-wires combined audio for a replaced instance; any non
  idempotent listener DP reports.
- RC: `src/index.ts` builds the inventory (dsd-fme dirs from the manager's configured decoders,
  the scanner storage `recordings` directory, the discovery centre lookup through the scanner
  service); `src/api/server.ts` registers `recordingRoutes` only with the access controller
  while `RECORDINGS_REQUIRES_ACCESS`.
- SB: `src/index.ts` resolves the cap once and passes it through a new `ScannerService` dep to
  `new SpectrumService({ binsCap })` in `scanner-service.ts`; `src/config.ts`
  `spectrumSummaryBins` max → `SPECTRUM_SUMMARY_BINS_MAX`; `scanner/types.ts` comment;
  `docs/SCANNER.md` bins and summary budget lines.
- Docs, coordination note, CLI grep, contract test updates after merges.

## Correctness properties

1. **Override layering.** For random configured entries and overrides, the effective config
   has the override's value for each override key, the configured value otherwise, `enabled`
   likewise; the input objects are deep-equal before and after. _Validates 1.1, 1.5._
2. **Store round trip and fail closed.** For random valid files, load(write(x)) deep-equals x;
   for random corruptions (truncation, wrong types, over-bound sizes, extra keys) the store loads
   empty with a revision greater than any earlier one and quarantines the file. _Validates
   1.2, 1.3._
3. **Patchable by meaning.** For random patch bodies over every type's keys plus random
   unknown keys, the policy accepts a body only when every key is a descriptor with
   `patchable: true` and every value passes its schema; refused bodies change nothing, and no
   error body contains a submitted value. _Validates 2.3, 2.4._
4. **Unrelated issues never fail a patch.** For random configured options with invalid
   untouched keys, a valid patch of other patchable keys is accepted. _Validates 2.4._
5. **View hides non-patchable values.** For random configs and overrides, no view entry that is
   secret or non-patchable carries `value`, and undocumented keys are never named. _Validates
   2.7._
6. **Rebuild equals fresh create.** For random staged option sets on random decoders, after the
   next start the status, caps, band and rate assessment equal those of a manager created with
   the effective config; with nothing staged no instance is constructed. _Validates 3.1, 3.2,
   3.4._
7. **Legacy unchanged.** For random PATCH bodies without the settings option, the response
   equals today's 501 (or 404/400 as today). _Validates 2.1._
8. **Inventory eligibility.** For random directory trees (names, symbolic links, TEMP files,
   fresh mtimes, probe folders, removals during the scan), listed items are exactly the
   eligible files, each id matches `RECORDING_INVENTORY_ID` and resolves to its file, and no
   file is modified. _Validates 4.2, 4.3, 4.5._
9. **Paging is a partition.** For random inventories and limits, following `nextCursor` from
   the first page yields every item exactly once in order. _Validates 4.4._
10. **RIFF duration.** For random headers (valid, truncated, non-PCM, inconsistent byte rate,
    oversized data size), `durationMs` is the stated formula for plain PCM and null otherwise;
    no read exceeds 4 KiB. _Validates 4.3, 4.6._
11. **Lossless wire.** For random summaries (values on the 0.5 dB grid, plus non-finite and
    out-of-range values), the host's bins deep-equal the worker's. _Validates 5.1._
12. **Cap choice.** For random measurer outputs, the cap is the largest choice within budget ×
    1.5, 2 048 when none passes, and 2 048 `fallback` on throw, non-finite or overtime.
    _Validates 5.2._
13. **Default profile unchanged.** For random subscribe options with the default summary budget,
    the profile, `adjusted` list and frames equal the WG8 base for any cap. _Validates 5.4, 5.5._
