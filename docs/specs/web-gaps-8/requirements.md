# Web gaps 8 requirements (WG8)

Status: contract frozen; lanes ST, DP, RC and SB in progress. See [design](design.md) and
[tasks](tasks.md).

## Scope

The eighth batch of core features the planned web dashboard needs: a persisted decoder settings
store with provenance and a working `PATCH /api/decoders/:id` (protected only, schema enforced,
applied when the decoder next starts); a protected read-only inventory of the WAV recordings
WaveKit already writes (dsd-fme per-call recordings and scanner recordings) with whole-file
download; and spectrum detail above 2 048 bins where the host can afford it, measured at
startup.

Out of scope: CLI and web UI features (the CLI and the web session get a coordination note
only); Keep, delete, trim, rename or any write to a recording (the activity-recording-catalog
tasks 5 and 6, behind its checkpoint B); HTTP `Range` on recording downloads; a general settings
store for anything but decoder options and `enabled` (station, scanner and live-audio settings
keep their own layers); config import; listing overrides in the config export (it stays the
YAML/env configuration); patching paths, hosts, ports, devices, identities, `extraArgs`, secrets
or undocumented keys; applying a patch to a running process without a restart; spectrum zoom
(stays gated); default-profile bins above 2 048 (`scanner.ws.spectrumBins` keeps its 128–2 048
range); scanner defaults; the channelizer (stays off) and S2 (stays disabled); any change to the
Activity caps, admission limits, retention, coalescing windows or `activity.enabled`; the access
default (`legacy`); the files pinned by the band-plans spec (`src/decoders/band-region.ts`,
`src/decoders/band-defaults.ts`, `src/core/scanner/bandplan/index.ts`,
`src/core/scanner/bandplan/builtin.ts`); new npm dependencies.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access or data research (tests use fake decoders, temporary
directories, self-written WAV headers, synthetic spectra and injected clocks; no test opens a
socket to anything but 127.0.0.1), load runs. The Raspberry Pi figures quoted in the design
come from one bench run before WG8; new Pi figures are open gaps, not acceptance criteria.

Defaults stay byte-identical: with no override file, no protected mode and the shipped config,
every route, frame, log line and argv is the same as at the WG8 base, and each lane proves it.
Every hot-path item states its CPU budget and its pipeline position in the design; every new
bound states its arithmetic and has a test at the bound.

## 1. Decoder settings store

As an operator in the web app I want to change a decoder's documented options and whether it
starts at boot, and see where each value comes from, without editing YAML.

1.1 A persisted override layer `<stateDir>/decoder-settings.json`
(`DECODER_SETTINGS_FILE_NAME`) holds, per decoder id and type, an optional `enabled` and a map of
option values. Precedence: override > configuration (YAML with `WAVEKIT_` environment
overrides) > the adapter default. The configuration object WaveKit loaded is never mutated; the
config export stays the YAML/env configuration.
1.2 Writes are atomic (temporary file, fsync, rename) and serialised; a corrupt or unreadable
file is moved aside (`decoder-settings.json.corrupt-<ms>`) and the store loads empty with a
seeded revision (as the station store: `max(now × 1000, lost + 1)`), so a stale `If-Match`
never matches; a missing file loads empty at revision 0. Stale temporary files are swept with
the station store's bounds.
1.3 Bounds: the file is at most 256 KiB (`DECODER_SETTINGS_FILE_MAX_BYTES`), at most 256 decoder
entries (`DECODER_SETTINGS_MAX_DECODERS`) and at most 64 option keys per entry
(`DECODER_SETTINGS_MAX_KEYS`). A file past a bound is treated as corrupt (1.2). A write that
would pass a bound is refused with `DECODER_SETTINGS_LIMIT` and changes nothing.
1.4 An entry whose decoder id is not configured (orphan) or whose type differs from the
configured type (retyped) is ignored, kept in the file unchanged and reported as counts only
(a warning at load naming no ids; `overrideIgnored: "type-changed"` on the retyped decoder's
view). A PATCH of a retyped decoder replaces its entry.
1.5 `enabled` in the override means autostart at boot only: it is applied when the decoder is
created at startup and never starts or stops a running decoder.
1.6 The store loads in both access modes (overrides written in protected mode keep applying);
only the routes (section 2) depend on the mode.

## 2. Decoder PATCH and settings view

