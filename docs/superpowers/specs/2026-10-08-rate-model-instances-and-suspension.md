# Rate model addendum: per-instance declarations and reversible suspension

Status: implementation-ready design addendum, 2026-10-08. Extends the
[sample-rate contract](2026-10-08-sample-rate-and-channelizer-design.md) and
honours the [research review](../../REVIEW-2026-10-08-CHANNELIZER.md). Every
fact below is derived from the code at `a63b70b`..`0ec58f4`; line numbers cite
that tree. Nothing here changes the channelizer plan. No fixture-verified RF
operating point exists yet, so no declaration below uses basis `verified-rf`.

## 1. Adapter facts per built-in instance

All stdin pipelines assume the fanout delivers CU8 IQ (`csdr convert -i char`,
`src/decoders/iq-decimate-decoder.ts:173`, `audio-demod-decoder.ts:222`). The
manager injects `inputSampleRate`/`inputCenterFreq` from source caps before each
wire and on every caps change (`src/decoders/manager.ts:676-684`, `905-912`), so
the per-decoder defaults (2 048 000 or 2 400 000) only apply when no source caps
exist. `fs` below is that injected source rate.

| Instance (mode) | Base / adaptation | Frontend rate delivered | Program stdin | Citations |
|---|---|---|---|---|
| readsb, stdin (`rtlTcpHost` unset) | `NetworkProducerDecoder`; sox resample unless `fs === 2 400 000` | exactly 2 400 000 | IQ UC8 at 2 400 000 (`--iformat UC8`, no rate arg) | `readsb.ts:155-166, 189-196` |
| readsb, `rtlTcpHost` set | spawns `readsb --device-type rtltcp`; owns its stream | n/a (not derived from the core source) | none | `readsb.ts:141, 172-187` |
| ais-catcher | `IqDecimateDecoder` exact: sox to 384 000 unless equal | exactly 384 000 | IQ CU8 384 000 (`-s 384000`) | `ais-catcher.ts:178-186, 204-209`; `iq-decimate-decoder.ts:134-142` |
| dumpvdl2 | exact: sox to `targetSampleRate` (default 1 050 000, must be a multiple of 105 000) | exactly target | IQ U8 at target, `--oversample target/105000`, `--centerfreq inputCenterFreq ?? frequencies[0]` | `dumpvdl2.ts:168-175, 194-203` |
| rtl_433 | integer: `k = round(fs/target)`, `k<1 → 1`; actual `fs/k`; decoder told the actual rate | 2 048 000→1 024 000 (k=2); 2 400 000→1 200 000; target 250 000: 2 048 000→256 000 (k=8), 2 400 000→240 000 (k=10) | IQ cu8 at actual (`-s effectiveTargetRate`) | `rtl433.ts:73-81, 147-151`; `iq-decimate-decoder.ts:146-164` |
| lora-meshtastic | exact: sox to `bw × oversampling` (LongFast 250 000×8 = 2 000 000; LongSlow 1 000 000; VeryLongSlow 500 000) | exactly `bw×os`; 2 048 000 is *down*sampled by 1.024 | IQ cu8 at `bw×os` (`--samp-rate`) | `lora-meshtastic.ts:128-133, 300-301, 324-331` |
| multimon-ng | `AudioDemodDecoder` integer: `k = round(fs/48 000)`; FM demod at `fs/k`; sox always to 22 050 | 2 400 000→48 000 (k=50); 2 048 000→47 627.9 (k=43) | PCM S16LE mono 22 050 | `multimon-ng.ts:186-217`; `audio-demod-decoder.ts:175-187, 297-310` |
| direwolf | same base, demod 48 000; sox only when `fs/k ≠ 48 000` | as multimon | PCM S16LE 48 000 (`-r 48000`) | `direwolf.ts:177-186, 211-212` |
| dsd-fme | own `buildPipelineCommand`, same `round`, sox WAV wrapper always | as multimon | WAV/S16LE 48 000 via `sox -t wav` | `dsd-fme.ts:560-571, 617-628` |
| acarsdec | same base, AM, demod 24 000; sox to 12 000 | 2 400 000→24 000 (k=100); 2 048 000→24 094.1 (k=85) | PCM S16LE 12 000 (`-m 1`) | `acarsdec.ts:127-138, 160-171` |
| LiveDemodulator (not a decoder) | integer `round(fs/(2·bw))`, clamped ≥1 | reported in status | audio clients | `src/core/live-demodulator.ts:380-397` |

