# Decoder enablement tasks (WG13)

Status: not started (2026-10-20). See [requirements](requirements.md) and [design](design.md).

Lanes work against the frozen contract (0.1) and touch only their own paths. Main (MA.\*) owns
the composition files (`src/index.ts`, `src/api/server.ts`, `src/config.ts`, `config/*`), the
contract files (`packages/**`, `src/decoders/enablement/contract.ts`,
`src/core/rate-policy-contract.ts`, the Fastify reason and status schemas), the build files
(`package.json`, the lockfile, `Dockerfile`, `Makefile`, `native/wavekit-chan/Cargo.toml` and
`Cargo.lock`), `cli/**`, the contract test and `docs/**` (including the append-only
`docs/CLI-COORDINATION.md`, never run through Prettier). No lane edits `src/core/scanner/**`,
`src/decoders/band-defaults.ts`, `src/decoders/band-region.ts` or the scanner band-plan files.
Every lane runs its touched tests, `pnpm run typecheck` and `pnpm run lint` (and `make chan-test`
when it touches Rust) before reporting, and lists every golden it changes with the requirement
that changes it. Live steps are run by Main only, on the local USB dongle (L) and on the current
network receiver, rtl_tcp at 1.024 Msps over Wi-Fi (W).

Parallelism: after 0.1, lanes CM, PL, EF, CH, RP and MG run in parallel (disjoint files below);
MG integrates against the contract with fakes of the CM, PL and EF modules; MA.1 composes the
merged lanes. ID-F tasks wait for the identify work that owns `src/core/scanner/**`.

| Lane | Files (exclusive)                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CM   | `src/decoders/enablement/{catalogue,mode,binary}.ts`; `src/decoders/settings/{layers,patch-policy,service,store}.ts`; `src/decoders/options/{dsd-fme,multimon-ng,direwolf}.ts`; their tests         |
| PL   | `src/decoders/enablement/{placement,channel-sources}.ts`; `src/decoders/{base-decoder,audio-demod-decoder,iq-decimate-decoder}.ts`; `src/decoders/builtin/{readsb,lora-meshtastic}.ts`; their tests |
| EF   | `src/decoders/enablement/{efficiency-gate,efficiency-monitor}.ts`; `src/core/source-fanout-router.ts`; their tests                                                                                  |
| CH   | `native/wavekit-chan/src/**`; `src/core/channelizer/{protocol,channelizer-process,channelizer-manager}.ts`; their tests                                                                             |
| RP   | `src/core/{rate-policy,link-advisory,tuner-controller,resource-aggregator}.ts`; `src/api/routes/tuner.ts`; their tests                                                                              |
| MG   | `src/decoders/{manager,manager-options,types}.ts`; `src/api/serializers/decoder-status.ts`; `src/api/routes/decoders.ts`; their tests                                                               |

- [ ] 0.1 Freeze the contract (Main seams): api-types additions and widened unions; config keys
      (`decoders[].mode`, `decoderPolicy`, `channelizer.auto`, all optional with no default
      filled in); `src/decoders/enablement/contract.ts` and `src/core/rate-policy-contract.ts`
      with every constant of the design table; Fastify reason enum and status fields; CLI alert
      guard and reason words; `tests/unit/decoders/decoder-enablement-contract.test.ts` pinning
      constants with their arithmetic, unions, the parsed shipped config unchanged and every
      catalogue default config free of option issues.
  - _Requirements: 1.7, 2.4, 4.5, 6.5, 7.2, 11.1, 11.2_
  - Live (Main): none (no runtime change).

## Lane CM: catalogue and mode

- [ ] CM.1 `buildDecoderCatalogue`, `isCatalogueConfig`, `resolveDecoderBinary`.
  - _Requirements: 1.1, 1.2, 1.4 to 1.6_
  - **Property 1: Catalogue completeness**
  - Live (Main): L and W, shipped config plus sources only: nine decoders listed, ids equal to
    types; a missing binary shows `decoder-unavailable`; config export unchanged.
