# Reliability and portable receiver roadmap

Updated 2026-10-08. Work proceeds in the order below. Software checks and hardware
acceptance are separate: a healthy process or passing unit suite does not prove
continuous IQ reception, correct RF decoding, or unattended installation.

## 1. Reproducible SD-card installation

A flashable WaveKit SD image and dedicated Imager launcher are now built locally.
The intended onboarding is: select WaveKit in Imager, configure network/account/SSH,
write, boot. Physical clean-card acceptance and release distribution remain pending;
the older manual staging workflow is retained for development and recovery.
The final candidate has completed a fresh unattended install and delivered IQ
to the laptop; its reboot and physical hotplug acceptance remain pending.
Earlier patched-runtime hotplug evidence is separate from this clean-card run.

- [x] Build a reproducible flashable WaveKit image from a pinned Pi OS base,
      embedding the verified receiver bundle and automatic first-boot setup.
- [x] Supply an Imager manifest with customization metadata so account, Wi-Fi
      and SSH setup work without post-write commands or preinstalled credentials.
- [ ] Validate the actual distributed image from a fresh write without manual
      payload staging or repairs on the Pi.

- [x] Provide a documented Imager → stage → eject → boot workflow for 64-bit Pi OS.
- [x] Stage optional SSH public-key access without copying private keys or requiring
      a manual SSH multiplex session. Normal receiver operation must not need SSH.
- [x] Preserve Imager accounts, Wi-Fi, SSH policy, and existing cloud-init commands.
- [x] Validate bundle integrity and platform before installation; retain explicit
      failed/running/complete status and actionable recovery logs.
- [x] Verify first-boot root installation with password-required sudo accounts.
- [ ] Repeat installation on a freshly written card: Wi-Fi, Ethernet, mDNS, direct
      SSH, Docker startup, dongle detection, reboot and receiver hotplug recovery.

The 2026-10-08 Wi-Fi run passed unattended installation, direct key-based SSH,
receiver startup and reboot recovery. USB reattachment exposed a stale receiver
handle; a subsequent runtime fix passed a physical unplug/replug test with IQ
resuming automatically. That runtime test does not count as a pristine image
pass; the refreshed image still needs a complete clean-card rerun. Ethernet and
sustained loss-free streaming remain unverified.

Validate SD writing, unattended first boot and sustained streaming separately.
Current development hardware has repeated undervoltage and substantial IQ loss
over Wi-Fi; a replacement supply is expected on 2026-10-09. Proceed with the
clean-card installer test on the current supply, recording any power events so
they are not confused with installer failures. Streaming stability acceptance
still requires stable power. Before erasing, verify the corrected payload and
identify the actual target disk again.

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

- [x] Route stdin decoders through the explicitly selected source.
- [x] Enforce source exclusivity in both assignment orders.
- [ ] Manage complete decoder process trees and avoid unsafe shell interpolation.
      Shared-IQ pipelines now own POSIX process groups and quote decoder arguments
      and recording paths; native grandchild cleanup tests pass. Audit remaining
      external-device/custom pipeline paths before marking the whole item complete.
- [ ] Make resampling independent of input chunk boundaries; report actual rates.
      Exact paired-IQ conversion now supports passive readsb (2.4 Msps), AIS,
      VDL2 and LoRa. Actual SoX rate, complex-phase, filtering and odd-chunk
      tests pass; all-decoder RF fixture coverage remains pending.
- [ ] Synchronize tuner state on reconnection and propagate accepted changes.
      Accepted frequencies now update source/decoder metadata, and tuning-driven
      decoder restarts are serialized. Reconnection synchronization remains open.
- [x] Preserve arrays when applying indexed environment overrides.
- [x] Fix recording EOF cleanup (file/timers released, downstream EOF after
      buffered final data; read errors stop looping playback).
- [ ] Distinguish disconnected, waiting, stale, dropping and streaming states;
      display current activity separately from historical counters. Core REST now
      exposes payload freshness (waiting/streaming/stale/paused/disconnected/ended)
      independently of transport and assignment capacity. CLI snapshots expire
      after 15 seconds; host sampling and combined drop reporting remain pending.
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

## 6. Lightweight Pi operator page

Provide an optional, uncluttered page served by the Pi itself, reachable from a
phone or computer on the local network without a cloud account. Keep it focused
on receiver operation and available without the laptop's WaveKit core running.

- [ ] Show first-boot progress/failure, host uptime, CPU load, memory, disk space,
      temperature and network connection with clearly labelled fresh/stale data.
- [ ] Distinguish active undervoltage/throttling from historical power events;
      report unavailable measurements honestly, without implying battery charge
      or power consumption can be measured on unsupported hardware.
- [ ] List attached SDR dongles and receiver service state, separating USB presence
      from actual sample flow, throughput and dropped data.
- [ ] Present a compact overview with optional diagnostic details, readable on
      mobile and inexpensive to serve on a Pi 3. Reuse the host API and shared
      telemetry contracts rather than creating a separate monitoring stack.
- [ ] Offer authenticated, explicitly confirmed shutdown (and optionally reboot),
      protected against cross-origin requests and limited to those host actions.
      Make pending shutdown and the expected loss of connectivity clear.
- [ ] Start with read-only status, then add host controls after access/origin policy
      is implemented. Test reconnects, setup failures, USB hotplug and stale data.

This is a planned operator convenience, not an implemented UI or a prerequisite
for the current clean-card acceptance run. Schedule it alongside the API/access
foundation once unattended setup is reliable.

## Delivery discipline

Review and publish coherent commits as each batch passes its relevant checks.
Keep credentials, SSH identities, local network settings, SD images, card backups
and raw diagnostic/session notes out of the public repository. Preserve local
artifacts while publishing only reusable examples and sanitized findings.
Record test results honestly, including skipped tests and hardware limitations.

## 7. CLI dashboard UI and UX overhaul

Run this as a dedicated design/implementation team alongside core reliability and
Pi operator-page work. Use Opus agents for implementation and review, with Fable
as a consultant for difficult product/design decisions and critical review.

- [ ] Audit the current dashboard with realistic live, idle, disconnected, stale,
      dropping and partially failing receiver/decoder states; establish a clear
      information hierarchy and operator workflows before redesigning.
- [ ] Improve layout, typography, spacing, navigation, keyboard interaction,
      discoverability and readable status/event presentation across terminal sizes.
- [ ] Make tuning, source ownership, decoder activity and decoded results easy to
      understand; distinguish API connectivity, IQ freshness, decoder process
      health, successful decoding and historical counters.
- [ ] Support useful detail views and filters without overwhelming the overview;
      handle empty states, reconnection, errors and unavailable measurements.
- [ ] Validate with representative fixtures and real terminal sessions, including
      narrow terminals, resize, keyboard use, long text and sustained event flow.
      Document any terminal/accessibility limitations and check rendering cost.
- [ ] Coordinate shared API/event changes with the core team. CLI team owns `cli/`;
      Pi team owns `packages/sdr-host/`; core team owns core/API/decoder changes.
      Agree on shared contracts before editing them, preserve concurrent work,
      and stage only each team's files. UI work must preserve the distinctions
      between clean-card acceptance, patched-runtime tests and streaming stability.