2.1 `DECODER_SETTINGS_REQUIRES_ACCESS = true`: `GET /api/decoders/:id/settings` and the working
`PATCH /api/decoders/:id` are mounted only in protected access mode. In legacy mode the PATCH
route answers exactly as today (501 `DECODER_CONFIG_UPDATE_UNSUPPORTED`) and the GET route does
not exist. In protected mode GET runs under root admission and PATCH re-checks the request like
the other protected mutations (`authorizeMetadataMutation`).
2.2 The PATCH body is a JSON merge patch `{ enabled?: boolean | null, options?: { <key>: value |
null } }`: a present value sets the override, `null` removes it (the configured value or default
applies again), an absent key is unchanged; at least one key. The body is at most 16 KiB
(`DECODER_SETTINGS_BODY_MAX_BYTES`, 413 `DECODER_SETTINGS_LIMIT`) and names at most 64 option
keys. An optional `If-Match: <revision>` that differs from the store revision is refused with
412 `DECODER_SETTINGS_REVISION_MISMATCH`.
2.3 **Patchable by meaning.** An option key is patchable only when its descriptor says
`patchable: true`; the descriptor default is false. A key is never patchable when it is
undocumented, belongs to a type without an option schema, is `secret`, is `extraArgs`, has
descriptor type `string` or `object`, is a `string-list` without a closed set, names a path,
file, directory, host, address, port, device, serial, URL or station identity (`lat`, `lon`,
`callsign`), routes output (`output`, `outputFormat`, `outputPort`, `udp*`, `agwPort`,
`kissPort`), controls recording, retention or debug capture, selects the input format, or is
rewritten by a composition step (digital-voice preparation). Such a key in a PATCH is refused
with 400 `DECODER_OPTION_NOT_PATCHABLE` and nothing changes.
2.4 Validation: each patched key is validated with its own option schema entry, and the merged
effective options pass the type's cross-key refinements; problems already present in the
configured options of keys the patch does not touch never fail the patch. Invalid values are
refused with 400 `DECODER_OPTIONS_INVALID` carrying issues (documented key paths and fixed rule
text, never the submitted values); nothing changes.
2.5 A PATCH of a scanner probe is refused with the existing 409 `DECODER_OWNED_BY_SCANNER`; an
unknown id with the existing 404 `DECODER_NOT_FOUND`; a store that cannot be written with 503
`DECODER_SETTINGS_STORE_UNAVAILABLE` (the in-memory layer is unchanged).
2.6 The 200 result carries the new view, the store revision, the keys whose effective value
changed (descriptor order, `enabled` first) and `pendingRestart`.
2.7 The settings view lists, for every documented key of the type in descriptor order, its
`source` (`override`, `config` or `default`), `patchable`, `secret`, `present` and, only for a
patchable non-secret key, its effective `value`; non-patchable and secret keys never show a
value. Undocumented configured keys are counted (`undocumentedKeys`), never named. The view
also carries `enabled` with its source, the store revision, `pendingRestart` and
`overrideIgnored` when it applies.
2.8 `GET /api/decoders/types` descriptors carry `patchable` (absent means false, so older
cores read as not patchable).

## 3. Applying settings on restart

3.1 A successful PATCH stages the effective patchable options on the decoder. The next start of
that decoder (operator start or restart, an automatic restart, or boot) builds a new adapter
instance from the instance's current configuration with the staged keys set or removed; until
then `pendingRestart` is true. Nothing is restarted by the PATCH itself.
3.2 After a rebuild every view derived from the decoder's configuration (status, caps, band and
rate assessment, provenance binding and tuning trust, ambient targets, audio and digital-voice
wiring) equals that of a decoder created at boot with the effective configuration. The manager
announces the rebuilt instance with the existing `decoder:created` event for the same id before
it starts; every listener of that event treats a known id as a replacement.
3.3 A rebuild that fails (the adapter constructor throws) keeps the previous instance and its
configuration, leaves the decoder stopped with a `lastError` naming the failure class only, and
`pendingRestart` stays true.
3.4 With no override file and no PATCH, decoder creation, start, restart and every argv are
byte-identical to the WG8 base.

## 4. Recordings inventory

As an operator I want to see and download the call recordings WaveKit already keeps, without
WaveKit changing them.

