# Web gaps 2 design (WG2)

Status: reviewed design, contract frozen; not implemented (2026-10-13). Requirements in
[requirements](requirements.md), tasks in [tasks](tasks.md). Background: the envelope spec
([decode envelope](../decode-envelope/requirements.md) 4.1–4.6), WG1
([design](../web-gaps-1/design.md): coalescing, vessels, transmissions) and the access spec
amendment ([core access policy](../core-access-policy/requirements.md) 4.9–4.12).

## Contract (frozen)

| File                                                                          | Addition                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/aprs.ts` (new, exported)                              | `AprsEntityKind`, `AprsPosition`, `AprsWeather`, `AprsStation`, `AprsTrackerStats`, `AprsStationListResponse`, `AprsStationNotFoundResponse`, `AprsLostEventData`, `AprsServerMessage`                                                                            |
| `packages/api-types/src/mesh.ts` (new, exported)                              | `MeshPosition`, `MeshNode`, `MeshTrackerStats`, `MeshNodeListResponse`, `MeshNodeNotFoundResponse`, `MeshLostEventData`, `MeshServerMessage`                                                                                                                      |
| `packages/api-types/src/live-audio.ts`                                        | `AnalogTransmissionTone`; `AnalogTransmissionEventData.tone?`                                                                                                                                                                                                     |
| `packages/api-types/src/activity.ts`, `src/core/activity/storage/contract.ts` | `AnalogTransmissionPayload.tone?` (identical copies)                                                                                                                                                                                                              |
| `packages/api-types/src/digital-voice.ts`, `src/core/digital-voice.ts`        | `DigitalVoiceCall` optional `colourCode`, `nac`, `algorithmId`, `keyId`, `ran`, `errors`; `DsdFmeVoiceCallState` (in `dsd-fme.ts`) the same optional fields                                                                                                       |
| `packages/api-types/src/access-devices.ts`                                    | `ACCESS_DEVICE_KINDS`, `ACCESS_DEVICES_LIMITS.nameMaxLength`/`lastSeenResolutionMs`, optional `name`/`kind`/`lastSeenAt` on `accessDeviceDtoSchema`, `accessDeviceLabelRequestSchema`, `AccessDeviceLabelRequest`, `AccessDeviceLabelResponse`                    |
| `packages/api-types/src/scanner.ts`                                           | `LockoutExclusion`; `PlanPreview.lockoutExclusions?`, `ScanJob.lockoutExclusions?`; `ScanJobHit`, `ScanJobHitStats`, `ScanJobProgress.hitStats?`, `ScannerProgressEventData.hits?`/`newDiscoveries?`, `ScannerDiscoveryEventData.jobHits?`, `ScanJobHitsResponse` |
| `src/decoders/builtin/direwolf.ts`                                            | `APRSData` optional `objectName`, `objectKind`, `objectKilled` (types only; lane R parses)                                                                                                                                                                        |
| `src/api/websocket/events.ts`                                                 | channels `aprs`, `mesh`; `AprsServerMessage`, `MeshServerMessage` in `ServerMessage`; `broadcastAprs{New,Update,Lost,Stats}`, `broadcastMesh{New,Update,Lost,Stats}` (unwired)                                                                                    |

`tests/unit/core/wg2-contract-compat.test.ts` asserts the copied types are identical and the
access schemas accept old and new device rows. Every addition is optional, new, or a new
union member.

## Activity presentation (lane P)

**Module.** `src/core/activity/presentation/registry.ts` (entry, no `index.ts`) exports
`presentDecoderOutput(output: DecoderOutput, decoderType: string | undefined):
DecodePresentation | undefined`, a pure function. One mapper per family in the same
directory (`aircraft.ts`, `ship.ts`, `aprs.ts`, `meshtastic.ts`, `pager.ts`,
`digital-voice.ts`, `acars-vdl2.ts`, `sensor.ts`, plus `budget.ts` for truncation and
field-count rules). Each mapper parses its payload with a Zod schema (`safeParse`, unknown
keys allowed) and returns undefined on failure. Mappers `import type` adapter payload types
only; they never import adapter modules or other lanes' new modules.

**Ingress.** `activity/ingress.ts` computes the presentation inside `try`, builds the
envelope with it, and on any build failure with a presentation rebuilds once without it
(`presentationFailures++`, rate-limited warning as today). Only a failure of the
presentation-free build counts as `buildFailures` (1.7).

**Entity keys (1.3).** Exact formats; `value` must match `[^:]+`, at most 128 bytes total.

| Output (`type`, condition)                               | Category        | Protocol                     | entityKey                                           | Position              | Title (≤ 80 chars)               |
| -------------------------------------------------------- | --------------- | ---------------------------- | --------------------------------------------------- | --------------------- | -------------------------------- |
| `aircraft` (`icao` or `hex`, 6 hex digits, no `~`)       | `aircraft`      | `adsb`                       | `icao:<UPPER 6 hex>`                                | `lat`/`lon`           | callsign/flight, else ICAO       |
| `ship` (`mmsi` 1–9 digits)                               | `marine`        | `ais`                        | `mmsi:<9 digits, zero-padded>`                      | `lat`/`lon`           | name, else MMSI                  |
| `aprs`, station packet                                   | `aprs`          | `aprs`                       | `callsign:<UPPER CALL[-SSID]>` (`-0` omitted)       | position packets      | callsign + data type             |
| `aprs`, object/item (`objectName`)                       | `aprs`          | `aprs`                       | `aprs-object:<name>` / `aprs-item:<name>` (trimmed) | when present          | name + "object"/"item"           |
| `meshtastic` (`from` uint32)                             | `mesh`          | `meshtastic`                 | `node:!<8 lowercase hex>`                           | none (needs protobuf) | node id + port name              |
| `message`/`decode` with `protocol` POCSAG\*/FLEX         | `paging`        | `pocsag` / `flex`            | `capcode:<decimal, no leading zeros>`               | none                  | protocol, capcode, message start |
| `message` EAS, `decode` DTMF/FSK9600                     | `other`         | `eas` / `dtmf` / `fsk9600`   | null                                                | none                  | protocol                         |
| `decode` AFSK1200 (`from` a valid callsign)              | `aprs`          | `afsk1200`                   | `callsign:<UPPER>`                                  | none                  | from → to                        |
| `call_start`/`call_end`/`call` (`talkgroup` integer ≥ 0) | `voice`         | data `protocol` (e.g. `dmr`) | `talkgroup:<tg>`                                    | none                  | `DMR TG 2081 from 3120001`       |
| `acars`                                                  | `aviation-data` | `acars`                      | `reg:<UPPER tail, dots removed>` when tail          | none                  | tail/flight + label              |
| `vdl2`                                                   | `aviation-data` | `vdl2`                       | `icao:<UPPER 6 hex>` when `icao`, else ACARS tail   | none                  | icao/tail + msgType              |
| `signal` with string `model` (rtl_433)                   | `sensors`       | `rtl_433`                    | `sensor:<model>-<id>[-<channel>]` (spaces → `_`)    | none                  | model + id                       |
| anything else                                            | (none)          |                              |                                                     |                       |                                  |

Decision: the digital call key is `talkgroup:<tg>`, not the envelope spec's
`talkgroup-radio:7+42` example (the web pivots on the talkgroup; the radio is a field and an
FTS term). `node:` uses Meshtastic's `!xxxxxxxx` form. Keys of different protocols can share
a namespace (`capcode:` POCSAG and FLEX, `talkgroup:` DMR and P25); clients combine the
entity filter with the protocol filter. The APRS and mesh tracker keys are these strings.

**Fields.** Per type a fixed ordered allowlist of payload keys with labels and units
(aircraft: callsign, squawk, altitude `ft`, ground speed `kt`, track `deg`, vertical rate
`ft/min`; ship: name, callsign, navStatus, sog `kn`, cog `deg`, shipType; APRS: dataType,
symbol, comment or status, course `deg`, speed `kn`; pager: message, function, messageType;
voice: talkgroup, source (radio), slot, encrypted, duration as given, colour code/NAC;
ACARS/VDL2: flight, label, text; rtl_433: temperature_C `°C`, humidity `%`, battery_ok,
channel; mesh: port, to, hops, rxSnr `dB`, rxRssi `dBm`). Only values present in the payload
appear, at most 6 (1.5); no field duplicates the title. Coalescible-shaped receptions
(1.6) carry none.

**Arithmetic (1.8), measured on main @27424340 with `buildActivityRow`.** A position-only
ADS-B reception (ICAO, altitude, lat, lon, lastSeen, messageCount) builds 979 bytes of row
JSON+FTS today; with its 1.6 presentation (category, protocol, key, title, position, no
fields) 1,113 bytes (+134, +14 %). A full SBS reception with 6 fields grows from 1,095 to
2,059 bytes (+964); an APRS position with 5 fields from 1,236 to 2,047 (+811). On a busy
ADS-B station (300 aircraft, one stored row per aircraft per minute after WG1 coalescing,
about 432,000 candidate rows/day) the 250,000-row cap is reached in about 14 h either way;
most stored rows are position-only, so the mean row grows about 15–25 %, and when the
256 MiB byte cap binds first (SQLite page, index and FTS overhead are not measured here)
retention shortens by at most that fraction. Lane P measures on-disk bytes per row with and
without presentation on 5,000 fixture rows through an inline store and reports both;
Main documents the result in `docs/API.md`.

**Failure paths.** Mapper throws or Zod failure → no presentation; presentation rejected by
the envelope schema (bad key, oversize, control characters) → rebuild without it; a
presentation that pushes the envelope past `MAX_ENVELOPE_BYTES` → rebuild without it; the
summary builder already drops fields, then title, then position to fit 4 KiB. Stored rows:
`parseStoredSummary` treats an invalid stored key or position as today (null / omitted); a
pre-WG2 row has no presentation and parses.

## Coalescing of APRS and mesh positions (lane P)

`storage/coalesce.ts` gains two `CoalesceSpec`s keyed by output type, exactly the
allowlists of requirement 2: `aprs` (entity `source`, identity `symbol`, `comment`,
eligible when `dataType` is in the six position types and `lat`/`lon` are finite numbers)
and `meshtastic` (entity `from`, no identity, eligible when `portnum === 3`). The rollback
and bound logic is unchanged and shared.

**Arithmetic.** APRS, busy metro, about 3,000 packets/h = 72,000 rows/day today. Assume 60 %
are position packets and 45 % of those are digipeated or fast-beacon repeats within 60 s of a
stored one: about 19,000 fewer rows, about 53,000 rows/day. Mesh, 100 nodes, flood relays
heard about 3× per packet: positions 100 × 4/h × 3 = 1,200/h, node info 100/h, telemetry
600/h, about 45,000 rows/day today; relay copies of positions collapse to about 400/h, about
26,000 rows/day. Neither changes the WG1 row cap arithmetic materially next to ADS-B.

## APRS tracker (lane R)

`src/core/aprs-tracker.ts`: `AprsTracker extends EventEmitter<{ "aprs:new": [AprsStation];
"aprs:update": [AprsStation]; "aprs:lost": [string, AprsStation]; "stats:update":
[AprsTrackerStats] }>`, config `{ maxAgeMs = 7_200_000, cleanupIntervalMs = 30_000,
maxStations = 2000, statsIntervalMs = 5000, duplicateWindowMs = 30_000, maxDuplicateKeys =
4096 }`, `start()`, `stop()` (idempotent, timers `unref()`), `processAprs(decoderId, data:
unknown, at?: Date)`, `getAll()` (lastSeen desc), `get(key)`, `getStats()`, injectable
`now`. Duplicate key `${source}>${destination}:${raw}`, remembered for 30 s (bounded,
oldest dropped). Objects/items are keyed by name; `callsign` is the reporting station.
Manager `src/core/aprs-tracking-manager.ts` like `VesselTrackingManager` (`type === "aprs"`).
Routes `src/api/routes/aprs.ts`: `aprsRoutes(app, { tracker })`, three GETs with response
JSON schemas (nullable types), tag `aprs`; key grammar
`^(callsign:[A-Z0-9]{1,6}(-[0-9]{1,2})?|aprs-(object|item):[^:\u0000-\u001f]{1,9})$`.
Parsing (direwolf): object `;NAME_____*DDHHMMz<pos>` (`*` live, `_` killed, 9-char name),
item `)NAME!<pos>` or `)NAME_<pos>` (3–9 chars); position via the existing parsers.

## Mesh tracker (lane N)

`src/core/meshtastic-protobuf.ts`: `readPosition(bytes): MeshPositionFields | null`,
`readUser(bytes): MeshUserFields | null`, over a bounded reader (varint ≤ 10 bytes,
length-delimited ≤ remaining, no recursion, max 64 fields per message). `src/core/mesh-tracker.ts`:
`MeshTracker` like `AprsTracker` with `processPacket(decoderId, data: unknown, at?)`, config
`{ maxAgeMs = 14_400_000, maxNodes = 1000, duplicateWindowMs = 60_000, maxDuplicateKeys =
4096, cleanupIntervalMs = 30_000, statsIntervalMs = 5000 }`. Manager
`mesh-tracking-manager.ts` (`type === "meshtastic"`), routes `src/api/routes/mesh.ts`
(`meshRoutes`). Test encoder `tests/mocks/fixtures/meshtastic/encode.ts` builds Position,
User and packet fixtures (no downloads).

## Tones (lane T)

`src/core/audio-tones/ctcss.ts`, `dtmf.ts` (Goertzel banks, pure, sample-rate aware: input
is decimated to 8 kHz by block averaging), `tone-detector.ts` (`ToneDetector`:
`push(pcm: Buffer, format: { rate: number; format: "s16le" | "f32le" })`, `result():
AnalogTransmissionTone`, `reset()`). `LiveDemodulator` emits `pcm` (chunk, format) from
`handleAudioData` only when a listener exists (audio path unchanged). The tracker attaches a
`pcm` listener while a transmission is open, feeds one detector, and puts `tone` on the
closed event and payload. `row.ts` accepts `TRANSMISSION_KEYS` with or without `tone`,
validates `tone` strictly (`ctcssHz` null or one of the 50 tones; `dtmf` null or 1–32 of
`[0-9*#A-D]`), and adds the fields and FTS terms. CPU: 50 + 8 Goertzel lines at 8 kHz, about
0.9 M multiply-adds/s, only during transmissions.

## AIS checksum and throttle (lane X)

`ais-catcher.ts`: `nmeaChecksumValid(sentence)` (XOR of the characters between `!` and
`*`, two upper-case hex digits) checked before the fragment buffer; failures increment
`stats.errors` and `checksumErrors`. Fixtures regenerated with `tests/mocks/fixtures/ais/encode.ts`.

`src/core/entity-update-throttle.ts`:

```ts
export interface EntityUpdateThrottleOptions<T> {
	windowMs: number
	identity: (state: T) => string
	emit: (key: string, state: T) => void
	now?: () => number
	maxKeys?: number // default 10_000; beyond it, offers pass through unthrottled
}
export class EntityUpdateThrottle<T> {
	offer(key: string, state: T): void
	clear(key: string): void
	stop(): void
	size(): number
}
```

Leading edge: a key with no emission in the last window emits now. Otherwise the state is
kept as pending and one timer (unref'd) flushes it at the window end. A different identity
emits now and drops the pending state. Emit callbacks never throw into the caller (caught
and counted). Identity functions (Main): vessels `name|callsign|navStatus|shipType|destination`;
APRS `kind|symbol|comment|status|killed`; mesh `longName|shortName|role|hwModel`.

**Arithmetic.** Busy port, 200 vessels, half underway reporting every 2–10 s, half anchored
every 3 min: about 17 updates/s. A 2 s window only limits class A movers reporting every
2 s (above 23 kn), a 10–15 % cut; it bounds bursts (a vessel's static and position messages
arriving together), not volume. APRS and mesh stay under 1 update/s.

Digital call metadata: `dsd-fme.ts` copies `dmr.cc`, `p25.nac`, `p25.alg`, `p25.keyId`,
`nxdn.ran` and `quality.crcErrs/fecErrs` into the voice-call state; `digital-voice.ts`
validates (extended `VoiceCallStateSchema`) and maps them.

## Devices (lane D)

Specified by [core access policy](../core-access-policy/design.md) "Device names, kinds and
coarse last-seen (WG2)". Lane D owns `src/access/**` for it.

## Main track

**Ignore skips sweeps (12).** `ScannerService` derives `LockoutExclusion`s from locked
discoveries per source and passes them with `spec.exclusions` to the hop planner and the
plan preview (`lockoutExclusions` on the preview and the job DTO). A lockout PATCH triggers
the same replan path as a live exclusion edit. The 1 kHz floor and 256 cap bound the planner
input; the "never empty" rule is checked on the candidate plan before it replaces the old.

**Hit statistics (13).** A per-job `Map<discoveryId, ScanJobHit>` in `ScannerService`,
updated where an observation is attributed to a job, reset on job start, dropped on delete;
`jobHits` on the discovery event and `hitStats` on progress; route
`GET /api/scanner/jobs/:id/hits`.

**Wiring.** After the lanes: `index.ts` constructs `AprsTrackingManager` and
`MeshTrackingManager` like the vessel manager; `server.ts` registers `aprsRoutes` and
`meshRoutes`, forwards tracker events to the new broadcast methods, and puts
`vessel:update`, `aprs:update` and `mesh:update` through one `EntityUpdateThrottle` each
(2 s), clearing a key on lost and stopping them on close.

## Correctness properties

Property 1: Presentation never loses a reception. For any decoder output (any type, any
JSON-like data), `presentDecoderOutput` never throws, and the ingress always yields a valid
envelope equal to the presentation-free one except for presentation fields. Validates: 1.1,
1.2, 1.7.

Property 2: Entity key canonical form. For generated valid payloads of each table row, the
key matches the row's format, is identical for inputs that differ only in case, SSID `-0` or
zero padding, and is null for invalid identifiers. Validates: 1.3.

Property 3: Presentation budget. For any payload, fields ≤ 6, title ≤ 80 characters, string
values within 1.5, position only when valid, and built-row growth within 1.8. Validates:
1.4–1.6, 1.8.

Property 4: APRS and mesh coalescing. For any timeline of APRS and mesh receptions over a
few entities, a reception is stored exactly when the WG1 rule with requirement 2's
allowlists says so, failed writes roll back as in WG1 7.9, and the entity bound holds.
Validates: 2.1–2.4.

Property 5: APRS merge and dedupe. For any packet sequence, each station's fields equal the
last valid value reported, duplicates within 30 s change nothing but the counts, killed
objects are gone. Validates: 3.3–3.5.

Property 6: Tracker expiry and cap (APRS and mesh). For any timeline, the trackers never
exceed their caps, remove exactly the entities older than `maxAgeMs` per sweep and emit one
lost event per removal. Validates: 3.6, 5.7.

Property 7: Protobuf round trip and robustness. For any Position and User values in range,
encode then read returns them; for any byte string, the readers return a value or null and
never throw. Validates: 5.2, 5.3.

Property 8: Mesh merge and flood copies. For any packet sequence, copies of a `(from, id)`
within 60 s change only `duplicateCopies`, and `hopsAway` follows 5.6. Validates: 5.4–5.6.

Property 9: CTCSS detection. For any standard tone, level and white-noise SNR ≥ 10 dB over
at least 1 s, the detector reports exactly that tone; for noise or voice-band (300–3000 Hz)
signals alone, null. Validates: 7.2.

Property 10: DTMF detection. For any digit string up to 32 symbols with ≥ 50 ms on and off
times, the detector returns the string; for noise or a single sine, null. Validates: 7.3.

Property 11: Transmission row with tone. For any valid payload with or without `tone`,
build then parse round-trips with the 7.5 fields; a payload with an invalid `tone` is
corrupt. Validates: 7.4, 7.5.

Property 12: NMEA checksum. For any encoder-generated sentence, it is accepted exactly when
its checksum is right; any single changed character between `!` and `*` rejects it.
Validates: 8.1.

Property 13: Throttle. For any offer timeline, per key: non-identity emissions are at least
`windowMs` apart, an identity change is emitted at once, the latest offered state is emitted
within `windowMs` of the last offer unless cleared, no state is emitted after a newer one,
and nothing is emitted after `clear` or `stop`. Validates: 9.1–9.3.

Property 14: Device last-seen. For any admission timeline, `lastSeenAt` is hour-aligned and
non-decreasing, at most one last-seen commit per device per hour happens, and a failed
commit leaves the committed snapshot unchanged. Validates: 11.3, 11.6.

Property 15: Lockout exclusions. For any discoveries, lockouts and ranges, applied
exclusions are ≤ 256, cover each applied locked centre, never empty a non-empty plan, and the
stored job spec is unchanged. Validates: 12.1–12.4.

Property 16: Hit counts. For any attribution sequence, each tracked discovery's `hits`
equals its observations in the job, `hitStats.hits` equals the total, and tracked
discoveries ≤ 2,000. Validates: 13.1, 13.4.
