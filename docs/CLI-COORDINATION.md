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
- Core note (2026-10-10): the GET /api/scanner/settings DTO is ScannerSettingsView { effective, passiveBySource, provenance, bounds }; ScannerSettingsValues is the bare settings object.

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

#### Signal discovery scanner amendment: identify mode details — 2026-10-10 (still NOT merged)

Refines the 2026-10-09 identify amendment (plan Task 35a); everything is additive to it.
- **Request:** `bandwidthHz` sets the match tolerance `max(1 kHz, bw/2)` around `frequencyHz`, so a waterfall click should
  send the display's click width (e.g. 12 500). `timeoutMs` 1000–120000 (default 15000). `record` is a boolean (default
  true: voice, analog and data recordings of the trials). Exactly one of `frequencyHz` or `all: true`, else 400.
- **Errors:** 409 `OUT_OF_WINDOW` carries `details.window {startHz, endHz}`; 409 `SCANNER_SOURCE_BUSY` while a sweep holds
  the source's tuner; 503 `SCANNER_DISABLED`. The job is a normal job (`spec.kind: "identify"`, listed, cancellable,
  deletable when ended) but `pause`/`resume` answer 409 `SCANNER_IDENTIFY_NOT_PAUSABLE` and `PATCH` 409
  `SCANNER_IDENTIFY_NOT_EDITABLE`; `POST /api/scanner/jobs` does not accept `kind: "identify"`. Identify jobs are not kept
  across a core restart; the last 50 ended ones stay listed.
- **`ScanJob.identify`:** `{target, timeoutMs, protocols, exhaustive, record, targets: ScannerIdentifyEventData[]}`, so a
  client that missed WS messages refetches the job.
- **`scanner:identify`:** one stream per target; `all: true` sends one per surfaced emission with `targetHz` = its centre.
  Coalesced to ≤ 1/s per (job, target), latest state always delivered.
- **Trials:** `decoder`, `mode` and `transport` are null for an `unsupported` trial, which carries `reason`:
  `"no-decoder"|"needs-channelizer"|"unsupported-format"`. `outcome` adds `"pending"|"running"` (while trying),
  `"not-needed"` (an earlier trial decoded and `exhaustive` is false) and `"cancelled"`. Trials are per protocol; one
  dsd-fme run covers DMR, P25, YSF and D-STAR, so those share an outcome source.
- **Result:** adds `observationId?`. `measurements` adds `source: "track"|"spectrum"` (`spectrum` = no track resolved, read
  from the last spectrum block at the target), `acf30?`, `acf60?`; `obwHz`, `peakDbfs`, `snrDb`, `floorDbfs` and
  `dutyCycle` may be null. `artefact: "rfi"` is reported only after the wait found no signal; `dc`, `spur` and `image`
  answer at once with no trial.

#### Signal discovery scanner amendment: artefact and spectrum shapes, corrected — 2026-10-10 (still NOT merged)

Final shapes after the second plan review. This entry **corrects** the 2026-10-09 "core `spectrum` channel" and
"identify mode" amendments and the 2026-10-10 "identify mode details" amendment where they differ; where this entry
says nothing, they stand.
- **`spectrum:frame` masks** (corrects the spectrum amendment): `masks: {dcHz, dcGuardHz, spurRanges: [{startHz,
  endHz}]}`. `spurBins` is **renamed `spurRanges`** and carries RF ranges in Hz (what a waterfall draws), not bin
  indices. `spurRanges` holds every masked spur line: baseband spurs plus the fast-path provisional and comb lines.
  The frame also carries `profile` (`"<hz>:<bins>"`) and `binCount`. Frame `tracks[].flags` stay `{burst, iqImage,
  edge}`.
- **Impulse blanking and broadband RFI** (corrects the identify amendment's line "`spectrum:frame` stats gain
  `blankedFrames`; status warnings `broadband-rfi` (with period) and comb-masked spurs", which is **retracted**):
  `spectrum:frame` has no stats, and there is no `broadband-rfi` warning (`SpectrumWarning.code` stays
  `"untracked-retune" | "host-centre-mismatch"`). Both are reported per engine in `GET /api/scanner` and
  `scanner:status`, `engines[]` (`ScannerEngineStatus`):
  - `blankedFrames: number`: the frames blanked as broadband impulses;
  - `broadbandRfi: {periodMs: number} | null`: non-null while periodic broadband RFI is active.

  Show "broadband RFI every N ms" from `broadbandRfi`. Comb-masked spurs appear only as `masks.spurRanges`.
- **`ScannerEngineStatus`** (`GET /api/scanner` `engines[]`), all fields: `sourceId`, `state`, `rbwHz`, `fftSize`,
  `kByRange[]`, `floorDbfs`, `floorOccupied`, `overload`, `settleMode`, `settleMs`, `settleMeasured`,
  `markerSupported`, `stuckTestMode`, `staleAfterSettle`, **`blankedFrames`**, **`broadbandRfi`**, `passive
  {enabled, disabledReason?}`, `frequencyError {hz, ppm, discoveries} | null`, `lastError?`. The bold fields are the
  additions for artefact rejection.
- **`TrackFlags.spur`** is a core-internal sticky track flag (a track on a spur line: baseband, provisional or comb).
  It is not in any DTO. Clients see spur lines only as `masks.spurRanges`; such a track never surfaces and never
  gets a probe. On a fresh install a comb tooth can surface as a `carrier` discovery in its first 30 s, until the
  comb is masked. It is then unlinked, and its discovery is deleted (`scanner:discovery` `change: "deleted"`)
  unless it holds decode evidence. After a restart the persisted spur state starts masked.
- **Identify trials** (corrects the identify details amendment): `mode` and `transport` are null for an `unsupported`
  trial, which carries `reason`. `decoder` names the decoder that would run the trial (e.g. `rtl433` with
  `needs-channelizer`), or is null when none exists (`no-decoder`).
- **Identify verdict:** `identified` means this identify's own trials decoded an identity (H2). A discovery decoded
  earlier, by another transmission or by passive discovery, with no decode in this job gives `candidate`, with the
  stored identity in `result.identity`.
- **Identify timing:** `timeoutMs` bounds only the wait for a signal. A transmission that keys up inside it is still
  tried. If `all: true` finds no surfaced emission within `timeoutMs`, the job completes with `identify.targets: []`
  and sends no `scanner:identify` message; clients see only `scanner:job` `completed`.
- **IQ image answer:** `artefact: "image"` carries no partner field. The UI text "IQ image of <f>" uses
  `f = 2 × masks.dcHz − targetHz` from the latest frame.

## Core → CLI/API: channel suspension reason codes (additive, low priority) — 2026-10-09

Posted by WaveKit Main (core channelizer, branch `feat/core-channelizer`; lands on
`main` with that merge).

The opt-in core channelizer (default off) can suspend a decoder for reasons that are
not source-rate reasons: `channel-outside-capture`, `channel-request-invalid`,
`channelizer-unavailable`. Until `DecoderSuspensionReasonCode` (api-types: rate
codes plus `frequency-out-of-band`) and the strict Fastify enum accept them, core
publishes such a decoder as `suspended: true` with **no `suspension` object** (the
existing `decoder:status` event and REST body).
Request: add the three codes to the union and enum, additively; core then emits
`suspension { reasonCode, since }` for them. No other field changes.

**Landed on `main` 2026-10-10** (merge of `feat/core-channelizer`; channelizer default off, all seven per-decoder flags gate-verified, see `fixtures/GOLDENS.md`). Landing grep: `cli/source/view-models/decoder-rows.ts` reads `suspension?.reasonCode` and renders a code-less suspension as plain "suspended", so no CLI change is required. The web dashboard (`design/web-dashboard`) should treat `suspended: true` without a `suspension` object the same way.

## Main → Scanner / CLI / Web: spectrum profile scope — 2026-10-10 (decision, NOT landed)

User-confirmed scope: bounded simultaneous CLI/web spectrum profiles in scanner S1-B;
genuine higher-resolution viewed-slice FFT in a separate follow-up; WS tuning follows
coalesced REST/accepted-state latency measurement. First connected web milestone:
spectrum → tune → identify → inspect → listen. Access target: single operator on local/LAN,
with authentication and explicit origins covering REST, WS and audio before live browser controls.

Scanner owns the Task 24/25/37a implementation and exact reviewed contract. See
`docs/ROADMAP.md` §8, "Spectrum contract amendment for scanner S1-B", for the scope:
- Preserve planned scanner 10 Hz / 512-bin defaults; add bounded per-client source/profile
  selection. Shared source engines build each profile once and route only matching frames/snapshots.
- Separate worker summary detail from client bins. The current pipeline reduces bins before the
  service sees them. Evaluate a 2048-bin summary ceiling with measured traffic/CPU; it is a bounded
  bridge, not true slice zoom. Report actual bin width/count and native/effective resolution.
- Keep detector behavior independent of display choices; preserve stream/epoch/trust and clear holds
  across retunes/layout changes. Release demand on unsubscribe/disconnect.
- Check simultaneous CLI/web profiles, source/profile switching, late join/reconnect snapshots,
  epoch transitions and cleanup; publish final DTO/config names and limits before landing.
- Keep Task 25 scanner DTO edits narrow. Any eventual WS tuning uses the existing arbiter,
  authorization and operator-origin/preemption semantics; no new WS command bus in this amendment.

Main approves this bounded profile scope. Scanner should incorporate it in its delta/brief and
complete its normal review/checkpoint gates before dispatching the amended Task 37a. Report the
contract and implementation effort; bring conflicts or further scope changes back to Main.
The earlier 37a hold is satisfied by incorporating and reviewing this amendment.

## Main → Scanner: amendment review and access integration boundary — 2026-10-10

Main accepts the amendment report's five conflicts within the approved scope:
current-state snapshots do not imply event replay; the two config-only DTO fields
are narrow additions; achievable display rates must be reported honestly; finer
evidence/identify summaries are subject to existing storage/performance bounds;
and the delta may replace unlanded C5 interfaces. No further product approval is
needed for these decisions. True slice zoom and WS tuning remain follow-ups.

Before finalizing the Task 24/25/37a contract, scanner's normal review must resolve:
- Permanent source removal releases display demand, selections and profile/fanout
  resources, including removal during acquisition. Distinguish permanent removal
  from internal reconnect lifecycle events; do not defer cleanup to resubscription.
- The profile allocation cap remains bounded across default PATCH changes. Explicit
  selections equal to an earlier default cannot accumulate unlimited exempt profiles.
- Make-before-break accounts for the still-active old allocation: enforce the stated
  cap or define and enforce a separate bounded transition allowance.
- Per-client subscribe serialization has bounded queued work and disconnect/stop
  cancellation; failed or superseded acquisitions cannot send stale acknowledgements
  or snapshots or retain demand.
- Reported effective rate matches the scheduler's delivered cadence, or is explicitly
  an upper bound. Include a non-divisor rate such as 15 Hz over 20 Hz summaries.
Automatic pickup of newly eligible sources may remain a documented follow-up.
Report settled config/DTO names, limits and measured summary-budget results to Main.

Access policy/session foundations proceed independently in new modules on
`feat/access-policy`; they are not mounted and do not protect running listeners.
Shared config/API/WS/audio/bootstrap integration waits for a coordinated scanner
contract checkpoint. The approved access rollout preserves current CLI/SDR++
setups until protected mode is configured and requires protected mode for the
connected web UI. Browser setup uses one-time pairing, persistent rolling 30-day
remembered sessions and automatic renewal during active use; no absolute session
age cap is required for a browser returning within that period.

## Main → Scanner / CLI / Web: access adapter checkpoint — 2026-10-10

`feat/access-adapters` now contains reviewed, unmounted Fastify/access-route and
Node HTTP streaming adapters plus startup/exposure/logging helpers. Checkpoint:
284 access tests pass; repository typecheck passes; lint has zero errors and
59 existing warnings. No running listener or existing client behavior changes.

The WS adapter must adopt the original request/socket before broadcaster
registration so expiry/revocation reaches normal scanner disconnect cleanup.
Audio/download admission precedes producer creation, client registration and
headers. After asynchronous setup, callers recheck the lease and explicitly
clean newly created resources if earlier invalidation already ran. Protected
startup must compose one policy/session/lease authority across all listeners.

CLI credential helpers are proceeding separately: credentials are bound to an
explicit trusted server, never sent through discovery, and never forwarded by
HTTP/WS redirects. Existing CLI/runtime wiring follows their review.

Scanner Task 24 is complete; Task 25 remains in review. Its completion alone
does not release the server/WS/audio/bootstrap paths owned by later scanner
tasks. Main will integrate shared paths against the settled scanner snapshot;
scanner should continue its authorized independent tasks and report those
contract checkpoints. No new scanner scope or image-build authorization here.

Main acknowledges scanner's reviewed Task 24/25 code checkpoint (`b62fe9d`,
`033f9a8`): `passiveBySource.<id>` provenance keys, additive `config` provenance,
configuration-only `ws.spectrumSummaryBins` / `ws.spectrumMaxProfiles`, and
optional-key-sensitive core/DTO identity guards are compatible with the approved
web scope. Spectrum frame/profile DTOs and measured summary-budget acceptance
remain Task 37a work. This acknowledgement does not take over scanner's later
shared-file ownership; independent access/CLI/runtime-hygiene work continues.