No built-in extends `ExternalSdrDecoder` any more; acarsdec and dumpvdl2 consume
the shared source. Only readsb in `rtlTcpHost` mode owns its input.

Requested-vs-delivered discrepancies and silent low-rate misbehaviour:

1. **`firdecimate 0` / `-r Infinity`.** `audio-demod-decoder.ts:182` and
   `dsd-fme.ts:568` do not clamp `round(fs/demodRate)`; for `fs < demodRate/2`
   (24 000 Hz, or 12 000 Hz for acarsdec) the shell pipeline is invalid and the
   process exits, entering the restart/backoff loop. `iq-decimate-decoder.ts:149`
   and `live-demodulator.ts:391` already clamp. Fix in batch 1 regardless of
   suspension.
2. **Audio demod below the demod rate** (`demodRate/2 ≤ fs < demodRate`): k=1,
   the demodulator runs at `fs` and sox upsamples; the pipeline "works" but the
   configured channel bandwidth is not realised. This is an adapter fact, used
   as the only audio-family capture minimum below.
3. **readsb rtlTcpHost mode still gets a fanout branch.** `caps.input` is
   `"iq"` (`readsb.ts:267`) so `wireDecoderToFanout` assigns a source and pipes
   IQ into stdin that readsb ignores (`manager.ts:661, 697-702`). The rate model
   must classify this mode as `external`; the wasted branch is a separate fix.
4. **Default rate drift.** readsb defaults to 2 048 000 (`readsb.ts:159`),
   audio demods to 2 400 000, iq-decimate to 2 048 000. Harmless while caps are
   injected, but `config.inputSampleRate || DEFAULT` (`iq-decimate-decoder.ts:132`,
   `audio-demod-decoder.ts:181`) silently treats `0` as "default".
5. **Source format is unchecked.** Pipelines assume CU8; `SourceCaps.format` may
   be `S16_IQ`/`FLOAT32LE`/`auto` (`src/config.ts:14-21`). The manager restarts
   on format change (`manager.ts:884-889`) but nothing validates it. Out of
   scope here; noted as a follow-up for a `capture.formats` field.
6. **Hard-coded passive list.** `manager.ts:890-901` names the types whose
   centre-only retune must not restart them. dumpvdl2 is correctly absent (it
   always bakes `inputCenterFreq` into `--centerfreq`, `dumpvdl2.ts:200-203`),
   but the list is a type string table rather than a decoder-declared fact; a
   later cleanup can move it behind `getRateAdapter`-style introspection.

## 2. Declarations and runtime context

### 2.1 Interface additions (`src/decoders/types.ts`)

```ts
interface Decoder {
	// existing members unchanged
	/** Instance requirements; falls back to registry caps.rateRequirements. */
	getRateRequirements?(): DecoderRateRequirements | undefined
	/** Actual adapter output for a candidate source rate; pure, no spawn. */
	getRateAdapter?(input: { sampleRateHz: number }): DecoderRateContext["adapter"]
}
```

Both are optional so custom decoders stay `unknown`. The candidate rate is a
parameter so the manager can preview without `updateOptions()`.

### 2.2 Pure functions and placement

