# Receiver endpoints requirements

Status: user stories 1–4 implemented and software-tested; not deployed to a Pi.

See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

A Raspberry Pi receiver often has two links: Wi-Fi and a cable. The client picks the
address it dials, and a client that dials the Wi-Fi address is served over Wi-Fi even
when Ethernet is up. A full 2.048 Msps U8 stream is about 4.1 MB/s. Measured on a Pi 3B
at -70 dBm, Wi-Fi delivered 2.2 MB/s and rtlmux dropped 52% of the IQ, while the
cable sat idle on another home subnet that the client could still reach through NAT.

## User story 1: a client can learn every address the receiver can be reached on, best first.

1.1 `GET /api/status` on sdr-host carries `endpoints`: the receiver's IQ and API ports
and one entry per usable address, ranked best first.

1.2 Ranking: a wired interface with carrier comes before Wi-Fi. Within the same kind,
the lower default-route metric comes first. IPv4 comes before global IPv6. Link-local,
loopback, container and virtual interface addresses are never listed.

1.3 Each entry states its interface name, its kind (`ethernet`, `wireless`, `other`),
its wired speed or null, and its Wi-Fi signal or null. It never claims that the address
is reachable from any particular client.

1.4 `GET /api/status` carries a `receiverId`: 128 random bits that identify one
running sdr-host process and are the same on every address it serves. It changes when
sdr-host restarts, which makes a comparison across a restart fail closed. It reveals
nothing about the host. It is not an authenticator: anyone on the LAN can read it, and
it only shows that two addresses lead to the same running receiver.

## User story 2: on a home network, the receiver can be found without typing an address.

2.1 The Pi image publishes a DNS-SD service `_wavekit-sdr._tcp` on the API port, through
the host's existing avahi-daemon, with TXT keys `v=1`, `iq=<rtlmux port>` and
`path=/api/status`.

2.2 The image also publishes `_http._tcp` for the status page, so the receiver appears
in browsers and in tools that list Bonjour services.

2.3 Discovery is a convenience only: it reaches one subnet. Endpoint choice is made
from 1.1, never from the multicast answer alone.

## User story 3: WaveKit moves its IQ connection to the best reachable endpoint and back.

3.1 For an `rtl_tcp` source that has an sdr-host API, `sdrHost.endpointSelection: auto`
lets core switch its active host to a better-ranked endpoint. The default is `off`,
which keeps the configured host, and behaviour and output stay byte-identical to today.

3.2 Core switches only after the candidate has passed two checks. First, its API returns
the same `receiverId` as the current receiver. Second, a TCP connection to its IQ port
returns a valid `RTL0` header within a bounded timeout. The probe sends no commands.

3.3 A switch reconnects the source once and restores tuning, as an ordinary reconnect
does. Each source switches at most once per hold-down period. No candidate is retried
before its own backoff has elapsed.

3.4 When a selected endpoint fails 3 times within 10 minutes, core falls back to the
configured host and resumes normal reconnect backoff there. A failure is a failed
connection attempt, or any session that ends without a deliberate switch. The configured host stays the anchor.
It is never rewritten in config.

3.5 Source status reports the configured host, the active host, the reason for the last
switch or fallback, and when it happened.

3.6 Fail closed. Endpoint data is validated with Zod at the boundary. A candidate is
only ever a literal IP address that the configured sdr-host itself listed in its
`endpoints`, fetched through the configured (or currently verified) API. Core never
dials hostnames from that list. It never takes candidates from mDNS answers or any
other source. Any failed check, timeout, parse error or ID mismatch leaves the active
host unchanged. Trust in a candidate comes from the configured host's own endpoint
list plus a valid `RTL0` header on the candidate. A matching `receiverId` only
confirms that the candidate is the same receiver; it authenticates nothing (1.4).
A listed address must be a unicast IP in every spelling: never loopback, unspecified,
link-local, multicast, reserved, broadcast, IPv4-mapped or IPv4-compatible, and never
with a zone id. Core probes a candidate's API only on the configured API port, never
on a port the receiver reports. A report whose `apiPort` or `iqPort` differs from the
configured ones leaves selection idle.

3.7 The CLI and web source-status guards accept the new `endpoint` field.
The field is omitted, never null, while selection is `off`.

## User story 4: the Mac loopback bridge can use the best endpoint.

4.1 `scripts/pi-lan-bridge.mjs --auto <host>` applies the same checks as 3.2 once at start
and bridges to the best endpoint that passes. It prints the chosen address. Without
`--auto` it behaves exactly as today.