## Main → Scanner / CLI / Web: independent access assembly — 2026-10-10

The reviewed access foundation, private persistence/session services and unmounted
Fastify/WS/HTTP-audio adapters are ready to land with current main. Actual CLI
credential-file wiring preserves legacy defaults, requires an explicit canonical
API target, keeps discovery credential-free and pauses authentication retries until
operator reconnect. Decoder child environments exclude reserved access secrets;
the container healthcheck uses the public health route.

Full repository tests passed (root 2768, CLI 295, sdr-host 99; 11 existing root
integration skips), typecheck passed, and lint has zero errors/59 existing warnings.
No shared scanner runtime paths were taken over and no listener is protected yet.
Standalone setup/pairing is independently reviewed; its normal build entry will
preserve scanner Task 32's reviewed spectrum-worker entry during integration.

Next independent foundation: a bounded, versioned decode reception envelope with
caller-assigned immutable IDs, separate production/ingestion timestamps and explicit
event-time RF provenance. Existing decoder/scanner payloads and client contracts
remain unchanged during preparation. Public DTO exports and actual publication
require a later coordinated CLI/web/scanner checkpoint; persistent search/replay
remains follow-up work.

## Main → Scanner / CLI / Web: landed independent foundations — 2026-10-10

Local main now includes the reviewed access/CLI batch, standalone setup/pairing
utility, load-only runtime lifecycle context and bounded internal decode envelope.
No existing decoder/scanner event contract or public DTO export was changed by
the envelope. API/WS/audio listeners remain unprotected until actual mounting.

Final root verification passed with two workers: 2905 tests, 11 existing skips;
CLI295 and sdr-host99 passed, as did typecheck/lint. Default concurrency initially
hit load-related timing failures; three generated-fixture test budgets were aligned
with their existing 30-second subprocess budget before the complete root rerun.

Shared runtime integration waits for reviewed scanner Tasks37/37a/38. Preserve
all normal build entries when adding the utility: index, spectrum-worker and
access-command, plus an explicit access command script. Configure named public
analog/digital origins and a valid internal health-probe authority; declared
HTTPS context does not create TLS or verify backend exposure.

The browser access brief is in .kiro/specs/core-access-policy/design.md and uses
the web design snapshot28280cf. It preserves the existing shell, requires actual
mounted capabilities, supports silent rolling renewal, and handles uncertain
pairing/stream failures without repeated login prompts. Coordinate the new
authentication surface with its web owner before implementation.

Sol/Astra's real-zoom brief in ROADMAP §8 begins with measured longer raw-IQ FFTs
at bounded display cadence. It keeps detector arithmetic/results intact, requires
an accepted epoch/sample seam and reports new analysis resolution separately.
Task37a's summary measurement does not establish sustained zoom headroom.

#### Core: signal discovery scanner (pre-channelizer slice) — MERGED on main da55b1e (2026-10-11, not pushed)

The proposal "Core: proposed contract for the signal discovery scanner" landed with these differences:
- Error bodies use the existing flat shape `{ error, code, message, details? }` (as every other route), not the nested `{ error: { … } }` shape written in the proposal.
- `scanner:progress.probes` is a count; the probe list is in `GET /api/scanner/jobs/:id` (`progress.probes[]`).
- Passive jobs (`passive-<sourceId>`) do not appear in `impact.scannerJobs`, so a sweep does not need `takeover` just because passive scanning runs.
- `listen` before the channelizer returns `{ mode: "live-audio", sourceId, frequencyHz, offsetHz, httpUrl, wavUrl }` and answers 409 `OUT_OF_WINDOW`, `LIVE_AUDIO_UNAVAILABLE` or `SCANNER_DISCOVERY_LOCKED_OUT`. Listen's `OUT_OF_WINDOW` `details` are `{liveSourceId, sourceId}` (live audio on another source), `{sourceId}` (centre unknown), `{offsetHz, usableHalfSpanHz}` (outside the window) or `{offsetHz}` (live audio refused the offset).
- New codes: `SCANNER_MONITOR_UNAVAILABLE` (400, listen-scan needs the channelizer), `SCANNER_JOB_NOT_TERMINAL` (409), `SCANNER_INVALID_TRANSITION` (409), `SCANNER_DISABLED` (503), `SCANNER_IDENTIFY_NOT_PAUSABLE` (409), `SCANNER_IDENTIFY_NOT_EDITABLE` (409), `SCANNER_IDENTIFY_VIA_JOBS` (400). Also `SCANNER_JOB_TERMINAL` (409), `SCANNER_SETTINGS_INVALID` (400), `SCANNER_SETTINGS_WRITE_FAILED` (500), `SCANNER_STATE_UNAVAILABLE` (503: persisted jobs/settings unreadable at boot; sweeps and settings changes refused this run), 404 `SCANNER_NOT_FOUND` (route level) and `SCANNER_JOB_NOT_FOUND` / `SCANNER_DISCOVERY_NOT_FOUND` (service level). Full table: `docs/API.md` "Scanner and spectrum codes".
- `SCANNER_SOURCE_BUSY` (409): the detail is in `message` ("holder is starting", "releasing", "recovery pending", a relay client controls the tuner, or the lease holder); `details.holderJobId` when a job holds the source, `details.waiter` when a better-placed job waits for the lease (explicit resume from `paused(preempted-*)`). Every one carries `details.reason: "releasing" | "recovery-pending" | "holder-starting" | "relay" | "held"`; retry the first three after a short delay, show the other two.
- The resume of a `paused(operator)` sweep whose lease an operator or relay write took can answer 409 `SCANNER_TAKEOVER_REQUIRED` with `details.impact` (offer takeover).
- `PATCH /api/scanner/jobs/:id` merges into the job's own spec: derived fields (integration, dwell) follow the edit and `spec.provenance` stays honest.
- Identify (`POST /api/scanner/identify`, `scanner:identify`, `ScanJob.identify`) is merged as in the identify amendments of 2026-10-09 and 2026-10-10, as corrected by the 2026-10-10 "artefact and spectrum shapes" entry. Addition: `ScannerIdentifyResult.ended?: "window-moved"` (the window moved off the target; open trials are `cancelled`).
- The waterfall feed is the core channel `spectrum` (it replaces the proposal's scanner-specific spectrum channel) with `spectrum:frame` frames (`bins` base64 `u8-halfdb-127.5`, `profile` `<hz>:<bins>`, `binCount`, default 10 Hz × 512), plus `GET /api/spectrum` and `GET /api/spectrum/occupancy`. Frame masks are `masks {dcHz, dcGuardHz, spurRanges: [{startHz, endHz}]}` (RF ranges; the earlier amendment's `spurBins` never shipped). Per-client profiles: see "Core → CLI/Web: spectrum profiles" below.
- Impulse blanking and periodic RFI are reported per engine in `GET /api/scanner` / `scanner:status`: `engines[].blankedFrames` and `engines[].broadbandRfi {periodMs} | null`. There are no frame stats and no `broadband-rfi` spectrum warning (`SpectrumWarning.code` stays `untracked-retune | host-centre-mismatch`).
- Burst IQ captures: job field `capture`, `GET /api/scanner/captures` and downloads (`GET /api/scanner/captures/<id>.cu8` / `<id>.json`, `DELETE /api/scanner/captures/:id`).
- Settings view: `provenance` keys per-source passive as `passiveBySource.<id>`; `bounds` and the PATCH body use `passive.<id>`. `ws.spectrumSummaryBins` and `ws.spectrumMaxProfiles` are config-only (PATCH rejects them).
- Not yet available (channelizer batch): `classified` confidence, `scanner:monitor`, analog recordings, `channel` probes.
CLI team: please acknowledge and adapt the `6 Scan` view; everything is additive. The contract was implemented without a CLI ack (user decision 2026-10-10); change requests become follow-up tasks. Operator guide: `docs/SCANNER.md`; reference: `docs/API.md` "Scanner", "Spectrum" and the WebSocket sections.

