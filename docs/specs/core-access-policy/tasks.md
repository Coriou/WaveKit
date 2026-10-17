# Core access policy — tasks

Foundation and integration have separate checkpoints. Tasks 4 and 5 may proceed
in parallel: prepare adapter contracts while implementing independent provisioning
and persistence. Task 6 requires both completed session flows and a coordinated
scanner integration window. Scanner owns its current shared-file work. Independent
CLI wiring and runtime hygiene portions of task 7 may proceed before task 6
when they preserve legacy defaults and do not modify scanner-owned paths.
Task 4 may also prepare a concrete, unmounted runtime lifecycle context in new
files: compose provisioned storage, restored sessions, policies and shared leases
with failure cleanup. Listener/config/bootstrap integration still requires the
scanner Tasks 37, 37a and 38 checkpoint; no preparation grants live protection.

- [x] 1. Implement exact authority/origin, raw-header and canonical credential policy.
  _Requirements: 2.1–2.3, 3.1–3.4_
- [x] 2. Implement persistent snapshot/session contracts and renewable 30-day lifecycle,
  capacity/replacement, revocation and race-safe connection leases.
  _Requirements: 4.1–4.5, 5.1–5.3_
- [x] 3. CHECKPOINT FOUNDATION: targeted meaningful tests, typecheck, lint and independent
  review; verify no existing runtime files/adapters changed and no live protection claimed.
  _Requirements: 1.3, 2.1–5.3_
- [x] 4. Prepare exact adapter/config/CLI contracts; agree the shared-file integration
  window with scanner and inspect settled route/WS/audio/bootstrap changes before wiring.
  _Requirements: 6.1, 6.5_
- [x] 5. Implement guided provisioning/pairing/refresh/revoke flows and private persistence,
  including fail-closed startup/storage behavior and bounded failed-attempt handling.
  _Requirements: 1.1, 1.2, 4.1–4.5_
- [x] 6. Integrate root Fastify/WS and shared HTTP audio admission/lease adapters, exact
  origins/authorities, cookie renewal and protected recording/download routes.
  _Requirements: 2.1–3.4, 5.1–5.3, 6.1_
- [x] 7. Integrate CLI credentials, liveness/status probes, sanitized logging/validation,
  child-environment isolation and correct public audio URLs.
  _Requirements: 6.3, 6.4_
- [x] 8. Implement explicit raw-listener policy and verify container/network exposure.
  _Requirements: 6.2_
- [ ] 9. CHECKPOINT PROTECTED MODE: actual WS/audio/download tests, CLI/browser coexistence,
  pairing/renewal/logout/restart and denied-origin/authority/no-secret checks; coordinated
  browser and deployment acceptance before connected web release.
  _Requirements: 1.1–6.5_

## Foundation checkpoint — 2026-10-10

Implementation commit: `49a8778` on `feat/access-policy`. Only ten new source/test
files were added; no existing runtime files changed and no listener is protected.
Independent Astra review approved the final policy/session implementation and
callback cleanup regression. Targeted tests: four files, 88 tests, including two
100-run properties. Typecheck passed. Repository lint passed with zero errors and
59 existing warnings outside the new paths; focused lint has zero warnings.

Integration remains pending. The next independent batch is guided provisioning,
pairing and private durable persistence. Coordinate the shared adapters/config/CLI
window with scanner before tasks 6–8; do not infer live protection from this checkpoint.

## Independent provisioning/session checkpoint — 2026-10-10

Private storage/setup: `3faf736`; pairing/session flows and exact boundary refactor:
`2fadd1d`; request facts and transport lifetime helpers: `4246db0`.
Independent Astra reviews approved all three components. Combined access tests:
11 files, 193 passing tests. Repository typecheck and lint passed; lint retains
59 existing warnings outside the access paths and no errors. Focused lint is clean.

Task 5 completes the unmounted utility/service implementations. Actual first-use
command/UI, routes in the running core and protected-mode acceptance remain tasks
6–9. Same-scope dead-owner recovery is supported; foreign/unverifiable ownership
requires explicit offline repair and deployment acceptance.

The next batch is actively implementing unmounted Fastify/access-route and Node
HTTP adapters on `feat/access-adapters`, based on `dbca1cc`. Shared existing core
configuration/server/broadcaster/audio/bootstrap edits remain gated by task 4's
scanner contract window. Do not claim that these commits protect running listeners.

