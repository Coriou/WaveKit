# Web gaps 9 tasks (WG9)

Status: frozen; lanes not started. See [requirements](requirements.md) and
[design](design.md). Lanes work against the frozen contract and touch only their own paths; Main
(MA.\*) owns the composition files (`src/index.ts`, `src/api/server.ts`, barrels,
`src/config.ts`, `config/*`), the frozen contract files (`packages/**`,
`src/core/recordings/contract.ts`), `src/core/scanner/scanner-service.ts`,
`src/core/scanner/store/**`, `src/core/scanner/types.ts`, `src/core/digital-voice.ts`, the
storage report, the isolation and contract tests and the docs. No lane edits the pinned
band-plan files or `docs/CLI-COORDINATION.md`. Every lane runs its touched tests,
`pnpm run typecheck` and `pnpm run lint` before reporting.

- [x] 0.1 Freeze the contract: pairing and session DTOs, preflight cache bound, access error
      codes; recording Keep and delete DTOs, bounds, error statuses, keep keys and the protection
      port; the identify `decoder-unavailable` reason.
  - _Requirements: 1.2, 1.4, 1.5, 2.1–2.4, 2.6, 2.8, 5.4_

## Lane PA: browser pairing

- [ ] PA.1 Preflight `Access-Control-Max-Age`; pair with optional `name` and `kind`.
  - _Requirements: 1.2, 1.5, 1.9_
  - **Property 1: Preflight cache only on success**, **Property 2: Pair body fails closed**
- [ ] PA.2 Separate-web-origin acceptance test (REST, CSRF, preflight, WebSocket, audio, foreign
      origin); Caddy profile example; pairing contract and example flow draft for Main.
  - _Requirements: 1.1, 1.3, 1.6–1.8_

## Lane RK: recording Keep and deletion

- [ ] RK.1 Keep store, protection coordinator and keep service; inventory `kept` and
      `invalidate()`.
  - _Requirements: 2.2–2.4, 2.7, 2.10_
  - **Property 3: Keep store round trip and fail closed**, **Property 5: Keys are never paths**
- [ ] RK.2 Keep, unkeep and delete routes; dsd-fme pruner hook; exact diffs and tests for the
      scanner-side deleters (Main applies them).
  - _Requirements: 2.1, 2.5, 2.6, 2.8, 2.9, 2.11_
  - **Property 4: No owner deletes a kept file**

## Lane TT: tuning trust and retune latency

- [ ] TT.1 Shared strict trust rule at every call site; reconnect caps unverified; epoch centre
      from the command.
  - _Requirements: 3.1–3.3, 3.6_
  - **Property 6: Strict trust**, **Property 7: One epoch per retune**
- [ ] TT.2 Offline retune latency harness (fake rtl_tcp with injectable delay); operator retune
      settle; before and after measurements.
  - _Requirements: 3.4, 3.5_
  - **Property 8: No early `commanded` frame**

## Lane ZM: zoom workload benchmark

- [ ] ZM.1 Benchmark, bundle script, smoke test; Mac run; proposed limits and the Pi command.
  - _Requirements: 4.1–4.4_

## Lane MN: minor defects

- [ ] MN.1 Startup port conflicts (audio output, tuner relay); stored shadowed keys dropped;
      live-audio PATCH 400 code.
  - _Requirements: 5.1–5.3_
  - **Property 10: Shadowed keys dropped**
- [ ] MN.2 Identify `decoder-unavailable`; legacy audio host derivation (route option); auto
      squelch re-seed after a retune.
  - _Requirements: 5.4–5.6_
  - **Property 9: Host derivation is inert**

## Main

- [ ] MA.1 Merge the lanes; wiring in `src/index.ts` and `src/api/server.ts` (keep service,
      inventory protection, dsd-fme protection, Keep/delete routes, legacy audio host option,
      optional `hostCentre`); apply RK's scanner-side deleter diffs and tests; contract test
      updates.
  - _Requirements: 2.5, 2.6, 6.1_
- [ ] MA.2 Docs (API.md pairing contract and example flow, Keep/delete, identify reason, settle
      and trust notes; DOCKER-SETUP web origin; ROADMAP; SCANNER; coordination note for the CLI and
      the web session) and the CLI grep (identify reason, `kept`, access DTOs). Tick
      core-access-policy task 15 (done by web-gaps-2 lane D) and record the checkpoint 14 local
      evidence.
  - _Requirements: 6.2, 6.3_
- [ ] MA.3 Run the zoom benchmark bundle on the Raspberry Pi; record Mac and Pi tables and the
      proposed limits in ROADMAP.
  - _Requirements: 4.4, 6.4_
- [ ] MA.4 Checkpoint: full root suite, typecheck, lint; spec status and ticks.
  - _Requirements: 7.1, 7.2_
