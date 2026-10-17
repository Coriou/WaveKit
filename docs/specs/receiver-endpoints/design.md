# Receiver endpoints design

Status: implemented and software-tested (user stories 1–4); not deployed. See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

## Pi side (sdr-host and image)

`packages/sdr-host/src/telemetry/endpoints.ts`: `rankEndpoints(interfaces)` is a pure
function over the `SdrHostNetworkInterface[]` that `HostCollector` already produces,
which carries `kind`, `operstate`, `addresses`, `speedMbps`, `defaultRouteMetric` and
`wireless`. `endpointsFromTelemetry(network, { iqPort, apiPort })` wraps it for the
status route, which reads the latest cached host network reading. When that reading
is unavailable, `endpoints` is a bare `null`; the reason stays in `GET /api/host`
`network.reason`. It never falls back to `os.networkInterfaces()` inside the container.

DTO in `packages/api-types/src/sdr-host.ts`:

```ts
export interface SdrHostEndpoint {
	address: string
	family: "IPv4" | "IPv6"
	interface: string
	kind: "ethernet" | "wireless" | "other"
	speedMbps: number | null
	signalDbm: number | null
}
export interface SdrHostEndpoints {
	iqPort: number
	apiPort: number
	addresses: SdrHostEndpoint[] // best first
}
// The sdr-host GET /api/status body (no named DTO; not core's status) gains
// receiverId: string and endpoints: SdrHostEndpoints | null.
```

`receiverId`: `randomBytes(16)` as hex, generated once when sdr-host starts. Core only
compares the ID behind the current address with the ID behind a candidate during a
single probe, so stability across restarts is not needed. A restart in between yields a
mismatch, and core skips that round (fail closed). No host files are mounted for it.

Image: add `wavekit-avahi.service` to `IMAGE_SUPPORT` in
`packages/sdr-host/scripts/build-pi-image.py` at
`/etc/avahi/services/wavekit-sdr-host.service`. It is a static avahi service file with
two `<service>` entries (`_wavekit-sdr._tcp` port 8080, `_http._tcp` port 80), and avahi
reloads such files on its own. The ports are the image defaults; a compose override of
the ports is not reflected there (documented). `validate_stock` additionally requires
`/usr/sbin/avahi-daemon`.

## Core side

`SdrHostPoller` (`src/core/sdr-host-poller.ts`) keeps polling only the configured
sdr-host API, which is the trust anchor; it never repoints its URL at a selected
endpoint. After each successful poll it parses `receiverId` and `endpoints` with a
Zod schema (`parseReceiverEndpoints`) and emits them as a separate
`receiver-endpoints` event. Every address must pass `isDialableEndpoint`: a literal
unicast IP that is not loopback, unspecified, link-local, multicast, broadcast or
IPv4-mapped. Any other entry drops the whole report, and so does a redirected
answer. The `status` event payload (`SdrHostStatus`) is unchanged, so
`/api/resources` stays byte-identical.

`EndpointSelector` (`src/core/endpoint-selector.ts`) is created in `src/index.ts`
only for startup sources that set `sdrHost.endpointSelection: auto`, and only when
the resource monitor and poller run. Otherwise startup logs a per-source warning
with the reason. Sources added at runtime are not covered. The selector acts on a
source only while its live config still matches the startup target (`rtl_tcp`,
same host and port, `auto`). A source removed and re-added under the same ID with
another host or setting is left alone. It keeps per source `{verifiedReceiverId,
lastSwitchAt, per-candidate backoff, busy}`. Reports are serialised per source: one
that arrives mid-probe is dropped. On each report:

1. While a non-configured host is active, it falls back to `configuredHost` when the
   receiver no longer lists the active address or its IQ port changed, or when the
   `receiverId` changed and the active address does not answer with the new one.
2. It does nothing without a report, while the source is disconnected, within the
   5-minute hold-down after an upgrade, or when the source port is not the
   receiver's `iqPort` (warned once).
3. The candidate is the first listed address that is ranked above the active host
   (a configured host that is not in the list counts as unranked) and is out of
   backoff. The probe (`src/core/endpoint-probe.ts`) checks that
   `GET http://<addr>:<apiPort>/api/status` (2 s timeout, no redirects, body capped
   at 256 KB) returns the same `receiverId`, then that a TCP connection to
   `<addr>:<port>` returns 12 bytes starting `RTL0` within 3 s and is closed
   without sending anything. On success the selector calls `retarget`. On failure
   the candidate backs off for 60 s, doubling up to 30 min. A later successful
   switch keeps the step, so a flapping endpoint waits longer each time.

Failure fallback lives in SourceManager, so it does not depend on the receiver's
API answering. On a selected (non-configured) host, every failed attempt and every
session shorter than 60 s counts. After 2 of them the source goes back to its
configured host before the next reconnect is scheduled, its `endpoint` reads
`fallback: selected endpoint failed`, and SourceManager emits `endpoint-fallback`.
The selector then backs that address off.

`SourceManager.retarget(id, host, reason)` keeps the registration, its stream, the
fanout and decoder assignments. It sets a host override that the next connection
attempt dials, then closes the current session. The ordinary reconnect path, the
same one that recovers from a receiver reboot, dials the new host after 250 ms
without a backoff step. Tuning is restored as on any reconnect. Only the first
attempt of a still-pending `connect()` is left to settle. `getStatus().url` stays
the configured URL. `trackEndpoint(id)` starts the optional `endpoint` status
field, `getActiveHost(id)` reads the override, and `getConfig(id)` returns a copy
of the live config.

`config.ts`: `sdrHost.endpointSelection: z.enum(["auto", "off"]).optional()` has no
default, so parsed configs and config export gain no key. Omitted or `off` means
off. Source status gains an optional `endpoint?: { configuredHost, activeHost,
reason, at }` (`SourceEndpoint`, `sourceEndpointSchema` in the REST source and
health schemas), present only for tracked sources. The CLI `guardSource` picks
known fields, so it ignores `endpoint`; that is tested.

The bridge (`scripts/pi-lan-bridge.mjs --auto`) applies the same checks and address
filter once at start through `scripts/pi-lan-bridge-select.mjs`, a plain ESM
module with no dependencies.

Known limits:

- `SourceBackpressureTracker` matches rtlmux clients by local socket address.
  Behind NAT, as in the measured home setup, it already falls back to the sum over
  all clients.
- A configured hostname counts as unranked, so a source that dials `pi.local`
  reconnects once even when the name already resolves to the best address.

## Correctness properties

Property 1: Ranking order. For any interface list, `rankEndpoints` lists no
link-local, loopback or virtual address. Every wired-with-carrier entry precedes every
wireless entry. Within the same kind, the order is by ascending metric and then IPv4
before IPv6. Validates 1.2, 1.3.

Property 2: No unverified switch. For any sequence of poll results and probe outcomes,
the active host changes to a candidate only on a step where both checks succeeded for
that candidate and the receiver ID matched. Validates 3.2, 3.6.

Property 3: Bounded switching and anchor fallback. For any sequence, switches are at
least the hold-down apart, and two consecutive failures on a non-configured host always
end at the configured host. Validates 3.3, 3.4.
