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
create trust. Existing public health exceptions are API GET/HEAD `/health` and
`/health/live`, after authority/origin validation. The accepted bootstrap extension
below is implemented with a separate opt-in; client/exposure acceptance remains
pending. Actual framework and audio
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

Property 5: **No implicit privilege** — public health, exact opt-in bootstrap and
preflight exceptions cannot admit protected API/audio/WS resources or execute
their side effects. Bootstrap grants no principal or lease, and absent opt-in,
normalized targets, upgrades and audio cannot acquire its public exception.
Validates: Requirements 3.3, 3.4, 3.5, 3.6, 6.1.

Property 6: **Committed active inventory** — a session-only read returns detached,
bounded, deterministically ordered allowlist rows from one committed authority
snapshot, with exactly one active requester. Pending mutations and read activity
cannot create renewal or expose uncommitted state; requester expiry/revocation,
storage failure and reentrant clock failure fail closed.
Validates: Requirements 4.6, 4.7, 4.8.

Property 7: **Device labels and coarse last-seen** (WG2) — for any admission and label
timeline, `lastSeenAt` is hour-aligned and non-decreasing, at most one last-seen commit
per device per UTC hour happens, a label or last-seen commit that fails leaves the
committed snapshot unchanged, and no inventory read commits anything.
Validates: Requirements 4.9–4.12.

Use deterministic scenario tests for races, persistence faults and adapter effects;
property-based tests map to these properties with at least 100 runs.

## Independent provisioning and session-flow batch

Private storage owns a bounded, versioned 0600 state file inside a private 0700
directory. Machine credentials remain outside ordinary config/status/log objects.
Existing malformed, symlinked, unsafe or unexpectedly missing initialized state
fails closed; it never silently provisions a replacement credential. Serialized
writes use an exclusive same-directory temporary file, file sync, atomic rename
and directory sync before success. Rotation atomically changes the credential
binding and, by default, removes remembered sessions in that same write. An
explicit keep rebinds them to the new generation (see machine-credential device
administration). Stale authority writes cannot restore the old binding.

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
tune → identify → inspect → listen. Device names remain a follow-up; the implemented device-list endpoint exposes
only remembered-session ID/clocks/current metadata, never private snapshots.

Before enabling live controls, load trusted deployment facts containing canonical
API/WS origins, named analog/digital audio origins and actual mounted access
capabilities. Publish these through a reviewed narrow bootstrap boundary or trusted
shell metadata. The exact protected bootstrap endpoint supplies these facts. Public
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

## Public bootstrap and remembered-device projection

**BACKEND IMPLEMENTED; CLIENT/EXPOSURE ACCEPTANCE PENDING.** This section defines
the additive protected-only contract implemented by explicit GET/HEAD routes and
closed shared DTOs. It does not assert a shipped browser client or completed
browser/TLS/exposure acceptance. Historical
checkpoint descriptions above retain their original scope. Existing configuration,
authentication, session persistence and stream authorities remain authoritative.

### Exact bootstrap boundary

Mount explicit GET and HEAD `/api/access/bootstrap` only with protected composition,
configured canonical public mapping and the matching root-hook opt-in. Default
policy evaluation remains unchanged. A separate public-bootstrap decision carries
validated response headers but no principal; it never authenticates another route.
The root dispatcher and route delivery both check the complete exact tuple:
HTTP transport, API surface, GET/HEAD method and raw target equality. Never match
by decoded path, query stripping, prefix or framework normalization. An admitted
normalized variant or upgrade must not receive the DTO merely because normal
authentication succeeded. HEAD is explicitly registered with implicit auto-HEAD
disabled and shares GET boundary/provider checks, status and headers, without a
wire body. OPTIONS uses existing validated preflight, not the metadata handler.

Shared raw-header parsing, Host and any present Origin validation precede this
exception. Missing Origin is allowed for this public safe request after valid
Host; opaque/disallowed Origin and malformed/ambiguous input retain existing
failures. Forwarded headers cannot supply authority or advertised origins.
Preserve `Cache-Control: no-store`, `Vary: Origin` and credentialed CORS only for
an unambiguous allowed Origin, including readable denials where currently safe.

For this exact public request, ignore structurally unambiguous invalid credentials:
wrong/expired/revoked tokens, unsupported schemes and unknown cookies do not
cause 401 or create authority. Valid credentials are equally irrelevant. Do not
verify credentials or look up sessions to admit it. Duplicate sensitive headers,
comma-joined Authorization, malformed header/cookie syntax and duplicate configured
cookie keys still fail boundary validation. Public reads issue no cookie, refresh,
lease, pairing exchange or store mutation. WS and audio have no bootstrap exception.

