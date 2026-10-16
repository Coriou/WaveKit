# Web gaps 5 design (WG5)

Status: contract frozen; lanes in progress. Requirements in [requirements](requirements.md),
tasks in [tasks](tasks.md). Background: the Activity store
([activity recording catalog](../activity-recording-catalog/requirements.md)), WG2
([design](../web-gaps-2/design.md): presentation and the row budget), WG3
([design](../web-gaps-3/design.md): RF provenance), WG4 ([design](../web-gaps-4/design.md):
bulk trails and the keyset walk), band plans ([band-plans](../band-plans/requirements.md)).

## Contract (frozen)

| File                                                                 | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/activity.ts`                                 | `ACTIVITY_AGGREGATES_SCAN_ROWS` (250 000); `ACTIVITY_BANDMAP_*` (default window 24 h, max window 72 h, default min 0 Hz, default max 2 000 000 000 Hz, max span 2 000 000 000 Hz, max Hz 100 000 000 000, default bucket 12 500 Hz, bucket 1 000–1 000 000 Hz, 1 000 buckets, 8 protocols, 3 top entities); `ACTIVITY_TIMELINE_*` (default window 1 h, max window 72 h, default bucket 60 000 ms, bucket 10 000–3 600 000 ms, 1 440 buckets, 64 entity keys); `ActivityAggregateTruncation`, `ActivityBandMapTruncation`, `ActivityBandMapQuery`, `ActivityBandMapProtocol`, `ActivityBandMapEntity`, `ActivityBandMapBucket`, `ActivityBandMap`, `ActivityTimelineQuery`, `ActivityTimelineBucket`, `ActivityTimeline` |
| `src/core/activity/storage/contract.ts`                              | identical copies of the aggregate types; optional `ActivityQueryService.bandMap?(input)` and `timeline?(input)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/core/activity/storage/index.ts`, `src/core/activity/runtime.ts` | type exports of the aggregate types; `inertActivityService()` `bandMap` and `timeline` reject like its other methods                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/api-types/src/vessels.ts`                                  | `VesselAton`; optional `VesselState.channel: "A" \| "B" \| null`, `aton: VesselAton \| null`, `altitudeM: number \| null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/api-types/src/bandplans.ts`                                | `BANDPLAN_IMPORT_FORMATS` = `sdrpp-json`, `sdrsharp-xml`, `gqrx-csv`; `BandPlanImportFormat`; `importedProvenanceSchema.format` and `ImportPreview.format` widened to the enum                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/core/bandplans/contract.ts`                                     | `BandPlanImportParser` (the `ParseSdrppBandPlan` signature), `BandPlanImportParsers` (one optional parser per non-SDR++ format), `SdrppFailureReason` gains `xml` and `csv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/core/bandplans/service.ts`                                      | optional `BandPlanServiceDeps.importParsers`; the parser is chosen by `format`; a format without a parser is 400 `BANDPLANS_IMPORT_INVALID`; `capabilities.importFormats` lists `sdrpp-json` plus the formats that have a parser (so the freeze advertises exactly today's list)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/decoders/builtin/ais-catcher.ts`                                | optional `ShipData.altitudeM`, `aidType`, `virtualAid`, `offPosition` (types only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/decoders/provenance-bindings.ts`                                | `ProvenanceTunerState`, `ProvenanceTunerSource` (types only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`tests/unit/core/wg5-contract.test.ts` pins the constants, the aggregate copy identity, the
optional service methods and the inert rejection, the optional vessel fields, the import
formats and their persisted-state compatibility, the parser selection of the frozen service,
the `ShipData` names, and that `TunerController` satisfies `ProvenanceTunerSource`.

Names a lane creates and Main consumes at merge (frozen here by name):

- AG: `bandMap` and `timeline` on `createActivityQueryService`; limit keys
  `aggregatesDeadlineMs` (1 000) and `aggregatesWallBudgetMs` (600) in `ActivityQueryLimits`;
  test override `aggregatesLimits?: Partial<AggregatesReadLimits>` in
  `ActivityQueryServiceOptions`; read ops `bandmap` and `timeline` in `read.ts`;
  `query/aggregates.ts` with `readBandMap(db, input)` and `readTimeline(db, input)`;
  `query/walk.ts` with the produced-index step walk shared with trails; routes
  `GET /api/activity/bandmap` and `GET /api/activity/timeline` in `activityRoutes`.
- TA: none (behaviour only); `ROW_GROWTH_COALESCED_BYTES` becomes 240.
- AIS: none beyond the frozen fields.
- V: `createDecoderProvenanceIndex(decoders, defaultSourceId, tuner?: ProvenanceTunerSource)`;
  `ProvenanceDecoderSource` events widen to `decoder:created`, `decoder:started`,
  `decoder:removed`.
- B: `parseSdrSharpBandPlan` in `src/core/bandplans/import/sdrsharp.ts` and
  `parseGqrxBandPlan` in `src/core/bandplans/import/gqrx.ts`, both `BandPlanImportParser`.

Every DTO addition is optional or new; no WebSocket event changes; no config key, default or
server slot changes.

## Pipeline positions

```
REST request
  ├─ AG: /api/activity/bandmap, /api/activity/timeline → query admission → reader worker
  │        (one read transaction, stepped walk on activity_produced) → JSON
  └─ B:  POST /api/bandplans/imports/preview | commit (protected) → base64 decode → B parser → preview/commit (unchanged)
decoder output → Activity ingress
  ├─ V:  provenance lookup (every reception, before admission) → resolveProvenance (unchanged)
  └─ TA: presentation (every reception, before the writer) → altM / mesh position → fitRowBudget → writer (coalescing unchanged)
tuner controller state-changed / control-mode-changed → V: per-source snapshot (operator rate)
decoder manager decoder:created / decoder:started → V: bind centre (lifecycle rate)
ais-catcher stdout line → AIS: bit decode 4/9/21 (per sentence) → ShipData → vessel tracker (channel, aton, altitudeM)
```

## CPU and IO budgets

| Item             | Position                                                            | Budget                                                                                                                | How measured                                          |
| ---------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| AG band map read | reader worker, per request                                          | ≤ 400 ms Mac at the 250 000-row scan cap; 600 ms cooperative wall budget; 1 000 ms deadline                           | benchmark on a seeded 250 000-row store, reported     |
| AG timeline read | reader worker, per request                                          | ≤ 250 ms Mac at the scan cap (SQL `GROUP BY` per step)                                                                | benchmark, reported                                   |
| AG serialisation | main thread, per request                                            | ≤ 30 ms for the largest band map (≈ 1.9 MB plain, ≈ 2.8 MB fully escaped), ≤ 5 ms for the largest timeline (≈ 330 kB) | benchmark, reported                                   |
| TA altitude      | ingress presentation, every aircraft/APRS/AIS reception             | one multiply, one round, two compares (< 1 µs)                                                                        | by construction                                       |
| TA mesh position | ingress presentation, portnum 3 receptions (≈ 600/h on a busy mesh) | strict base64 of ≤ 344 characters + one protobuf walk of ≤ 256 B, ≤ 20 µs                                             | micro-benchmark, reported                             |
| TA row budget    | ingress, every reception                                            | the arithmetic fast path stays the path of ≥ 99 % of typical coalesced receptions (no built row)                      | count on generated corpora before and after, reported |
| AIS decode       | adapter, per sentence of type 4/9/21                                | ≤ 12 more bit slices, ≤ 5 µs                                                                                          | by construction                                       |
| AIS tracker      | per ShipData                                                        | constant work, no allocation beyond the state object it already builds                                                | by construction                                       |
| V lookup         | ingress, every reception, before admission                          | ≤ 2 µs mean (WG3 req 5.6 budget), one Map read + ≤ one compare per target, no allocation in the steady state          | micro-benchmark, reported                             |
| V snapshot       | tuner events, operator rate                                         | one `getState` clone per event                                                                                        | by construction                                       |
| B parse          | protected import request, operator rate                             | single linear pass, ≤ 100 ms Mac for a 1 MiB file, no backtracking regex over unbounded input                         | benchmark, reported                                   |

Benchmarks are indicative under batch load; Main re-measures a miss on a quiet box. Raspberry
Pi figures are open gaps.

## Activity aggregates (lane AG)

**Walk** (`query/walk.ts`). The WG4 trails walk is extracted unchanged into a shared helper:
newest first over `activity INDEXED BY activity_produced`, from an exclusive cursor
`(ms, seq)`, in steps of at most `TRAILS_CHUNK_ROWS` (4 096) index rows of the window. A step
first finds its end on the index alone (`produced_at_ms = ? AND seq < ? ORDER BY seq DESC
LIMIT ?` for a run of one millisecond, else `produced_at_ms BETWEEN ? AND ? ORDER BY
produced_at_ms DESC, seq DESC LIMIT 1 OFFSET ?`), then reads its pieces (`produced_at_ms = ?
AND seq < ? AND seq >= ?` or `produced_at_ms BETWEEN ? AND ?`) with the filters applied in
the statement. Equal timestamps are bounded by the rowid, so no statement examines more than
4 096 index rows plus their table rows, whatever the filters match. `trails.ts` uses the
helper; the trails tests pass unchanged. `scannedRows` counts index rows of the window
examined (matched or not); a final partial step counts its rows on the covering index.

**Band map** (`readBandMap`). Per piece: `SELECT seq, produced_at_ms, kind, protocol,
category, entity_key, frequency_hz` with the window, category and protocol filters and
`(frequency_hz IS NULL OR frequency_hz BETWEEN :minHz AND :maxHz)`; null frequencies go to
`noFrequencyRows`. Aggregation in the worker: `Map<startHz, bucket>`, per bucket
`Map<groupKey, { rows, lastAt, category, entities: Set }>` and `Map<entityKey, rows>`.
Finalisation sorts protocols and entities (1.3), keeps the 1 000 buckets with the newest
`lastAt` (1.4) and returns them by `startHz`.

**Timeline** (`readTimeline`). Per piece: `SELECT produced_at_ms / :bucketMs AS b, category,
COUNT(*) AS n ... GROUP BY b, category` (additive across pieces), plus the `entity_key IN`
filter when given; the worker fills the dense bucket array.

**Truncation.** The walk stops at the scan cap (`scan-rows`) or when the wall budget is spent
before the next statement (`time-limit`, checked before every statement after the first, as
in trails). `coveredFrom` is the smallest millisecond such that every window row with
`producedAt` at or after it was examined; it is the window start when nothing cut the walk.

**Service and route.** `bandMap(input)` and `timeline(input)` validate (`validate.ts` rules
plus 1.2 and 2.2), acquire query admission like search (`withActivityClient`), run with
`aggregatesDeadlineMs` and pass `aggregatesWallBudgetMs` to the reader. A 600 ms read holds
the single executing slot; other queries queue as they do behind trails. Routes in
`src/api/routes/activity.ts` with a Fastify response schema covering every field; params as
1.2 and 2.2; numbers are strict decimal integers.

**Arithmetic.** The WG3 docs mix is ≈ 520 000 rows/day ≈ 21 700 rows/h; the store holds at
most 250 000 rows (≈ 11.5 h of that mix), so a 72-hour window examines at most the whole store
and the 250 000 scan cap only bites when the store is above its cap between prune passes.
250 000 rows ÷ 4 096 per step ≈ 62 steps of two to three statements each. The band map holds
one entity entry per distinct (bucket, group, entity): at most 250 000 entries (≈ 20 MB
transient in the worker). Band map response, worst case with 64-character protocols and
128-character ASCII entity keys: bucket header ≈ 130 B + 8 × ≈ 176 B + 3 × ≈ 160 B ≈ 2.0 kB,
× 1 000 buckets ≈ 2.0 MB of unescaped ASCII (measured 1 894 277 B; the test bound is 2.1 MB).
That figure assumes no character needs JSON escaping: with every protocol and key character
escaped (quotes, backslashes) the same shape measures 2 766 767 B, ≈ 2.8 MB (Main correction
after lane AG). A typical bucket (two short protocols, three short keys) is ≈ 0.5 kB
and a busy station has a few hundred active 12.5 kHz buckets (≈ 0.1–0.2 MB). Timeline: ≈ 30 B +
9 categories × ≈ 22 B ≈ 230 B per bucket × 1 440 ≈ 330 kB. Both routes are exempt from the
512 KiB search page budget, as trails. Zero rows per day are added.

**Failure paths.** Disabled 404, unavailable 503, busy or timeout 429, reader failure 500,
invalid 400; rows with a null frequency counted, never bucketed; corrupt kind/category values
are reported by the existing `activityRecordCorrupt` path (500); an empty window is 200 with
no buckets (band map) or dense zero buckets (timeline).

## Trail altitude and mesh positions (lane TA)

**Presenters.** `aircraft.ts`: `altM` from `firstNumber(payload, ["altitude", "alt_baro"])`
× 0.3048, rounded; `aprs.ts`: payload `altitude` (ft) the same way; `ship.ts`: `altitudeM`;
`meshtastic.ts`: for portnum 3, strict canonical base64 of `payloadB64` (length ≤ 344,
multiple of 4, `[A-Za-z0-9+/]` with ≤ 2 `=`, re-encode equal, ≤ 256 bytes), then
`readPosition(bytes)` from `src/core/meshtastic-protobuf.ts`; lat/lon validated as
`readPosition` in `budget.ts` (finite, in range, not (0, 0)); `altM` from `altitudeM`. A
shared `readAltitude`/`altitudeMetres` helper in `budget.ts` applies 4.5. `readPosition` in
`budget.ts` accepts an optional `altM` argument.

**Row budget.** `estimateGrowth` already counts the whole position JSON. Measured growth
bounds (`2 × presentation JSON + FTS`) of typical coalesced rows with six-decimal coordinates:
aircraft without `altM` 150 B, with a five-digit `altM` 176 B; APRS 151 B / 177 B; mesh
(seven-decimal coordinates, 18-character title) 200 B / 226 B. Under the WG2 160 B bound
every aircraft or APRS position with `altM` would be rounded or would lose `altM`, and no mesh
position would keep its title, so the coalesced bound becomes 240 B (4.7). Cost: at most 80 B
more per coalesced row; at the 250 000-row cap that is ≤ 20 MB (≤ 7.5 % of the 256 MiB byte
cap); rows per day are unchanged (coalescing decides on the payload). `roundPosition` keeps
`altM`; the no-`altM` retry of 4.7 runs before rounding below four decimals. The lane adds a
golden maximum-size row per presenter at the 240 B and 1 100 B bounds and proves 4.7 on it.

**Failure paths.** Throwing protobuf read or invalid base64 → no position, presentation kept;
`altitude: "ground"` or non-finite → no `altM`; an altitude outside −500..50 000 m → no `altM`;
oversized payload → no position.

## AIS types 4, 9 and 21 and the vessel channel (lane AIS)

**Decoder.** `decodeAisPayload` gains `applyType4`, `applyType9`, `applyType21` with the
5.1 offsets, using the existing `readUnsigned`/`readSigned`/`readAisText` helpers (which
return undefined past the end, so short payloads omit fields). Type 21 name = `readAisText(43,
20)` + the extension (`floor((bits − 272) / 6)` characters, at most 14), trimmed after `@`
removal, at most 34 characters. Type 9 `sog` is whole knots (no `/10`). `offPosition` only
when the second ≤ 59.

**JSON.** `parseJsonShip` validates with a Zod schema (unknown keys ignored) and maps the
aid type, virtual aid, off-position and altitude keys the lane confirms against the existing
JSON fixture and parser; a key it cannot confirm offline is mapped as AIS-catcher names it
(`aid_type`, `virtual_aid`, `off_position`, `alt`) and reported as an assumption.

**Tracker.** `shipReportSchema` accepts `channel` (`A`/`B`), `altitudeM`, `aidType`,
`virtualAid`, `offPosition`. `VesselState.channel` = newest carried channel (a message without
one keeps it); `aton` for class `aton` from the newest type 21 (each field null when that
message lacked it); `altitudeM` for class `sar` from the newest type 9; all three null
otherwise. Route schemas (`src/api/routes/vessels.ts`) list the three fields.

**Fixtures.** `tests/mocks/fixtures/ais/encode.ts` gains `encodeType4`, `encodeType9` and
`encodeType21` (self-encoded, ITU-R M.1371 offsets).

**Failure paths.** Short or garbage payloads → fields omitted; 181/91 → no position; aid type
out of 0..31 impossible (5 bits); JSON with wrong types → the field is ignored, not the ship.

## Verified tuning trust (lane V)

**Rule** (6.2). `trust(entry, snapshot)`:

```
if !tuner || entry.sourceId === null → unverified
s = snapshot(entry.sourceId); if !s → unverified
if s.unknownFields has "frequency" or "sampleRate" → unverified
if s.declaredOnlyFields has "frequency" or "sampleRate" → unverified   (R1: baseline ≠ proof)
if s.directSampling !== "off" → unverified
if !(s.sampleRate > 0) or entry.targets is empty → unverified
if entry.bindSourceId !== entry.sourceId or entry.bindCentre !== s.frequency → unverified
if any |t − s.frequency| > 0.45 × s.sampleRate → unverified
return s.controlMode === "external" ? "relay" : "commanded"
```

The controller lists a relay frequency/rate it ignored (out of range, RTL gap; the relay
already forwarded it) in `unknownFields` until the next accepted value. A bind captures any
known centre, declared-only included, since the decoder configured itself from the caps.
The index keeps one snapshot per source (`frequency`, `sampleRate`, `controlMode`,
`directSampling`, `unknownFields`, `declaredOnlyFields`), seeded with `getState` the first time a source is needed and refreshed on
`state-changed` and `control-mode-changed`; the lookup never calls `getState` (it clones).
The bind centre and source are captured on `decoder:created` and `decoder:started`. Per entry
up to three frozen bindings (one per trust value) are cached for the current source, so the
steady state allocates nothing. `dispose()` removes every listener.

**Margin.** 0.45 × sample rate keeps a target inside the usable 90 % of the IQ bandwidth
(2.4 Msps → ± 1.08 MHz).

**Limitation.** The trust is as good as the tuner state WaveKit observes: a retune through the
relay or a WaveKit command is seen; a client that tunes the dongle host directly, bypassing
both, is not, exactly as for analog transmissions and spectrum today. The documentation says
so; the lane reports which paths update the state.

**Failure paths.** `getState` or a listener throwing → that source has no snapshot →
`unverified`; the lookup never throws (ingress also guards it, WG3 req 5.7).

## Band-plan import of SDR# and Gqrx (lane B)

**SDR#** (`import/sdrsharp.ts`). Strict UTF-8 decode (BOM stripped; UTF-16 is `encoding`); a
hand-written tokenizer over the string with explicit bounds: optional leading `<?xml ...?>`,
comments `<!-- -->` (each ≤ 4 096 characters), whitespace; `<!DOCTYPE`, `<!ENTITY`, `<![CDATA[`
or any other `<!`/`<?` construct → `xml`. Elements: name `[A-Za-z_][\w.-]*` (namespace
prefixes allowed and ignored), at most 16 attributes each (single or double quotes, ≤ 1 024
characters), depth ≤ 4, matching end tags, text ≤ 1 024 characters. References: `&amp;`
`&lt;` `&gt;` `&quot;` `&apos;`, `&#N;` and `&#xH;` of a valid non-control scalar; anything else
→ `xml`. The root must be `ArrayOfRangeEntry`; each `RangeEntry` child is one row (other
children are `malformed-row`). Frequencies: decimal integer strings; `step` decimal integer;
`color` 8 hex (`AARRGGBB`) or 6 hex → `#rrggbb`.

**Gqrx** (`import/gqrx.ts`). Strict UTF-8; lines split on `\n` (a trailing `\r` removed); a
line over 1 024 characters is `malformed-row`; blank and `#` lines skipped (they do not count
toward the row cap); fields split on the first five commas and trimmed; fewer than six fields
→ `malformed-row`; frequencies decimal integers; colour `#rrggbb` or `#aarrggbb` → `#rrggbb`.

**Mode map** (case-insensitive, trimmed): `AM` → `am`; `FM`, `NFM`, `NARROW FM` → `nfm`;
`WFM`, `WFM (MONO)`, `WFM (STEREO)`, `WFM (OIRT)` → `wfm`; `USB` → `usb`; `LSB` → `lsb`; `DSB` →
`dsb`; `CW`, `CW-L`, `CW-U`, `CWL`, `CWU` → `cw`; `RAW` → `raw`; anything else → null.

**Rows.** As SDR++ (`inspectRow` rules, shared helpers may move into a new
`import/rows.ts`), plus `mode`, `stepHz` and `colourHint`; `sourceType` = mode text; group from
`mapImportGroup`; preview `meta` all null; `format` = the file's format; `domain.ts` writes the
mutation's format into the provenance.

**Arithmetic.** 1 MiB ÷ 4 096 rows ≈ 256 B per row, above any real entry (≈ 80–120 B), so the
row cap and the file cap bind together; ≤ 512 bands accepted per pack (existing). The
tokenizer is one pass with constant work per character: a 1 MiB file is ≈ 1 M steps.

**Failure paths** (each a test): DOCTYPE, internal and external entity declarations, an
entity-expansion bomb, an unknown entity, CDATA, a processing instruction after the start,
depth 5, 17 attributes, a 1 025-character attribute, unclosed and mismatched tags, a wrong
root, NUL and control characters, UTF-16 with BOM, invalid UTF-8, 4 097 rows, 1 MiB + 1
byte, CRLF, an SDR++ JSON file sent as `gqrx-csv` and vice versa.

## Main wiring

`src/index.ts`: `createDecoderProvenanceIndex(decoderManager, () =>
sourceRouting.getDefaultSourceId(), tunerController)` (V). `src/core/bandplans/index.ts`
(barrel): `importParsers: { "sdrsharp-xml": parseSdrSharpBandPlan, "gqrx-csv":
parseGqrxBandPlan }` (B). `src/core/activity/storage/contract.ts`: `bandMap` and `timeline`
become required after AG merges; the query-service fakes in
`tests/unit/api/activity-routes.test.ts`, `tests/unit/api/activity-subscriptions.test.ts`,
`tests/unit/api/activity-websocket.test.ts` and `tests/unit/core/activity/query/fixture.ts`
gain the two methods. No `server.ts` change (the routes ride `activityRoutes`,
`vesselRoutes` and `bandPlanRoutes`).

## Correctness properties

1. **Band map model.** For any stored rows (random kinds, protocols, categories, entities,
   frequencies including null, equal timestamps) and any valid query, the band map equals a
   naive in-memory model of 1.1–1.5: every bucket's `startHz ≤ hz < startHz + bucketHz` for
   its rows, `rows` = Σ protocol rows + `otherRows`, `countedRows` = Σ bucket rows +
   `droppedRows`, `noFrequencyRows` exact, caps never exceeded. _Validates 1.1–1.5._
2. **Timeline model.** For any stored rows and query, the dense bucket array has
   `floor(to / b) − floor(from / b) + 1` buckets, each row is counted in the bucket of
   `floor(ms / b)`, and Σ totals = the count of matching rows in the window. _Validates
   2.3, 2.4._
3. **Aggregate walk bounds.** For any store (including runs of more than 4 096 rows with one
   timestamp) and filters, every statement's plan is an index search on `activity_produced`
   (no full scan), no statement returns or examines more than 4 096 index rows, and with the
   scan cap or the wall budget lowered the counts are exact for rows at or after `coveredFrom`
   and never exceed the model. _Validates 1.6, 2.4, 3.2, 3.3._
4. **Altitude.** For any payload, `altM` is absent or an integer in −500..50 000 equal to
   `round(ft × 0.3048)` (aircraft, APRS) or `round(altitudeM)` (AIS, mesh). _Validates
   4.1–4.3, 4.5._
5. **Mesh position agreement.** For any Position protobuf of at most 256 bytes, the presented
   position equals the mesh tracker's decode of the same payload (lat, lon; `altM` per 4.5),
   and any other `payloadB64` yields no position without throwing. _Validates 4.4, 4.6._
6. **Row budget with altitude.** For random presenter payloads, built-row growth is ≤ 240 B
   for a coalescible reception and ≤ 1 100 B otherwise. _Validates 4.7._
7. **AIS round trip.** For random valid fields of types 4, 9 and 21 (including the name
   extension and the not-available values), encode → decode returns the fields (not-available
   values omitted). _Validates 5.1, 5.3._
8. **AIS truncation.** Any prefix of a valid 4/9/21 payload, and random 6-bit strings, decode
   without throwing and never yield a field whose bits are missing. _Validates 5.2._
9. **Vessel channel and class fields.** For any message sequence, `channel` is the newest
   carried channel, `aton` is non-null only for class `aton` and `altitudeM` only for class
   `sar`. _Validates 5.5._
10. **Trust rule.** For random tuner states, bind centres, sources and targets, the binding's
    trust equals the 6.2 function; it is never `commanded`/`relay` when the centre moved or a
    target is outside the margin; without a tuner source it is always `unverified`.
    _Validates 6.1–6.3._
11. **Import totality.** For random bytes and random mutations of valid files, both parsers
    return without throwing, and every accepted band satisfies the band schema and
    `checkBand`. _Validates 7.3–7.5._
12. **Import round trip.** A generated SDR# or Gqrx file of random valid rows imports to the
    same names, edges, modes, steps and colours; its preview digest is stable across calls.
    _Validates 7.2, 7.4, 7.6._
