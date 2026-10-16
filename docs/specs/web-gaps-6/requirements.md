# Web gaps 6 requirements (WG6)

Status: implemented (lanes K, DO, DCS, U and CE merged, Main wiring done); E2 decided
2026-10-16: keep as shipped. See [design](design.md) and [tasks](tasks.md).

## Scope

The sixth batch of core features the planned web dashboard needs, driven by the founding use
case (see a signal on the waterfall, and WaveKit says what it is): scanner plans that say which
frequencies decoders elsewhere already cover, with an opt-in skip, and the duration of a job's
last hit per discovery; decoder option schemas that report bad or unknown options and describe
every option a type accepts; DCS (Digital-Coded Squelch) codes on closed analog transmissions,
stored and searchable; band-plan import from an https URL fetched once by core, with a manual
"check for update" diff; a redacted export of the effective configuration; and suggested RTL-SDR
sample rates on receiver capabilities.

Out of scope: CLI and web UI features (the CLI gets a coordination note only); decoder PATCH
(`PATCH /api/decoders/:id` stays 501) and enforcing option schemas; config import; a read-only
access role; noise squelch; recordings catalog adapters; FFT sizes above 2 048 bins; tuner
control over WebSocket; tuner gain tables or tuning ranges; new scanner protocols; band plans
feeding scanner exclusions; scanner defaults (`skipDecodedElsewhere` absent means today's
plans); the channelizer (stays off) and S2 (stays disabled); any change to the Activity caps,
admission limits, retention policy, coalescing windows or `activity.enabled`; the access
default (`legacy`); the files pinned by the band-plans spec (`src/decoders/band-region.ts`,
`src/decoders/band-defaults.ts`, `src/core/scanner/bandplan/index.ts`,
`src/core/scanner/bandplan/builtin.ts`); new npm dependencies.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access or data research (tests use injected fetchers, fake DNS and
self-encoded fixtures; no test opens a socket to the internet), load runs. CPU figures measured
on the Raspberry Pi are open gaps, not acceptance criteria.

Every hot-path item states its CPU budget and its pipeline position in the design; every new
bound states its arithmetic (rows/day, entries or bytes) and has a test at the bound.

## 1. Decoded elsewhere on scanner plans

As a web user planning a scan I want to see which parts of my ranges decoders on other
receivers already decode, and optionally skip them, so a scan spends its time on what nobody
is listening to.

