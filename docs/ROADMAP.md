# Reliability and portable receiver roadmap

Updated 2026-10-08. Work proceeds in the order below. Software checks and hardware
acceptance are separate: a healthy process or passing unit suite does not prove
continuous IQ reception, correct RF decoding, or unattended installation.

## 1. Reproducible SD-card installation

- [x] Provide a documented Imager → stage → eject → boot workflow for 64-bit Pi OS.
- [x] Stage optional SSH public-key access without copying private keys or requiring
      a manual SSH multiplex session. Normal receiver operation must not need SSH.
- [x] Preserve Imager accounts, Wi-Fi, SSH policy, and existing cloud-init commands.
- [x] Validate bundle integrity and platform before installation; retain explicit
      failed/running/complete status and actionable recovery logs.
- [ ] Verify first-boot root installation with password-required sudo accounts.
- [ ] Repeat installation on a freshly written card: Wi-Fi, Ethernet, mDNS, direct
      SSH, Docker startup, dongle detection, reboot and receiver hotplug recovery.

Hardware acceptance requires a stable supply. Current development hardware has
repeated undervoltage and substantial IQ loss over Wi-Fi; a replacement supply
is expected on 2026-10-09. Do not erase the running card until the corrected
payload is tested and the actual target disk is identified again.

## 2. Network performance and portability

Begin research after the complete SD installation has been exercised.

- [ ] Measure native and container delivery separately on Ethernet and Wi-Fi:
      generated/delivered/dropped bytes, stalls, latency, CPU, memory and power.
- [ ] Establish a 30-minute continuous baseline at the selected sample rate, then
      test multiple clients, slow clients, disconnections and automatic recovery.
- [ ] Investigate Wi-Fi power saving, interference, channel/link limits and sample
      rate choices; change one variable at a time and report bandwidth tradeoffs.
- [ ] Evaluate on-Pi processing, decimation and transport alternatives where useful.
- [ ] Design an optional secured direct Wi-Fi connection for a laptop + battery +
      Pi setup, including provisioning, discovery, reconnect and LAN fallback.

## 3. Correctness and performance audit

- [ ] Route stdin decoders through the explicitly selected source.
- [ ] Enforce source exclusivity in both assignment orders.
- [ ] Manage complete decoder process trees and avoid unsafe shell interpolation.
- [ ] Make resampling independent of input chunk boundaries; report actual rates.
- [ ] Synchronize tuner state on reconnection and propagate accepted changes.
- [ ] Fix recording EOF cleanup and indexed environment overrides.
- [ ] Distinguish disconnected, waiting, stale, dropping and streaming states;
      display current activity separately from historical counters.
- [ ] Exercise real decoder IQ fixtures, lifecycle failure cases, and memory limits.

## 4. API and event foundation for multiple clients

The CLI is the first consumer; a future web interface must use the same public
contracts. Audit existing REST, WebSocket, SSE and binary/server streaming paths
before choosing extensions or promising compatibility.

Initial code audit: REST routes have Fastify schemas and Swagger; `/ws` supports
channel subscriptions and caps incoming messages at 1 MiB. Its outgoing event
queues are unbounded, with no heartbeat, sequence/replay or reconnect snapshot
contract. No SSE endpoint is implemented. Authentication is absent from the
API layer and CORS reflects all origins with credentials enabled. Audio and IQ
use separate streaming servers; their per-client queues are now bounded. Prioritize
WebSocket output bounds and access/origin policy before exposing a browser UI.
These findings describe the current code, not completed API acceptance.

- [ ] Define typed, versioned schemas, capability discovery and consistent errors.
- [ ] Specify snapshot/event ordering, sequence IDs, reconnect/resume behavior,
      bounded replay and explicit gaps when history is unavailable.
- [ ] Provide filtered subscriptions, heartbeat/liveness and cancellation.
- [ ] Bound per-client buffers and define overload behavior independently for
      telemetry, decoder events, audio and IQ.
- [ ] Define authentication, origin policy, authorization and safe LAN exposure.
- [ ] Test simultaneous CLI/web clients, slow readers, reconnects, server restart,
      event ordering, resource cleanup and documented throughput limits.
- [ ] Publish examples and contract tests for REST, WebSocket, SSE and streaming.

## Delivery discipline

Review and publish coherent commits as each batch passes its relevant checks.
Keep credentials, SSH identities, local network settings, SD images, card backups
and raw diagnostic/session notes out of the public repository. Preserve local
artifacts while publishing only reusable examples and sanitized findings.
Record test results honestly, including skipped tests and hardware limitations.
