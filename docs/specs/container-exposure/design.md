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
  bound on `0.0.0.0` port 0 in process, and a direct client that connects over
  a non-loopback local address with forged and genuine Host values: wrong Host
  is rejected; correct Host without credentials gets only the public
  exceptions. Under the new exposure, regression tests also cover: a
  forbidden Origin with a valid session rejected, unsafe cookie requests
  without CSRF rejected, WebSocket upgrades with a wrong Origin rejected, both
  audio listeners rejecting a wrong Host and a missing token, and the raw TCP
  audio port and RTL-TCP relay still suppressed in protected mode.
- Docs: `docs/DOCKER-SETUP.md` gains a one-container protected recipe with
  loopback-only publishing; the config reference lists the new value.
