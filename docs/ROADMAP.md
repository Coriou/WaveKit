# Reliability and portable receiver roadmap

Updated 2026-10-08. The immediate software sequence is below; numbered sections
track related work and acceptance rather than blocking all work on hardware.
Software checks and hardware
acceptance are separate: a healthy process or passing unit suite does not prove
continuous IQ reception, correct RF decoding, or unattended installation.

## Immediate software priorities (re-ordered 2026-10-08 evening)

1. **Deploy the merged core on the Mac.** Tuner-state reconnect
   synchronization and the rtl_tcp stall watchdog are merged; rebuild the Mac image with all merged core work and
   redeploy it with the hardware profile. Then repeat end-to-end Pi reboot and
   USB hotplug recovery through the Mac (a runtime result, separate from the
   clean-card image claims) and announce the new events to the CLI team.
   Run the bounded CSDR rings on the live Mac app as an explicit, reversible
   trial (`csdr.boundedBuffers: true`) to gather real-RF evidence.
2. **Make the full test suite trustworthy.** Pi script tests time out under
   host load and one source-routing ownership test is intermittently flaky;
   fix them so a full-suite pass is meaningful again.
3. **Rate model, batches B1–B4** per the
   [instance/suspension addendum](superpowers/specs/2026-10-08-rate-model-instances-and-suspension.md):
   B1 adapter truth, per-instance declarations, the decimation-factor clamp and
   rejection of tuner rates librtlsdr cannot run; B2 reversible manager
   suspension; B3 REST/WebSocket contracts (announced to the CLI team before
   merge; published through `decoder:status`); B4 wiring and docs.
4. **Streaming stability on stable power** (replacement supply expected
   2026-10-09): 30-minute continuous baseline, overnight bounded-CSDR soak with
   decode counts compared to baseline, quiet-host matched capacity comparison,
   then decide whether bounded rings become the default.
5. **Next Pi image**, after the rate model: carry an rtlmux patch for a
   use-after-free on commands sent while its upstream is down, include the
   polished operator and setup pages, and re-run clean-card acceptance
   including Ethernet.
6. Later: API access/origin policy (prerequisite for host controls and a web
   UI), real IQ fixture baselines, then the opt-in core channelizer prototype
   ([sample-rate/channelizer design](superpowers/specs/2026-10-08-sample-rate-and-channelizer-design.md)).

The [channelizer research review](REVIEW-2026-10-08-CHANNELIZER.md) records the
buffer finding, corrected rate arithmetic, limits of the Pi benchmark and missing
fixture evidence. Exploratory research is not a final implementation spec.

### Status at end of 2026-10-08 (committed code; NOT yet deployed to the Mac app)

- CLI requests 1–4 are merged: `source:status` and `decoder:status` WebSocket
  events and additive `DecoderStatus` fields (`sourceId`, `targetFrequenciesHz`,
  `lastError`, `idleTimeoutMs`, `deviceSerial`). Configured `health.idleTimeout`
  and `checkInterval` now reach the decoder manager.
- Bounded CSDR rings are merged behind `csdr.boundedBuffers` (default off) for
  harness-validated stages only. Native outputs are byte-identical to upstream;
  the live app's CSDR ring memory was measured at about 5 GiB versus about
  9 MiB when bounded. A synthetic all-decoder run on a heavily loaded host was
  CPU-bound (most IQ dropped either way), so throughput is not established.
- Tuner reconnect synchronization and an rtl_tcp stall watchdog are merged: last accepted tuner state is replayed on the first payload of a new
  session (`tuner.reconnectPolicy: restore|reset`), rejected relay rates no
  longer change caps, and a silent connected rtl_tcp session reconnects after
  `stallTimeoutMs` (default 15 s). This fixes two observed live failures: stale
  rate metadata after a receiver reboot, and a half-open connection that never
  reconnected.
- The rate-model instance/suspension design is written and reviewed.

The Pi image/operator-page and CLI teams continue independently in their owned
files. No software milestone substitutes for hardware acceptance.

## 1. Reproducible SD-card installation

A flashable WaveKit SD image and dedicated Imager launcher are now built locally.
The intended onboarding is: select WaveKit in Imager, configure network/account/SSH,
write, boot. Physical clean-card acceptance and release distribution remain pending;
the older manual staging workflow is retained for development and recovery.
The operator-page candidate (early setup page, persistent Wi-Fi policy) was
written to a fresh card on 2026-10-08 and passed its own clean-card run on Wi-Fi
with no runtime patches: first boot, mDNS and key-based SSH, the early setup page
throughout installation (it reported the full page ready only once that page
answered), unattended installation in about six minutes, the full operator page,
Wi-Fi power saving off after the first boot and after a reboot, receiver reboot
recovery and physical USB hotplug recovery (sampling resumed about 8 s after
re-enumeration). Ethernet was not tested. Earlier patched-runtime hotplug evidence
and the earlier candidate's results remain separate claims.

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
      Wi-Fi path passed on the operator-page image (2026-10-08); Ethernet pending.