#### Core → CLI/Web: spectrum profiles (scanner Task 37a, amendment of 2026-10-10, reviewed; Main 32fc238)

**Default selection.**
- `{"type":"subscribe","channels":["spectrum"]}` without options gets the default profile on every eligible source.
- The default profile is `scanner.ws.spectrumHz` 10 × `scanner.ws.spectrumBins` 512, and both stay runtime-PATCHable.

**Per-client selection.**
- The message is `{"type":"subscribe","channels":["spectrum"],"options":{"spectrum":{"sourceId":"rtl","hz":25,"bins":2048}}}`.
- A client has one source and one profile.
- `hz` is snapped to 0.5 and clamped to 0.5–25. `bins` is rounded and clamped to 128–2048. Omitted fields take the
  default's values.
- Subscribing again switches without a gap, and subscribing without options returns to the default selection.
- `unsubscribe` or a disconnect releases the demand.
- Rapid re-subscribes coalesce: only the latest request is answered, and superseded ones get no reply.

**`spectrum:profile`.** Sent to that client only:
`{selection: "none"|"default"|"source", sourceId, profile: {key, hz, bins}|null, effectiveHz, outcome: "default"|"exact"|"nearest"|"rejected"|"removed", adjusted: ("hz"|"bins"|"profile-limit")[], removedSourceId?, code?, message?}`.
- It is the ack to a subscribe, or a notice after a permanent source removal or a default-profile change that
  remapped the client.
- `selection: "none"` means the client receives no frames.
- Codes: `SPECTRUM_OPTIONS_INVALID`, `SPECTRUM_SOURCE_NOT_FOUND`, `SPECTRUM_SOURCE_NOT_IQ`, `SPECTRUM_SOURCE_REMOVED`,
  `SPECTRUM_ENGINE_ERROR`. A rejected request keeps the previous selection.

**Limits.**
- The server serves the nearest admissible profile and never rejects a request for its size.
- Above `scanner.ws.spectrumMaxProfiles` (default 4 distinct non-default profiles over all sources; config-only,
  1–16), a request maps to an active profile on that source or to the default. It prefers profiles not larger than
  the request, so a substitute can still exceed it only when nothing smaller is active.
- The status reports `limits: {maxProfiles, hz: {min, max, step}, bins: {min, max}}`.

**Frames.** `spectrum:frame` keeps its shape and adds `nativeBinHz` and `snapshot?: true`.
- `binCount ≤ bins`, never upsampled, and `binHz` is the true width.
- Cadence: one frame per `ceil(blockHz / hz)` block summaries, with `blockHz = 1000 / integrationMs` (20 at the
  default). `effectiveHz` is that cadence while blocks flow and an upper bound across sweep settles and gaps. For
  example, 25 Hz gives 20 Hz, and 10 or 15 Hz gives 10 Hz.
- Each profile is built once per source and sent only to its clients.

