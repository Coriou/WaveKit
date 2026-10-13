# Web gaps 2 tasks (WG2)

Status: 0.1 done (spec and contract frozen, 2026-10-13); lanes and Main open. See
[requirements](requirements.md) and [design](design.md). Lanes P, R, N, T, X and D work in
parallel against the frozen contract and touch only their own paths; Main (M) owns the
composition files (`src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`), the WS
broadcaster in `src/api/websocket/events.ts`, `src/api/websocket/scanner-broadcast.ts`, the
scanner files, the contract files and the docs. M.1 and M.2 do not depend on the lanes and run
while they work; M.3 onwards follow the lane merges. No lane edits the pinned band-plan files,
the isolation tests or `docs/CLI-COORDINATION.md`. Every lane runs its touched tests,
`pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: `aprs.ts`, `mesh.ts`, transmission `tone`, digital call
      fields, device DTO and label schema, scanner lockout and hit DTOs, `APRSData` object
      fields, the `aprs` and `mesh` channels with their message types and broadcast methods;
      the access spec amendment.
  - _Requirements: 3.1, 4.2, 5.1, 6.2, 7.4, 10.1, 11.2, 11.4, 12.2, 13.2, 14.1_

## Lane P: Activity presentation

- [ ] P.1 `src/core/activity/presentation/**`: registry and per-family mappers, budget
      helpers; ingress passes the presentation with the rebuild-without fallback.
  - _Requirements: 1.1–1.9_
  - **Property 1: Presentation never loses a reception**, **Property 2: Entity key canonical
    form**, **Property 3: Presentation budget**
- [ ] P.2 APRS and mesh position specs in `storage/coalesce.ts`.
  - _Requirements: 2.1–2.4_
  - **Property 4: APRS and mesh coalescing**

## Lane R: APRS stations

- [ ] R.1 Object and item parsing in `direwolf.ts`; speed doc comment.
  - _Requirements: 3.2, 3.9_
- [ ] R.2 `src/core/aprs-tracker.ts`, `src/core/aprs-tracking-manager.ts`.
  - _Requirements: 3.1, 3.3–3.8_
  - **Property 5: APRS merge and dedupe**, **Property 6: Tracker expiry and cap**
- [ ] R.3 `src/api/routes/aprs.ts`.
  - _Requirements: 4.1_

## Lane N: Meshtastic nodes

- [ ] N.1 `src/core/meshtastic-protobuf.ts` and the test encoder.
  - _Requirements: 5.2, 5.3_
  - **Property 7: Protobuf round trip and robustness**
- [ ] N.2 `src/core/mesh-tracker.ts`, `src/core/mesh-tracking-manager.ts`.
  - _Requirements: 5.1, 5.4–5.8_
  - **Property 8: Mesh merge and flood copies**, **Property 6: Tracker expiry and cap**
- [ ] N.3 `src/api/routes/mesh.ts`.
  - _Requirements: 6.1_

## Lane T: tones

- [ ] T.1 `src/core/audio-tones/**`: CTCSS and DTMF detectors.
  - _Requirements: 7.2, 7.3_
  - **Property 9: CTCSS detection**, **Property 10: DTMF detection**
- [ ] T.2 PCM tap on the live demodulator; tone on closed transmissions; row fields and
      parsing; the absent-versus-default `sourceId` fix.
  - _Requirements: 7.1, 7.4–7.7_
  - **Property 11: Transmission row with tone**

## Lane X: AIS checksum, throttle, digital call metadata

- [ ] X.1 Strict NMEA checksum in `ais-catcher.ts`; regenerated fixtures.
  - _Requirements: 8.1, 8.2_
  - **Property 12: NMEA checksum**
- [ ] X.2 `src/core/entity-update-throttle.ts`.
  - _Requirements: 9.1–9.3_
  - **Property 13: Throttle**
- [ ] X.3 Digital call metadata in `dsd-fme.ts` and `digital-voice.ts`.
  - _Requirements: 10.1, 10.2_

## Lane D: devices

- [ ] D.1 Snapshot v2 with name, kind and last-seen; migration; projections.
  - _Requirements: 11.1, 11.4–11.6_
- [ ] D.2 `POST /api/access/devices/label`; last-seen on authenticated admission.
  - _Requirements: 11.2, 11.3_
  - **Property 14: Device last-seen**

## Main

- [ ] M.1 Ignore skips sweeps: lockout exclusions in the planner, preview and job DTO.
  - _Requirements: 12.1–12.5_
  - **Property 15: Lockout exclusions**
- [ ] M.2 Per-job hit statistics: counts, events, route.
  - _Requirements: 13.1–13.5_
  - **Property 16: Hit counts**
- [ ] M.3 Merge the lanes; wire APRS and mesh trackers, routes and channels; the throttle on
      vessel, APRS and mesh updates.
  - _Requirements: 4.2, 4.3, 6.2, 6.3, 9.4_
- [ ] M.4 Docs and the coordination note.
  - _Requirements: 15.1_
- [ ] M.5 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 14.1, 14.2_
