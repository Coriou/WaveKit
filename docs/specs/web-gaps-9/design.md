# Web gaps 9 design (WG9)

Status: frozen for implementation. Requirements in [requirements](requirements.md), tasks in
[tasks](tasks.md). Background: the core access policy (protected mode, admission, pairing,
sessions, download leases), web-gaps-2 device labels, the WG5 strict tuning trust, the WG8
recordings inventory and settings store pattern, the activity-recording-catalog deletion owner
audit, the viewed-slice-spectrum budgets and the WG8 bins cap measurer.

## Contract (frozen)

| File                                             | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/access-pairing.ts` (new) | `ACCESS_PAIR_ROUTE`, `ACCESS_SESSION_ROUTE`, `ACCESS_SESSION_REFRESH_ROUTE`, `ACCESS_SESSION_LOGOUT_ROUTE`, `ACCESS_PAIRING_CODES_ROUTE`, `ACCESS_SESSION_COOKIE_NAME`, `ACCESS_CSRF_HEADER`, `ACCESS_PREFLIGHT_MAX_AGE_SECONDS` (600), `ACCESS_PAIRING_CODE`, `accessPairRequestSchema` / `AccessPairRequest` (optional `name`, `kind`), `accessSessionDtoSchema` / `AccessSessionDto`, `AccessLogoutResponse`, `AccessPairingCodeResponse`, `AccessErrorCode`, `AccessErrorBody` |
| `packages/api-types/src/recordings.ts`           | optional `RecordingInventoryItem.kept`; `RECORDING_KEEPS_REQUIRES_ACCESS`, `RECORDING_KEEP_ROUTE`, `RECORDING_DELETE_ROUTE`, `RECORDING_KEEPS_FILE_NAME`, `RECORDING_KEEPS_MAX_ENTRIES` (2 000), `RECORDING_KEEPS_FILE_MAX_BYTES` (1 MiB), `RECORDING_KEEPS_MAX_BYTES` (512 MiB), `RecordingKeepResult`, `RecordingDeleteResult`, `RecordingKeepErrorCode`, `RECORDING_ERROR_STATUS`, `RecordingKeepErrorBody`, `SCANNER_DISCOVERY_HOLDS_KEPT_CODE`                                |
| `packages/api-types/src/scanner.ts`              | identify trial `reason` gains `"decoder-unavailable"` (no outcome added)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/api-types/src/index.ts`                | barrel export of `access-pairing.js`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/core/recordings/contract.ts` (new)          | `RECORDING_KEEPS_SCHEMA_VERSION`, `RECORDING_KEEP_KEY`, `RecordingKeepKey`, `recordingKeepKeyOf`, `dsdFmeKeepKey`, `scannerKeepKey`, `RecordingKeepEntry`, `RecordingKeepsFile`, `RecordingProtection` (the deletion decision port), `RecordingKeepService`, `RecordingKeepError`                                                                                                                                                                                                  |

`tests/unit/core/wg9-contract.test.ts` pins the routes, cookie name, CSRF header, preflight
cache bound, the pair request rules (accepted and refused bodies), the session body, the access
code union against the core denial codes, the Keep bounds with their arithmetic, the error
statuses, the keep keys (accepted and refused, traversal included, the index not part of the key),
the protection port shape, the optional `kept`, the identify reason union with the outcome list
unchanged, and the trust vocabulary unchanged.

Names a lane creates and Main consumes at merge (frozen here by name):

- PA: none beyond its own files (`src/access/**`); the preflight header and pair fields are
  internal to the access routes Main already mounts.
- RK: `openRecordingKeepService(options: { stateDir: string; inventory: RecordingInventory;
logger: Logger; now?: () => number }): Promise<RecordingKeepService>` in
  `src/core/recordings/keep-service.ts` (resolves after the load, in state `ready` or `failed`;
  never rejects; Main awaits it before decoder creation, so no pruner runs while `loading`); `createRecordingInventory` options gain
  `protection?: RecordingProtection` (absent: no `kept` field, today's items) and the inventory
  gains `invalidate(): void`; `recordingRoutes` options gain `keeps?: RecordingKeepService` and
  `authorizeMutation?: (request) => DeniedAdmission | undefined` (absent: no Keep or delete
  routes, today's behaviour); `setCallRecordingProtection(protection: RecordingProtection |
null): void` in `src/decoders/builtin/call-recordings.ts` (null, the default, is today's
  pruner).
- TT: `tuningTrustOf(state: TunerState | null | undefined): TuningTrust` in
  `src/core/tuning-trust.ts` (imports types only); `OPERATOR_RETUNE_SETTLE_MS` exported from
  `src/core/spectrum/retune-settle.ts`.
- ZM: `scripts/bench/zoom-workload.ts`, `scripts/bench/build-zoom-workload.mjs` (bundle to
  `output/bench/zoom-workload.mjs`).
- MN: the route option `legacyAudioHost?: boolean` on the live-audio and digital-voice route
  options (absent: today's `httpUrl`).

Every DTO addition is optional or new; no WebSocket event type is added; no config key or
default changes; in legacy mode no route changes except 5.5 once Main sets the route option.

## Pipeline positions

```
browser (web origin :W) → preflight OPTIONS → access policy (allowed origin) → 204 + Max-Age 600
browser → POST /api/access/pair {code, name?, kind?} → validate body → reserve code → session create
  (name, kind committed with the session) → 201 AccessSessionDto + Set-Cookie
PUT/DELETE /api/recordings/:id/keep (protected) → authorizeMutation → id check → keep service
  (mutex per key) → inventory.open (Keep) → store write (tmp+fsync+rename) → memory → invalidate
DELETE /api/recordings/:id (protected) → authorizeMutation → id check → dsd only → mutex → kept? 409
  → inventory.open (verified) → lstat dev/ino equal → unlink → invalidate
dsd-fme pruner (timer, 2 s after a call) → per file: protection.isDsdFmeFileProtected(name) → unlink
scanner maintenance tick → evidence retention / analog retention / inactive prune → protection → rm
POST /api/tuner/:id/frequency → tuner-controller.setFrequency → sendCommand → command-sent(origin)
  → spectrum engine epoch (centre = command value, settle by origin) → worker pipeline settle gate
  → first summary → spectrum service frame (label by tuningTrustOf + settle window)
```

## CPU and IO budgets

| Item               | Position                                      | Budget                                                                                      | How measured                                           |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| PA preflight       | per preflight (browser cached 600 s)          | constant (one more header)                                                                  | by construction                                        |
| RK keep write      | per Keep or unkeep (operator rate)            | one file ≤ 1 MiB written and fsynced                                                        | byte test at the bound                                 |
| RK decision        | per file a deleter considers                  | O(1) set lookup, synchronous, no IO                                                         | by construction; counted lookups in tests              |
| RK pruner overhead | dsd-fme prune (≤ once per 2 s)                | + one lookup per candidate file                                                             | by construction                                        |
| TT trust           | per epoch and per transmission                | constant                                                                                    | by construction                                        |
| TT retune          | per operator retune                           | p90 command → first new-centre frame ≤ 300 ms (no injected delay), ≤ delay + 300 ms with it | offline harness, 50 retunes, p50/p90/max, load average |
| ZM bench           | offline only                                  | none on the product; bench ≥ 60 s per cell                                                  | the bench itself                                       |
| MN host derivation | per status response (legacy, no publicOrigin) | one header parse ≤ 255 characters                                                           | by construction                                        |
| MN squelch re-seed | once per retune                               | constant                                                                                    | by construction                                        |

## Browser pairing (lane PA)

**What exists** (verified at the base): protected mode does its own CORS (exact allowed Origin
echoed with `Access-Control-Allow-Credentials: true`; `Origin: null` and foreign origins 403
`ORIGIN_FORBIDDEN`); preflights are handled before authentication with the allowed methods and
headers (including `X-WaveKit-CSRF`); unsafe cookie requests need an allowed Origin and the
session's CSRF token; safe GETs without Origin need `Sec-Fetch-Site` `same-origin` or `none`;
WebSocket upgrades need the cookie and an allowed Origin; the cookie is host-only `HttpOnly;
SameSite=Strict; Path=/` with `Secure` from `listenerScheme`; device names and kinds exist
(`POST /api/access/devices/label`, web-gaps-2). Every allowed origin must share the API scheme
and hostname; a web app on another port of that hostname is same site, so the Strict cookie is
sent and nothing in the policy blocks it.

**Gaps closed here.** (1) `Access-Control-Max-Age: 600` on successful preflights only
(`src/access/policy.ts`; denied preflights unchanged). (2) Pair with optional `name`/`kind`
(`src/access/pairing.ts` parses with `accessPairRequestSchema` before reserving the code; the
session store's create takes the label so one commit writes both; check `sessions.ts` create and
the snapshot v2 fields). (3) The acceptance test of requirement 1.3 against an actual protected
server with two origins (reuse `tests/helpers/access-browser/{cookie-jar,browser-client}.ts`,
extended with a `documentOrigin` different from the API origin; new helpers in new files). The
`https` form runs the TLS exposure mode with the listener scheme `https` behind a local
terminator stand-in or asserts the cookie and CORS headers on the `https` configuration without
TLS on the wire; say which. (4) Caddy profile example. (5) The contract draft for Main.

**Fail closed by meaning.** The Max-Age header is added only on the 204 path after the origin
and method checks pass. The pair body is validated strictly before any state change; a name that
fails the label rules never reaches the store or a log. Nothing derived from the request (Origin,
Host, name) is logged. `Sec-Fetch-Site` rules, Host checks and the allowlist are unchanged.

## Recording Keep and deletion (lane RK)

**Deletion owners** (all in the main process; every one consults `RecordingProtection`):

| Owner                                                        | Hook                                                                           | File owner          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------- |
| dsd-fme call pruner `pruneCallRecordings` (age then size)    | skip a file when `isDsdFmeFileProtected(name)`; count skipped                  | RK                  |
| scanner evidence retention (`evidence-store.ts` `retention`) | skip a recording file when `isScannerFileProtected(discovery, name)`           | Main (diff from RK) |
| `removeDiscovery` and explicit `deleteDiscovery`             | refuse 409 `SCANNER_DISCOVERY_HOLDS_KEPT_RECORDINGS` when `discoveryHoldsKept` | Main (diff from RK) |
| inactive prune and capacity eviction (`discovery-store.ts`)  | skip a discovery when `discoveryHoldsKept`                                     | Main (diff from RK) |
| analog retention (`analog-operations.ts` `retained`)         | skip an artifact when its scanner key is protected                             | Main (diff from RK) |
| probe cleanup, orphan probe dirs, capture store, journal     | not listed recordings; unchanged                                               | none                |

The scanner-side hooks are optional parameters with today's behaviour when absent (so the
default is byte-identical); Main applies them in `src/core/scanner/store/**` and
`src/core/scanner/scanner-service.ts` from RK's exact diffs, with RK's tests.

**Store** (`src/core/recordings/keep-store.ts`). `RecordingKeepsFile` (`schemaVersion` 1,
`revision`, `keeps`); Zod strict, every key matching `RECORDING_KEEP_KEY`, no duplicate keys,
`bytes` a non-negative safe integer, the three bounds; the file checked by byte length before
parse. Missing → empty, revision 0. Anything else wrong → state `failed` (requirement 2.4: left
in place, not quarantined; a quarantine would load empty and unprotect every kept file).
Writes serialised on one promise chain (a failed write does not poison it), `tmp + fsync +
rename` (+ directory fsync as the station store), memory replaced only after the rename; stale
temporary files swept with the station bounds.

**Coordinator** (`keep-service.ts`). In-memory set of keys plus a set of keys with a delete in
progress; one async mutex per key (bounded map, entries removed when idle). `isProtected(key)`:
`state !== "ready" || kept.has(key) || deleting.has(key)`. The pruner form returns false for a
non-call name only when ready (TEMP files are not keepable). Keep: mutex; `deleting` → 409
`RECORDING_BUSY`; `inventory.open(id)` (verified, eligible) else 404; bounds (entries, bytes with
the opened size) else 409 `RECORDING_KEEP_LIMIT`; add to memory as protecting before the write
(a deleter sees it protected at once), write; a failed write removes it again and answers 503.
Unkeep: mutex; write first, then drop from memory (a failed write keeps it protected). Remove:
`dsd:` only; mutex; kept → 409 `RECORDING_KEPT`; mark deleting; `inventory.open(id)` (verified)
else 404; `lstat` the resolved path and compare device and inode with the handle; unlink;
close the handle in `finally`; clear deleting; `inventory.invalidate()`. ENOENT at unlink → 404.

**Routes** (`src/api/routes/recordings.ts`). With `keeps` and `authorizeMutation` only:
`authorizeMutation` first (deny → its status and `{ code }`), id check (404 without fs call),
then the service; `RecordingKeepError` → its status and `RecordingKeepErrorBody`; anything else
500 with a fixed message and `safeErrorFields`. Bodies are ignored (no body is read); a request
body over 1 KiB is 413 by Fastify's limit on these routes.

**Dsd-fme wiring.** `setCallRecordingProtection(p)` stores a module-level port read by
`pruneCallRecordings` (default null = today's behaviour). `pruneCallRecordings` consults it per
file at the unlink point (after its own age and size decision), counts protected skips, and keeps
its size accounting (kept files still count toward the total). `dsd-fme.ts` reads nothing new
(the pruner reads the port), so the adapter options and argv are unchanged.

## Tuning trust and retune latency (lane TT)

**Cause** (verified at the base). The spectrum engine's `initialTrust()` labels the first stream
`commanded` whenever the frequency is not in `unknownFields`, without checking
`declaredOnlyFields` or a command on this connection; `externalTrust()` returns `commanded` for
any internal-mode state and is reached from the caps-change path, including the caps reset that
reconnect reconciliation emits; the analog transmission `tunerFrequencyAt` repeats the first
flaw. The sdr-host poller and the rtl_tcp header carry no trust. `hostCentre` (which can only
demote to `unverified`) is not wired.

**Fix.** `tuningTrustOf(state)` (new `src/core/tuning-trust.ts`) implements requirement 3.1;
`initialTrust`, `externalTrust` and `tunerFrequencyAt` call it; the caps-change path labels a
reconciliation-driven caps change `unverified` unless a command of this core succeeded on the
current connection epoch (tuner-controller exposes that fact; read `reconcileCaps`,
`synchronizeOnConnect`, the replay path). The epoch centre comes from the command value at
`command-sent` (no transient epoch with the old centre). Check every consumer of the label
(`scanner/job-runner.ts` epoch ownership, scanner-service tracks, activity provenance) keeps its
meaning: the scanner's own commands stay `commanded`.

**Latency.** The base cost is the settle gate: a REST retune uses
`scanner.sweep.settleMs.network` (1 000 ms) as its settle, then up to 1 000 ms of stale-content
discard. The script that measured it registers its waiter before the request and stamps frames
on receipt, so the 1.1 s is real. The fix gives non-scanner retunes their own settle
(requirement 3.4): marker settle where the source supports retune markers (as the scanner
arbiter does), else `OPERATOR_RETUNE_SETTLE_MS`, measured with the fake rtl_tcp server
(`tests/mocks/scanner/fake-rtl-tcp.ts` gains an injectable send delay) at injected delays 0,
100, 250 and 500 ms; the stale discard for such a retune is capped at the same value. Frames in
the window between that settle and the configured network settle carry `unverified`. The scanner
path (origin scanner) is unchanged. Report the before and after p50/p90/max and the fraction of
frames in the harness whose content still matches the old centre.

## Zoom workload benchmark (lane ZM)

The benchmark reuses `Fft`, `hannWindow`, `accumulateShiftedPower`, `powerToDb`
(`src/core/spectrum/fft.ts`), optionally `FrameSource` and the scanner decimator
(`src/core/scanner/evidence/iq-decimate.ts`) for the shift and decimate variant, and copies the
small service helpers it needs (`reduceMaxHold`, `encodeBins`) instead of importing the service.
Input: seeded CU8 (noise plus two tones 250 Hz apart) fed in real-time 50 ms chunks; a detector
proxy (2 048-point FFT per frame, as the live engine) runs underneath so the zoom cost is
incremental. Each cell: `process.cpuUsage` over wall, per-transform `performance.now`
percentiles, `monitorEventLoopDelay`, `rss`/`heapUsed` high-water, missed 250 ms deadlines. CLI
flags select the sweep and a `--smoke` mode (≤ 5 s per cell) used by its unit test. Output JSON
lines and a summary under `--out` (default `output/bench/zoom-<timestamp>/`, git-ignored). The
build script bundles everything (no external packages) so the single file runs with `node` in
the sdr-host container on the Pi.

## Minor defects (lane MN)

- 5.1 `audio-output.ts` and `tuner-relay.ts`: before listening, a server error logs and rejects
  only (no `emit("error")` without listeners); after listening, `error` is emitted only when a
  listener exists, else logged. Startup then fails through `main()`'s catch (stderr line, exit 1).
  Process test: a legacy start with the audio port held (extend the protected-runtime process
  harness in a new test file; do not edit the existing one).
- 5.2 `sanitizeStoredOptions` gets the configured `frequencies` and drops shadowed keys
  (`frequencies` checked before `frequency`), counted in the existing `dropped` count.
- 5.3 `routes/live-audio.ts` manual 400 branch: `VALIDATION_ERROR` for a ZodError, the
  WaveKitError's own code otherwise; message redacted as the global handler when access is set.
- 5.4 `probe-pool.ts` notices the probe decoder's exit (or faulted status) before any output and
  reports it; `identify.ts` maps it to `unsupported` / `decoder-unavailable`. A shell exit 126 or
  127, a spawn ENOENT or EACCES qualify; any other early exit stays as today.
- 5.5 `routes/live-audio.ts` and `routes/digital-voice.ts`: with `legacyAudioHost: true` (Main
  sets it in legacy mode only) and a status `httpUrl` that is exactly the localhost fallback, the
  response's URL host becomes the request `Host` when it parses as a DNS name (RFC 1123 labels),
  an IPv4 address or a bracketed IPv6 address, with an optional port that is ignored (the audio
  port replaces it); anything else keeps `localhost`. Never `X-Forwarded-*`. `Cache-Control:
no-store` on such responses.
- 5.6 `live-demodulator.ts`: keep the reset; remember the pre-retune floor and seed the new one
  from `min(previous floor, first block power)`; with no previous floor (cold start) unchanged.
- 5.7 dropped (not a bug).

## Main wiring

- RK: `src/index.ts` awaits `openRecordingKeepService({ stateDir, inventory, logger })` in both
  modes (before decoder creation), passes `protection` to the inventory,
  `setCallRecordingProtection(keeps)` before decoders start, and the scanner-side hooks (RK's
  diffs to `evidence-store.ts`, `discovery-store.ts`, `analog-operations.ts`,
  `scanner-service.ts`, with RK's tests); `src/api/server.ts` passes `keeps` and
  `authorizeMutation` (`authorizeMetadataMutation`) to `recordingRoutes` only with the access
  controller while `RECORDING_KEEPS_REQUIRES_ACCESS`; shutdown closes the service; the storage
  report's area for recordings lists the keep file under its state area.
- MN: `src/api/server.ts` passes `legacyAudioHost: true` to the live-audio and digital-voice
  routes in legacy mode only.
- TT: optional `hostCentre` from the sdr-host poller in `src/index.ts` (it can only demote).
- Docs, coordination note, CLI grep, contract test updates after merges, the Pi benchmark run.

## Correctness properties

1. **Preflight cache only on success.** For random preflight requests (origin allowed or not,
   null, method present or not, header sets), `Access-Control-Max-Age: 600` is present exactly
   when the response is the 204 success, and every other header equals the base. _Validates 1.2,
   1.9._
2. **Pair body fails closed.** For random pair bodies (valid codes, random names and kinds,
   unknown keys, wrong types), a body is accepted only when `accessPairRequestSchema` accepts it;
   a refused body leaves the code usable and writes nothing. _Validates 1.5._
3. **Keep store round trip and fail closed.** For random valid files, load(write(x)) equals x; for
   random corruptions and over-bound files the state is `failed`, the file is unchanged on disk
   and `isProtected` is true for every key. _Validates 2.3, 2.4._
4. **No owner deletes a kept file.** For random sets of recordings, keeps and interleavings of
   Keep, unkeep, delete and pruner runs (fake fs, injected scheduler), no kept key's file is ever
   unlinked, a delete of a kept key is refused, and every unlink targets the verified file.
   _Validates 2.5, 2.7, 2.8._
5. **Keys are never paths.** For random strings, `recordingKeepKeyOf`, `dsdFmeKeepKey` and
   `scannerKeepKey` return null or a key without `/`, `\` or `..` segments, and the inventory id
   to key mapping ignores the directory index. _Validates 2.2, 2.9._
6. **Strict trust.** For random tuner states (control mode, unknown and declared-only field
   sets, command counts, connection epochs), the label is `unverified` whenever frequency or
   sample rate is unknown or declared only, and otherwise `relay`/`commanded` by control mode, at
   every call site. _Validates 3.1, 3.2._
7. **One epoch per retune.** For random retune sequences against the engine with a fake
   controller, each command posts exactly one epoch, centred on the command value. _Validates
   3.3._
8. **No early `commanded` frame.** For random injected delays and retune sequences in the
   harness, no frame labelled `commanded` or `relay` before the configured network settle carries
   pre-retune samples. _Validates 3.4, 3.5._
9. **Host derivation is inert.** For random `Host` headers, the derived `httpUrl` is either the
   base value or `http://<valid host>:<audio port>/…`, never contains characters outside the
   host grammar, and nothing else in the response or any log changes. _Validates 5.5._
10. **Shadowed keys dropped.** For random stored overrides and configs, a key the configuration
    shadows never survives load, and unshadowed keys are kept as before. _Validates 5.2._
