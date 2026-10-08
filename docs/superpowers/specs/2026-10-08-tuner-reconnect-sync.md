# Tuner state synchronization on source reconnection

Implemented (ROADMAP §3). Parent: `2026-10-08-sample-rate-and-channelizer-design.md`.
An rtl_tcp source (rtl_tcp, rtlmux, SDR++ in rtl_tcp mode) can return at its own defaults.
Observed: a reflashed Pi came back at its configured 2.048 Msps while core caps still
claimed a pre-outage relay tuning of 2.16 Msps / 446.866968 MHz. The dongle-info header
carries tuner type/gain count only; rate/center cannot be read back.

## Desired state and ownership

- Desired state = `TunerState` fields _accepted_ through a command since the source was
  registered, each stamped with a monotonically increasing sequence number.
  - API (`POST /api/tuner/:sourceId/...`, `configure`) in `internal` mode: accepted only
    after the upstream write succeeded (writes while disconnected still fail, unchanged).
  - Relay (SDR++) via `applyExternalCommand`: accepted when valid, even if the upstream
    forward failed while the source was down; the next replay applies them. Caps follow
    accepted commands only: a rejected relay rate never reaches caps or decoders.
- Config defaults are never commanded. Nothing accepted → reconnect writes nothing.
- Ownership (`controlMode`, relay exclusive/shared) governs who may _change_ desired state;
  restoring is not a new command, so it bypasses the `external`-mode API guard.

## Policy: `tuner.reconnectPolicy` (`WAVEKIT_TUNER__RECONNECT_POLICY`)

- `restore` (default, per the parent spec): re-send accepted state (below).
- `reset` (shared hosts another operator may own after an outage): write nothing, discard
  accepted state, return tuner fields to the startup baseline (registered caps center/rate,
  AGC, zero gain/PPM). The baseline must mirror the receiver's startup args.
- Both: caps are then reconciled to accepted values for commanded fields, otherwise the
  baseline caps (dropping an undeclared `centerFreq`), with a warning when they change.
  Reconciliation is NOT readback: it only makes caps agree with what core commanded or
  configured.

## Replay order (restore)

Trigger: every rtl_tcp `connected` (`synchronizeOnConnect`, wired in `core/tuner-wiring.ts`):

1. direct sampling, offset tuning, RTL xtal, tuner xtal, PPM
2. sample rate, then center frequency (bandwidth/IF depends on rate)
3. bias-tee, RTL2832 AGC
4. gain group (mode, gain, gain index, IF gain, tuner IF gain) in acceptance order
5. test mode

Races: all frames are written synchronously in one tick, no events until the batch is on the
socket. A later API/relay command goes after the batch on the same TCP stream, so the newer
command wins (including re-entrant `command-sent` listeners). Values are read at replay time.

Failure: a throwing write stops the batch, sets `lastError`, emits `error` + `state-changed`;
the next `connected` replays in full. Bounded: ≤15 writes per connection, no own retries.
The relay's outage-time forward error is cleared on reconnect or the next good forward.

## Metadata, decoders, status

An unchanged reconnect emits zero `caps-changed` (no restart storm); a divergence emits
exactly one (`SourceManager.setTuningCaps`). No public API shape change: `TunerState` stays
_last commanded_; replay writes count in `commandCount`/`lastCommandAt`; failures set
`lastError`. Config gains `tuner`. Documented in `docs/API.md`.

## Detecting the outage: stall watchdog

A rebooted Pi can leave the socket half-open (connected, `stale`, never reconnecting).
For rtl_tcp IQ sources, once a session has delivered payload, a gap of `stallTimeoutMs`
(default 15 s, 0 = off) fails the socket into the normal backoff path; sync then runs on the
new connection. Exempt: recordings, sdrpp-network/audio, a not-yet-streamed session
(e64e16b keeps it connected and `stale`) and local-backpressure pauses. TCP keepalive
(5 s) is also enabled as defence in depth only.

## Residual gap and follow-up

After a core-only restart nothing is accepted, so nothing is written and caps = config
baseline, while rtlmux may still replay relay-set values it cached to rtl_tcp. Follow-up:
opt-in "command baseline on first connect" (send configured rate/center once).

## Out of scope

- SDR-host default gain/rate restoration on last-client departure (Pi team).
- rtlmux drops 0x07 test mode and 0x09 direct sampling: replaying them via the Pi host
  is a no-op, so `TunerState` may over-claim those two fields.
- Explicit `reconnect()`/removal (discards tuner state); dongle-swap detection; readback;
  per-source policy; non-rtl_tcp sources; a session that never streams after connect.