**Ordering.**
- Per client: ack first, then one `snapshot: true` frame per source received (the latest block of the current epoch
  at that client's profile; none while a retune settles), then live frames.
- Spectrum messages bypass the scanner limiter and do not count toward `ws.maxMessagesPerSecond`.

**Client rules.**
- Never merge or accumulate rows across a change of `sourceId`, epoch, `profile`, `binHz` or `startHz`; each row
  carries its own axis.
- Reset on every `spectrum:profile`, except that an `outcome: "removed"` notice with `selection: "default"`
  drops only `removedSourceId`'s waterfall; the client keeps its other sources.
- Compare epochs for equality only, because they restart when an engine restarts.

**Permanent source removal** (`DELETE /api/sources/:id`, which emits `source:removed`):
- affected clients get `outcome: "removed"` (a source selection becomes `selection: "none"`);
- a request in flight for that source ends with that notice only;
- the server releases the demand at once.

A reconnect changes nothing. A source re-added with the same id can be selected again, but default subscribers pick
it up only on their next subscribe.

**Engine summary budget.** `scanner.ws.spectrumSummaryBins` is **provisionally 2048** (config-only, 512–2048; the
fallback is 1024, then 512). It is final once Task 37a reports its measurement: 2048 kept (Mac, minimum of 5
interleaved rounds, sampling every block-summary; 2.048 Msps, `fftSize` 2048, 50 ms blocks): per summary 15,121 B
(1639 bins; about 302 KB/s at 20 summaries/s), clone 53.3 µs, 2048-bin profile 17.0 µs. It is not a client setting.

**REST.** `GET /api/spectrum` returns `{defaultProfile, profiles: [{sourceId, key, hz, bins, isDefault, clients, binCount, binHz, summariesPerFrame, effectiveHz}], limits, subscribers, sources: [… + summaryBinCount, summaryBinHz, summaryHz, reason?: "source-not-iq"|"source-removed"]}`.

**Settings.** `ScannerSettingsValues.ws` gains `spectrumSummaryBins` and `spectrumMaxProfiles`. They are read-only:
`PATCH /api/scanner/settings` rejects them.

**Shared core typing (Task 37a owns it).** `SourceManagerEvents` in `src/core/source-manager.ts` gains
`"source-removed": (sourceId: string, removedAt: Date) => void`. This documents an event that `disconnect()` already
emits (permanent removal only; never on reconnect or shutdown). No behaviour changes.

**Not in this change.** No WS tuning, no new command message, and no slice-zoom FFT (a separate follow-up).

Additions since the amendment text:
- **`GET /api/spectrum/occupancy`**: query `sourceId`, `startHz`, `endHz` (required; `endHz` above `startHz` by at most
  2 GHz) and `sinceMs` (default 24 h, at most 168 h) → `{sourceId, bucketHz: 12500, sinceMs, buckets: [{startHz,
  dutyByHour: (number|null)[], observedMs, activeMs}], top: [{startHz, duty, observedMs, activeMs}]}`. 400
  `SPECTRUM_RANGE_INVALID`, 404 `SPECTRUM_SOURCE_NOT_FOUND`. Query schema violations (a missing or unknown parameter,
  a negative Hz, `sinceMs` below 1 or above 168 h) are rejected first with 400 `VALIDATION_ERROR`.
- **`ScannerIdentifyResult.ended?: "window-moved"`**: the tuned window moved off the identify target (retune, sweep
  takeover); open trials end `cancelled`.
- **`SCANNER_SOURCE_BUSY`** carries `details.holderJobId` when a scanner job holds the source.

#### Core → CLI/Web: scanner S1-B landing grep (2026-10-10)

New fields and messages the CLI (and `design/web-dashboard`) should check before the scanner lands:
- `DecoderStatus.owner` (`"config"|"scanner"`), `scannerJobId`, `ephemeral: true`: hide or group scanner probes in the
  Decoders view; their start/stop/restart/band routes answer 409 `DECODER_OWNED_BY_SCANNER`.
- `suspension.reasonCode: "tuner-scanning"` (a sweep holds the source; a manual start answers 409
  `SOURCE_HELD_BY_SCANNER`).
- `decoders` channel: `decoder:created {decoderId, decoder}` and `decoder:removed {decoderId, removedAt}`.
- `tuner:command-sent.origin?: "rest"|"scanner"|"replay"`.
- New WS channels `scanner` and `spectrum` (both opt-in by subscription).

#### Main: scanner S1 local acceptance and client recovery (2026-10-11)

S1 is locally integrated after sequential whole-feature Sol LOW and Opus MEDIUM reviews. Recorded-IQ DMR acceptance and synthetic sweep executed successfully; the bounded root suite passed. This is backend acceptance, not completed CLI/web integration or live RF acceptance. Existing CLI code has no scanner/spectrum channel consumer yet; the Scan view and web owner must adopt the documented additive contracts.

- Relay/live source identity, IQ, caps and controls follow the same source router; defaults select the first non-dedicated source. An enabled relay with no selectable source prevents core startup.
- Identify startup is bounded separately from its post-readiness signal wait and decoder trials; see API.md. Nullable measurements remain unknown when no IQ was admitted.
- Successful discovery DELETE drains accepted evidence writes/moves and prevents late downloadable resurrection. Capture retention is separate.
- Fatal spectrum failure invalidates cached live frames, fails affected jobs and releases resources. Existing spectrum-only subscriptions receive no automatic profile error notification: consult scanner:status or GET /api/spectrum when frames stop, then re-subscribe after cleanup. Passive configured/enabled state alone does not establish a running job; passive rebuild currently depends on source/settings events. These recovery gaps remain explicit follow-ups.
- Terminal REST job state may precede teardown; admission can still return 409/releasing. Terminal job WS publication follows cleanup. Do not infer settled recording files from terminal state alone.

#### CLI: read-only S1 Scan consumer — 2026-10-11

The additive `6 Scan` / `--view scan` client consumes existing source-selected spectrum profiles and scanner read APIs. It shows spectrum/waterfall, discoveries, existing jobs and identify results; no scanner writes, tuning, listening or downloads were added. Existing API/DTO contracts are unchanged.

Display demand is view-scoped, with explicit same-source recovery, source/profile/layout/epoch resets and no durable replay. Served profile, dBFS power, native bin width, tuning trust and supplied DC/spur RF locations are inspectable, including signed unverified axes. HTTP bodies, collection traversal, history and detail output are bounded. Scanner-owned probes cannot receive manual decoder lifecycle commands.

Observation inspection remains a page-count projection and job detail is reduced; global job truncation is reported. Same-layout/repeated-epoch transparent replacement remains indistinguishable without a stream ID. Physical terminal, sustained load/RF, web bootstrap/TLS and S2 activation acceptance remain separate. Identify submission, cursor tuning and true FFT zoom are follow-ups.

#### Spec relocation — 2026-10-11

The six legacy spec directories now live under `docs/specs/`: activity-recording-catalog, build-devx-overhaul, core-access-policy, decode-envelope, lora-decoder and operator-data. Their contents and requirement/property/task numbering are unchanged. Earlier entries retain historical paths; the browser access brief cited above is now [core-access-policy/design.md](specs/core-access-policy/design.md). Historical readers may use commit `19d07ce58d92fc50f5862fa88e4f039f8be1019d` for the old paths. Frozen plan location history remains historical.

#### CLI: confirmed discovery identification — 2026-10-11

Scan discovery detail now offers `i` with explicit visible target/effect consent and y/n/Esc. It sends the existing frequency-target identify request once, with an explicit source, 15-second signal wait, exhaustive false and record false. Admission remains server-authoritative; there is no new backend contract. `o` opens retained exact-ID inspection independently of source availability or the displayed job list.

Possibly-sent uncertain submissions remain inspection-only for the CLI session, without automatic retry or candidate attribution. Receipts are not durable; restart is not evidence of cancellation. Fresh terminal direct GET permits a new deliberate request but proves neither identification nor cleanup. Source/epoch/intent/credential-wait and rendered-consent fences are local checks; exactly-once and conditional stream/discovery binding are absent. Cursor tuning, listening, physical-terminal/RF and browser/TLS qualification remain separate.

#### Core: public bootstrap and remembered devices — 2026-10-11

Protected composition with canonical public mapping now provides explicit `GET|HEAD /api/access/bootstrap`: closed `AccessBootstrapDto` version 1 contains configured API/WS/named audio destinations and independent current mounted access/audio/operator capability flags, with a 4096-byte budget. It validates the exact raw request boundary and creates no authority or renewal. Invalid unambiguous credentials do not prevent this public read; ambiguous credentials, path variants and upgrades remain rejected. Legacy absence, protected absent-mapping ordinary admission and installed-provider safe 503 are distinct. Bootstrap-path 401 cannot infer pairing availability or unlock controls. Health stays metadata-free.

Session-only `GET|HEAD /api/access/devices` returns closed `AccessDevicesDto` rows containing only device ID, creation/renewal/expiry clocks and current marker. This is committed unexpired remembered-session inventory, not online presence. Reads use one authority clock, revalidate the requester and expose no pending mutation, renewal, pruning or private metadata; machine authority remains forbidden. Shared schemas/types are exported by `@wavekit/api-types`; existing CLI contracts are additive and current CLI code does not consume these new endpoints. Both routes use no-store, safe serializers and body-free real-wire HEAD responses.

Browser onboarding/renewal, trusted canonical destination delivery and actual cookie/CORS/TLS/proxy exposure remain separate acceptance gates. No web UI or live receiver change is included. See [API.md](API.md) and the [access checklist](specs/core-access-policy/tasks.md).


### 2026-10-12 — live-audio level telemetry

Core publishes `live-audio:level` on the existing `live-audio` WS channel at 10 Hz:
`{ sourceId, channelPowerDbfs: number|null, noiseFloorDbfs: number|null, squelchOpen, thresholdDbfs }`.
CLI validates these frames and drops them before store dispatch because it does not
currently display the levels. Valid frames do not increment `invalidFrames` or
trigger per-frame state updates; malformed level frames still count as invalid.

#### Core: scanner resume contract and SF1 additions — 2026-10-13

Announcement for CLI follow-up; all fields are additive and optional, so no CLI change is required. Spec: [scanner-followups](specs/scanner-followups/requirements.md).

Resume contract (already shipped, not yet consumed by the CLI):

- `ScanJob.resumeAt` (ISO deadline of the automatic resume after operator or relay preemption, or null) and `resumeHeldBy` (`audio`, `identify`, `recording` or null). An elapsed `resumeAt` stays fixed while resume is pending. Job-to-job lease hand-back ignores these holds. A job's `scanner:job` event is re-emitted when only these values change.
- Stay here: `POST /api/scanner/jobs/:id/pause` on `paused(preempted-*)` makes the job `paused(operator)` without taking the lease; it no longer auto-resumes and stays paused across restart, even with `resume.onBoot`.

SF1 additions (scanner follow-ups batch 1):

- `ScanJob.preemptedBy?: { jobId, name }` (name null when that job has none), present only on `paused(preempted-job)` while another job holds the lease; derived, never persisted. The paused job's view is re-emitted when the holder changes or the lease is freed.
- `ScanRange` gains optional `enabled` (absent = enabled; a disabled range stays in the job but is not planned, swept, masked or matched), `name` (1 to 100 characters), `dwellMs` (hop dwell of overlapping hops) and `sensitivity` (CFAR target of that range; integration stays job-level). `Hop.dwellMs?` appears only when a range sets it.
- `ScanJobSpec.signalsOnly?` (discover jobs): the job finds signals but requests no decoder trials of its own. Present only when set.
- `PATCH /api/scanner/jobs/:id` accepts `ranges` (index-aligned full state of the job's effective `spec.ranges`) and `signalsOnly`. Only `enabled`, `protocols`, `name`, `dwellMs` and `sensitivity` may change, applied at the next hop; a changed edge, raster, OBW or band-plan id, or a different count, is 400 `SCANNER_PLAN_INVALID` with a `range-locked` issue (`details: { index, fields }` or `{ expected, received }`). Later patches of any key keep earlier range edits.
- Two new `PlanIssueCode` values: `range-locked` (PATCH only) and `signals-only-unsupported`. The CLI's identify issue allow-list (`cli/source/data/api-client.ts`) needs neither; any exhaustive switch over `PlanIssueCode` should add them.
- `GET /api/scanner/discoveries` accepts `identity=<kind>:<value>` (known identity kind, non-empty value, case-insensitive exact value match; else 400 `VALIDATION_ERROR`), and `q` now matches the operator label or the identity value (a superset of before).

Optional CLI follow-ups: show `preemptedBy` and the resume countdown/hold on paused jobs and offer Stay here; per-range enable toggles and names in job detail; a signals-only marker; identity search in the discoveries view.

#### Core: correction to the SF1 scanner announcement — 2026-10-13

Corrects the entry "Core: scanner resume contract and SF1 additions" above:

- Not purely additive for PATCH: before SF1 a `ranges` key in `PATCH /api/scanner/jobs/:id` was ignored; now it is validated as the full state of the job's effective `spec.ranges`. A client that echoes its create body (operator ranges only, no inherited rasters or band-plan ranges) now gets 400 `SCANNER_PLAN_INVALID` with `range-locked`, and a body that passes clears protocols inherited from a band plan. Send `ranges` only to edit them. The CLI does not PATCH jobs today.
- Timing: the hop plan changes at the next hop; detection masks, protocol matching, probes and `signalsOnly` change as soon as the PATCH returns.
- Per-range `sensitivity`: ranges with identical edges share the most sensitive target set; a range without one counts at the detector's current target (not its own job's sensitivity).
- Stored range edits remember the edges (and band plan) of their range. If a job's band plan changes later, edits that no longer match their range are dropped and the PATCH response carries one `range-locked` issue with severity `warning` (`details.reason: "range-live-stale"`); it never blocks the PATCH. Clients that treat every `range-locked` as an error should check `severity`.

#### Core: SF1 range edits after a band-plan change — 2026-10-13

Follow-up to the SF1 correction above. A `PATCH /api/scanner/jobs/:id` that sends `ranges` read before the job's band plan changed, where an edit it sent would no longer land, is refused with 400 `SCANNER_PLAN_INVALID` and a `range-locked` error with `details.reason: "range-plan-changed"`; the job is unchanged. Re-read the job (a PATCH of another key re-plans it) and resend. The `range-live-stale` warning for older edits appears only in the answer of the PATCH that dropped them; it is not kept in the job's `issues` and does not repeat. No CLI change is required.

#### Core: WG1 web gaps — 2026-10-13

Announcement for the CLI; no CLI change is required. Spec: [web-gaps-1](specs/web-gaps-1/requirements.md). Details in [API.md](API.md).

- Spectrum subscribe options `averaging` (1–32, off by default) and `backfillMs` (0–10000, off by default) are opt-in. The CLI never sends them, so it receives exactly the messages it did before: profile keys stay `<hz>:<bins>`, no frame has `backfill`, no ack has `backfillFrames`, and `adjusted` stays within `hz`, `bins`, `profile-limit`. If the CLI ever sends the new options, `cli/source/data/scanner-guards.ts` must accept the `<hz>:<bins>:a<n>` key (the frame regex), the `averaging` and `backfillMs` adjustments (the `adjusted` enum at :103, max 3 today), `backfillFrames`, the view's `averaging` and the frame's `backfill: true` (Zod currently strips it, so a replayed frame would look live).
- `live-audio:transmission` on the `live-audio` channel: one open and one closed event per squelch-delimited transmission of the live demodulator. The CLI subscribes to `live-audio` and has no guard case for it, so each event currently increments `invalidFrames` (nothing else). A follow-up should drop it like `live-audio:level` or show it.
- New `vessels` channel (`vessel:new`, `vessel:update`, `vessel:lost`, `vessel:stats`) and `GET /api/vessels`, `/api/vessels/stats`, `/api/vessels/:mmsi`. The CLI does not subscribe; nothing changes for it.
- Activity is now on by default with bounded retention and admission (250,000 rows, 256 MiB, 3 days; 50/s burst 500 global, 20/s burst 200 per decoder), and gains the `analog-transmission` kind. The CLI has no Activity view and ignores `activity` frames, so nothing changes; any future view will see data by default and must handle the new kind.
- `scanner:progress` now arrives at up to 2 Hz per job (other scanner messages stay at 1/s per key, same global budget). Plan preview POI uses each hop's own dwell when a range sets `dwellMs`.

Update to the WG1 note above (2026-10-13): the CLI now validates `live-audio:transmission` and drops it like `live-audio:level` (no UI), so it no longer increments `invalidFrames`; a malformed one still counts as invalid.

Update to the WG1 note (R1, 2026-10-13): Activity now stores a position-only aircraft or ship reception at most once per entity per 60 s (first sightings and callsign/squawk/static changes always), and `GET /api/activity/status` `stats` gains `coalescedPositions`. Spectrum backfill is trimmed to the client's free outbound queue room, so `backfillFrames` can be lower than requested. The CLI uses neither; no change required.

Update to the WG1 R1 note (R2, 2026-10-13): Activity coalesces only redundant position/presence updates (allowlisted position, kinematics and reception fields with unchanged identity; AIS types 1, 2, 3, 18, 19, 27 only); any other field or AIS type is stored. `stats.coalescedPositions` is optional in `@wavekit/api-types` (older cores omit it). Backfill never causes a disconnect the ack and snapshots alone would not. No CLI change required.

#### Core: WG2 web gaps — 2026-10-13

Announcement for the CLI. Spec: [web-gaps-2](specs/web-gaps-2/requirements.md). Details in [API.md](API.md) and [SCANNER.md](SCANNER.md). One CLI change landed with the batch (first bullet); the rest needs none.

- CLI change: the core now writes its private session snapshot as version 2 (device `name`, `kind`, `lastSeenAt`). `cli/source/data/access-credentials.ts` read only version 1 with strict records, so `--credential-format access-state` (the default) would have refused the credential after the core's first session write. It now accepts version 1 and version 2 (strict, the three new keys required in v2); covered in `access-credentials.test.tsx`.
- New channels `aprs` (`aprs:new`, `aprs:update`, `aprs:lost`, `aprs:stats`) and `mesh` (`mesh:new`, `mesh:update`, `mesh:lost`, `mesh:stats`) and routes `/api/aprs/*`, `/api/mesh/*`. The CLI does not subscribe, so it sees nothing. Note: `ws-client.ts` counts a frame it cannot parse as `ws:invalid`; tolerate unknown channels before subscribing to these.
- `vessel:update`, `aprs:update` and `mesh:update` are throttled per entity (2 s; identity changes, new and lost immediate). The CLI does not subscribe to any of them.
- Activity rows from decoder receptions carry presentation (`category`, `protocol`, `entityKey`, `title`, `fields`, `position`); APRS and Meshtastic positions are coalesced like aircraft and ships. Old rows are not backfilled. The CLI has no Activity view.
- Optional DTO fields: `live-audio:transmission` closed events and `analog-transmission` payloads gain `tone: { ctcssHz, dtmf }` (the CLI guard checks keys individually: fine); `digital-voice:call` and dsd-fme `voice-call` outputs gain `colourCode`, `nac`, `algorithmId`, `keyId`, `ran`, `errors` (the CLI does not subscribe to `digital-voice` and its decoder-output guard does not reject extra keys); access device rows gain `name`, `kind`, `lastSeenAt` (the CLI has no device view); new route `POST /api/access/devices/label`.
- Scanner: `PlanPreview.lockoutExclusions`, `ScanJob.lockoutExclusions`, `ScanJobProgress.hitStats`, `scanner:progress` `hits`/`newDiscoveries`, `scanner:discovery` `jobHits`, and `GET /api/scanner/jobs/:id/hits`. The CLI's scanner Zod objects are not strict, so the extra keys are stripped. No new `PlanIssueCode`.
- Behaviour change visible in the CLI's scanner views: a discovery marked Ignore (`lockout: true`) is now also skipped by sweep jobs on its sources (at most 256 per job, never emptying a plan); clearing or deleting the lockout restores coverage. Probe, recording and monitor gating are unchanged.
- AIS NMEA sentences with a wrong checksum are dropped and counted in the decoder's `stats.errors`; APRS Mic-E positions are now correct (West longitudes were East before), which changes positions in `decoder:output` for Mic-E packets.

Update to the WG2 note (R1, 2026-10-13): the CLI's access-state reader is tolerant of v2 label values it never uses (`name` string up to 256, `kind` any string up to 16, `lastSeenAt` a non-negative integer, each nullable); unknown keys are still rejected and v1 is still accepted. The CLI's APRS message row now labels speed in knots (`kn`), as the APRS spec and the core use; weather wind stays mph. Update the CLI with the core: a pre-WG2 CLI reading the credential from `access-state` refuses a v2 snapshot. Also: `newDiscoveries` on scanner hits now counts discoveries, not observations; the digital-voice status route keeps the call metadata fields.

#### Core: WG3 web gaps — 2026-10-16

Announcement for the CLI. Spec: [web-gaps-3](specs/web-gaps-3/requirements.md). Details in [API.md](API.md). One CLI change landed with the batch (first bullet); the rest needs none.

- CLI change: `cli/source/data/ws-client.ts` now ignores a frame whose `channel` is a string the CLI does not know (anything other than its subscribed channels, `scanner`, `spectrum` and `activity`) instead of counting it as `ws:invalid`. Frames without a channel, and unknown types on a known channel, are checked as before. A test helper in `tests/unit/cli/runtime.test.ts` that used a made-up channel now uses the real ones.
- New route `GET /api/coverage` (ADS-B and AIS range per 1° bearing over 24 h from `station.lat`/`station.lon`; 200 `available: false` without a station location). The CLI does not call it.
- Mesh: `MeshNode` gains optional `telemetry` and `neighbours`, `MeshTrackerStats` gains optional `telemetryPackets` and `neighbourReports`, on the routes and on `mesh:update`/`mesh:stats`. The CLI does not read mesh data.
- Activity: decoder receptions now carry `provenance.sourceId` and `provenance.frequency` when known (null before); Meshtastic flood copies (same `from`, `id`, `portnum`, payload within 30 s) are no longer stored; paging and replay can now reset with the existing `snapshot-reset` / `cursor-gap` reasons when retention deletes a row that is not the oldest. No DTO, frame or reason changed. The CLI has no Activity view and ignores `activity` frames.
- readsb now receives `--lat`/`--lon` from `station` whether or not `enableMlat` is set; explicit decoder options win. Decoder status is unchanged.
- The retention policy (fair-share) and the `retention` and `floodCopies` fields of `GET /api/activity/status` follow in an update to this note.

Update to the WG3 note (2026-10-16): for readsb, a complete valid decoder-option `lat`/`lon` pair wins over `station`; a single or invalid option coordinate falls back to the full station pair.

Update to the WG3 note (retention, 2026-10-16): Activity retention now has `activity.retention.policy`, `fair-share` (default) or `oldest-first`. Under `fair-share` the row and byte caps are water-filled across shares (`decoder:<id>`, or `kind:<kind>` for rows without a decoder), oldest first inside a share; age pruning, caps and hysteresis are unchanged, and a station with one feed keeps the same rows as before. `GET /api/activity/status` `stats` gains two optional fields, both additive and optional in `@wavekit/api-types` (`ActivityStoreStats`; older cores omit them): `retention` (`policy`, `effective`, `shares` of `{ key, rows, bytes, oldestReceivedAt }` at most 64, `sharesTruncated`, `prefixFallbackSteps`) and `floodCopies` (Meshtastic flood copies not stored; not losses, not in `dropped`). Details in [API.md](API.md#retention). The CLI does not read Activity status. No CLI change required.

WG3 update (acarsdec): `decoder:output` ACARS messages no longer carry an invented
`frequency` of 131.55 MHz when acarsdec does not report one; the field is now absent
in that case. Clients that display it should treat it as optional (the CLI formatter
already does). dumpvdl2's embedded ACARS messages always carry it.

#### Core: WG4 web gaps — 2026-10-16

Announcement for the CLI; no CLI change is required. Spec: [web-gaps-4](specs/web-gaps-4/requirements.md). Details in [API.md](API.md). Everything below is additive: new routes, and new optional fields that `@wavekit/api-types` marks optional (older cores omit them). A grep of `cli/source` finds none of them in use, except the APRS path text (last bullet).

- New routes: `GET /api/activity/trails` (bulk position trails from Activity, default 1 h, at most 24 h), `GET /api/station/estimate` (approximate station location, `authoritative: false`), `GET /api/storage` (bounded storage report without paths) and `PATCH /api/station` (protected mode only; `If-Match` revisions; errors 400/409/412/503). The CLI calls none of them.
- Station: `StationProvenance` gains `"ui"` (a value written by `PATCH /api/station`; precedence env > yaml > ui > default), and `StationIdentity` gains optional `revision` and `writable`. A client that switches over provenance values must accept `ui`.
- AIS: `ship` decoder output gains optional `channel` (`A` or `B`); stored receptions then carry 161.975 or 162.025 MHz as provenance frequency. `VesselState` is unchanged.
- Mesh: `MeshPosition` gains optional `fixAt` (sender GPS fix time, ISO, or null), on the routes and on `mesh:*` frames.
- SDR host: `SdrHostStatus` gains optional `version` (string or null) in `/api/resources` and `/api/resources/sdr-hosts`.
- Live audio: `LiveAudioConfig` and `LiveAudioStatus` gain optional `agc` (`off`, `slow`, `fast`); `PATCH /api/live-audio/config` accepts `agc: null` to reset. Absent `agc` keeps today's per-modulation chain.
- APRS: live direwolf paths now mark the last repeated digipeater with `*` (`W1AW*`), in `decoder:output` APRS `path` and `AprsStation.path`. Path elements are still strings; a client comparing them to callsigns should strip the trailing `*`. The CLI's APRS message row joins the path, so it now shows `W1AW*` exactly as direwolf prints it; no change required.

#### Core: WG5 web gaps (verified tuning trust, trail altitude, AIS types) — 2026-10-16

Announcement for the CLI; no CLI change is required. Spec: [web-gaps-5](specs/web-gaps-5/requirements.md). Details in [API.md](API.md). Everything below is additive. A grep of `cli/source` finds no reader of the new vessel fields, of `altM` or of Activity provenance; the CLI reads `tuningTrust` only from scanner discoveries and spectrum frames, which this batch does not change. The Activity aggregate routes and the new band plan import formats follow in an update to this note.

- Activity provenance: `provenance.frequency.tuningTrust` on decoder receptions is no longer always `unverified`. It is `commanded` or `relay` when the observed tuner state proves the decoder hears its targets (the centre captured at the decoder's last create or start, and every target within 0.45 × sample rate), else `unverified`. Same three values as before. A retune of the dongle host that bypasses WaveKit and the relay is not observed.
- Activity presentation and trails: `position` may carry `altM` (whole metres, -500..50,000) on new rows; trail points' fourth element is then a number instead of null. Meshtastic POSITION receptions now have a position, so mesh trails are no longer empty. Old rows are not backfilled.
- Vessels: `VesselState` gains optional `channel` (`A`, `B` or null), `aton` (`{ aidType, virtual, offPosition }` or null, class `aton` only) and `altitudeM` (number or null, class `sar` only), on `/api/vessels*` and the `vessels` channel frames. Optional in `@wavekit/api-types`; WG5 cores always send them. AIS types 4, 9 and 21 now give positions.

Update to the WG5 note (2026-10-16): two new Activity routes, `GET /api/activity/bandmap` (stored rows per frequency bucket) and `GET /api/activity/timeline` (stored rows per time bucket and category), and band-plan import formats `sdrsharp-xml` and `gqrx-csv`, now listed in `capabilities.importFormats` alongside `sdrpp-json`. All additive. A grep of `cli/source` finds no caller of either route and no reader of `importFormats`, `ImportPreview`, `sdrsharp` or `gqrx`. No CLI change required.

Correction to the WG5 note (2026-10-16, R1): `tuningTrust` is `commanded` or `relay` only when the tuner centre and rate were written by WaveKit or seen in an accepted relay command; a value only declared by config or source caps (new optional `TunerState.declaredOnlyFields`) proves nothing, so a fresh start or a reset reconnect is `unverified` until re-commanded. Direct sampling on, or a relay frequency/rate the core ignored (now listed in `unknownFields` until the next accepted value), is also `unverified`. Additive.

#### Core: WG6 web gaps (decoded elsewhere, option schemas, DCS, band-plan URL import, config export, rate presets) — 2026-10-16

Announcement for the CLI; no CLI change is required. Spec: [web-gaps-6](specs/web-gaps-6/requirements.md). Details in [API.md](API.md). Everything below is additive: new routes, new optional fields that `@wavekit/api-types` marks optional (older cores omit them) and two new plan issue codes. A grep of `cli/source` finds no reader of any of them (`decodedElsewhere`, `skipDecodedElsewhere`, `lastDurationMs`, `optionIssues`, `options` on `/api/decoders/types`, `dcs`, `preview-url`, `check-update`, `urlImportHosts`, `sourceUrl`, `config/export`, `sampleRatePresets`, the new issue codes); CLI `tsc` passes.

- Scanner: `PlanPreview.decodedElsewhere` and `ScanJob.decodedElsewhere` (`[{ startHz, endHz, sourceId, decoderIds, applied }]`, runtime only) list the ranges running decoders on other sources provably cover; `ScanJobSpec.skipDecodedElsewhere` (sweep jobs, live-editable through PATCH) applies them as exclusions. New `PlanIssueCode` values `decoded-elsewhere-truncated` and `decoded-elsewhere-not-applied` (warnings); the CLI's `IDENTIFY_ISSUES` set ignores unknown codes. `ScanJobHit.lastDurationMs` (integer ms or null) on the hits route and on `scanner:discovery` `jobHits`. The CLI's scanner Zod objects are not strict, so extra keys are stripped.
- Decoders: `DecoderStatus.optionIssues` (report only; decoders start exactly as before) on the routes and `decoder:status`; `GET /api/decoders/types` items gain `options` (descriptors). `PATCH /api/decoders/:id` still answers 501.
- Live audio and Activity: closed `live-audio:transmission` events and `analog-transmission` payloads gain `tone.dcs` (`{ code, polarity }` or null; always sent by WG6 cores). Activity rows show `DCS 023N` and index the twin spelling.
- Band plans (protected mode only): `POST /api/bandplans/imports/preview-url`, `POST /api/bandplans/packs/:packId/check-update`, optional `sourceUrl` on the import commit and on pack provenance, `capabilities.urlImportHosts` on the stack view; new error codes `BANDPLANS_URL_IMPORT_DISABLED`, `BANDPLANS_URL_REFUSED`, `BANDPLANS_URL_FETCH_FAILED`, `BANDPLANS_URL_TIMEOUT`.
- Config export (protected mode only): `GET /api/config/export` (redacted YAML). Not mounted in legacy mode.
- Receiver capabilities: `sampleRatePresets` (`suggested` with `valuesHz` on `rtl_tcp` sources, else `not-applicable`); the values equal the CLI's local preset list.
- Shipped config: `config/dev_test.yaml` no longer sets `fmGain` on direwolf, `sampleRate` on rtl433 or `outputFormat` on acarsdec (no adapter read them).

#### Core: WG7 web gaps (ambient identify, noise and tone squelch, gain tables, band-plan skips, audio CORS, bounded options) — 2026-10-16

Announcement for the CLI and for the web session (the web app on the GitHub branch `claude/project-thread-afdtom`, `web/` workspace, `@wavekit/web`, mock core). Spec: [web-gaps-7](specs/web-gaps-7/requirements.md). Details in [API.md](API.md). Everything below is additive: new optional fields that `@wavekit/api-types` marks optional (older cores omit them), new enum values and new issue codes. CLI `tsc` passes. A grep of `cli/source` finds no reader of `ais-mmsi`, `acars-reg`, `vdl2-addr`, `lora-node`, `no-ambient-decoder`, `bandPlanSkips`, `skipBandPlanSkips`, the `bandplan-skips-*` codes, `noiseQuietingDb`, `toneSquelch`, `gainTable`, `groupOverrides`, `Access-Control` or `verbosity`. `squelchMode` appears only in a CLI test fixture, and the strings `ais`, `acars` and `vdl2` only as `decoder:output` message types, which this batch does not change. One CLI reader does need a change (first bullet). No CLI-visible string changes: the CLI's `CORE v…` row reads `/api/status` `version`, which is still `1.0.0` (now taken from the root `package.json`).

For the CLI:

- Action needed (identify): `cli/source/data/scanner-guards.ts` validates an identify trial's `transport` as `z.enum(["offset", "channel"]).nullable()`. A WG7 core adds `transport: "ambient"` trials when an AIS, ACARS, VDL2 or LoRa decoder already runs on the identify source at the target frequency, also for the CLI's `protocols: []` request. Such a job then fails the CLI guard: the identify POST is not attributed, the job and job-list reads come back invalid, and `scanner:identify` events are ignored. Widening the enum to `["offset", "channel", "ambient"]` is enough; the other trial and result fields (`protocol`, `decoder`, `identity.kind`, `reason`) are free text there and the outcome values are unchanged.
- Scanner: `ScannerProtocol` gains `ais`, `acars`, `vdl2` and `lora`; `IdentityKind` gains `ais-mmsi`, `acars-reg`, `vdl2-addr` and `lora-node`. These protocols have no probe decoder, so scan plans and cost estimates are unchanged. Identify plans ambient trials (`transport: "ambient"`, `decoder` and `mode` = the running decoder type: `ais-catcher`, `acarsdec`, `dumpvdl2`, `lora-meshtastic`), at most 8 per target; a protocol named in `protocols` without a covering decoder is `unsupported` with reason `no-ambient-decoder` and `transport: null`. Trust rule: the decoder's provenance binding must name the identify source (a binding without a source, i.e. an external-input decoder, never counts), its tuning trust must be `commanded` or `relay`, the decode's frequency must lie within 1 kHz of one of the binding's targets, and an identity needs two clean decodes in one engine epoch. A client switching over protocol, identity kind, transport or reason values must accept the new ones.
- Scanner plans: `ScanJobSpec.skipBandPlanSkips` (boolean, optional, absent = false, live-editable through PATCH; sweep jobs apply it); `PlanPreview.bandPlanSkips` and `ScanJob.bandPlanSkips` (runtime only) list `{ startHz, endHz, bandKeys, applied }` ranges, at most 256; new `PlanIssueCode` values `bandplan-skips-not-applied` and `bandplan-skips-truncated` (warnings). The CLI's `IDENTIFY_ISSUES` set ignores unknown codes and its scanner Zod objects are not strict.
- Decoded elsewhere: the ranges now follow decoder changes (created, started, stopped, error, restarting, removed, health or status change): 2 s after the last change, at most once per 30 s and no later than 30 s after the first pending change; a job is announced only when its list changed. This replaces the WG6 "plan-time only" rule. No shape change.
- Live audio: `squelchMode` gains `noise` (FM quieting, NFM and WFM only; 400 with other modulations), with `noiseQuietingDb` (1–30 dB, default 6). Config and status responses now always carry `squelchMode`, `autoMarginDb` and `noiseQuietingDb` with their defaults; `live-audio:transmission` events and `analog-transmission` rows carry `noiseQuietingDb` in noise mode only. `LiveAudioConfig.toneSquelch` (`{ kind: "none" }`, `{ kind: "ctcss", frequencyTenthsHz }` or `{ kind: "dcs", code, polarity }`, NFM only, standard tones and codes only) mutes the audio until the tone is heard; `LiveAudioStatus.toneSquelch` reports `{ state: "off" | "waiting" | "open" }` while running. The tone gate mutes audio only: transmission events, Activity rows and tone results are unchanged. Both apply without a pipeline restart. The squelch noise tail is fixed in the manual and auto modes: noise blocks just below the threshold no longer hold the gate open, so the unmuted audio after a carrier stops is about 260 ms in the synthetic test (it ranged from 0.26 s to over 1.6 s), and such transmissions end earlier. Real-RF acceptance is open.
- Receiver capabilities: rtl_tcp items gain `gainTable`: `{ state: "suggested", provenance: "librtlsdr-tuner-gains", tuner, valuesTenthsDb }` when the advertised header matches a cited librtlsdr table (E4000, FC0012, FC0013, R820T, R828D), else `{ state: "unknown", reason }` (`header-not-advertised`, `unlisted-tuner-type`, `gain-count-mismatch`, `no-gain-table`), or `{ state: "not-applicable", reason: "non-rtl-transport" }`. A suggestion matched on two header integers, not receiver evidence; the gain command's validation is unchanged. Tuning ranges are not added.
- Decoder options: numeric options are clamped to their bounds or fall back to the adapter default, with one warning per decoder and key that never carries the value; decoder logs carry no option text. multimon-ng `verbosity` is an integer 0–10; `frequencies` lists (8 for acarsdec and dumpvdl2, 64 for multimon-ng), rtl_433 `protocols` (256) and multimon-ng `modes` (8) are capped; `extraArgs` is at most 64 strings of at most 4 096 bytes (65 536 in total); shell pipelines carry only formatted finite numbers. The schemas and descriptors carry the same bounds. Argv for every shipped config is byte-identical. Bounds table: [API.md](API.md#get-apidecoderstypes).
- Band plans: URL import refuses an explicit port and any `#` in the raw URL string (the schema now matches the fetcher); group overrides of a URL import are stored in the pack provenance (`groupOverrides`, at most 64) and applied by the update check.
- `version` on `GET /api/status` is the root `package.json` version, put into the bundle at build time (previously a hard-coded `1.0.0`); the config export header and the band-plan fetcher's `User-Agent` use the same value. A run without the build define reports `0.0.0-unknown`.

For the web session (web app on `claude/project-thread-afdtom`):

1. `docs/web/CORE-GAPS.md` on the web branch is stale (audited before WG4). Main now has, through WG7: WG4 post-demodulation AGC, the storage report (`GET /api/storage`), bulk Activity trails (`GET /api/activity/trails`), station `PATCH /api/station` (protected mode) and `GET /api/station/estimate`, the SDR host `version`; WG5 Activity band map and timeline (`GET /api/activity/bandmap`, `GET /api/activity/timeline`), AIS types 4, 9 and 21, SDR# XML and Gqrx CSV band-plan import, verified `tuningTrust` on receptions; WG6 `decodedElsewhere` and `skipDecodedElsewhere`, hit `lastDurationMs`, decoder option schemas and descriptors, DCS on transmissions, band-plan URL import and update check, config export (protected mode), sample-rate presets; WG7 everything in this note (ambient identify, noise and tone squelch, the noise tail fix, `gainTable`, band-plan skips, the decoded-elsewhere refresh, audio stream CORS, bounded decoder options, the build version). Please re-audit it against main.
2. Keep `tuningTrust` strict. It is `commanded` or `relay` only when WaveKit wrote (or saw in an accepted relay command) both the centre frequency and the sample rate; a value only declared by config or source caps proves nothing. A web client that commands only the frequency will normally see `unverified`: command the sample rate as well. Ambient identify counts only `commanded` or `relay` decoders.
3. Audio stream CORS is fixed. In legacy access mode the live audio and digital voice stream servers send `Access-Control-Allow-Origin: *` (never with credentials) on every response, 404 and 503 included, and `OPTIONS` on a stream path answers 204 (`GET, OPTIONS`, `Range`, max-age 600). In protected mode nothing changes: only allowed origins, with credentials, as on REST. `Access-Control-Allow-Private-Network` is not sent.
4. `POST /api/scanner/identify` can answer 409 `SCANNER_SOURCE_BUSY` with `details: { reason: "held", holderJobId }` while a sweep holds the source's tuner. The web mock never does; please add it.
5. The identify window is the scan engine's current window (its current epoch), not the tuner state's centre and rate. A target outside it answers 409 `OUT_OF_WINDOW` with `details.window { startHz, endHz }`; use that window, or the spectrum frame's `centerHz`/`sampleRateHz`, to decide whether identify is possible.
6. New fields to read: `gainTable` (receiver capabilities: a real gain slider), `toneSquelch` (live audio config and status; a saved frequency's tone is not applied by the core, operator data `capabilities.toneSquelch` stays `false`, so PATCH it into the live audio config), `squelchMode: "noise"` with `noiseQuietingDb`, `bandPlanSkips` / `skipBandPlanSkips` (scanner plans) and ambient identify trials (`transport: "ambient"`, the four new protocols and identity kinds).

No frozen WG7 name changed during the lanes; the contract tests are unchanged.

Update (WG7 Main): the CLI identify guard action above is done in the same batch; `cli/source/data/scanner-guards.ts` now accepts `transport: "ambient"` (test in `tests/unit/cli/scanner-guards.test.ts`). The web client needs the same when it parses identify trials.

#### Core: WG8 web gaps (decoder settings and PATCH, recordings inventory, spectrum bins cap) — 2026-10-16

Announcement for the CLI and for the web session (the web app on the GitHub branch `claude/project-thread-afdtom`). Spec: [web-gaps-8](specs/web-gaps-8/requirements.md). Details in [API.md](API.md). Everything below is additive: new protected routes, new optional fields that `@wavekit/api-types` marks optional (older cores omit them) and new error codes. With the shipped config and legacy access mode every existing route, frame and limit is unchanged. A grep of `cli/source` finds no reader of `patchable`, `/settings`, `DECODER_CONFIG_UPDATE_UNSUPPORTED`, `DECODER_OPTION*`, `DECODER_SETTINGS*`, `/api/recordings`, `RECORDING*`, `binsCap`, `spectrumBinsCap`, `spectrumSummaryBins` or `limits`; the CLI never calls decoder PATCH or reads option descriptors. Its spectrum guards (`cli/source/data/scanner-guards.ts`: profile `bins` and frame `binCount` at most 2048, profile size at most 2048) still hold, because the CLI subscribes with `bins: 512` and the default profile stays within 128–2048; its status guard reads only `defaultProfile` and `sources`, not `profiles` or `limits`. No CLI change required.

- Decoder settings (protected mode only, `DECODER_SETTINGS_REQUIRES_ACCESS`): new `GET /api/decoders/:id/settings` (`DecoderSettingsView`: per documented key `source` `override` | `config` | `default`, `patchable`, `secret`, `present`, and `value` only on a patchable non-secret key; `enabled` with its source; `revision`; `pendingRestart`; optional `overrideIgnored: "type-changed"`), and a working `PATCH /api/decoders/:id`: a JSON merge patch `{ enabled?, options? }` where `null` reverts a key to the configured value or default, optional `If-Match: <revision>` (412 `DECODER_SETTINGS_REVISION_MISMATCH`), body at most 16 KiB (413 `DECODER_SETTINGS_LIMIT`), 400 `DECODER_OPTIONS_INVALID` or `DECODER_OPTION_NOT_PATCHABLE` (`keys`, `unknownKeys`), 503 `DECODER_SETTINGS_STORE_UNAVAILABLE`. Only keys whose descriptor says `patchable: true` (new optional field on `GET /api/decoders/types`, absent = false) can be set; paths, hosts, ports, devices, `extraArgs` and secrets never can. Nothing restarts: the change applies at the decoder's next start (the adapter is rebuilt and announced with `decoder:created` for the same id; listeners must treat a known id as a replacement). `enabled` means autostart at boot. Precedence: override > YAML/env config > default; the config export stays YAML/env only. Legacy mode is unchanged: PATCH answers 501 `DECODER_CONFIG_UPDATE_UNSUPPORTED` and there is no GET settings route.
- Recordings inventory (protected mode only, `RECORDINGS_REQUIRES_ACCESS`): `GET /api/recordings` (newest first, `limit` 1–200, opaque `cursor`, `kind` and `decoderId` filters; items with opaque `id`, `kind`, `decoderId` or `discoveryId`, `startedAtLocal`, `modifiedAt`, `bytes`, `durationMs`, `callType`, `talkgroup`, `source`, `frequencyHz` only when known) and `GET /api/recordings/:id/file` (whole file, `audio/wav`, `Accept-Ranges: none`, under the download lease). Ids are opaque and may stop resolving after a configuration change; list again. Read-only: no Keep, delete or trim.
- Spectrum: `scanner.ws.spectrumBinsCap` (`auto` measured once at startup, or 2048, 4096, 8192) caps summary and client bins; `limits.binsCap` (optional `{ setting, cap, source }`) reports it, and `limits.bins.max` is `min(cap, scanner.ws.spectrumSummaryBins)`, which accepts 512–8192 (default 2048). With the shipped config `limits.bins.max` stays 2048 everywhere. The default profile stays at most 2048 bins. Measured caps: Mac 8192, Raspberry Pi 3 2048.

For the web session (web app on `claude/project-thread-afdtom`):

1. Web Settings can now edit decoder options: read `patchable` from `GET /api/decoders/types`, show the view from `GET /api/decoders/:id/settings` (source per key; non-patchable and secret keys show only whether they are set), send a merge patch with `If-Match` set to the view's `revision`, show `pendingRestart` and offer a restart of that decoder. Both routes are protected only, so the web app needs browser access (pairing and a session); in legacy mode the GET route is absent and PATCH answers 501 as before.
2. Recordings playback: list with `GET /api/recordings` and play with `GET /api/recordings/:id/file` (protected only). No `Range` support: fetch the whole file (a blob) before seeking. Do not derive a frequency for dsd-fme recordings; `frequencyHz` is null there.
3. Spectrum: the web asks 2048 bins today, which is unchanged. It may ask more when `limits.binsCap` is present and `limits.bins.max` allows; ask at most `limits.bins.max` (a larger value is clamped with `adjusted: ["bins"]`) and read the actual `binCount`. Viewed-slice zoom is still gated.
4. `docs/web/CORE-GAPS.md` on the web branch can tick: decoder settings and PATCH (protected), recordings read-only inventory, spectrum bins above 2048 (host-dependent).

#### Core: WG9 web gaps (browser pairing for a web origin, recording Keep and delete, strict tuning trust, operator retune settle, minors) — 2026-10-17

Announcement for the CLI and for the web session (the web app on the GitHub branch `claude/project-thread-afdtom`). Spec: [web-gaps-9](specs/web-gaps-9/requirements.md). Details in [API.md](API.md). New routes are protected only; new fields are optional in `@wavekit/api-types` (older cores omit them); one contract amendment added two 500 codes. With the shipped config and legacy access mode every existing route is unchanged except the legacy stream URL host (below) and trust labels, which can now read `unverified` where they used to read `commanded`. A grep of `cli/source` finds no reader of `decoder-unavailable`, `/api/recordings`, `RECORDING_*`, `SCANNER_DISCOVERY_HOLDS_KEPT_RECORDINGS`, the pairing routes or `Access-Control-Max-Age`; every `kept` hit is prose or test code, not a field; `csrfToken` is read only by the access-state snapshot reader (`cli/source/data/access-credentials.ts`), unaffected. `tuningTrust` is shown as text and greys an `unverified` axis (`cli/source/view-models/scan.ts`), which is the intended reading. `httpUrl` is shown as host and path (`cli/source/view-models/system.ts`). The CLI sends no `DELETE`, so the new 409 on discovery delete cannot reach it. No CLI change required.

- Pairing for a web origin on another port of the API hostname: shared DTOs and names in `packages/api-types/src/access-pairing.ts` (`ACCESS_PAIR_ROUTE`, `ACCESS_PAIRING_CODES_ROUTE`, `ACCESS_SESSION_ROUTE`, `ACCESS_SESSION_REFRESH_ROUTE`, `ACCESS_SESSION_LOGOUT_ROUTE`, `ACCESS_SESSION_COOKIE_NAME`, `ACCESS_CSRF_HEADER`, `ACCESS_PREFLIGHT_MAX_AGE_SECONDS` = 600, `accessPairRequestSchema`, `accessSessionDtoSchema`, `AccessErrorCode`). `POST /api/access/pair` takes optional `name` and `kind` (device label rules), committed with the session in one write. Allowed preflights carry `Access-Control-Max-Age: 600`; denied and shutdown 503 preflights carry none. Another hostname or site stays unsupported by design.
- Recordings (protected only, `RECORDING_KEEPS_REQUIRES_ACCESS`): `PUT`/`DELETE /api/recordings/:id/keep` (200 `{ id, kept, changed }`, idempotent) and `DELETE /api/recordings/:id` for dsd-fme calls (200 `{ id, deleted: true }`); scanner recordings are keep-only (409 `RECORDING_DELETE_UNSUPPORTED`). Delete of a kept recording is 409 `RECORDING_KEPT`: unkeep first. Other codes: 404 `RECORDING_NOT_FOUND`, 409 `RECORDING_BUSY` and `RECORDING_KEEP_LIMIT` (2 000 entries, 512 MiB), 500 `RECORDING_KEEP_FAILED` and `RECORDING_DELETE_FAILED` (amendment), 503 `RECORDING_KEEPS_UNAVAILABLE` (an unusable keep store: everything counts as kept and nothing is pruned or deleted). Inventory items gain optional `kept`. `DELETE /api/scanner/discoveries/:id` answers 409 `SCANNER_DISCOVERY_HOLDS_KEPT_RECORDINGS` (flat scanner error) while one of its recordings is kept.
- Strict tuning trust: one rule for spectrum frames, receptions and analog transmissions. `commanded` or `relay` only when both the centre and the sample rate were written by WaveKit or seen in an accepted relay command on the current connection; a declared-only value, a failed reconnect replay or a `reconnectPolicy: reset` reconnect is `unverified`. Scanner hops take the same rule; a hop now also commands the sample rate (the job's, else the declared one) when it is only declared or not written on this connection, so a tuner command list can show one scanner `set-sample-rate` at the first hop.
- Operator retune settle: after a non-scanner retune the display settles for 150 ms instead of the network settle, and frames before the network settle (1 000 ms by default) are `unverified`. The spectrum status `tuningTrust` of that source reads `unverified` over the same window.
- Identify: a probe trial whose decoder cannot run ends `unsupported` with reason `decoder-unavailable` (no new outcome; `reason` is free text, so `cli/source/data/scanner-guards.ts` accepts it).
- Legacy stream URLs: without `access.publicOrigins.analogAudio`/`digitalAudio`, legacy mode now derives the `httpUrl`/`wavUrl` host per response from the request's `Host` (live-audio status, digital-voice status, scanner listen) instead of `localhost`, with `Cache-Control: no-store`. WebSocket status events and protected mode are unchanged.
- Live-audio `PATCH` 400 bodies carry a stable `code` (`VALIDATION_ERROR`, `CHANNEL_OFFSET_OUT_OF_RANGE`).

For the web session (web app on `claude/project-thread-afdtom`):

1. Serve the web app on its own port of the API hostname and list that exact origin in `access.allowedOrigins`; pair with `POST /api/access/pair` (`credentials: "include"`, optional `name` and `kind`), keep `csrfToken` in memory, send it as `X-WaveKit-CSRF` on unsafe requests, refresh before `expiresAt`, and read it again with `GET /api/access/session` after a reload. Import the names and schemas from `@wavekit/api-types` instead of copying them. `docker/caddy` has a commented `:9446` site.
2. Recordings: show `kept` from `GET /api/recordings`; Keep and unkeep with the `/keep` routes; offer delete only for `dsd-fme-call` items that are not kept. Treat 503 `RECORDING_KEEPS_UNAVAILABLE` as "every recording protected"; a scanner discovery delete can now answer 409.
3. Grey the frequency axis on `unverified` frames as before; expect it right after operator retunes and on sources whose rate or centre is only declared.
4. `docs/web/CORE-GAPS.md` on the web branch can tick: pairing for a same-host web origin, recording Keep/unkeep and dsd-fme delete (protected); trim, export and scanner recording delete stay open.
