# Core access policy — design

Approved product direction: compatible rollout, easy initial pairing and renewable
30-day remembered-browser sessions. This design separates an unmounted foundation
from scanner-coordinated adapters; no running listener changes in the first batch.

## Foundation

Owned modules under `src/access/` normalize request facts, verify credentials,
maintain sessions and return typed admission decisions. They accept raw Node HTTP
headers so duplicate Host/Origin/Authorization/CSRF and session-cookie ambiguity
can be rejected. Exact names live with the implementation; no shared DTO edits.

Per-listener authority allowlists include scheme/effective-port context; origins
are exact HTTP(S) origins. Forwarded headers and attacker-supplied Host do not
create trust. Public health exceptions are API GET/HEAD `/health` and
`/health/live` only, after authority/origin validation. Actual framework and audio
admission adapters will check before executing handlers or sending WAV headers.

Machine authentication uses a random 32-byte canonical base64url token, loaded
outside ordinary parsed config. The foundation receives its fixed-size digest.
Browser session creation exchanges a verified pairing credential for an opaque
cookie and CSRF token. SameSite=Strict, HttpOnly and host-only cookie scope require
a coherent browser/API/audio hostname; ports do not isolate cookies. Native WS
uses cookies, not reusable URL or subprotocol tokens. Transport encryption is a
separate deployment requirement; origin policy does not encrypt HTTP traffic.

The session store uses one serialized mutation queue and an injected async private
snapshot persistence interface. Cookie lookup remains synchronous against committed
state. Snapshots contain a version, credential-generation binding and bounded
records: device ID, cookie-token hash, CSRF metadata, creation/renewal/expiry times.
Validation rejects ambiguous/duplicate records and invalid bounds; expired
records cannot become usable after restore. An otherwise valid old-binding
snapshot is replaced with an empty current-binding snapshot before admission;
malformed or unreadable existing storage makes browser access unavailable. Cookie plaintext is
returned at creation and is never retained in the snapshot.

Default remembered lifetime is 30 days with no absolute age cap for active use.
Explicit refresh at bootstrap/reconnect/foreground and approximately daily
during active use renews the same cookie. The adapter acknowledges renewal and sets Max-Age only
after persistence succeeds. Admission and passive stream delivery do not renew.
The store supports device revocation, revoke-all, safe session replacement and
a default maximum of 32 remembered devices. Persistence failure latches session access unavailable and
invalidates active browser leases; machine access remains a distinct authority.
A failed durable operation is reported as failed, including the limitation that a
restart can recover only the last successfully persisted state.

Lease attachment revalidates the principal to close admission/revocation races.
Expiry enforcement reads current committed deadlines, so renewal keeps a valid
connection alive. Framework adapters own expiry scheduling and socket/response
cleanup; the store has no unmanaged timer. Expiry scheduling must recheck the
lease against the store clock and avoid rescheduling an already-past wall-clock
deadline after a system clock adjustment. Invalidating one lease must not prevent
cleanup of the others.

## Integration after a scanner checkpoint

- Guided local provisioning/pairing, private credential/snapshot storage, atomic
  persistence and failed-attempt limits precede browser release. A provisioned
  machine credential/local setup utility authorizes short-lived (10-minute),
  single-use pairing-code issuance; redemption checks allowed Host/Origin.
  Pairing codes authorize only the session-exchange flow, never general API
  access. Never let the first unauthenticated requester claim the instance.
  Keep a reusable machine token out of the ordinary browser experience.
- Root Fastify authority/admission hooks precede plugin/route registration. Installed
  WS upgrades traverse Fastify hooks; session context then leases the admitted socket.
- Shared `AudioHttpServer` authorization precedes route admission and stream headers,
  covering analog, digital and future scanner monitor streams.
- CLI REST/Node WS receive credentials from private storage for the explicitly chosen
  API authority; failed auth does not trigger endless rediscovery or credential
  forwarding to arbitrary candidates/redirects.
- Protect detailed status/docs/downloads, adjust `docker/scripts/healthcheck.sh`,
  sanitize logging/config errors, and omit credentials from decoder child environments.
- Validate raw TCP listener exceptions and actual container port publication. No
  HTTP policy can authorize the existing raw audio/RTL-TCP wire protocols.

## Correctness properties

Property 1: **Exact trust boundary** — normalization accepts only the configured
canonical authority/origin, not lookalikes or ambiguous headers.
Validates: Requirements 2.1, 2.2, 2.3.

Property 2: **Credential canonicality** — generated tokens round-trip through
canonical digest/verification; malformed encodings and other tokens never pass.
Validates: Requirements 3.1.

Property 3: **Explicit browser admission** — cookie mutation/upgrade requires the
specified Origin/CSRF proof; bad bearer input cannot fall back to cookies.
Validates: Requirements 2.3, 3.2, 3.4.

Property 4: **Durable renewable lifecycle** — only committed issuance/refresh is
usable; renewal updates the deadline, restart restores unexpired compatible
records, and expired/revoked/unavailable sessions cannot acquire a valid lease.
Validates: Requirements 4.1–4.5, 5.1, 5.2.

Property 5: **No implicit privilege** — public health and preflight exceptions
cannot admit protected API/audio/WS resources or execute their side effects.
Validates: Requirements 3.3, 3.4, 6.1.

Use deterministic scenario tests for races, persistence faults and adapter effects;
property-based tests map to these properties with at least 100 runs.