## Unmounted runtime adapter checkpoint — 2026-10-10

Node HTTP admission/stream leases: `b155fd7`; Fastify root hooks/access routes:
`abb8882`; startup, raw-listener and environment/logging policy helpers:
`a72aa3d`; shared lease-authority identity and secure cookie-prefix guards:
`7a7d116`. Independent Astra reviews approved the adapters and independent
Sol/root reviews approved the runtime helpers.

Combined access suite: 17 files, 284 passing tests, including real HTTP/audio/WS
transport lifecycle regressions and 100-run properties. Repository typecheck
passed after correcting two missing returns in test handlers; the changed
Fastify file was retested (17 passing tests). Repository lint passed with zero
errors and 59 existing warnings outside access; focused lint is clean.

Tasks 6–8 remain incomplete: these implementations are not mounted. Scanner
Task 24 is complete; Task 25 is still in review, and later scanner tasks retain
ownership of shared server/WS/audio/bootstrap paths. Mount against a settled
scanner snapshot in a coordinated window. CLI credential/transport helpers are
now being prepared independently on `feat/access-cli-transport`; live CLI wiring,
first-use command/UI, container exposure and browser acceptance remain pending.

## Independent runtime hygiene checkpoint — 2026-10-10

`bb8f9a2` filters the reserved access environment namespace at the actual decoder
and channelizer spawns, composing with existing CSDR filtering. `e743c39` removes
the container healthcheck's protected status request while retaining public
system health and existing service checks. These changes affect their call sites,
but do not mount authentication. Scanner ownership was checked before editing.

Independent Astra/root reviews approved both changes. Decoder/channelizer target
set: 64 passing tests. Actual shell health probe: four passing tests covering
its sole public request and exit statuses; real s6 service state was not tested.
Repository typecheck and lint passed; lint retains 59 existing warnings and zero
errors. Focused lint and shell syntax validation passed. Tasks 7–9 remain open.

## Unmounted CLI transport checkpoint — 2026-10-10

CLI helper implementation: `6cba790` (assembled here as `e006f3f`). Private
credential reads do not acquire the core writer lock. Transport credentials
are bound to an explicit canonical target; redirects cannot forward them.
Credential lookup respects cancellation and WS deadlines; errors contain only
safe status/denial projections. Credential-free discovery preserves the existing
503 public-health signal. No existing CLI runtime wiring changed in this batch.

Independent Astra/root reviews approved the final helper and discovery fixes.
Targeted tests: 80, including a 100-run token property. Full CLI suite: 17 files,
289 tests. Repository typecheck and lint passed; lint retains 59 existing
warnings and zero errors, with focused lint clean.

Next: actual CLI credential-file/target composition and authentication retry
pausing on `feat/access-cli-wiring`. Task 7 remains incomplete: core logging,
public audio origins and coordinated runtime acceptance still need integration.
Tasks 24/25 scanner contracts are reviewed; later scanner task ownership remains.

## Independent CLI wiring checkpoint — 2026-10-10

`eb2cf61` mounts destination-bound transports when an operator supplies a private
credential file and an explicit HTTP(S) API target. Protected target composition
preserves its hostname; legacy localhost resolution keeps its existing rewrite.
Discovery always uses its separate credential-free probe. WS authentication and
credential failures pause retries; explicit reconnect rereads credentials.
Existing REST liveness, confirmation and uncertain-write behavior is preserved.

Independent Astra/root reviews approved the 12-path change. Touched logic/native
transport set: 156 passing tests. Full CLI suite: 295 passing tests. Repository
typecheck, CLI build, and compiled entry/help guards passed; malformed/userinfo/
numeric-alias targets and missing explicit targets fail without echoing inputs.
Repository lint passed with zero errors and 59 existing warnings; focused lint
is clean. No actual protected core/browser listener is mounted yet.

The standalone core setup/pair utility is being implemented independently. Its
package/build wiring waits for scanner Task 32's new worker build entry to settle.
Core logging, audio-origin mapping, browser onboarding/renewal and actual
container/TLS exposure acceptance remain incomplete portions of tasks 6–9.

## Independent assembly checkpoint — 2026-10-10

