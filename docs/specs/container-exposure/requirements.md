# Container loopback exposure — requirements and design

Amends [core access policy](../core-access-policy/requirements.md). Scope: a
protected core running in a container whose ports the operator publishes to the
host's loopback interface only (for example `-p 127.0.0.1:9000:5173`). Today
`exposure: local-http` binds every plaintext listener to a loopback address
inside the container, which the container runtime's port publishing cannot
reach, so a second forwarding container is needed. This exposure removes it.

## 1. Requirements

1.1 Add `access.exposure: container-loopback`, valid only with
`listenerScheme: http`. It is never inferred: no other value, environment probe
or bind address selects it, and every existing configuration validates and
behaves byte-identically.

1.2 Under `container-loopback`, `api.host`, `access.audio.analog.bindHost` and
`access.audio.digital.bindHost` must all be exactly `0.0.0.0` (the container's
IPv4 interfaces). `::`, interface addresses, hostnames and mixed values are
rejected. Under `local-http` and `tls-termination`, `0.0.0.0` stays rejected
everywhere it is rejected today.

1.3 Every advertised fact stays as strict as `local-http`: `publicOrigins`,
`allowedOrigins` and `allowedAuthorities` must be `http` on the same loopback
hostname (`127.0.0.1`, `localhost` or `[::1]`); the API, analog and digital
origins stay distinct; the public ports must equal the in-container listener
ports (the operator publishes the same port number, or fronts it with a
same-host proxy that preserves `Host`, as the Vite preview does). Host, Origin,
cookie, CSRF, pairing, machine-credential and audio-token checks are unchanged
code paths with unchanged inputs.

1.4 The health probe target must be `http://127.0.0.1:<api.port>` (the probe
runs inside the container namespace and reaches the wildcard listener over
loopback); its Host must still be one of the allowed authorities.

1.5 Any ambiguous or contradictory combination fails closed at config
validation with the existing generic `ACCESS_CONFIG_INVALID` error, before any
listener opens.

1.6 At startup under `container-loopback` the core logs one warning stating
that its listeners accept connections on every container interface and that the
operator must publish the ports to `127.0.0.1` only. The warning carries no
configured value.

## 2. What the core can and cannot verify

The core sees its own bind address, the request's Host/Origin headers, cookies
and credentials. It cannot see the host-side publish address, the container
network's other members, or whether a connection arrived through port
publishing or directly over the container network: with publishing the peer
address is a runtime gateway or proxy address, indistinguishable from another
container on the same network. The core therefore does not use peer addresses
as a trust signal in this mode.

What still protects the listeners:

- Browsers (including DNS rebinding pages) send the page's own authority as
  Host; only the configured loopback authorities are accepted, so a rebound
  name is rejected exactly as under `local-http`.
- A non-browser client on the container network can forge Host and Origin, the
  same as any local process can under `local-http`. It still gets only the
  public exceptions (health, bootstrap metadata); every other route, WebSocket
  and audio stream requires a paired session cookie, a machine bearer
  credential or a short-lived audio token. Pairing codes are issued only with
  the machine credential held in private storage.

What the operator must guarantee: publish every listener port to `127.0.0.1`
(or `[::1]`) only, and keep untrusted containers off the core's network (a
dedicated user-defined network or the default bridge with no other
workloads). Publishing to `0.0.0.0` exposes plaintext session cookies to the
LAN; use `tls-termination` for that.

## 3. Design

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
  exceptions.
