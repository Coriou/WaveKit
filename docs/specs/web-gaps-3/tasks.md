# Web gaps 3 tasks (WG3)

Status: 0.1 done (contract frozen); lane tasks not started. See [requirements](requirements.md)
and [design](design.md). Lanes F, G, P, H, C and M work in parallel against the frozen
contract and touch only their own paths; Main (MA._) owns the composition files
(`src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`, `config/_`), the Activity
contract files (`storage/contract.ts`, `storage/limits.ts`, `activity/types.ts`,
`activity/runtime.ts`), `src/api/websocket/events.ts`, the scanner files and the docs. No lane
edits the pinned band-plan files, the isolation tests or `docs/CLI-COORDINATION.md`. Every lane
runs its touched tests, `pnpm run typecheck`and`pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: hole meta keys and identity fields, the retention policy key,
      limit and default (fair-share), retention stats, `flood-copy`, the provenance lookup
      types and pass-through, coverage DTOs, mesh telemetry and neighbour DTOs; anchor the
      Activity test store clock.
  - _Requirements: 1.1, 1.16, 2.1, 3.1, 3.5, 5.2, 6.6, 7.5, 8.4, 8.5_

## Lane F: fair-share retention (writer)

- [ ] F.1 `storage/fair-share.ts`: share keys, water-filling level, step allocation (pure).
  - _Requirements: 1.2, 1.5, 1.6_
  - **Property 1: Fair floor**
- [ ] F.2 Writer: counters (seed, commit, prune), fair step and transaction, hole bookkeeping,
      fallbacks, policy switch; `oldest-first` unchanged.
  - _Requirements: 1.3, 1.4, 1.7–1.14, 3.1–3.7_
  - **Property 2: Caps bind**, **Property 3: Single share equals oldest-first**,
    **Property 4: Counters**, **Property 5: Hole bookkeeping**
- [ ] F.3 Retention stats in the writer snapshot and `store.ts`; measurements (seed time,
      delete throughput, size drift).
  - _Requirements: 1.15, 2.1–2.3_

## Lane G: hole contract (readers)

- [ ] G.1 Hole keys in `readObserved` and identity handling; `hg` in page tokens and replay
      cursors; page and replay checks.
  - _Requirements: 4.1–4.9_
  - **Property 6: No silent skip**, **Property 7: Reset termination**

## Lane P: RF provenance

- [ ] P.1 `activity/provenance/**` resolver per the provenance table; ingress integration with
      the null-provenance rebuild and `provenanceFailures`; benchmark.
  - _Requirements: 5.1–5.8_
  - **Property 8: Provenance resolution**

## Lane H: Meshtastic flood copies

- [ ] H.1 `storage/flood-dedupe.ts` and the check in `storage/ingress.ts`; forget on failed
      writes; `floodCopies` getter.
  - _Requirements: 6.1–6.8_
  - **Property 9: Flood copies**

## Lane C: coverage

- [ ] C.1 `src/core/coverage/**`: tracker and manager.
  - _Requirements: 7.1–7.4, 7.6, 7.7_
  - **Property 10: Coverage maximum**
- [ ] C.2 `src/api/routes/coverage.ts`.
  - _Requirements: 7.5_

## Lane M: mesh telemetry and neighbours

- [ ] M.1 Telemetry and NeighborInfo in `meshtastic-protobuf.ts`; encoder helpers.
  - _Requirements: 8.1–8.3_
  - **Property 11: Mesh telemetry round trip**
- [ ] M.2 Tracker state, stats and route schemas.
  - _Requirements: 8.4–8.8_
  - **Property 12: Neighbour state**

## Main

- [ ] MA.1 readsb station location; CLI unknown-channel tolerance.
  - _Requirements: 9.1, 9.2_
- [ ] MA.2 Merge the lanes; wire provenance lookup, coverage manager and route, `floodCopies`.
  - _Requirements: 2.1, 5.2, 6.6, 7.5_
- [ ] MA.3 Docs and the coordination note.
  - _Requirements: 9.3_
- [ ] MA.4 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 10.1, 10.2_
