# Container loopback exposure — design

Requirements: [requirements.md](requirements.md).

## Design

- `src/access/runtime-config.ts`: extend the `exposure` and `bindHost` enums;
  `validateProtectedRuntimeMapping` branches on exposure for the bind-address
  and probe checks only; all origin, authority and port-equality checks are
  shared with `local-http`. Export a predicate the startup path uses to log 1.6.
- `src/config.ts` accepts the new values through the existing schema; no new key.
- Listeners already take their bind host from `api.host` and the audio
  `bindHost`; no listener code changes.
- Tests: a validation table (accepted and rejected combinations across all
  three exposures), byte-identical acceptance of existing fixtures, listeners
  bound on `0.0.0.0` in a real core process, and loopback clients with forged
  and genuine Host values (the policy never reads the peer address, so a peer
  on the container network is covered by the same cases): wrong Host
  is rejected; correct Host without credentials gets only the public
  exceptions. Under the new exposure, regression tests also cover: a
  forbidden Origin with a valid session rejected, unsafe cookie requests
  without CSRF rejected, WebSocket upgrades with a wrong Origin rejected, the
  shared audio server on a wildcard bind rejecting a wrong Host and a missing
  token (per-service wiring is not exercised: those listeners need a source), and the raw TCP
  audio port and RTL-TCP relay still suppressed in protected mode.
- Docs: `docs/DOCKER-SETUP.md` gains a one-container protected recipe with
  loopback-only publishing; the config reference lists the new value.
