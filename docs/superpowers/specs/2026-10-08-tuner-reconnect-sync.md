# Tuner state synchronization on source reconnection

Status: implemented (ROADMAP §3). Parent: `2026-10-08-sample-rate-and-channelizer-design.md`
§"Source rate choices and tuner ownership".

## Problem

An rtl_tcp source (rtl_tcp, rtlmux, SDR++ in rtl_tcp mode) can return at its own defaults
(host reboot, server restart, replug). Observed: a reflashed Pi came back at its configured
2.048 Msps while core caps still claimed a pre-outage relay tuning of 2.16 Msps /
446.866968 MHz, so decoders would adapt to a rate the hardware was not producing. The
dongle-info header carries tuner type/gain count only; rate/center cannot be read back.

## Desired state and ownership

- Desired state = `TunerState` values of fields _accepted_ through a command since the
  source was registered, each stamped with a monotonically increasing sequence number.
  - API (`POST /api/tuner/:sourceId/...`, `configure`) in `internal` mode: accepted only
    after the upstream write succeeded (writes while disconnected still fail, unchanged).
  - Relay clients (SDR++) via `applyExternalCommand`: accepted when valid, even if the
    upstream forward failed while the source was down; the next replay applies them.
- Config/caps defaults are never commanded. Nothing accepted → reconnect writes nothing.
- Ownership (`controlMode`, relay exclusive/shared) governs who may _change_ desired state.
  Restoring is not a new command, so it bypasses the `external`-mode API guard. The relay
  keeps SDR++ connected across upstream reconnects, so SDR++ never resends by itself.

## Policy: `tuner.reconnectPolicy` (`WAVEKIT_TUNER__RECONNECT_POLICY`)

- `restore` (default, per the parent spec): re-send accepted state (below).
- `reset` (conservative, for shared hosts another operator may own after an outage): write
  nothing, discard accepted state, reset tuner fields to the startup baseline (registered
  caps center/rate, AGC, zero gain/PPM...). Same truth level as a fresh start.
- Both: caps are then reconciled to what the tuner state backs. That means accepted values
  for commanded fields, otherwise the baseline caps (dropping a `centerFreq` the config never
  declared). Stale caps are never kept silently, and a reconciliation logs a warning.

## Replay order (restore)

Trigger: every `connected` event for an rtl_tcp source (`synchronizeOnConnect`, wired in
`src/index.ts`). Order follows librtlsdr semantics:

1. direct sampling, offset tuning, RTL xtal, tuner xtal, PPM
2. sample rate, then center frequency (bandwidth/IF depends on rate)
3. bias-tee, RTL2832 AGC
4. gain group (mode, gain, gain index, IF gain, tuner IF gain) in acceptance order, so
   "gain then AGC" and "AGC then gain" both reproduce faithfully
5. test mode

Races: all frames are written synchronously in one tick, with no events until the batch is on
the socket. No API/relay command can interleave; a later one goes after the batch on the
same TCP stream, so the newer command wins on the wire and in state (including re-entrant
listeners of the post-replay `command-sent`). The sequence number is the generation: values
are read at replay time, so nothing stale is replayed over a newer accepted value.

Failure: a throwing write (socket closed mid-replay) stops the batch, sets `lastError`, emits
`error` + `state-changed`; desired state is untouched, so the next `connected` replays in full.
Bounded: one batch (≤15 writes) per connection, no own timers/retries; cadence = backoff.

## Metadata and decoders

Accepted commands already updated caps, so a normal reconnect emits zero `caps-changed`
(no restart storm). A divergence is fixed by one `SourceManager.setTuningCaps` call, which
emits exactly one `caps-changed` for DecoderManager's serialized worker.

## Status honesty

No public API shape change. `TunerState` values remain _last commanded desired values_
(rtl_tcp has no acknowledgement or readback). Replay writes count in `commandCount`/
`lastCommandAt` and emit `command-sent`; failures set `lastError`. "Pending vs sent" =
tuner state + source `connected`. Documented in `docs/API.md`. Config gains `tuner`.

## Out of scope

- SDR-host default gain/rate restoration on last-client departure (Pi team; it must
  serialize against an arriving, replaying core).
- Explicit `SourceManager.reconnect()`/removal: `removed` discards tuner state by design.
- Dongle-swap detection via the header (gain values replayed as-is); hardware readback.
- Per-source policy, and "restore only while the authoring relay client is present".
- Non-rtl_tcp sources.