4.1 `RECORDINGS_REQUIRES_ACCESS = true`: `GET /api/recordings` and
`GET /api/recordings/:id/file` are mounted only in protected access mode; the list re-checks the
request like the other protected operator routes, the download takes the existing protected
download lease. Nothing is mounted in legacy mode.
4.2 Sources: the per-call directories of the configured dsd-fme decoders that record
(`dsdFmeRecordingDir`), and the scanner recordings (`recordings/{dv,analog}/<discoveryId>/`
under the scanner storage directory). Live probe folders (`probe-*`), `TEMP_` files, files
modified less than 10 s ago (`RECORDING_IN_PROGRESS_MS`), names that do not match the dsd-fme
call pattern or the scanner recording id, symbolic links and non-regular files are never
listed. Files that vanish during a scan (the pruners run concurrently) are skipped.
4.3 Each item has an opaque `id` that is never a path: `dsd:<n>~<basename>` (n = the index of
the recording directory in the inventory's source list) or `scan:<recordingId>`, both checked
against `RECORDING_INVENTORY_ID` before any filesystem lookup. Items carry `kind`
(`dsd-fme-call`, `scanner-dv`, `scanner-analog`), `decoderId` (dsd-fme) or `discoveryId`
(scanner), `startedAtLocal` from the file name when it parses as a real local date-time,
`modifiedAt`, `bytes`, `durationMs` from the RIFF header (null when the header is not a
plain PCM WAV), `callType` (`group`, `private`, `unit`), `talkgroup` and `source` (decimal
digits only, else null) and `frequencyHz` only when it is known (a scanner discovery's centre;
dsd-fme names carry none, so null; never guessed).
4.4 Paging: newest `modifiedAt` first, ties by id; `limit` 1–200 (default 50); an opaque
`cursor` (at most 512 characters) that is validated and refused with 400
`RECORDINGS_QUERY_INVALID` when malformed; optional `kind` and `decoderId` filters. The page
reports `scannedFiles` and `truncated` when a scan stopped at its bound.
4.5 Download: whole file, `audio/wav`, `Content-Disposition: attachment` with the basename,
`Accept-Ranges: none`; the id is resolved again at request time (same checks as 4.2); a missing
or no longer eligible file is 404 `RECORDING_NOT_FOUND`. The inventory never writes, renames or
deletes a file and never follows a symbolic link.
4.6 Bounds: at most 2 000 files examined per scan (`RECORDINGS_SCAN_MAX_FILES`), at most 4 KiB
read per file header (`RECORDINGS_HEADER_READ_BYTES`), at most 8 concurrent filesystem
operations, header results cached by path, size and mtime; a scan takes at most 500 ms on the
Mac at the bound.
4.7 Log lines and error bodies of the inventory name no path, file name, directory or decoder
option; errors use the allowlisted error fields.

## 5. Spectrum detail above 2 048 bins

As a web user on a fast host I want more spectrum detail than 2 048 bins when the host can
afford it, without slowing the Raspberry Pi or changing what the CLI gets.

5.1 Block summaries cross the worker boundary as 16-bit half-dB integers (the summary bins are
already rounded to 0.5 dB, so the encoding is lossless); the host decodes them back to the same
`number[]`, so every consumer sees identical values. A summary with a value the encoding cannot
carry exactly (non-finite, or outside its range) crosses as today's `number[]`.
5.2 `scanner.ws.spectrumBinsCap`: `"auto"` (default), 2 048, 4 096 or 8 192. `"auto"` runs one
startup micro-benchmark (at most 200 ms wall, logged once) with an injectable measurer and
picks the largest of 4 096 and 8 192 whose measured cost, times 1.5, stays within the budgets
(summary traffic ≤ 512 KiB/s, clone ≤ 10 ms/s, per-profile work ≤ 5 ms/s at the summary rate);
2 048 is the floor and needs no measurement. A failing or throwing measurer gives 2 048.
5.3 `scanner.ws.spectrumSummaryBins` accepts up to 8 192 (`SPECTRUM_SUMMARY_BINS_MAX`, default
2 048 unchanged). The engine's effective summary budget is the smaller of it and the cap.
5.4 A client's `options.spectrum.bins` is clamped to 128..min(cap, summary budget) with
`adjusted: ["bins"]` as today; `SpectrumLimits.bins.max` reports that bound and
`SpectrumLimits.binsCap` reports the setting, the cap and how it was chosen. With the default
summary budget (2 048) every subscribe, frame and limit is the same as at the WG8 base.
5.5 The default profile (`scanner.ws.spectrumBins`) keeps 128–2 048 and the default 512, so the
CLI and every client of the default profile get the same frames.
5.6 Other readers of the summary bins (scanner PSD evidence, identify peak) stay correct and
bounded for summaries above 2 048 bins.

## 6. Amendments

6.1 The activity-recording-catalog spec (task 5, requirements 6.1 and 7.1) gains a note: the
read-only legacy inventory of section 4 is delivered before its checkpoint B; it has no Keep,
delete or trim and serves downloads by inventory id, not catalog id.
6.2 The earlier "settings store later" and "decoder PATCH stays 501" scope lines (band plans,
web-gaps-4, web-gaps-6, web-gaps-7) and the WG7 "FFT sizes above 2 048 bins (WG8)" line point to
this spec.

## 7. Main items

7.1 Main wires: the store load before decoder creation and the boot `enabled`; the settings
service, the protected mounts and the rebuild listeners (digital voice, audio) in
`src/index.ts` and `src/api/server.ts`; the storage report counts the settings file in
`decoder-overrides`; the recordings inventory sources; the bins cap at startup and its use by the
spectrum service; the `spectrumSummaryBins` bound once the worker carries 8 192 bins.
7.2 docs/API.md, docs/SCANNER.md, ROADMAP and the coordination note (also addressed to the web
session) describe every new route, field, bound and rule.

## 8. Verification

8.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
8.2 The root suite, typecheck and lint pass at every merge.