The reviewed foundation, private persistence/session flows, unmounted runtime
adapters, decoder environment/container health hygiene and actual CLI credential
wiring are assembled with current main. The complete repository test command
passed: root 2,768 tests, CLI 295 and sdr-host 99. Eleven root integration tests
were skipped by their existing fixture/binary prerequisites. Repository typecheck
passed; lint has zero errors and 59 existing warnings.

This batch is safe to land independently of scanner's active shared-file work.
It does not mount core authentication or make the browser ready for release.
Standalone setup/pairing follows as a separately reviewed change; the runtime
and browser checkpoint remains open.

## Standalone setup/pairing checkpoint — 2026-10-10

`8df836a` (landed independently as `de793ec`) adds a standalone utility and a
validated read-only credential boundary usable while the core writer is live.
Setup validates canonical browser/API/audio hostname and scheme before writing;
LAN browser plans require HTTPS and literal loopback plans may use HTTP. Pairing
uses one destination-bound machine-authenticated POST with a bounded deadline,
no redirects and no automatic retry after an uncertain issuance.

Independent Astra/root review approved all seven paths. The 101 focused tests,
root TypeScript check, focused lint, standalone build/help and compiled timeout
smoke passed. Normal package build-entry integration must preserve scanner
Task 32's spectrum-worker entry. Actual protected listeners, browser pairing and
rolling renewal remain pending integration; setup prints an unmounted public
plan and creates no TLS listener.

## Runtime lifecycle preparation checkpoint — 2026-10-10

`2ad80f8` (landed as `8bb3845`) composes load-only private storage, durably
restored sessions, API/audio policies and one shared connection lease authority.
Explicit audio boundaries must agree with the public bootstrap; no advertised
URL is used to guess listener roles. Partial construction releases ownership;
idempotent shutdown closes leases before storage and preserves remembered
browsers. Callers must stop admissions and drain flow/adapters before closing.
Load mode now cannot create a missing private directory; provision mode retains
its existing first-use behavior.

Independent Astra/root review approved the four paths. The 58 focused tests,
full repository typecheck/lint and focused lint passed (59 existing warnings
outside the owned paths). Actual listener mounting still requires the scanner
37/37a/38 integration window. Health-probe authority, named analog/digital
public origins, sanitized runtime logging and real transport/container exposure
remain explicit integration gates, not additional product decisions.

## Main integration verification — 2026-10-10

The complete independent batch is landed on local main: access foundation,
adapters, CLI wiring, setup/pair utility, runtime lifecycle composition and
the internal decode-envelope foundation. Root tests passed with two workers:
187 files, 2,905 tests, with 11 existing integration skips. The complete workspace
run also passed CLI 295 and sdr-host 99. Repository typecheck and lint passed;
main has 59 existing source warnings and three generated coverage warnings,
with zero errors or warnings in the owned implementation paths.

The final default-concurrency root run hit ten timing/shell failures and two
worker RPC timeouts while Mac load reached 179. A two-worker diagnostic cleared
the channelizer and healthcheck failures and exposed three generated fixture
cases still using a five-second test deadline despite their thirty-second
subprocess budget. `2df7ff4` aligns those three cases with the existing neighboring
generated test. The subsequent complete two-worker root run passed; production
behavior and assertions were unaffected by this test-budget correction.

Next coordinated implementation is tasks 4/6–9 against scanner 37/37a/38. The
reviewed browser recovery/onboarding brief is in design.md; genuine slice zoom
planning is recorded in ROADMAP §8 and waits for Task 37a's measured baseline.
No deployment, push or live receiver change is part of this checkpoint.

## Protected runtime integration candidate — 2026-10-11

Runtime wiring now includes opt-in strict public mapping with named API, analog
and digital boundaries, durable authority loading before listeners, root Fastify
admission before plugins/routes, WS adoption before subscriber registration, and
leased audio/scanner downloads. One session/lease authority backs all listeners.
Protected raw TCP/relay startup is disabled; legacy defaults remain supported.
Implicit relay configuration without a shared source fails validation before
listeners, while explicit dedicated selection remains supported in legacy mode.

Protected lifecycle composition seals admissions synchronously, fences late audio
restarts, waits actual startup and flow/transport cleanup, and releases access
storage only after successful completion. An incomplete drain retains ownership
until process termination. The internal bootstrap uses actual mounted/healthy
access services and running audio state; there is no public bootstrap endpoint or
health metadata. Operator data is unmounted and unavailable.

