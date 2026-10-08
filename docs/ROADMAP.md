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
- [ ] Support a direct Ethernet cable between the Pi and the operator's computer,
      powered by a battery, without a router. Evaluate automatic addressing,
      discovery, routing alongside the computer's internet connection, adapter/OS
      compatibility and recovery after cable removal. Measure sustained loss-free
      IQ and latency at supported rates rather than assuming Ethernet guarantees it.

Both direct Wi-Fi and direct Ethernet are portability targets: one laptop, one
Pi, one battery, with an Ethernet cable as the wired alternative. Router-based
Wi-Fi/Ethernet and direct links need separate acceptance tests.

## 3. Correctness and performance audit

- [ ] Route stdin decoders through the explicitly selected source.
- [x] Enforce source exclusivity in both assignment orders.
- [ ] Manage complete decoder process trees and avoid unsafe shell interpolation.
- [ ] Make resampling independent of input chunk boundaries; report actual rates.
- [ ] Synchronize tuner state on reconnection and propagate accepted changes.
- [x] Preserve arrays when applying indexed environment overrides.
- [ ] Fix recording EOF cleanup.
- [ ] Distinguish disconnected, waiting, stale, dropping and streaming states;
      display current activity separately from historical counters.
- [ ] Exercise real decoder IQ fixtures, lifecycle failure cases, and memory limits.

## 4. API and event foundation for multiple clients

The CLI is the first consumer; a future web interface must use the same public
contracts. Audit existing REST, WebSocket, SSE and binary/server streaming paths
before choosing extensions or promising compatibility.

REST routes have Fastify schemas and Swagger; `/ws` supports channel subscriptions
and caps incoming messages at 1 MiB. Outgoing payloads are now bounded per client
at 1 MiB/256 queued messages, with heartbeat and slow/dead-client cleanup. There
is still no sequence/replay or reconnect snapshot contract, and no SSE endpoint.
Authentication is absent from the
API layer and CORS reflects all origins with credentials enabled. Audio and IQ
use separate streaming servers; their per-client queues are now bounded. Prioritize
access/origin policy before exposing a browser UI.
These findings describe the current code, not completed API acceptance.

- [ ] Define typed, versioned schemas, capability discovery and consistent errors.
- [ ] Specify snapshot/event ordering, sequence IDs, reconnect/resume behavior,
      bounded replay and explicit gaps when history is unavailable.
- [ ] Provide filtered subscriptions, heartbeat/liveness and cancellation.
- [x] Bound WebSocket output queues, isolate slow clients and detect dead peers.
- [ ] Bound per-client buffers and define overload behavior independently for
      telemetry, decoder events, audio and IQ.
- [ ] Define authentication, origin policy, authorization and safe LAN exposure.
- [ ] Test simultaneous CLI/web clients, slow readers, reconnects, server restart,
      event ordering, resource cleanup and documented throughput limits.
- [ ] Publish examples and contract tests for REST, WebSocket, SSE and streaming.

## 5. Protocol-aware signal discovery and scanning

Study and prototype this as a major product feature once tuning, source ownership
and decoder lifecycle are reliable. A scanner should discover and characterize
activity, not merely stop on a strong signal.

- [ ] Scan an operator-selected frequency range or the receiver's supported tuning
      range with explicit steps, bandwidth, dwell time and exclusions.
- [ ] Offer protocol-specific searches, such as finding DMR activity, using suitable
      demodulators/decoders and distinguishing a candidate from a confirmed decode.
- [ ] Combine spectrum/activity detection with targeted decoding; report frequency,
      bandwidth, observed protocol, confidence, timestamps, signal measurements and
      available decoded metadata. Retain evidence and avoid duplicate discoveries.
- [ ] Schedule efficient coarse searches and focused revisits, with bounded CPU,
      memory and retuning overhead. Test weak, intermittent and overlapping signals
      using recorded fixtures and measured detection/false-positive rates.
- [ ] Define background scanning ownership: a single tuner cannot scan other bands
      while maintaining an unrelated live stream. Expose pause/resume, priorities,
      compatible in-window searches and additional-receiver options explicitly.
- [ ] Expose scan jobs, progress, cancellation and discovery reports through the
      shared API/events so CLI and future web clients have equivalent capabilities.
- [ ] Establish hardware/protocol limitations before promising whole-band coverage
      or identifying every signal. Treat encrypted/undecodable activity honestly.

## Delivery discipline

Review and publish coherent commits as each batch passes its relevant checks.
Keep credentials, SSH identities, local network settings, SD images, card backups
and raw diagnostic/session notes out of the public repository. Preserve local
artifacts while publishing only reusable examples and sanitized findings.
Record test results honestly, including skipped tests and hardware limitations.
