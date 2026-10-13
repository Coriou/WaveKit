# Web gaps 1 requirements (WG1)

Status: contract frozen; lanes and Main tasks not started. See [design](design.md) and
[tasks](tasks.md).

## Scope

Core features the web dashboard branch lists as missing (`docs/web/CORE-GAPS.md` on
`design/web-dashboard`, sections Spectrum, Analog transmissions and Map): waterfall
backfill on subscribe, per-client spectrum averaging, analog transmission events from the
live demodulator's squelch, and a current-state tracker for AIS vessels. Activity
recording becomes on by default, with bounded retention and admission defaults. Two scanner
extras ride along: `scanner:progress` at up to 2 Hz per job, and coverage (POI) warnings that
use each hop's own dwell.

Out of scope: CLI and web UI changes (the CLI gets a coordination note only); `fftSize` above
2048 (deferred until a Pi-class CPU measurement); analog versus digital detection, CTCSS,
DCS, DTMF and recordings on transmissions; APRS and Meshtastic trackers; position history,
trails and coverage maps; any scanner default; the access default (stays `legacy`); the
channelizer (stays off) and S2 (stays disabled); the files pinned by the band-plans spec
(`src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`,
`src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`) and both
isolation hash tables.

## 1. Waterfall backfill

As a web user opening the Spectrum view I want the waterfall to show the last few seconds at
once, not fill from the top.

1.1 `options.spectrum` of a WS `subscribe` shall accept `backfillMs`, rounded to an integer
and clamped to 0–10000; a changed value adds `"backfillMs"` to `adjusted`. Absent or 0 means
no backfill, and the subscribe behaves exactly as before.
1.2 After a committed `source` ack whose request had `backfillMs` > 0, the server shall send
backfill frames (`spectrum:frame` with `backfill: true`) oldest first, then the snapshot frame
(if any), then live frames. No backfill frame follows a rejected ack or a default selection.
1.3 Backfill frames shall be built at the client's profile (hz, bins, averaging) from block
summaries the source's engine produced within the last `backfillMs`, with the same
`summariesPerFrame` grouping and max-hold as live frames.
1.4 Backfill shall use only summaries of the engine's current stream and epoch; summaries
from before a retune or stream change are never sent. The buffer is per source and bounded
to 10 s of summaries.
1.5 A subscribe shall send at most 64 backfill frames and at most 512 KiB of serialized
backfill messages; when a bound is hit the newest frames are kept.
1.6 The ack shall carry `backfillFrames`, the number of backfill frames that follow it
(0 when none are buffered), whenever the request had `backfillMs` > 0.
1.7 `GET /api/spectrum/status` `limits` shall report the averaging and backfill bounds.

## 2. Per-client averaging

As a web user I want a smoother waterfall and trace on a noisy band without changing what
other clients see.

2.1 `options.spectrum` shall accept `averaging`, rounded to an integer and clamped to
1–32; a changed value adds `"averaging"` to `adjusted`. Absent or 1 means off.
2.2 With `averaging` n > 1, each frame of the profile shall be the exponential average of
its max-held frames in the dBFS domain: `avg = avg + (frame − avg) / n` per bin, seeded with
the first frame.
2.3 The running average shall restart on a new epoch, stream or bin layout.
2.4 Averaging shall be part of the profile: clients with equal hz, bins and averaging share
one frame build. The profile key is `${hz}:${bins}` when averaging is off (unchanged) and
`${hz}:${bins}:a${n}` otherwise; `SpectrumProfileView.averaging` is present only when n > 1.
2.5 Averaged profiles count against `scanner.ws.spectrumMaxProfiles` like any other
non-default profile. At the limit, a request maps to the nearest existing profile with the
same averaging, or else to one with averaging off (the default profile always qualifies),
and `adjusted` names `"profile-limit"` and, when it changed, `"averaging"`.
2.6 A client that never sends `averaging` shall never receive an averaged profile.

## 3. Analog transmission events

As a web user I want each squelch-delimited analog transmission on the live demodulator as
an event with start, end, duration and frequency.

3.1 While the live demodulator runs with a gating squelch (manual mode with a non-zero
threshold, or auto mode), each squelch open shall start a transmission and the matching
close shall end it. With squelch 0 in manual mode no transmission is produced.
3.2 On start the server shall send `live-audio:transmission` with `state: "open"` on the
`live-audio` channel; on end, one with `state: "closed"`. Both carry the same
`transmissionId` (a UUID).
3.3 `startedAt` shall be the time of the open. `endedAt` shall be the time of the last
above-threshold block, that is the close time minus the squelch hang time, and never before
`startedAt`; `durationMs` = `endedAt − startedAt`.
3.4 `frequency` shall be the event-time RF frequency when the transmission opened: the
tuned centre of the live demodulator's source plus `offsetHz`, with the tuning trust; null
when the centre is unknown.
3.5 A change of the event-time frequency while open (a retune seen on a level sample) shall
end the transmission with `closeReason: "retune"`; a new one starts if the squelch is still
open.
3.6 A config change that restarts the pipeline shall end it with `"config"`, a stop with
`"stopped"`, and a transmission reaching 10 minutes with `"max-duration"` (a new one starts
if the squelch is still open). A normal close is `"squelch"`.
3.7 Each event shall carry modulation, bandwidth, squelch mode, the effective threshold at
open, and the peak and mean channel power over the transmission's level samples (null
before the first sample).
3.8 Every open event shall be followed by exactly one closed event for the same id, also on
shutdown.
3.9 Transmissions and their WS events shall work whether Activity is enabled or disabled.

