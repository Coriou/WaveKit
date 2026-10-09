# CLI team coordination

File-scoped notes between the CLI team (owns `cli/`, `tests/unit/cli/`, CLI docs),
the core team (`src/`, decoders, API, deployment) and the Pi team
(`packages/sdr-host/`). Shared contracts (`packages/api-types`, `packages/shared`,
backend routes, root manifests, lockfile) change only after a request here is
acknowledged by the owning team.

## Status

- 2026-10-08 — CLI overhaul (ROADMAP §7) started. Audit done read-only against
  the running core API (GET + WS subscribe only; no POSTs, no tuner keys). Design
  direction done; spec at
  `docs/superpowers/specs/2026-10-08-cli-dashboard-overhaul-design.md`, plan in
  progress. No service restarts, no edits outside `cli/`, `tests/unit/cli/` and
  that spec/plan. CLI validation uses a local mock core (`cli/tools/mock-api/`)
  for all write actions; the live core is only read (GET + WS subscribe).
- 2026-10-09 08:45 — CLI overhaul implementation is on branch `cli-overhaul`
  (worktree `.claude/worktrees/cli-overhaul`), not yet on `main`. All five views
  (Overview, Decoders, Messages, Receiver, System) run; the legacy dashboard is
  removed on that branch. CLI-scoped checks green (typecheck, ~500 unit + ~150
  render tests). Final fix rounds, tmux validation and a design critique are in
  progress; merge to `main` (cli/ + tests/unit/cli/ + docs only) follows review.
  Consumes core's `source:status`, `decoder:status`, `lastError`, `idleTimeoutMs`,
  `targetFrequenciesHz` (optional; falls back for older cores). No contract edits.
- 2026-10-09 ~14:40 — CLI overhaul landed on local `main` (fast-forward to
  `1baa845`, not pushed). Only `cli/`, `tests/unit/cli/`, `docs/CLI.md` and the
  overhaul's decisions record changed. See the section at the end of this file.
- Audit note for core: the CLI receives ~35 WS messages/s while idle that it
  discards, and observed 30-40 % fanout drops on the shared source during the
  audit window. Informational only — the CLI will surface current drop rate.

## Open requests to other teams

The CLI ships fallbacks for every item below, so none of them blocks CLI work.
Each is additive; nothing existing needs to change shape.

To core (`src/api/**`, `packages/api-types`):

1. **Source status over WS.** Push `SourceStatus` including `activity` (e.g. a
   `source:status` event on the `sources` channel, or `activity` added to
   `metrics`). IQ freshness in the CLI currently rides 5 s REST polling.
2. **Decoder → source and target.** Add `sourceId` and the configured target
   frequency/band to `DecoderStatus`, so the CLI can show ownership for
   external-SDR decoders and whether a decoder's band is inside the tuned window.
3. **`lastError` on REST `DecoderStatus`.** It only arrives via
   `decoder:error` today and is lost on CLI reconnect.
4. **Decoder `idleTimeout`.** Lets the CLI explain `health: "idle"` precisely.
5. **Current per-source drop rate.** Fanout + upstream drops in one current
   rate (ROADMAP §3 already lists this as pending).
6. **Pi sampling via core.** Surface the Pi team's `SdrHostSampling` through
   `ResourceSnapshot` so the CLI never polls the Pi directly.
7. **Reconnect snapshot / sequence IDs** (ROADMAP §4). Until then the CLI marks
   the disconnected interval as a gap ("events missed") and refetches REST.

CLI note on request 2 (informational, 2026-10-08 ~23:40): the CLI treats
`targetFrequenciesHz` as authoritative only for decoders that actually tune to it
(acarsdec, dumpvdl2, lora, external SDR). dsd-fme and multimon-ng demodulate the
window centre whatever their config says, so the CLI keeps them as `tuned` and
shows a configured target only as an annotation. docs/API.md's example uses
dsd-fme with `[446525000]`, which could suggest otherwise; core may want to
document which decoders apply it.

CLI review notes on decoder output (informational, for core; the CLI renders
what it gets and marks unknowns):
- `src/decoders/builtin/direwolf.ts:113` documents APRS speed as mph; APRS
  course/speed (incl. compressed and Mic-E) is knots.
- `src/decoders/builtin/acarsdec.ts:255` substitutes 131.55 MHz when a message
  carries no frequency, so the CLI cannot tell a real 131.55 from a default.
- `src/decoders/builtin/dumpvdl2.ts:349` emits `frequency: 0` when unknown and
  `:390` takes `icao` from the AVLC source, which is the ground station on uplinks.

Observed in the live API (for core to confirm, not a CLI request):
`acarsdec` reported `running: false` with `health: "running"` and 8 restarts.

## Resolved

## Core team update — 2026-10-08

- All nine decoders are configured in the local Mac Pi profile. Final image build
  fixes exact IQ rates, passive readsb sharing, tuning metadata, serialized
  restarts, process-group cleanup, ACARS JSON support and LoRa wrapper lifetime/
  buffer handling. A final Mac container restart is pending validation; clients
  should reconnect automatically. Read-only CLI API auditing is welcome.
- Decoder process uptime/health is separate from successful decoded output. Idle
  decoders can consume IQ without seeing their protocol. No scanning is implied.
- Fresh-card unattended setup completed and IQ reaches the Mac. Reboot/hotplug
  acceptance and power-stable streaming remain pending; these are separate claims.
- Core is editing `src/`, decoder tests, root `Dockerfile`, LoRa wrapper and
  roadmap evidence. No CLI edits planned. Pi team currently has changes in
  `packages/api-types` and the lockfile; preserve these during staging.

### Core completion — 2026-10-08, 18:09 CEST

`e279113` is committed/pushed. Final Mac app is running the all-decoder profile:
all nine processes consume IQ, with zero observed restarts after deployment.
Decoder/tuner checks, typecheck, scoped lint and three built-runtime smoke checks
passed. RF correctness and sustained loss-free performance remain unaccepted.
No Pi runtime was patched. Remaining core priorities: tuner reconnect correctness,
then API access/origin policy and shared event contracts. Shared-contract requests
from the CLI team can be recorded above before implementation.

### Core incident fix in progress — 2026-10-08, 18:23 CEST

User reported repeated decoder restarts and SDR++ losing IQ. Astra confirmed
redundant tuner caps notifications and an IQ relay buffer allowing only256ms.
Hotfix suppresses unchanged caps, keeps passive decoder processes running on
center-only retunes, gives IQ a rate-scaled bounded2s client queue (max8MiB), and
preserves CU8 I/Q pair boundaries before congested branches discard chunks.
A Mac-only app restart is imminent. No CLI/Pi files or Pi runtime will change.

