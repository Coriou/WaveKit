# Web gaps 6 design (WG6)

Status: frozen for lanes K, DO, DCS, U and CE. Requirements in [requirements](requirements.md),
tasks in [tasks](tasks.md). Background: the scanner ([SCANNER.md](../../SCANNER.md) plan
preview, WG2 [lockouts](../web-gaps-2/design.md)), WG2 CTCSS/DTMF (the tone path), band
plans ([band-plans](../band-plans/requirements.md), WG5 [import formats](../web-gaps-5/design.md)),
[receiver capabilities](../receiver-capabilities/requirements.md), the access spec (protected
mode).

## Contract (frozen)

| File                                                                          | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/scanner.ts`                                           | `DecodedElsewhereRange`; `DECODED_ELSEWHERE_TARGET_HALF_WIDTH_HZ` (6 250), `DECODED_ELSEWHERE_MAX_DECODERS` (64), `DECODED_ELSEWHERE_MAX_TARGETS` (32), `DECODED_ELSEWHERE_MAX_RANGES` (256); optional `ScanJobSpec.skipDecodedElsewhere`, `NormalisedJobSpec.skipDecodedElsewhere`, `PlanPreview.decodedElsewhere`, `ScanJob.decodedElsewhere`, `ScanJobHit.lastDurationMs`; `PlanIssueCode` gains `decoded-elsewhere-truncated`, `decoded-elsewhere-not-applied`                                                                                                                                  |
| `src/core/scanner/types.ts`                                                   | identical copies of the scanner additions; `DecoderCoverageView` (the plan's input)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/core/scanner/plan/plan-preview.ts`                                       | optional `PreviewContext.decoderCoverage?: () => readonly DecoderCoverageView[]` (unused until K)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/core/scanner/store/persistence.ts`                                       | `NormalisedJobSpecSchema.skipDecodedElsewhere` optional (old jobs load)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/api-types/src/decoders.ts`                                          | `DECODER_OPTIONS_ENFORCE` (false), `DECODER_OPTION_ISSUES_MAX` (32), `DECODER_OPTION_ISSUE_TEXT_MAX` (256); `DecoderOptionIssue`, `DecoderOptionType`, `DecoderOptionDescriptor`, `DecoderTypeInfo`; optional `DecoderStatus.optionIssues`                                                                                                                                                                                                                                                                                                                                                          |
| `src/decoders/types.ts`                                                       | optional `DecoderStatus.optionIssues`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/api-types/src/live-audio.ts`                                        | `AnalogTransmissionDcs`; optional `AnalogTransmissionTone.dcs`; `DCS_BIT_RATE_BPS` (134.4), `DCS_MIN_WORDS` (3), `DCS_MIN_AUDIO_SECONDS` (0.75), `DCS_CODE_SET` ("standard"), `DCS_STANDARD_CODES` (104, cited)                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/api-types/src/activity.ts`, `src/core/activity/storage/contract.ts` | identical optional `tone.dcs` on the analog transmission payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/api-types/src/bandplans.ts`                                         | `BANDPLAN_URL_IMPORT_HOSTS` (`["raw.githubusercontent.com"]`), `BANDPLANS_URL_LIMITS` (2 048 chars, 1 MiB, 10 000 ms, 1 in flight), `BANDPLAN_URL_CONTENT_TYPES`, `bandPlanImportUrlSchema`, `importUrlPreviewRequestSchema`, `ImportUrlPreview`, `BandPlanUpdateBand`, `BandPlanUpdateChangedBand`, `BandPlanUpdateCheck`; optional `importedProvenanceSchema.sourceUrl`, `importCommitFieldsSchema.sourceUrl`, `BandPlanCapabilities.urlImportHosts`; error codes `BANDPLANS_URL_IMPORT_DISABLED` 403, `BANDPLANS_URL_REFUSED` 422, `BANDPLANS_URL_FETCH_FAILED` 502, `BANDPLANS_URL_TIMEOUT` 504 |
| `src/core/bandplans/contract.ts`                                              | `BandPlanUrlFetchResult`, `BandPlanUrlFetcher`; optional `BandPlanServiceOptions.urlFetcher`, `urlImportHosts`; optional `BandPlanService.previewImportUrl?`, `checkImportUpdate?`; `PreviewDigestFor` gains an optional `sourceUrl` (absent or null = the pre-WG6 digest)                                                                                                                                                                                                                                                                                                                          |
| `packages/api-types/src/config-export.ts` (new)                               | `CONFIG_EXPORT_ROUTE`, `CONFIG_EXPORT_CONTENT_TYPE`, `CONFIG_EXPORT_FILE_NAME`, `CONFIG_EXPORT_REQUIRES_ACCESS` (true), `CONFIG_EXPORT_REDACTED`, `CONFIG_EXPORT_OPTION_ALLOWLIST`, `CONFIG_EXPORT_SECRET_KEY_PATTERN`, `CONFIG_EXPORT_KEPT_STRING_PATHS`, `CONFIG_EXPORT_REDACTED_PATHS`, `CONFIG_EXPORT_MAX_BYTES` (256 KiB), `ConfigExportErrorCode`, `ConfigExportErrorDto`                                                                                                                                                                                                                     |
| `packages/api-types/src/receiver-capabilities.ts`                             | `RECEIVER_SAMPLE_RATE_PRESETS_HZ` (11 rates), `ReceiverSampleRatePresets`; optional `ReceiverCapabilities.sampleRatePresets`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`tests/unit/core/wg6-contract.test.ts` pins the constants, the copy identities, the persisted
spec compatibility, the DCS table properties (104 codes, no two listed codes rotations of each
other, exactly one listed inverted twin each, 023 ↔ 047), the URL schema cases, the provenance
and commit compatibility, the error statuses, the config export switches and the preset list
against the CLI's.

Names a lane creates and Main consumes at merge (frozen here by name):

- K: `computeDecodedElsewhere(views, spec)` in `src/core/scanner/plan/decoded-elsewhere.ts`;
  `planJob` returns `{ plan, lockoutExclusions?, decodedElsewhere? }`; `JobHits.ended(observationId,
discoveryId, durationMs)`.
- DO: `src/decoders/options/index.ts` exports `DECODER_OPTION_SCHEMAS` (type → schema),
  `validateDecoderOptions(type, options): DecoderOptionIssue[] | undefined` and
  `decoderOptionDescriptors(type): DecoderOptionDescriptor[] | undefined` (no Main wiring:
  manager and route import them).
- DCS: `DcsDecoder` and `dcsTwin(dcs)` in `src/core/audio-tones/dcs.ts` (no Main wiring).
- U: `createBandPlanUrlFetcher(options?)` in `src/core/bandplan-url/fetch.ts` returning a
  `BandPlanUrlFetcher`; `diffImportedBands(current, fresh)` in
  `src/core/bandplans/import/update-diff.ts`; routes `POST /api/bandplans/imports/preview-url`
  and `POST /api/bandplans/packs/:packId/check-update` in `bandPlanRoutes`.
- CE: `exportConfig(config, options): string` in `src/core/config-export/export.ts`;
  `configExportRoutes` plugin in `src/api/routes/config-export.ts` with options
  `{ getConfig: () => Config, authorize?: (request) => DeniedAdmission | undefined, version: string,
secretOptionKeys?: (type: string) => readonly string[] }`.

Every DTO addition is optional or new; no WebSocket event type changes; no config key or default
changes.

## Pipeline positions

```
REST request
  ├─ K:  POST /api/scanner/plan, job create / PATCH / restore → planJob → decoderCoverage() once → computeDecodedElsewhere → (flag) exclusions
  ├─ DO: GET /api/decoders, /api/decoders/types → status + optionIssues / descriptors (cached per decoder)
  ├─ U:  POST /api/bandplans/imports/preview-url | packs/:id/check-update (protected) → authorize → fetcher (DNS check, pinned TLS connect, capped body) → parser → preview / diff
  └─ CE: GET /api/config/export (protected) → authorize → exportConfig(effective config) → YAML
