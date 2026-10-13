# Web gaps 1 design (WG1)

Status: implemented (2026-10-13); M.5 checkpoint open. Requirements in
[requirements](requirements.md), tasks in [tasks](tasks.md). Background: `docs/SCANNER.md`
(spectrum channel and profiles), the activity spec
([event foundation](../activity-recording-catalog/requirements.md)) and
`src/core/aircraft-tracker.ts`.

## Contract (frozen)

| File                                                                                      | Addition                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/spectrum.ts`                                                      | `SpectrumSubscribeOptions.averaging`, `backfillMs`; `SpectrumFrameEventData.backfill`; `SpectrumProfileView.averaging`; `SpectrumProfileAdjustment` `averaging`, `backfillMs`; `SpectrumProfileEventData.backfillFrames`; `SpectrumLimits.averaging`, `backfill` |
| `src/core/spectrum/subscribe-options.ts` (new; re-exported by `spectrum-service.ts`)      | `PROFILE_LIMITS` (moved, plus `averaging` 1–32), `BACKFILL_LIMITS` (10000 ms, 64 frames, 512 KiB), `SpectrumSubscribeOptionsSchema` with `averaging` and `backfillMs`                                                                                            |
| `packages/api-types/src/live-audio.ts`                                                    | `AnalogTransmissionEventData`, `AnalogTransmissionFrequency`, `AnalogTransmissionCloseReason`                                                                                                                                                                    |
| `src/core/activity/storage/contract.ts`, `packages/api-types/src/activity.ts` (identical) | `AnalogTransmissionPayload`, `AnalogTransmissionRecord` in `ActivityRecord`; contract only: `AnalogTransmissionAdmission`, `ActivityStoreHandle.admitTransmission`                                                                                               |
| `src/core/activity/storage/row.ts`, `store.ts`                                            | Stubs that throw `ACTIVITY_NOT_IMPLEMENTED` for the new kind (lane A replaces them)                                                                                                                                                                              |
| `packages/api-types/src/vessels.ts` (new, exported)                                       | `VesselClass`, `VesselPosition`, `VesselState`, `VesselTrackerStats`, `VesselListResponse`, `VesselNotFoundResponse`, `VesselLostEventData`, `VesselServerMessage`                                                                                               |
| `src/api/websocket/events.ts`                                                             | channel `vessels`; message type `live-audio:transmission`; `VesselServerMessage` in `ServerMessage`. No broadcast methods (Main adds them)                                                                                                                       |

`tests/unit/core/activity/api-types-compat.test.ts` asserts the two activity copies are the
same type. All other additions are optional fields or new types.

## Spectrum: backfill

**Buffer.** Each source `Entry` keeps a ring of its latest block summaries
(`BlockSummary` plus the `EngineEpoch` and the arrival time `atMs`), appended in
`onPipeline` next to `lastSummary`. Capacity is `ceil(BACKFILL_LIMITS.maxMs / integrationMs) + 1`
from the engine config; entries older than `maxMs` are dropped on append. A summary of a
different stream or epoch than the previous one clears the ring first (1.4). The ring lives
and dies with the entry. Summary `bins` arrays are not mutated after emission (lane W
verifies, else copies).

**Build.** At commit of a `source` selection with `backfillMs` > 0 (after the snapshot rule
check, before `emit("profile")`), take the ring suffix with `atMs >= now − backfillMs`, of
the engine's current stream and epoch, excluding the summary used by the snapshot. Group it
from the newest end in runs of `n = summariesPerFrame(blockHz, profile.hz)`; a partial
oldest run is dropped. Each run is `reduceMaxHold` and `accumulateHold`-ed like a live frame,
labelled from its newest summary, `at` = that summary's `atMs`, `backfill: true`. With
averaging the backfill frames pass through a fresh averager in order (2.2). Keep the newest
`BACKFILL_LIMITS.maxFrames` frames, then drop the oldest until the summed
`JSON.stringify({type:"spectrum:frame", data}).length` is at most `maxBytes`.

**Delivery.** The `profile` event gains a third array: `(clientId, ack, snapshots,
backfill)`. `wireSpectrumBroadcasts` sends ack, backfill frames (in order), snapshots,
synchronously, so live frames can only follow. `ack.backfillFrames = backfill.length` when
requested. `SpectrumBroadcastSource`'s `profile` listener type changes accordingly (both in
lane W's files).

## Spectrum: averaging

**Profile.** The internal `SpectrumProfile` gains `averaging: number` (1 = off).
`profileKey(hz, bins, averaging)` returns `${hz}:${bins}` for 1 and
`${hz}:${bins}:a${n}` otherwise. `normaliseProfile` handles `averaging` like `bins`
(round, clamp, `adjusted`). The default profile is always averaging 1. `describe()` adds
`averaging` to the view only when > 1.

**Nearest.** At the profile limit, `nearestProfile` filters candidates to the requested
averaging; if none, to averaging 1 (the default is always there) and adds `"averaging"` to
`adjusted` (2.5, 2.6). The hz/bins metric and ties are unchanged.

**Build.** `SpectrumHold` gains `avg: Float32Array | null`. When a frame completes
(`hold.count >= n`) and the profile's averaging is > 1, `avg` is seeded with the frame or
updated `avg[i] += (frame[i] − avg[i]) / averaging`, and the frame carries `avg`. A reset in
`accumulateHold` (epoch, factor, length change) clears `avg` (2.3). The snapshot of an
averaged profile uses the profile's `avg` when it exists for the current epoch, else the
raw latest summary.

## Analog transmissions

**Module.** `src/core/analog-transmission.ts` (new):

```ts
export interface AnalogTransmissionSource {
	getStatus(): LiveDemodStatus
	isSquelchOpen(): boolean
	squelchHangMs(): number
	// typed overloads for "squelch-changed" (open: boolean), "level" (LiveAudioLevel),
	// "config-changed" (LiveDemodConfig), "started", "stopped"; `off` likewise
}
export interface AnalogTransmissionTrackerOptions {
	source: AnalogTransmissionSource
	/** Event-time frequency (tuned centre + offsetHz); Main wires it from the tuner. */
	frequencyAt: (
		sourceId: string,
		offsetHz: number,
	) => AnalogTransmissionFrequency | null
	now?: () => number
	randomUUID?: () => string
	maxDurationMs?: number // default 600_000
}
export class AnalogTransmissionTracker extends EventEmitter {
	// "transmission" (AnalogTransmissionEventData, open and closed);
	// "closed" (AnalogTransmissionPayload) once per closed transmission
	start(): void
	stop(): void // closes an open transmission with "stopped", then detaches
	current(): AnalogTransmissionEventData | null
}
export function toActivityPayload(
	e: AnalogTransmissionEventData,
): AnalogTransmissionPayload
```

**State machine.** Idle → Open on `squelch-changed(true)` while gated (rule as
`liveDemodOperatorActivity`: `squelchMode === "auto" || squelch !== 0`) and running. Open →
Idle on `squelch-changed(false)` (`squelch`), `stopped` (`stopped`), a `config-changed`
that changes `sourceId`, `modulation`, `bandwidth`, `offsetHz` or `squelchMode`, or any
reconfigure that restarts the pipeline (`config`, per requirement 3.6; the live demodulator
labels the teardown squelch edge; threshold-only changes keep it open), a level sample whose `frequencyAt` differs from the open frequency by more than
1 Hz or changes null-ness (`retune`), or `now − startedAt >= maxDurationMs`, checked on
level samples (`max-duration`). After `retune` or `max-duration` a new transmission opens
at once if the squelch is still open and gated. Level samples while open update peak and a
running mean of `channelPowerDbfs` (non-null only). `endedAt = max(startedAt, closeAt −
squelchHangMs())` for a `squelch` close only; every other reason uses `closeAt`. The tracker never
throws into the emitter; `frequencyAt` failures give `frequency: null`.

**Live demodulator.** Lane A may add `squelchHangMs()` (the `ChannelSquelch` hang in use)
and anything else the port needs to `live-demodulator.ts`, without changing behaviour or
existing events.

**Activity.** `row.ts` gains `transmissionRow` (summary per 4.2; title
`"${MODULATION} ${MHz} MHz"` or `"${MODULATION} transmission"` without frequency; fields
`durationMs` (unit ms), `modulation`, `peakChannelPowerDbfs` (unit dBFS) when non-null;
FTS text: `analog-transmission`, modulation, source id, frequency in Hz) and parse
support. `storage/ingress.ts` gains `admitTransmission(input)`: closed/paused/overflow and
token checks as `admit`, bucket key `analog:<sourceId>` in the per-decoder map, never
telemetry, `eventId = payload.transmissionId`. `store.ts` implements `admitTransmission` like
`admit`. `runtime.ts` exposes `transmissionSink(): ((p: AnalogTransmissionPayload) => void) | null`
(null unless ready); Main wires tracker `closed` → sink.

## AIS vessels

**Tracker.** `src/core/vessel-tracker.ts` (new), modelled on `AircraftTracker`:
`VesselTracker extends EventEmitter<{ "vessel:new": [VesselState]; "vessel:update":
[VesselState]; "vessel:lost": [string, VesselState]; "stats:update": [VesselTrackerStats] }>`,
config `{ maxAgeMs = 900_000, cleanupIntervalMs = 10_000, maxVessels = 5000,
statsIntervalMs = 5000 }`, `start()`, `stop()`, `processShip(decoderId, data: unknown,
at?: Date)`, `getAll()` (lastSeen desc), `get(mmsi)`, `getStats()`, `now` injectable.
`processShip` parses with a Zod schema of `ShipData` (`eta` as Date or ISO string; numbers
finite), applies 5.2–5.4, and emits `vessel:new` for a new MMSI, else `vessel:update`.
Invalid data is counted and dropped, never thrown.

**Class.** From the message types seen, first match: 4 or 11 → `base-station`; 21 →
`aton`; 9 → `sar`; 18, 19 or 24 → `B`; 1, 2, 3 or 5 → `A`; else `unknown`.

**Manager.** `src/core/vessel-tracking-manager.ts` (new), like
`AircraftTrackingManager`: listens to `decoderManager.on("decoder:output")`, filters
`output.type === "ship"`, calls `processShip(decoderId, output.data, output.timestamp)`.

**NMEA.** `ais-catcher.ts`: `decodeAisPayload` gains types 18 and 19 (position fields at
their ITU-R M.1371 offsets), 5 (static and voyage, 424 bits), 19 (name, ship type) and 24
(part A name; part B ship type and callsign), six-bit text decoding with `@` trimming.
`parseNmeaSentence` stays single-sentence; the adapter instance keeps a small fragment
buffer keyed by talker (`AIVDM`/`AIVDO`), sequence id and channel (at most 8 pending, 2 s timeout) so type 5 decodes.
Output stays `type: "ship"` with `ShipData`.

**Routes.** `src/api/routes/vessels.ts` (new): `vesselRoutes(app, { tracker })` with the
three GET routes of requirement 6 and JSON schemas for the responses.

**Backfill and the outbound queue (1.8).** `WebSocketEventBroadcaster.outboundHeadroom`
reports a client's free bytes and messages; `fitBackfill` in `spectrum-broadcast.ts` trims
the service's backfill to that headroom before the ack is sent and rewrites the ack's
`backfillFrames` to the trimmed count.

## Activity default

`src/config.ts`: `enabled` default true. Retention and admission defaults come from one place:
`ACTIVITY_LIMIT_DEFAULTS` in `src/core/activity/storage/limits.ts` (rows 250 000, bytes
256 MiB, age 3 days; global 50/s burst 500; per decoder 20/s burst 200), so omitted fields
anywhere fall back to the bounded values. Those defaults are an operator judgement for a
Pi-class SD card, not measured.

**Position coalescing (7.6–7.9).** `src/core/activity/storage/coalesce.ts`
`PositionCoalescer` runs in `ActivityIngress.admit` after the telemetry check and before
the token buckets. Per output type a positive allowlist of redundant fields, a list of
identity fields compared with the last stored values, and (ship) an AIS message-type gate;
any other field makes the reception informative and stored. Key `decoderId + outputType +
entity id`; window by the envelope's `receivedAt` (the ingest clock); the entity state is
committed only when the row is queued, so a rate-limited or dropped reception does not
mute the next one, and the commit's undo runs when the write fails (`nack`, skipped rows). Bounded by `positionCoalesceMaxEntities`
(20 000) with LRU eviction; an evicted entity's next reception counts as a first sighting.
A backwards clock step stores. Rejection reason `coalesced`; `coalescedPositions` in stats.

## Scanner extras

`WsLimiter` gains an optional per-priority interval (`perKeyMinIntervalMs` per priority,
`progress: 500`); `wireScannerBroadcasts` sets it. `poiFor` uses
`(hop.dwellMs ?? n.dwellMs) − n.settleMs`.

## Correctness properties

Property 1: Backfill bounds and order. For any ring and request, backfill frames are oldest
first, at most 64, at most 512 KiB serialized, all of the current stream and epoch, all
`backfill: true`, and none older than `backfillMs`. Validates: 1.2–1.5.

Property 2: Backfill equals live. Feeding a summary sequence live to a profile and building
its backfill from the same ring yield the same bins for the frames both contain (frame
boundaries aligned from the newest end). Validates: 1.3.

Property 3: Averaging recurrence. For any frame sequence and n in 1–32, the averaged output
equals the reference recurrence, n = 1 is the identity, and a layout or epoch change
restarts it. Validates: 2.2, 2.3.

Property 4: Averaging isolation. For any set of client requests, a client with no
`averaging` is only ever served a profile with averaging 1, and the profile count never
exceeds the limit. Validates: 2.4–2.6.

Property 5: Transmission pairing. For any sequence of squelch, level, config, stop and
retune events, every open event is followed by exactly one closed event with the same id,
transmissions never overlap, `durationMs >= 0`, `endedAt >= startedAt`, and no event is
produced while ungated. Validates: 3.1–3.3, 3.5, 3.6, 3.8.

Property 6: Transmission row round trip. For any valid payload, `buildActivityRow` then
`parseStoredRecord` and `parseStoredSummary` return the record and a summary of at most
4 KiB with the fields of 4.2. Validates: 4.1, 4.2, 4.4.

Property 7: Vessel merge. For any sequence of ship reports for one MMSI, the state's
fields equal the last valid value reported for each field, sentinel and out-of-range values
never appear, and `messageTypes` is the sorted distinct set. Validates: 5.2–5.5.

Property 8: Vessel expiry and cap. For any report timeline, the tracker never holds more
than `maxVessels`, removes exactly the vessels older than `maxAgeMs` at each sweep, and
emits one `vessel:lost` per removal. Validates: 5.6.

Property 9: AIS six-bit round trip. For any field values in range, encoding a type 1, 5, 18
or 24 payload with the test encoder and decoding it returns the values. Validates: 5.8.

Property 10: Scanner progress rate. For any offer timeline, `scanner:progress` keys are
emitted at least 500 ms apart, every other key at least 1 s apart, no 1 s window holds more
than the global budget, and every key's latest state is delivered. Validates: 8.1.

Property 11: Position coalescing. For any timeline of aircraft receptions over a few
entities, a reception is stored exactly when the entity is new (or was evicted), its last
stored reception is at least 60 s older, an identity field it carries differs from the
last known value, or it carries a field outside the allowlist; the tracked entities never
exceed the bound. Validates: 7.6, 7.7, 7.9.

Property 12: Backfill within the outbound headroom. For any socket buffer level, earlier
queued traffic, backfill frame count and size, delivering ack, backfill and snapshot never
disconnects the client, and `backfillFrames` equals the backfill frames sent. Validates: 1.8.