| Request/composition                                                         | Result                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Installed protected route/opt-in, exact GET, valid boundary, ready provider | 200 bounded DTO; credentials irrelevant                                                           |
| Exact HEAD                                                                  | Same GET status/headers, no body on success or failure                                            |
| Malformed boundary or unallowed Host/Origin                                 | Existing 400/403 safe denial and header rules                                                     |
| Allowed validated OPTIONS                                                   | Existing 204 preflight; no DTO, principal or actual-request authority                             |
| Query, trailing slash, encoding, prefix, POST, upgrade or audio             | Normal policy; subsequent ordinary routing or exact-target denial, never public DTO               |
| Legacy without access hooks, absent route                                   | Ordinary framework 404; no protected boundary/CORS claim                                          |
| Protected route/opt-in absent, including absent mapping                     | Normal admission first: 400/403/401/503 as applicable; admitted authenticated request reaches 404 |
| Installed route/opt-in but absent, not-ready, throwing or invalid provider  | Fixed 503 `ACCESS_UNAVAILABLE`; no fake successful document                                       |
| Sealed/stopping controller                                                  | Existing 503 admission denial; no cached successful response                                      |

Normal credential precedence governs protected absent-route denials; unavailable
session authority does not erase distinct machine authority. No unconditional 404
bypass is introduced. Bootstrap-path 401 establishes neither mounted pairing/session
services nor control permission. Clients retain unavailable state until a valid
bounded DTO is obtained from their configured canonical endpoint. Only subsequent
credentialed session operations establish authorization. Independently established
session operations can use existing refresh/pair recovery after 401. Preserve
cookies/view on offline or 503 recovery; never infer an authoritative empty list,
unlock, pairing availability or automatically replay a hardware write.

### Closed bootstrap DTO and provider

Canonical shared Zod schemas infer closed public DTOs; explicit projection copies
only the allowlist below, never spreads the internal getter or config. Input extras
cannot become output fields. No new dependency or configuration is needed.

```ts
interface AccessBootstrapDto {
	version: 1
	apiOrigin: string
	webSocketUrl: string
	analogAudioOrigin: string
	digitalAudioOrigin: string
	access: {
		mode: "protected"
		sessionAvailable: boolean
		pairingAvailable: boolean
	}
	capabilities: {
		analogAudioAvailable: boolean
		digitalAudioAvailable: boolean
		operatorDataAvailable: boolean
	}
}
```

HTTP(S) origins are canonical configured values, each bounded at 320 characters;
WS URL is exactly the API origin's ws/wss counterpart plus `/ws`, bounded at 323
characters. Validate this relationship rather than accept arbitrary WS locations.
Fully encoded UTF-8 body is at most 4096 bytes. Invalid projection or overflow is
fixed safe 503, without internal causes. No secrets, digests, cookies, device IDs,
allowlists, source inventories, paths or private cleanup state are advertised.
This metadata budget is not a WS aggregate/backpressure qualification.

| Provider state                                                               | Projection                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Actual protected listener/routes ready, canonical mapping present            | 200 with current mounted flags                                                  |
| Registration intent only, before successful ready/listen or failed startup   | Provider unavailable; no successful readiness document                          |
| Session authority unavailable on otherwise running composition               | 200 with session/pairing false; independent audio/operator flags remain current |
| Audio listener not actually mounted/running                                  | Corresponding audio capability false                                            |
| Operator routes/snapshot/update not wired, stopping or snapshot health fails | Operator capability false via existing on-demand authority                      |
| Route/opt-in absent due to missing mapping                                   | Normal protected admission then authenticated 404, not a provider response      |
| Installed route/opt-in with malformed/missing/throwing provider              | Fixed safe 503                                                                  |
| Stopping                                                                     | Admission/provider unavailable                                                  |

Reuse existing access capability and internal getter semantics. Pairing availability
requires actual route installation, healthy session authority and configured origin
requirements. The API server's provider uses existing post-listen mounted state and stopping
checks; do not add a competing cached readiness authority. Install route and opt-in
together under the configured protected gate. Provider/route failures explicitly
send safe status/body/serializer instead of falling through generic error mapping.
Flags are point-in-time advisory mounted-backend facts, not endpoint identity,
permission, RF/native readiness, TLS reachability or a future availability promise.
Health remains minimal liveness metadata. Legacy is not expanded.

### Session-only device methods and DTO

Explicit GET and HEAD `/api/access/devices` reuse the existing session-only flow
and bounded route admission/drain. HEAD executes the same checks with no body.
Safe-read Origin/fetch-metadata rules remain unchanged; safe reads do not add CSRF.
Machine authority cannot enumerate devices on this session route, even with a
session cookie alongside a preferred machine Authorization credential.
Enumeration uses the machine routes (see browser-access-batch1.md Decision 6).
Existing pair, refresh, logout, individual revoke and revoke-all permissions
and operations are reused.

