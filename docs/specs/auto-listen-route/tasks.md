# Auto listen route tasks

Status: not started (2026-10-24). See [requirements](requirements.md) and [design](design.md).

Tasks run in order; each lands with its tests, `pnpm run typecheck` and `pnpm run lint`.
Property tests carry `// Feature: auto-listen-route, Property N: <name>` and `numRuns ≥ 100`.
No task edits `src/core/evidence-squelch/**`, `src/core/analog-transmission.ts`, `src/index.ts`,
`src/config.ts`, `src/api/server.ts` or `config/*.yaml`; the `src/index.ts` seam is applied by the
maintainer from the design (MAIN-NEEDED). Tests are in-process only.

- [ ] 1. Contract, resampler and FIFO
  - `packages/api-types/src/live-audio.ts`: `LIVE_AUDIO_AUTO_ROUTE_*` constants,
    `LiveAudioAutoRouteSource`, `LiveAudioAutoRoute`, `LiveAudioAutoRouteLevel`, optional
    `autoRoute` on `LiveDemodStatus` and `LiveAudioLevel`
  - `src/core/auto-listen/contract.ts`: `VoiceTapFrame`, `VoiceTapSource`, `VoiceCoveragePort`,
    `AutoRouteClock`, `AUTO_ROUTE_STREAM`
  - `src/core/auto-listen/resampler.ts` (`PolyphaseResampler`),
    `src/core/auto-listen/source-fifo.ts` (`SourceFifo`, per-sample flags),
    `src/core/auto-listen/preroll-shadow.ts` (`PreRollShadow`)
  - Tests: `tests/unit/core/auto-listen/contract.test.ts` (values,
    `PREEMPT_MAX_MS === LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS`),
    `tests/unit/core/auto-listen/resampler.test.ts`, `tests/unit/core/auto-listen/source-fifo.test.ts`,
    `tests/unit/core/auto-listen/preroll-shadow.test.ts` (against the real `PreRoll`),
    allocation check (no new `Buffer`, typed array or view in the DSP paths after warm-up;
    the budgeted exceptions of design "Allocation guarantee" excluded)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.6, 3.7, 6.1, 6.2, 7.3_
  - **Property 1: Chunk-split invariance** (resampler, FIFO)
  - **Property 2: Resampler response**
  - **Property 9: Pre-roll shadow equivalence**, **Property 15: Shadow from any start**

- [ ] 2. Router
  - `src/core/auto-listen/inputs.ts` (`AnalogInput`, `VoiceInput`),
    `src/core/auto-listen/router.ts` (`AutoListenRouter`: pacer, selection, release, preemption,
    catch-up, bounded pacing and rebase, admission versus drain, invalidation, fresh output
    blocks, underruns, resets, status, level, `auto-route-changed`)
  - `tests/bench/auto-listen-route.bench.ts` (not collected as `*.test.ts`; run with
    `pnpm exec vitest bench`): desktop figures at NFM rates for 2.048 and 2.4 Msps and at 200 kHz
  - Tests: `tests/unit/core/auto-listen/router.test.ts`,
    `tests/unit/core/auto-listen/router.property.test.ts` with a fake voice source, fake coverage
    and injected clock
    including a delayed-drain regression test (a fake socket that withholds drain for seconds)
  - _Requirements: 2.6, 2.7, 2.8, 3.2, 3.4, 3.5, 4.1 to 4.11, 5.1, 5.2, 6.4, 8.1, 8.2_
  - **Property 3: Bounded pacing**, **Property 4: No doubled audio**, **Property 5: No loss
    inside an over**, **Property 6: Priority and bound**, **Property 7: Catch-up only on
    silence**, **Property 10: Encryption**, **Property 11: Several decoders**, **Property 12:
    Coverage**, **Property 14: Output blocks are immutable**, **Property 16: Digital
    tail**

- [ ] 3. Wiring and API
  - `src/core/live-demodulator.ts`: router construction, `/auto` in `resolveRoute`, sample-aligned
    analog spans at the three client-write sites, `PreRollShadow` calls next to each pre-roll
    call with the shadow built, cleared and dropped with the pre-roll (tracking with or
    without `/auto` clients), `resetAnalog` next to the evidence resets, `autoRoute` on status and level,
    `attachAutoRouteVoice` (coverage `generation` port, cached `covers`)
  - `src/core/digital-voice.ts`: `addVoiceTap`, `voiceSampleRate`, ingest condition and
    `frame` call, `call` notifications from `handleVoiceCall`, `detach` from `removeChannel`,
    `stop` and `destroy` (own stream unchanged)
  - `src/api/routes/live-audio.ts`: `autoRoute` in `liveDemodStatusSchema` and
    `toApiLiveDemodStatus` (legacy URL rewrite)
  - `docs/API.md`: `/auto`, `/auto.wav` and the `autoRoute` status and level fields
  - Tests: `tests/unit/core/live-demodulator-auto-route.test.ts` (route, access parity with
    `/stream`, client kept across restart and rate change, goldens for `/stream`, chunks spanning
    open, close, tone-slice changes and the final pre-roll drain),
    `tests/unit/core/digital-voice-tap.test.ts` (own stream byte-identical with a tap; clear then
    encrypted with audio queued and no further datagram; detach),
    `tests/unit/api/live-audio-auto-route.test.ts` (schema keeps `autoRoute`)
  - _Requirements: 1.1 to 1.5, 3.1, 3.3, 6.1 to 6.3, 7.1, 7.2_
  - **Property 8: Analog equals `/stream`, sample-aligned**, **Property 13: Existing streams
    unchanged**

- [ ] 4. Acceptance (checkpoint)
  - `tests/unit/core/auto-listen/acceptance.test.ts`: the in-process fake-link fixture of
    design "Fake-link acceptance plan" (analog over, then DMR over, on one channel; plus 9.2)
  - Report the MAIN-NEEDED `src/index.ts` seam from the design for the maintainer to apply, then
    the live test plan
  - _Requirements: 9.1, 9.2, 9.3_