decoder create (config, API, scanner probe) → DO: validate options once → issues cached on the decoder state, one warn log
scanner observation ingest (open/close) → K: JobHits.record / JobHits.ended (Main call sites)
live demodulator PCM of an open transmission → tone detector (8 kHz) → CTCSS bank | DTMF bank | DCS: low-pass, bit slicer, 23-bit register, word check (per bit)
closed transmission → finishTone → tone.dcs → Activity row (payload, summary field, FTS)
```

## CPU and IO budgets

| Item        | Position                                                              | Budget                                                                                                                                                                                                        | How measured                                                                        |
| ----------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| K coverage  | per plan (preview, create, PATCH, restore, replan); never per hop     | ≤ 64 decoders × 32 targets = 2 048 intervals, sort + merge O(n log n), ≤ 1 ms Mac per plan                                                                                                                    | micro-benchmark at the bounds, reported                                             |
| K skip      | per plan, inside `planJob`                                            | one extra `planForSpec` at most (as lockouts)                                                                                                                                                                 | by construction                                                                     |
| K hits      | per credited observation / per ended observation                      | one Map read, constant work, no allocation                                                                                                                                                                    | by construction                                                                     |
| DO validate | decoder create (lifecycle rate)                                       | one Zod parse of the options object, ≤ 1 ms per decoder                                                                                                                                                       | by construction, reported                                                           |
| DO status   | per status read / `decoder:status` event                              | issues cached at create: zero work per read beyond copying ≤ 32 entries                                                                                                                                       | by construction                                                                     |
| DCS stage   | tone path, every PCM block of an open transmission (≈ 20–50 blocks/s) | ≤ 5 ms CPU per second of audio (0.5 % of one Mac core) for the DCS stage alone: per 8 kHz sample one low-pass step and one compare; per bit (134.4/s) one shift and one Map lookup; zero allocation in `push` | micro-benchmark: 60 s of synthetic 48 kHz audio, median of 3, load average reported |
| DCS finish  | per closed transmission                                               | constant (read the confirmed code)                                                                                                                                                                            | by construction                                                                     |
| DCS storage | per transmission row                                                  | ≤ 12 B without code, ≤ 128 B with one; rows/day unchanged                                                                                                                                                     | golden rows                                                                         |
| U fetch     | protected operator request                                            | 1 in flight, ≤ 10 s, ≤ 1 MiB streamed, then the existing parsers (≤ 100 ms for 1 MiB)                                                                                                                         | injected clock and fake sockets; parse benchmark exists (WG5)                       |
| U diff      | per update check                                                      | ≤ 512 × 512 bands keyed by id: Map build + one pass, ≤ 5 ms                                                                                                                                                   | by construction                                                                     |
| CE export   | protected operator request                                            | one walk of the config (≤ a few thousand nodes) + YAML stringify, ≤ 20 ms, body ≤ 256 KiB                                                                                                                     | benchmark on the largest fixture, reported                                          |
| CE presets  | per capabilities item                                                 | constant (a frozen array reference)                                                                                                                                                                           | by construction                                                                     |

Benchmarks are indicative under batch load; Main re-measures a miss on a quiet box. Raspberry
Pi figures are open gaps.

## Decoded elsewhere (lane K)

**Input.** `DecoderCoverageView` (core `types.ts`): id, running, health, suspended, owner,
`sourceId` (default source resolved by Main; null for external input), `inputKind`, and `band`
(verdict, basis, targets, ranges, capture centre, window half-width, all from the decoder's
`bandAssessment`). Main builds it from `DecoderManager.getAllStatus()` in the scanner service's
`previewContext()`; K never reads the manager.

**Rule** (req 1.3), `coverageOf(view, jobSourceId)`:

```
if !view.running or view.health ∉ {running, idle} or view.suspended or view.owner ≠ "config" → none
if view.sourceId === jobSourceId → none            (the job retunes that source)
b = view.band; if !b → none
if view.sourceId !== null:                          (WaveKit source)
    if b.verdict ≠ "in-band" or b.captureCenterHz == null or b.windowHalfWidthHz == null → none
    c, w = centre, half-width
    targets t with |t − c| ≤ w → [t − 6 250, t + 6 250] ∩ [c − w, c + w]
    ranges r → [max(r.minHz, c − w), min(r.maxHz, c + w)] if start ≤ end