```ts
interface AccessDeviceDto {
	deviceId: string
	createdAt: number
	renewedAt: number
	expiresAt: number
	current: boolean
}
interface AccessDevicesDto {
	devices: AccessDeviceDto[]
}
```

All objects are closed. IDs use existing live-record constraints. Clocks are existing
nonnegative safe-integer epoch milliseconds with their existing ordering invariants.
Sort by creation time ascending, then ASCII device ID ascending, never locale order.
Rows are detached and bounded by configured session capacity (maximum 32), with
exactly one current requester. Active means remembered and unexpired, not online.
Renewal time records explicit refresh, not read activity. No labels, kind, lastSeen,
user agent/IP, extra timestamp/revision, metadata-write API or storage migration.

| Request/state                                            | Result                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Current session and allowed safe-read context            | 200 snapshot; HEAD same status/headers without body        |
| Missing, expired or revoked requester                    | 401 `AUTH_REQUIRED`                                        |
| Valid machine principal                                  | 403 `SESSION_REQUIRED` using existing flow error shape     |
| Malformed boundary or cross-origin/fetch-metadata denial | Existing safe 400/403                                      |
| Store unavailable or authority clock failure             | 503 `ACCESS_UNAVAILABLE`, never successful empty inventory |
| Sealed controller or stopped flow admission              | Existing 503                                               |
| Existing active-flow capacity exhausted                  | Existing 429                                               |
| Unsupported method                                       | Normal policy/routing, no new bypass                       |

Snapshot is informational, not renewable authority or a guarantee that a later
revocation succeeds. Existing revoke results and explicit refetch reconcile races;
no device WS bus, online tracking, background clock, queue or second lifecycle.

### Snapshot linearization and fail-closed reads

Add a narrow synchronous SessionStore active-device snapshot operation returning
an active snapshot or missing-requester discriminator. Unavailable/clock failure
uses the existing safe authority error. Do not project `exportSnapshot()`, which
contains persistence-internal credential metadata, or use an external wall clock.

Inside the authority: check availability, call its clock exactly once for this
snapshot, recheck availability after the injected callback, then capture the current
committed map and revalidate requester presence/expiry against that same time.
A callback that latches failure but returns valid time still yields 503. Construct
allowlist rows without external callbacks, omit expired rows, mark requester,
sort/bound and return detached objects. Existing authentication may independently
read the clock; the one-clock rule applies to snapshot assembly. Do not prune,
renew, enqueue or persist a read. Existing expired records may remain privately
stored until normal mutation pruning.

The flow reauthorizes the original request immediately before this synchronous
operation, requiring a session principal with no await gap. Store revalidation
closes requester expiry/revocation after initial root-hook admission. The view
linearizes at its clock/committed-map observation; later changes do not retroactively
invalidate an informational response. Existing mutation serialization, storage
failure latch and lease revocation remain authoritative.

| Persistence/race state                                     | Visible read                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| Create accepted, persistence pending                       | New row omitted; previous committed map                     |
| Refresh pending                                            | Previous committed clocks/expiry; no premature renewal      |
| Revoke pending                                             | Previous committed record until successful commit           |
| Mutation committed before snapshot                         | Updated committed map                                       |
| Failed uncertain persistence/latched unavailable           | 503, no old successful or empty fallback                    |
| Requester expiry/revocation between root hook and snapshot | 401; clock/authority failure instead yields 503             |
| Clock callback reenters and latches unavailable            | Post-callback recheck yields 503 before successful assembly |

### Backend verification and remaining acceptance

Backend verification uses real ApiServer/root hooks/routes and SessionStore persistence/clock fixtures in
`tests/unit/api/access-bootstrap-devices.test.ts`, alongside focused policy, adapter,
store, flow, route and projector tests. Required schedules include the full raw
request tuple at dispatch and delivery; valid authenticated normalized variants and
upgrades; malformed/duplicate headers; invalid credentials confined to public reads;
GET/HEAD denial/body parity; separate preflight; no public principal/lease/renewal;
legacy absence versus protected absent-route valid/invalid credentials; provider
readiness/faults, byte limits and poisoned inherited serializers; IPv4/IPv6/default
port canonical URLs; truthful independent session/audio/operator flags; low configured
caps as well as 32, detached rows and deterministic current marker; deferred
create/refresh/revoke, requester expiry/revocation, failed persist and reentrant clock;
no read writes/pruning; unchanged restart-v1 compatibility; capacity and shutdown drain.

Server composition, shared DTO exports and public API documentation implement this
contract. Focused actual-server/property tests and independent exact-candidate
reviews cover the backend; the task checkpoint records cohesive check results. No web UI,
regional registry or tuner changes belong to this slice. Local tests do not establish
browser cookies/CORS/TLS/proxy exposure, private-volume/deployment behavior, physical
native/RF settlement or measured capacity. Existing production binding remains off,
scanner tier disabled with 500 ms default and 300–2000 ms bounds, private profile
absent/direct-only; analog filesystem uncertainty, deferred reuse and required
incomplete guarded IQ remain separate acceptance gaps.