- [ ] Recover the laptop's IQ stream automatically after a receiver reboot or
      hotplug. Observed failure: the core kept a half-open connection marked
      connected/stale and never reconnected. Fix (stall watchdog) is merged but
      not yet deployed.

The 2026-10-08 Wi-Fi run passed unattended installation, direct key-based SSH,
receiver startup and reboot recovery. USB reattachment exposed a stale receiver
handle; a subsequent runtime fix passed a physical unplug/replug test with IQ
resuming automatically. That runtime test does not count as a pristine image
pass. The operator-page image later passed the clean-card Wi-Fi run described
above. Ethernet and sustained loss-free streaming remain unverified; that run
logged nine brief undervoltage episodes (including three right after the dongle
was re-plugged), a weak Wi-Fi link and substantial delivery loss at times.

Validate SD writing, unattended first boot and sustained streaming separately.
Current development hardware has repeated undervoltage and substantial IQ loss
over Wi-Fi; a replacement supply is expected on 2026-10-09. Proceed with the
clean-card installer test on the current supply, recording any power events so
they are not confused with installer failures. Streaming stability acceptance
still requires stable power. Before erasing, verify the corrected payload and
identify the actual target disk again.

## 2. Network performance and portability

Software policy and transport research may proceed while hardware acceptance is
pending. Coordinate any live receiver/network changes with the hardware session.

- [ ] Measure native and container delivery separately on Ethernet and Wi-Fi:
      generated/delivered/dropped bytes, stalls, latency, CPU, memory and power.
- [ ] Establish a 30-minute continuous baseline at the selected sample rate, then
      test multiple clients, slow clients, disconnections and automatic recovery.
- [ ] Investigate Wi-Fi power saving, interference, channel/link limits and sample
      rate choices; change one variable at a time and report bandwidth tradeoffs.
- [ ] Evaluate on-Pi processing, decimation and transport alternatives where useful.
      Research notes: `docs/RESEARCH-2026-10-08-CHANNELIZER.md` (one shared
      channelizer per source instead of per-decoder csdr pipelines; design,
      core-side measurements) and `docs/RESEARCH-2026-10-08-PI-CHANNELIZER.md`
      (placing it on the Pi: pros/cons, Pi 3 CPU measurements, optionality on
      weak hardware, keeping "decode anything" intact). WaveKit is not Pi
      centric: a dongle plugged straight into the computer is an equal first
      class setup, so the channelizer is built for the core first (it cuts
      per-decoder CPU there and enables several protocols from one capture)
      and only then offered on the SDR host as a transport optimisation.
- [x] Disable Wi-Fi power save persistently in the Pi image. The image embeds
      a NetworkManager `wifi.powersave=2` default before first network activation;
      verified off on a freshly written card after first boot and after reboot,
      with the Imager connection inheriting the default. Explicit per-connection
      operator choices retain precedence. (Not a cure for streaming loss.)
- [ ] Make the SDR host re-apply its configured gain and sample rate when the last
      rtlmux client disconnects, so a departing client cannot leave the receiver
      under-driven (observed: gain left at index 11, samples spanning 124–131).
- [ ] Sample-rate model, WaveKit-wide: every decoder (including future ones)
      declares the input rate it works best at, the rates it accepts and the
      minimum below which it cannot work; the manager resolves each decoder
      against the source rate, suspends decoders with a machine-readable reason
      (`insufficient-sample-rate`) and resumes them when the rate rises; the
      per-decoder verdict (best / acceptable / unusable, with the reason) and the
      source's valid rate presets travel through REST/WebSocket/`api-types` so
      the CLI (and later web UI) can tell the user which rate suits which
      decoder. Keep capture requirements separate from adapter output and decoder
      stdin rates; unknown requirements remain explicit rather than disabling
      third-party decoders. The core already sets the upstream rate via
      `POST /api/tuner/:sourceId/sample-rate` and the SDR++ relay; keep both.
      A channelizer (`docs/RESEARCH-2026-10-08-CHANNELIZER.md`) gives each
      decoder an exact requested rate when supported, but cannot recover RF
      bandwidth absent from the capture. Passband/transition margins and source
      quality remain part of channel admission.