- [ ] CM.2 `resolveDecoderMode`; store, patch policy, view and service `mode` with the
      `applyDecoderMode` port call; `channelsHz` option descriptors. (The settings PATCH route
      shape check in `src/api/routes/decoders.ts` accepting `mode` is MG.1's.)
  - _Requirements: 2.1 to 2.6_
  - **Property 2: Mode precedence**, **Property 12: Live mode**
  - Live (Main): L, protected mode: PATCH readsb `off`, `always`, `auto`; each applies within one
    evaluation and survives a core restart.

## Lane PL: placement planner

- [ ] PL.1 `planPlacements` with reach rules, per-type channels, ordering, `always` fallback and
      multi-source binding (fake sources).
  - _Requirements: 3.1 to 3.3, 3.6, 3.7, 3.9, 8.1 to 8.5_
  - **Property 4: Reach is honest**, **Property 11: One instance per channel**,
    **Property 3: Always skips only the band** (planner half)
  - Live (Main): none alone (verified in MG.1).
- [ ] PL.2 VFO and band-plan channel sources; `reach()` hook on the bases, readsb and LoRa.
  - _Requirements: 3.4, 3.5, 3.10_
  - **Property 5: Channel sources**, **Property 13: VFO follows** (planner half)
  - Live (Main): L, operator band plan with one POCSAG channel in the window: multimon-ng lists
    the band-plan placement and the VFO placement.

## Lane EF: efficiency gate

- [ ] EF.1 Gate decision core: budget, CPU, drop and clear windows, probation, retry backoff;
      safe on unknown.
  - _Requirements: 4.1 to 4.4, 4.6, 4.8_
  - **Property 6: No eviction**, **Property 7: Budget bound**,
    **Property 8: Unknown is never drop-free**
  - Live (Main): none alone (verified in MG.2).
- [ ] EF.2 Monitor (per-source branch telemetry accessor in `source-fanout-router.ts`, CPU meter
      sample, 2 s tick) with a unit bench under the design's budget.
  - _Requirements: 4.1, 4.5, 4.6_
  - Live (Main): L, `GET /api/decoders/efficiency` matches `ps` and the fanout counters for
    10 minutes.

## Lane CH: in-place channel retune

- [ ] CH.1 `retune` request in the engine protocol and `wavekit-chan` (phase-continuous NCO, same
      taps and output rate, refused outside admission); chunk-split invariance and
      retune-equivalence tests; bench before and after.
  - _Requirements: 5.5_
  - **Property 13: VFO follows** (engine half)
  - Live (Main): L, drag the VFO across a DMR channel: dsd-fme keeps its pid and decodes after
    the settle time.

## Lane RP: rate policy and link advisory

- [ ] RP.1 `createRatePolicy` and the tuner controller `beforeOperatorRetune` hook; operator rate
      write clears the record; `tuner:rate-policy` event and `TunerState.ratePolicy`.
  - _Requirements: 6.1 to 6.6, 10.1_
  - **Property 9: Raise and restore**
  - Live (Main): L at 2.048 Msps: tune to 1 090 MHz, rate becomes 2.4 Msps and readsb decodes;
    tune to 162 MHz, rate returns to 2.048 Msps. W with SDR++ on the relay: tuning to 1 090 MHz
    from SDR++ writes nothing and emits `skipped` / `external-control`.
- [ ] RP.2 `createLinkAdvisor`; `link-capacity` alert in the resource aggregator; a periodic
      re-check after a raise (about 10 s, then while raised) that reports `dropping` when the
      link falls short. Main feeds `observe` from the source metrics and `reset` on reconnect (MA.1).
  - _Requirements: 7.1 to 7.3_
  - **Property 10: Link advisory**
  - Live (Main): W at 1.024 Msps via REST: tune to 1 090 MHz, advisory `unproven`, then
    `dropping` if the link falls short; L reports `none`.

## Lane MG: manager integration

- [ ] MG.1 Mode in eligibility and `startAll`; primary plus placement workers (owner
      `placement`, hidden, output under the parent id with placement frequency, prefixed log
      lines); evaluation triggers; `placements[]`, `mode`, `origin` in the status; reason
      precedence; the settings PATCH route accepts `mode`; an operator start re-checks a
      missing binary.
  - _Requirements: 1.3, 1.6, 2.1, 2.5, 3.1, 3.7 to 3.9, 8.3, 11.3, 11.4_
  - **Property 3: Always skips only the band** (manager half)
  - Live (Main): L at 162.0 MHz with the channelizer enabled: AIS, dsd-fme (VFO) and
    multimon-ng (VFO) run as placements; Activity shows one decoder each.
- [ ] MG.2 Gate in the caps worker; channelizer auto start and idle stop; catalogue channel
      types without a channelizer report `channelizer-unavailable`, YAML ones keep the raw path;
      `GET /api/decoders/efficiency`.
  - _Requirements: 4.1 to 4.3, 4.7, 5.1 to 5.3_
  - **Property 6: No eviction**, **Property 7: Budget bound** (integration tests with fake
    monitor samples)
  - Live (Main): L with `cpuBudgetCores` lowered to 0.5 at 869.525 MHz: LoRa and dsd-fme shown
    `efficiency-budget` (`budget`); nothing restarts in a loop.

## Main

- [ ] MA.1 Wiring (Main seams): catalogue before the settings service and decoder creation;
      gate, monitor, planner sources (live demodulator, band-plans service), CPU meter, rate
      policy and link advisor in `src/index.ts`; `tuner:rate-policy` forwarding and the
      efficiency route in `src/api/server.ts`; `config/default.yaml` documents `mode`,
      `decoderPolicy` and `channelizer.auto`.
  - _Requirements: 1.1, 1.3, 2.4, 6.5, 7.2_
- [ ] MA.2 Docs: `docs/API.md` (mode, placements, efficiency route, reasons, rate policy event,
      link alert); band-plans requirement 1.2 amendment note (3.10); web-gaps-8 requirement 1.5
      note (2.5); `docs/CLI-COORDINATION.md` announcement of the widened unions (append only);
      `docs/ROADMAP.md` status.
  - _Requirements: 3.10, 11.2_
- [ ] MA.3 Checkpoint: full root suite, typecheck, lint, `make chan-test`; every lane golden
      change reviewed against the Defaults paragraph.
- [ ] MA.4 Capacity acceptance on the desktop reference and a Pi 4-class host (requirement 5.4);
      record in `docs/engineering/`; flip `CHANNELIZER_AUTO_ACCEPTED` in the same commit only if
      it passed.
  - _Requirements: 5.2, 5.4_
- [ ] MA.5 Live acceptance (requirement 12.2) on L, then the W checks of RP.1 and RP.2.
  - _Requirements: 12.1, 12.2_

## Dependent follow-ups (identify work, `src/core/scanner/**`)

- [ ] ID-F.1 Verify that priors are clamped above 0 and only user-typed protocol lists bound
      trials (delivered by the identify work); add the property test if missing.
  - _Requirements: 9.1_
  - **Property 14: Identify is never excluded by priors**
  - Live (Main): L, identify an analog FM signal inside a band plan range that does not list
    `analog-fm`: the analog trial runs.
- [ ] ID-F.2 Temporary channelizer probe for AIS, ACARS, VDL2 and LoRa on a detected signal
      anywhere in the window, within the probe pool budget.
  - _Requirements: 9.2_
  - Live (Main): L, identify an AIS burst with ais-catcher `off`: identify names AIS.
- [ ] ID-F.3 Scanner status `channelizerAvailable` reports a running auto-started engine.
  - _Requirements: 5.2_

## Suspension follows the band amendment — 2026-10-25

- [ ] SB.0 (Main, prerequisite of SB.1) Widen `DecoderSuspensionReasonCode` in
      `packages/api-types` with `capture-too-narrow` (shared seam, Main only), with the Fastify
      schemas, the CLI guards, the web reason words and the coordination note.
  - _Requirements: 3.14, 11.2_
- [ ] SB.1 (after SB.0) Planner `capture-too-narrow` reason; manager keeps the 11.3 precedence
      and passes planner reasons through; `since` per 3.15. SB.1 is not complete until SB.0 has
      landed.
  - _Requirements: 3.13, 3.14, 3.15, 11.3_
  - **Property 16: Suspension equals the band verdict after settle**
  - Live (Main): none alone (verified in SB.4).
- [ ] SB.2 rtl_433 channel by the design arithmetic; `-s` equals the realised rate; restart on a
      rate change, in-place retune on a centre move (deterministic tests for both).
  - _Requirements: 3.16_
  - **Property 17: The rtl_433 channel fits**
- [ ] SB.3 LoRa regional slots (EU 868 and 433) as centre-reach candidates with placement options.
  - _Requirements: 3.17_
  - Live (Main): L, tune near the EU 433 LoRa default channel: the LoRa placement appears.
- [ ] SB.4 Scripted acceptance with a fake source: out, in, out, in for every decoder kind,
      reconnect at a new centre, manager restart while in band; then the live step of 3.17 on W.
  - _Requirements: 3.13 to 3.17, 12.1_