## 4. Analog transmissions in Activity

4.1 When Activity is ready, each closed transmission shall be stored as one record of kind
`analog-transmission` with `AnalogTransmissionPayload`; the record's `eventId` equals the
`transmissionId`, `producedAt` equals `endedAt`.
4.2 The record's summary shall have category `voice`, protocol `analog`, the source id,
`frequencyHz` from the event-time frequency (null when unknown), decoder id null, a title
naming modulation and frequency, and fields for duration, modulation and peak power.
4.3 Admission shall be non-blocking and counted like decoder receptions, with its own token
bucket per source; drops become ingestion-gap episodes as today.
4.4 Stored records shall round-trip through `parseStoredRecord` and `parseStoredSummary`,
be searchable by `kinds: ["analog-transmission"]`, source and frequency, and reach Activity
WS subscribers through the existing replay.
4.5 With Activity disabled or unavailable, closed transmissions are not stored and nothing
fails.

## 5. AIS vessel tracker

As a web user I want the current state of every AIS vessel heard, like the aircraft list.

5.1 A vessel tracker shall consume `decoder:output` events of type `ship` from AIS
decoders, validate the data at the boundary and key vessels by MMSI (9 digits).
5.2 Position reports shall update position, course, speed, heading and navigation status;
static and voyage reports shall update name, callsign, IMO, ship type, destination, ETA and
draught. A report never clears a field it does not carry.
5.3 AIS "not available" values shall be ignored: latitude 91, longitude 181, course 360,
speed 102.3, heading 511, navigation status 15; out-of-range values likewise.
5.4 Text fields shall be trimmed with the AIS `@` padding removed; empty text is absent.
5.5 The vessel class shall follow the message types seen (design table).
5.6 A vessel not heard for `maxAgeMs` (default 15 min) shall be removed and reported lost;
the tracker shall hold at most 5000 vessels, evicting the least recently heard.
5.7 The tracker shall report stats: counts by class, with position, with name, messages
processed and per second, last message time and the most recently heard MMSI.
5.8 The NMEA path of the AIS-catcher adapter shall decode position from message types 1–3,
18 and 19 and static data from types 5 (two-fragment reassembly), 19 and 24 (parts A and B),
so the default NMEA output feeds the tracker.
5.9 No new tracker config key is added; defaults live in the tracker.

## 6. Vessels API

6.1 `GET /api/vessels` shall return `VesselListResponse`, most recently heard first.
6.2 `GET /api/vessels/stats` shall return `VesselTrackerStats`.
6.3 `GET /api/vessels/:mmsi` shall return the vessel, 404 `VESSEL_NOT_FOUND` when unknown,
and 400 `VALIDATION_ERROR` when the parameter is not 1–9 digits (shorter values are
zero-padded).
6.4 The `vessels` WS channel shall carry `vessel:new`, `vessel:update`, `vessel:lost` and
`vessel:stats` (stats every 5 s while the tracker runs, like aircraft).
6.5 Routes and channel shall exist whenever the tracker is constructed (always), and follow
the access policy like the aircraft routes.

## 7. Activity on by default

7.1 `activity.enabled` shall default to true. An explicit `enabled: false` keeps today's
disabled behaviour (no database file, no worker).
7.2 A config without an `activity` block, or with partial `retention` or `admission`
blocks, shall get these bounded defaults for every omitted field: retention 250 000 rows,
256 MiB, 3 days; admission 50 per second with burst 500 globally, 20 per second with burst
200 per decoder.
7.3 An unavailable store (probe failure, lock, schema mismatch) shall leave the rest of the
app running, as today.
7.4 `config/default.yaml`, `docs/API.md` and `docs/ROADMAP.md` shall describe the new
default and bounds.
7.5 Access stays `legacy` by default.

## 8. Scanner extras

8.1 `scanner:progress` shall be delivered at up to 2 Hz per job (500 ms per key); every
other scanner message keeps its 1 s per-key interval and the global message budget.
8.2 Plan preview POI (detection and decode probability) shall use the hop's own
`dwellMs` when set, else the job's `dwellMs`; plans without per-hop dwell are unchanged.

## 9. Compatibility and gates

9.1 A client that sends none of the new options receives exactly today's spectrum
messages.
9.2 All DTO additions are optional fields, new union members or new types; no existing
field changes meaning.
9.3 Scanner defaults, the production binding, the access default, the channelizer and S2
are unchanged; the pinned band-plan files and isolation tables are unchanged.
9.4 `fftSize` and `bins` stay capped at 2048.

## 10. Documentation

10.1 `docs/API.md` (spectrum options and frames, `live-audio:transmission`, Activity kind
and defaults, vessels routes and channel), `docs/SCANNER.md` (progress rate, POI),
`docs/ROADMAP.md` and an append to `docs/CLI-COORDINATION.md` shall describe the changes.