## Machine-credential device administration

Lost-browser recovery does not require a browser session. Exact machine-bearer
routes list and revoke remembered sessions. Cookie and session routes keep their
current semantics. These routes authenticate like `POST /api/access/pairing-codes`:
canonical Host, an allowed Origin when one is present, and the machine bearer.
They never accept a cookie as authority, never renew, and do not require CSRF.
A cookie alongside the bearer is ignored. Missing and invalid bearers stay
401 `AUTH_REQUIRED`. A cookie request that fails the existing cookie boundary
(safe-read or CSRF) is denied there first. A session principal that passes it
is 403 `MACHINE_REQUIRED`.

| Route | Success |
| --- | --- |
| `GET`/`HEAD /api/access/machine/devices` | 200 inventory; HEAD has no wire body |
| `POST /api/access/machine/devices/revoke` | 200 `{ "revoked": boolean }` |
| `POST /api/access/machine/devices/revoke-all` | 200 `{ "revoked": true }` |

The inventory reuses each `AccessDeviceDto` row and the same ordering, expiry and
allowlist rules. It is not the browser `AccessDevicesDto`: there is no requester,
so `current` is false on every row, and zero rows is a successful empty inventory.
Unavailable storage or a failed authority clock is 503, never an empty success.
Reads stay synchronous and do not wait for the mutation queue. Revocation uses
that queue and `SessionStore.revoke` / `revokeAll`, so the same lease invalidation
closes live WS and audio attachments. Persistence failure latches the authority
and closes leases. Authenticated attempts use a separate budget with the same
limits as pairing redemption (5/minute per connection address, 60/minute
globally, 128 address buckets) and return 429 `MACHINE_RATE_LIMITED` with
`Retry-After: 60`.

`rotate-credential` is an offline utility, like setup. It refuses with
`ACCESS_STORAGE_BUSY` while any live owner holds the private directory. On a
stopped directory it atomically replaces the machine credential under the same
0600 file and 0700 directory rules. By default that write removes remembered
browser sessions. `--keep-sessions` rebinds them to the new credential
generation; the operator then reviews `devices list` after restart. A previous
in-memory persistence hook still cannot write the old binding. The command
prints no secret.

## Device names, kinds and coarse last-seen (WG2)

Amends "Session-only device methods and DTO" for requirements 4.9–4.12 (user decision
D3, 2026-10-13). The rest of that section, including "no device WS bus, online
tracking, background clock", stands: last-seen is an hour, not presence.

```ts
type AccessDeviceKind =
	| "browser"
	| "phone"
	| "tablet"
	| "desktop"
	| "cli"
	| "other"
interface AccessDeviceDto {
	deviceId: string
	createdAt: number
	renewedAt: number
	expiresAt: number
	current: boolean
	name?: string | null // always present once WG2 is implemented
	kind?: AccessDeviceKind | null
	lastSeenAt?: number | null // epoch ms, a multiple of 3 600 000
}
interface AccessDeviceLabelRequest {
	deviceId: string
	name?: string | null
	kind?: AccessDeviceKind | null
}
interface AccessDeviceLabelResponse {
	updated: boolean
}
```

The fields are optional in the shared schema only so that the frozen contract precedes
the implementation; projections always set them. The session snapshot record gains
`name`, `kind` and `lastSeenAt` (nullable) at version 2; version 1 records load with
nulls. `SessionStore` gains `label(deviceId, patch)` and `noteSeen(deviceId, now)`;
both go through `#commit` on the existing queue. `noteSeen` is a no-op unless
`floor(now / 1 h) * 1 h` is greater than the committed `lastSeenAt`, so a burst of
requests within one hour produces one commit; while one is in flight further calls
for that device are skipped. It is called after a successful authenticated admission
in the Fastify adapter (HTTP and WebSocket), never from the inventory read, and its
promise is caught. A persistence failure follows the existing latch rules for real
mutations but a failed `noteSeen` alone only counts and logs.

| Request/state                                | Result                                    |
| -------------------------------------------- | ----------------------------------------- |
| Valid session, CSRF, allowed Origin, body ok | 200 `{ updated: true }` after the commit  |
| Unknown or expired device ID                 | 200 `{ updated: false }`                  |
| Malformed body, invalid name, no keys        | 400 `MALFORMED_REQUEST`                   |
| Missing session or CSRF, wrong Origin        | Existing 401/403                          |
| Machine principal                            | 403 `SESSION_REQUIRED`                    |
| Persistence failure                          | 503 `ACCESS_UNAVAILABLE`, state unchanged |
