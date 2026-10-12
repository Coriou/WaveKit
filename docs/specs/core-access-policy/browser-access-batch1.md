# Browser access end to end — batch 1 scope

This amendment scopes the next core-access slice: server-side browser access,
from pairing to renewal and revocation, without a web UI. It builds on
[design.md](design.md) ("Browser integration brief", "Public bootstrap and
remembered-device projection") and closes or narrows open tasks 4, 6–9 and 14 in
[tasks.md](tasks.md). Web UI implementation, browser receiver controls, live
deployment, image builds and receiver/RF acceptance are out of scope.

## Decisions

1. **Default mode stays `legacy`.** Protected mode remains opt-in. Changing the
   default is a separate decision after task 14 deployment acceptance.
2. **Raw listeners: no exception.** Protected mode keeps raw audio TCP and the
   RTL-TCP relay hard-disabled at startup. The unused exception helper
   (`src/access/raw-listener-policy.ts`) is removed; the startup hard-disable is
   the task 8 policy. Container exposure still needs the audit below.
3. **Trusted canonical bootstrap delivery.** A browser shell's trust anchor is the
   canonical API origin fixed in its build or deployment configuration. The shell
   fetches `/api/access/bootstrap` only from that origin and takes WS and audio
   origins only from the bootstrap response. No origin discovery, no
   core-served shell metadata. Revisit if the core ever serves the shell.
4. **Three origins remain.** API, analog and digital audio keep distinct origins
   on one hostname and HTTPS scheme.
5. **Reference TLS deployment: Caddy internal CA.** An opt-in `protected` compose
   profile runs a Caddy sidecar in the core's network namespace
   (`network_mode: service:<core>`), terminating TLS with Caddy's local CA for
   three public ports and proxying to the loopback HTTP listeners with the
   public Host preserved. Backend bindings stay loopback. Access private state
   lives in a dedicated private volume. Operators install the Caddy root on LAN
   clients; ACME/DNS issuance is deferred. Loopback HTTP stays development-only.
6. **Machine-credential device administration.** Lost-browser recovery must not
   require a browser session. The machine credential (already the authority for
   pairing codes) may list remembered sessions and revoke one or all of them
   through new exact machine-bearer routes. Cookie and session routes keep their
   current semantics; machine routes never accept cookies, never renew and
   reuse the existing device projection. Machine-credential rotation is an
   offline utility operation on stopped private state, like setup. By default it
   removes remembered browser sessions in the same atomic write as the new
   credential. `--keep-sessions` keeps them and rebinds them to the new
   generation; the operator then reviews `devices list` after restart.

## Work items

- **Acceptance tests.** A headless browser-lifecycle suite against the real
  server with a real cookie jar and exact Origin/Host: bootstrap → `401
  AUTH_REQUIRED` → pair → session → CSRF → refresh near day 30 (fake clock) →
  WS stream → credentialed cross-port audio → logout/revoke → restart; multiple
  tabs refreshing concurrently; uncertain pair response resolved by session
  status; rejected origins/authorities on REST, WS upgrade and audio;
  revocation and persistence failure closing open WS/audio leases at process
  level.
- **Protected development server.** A local command that starts the real
  server in protected mode with no receiver, auto-provisions throwaway private
  state, prints the three canonical origins and a pairing code, and cleans up on
  exit. It lets browser clients integrate without hardware.
- **Reference TLS deployment.** The compose profile, Caddy configuration,
  probe environment and `DOCKER-SETUP.md` protected section, validated
  statically (`docker compose config` plus repository tests). Running the
  stack and real browser/TLS acceptance stay with task 14.
- **CLI device administration.** `access devices` list/revoke/revoke-all over
  the machine routes, and offline credential rotation, with tests and docs.

## Acceptance for this batch

Focused tests for every item, typecheck, lint and the root suite pass on
Node 24; one independent review approves the merged candidate. Tasks 4, 6 and 7
are ticked with the review and check evidence recorded in tasks.md. Task 8
closes on the raw-listener decision plus the static exposure audit of the
reference profile. Tasks 9 and 14 stay open for real browser, TLS and
deployment acceptance.
