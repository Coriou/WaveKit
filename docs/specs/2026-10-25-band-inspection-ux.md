# Band inspection UX

Status: design, 2026-10-25. Scope: the web band view (discovery tags on the Spectrum board and
the band ruler), discovery hints across the web app, 429 handling for Activity fetches, merge
aliases for discovery reads and startup consolidation events, and four documentation fixes.

## Background

A user inspecting a band in the web app meets three defects: discovery tags for one emitter
stack at one frequency; a discovery far outside the capture window can be drawn at the left
edge; and nothing says what an unidentified signal probably is or what to do next. In the core,
a discovery absorbed by consolidation returns 404 by its old id, and startup consolidation
emits no WebSocket `merged` events, so open clients keep stale records.

Relevant code today:

- `web/src/plot/discovery-tags.ts` `placeDiscoveryTags`: filters to the view, dedupes on the
  exact rounded Hz, then drops any dot that clashes with an earlier one (a dropped tag is
  invisible, so neighbours silently disappear or overlap with saved tags).
- `web/src/plot/band-ruler.ts` `rulerMarks` / `hzToRulerX`; `web/src/plot/BandRuler.tsx`.
- `Discovery.hint` in `packages/api-types/src/scanner.ts`:
  `ScannerClass | "ism-device" | "analog-voice" | "lora"` (weak discoveries only).
- `DecoderSuspensionReasonCode` in `packages/api-types/src/decoders.ts` includes
  `frequency-out-of-band`, `capture-too-narrow`, `no-channel-selected`, `tuner-scanning`,
  `efficiency-budget`, `decoder-unavailable`, `channelizer-unavailable` and the rate reasons.
- `GET /api/scanner/discoveries/:id` in `src/api/routes/scanner.ts` calls
  `ScannerService.getDiscovery`, which reads `DiscoveryStore.get` only.
- Merge aliases: `RecordingAliasTable` (`src/core/scanner/recording-aliases.ts`), at most
  `DISCOVERY_RECORDING_ALIASES_MAX = 64` per owner, oldest released first.
- Startup consolidation: `ScannerService` applies `DiscoveryStore.applyConsolidation` in slices
  of `CONSOLIDATE_SLICE_GROUPS` (16) before ingest; `onStoreChange` is the event path.

## Requirements

### Requirement 1: band view

**1.1 Emitter clusters.** Tags in view are grouped before placement. Sort candidates by
frequency. A candidate joins the current cluster when either holds against the cluster's last
member `p`:

- pixel rule: `x(d) - x(p) < bare + gap` (defaults 15 + 4 = 19 px), with
  `x(f) = (f - view.startHz) / span * widthPx`; or
- bandwidth rule: `d.frequencyHz - p.frequencyHz <= max(1000, max(bw(d), bw(p)) / 2)`,
  `bw = bandwidthHz || 12500`.

Chaining is unbounded (a dense band can form one wide cluster); that is what guarantees no
overlap. Placement: a cluster's tag sits at `x(first)` (its lowest member), never at the
representative's x. Two consecutive clusters A, B satisfy `x(B.first) - x(A.last) >= 19`
(else B would have joined A), and `x(A.last) >= x(A.first)`, so a bare tag (15 px) plus the
4 px gap always fits: `x(A.first) + 15 + 4 <= x(B.first)`. A label widens a tag only when it
still ends `gap` before the next tag, as today. Every member is reachable through its cluster's
popover, which lists all members (scrolling, frequency order; no member cap, since members are
already bounded by the fetched discoveries).

Example: at 2.4 MHz across 1200 px (2 kHz/px), discoveries at 433.920, 433.925 and
433.940 MHz sit 2.5 px and 7.5 px apart: one cluster of three. At 433.980 (20 px from
433.940) a new cluster starts. The review case x = 0, 18, 36, 54, 72, 77 forms one cluster
(each step < 19 px), drawn as one tag at x = 0.

Acceptance:

