# Web gaps 5 requirements (WG5)

Status: contract frozen; lanes AG, TA, AIS, V and B in progress. See [design](design.md) and
[tasks](tasks.md).

## Scope

The fifth batch of core features the planned web dashboard needs, driven by the founding use
case (see a signal on the waterfall, and WaveKit says what it is): an automatic band map of
what Activity decoded per frequency bucket and a per-minute activity timeline, both from the
Activity store; altitude on stored positions and the Meshtastic positions that trails are
missing today; AIS base station (4), SAR aircraft (9) and aid-to-navigation (21) positions on
the default NMEA path, with the radio channel, the aid fields and the SAR altitude on
`VesselState`; a verified `tuningTrust` on reception provenance from the actual tuner state,
with a guard against frequencies a retuned receiver no longer hears; and band-plan import of
SDR# `BandPlan.xml` and Gqrx `bandplan.csv` files.

Out of scope: CLI and web UI features (the CLI gets a coordination note only); DCS; config
export; decoder PATCH; a read-only access role; noise squelch; scanner code and defaults
(`src/core/scanner/**`, `src/services/scanner-service*`), including plan-preview
`decodedElsewhere` and event replay; the channelizer (stays off) and S2 (stays disabled); any
change to the Activity caps (250 000 rows, 256 MiB, 3 days), admission limits, retention
policy default (`fair-share`), coalescing windows or `activity.enabled`; the access default
(`legacy`); a backfill of altitude on rows stored before WG5; band-plan import from a URL;
band plans feeding scanner exclusions; the files pinned by the band-plans spec
(`src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`,
`src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`); new npm
dependencies (no XML or CSV library).

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network or data research, load runs. Fixtures are self-encoded or inline.
CPU figures measured on the Raspberry Pi are open gaps, not acceptance criteria.

Every hot-path item states its CPU budget and its pipeline position in the design; every new
bound states its arithmetic (rows/day, entries or bytes) and has a test at the bound.

## 1. Automatic band map

As a web user I want the spectrum labelled with what Activity decoded at each frequency, so a
signal I see on the waterfall is identified by what was heard there before.

1.1 `GET /api/activity/bandmap` shall return `ActivityBandMap`: stored Activity rows with a
`frequency_hz`, inside a `producedAt` window and a frequency range, grouped into buckets of
`bucketHz` on a grid aligned to 0 Hz (`startHz = floor(hz / bucketHz) × bucketHz`).
1.2 Query parameters: `producedFrom`, `producedTo` (ISO), `minHz`, `maxHz`, `bucketHz`
(decimal integers), `categories` and `protocols` (comma lists or repeated, as on the search
route). Defaults: `producedTo` = now, `producedFrom` = `producedTo` minus 24 hours, `minHz` 0,
`maxHz` 2 000 000 000, `bucketHz` 12 500. Rows count when `minHz ≤ frequency_hz ≤ maxHz`.
Any other parameter, an unparseable time or number, `producedFrom > producedTo`, a window
longer than 72 hours, `minHz > maxHz`, `maxHz − minHz` above 2 000 000 000, `maxHz` above
100 000 000 000, `bucketHz` outside 1 000–1 000 000 or an unknown category is 400
`ACTIVITY_QUERY_INVALID`.
1.3 A bucket carries `startHz`, `rows`, `lastAt` (newest `producedAt`), up to 8 `protocols`
and `otherRows` (rows of the groups past the eighth), and up to 3 `topEntities`. The group
key of a row is its `protocol`, or its `kind` when the protocol is null (analog transmissions
appear as `analog-transmission`). A protocol entry carries `protocol` (the group key),
`category` (of the group's newest row in the bucket), `rows`, `entities` (distinct non-null
entity keys) and `lastAt`. Protocols are ordered by rows descending, then key ascending; top
entities by rows descending, then key ascending. `bucket.rows` equals the sum of its protocol
rows and `otherRows`.
1.4 Buckets are returned by `startHz` ascending. At most 1 000 buckets: past that the buckets
with the newest `lastAt` are kept (ties by `startHz` ascending), the response is `truncated`
with `buckets` in `truncation`, and `droppedRows` counts the rows of the dropped buckets.
1.5 Matched rows (window and filters) whose `frequency_hz` is null are counted in
`noFrequencyRows` and never placed in a bucket. `countedRows` is the number of rows placed in
buckets before the bucket cap.
1.6 Rows are examined newest first. At most 250 000 index rows of the window are examined per
request (`ACTIVITY_AGGREGATES_SCAN_ROWS`); a request that reaches the cap is `truncated` with
`scan-rows`. `coveredFrom` is the oldest instant from which the counts are exact (the window
start when nothing cut the scan).
1.7 Counts are stored rows, not receptions: a coalesced position counts once per 60 s per
entity. The documentation says so.

## 2. Activity timeline

As a web user I want a bar of activity counts per minute under the map and the Activity list,
so I can see when things were heard and drive a time cursor over the trails.

