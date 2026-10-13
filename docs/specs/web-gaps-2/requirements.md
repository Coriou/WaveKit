# Web gaps 2 requirements (WG2)

Status: implemented on the WG2 batch (2026-10-13); final checkpoint pending. See [design](design.md)
and [tasks](tasks.md).

## Scope

The second batch of core features the planned web dashboard needs: presentation on stored
Activity rows (category, protocol, entity key, title, fields, position), current-state
trackers for APRS stations and Meshtastic nodes, CTCSS and DTMF on analog transmissions,
strict AIS NMEA checksums, a per-entity update throttle for map channels, digital call
metadata on the `digital-voice` channel, operator-set device names and kinds with a coarse
last-seen time, scanner lockouts that also skip sweeps, and per-job scanner hit statistics.

Out of scope: CLI and web UI changes (the CLI gets a coordination note only); DCS, tone
squelch, talker alias, `fftSize` above 2048; position history and trails; Meshtastic
telemetry, links and neighbour info; passive device recovery; backfilling presentation onto
rows stored before WG2; any new config key; any scanner default other than requirement 12
(user-approved); the access default (stays `legacy`); Activity defaults (unchanged); the
channelizer (stays off) and S2 (stays disabled); the files pinned by the band-plans spec
(`src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`,
`src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`) and both
isolation hash tables; new npm dependencies.

## 1. Activity presentation

As a web user I want Activity rows with a category, a protocol, a title, an entity I can
pivot on and a map position, instead of `other` with nothing to show.

1.1 The Activity ingress shall pass a presentation built from the decoder output to the
envelope for every built-in output type of the design's entity-key table; any other output
type gets no presentation (today's defaults).
1.2 Presentation shall be derived only from the output's own validated payload (Zod at the
boundary, per type). It never infers protocol, frequency or position from RF context, and
never converts units: altitude in feet stays a field in feet, and `position.altM` is omitted.
1.3 `entityKey` shall follow the design's table exactly (formats, case, SSID handling) and
be null when the payload lacks a valid identifier. A key that would not pass the envelope's
key rule (`kind:value`, value without `:`, at most 128 bytes, no control characters) is null.
1.4 `position` shall be set only when the payload has finite latitude in [-90, 90] and
longitude in [-180, 180], for the types the table names (aircraft, ship, APRS position
packets); never for (0, 0) exactly.
1.5 Budget: at most 6 fields; title at most 80 characters; labels at most 24 characters;
string field values at most 64 bytes (pager message, APRS comment/status/message text and
ACARS text at most 256 bytes), truncated on a UTF-8 boundary with a trailing `…`.
1.6 A reception whose fields are all on its type's coalescing allowlist (requirement 2 and
WG1 7.6: position, kinematics, presence) shall carry title, entity key, position, category
and protocol but no fields.
1.7 A presentation that fails, throws, or makes the envelope invalid shall never lose the
reception: the ingress builds the envelope again without presentation and counts
`presentationFailures`. Presentation never changes `decodedData`.
1.8 Built-row growth (summary JSON + record JSON + FTS text) from presentation shall be at
most 160 bytes for a reception per 1.6 and at most 1,100 bytes for any reception.
1.9 Rows stored before WG2 keep category `other` and no entity key; no migration or
backfill runs, and both old and new rows parse.

## 2. Coalescing of APRS and Meshtastic positions in Activity

