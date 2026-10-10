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
- [ ] 4. Prepare exact adapter/config/CLI contracts; agree the shared-file integration
  window with scanner and inspect settled route/WS/audio/bootstrap changes before wiring.
  _Requirements: 6.1, 6.5_
- [x] 5. Implement guided provisioning/pairing/refresh/revoke flows and private persistence,
  including fail-closed startup/storage behavior and bounded failed-attempt handling.
  _Requirements: 1.1, 1.2, 4.1–4.5_
- [ ] 6. Integrate root Fastify/WS and shared HTTP audio admission/lease adapters, exact
  origins/authorities, cookie renewal and protected recording/download routes.
  _Requirements: 2.1–3.4, 5.1–5.3, 6.1_
- [ ] 7. Integrate CLI credentials, liveness/status probes, sanitized logging/validation,
  child-environment isolation and correct public audio URLs.
  _Requirements: 6.3, 6.4_
- [ ] 8. Implement explicit raw-listener policy and verify container/network exposure.
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