The candidate has 350 passing tests across 16 files with one worker, including a
freshly compiled real process, paired-session restart, active WS SIGTERM cleanup,
API bind-failure cleanup, failed partial scanner cleanup with retained ownership,
legacy scanner fallback, no-listener fatal startup, actual Fastify persistence
drain, stream revocation/late producer cleanup, mapping and probe validation
(including canonical port-80 loopback origins for both address families).
Independent exact-candidate review and final check results will be recorded in the
subsequent checkpoint. These facts do not mark the integration tasks accepted yet.

Task 8 container/network exposure and task 9 remain open. Outstanding acceptance
includes deterministic signal during stalled startup, the coordinated broad-suite
window, trusted shell bootstrap delivery and web authentication/playback recovery,
real TLS/Host/private-volume/backend/container isolation, CLI/browser coexistence,
and the connected spectrum → tune → identify → inspect → listen client milestone.
No live receiver or browser/deployment acceptance follows from these tests.

## Bootstrap/device design extension — 2026-10-11

**BACKEND IMPLEMENTED; CLIENT/EXPOSURE ACCEPTANCE PENDING.** The additive contract
is specified in [design.md](design.md#public-bootstrap-and-remembered-device-projection).
Explicit protected routes and closed DTOs are implemented; browser clients and
TLS/exposure acceptance remain gated. Historical task states/checkpoints above
retain their original scope. Backend verification is recorded below.

- [x] 10. Implement closed canonical bootstrap/device DTO schemas and explicit
      bounded allowlist projectors; configured origins/API-derived WS URL only,
      4096-byte bootstrap budget, detached device ID/clocks/current metadata only.
      _Requirements: 3.6, 4.7, 4.8_
- [x] 11. Mount exact opt-in protected GET/HEAD bootstrap with shared raw boundary,
      separate preflight, no public principal/lease and invalid-credential semantics.
      Preserve legacy ordinary absence, protected absent-route normal admission and
      installed-provider safe 503; gate flags on actual readiness/current health.
      _Requirements: 2.1–2.3, 3.3–3.6, 6.1_
- [x] 12. Implement session-only explicit GET/HEAD device inventory using the
      authority-clock/committed-map snapshot, immediate request reauthorization,
      post-clock availability recheck and no read writes/renewal/pruning/migration.
      Reuse existing pairing/refresh/logout/revoke and bounded flow/drain ownership.
      _Requirements: 3.2, 4.6–4.8, 5.1–5.3_
- [x] 13. CHECKPOINT BACKEND CONTRACT: focused actual-server and property tests
      covering exact raw tuple, HEAD/denial/CORS, absent-route/provider states,
      serializer faults, current mounted flags, permission, committed persistence
      races, requester expiry/revocation and reentrant clock failure. Run released
      serial checks and independent exact-candidate review before merged client
      contract acceptance; extend Property 5 and verify new Property 6.
      _Requirements: 2.1–3.6, 4.6–4.8, 6.1_
- [ ] 14. CHECKPOINT CLIENT/EXPOSURE: verify real browser cookie/CORS/TLS/proxy
      recovery and trusted canonical bootstrap delivery; bootstrap-path 401 cannot
      infer mounted pairing/session or unlock. No local backend check substitutes for
      deployment, RF/native, capacity or physical evidence acceptance. Task 9 remains
      a separate connected-client release gate.
      Amended (WG9): [web-gaps-9](../web-gaps-9/requirements.md) requirement 1 adds the local
      evidence for a web origin on another port of the API hostname (separate-origin
      acceptance test, preflight cache, pairing DTOs and contract); deployment acceptance stays
      open here.
      _Requirements: 1.1–1.3, 3.6, 4.8, 6.2–6.5_
- [x] 15. (WG2 lane D) Device names, kinds and coarse last-seen: snapshot version 2
      migration, `POST /api/access/devices/label`, hour-aligned last-seen on
      authenticated admission through the mutation queue, projections; Property 7.
      See docs/specs/web-gaps-2. Done in web-gaps-2 lane D (2397656a, 00441240, 670d9952);
      documented in docs/API.md (protected runtime, devices and label).
      _Requirements: 4.9–4.12_

### Backend implementation checkpoint — 2026-10-11

Explicit protected bootstrap and session-only remembered-device GET/HEAD routes,
closed shared DTO exports and public API/client documentation are implemented.
Independent exact-candidate code reviews approved both stages. Actual-server tests
cover raw-wire HEAD, exact tuple/upgrade rejection, provider/serializer faults,
committed inventory during held real create/refresh/revoke persistence, requester
expiry after admission and snapshot-only/reentrant clock failure. Property 5 and
Property 6 retain traced coverage with at least 100 runs.

At `14a0e235e95cf6b5b1b4beace70cd683bc25b7cc`, the fresh full root suite passed:
319 files and 5106 tests passed, 6 files/15 tests skipped, exit 0. Workspace tests
passed all 8 tasks (2 cached build prerequisites); fresh CLI tests passed all 341.
Typecheck exited 0 with the root compiler executed and 7 cached workspace tasks.
Lint exited 0 with 0 errors and 62 existing warnings. Shared/API-type compilation,
the three root entry builds and CLI build exited 0. The final checkpoint/status
correction changes documentation only; runtime and test blobs retain that scope.
Historical task formatting and earlier checkpoints are preserved.

Task 14, task 9 and real browser cookie/CORS/TLS/proxy/deployment acceptance remain
open. No receiver, native/RF, endurance/load, connected-client or production-binding
acceptance follows from this backend checkpoint.

## Browser access batch 1 checkpoint — 2026-10-12

Scope and decisions: [browser-access-batch1.md](browser-access-batch1.md).
Headless browser-lifecycle acceptance tests drive the assembled server and the
compiled process with a real cookie jar and exact Origin/Host: pairing, CSRF,
renewal near day 30 and expiry, concurrent tabs, uncertain pairing, WS and
cross-port audio admission, logout/revoke/revoke-all lease closure, persistence
fail-close, restart and secret-free denials. Machine-credential device routes
and the `access devices` CLI support lost-browser recovery; offline
`rotate-credential` empties remembered sessions unless `--keep-sessions` is
given. `make dev-protected` runs the real protected server on loopback without
a receiver. The opt-in `protected` compose profile adds a Caddy local-CA TLS
sidecar in the core's network namespace and gives the core only the root
certificate.

Three independent review rounds ended in approval after two rounds of fixes.
At the reviewed candidate, on Node 24.20.0: build, forced typecheck and lint
exited 0 (0 errors, 59 existing warnings); CLI 343 and sdr-host 99 tests passed;
the root suite with four workers passed 369 files and 5783 tests (24 skipped),
exit 0. One earlier root run hit a known port-reservation race in an untouched
legacy-startup process test that passes in isolation.

Tasks 4, 6 and 7 are accepted on this evidence and the earlier integration
checkpoints. Task 8 closes on the no-exception raw-listener decision and the
static exposure checks of the reference profile; the stack was not started.
Live TLS, proxy, private-volume and browser acceptance stay with task 14, and
task 9 remains the connected-client release gate. No receiver, deployment,
image build or production-binding acceptance follows from this checkpoint.

## Web origin on another port: local evidence — 2026-10-17

[web-gaps-9](../web-gaps-9/requirements.md) requirement 1 records the local evidence for a
web app on another port of the API hostname. `tests/unit/access/web-origin-acceptance.test.ts`
runs an actual protected server with the API origin, a web origin and a foreign origin, over
http and in the tls-termination form (plaintext listener behind a terminator stand-in): pair
with and without a label, session read, refresh, CSRF-guarded mutation, preflight, WebSocket,
cross-port audio and logout; foreign, `localhost` and `null` origins are refused, and legacy
mode mounts no access route. `tests/unit/access/preflight-max-age.test.ts` (Property 1) holds
`Access-Control-Max-Age: 600` to the allowed preflight only, and the Fastify and Node HTTP
adapter tests hold it off shutdown 503 preflights. `tests/unit/access/pair-label.test.ts`
(Property 2) covers the strict pair body and the single committed write. The contract and
example flow are in [API.md](../../API.md#browser-pairing-for-a-web-origin-wg9). No real TLS,
proxy, browser or deployment acceptance follows: task 14 stays open.