2.1 `GET /api/activity/timeline` shall return `ActivityTimeline`: counts of stored Activity
rows per time bucket and category inside a `producedAt` window.
2.2 Query parameters: `producedFrom`, `producedTo`, `bucketMs` (decimal integer),
`categories`, `protocols` (as on the search route) and `entityKey` (repeated, never
comma-split, at most 64). Defaults: `producedTo` = now, `producedFrom` = `producedTo` minus
1 hour, `bucketMs` 60 000. Any other parameter, an unparseable time or number,
`producedFrom > producedTo`, a window longer than 72 hours, `bucketMs` outside
10 000–3 600 000, more than 1 440 buckets (2.3), an unknown category or more than 64 entity
keys is 400 `ACTIVITY_QUERY_INVALID`.
2.3 Buckets are aligned to the epoch (`startMs = floor(ms / bucketMs) × bucketMs`) and dense:
one bucket per grid step from the step holding `producedFrom` to the step holding
`producedTo`, ascending, each with `total` and `counts` (non-zero categories only).
2.4 The sum of all bucket totals equals the number of rows in the window that match the
filters, unless the response is truncated; truncation and `coveredFrom` follow 1.6 (bounds
`scan-rows` and `time-limit`).
2.5 Counts are stored rows of every kind, as 1.7.

## 3. Shared rules of the aggregate reads

3.1 Both reads run in the Activity reader worker in one read transaction, through the
existing query admission (same busy and timeout responses as search, 429), with their own
deadline of 1 000 ms as a backstop. Activity disabled is 404 `ACTIVITY_DISABLED`, unavailable
503 `ACTIVITY_UNAVAILABLE`, a reader failure 500 `ACTIVITY_QUERY_FAILED`.
3.2 Inside the reader one cooperative wall budget of 600 ms covers the read; past it the read
answers 200 with `truncated: true` and `time-limit` in `truncation`. A slow read shall not
reach the outer deadline in normal use, so it never restarts the shared reader worker.
3.3 Every SQL statement of both reads is bounded by the index rows it examines, never by the
rows it matches: the walk goes over `activity_produced` (`(produced_at_ms)` with the rowid
implicit) newest first in steps of at most 4 096 index rows, each step an index range a seek
can bound (a run of one millisecond below a rowid, or whole milliseconds), so equal
timestamps never make a step unbounded. Tests prove the plans with `EXPLAIN QUERY PLAN`.
3.4 Neither read writes, caches or changes ingest; both are snapshots without cursors.
3.5 The responses carry `retentionFloor` (the oldest stored `producedAt`, null when empty) and
`generatedAt`.

## 4. Trail altitude and Meshtastic positions

As a web user I want altitude on aircraft, APRS, SAR and mesh trail points, and mesh nodes on
the trails map at all.

4.1 New aircraft rows shall carry `position.altM = round(ft × 0.3048)` from the first numeric
`altitude` or `alt_baro` (barometric; documented as such). The string `ground` and any other
non-number omit `altM`.
4.2 New APRS rows shall carry `altM` from the payload `altitude` (feet) by the same rule.
4.3 New AIS rows shall carry `altM` from `ShipData.altitudeM` (type 9, metres).
4.4 New Meshtastic POSITION rows (portnum 3) shall carry a position decoded from `payloadB64`
(strict canonical base64, at most 344 characters = 256 bytes; longer or invalid omits the
position) with `meshtastic-protobuf` `readPosition`: `lat`, `lon` and `altM` from
`altitudeM`. A position that is non-finite, out of range or exactly (0, 0) is omitted.
4.5 `altM` is an integer in −500..50 000 m; anything else omits `altM` and keeps `lat`/`lon`.
4.6 A presenter that cannot decode the altitude or the mesh payload keeps the rest of the
presentation; it never throws to ingress.
4.7 The built-row growth bound of a coalesced reception (WG2 requirement 1.8) becomes 240
bytes (was 160); the bound for any other reception stays 1 100 bytes. `fitRowBudget` keeps
`altM` on every rounded position candidate; when no candidate with `altM` fits at four or
more decimals it tries the same candidates without `altM` before rounding further.
4.8 Coalescing is unchanged (decided on the payload), so mesh positions store at most 61 rows
per node per hour. Rows stored before WG5 keep `altM` null (no backfill).

## 5. AIS types 4, 9 and 21 and the vessel channel

As a web user I want AIS base stations, SAR aircraft and aids to navigation on the map, and
the radio channel on the vessel card.