2.1 (Decision, extends WG1 7.6.) An `aprs` output shall be coalescible per source callsign
(`source`) and decoder, at most one stored redundant update per 60 s, only when its
`dataType` is one of `Position`, `Position with messaging`, `Position with timestamp`,
`Position with timestamp and messaging`, `Mic-E`, `Mic-E (old)`, it has finite `lat` and
`lon`, and every field it carries is on the allowlist `source`, `destination`, `path`,
`dataType`, `lat`, `lon`, `altitude`, `course`, `speed`, `raw`, `timestamp`, or is an
identity field (`symbol`, `comment`) with an unchanged value.
2.2 A `meshtastic` output shall be coalescible per `from` node and decoder only when
`portnum` is 3 (POSITION_APP) and every field it carries is on the allowlist `from`, `to`,
`id`, `channel`, `hopLimit`, `hopStart`, `wantAck`, `viaMqtt`, `priority`, `portnum`,
`payloadB64`, `payloadLen`, `rxRssi`, `rxSnr`, `rxTime`, `frequency`, `bw`, `sf`, `cr`.
Mesh positions have no identity fields.
2.3 Every other APRS data type (objects, items, messages, status, weather, telemetry,
queries, third-party, unknown), any APRS packet carrying `weather` or `message`, and every
other Meshtastic port (text, node info, telemetry, routing, ...) shall always be stored.
2.4 WG1 7.7 and 7.9 apply unchanged: first sightings and identity changes store; coalesced
receptions count in `coalescedPositions`, are not losses and open no ingestion gap; a failed
write or batch rolls the entity's state back newest first; a timed-out write keeps it; the
entity map stays bounded at `positionCoalesceMaxEntities` shared by all types.

## 3. APRS station tracker

As a web user I want the current state of every APRS station, object and item heard, like
the aircraft and vessel lists.

3.1 An APRS tracker shall consume `decoder:output` events of type `aprs`, validate the data
at the boundary and key entities by the design's key (`callsign:<CALL-SSID>`,
`aprs-object:<name>`, `aprs-item:<name>`), equal to the Activity entity key.
3.2 The direwolf adapter shall parse object (`;`) and item (`)`) reports: name, live or
killed, and the position, symbol and comment that follow, into new optional `APRSData`
fields; every existing field and packet shape is unchanged.
3.3 A report shall never clear a field it does not carry; position `at` is the report time.
Status packets (`>`) set `status`; weather reports set `weather`.
3.4 A copy of a packet already heard (same source, destination and information field)
within 30 s shall count in `digipeatedCopies` and the stats, update nothing else and emit
nothing.
3.5 A killed object or item shall be removed at once and reported lost with `killed: true`.
3.6 An entity not heard for 2 h shall be removed and reported lost; the tracker holds at most
2,000 entities, evicting the least recently heard (also reported lost).
3.7 The tracker shall report stats: counts by kind, with position, packets processed,
duplicates, invalid packets, packets per second (rolling 60 s), last packet time, latest key,
expired total.
3.8 Invalid data is counted and dropped, never thrown; tracker defaults live in the tracker
(no config key).
3.9 The direwolf `speed` doc comment shall state knots (APRS course/speed extension and
Mic-E); values are not converted.

## 4. APRS API and channel

4.1 `GET /api/aprs/stations` shall return `AprsStationListResponse`, most recently heard
first; `GET /api/aprs/stats` `AprsTrackerStats`; `GET /api/aprs/stations/:key` the entity,
404 `APRS_STATION_NOT_FOUND` when unknown, 400 `VALIDATION_ERROR` for a key outside the
design's key grammar.
4.2 The `aprs` WS channel shall carry `aprs:new`, `aprs:update`, `aprs:lost` and `aprs:stats`
(every 5 s while the tracker runs); updates pass the entity update throttle (requirement 9).
4.3 Routes and channel exist whenever the tracker is constructed (always) and follow the
access policy like the aircraft routes.

## 5. Meshtastic node tracker

5.1 A mesh tracker shall consume `decoder:output` events of type `meshtastic`, validate the
packet and key nodes by `from` as `!%08x` (lowercase); its key `node:!xxxxxxxx` equals the
Activity entity key.
5.2 A hand-written protobuf reader (no new dependency) shall decode `Position` (port 3:
`latitude_i`, `longitude_i` ×1e-7, `altitude` metres, `time`) and `User` (port 4: `id`,
`long_name`, `short_name`, `hw_model`, `is_licensed`, `role`) from `payloadB64`; unknown
fields are skipped by wire type.
5.3 Malformed protobuf (truncated, bad varint over 10 bytes, length past the end, wrong wire
type for a known field, nesting) shall return null and count `decodeErrors`, never throw.
5.4 A `User` whose `id` differs from the packet's `from` shall not rename the node (counted).
Latitude/longitude out of range or both 0 are ignored.
5.5 A copy of the same `(from, id)` packet within 60 s (flood relay) shall count in
`duplicateCopies`, update nothing else and emit nothing.
5.6 `hopsAway` = `hopStart − hopLimit` when `hopStart` > 0 and ≥ `hopLimit`, else null;
`snrDb`/`rssiDbm` from the packet, null when the wrapper reports 0.
5.7 A node not heard for 4 h (NODEINFO is broadcast every 3 h) is removed and reported lost; at most 1,000 nodes, evicting the
least recently heard (reported lost). Per-node `portnums` counts are bounded to 64 keys.
5.8 Stats: node counts, with position, with name, packets, duplicates, invalid packets,
decode errors, packets per second (rolling 60 s), last packet time, latest node, expired.

