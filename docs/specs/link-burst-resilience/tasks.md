# Link burst resilience tasks

Status: contract frozen (0.1, 2026-10-22). See [requirements](requirements.md) and
[design](design.md). The step-by-step plan is
[2026-10-22-link-burst-resilience](../../superpowers/plans/2026-10-22-link-burst-resilience.md).

Lanes work against the frozen contract (0.1) and touch only their own paths. Main (M.\*) owns
the composition files (`src/index.ts`, `src/api/server.ts`, `src/config.ts`, `config/*`), the
contract files (`packages/api-types/**`, `src/core/link-burst/contract.ts`,
`src/decoders/enablement/contract.ts`) and the build files. Every lane runs its touched tests,
`pnpm run typecheck` and `pnpm run lint` before reporting. Live steps are run by Main only.

| Lane | Files (exclusive)                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AB   | `src/core/link-burst/absorber.ts`; `src/core/fanout-manager.ts`; `src/core/source-fanout-router.ts`; their tests                                                                                                                                                                          |
| IR   | `src/core/link-burst/{recorder,loop-meter,link-quality}.ts`; `src/core/link-advisory.ts`; `src/core/resource-aggregator.ts`; `src/api/routes/resources.ts`; the SDR host poller; their tests                                                                                              |
| AG   | `src/decoders/enablement/{attribution,efficiency-monitor,efficiency-gate}.ts`; `src/decoders/manager.ts` (verdict detail and running placement fields only); the efficiency schemas; their tests                                                                                          |
| FL   | `scripts/capacity/fake_rtl_tcp.py`; `scripts/link-burst/**`; `scripts/bench/burst-absorber.ts`                                                                                                                                                                                            |
| HD   | `src/core/tuner-capabilities/provider.ts`; `packages/sdr-host/src/**` (status field only); `docs/specs/decoder-enablement/{requirements,design}.md`; this spec's `design.md` (erratum only); `docs/specs/README.md`; `docs/API.md`; `docs/CLI-COORDINATION.md` (append only, no Prettier) |

## Contract

- [x] 0.1 Freeze the contract: DTOs, `burstAbsorber` and `delivery` config, constants, port
      interfaces and contract tests
  - _Requirements: 1.9, 2.1, 2.2, 5.5, 7.1-7.3, 8.1, 8.2_

## Lane AB: absorber

- [ ] AB.1 FanoutManager seams (read-only congestion view, public `distribute`) and the
      backpressure oracle
  - _Requirements: 1.1-1.9_
- [ ] AB.2 BurstAbsorber with held-duration and laggard-exclusion figures
  - _Requirements: 1.1-1.9, 8.3, 9.2_
- [ ] AB.3 Router wiring and the `@absorber` drop counter
  - _Requirements: 1.1-1.9_

## Lane IR: instrumentation and reporting

- [ ] IR.1 IngestRecorder (gap, chunk-size and catch-up histograms) and EventLoopMeter
      (`report()` never resets)
  - _Requirements: 2.1, 2.2_
- [ ] IR.2 SDR host link facts and `iqDelivery` in the poller and its response schema
  - _Requirements: 8.1_
- [ ] IR.3 LinkQuality, the route and the WebSocket event
  - _Requirements: 2.1-2.3, 6.1-6.3, 6.5, 6.6, 8.1_
- [ ] IR.4 Link advisory: shortfall, link hold, burst summary, per-tick re-check
  - _Requirements: 6.1-6.6_

## Lane AG: attribution and gate

- [ ] AG.1 `attributeInterval`
  - _Requirements: 3.1-3.8_
- [ ] AG.2 EfficiencyMonitor attribution, link path and late windows
  - _Requirements: 3.1-3.8, 4.1-4.6, 5.1-5.5, 8.3_
- [ ] AG.3 Gate: link admission wait, late shedding and the rate-limited held warning
  - _Requirements: 4.1-4.6, 5.1-5.6, 8.3_
- [ ] AG.4 Manager and efficiency schemas
  - _Requirements: 5.1-5.5, 8.1, 8.3_

## Lane FL: fake link and benches

- [ ] FL.1 Stall schedule in the fake `rtl_tcp`
  - _Requirements: 9.1, 9.3_
- [ ] FL.2 Scratch compose project, slow-sink consumer and acceptance driver
  - _Requirements: 9.1-9.3_
- [ ] FL.3 Absorber and recorder bench (after AB.2 and IR.1 merge)
  - _Requirements: 9.4_

## Lane HD: delivery hook and docs

- [ ] HD.1 `iqDelivery` in receiver capabilities and the SDR host
  - _Requirements: 7.1-7.3_
- [ ] HD.2 Decoder-enablement amendments, design erratum, spec index, API docs, coordination
      note
  - _Requirements: 8.1, 10.1_

## Main

- [ ] M.1 Composition (after AB, IR, AG and HD merge)
  - _Requirements: 2.2, 5.5, 6.4_
- [ ] M.2 Fake-link acceptance
  - _Requirements: 9.1-9.4_
- [ ] M.3 Instrumentation record and default flip
  - _Requirements: 2.3_
- [ ] M.4 Live soak
  - _Requirements: 9.5_
- [ ] M.5 Pi 4-class CPU and memory measurement
  - _Requirements: 9.4_