5.1 The NMEA bit decoder shall decode type 4 longitude and latitude (bits 79–106, 107–133);
type 9 altitude (38–49, 4095 not available), speed over ground in whole knots (50–59, 1023
not available), longitude and latitude (61–88, 89–115) and course (116–127, tenths, 3600 not
available); type 21 aid type (38–42), name (43–162 plus the name extension from bit 272 in
whole 6-bit characters, at most 34 characters, `@` padding and trailing spaces removed),
longitude and latitude (164–191, 192–218), off-position (259, only when the UTC second at
253–258 is at most 59) and virtual aid (269). Longitude 181 and latitude 91 are not
available. ITU-R M.1371 offsets.
5.2 A payload too short for a field omits that field; the decoder never throws.
5.3 `ShipData` gains `altitudeM` (type 9), `aidType`, `virtualAid` and `offPosition`
(type 21); `name` carries the type 21 name with its extension.
5.4 The AIS-catcher JSON path shall validate its input with Zod (no `as` casts) and map the
aid type, virtual aid, off-position and SAR altitude fields to the same `ShipData` names.
5.5 The vessel tracker shall accept the new fields and `channel`. `VesselState.channel` is the
channel of the newest message that carried one (null before any); `aton` is set only for
class `aton` from the newest type 21; `altitudeM` only for class `sar` from the newest type 9.
5.6 The vessel route response schemas shall carry `channel`, `aton` and `altitudeM`.
5.7 Rows of types 4, 9 and 21 were already full rows (not coalesced); Activity volume does not
change.

## 6. Verified tuning trust

As a web user I want a trust badge that says when WaveKit knows the receiver is tuned where a
reception claims, and no confident frequency after SDR++ retunes the receiver.

6.1 `createDecoderProvenanceIndex` shall take an optional tuner source. Without it, every
binding is `unverified`, as today.
6.2 With it, a binding is `unverified` when the decoder owns its device (source null), the
source has no tuner state, the state marks `frequency` or `sampleRate` unknown or only
declared by the configuration baseline (`declaredOnlyFields`: config or source caps, never
written by WaveKit nor seen in an accepted relay command since the start or the last reset
reconnect), direct sampling is not `off`, the sample rate is not positive, the decoder has no target frequency, the source centre differs from the
centre captured when the decoder was last created or started (or none was captured), or any
target lies more than 0.45 × sample rate from the centre. Otherwise it is `relay` when the
control mode is `external` and `commanded` when it is `internal`.
6.3 The bind centre is captured on `decoder:created` and again on `decoder:started`, for the
source the decoder reads at that moment; a lookup for a different source is `unverified`.
6.4 This rule supersedes the WG3 Main decision recorded at
[web-gaps-3 requirement 5.3](../web-gaps-3/requirements.md) ("unverified for every
decoder"). It matches the analog transmission and spectrum rule, guarded by the bind-centre
check.
6.5 A tuner source that throws makes the binding `unverified`; the lookup never throws.
6.6 The lookup stays one Map read plus at most one comparison per target, without allocating
in the steady state.

## 7. Band-plan import of SDR# and Gqrx files

As an operator I want to import the band plans I already have in SDR# or Gqrx.

7.1 `BANDPLAN_IMPORT_FORMATS` shall be `sdrpp-json`, `sdrsharp-xml`, `gqrx-csv`; the imported
provenance and the preview carry the format of the file. Persisted state written before WG5
(format `sdrpp-json`) stays readable.
7.2 `sdrsharp-xml`: a `BandPlan.xml` with an `ArrayOfRangeEntry` root of `RangeEntry`
elements (`minFrequency`, `maxFrequency`, `mode`, `step`, `color` attributes in any order,
element text = name). `gqrx-csv`: a `bandplan.csv` of `start, end, mode, step, color, name`
lines, `#` comment lines and blank lines.
7.3 The parsers are hand written and bounded: UTF-8 only (a BOM is allowed), at most
1 048 576 bytes (existing), at most 4 096 rows examined (existing `importRows`), at most 512
accepted bands (existing pack limit). XML: no DTD, no entity declarations, no CDATA, no
processing instruction except a leading XML declaration; only the five predefined entities and
numeric character references are expanded; element depth at most 4; at most 16 attributes per
element; attribute values and element text at most 1 024 characters. CSV: lines at most 1 024
characters; the name is the rest of the line after the fifth comma.
7.4 Rows follow the SDR++ importer rules (unnamed, malformed, invalid edges, out of range,
invalid text, duplicate, pack band limit; same skip reasons); frequencies are integer Hz;
`mode` maps to the band `mode` (or null), `step` to `stepHz` (integer 1–10 000 000, else null),
`color` to `colourHint` (`#rrggbb`, alpha dropped, else null); `sourceType` is the mode text
(trimmed, at most 64 characters) and the group comes from the existing group mapping (name
keywords, overrides).
7.5 A file of the wrong format, a forbidden construct or a malformed document is 400
`BANDPLANS_IMPORT_INVALID`; an oversized one 413 `BANDPLANS_IMPORT_TOO_LARGE`. The parsers
never throw.
7.6 Preview, commit, digest and the protected-only write rule are unchanged.

## 8. Main items

8.1 Main wires the tuner source into the provenance index, the two parsers into the
band-plan service, and makes `bandMap` and `timeline` required on the query service.
8.2 Main verifies the access policy treats the two new GET routes like the existing Activity
read routes.
8.3 docs/API.md, ROADMAP and the coordination note shall describe the band map, the
timeline, trail altitude and mesh trails, the AIS fields, the trust rule and the import
formats.

## 9. Verification

9.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
9.2 The root suite, typecheck and lint pass at every merge.