## 6. Mesh API and channel

6.1 `GET /api/mesh/nodes` (`MeshNodeListResponse`, most recently heard first),
`GET /api/mesh/stats`, `GET /api/mesh/nodes/:nodeId` (404 `MESH_NODE_NOT_FOUND`, 400
`VALIDATION_ERROR` unless `!` plus 8 hex digits, case-insensitive).
6.2 The `mesh` WS channel carries `mesh:new`, `mesh:update`, `mesh:lost`, `mesh:stats`
(every 5 s); updates pass the entity update throttle.
6.3 Routes and channel exist always and follow the access policy like aircraft.

## 7. CTCSS and DTMF on analog transmissions

As a web user I want to see the sub-audible tone and any DTMF digits of each transmission.

7.1 (Decision.) While a transmission is open, the tracker shall analyse the live
demodulator's output PCM for CTCSS and DTMF. On by default, without a config key; nothing
runs while no transmission is open.
7.2 CTCSS: the 50 standard EIA/TIA-603 tones 67.0–254.1 Hz. A tone is reported only after at
least 2 consecutive analysis blocks (500 ms each, 250 ms hop) agree, with the block's tone
power at least 0.65 of the 50–300 Hz band power and at least 3× the next-best tone.
`ctcssHz` is the tone that won the most blocks, null when none qualified.
7.3 DTMF: the 16 symbols `0-9*#A-D`; a digit needs one row and one column tone dominant for
at least 40 ms, twist within +4/−8 dB, and is repeated only after at least 40 ms of absence.
`dtmf` is the digit string, at most 32 symbols (later digits dropped), null when none.
7.4 Each closed `live-audio:transmission` event and `AnalogTransmissionPayload` shall carry
`tone: { ctcssHz, dtmf }`; open events carry none. A transmission that closes before 750 ms
of audio has `ctcssHz: null`.
7.5 Stored `analog-transmission` rows with `tone` shall add fields `ctcssHz` (unit Hz) and
`dtmf` when non-null, and FTS terms; rows stored before WG2 without `tone` still parse; a
row with a malformed `tone` is corrupt.
7.6 Audio output bytes, level events and squelch behaviour shall be unchanged; the PCM tap
costs nothing without a listener.
7.7 (WG1 n2.) A config change between an absent `sourceId` and an explicit default
`sourceId` that resolve to the same source shall not close a transmission as `config`.

## 8. AIS checksum

8.1 The AIS-catcher NMEA path shall verify the XOR checksum of every sentence and drop
sentences with a missing or wrong checksum, counted in `stats.errors` and a
`checksumErrors` counter on the adapter. The JSON path is unchanged.
8.2 Fixtures with invalid checksums shall be regenerated by the test encoder; a fragment
group with one bad sentence is dropped as a whole.

## 9. Entity update throttle

9.1 A reusable per-key throttle shall emit the first update of a key at once, then at most
one update per key per window, the latest state flushed at the window's end.
9.2 An update whose identity (supplied by the caller) differs from the last emitted one
shall be emitted at once and supersede any pending update.
9.3 `clear(key)` (on lost) drops the pending update; nothing for that key is emitted until a
new offer. `stop()` cancels every timer and emits nothing further.
9.4 (Decision.) Main applies it with a 2 s window to `vessel:update`, `aprs:update` and
`mesh:update`; `*:new` and `*:lost` are never throttled and per-key order is preserved
(new, then updates, then lost). Aircraft are not throttled.

## 10. Digital call metadata