- `audio-demod-decoder.ts`: `export function audioDemodRateAdapter(config: DemodulationConfig, stdin: { format: string; rateHz: number }, fs: number)` returning `{ adaptation: "integer-decimation", frontendRateHz: fs / max(1, round(fs / demodRate)), decoderInputKind: "audio_pcm", decoderInputRateHz: stdin.rateHz, decoderInputFormat: stdin.format }`. `buildPipelineCommand` must call the same helper for `decimation`/`actualDemodRate` so the pipeline and the report cannot diverge. dsd-fme's override uses it too.
- `iq-decimate-decoder.ts`: `export function iqDecimateRateAdapter(config: IqDecimationConfig, fs: number)` returning `adaptation: fs === target ? "none" : (exact ? "resample" : "integer-decimation")`, `frontendRateHz` = target (exact) or `fs / max(1, round(fs/target))`, `decoderInputKind: "iq"`, `decoderInputRateHz` = frontend, `decoderInputFormat: "cu8"`. `buildPipelineCommand` and `rtl433.calculateEffectiveTargetRate` call it.
- `readsb.ts`: `readsbRateAdapter(options, fs)`: `undefined` in rtlTcpHost mode; otherwise `{ adaptation: fs === 2 400 000 ? "none" : "resample", frontendRateHz: 2 400 000, decoderInputKind: "iq", decoderInputRateHz: 2 400 000, decoderInputFormat: "uc8" }`.
- Each builtin implements `getRateAdapter(input)` by building its config with `inputSampleRate: input.sampleRateHz` and calling the helper; `getRateRequirements()` returns the constants below (LoRa derives from options).
- `registry.register()` (`registry.ts:69-83`) validates `caps.rateRequirements` with `validateDecoderRateRequirements`; `DecoderManager.createDecoder` validates the instance declaration and throws `ConfigValidationError` on failure.

### 2.3 Declarations (`sourceKind: "iq"` unless stated; `version: 1`)

| Instance | capture | frontendIq | decoderInput | Verdicts |
|---|---|---|---|---|
| readsb stdin | omitted (no evidence for a floor; see contract table) | preferred 2 400 000, accepted discrete [2 400 000] | iq, `uc8`, 2 400 000 | always `unknown` + observed rates |
| readsb rtlTcpHost | — | — | sourceKind/decoderInput `external` | `unknown`/`external-input`; never gated |
| ais-catcher | omitted | 384 000 discrete | iq, `cu8`, 384 000 | `unknown` + observed |
| dumpvdl2 | omitted (channel-span floor is a follow-up once pinned dumpvdl2 out-of-band behaviour is checked) | preferred `target`, accepted range min 105 000 step 105 000 | iq, `u8`, same | `unknown` + observed |
| rtl_433 | omitted | omitted (actual rate varies with `round`) | iq, `cu8`, preferred `target`, accepted omitted | `unknown` + observed |
| lora-meshtastic | accepted range `minHz: bw`, preferred `[bw×os]`, minimum `{ hz: bw, basis: "implementation", evidence: "Complex capture span equals the sample rate; the LoRa signal occupies bw Hz (lora-meshtastic.ts:128,133). Nyquist bound, not an RF-verified operating point." }` | preferred `bw×os`, discrete | iq, `cu8`, `bw×os` | best at `fs === bw×os`, acceptable above `bw`, unusable below |
| multimon-ng / direwolf / dsd-fme | accepted range `minHz: 48 000`, preferred `[2 400 000]`, minimum `{ hz: 48 000, basis: "implementation", evidence: "audio-demod-decoder.ts:182-187: below the demod rate the integer decimator is 1, the demodulator runs at the source rate and sox upsamples, so the 48 000 Hz demod bandwidth is not realised." }` | omitted (actual `fs/k` lies in [36 000, 72 000) for any `fs ≥ 48 000`; sox normalises it) | audio_pcm `s16le` 22 050 / `s16le` 48 000 / `wav-s16le` 48 000 | best at 2 400 000 (k=50 exact), acceptable at 2 048 000, unusable below 48 000 |
| acarsdec | as above with 24 000 and preferred `[2 400 000]` | omitted | audio_pcm `s16le` 12 000 | best at 2 400 000, acceptable at 2 048 000, unusable below 24 000 |