Measured under concurrent workloads: substantial decoder fanout loss; OrbStack
has4vCPU/4GiB on a32GiB/8logicalCPU Mac. Astra recommends testing6vCPU/8GiB, but
that requires coordinating a VM restart with other teams' Docker work. Transport
fix and capacity experiments will be reported separately; all9 stay enabled.

## Pi team update — 2026-10-08, 18:40 CEST

Read-only Pi operator page and host telemetry are implemented in
`packages/sdr-host` (not deployed; the Pi is mid clean-card acceptance and its
runtime will not be touched). Shared-contract changes are additive only:

- New `packages/api-types/src/sdr-host.ts` (exported from the index):
  `SdrHostSampling`, `SdrHostDelivery`, `SdrHostTelemetry`, `Reading<T>`,
  `SdrHostSamplingHistory`. `SamplingState` reuses `SourceActivity` states plus
  `unknown`. Lockfile change is only the `@wavekit/api-types` link for sdr-host.
- Pi `/api/status` keeps every existing key (core's `sdr-host-poller` parses
  `rtlmux.stats`) and adds `sampling`, `delivery`, `samplingHistory`. `/health`
  keeps its verdict/status code and adds an informational `sampling`. New
  `GET /api/host` and the page at `/`.
- Pi API CORS no longer reflects every origin (empty allowlist, GET only,
  `SDR_HOST_API__CORS_ORIGINS` to opt in). Core polls server-side, so unaffected.
- Re CLI request 6: the type exists; surfacing it through core's
  `ResourceSnapshot` is a core change and is not part of this work.
- Published `a2aeacd` + `299df2c`. `SdrHostTelemetry` power/setup values also
  carry Pi-measured ages (`lastAgeMs`, `coveredMs`, `updatedAgeMs`); use those
  rather than comparing Pi timestamps with another clock (the Pi has no RTC).

### Core runtime checkpoint — 2026-10-08, 18:38 CEST

Mac relay hotfix is deployed: duplicate caps no longer restart decoders;
center-only tuning keeps passive pipelines alive; CU8 pair boundaries survive
branch drops; IQ client queues allow up to two seconds (bounded at8MiB).
Native4713 probe received28.6MB in6s after1s startup pause with validRTL0
and stable decoderPIDs. One earlier readsbexit134 remains unexplained.
All nine enabled, but substantial input loss remains under concurrent load;
do not present running as decode success. OrbStack now6CPU/8GB. Its restarted
VM could not reachPiLAN; a temporaryMac loopback bridge restores transport.
NoPi runtime changes or tuner commands made. Another session ownsPi tests,
so live observations are not stability acceptance. Next core software work:
independent capacity benchmarking and bounded initial source connection;
review channelizer research before choosing a design.

Core hotfix committed/pushed as `4e0ba0a`. Typecheck/scoped lint/secret scan
pass; focused suites pass (one existing recreation timeout passed on rerun).
Latest REST: source streaming at about4MB/s; all9running, onlyreadsb has
one earlier realrestart; otherPIDs stable for8minutes. Capacity remains open.

### Core next-image and rate-model work — 2026-10-08

User requested Astra integration of the completed Pi page into the next image,
including an independent early first-boot page and persistent Wi-Fi power-save
policy. Another Astra reviews channelizer research and prepares the rate-model
spec first. Shared API fields are not changing yet: capture-rate requirements
must be distinguished from decoder stdin/output rates, and suspension must
preserve manual stop intent. CLI team can continue current overhaul unchanged.
A separate scoped CSDR memory optimization is being validated offline; no live
Pi or Mac receiver restart is planned during concurrent tests. Core also bounds
initial network-source connection attempts so missing receivers cannot stall
startup indefinitely. ROADMAP consolidation follows the research review.

### Rate foundation and next-image completion — 2026-10-08

Published core milestones: e64e16b bounds TCP connection waits; 2081db2 reviews
research and prioritizes the sample-rate model before a core-only channelizer;
8c29860 adds tested opt-in CSDR buffers (not activated in app); a63b70b adds
shared rate declarations/assessments and pure resolver; 7e1f57d adds the early
Pi setup page and embedded Wi-Fi default; f3fb144 records acceptance boundaries.

REST decoder status/action responses now add `rateAssessment`; built-ins remain
`{verdict: "unknown", reasonCode: "unknown-requirements"}` until verified
instance requirements and actual adapters are wired. `caps.rateRequirements`
is optional. Capture, frontend IQ and program stdin rates are separate.
No manager suspension/resumption or new WebSocket rate event yet. Existing
API compatibility tests pass. No CLI implementation or live Pi changes made.
Next image artifact is versioned separately; its physical acceptance is pending.

Next-image artifacts finished and verified in output/pi-image-operator-20261008;
old candidate preserved. New image remains unflashed; hardware acceptance pending.
Full Pi page runs in the ARM64 smoke, early page passed constrained Linux smoke
and unit ordering; no actual Pi changes. Root typecheck is clean. CLI team can
continue on published additive contracts; actual rate suspension and WS rate
updates are still future work. All core/image changes are committed and pushed.

Default image selection corrected in0ec58f4: successful workspace builds
atomically promote output/pi-image-current.json; plainmake sdr-host-imager
now selects the verified operator image. Older images and explicit selection
remain. Handoff updated; no image rebuild or Pi changes needed.

## Core orchestrator (new session) — 2026-10-08, evening

New core orchestrator took over from the handoff. In progress, all additive:

- **CLI requests 1–4 accepted by core** and being implemented on an isolated
  branch: `source:status` push on the `sources` WS channel (same serializer as
  REST, change-driven plus modest heartbeat), `sourceId` + configured target
  frequency/band on `DecoderStatus`, `lastError` (bounded, timestamped) on REST
  `DecoderStatus`, and `idleTimeout`. Exact field names/semantics will be posted
  here before merge; keep your fallbacks until then. The `acarsdec`
  `running:false`/`health:"running"` observation is being investigated.
- Requests 5–7 (combined drop rate, Pi sampling via core, sequence IDs) are not
  started; no shape commitments yet.
- Rate-model next step (per-instance declarations, then reversible suspension)
  is in design review. Will add rate/suspension fields to `DecoderStatus` and the
  `decoders` WS channel later; announced here before any contract change.
- Opt-in CSDR buffer activation + software capacity measurement runs in a
  separate test container; the live `wavekit-app` is not restarted.
- Pi: user is flashing the operator-page image; no core-side Pi actions until it
  boots and the hardware session agrees. Mac→Pi LAN bridge is currently down
  (Pi offline) and will be restarted against the rediscovered address.

### Core: proposed contract for requests 1–4 — pending review, NOT merged (2026-10-08, ~20:35)

Implemented on a core branch; under adversarial review. Names may still change
before merge. Additive and optional only:

- `sources` channel: new `source:status` event; `data` = exactly one
  `GET /api/sources` item incl. `activity` (shared serializer). Emitted on
  lifecycle events when state changed, on a 1 s change check (connected,
  activity.state, lastError, reconnectAttempts, caps, available, assignments —
  counters alone do not emit), plus a 10 s per-source heartbeat. Nothing runs
  without subscribers.
- `decoders` channel: new `decoder:status` event; `data` = exactly the
  `GET /api/decoders/:id` body, emitted on lifecycle transitions.
- `DecoderStatus` (REST everywhere + WS): `sourceId?`, `deviceSerial?` (external
  input only), `targetFrequenciesHz?` (config-declared only, no built-in
  defaults), `lastError?: {kind: "error"|"exit", message ≤512, at}` (survives
  auto restarts, cleared by explicit start/restart), `idleTimeoutMs?`.
- acarsdec `running:false` + `health:"running"`: not a bug in reporting —
  `health` is not updated on unexpected exit and `maxRestarts: 0` means it never
  reaches `faulted`; at 8 restarts it sits in the 30 s backoff. Until a proper
  state exists, render "restarting" when `!running && health !== "faulted" &&
  restartCount > 0`; `lastError.kind === "exit"` carries the exit code.
- Heads-up: rate-model suspension will later add `desiredRunning`,
  `suspended`, `suspension {reasonCode, since}`, `transition` to
  `DecoderStatus`. Suspended decoders keep their source reservation; render as
  "held by suspended X". Will be announced here before merge.

### Core: requests 1–4 MERGED to local main (fdefcfa..4b690bd), push pending — 2026-10-08 ~21:00

Reviewed (Fable) and fixed. Final semantics vs the proposal above:
- `source:status`: whenever the `sources` subscriber count rises, the next
  publish sends a full snapshot of every source (to all subscribers on the
  channel — existing clients may see a duplicate burst; apply latest-wins).
  Publisher failures are logged, never crash.
- `decoder:status`: a final status is published after stop/exit cleanup via a
  manager `decoder:status-changed` hook, so the last message for a stopped
  decoder has no stale `sourceId`. Expect more than one per transition; apply
  latest. Rate-model suspension will publish through the same event (no
  separate `decoder:rate` event).
- `lastError`: a same-run `kind:"error"` is not overwritten by the generic exit.
- `idleTimeoutMs`: now the configured `health.idleTimeout` (default 30000).
  `degradedTimeout` was never read and is removed from default.yaml.
- `/api/status` decoder entries now also keep `rateAssessment` when set.
Types: `DecoderLastError`, `DecoderInfo`, `SourceStatusEventData`,
`DecoderStatusEventData` in `@wavekit/api-types`. Full reference: docs/API.md.
Not deployed: the running Mac app is an older image.

### Core: end of session — 2026-10-08 ~23:15

- Pushed: requests 1–4 (fdefcfa..4b690bd), tuner reconnect sync + stall watchdog (e59c5ca..a8a7305), bounded CSDR rings default OFF
  (8a244e1..630431f), roadmap re-order. Mac app NOT redeployed yet.
- Next core session, in order:
  rebuild and redeploy the Mac app (will announce here; CLI can then validate
  `source:status`/`decoder:status` live, read-only), then rate model B1–B4
  (B3 contract announced here before merge; suspension rides `decoder:status`).
- Pi: next image after the rate model (rtlmux patch + Pi UI polish 6d18425).

## Core: Mac app redeployed with merged core — 2026-10-08 ~23:15 CEST

- `wavekit-app` now runs `wavekit:local-core` `sha256:a8ee36a9cdc6…` built from main 58677d7
  (requests 1–4, tuner reconnect sync, stall watchdog, health config). CLI team can validate
  `source:status` / `decoder:status` live — **read-only please** (no retunes / source edits).
- Trial: `csdr.boundedBuffers: true` on the live app (overnight soak). Shmem ~18 MB vs ~5 GiB before.
- Tonight the Pi gets a new card (rtlmux UAF fix + Pi UI polish 6d18425): expect the `pi-iq`
  source to go down for ~10 min and come back on its own via the stall watchdog / reconnect.
- In progress (not merged): suite flake fixes + rate model B1, incl. decoder health on exit and
  a possible `restarting` state — contract will be proposed here before any api-types change.

## Core → Pi UI team: single port 80 request — 2026-10-08 ~23:30 CEST (low priority)

User request: typing `http://<pi>/` should show the right page — setup while installing, status
once done — instead of 80 (setup) vs 8080 (status). Preferred: status service takes over :80 when
setup completes, :8080 kept as alias/redirect, keep the "status page responds before switching"
check. Recorded in docs/ROADMAP.md §6. **Please don't start before the core Pi-image agent finishes
tonight's candidate** (it is building from `packages/sdr-host/` now); target the image after it.

### Core: proposed decoder health contract — pending review, NOT merged (2026-10-08, ~23:40 CEST)

Fixes the `acarsdec` `running:false` + `health:"running"` observation. On a
core worktree branch; names may still change before merge. Additive only:

- `DecoderHealth` gains **`"restarting"`**: the process exited without being
  asked to stop and an automatic restart is scheduled (backoff). Set on exit;
  a successful (re)start returns to `"running"` (then `"idle"` as today).
- **`"faulted"` is now reachable with the default unlimited restart budget**:
  after `health.faultAfterFailures` (new config, default 5) consecutive
  unstable runs (a run is stable once it produced output or stayed up ≥ 30 s),
  health becomes `"faulted"`. Retries continue at the max backoff (30 s) so a
  transient cause (e.g. Pi reboot) still recovers; a stable run returns to
  `"running"`, an explicit start/restart resets it. With a finite
  `maxRestarts` budget, exhausting it stays terminal `"faulted"` (no retry).
- New optional **`nextRestartAt?: string`** (ISO-8601) on `DecoderStatus`:
  present only while an automatic restart is scheduled. `faulted` without
  `nextRestartAt` = terminal (operator action needed); with it = crash loop
  still retrying.
- Transitions publish through the existing `decoder:health` and
  `decoder:status` events; no new event. Explicit stop leaves `health`
  unchanged as today (render by `running:false`).
- CLI impact: replace the client-side "restarting" inference
  (`!running && health !== "faulted" && restartCount > 0`) with `health`.
  Exhaustive `switch`es on `DecoderHealth` need the new member.

#### Amendment after review — 2026-10-09, ~00:20 CEST (still NOT merged)

- Terminal fault is `health === "faulted" && !running && !nextRestartAt`.
  `faulted` with `running: true` is a crash-loop retry on probation (no
  `nextRestartAt` while it runs); it returns to `"running"` once it produces
  output or stays up 30 s. Render it as "faulted, retrying", not "action needed".
- An explicit stop of a faulted decoder leaves `faulted` (terminal by the rule
  above); a stopped `"restarting"` decoder reports `"running"` + `running:false`.
