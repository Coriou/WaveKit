# Web gaps 9 requirements (WG9)

Status: frozen for implementation. See [design](design.md) and [tasks](tasks.md).

## Scope

The ninth batch of core work the web dashboard needs: browser pairing for a web app served on
another port of the API hostname (the client and exposure checkpoint of the access policy and a
documented pairing contract); per-recording Keep and deletion on the WG8 recordings inventory
behind one deletion decision every deletion owner consults; strict tuning trust on spectrum
frames and analog transmissions, and a shorter operator retune to first retuned frame; a
reproducible sustained workload benchmark for a genuine viewed-slice FFT (measurement only); and
seven reported minor defects, verified first (six real, one not a bug).

Out of scope: web UI and CLI features (they get a coordination note only); a web app on a
different hostname or a different site (see 1.7); a read-only role or any other role; the
clean-card protected acceptance on a receiver; WebSocket tuner control (the REST command path is
7 to 12 ms; the retune delay is downstream of it, see section 3); trim, export, SigMF, HTTP
`Range`, rename or any write to a recording other than Keep and delete; deleting scanner
recordings (Keep and unkeep only); the catalog's stable ids, generation-fenced scanner Keep
handshake, file leases, delete intents and per-filesystem reserve (activity-recording-catalog
task 6 beyond what section 2 states); any zoom feature, route, profile or DSP change; the
channelizer (stays off) and S2 (stays disabled); scanner defaults including
`scanner.sweep.settleMs.network` (1 000 ms); the Activity caps, admission limits, retention,
coalescing windows and `activity.enabled`; the access default (`legacy`) and
`STATION_WRITE_REQUIRES_ACCESS` (stays true); decoded-elsewhere for external decoders (stays
excluded); the files pinned by the band-plans spec; new npm dependencies.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access or data research, load runs beyond the in-lane benchmark of
section 4. Tests use fake decoders, a fake rtl_tcp server on 127.0.0.1, temporary directories,
synthetic IQ and injected clocks; no test opens a socket to anything but 127.0.0.1. The Raspberry
Pi run of the section 4 benchmark is a Main task.

Defaults stay byte-identical except where a requirement here changes them on purpose (section 3
trust labels, 3.4 operator retune settle, 5.x defect fixes); each lane proves the rest against
goldens recorded from the frozen code, and lists every golden it changes with the requirement
that changes it. Every hot-path item states its CPU budget and pipeline position in the design;
every new bound states its arithmetic and has a test at the bound.

Background: a supervised real-RF session on the WG8 base measured the tuner REST command at 7 to
12 ms and the command to first new-centre spectrum frame at about 1.1 s (p50 1 099 ms, p90
1 167 ms over 20 steps of 100 kHz), and saw spectrum frames labelled `commanded` while the core
had sent no tuner command and the receiver was tuned about 133 kHz away from the configured
centre.

## 1. Browser pairing for a web app on another port

As an operator I want the web app, served from its own port on the same hostname as the
WaveKit API, to pair once and then read and control WaveKit with the same protections as today.