Legacy `preferredSampleRates` stays untouched and is never read by the resolver.
"Preferred" above is strictly "adapter runs without sox or with an exact integer
factor"; it says nothing about RF. The readsb 2.0 Msps floor, AIS span, VDL2
channel span and rtl_433 protocol needs remain evidence gaps, so those instances
report `unknown` with observed rates until fixtures exist.

### 2.4 Runtime computation

`DecoderManager.assessState(state, capsOverride?)`:

```ts
const caps = capsOverride ?? state.inputCaps ?? this.sourceCapsFor(state)
const req = state.decoder.getRateRequirements?.() ?? state.decoder.caps.rateRequirements
const adapter = caps ? state.decoder.getRateAdapter?.({ sampleRateHz: caps.sampleRate }) : undefined
return assessDecoderRate(req, {
	...(caps ? { source: { kind: caps.kind === "recording" ? "iq" : caps.kind, rateHz: caps.sampleRate } } : {}),
	...(adapter ? { adapter } : {}),
})
```

`sourceCapsFor(state)` resolves `config.sourceId ?? sourceRouting.getDefaultSourceId()`
through `sourceManager.getCaps` (`manager.ts:669-677`). A `recording` source is
treated as IQ (its pipelines are the IQ ones). `getStatus()` returns the cached
`state.ratePlan` (recomputed on wire, caps change, connect/remove and explicit
start), never recomputing on the REST path.

## 3. Where the source rate comes from

- **Truth today:** `SourceConfig.caps.sampleRate` (required positive int,
  `src/config.ts:16`), read via `SourceManager.getCaps` (`source-manager.ts:1284`).
  It is a *declared* rate; rtl_tcp has no readback and sdrpp-network/recording
  sources are never corrected at runtime.
- **Writers:** `TunerController.setSampleRate` (REST `POST /api/tuner/:id/sample-rate`,
  `tuner-controller.ts:465-473`, range 225 001–3 200 000 at `:25` — a
  pre-existing bug: librtlsdr rejects 300 001–900 000 Hz, valid RTL2832 rates
  are 225 001–300 000 and 900 001–3 200 000, yet accepted gap rates feed caps
  and reconnect replay; B1 and the rate preview must reject them); relay
  external command `0x02` reaches `updateSourceCaps` twice — `index.ts:667-673`
  and `applyExternalCommand` (`tuner-controller.ts:281-290`); the second is a
  no-op thanks to the identical-caps guard (`source-manager.ts:1316-1321`).
  `sdr-host-poller` never updates caps.
- **Unknown when:** no source manager/routing (tests), decoder selects a source
  id that does not exist, or no default source. Never "unknown" merely because
  the hardware has not acknowledged.
- **Propagation:** `updateSourceCaps` → `caps-changed` → `DecoderManager`
  (debounced 300 ms, serial `drainCapsChanges`, latest caps per source win —
  `manager.ts:807-843`), `LiveDemodulator` (`live-demodulator.ts:328`) and the
  `sources` WS channel (`index.ts:676`). `connected` → ownership re-assignment
  for wired decoders (`manager.ts:768-795`); `removed` → router detaches the
  fanout (`source-fanout-router.ts:29-32`); the manager does nothing on removal.

## 4. Reversible suspension in `DecoderManager`

### 4.1 State (additive fields on `DecoderState`, `manager.ts:60-78`)

```ts
desiredRunning: boolean          // operator intent; set by startDecoder/startAll, cleared by stopDecoder/removeDecoder
ratePlan: DecoderRateAssessment | undefined
suspension: { reasonCode; since: Date } | null
transition: "suspending" | "resuming" | null
rateGeneration: number           // bumped by every evaluation, start, stop, remove
```

`intentionallyStopped` keeps its exact current meaning (suppresses auto-restart)
and remains the inverse of `desiredRunning` except during `restartDecoder`'s
stop→start window; `assignedSourceId`/`inputCaps` are unchanged. The existing
`stopRevision` and `destroying` checks stay where they are.

### 4.2 Primitives

