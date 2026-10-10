# Core access policy — requirements

Scope: one operator on a local/LAN deployment. Existing CLI/SDR++ workflows
continue until protected mode is configured; the connected web UI requires
protected mode. Accounts, Internet deployment and Pi-host controls are separate.
The first implementation batch is an unmounted policy/session foundation.

## 1. Setup and rollout

1.1 First setup must provide a short guided pairing flow, without editing a
credential into YAML, placing it in a URL or storing it in browser localStorage.
1.2 Provision machine credentials in private storage outside serializable runtime
config. Pairing-code issuance requires that credential/local setup authority;
codes are short-lived, single-use and redeemed only from allowed Host/Origin. Missing or invalid credentials in protected mode must fail closed.
1.3 Preserve existing runtime behavior until coordinated integration and explicit
protected-mode configuration. Foundation-only code must not claim live protection.

## 2. Authority and origin

2.1 Validate exact configured HTTP authorities independently of credentials,
Origin, forwarded headers and public-route exceptions.
2.2 Validate any present Origin against exact configured HTTP(S) origins; reject
opaque, malformed, duplicate or lookalike authorities/origins.
2.3 Reject ambiguous security headers and duplicate session cookies. Machine
requests without Origin still require credentials; browser credentials do not
permit requests from a rejected origin.

## 3. Admission

3.1 Authenticate machine requests using a bounded, canonical random bearer token;
use fixed-size digest comparison and never accept URL/subprotocol credentials.
3.2 Authenticate browser requests with an HttpOnly host-only session cookie.
Unsafe cookie requests require allowed Origin and CSRF proof; cookie WebSocket
upgrades require allowed Origin. Safe no-Origin cookie reads need positive
same-origin/browser-navigation metadata.
3.3 Allow only exact minimal API GET/HEAD health exceptions. Protect status,
documentation, recordings, scanner controls, audio and unknown paths by default.
3.4 Validate credential-free preflight without granting actual request access.
Return stable generic denial codes, no-store responses and readable CORS failures
only for allowed origins. Authenticate before side effects or streaming headers.

## 4. Remembered browsers

4.1 Remember a paired browser across core restarts. Renew automatically while the
operator uses the app within a rolling 30-day period; do not impose a short
absolute login lifetime on an active operator.
4.2 Explicit authenticated refresh extends server expiry and browser cookie
expiry together. Retain the opaque cookie across refresh to avoid tab/audio/WS
races. Passive stream frames alone do not renew a session.
4.3 Default to at most 32 remembered sessions, reject capacity exhaustion explicitly, and allow
individual-device/all-device revocation. Machine credential rotation invalidates
persisted browser sessions bound to the old credential generation.
4.4 Persist only hashed cookie tokens and private session metadata through a
validated bounded snapshot. Serialize mutations and persist before acknowledging
issuance, renewal or revocation. Do not fall back silently to memory-only sessions.
4.5 Fail session access with a service-unavailable response on persistence failure;
close browser leases and avoid misleading login prompts or durable-success claims.

## 5. Connection lifecycle

5.1 Revocation and expiry terminate session-owned WS/audio/download connections
through normal cleanup. Attaching a lease after revocation must fail immediately.
5.2 A renewed session extends its active leases; their deadlines must follow the
current committed session, not an old admission timestamp.
5.3 Logout must not retune hardware or cancel jobs implicitly. Machine bearer
access is distinct from a browser session's lifecycle.

## 6. Integration and exposure

6.1 Use one policy/session authority across Fastify REST/WS and both HTTP audio
servers, including future scanner monitor/download routes.
6.2 Protected mode disables unauthenticated raw TCP audio/RTL-TCP relay by default;
any exception must describe and verify its real process/container/network boundary.
HTTP authentication must not imply those protocols are authenticated.
6.3 Preserve minimal discovery/liveness probes; update the container's protected
status diagnostic. Bind CLI credentials to an explicit trusted API target.
6.4 Prevent secret leakage in startup config, request/error logs, status, child
process environments and validation errors. Advertise credential-free audio URLs
usable by the actual local/LAN browser rather than its own localhost.
6.5 Coordinate existing config/server/WS/audio/CLI/bootstrap edits with scanner
checkpoints. Browser release needs real transport and exposure acceptance.
