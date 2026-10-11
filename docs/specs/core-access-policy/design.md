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

## Independent provisioning and session-flow batch

Private storage owns a bounded, versioned 0600 state file inside a private 0700
directory. Machine credentials remain outside ordinary config/status/log objects.
Existing malformed, symlinked, unsafe or unexpectedly missing initialized state
fails closed; it never silently provisions a replacement credential. Serialized
writes use an exclusive same-directory temporary file, file sync, atomic rename
and directory sync before success. Rotation atomically changes the credential
binding and empties sessions; stale authority writes cannot restore the old binding.

Ownership uses unique immutable process-owner files published before scanning other
owners. Any other live owner, including another nonce for the same PID, makes the
open busy. Only exact unique owner paths proven dead in the same supported process
scope can be reclaimed. Foreign or unverifiable namespaces fail closed; automatic
same-namespace crash recovery is tested, while container/host ownership transitions
require explicit stopped-instance recovery and deployment acceptance. Never use
host PID checks to reclaim a writer in another Docker PID namespace.

Offline setup provisions private state. The running core owns pairing-code state;
a future setup client obtains a code by making an authenticated request to that
explicitly selected core. It must not mint an isolated in-memory code that the
running server cannot redeem, or acquire writable storage behind a running owner.
Actual command/UI and existing listener mounts remain a separate integration gate.

## Pairing and remembered-session service contract

The running authority issues pairing codes only for an original machine-authenticated
POST `/api/access/pairing-codes`. Codes are ten Crockford-base32 characters displayed
as `XXXXX-XXXXX`, expire after ten minutes and exist only as hashes in process memory.
At most four outstanding/reserved codes are retained. Restart discards unused codes.

POST `/api/access/pair` has a narrow boundary-only policy entrypoint requiring the
actual API/HTTP method/path, exact Host, explicit allowed Origin and unambiguous raw
headers. This check grants no principal; normal API policy still requires credentials
there. Strict code input accepts ASCII case normalization and the single separator.
Redemption limits are five attempts/minute per connection address, sixty/minute
globally, and 128 active address buckets; forwarded addresses create no trust.
A synchronous reservation precedes durable session creation. Concurrent redemption
cannot issue two sessions; success consumes the reservation only after persistence.
A reservation begun before expiry may finish afterward. Capacity failure permits an
unexpired retry, while storage failure yields generic 503 without a cookie or success.

Browser flows evaluate their original request and require a session principal:
GET `/api/access/session`; POST `/api/access/session/refresh`,
`/api/access/session/logout`, `/api/access/devices/revoke`, and
`/api/access/devices/revoke-all`. Unsafe methods require Origin and CSRF. Mutations
are serialized and reevaluate authentication at execution so logout cannot be undone
by a queued refresh. Refresh reissues the same validated opaque cookie after durable
renewal. Self/all revocation clears that cookie, with no hardware/job side effects.
Public bodies contain device ID, expiry and CSRF metadata. Cookie directives are
separate non-enumerable transport metadata and must never be serialized as JSON.

## Unmounted adapter preparation

Raw Node request conversion preserves original headers/target/socket address and
uses the stricter upgrade path for raw Upgrade headers before framework metadata.
A shared connection-lifetime manager checks the session authority every 250 ms by
default (configurable maximum 1000 ms), with one bounded timer for at most 512 leases.
Event-loop stalls can add delay; revocation/storage failure invokes immediate normal
cleanup. The manager never schedules epoch expiry against Date.now() or a 30-day
native timeout. Rejected lease attachment performs no transport cleanup before a
protocol denial; release/disposal cancels listeners/timers idempotently.

Next adapters install direct root Fastify hooks before plugins/routes and provide
pre-upgrade reservation/adoption and download leases. The Node HTTP adapter gates
audio before WAV headers/client admission. Exact pairing-route handling delegates to
the services above; no `/api/access/*` exemption is permitted. Actual core wiring,
current CORS-plugin replacement, CLI/probes/logging/raw-listener configuration and
first-use UI/command acceptance remain coordinated integration work.

## Browser integration brief — reviewed 2026-10-10

The web design snapshot `28280cf` leaves authentication as an open surface.
Preserve its existing shell and visual system; coordinate the pairing surface with
its owner before UI implementation. The first successful flow ends at spectrum →
tune → identify → inspect → listen. Device names and a device-list endpoint may
follow; they must not delay first connection or expose private snapshots.

Before enabling live controls, load trusted deployment facts containing canonical
API/WS origins, named analog/digital audio origins and actual mounted access
capabilities. Publish these through a reviewed narrow bootstrap boundary or trusted
shell metadata. The existing capabilities helper has no wire endpoint. Public
health stays a liveness surface; legacy/unmounted mode cannot unlock the browser.

Check the credentialed session endpoint. A returning session obtains CSRF metadata
in memory, performs one single-flight refresh, then connects streams and controls.
A readable `401 AUTH_REQUIRED` presents one labeled, paste-friendly pairing-code
field with keyboard submission and accessible inline status. Submit the one-time
code once, then confirm cookie acceptance through session status. If the pairing
response is uncertain, check session status before requesting another code.

Renew at bootstrap, foreground, reconnect and roughly daily during visible use,
coalescing simultaneous triggers. Active use can continue without an absolute age
cap; passive frames do not renew. The opaque credential remains solely in the
HttpOnly cookie, CSRF solely in memory. REST and audio need credentialed CORS;
browser WS uses its eligible cookie. Browser WS cannot inspect the CLI's native
handshake status: coalesce a REST session check after WS failure and, when the
session is valid, recover the stream without another pairing/refresh loop.

Offline, `503`, missing routes and opaque TLS/CORS failures preserve the remembered
cookie and view while offering bounded connection recovery. Readable origin/Host
denials need configuration recovery. A CSRF denial permits one metadata recovery,
without automatic replay of hardware writes. Rate limiting and session capacity
have different recovery; expose `Retry-After` through CORS when displaying a rate
countdown. Capacity must not become a countdown retry loop.

Logout and receiver changes invalidate pending client operations and stop owned
transports. Generation guards discard late pair/status/refresh responses. Confirm
durable logout before declaring success. Browser acceptance must cover restart,
renewal near day 30, multiple tabs, uncertain pairing, logout races, cross-port
audio, rejected origins and unavailable persistence. These remain integration
gates; foundation tests do not establish browser readiness.