else:                                               (external input, own device)
    if view.inputKind ≠ "external" or b.basis ∉ {configured, protocol, override} → none
    targets t → [t − 6 250, t + 6 250]               (ranges ignored: no window proves them)
```

Per decoder at most 32 targets plus ranges (targets first, then ranges, in view order), at most
64 decoders in view order; past a bound one `decoded-elsewhere-truncated` warning issue. Intervals
are clipped to the job's enabled ranges (`isRangeEnabled`), grouped by `sourceId`, sorted and
merged (touching intervals merge; decoder ids united, sorted), then all entries sorted by
`startHz`, `sourceId` (null last), and cut to 256.

**Plan.** `planJob` computes the entries once. Without the flag every entry is `applied: false`
and the hops are untouched. With `skipDecodedElsewhere: true` on a sweep job the entries become
extra exclusions alongside the lockout candidates (the same `planForSpec(spec, ctx, extra)` path
as `planWithLockouts`); if the plan with them has no hop while the plan without them has hops,
none apply and one `decoded-elsewhere-not-applied` warning is added. `previewPlan` adds
`decodedElsewhere` only when the list is non-empty. Normalisation copies the flag only when set
(provenance `operator`); `denormalise` round-trips it.

**Hit duration.** `JobHits` entries keep `lastObservationId` and `lastDurationMs` (null).
`record` sets `lastObservationId` on every credit; `ended(observationId, discoveryId, durationMs)`
sets `lastDurationMs = round(durationMs)` when the entry exists, the id is its
`lastObservationId` and the duration is finite and ≥ 0. Main calls `ended` from the ingest path
when an observation closes (`endReason` present) for each of its jobs, with
`endedAt − startedAt`.

**Failure paths.** A throwing `decoderCoverage()` → no entries and plans as without it (logged
by Main); NaN, negative or non-finite numbers in a view → that target or range ignored; a view
list longer than 64 → truncated issue; flag on an in-window job → ignored (entries reported,
never applied).

## Decoder option schemas (lane DO)

**Schemas.** `src/decoders/options/<type>.ts` per decoder type registered in `src/index.ts`
(the built-ins under `src/decoders/builtin/`), each a `z.object({...}).strict()` written
from the adapter's actual `options[...]` reads (types, enums, ranges as the adapter accepts them;
when the adapter coerces, the schema accepts what it coerces). The keys every decoder may carry
through `resolveDecoderTargetFrequencies` (`frequencies`, `frequency`) are in every schema that
allows them. `lora-meshtastic` reuses its raw options schema (exported, behaviour unchanged).
A test greps each adapter for `options[...]` / `options.` / destructured reads and fails when a
read key is missing from its schema.

**Issues.** `validateDecoderOptions(type, options)`: undefined for an unknown type; else the
Zod issues mapped to `{ path, code, message }` (`unrecognized_keys` → one `unknown-key` per key,
everything else `invalid-value`), sorted by path, cut to 32 (the 32nd a `truncated` entry
"N more"), texts cut to 256 code units. Messages are written by DO from the issue kind and the
schema (expected type, range, enum), never from the received value.

**Manager.** `registerDecoder` validates once and stores the issues on the decoder state;
`getStatus` adds `optionIssues`; one `warn` per decoder with issues (paths only). Nothing else in
the lifecycle changes (`DECODER_OPTIONS_ENFORCE` is false; the constant exists for a later flip).

**Descriptors.** Built by hand next to each schema (zod 3.25, no JSON-schema dependency):
`DecoderOptionDescriptor` per key; a test asserts descriptor keys equal schema keys and every
`enumValues`/`min`/`max` agrees with the schema. Secret keys: Meshtastic `channelKey`, every
dsd-fme key/privacy option, any credential the adapters read.

**Route and status.** `GET /api/decoders/types` items `{ type, caps, options? }` with a response
schema for the descriptor; `decoder-status-schemas.ts` and the serializer carry `optionIssues`.

## DCS (lane DCS)

**Signal.** 134.4 bit/s NRZ under the voice (0–300 Hz), continuous 23-bit words: data
`code (9 bits, LSB first) | 100 | Golay(23,12) parity (generator 0xC75)`. The receiver sees a
cyclic bit stream; any 23 consecutive bits are a rotation of the word.

**Detector** (`dcs.ts`, `DcsDecoder`). Fed by the tone detector's 8 kHz samples (the same
decimated stream as CTCSS): a low-pass below ~300 Hz (one-pole or biquad, state only), DC
removal, a slicer, and a bit clock at 8 000 / 134.4 ≈ 59.52 samples per bit recovered from zero
crossings (early/late adjustment, bounded). Each bit shifts a 23-bit register; the register is
looked up in a Map of the 512 × 23 rotations of valid words (and of their complements),
precomputed once per process (≈ 23 552 entries). A hit yields (code, polarity) — polarity
`inverted` when the complement matched. Three consecutive hits 23 bits apart with the same
reading confirm it; a different reading resets the count. `result()` returns the confirmed
reading or null. With `DCS_CODE_SET = "standard"` only table codes are readings; a word whose
normal and inverted readings are both table codes is resolved by WaveKit's demodulator polarity
(normal = the stream as demodulated), and the twin is derivable with `dcsTwin`.

**Integration.** `ToneDetector` feeds the DCS decoder alongside the banks and returns `dcs` in
`result()`; `analog-transmission.ts` `finishTone` returns `dcs` under the 0.75 s rule (and
`dcs: null` on the broken/fallback paths); `toActivityPayload` copies it.

**Storage** (`row.ts`). `isTone` accepts `{ctcssHz, dtmf}` and `{ctcssHz, dtmf, dcs}` (dcs null
or `{code: /^[0-7]{3}$/, polarity}` with the code in the table when `standard`); the summary
field `{ key: "dcs", label: "DCS", value: "023N" }`; FTS parts `DCS 023N` and the twin `DCS 047I`.
Old rows without `dcs` read unchanged.

**Fixtures.** A synthetic encoder in tests (`tests/unit/core/audio-tones/dcs-synth.ts`): NRZ at
134.4 bit/s, optional voice-like audio (sums of formant-like tones with random envelopes),
noise, deviation scaling, random start phase, both polarities; corpora for false alarms (≥ 10
minutes total: speech-like, white and pink noise, CTCSS-only, DTMF-only).

**Failure paths.** Too short audio → null; a corrupted bit in a word → no hit for that word
(no error correction: the 3-word confirmation needs clean words); alternating codes → null; NaN
or silence → null; the detector throws → `toneErrorCount` and `dcs: null` like the CTCSS path.

## Band-plan URL import (lane U)

**Fetcher** (`src/core/bandplan-url/fetch.ts`, outside the isolated band-plan core).
`createBandPlanUrlFetcher({ resolve?, connect?, now?, timeoutMs?, userAgent })` returns a
`BandPlanUrlFetcher(url, hosts)`:

1. Parse with `bandPlanImportUrlSchema` and `new URL`; host lower-case, not an IP literal, in
   `hosts`; else `BANDPLANS_URL_REFUSED`.
2. Resolve with `dns.lookup(host, { all: true })` (injectable). Refuse when the list is empty or
   any address is in a refused block (`node:net` `BlockList`): 0.0.0.0/8, 10/8, 100.64/10,
   127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24,
   203.0.113/24, 224/4, 240/4, 255.255.255.255; ::, ::1, ::ffff:0:0/96 (checked as the embedded
   IPv4), 64:ff9b::/96 (embedded IPv4), 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8.
3. `https.request` to the first checked address (`host` = the address, `servername` = the
   host, `Host` header = the host, `lookup` replaced by one that returns that address only),
   `rejectUnauthorized` true, `agent: false` (no pooling), no proxy, headers `Accept`,
   `Accept-Encoding: identity`, `User-Agent`; no cookies or auth.
4. Status 200 only (3xx, 4xx, 5xx → `BANDPLANS_URL_FETCH_FAILED`, the Location header ignored);
   `Content-Encoding` other than identity → refused; media type in `BANDPLAN_URL_CONTENT_TYPES`
   else `BANDPLANS_URL_REFUSED`; `Content-Length` above 1 MiB → `BANDPLANS_IMPORT_TOO_LARGE`
   before reading; the body is counted while streaming and destroyed past 1 MiB.
5. One deadline (10 s) covers lookup, connect, TLS, headers and body; it destroys the request
   (`BANDPLANS_URL_TIMEOUT`). One module-level in-flight flag per fetcher: a second call is
   `BANDPLANS_BUSY`. Every path releases the flag and destroys the socket.

**Service.** `previewImportUrl(request)`: off (no fetcher, empty `urlImportHosts`, or not
writable) → `BANDPLANS_URL_IMPORT_DISABLED`; validate `importUrlPreviewRequestSchema`; fetch;
`fileName` = the last path segment (decoded, bounded to 128, else `band-plan`); run the existing
preview with the bytes; `previewDigest` binds the URL (`previewDigestFor(sha, overrides,
sourceUrl)`; without a URL the digest is byte-identical to today's). Commit with `sourceUrl`
re-checks the digest and stores `provenance.sourceUrl`. `checkImportUpdate(packId)` reads the
pack's provenance, fetches, compares sha256, parses with `provenance.format`, diffs with
`diffImportedBands` (by id; `changed.fields` = the band keys whose JSON differs: name, edges,
mode, stepHz, colourHint, group, sourceType, channels) and returns the preview to commit with
`replacesPackId`. `capabilities.urlImportHosts` = the hosts when on, `[]` otherwise.

**Routes.** Both POST routes register only with `authorizeMutation` (protected), re-authorize
immediately before calling the service, use the existing error mapping and body limits
(`requestBytes` 64 KiB is enough for the URL request), and send `ImportUrlPreview` /
`BandPlanUpdateCheck`. The commit route accepts the optional `sourceUrl` key.

**Tests** never open sockets to the internet: the fetcher is tested with an injected resolver and
a local TLS-less fake `connect` (or a local `https` server with a self-signed certificate on
127.0.0.1, reached only through the injected resolver in a test that also proves the default
resolver refuses 127.0.0.1); service and route tests inject a fake fetcher.

**Failure paths** (each a test): http URL, user info, port, fragment, IP literal host, host not in
list, empty list, resolution to 127.0.0.1 / 10.x / 169.254.169.254 / ::1 / fd00:: /
::ffff:10.0.0.1 / 64:ff9b::a00:1, mixed public+private answers, DNS failure, a 301/302 with a
Location to an allowed host (still refused), 404, 500, gzip encoding, text/html, Content-Length
1 MiB + 1, a chunked body crossing 1 MiB, a stall past 10 s (injected clock), a second concurrent
fetch, TLS failure, a parse failure of the fetched bytes, update check of a pack without
`sourceUrl` and of an unknown pack.

## Config export (lane CE)

**Export** (`src/core/config-export/export.ts`, pure). `exportConfig(config, { secretOptionKeys?,
version, generatedAt })` (`secretOptionKeys(type)` returns the keys DO describes as
`secret: true`; Main injects it from `decoderOptionDescriptors` because CE may not import DO's new
module; without it only the pattern and the string rule apply): deep-copies the validated `Config`, applies 7.3 in this order: access →
`{ mode }`; redacted paths; secret-key pattern on every key at any depth; decoder options (allow
list, `secretOptionKeys`); kept-string rule outside options (paths in
`CONFIG_EXPORT_KEPT_STRING_PATHS`, or a closed set in `ConfigSchema` found by walking the Zod
schema alongside the value: `ZodEnum`, `ZodNativeEnum`, `ZodLiteral`, unions of literals, through
`ZodDefault`/`ZodOptional`/`ZodNullable`/`ZodEffects`); then `yaml` stringify with a leading
comment. Unknown structures (records, unknown keys) default to redaction for strings.

**Route** (`src/api/routes/config-export.ts`). `configExportRoutes({ getConfig, authorize,
version })`: GET `CONFIG_EXPORT_ROUTE`; `authorize` (required while
`CONFIG_EXPORT_REQUIRES_ACCESS`) runs first and its denial is returned as the access layer
does; content type, disposition, `Cache-Control: no-store`; 503 / 500 bodies as
`ConfigExportErrorDto`.

**Presets** (`src/core/tuner-capabilities/**`, `src/api/routes/receiver-capabilities.ts`).
Each item gains `sampleRatePresets` by transport (rtl_tcp → suggested with the frozen array;
others not-applicable); the item's Zod/JSON schemas and byte bounds include it.

**Tests.** The every-secret fixture of 7.4 (with each secret a distinct random token) exported
and searched as raw, YAML-quoted and base64 substrings; a property over random configs with
seeded secrets; legacy mode → no route; protected → authorize called first; presets inside the
validated ranges; byte bounds still met.

## Main wiring

- `src/core/scanner/scanner-service.ts`: `previewContext().decoderCoverage = () =>
mapDecoderStatuses(decoderManager.getAllStatus(), defaultSourceId)` (a new dep the service takes
  from `src/index.ts`); `ScanJob.decodedElsewhere` from `planJob`; `skipDecodedElsewhere` in the
  PATCH allowed keys; `this.hitsOf(jobId).ended(...)` where an observation closes.
- `src/index.ts`: `openBandPlanService({ ..., urlFetcher: createBandPlanUrlFetcher({ userAgent }),
urlImportHosts: BANDPLAN_URL_IMPORT_HOSTS })`; the scanner dep above; the effective config to
  the server for CE.
- CE ← DO: `secretOptionKeys: type => (decoderOptionDescriptors(type) ?? []).filter(d =>
d.secret).map(d => d.key)` passed to the export route.
- `src/api/server.ts`: register `configExportRoutes` only in protected mode while
  `CONFIG_EXPORT_REQUIRES_ACCESS`, with `authorize` from the access controller and the config
  getter.
- Docs and the contract test updates after merges.

## Correctness properties

1. **Decoded elsewhere is inert without views or flag.** For random specs and contexts, with
   `decoderCoverage` absent (or yielding no covering decoder) the preview deep-equals today's;
   with views but the flag absent/false the hops deep-equal today's. _Validates 1.1, 1.6._
2. **Trust rule.** For random decoder views, every reported interval is covered by some view that
   passes 1.3 (running, healthy, not suspended, config owner, other source, in-band window or
   external with a proving basis), and no view failing 1.3 contributes. _Validates 1.3._
3. **Merge shape.** Reported entries are sorted, non-overlapping and non-touching per source,
   clipped to enabled ranges, decoder ids sorted and unique, at most 256. _Validates 1.2, 1.5._
4. **Skip excludes.** With the flag on a sweep job, no hop's covered span centre lies inside an
   applied interval unless none were applied (and then the warning is present). _Validates 1.6._
5. **Hit duration.** For random record/ended sequences, `lastDurationMs` equals the duration of
   the latest ended observation that was the entry's last credit, else null. _Validates 2.1, 2.2._
6. **Option schemas accept real configs.** Every decoder in `config/*.yaml` and the fixtures
   validates with zero issues; random unknown keys always yield `unknown-key` issues and never
   change the created decoder. _Validates 3.1–3.3, 3.6._
7. **Issue bounds and secrecy.** For random option objects with seeded secret strings, issues
   are ≤ 32, texts ≤ 256, and no issue text contains a seeded value. _Validates 3.3._
8. **DCS round trip.** For every standard code and polarity at random phase, deviation, noise
   (≥ a stated SNR) and voice level, the detector reports the code (and the twin rule holds).
   _Validates 4.1, 4.3–4.5._
9. **DCS never guesses.** Random audio and the no-DCS corpora yield null; any stream with fewer
   than 3 consecutive identical words yields null. _Validates 4.3, 4.8._
10. **Tone path unchanged.** For the existing CTCSS/DTMF corpora the `ctcssHz` and `dtmf`
    results equal the pre-WG6 detector's. _Validates 4.6._
11. **URL refusal.** For random URLs and random resolved address lists, the fetcher connects only
    when the URL passes 5.2 and every address is public, and then only to a checked address.
    _Validates 5.2._
12. **Fetch bounds.** For random response shapes (status, headers, chunk sizes, delays) the
    fetcher returns bytes only for status 200, an accepted media type, identity encoding, ≤ 1 MiB
    within 10 s, and otherwise the mapped error; the in-flight flag is always released.
    _Validates 5.3, 5.4._
13. **Update diff.** For random pairs of band lists, added ∪ removed ∪ changed ∪ unchanged
    partitions the ids, and applying the diff to the current list yields the fresh list.
    _Validates 6.2._
14. **No secret in export.** For random configs with seeded secrets in every secret-bearing slot,
    no seeded value appears in the export (raw, quoted or base64). _Validates 7.3, 7.4._
