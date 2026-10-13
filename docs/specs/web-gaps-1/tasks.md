# Web gaps 1 tasks (WG1)

Status: 0.1, lanes W, A, V and Main M.1–M.4 done (2026-10-13); M.5 checkpoint open. See
[requirements](requirements.md) and [design](design.md). Lanes W, A and V work in parallel
against the frozen contract and touch only their own paths; Main (M) owns the composition
files (`src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`), the WS broadcaster
methods in `src/api/websocket/events.ts`, the scanner files, the contract files and the docs,
and works serially after the lanes. No lane edits the pinned band-plan files, the isolation
tests or `docs/CLI-COORDINATION.md`. Every lane runs its touched tests, `pnpm run typecheck`
and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: spectrum DTO additions and
      `src/core/spectrum/subscribe-options.ts`; analog transmission DTOs; the
      `analog-transmission` activity record, payload and `admitTransmission` (stubbed);
      `packages/api-types/src/vessels.ts`; the `vessels` channel and the
      `live-audio:transmission` message type.
  - _Requirements: 1.1, 1.6, 1.7, 2.1, 2.4, 3.2, 4.1, 6.4, 9.2_

## Lane W: waterfall backfill and averaging

- [x] W.1 Summary ring per source entry and the backfill build in `spectrum-service.ts`
      (new helpers in `src/core/spectrum/spectrum-backfill.ts`); ack `backfillFrames`.
  - _Requirements: 1.1–1.6_
  - **Property 1: Backfill bounds and order**, **Property 2: Backfill equals live**
- [x] W.2 Averaging in the profile (key, normalise, nearest, hold, snapshot), helpers in
      `src/core/spectrum/spectrum-averaging.ts`.
  - _Requirements: 2.1–2.6_
  - **Property 3: Averaging recurrence**, **Property 4: Averaging isolation**
- [x] W.3 `spectrum-broadcast.ts`: send ack, backfill, snapshots in order.
  - _Requirements: 1.2, 9.1_
- [x] W.4 (Main, R1 M2) Bound backfill by the client's outbound headroom.
  - _Requirements: 1.8_
  - **Property 12: Backfill causes no disconnect**

## Lane A: analog transmissions

- [x] A.1 `src/core/analog-transmission.ts`: tracker, state machine, payload mapping;
      `squelchHangMs()` on the live demodulator.
  - _Requirements: 3.1–3.9_
  - **Property 5: Transmission pairing**
- [x] A.2 Activity storage of the new kind: `row.ts`, `storage/ingress.ts`, `store.ts`,
      `runtime.ts` sink.
  - _Requirements: 4.1–4.5_
  - **Property 6: Transmission row round trip**

## Lane V: AIS vessels

- [x] V.1 `src/core/vessel-tracker.ts` and `src/core/vessel-tracking-manager.ts`.
  - _Requirements: 5.1–5.7, 5.9_
  - **Property 7: Vessel merge**, **Property 8: Vessel expiry and cap**
- [x] V.2 NMEA decoding of types 5, 18, 19 and 24 with fragment reassembly in
      `ais-catcher.ts`; encoder-generated fixtures.
  - _Requirements: 5.8_
  - **Property 9: AIS six-bit round trip**
- [x] V.3 `src/api/routes/vessels.ts`.
  - _Requirements: 6.1–6.3_

## Main (serial, after the lanes)

- [x] M.1 Wire spectrum (nothing beyond the lane unless the server tests need it), the
      transmission tracker (frequency port from the tuner, WS broadcast, activity sink) and
      the vessel tracker (routes, `vessels` channel broadcasts, stats).
  - _Requirements: 3.2, 3.4, 3.9, 4.5, 6.4, 6.5_
- [x] M.2 Activity on by default with bounded defaults; tests.
  - _Requirements: 7.1–7.5_
- [x] M.2b Position coalescing per entity in Activity ingress (user decision, R1 M1).
  - _Requirements: 7.6–7.8_
  - **Property 11: Position coalescing**
- [x] M.3 Scanner extras: progress at 2 Hz, POI with per-hop dwell.
  - _Requirements: 8.1, 8.2_
  - **Property 10: Scanner progress rate**
- [x] M.4 Docs and the coordination note.
  - _Requirements: 10.1_
- [ ] M.5 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 9.1–9.4_