- A cluster of one renders exactly as today.
- A cluster of n >= 2 renders one group tag at `x(first)`, labelled with the representative
  (first by the existing order: tier, confidence, recency, id) as `<title> +n-1`, accessible
  name "n signals, <low MHz>-<high MHz>".
- Activating a group tag opens a popover listing every member, each with its own "what is
  this" row (1.3); Escape and outside click close it.

**1.2 Out-of-window discoveries.** Discoveries with `frequencyHz` outside
`[view.startHz, view.endHz]` are never drawn on the board or the ruler at a clamped position.
Each side with k >= 1 such discoveries among those already fetched (`discoveryFetchSpan` is
the view widened by half a view each side) shows one edge marker: "k signals outside view ←"
or "→". Discoveries beyond the fetched span are not counted (the marker says "nearby").

Acceptance:

- Exactly zero tags have `hz` outside the view; at most one marker per side.
- Clicking a marker opens a confirm offering "Tune to <nearest MHz>?". Confirm calls the
  existing tuner action; cancel does nothing. Nothing retunes without confirmation.
- The implementer first reproduces the left-edge pin with the stale-cache fixture below
  (`placeDiscoveryTags` and `rulerMarks` already filter, so the pin likely comes from a layer
  that keeps tags from a previous view after a retune: the Plot label layer or the
  discovery row's CSS position) and fixes it there.

**1.3 "What is this".** Each tag, group member and discovery row shows, in order:

1. Protocol: unqualified only for verified evidence (`confidence === "decoded"` or
   `evidenceLevel === "proven"`); a tentative protocol keeps the existing `confidenceText`
   qualifier.
2. Otherwise `hint`, rendered as "likely <hint text>" in muted style, never in the protocol
   slot and never used as a filter (`ism-device` "ISM device", `analog-voice` "analog voice",
   `lora` "LoRa", a `ScannerClass` its existing class label, any other string "unclassified").
3. A next-step line from `coverage` (1.4), first matching row:

| coverage                                        | next step text                                     |
| ----------------------------------------------- | -------------------------------------------------- |
| field absent (unknown)                          | "Run identify" (no decoder claim)                  |
| `[]` (verified none) and `hint: "analog-voice"` | "Listen to check"                                  |
| `[]` (verified none)                            | "No decoder covers this frequency; run identify"   |
| entry `state: "running"`                        | "<decoder> is listening; wait for a transmission"  |
| `suspended`, `frequency-out-of-band`            | "<decoder> covers this band only when tuned to it" |
| `suspended`, `capture-too-narrow`               | "Widen the capture so <decoder> fits"              |
| `suspended`, `no-channel-selected`              | "Select a channel for <decoder>"                   |
| `suspended`, other known or unknown reason      | "<decoder> is suspended"                           |
| `stopped`                                       | "Start <decoder> to identify"                      |
| any unknown `state` string                      | "<decoder> may cover this; run identify"           |

"Listen to check" is added beside a decoder row too when the hint is `analog-voice`. Unknown
strings never yield "listening".

**1.4 Additive DTO.** In `packages/api-types/src/scanner.ts`:

```ts
export interface DiscoveryCoverage {
	decoderId: string // 1-64 chars
	state: "running" | "suspended" | "stopped"
	suspensionReason?: DecoderSuspensionReasonCode
}
// on Discovery:
/** Absent: unknown (no claim). []: verified no placement covers it. At most 3, running first. */
coverage?: DiscoveryCoverage[]
```

Projection (core, read time, from each decoder's `DecoderStatus.placements`, not band
eligibility; not stored or journaled):

1. A placement is a candidate when `placement.sourceId` is in `discovery.sourceIds`.
2. It covers `f = discovery.frequencyHz` when: `reach: "channel"` and
   `|f - channelHz| <= channelWidthHz / 2` (the decoder's declared channel width, default
   12 500 Hz); `reach: "raw" | "centre"` and `f` lies in the placement source's capture window
   `captureCenterHz +- windowHalfWidthHz` (the band assessment's figures). A placement missing
   the figures it needs is skipped and makes the whole result unknown (field omitted).
3. Per decoder, the best covering placement wins: `running` over `suspended` (its
   `suspension.reasonCode`) over `stopped`. "running" is reported only from a running
   placement that covers `f` on a matching source.
4. Sort running, suspended, stopped, then `decoderId`; keep 3. Decoders with an id longer
   than 64 chars are skipped (logged once).
5. Omit the field when decoder status is unavailable.

Bounds: decoders are not capped by config, so the route builds one sorted interval index of
all placements per request (P placements: O(P log P)), then each discovery is O(log P + k)
with k capped by early exit at 3 decoders. Entry size <= 64 (id) + 10 (state) + 26 (reason) +
~60 (keys, quotes) = 160 bytes; field <= 3 x 160 + 2 = 482 bytes; the list page maximum is 500,
so <= 241 kB added per page. Served on `GET /api/scanner/discoveries`,
`GET /api/scanner/discoveries/:id` and band-map entries carrying a discovery id.

Acceptance: older clients ignore the field; the response JSON schema lists it as optional;
`[]` and absent are distinguished end to end.

### Requirement 2: web resilience and hints everywhere

**2.1 429 retry.** `ApiClient` (`web/src/data/api-client.ts`) retries GETs used by Activity
(`/api/activity`, `/api/activity/timeline`, `/api/activity/bandmap`, `/api/activity/facets`)
and message lists on HTTP 429.

- Base delay `d`: `Retry-After` seconds (non-negative integer) or HTTP date (minus now);
  malformed or absent: `500 * 2^attempt` ms (500, 1000, 2000).
- If `d > 10 000` ms: do not retry; surface the error with "rate limited, retry in N s".
- Else wait `max(d, 250) * (1 + j)`, `j` uniform in [0, 0.2]: never earlier than the server
  asked; one wait <= 12 s.
- At most 3 retries: worst case 36 s added, then today's error state. Abort stops at once.

**2.2 Hint rendering.** Render `hint` via one shared formatter (`hintText` next to
`discoveryTitle` in `web/src/data/scanner-format.ts`) in: `plot/DiscoveryTags.tsx` (tag title
and group popover), `plot/SignalMenu.tsx`, `features/scanner/drawer/DiscoveryList.tsx` and
`rows.ts`, `features/scanner/drawer/History.tsx` / `HitLog.tsx`, `features/tuned/TunedCard.tsx`
(identify view), `features/palette/model.ts` (discovery results), and
`features/recordings/RecordingsDrawer.tsx` where a discovery is named.

### Requirement 3: core detection

**3.1 Reading an absorbed id.** `GET /api/scanner/discoveries/:id` for an id merged into a
live survivor returns 200 with the survivor's record plus `absorbedInto: <survivor id>` and
`requestedId: <id>` (additive, optional). Chosen over a 301 redirect because clients already
parse one shape, a redirect complicates CORS for paired browsers, and one round trip suffices.
`/observations` and the evidence routes resolve the same way. Unknown or evicted ids stay 404.

Resolution order: `RecordingAliasTable.aliasOwner` (recording aliases, unchanged, <= 64 per
owner), then a new `AbsorbedIdIndex`: a global insertion-ordered map `absorbedId -> survivorId`
capped at 16 384 entries, evicting the oldest merge first; chains are resolved at write time
(re-pointing on a later merge is an update, not a new entry). Memory: ~200 bytes per entry
(two id strings plus map overhead) = ~3.3 MB worst case, independent of `maxDiscoveries`
(up to 1 000 000). The index is in memory only; after restart only recording aliases resolve.
The recording alias table is not enlarged, so recording ownership rules do not change.

**3.2 Startup consolidation events.** After each slice, one `discovery` event per survivor
with `change: "merged"`, the full survivor record and `mergedIds` (the existing payload, so
`ScannerStore.withDiscoveryEvent` and `NearDiscoveryStore.onDiscovery` work unchanged).
`mergedIds` holds at most 64 ids; beyond that the event adds `mergedTruncated: true` and
clients refetch that survivor and the discovery list.

When a start applies more than 256 groups, the core sends no per-group events and instead one
new WebSocket event type `scanner:discoveries-resync` `{ reason: "consolidation", groups }`.
Old clients ignore unknown event types (the implementer verifies `events-client.ts` and the CLI
do); new clients refetch the discovery list. So <= 256 merge events per start. Events applied
before the WebSocket server is up are queued (<= 256, else resync).

**3.3 Store revision.** HTTP answers and WebSocket events share no ordering, and a client
cannot guess one (a PATCH answer is a snapshot the core may hold while it releases probes and
replans). So the core orders them:

- `DiscoveryStore` keeps one store-wide counter, bumped once per published change (an
  operation, a proof change, a recording commit). Every record that change touched takes the
  new value as its `revision`, so a record's revision strictly increases; removed records
  leave at that revision. Memory only, never journaled or snapshotted; a record unchanged since
  the start reads 1.
- `storeEpoch` is new on every start and restore, so revisions are never compared across
  restarts and the counter needs no persistence. At 1e6 changes/s a JS safe integer
  (about 9.0e15) lasts some 285 years.
- Reads carry `revision` per record; list pages, detail and PATCH answers carry `storeEpoch`
  and `storeRevision` (the store revision the answer was taken at; for PATCH, right after the
  edit). Events carry `revision` (the removal's for `deleted`; for `merged` also the removal
  revision of every id in `mergedIds`) and `storeEpoch`. DELETE (204) sends both as headers.
- The web store orders every write on (record revision, read revision), the read revision
  being the answer's `storeRevision` (an event's own revision), and applies one when its pair
  is at least the held pair. An equal pair is accepted, so a later read refreshes `coverage`
  (added by the routes at read time, never on events, and changing without a new revision);
  an event without `coverage` keeps the held one. A deletion is final (ids are never reused).
  A complete page (the first page, asked without a cursor, with `nextCursor` null) read at R
  covers its query: a matching record it did not list, from an answer read before R, is stale,
  which also handles records the cache never saw. A page that drops a cached record removes it
  without making that final (the record may have moved). Bounds: 2 048 remembered removals and
  32 covered pages; evicting one raises a floor to its read revision, and an answer read before
  the floor is refused (missing until the next read, never stale); a fresh read is never below
  it. A new epoch clears the cache and resyncs; late answers from a retired epoch are dropped,
  and a DELETE asked before an epoch change applies nothing. Without `storeEpoch` (an older
  core) the same rules run on a client sequence: a read's request start, a live event's or a
  successful mutation's arrival.

### Requirement 4: documentation

- `docs/API.md`, `docs/ROADMAP.md`: replace internal batch codes (`WG[0-9]+`, "lane …") with
  dates and spec links; content unchanged.
- `docs/web/canvas/Settings.dc.html` (`sys.ports` row): "API 3000" becomes "API 9000"; check
  the audio value against `config/default.yaml` at the same time.
- Relay port: the schema default (1234, `src/config.ts`) and the shipped Docker configs (4713,
  `config/docker-usb.yaml`, `config/docker-pi.example.yaml`, `config/docker-usb-bridge.yaml`)
  are both valid; no config change. Document the distinction in `docs/DOCKER-SETUP.md` and
  `docs/CORE-REFERENCE.md`: 1234 when the key is omitted, 4713 in the Docker images so it does
  not collide with an rtl_tcp server on 1234.
- `compose.yaml` set `RTL_TCP_HOST` / `RTL_TCP_PORT` on the `prod-single-host` service, which
  nothing in the image reads. Resolved by deleting the two lines rather than renaming them to
  `WAVEKIT_SOURCES_0_*` (that would change behaviour); the source is set in the mounted config,
  whose existing `sources[0]` can be overridden with `WAVEKIT_SOURCES_0_HOST` /
  `WAVEKIT_SOURCES_0_PORT`.

## Properties

```ts
// Feature: band-inspection-ux, Property 1: clusters cover and do not overlap
// Validates: Requirements 1.1
```

1. For any discoveries, view and width: every in-view taggable discovery is in exactly one
   cluster; for sorted placed tags `a.x + a.width + gap <= b.x`; each cluster's tag x equals
   `x(first)`. (1.1)
2. Clustering is invariant under input order. (1.1)
3. No placed tag has `hz` outside the view; left + right marker counts + placed members =
   taggable fetched discoveries. (1.2)
4. The protocol slot is never filled from `hint`, and no row says "listening" unless a
   coverage entry has `state: "running"`. (1.3)
5. `coverage` is absent, or has <= 3 entries, ids of 1-64 chars, running before suspended
   before stopped; a "running" entry exists only if a running placement on a matching source
   covers `frequencyHz`. (1.4)
6. For any `Retry-After` string and attempt: no retry when `d > 10 000`; else the wait is in
   `[max(d,250), 1.2 max(d,250)]`; attempts <= 4. (2.1)
7. For any merge sequence: GET of a merged id resolves to its current survivor while indexed;
   index size <= 16 384; per-owner recording aliases <= 64. (3.1)
8. Per start: merge events <= 256 or exactly one resync; each `mergedIds.length <= 64`. (3.2)
9. For any sequence of server changes (edits, deletions, merges) with reads, PATCHes and
   DELETEs taken between them, delivered to the web store with their events in any order, the
   store ends at the server's final state for every id it has seen. (3.2, 3.3)

All with `fast-check`, `numRuns: 100` or more.

## Mock fixtures (web/mock)

Add to `web/mock/scanner.ts`:

- `stacked`: five discoveries within 433.915-433.935 MHz (mixed `decoded`, tentative,
  `activity` with `hint: "ism-device"`, one operator label) plus one at 433.980; and a dense
  run at 19 px minus 1 Hz steps to exercise unbounded chaining.
- `nearby-off-screen`: mock tuned to 433.92 MHz at 2.4 Msps; one discovery at 432.9 MHz and
  three near 434.9 MHz (inside the fetched half-view margins) to show "1 ←" and "3 →".
- `stale-cache`: discoveries at 145.500 MHz loaded while tuned there, then a retune to
  433.92 MHz; asserts no tag at x = 0 (the left-edge regression).
- `hints`: one weak discovery per hint value plus one unknown hint string; coverage absent,
  `[]`, running, each of `frequency-out-of-band`, `capture-too-narrow`, `no-channel-selected`,
  an unknown reason and an unknown state.
- In `web/mock/server.ts`: switches answering Activity GETs with 429 and `Retry-After: 1`,
  `Retry-After: 30`, an HTTP date, and a malformed value.

## Test plan

- Req 1.1/1.2: property and unit tests on `placeDiscoveryTags` and a new `clusterDiscoveries`
  in `web/tests/plot/` (cases: 18/19/20 px gaps, the 0-77 px chain, zero width, empty view);
  component tests for the popover and the marker confirm (no tuner call on cancel);
  `docs:shots` refresh.
- Req 1.3/1.4: table test of the next-step formatter over every row and unknown strings; core
  projection tests for source mismatch, channel edge (half width, +1 Hz), running vs suspended
  precedence, missing figures (absent), 3 and 4 covering decoders (3 kept), a 65-char id;
  route schema tests that absent and `[]` survive serialization; old-client test that a
  pre-change `Discovery` parse ignores `coverage`.
- Req 2: `api-client` tests with a scripted fetch: seconds, date, past date, malformed,
  absent header, `d` = 10 000 (retries) and 10 001 (surfaces), 4th 429 surfaces, abort mid-wait.
- Req 3: alias tests after merge, chained merge, eviction at 16 384/16 385, recording alias
  release, restart; route tests for 200 + `absorbedInto`, 404 unknown and evicted; service
  tests for 1, 16, 256 groups (merged events) and 257 (one resync), `mergedIds` of 64 (no
  flag) and 65 (64 + `mergedTruncated`); web store tests that a resync event triggers a
  refetch and that an old store ignores it.
- Req 4: `node scripts/check-docs.mjs`; `grep -n "WG[0-9]" docs/API.md docs/ROADMAP.md` empty.