1.1 **Target.** The supported web deployment is a web origin with the same scheme and hostname
as `access.publicOrigins.api` and a different port (same site). It is configured by adding the
web origin to `access.allowedOrigins` (the existing rule that every allowed origin shares the
API scheme and hostname stays). No configuration key is added.
1.2 Preflight: an allowed-origin preflight answers 204 with the existing allowed methods and
headers and `Access-Control-Max-Age: 600` (`ACCESS_PREFLIGHT_MAX_AGE_SECONDS`). A preflight
from an origin that is not allowed, with `Origin: null`, or without
`Access-Control-Request-Method` is answered exactly as today. No
`Access-Control-Allow-Private-Network` header is sent.
1.3 A real-browser-style acceptance test drives a separate web origin (another 127.0.0.1 port,
and the `https` same-hostname form behind the TLS exposure mode) against an actual protected
server: pairing, session read, refresh, logout, a REST mutation with `X-WaveKit-CSRF`, a
mutation without it (403 `CSRF_REQUIRED`), preflights (allowed, denied, cached-age header), the
WebSocket upgrade with the cookie and Origin, an audio stream on the audio origin, and a foreign
origin denied at each step (403 `ORIGIN_FORBIDDEN`, no `Access-Control-Allow-*` headers, no
cookie set). The session cookie keeps `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, and
`Secure` exactly when `listenerScheme` is `https`.
1.4 The pairing and session DTOs are shared (`packages/api-types/src/access-pairing.ts`): pair
request and response, session, refresh, logout, pairing code, error codes. The routes, statuses
and bodies stay as today except 1.5.
1.5 `POST /api/access/pair` accepts optional `name` and `kind` with the device label rules
(1–64 characters, at most 128 UTF-8 bytes, no surrounding whitespace, no C0/C1 control or
bidirectional override; `kind` from `ACCESS_DEVICE_KINDS`). They are validated before the code is
reserved (an invalid value is 400 `MALFORMED_REQUEST` and the code stays usable) and committed
with the session (the device list shows them; no second write a failure could split). A body
without them pairs exactly as today. Unknown keys are refused as today.
1.6 The reference TLS profile (`docker/caddy`) gains a commented web origin example on its own
port of the API hostname, listed in `allowedOrigins`.
1.7 A web app on a different hostname or site stays unsupported by design: the session cookie is
host-only and `SameSite=Strict` (a cross-site request does not carry it, and `SameSite=None`
would depend on third-party cookies that browsers block), an `https` page cannot call an `http`
API (mixed content), and the access design binds browser, API and audio to one coherent
hostname. The configuration check keeps refusing such origins.
1.8 The lane returns a pairing contract and an example browser flow (operator issues a code
with the CLI or the machine credential; the web app reads `GET /api/access/bootstrap`, posts the
code with `credentials: "include"`, keeps the CSRF token in memory, renews, logs out, recovers
from 401 and 403) for Main to publish in `docs/API.md`.
1.9 Legacy mode, every legacy route and every protected response other than 1.2 (the added
header) and 1.5 (the optional fields) are byte-identical.

## 2. Recording Keep and deletion

As an operator I want to keep a recording so nothing WaveKit runs deletes it, and to delete a
call recording I do not need, without any path from the web app reaching the filesystem.

2.1 `RECORDING_KEEPS_REQUIRES_ACCESS = true`: `PUT` and `DELETE /api/recordings/:id/keep` and
`DELETE /api/recordings/:id` are mounted only in protected mode, beside the WG8 inventory, and
re-check the request like the other protected mutations (session, CSRF, Origin). Nothing is
mounted in legacy mode.
2.2 Keys: a keep is stored under a stable key that is never a path: `dsd~<call name>` for a
dsd-fme call recording (any dsd-fme recording directory; the inventory index is not stable) and
`scan:<recordingId>` for a scanner recording. Inventory items carry `kept`.
2.3 The keep store `<stateDir>/recording-keeps.json` (`RECORDING_KEEPS_FILE_NAME`): atomic,
serialised writes (temporary file, fsync, rename; memory replaced only after the rename); at
most 2 000 entries (`RECORDING_KEEPS_MAX_ENTRIES`), 1 MiB (`RECORDING_KEEPS_FILE_MAX_BYTES`) and
512 MiB of kept bytes (`RECORDING_KEEPS_MAX_BYTES`, each file counted at its size when kept). A
Keep that would pass a bound is refused with 409 `RECORDING_KEEP_LIMIT`.
2.4 **Fail closed by meaning.** A missing file loads empty. A file that cannot be read, parsed or
validated, or that passes a bound, is left in place (not moved aside, not rewritten) and the
store is `failed`: while the store is `loading` or `failed` every deletion decision is
"protected" (no owner deletes any recording), every item reads `kept: true`, and Keep, unkeep and
delete answer 503 `RECORDING_KEEPS_UNAVAILABLE`. One warning is logged with a count and the error
class; the operator repairs or removes the file and restarts. A store that cannot be written
answers 503 and leaves memory unchanged.
2.5 One deletion decision: every code path that deletes a listed recording or a folder that holds
one consults the protection port (`RecordingProtection`) synchronously, immediately before the
unlink: the dsd-fme call pruner, scanner evidence retention, discovery removal (explicit delete,
inactive prune and capacity eviction) and analog retention. A kept file is never deleted by any
of them; the decision runs in the same synchronous turn as the unlink call that follows it.
2.6 Deleting a scanner discovery that holds a kept recording is refused with 409
`SCANNER_DISCOVERY_HOLDS_KEPT_RECORDINGS` (no cascade to protected media); the inactive prune
and capacity eviction skip such a discovery.
2.7 Keep (`PUT`): the id must resolve to an eligible recording (WG8 checks, verified open);
idempotent (`changed: false` when already kept); persisted before the 200. Unkeep (`DELETE
…/keep`): idempotent, allowed when the file is gone; persisted before the 200.
2.8 Delete (`DELETE /api/recordings/:id`): only `dsd:` ids (a `scan:` id is 409
`RECORDING_DELETE_UNSUPPORTED`); a kept recording is 409 `RECORDING_KEPT` (unkeep first); the
file is opened and verified as for download, then unlinked only if the path still names the same
file (device and inode) and is not kept; a vanished file is 404 `RECORDING_NOT_FOUND`. Keep and
delete of the same key are serialised; the loser gets 409 `RECORDING_BUSY`. The inventory
listing cache is invalidated after a delete, Keep or unkeep.
2.9 No request input is a path; no symbolic link is followed; error bodies and logs name no path,
file name, directory, key or submitted value.
2.10 With no keep file, no protected mode and the shipped config, every pruner, retention run,
route and log line is byte-identical to the WG9 base.
2.11 Known gaps recorded, not fixed: a discovery merge does not move the dropped discovery's
recording folder, and a capacity eviction can leave a folder without its discovery; a kept file
in such a folder stays protected by its key (2.5), but the folder is not listed under the
surviving discovery. Kept dsd-fme bytes count toward the dsd-fme size cap, so many keeps shrink
the space for new calls (bounded by 2.3). While the store is `failed` no recording is pruned, so
the disk can fill.

## 3. Tuning trust and retune latency

As a web user I want the frequency label on spectrum frames and transmissions to be true, and the
spectrum to follow my retune quickly.

3.1 **Strict trust.** One shared rule derives the trust label from tuner state: `unverified` when
frequency or sample rate is unknown or only declared (`unknownFields` or `declaredOnlyFields`:
never written by this core on the current connection nor seen in an accepted relay command since
the last reset), else `relay` for external control and `commanded` for internal control. The
spectrum engine's initial label, its caps-change and suppressed-centre relabels, and the analog
transmission frequency use this rule (WG5 requirement 6.2 and 6.4, now enforced everywhere).
3.2 A caps change that comes from reconnect reconciliation (no command of this core on the new
connection) is labelled `unverified` until this core commands the tuner on that connection. A
replayed command (reconnect restore) that the tuner accepts is a command of this connection.
3.3 A retune's spectrum epoch takes its centre from the command value, so a retune posts one
epoch with the new centre (no transient epoch with the old centre).
3.4 **Operator retune settle.** A retune that is not the scanner's own (`origin` other than
scanner) uses its own display settle: the retune marker boundary when the source supports
markers, else a bounded timer (`OPERATOR_RETUNE_SETTLE_MS`, at most 300 ms, chosen by
measurement). Frames published before the configured network settle
(`scanner.sweep.settleMs.network`) has elapsed after such a retune are labelled `unverified`.
The scanner's settle, markers and stale-content discard are unchanged.
3.5 Budget, measured offline with a fake rtl_tcp server on 127.0.0.1 and an injectable send delay:
command to first spectrum frame at the new centre, p90 at most 300 ms with no injected delay
(from about 1 100 ms), and at most the injected delay plus 300 ms with it; no frame labelled
`commanded` or `relay` carries samples from before the retune in the harness.
3.6 The spectrum frame, transmission and WebSocket shapes are unchanged; only the label values
change where 3.1 to 3.4 say so. Every golden that changes is listed with its reason.

## 4. Zoom sustained workload measurement

As the maintainer I want measured limits for a genuine viewed-slice FFT before building zoom.

4.1 A reproducible benchmark (`scripts/bench/zoom-workload.ts`, bundled to one file by
`scripts/bench/build-zoom-workload.mjs`) measures the sustained cost of a separate long FFT over
contiguous raw IQ for a viewed slice, on top of a detector-proxy load, with no product code
change (it imports pure spectrum helpers only, or copies them).
4.2 Sweep: sample rates 2.048 and 2.4 Msps; transform sizes 2 048 to 262 144 (powers of two);
slice transform rates 1 to 25 per second; 1 to 8 concurrent slices; at least 60 s per cell
(shorter in a smoke mode). Optional variant: shift and decimate before the FFT.
4.3 Per cell it records CPU core fraction, per-transform p50/p95/p99, event-loop delay p99,
RSS and heap high-water, and missed 250 ms freshness deadlines, as JSON lines plus a summary.
4.4 The lane runs it on the Mac and proposes limits (transform size, slice rate, concurrent
slices or clients) against the viewed-slice-spectrum budgets (at most 0.10 core per source, 0.20
in total, event-loop p99 increase at most 2 ms, no missed deadlines, bounded RSS). Main runs the
same bundle on the Raspberry Pi and records both.

## 5. Minor defects

5.1 A taken audio output port (legacy mode) or tuner relay port makes startup fail cleanly (the
error is logged, startup cleanup runs, exit code 1) instead of an uncaught exception; a test
holds the port.
5.2 A stored decoder override key that the configuration shadows (top-level `frequencies`, or
`options.frequencies` over `frequency`) is dropped at load, counted with the other dropped keys
and logged once as a count.
5.3 A live-audio `PATCH` refused by the core's own validation answers 400 with a stable `code`
(`VALIDATION_ERROR` for a schema range, the error's own code such as
`CHANNEL_OFFSET_OUT_OF_RANGE` otherwise) and, with access configured, the same redacted message
as the global error handler.
5.4 An identify trial whose decoder program cannot run (it exits before any output with the
shell's command-not-found or not-executable status, or fails to spawn) is `unsupported` with
reason `decoder-unavailable`, not `no-sync`. The outcome list is unchanged.
5.5 In legacy mode with no configured public origin, the live-audio and digital-voice status
routes answer with an `httpUrl` whose host is the request's own `Host` (validated as a host name
or address and port; an invalid one keeps today's `localhost`), scheme `http` and the audio port.
It is derived per response, never stored, logged, broadcast or used for any decision; WebSocket
status keeps today's value. Responses carrying a derived URL are `Cache-Control: no-store`.
5.6 After a retune the auto squelch re-seeds its noise floor from the lower of the previous floor
and the first measured power (a carrier present at the new frequency no longer mutes itself until
it ends). The reset on retune stays.
5.7 Not a bug (dropped): a new spectrum subscriber gets no snapshot while passive scanning is off
because the engine has no summary yet; live frames follow within one integration period.

## 6. Main items

6.1 Main wires: the keep store, the protection port for every deleter (dsd-fme provider and the
scanner-side hooks in Main-only files), the Keep and delete routes; the pairing name/kind in the
docs; the legacy audio host derivation option on the status routes; optional `hostCentre` from
the sdr-host poller.
6.2 docs/API.md, docs/DOCKER-SETUP.md, ROADMAP, SCANNER (settle note) and the coordination note
(for the CLI and the web session) describe every new route, field, bound and rule; the CLI
guards are checked for the new reason and fields.
6.3 Main ticks core-access-policy task 15 (implemented by web-gaps-2 lane D) and records
checkpoint 14's local evidence; real deployment acceptance stays a separate gate.
6.4 Main runs the section 4 benchmark on the Raspberry Pi.

## 7. Verification

7.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
7.2 The root suite, typecheck and lint pass at every merge.