- [ ] Decided 2026-10-08: no lossy bit reduction, no lossless-only compression
      (measured 0.68–0.86 at real gains), no decoders on the Pi for now. Details
      and measurements: `docs/RESEARCH-2026-10-08-WIFI-IQ-TRANSPORT.md`.
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
      decoder restarts are serialized. Reconnect replay of the last accepted state
      (on first payload), caps reconciliation and an rtl_tcp stall watchdog are
      merged; deploy and live re-test remain.
- [x] Preserve arrays when applying indexed environment overrides.
- [x] Fix recording EOF cleanup (file/timers released, downstream EOF after
      buffered final data; read errors stop looping playback).
- [ ] Distinguish disconnected, waiting, stale, dropping and streaming states;
      display current activity separately from historical counters. Core REST now
      exposes payload freshness (waiting/streaming/stale/paused/disconnected/ended)
      independently of transport and assignment capacity. CLI snapshots expire
      after 15 seconds. The Pi SDR-host now derives upstream sampling evidence
      from fresh rtlmux byte counts (bounded non-overlapping polling, PID and
      counter resets, 10 s deadline), independent of USB, processes and clients;
      not yet deployed to the Pi. Combined core + Pi drop reporting remains pending.
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

- [x] Show first-boot progress/failure, host uptime, CPU load, memory, disk space,
      temperature and network connection with clearly labelled fresh/stale data.
- [x] Distinguish active undervoltage/throttling from historical power events;
      report unavailable measurements honestly, without implying battery charge
      or power consumption can be measured on unsupported hardware.
- [x] List attached SDR dongles and receiver service state, separating USB presence
      from actual sample flow, throughput and dropped data.
- [x] Present a compact overview with optional diagnostic details, readable on
      mobile and inexpensive to serve on a Pi 3. Reuse the host API and shared
      telemetry contracts rather than creating a separate monitoring stack.
- [ ] Offer authenticated, explicitly confirmed shutdown (and optionally reboot),
      protected against cross-origin requests and limited to those host actions.
      Make pending shutdown and the expected loss of connectivity clear.
- [ ] Start with read-only status, then add host controls after access/origin policy
      is implemented. Test reconnects, setup failures, USB hotplug and stale data.

The read-only page is implemented in `packages/sdr-host` and served at
`http://<pi>:8080/`; `GET /api/host` and additive `/api/status` fields
(`sampling`, `delivery`, `samplingHistory`) carry the shared
`@wavekit/api-types` contracts. Each reading states its scope (Pi host,
receiver container, Docker storage filesystem, or observed by the service) and
its freshness; anything the unprivileged container cannot see is shown as
unavailable with a reason. The Pi CORS policy no longer reflects every origin.

Unit/integration tests cover stale counters, idle delivery with ongoing
sampling, header-only growth, rtlmux/rtl_tcp restarts, hung and malformed stats,
expiry, missing sysfs files, setup records and page logic. On hardware, the
operator-page image (2026-10-08) served the page from a fresh card: undervoltage
state (`rpi_volt`), the `cpu-thermal` zone and `/proc/net/wireless` link data
are visible to the receiver container; container memory accounting is not
visible from inside it, and throttling stays unavailable by design. The page
showed the USB hotplug transition. A later visual polish of the status and
setup pages is committed but not yet in an image.

Known limits: on current Raspberry Pi kernels the firmware's "since boot" power
bits are cleared by the kernel's own polling and throttling flags need
`vcgencmd`/`/dev/vcio`, so under-voltage history is "observed by the receiver
service since it started" and throttling is reported as not measurable. Setup
progress appears only on images whose first boot writes the sanitized
`/var/lib/wavekit/status/setup.json`. Updated images also serve an independent
early setup page on port 80 before Docker installation, opening the full page
on port 8080 only after setup completes and that page responds. Reboot/shutdown
controls remain deliberately absent until authentication, authorization and
origin/CSRF protection exist.

**Next (low priority, Pi UI): one address for the user.** Two ports (80 for
setup, 8080 for status) confuse operators. Goal: typing `http://<pi>/` always
shows the right page — the setup page while installing, the status page once
setup completes. Preferred shape: the status service takes over port 80 when
setup finishes (the early setup server releases it), with 8080 kept as a
compatibility alias or redirect; the early server's honest handoff check
(status page responds before switching) must survive. Ship in an image after
the 2026-10-08b candidate, with its own clean-card acceptance (setup → switch
→ reboot keeps port 80 on the status page).

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