- `suspend(state, plan)`: `gen = ++state.rateGeneration`; set `suspension`,
  `transition = "suspending"`, `ratePlan`; `await state.decoder.stop()`;
  then a new `detachBranch(state)` helper — `decoder.detachInput()`,
  `branchFanout.removeBranch(branchId)`, `releaseUnused` — that **must not**
  call `unwireDecoderFromFanout` (it nulls `assignedSourceId`,
  `manager.ts:723`, and the status `sourceId = assignedSourceId ?? config.sourceId`
  would stop reflecting the retained assignment). It **keeps**
  `assignedSourceId` and the `sourceManager.assignDecoder` reservation (spec:
  retain logical ownership; a suspended decoder is never reassigned to another
  radio automatically). An operator who wants the radio for another exclusive
  decoder must explicitly stop/disable the suspended one; the CLI shows the
  reservation as "held by suspended X". Then `transition = null`; publish. If `stop()`
  throws: keep `suspension` and `transition = "suspending"`, log, publish; the
  next evaluation retries. `handleDecoderExit` early-returns when
  `state.suspension !== null`, and that return must sit **before** the
  `lastError` write the CLI-fields branch adds right after the
  `intentionallyStopped` return (`manager.ts` ~602 on that branch); otherwise a
  suspension stop records a spurious `lastError` of kind `"exit"`. No restart is
  scheduled, no budget consumed, no `decoder:max-restarts`, no `faulted`.
- `resume(state, plan)`: `gen = ++state.rateGeneration`; `suspension = null`,
  `transition = "resuming"`, `ratePlan`; `await wireDecoderToFanout(state)`
  (idempotent when the assignment is retained); recheck `gen`, `desiredRunning`,
  `destroying`, map identity; `await decoder.start()`; recheck again — if intent
  changed meanwhile, `await decoder.stop()` + full unwire. On start failure:
  `transition = null`, `createDecoderLastError(err, "error")`, then
  `handleDecoderExit(state, null, null)` — a real spawn failure legitimately
  records `lastError` and uses the existing backoff/budget.
- `evaluate(state, caps | undefined)`: compute plan; `inputChanged` as today
  (`manager.ts:883-889`); dispatch per the table; `ratePlan` always updated;
  publish once per decoder per evaluation through the manager's
  `decoder:status-changed(id)` hook only when the serialized status actually
  changed (repeated identical caps are no-ops).

### 4.3 Transition table