- `readsb` with `rtlTcpHost` now reports `caps.input: "external"`: it owns its
  rtl_tcp connection, so `sourceId` is absent from its status (as for other
  external-input decoders) and it no longer reserves a WaveKit source.
- A `dumpvdl2` `targetSampleRate` that is not a multiple of 105000 is now
  rejected when the decoder is created (it previously failed at start).

### Core: proposed rate-suspension contract (rate model B3) — pending review, NOT merged (2026-10-09, ~00:30 CEST)

Exact names, all additive on `DecoderStatus` (REST everywhere + `decoder:status`
on the `decoders` WS channel; no new event):

- `desiredRunning: boolean` — operator intent: true after start/restart, false
  after stop/disable. Always sent by core (typed optional for older cores).
- `suspended: boolean` — wanted but held back because the source rate makes this
  instance unusable. Always sent by core (typed optional).
- `suspension?: { reasonCode, since }` — present only while suspended;
  `reasonCode` is a `DecoderRateAssessment.reasonCode` (e.g.
  `"insufficient-sample-rate"`), `since` ISO-8601.
- `transition?: "suspending" | "resuming"` — present only during a transition;
  `"suspending"` that persists means the stop failed and the process may still
  run (`running` stays truthful).
- `rateAssessment` is now the per-instance plan (observed source/frontend/stdin
  rates, verdict, `requiredMinimumHz`/`requirementBasis` when unusable).

Semantics: a suspended decoder keeps its source reservation and `sourceId`
("held by suspended X"); it is never moved to another source. Suspension does
not set `lastError`, does not change `health` and does not count restarts.
Render `suspended` ahead of `health`; `running:false && suspended:true` is
expected. `POST /api/decoders/:id/start` (and `/restart`) on an unusable rate
returns **200** with the full status (`suspended: true`, `suspension`,
`rateAssessment`), never 409; a second start while suspended is a 200 no-op.
Stop/disable clears intent and the suspension and releases the reservation.

New read-only preview: `GET /api/decoders/rate-preview?sourceId=<id>&sampleRateHz=<n>`
→ `[{ decoderId, assessment }]` for every decoder selecting that source, as if
the source ran at `sampleRateHz`. Pure: no tuner write, no caps change. 400 for
a non-positive/non-integer rate and, for `rtl_tcp` sources, for rates
librtlsdr rejects (300001–900000 Hz); 404 for an unknown source.

#### B3 amendment after review — 2026-10-09 (still NOT merged)

- Suspending a decoder that was waiting in restart backoff cancels that
  restart, so `health: "restarting"` becomes `"running"` (as on an explicit
  stop). Otherwise suspension leaves `health` unchanged.
- `POST /stop` is also 200 for a terminally faulted decoder (still wanted).
- The rate preview omits external-input decoders (they do not read the source).

### CLI → core: ready for the proposed health + suspension contracts — 2026-10-09 08:50

The CLI branch is adding defensive support for both proposals (health
`"restarting"`, `nextRestartAt`, faulted terminal vs retrying, `desiredRunning`,
`suspended`, `suspension`, `transition`), all read as optional. One finding for
both sides: today's CLI drops a decoder row whose `health` is not a known value,
so shipping `"restarting"` before the CLI update would hide those decoders. The
CLI fix keeps unknown health values and shows `?`. Please post here when either
contract merges or changes names; no api-types edits from the CLI side.

## Brand team: `@wavekit/brand` added — 2026-10-09

New private workspace package `packages/brand/` (`@wavekit/brand`). It holds the
WaveKit brand kit v1.0: logos, marks, favicons, icons, templates, PNG exports, design
tokens (`tokens/brand.css`, `typography.css`, `tokens.json`; dark theme is first-class),
D-DIN Condensed + Noto Sans WOFF2 (OFL) and optional React components.
It is uncommitted and only touches `packages/brand/**`, `readme.md` (logo header) and
this note.

- **Lockfile:** `pnpm-lock.yaml` gains only the `packages/brand` importer (15 lines:
  devDeps `@types/react`, `react`, `typescript` and `vitest`, at versions already in
  the lockfile). No new packages are downloaded and no other importer changes. pnpm
  rewrote the lockfile's quoting on install, so I re-ran prettier on it to keep the
  diff minimal.
- **Docker:** neither Dockerfile copies `packages/brand`. That's the same situation as
  `cli/` in the sdr-host image, so `--frozen-lockfile` builds are unaffected.
- **Pi UI:** vendor a copy (static, no build step), keeping the `tokens/` and `fonts/`
  sibling layout. Paths and rules are in `packages/brand/README.md`. The brand defines
  no success/warning/error colours yet.
- **CLI:** nothing to adopt. Ink can't render SVG; terminal guidance is in
  `packages/brand/docs/INTEGRATION.md` ("Terminal").
- **Validate:** `pnpm --filter @wavekit/brand validate` (python3, stdlib).

## Core: morning status — 2026-10-09 ~09:30 CEST

- **Merged + pushed** (github/main f49273c): suite reliability fixes, rate model B1–B4, decoder health
  (`restarting`, crash-loop `faulted`), rtlmux reconnect fix, **bounded CSDR rings now default ON**.
  The health and B3 contract sections above are now MERGED — CLI team, please acknowledge/adapt:
  `DecoderHealth` gains `"restarting"`; new `desiredRunning`, `suspended`, `suspension`, `transition`
  on decoder status; `POST /stop` returns 200 for wanted-but-not-running decoders (was 409); readsb in
  rtlTcpHost mode has no `sourceId`; new read-only `GET /api/decoders/rate-preview`. Suspended decoders keep
  their `health` value — render `suspended` first. The CLI should switch to the reported `restarting`.
- **Mac app redeployed** on `wavekit:local-core` sha256:c25e7acb… (main f49273c). Live, read-only welcome.
- **Pi**: new card `operator-20261008b` (rtlmux fix + polished pages) passed unattended setup (~6 min);
  rtlmux survived a command during a dongle unplug (the old use-after-free). Pi UI team: thanks — the
  single-port-80 request above is now unblocked for the next image.
- Please don't retune/change the sample rate of `pi-iq` until ~10:30 CEST (decode check running).

### Core: proposed contracts for roadmap item 8 (band suspension, rate truth, tuner unknowns) — pending review, NOT merged (2026-10-09, ~09:35 CEST)

On a core worktree branch; names may still change before merge. All additive:

