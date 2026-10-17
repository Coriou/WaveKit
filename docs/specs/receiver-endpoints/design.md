# Receiver endpoints design

Status: Pi side implemented (user stories 1–2); core and bridge design only. See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

## Pi side (sdr-host and image)

`packages/sdr-host/src/telemetry/endpoints.ts`: `rankEndpoints(interfaces, ports)` is a
pure function over the `SdrHostNetworkInterface[]` that `HostCollector` already
produces, which carries `kind`, `operstate`, `addresses`, `speedMbps`,
`defaultRouteMetric` and `wireless`. The status route reads the latest host network
reading. When that reading is unavailable, `endpoints` is `null` with a reason; it
never falls back to `os.networkInterfaces()` inside the container.

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
// SdrHostStatus gains: receiverId: string; endpoints: SdrHostEndpoints | null
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

Inside `SdrHostPoller` (`src/core/sdr-host-poller.ts`), which already fetches
`/api/status` per host: parse `receiverId` and `endpoints` with a Zod schema, then hand
them to a new `EndpointSelector` (`src/core/endpoint-selector.ts`), one per source.

The selector holds `{configuredHost, activeHost, receiverId, lastSwitchAt, failures,
candidateBackoff}`. On each poll:

1. If the best-ranked candidate is ranked above the active host, and the hold-down
   (5 min) and that candidate's backoff have both elapsed, probe it:
   `GET http://<addr>:<apiPort>/api/status` (2 s timeout) must return the same
   `receiverId`, and a TCP connect to `<addr>:<iqPort>` must yield 12 bytes starting
   `RTL0` within 3 s, after which the socket is destroyed.
2. On success, call `SourceManager.retarget(id, host)`, a new method: `disconnect` plus
   `connect` with the host overridden in a copy of the config. That is the same path
   `reconnect` already uses, so tuning restoration and trust/settle handling are
   unchanged. Point the poller's API URL for that source at the new host unless the
   config sets an explicit `sdrHost.apiUrl`.
3. Two consecutive connect failures on a non-configured active host make the selector
   retarget back to `configuredHost` and mark the candidate's backoff.

`config.ts`: `sdrHost.endpointSelection: z.enum(["auto", "off"]).default("off")`
(additive; with `off` no selector is created and output is byte-identical). Source
status DTO gains an optional `endpoint?: { configuredHost, activeHost, reason, at }`,
omitted while selection is off. That is a contract change: extend the CLI guards in
`cli/source/data/*guards*.ts` and announce it to the web owner.

Sequencing: the core part lands after WG10 is published, rebased onto the new main.
WG10 owns `src/index.ts`, `src/config.ts` and `packages/api-types` until then.

The bridge (`scripts/pi-lan-bridge.mjs --auto`) reuses the same probe logic. The probe
lives in a small dependency-free module that the script can import.

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