1.1 The plan preview context shall take an optional `decoderCoverage()` view of the decoders
(`DecoderCoverageView`). Without it, or when it yields no covering decoder, previews, plans and
job runs are exactly as before (deep-equal), and no `decodedElsewhere` key appears.
1.2 `PlanPreview.decodedElsewhere` (and `ScanJob.decodedElsewhere`, runtime only) lists
`DecodedElsewhereRange` entries: `startHz`, `endHz`, `sourceId` (string, or null for
external-input decoders), `decoderIds` (sorted, unique) and `applied`. Entries are clipped to the
job's enabled ranges, merged per `sourceId` (overlapping or touching intervals become one, their
decoder ids united), and sorted by `startHz`, then `sourceId` (null last). Sweep and in-window
jobs both report them; only sweep jobs apply them.
1.3 **Trust rule.** A decoder contributes coverage only when its state proves it: `running`,
`health` `running` or `idle`, not `suspended`, `owner` `config` (scanner probes never count),
and its source differs from the job's source (decoders on the job's own source lose their
coverage when the job retunes it). For a decoder on a WaveKit source, its band verdict must be
`in-band` with a known capture centre `c` and window half-width `w`; each target `t` with
`|t − c| ≤ w` covers `[t − 6 250, t + 6 250] ∩ [c − w, c + w]`, and each band range covers
`[max(min, c − w), min(max, c + w)]` when non-empty. For an external-input decoder (own device,
`sourceId` null), only targets whose band basis is `configured`, `protocol` or `override`
cover `[t − 6 250, t + 6 250]` (no window). Nothing else is ever reported as decoded elsewhere;
an unknown or missing field means no coverage.
1.4 Coverage is evaluated when a plan is computed (preview, create, PATCH, restore and any
replan the service already performs); WG6 adds no replan on decoder state changes, and the
documentation says a skipped range stays skipped until the job's next plan.
1.5 Bounds: at most 64 decoders (in view order) and 32 targets plus ranges per decoder are
examined; at most 256 merged entries are reported (lowest `startHz` first). Exceeding a bound
adds one `warning` plan issue `decoded-elsewhere-truncated` and never fails the plan; the
warning is added only when at least one entry is reported (with no entry nothing is partial, so
1.1's equality holds).
1.6 `ScanJobSpec.skipDecodedElsewhere` (boolean, optional, absent = false, live-editable) makes
the reported ranges exclusions of a sweep plan, merged like the WG2 lockout exclusions:
`applied` is true for the ranges that became exclusions; if applying them would leave no hop,
none apply (all `applied: false`) and one `warning` issue `decoded-elsewhere-not-applied` says so.
With the flag absent or false, the hops equal today's hops for every spec.
1.7 The normalised spec carries `skipDecodedElsewhere` only when the operator set it (as
`signalsOnly`), with provenance `operator`; persisted jobs written before WG6 load unchanged.
1.8 The coverage computation is O(n log n) in examined targets and runs at most once per plan,
never per hop.

## 2. Last hit duration per job

As a web user I want to see how long the last transmission of each discovery lasted in a job.

2.1 `ScanJobHit.lastDurationMs` is the duration (`endedAt − startedAt`, ms, integer ≥ 0) of the
most recent ended observation credited to that discovery in that job, or null until one ended.
WG6 cores always send it on the hits route and on `jobHits` in scanner events.
2.2 `JobHits` gains `ended(observationId, discoveryId, durationMs)`: it updates the entry only
when that observation is the entry's most recently credited one; an unknown entry, an older
observation, a negative or non-finite duration is ignored. No new per-job memory beyond one
number and one id per tracked entry (≤ 2 000 entries).
2.3 The hits route response schema lists `lastDurationMs` (`integer`, nullable).

## 3. Decoder option schemas (report only)

As an operator I want WaveKit to tell me when a decoder option is misspelt or out of range, and
as a web UI I want every option a decoder type accepts, with its type, range, unit and default.

3.1 Every built-in decoder type has a Zod option schema written from the options its adapter
actually reads (lora-meshtastic reuses its existing schema). A test fails when an adapter reads
an option key its schema lacks.
3.2 Options are validated when a decoder is created (config and API create; scanner probes
included). Unknown keys and invalid values become issues; the decoder is created exactly as
before (`DECODER_OPTIONS_ENFORCE = false`), and one `warn` log per decoder lists the issue paths.
3.3 `DecoderStatus.optionIssues` lists the issues (`path`, `code` `unknown-key` |
`invalid-value` | `truncated`, `message`): absent for a type without a schema, `[]` when valid,
at most 32 entries (the 32nd is a `truncated` entry counting the rest), path and message at most
256 UTF-16 code units each. Messages never echo option values (a value may be a secret).
3.4 `GET /api/decoders/types` items gain `options`: one `DecoderOptionDescriptor` per documented
key (`key`, `type`, `enumValues`, `min`, `max`, `unit`, `default`, `secret`, `effect: "restart"`,
`description`), sorted by key; absent for a type without a schema. Every key whose value is a
credential or key material (for example the Meshtastic `channelKey`) has `secret: true`.
3.5 The decoder status and types response schemas carry every new field (Fastify strips unknown
properties); the WebSocket `decoder:status` serializer emits the same body.
3.6 Every decoder in `config/*.yaml` and in the test fixtures validates with zero issues.
Enforcement and `PATCH` are out of scope; flipping `DECODER_OPTIONS_ENFORCE` is a later decision.

## 4. DCS on closed analog transmissions

As a web user I want the DCS code of a transmission next to its CTCSS tone, and to search by it.

4.1 The tone path shall decode DCS: 134.4 bit/s NRZ sub-audible data, 23-bit Golay(23,12) words
(9 code bits, the fixed bits `100`, 11 parity bits, generator 0xC75), repeated continuously.
4.2 It runs only on the audio of open transmissions, on the 8 kHz stream the CTCSS bank already
receives, with buffers allocated once per detector and reused (no per-block allocation).
4.3 A code is reported only after at least 3 consecutive identical valid words
(`DCS_MIN_WORDS`), and only for closed transmissions with at least 0.75 s of audio (the CTCSS
rule); otherwise `dcs` is null. The detector never guesses: an ambiguous or inconsistent stream
is null.
4.4 `AnalogTransmissionTone.dcs` is `{ code, polarity }` (three octal digits; `normal` |
`inverted` as received with WaveKit's FM demodulator polarity) or null; closed events of WG6
cores always carry the key. Its inverted twin (023 normal = 047 inverted) is derived, never sent.
4.5 **E3 decided.** Only codes of the 104-code standard table (`DCS_STANDARD_CODES`, a cited
protocol constant like the 50 CTCSS tones) are reported. The switch `DCS_CODE_SET =
"any-valid"` would report the lowest valid code among the received word's rotations instead.
4.6 CTCSS and DTMF results are unchanged for every input (a property over the existing
synthetic corpora).
4.7 The Activity transmission row stores `tone.dcs`; old rows (without the key) stay valid;
the summary field `DCS` shows `023N` / `047I`; the full-text index holds `DCS 023N` and the
twin `DCS 047I`, so a search for either spelling finds the row.
4.8 False alarms: on the lane's synthetic no-DCS corpora (speech-like audio, noise, CTCSS-only,
DTMF-only; at least 10 minutes in total) the detector reports no code.
4.9 CPU: at most 0.5 % of one Mac core per second of transmission audio for the DCS stage
(5 ms per audio second), measured and reported; Pi unmeasured.
4.10 Row growth: at most 12 bytes per transmission row without a code (`"dcs":null`), at most
128 bytes with one (payload, summary field and FTS together); rows per day unchanged.

## 5. Band-plan import by URL (E-URL decided)

As an operator I want to import a published band plan by its URL instead of downloading it
first.

5.1 `POST /api/bandplans/imports/preview-url` with `{ url, format, groupOverrides }` shall fetch
the URL once through the injected fetcher and answer `ImportUrlPreview`: the ImportPreview of
the fetched bytes (same parser, rules and limits as file import) plus `sourceUrl` and the file
as `contentBase64`. Nothing is persisted. The client commits through the existing
`POST /api/bandplans/imports` with `sourceUrl`; the preview digest then also binds the URL,
and the committed provenance carries `sourceUrl`. A commit without `sourceUrl` computes exactly
today's digest.
5.2 **SSRF rules (all mandatory).** The URL is `https:` only, without user info, explicit port
or fragment, at most 2 048 characters. Its host (lower-case, exact match, no IP literal) must
be in `BANDPLAN_URL_IMPORT_HOSTS` (`raw.githubusercontent.com`). The fetcher resolves the host
itself and refuses if any resolved address is loopback, private (RFC 1918), link-local,
CGNAT (100.64.0.0/10), unspecified, broadcast, multicast, reserved or documentation space,
IPv6 unique-local (fc00::/7), link-local, IPv4-mapped or NAT64 forms of those; it connects only
to the checked address (no second resolution, so no DNS rebinding) with TLS verification on and
SNI set to the host.
5.3 The fetch follows no redirect (any 3xx is `BANDPLANS_URL_FETCH_FAILED`), accepts only status
200, sends no cookies, credentials or proxy settings, asks for `identity` encoding and refuses a
compressed response, accepts only the media types of `BANDPLAN_URL_CONTENT_TYPES`, aborts once
the body passes 1 MiB (`BANDPLANS_IMPORT_TOO_LARGE`, also when `Content-Length` announces more),
and aborts after 10 s in total (`BANDPLANS_URL_TIMEOUT`). One fetch is in flight per process;
another meanwhile is 503 `BANDPLANS_BUSY`.
5.4 Errors: URL import off (no fetcher injected, empty host list, or not writable) is 403
`BANDPLANS_URL_IMPORT_DISABLED`; a URL or address that breaks 5.2 or a refused media type is
422 `BANDPLANS_URL_REFUSED`; a network, TLS or status failure is 502
`BANDPLANS_URL_FETCH_FAILED`; bad request bodies are 400 `BANDPLANS_INVALID`; the parser
outcomes are as for file import. Error bodies and logs never include response bytes; logs carry
the host and path, never a query string.
5.5 The URL routes are protected only: they are mounted with the band-plan mutation routes
(only when `authorizeMutation` exists) and re-check authorization before any fetch. File import
is unchanged. `capabilities.urlImportHosts` lists the allowlist when URL import is on, `[]`
otherwise.
5.6 The band-plan core (`src/core/bandplans/**`) stays I/O-free: the fetcher lives outside it
and is injected (`BandPlanServiceOptions.urlFetcher`); the authority isolation test is
unchanged.
5.7 This amends [band-plans requirement 6.1](../band-plans/requirements.md) ("Core shall fetch no
URL"): core fetches only under 5.2–5.5.

## 6. Check for band-plan update

As an operator I want to see what changed upstream in a plan I imported by URL before I apply it.

6.1 `POST /api/bandplans/packs/:packId/check-update` (protected only) shall re-fetch the pack's
`sourceUrl` under 5.2–5.4 (the host must still be allowlisted) and answer `BandPlanUpdateCheck`.
An unknown pack is 404 `BANDPLANS_NOT_FOUND`; a pack without `sourceUrl` is 400
`BANDPLANS_INVALID`. Nothing is persisted.
6.2 Same bytes (sha256) answer `upToDate: true`, empty lists and `preview: null`. Otherwise the
fresh file is parsed with the pack's format and compared with the committed pack's imported
bands by band id: `added`, `removed`, and `changed` (with the differing field names), each sorted
by `startHz` then id and bounded by the 512-band pack cap; `preview` is the ImportUrlPreview to
commit with `replacesPackId` (operator edits kept, as re-import does today). A fresh file that
does not parse answers its parser error.
6.3 There is no automatic or periodic check.

## 7. Redacted config export (E2 decided)

As an operator I want to download my effective configuration to back it up or share it, without
leaking secrets.

**E2 DECIDED 2026-10-16: keep as shipped** (protected only, fail closed by meaning; see
[web-gaps-7 11.1](../web-gaps-7/requirements.md)). Every part below is a one-constant switch in
`packages/api-types/src/config-export.ts`.

7.1 `GET /api/config/export` answers the effective configuration (file, environment overrides
and defaults, as validated at startup) as YAML (`application/yaml`), with a first comment line
saying it is a redacted export and the WaveKit version, and `Content-Disposition: attachment`.
Export only; there is no import.
7.2 While `CONFIG_EXPORT_REQUIRES_ACCESS` is true the route exists only in protected access mode
and authorizes every request like the other protected operator routes; in legacy mode it is not
mounted (404).
7.3 Redaction: `access` is reduced to `{ mode }`; a value whose key (any path segment) matches
`CONFIG_EXPORT_SECRET_KEY_PATTERN` becomes `"<redacted>"` whatever its type or depth; the
station position (`CONFIG_EXPORT_REDACTED_PATHS`) is redacted; in `decoders[].options` every
string at any depth is redacted unless its key is in `CONFIG_EXPORT_OPTION_ALLOWLIST`, and a
key described `secret: true` by the decoder's option schema (3.4) is redacted whatever its
value; a number in decoder options is kept only when it is a member of the option's closed set
or its key is in the reviewed per-type numeric allowlist (`CONFIG_EXPORT_NUMERIC_OPTION_KEYS`)
and the option schema accepts it; outside options, a string is kept only at
`CONFIG_EXPORT_KEPT_STRING_PATHS` or when the config schema restricts it to a closed set (enum or
literal), and a value whose key names a host, URL, path, file, serial, argument, account or
operator is redacted whatever its type. Booleans and null are kept otherwise, and numbers outside
options where the schema types them. Host names, URLs, file paths, names and callsigns are therefore redacted.
7.4 **No secret ever in output.** A fixture config containing every secret-bearing key the
schema and the built-in adapters know (the protected `access` block, Meshtastic `channelKey`,
dsd-fme key options, source URLs with credentials, hosts, paths, station name, callsign and
position) exports with none of its secret values present anywhere in the body (substring
search, including YAML-escaped and base64 forms).
7.5 The body is at most 256 KiB (`CONFIG_EXPORT_MAX_BYTES`); larger is 500
`CONFIG_EXPORT_FAILED`. A missing config provider is 503 `CONFIG_EXPORT_UNAVAILABLE`.

## 8. Suggested sample rates

As a web user I want the sample rates worth offering for an RTL-SDR source.

8.1 `ReceiverCapabilities.sampleRatePresets` is `{ state: "suggested", provenance:
"wavekit-rtl-rate-presets", valuesHz }` with `RECEIVER_SAMPLE_RATE_PRESETS_HZ` (the CLI's 11
rates) on rtl_tcp sources, and `{ state: "not-applicable", reason: "non-rtl-transport" }`
elsewhere. Each preset lies inside the command's validated sample-rate ranges.
8.2 Presets are suggestions, not receiver evidence: this amends
[receiver-capabilities requirement 1.3](../receiver-capabilities/requirements.md) (no
model/table/range inference) to allow a fixed suggestion list that claims nothing about the
device. Item and page byte bounds still hold.

## 9. Main items

9.1 Main wires: the `decoderCoverage` view and the hit durations in the scanner service
(`skipDecodedElsewhere` live-editable, `ScanJob.decodedElsewhere`); the real URL fetcher and
the host list into the band-plan service options in `src/index.ts`; the config export route
in `src/api/server.ts` with the effective config and the access guard.
9.2 Main verifies the access policy: URL import and update check exist only in protected mode;
the export route only in protected mode while `CONFIG_EXPORT_REQUIRES_ACCESS`.
9.3 docs/API.md, ROADMAP and the coordination note describe every new field and route, the
trust rule of 1.3, the SSRF rules and the redaction rules.

## 10. Verification

10.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
10.2 The root suite, typecheck and lint pass at every merge.