10.1 `DigitalVoiceCall` (REST status and `digital-voice:call`) shall carry, when known:
`colourCode` (DMR), `nac` (P25, upper-case hex), `algorithmId` and `keyId` (hex, encrypted
calls), `ran` (NXDN) and `errors { crc, fec }` (counts so far). Absent when unknown.
10.2 Values come from the decoder's existing call state; no new parsing of dsd-fme output.
Talker alias is out of scope.

## 11. Device names, kinds and coarse last-seen (access amendment)

11.1 Each remembered device shall have an optional operator-set `name` (1–64 characters
with no leading or trailing whitespace, at most 128 bytes, no control or bidirectional-override characters) and
`kind` (`browser`, `phone`, `tablet`, `desktop`, `cli`, `other`), never derived from a user
agent, address or any fingerprint.
11.2 `POST /api/access/devices/label` with `{ deviceId, name?, kind? }` (at least one;
null clears) shall update a remembered device under the existing session mutation rules
(CSRF, Origin, queue, persist before acknowledging) and return `{ updated: boolean }`.
11.3 `lastSeenAt` shall be the start of the UTC hour of the device's latest authenticated
admission, persisted at most once per device per hour, through the mutation queue, never on
the device-inventory read itself; a failed persistence leaves the committed state unchanged
and never fails the request that caused it.
11.4 Device DTOs (session and machine inventories) shall carry `name`, `kind` and
`lastSeenAt` (null when unset); the machine routes cannot label.
11.5 The private session snapshot shall migrate from version 1 to 2 (absent fields null);
an older WaveKit refuses a version 2 file and fails closed as for any invalid file.
11.6 Bounds: 32 devices × 24 writes/day at most 768 last-seen writes per day; the state file
stays under its 64 KiB cap.

## 12. Ignore also skips sweeps (D2, user-approved default change)

12.1 A discovery with `operator.lockout` shall add an exclusion of
`[centre − w/2, centre + w/2]` (w = max(occupied bandwidth, raster step, 1 kHz)) to every
sweep job on a source in the discovery's `sourceIds`, at the job's next replan.
12.2 Lockout exclusions are runtime only: never written into the job spec or stored jobs,
visible as `lockoutExclusions` on the plan preview and the job DTO with `applied`.
12.3 At most 256 lockout exclusions apply per job (lowest frequency first inside the job's
ranges); the rest are listed with `applied: false`.
12.4 Lockouts shall never empty a plan: when applying them would leave no hop, none is
applied and all are listed with `applied: false`.
12.5 Clearing a lockout removes its exclusion at the next replan. Probe, recording and
monitor gating by lockout is unchanged.

## 13. Per-job scanner hit statistics

13.1 A running job shall count, per discovery, the observations attributed to it ("hits"),
with first and last hit time and whether the discovery was first seen in this job.
13.2 `scanner:discovery` events caused by a job's observation shall carry `jobHits`;
`scanner:progress` and `ScanJobProgress` carry `hitStats`.
13.3 `GET /api/scanner/jobs/:id/hits?limit=n` (1–500, default 100) shall return the hits,
most recent first.
13.4 Per job at most 2,000 discoveries are tracked (further hits counted in `hits` only,
`truncated: true`); the counts reset when a job starts (not on resume) and are dropped when
the job is deleted; in memory only, empty after a restart.
13.5 Hit statistics are best-effort. An observation counts once per job: the job remembers
the last 4,096 observations it credited, and dedupe is exact until that memory first evicts
one. From then on a re-placed evicted observation may count again, and the job's stats carry
`truncated: true`.

## 14. Compatibility and gates

14.1 All DTO additions are optional fields, new types, new channels or new message types; no
existing field changes meaning.
14.2 Scanner defaults (except 12), the production binding, the access default, Activity
defaults, the channelizer and S2 are unchanged; the pinned band-plan files and isolation
tables are unchanged; no new npm dependency.

## 15. Documentation

15.1 `docs/API.md` (Activity presentation and entity keys, APRS and mesh routes and
channels, transmission `tone`, AIS checksum, throttle, digital call fields, device label
route, lockout exclusions, hit statistics), `docs/SCANNER.md` (12, 13), `docs/ROADMAP.md` and
an append to `docs/CLI-COORDINATION.md` shall describe the changes.
