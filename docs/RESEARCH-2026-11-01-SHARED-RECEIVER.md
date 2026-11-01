# Research: one receiver, several WaveKit cores

Status: research note, 2026-11-01. No code changes. Backlog: [roadmap §4b](ROADMAP.md#4b-shared-receiver-tuning-truth-and-control),
§2 (endpoint selection default) and §12 (discovery). Written for the lane that picks this up;
verify file and line references before relying on them.

## Question

A WaveKit SDR host (the `packages/sdr-host` image, on a Pi or beside a USB dongle) serves one
dongle to several clients through rtlmux. Two WaveKit cores on two computers used the same Pi
at once. Does each core know what the dongle is actually tuned to, and does the core use the
host's best network link?

## What was observed (one Pi 3B, two cores, 2026-11-01)

1. **The second core trusted its config.** Core A had tuned the dongle for ADS-B (1090 MHz,
   2.4 Msps). Core B connected fresh with `caps.centerFreq` 446.52492 MHz and 2.048 Msps in its
   config, and showed and decoded the stream as that. Its pager decoder was placed on a channel
   that was not in the captured band. Core B wrote no tuning (correct), so core A was not
   disturbed.
2. **The host reported the wrong frequency.** sdr-host `GET /api/status` returned
   `rtlTcp.config.frequency: 446524920`, the value rtl_tcp was started with, while the dongle
   was at 1090 MHz. Its upstream byte rate (about 4.8 MB/s, so 2.4 Msps) contradicted the
   2.048 Msps the core assumed; `sampling.upstream.rateStatus` read `unknown`.
3. **No warning fired.** The core's `host-centre-mismatch` trust warning compares the core's
   centre with the host-reported one; both said 446.52492 MHz. The `untracked-retune`
   detector catches a change during a session, not a stream that is wrong from its first
   sample.
4. **A plain resume behaved as documented.** After `POST /api/sources/:id/resume` the core
   wrote nothing and marked centre, rate and gain unverified (`docs/API.md`, plain resume).
5. **The host was dialled on its Wi-Fi address while its Ethernet link was idle.** The client
   resolved the host's `.local` name on the Wi-Fi subnet; the cable sat on another home subnet
   reachable through NAT. Same stream, same client, 10 s each: 3.13 MB/s with a 762 ms worst
   gap over Wi-Fi, 4.84 MB/s with a 63 ms worst gap over Ethernet. This is the case
   `docs/specs/receiver-endpoints/requirements.md` describes.
6. **Endpoint selection worked live, first real-hardware run.** With
   `sources[].sdrHost.endpointSelection: auto` (default `off`) and the Wi-Fi address
   configured, core moved to the Ethernet address about 2 s after the feed resumed
   (`reason: verified ethernet endpoint`), wrote no tuning, and the rtlmux client showed
   `commandBytes: 0`. Remaining loss (about 5–10 %) was on the client's own Wi-Fi repeater
   chain (10–37 ms round trip to its router), not on the host.
7. **Discovery is published, not consumed.** The image announces `_wavekit-sdr._tcp`
   (`v=1 iq=5555 path=/api/status`) and was found by `dns-sd -B`, but nothing in `src/`,
   `web/` or `cli/` browses for it. Users still type an address into a copied config.

## Why it happens (code facts)

- rtl_tcp has no readback: a client writes 5-byte commands and never learns the state.
  rtlmux forwards every client's commands to the one rtl_tcp; the last writer wins.
- sdr-host starts rtl_tcp on an internal port (`rtlTcp.internalPort`, default 1234, not
  published) and every client reaches it through rtlmux (`rtlmux.port`, 5555). The USB
  compose profile (`compose.usb.yaml`) runs the same image. So the host is the one place
  that can see every command, for both the Pi and USB setups.
- The status route reports the launch value (`packages/sdr-host/src/api/routes/status.ts`,
  `frequency: config.rtlTcp.frequency`).
- On a fresh connect, `TunerController.synchronizeOnConnect`
  (`src/core/tuner-controller.ts`) writes only configured `sources[].tuner` gain frames and
  otherwise keeps the configured caps as known values. A plain resume holds them unverified.
- The core already overrides its centre from a host-reported one
  (`src/core/spectrum/spectrum-engine.ts`, `host-centre-mismatch`), and already arbitrates
  tuner use inside one process (`src/core/scanner/tuner-arbiter.ts`: leases, preemption
  reasons such as `preempted-operator`). Neither spans cores.

## Proposed direction

Principles from the owner: no configuration nightmare, no burden on dev machines or agents,
equally easy for humans in the UI and for agents through the API.

### A. The host knows the tuning (Pi and USB)

The host records every command that reaches rtl_tcp: centre, rate, gain mode, gain, AGC, PPM,
bias tee and direct sampling, with the time and the rtlmux connection that sent it. Two places
can do it: a small proxy in sdr-host between rtlmux and rtl_tcp, or the patched rtlmux already
built in `packages/sdr-host/Dockerfile`. Initial state is the launch config, which the host
itself applied. It publishes this in `GET /api/status` and pushes changes (SSE or WebSocket),
together with the dongle facts it already has or can read (USB product, tuner type and gain
count from the rtl_tcp header). It checks the written rate against its measured byte rate.

Limits to state honestly: the host knows what was written, not that the tuner applied it.
Out-of-range values can be rejected or flagged against librtlsdr's ranges. A later step could
replace rtl_tcp with a host-owned librtlsdr server that reads back the achieved rate and
frequency. Sources without our host (bare `rtl_tcp`, third-party servers, recordings) keep
today's behaviour.

### B. Cores always use the host's truth

On connect and on every pushed change, the core adopts the host's state: spectrum axis,
caps, decoder placement and the island show it, with who set it and when. "Unverified" then
remains only for sources without our host. The `host-centre-mismatch` path becomes useful as
is once the host reports live values.

### C. Shared control, in two phases

**Phase 1, visibility only (no blocking, no config).** Anyone may tune, as today. Every change
is attributed and broadcast ("1090 MHz, set by <station name>, 2 min ago"), and every core
follows at once. Decoders that lose their band suspend with a reason naming who retuned.
Attribution needs a name per connection: for example the core registers its rtlmux
connection with the host API on connect; unregistered clients (SDR++) show as their address.

**Phase 2, optional holds.** A core can hold the tuner for a purpose ("ADS-B watch").
Background work (scanner sweeps, scheduled jobs) never preempts a hold. Explicit requests
can: "Take control" in the UI, `takeover: true` through the API. The previous holder is told
and pauses with the reasons the core already uses. A **borrow** (an agent's dwell, a test
tune) restores the previous tuning when it ends, so a dev agent can dwell without breaking a
station. Holds end when their core disconnects or stops heartbeating, so a crashed core
cannot lock the tuner. A refused request returns who holds it, why and since when, so an
agent can decide to wait, borrow or take over without guessing.

Defaults: no hold exists until someone sets one; nothing new is required in config. Tuning
stays in-band as rtl_tcp commands, so SDR++ and older cores keep working; the host observes
and, only in Phase 2, filters.

### Risks to design for

- Old cores and SDR++ connected to rtlmux bypass holds unless the host filters commands; a
  filtering host must never silently drop a command without telling its sender's core.
- A retune by one core restarts or suspends decoders on the others. That is correct but
  visible; the UI should say who and why.
- The host becomes the tuning authority; it already is the single point of failure for IQ.
- Tests should keep using recordings and the mock station, not a shared live receiver.

## Open questions for the lane

1. Proxy in sdr-host or patch rtlmux? (Patch keeps one hop; proxy keeps rtlmux upstream-clean.)
2. How a core identifies its rtlmux connection to the host (registration call, or a
   WaveKit-specific command frame that rtl_tcp would ignore).
3. Push transport and its contract in `@wavekit/api-types`, shared by core, CLI and web.
4. Whether Phase 2 filtering lives in the host or stays advisory in the cores.
5. How the scanner's existing leases map onto host holds.

## Acceptance ideas

Two cores on one host: B connects while A holds 1090 MHz; B shows 1090 MHz from the first
frame, names A, and places no decoder outside the band. A retune by either is seen by the
other within one push. Repeat with the USB compose profile. An agent borrow restores A's
tuning. A killed core releases its hold.