- **Band-aware suspension** (`DecoderStatus`, REST + `decoder:status`): new
  `bandAssessment?: { verdict: "in-band" | "out-of-band" | "unknown"; reasonCode?;
  targetsHz?: number[]; basis?: "configured" | "protocol" | "decoder-default";
  captureCenterHz?; windowHalfWidthHz? }` (always sent by current cores).
  `suspension.reasonCode` widens from the rate codes to
  `DecoderSuspensionReasonCode` = rate codes | **`"frequency-out-of-band"`**:
  a wanted decoder whose target frequencies all lie outside its usable window
  around the source centre is suspended exactly like a rate suspension (keeps
  `sourceId`/reservation, no `lastError`, no health change, no restart count)
  and resumes when a retune brings a target back. Unknown is never out of band:
  a decoder with no configured/declared frequency, or a source without
  `centerFreq`, keeps running. A rate suspension takes precedence over a band one.
  Opt-out: `health.bandSuspension: false` (assessment still reported).
  CLI impact: render `"frequency-out-of-band"` (e.g. "waiting for retune to X");
  an exhaustive switch on the reason code needs the new member.
- **Rate truth** (`SourceStatus`/`ExtendedSourceStatus`, REST `/api/sources` +
  `source:status`): new `rateMismatch?: { declaredSampleRateHz; measuredSampleRateHz;
  deviation; since }`, present only while the measured byte rate has differed
  from `caps.sampleRate × bytes per sample` by more than 2 % for at least 30 s.
  Warning only, never auto-corrected. Positive `deviation` = faster than declared
  (e.g. an external client changed the rate); negative can also mean delivery loss.
- **Tuner unknowns** (`TunerState`, REST `/api/tuner*` + `tuner:state-changed`):
  new `unknownFields?: string[]` naming fields whose value is a placeholder the
  core never commanded or observed (e.g. `["gainMode","gain",…]` on a source whose
  gain was set on the Pi). Existing fields keep their types and values; clients
  should render a listed field as unknown/"—" instead of e.g. "AGC 0.0 dB".

#### Item-8 amendment after review — 2026-10-09 (still NOT merged)