| Current | Event | Plan | Action |
|---|---|---|---|
| idle (not desired) | any caps/connect/remove | any | update `ratePlan`; publish; never spawn |
| idle | `startDecoder` | usable/unknown | existing path (`manager.ts:225-255`), `desiredRunning = true` |
| idle | `startDecoder` | unusable | `desiredRunning = true`, `suspension` set, no spawn, no throw; REST returns 200 with `suspended: true` |
| running | caps unchanged | any | no-op (also covered by `source-manager.ts:1316`) |
| running | caps changed | usable, `inputChanged` or non-passive | existing `restartDecoder` path |
| running | caps changed | usable, passive & unchanged input | option update only (today's behaviour) |
| running | caps changed / connect | unusable | `suspend` |
| running | source removed | — | plan `source-rate-unknown`; keep running (today's behaviour); publish |
| suspended | caps changed / connect | usable/unknown | `resume` |
| suspended | caps changed | unusable (same or different reason) | update reason/plan; publish; stay |
| suspended | source removed | — | stay suspended; plan `source-rate-unknown`; do **not** reassign to another source |
| suspended | `stopDecoder`/disable | — | `desiredRunning = false`, `suspension = null`, full unwire (release reservation); `ratePlan` kept |
| suspended | `removeDecoder`/`destroy` | — | as stop, then delete; in-flight resume aborts on identity/gen check |
| suspended | `startDecoder` (REST start while suspended) | unusable → 200 no-op (intent already recorded); usable → `resume` | — |
| suspending/resuming | newer caps | any | worker is serial: the in-flight transition finishes, rechecks `gen`/latest `inputCaps`, and the loop processes the newer caps next; the newest plan always wins |
| any | `restartDecoder` (REST) | unusable | stop as today; the start half sees unusable → suspended, not spawned |

`unknown` verdicts are usable for lifecycle purposes (absent declaration is not
incompatibility). External-input decoders are never evaluated.

### 4.4 Serialization and races

- All evaluations run inside `drainCapsChanges` (`manager.ts:827-843`), which
  already coalesces per source and runs one transition at a time. `connected`
  and `removed` enqueue through the same map (`pendingCapsChanges.set(id, caps ?? null)`)
  instead of acting inline; `sourceConnectedHandler` keeps its reassignment loop.
- Manual `startDecoder`/`stopDecoder` are not queued behind the worker (as
  today). Safety comes from: (a) `++rateGeneration` in start/stop/remove,
  (b) every `await` in suspend/resume followed by `gen`/identity/intent checks,
  (c) `BaseDecoder.start()` refusing a second spawn (`base-decoder.ts:135`).
  Manual stop racing a resume: the post-start recheck stops the just-spawned
  process. Manual start racing a suspend: start sees `ratePlan` unusable and
  records intent without spawning.
- Failed stop during suspend keeps `transition = "suspending"` visible; the
  process may still be alive, so status must not claim `running: false` is a
  clean suspension — `running` continues to come from `decoder.getStatus()`.
- `handleCapsChange` currently only visits *running* decoders
  (`manager.ts:855-863`); it must visit every decoder selecting the source so
  suspended and idle instances get fresh plans.

## 5. Contract additions

Additive on `DecoderStatus` (`packages/api-types/src/decoders.ts`,
`src/decoders/types.ts`, `decoderStatusSchema` in `src/api/routes/decoders.ts:66-90`,
and the DTO mapper): `desiredRunning: boolean`, `suspended: boolean`,
`suspension?: { reasonCode: DecoderRateAssessment["reasonCode"]; since: string }`,
`transition?: "suspending" | "resuming"`, and `rateAssessment` now carries the
instance plan (fallback object unchanged for custom decoders). Fastify response
schemas must list each field or `fast-json-stringify` strips it.

No separate rate event. The CLI-fields branch already adds `decoder:status` on
the `decoders` channel (data = exactly the `GET /api/decoders/:id` body) fed by
the manager hook `decoder:status-changed(id)`; rate/suspension transitions
publish through that hook so the CLI keeps one event and one reducer. The DTO
mapper is `src/api/serializers/decoder-status.ts` (`toApiDecoderStatus` /
`toApiDecoderInfo`); the shared Fastify property set is
`src/api/routes/decoder-status-schemas.ts` (also reused by `health.ts`) and the
new fields are added there once. Suspension also produces the existing
`decoder:stopped`/`decoder:started` events because the decoders themselves
emit them; `decoder:status` follows with the reason.

Interplay with the concurrent CLI-request fields: `sourceId` on status must
reflect the retained assignment while suspended; `lastError` is not set by a
suspension (it is not an error); `health` is left unchanged by suspend/resume
(no new enum value), so clients should render `suspended` ahead of `health` and
treat `running:false && suspended:true` as expected, unlike the acarsdec
`running:false/health:"running"` anomaly noted in `docs/CLI-COORDINATION.md`.

`POST /api/decoders/:id/start` on an unusable rate returns 200, never 409:
the action response body carries the full status with `suspended: true`,
`suspension { reasonCode, since }` and the current `rateAssessment`, so the CLI
can say "start recorded; waiting for ≥ N Hz" without a second fetch. Intent is
recorded separately from eligibility, matching the base contract.

Preview: `GET /api/decoders/rate-preview?sourceId=<id>&sampleRateHz=<n>` →
`[{ decoderId, assessment }]` using `assessState(state, { ...caps, sampleRate })`
for every decoder selecting that source; pure, no side effects, no tuner write.
The registry endpoint keeps exposing type defaults; instance status is
authoritative.

## 6. Batches and tests

Each batch is independently committable; run `pnpm run typecheck`,
`pnpm exec vitest run tests/unit/decoders tests/unit/api`, and `pnpm run lint`
after each.

**B1 — adapter truth and declarations (no lifecycle change).** Pure helpers in
the two bases and readsb; `buildPipelineCommand` paths call them; clamp the
audio-demod/dsd-fme decimation; optional `getRateRequirements`/`getRateAdapter`
on all nine builtins; registry/create validation; `assessState` and cached
`ratePlan` in `getStatus`. Tests (`tests/unit/decoders/rate-adapters.test.ts`):
table-driven rates for 2 400 000, 2 048 000, 1 024 000, 240 000, 20 000 per
instance asserting frontend/stdin rates and that the generated shell command
contains the same `firdecimate k` / `sox -r` numbers; LoRa floor = bw for every
preset; readsb rtlTcpHost → `external-input`; audio family unusable below
48 000/24 000 with `requirementBasis: "implementation"`; readsb/ais/dumpvdl2/
rtl_433 stay `unknown` with observed rates populated; invalid declarations are
rejected at register/create; `firdecimate 0` regression test at 20 000 Hz;
tuner `VALIDATION.sampleRate` rejects the 300 001–900 000 Hz gap.

**B2 — manager suspension.** State fields, primitives, transition table, worker
changes, `handleDecoderExit` guard. Tests
(`tests/unit/decoders/manager-suspension.test.ts`) with a fake `SourceManager`
(`EventEmitter` + `getCaps/assignDecoder/unassignDecoder/getStatus/getStream`,
after `tests/unit/decoders/source-routing.test.ts`) and a controllable fake
decoder (after `manager-lifecycle.test.ts:16-80`) whose `getRateRequirements`/
`getRateAdapter` return scripted plans and whose `start/stop` can be delayed or
made to throw: low-rate start records intent without spawn; usable→unusable→
usable suspends then resumes with `restartCount` unchanged and no
`decoder:restarting`; repeated identical caps produce no transition and no
event; two caps changes while the stop is pending end in the newest plan with
exactly one spawn; stop failure leaves `transition: "suspending"` and retries on
the next event; start failure on resume schedules the normal backoff; manual
stop during resume ends with no process; manual start during suspend ends
suspended; disable/remove during transition deletes cleanly and later caps do
nothing; source removed keeps a suspended decoder suspended and never assigns a
different source; reconnect resumes; external decoders are never touched.

**B3 — contracts.** api-types fields, `decoder-status-schemas.ts` properties,
`serializers/decoder-status.ts` mapping, `decoder:status-changed` emission on
rate transitions, preview route. Tests: route responses keep every new field
through `fast-json-stringify`; `decoder:status` payload deep-equals the REST
body after a suspend and a resume; preview is pure
(no tuner writes, no caps change); schema fixtures in `tests/unit/api/server.test.ts`.

**B4 — wiring and docs.** `index.ts` broadcaster wiring, `docs/API.md`,
`docs/CLI-COORDINATION.md` announcement of the exact field names before merge,
`config/default.yaml` comments where `inputSampleRate` defaults are implied.

**Sequencing.** B1 touches `audio-demod-decoder.ts`, `dsd-fme.ts` and
`iq-decimate-decoder.ts`, which a concurrent CSDR-buffer agent is also editing
(same pipeline builders). B2/B3 overlap the concurrent agent adding
`DecoderStatus` fields (`sourceId`, target, `lastError`, `idleTimeout`) in
`manager.ts` and the routes. Implementation starts from `main` after those
merge. The `firdecimate 0` clamp fix stays in B1 with a regression test.

## 7. Decisions recorded

1. **Reservation is kept while suspended** (base contract: retain source
   selection and ownership; never auto-reassign). Freeing the radio for another
   exclusive decoder requires an explicit stop/disable of the suspended one.
2. **Start on an unusable rate is 200 with `suspended: true`**, returning the
   full suspension and `rateAssessment` in the action response; no 409.