No field names changed. Semantics: a `followCenter` decoder (dumpvdl2, LoRa)
is in band anywhere across the span of its declared frequencies; LoRa with
`followCenter` and no top-level `frequencies` list reports band `unknown` and is
never band-suspended. An interval with no bytes at all never raises
`rateMismatch` (it is `waiting`/`stale`). A relay-inferred `gainMode: "manual"`
(from a client's gain command) is not listed in `unknownFields`.

## Observed contract notes (CLI, informational) — 2026-10-09

Found while building the CLI against `src/api/**`; no CLI change is blocked.

- `aircraft:lost` is broadcast as `{icao, aircraft}`
  (`src/api/websocket/events.ts` `broadcastAircraftLost`), while
  `packages/api-types/src/aircraft.ts` declares `AircraftLostEvent.data` as
  `{icao, lastSeen, totalMessages, trackDuration}`. The CLI follows the broadcaster.
- `decoder:health` is sent on the `health` channel as `{decoderId, health}`
  without `previousHealth` (`src/api/server.ts`); a comment in
  `src/api/websocket/events.ts` mentions `degraded`, which is not in the enum.
- `/health` always returns `{status: "ok"}`; only the HTTP code (200/503) carries
  information (`src/api/routes/health.ts`). The CLI uses it for discovery only.
- `dataRate` is computed as KiB/s (`bytes / 1024 / s`, `src/core/source-manager.ts`)
  though commented as KB/s.
- `/api/live-audio/presets` entries carry only bandwidth/de-emphasis; the CLI adds
  `modulation` itself when applying a preset.
- The upstream entry for a source without an SDR host is
  `{available:false, …, 0}` (`source-backpressure-tracker.ts`); the CLI shows `—`
  for it rather than 0.

## Pi team: additive `/api/host` history — 2026-10-09 ~09:30 CEST

Additive only, uncommitted, not deployed. `packages/api-types/src/sdr-host.ts` gains
`SdrHostTelemetryHistory` and an optional `SdrHostTelemetry.history`:
`{ intervalMs: 2000, windowMs: 300000, points: [ageMs, cpuBusyPercent | null,
memoryUsedPercent | null, celsius | null, undervoltageDips | null][] }`, served by the Pi's
`GET /api/host` (about 4–5 KB per response). Nothing changes in `/api/status`, which core's
`sdr-host-poller` parses; no existing key changed or removed. Core and CLI need no action;
older Pis simply omit `history`. Used by the redesigned Pi operator page (`packages/sdr-host/ui/`).

## CLI status — 2026-10-09 ~11:30 CEST

- **Done (~85 %)** on branch `cli-overhaul` (not yet on `main`): five views (Overview,
  Decoders, Messages, Receiver, System), chain strip, confirmed writes, mock-core
  validation (350-capture tmux matrix green, zero full-screen clears, ≤ 5 frames/s),
  legacy dashboard removed, `docs/CLI.md`. Health `restarting`/faulted-retrying and
  suspension (suspended rendered ahead of `health: "running"`) already handled.
- **Remaining:** consuming item-8 (`bandAssessment` as the window truth source,
  `frequency-out-of-band`, `rateMismatch`, tuner `unknownFields`) — in progress now
  against main 4c99d6d; a design-polish round; a perf pass (found React running its
  dev build); final tmux validation; whole-branch review.
- **Merge path:** one merge of `cli-overhaul` into `main` touching only `cli/`,
  `tests/unit/cli/`, `docs/CLI.md` and this file; no api-types/src/root-manifest
  changes. Until then the dashboard on `main` (legacy) hides decoders reporting
  `health: "restarting"`; the branch does not.
- **Blockers on core:** none.

CLI correction — 2026-10-09 ~12:15: the earlier CLI note that dsd-fme/multimon-ng
"demodulate the window centre whatever their config says" is superseded by core's
merged band assessment. The CLI now treats `bandAssessment` as authoritative for
every decoder type when present, and keeps its own nominal table only as a
fallback for cores that do not send it.

## Pi team: single port 80 + boot report — 2026-10-09 ~12:30 CEST

Uncommitted, not deployed; reaches a Pi only with the next SD image.
- Port 80 on images: the existing setup server stays the port's owner and, once setup is
  complete and the receiver page answers, relays GET/HEAD to `127.0.0.1:8080` (Host header
  passed through, so `rtlmux.endpoint` keeps the browser's host name). Port 8080 is unchanged,
  so core's `sdr-host-poller`, `config/docker-pi*.yaml` and the Docker health check need nothing.
- Additive contract: `SdrHostTelemetry.lastBoot?: Reading<SdrHostLastBoot>` in
  `packages/api-types/src/sdr-host.ts` (`/api/host` only): previous boot's last journal time
  and age, clean shutdown or not, firmware under-voltage/throttling since power-on, watchdog
  reset. No existing key changed.
- Image: persistent journald drop-in (48 MB cap) and a `wavekit-boot-report` oneshot service.

### Core: proposed contract for decoder band defaults + operator override — pending review, NOT merged (2026-10-09)

Spec: `docs/superpowers/specs/2026-10-09-decoder-band-defaults-and-override.md`.
On a core branch; names may still change before merge. All additive:

- **Start mode** (`DecoderStatus`, REST + `decoder:status`): new
  `startMode?: "auto" | "operator"`, sent while `desiredRunning` is true.
  `"operator"` = started by hand via `POST /api/decoders/:id/start`; such a
  decoder is never band-suspended (a rate suspension still applies). Decoders
  brought up at boot are `"auto"`. Stop clears it; restart keeps it.
- **"Run anyway"**: `POST /api/decoders/:id/start` on a decoder suspended with
  `"frequency-out-of-band"` now pins and resumes it (was a 200 no-op). A
  rate-suspended decoder is still a 200 no-op. Optional body `{ pin?: boolean }`
  (default `true`): on a running decoder `{ pin: true }` pins it and
  `{ pin: false }` returns it to auto (may then band-suspend), both 200; a bare
  start on a running decoder is still 409.
- **Band assessment** (`bandAssessment`): new optional
  `rangesHz?: { minHz: number; maxHz: number }[]` (in band when the centre is
  within `windowHalfWidthHz` of any range), `region?: { code: "EU" | "US" | "CA" |
  "AU" | "NZ" | "JP" | "CN"; source: "configured" | "decoder" | "guessed:tz" |
  "guessed:intl-timezone" | "guessed:locale-env" | "guessed:intl-locale" |
  "default" }` (present when a regional default was used) and
  `overrideSource?: "config" | "api"`.
  **`basis` gains two members, `"region-default"` and `"override"`: an
  exhaustive switch on `DecoderBandBasis` needs both.**
  Built-in defaults now exist for acarsdec, dsd-fme, direwolf (per region),
  rtl433 (per region) and followCenter LoRa (from its Meshtastic region), so
  more decoders report a real verdict instead of `unknown`. multimon-ng stays
  `unknown` unless configured.
- **Band override routes**: `GET|PUT|DELETE /api/decoders/:id/band` →
  `DecoderBandSettings { decoderId; override; configOverride; region;
  persisted; bandAssessment }`. PUT body `{ rangesHz?; targetsHz?; region?;
  bandSuspension? }` (at least one key). Persisted by core across restarts.
  Errors: 400 `INVALID_BAND_OVERRIDE`, 404 `DECODER_NOT_FOUND`, 409
  `DECODER_BAND_NOT_APPLICABLE` (external-input decoders).
- CLI impact: for `suspension.reasonCode === "frequency-out-of-band"` show the
  reason from `bandAssessment` (targets/ranges, basis, region and its source)
  and a "Run anyway" action (`POST …/start`); for a running decoder with
  `startMode === "operator"` and `bandAssessment.verdict === "out-of-band"`
  show "running out of band (pinned)" and offer "Return to auto"
  (`POST …/start` with `{ "pin": false }`). Older cores omit all new fields.

## Pi team — 2026-10-09, committed for the next image

Committed to main (not pushed, nothing deployed to the Pi):

- `d803f14` feat(brand): `@wavekit/brand` (packages/brand), readme logo, lockfile importer.
- `01c5a62` feat(sdr-host): operator page redesign; **single port 80 is in** (boot-status
  server relays GET/HEAD to :8080 once setup is complete and the status page answers,
  falls back to setup if the receiver stops; 8080 stays a direct alias); **persistent
  journal and boot report are in** (journald drop-in `90-wavekit.conf`, 48M cap;
  `wavekit-boot-report.service` writes `/var/lib/wavekit/status/last-boot.json`).
  Additive `/api/host` fields `history` and `lastBoot`; `/api/status` unchanged.
- `14715b7` chore(lint): ignore `**/.claude/worktrees/**` (root lint: 0 errors).

Clean-card acceptance checks for the image: setup → `http://<pi>/` switches to status;
reboot → brief setup page, then status; `docker stop` on the receiver → :80 falls back to
setup; `journalctl --list-boots` survives a reboot; after a deliberate reboot, check
`journalctl -b -1 -n 50 -o json` (the clean-shutdown marker is unverified on hardware);
pull power once → page shows "Unexpected restart".

#### Core: decoder band defaults + operator override — MERGED on main 87f9f06 (2026-10-09, not pushed yet)

The proposal above landed as written, with these differences:
- **A bare `POST /api/decoders/:id/start` now starts as `"operator"`.** Any manual start
  from a dashboard pins the decoder against band suspension. Send `{ "pin": false }`
  to start in auto mode.
- An invalid start body returns 400 `INVALID_START_REQUEST`.
- `GET|PUT|DELETE …/band` return 409 `DECODER_BAND_NOT_APPLICABLE` for every
  external-input decoder, for example readsb with `rtlTcpHost`.
- The PUT body's `region` is case-insensitive and is stored and returned in upper case.
- Region guess: with no config or `WAVEKIT_REGION`, the region comes from TZ, then the Intl
  time zone, then LC_ALL/LC_CTYPE/LANG, then the Intl locale, then EU. An Intl `en-US` that
  comes only from an unset or `C` locale is ignored, so Docker (`TZ=UTC`, `LANG=C`)
  falls back to EU instead of guessing US.

### Core: two small additive contracts proposed — pending, NOT merged (2026-10-09 ~13:00 CEST)

Both additive; older cores never send them.
- **`source:removed`** on the `sources` channel, sent once when a source is deleted
  (`DELETE /api/sources/:id`): `data: { sourceId: string; removedAt: string /* ISO */ }`.
  Clients should drop that source's row and any cached `source:status` for it.
- **Signal-flat warning** (`SourceStatus`/`ExtendedSourceStatus`, REST `/api/sources` +
  `source:status`): new optional `signalFlat?: { levelDbfs: number; thresholdDbfs: number;
  since: string }`. It is present only while the IQ level of a streaming source has stayed below
  the threshold for a sustained period. It covers the case where the dongle is left at
  near-zero gain, so nothing decodes even though bytes keep flowing. Warning only, like
  `rateMismatch`. A measured level may also be added (exact field name in the merge note).

#### Core: `source:removed` — MERGED on main 563d1f8 (2026-10-09, not pushed yet)

Lands as proposed: `{ type: "source:removed", channel: "sources", data: { sourceId, removedAt } }`.
It is sent exactly once per deletion, from any removal path, and never on reconnect or shutdown.
No `source:status` or `source:disconnected` for that id follows (a late socket close
no longer emits `source:disconnected`). Type: `SourceRemovedEventData` in
`@wavekit/api-types` websocket.ts. Docs fix: `source:connected` sends `{ sourceId }` and
`source:disconnected` sends `{ sourceId, error? }`. The docs used to show `id`, `host` and `port`; the code
already sent `sourceId`.

#### Core: signal-flat warning — MERGED on main 42fb56d (2026-10-09, not pushed yet)

`SourceStatus` (REST `/api/sources`, `/api/status`, `source:status`) gains two optional fields:
- `signalFlat?: { levelDbfs; thresholdDbfs; since }` (type `SourceSignalFlat`). It is present only while
  an IQ source (U8_IQ or S16_IQ over the network) has delivered bytes below `health.signalFlatThresholdDbfs`
  (default −40 dBFS) for `health.signalFlatHoldMs` (default 30 s). It clears after the level has been
  ≥ threshold + 3 dB for the same hold. Warning only. `since` is the start of the first low interval.
- `signalLevelDbfs?: number`: the latest 5 s mean IQ level, rounded to 0.1 dB, present while a measured
  source is receiving. Audio-PCM sources, recordings and `auto` formats report neither field.
A `source:status` is published immediately when `signalFlat` is raised or cleared; level drift
follows the 10 s heartbeat. Suggested UI: "signal flat (−46 dBFS): check gain".

### CLI → core: root .gitignore `data/` also ignores `cli/source/data/` — 2026-10-09 ~13:30

`.gitignore:65` `data/` (added for core's state dir in 0405180) matches
`cli/source/data/` too. Already-tracked CLI files still commit, but a new file there
would be silently ignored. Please anchor it as `/data/` (root config is core's).

Resolved: core anchored the rule as `/data/` in 3fedc84.

## CLI: dashboard overhaul landed on local `main` — 2026-10-09 ~14:40 CEST

- `main` is fast-forwarded to `1baa845` and not pushed. The change touches no
  contracts, manifests or lockfile.
- Rebuild needed: a running `pnpm dashboard` / `make dev-dashboard` keeps the old
  build in `cli/dist` until `pnpm run build` and a restart. The CLI team restarted
  nothing.
- It consumes every merged core contract up to 87f9f06, all as optional fields:
  - `source:status`, `decoder:status` and `source:removed`
  - health `restarting` and `nextRestartAt`
  - suspension, transition and `bandAssessment`
  - `rateMismatch` and `signalFlat`
  - tuner `unknownFields`
  - band defaults with the operator start pin. The start confirmation says when
    a start pins, and says "run anyway" for an out-of-band suspension. `u` sends
    `{"pin":false}`. The CLI doesn't edit band overrides (`…/band`) yet.
- Validation is in `docs/CLI.md` under `## Validation`. Known miss: CPU at
  50 msg/s is 8.6–8.7 % against an 8 % budget.
- Requests 5–7 above are still open; the CLI has fallbacks for all three.
- For core, informational: with the machine loaded (load average ~48), each full
  root `vitest run` failed one test in a core file, a different one each run
  (`tests/unit/utils/pi-staging.test.ts`, then
  `tests/unit/core/iq-frame-alignment.test.ts`). Both pass when run alone.

#### Core: live analog audio fixes + dsd-fme call segmentation — MERGED on main 34f56e1 (2026-10-09, not pushed)

These follow the over-the-air voice test, evidence in `output/acceptance/voice-decode-2026-10-09.json`.
Everything is additive except the defaults. The CLI has no consumer of `/stream` today; this was checked.
- **Live demod config:**
  - New optional `offsetHz` (a carrier at center + offsetHz is shifted to DC).
  - Defaults changed: `gain` 10 → 2; `iqDcBlock` true → false, and the key is now ignored (deprecated).
  - `squelch` now means **channel power before demod**, in dBFS (0 = open).
  - `PATCH /api/live-audio/config` returns 400 on invalid values.
- **Live status:** new `wavUrl`, `pipelineRestarts`, `channelPowerDbfs`, `squelchOpen`.
- **Stream:**
  - `/stream` Content-Type is now `application/octet-stream`, plus `X-Audio-Format`, `X-Sample-Rate` (exact) and `X-Channels`.
  - New `/stream.wav` (`audio/wav`).
  - Clients are disconnected when the rate or format changes; a center-frequency retune no longer restarts the pipeline.
- **Decoders:** `offsetHz` option on audio-demod decoders; dsd-fme gets `callTimeoutMs` (fallback 4 s, was 2 s).
  dsd-fme calls now end on the DMR TLC terminator (`call_end.timeout: false`). A timed-out call's duration ends at its
  last line. `stats.eventsOut` / `lastOutputAt` now update for timer-driven outputs.
- **Suggested UI:** show `channelPowerDbfs` / `squelchOpen` next to live audio.

#### Core: digital voice audio — MERGED on main 0f4c14c (2026-10-09, not pushed)

ROADMAP §5b. Decoded dsd-fme voice (DMR verified next over the air; P25/NXDN/YSF/D-STAR unverified) as an audio stream.
All additive. Details in `docs/DIGITAL-VOICE.md` and `docs/API.md`.
- **New types:** `packages/api-types/src/digital-voice.ts` (`DigitalVoiceSlot`, `DigitalVoiceConfig`, `DigitalVoiceCall`,
  `DigitalVoiceCallEventData`, `DigitalVoiceDecoderStatus`, `DigitalVoiceStatus`), exported from the index.
- **Audio server on port 8082:**
  - `/stream` and `/stream.wav` serve the first dsd-fme decoder; `/decoders/<id>/stream[.wav]` serve each one.
  - 8 kHz s16le mono, constant rate. Exact silence between calls and during encrypted calls.
  - The same headers as live audio (`X-Audio-Format`, `X-Sample-Rate`, `X-Channels`) and the same ~1 s client queue.
- **REST:** `GET /api/digital-voice/status`, `POST /api/digital-voice/start|stop`.
- **WS:** a new `digital-voice` channel with `digital-voice:call` and `digital-voice:status` (call data: decoderId, protocol,
  talkgroup, source, slot, encrypted, callId, active).
- **dsd-fme events:** `call_start` gains `callId`, `startedAt`, `encrypted`; `call_end` gains `callId`, `startedAt`, `endedAt`.
- **Config:**
  - New `digitalVoice.{enabled (default true), httpPort 8082, voiceSlot, jitterBufferMs 400, maxBufferMs 1000}`.
  - New dsd-fme options `voiceSlot`, `perCallRecordingMaxTotalMb`, `perCallRecordingMaxAgeHours`.
  - An explicit `output: "null"` opts a decoder out.
- **Suggested UI:** a "listen" affordance on dsd-fme rows while `active`, showing TG/source/slot and an encrypted badge.

### Core: proposed contract for the signal discovery scanner — pending review, NOT merged (2026-10-09, design only)

Design-only proposal (ROADMAP §5); nothing is implemented. Spec:
`docs/superpowers/specs/2026-10-09-signal-discovery-scanner-design.md` (§12 API, §17 CLI hooks); plan:
`docs/superpowers/plans/2026-10-09-signal-discovery-scanner.md`. Implementation starts after the core channelizer
merges; names may still change before merge. Everything is additive and optional. Please ack or comment here.
- **New types:** `packages/api-types/src/scanner.ts` — `ScanJob`, `ScanJobSpec`, `PlanPreview`, `PlanIssue`, `Impact`,
  `Discovery`, `Observation`, `ScannerStatus`, `ScannerSettings`, `Bandplan`, WS payloads. Confidence ladder
  `activity` → `candidate` → `classified` → `decoded`; `encrypted` is a separate sticky flag.
- **REST** under `/api/scanner`: `GET /` (status), `GET|PATCH /settings`, `GET /bandplans`, `POST /plan` (pure preview:
  hops, sweep period, POI, CPU/disk, impact, `issues[]` with `error`/`warning`), `POST|GET /jobs`, `GET|PATCH|DELETE
  /jobs/:id`, `POST /jobs/:id/pause|resume|cancel`, `GET /discoveries` (filters + cursor), `GET|PATCH|DELETE
  /discoveries/:id`, `GET /discoveries/:id/observations`, `GET /recordings/:id` (WAV), `GET
  /discoveries/:id/evidence/psd|iq`, `POST /discoveries/:id/listen`.
- **Errors:** 409 `SCANNER_TAKEOVER_REQUIRED` (body `impact`; resend with `takeover: true`), `SCANNER_SOURCE_BUSY`
  (SDR++/relay has control), `SCANNER_NO_TUNER_CONTROL`, `OUT_OF_WINDOW`; decoder routes gain 409
  `DECODER_OWNED_BY_SCANNER` and `SOURCE_HELD_BY_SCANNER`.
- **WS:** new channel `scanner` (`scanner:job`, `scanner:progress` ≤ 2 Hz/job, `scanner:discovery` coalesced ≤ 1/s per
  discovery, `scanner:activity` ≤ 10/s, `scanner:monitor`, `scanner:status`; ≤ 10 msg/s in total) and opt-in channel
  `scanner-spectrum` (`scanner:spectrum`, ≤ 2 Hz, ≤ 512 bins max-hold dBFS, floor, threshold, track spans). `decoders`
  channel gains `decoder:created` / `decoder:removed` (scanner probes come and go at runtime).
- **`DecoderStatus`:** optional `owner?: "config" | "scanner"`, `scannerJobId?`, `ephemeral?: true`. Suspension reason
  `tuner-scanning` (configured decoders on a source are held once for a whole sweep, not re-suspended per hop).
- **`tuner:command-sent`:** optional `origin?: "rest" | "scanner" | "replay"`.
- **Digital voice port 8082:** probe streams at `/decoders/<probeId>/stream[.wav]`; listen-scan streams at
  `/scanner/<jobId>/stream[.wav]` (8 kHz s16 mono). `/stream` stays bound to configured decoders.
- **Config:** `scanner:` section (on by default, incl. passive in-window discovery per source) and
  `sources[i].scanner {role: "shared"|"dedicated", passive}`.
- **Suggested UI:** view `6 Scan` (jobs, hop strip from `plan.hops[]`, spectrum line, discoveries table with
  `ACT`/`CAND`/`CLASS`/`DEC` and encrypted badges); new-job flow = bandplan preset → range edit → `POST /plan` preview
  with issues and impact in the confirm bar → `y`; takeover confirmation lists the impact; `rx` lane shows
  `scanning 412.6 MHz · hop 7/44` / `paused (SDR++)`; Messages preset `discoveries`; hide or group `owner: "scanner"`
  decoders in the Decoders view.

#### Signal discovery scanner amendment: core `spectrum` channel for waterfalls — 2026-10-09 (still NOT merged)

Requested by WaveKit Main. Supersedes the `scanner-spectrum` channel above.
- **WS channel `spectrum`** (not scanner-specific), message `spectrum:frame` per source: `{sourceId, epoch,
  tuningTrust, centerHz, sampleRateHz, binHz, startHz, binEncoding: "u8-halfdb-127.5", bins (base64 Uint8, value =
  round((dBFS + 127.5) × 2), 0.5 dB steps), floorDbfs, thresholdDb, tracks [{startHz, endHz, flags}], masks {dcHz,
  spurBins}, at}`, max-hold per display interval. Default 10 Hz × 512 bins; server bounds 0.5–25 Hz and 128–2048 bins
  (web UI). One server profile today; per-subscription profiles can be added later without changing the frame.
- Runs whenever a `spectrum` subscriber exists, even with the scanner disabled. Detection runs on the full sample
  stream; only this feed is decimated.
- `tuningTrust: "unverified"` means the frequency axis may be wrong (a retune that bypassed the relay); grey out the
  axis and say so.
- **REST:** `GET /api/spectrum` (per-source engine status + latest frame), `GET /api/spectrum/occupancy?sourceId&startHz&endHz&sinceMs`
  (hourly duty per 12.5 kHz bucket, 7 days); `GET|DELETE /api/scanner/captures…` (burst IQ captures with fixtures
  manifest v2 sidecars).
- **Cursor tuning** uses existing endpoints: `PATCH /api/live-audio/config {offsetHz}` inside the window, or
  `POST /api/tuner/:sourceId/frequency` (this preempts a scanner sweep lease; the job pauses and auto-resumes).
- **Suggested UI:** a waterfall view fed by `spectrum`, with a cursor that listens (offsetHz) or retunes, discovery
  markers from `scanner:discovery`, and an occupancy strip from `/api/spectrum/occupancy`.

#### Signal discovery scanner amendment: identify mode — 2026-10-09 (still NOT merged)

User-confirmed primary use case: click a signal on the waterfall, every plausible decoder tries it.
- **REST:** `POST /api/scanner/identify {sourceId, target: {frequencyHz, bandwidthHz?} | {all: true}, timeoutMs?,
  protocols?, exhaustive?, record?}` → 201 job (`kind: "identify"`); 409 `OUT_OF_WINDOW` when the target is outside
  the tuned window (tune first). Never retunes.
- **WS `scanner:identify`:** `{jobId, targetHz, state: "waiting-for-signal"|"trying"|"identified"|"candidate"|
  "unidentified", trials: [{protocol, decoder, mode, transport, outcome}], result?: {protocol?, confidence, identity?,
  metadata, discoveryId?, measurements: {centreHz, obwHz, peakDbfs, snrDb, floorDbfs, dutyCycle, class}, artefact?:
  "dc"|"spur"|"image"|"rfi"}}`.
- `spectrum:frame` stats gain `blankedFrames`; status warnings `broadband-rfi` (with period) and comb-masked spurs.
- **Suggested UI:** waterfall click → identify with a live trial list (decoder, outcome) and the result card; an
  artefact answer explains itself ("DC spike", "receiver spur", "IQ image of 446.194 MHz", "broadband RFI").
